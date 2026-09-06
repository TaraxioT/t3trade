/**
 * TradingControlService — the §14.7 deterministic user-control API.
 *
 * The defining property is negative, so it is tested negatively: NO service
 * this suite provides can serve a harness turn. There is no turn coordinator,
 * no wakeup composer, no provider session, no harness binding, and the preview
 * service is absent rather than stubbed green — if any control reached for one
 * of them, the layer would fail to build and every test here would fail.
 *
 * That is the closest a unit test can get to "verified with the provider
 * process stopped", and it is stronger than a stub: a stub proves the call
 * was made and answered, while an absent service proves the call is never
 * made at all.
 */
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { HyperliquidGateway } from "@t3tools/hyperliquid";
import { HyperliquidInfoClient } from "@t3tools/hyperliquid/InfoClient";
import type { TradingOrderResult } from "@t3tools/trading-contracts/execution";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import {
  HyperliquidExecutionService,
  TradingExecutionError,
} from "./HyperliquidExecutionService.ts";
import { HyperliquidReconciler } from "./HyperliquidReconciler.ts";
import { TradingMissionService } from "./TradingMissionService.ts";
import { TradingProtectionService } from "./TradingProtectionService.ts";
import {
  describeEntryCancellation,
  makeTradingControlService,
  TradingControlError,
  type ControlOutcome,
  type ExchangeControlInput,
  type ManualCloseOutcome,
  type MissionFinalizationMarket,
  type TradingControlService,
} from "./TradingControlService.ts";

const MISSION = "mission_control";

const TARGET: ExchangeControlInput = {
  missionId: MISSION,
  masterAddress: "0xmaster",
  market: "ETH",
};

interface Fake {
  positionSize: number;
  /**
   * Canonical exposure by market. When set, this map is the exchange's truth
   * for every market; when unset, the single `positionSize` field stands in
   * for the ETH-only cases the older tests cover.
   */
  positions: Record<string, number> | undefined;
  exits: number[];
  /** Every reduce-only IOC submission, with the market it targeted (RC01). */
  exitLog: Array<{ readonly market: string; readonly size: number }>;
  cancels: string[];
  transitions: string[];
  protectedCancels: Array<ReadonlyArray<string>>;
  protectionEscalates: boolean;
  /** When set, every manual reduce-only IOC is rejected with this reason. */
  manualExitRejection: string | null;
  /** Fraction of each manual reduce-only IOC that fills (1 = fully). */
  manualExitFillFraction: number;
  /** When set, every mission reduce-only IOC is rejected with this reason. */
  exitRejection: string | null;
  /** Fraction of each mission reduce-only IOC that fills (1 = fully). */
  exitFillFraction: number;
  /**
   * Per-call outcome plan for the canonical account snapshot, consumed
   * front-to-back; reads past the plan succeed. Deterministic per-read
   * control — no timing, no sleeps (06A).
   */
  snapshotReads: Array<"ok" | "fail">;
  /**
   * Per-submission fill fractions for the mission lane, consumed
   * front-to-back; submissions past the plan use exitFillFraction (06D).
   */
  exitFillPlan: Array<number>;
  /** Runs on each mission-lane reconcile between attempts — e.g. a concurrent position increase (06D). */
  onReconcile?: (() => void) | undefined;
  // --- mission-domain stand-ins for the mission-level finalization (RC01) ---
  /** Current mission status; the transition fake keeps it in step. */
  missionStatus: string;
  /** Held markets the mission fake reports. */
  missionMarkets: string[];
  /** Per-getMission held-set plan, consumed front-to-back; the last entry repeats. */
  missionMarketsByCall: Array<string[]> | undefined;
  /** Terminal/blocking statuses whose transition the mission fake refuses. */
  failTransitionsTo: string[];
  getMissionCalls: number;
  /**
   * Cloids whose cancellation the fake exchange refuses (RC03). Everything
   * else is acknowledged; a refused cloid fails typed, exactly like an
   * exchange-level rejection observed through the RC02 acknowledgement check.
   */
  cancelRejections: ReadonlyArray<string>;
  /**
   * When set, the protection fake's cancel-entries outcome carries this
   * entry-cancellation report, so the control layer's propagation of the
   * acknowledged-only summary can be asserted without re-faking §17.3.
   */
  protectedEntryCancellation:
    | {
        readonly acknowledged: ReadonlyArray<string>;
        readonly unconfirmed: ReadonlyArray<{ readonly cloid: string; readonly reason: string }>;
      }
    | undefined;
}

const makeFake = (overrides: Partial<Fake> = {}): Fake => ({
  positionSize: 0.5,
  positions: undefined,
  exits: [],
  exitLog: [],
  cancels: [],
  transitions: [],
  protectedCancels: [],
  protectionEscalates: false,
  manualExitRejection: null,
  manualExitFillFraction: 1,
  exitRejection: null,
  exitFillFraction: 1,
  snapshotReads: [],
  exitFillPlan: [],
  missionStatus: "analysing",
  missionMarkets: ["ETH"],
  missionMarketsByCall: undefined,
  failTransitionsTo: [],
  getMissionCalls: 0,
  cancelRejections: [],
  protectedEntryCancellation: undefined,
  ...overrides,
});

/** The exchange's current canonical map: the explicit one, or the legacy single market. */
const canonicalPositions = (fake: Fake): Record<string, number> =>
  fake.positions ?? { ETH: fake.positionSize };

/** Apply a fill to the canonical map, keeping the legacy field in step. */
const applyFill = (fake: Fake, market: string, closable: number): void => {
  if (fake.positions === undefined) {
    // Legacy single-market lane: `positionSize` is the exchange's whole truth,
    // including any concurrent change a test's onReconcile writes into it.
    const sign = fake.positionSize > 0 ? 1 : -1;
    fake.positionSize = Number((fake.positionSize - sign * closable).toFixed(10));
    return;
  }
  const bucket = { ...fake.positions };
  const current = bucket[market] ?? 0;
  const sign = current > 0 ? 1 : -1;
  bucket[market] = Number((current - sign * closable).toFixed(10));
  fake.positions = bucket;
};

const gatewayLayer = (fake: Fake) =>
  Layer.succeed(HyperliquidGateway, {
    getAccountSnapshot: () =>
      Effect.suspend(() => {
        const read = fake.snapshotReads.shift() ?? "ok";
        if (read === "fail") return Effect.fail("account snapshot read refused");
        const positions = Object.entries(canonicalPositions(fake))
          .filter(([, size]) => Math.abs(size) > 1e-12)
          .map(([market, size]) => ({
            market,
            size,
            entryPrice: 3_000,
            unrealisedPnl: 0,
            marginUsed: 100,
          }));
        return Effect.succeed({ positions });
      }),
    getOrderBook: () => Effect.succeed({ bestBidOffer: { bidPrice: 2_999, askPrice: 3_001 } }),
    getOpenOrders: () => Effect.succeed([]),
    resolveMarket: () => Effect.die("not used"),
    getMarketSnapshot: () => Effect.die("not used"),
    getMarketHistory: () => Effect.die("not used"),
    getPosition: () => Effect.die("not used"),
    getTakerFeeRateBps: () => Effect.die("not used"),
  } as unknown as HyperliquidGateway["Service"]);

const executionLayer = (fake: Fake) =>
  Layer.succeed(HyperliquidExecutionService, {
    submitReduceOnlyIoc: (input: { market: string; positionSize: number }) =>
      Effect.sync(() => {
        fake.exits.push(input.positionSize);
        fake.exitLog.push({ market: input.market, size: input.positionSize });
        if (fake.exitRejection !== null) {
          return [
            { cloid: "0xexit", status: "error", reason: fake.exitRejection, role: "entry" },
          ] as ReadonlyArray<TradingOrderResult>;
        }
        const closable =
          Math.abs(input.positionSize) * (fake.exitFillPlan.shift() ?? fake.exitFillFraction);
        applyFill(fake, input.market, closable);
        return [
          { cloid: "0xexit", status: "filled", filledSize: closable, role: "entry" },
        ] as ReadonlyArray<TradingOrderResult>;
      }),
    submitManualReduceOnlyIoc: (input: { market: string; positionSize: number }) =>
      Effect.sync(() => {
        fake.exits.push(input.positionSize);
        fake.exitLog.push({ market: input.market, size: input.positionSize });
        if (fake.manualExitRejection !== null) {
          return [
            { cloid: "0xmanual", status: "error", reason: fake.manualExitRejection, role: "entry" },
          ] as ReadonlyArray<TradingOrderResult>;
        }
        const closable = Math.abs(input.positionSize) * fake.manualExitFillFraction;
        applyFill(fake, input.market, closable);
        return [
          { cloid: "0xmanual", status: "filled", filledSize: closable, role: "entry" },
        ] as ReadonlyArray<TradingOrderResult>;
      }),
    submitCancel: (input: { cloid: string }) =>
      Effect.suspend(() => {
        fake.cancels.push(input.cloid);
        if (fake.cancelRejections.includes(input.cloid)) {
          return Effect.fail(
            new TradingExecutionError({
              stage: "inspect_failed",
              detail: "rejected by exchange",
            }),
          );
        }
        return Effect.void;
      }),
    // Present so the layer builds, but a control that reached the full submit
    // path would need a preview context — which is exactly what these must not
    // require, so it dies rather than returning something plausible.
    submitOrder: () => Effect.die("a deterministic control must not use the preview path"),
    submitProtectiveStop: () => Effect.die("not used"),
  } as unknown as HyperliquidExecutionService["Service"]);

const protectionLayer = (fake: Fake) =>
  Layer.succeed(TradingProtectionService, {
    reconcileProtection: () => Effect.die("not used directly by the control service"),
    cancelEntriesWithProtection: (input: { cloids: ReadonlyArray<string> }) =>
      Effect.sync(() => {
        fake.protectedCancels.push(input.cloids);
        return {
          status: fake.protectionEscalates ? "escalate" : "protected",
          positionSize: fake.positionSize,
          protectedSize: fake.protectionEscalates ? 0 : Math.abs(fake.positionSize),
          replacedCloids: [],
          ...(fake.protectedEntryCancellation === undefined
            ? {}
            : { entryCancellation: fake.protectedEntryCancellation }),
        };
      }),
  } as unknown as TradingProtectionService["Service"]);

const reconcilerLayer = (fake: Fake) =>
  Layer.succeed(HyperliquidReconciler, {
    reconcile: () =>
      Effect.sync(() => {
        fake.onReconcile?.();
        return {
          position: null,
          openOrders: [],
          canonicalOrders: [],
          fills: [],
          observedAt: 0,
        };
      }),
  } as unknown as HyperliquidReconciler["Service"]);

const missionsLayer = (fake: Fake) =>
  Layer.succeed(TradingMissionService, {
    getMissionVersion: () => Effect.succeed(1),
    transition: (input: { to: string }) =>
      Effect.suspend(() => {
        if (fake.failTransitionsTo.includes(input.to)) {
          return Effect.fail({ _tag: "TransitionRefused", to: input.to });
        }
        fake.transitions.push(input.to);
        fake.missionStatus = input.to;
        return Effect.succeed({ status: input.to });
      }),
    getMission: () =>
      Effect.sync(() => {
        fake.getMissionCalls++;
        const plan = fake.missionMarketsByCall;
        const markets =
          plan === undefined
            ? fake.missionMarkets
            : plan[Math.min(fake.getMissionCalls - 1, plan.length - 1)];
        return {
          id: MISSION,
          userId: "local",
          tradingAccountId: "acct_control",
          instruction: "test",
          market: fake.missionMarkets[0] ?? "ETH",
          markets: markets ?? ["ETH"],
          status: fake.missionStatus,
          authorityVersion: 1,
        };
      }),
    getMasterWalletAddress: () => Effect.succeed("0xmaster"),
  } as unknown as TradingMissionService["Service"]);

const infoLayer = Layer.succeed(
  HyperliquidInfoClient,
  {} as unknown as HyperliquidInfoClient["Service"],
);

const migrated = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({});
  yield* sql`DELETE FROM trading_orders`;
  yield* sql`DELETE FROM trading_execution_records`;
  yield* sql`DELETE FROM trading_fills`;
});

/**
 * Build the control service over a deliberately harness-free context.
 *
 * Absent here, and absent on purpose: TradingTurnCoordinator,
 * TradingWakeupComposer, TradingPreviewService, TradingEventInbox,
 * ProviderService, and the orchestration engine. If a control needed any of
 * them, this would not compile or would not build.
 */
const runControl = <A, E>(
  fake: Fake,
  body: (service: TradingControlService["Service"]) => Effect.Effect<A, E>,
  seed: Effect.Effect<void, never, SqlClient.SqlClient> = Effect.void,
) =>
  Effect.gen(function* () {
    yield* migrated;
    yield* seed;
    const service = yield* makeTradingControlService;
    return yield* body(service);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        gatewayLayer(fake),
        executionLayer(fake),
        protectionLayer(fake),
        reconcilerLayer(fake),
        missionsLayer(fake),
        infoLayer,
        NodeSqliteClient.layerMemory(),
      ),
    ),
  );

/** Insert a resting order plus the execution record that names its action. */
let seededSequence = 0;
const seedOrder = (
  cloid: string,
  actionType: string,
  reduceOnly: number,
  stopPrice: number | null,
  market = "ETH",
): Effect.Effect<void, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO trading_orders (
        mission_id, cloid, order_id, market, side, limit_price,
        remaining_size, reduce_only, observed_at
      ) VALUES (${MISSION}, ${cloid}, 1, ${market}, 'buy', 3000, 0.5, ${reduceOnly}, 0)
    `;
    // One sequence per row: (mission, sequence) is unique since migration 053.
    const executionSequence = seededSequence++;
    yield* sql`
      INSERT INTO trading_execution_records (
        execution_id, mission_id, execution_sequence, action_type,
        cloid, idempotency_key, market, side, size, limit_price, time_in_force,
        reduce_only, signer_address, status, order_results_json, created_at, updated_at,
        stop_price
      ) VALUES (
        ${`exec_${cloid}`}, ${MISSION}, ${executionSequence}, ${actionType}, ${cloid}, ${`idem_${cloid}`},
        ${market}, 'buy', 0.5, 3000, 'gtc', ${reduceOnly}, '0xsigner', 'accepted', '[]', 0, 0,
        ${stopPrice}
      )
    `;
  }).pipe(Effect.orDie);

/** One reconciled fill: the completed-versus-revoked fact for thread ending. */
const seedFill: Effect.Effect<void, never, SqlClient.SqlClient> = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO trading_fills (
      fill_id, mission_id, execution_id, cloid, order_id, market, side,
      filled_size, avg_fill_price, fee_usd, fee_token, traded_at, observed_at,
      closed_pnl
    ) VALUES (
      'fill_control', ${MISSION}, 'exec_control', '0xcloid_control', 1, 'ETH', 'buy',
      0.5, 3000, 1.5, 'USDC', 1000, 1000, 12.5
    )
  `;
}).pipe(Effect.orDie);

/** The finalization's market result, by market name. */
const marketResult = (markets: ReadonlyArray<MissionFinalizationMarket>, market: string) =>
  markets.find((entry) => entry.market === market);

// ---------------------------------------------------------------------------
// Lifecycle controls
// ---------------------------------------------------------------------------

it.effect("pause blocks entries without standing down the stop", () =>
  Effect.gen(function* () {
    // §14.7's paused card promises the stop stays live on-exchange. A pause
    // that cancelled protection would make that card a lie.
    const fake = makeFake();
    const outcome = yield* runControl(fake, (s) => s.pause({ missionId: MISSION }));

    assert.equal(outcome.status, "paused");
    assert.deepEqual(fake.transitions, ["paused"]);
    assert.deepEqual(fake.cancels, []);
    assert.deepEqual(fake.exits, []);
    assert.ok(outcome.summary.includes("protection stays live"));
  }),
);

it.effect("resume returns the mission to analysing", () =>
  Effect.gen(function* () {
    const fake = makeFake();
    const outcome = yield* runControl(fake, (s) => s.resume({ missionId: MISSION }));
    assert.equal(outcome.status, "analysing");
  }),
);

it.effect("revoke ends authority and preserves protection", () =>
  Effect.gen(function* () {
    // Revocation ends what the harness may do. Cancelling the stop at the same
    // time would end the safety net along with the authority.
    const fake = makeFake();
    const outcome = yield* runControl(fake, (s) => s.revoke({ missionId: MISSION }));

    assert.equal(outcome.status, "revoked");
    assert.deepEqual(fake.cancels, []);
    assert.ok(outcome.summary.includes("protection stays live"));
  }),
);

// ---------------------------------------------------------------------------
// Exchange-touching controls
// ---------------------------------------------------------------------------

it.effect("cancel_entries protects the filled slice before cancelling", () =>
  Effect.gen(function* () {
    const fake = makeFake();
    const outcome = yield* runControl(
      fake,
      (s) => s.cancelEntries(TARGET),
      seedOrder("0xentry", "open", 0, 2_950),
    );

    // It routed through the §17.3 protected-cancel path, not a bare cancel.
    assert.deepEqual(fake.protectedCancels, [["0xentry"]]);
    assert.deepEqual(fake.cancels, []);
    assert.ok(outcome.summary.includes("stays protected"));
  }),
);

it.effect("cancel_entries leaves reduce-only protection alone", () =>
  Effect.gen(function* () {
    const fake = makeFake();
    yield* runControl(
      fake,
      (s) => s.cancelEntries(TARGET),
      Effect.gen(function* () {
        yield* seedOrder("0xentry", "open", 0, 2_950);
        yield* seedOrder("0xstop", "open", 1, 2_950);
      }),
    );

    // Only the non-reduce-only entry is a candidate. Cancelling the stop would
    // strip the position of the thing limiting its loss.
    assert.deepEqual(fake.protectedCancels, [["0xentry"]]);
  }),
);

it.effect("cancel_entries does not cancel when protection could not be established", () =>
  Effect.gen(function* () {
    const fake = makeFake({ protectionEscalates: true });
    const outcome = yield* runControl(
      fake,
      (s) => s.cancelEntries(TARGET),
      seedOrder("0xentry", "open", 0, 2_950),
    );

    assert.ok(outcome.summary.includes("could not be protected"));
  }),
);

it.effect("cancel_entries reports plainly when nothing is resting", () =>
  Effect.gen(function* () {
    const fake = makeFake();
    const outcome = yield* runControl(fake, (s) => s.cancelEntries(TARGET));

    assert.deepEqual(fake.protectedCancels, []);
    assert.ok(outcome.summary.includes("No resting entry orders"));
  }),
);

// ---------------------------------------------------------------------------
// RC03 — an entry-cancellation claim agrees with what the exchange confirmed
// ---------------------------------------------------------------------------

it.effect("a plain cancel_entries reports acknowledged entries only (mixed batch)", () =>
  Effect.gen(function* () {
    // Pre-Phase-5 records carry no stop, so cancellation runs plainly. Two
    // entries, one refused: both were attempted, the outcome claims only the
    // acknowledged one, and the summary says the rest could not be confirmed.
    const fake = makeFake({ cancelRejections: ["0xfirst"] });
    const outcome = yield* runControl(
      fake,
      (s) => s.cancelEntries(TARGET),
      Effect.gen(function* () {
        yield* seedOrder("0xfirst", "open", 0, null);
        yield* seedOrder("0xsecond", "open", 0, null);
      }),
    );

    assert.deepEqual(fake.cancels, ["0xfirst", "0xsecond"], "every entry was attempted");
    assert.deepEqual(outcome.cancelledCloids, ["0xsecond"]);
    assert.equal(
      outcome.summary,
      "Cancelled 1 of 2 resting entry order(s); 1 could not be confirmed.",
    );
  }),
);

it.effect("a plain cancel_entries says not confirmed when every acknowledgement fails", () =>
  Effect.gen(function* () {
    const fake = makeFake({ cancelRejections: ["0xfirst", "0xsecond"] });
    const outcome = yield* runControl(
      fake,
      (s) => s.cancelEntries(TARGET),
      Effect.gen(function* () {
        yield* seedOrder("0xfirst", "open", 0, null);
        yield* seedOrder("0xsecond", "open", 0, null);
      }),
    );

    assert.deepEqual(fake.cancels, ["0xfirst", "0xsecond"]);
    assert.deepEqual(outcome.cancelledCloids, []);
    assert.equal(outcome.summary, "Cancellation was not confirmed for 2 resting entry order(s).");
  }),
);

it.effect("a protection-aware cancel_entries carries the acknowledged-only report", () =>
  Effect.gen(function* () {
    // The §17.3 path reports the same truth: protection was established
    // first, so an unconfirmed cancel is a still-resting entry — reported as
    // such, never rounded up into the cancelled list.
    const fake = makeFake({
      protectedEntryCancellation: {
        acknowledged: ["0xsecond"],
        unconfirmed: [{ cloid: "0xfirst", reason: "rejected by exchange" }],
      },
    });
    const outcome = yield* runControl(
      fake,
      (s) => s.cancelEntries(TARGET),
      seedOrder("0xentry", "open", 0, 2_950),
    );

    assert.deepEqual(fake.protectedCancels, [["0xentry"]]);
    assert.deepEqual(outcome.cancelledCloids, ["0xsecond"]);
    assert.ok(
      outcome.summary.includes("Cancelled 1 of 2 resting entry order(s); 1 could not be confirmed"),
      outcome.summary,
    );
    assert.ok(outcome.summary.includes("stays protected"), outcome.summary);
  }),
);

it("describeEntryCancellation never claims more than was acknowledged", () => {
  const report = (acknowledged: string[], unconfirmed: string[]) => ({
    acknowledged,
    unconfirmed: unconfirmed.map((cloid) => ({ cloid, reason: "refused" })),
  });
  // All confirmed: the plain count.
  assert.equal(
    describeEntryCancellation(2, report(["0xa", "0xb"], [])),
    "Cancelled 2 resting entry order(s).",
  );
  // Mixed: how many of how many, and the residue named.
  assert.equal(
    describeEntryCancellation(3, report(["0xa"], ["0xb", "0xc"])),
    "Cancelled 1 of 3 resting entry order(s); 2 could not be confirmed.",
  );
  // None: not a zero-count "cancelled 0" — a refusal to claim cancellation.
  assert.equal(
    describeEntryCancellation(2, report([], ["0xa", "0xb"])),
    "Cancellation was not confirmed for 2 resting entry order(s).",
  );
});

it.effect("reduce_position takes the requested fraction of the canonical position", () =>
  Effect.gen(function* () {
    for (const [percent, expected] of [
      [25, 0.125],
      [50, 0.25],
      [75, 0.375],
      [100, 0.5],
    ] as const) {
      const fake = makeFake({ positionSize: 0.5 });
      yield* runControl(fake, (s) => s.reducePosition({ ...TARGET, percent }));
      assert.equal(fake.exits[0], expected, `${percent}%`);
    }
  }),
);

it.effect("reduce_position sizes off the canonical position, not a remembered one", () =>
  Effect.gen(function* () {
    // The position moved since the button was rendered. 50% means 50% of what
    // exists now.
    const fake = makeFake({ positionSize: 0.2 });
    yield* runControl(fake, (s) => s.reducePosition({ ...TARGET, percent: 50 }));
    assert.equal(fake.exits[0], 0.1);
  }),
);

it.effect("reduce_position reduces a short by buying", () =>
  Effect.gen(function* () {
    const fake = makeFake({ positionSize: -0.4 });
    yield* runControl(fake, (s) => s.reducePosition({ ...TARGET, percent: 50 }));
    assert.equal(fake.exits[0], -0.2);
  }),
);

it.effect("close_position closes the whole canonical position", () =>
  Effect.gen(function* () {
    const fake = makeFake({ positionSize: 0.5 });
    const outcome = yield* runControl(fake, (s) => s.closePosition(TARGET));

    assert.deepEqual(fake.exits, [0.5]);
    assert.equal(outcome.positionSize, 0);
    assert.ok(outcome.summary.includes("closed"));
  }),
);

it.effect("close_position on a flat position does nothing", () =>
  Effect.gen(function* () {
    const fake = makeFake({ positionSize: 0 });
    const outcome = yield* runControl(fake, (s) => s.closePosition(TARGET));

    assert.deepEqual(fake.exits, []);
    assert.ok(outcome.summary.includes("Already flat"));
  }),
);

it.effect("close_and_revoke finalizes a flat single-market mission", () =>
  Effect.gen(function* () {
    const fake = makeFake({ positions: { ETH: 0.5 } });
    const outcome = yield* runControl(fake, (s) => s.closeAndRevokeMission({ missionId: MISSION }));

    // The close ran first — revoking before the close would end the authority
    // the close itself runs under — and the revoke is the SECOND transition.
    assert.deepEqual(fake.exitLog, [{ market: "ETH", size: 0.5 }]);
    assert.deepEqual(fake.transitions, ["paused", "revoked"]);
    assert.equal(outcome.finalized, true);
    assert.equal(outcome.status, "revoked");
    assert.ok(outcome.summary.includes("Authority revoked"), outcome.summary);
  }),
);

it.effect("every control runs with no harness service in context", () =>
  Effect.gen(function* () {
    // The negative property §14.7 turns on, exercised across all eight in one
    // context that contains no coordinator, no preview service, no provider
    // session, and no harness binding. Reaching for any of them would fail to
    // build rather than fall back.
    const fake = makeFake({ positions: { ETH: 0.5 } });
    const summaries = yield* runControl(
      fake,
      (s) =>
        Effect.gen(function* () {
          const pause = yield* s.pause({ missionId: MISSION });
          const resume = yield* s.resume({ missionId: MISSION });
          const cancel = yield* s.cancelEntries(TARGET);
          const reduce = yield* s.reducePosition({ ...TARGET, percent: 25 });
          const close = yield* s.closePosition(TARGET);
          const revoke = yield* s.revoke({ missionId: MISSION });
          const closeRevoke = yield* s.closeAndRevokeMission({ missionId: MISSION });
          const threadEnd = yield* s.endMissionForThreadEnding({ missionId: MISSION });
          return [pause, resume, cancel, reduce, close, revoke, closeRevoke, threadEnd].map(
            (o) => o.summary,
          );
        }),
      seedOrder("0xentry", "open", 0, 2_950),
    );

    assert.equal(summaries.length, 8);
    assert.equal(
      summaries.every((s) => s.length > 0),
      true,
    );
  }),
);

// ---------------------------------------------------------------------------
// Mission-level finalization (RC01): authority ends exactly once, and only
// after every held market is canonically flat and mission-owned increasing
// orders can no longer reopen exposure. The per-market cases below are the
// ones the R1 review named: a flat first market must never end a mission
// whose second market is still open, unreadable, or unknown.
// ---------------------------------------------------------------------------

it.effect("a flat first market does not revoke while a second remains open", () =>
  Effect.gen(function* () {
    // ETH flat, BTC 1 short. The bounded close fills nothing (fraction 0), so
    // BTC stays open and the authority must survive the whole pass.
    const fake = makeFake({
      missionMarkets: ["ETH", "BTC"],
      positions: { ETH: 0, BTC: 1 },
      exitFillFraction: 0,
    });
    const outcome = yield* runControl(fake, (s) => s.closeAndRevokeMission({ missionId: MISSION }));

    assert.equal(outcome.finalized, false);
    assert.deepEqual(fake.transitions, ["paused"]);
    const btc = marketResult(outcome.markets, "BTC");
    assert.ok(btc !== undefined);
    assert.equal(btc.outcome, "remains");
    assert.equal(btc.positionSize, 1);
    const eth = marketResult(outcome.markets, "ETH");
    assert.ok(eth !== undefined);
    assert.equal(eth.outcome, "flat");
    assert.ok(outcome.summary.includes("BTC is still open"), outcome.summary);
    assert.ok(outcome.summary.includes("Authority was not revoked"), outcome.summary);
    // Every submitted exit targeted the open market, never the flat one.
    assert.ok(fake.exitLog.length > 0);
    assert.ok(
      fake.exitLog.every((exit) => exit.market === "BTC"),
      fake.exitLog.map((exit) => `${exit.market}:${exit.size}`).join(","),
    );
  }),
);

it.effect("a second market's read failure keeps the authority as unconfirmed", () =>
  Effect.gen(function* () {
    // Canonical read sequence: ETH's close read (1, ok), BTC's close read
    // (2, fail), ETH's confirmation read (3, ok), BTC's confirmation read
    // (4, fail). BTC can never be confirmed, so nothing may end.
    const fake = makeFake({
      missionMarkets: ["ETH", "BTC"],
      positions: { ETH: 0, BTC: 1 },
      snapshotReads: ["ok", "fail", "ok", "fail"],
    });
    const outcome = yield* runControl(fake, (s) => s.closeAndRevokeMission({ missionId: MISSION }));

    assert.equal(outcome.finalized, false);
    const btc = marketResult(outcome.markets, "BTC");
    assert.ok(btc !== undefined);
    assert.equal(btc.outcome, "unknown");
    assert.equal(btc.positionSize, null);
    assert.ok(outcome.summary.includes("could not be confirmed"), outcome.summary);
  }),
);

it.effect("a confirmed partial close keeps the authority with the remaining size", () =>
  Effect.gen(function* () {
    // Attempt 1 fills half, attempt 2 fills nothing: 0.25 of 0.5 remains.
    const fake = makeFake({ positions: { ETH: 0.5 }, exitFillPlan: [0.5, 0] });
    const outcome = yield* runControl(fake, (s) => s.closeAndRevokeMission({ missionId: MISSION }));

    assert.equal(outcome.finalized, false);
    const eth = marketResult(outcome.markets, "ETH");
    assert.ok(eth !== undefined);
    assert.equal(eth.outcome, "remains");
    assert.equal(eth.positionSize, 0.25);
  }),
);

it.effect("an unknown close outcome keeps the authority unconfirmed", () =>
  Effect.gen(function* () {
    // The submitted close's re-read fails: the fill's effect is unknown, and
    // the confirmation read fails too, so the mission cannot end.
    const fake = makeFake({
      positions: { ETH: 0.5 },
      exitFillFraction: 0,
      snapshotReads: ["ok", "fail", "fail"],
    });
    const outcome = yield* runControl(fake, (s) => s.closeAndRevokeMission({ missionId: MISSION }));

    assert.equal(outcome.finalized, false);
    const eth = marketResult(outcome.markets, "ETH");
    assert.ok(eth !== undefined);
    assert.equal(eth.outcome, "unknown");
    assert.equal(eth.positionSize, null);
    assert.ok(outcome.summary.includes("Authority was not revoked"), outcome.summary);
  }),
);

it.effect("all canonical reads unavailable leaves the mission nonterminal", () =>
  Effect.gen(function* () {
    const fake = makeFake({
      missionMarkets: ["ETH", "BTC"],
      positions: { ETH: 1, BTC: 1 },
      // Every canonical read fails: closes, and confirmations alike.
      snapshotReads: Array.from({ length: 8 }, () => "fail" as const),
    });
    const outcome = yield* runControl(fake, (s) => s.closeAndRevokeMission({ missionId: MISSION }));

    // No submission ever happened (reads gate the loop), and no transition
    // beyond the entry-blocking pause.
    assert.deepEqual(fake.exitLog, []);
    assert.deepEqual(fake.transitions, ["paused"]);
    assert.equal(outcome.finalized, false);
    assert.ok(outcome.markets.every((market) => market.outcome === "unknown"));
    assert.ok(outcome.summary.includes("could not be confirmed"), outcome.summary);
  }),
);

it.effect("three held markets each get an explicit result", () =>
  Effect.gen(function* () {
    const fake = makeFake({
      missionMarkets: ["ETH", "BTC", "SOL"],
      positions: { ETH: 0, BTC: 1, SOL: 0 },
      exitFillFraction: 0,
    });
    const outcome = yield* runControl(fake, (s) => s.closeAndRevokeMission({ missionId: MISSION }));

    assert.equal(outcome.finalized, false);
    assert.equal(outcome.markets.length, 3);
    assert.equal(marketResult(outcome.markets, "ETH")?.outcome, "flat");
    assert.equal(marketResult(outcome.markets, "BTC")?.outcome, "remains");
    assert.equal(marketResult(outcome.markets, "SOL")?.outcome, "flat");
  }),
);

it.effect("market order does not decide which market survives", () =>
  Effect.gen(function* () {
    // The mirror of the flat-first case: the open market leads, the flat one
    // follows, and the outcome is the same either way.
    const fake = makeFake({
      missionMarkets: ["BTC", "ETH"],
      positions: { ETH: 1, BTC: 0 },
      exitFillFraction: 0,
    });
    const outcome = yield* runControl(fake, (s) => s.closeAndRevokeMission({ missionId: MISSION }));

    assert.equal(outcome.finalized, false);
    assert.equal(marketResult(outcome.markets, "ETH")?.outcome, "remains");
    assert.equal(marketResult(outcome.markets, "BTC")?.outcome, "flat");
  }),
);

it.effect("a held market added during finalization is not processed and blocks the end", () =>
  Effect.gen(function* () {
    // The mission holds ETH at the start; by the confirmation re-read it also
    // holds BTC. A market the pass never closed cannot be claimed flat.
    const fake = makeFake({
      missionMarketsByCall: [["ETH"], ["ETH", "BTC"]],
      positions: { ETH: 0 },
    });
    const outcome = yield* runControl(fake, (s) => s.closeAndRevokeMission({ missionId: MISSION }));

    assert.equal(outcome.finalized, false);
    const btc = marketResult(outcome.markets, "BTC");
    assert.ok(btc !== undefined);
    assert.equal(btc.outcome, "unprocessed");
    assert.equal(btc.positionSize, null);
  }),
);

it.effect("unconfirmed increasing-order cancellation blocks the end even when flat", () =>
  Effect.gen(function* () {
    // RC03 dependency resolved: the acknowledgement is real now, so a resting
    // entry whose cancellation the exchange refused keeps the authority even
    // though every position reads flat — the entry may still fill.
    const fake = makeFake({ positions: { ETH: 0 }, cancelRejections: ["0xentry"] });
    const outcome = yield* runControl(
      fake,
      (s) => s.closeAndRevokeMission({ missionId: MISSION }),
      seedOrder("0xentry", "open", 0, null),
    );

    assert.equal(outcome.finalized, false);
    assert.deepEqual(fake.cancels, ["0xentry"]);
    assert.ok(
      outcome.summary.includes("1 of 1 resting increasing order(s) were not confirmed cancelled"),
      outcome.summary,
    );
  }),
);

it.effect("an acknowledged increasing-order cancellation lets a flat mission finalize", () =>
  Effect.gen(function* () {
    // The mirror of the blocked case: the exchange confirmed the cancel, the
    // positions are flat, and finalization proceeds exactly once.
    const fake = makeFake({ positions: { ETH: 0 } });
    const outcome = yield* runControl(
      fake,
      (s) => s.closeAndRevokeMission({ missionId: MISSION }),
      seedOrder("0xentry", "open", 0, null),
    );

    assert.equal(outcome.finalized, true);
    assert.equal(outcome.status, "revoked");
    assert.deepEqual(outcome.cancelledCloids, ["0xentry"]);
    assert.deepEqual(fake.cancels, ["0xentry"]);
  }),
);

it.effect("a guard-transition failure stops the finalization before any close", () =>
  Effect.gen(function* () {
    const fake = makeFake({
      missionStatus: "executing",
      positions: { ETH: 1 },
      failTransitionsTo: ["paused"],
    });
    const failure = yield* Effect.flip(
      runControl(fake, (s) => s.closeAndRevokeMission({ missionId: MISSION })),
    );

    assert.equal(failure._tag, "TradingControlError");
    if (failure._tag === "TradingControlError") {
      assert.equal(failure.reason, "transition_rejected");
    }
    assert.deepEqual(fake.exitLog, []);
    assert.deepEqual(fake.transitions, []);
  }),
);

it.effect("an already-terminal mission is a no-op: no second revoke, no close orders", () =>
  Effect.gen(function* () {
    const fake = makeFake({ missionStatus: "revoked", positions: { ETH: 1 } });
    const outcome = yield* runControl(fake, (s) => s.closeAndRevokeMission({ missionId: MISSION }));

    assert.equal(outcome.finalized, true);
    assert.equal(outcome.status, "revoked");
    assert.deepEqual(fake.transitions, []);
    assert.deepEqual(fake.exitLog, []);
    assert.ok(outcome.summary.includes("already revoked"), outcome.summary);
  }),
);

it.effect("a blocked mission finalizes without re-pausing, keeping its blocked record", () =>
  Effect.gen(function* () {
    // Pausing a blocked mission would erase the persisted blocked reason;
    // blocked already refuses entries, so the pass must not touch it.
    const fake = makeFake({ missionStatus: "blocked", positions: { ETH: 0.5 } });
    const outcome = yield* runControl(fake, (s) => s.closeAndRevokeMission({ missionId: MISSION }));

    assert.deepEqual(fake.transitions, ["revoked"]);
    assert.equal(outcome.finalized, true);
  }),
);

it.effect("thread ending completes a traded, unblocked mission", () =>
  Effect.gen(function* () {
    const fake = makeFake({ positions: { ETH: 0.5 } });
    const outcome = yield* runControl(
      fake,
      (s) => s.endMissionForThreadEnding({ missionId: MISSION }),
      seedFill,
    );

    assert.deepEqual(fake.transitions, ["paused", "completed"]);
    assert.equal(outcome.finalized, true);
    assert.equal(outcome.status, "completed");
  }),
);

it.effect("thread ending revokes a mission that never traded", () =>
  Effect.gen(function* () {
    const fake = makeFake({ positions: { ETH: 0.5 } });
    const outcome = yield* runControl(fake, (s) =>
      s.endMissionForThreadEnding({ missionId: MISSION }),
    );

    assert.equal(outcome.status, "revoked");
    assert.equal(outcome.finalized, true);
  }),
);

it.effect("thread ending revokes a traded mission that was blocked", () =>
  Effect.gen(function* () {
    const fake = makeFake({ missionStatus: "blocked", positions: { ETH: 0.5 } });
    const outcome = yield* runControl(
      fake,
      (s) => s.endMissionForThreadEnding({ missionId: MISSION }),
      seedFill,
    );

    assert.deepEqual(fake.transitions, ["revoked"]);
    assert.equal(outcome.status, "revoked");
  }),
);

// ---------------------------------------------------------------------------
// Manual close truthfulness (R2-2/R2-3): the summary reports what actually
// happened on the exchange — closed, partly closed, or failed with the
// exchange's verbatim rejection — never "partly closed" for an untouched
// position.
// ---------------------------------------------------------------------------

const MANUAL = {
  accountId: "acct_manual",
  masterAddress: "0xmaster",
  market: "ETH",
};

it.effect("manual close that fills nothing reports failure with the exchange's reason", () =>
  Effect.gen(function* () {
    const fake = makeFake({
      positionSize: 0.2,
      manualExitRejection: "Order could not immediately match against any resting orders.",
    });
    const outcome = yield* runControl(fake, (s) => s.closeManualPosition(MANUAL));

    assert.equal(outcome.outcome, "done");
    if (outcome.outcome !== "done") return;
    assert.equal(outcome.positionSize, 0.2);
    assert.ok(outcome.summary.startsWith("Close failed"), outcome.summary);
    assert.ok(
      outcome.summary.includes("Order could not immediately match against any resting orders."),
      outcome.summary,
    );
    assert.ok(!outcome.summary.includes("partly closed"), outcome.summary);
  }),
);

it.effect("manual close that half fills reports partly closed", () =>
  Effect.gen(function* () {
    const fake = makeFake({ positionSize: 0.5, manualExitFillFraction: 0.5 });
    const outcome = yield* runControl(fake, (s) => s.closeManualPosition(MANUAL));

    assert.equal(outcome.outcome, "done");
    if (outcome.outcome !== "done") return;
    assert.ok(Math.abs(outcome.positionSize) > 0);
    assert.ok(outcome.summary.includes("partly closed"), outcome.summary);
    assert.ok(!outcome.summary.startsWith("Close failed"), outcome.summary);
  }),
);

it.effect("manual close that fully fills reports closed", () =>
  Effect.gen(function* () {
    const fake = makeFake({ positionSize: 0.3 });
    const outcome = yield* runControl(fake, (s) => s.closeManualPosition(MANUAL));

    assert.equal(outcome.outcome, "done");
    if (outcome.outcome !== "done") return;
    assert.equal(outcome.positionSize, 0);
    assert.equal(outcome.summary, "Position closed.");
  }),
);

// ---------------------------------------------------------------------------
// Failed reads are failures (06A): a dead canonical account read or a dead
// resting-order read must never be narrated as "flat" or "nothing to cancel".
// ---------------------------------------------------------------------------

it.effect("a failed initial canonical read fails the control instead of reporting flat", () =>
  Effect.gen(function* () {
    // reducePosition, closePosition, and the manual lane all read the
    // canonical account before touching the exchange; the first read failing
    // means no submission and no success outcome for each of them.
    for (const run of [
      (s: TradingControlService["Service"]) => s.reducePosition({ ...TARGET, percent: 50 }),
      (s: TradingControlService["Service"]) => s.closePosition(TARGET),
      (s: TradingControlService["Service"]) => s.closeManualPosition(MANUAL),
    ] as Array<
      (
        s: TradingControlService["Service"],
      ) => Effect.Effect<ControlOutcome | ManualCloseOutcome, TradingControlError>
    >) {
      const fake = makeFake({ positionSize: 10, snapshotReads: ["fail"] });
      const error = yield* runControl(fake, (s) => Effect.flip(run(s)));

      assert.equal(error._tag, "TradingControlError");
      assert.equal(error.reason, "exchange_action_failed");
      assert.ok(error.detail?.includes("canonical account read failed"), error.detail);
      assert.deepEqual(fake.exits, [], "no order may be submitted after a failed initial read");
    }
  }),
);

it.effect("a healthy absent position still reads Already flat", () =>
  Effect.gen(function* () {
    // The read succeeded and the exchange holds nothing: that is a real flat,
    // not a fabricated one, and both lanes must keep reporting it.
    const reduce = yield* runControl(makeFake({ positionSize: 0 }), (s) =>
      s.reducePosition({ ...TARGET, percent: 50 }),
    );
    assert.ok(reduce.summary.includes("Already flat"));

    const manual = yield* runControl(makeFake({ positionSize: 0 }), (s) =>
      s.closeManualPosition(MANUAL),
    );
    assert.equal(manual.outcome, "done");
    if (manual.outcome === "done") assert.ok(manual.summary.includes("Already flat"));
  }),
);

it.effect("an unconfirmable post-submit read reports an unknown close, never a size", () =>
  Effect.gen(function* () {
    // Reads: flat-check ok, loop initial ok, submit one IOC that only partly
    // fills (10 -> 8), then the confirming read fails. Exactly one
    // submission, an explicit unknown outcome, and no numeric zero.
    const fake = makeFake({
      positionSize: 10,
      exitFillFraction: 0.2,
      snapshotReads: ["ok", "ok", "fail"],
    });
    const outcome = yield* runControl(fake, (s) => s.closePosition(TARGET));

    assert.equal(fake.exits.length, 1);
    assert.equal(fake.exits[0], 10);
    assert.equal(outcome.positionSize, null);
    assert.equal(
      outcome.summary,
      "Close outcome unknown: an order may have executed; position could not be confirmed.",
    );
    assert.ok(!outcome.summary.includes("closed"));
  }),
);

it.effect("an unconfirmable post-submit read never retries on a stale size", () =>
  Effect.gen(function* () {
    // Short side of the same guard: -10, one partial IOC, then the re-read
    // fails. The loop must stop after that single submission rather than
    // submit again sized from the pre-submit read.
    const fake = makeFake({
      positionSize: -10,
      exitFillFraction: 0.2,
      snapshotReads: ["ok", "ok", "fail"],
    });
    const outcome = yield* runControl(fake, (s) => s.reducePosition({ ...TARGET, percent: 100 }));

    assert.deepEqual(fake.exits, [-10]);
    assert.equal(outcome.positionSize, null);
    assert.ok(outcome.summary.startsWith("Close outcome unknown"));
  }),
);

it.effect(
  "the manual lane fails with the unknown-outcome error when its confirming read fails",
  () =>
    Effect.gen(function* () {
      const fake = makeFake({
        positionSize: 10,
        manualExitFillFraction: 0.2,
        snapshotReads: ["ok", "ok", "fail"],
      });
      const error = yield* runControl(fake, (s) => Effect.flip(s.closeManualPosition(MANUAL)));

      assert.equal(error._tag, "TradingControlError");
      assert.equal(error.reason, "exchange_action_failed");
      assert.ok(error.detail?.startsWith("Close outcome unknown"), error.detail);
      assert.equal(fake.exits.length, 1);
    }),
);

it.effect("close_and_revoke does not revoke when the close outcome stays unknown", () =>
  Effect.gen(function* () {
    // Read plan: initial read (ok), post-submit re-read (fail — the fill's
    // effect is unknown), confirmation read (fail — still unconfirmable).
    const fake = makeFake({
      positions: { ETH: 10 },
      exitFillFraction: 0.2,
      snapshotReads: ["ok", "ok", "fail", "fail"],
    });
    const outcome = yield* runControl(fake, (s) => s.closeAndRevokeMission({ missionId: MISSION }));

    const eth = marketResult(outcome.markets, "ETH");
    assert.ok(eth !== undefined);
    assert.equal(eth.positionSize, null);
    assert.equal(outcome.finalized, false);
    assert.deepEqual(fake.transitions, ["paused"], "an unknown close must not reach the revoke");
    assert.ok(outcome.summary.includes("could not be confirmed"), outcome.summary);
    assert.ok(outcome.summary.includes("Authority was not revoked"), outcome.summary);
  }),
);

it.effect("close_and_revoke with a confirmed partial close keeps the authority", () =>
  Effect.gen(function* () {
    // Two bounded attempts at 20% fill each cannot reach flat: the truthful
    // close result stands and the revoke is withheld.
    const fake = makeFake({ positions: { ETH: 10 }, exitFillFraction: 0.2 });
    const outcome = yield* runControl(fake, (s) => s.closeAndRevokeMission({ missionId: MISSION }));

    assert.equal(outcome.finalized, false);
    assert.deepEqual(fake.transitions, ["paused"]);
    const eth = marketResult(outcome.markets, "ETH");
    assert.ok(eth !== undefined);
    assert.equal(eth.outcome, "remains");
    assert.equal(eth.positionSize, 6.4);
    assert.ok(outcome.summary.includes("ETH is still open"), outcome.summary);
    assert.ok(outcome.summary.includes("a position is still open"), outcome.summary);
  }),
);

it.effect("close_and_revoke with a confirmed no-fill close keeps the authority", () =>
  Effect.gen(function* () {
    const fake = makeFake({
      positions: { ETH: 10 },
      exitRejection: "Order could not immediately match against any resting orders.",
    });
    const outcome = yield* runControl(fake, (s) => s.closeAndRevokeMission({ missionId: MISSION }));

    assert.equal(outcome.finalized, false);
    assert.deepEqual(fake.transitions, ["paused"]);
    const eth = marketResult(outcome.markets, "ETH");
    assert.ok(eth !== undefined);
    assert.equal(eth.outcome, "remains");
    assert.equal(eth.positionSize, 10);
    assert.ok(outcome.summary.includes("a position is still open"), outcome.summary);
  }),
);

it.effect("a failed resting-order read stops cancel_entries before any cancellation", () =>
  Effect.gen(function* () {
    // The SELECT itself fails (the table is gone). The old empty-array
    // fallback answered this as "No resting entry orders to cancel."
    const seedBrokenOrders = Effect.gen(function* () {
      yield* seedOrder("0xentry", "open", 0, 2_950);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DROP TABLE trading_orders`;
    }).pipe(Effect.orDie);

    const fake = makeFake();
    const error = yield* runControl(
      fake,
      (s) => Effect.flip(s.cancelEntries(TARGET)),
      seedBrokenOrders,
    );

    assert.equal(error._tag, "TradingControlError");
    assert.equal(error.reason, "exchange_action_failed");
    assert.ok(error.detail?.includes("resting-order read failed"), error.detail);
    assert.deepEqual(fake.protectedCancels, []);
    assert.deepEqual(fake.cancels, []);
  }),
);

// ---------------------------------------------------------------------------
// Held-market ownership in the manual close lane (06B): the held set
// (migration 079) is the authority, secondary markets refuse too, and a
// failed ownership read is a typed failure — never "nobody holds it".
// ---------------------------------------------------------------------------

const seedMissionHolding = (
  missionId: string,
  status: string,
  heldMarkets: ReadonlyArray<{ readonly market: string; readonly released: boolean }>,
): Effect.Effect<void, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO trading_accounts (
        account_id, user_id, environment,
        master_wallet_json, execution_wallet_json, status, created_at, updated_at
      ) VALUES (
        'acct_1', 'local', 'testnet',
        '{"privyWalletId":"pw_1","address":"0xmaster","ownership":"user"}',
        '{"privyWalletId":"pw_1","address":"0xmaster","hyperliquidAgentName":"t3","ownership":"service"}',
        'active', 0, 0
      )
    `;
    yield* sql`
      INSERT INTO trading_missions (
        mission_id, user_id, trading_account_id, instruction, market,
        harness_json, status, control_json, authority_version, version,
        created_at, updated_at
      ) VALUES (
        ${missionId}, 'local', 'acct_1', 'trade', 'ETH', '{}', ${status},
        '{}', 1, 1, 1, 1
      )
    `;
    for (const held of heldMarkets) {
      yield* sql`
        INSERT INTO trading_mission_markets (
          mission_id, user_id, venue, market, bound_at, released_at
        ) VALUES (
          ${missionId}, 'local', 'hyperliquid', ${held.market}, 1,
          ${held.released ? 1 : null}
        )
      `;
    }
  }).pipe(Effect.orDie);

it.effect("manual close refuses a held secondary market (06B)", () =>
  Effect.gen(function* () {
    // Mission primary ETH, held ETH and BTC: closing BTC by hand refuses even
    // though trading_missions.market says ETH, and nothing is submitted.
    const fake = makeFake({ positionSize: 0.5 });
    const outcome = yield* runControl(
      fake,
      (s) => s.closeManualPosition({ ...MANUAL, market: "BTC" }),
      seedMissionHolding("m_multi", "position_open", [
        { market: "ETH", released: false },
        { market: "BTC", released: false },
      ]),
    );

    assert.equal(outcome.outcome, "refused");
    if (outcome.outcome === "refused") {
      assert.equal(outcome.reason, "market_owned_by_mission");
      assert.ok(outcome.detail.includes("m_multi"));
    }
    assert.deepEqual(fake.exits, []);
  }),
);

it.effect("manual close works again on a released market (06B)", () =>
  Effect.gen(function* () {
    const fake = makeFake({ positionSize: 0 });
    const outcome = yield* runControl(
      fake,
      (s) => s.closeManualPosition({ ...MANUAL, market: "BTC" }),
      seedMissionHolding("m_released", "position_open", [
        { market: "ETH", released: false },
        { market: "BTC", released: true },
      ]),
    );

    assert.equal(outcome.outcome, "done");
    if (outcome.outcome === "done") assert.ok(outcome.summary.includes("Already flat"));
  }),
);

it.effect("a failed ownership read fails the manual close with no submission (06B)", () =>
  Effect.gen(function* () {
    const breakHeldTable = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DROP TABLE trading_mission_markets`;
    }).pipe(Effect.orDie);

    const fake = makeFake({ positionSize: 0.5 });
    const error = yield* runControl(
      fake,
      (s) => Effect.flip(s.closeManualPosition({ ...MANUAL, market: "BTC" })),
      breakHeldTable,
    );

    assert.equal(error._tag, "TradingControlError");
    assert.equal(error.reason, "exchange_action_failed");
    assert.ok(error.detail?.includes("held-market ownership read failed"), error.detail);
    assert.deepEqual(fake.exits, []);
  }),
);

// ---------------------------------------------------------------------------
// Observed reductions (06D): the success line reports the canonical net
// decrease with the requested percent alongside — never a fill attributed
// from the position delta, never a percentage for a sign flip or growth.
// ---------------------------------------------------------------------------

it.effect("reports the observed decrease alongside the requested percent (06D)", () =>
  Effect.gen(function* () {
    // Start 10, request 50%: attempt 1 submits 5 and fills 40% of it (10 -> 8);
    // attempt 2 fills nothing, so the total reduction is exactly 2.
    const fake = makeFake({ positionSize: 10, exitFillPlan: [0.4, 0] });
    const outcome = yield* runControl(fake, (s) => s.reducePosition({ ...TARGET, percent: 50 }));

    assert.deepEqual(fake.exits, [5, 3]);
    assert.equal(outcome.positionSize, 8);
    assert.equal(
      outcome.summary,
      "Position size decreased by 20% (10 to 8 ETH); requested 50%.",
      outcome.summary,
    );
  }),
);

it.effect("a fully-filled requested half reports 50% observed (06D)", () =>
  Effect.gen(function* () {
    const fake = makeFake({ positionSize: 10, exitFillPlan: [1] });
    const outcome = yield* runControl(fake, (s) => s.reducePosition({ ...TARGET, percent: 50 }));

    assert.equal(
      outcome.summary,
      "Position size decreased by 50% (10 to 5 ETH); requested 50%.",
      outcome.summary,
    );
  }),
);

it.effect("a short reports its observed decrease with signed sizes (06D)", () =>
  Effect.gen(function* () {
    const fake = makeFake({ positionSize: -10, exitFillPlan: [0.4, 0] });
    const outcome = yield* runControl(fake, (s) => s.reducePosition({ ...TARGET, percent: 50 }));

    assert.equal(
      outcome.summary,
      "Position size decreased by 20% (-10 to -8 ETH); requested 50%.",
      outcome.summary,
    );
  }),
);

it.effect("a reduction that fills nothing is still a failure, not a percent (06D)", () =>
  Effect.gen(function* () {
    const fake = makeFake({ positionSize: 10, exitFillPlan: [0, 0] });
    const outcome = yield* runControl(fake, (s) => s.reducePosition({ ...TARGET, percent: 50 }));

    assert.ok(outcome.summary.startsWith("Reduce failed"), outcome.summary);
    assert.ok(!outcome.summary.includes("%"), outcome.summary);
  }),
);

it.effect("a concurrent increase is never narrated as an attributed fill (06D)", () =>
  Effect.gen(function* () {
    // Attempt 1 fills its 5, then a concurrent scale-in adds 6 between the
    // reconcile and the re-read: the position GREW. No percentage may appear.
    let scaledIn = false;
    const fake = makeFake({
      positionSize: 10,
      exitFillPlan: [1, 0],
      onReconcile: () => {
        if (scaledIn) return;
        scaledIn = true;
        fake.positionSize += 6;
      },
    });
    const outcome = yield* runControl(fake, (s) => s.reducePosition({ ...TARGET, percent: 50 }));

    assert.ok(outcome.summary.startsWith("Position changed during reduction"), outcome.summary);
    assert.ok(outcome.summary.includes("Confirmed current position: 11 ETH"), outcome.summary);
    assert.ok(!outcome.summary.includes("decreased by"), outcome.summary);
  }),
);

it.effect("a sign flip reports the changed position, not a fictitious fill (06D)", () =>
  Effect.gen(function* () {
    // The submitted 5 fills 12 (an opposing book): 10 long becomes 2 short.
    const fake = makeFake({ positionSize: 10, exitFillPlan: [2.4] });
    const outcome = yield* runControl(fake, (s) => s.reducePosition({ ...TARGET, percent: 50 }));

    assert.ok(outcome.summary.startsWith("Position changed during reduction"), outcome.summary);
    assert.ok(outcome.summary.includes("Confirmed current position: -2 ETH"), outcome.summary);
    assert.ok(!outcome.summary.includes("decreased by"), outcome.summary);
  }),
);

it.effect("a confirmed flat from a reduce reports 100% observed (06D)", () =>
  Effect.gen(function* () {
    // Requested 50, but concurrent activity closed the rest: the canonical
    // read is flat, and flat is a same-side decrease to zero.
    const fake = makeFake({
      positionSize: 10,
      exitFillPlan: [1],
      onReconcile: () => {
        fake.positionSize = 0;
      },
    });
    const outcome = yield* runControl(fake, (s) => s.reducePosition({ ...TARGET, percent: 50 }));

    assert.equal(outcome.positionSize, 0);
    assert.equal(
      outcome.summary,
      "Position size decreased by 100% (10 to 0 ETH); requested 50%.",
      outcome.summary,
    );
  }),
);

// ---------------------------------------------------------------------------
// 09A companion: an exhausted, blocked mission keeps its provider-free
// risk-reducing controls. §14.7 availability does not depend on the harness —
// or on the mission's blocked state.
// ---------------------------------------------------------------------------

it.effect("risk-reducing controls stay usable on a blocked, exhausted mission (09A)", () =>
  Effect.gen(function* () {
    const seedBlockedMission = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO trading_accounts (
          account_id, user_id, environment,
          master_wallet_json, execution_wallet_json, status, created_at, updated_at
        ) VALUES (
          'acct_1', 'local', 'testnet',
          '{"privyWalletId":"pw_1","address":"0xmaster","ownership":"user"}',
          '{"privyWalletId":"pw_1","address":"0xmaster","hyperliquidAgentName":"t3","ownership":"service"}',
          'active', 0, 0
        )
      `;
      yield* sql`
        INSERT INTO trading_missions (
          mission_id, user_id, trading_account_id, instruction, market,
          harness_json, status, control_json, authority_version, version,
          created_at, updated_at
        ) VALUES (
          ${MISSION}, 'local', 'acct_1', 'trade', 'ETH', '{}', 'blocked',
          '{}', 1, 1, 1, 1
        )
      `;
    }).pipe(Effect.orDie);

    // A partial reduction still succeeds — the §14.7 buttons are the way out
    // of a blocked mission, so blocking must not take them with it.
    const fake = makeFake({ positionSize: 0.5, exitFillFraction: 0.5 });
    const outcome = yield* runControl(
      fake,
      (s) => s.reducePosition({ ...TARGET, percent: 50 }),
      seedBlockedMission,
    );

    assert.equal(fake.exits.length > 0, true);
    assert.ok(outcome.summary.includes("decreased by"), outcome.summary);
  }),
);
