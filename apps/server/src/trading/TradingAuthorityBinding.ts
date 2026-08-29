/**
 * Taking trading authority from inside a chat turn.
 *
 * The trade home's "New mission" form is no longer the only door. A thread that
 * has never held a mission can now publish a plan or place an entry, and the
 * first such call takes authority on the market it names: this module is what
 * that call runs. It is the reactor's `processCreateRequested` with the two
 * halves a chat turn does not want removed — there is no command round trip,
 * because the caller is waiting on the answer inside its own tool call, and no
 * new run is dispatched, because the turn that needs the authority is already
 * running.
 *
 * Everything else is deliberately the same as the explicit path: the same
 * `createMission`, so the D4 per-market exclusivity check and the manual
 * exposure check are the ones already written, the same testnet authority
 * envelope, the same capital resolution, the same §11.1 status walk, the same
 * `trading.mission.status-set` announcements, and the same trading profile
 * bound to the thread. An auto-created mission is a mission.
 *
 * @module TradingAuthorityBinding
 */
import { CommandId, ThreadId, TradingMissionId } from "@t3tools/contracts";
import type { TradingMarket } from "@t3tools/trading-contracts/primitives";
import type { TradingProvider } from "@t3tools/trading-contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { HyperliquidGateway } from "@t3tools/hyperliquid/Gateway";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { setSessionProfile } from "../provider/SessionProfile.ts";
import { resolveMissionCapitalUsd } from "./MissionCapital.ts";
import { LOCAL_TRADING_ACCOUNT_ID } from "./TradingAccountBootstrap.ts";
import { LOCAL_TRADING_USER_ID } from "./TradingMissionReactor.ts";
import { TradingMissionService } from "./TradingMissionService.ts";
import { TradingTurnCoordinator } from "./TradingTurnCoordinator.ts";
import type { TradingMission } from "./Schemas.ts";

/** The venue this fork trades. Named rather than implied, so a refusal can say it. */
export const BOUND_VENUE = "hyperliquid";

/**
 * Why the market could not be taken, in the words the model has to relay.
 *
 * `detail` is one sentence naming the holder; `options` are the ways out, and
 * they are separate so the model relays choices rather than prose.
 */
export interface AuthorityConflict {
  readonly market: string;
  readonly heldBy: "another_mission" | "your_own_hand";
  readonly detail: string;
  readonly options: ReadonlyArray<string>;
}

export type AuthorityBinding =
  | { readonly outcome: "bound"; readonly mission: TradingMission }
  | { readonly outcome: "conflict"; readonly conflict: AuthorityConflict };

/**
 * What the holding mission is doing, in words a user reads rather than the
 * §11.1 token.
 *
 * The two that matter to someone hunting for the holder are the two that look
 * different on the trade home: a mission holding a position is listed there,
 * and a waiting one is not.
 */
const statusInWords = (status: string): string =>
  status === "position_open"
    ? "holding a position"
    : status === "waiting"
      ? "waiting on its plan"
      : status === "executing"
        ? "placing an order"
        : status === "analysing"
          ? "reading the market"
          : status === "initializing"
            ? "starting up"
            : status.replace(/_/g, " ");

/**
 * The refusal text a held market answers with, holder named.
 *
 * `threadTitle` is what makes the refusal actionable: "another mission" told
 * the user a market was taken and gave them nowhere to look. Naming the chat
 * lets them find it in the thread list, which is the only route to a mission
 * that holds no position — the trade home lists positions, so a waiting
 * mission is invisible there. That gap is said out loud rather than papered
 * over, and no new navigation is built to close it.
 */
const missionConflict = (input: {
  readonly market: string;
  readonly status: string;
  readonly threadTitle: string | null;
}): AuthorityConflict => {
  const named = input.threadTitle !== null;
  // Capitalized: `detail` is read as its own sentences wherever it lands — the
  // model relays it into the chat, and a refusal that opens in lower case
  // reads as the tail of a sentence the reader never saw.
  const holder = named ? `The chat "${input.threadTitle}"` : "Another chat";
  // Where to go to end it. A titled chat is findable by that title; an
  // untitled one is only reachable the old way, and only while it holds a
  // position to be listed by.
  const goTo = named ? "that chat" : "the trade home";
  const invisible = named
    ? input.status === "position_open"
      ? ""
      : " It holds no position, so the trade home does not list it; find it by that name in your thread list."
    : " It has no title to find it by, and the trade home lists it only while it holds a position.";
  return {
    market: input.market,
    heldBy: "another_mission",
    detail:
      `${holder} already holds ${input.market} on ${BOUND_VENUE} and is ` +
      `${statusInWords(input.status)}. One market answers to one chat at a time, so nothing ` +
      `was placed here.${invisible}`,
    options: [
      `take ${input.market} over in this chat by ending that mission first, from ${goTo}`,
      "trade a different market from this chat instead",
    ],
  };
};

/**
 * The holding chat's title, for the refusal above.
 *
 * Advisory: a title that cannot be read costs the refusal a name, never the
 * refusal itself, so every failure answers `null`.
 */
const readThreadTitle = (
  threadId: string | undefined,
): Effect.Effect<string | null, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    if (threadId === undefined) return null;
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly title: string }>`
      SELECT title FROM projection_threads
      WHERE thread_id = ${threadId} AND deleted_at IS NULL
    `;
    const title = rows[0]?.title.trim();
    return title === undefined || title === "" ? null : title;
  }).pipe(Effect.catchCause(() => Effect.succeed(null)));

const manualConflict = (input: {
  readonly market: string;
  readonly exposure: string;
}): AuthorityConflict => ({
  market: input.market,
  heldBy: "your_own_hand",
  detail: `You are in ${input.market} by hand, with a ${input.exposure.replace("_", " ")} on ${BOUND_VENUE}. An agent may not take a market its owner is already trading, so nothing was placed here.`,
  options: [
    `close or cancel that ${input.exposure.replace("_", " ")} on ${input.market}, then ask again`,
    "trade a different market from this chat instead",
  ],
});

/**
 * The mandate an auto-created mission carries.
 *
 * It says where it came from and what it is for. A mandate is read back to the
 * model on every wake, so the one thing it must not do is pretend to be a
 * strategy the user never gave.
 */
const autoMandate = (market: string): string =>
  `Trade ${market} on ${BOUND_VENUE} testnet for the user, from this chat. ` +
  `Authority was taken automatically when the chat first acted on ${market}. ` +
  "Follow what the user asks in the chat; where they have not said, work your own read of the market and publish a plan for it.";

/**
 * Take one more market for a thread that already holds a mission.
 *
 * The same act as taking the first, and deliberately the same shape: the D4
 * per-market exclusivity check and the manual-exposure check are the ones
 * `createMission` runs, so a market taken by extension is taken under exactly
 * the rules a market taken by creation is. Nothing else moves — no new mission,
 * no new harness binding, no status walk, no second lease. The turn that is
 * asking is already running under this mission's authority; all it needed was
 * for the mission to hold the market it just named.
 *
 * A market the mission already holds answers `bound` without writing anything,
 * so a turn that enters twice on one market is never told the market is taken
 * by itself.
 */
export const extendMissionToMarket = Effect.fn("TradingAuthorityBinding.extendMissionToMarket")(
  function* (input: {
    readonly missionId: string;
    readonly market: TradingMarket;
  }): Effect.fn.Return<
    AuthorityBinding,
    never,
    TradingMissionService | OrchestrationEngineService | SqlClient.SqlClient | Crypto.Crypto
  > {
    const missions = yield* TradingMissionService;
    const extended = yield* missions.bindMarket(input).pipe(
      Effect.map((mission) => ({ outcome: "bound" as const, mission })),
      Effect.catchTags({
        TradingMissionAlreadyActiveError: (refusal) =>
          readThreadTitle(refusal.activeThreadId).pipe(
            Effect.map((threadTitle) => ({
              outcome: "conflict" as const,
              conflict: missionConflict({
                market: refusal.market ?? input.market,
                status: refusal.activeStatus,
                threadTitle,
              }),
            })),
          ),
        TradingMarketManualExposureError: (refusal) =>
          Effect.succeed({
            outcome: "conflict" as const,
            conflict: manualConflict({ market: refusal.market, exposure: refusal.exposure }),
          }),
      }),
      // Anything else is a defect: the caller is mid-order and has no honest
      // answer to give. Same rule as the create path.
      Effect.orDie,
    );

    if (extended.outcome === "conflict") {
      yield* Effect.logInfo("trading authority not extended: the market is held", {
        missionId: input.missionId,
        market: input.market,
        heldBy: extended.conflict.heldBy,
      });
      return extended;
    }

    yield* announceMarkets({
      type: "trading.mission.market-bound",
      threadId: ThreadId.make(extended.mission.harness.threadId),
      missionId: TradingMissionId.make(extended.mission.id),
      market: input.market,
      markets: extended.mission.markets,
    });

    yield* Effect.logInfo("trading authority extended to a second market", {
      missionId: input.missionId,
      market: input.market,
      markets: extended.mission.markets.join(","),
    });
    return extended;
  },
);

/**
 * Take authority on `{venue, market}` for this thread, or say who holds it.
 *
 * The caller is a tool handler inside a live turn, so this returns a value
 * rather than failing: a held market is an answer the model relays, not an
 * error it retries.
 */
export const bindThreadToMarket = Effect.fn("TradingAuthorityBinding.bindThreadToMarket")(
  function* (input: {
    readonly threadId: string;
    readonly providerInstanceId: string;
    readonly market: TradingMarket;
  }): Effect.fn.Return<
    AuthorityBinding,
    never,
    | TradingMissionService
    | TradingTurnCoordinator
    | HyperliquidGateway
    | ProviderRegistry
    | OrchestrationEngineService
    | SqlClient.SqlClient
    | Crypto.Crypto
  > {
    const missions = yield* TradingMissionService;
    const gateway = yield* HyperliquidGateway;
    const registry = yield* ProviderRegistry;
    const coordinator = yield* TradingTurnCoordinator;
    const crypto = yield* Crypto.Crypto;

    const threadId = ThreadId.make(input.threadId);
    const missionId = TradingMissionId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie));

    // The provider running this very turn, read off the MCP credential's own
    // instance rather than guessed. §10.2 freezes the binding for the life of
    // the mission, so a provider wrong here can never be corrected, and the
    // workspace locks the composer's model picker to it.
    const driver = yield* registry.getProviders.pipe(
      Effect.map(
        (providers) =>
          providers.find((snapshot) => snapshot.instanceId === input.providerInstanceId)?.driver ??
          null,
      ),
      Effect.catchCause(() => Effect.succeed(null)),
    );
    const provider: TradingProvider =
      driver === "claude" || driver === "claudeAgent"
        ? "claude"
        : driver === "opencode"
          ? "opencode"
          : "codex";

    // No stated capital: size the mandate from the account, exactly as the
    // explicit path does. An unreadable account warns and falls back rather
    // than refusing an entry the user asked for.
    const capital = yield* resolveMissionCapitalUsd({
      explicitUsd: undefined,
      readAccountValueUsd: missions.getMasterWalletAddress(LOCAL_TRADING_ACCOUNT_ID).pipe(
        Effect.flatMap((address) => gateway.getAccountSnapshot(address)),
        Effect.map((snapshot) => snapshot.accountValue),
      ),
    });

    const created = yield* missions
      .createMission({
        missionId,
        userId: LOCAL_TRADING_USER_ID,
        tradingAccountId: LOCAL_TRADING_ACCOUNT_ID,
        instruction: autoMandate(input.market),
        allocatedCapitalUsd: capital.allocatedCapitalUsd,
        capitalSource: capital.source,
        market: input.market,
        harness: {
          provider,
          providerInstanceId: input.providerInstanceId,
          threadId,
          status: "available",
        },
      })
      .pipe(
        Effect.map((mission) => ({ outcome: "bound" as const, mission })),
        Effect.catchTags({
          TradingMissionAlreadyActiveError: (refusal) =>
            readThreadTitle(refusal.activeThreadId).pipe(
              Effect.map((threadTitle) => ({
                outcome: "conflict" as const,
                conflict: missionConflict({
                  market: refusal.market ?? input.market,
                  status: refusal.activeStatus,
                  threadTitle,
                }),
              })),
            ),
          TradingMarketManualExposureError: (refusal) =>
            Effect.succeed({
              outcome: "conflict" as const,
              conflict: manualConflict({ market: refusal.market, exposure: refusal.exposure }),
            }),
        }),
        // A create that fails for any other reason is a defect: the caller is
        // mid-order and has no honest answer to give.
        Effect.orDie,
      );

    if (created.outcome === "conflict") {
      yield* Effect.logInfo("trading authority not taken: the market is held", {
        threadId: input.threadId,
        market: input.market,
        heldBy: created.conflict.heldBy,
      });
      return created;
    }

    // The thread is a trading thread from here on: every later session it opens
    // is locked to the trading tools, and the wake path resumes it by name.
    yield* Effect.sync(() => setSessionProfile({ threadId, kind: "trading" }));

    // §11.1 initializing -> analysing -> waiting. The explicit path walks the
    // first edge when its dispatched run starts; here the run is the chat turn
    // already in flight, so both edges are walked now. `waiting` is what an
    // entry is reachable from (§16.3 item 1 admits an intent from `waiting` or
    // `position_open`), and it is the truth of the mission either way: it holds
    // authority and is waiting on this turn's decision.
    yield* announce({ threadId, missionId, status: "initializing" });
    yield* walk({ threadId, missionId, to: "analysing" });
    yield* walk({ threadId, missionId, to: "waiting" });

    // The decision lease. Every execution check asks which harness run owns it,
    // and a chat turn nobody dispatched owns nothing until this.
    yield* coordinator
      .adoptTurn({ missionId, threadId: input.threadId })
      .pipe(Effect.catchCause(() => Effect.succeed(false)));

    yield* Effect.logInfo("trading authority taken on first use", {
      missionId,
      threadId: input.threadId,
      market: input.market,
      provider,
      allocatedCapitalUsd: capital.allocatedCapitalUsd,
      capitalSource: capital.source,
    });

    return { outcome: "bound", mission: created.mission };
  },
);

/**
 * What a release did, in the words the model relays to the user.
 *
 * `refused` is the only one that changed nothing, and it says why in a sentence
 * rather than a code: the caller is a tool handler, and its answer goes
 * straight into the chat.
 */
export type MarketRelease =
  | { readonly outcome: "released"; readonly mission: TradingMission; readonly detail: string }
  | { readonly outcome: "refused"; readonly detail: string };

/**
 * Let one market go without ending the mission - the reverse of the bind.
 *
 * The market is free for another chat the moment this returns. Releasing the
 * last one is refused: a mission holding nothing is a mission that should have
 * ended, and ending it is a decision the user makes out loud rather than a side
 * effect of "stop trading BTC here".
 *
 * Deliberately does NOT close a position or cancel an order. Releasing is about
 * authority, not exposure, and a release that silently flattened a position
 * would be the most expensive surprise in the product. The caller checks for
 * exposure first and says so.
 */
export const releaseMissionMarket = Effect.fn("TradingAuthorityBinding.releaseMissionMarket")(
  function* (input: {
    readonly missionId: string;
    readonly market: TradingMarket;
  }): Effect.fn.Return<
    MarketRelease,
    never,
    TradingMissionService | OrchestrationEngineService | SqlClient.SqlClient | Crypto.Crypto
  > {
    const missions = yield* TradingMissionService;
    const released = yield* missions.releaseMarket(input).pipe(Effect.orDie);

    if (released.outcome === "not_held") {
      return {
        outcome: "refused",
        detail: `Nothing changed: this chat does not hold ${input.market}. It holds ${released.mission.markets.join(", ")}.`,
      };
    }
    if (released.outcome === "last_market") {
      return {
        outcome: "refused",
        detail:
          `Nothing changed: ${input.market} is the only market this chat holds, and a mission ` +
          "cannot hold none. Ask the user to end the mission if they want this chat to stop trading entirely.",
      };
    }

    yield* announceMarkets({
      type: "trading.mission.market-released",
      threadId: ThreadId.make(released.mission.harness.threadId),
      missionId: TradingMissionId.make(released.mission.id),
      market: input.market,
      markets: released.mission.markets,
    });

    yield* Effect.logInfo("trading authority released one market", {
      missionId: input.missionId,
      market: input.market,
      markets: released.mission.markets.join(","),
    });

    return {
      outcome: "released",
      mission: released.mission,
      detail:
        `${input.market} was released and is free for another chat. This chat still holds ` +
        `${released.mission.markets.join(", ")}.`,
    };
  },
);

/**
 * One held-set command, so the workspace sees the change on the ordered push
 * path. A failed announcement is a stale panel, never a lost release.
 */
const announceMarkets = (input: {
  readonly type: "trading.mission.market-bound" | "trading.mission.market-released";
  readonly threadId: ThreadId;
  readonly missionId: TradingMissionId;
  readonly market: string;
  readonly markets: ReadonlyArray<string>;
}) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const crypto = yield* Crypto.Crypto;
    const commandId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    yield* engine.dispatch({
      type: input.type,
      commandId: CommandId.make(commandId),
      threadId: input.threadId,
      missionId: input.missionId,
      market: input.market,
      markets: input.markets,
      createdAt: yield* DateTime.now.pipe(Effect.map(DateTime.formatIso)),
    });
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("could not announce a mission's held-market change", {
        missionId: input.missionId,
        market: input.market,
        cause: String(cause),
      }),
    ),
  );

/** One `trading.mission.status-set`, so the workspace sees the new mission. */
const announce = (input: {
  readonly threadId: ThreadId;
  readonly missionId: TradingMissionId;
  readonly status: "initializing" | "analysing" | "waiting";
}) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const crypto = yield* Crypto.Crypto;
    const commandId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    yield* engine.dispatch({
      type: "trading.mission.status-set",
      commandId: CommandId.make(commandId),
      threadId: input.threadId,
      missionId: input.missionId,
      status: input.status,
      createdAt: yield* DateTime.now.pipe(Effect.map(DateTime.formatIso)),
    });
  }).pipe(
    // The mission is already durable; a failed announcement is a stale panel,
    // never a lost mission.
    Effect.catchCause((cause) =>
      Effect.logWarning("could not announce an auto-bound mission's status", {
        missionId: input.missionId,
        cause: String(cause),
      }),
    ),
  );

/** One §11.1 edge, with the version read the transition needs. */
const walk = (input: {
  readonly threadId: ThreadId;
  readonly missionId: TradingMissionId;
  readonly to: "analysing" | "waiting";
}) =>
  Effect.gen(function* () {
    const missions = yield* TradingMissionService;
    const expectedVersion = yield* missions.getMissionVersion(input.missionId);
    yield* missions.transition({
      missionId: input.missionId,
      to: input.to,
      expectedVersion,
    });
    yield* announce({
      threadId: input.threadId,
      missionId: input.missionId,
      status: input.to,
    });
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("could not walk an auto-bound mission's status", {
        missionId: input.missionId,
        to: input.to,
        cause: String(cause),
      }),
    ),
  );
