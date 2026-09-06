/**
 * The request → domain → projection loop.
 *
 * These tests exercise the ordering the whole design rests on: a `*-requested`
 * event is applied by the reactor through `TradingMissionService`, and only the
 * resulting `trading.mission.status-set` reaches the projection. A control the
 * domain refuses must leave the projection showing the status still in force.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TradingMissionId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../config.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { makeProviderRegistryLayer } from "../provider/testUtils/providerRegistryMock.ts";
import { clearSessionProfile, isTradingThread } from "../provider/SessionProfile.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import type { HarnessRunRequest } from "./Schemas.ts";
import { TradingMissionProjection } from "./TradingMissionProjection.ts";
import {
  LOCAL_TRADING_USER_ID,
  TradingMissionReactor,
  TradingMissionReactorLive,
} from "./TradingMissionReactor.ts";
import { TradingMissionService } from "./TradingMissionService.ts";
import {
  HyperliquidReconciler,
  type ReconcileInput,
  type ReconciliationTrigger,
} from "./HyperliquidReconciler.ts";
import { TradingProtectionService } from "./TradingProtectionService.ts";
import { makeTradingExecutionGuard } from "./TradingExecutionGuard.ts";
import { HyperliquidExecutionService } from "./HyperliquidExecutionService.ts";
import { TradingWatchService } from "./TradingWatchService.ts";
import { TradingTurnCoordinator } from "./TradingTurnCoordinator.ts";
import { FALLBACK_MISSION_CAPITAL_USD } from "./MissionCapital.ts";
import { TradingLayerLive } from "./runtimeLayer.ts";
import { makeTradingControlService, TradingControlService } from "./TradingControlService.ts";
import { TradingLeaseTarget, TradingRuntimeLease } from "./TradingRuntimeLease.ts";
import { HyperliquidGateway } from "@t3tools/hyperliquid";
import { HyperliquidInfoClient } from "@t3tools/hyperliquid/InfoClient";

const THREAD_ID = ThreadId.make("thread-trading-reactor");
const MISSION_ID = TradingMissionId.make("mission-trading-reactor");

/** Mutable stand-in for the lease so the watchdog stand-down test can flip it. */
let watchdogLeaseHeld = true;
const fakeWatchdogLease = Layer.succeed(TradingRuntimeLease, {
  get held() {
    return watchdogLeaseHeld;
  },
  lockPath: null,
});

// The reactor now runs the §17.2 write side (preview → submit → reconcile) and
// the §18.2 startup reconcile, so its `make` depends on the execution services
// (guard, execution, reconciler, budget reader, signer). Provide the full
// trading layer rather than just the core mission layer.
const TestLayer = TradingMissionReactorLive.pipe(
  Layer.provideMerge(
    TradingLayerLive.pipe(Layer.provide(Layer.succeed(TradingLeaseTarget, { dbPath: ":memory:" }))),
  ),
  Layer.provideMerge(OrchestrationEngineLive),
  Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
  Layer.provideMerge(OrchestrationProjectionPipelineLive),
  Layer.provideMerge(OrchestrationEventStoreLive),
  Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
  Layer.provideMerge(RepositoryIdentityResolver.layer),
  // The reactor resolves a mission's harness driver kind by provider instance
  // id. No test here configures provider instances, so an empty registry is
  // the honest stand-in: the lookup finds nothing and the binding falls back.
  Layer.provideMerge(makeProviderRegistryLayer()),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-trading-reactor-" })),
  // Upstream's projection pipeline reads per-thread background liveness and
  // plan progress; every stack that builds it has to supply them.
  Layer.provideMerge(ThreadBackgroundLiveness.layer),
  Layer.provideMerge(ThreadPlanProgress.layer),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
);

const commandId = Crypto.Crypto.pipe(
  Effect.flatMap((crypto) => crypto.randomUUIDv4),
  Effect.orDie,
  Effect.map(CommandId.make),
);

const NOW = "2026-07-30T00:00:00.000Z";

/**
 * The engine projects each dispatch synchronously, but the reactor is a queue:
 * a request has to drain before the status-set it raises exists at all, and
 * that dispatch can enqueue nothing further, so one drain is enough.
 */
const settle = TradingMissionReactor.pipe(Effect.flatMap((reactor) => reactor.drain));

const createMission = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  yield* engine.dispatch({
    type: "trading.mission.create",
    commandId: yield* commandId,
    threadId: THREAD_ID,
    missionId: MISSION_ID,
    tradingAccountId: "acct-trading-reactor",
    instruction: "Trade ETH momentum",
    allocatedCapitalUsd: 1_000,
    createdAt: NOW,
  });
  yield* settle;
});

/**
 * The same create, with no capital stated — the path that resolves the mandate
 * from the account. Absent rather than zero: the two are different requests.
 */
const createMissionWithoutCapital = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  yield* engine.dispatch({
    type: "trading.mission.create",
    commandId: yield* commandId,
    threadId: THREAD_ID,
    missionId: MISSION_ID,
    tradingAccountId: "acct-trading-reactor",
    instruction: "Trade ETH momentum",
    createdAt: NOW,
  });
  yield* settle;
});

/** The master-wallet identity account reads resolve through (§10.6). */
const MASTER_ADDRESS = "0x000000000000000000000000000000000000beef";

/**
 * Provision the account row the mission names, so `getMasterWalletAddress`
 * resolves and the account read is actually reached. The wallet JSON shape is
 * the published `TradingMasterWallet` contract (§10.1).
 */
const seedTradingAccount = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const masterWalletJson =
    '{"privyWalletId":"wallet-trading-reactor",' +
    `"address":"${MASTER_ADDRESS}",` +
    '"ownership":"user"}';
  yield* sql`
    INSERT INTO trading_accounts (
      account_id, user_id, environment, master_wallet_json,
      execution_wallet_json, status, created_at, updated_at
    ) VALUES (
      'acct-trading-reactor', 'local', 'hyperliquid_testnet', ${masterWalletJson},
      ${masterWalletJson}, 'ready', 0, 0
    )
  `;
});

const control = (
  type: "trading.mission.pause" | "trading.mission.resume" | "trading.mission.revoke",
) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    yield* engine.dispatch({
      type,
      commandId: yield* commandId,
      threadId: THREAD_ID,
      missionId: MISSION_ID,
      createdAt: NOW,
    });
    yield* settle;
  });

const projectedMission = TradingMissionProjection.pipe(
  Effect.flatMap((projection) => projection.getByThreadId(THREAD_ID)),
  Effect.orDie,
);

/**
 * Move the test mission straight into the §16.4 blocked state, the way the
 * reactor's own `blockForExhaustion` does after a post-submit budget exhausts.
 * `initializing → blocked` is a legal §11.1 exit, so the service accepts it
 * directly; the reactor only reaches `blocked` through execution, which these
 * control-matrix tests do not drive. The matching `status-set` announcement is
 * dispatched afterwards so the projection reflects the blocked status, exactly
 * as the reactor's execution path does (TradingMissionReactor L438).
 */
const blockMission = Effect.gen(function* () {
  const missions = yield* TradingMissionService;
  yield* missions.transition({
    missionId: MISSION_ID,
    to: "blocked",
    expectedVersion: yield* missions.getMissionVersion(MISSION_ID),
    blockedReason: "cumulative_loss_limit",
  });
  const engine = yield* OrchestrationEngineService;
  yield* engine.dispatch({
    type: "trading.mission.status-set",
    commandId: yield* commandId,
    threadId: THREAD_ID,
    missionId: MISSION_ID,
    status: "blocked",
    blockedReason: "cumulative_loss_limit",
    createdAt: NOW,
  });
  yield* settle;
});

const PROJECT_ID = ProjectId.make("project-trading-reactor");

/**
 * A mission is bound to a real thread (§10.2), so the thread has to exist
 * before a mission command naming it can be decided.
 */
const started = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM trading_missions`;
  yield* sql`DELETE FROM trading_mission_markets`;
  yield* sql`DELETE FROM trading_authority_versions`;
  yield* sql`DELETE FROM projection_trading_missions`;
  yield* sql`DELETE FROM trading_fills`;

  const reactor = yield* TradingMissionReactor;
  yield* reactor.start();

  const engine = yield* OrchestrationEngineService;
  const modelSelection = {
    instanceId: ProviderInstanceId.make("claude"),
    model: "sonnet",
  };
  yield* engine
    .dispatch({
      type: "project.create",
      commandId: yield* commandId,
      projectId: PROJECT_ID,
      title: "Trading",
      workspaceRoot: process.cwd(),
      defaultModelSelection: modelSelection,
      createdAt: NOW,
    })
    .pipe(Effect.ignore);
  yield* engine
    .dispatch({
      type: "thread.create",
      commandId: yield* commandId,
      threadId: THREAD_ID,
      projectId: PROJECT_ID,
      title: "Mission thread",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: NOW,
    })
    .pipe(Effect.ignore);
});

/**
 * A live mission bound to `threadId`, written straight to the domain.
 *
 * Stands in for the row a restart inherits: the mission survives in SQLite, but
 * nothing in memory remembers that its thread is a trading thread.
 */
const seedMissionOnThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const missions = yield* TradingMissionService;
    yield* missions.createMission({
      missionId: MISSION_ID,
      userId: "local",
      tradingAccountId: "acct-trading-reactor",
      instruction: "Trade ETH momentum",
      allocatedCapitalUsd: 1_000,
      harness: {
        provider: "claude",
        providerInstanceId: "claude",
        threadId,
        status: "available",
      },
    });
  });

/**
 * Create the mission without starting its first run.
 *
 * `createMission` goes through the reactor, which starts the first harness run,
 * which queues a turn start — and upstream refuses to settle a thread inside
 * the queued-turn grace window. That refusal is correct (settling would hide
 * just-requested work) and it is not what these tests are about, so the mission
 * is written straight to the domain and announced, the way `blockMission` does.
 */
const createQuietMission = Effect.gen(function* () {
  const missions = yield* TradingMissionService;
  yield* missions.createMission({
    missionId: MISSION_ID,
    userId: "local",
    tradingAccountId: "acct-trading-reactor",
    instruction: "Trade ETH momentum",
    allocatedCapitalUsd: 1_000,
    harness: {
      provider: "claude",
      providerInstanceId: "claude",
      threadId: THREAD_ID,
      status: "available",
    },
  });
  const engine = yield* OrchestrationEngineService;
  yield* engine.dispatch({
    type: "trading.mission.status-set",
    commandId: yield* commandId,
    threadId: THREAD_ID,
    missionId: MISSION_ID,
    status: "analysing",
    createdAt: NOW,
  });
  yield* settle;
});

/** One reconciled fill: the proof the mission has a realised result to report. */
const recordFill = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO trading_fills (
      fill_id, mission_id, execution_id, cloid, order_id, market, side,
      filled_size, avg_fill_price, fee_usd, fee_token, traded_at, observed_at,
      closed_pnl
    ) VALUES (
      'fill-settle', ${MISSION_ID}, 'exec-settle', '0xcloid-settle', 1, 'ETH', 'buy',
      0.5, 3000, 1.5, 'USDC', 1000, 1000, 12.5
    )
  `;
});

/**
 * The last status the reactor announced for the test mission.
 *
 * The projection also carries the terminal status now that settled rows
 * survive (plan 27 H1); the announced event is checked as well because it is
 * what the workspace reacts to.
 */
const lastAnnouncedStatus = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly status: string | null }>`
    SELECT json_extract(payload_json, '$.status') AS status
    FROM orchestration_events
    WHERE event_type = 'trading.mission-status-changed'
    ORDER BY sequence DESC LIMIT 1
  `;
  return rows[0]?.status ?? null;
});

/** How many mission rows survive. Settle keeps them (plan 27 H1): the
    terminal row is the permanent record of what was traded. */
const missionRowCount = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly c: number }>`SELECT COUNT(*) AS c FROM trading_missions`;
  return rows[0]?.c ?? 0;
});

/** Settle a thread the way the sidebar's Settle does, then drain the reactor. */
const settleThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    yield* engine.dispatch({
      type: "thread.settle",
      commandId: yield* commandId,
      threadId,
    });
    yield* settle;
  });

/** Delete a thread the way the sidebar's Delete does, then drain the reactor. */
const deleteThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    yield* engine.dispatch({
      type: "thread.delete",
      commandId: yield* commandId,
      threadId,
    });
    yield* settle;
  });

/**
 * A recording stand-in for the exchange the mission-level finalization talks
 * to (RC01). Canonical exposure lives in `positions`; a reduce-only IOC fills
 * fully and converges its market to zero; reads fail exactly where the plan
 * says. The REAL control service and mission domain run on top of it, so
 * mission rows, transitions, and projections stay internally consistent while
 * the exchange remains hermetic.
 */
interface FinalizationExchange {
  readonly positions: Record<string, number>;
  readonly snapshotReads: Array<"ok" | "fail">;
  readonly exits: Array<{ readonly market: string; readonly size: number }>;
  readonly cancels: Array<string>;
}

const makeFinalizationExchange = (
  positions: Record<string, number>,
  snapshotReads: ReadonlyArray<"ok" | "fail"> = [],
): FinalizationExchange => ({
  positions: { ...positions },
  snapshotReads: [...snapshotReads],
  exits: [],
  cancels: [],
});

const finalizationGatewayLayer = (exchange: FinalizationExchange) =>
  Layer.succeed(HyperliquidGateway, {
    getAccountSnapshot: () =>
      Effect.suspend(() => {
        const read = exchange.snapshotReads.shift() ?? "ok";
        if (read === "fail") return Effect.fail("account snapshot read refused");
        return Effect.succeed({
          positions: Object.entries(exchange.positions)
            .filter(([, size]) => Math.abs(size) > 1e-12)
            .map(([market, size]) => ({
              market,
              size,
              entryPrice: 3_000,
              unrealisedPnl: 0,
              marginUsed: 100,
            })),
        });
      }),
    getOrderBook: () => Effect.succeed({ bestBidOffer: { bidPrice: 2_999, askPrice: 3_001 } }),
    getOpenOrders: () => Effect.succeed([]),
    resolveMarket: () => Effect.die("not used"),
    getMarketSnapshot: () => Effect.die("not used"),
    getMarketHistory: () => Effect.die("not used"),
    getPosition: () => Effect.die("not used"),
    getTakerFeeRateBps: () => Effect.die("not used"),
  } as unknown as HyperliquidGateway["Service"]);

const finalizationExecutionLayer = (exchange: FinalizationExchange) =>
  Layer.succeed(HyperliquidExecutionService, {
    submitReduceOnlyIoc: (input: { market: string; positionSize: number }) =>
      Effect.sync(() => {
        exchange.exits.push({ market: input.market, size: input.positionSize });
        exchange.positions[input.market] = 0;
        return [
          {
            cloid: "0xexit",
            status: "filled",
            filledSize: Math.abs(input.positionSize),
            role: "entry",
          },
        ];
      }),
    submitCancel: (input: { cloid: string }) =>
      Effect.sync(() => {
        exchange.cancels.push(input.cloid);
      }),
    submitOrder: () => Effect.die("not used"),
    submitProtectiveStop: () => Effect.die("not used"),
  } as unknown as HyperliquidExecutionService["Service"]);

/**
 * The reactor over the real trading layer, with only the control service's
 * exchange-facing dependencies stubbed (RC01). Everything durable — mission
 * domain, transitions, projection — is real, so assertions read actual rows.
 *
 * The control layer is built FRESH (`Layer.effect` over the shared `make`
 * effect) rather than re-providing `TradingControlServiceLive`: Effect
 * memoizes a layer by reference, and `TradingLayerLive` already builds that
 * reference with the real gateway — a second provision of the same reference
 * is silently ignored.
 */
const reactorLayerOverExchange = (exchange: FinalizationExchange) => {
  const controlOverStubs = Layer.effect(TradingControlService, makeTradingControlService).pipe(
    Layer.provide(
      Layer.mergeAll(finalizationGatewayLayer(exchange), finalizationExecutionLayer(exchange)),
    ),
  );
  return TradingMissionReactorLive.pipe(
    Layer.provide(controlOverStubs),
    Layer.provideMerge(
      TradingLayerLive.pipe(
        Layer.provide(Layer.succeed(TradingLeaseTarget, { dbPath: ":memory:" })),
      ),
    ),
    Layer.provideMerge(OrchestrationEngineLive),
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provideMerge(OrchestrationProjectionPipelineLive),
    Layer.provideMerge(OrchestrationEventStoreLive),
    Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
    Layer.provideMerge(RepositoryIdentityResolver.layer),
    Layer.provideMerge(makeProviderRegistryLayer()),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-trading-finalize-" })),
    Layer.provideMerge(ThreadBackgroundLiveness.layer),
    Layer.provideMerge(ThreadPlanProgress.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  );
};

/** A §14.7 exchange-touching control from the workspace, then drain. */
const riskControl = (control: "close_and_revoke" | "close_position") =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    yield* engine.dispatch({
      type: "trading.mission.risk-control",
      commandId: yield* commandId,
      threadId: THREAD_ID,
      missionId: MISSION_ID,
      control,
      createdAt: NOW,
    });
    yield* settle;
  });

// Deleting a thread used to leave its mission holding authority with no
// surface to see it on, until the boot sweep erased the row and the record of
// the money it was holding. Deletion now ends the mission the same way settle
// does — through the mission-level finalization gate (RC01).
it.live("deleting a mission-bound thread revokes it and keeps its row", () =>
  Effect.gen(function* () {
    const exchange = makeFinalizationExchange({});
    yield* Effect.gen(function* () {
      yield* started;
      yield* seedTradingAccount;
      yield* createQuietMission;

      yield* deleteThread(THREAD_ID);

      assert.equal(yield* lastAnnouncedStatus, "revoked");
      assert.equal(yield* missionRowCount, 1);
      const projected = yield* projectedMission;
      assert.ok(Option.isSome(projected));
      assert.equal(projected.value.status, "revoked");
    }).pipe(Effect.scoped, Effect.provide(reactorLayerOverExchange(exchange)));
  }),
);

it.live("deleting a mission-bound thread frees the mission's authority", () =>
  Effect.gen(function* () {
    const exchange = makeFinalizationExchange({});
    yield* Effect.gen(function* () {
      yield* started;
      yield* seedTradingAccount;
      yield* createQuietMission;

      yield* deleteThread(THREAD_ID);

      const missions = yield* TradingMissionService;
      assert.isTrue(Option.isNone(yield* missions.findActiveMission(LOCAL_TRADING_USER_ID)));
    }).pipe(Effect.scoped, Effect.provide(reactorLayerOverExchange(exchange)));
  }),
);

// Settle is the way out of a mission. A thread the user has finished with
// must not keep an authority that wakes, trades, and holds the one active
// slot the next thread needs.
it.live("settling a mission-bound thread revokes it and keeps its row", () =>
  Effect.gen(function* () {
    const exchange = makeFinalizationExchange({});
    yield* Effect.gen(function* () {
      yield* started;
      yield* seedTradingAccount;
      yield* createQuietMission;

      yield* settleThread(THREAD_ID);

      assert.equal(yield* lastAnnouncedStatus, "revoked");
      // A settled mission is archived, not erased (plan 27 H1): the row stays
      // as the record of what was traded, projected with its terminal status.
      assert.equal(yield* missionRowCount, 1);
      const projected = yield* projectedMission;
      assert.ok(Option.isSome(projected));
      assert.equal(projected.value.status, "revoked");
    }).pipe(Effect.scoped, Effect.provide(reactorLayerOverExchange(exchange)));
  }),
);

// §11.1 has two permanent terminals and only one of them was reachable, so
// `completed` sat in the contract, the transition table, and the UI's
// completion summary while nothing ever set it. A fill is the difference: a
// mission that traded and came back flat finished, and says so.
it.live("settling completes a flat mission that actually traded", () =>
  Effect.gen(function* () {
    const exchange = makeFinalizationExchange({});
    yield* Effect.gen(function* () {
      yield* started;
      yield* seedTradingAccount;
      yield* createQuietMission;
      yield* recordFill;

      yield* settleThread(THREAD_ID);

      assert.equal(yield* lastAnnouncedStatus, "completed");
      assert.equal(yield* missionRowCount, 1);
      const projected = yield* projectedMission;
      assert.ok(Option.isSome(projected));
      assert.equal(projected.value.status, "completed");
    }).pipe(Effect.scoped, Effect.provide(reactorLayerOverExchange(exchange)));
  }),
);

// A blocked mission's authority was withdrawn by a deterministic safety
// condition. It traded, but it did not finish — reporting that as a completed
// objective is the more expensive of the two lies.
it.live("settling still revokes a mission that traded and then blocked", () =>
  Effect.gen(function* () {
    const exchange = makeFinalizationExchange({});
    yield* Effect.gen(function* () {
      yield* started;
      yield* seedTradingAccount;
      yield* createQuietMission;
      yield* recordFill;
      yield* blockMission;

      yield* settleThread(THREAD_ID);

      assert.equal(yield* lastAnnouncedStatus, "revoked");
      assert.equal(yield* missionRowCount, 1);
    }).pipe(Effect.scoped, Effect.provide(reactorLayerOverExchange(exchange)));
  }),
);

it.live("settling some other thread leaves the mission alone", () =>
  Effect.gen(function* () {
    const exchange = makeFinalizationExchange({});
    yield* Effect.gen(function* () {
      yield* started;
      yield* seedTradingAccount;
      yield* createQuietMission;

      const otherThread = ThreadId.make("thread-trading-reactor-unbound");
      const engine = yield* OrchestrationEngineService;
      yield* engine
        .dispatch({
          type: "thread.create",
          commandId: yield* commandId,
          threadId: otherThread,
          projectId: PROJECT_ID,
          title: "Unbound thread",
          modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "sonnet" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: NOW,
        })
        .pipe(Effect.ignore);
      yield* settle;

      yield* settleThread(otherThread);

      const projected = yield* projectedMission;
      assert.ok(Option.isSome(projected));
      assert.notEqual(projected.value.status, "revoked");
    }).pipe(Effect.scoped, Effect.provide(reactorLayerOverExchange(exchange)));
  }),
);

// `findMissionByThreadId` returns only a still-authoritative mission, so the
// second settle has nothing to act on even though the revoked row survives.
// Settle is a bulk action in the sidebar and must stay a silent no-op the
// second time — and the second event must not submit duplicate closes.
it.live("a second settle after a revoke is a no-op with no duplicate closes", () =>
  Effect.gen(function* () {
    // Canonical exposure the first settle has to close before revoking; the
    // second settle must find a revoked mission and do nothing at all.
    const exchange = makeFinalizationExchange({ ETH: 1 });
    yield* Effect.gen(function* () {
      yield* started;
      yield* seedTradingAccount;
      yield* createQuietMission;

      yield* settleThread(THREAD_ID);
      yield* settleThread(THREAD_ID);

      assert.equal(yield* lastAnnouncedStatus, "revoked");
      assert.equal(yield* missionRowCount, 1);
      assert.equal(exchange.exits.length, 1, "the second settle must not close again");
    }).pipe(Effect.scoped, Effect.provide(reactorLayerOverExchange(exchange)));
  }),
);

// RC01: the thread-ending path must run the canonical gate even when local
// snapshots are absent or stale — the old code inferred "flat" from the local
// snapshot table and skipped both the close and the confirmation entirely.
it.live("thread ending with canonical exposure closes it before revoking", () =>
  Effect.gen(function* () {
    const exchange = makeFinalizationExchange({ ETH: 1 });
    yield* Effect.gen(function* () {
      yield* started;
      yield* seedTradingAccount;
      yield* createQuietMission;

      yield* settleThread(THREAD_ID);

      // One bounded close for the held exposure, then the single revoke.
      assert.equal(exchange.exits.length, 1);
      assert.equal(exchange.exits[0]?.market, "ETH");
      assert.equal(yield* lastAnnouncedStatus, "revoked");
      assert.equal(exchange.positions.ETH, 0);
    }).pipe(Effect.scoped, Effect.provide(reactorLayerOverExchange(exchange)));
  }),
);

// RC01: authority that cannot be confirmed is never terminally claimed. The
// mission stays reachable from the trading workspace with its blocking status.
it.live("an unconfirmable finalization keeps the mission authoritative", () =>
  Effect.gen(function* () {
    const exchange = makeFinalizationExchange({ ETH: 1 }, ["fail"]);
    yield* Effect.gen(function* () {
      yield* started;
      yield* seedTradingAccount;
      yield* createQuietMission;

      yield* settleThread(THREAD_ID);

      // No canonical read ever succeeded, so nothing was submitted and no
      // terminal status was announced; the entry block the pass established
      // is the last status the operator sees.
      assert.deepEqual(exchange.exits, []);
      assert.equal(yield* lastAnnouncedStatus, "paused");
      const missions = yield* TradingMissionService;
      const stillHeld = yield* missions.findMissionByThreadId(THREAD_ID);
      assert.isTrue(Option.isSome(stillHeld), "the mission must stay reachable, not revoked");
      assert.equal(yield* missionRowCount, 1);
    }).pipe(Effect.scoped, Effect.provide(reactorLayerOverExchange(exchange)));
  }),
);

// RC01: the workspace's close-and-revoke button is the same mission-level
// finalization — one revoke after an all-market canonical gate, never a
// per-market revoke.
it.live("the close_and_revoke control finalizes the whole mission once", () =>
  Effect.gen(function* () {
    const exchange = makeFinalizationExchange({ ETH: 1 });
    yield* Effect.gen(function* () {
      yield* started;
      yield* seedTradingAccount;
      yield* createQuietMission;

      yield* riskControl("close_and_revoke");

      assert.equal(exchange.exits.length, 1);
      assert.equal(yield* lastAnnouncedStatus, "revoked");
      const missions = yield* TradingMissionService;
      assert.isTrue(Option.isNone(yield* missions.findActiveMission(LOCAL_TRADING_USER_ID)));
    }).pipe(Effect.scoped, Effect.provide(reactorLayerOverExchange(exchange)));
  }),
);

it.live("the close_and_revoke control keeps authority when it cannot confirm", () =>
  Effect.gen(function* () {
    const exchange = makeFinalizationExchange({ ETH: 1 }, ["fail"]);
    yield* Effect.gen(function* () {
      yield* started;
      yield* seedTradingAccount;
      yield* createQuietMission;

      yield* riskControl("close_and_revoke");

      assert.deepEqual(exchange.exits, []);
      assert.equal(yield* lastAnnouncedStatus, "paused");
      const missions = yield* TradingMissionService;
      assert.isTrue(Option.isSome(yield* missions.findMissionByThreadId(THREAD_ID)));
    }).pipe(Effect.scoped, Effect.provide(reactorLayerOverExchange(exchange)));
  }),
);

it.layer(TestLayer)("trading mission reactor", (it) => {
  it.effect("projects a mission only after the domain accepts it", () =>
    Effect.gen(function* () {
      yield* started;
      yield* createMission;

      const projected = yield* projectedMission;
      assert.ok(Option.isSome(projected), "expected a projected mission row");
      assert.equal(projected.value.id, MISSION_ID);
      assert.equal(projected.value.threadId, THREAD_ID);
      // §11.1 `initializing → analysing`: the create handler starts the first
      // run and then advances, so a mission whose first run started is
      // analysing by the time it is projected.
      assert.equal(projected.value.status, "analysing");
      assert.equal(projected.value.strategy, null);
      // The mandate is the testnet authority defaults over the allocated capital.
      assert.equal(projected.value.authorityVersion, 1);
      assert.equal(projected.value.authority.allocatedCapitalUsd, 1_000);
      assert.equal(projected.value.authority.maximumGrossNotionalUsd, 8_000);
      // Migration 035 stores epoch millis; the read model is ISO.
      assert.match(projected.value.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
    }),
  );

  // R6-1: a refused create used to be a server WARN and nothing else — the
  // form's dispatch is an acknowledgement, so the user saw no mission and no
  // reason. The refusal now lands in the alert feed with its text verbatim,
  // the same channel manual-order refusals use.
  it.effect("appends a D4 manual-exposure refusal to the alert feed", () =>
    Effect.gen(function* () {
      yield* started;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM trading_alert_events`;
      yield* sql`DELETE FROM trading_position_snapshots`;

      // The user is in ETH by hand: an open manual position (mission_id NULL).
      yield* sql`
        INSERT INTO trading_position_snapshots
          (mission_id, market, size, entry_price, unrealised_pnl, margin_used,
           protected_size, observed_at, account_id)
        VALUES (NULL, 'ETH', 0.5, 3_000, 0, 100, 0, 1_000, 'acct-trading-reactor')
      `;

      yield* createMission;

      // The domain refused: no mission row exists.
      assert.equal(yield* missionRowCount, 0);
      // The refusal reached the one surface the user watches, text verbatim.
      const alerts = yield* sql<{
        readonly asset: string;
        readonly account_id: string | null;
        readonly watch_id: string;
        readonly summary: string;
      }>`
        SELECT asset, account_id, watch_id, summary FROM trading_alert_events
      `;
      assert.equal(alerts.length, 1);
      assert.equal(alerts[0]?.asset, "ETH");
      assert.equal(alerts[0]?.account_id, "acct-trading-reactor");
      assert.equal(alerts[0]?.watch_id, "mission_create");
      assert.equal(
        alerts[0]?.summary,
        "Mission on ETH refused: ETH has manual exposure (open position); " +
          "close it or cancel it before a mission can take this market",
      );

      yield* sql`DELETE FROM trading_position_snapshots`;
      yield* sql`DELETE FROM trading_alert_events`;
    }),
  );

  it.effect("applies a legal control and reflects it in the projection", () =>
    Effect.gen(function* () {
      yield* started;
      yield* createMission;

      // The create handler already advanced the mission to analysing, which is
      // where pause is legal from.
      yield* control("trading.mission.pause");

      const paused = yield* projectedMission;
      assert.ok(Option.isSome(paused));
      assert.equal(paused.value.status, "paused");

      yield* control("trading.mission.resume");

      const resumed = yield* projectedMission;
      assert.ok(Option.isSome(resumed));
      assert.equal(resumed.value.status, "analysing");
    }),
  );

  it.effect("leaves the projection alone when §11.1 refuses the control", () =>
    Effect.gen(function* () {
      yield* started;
      yield* createMission;

      // revoked is a permanent terminal (§11.1): no control is legal from it,
      // so the pause below must be refused.
      const missions = yield* TradingMissionService;
      yield* missions.transition({
        missionId: MISSION_ID,
        to: "revoked",
        expectedVersion: yield* missions.getMissionVersion(MISSION_ID),
      });

      yield* control("trading.mission.pause");

      const stillRevoked = yield* missions.getMission(MISSION_ID);
      assert.equal(stillRevoked.status, "revoked", "the domain must refuse the control");
    }),
  );

  // ── §16.4 blocked-mission control matrix ────────────────────────────────────
  //
  // The bug B4 fixed was `guardResume` running before the control's target
  // status was read, which rejected pause and revoke too. The matrix below
  // pins the correct behaviour: while a mission is blocked under
  // `cumulative_loss_limit`, revocation and pause remain available (the user
  // must be able to recover safely), but resume is rejected and leaves the
  // mission blocked. A later case reconciles before resuming a merely-paused
  // mission.

  it.effect("§16.4: permits revocation while a mission is blocked", () =>
    // §16.4 item 4: revocation is explicitly permitted while blocked, so the
    // user can wind the mission down without first clearing the block. It ends
    // the same way a settle does — announced revoked, row kept as the record.
    Effect.gen(function* () {
      yield* started;
      yield* createMission;
      yield* blockMission;

      yield* control("trading.mission.revoke");

      assert.equal(yield* lastAnnouncedStatus, "revoked");
      assert.equal(yield* missionRowCount, 1);
      const projected = yield* projectedMission;
      assert.ok(Option.isSome(projected));
      assert.equal(projected.value.status, "revoked");
    }),
  );

  it.effect("§16.4: permits pause while a mission is blocked", () =>
    // Pause is a control, not a resume, so the exhaustion gate does not apply;
    // the blocked mission transitions to paused and the projection reflects it.
    Effect.gen(function* () {
      yield* started;
      yield* createMission;
      yield* blockMission;

      yield* control("trading.mission.pause");

      const paused = yield* projectedMission;
      assert.ok(Option.isSome(paused));
      assert.equal(paused.value.status, "paused");
    }),
  );

  it.effect("§16.4: rejects resume while blocked and leaves the mission blocked", () =>
    // The reactor's guardResume must reject a resume dispatched on a blocked
    // mission (TradingExhaustionError / resume_blocked). The rejection is
    // caught and logged by the reactor's runEvent guard (a refused control is
    // a normal outcome, not a crash), so dispatch resolves; the proof that the
    // guard fired is the projection still reading blocked — transition was
    // never reached. This is the regression net for bug B4: had guardResume run
    // before the control type was read, pause/revoke would have been rejected
    // too; here resume alone is refused.
    Effect.gen(function* () {
      yield* started;
      yield* createMission;
      yield* blockMission;

      yield* control("trading.mission.resume");

      // The mission must NOT have transitioned back to analysing.
      const stillBlocked = yield* projectedMission;
      assert.ok(Option.isSome(stillBlocked));
      assert.equal(
        stillBlocked.value.status,
        "blocked",
        "resume must not transition a blocked mission",
      );
      assert.equal(
        stillBlocked.value.blockedReason,
        "cumulative_loss_limit",
        "the block reason must survive a refused resume",
      );
    }),
  );
});

/**
 * The wake loop seam: a `trading.mission-watch-fired` domain event must reach
 * `TradingTurnCoordinator.requestRun` with the watch as the triggering cause.
 * Uses a recording stub coordinator so the test observes exactly what the
 * reactor asked for without driving a real provider turn.
 */
it.live("asks the coordinator for a run when a watch fires", () =>
  Effect.gen(function* () {
    const calls: Array<HarnessRunRequest> = [];
    const stubCoordinator = Layer.succeed(TradingTurnCoordinator, {
      requestRun: (input) =>
        Effect.sync(() => {
          calls.push(input);
          return { status: "started", harnessRunId: `run_${calls.length}` } as const;
        }),
      requestUserMessageRun: () => Effect.succeed(false),
      adoptTurn: () => Effect.succeed(false),
    });

    const StubbedLayer = TradingMissionReactorLive.pipe(
      Layer.provide(stubCoordinator),
      Layer.provideMerge(
        TradingLayerLive.pipe(
          Layer.provide(Layer.succeed(TradingLeaseTarget, { dbPath: ":memory:" })),
        ),
      ),
      Layer.provideMerge(OrchestrationEngineLive),
      Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
      Layer.provideMerge(OrchestrationProjectionPipelineLive),
      Layer.provideMerge(OrchestrationEventStoreLive),
      Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
      Layer.provideMerge(RepositoryIdentityResolver.layer),
      // The reactor resolves a mission's harness driver kind by provider instance
      // id. No test here configures provider instances, so an empty registry is
      // the honest stand-in: the lookup finds nothing and the binding falls back.
      Layer.provideMerge(makeProviderRegistryLayer()),
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-trading-watchfired-" }),
      ),
      Layer.provideMerge(ThreadBackgroundLiveness.layer),
      Layer.provideMerge(ThreadPlanProgress.layer),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(NodeServices.layer),
    );

    yield* Effect.gen(function* () {
      yield* started;
      yield* createMission;
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.cause, "mission_created");

      const engine = yield* OrchestrationEngineService;
      yield* engine.dispatch({
        type: "trading.mission.watch-fired",
        commandId: yield* commandId,
        threadId: THREAD_ID,
        missionId: MISSION_ID,
        watchId: "watch_1",
        deduplicationKey: "candle_close:watch_1:1000",
        createdAt: NOW,
      });
      yield* settle;

      // The retry loop is forked; poll briefly for the recorded request.
      for (let attempt = 0; attempt < 300 && calls.length < 2; attempt++) {
        yield* Effect.sleep("10 millis");
      }
      assert.equal(calls.length, 2, "the fired watch must request a run");
      assert.equal(calls[1]?.cause, "market_watch_triggered");
      assert.equal(calls[1]?.triggeringWatchId, "watch_1");
      assert.equal(calls[1]?.missionId, MISSION_ID);
    }).pipe(Effect.scoped, Effect.provide(StubbedLayer));
  }),
);

/**
 * §16.4 ordering: a resume of a merely-*paused* (not blocked) mission must run
 * the `before_resuming_paused_mission` reconcile BEFORE the transition, so the
 * budget gate and the resumed turn see reconciled truth rather than a stale
 * local cache. The reactor wraps the reconcile in a catch (a reconcile failure
 * is logged, not fatal), so to observe the trigger the mission's trading
 * account must resolve a master address — otherwise the reconcile is never
 * reached and the trigger never fires.
 *
 * A recording stub reconciler captures the trigger; the live layer is otherwise
 * intact so the real reactor ordering (guard → reconcile → transition →
 * announce) is what runs.
 */
it.live("reconciles before resuming a paused mission", () =>
  Effect.gen(function* () {
    const triggers: Array<ReconciliationTrigger> = [];
    const stubReconciler = Layer.succeed(HyperliquidReconciler, {
      reconcile: (input: ReconcileInput, trigger: ReconciliationTrigger) =>
        Effect.sync(() => {
          triggers.push(trigger);
          assert.equal(input.missionId, MISSION_ID);
          return {
            position: null,
            openOrders: [],
            canonicalOrders: [],
            fills: [],
            observedAt: 0,
            externalChanges: [],
            closedTrade: null,
          };
        }),
    });

    const StubbedLayer = TradingMissionReactorLive.pipe(
      Layer.provide(stubReconciler),
      Layer.provideMerge(
        TradingLayerLive.pipe(
          Layer.provide(Layer.succeed(TradingLeaseTarget, { dbPath: ":memory:" })),
        ),
      ),
      Layer.provideMerge(OrchestrationEngineLive),
      Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
      Layer.provideMerge(OrchestrationProjectionPipelineLive),
      Layer.provideMerge(OrchestrationEventStoreLive),
      Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
      Layer.provideMerge(RepositoryIdentityResolver.layer),
      // The reactor resolves a mission's harness driver kind by provider instance
      // id. No test here configures provider instances, so an empty registry is
      // the honest stand-in: the lookup finds nothing and the binding falls back.
      Layer.provideMerge(makeProviderRegistryLayer()),
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-trading-resumereconcile-" }),
      ),
      Layer.provideMerge(ThreadBackgroundLiveness.layer),
      Layer.provideMerge(ThreadPlanProgress.layer),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(NodeServices.layer),
    );

    yield* Effect.gen(function* () {
      yield* started;
      yield* createMission;

      // Seed the trading account so getMasterWalletAddress resolves and the
      // reactor actually reaches reconciler.reconcile. The wallet JSON shape is
      // the published TradingMasterWallet contract (§10.1).
      const sql = yield* SqlClient.SqlClient;
      const masterWalletJson =
        '{"privyWalletId":"wallet-trading-reactor",' +
        '"address":"0x000000000000000000000000000000000000beef",' +
        '"ownership":"user"}';
      yield* sql`
        INSERT INTO trading_accounts (
          account_id, user_id, environment, master_wallet_json,
          execution_wallet_json, status, created_at, updated_at
        ) VALUES (
          'acct-trading-reactor', 'local', 'hyperliquid_testnet', ${masterWalletJson},
          ${masterWalletJson}, 'ready', 0, 0
        )
      `;

      // Creation already put the mission in the active loop; pause is the
      // state resume targets.
      yield* control("trading.mission.pause");

      const paused = yield* projectedMission;
      assert.ok(Option.isSome(paused));
      assert.equal(paused.value.status, "paused");

      yield* control("trading.mission.resume");

      // The reconcile must have fired with the §18.2 trigger, and only then did
      // the mission resume — so the projection now reads analysing.
      assert.isTrue(
        triggers.includes("before_resuming_paused_mission"),
        "resume must reconcile before the transition",
      );
      const resumed = yield* projectedMission;
      assert.ok(Option.isSome(resumed));
      assert.equal(resumed.value.status, "analysing");
    }).pipe(Effect.scoped, Effect.provide(StubbedLayer));
  }),
);

/**
 * The mandate's size comes from the account, not from a constant.
 *
 * A create request that states no capital is the ordinary case — the form's
 * capital field left empty. The
 * reactor resolves it from the live account value at creation time, and the
 * whole §10.4 envelope scales from what it resolved: a $1,000 account yields a
 * $350 cumulative loss budget rather than the $17.50 a hardcoded $50 produced.
 */
it.live("sizes a mission with no stated capital from the live account value", () =>
  Effect.gen(function* () {
    const stubGateway = Layer.succeed(HyperliquidGateway, {
      resolveMarket: () => Effect.die("not used"),
      listUniverse: Effect.die("not used"),
      getMarketSnapshots: () =>
        Effect.die("HyperliquidGateway.getMarketSnapshots is not used by these tests"),
      getMarketSnapshot: () => Effect.die("not used"),
      getMarketHistory: () => Effect.die("not used"),
      getOrderBook: () => Effect.die("not used"),
      getAccountSnapshot: () =>
        Effect.succeed({
          address: MASTER_ADDRESS,
          accountValue: 1_000,
          marginUsed: 0,
          withdrawable: 1_000,
          positions: [],
          freshness: { observedAt: 0, source: "info_api", staleness: "fresh" },
        } as never),
      getPosition: () => Effect.die("not used"),
      getOpenOrders: () => Effect.die("not used"),
      getTakerFeeRateBps: () => Effect.die("not used"),
      getUserFeeRatesBps: () => Effect.die("not used"),
    });

    const StubbedLayer = TradingMissionReactorLive.pipe(
      Layer.provide(stubGateway),
      Layer.provideMerge(
        TradingLayerLive.pipe(
          Layer.provide(Layer.succeed(TradingLeaseTarget, { dbPath: ":memory:" })),
        ),
      ),
      Layer.provideMerge(OrchestrationEngineLive),
      Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
      Layer.provideMerge(OrchestrationProjectionPipelineLive),
      Layer.provideMerge(OrchestrationEventStoreLive),
      Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
      Layer.provideMerge(RepositoryIdentityResolver.layer),
      // The reactor resolves a mission's harness driver kind by provider instance
      // id. No test here configures provider instances, so an empty registry is
      // the honest stand-in: the lookup finds nothing and the binding falls back.
      Layer.provideMerge(makeProviderRegistryLayer()),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-trading-capital-" })),
      Layer.provideMerge(ThreadBackgroundLiveness.layer),
      Layer.provideMerge(ThreadPlanProgress.layer),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(NodeServices.layer),
    );

    yield* Effect.gen(function* () {
      yield* started;
      yield* seedTradingAccount;
      yield* createMissionWithoutCapital;

      const projected = yield* projectedMission;
      assert.ok(Option.isSome(projected));
      assert.equal(projected.value.authority.allocatedCapitalUsd, 1_000);
      // The §10.4 envelope the resolved capital scales: 8x gross, 35% budget.
      assert.equal(projected.value.authority.maximumGrossNotionalUsd, 8_000);
      assert.equal(projected.value.authority.maximumCumulativeLossUsd, 350);
      assert.equal(projected.value.authority.maximumPlannedRiskPerPositionUsd, 70);
    }).pipe(Effect.scoped, Effect.provide(StubbedLayer));
  }),
);

/**
 * An unreadable account is a warning, not a refusal.
 *
 * Here the mission names a trading account that was never provisioned, so the
 * master address — and with it the account read — fails outright. The mission
 * must still be created, on the documented fallback mandate: a dead info
 * endpoint is not a reason to stop a testnet lab from starting, and the
 * operator's cue is the warning plus a mandate visibly smaller than expected.
 */
it.live("still creates the mission when the account cannot be read", () =>
  Effect.gen(function* () {
    yield* started;
    // No trading_accounts row seeded: getMasterWalletAddress fails.
    yield* createMissionWithoutCapital;

    const projected = yield* projectedMission;
    assert.ok(Option.isSome(projected));
    assert.equal(projected.value.authority.allocatedCapitalUsd, FALLBACK_MISSION_CAPITAL_USD);
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

/**
 * A harness-driven close retires the position's watches.
 *
 * Plan 36 wired `supersedePositionWatches` to the 5s watchdog, which only sees
 * the STOP-OUT shape of going flat: the exchange takes the position while the
 * mission sits in `position_open`. A close the harness asks for never presents
 * that state — it is an execution, so the mission is already in `executing` and
 * settles straight to `waiting`, leaving the watchdog nothing to observe. Six
 * consecutive closes on a live mission therefore retired nothing, and four
 * profit targets armed for the first trade fired three hours later against an
 * unrelated one.
 *
 * The test has to drive a real transition. A test that calls
 * `supersedePositionWatches` directly — which is what the coverage was — proves
 * the sweep works IF invoked, and the defect was that it never was. The
 * execution here is expected to fail; `settleAfterExecution` runs under
 * `Effect.ensuring` on every exit path, which is exactly the path under test.
 */
it.live("retires the position's watches when the harness closes the position", () =>
  Effect.gen(function* () {
    const stubCoordinator = Layer.succeed(TradingTurnCoordinator, {
      requestRun: () => Effect.succeed({ status: "started", harnessRunId: "run_1" } as const),
      requestUserMessageRun: () => Effect.succeed(false),
      adoptTurn: () => Effect.succeed(false),
    });

    const StubbedLayer = TradingMissionReactorLive.pipe(
      Layer.provide(stubCoordinator),
      Layer.provideMerge(
        TradingLayerLive.pipe(
          Layer.provide(Layer.succeed(TradingLeaseTarget, { dbPath: ":memory:" })),
        ),
      ),
      Layer.provideMerge(OrchestrationEngineLive),
      Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
      Layer.provideMerge(OrchestrationProjectionPipelineLive),
      Layer.provideMerge(OrchestrationEventStoreLive),
      Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
      Layer.provideMerge(RepositoryIdentityResolver.layer),
      Layer.provideMerge(makeProviderRegistryLayer()),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-trading-retire-" })),
      Layer.provideMerge(ThreadBackgroundLiveness.layer),
      Layer.provideMerge(ThreadPlanProgress.layer),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(NodeServices.layer),
    );

    yield* Effect.gen(function* () {
      yield* started;
      yield* seedTradingAccount;
      yield* createMission;

      const missions = yield* TradingMissionService;
      for (const to of ["waiting", "executing", "position_open"] as const) {
        const expectedVersion = yield* missions.getMissionVersion(MISSION_ID);
        yield* missions.transition({ missionId: MISSION_ID, to, expectedVersion });
      }

      // The close already reconciled: the snapshot the settle reads is flat.
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO trading_position_snapshots (
          mission_id, market, size, entry_price, unrealised_pnl,
          margin_used, protected_size, observed_at
        ) VALUES (${MISSION_ID}, 'ETH', 0, 3000, 0, 0, 0, 1000)
      `;

      // Two profit targets: one the runtime armed, one the model armed itself.
      // The second is the reason the sweep matches on watch TYPE and not on
      // `armed_reason` alone — a model-armed target has none.
      const watches = yield* TradingWatchService;
      const runtimeArmed = yield* watches.registerWatch({
        missionId: MISSION_ID,
        watch: { type: "pnl_above", market: "ETH", valueUsd: 5 },
        armedReason: "profit_target",
      });
      const modelArmed = yield* watches.registerWatch({
        missionId: MISSION_ID,
        watch: { type: "pnl_above", market: "ETH", valueUsd: 9 },
      });

      // A level the model armed is NOT position-scoped: a level is still a
      // level when flat, and it must survive the close.
      const level = yield* watches.registerWatch({
        missionId: MISSION_ID,
        watch: {
          type: "price_cross",
          market: "ETH",
          price: 3_100,
          direction: "above",
          priceSource: "mark",
        },
      });

      const engine = yield* OrchestrationEngineService;
      yield* engine
        .dispatch({
          type: "trading.execution.requested",
          commandId: yield* commandId,
          threadId: THREAD_ID,
          missionId: MISSION_ID,
          intent: {
            missionId: MISSION_ID,
            executionSequence: 1,
            actionType: "close",
            market: "ETH",
            side: "sell",
            size: 0.5,
            orderPreference: "marketable_ioc",
            limitPrice: 2_900,
            reduceOnly: true,
          },
          expectedAuthorityVersion: 1,
          activeHarnessRunId: "run_1",
          createdAt: NOW,
        })
        .pipe(Effect.ignore);
      yield* settle;

      const mission = yield* missions.getMission(MISSION_ID);
      assert.equal(mission.status, "waiting", "the close settles the mission flat");

      const after = yield* sql<{
        readonly watch_id: string;
        readonly status: string;
      }>`SELECT watch_id, status FROM trading_watches WHERE mission_id = ${MISSION_ID}`;
      const statusOf = (id: string) => after.find((row) => row.watch_id === id)?.status;

      assert.equal(statusOf(runtimeArmed.watch.id), "superseded", "the runtime's target retires");
      assert.equal(statusOf(modelArmed.watch.id), "superseded", "the model's target retires too");
      assert.equal(statusOf(level.watch.id), "active", "a price level outlives the position");
    }).pipe(Effect.scoped, Effect.provide(StubbedLayer));
  }),
);

/**
 * §17: a stop pulled by hand in the exchange UI leaves the position naked, and
 * nothing outside an execution ever compared the confirmed protected size to
 * the position again. The watchdog is that comparison. It runs on the same 5s
 * pass that settles a flat position, so this test waits for a real tick.
 */
it.live(
  "re-places protection when the reconciled position outgrows its confirmed stop",
  () =>
    Effect.gen(function* () {
      const runs: Array<HarnessRunRequest> = [];
      const stubCoordinator = Layer.succeed(TradingTurnCoordinator, {
        requestRun: (input) =>
          Effect.sync(() => {
            runs.push(input);
            return { status: "started", harnessRunId: `run_${runs.length}` } as const;
          }),
        requestUserMessageRun: () => Effect.succeed(false),
        adoptTurn: () => Effect.succeed(false),
      });

      const protectionCalls: Array<{ readonly stopPrice: number }> = [];
      const stubProtection = Layer.succeed(TradingProtectionService, {
        reconcileProtection: (input: { readonly stopPrice: number }) =>
          Effect.sync(() => {
            protectionCalls.push({ stopPrice: input.stopPrice });
            return {
              status: "protected" as const,
              positionSize: 0.5,
              protectedSize: 0.5,
              replacedCloids: [],
            };
          }),
        replaceProtection: () => Effect.die("not used"),
        cancelEntriesWithProtection: () => Effect.die("not used"),
      } as unknown as TradingProtectionService["Service"]);

      const StubbedLayer = TradingMissionReactorLive.pipe(
        Layer.provide(stubCoordinator),
        Layer.provide(stubProtection),
        Layer.provideMerge(
          TradingLayerLive.pipe(
            Layer.provide(Layer.succeed(TradingLeaseTarget, { dbPath: ":memory:" })),
          ),
        ),
        Layer.provideMerge(OrchestrationEngineLive),
        Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
        Layer.provideMerge(OrchestrationProjectionPipelineLive),
        Layer.provideMerge(OrchestrationEventStoreLive),
        Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
        Layer.provideMerge(RepositoryIdentityResolver.layer),
        // The reactor resolves a mission's harness driver kind by provider instance
        // id. No test here configures provider instances, so an empty registry is
        // the honest stand-in: the lookup finds nothing and the binding falls back.
        Layer.provideMerge(makeProviderRegistryLayer()),
        Layer.provideMerge(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-trading-protection-" }),
        ),
        Layer.provideMerge(ThreadBackgroundLiveness.layer),
        Layer.provideMerge(ThreadPlanProgress.layer),
        Layer.provideMerge(SqlitePersistenceMemory),
        Layer.provideMerge(NodeServices.layer),
      );

      yield* Effect.gen(function* () {
        yield* started;
        yield* seedTradingAccount;
        yield* createMission;

        // Walk the mission to `position_open`, the only status the watchdog acts in.
        const missions = yield* TradingMissionService;
        for (const to of ["waiting", "executing", "position_open"] as const) {
          const expectedVersion = yield* missions.getMissionVersion(MISSION_ID);
          yield* missions.transition({ missionId: MISSION_ID, to, expectedVersion });
        }

        // Half an ETH open with nothing confirmed protecting it, and an approved
        // stop price on the record that opened it.
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
        INSERT INTO trading_position_snapshots (
          mission_id, market, size, entry_price, unrealised_pnl,
          margin_used, protected_size, observed_at
        ) VALUES (${MISSION_ID}, 'ETH', 0.5, 3000, 0, 100, 0, 1000)
      `;
        yield* sql`
        INSERT INTO trading_execution_records (
          execution_id, mission_id, execution_sequence, action_type,
          cloid, idempotency_key, market, side, size, limit_price, time_in_force,
          reduce_only, signer_address, status, order_results_json, created_at, updated_at,
          stop_price
        ) VALUES (
          'exec-protect', ${MISSION_ID}, 1, 'open',
          '0xcloid', 'idem-protect', 'ETH', 'buy', 0.5, 3001, 'ioc',
          0, ${MASTER_ADDRESS}, 'filled', '[]', 1000, 1000, 2900
        )
      `;

        // The watchdog rides the 5s settle pass.
        for (let attempt = 0; attempt < 800 && protectionCalls.length === 0; attempt++) {
          yield* Effect.sleep("10 millis");
        }

        assert.equal(protectionCalls.length > 0, true, "the watchdog must re-place the stop");
        assert.equal(protectionCalls[0]?.stopPrice, 2900);

        // And the harness is told its stop was pulled out from under it.
        const woken = runs.filter((run) => run.cause === "order_updated");
        assert.equal(woken.length > 0, true, "the harness must be woken");

        const events = yield* sql<{ readonly summary: string }>`
        SELECT summary FROM trading_event_inbox
        WHERE mission_id = ${MISSION_ID} AND deduplication_key LIKE 'protection_lost:%'
      `;
        assert.equal(events.length > 0, true, "the loss must be recorded where the harness reads");
      }).pipe(Effect.scoped, Effect.provide(StubbedLayer));
    }),
  { timeout: 30_000 },
);

/**
 * The watchdog loop is a lease-gated writer, exactly like the follow loop and
 * the watch sweep: while the trading lease is not held its guard passes must
 * do nothing (no protection, take-profit, or working-order writes), and they
 * must resume once the lease is held again (a fresh boot re-acquires).
 */
it.live(
  "the watchdog performs no guard passes while the lease is not held",
  () =>
    Effect.gen(function* () {
      const stubCoordinator = Layer.succeed(TradingTurnCoordinator, {
        requestRun: () => Effect.succeed({ status: "started", harnessRunId: "run_1" } as const),
        requestUserMessageRun: () => Effect.succeed(false),
        adoptTurn: () => Effect.succeed(false),
      });

      const protectionCalls: Array<{ readonly stopPrice: number }> = [];
      const stubProtection = Layer.succeed(TradingProtectionService, {
        reconcileProtection: (input: { readonly stopPrice: number }) =>
          Effect.sync(() => {
            protectionCalls.push({ stopPrice: input.stopPrice });
            return {
              status: "protected" as const,
              positionSize: 0.5,
              protectedSize: 0.5,
              replacedCloids: [],
            };
          }),
        replaceProtection: () => Effect.die("not used"),
        cancelEntriesWithProtection: () => Effect.die("not used"),
      } as unknown as TradingProtectionService["Service"]);

      const StubbedLayer = TradingMissionReactorLive.pipe(
        // The reactor's watchdog must read this lease, not the (always-held)
        // in-memory one the trading layer derives from its lease target.
        Layer.provide(fakeWatchdogLease),
        Layer.provide(stubCoordinator),
        Layer.provide(stubProtection),
        Layer.provideMerge(
          TradingLayerLive.pipe(
            Layer.provide(Layer.succeed(TradingLeaseTarget, { dbPath: ":memory:" })),
          ),
        ),
        Layer.provideMerge(OrchestrationEngineLive),
        Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
        Layer.provideMerge(OrchestrationProjectionPipelineLive),
        Layer.provideMerge(OrchestrationEventStoreLive),
        Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
        Layer.provideMerge(RepositoryIdentityResolver.layer),
        Layer.provideMerge(makeProviderRegistryLayer()),
        Layer.provideMerge(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-trading-watchdog-lease-" }),
        ),
        Layer.provideMerge(ThreadBackgroundLiveness.layer),
        Layer.provideMerge(ThreadPlanProgress.layer),
        Layer.provideMerge(SqlitePersistenceMemory),
        Layer.provideMerge(NodeServices.layer),
      );

      yield* Effect.gen(function* () {
        yield* started;
        yield* seedTradingAccount;
        yield* createMission;

        // Walk the mission to `position_open`, the only status the watchdog
        // acts in, and leave it naked with an approved stop on the record —
        // the same setup the re-place test above uses to prove the watchdog
        // writes when it is allowed to.
        const missions = yield* TradingMissionService;
        for (const to of ["waiting", "executing", "position_open"] as const) {
          const expectedVersion = yield* missions.getMissionVersion(MISSION_ID);
          yield* missions.transition({ missionId: MISSION_ID, to, expectedVersion });
        }
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
        INSERT INTO trading_position_snapshots (
          mission_id, market, size, entry_price, unrealised_pnl,
          margin_used, protected_size, observed_at
        ) VALUES (${MISSION_ID}, 'ETH', 0.5, 3000, 0, 100, 0, 1000)
      `;
        yield* sql`
        INSERT INTO trading_execution_records (
          execution_id, mission_id, execution_sequence, action_type,
          cloid, idempotency_key, market, side, size, limit_price, time_in_force,
          reduce_only, signer_address, status, order_results_json, created_at, updated_at,
          stop_price
        ) VALUES (
          'exec-watchdog-lease', ${MISSION_ID}, 1, 'open',
          '0xcloid2', 'idem-watchdog-lease', 'ETH', 'buy', 0.5, 3001, 'ioc',
          0, ${MASTER_ADDRESS}, 'filled', '[]', 1000, 1000, 2900
        )
      `;

        // Not held: wait past a full 5s watchdog tick. The guards must not
        // run — no protection write happens.
        watchdogLeaseHeld = false;
        yield* Effect.sleep("6 seconds");
        assert.equal(protectionCalls.length, 0, "no guard pass while the lease is unheld");

        // Held again: the same naked position is now re-protected.
        watchdogLeaseHeld = true;
        for (let attempt = 0; attempt < 200 && protectionCalls.length === 0; attempt++) {
          yield* Effect.sleep("50 millis");
        }
        assert.equal(protectionCalls.length > 0, true, "the watchdog resumes once held");
      }).pipe(
        // Never leak a lost lease into the other tests, even on failure.
        Effect.onExit(() => Effect.sync(() => (watchdogLeaseHeld = true))),
        Effect.scoped,
        Effect.provide(StubbedLayer),
      );
    }),
  { timeout: 30_000 },
);

// ---------------------------------------------------------------------------
// Loss exhaustion (09A): when the cumulative-loss ceiling is gone, the
// position-increasing order is cancelled, the reduce-only stop is NOT, the
// protected exposure is not silently zeroed, the mission blocks, further
// increases are refused, and provider-free risk-reducing controls stay usable.
// Test-only child: no production behavior is changed here.
// ---------------------------------------------------------------------------

it.live(
  "loss exhaustion preserves protected exposure, cancels only increases, and refuses more",
  () =>
    Effect.gen(function* () {
      const submittedActions: Array<string> = [];
      const cancelledCloids: Array<string> = [];
      const stubExecution = Layer.succeed(HyperliquidExecutionService, {
        submitOrder: (input: { intent: { actionType: string } }) =>
          Effect.sync(() => {
            submittedActions.push(input.intent.actionType);
            return { status: "accepted" };
          }),
        submitReduceOnlyIoc: () => Effect.succeed([]),
        submitCancel: (input: { cloid: string }) =>
          Effect.sync(() => {
            cancelledCloids.push(input.cloid);
          }),
        submitProtectiveStop: () => Effect.die("not used"),
      } as unknown as HyperliquidExecutionService["Service"]);

      // The reconciler is stubbed so the fixture accounting (the seeded loss
      // and protected exposure) survives to the budget read instead of being
      // converged away against the live exchange.
      const stubReconciler = Layer.succeed(HyperliquidReconciler, {
        reconcile: () =>
          Effect.succeed({
            position: null,
            openOrders: [],
            canonicalOrders: [],
            fills: [],
            observedAt: 1000,
          }),
      } as unknown as HyperliquidReconciler["Service"]);

      const ExhaustionLayer = TradingMissionReactorLive.pipe(
        Layer.provide(stubExecution),
        Layer.provide(stubReconciler),
        Layer.provideMerge(
          TradingLayerLive.pipe(
            Layer.provide(Layer.succeed(TradingLeaseTarget, { dbPath: ":memory:" })),
          ),
        ),
        Layer.provideMerge(OrchestrationEngineLive),
        Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
        Layer.provideMerge(OrchestrationProjectionPipelineLive),
        Layer.provideMerge(OrchestrationEventStoreLive),
        Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
        Layer.provideMerge(RepositoryIdentityResolver.layer),
        Layer.provideMerge(makeProviderRegistryLayer()),
        Layer.provideMerge(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-trading-exhaust-" }),
        ),
        Layer.provideMerge(ThreadBackgroundLiveness.layer),
        Layer.provideMerge(ThreadPlanProgress.layer),
        Layer.provideMerge(SqlitePersistenceMemory),
        Layer.provideMerge(NodeServices.layer),
      );

      yield* Effect.gen(function* () {
        yield* started;
        yield* seedTradingAccount;
        yield* createMission;

        const missions = yield* TradingMissionService;
        for (const to of ["waiting", "executing", "position_open"] as const) {
          const expectedVersion = yield* missions.getMissionVersion(MISSION_ID);
          yield* missions.transition({ missionId: MISSION_ID, to, expectedVersion });
        }

        const sql = yield* SqlClient.SqlClient;
        // Protected nonzero exposure: half an ETH, fully protected.
        yield* sql`
          INSERT INTO trading_position_snapshots (
            mission_id, market, size, entry_price, unrealised_pnl,
            margin_used, protected_size, observed_at
          ) VALUES (${MISSION_ID}, 'ETH', 0.5, 3000, 0, 100, 0.5, 1000)
        `;
        // Deterministic fixture accounting: a realised loss far past the
        // mission's cumulative-loss ceiling exhausts the §16.2 budget.
        yield* sql`
          INSERT INTO trading_fills (
            fill_id, mission_id, execution_id, cloid, order_id, market, side,
            filled_size, avg_fill_price, fee_usd, fee_token, traded_at, observed_at,
            closed_pnl
          ) VALUES (
            'fill-loss', ${MISSION_ID}, 'exec-loss', '0xcloid-loss', 1, 'ETH', 'sell',
            0.5, 2500, 0, 'USDC', 1000, 1000, -10000
          )
        `;
        // One resting increase and one reduce-only stop.
        const seedOrder = (cloid: string, actionType: string, reduceOnly: number) =>
          sql`
            INSERT INTO trading_orders (
              mission_id, cloid, order_id, market, side, limit_price,
              remaining_size, reduce_only, observed_at
            ) VALUES (${MISSION_ID}, ${cloid}, 1, 'ETH', 'buy', 3000, 0.5, ${reduceOnly}, 1000)
          `.pipe(
            Effect.andThen(sql`
              INSERT INTO trading_execution_records (
                execution_id, mission_id, execution_sequence, action_type,
                cloid, idempotency_key, market, side, size, limit_price, time_in_force,
                reduce_only, signer_address, status, order_results_json, created_at, updated_at,
                stop_price
              ) VALUES (
                ${`exec-${cloid}`}, ${MISSION_ID}, ${cloid === "0xinc" ? 2 : 3}, ${actionType}, ${cloid},
                ${`idem-${cloid}`}, 'ETH', 'buy', 0.5, 3000, 'gtc', ${reduceOnly}, ${MASTER_ADDRESS},
                'accepted', '[]', 1000, 1000, 2950
              )
            `),
            Effect.orDie,
          );
        yield* seedOrder("0xinc", "open", 0);
        yield* seedOrder("0xstop", "open", 1);

        // An exhausted budget refuses a position-increasing execution before
        // any submit — nothing reaches the exchange.
        const engine = yield* OrchestrationEngineService;
        yield* engine
          .dispatch({
            type: "trading.execution.requested",
            commandId: yield* commandId,
            threadId: THREAD_ID,
            missionId: MISSION_ID,
            intent: {
              missionId: MISSION_ID,
              executionSequence: 4,
              actionType: "open",
              market: "ETH",
              side: "buy",
              size: 0.5,
              orderPreference: "marketable_ioc",
              limitPrice: 3_001,
              reduceOnly: false,
            },
            expectedAuthorityVersion: 1,
            activeHarnessRunId: "run_1",
            createdAt: NOW,
          })
          .pipe(Effect.ignore);
        yield* settle;

        assert.deepEqual(
          submittedActions,
          [],
          "the exhausted budget refuses the increase pre-submit",
        );

        // The §16.4 exhaustion cancellation: the REAL guard service (the one
        // the reactor's post-budget seam calls at L1824), built directly over
        // this test's mission rows and the observed exchange seam.
        const missionsInstance = yield* TradingMissionService;
        const stubExecutionValue = {
          submitOrder: (input: { intent: { actionType: string } }) =>
            Effect.sync(() => {
              submittedActions.push(input.intent.actionType);
              return { status: "accepted" };
            }),
          submitReduceOnlyIoc: () => Effect.succeed([]),
          submitCancel: (input: { cloid: string }) =>
            Effect.sync(() => {
              cancelledCloids.push(input.cloid);
            }),
          submitProtectiveStop: () => Effect.die("not used"),
        } as unknown as HyperliquidExecutionService["Service"];
        const stubReconcilerValue = {
          reconcile: () =>
            Effect.succeed({
              position: null,
              openOrders: [],
              canonicalOrders: [],
              fills: [],
              observedAt: 1000,
            }),
        } as unknown as HyperliquidReconciler["Service"];
        const observedGuard = yield* makeTradingExecutionGuard.pipe(
          Effect.provideService(TradingMissionService, missionsInstance),
          Effect.provideService(HyperliquidExecutionService, stubExecutionValue),
          Effect.provideService(HyperliquidReconciler, stubReconcilerValue),
        );
        const blockExhausted = observedGuard
          .blockForExhaustion(
            MISSION_ID,
            yield* missionsInstance.getMissionVersion(MISSION_ID),
            MASTER_ADDRESS,
          )
          .pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
            Effect.provideService(HyperliquidGateway, {} as HyperliquidGateway["Service"]),
            Effect.provideService(HyperliquidInfoClient, {} as HyperliquidInfoClient["Service"]),
          );
        yield* blockExhausted;

        assert.deepEqual(
          cancelledCloids,
          ["0xinc"],
          "the resting increase is cancelled and the reduce-only stop is not",
        );
        assert.equal((yield* missions.getMission(MISSION_ID)).status, "blocked");

        // The exposure is not silently zeroed and protection stays recorded.
        const snapshot = yield* sql<{ readonly size: number; readonly protected_size: number }>`
          SELECT size, protected_size FROM trading_position_snapshots
          WHERE mission_id = ${MISSION_ID} ORDER BY observed_at DESC LIMIT 1
        `;
        assert.equal(snapshot[0]?.size, 0.5);
        assert.equal(snapshot[0]?.protected_size, 0.5);

        // A further increase is still refused while blocked and exhausted.
        yield* engine
          .dispatch({
            type: "trading.execution.requested",
            commandId: yield* commandId,
            threadId: THREAD_ID,
            missionId: MISSION_ID,
            intent: {
              missionId: MISSION_ID,
              executionSequence: 5,
              actionType: "open",
              market: "ETH",
              side: "buy",
              size: 0.5,
              orderPreference: "marketable_ioc",
              limitPrice: 3_001,
              reduceOnly: false,
            },
            expectedAuthorityVersion: 1,
            activeHarnessRunId: "run_1",
            createdAt: NOW,
          })
          .pipe(Effect.ignore);
        yield* settle;
        assert.deepEqual(submittedActions, [], "a blocked mission still refuses increases");

        // Current behavior, asserted rather than changed: a failed discovery
        // read surfaces as an infrastructure error — never recorded as a
        // verified cancellation.
        yield* sql`DROP TABLE trading_orders`;
        const failedRead = yield* Effect.flip(
          observedGuard
            .blockForExhaustion(
              MISSION_ID,
              yield* missionsInstance.getMissionVersion(MISSION_ID),
              MASTER_ADDRESS,
            )
            .pipe(
              Effect.provideService(SqlClient.SqlClient, sql),
              Effect.provideService(HyperliquidGateway, {} as HyperliquidGateway["Service"]),
              Effect.provideService(HyperliquidInfoClient, {} as HyperliquidInfoClient["Service"]),
            ),
        );
        assert.equal(failedRead._tag, "TradingExhaustionError");
        if (failedRead._tag === "TradingExhaustionError") {
          assert.equal(failedRead.reason, "infrastructure_error");
        }
        assert.deepEqual(cancelledCloids, ["0xinc"], "a failed discovery cancels nothing new");
      }).pipe(Effect.scoped, Effect.provide(ExhaustionLayer));
    }),
  { timeout: 30_000 },
);
