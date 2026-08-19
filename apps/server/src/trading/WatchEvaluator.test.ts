import * as NodeServices from "@effect/platform-node/NodeServices";
import { fakeWebSocketClientLayer } from "@t3tools/hyperliquid/InfoClientTest";
import { HyperliquidGateway } from "@t3tools/hyperliquid/Gateway";
import type { WsDelivery } from "@t3tools/hyperliquid/WebSocketClient";
import type { AgentMarketSnapshot } from "@t3tools/trading-contracts/market";
import type { AgentNetPosition } from "@t3tools/trading-contracts/account-snapshot";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

// @effect-diagnostics nodeBuiltinImport:off - temp files for a temp archive.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { openArchiveDatabase } from "./archive/db.ts";
import { upsertFunding } from "./archive/funding.ts";
import { makeTradingMarketArchive } from "./TradingMarketArchive.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import type { TradingHarnessBinding, MarketWatch } from "./Schemas.ts";
import {
  TradingMarketArchive,
  type TradingMarketArchiveShape,
  type DerivedMetricResult,
} from "./TradingMarketArchive.ts";
import { TradingEventInbox, TradingEventInboxLive } from "./TradingEventInbox.ts";
import { TradingMissionService, TradingMissionServiceLive } from "./TradingMissionService.ts";
import { TradingRuntimeLease } from "./TradingRuntimeLease.ts";
import { TradingStrategyService, TradingStrategyServiceLive } from "./TradingStrategyService.ts";
import { TradingWatchService, TradingWatchServiceLive } from "./TradingWatchService.ts";
import { WatchEvaluator, WatchEvaluatorLive } from "./WatchEvaluator.ts";

/**
 * A stub engine that swallows dispatches. The evaluator announces
 * `trading.mission.watch-fired` here; the real engine-driven resume path is
 * proven in the Step 5 integration test.
 */
const stubEngine = Layer.succeed(OrchestrationEngineService, {
  dispatch: () => Effect.succeed({ sequence: 0 }),
  streamDomainEvents: Effect.never,
  latestSequence: 0,
} as unknown as (typeof OrchestrationEngineService)["Service"]);

/**
 * A fixed close time far enough in the past that the evaluator's `observedAt`
 * is always after it (finalised), and a far-future time that is always after
 * `observedAt` (not finalised).
 */
const PAST_CLOSE = 1_700_000_000_000; // 2023-11-14
const FUTURE_CLOSE = 9_999_999_999_999; // ~2286
/**
 * The "now" the evaluator observes: after PAST_CLOSE (finalised) and before
 * FUTURE_CLOSE (not finalised). `it.effect` runs under a TestClock at epoch 0,
 * so each test advances it to here before evaluating.
 */
const NOW = PAST_CLOSE + 60_000;

const freshness = {
  observedAt: PAST_CLOSE,
  source: "info_api",
  staleAfterMillis: 2_000,
} as const;

/** The fresh snapshot the stub gateway serves: mark 3_100, mid 3_090. */
const stubSnapshot: AgentMarketSnapshot = {
  market: "ETH",
  markPrice: 3_100,
  midPrice: 3_090,
  oraclePrice: 3_095,
  fundingRate8h: 0.0001,
  openInterest: 1_000,
  dayVolumeUsd: 1_000_000,
  bestBidOffer: { bidPrice: 3_089, bidSize: 1, askPrice: 3_091, askSize: 1, freshness },
  freshness,
  change24hPercent: 1.2,
};

const unusedRead = () => Effect.die("not used by WatchEvaluator tests");

/**
 * The fake archive seam: `derivedMetric` records every call and delegates to a
 * per-test script. Tests that need REAL computation (the sign-flip durability
 * restart case) swap `derivedServe` for a `makeTradingMarketArchive` handle.
 */
const derivedCalls: Array<{
  readonly market: string;
  readonly metric: string;
  readonly now: number;
}> = [];

const okMetric = (value: number): DerivedMetricResult => ({ status: "ok", value });

let derivedServe: (input: {
  readonly market: string;
  readonly now: number;
}) => Effect.Effect<DerivedMetricResult> = () => Effect.succeed(okMetric(1));

const resetDerivedFake = (script?: (index: number) => DerivedMetricResult): void => {
  derivedCalls.length = 0;
  let calls = 0;
  derivedServe = script ? () => Effect.succeed(script(calls++)) : () => Effect.succeed(okMetric(1));
};

const fakeArchive = Layer.succeed(
  TradingMarketArchive,
  TradingMarketArchive.of({
    fundingStats: unusedRead,
    fundingSeries: unusedRead,
    oiPremium: unusedRead,
    bookHistory: unusedRead,
    derivedMetric: (input: {
      readonly market: string;
      readonly params: { readonly metric: string };
      readonly now: number;
    }) =>
      Effect.suspend(() => {
        derivedCalls.push({
          market: input.market,
          metric: input.params.metric,
          now: input.now,
        });
        return derivedServe(input);
      }),
  } as unknown as TradingMarketArchiveShape),
);

/**
 * The position the stub gateway serves to `getPosition`. Mutable so a `pnl_above`
 * case can set the unrealised PnL it wants the evaluator to see. `null` keeps
 * the legacy "not used" behaviour so the other cases are unaffected.
 */
let stubPosition: AgentNetPosition | null = null;

const stubGateway = Layer.succeed(HyperliquidGateway, {
  resolveMarket: unusedRead,
  getMarketSnapshot: () => Effect.succeed(stubSnapshot),
  getMarketHistory: unusedRead,
  getOrderBook: unusedRead,
  getAccountSnapshot: unusedRead,
  getPosition: () =>
    stubPosition === null ? (unusedRead() as never) : Effect.succeed(stubPosition),
  getOpenOrders: unusedRead,
  // 4.5 bps a side, so a $1,525 notional owes $0.69 to get out. `pnl_above`
  // fires on unrealised PnL NET of that.
  getTakerFeeRateBps: () => Effect.succeed({ feeBps: 4.5, observedAt: 0 }),
} as unknown as (typeof HyperliquidGateway)["Service"]);

const harness: TradingHarnessBinding = {
  provider: "claude",
  providerInstanceId: "instance_1",
  threadId: "thread_1",
  status: "available",
};

const candleCloseWatch: MarketWatch = {
  type: "candle_close",
  market: "ETH",
  interval: "5m",
  direction: "above",
  price: 3_000,
};

const migrated = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // `trading_orders` arrives in 038 (the `order_update` watch reads it) and
  // `peak_unrealised_pnl` in 045 (the `pnl_giveback` watch reads it).
  yield* runMigrations({ toMigrationInclusive: 73 });
  yield* sql`DELETE FROM trading_missions`;
  yield* sql`DELETE FROM trading_authority_versions`;
  yield* sql`DELETE FROM trading_watches`;
  yield* sql`DELETE FROM trading_plan_history`;
  yield* sql`DELETE FROM trading_event_inbox`;
  yield* sql`DELETE FROM trading_position_snapshots`;
  yield* sql`DELETE FROM trading_orders`;
  // The `pnl_above` watch resolves the master-wallet address for the mission's
  // trading account (the same identity the composer uses). Seed the account row
  // it reads from so that path does not fail with a missing account.
  const masterWalletJson =
    '{"privyWalletId":"master_1","address":"0x000000000000000000000000000000000000beef","ownership":"user"}';
  yield* sql`
    INSERT INTO trading_accounts (
      account_id, user_id, environment, master_wallet_json,
      execution_wallet_json, status, created_at, updated_at
    ) VALUES (
      'acct_1', 'local', 'hyperliquid_testnet', ${masterWalletJson},
      '{}', 'ready', 0, 0
    )
    ON CONFLICT (account_id) DO NOTHING
  `;
});

/** Write the reconciled position row the `position_update` watch reads. */
const writePosition = (size: number, entryPrice: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DELETE FROM trading_position_snapshots WHERE mission_id = 'mission_1'`;
    yield* sql`
      INSERT INTO trading_position_snapshots (
        mission_id, market, size, entry_price, unrealised_pnl,
        margin_used, protected_size, observed_at
      ) VALUES ('mission_1', 'ETH', ${size}, ${entryPrice}, 0, 10, ${size}, ${PAST_CLOSE})
    `;
  });

/** Write the reconciled position row with the high-water mark a give-back reads. */
const writePositionPeak = (input: {
  readonly size: number;
  readonly unrealisedPnl: number;
  readonly peak: number | null;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DELETE FROM trading_position_snapshots WHERE mission_id = 'mission_1'`;
    yield* sql`
      INSERT INTO trading_position_snapshots (
        mission_id, market, size, entry_price, unrealised_pnl,
        margin_used, protected_size, peak_unrealised_pnl, observed_at
      ) VALUES (
        'mission_1', 'ETH', ${input.size}, 3000, ${input.unrealisedPnl},
        10, ${input.size}, ${input.peak}, ${PAST_CLOSE}
      )
    `;
  });

/** Write the reconciled order row the `order_update` watch reads. */
const writeOrder = (cloid: string, remainingSize: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO trading_orders (
        mission_id, cloid, order_id, market, side,
        limit_price, remaining_size, reduce_only, observed_at
      ) VALUES ('mission_1', ${cloid}, 1, 'ETH', 'buy', 3000, ${remainingSize}, 0, ${PAST_CLOSE})
    `;
  });

/** Create the mission, publish strategy v1, and register `watch`. */
const seed = (watch: MarketWatch) =>
  Effect.gen(function* () {
    const missions = yield* TradingMissionService;
    yield* missions.createMission({
      missionId: "mission_1",
      userId: "local",
      tradingAccountId: "acct_1",
      instruction: "Trade ETH momentum",
      allocatedCapitalUsd: 1_000,
      harness,
    });
    const strategies = yield* TradingStrategyService;
    const published = yield* strategies.publishPlan({
      missionId: "mission_1",
      expectedMissionVersion: 1,
      strategy: {
        market: "ETH",
        intent: "long",
        entry: { triggers: [], urgency: "now" },
        stop: { method: "fixed" },
        target: { profitUsd: 10 },
        invalidation: [],
        reassess: { afterMinutes: 90 },
        because: "wait for the 5m close above 3000",
      },
    });
    if (published.outcome !== "accepted") throw new Error("seed publish rejected");

    const watches = yield* TradingWatchService;
    const registered = yield* watches.registerWatch({ missionId: "mission_1", watch });
    return registered.watch;
  });

/** Register another watch on the mission `seed` already created. */
const seedMore = (watch: MarketWatch) =>
  Effect.gen(function* () {
    const watches = yield* TradingWatchService;
    const registered = yield* watches.registerWatch({ missionId: "mission_1", watch });
    return registered.watch;
  });

/** Build a WS delivery for the 5m candle closing at `closeTime`, priced `closePrice`. */
const candleDelivery = (closeTime: number, closePrice: number): WsDelivery => ({
  subscription: { type: "candle", coin: "ETH", interval: "5m" },
  channel: "candle",
  data: [
    {
      t: closeTime - 300_000,
      T: closeTime,
      s: "ETH",
      i: "5m",
      o: 3050,
      c: closePrice,
      h: 3150,
      l: 3040,
      v: 100,
      n: 50,
    },
  ],
});

/**
 * The test layer: trading services provided to the evaluator. No WS fake is
 * needed because the tests drive evaluation synchronously via
 * `evaluateDelivery` / `sweep`, which is exactly what the forked consumers call
 * — so this proves the same fires-exactly-once invariant without racing a
 * forked fiber.
 */
/** Mutable stand-in for the lease so one test can observe the stand-down. */
let leaseHeld = true;
const fakeLease = Layer.succeed(TradingRuntimeLease, {
  get held() {
    return leaseHeld;
  },
  lockPath: null,
});

const layer = it.layer(
  WatchEvaluatorLive.pipe(
    Layer.provideMerge(TradingMissionServiceLive),
    Layer.provideMerge(TradingStrategyServiceLive),
    Layer.provideMerge(TradingWatchServiceLive),
    Layer.provideMerge(TradingEventInboxLive),
    Layer.provideMerge(fakeWebSocketClientLayer([])),
    Layer.provideMerge(stubGateway),
    Layer.provideMerge(fakeArchive),
    Layer.provideMerge(NodeSqliteClient.layerMemory()),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(stubEngine),
    // The evaluator stands its writers down when the lease is lost; tests
    // here hold it by default, and the stand-down test flips it.
    Layer.provideMerge(fakeLease),
  ),
);

layer("WatchEvaluator", (it) => {
  it.effect(
    "fires a matching candle-close watch exactly once when the same closed candle is replayed",
    () =>
      Effect.gen(function* () {
        yield* migrated;
        const watch = yield* seed(candleCloseWatch);
        yield* TestClock.setTime(NOW);
        const evaluator = yield* WatchEvaluator;
        yield* evaluator.forgetDeliveredCandles;

        // Deliver the same finalised candle twice; the evaluator must fire once.
        yield* evaluator.evaluateDelivery(candleDelivery(PAST_CLOSE, 3_100));
        yield* evaluator.evaluateDelivery(candleDelivery(PAST_CLOSE, 3_100));
        yield* evaluator.drain;

        const inbox = yield* TradingEventInbox;
        const claimed = yield* inbox.claimPending("mission_1");
        assert.equal(claimed.length, 1);
        assert.equal(claimed[0]?.deduplicationKey, `candle_close:${watch.id}:${PAST_CLOSE}`);
        assert.equal(claimed[0]?.summary, "5m candle closed 3100 (above 3000)");

        const strategies = yield* TradingStrategyService;
        const [persisted] = yield* strategies.listWatches("mission_1");
        assert.equal(persisted?.status, "triggered");
      }),
  );

  it.effect("does not fire a candle-close watch whose close is still in the future", () =>
    Effect.gen(function* () {
      yield* migrated;
      yield* seed(candleCloseWatch);
      yield* TestClock.setTime(NOW);
      const evaluator = yield* WatchEvaluator;
      yield* evaluator.forgetDeliveredCandles;

      yield* evaluator.evaluateDelivery(candleDelivery(FUTURE_CLOSE, 3_100));
      yield* evaluator.drain;

      const inbox = yield* TradingEventInbox;
      assert.equal((yield* inbox.claimPending("mission_1")).length, 0);
    }),
  );

  // The regression that stalled the wake loop: Hyperliquid stops delivering a
  // candle before its close time, so a watch that waits for a delivery stamped
  // after `T` waits minutes. The start of the next candle is the finality proof.
  it.effect("fires on the candle a rollover finalised, though its own close never arrived", () =>
    Effect.gen(function* () {
      yield* migrated;
      const watch = yield* seed(candleCloseWatch);
      yield* TestClock.setTime(NOW);
      const evaluator = yield* WatchEvaluator;
      yield* evaluator.forgetDeliveredCandles;

      // Two in-progress deliveries for the same candle. Both close in the
      // future, so on the wall-clock test alone neither fires — and no further
      // delivery for this candle is ever sent.
      yield* evaluator.evaluateDelivery(candleDelivery(FUTURE_CLOSE, 3_050));
      yield* evaluator.evaluateDelivery(candleDelivery(FUTURE_CLOSE, 3_100));
      yield* evaluator.drain;

      const inbox = yield* TradingEventInbox;
      assert.equal((yield* inbox.claimPending("mission_1")).length, 0);

      // The next candle opens. That is the exchange saying the previous one is
      // done, so it is evaluated at the last close it was delivered with.
      yield* evaluator.evaluateDelivery(candleDelivery(FUTURE_CLOSE + 300_000, 2_900));
      yield* evaluator.drain;

      const claimed = yield* inbox.claimPending("mission_1");
      assert.equal(claimed.length, 1);
      assert.equal(claimed[0]?.deduplicationKey, `candle_close:${watch.id}:${FUTURE_CLOSE}`);
      assert.equal(claimed[0]?.summary, "5m candle closed 3100 (above 3000)");
    }),
  );

  it.effect("does not fire a candle-close watch whose close is below the threshold", () =>
    Effect.gen(function* () {
      yield* migrated;
      yield* seed(candleCloseWatch);
      yield* TestClock.setTime(NOW);
      const evaluator = yield* WatchEvaluator;
      yield* evaluator.forgetDeliveredCandles;

      yield* evaluator.evaluateDelivery(candleDelivery(PAST_CLOSE, 2_900));
      yield* evaluator.drain;

      const inbox = yield* TradingEventInbox;
      assert.equal((yield* inbox.claimPending("mission_1")).length, 0);
    }),
  );

  it.effect("fires a price-cross watch once against the fresh gateway snapshot", () =>
    Effect.gen(function* () {
      yield* migrated;
      // Stub mark price is 3_100, so "mark above 3_000" matches.
      const watch = yield* seed({
        type: "price_cross",
        market: "ETH",
        priceSource: "mark",
        direction: "above",
        price: 3_000,
      });
      yield* TestClock.setTime(NOW);
      const evaluator = yield* WatchEvaluator;
      yield* evaluator.forgetDeliveredCandles;

      // Two sweeps; the triggered watch must not fire a second time.
      yield* evaluator.sweep;
      yield* evaluator.sweep;
      yield* evaluator.drain;

      const inbox = yield* TradingEventInbox;
      const claimed = yield* inbox.claimPending("mission_1");
      assert.equal(claimed.length, 1);
      assert.equal(claimed[0]?.deduplicationKey, `price_cross:${watch.id}`);
      assert.equal(claimed[0]?.category, "market");

      const strategies = yield* TradingStrategyService;
      const [persisted] = yield* strategies.listWatches("mission_1");
      assert.equal(persisted?.status, "triggered");
    }),
  );

  it.effect("does not fire a price-cross watch whose level has not been reached", () =>
    Effect.gen(function* () {
      yield* migrated;
      // Stub mid price is 3_090, below the 3_200 threshold.
      yield* seed({
        type: "price_cross",
        market: "ETH",
        priceSource: "mid",
        direction: "above",
        price: 3_200,
      });
      yield* TestClock.setTime(NOW);
      const evaluator = yield* WatchEvaluator;
      yield* evaluator.forgetDeliveredCandles;

      yield* evaluator.sweep;
      yield* evaluator.drain;

      const inbox = yield* TradingEventInbox;
      assert.equal((yield* inbox.claimPending("mission_1")).length, 0);
    }),
  );

  /**
   * The periodic sweep is a lease-gated writer: when the runtime lease is
   * lost the sweep must do nothing, and it must resume evaluating once the
   * lease is held again (a fresh boot re-acquires).
   */
  it.effect("the sweep performs no evaluation while the lease is not held", () =>
    Effect.gen(function* () {
      yield* migrated;
      // Stub mark price is 3_100, so "mark above 3_000" would fire if run.
      yield* seed({
        type: "price_cross",
        market: "ETH",
        priceSource: "mark",
        direction: "above",
        price: 3_000,
      });
      yield* TestClock.setTime(NOW);
      const evaluator = yield* WatchEvaluator;
      yield* evaluator.forgetDeliveredCandles;

      // Not held: the sweep performs no evaluation — the watch stays armed.
      leaseHeld = false;
      yield* evaluator.sweep;
      yield* evaluator.drain;
      const inbox = yield* TradingEventInbox;
      assert.equal((yield* inbox.claimPending("mission_1")).length, 0);

      // Held again: the same sweep now fires the matching watch.
      leaseHeld = true;
      yield* evaluator.sweep;
      yield* evaluator.drain;
      assert.equal((yield* inbox.claimPending("mission_1")).length, 1);
    }).pipe(
      // Never leak a lost lease into the other tests, even on failure.
      Effect.onExit(() => Effect.sync(() => (leaseHeld = true))),
    ),
  );

  it.effect("fires a due scheduled reassessment as a timer event, but not an undue one", () =>
    Effect.gen(function* () {
      yield* migrated;
      const due = yield* seed({ type: "scheduled_reassessment", runAt: PAST_CLOSE });
      const watches = yield* TradingWatchService;
      yield* watches.registerWatch({
        missionId: "mission_1",
        watch: { type: "scheduled_reassessment", runAt: FUTURE_CLOSE },
      });
      yield* TestClock.setTime(NOW);
      const evaluator = yield* WatchEvaluator;
      yield* evaluator.forgetDeliveredCandles;

      yield* evaluator.sweep;
      yield* evaluator.drain;

      const inbox = yield* TradingEventInbox;
      const claimed = yield* inbox.claimPending("mission_1");
      assert.equal(claimed.length, 1);
      assert.equal(claimed[0]?.deduplicationKey, `scheduled_reassessment:${due.id}`);
      assert.equal(claimed[0]?.category, "timer");
    }),
  );

  /**
   * `position_update` and `order_update` are published on the watch union, so
   * the harness can and does arm them — and for a while nothing evaluated
   * either one. A mission whose only remaining watch was `position_update` was
   * simply deaf: the position moved, the harness was never woken, and its own
   * answer to the user ("any position update also wakes it") was false.
   */
  it.effect("fires a position-update watch when the reconciled size changes, not before", () =>
    Effect.gen(function* () {
      yield* migrated;
      yield* writePosition(0.5, 3_000);
      const watch = yield* seed({ type: "position_update", market: "ETH" });
      yield* TestClock.setTime(NOW);
      const evaluator = yield* WatchEvaluator;

      // First sweep only records the baseline — an unchanged position is not an
      // update, and firing here would wake the harness for nothing.
      yield* evaluator.sweep;
      yield* evaluator.sweep;
      yield* evaluator.drain;
      const inbox = yield* TradingEventInbox;
      assert.equal((yield* inbox.claimPending("mission_1")).length, 0);

      yield* writePosition(1.25, 3_010);
      yield* evaluator.sweep;
      yield* evaluator.drain;

      const claimed = yield* inbox.claimPending("mission_1");
      assert.equal(claimed.length, 1);
      assert.equal(claimed[0]?.category, "market");

      const strategies = yield* TradingStrategyService;
      const persisted = (yield* strategies.listWatches("mission_1")).find((w) => w.id === watch.id);
      assert.equal(persisted?.status, "triggered");
    }),
  );

  /**
   * The baseline a differential watch compares against used to live in a
   * process-local Map, so a restart forgot it and re-seeded from whatever was
   * current — swallowing exactly the change that happened while the server was
   * down. The baseline is on the watch row now, so a fresh evaluator picks up
   * where the last one left off.
   */
  it.effect("fires on the first change after a restart, having kept its baseline", () =>
    Effect.gen(function* () {
      yield* migrated;
      yield* writePosition(0.5, 3_000);
      yield* seed({ type: "position_update", market: "ETH" });
      yield* TestClock.setTime(NOW);

      // The evaluator that was running before the restart records the baseline.
      const before = yield* WatchEvaluator;
      yield* before.sweep;
      yield* before.drain;
      const inbox = yield* TradingEventInbox;
      assert.equal((yield* inbox.claimPending("mission_1")).length, 0);

      // The position moves while nothing is watching, and a fresh evaluator —
      // same database, empty in-memory state — comes up.
      yield* writePosition(1.25, 3_010);
      yield* Effect.gen(function* () {
        const restarted = yield* WatchEvaluator;
        yield* restarted.sweep;
        yield* restarted.drain;
      }).pipe(Effect.provide(WatchEvaluatorLive));

      const claimed = yield* inbox.claimPending("mission_1");
      assert.equal(claimed.length, 1);
      assert.equal(claimed[0]?.category, "market");
    }),
  );

  it.effect("fires an order-update watch when the order leaves the book", () =>
    Effect.gen(function* () {
      yield* migrated;
      yield* writeOrder("0xabc", 0.5);
      yield* seed({ type: "order_update", cloid: "0xabc" });
      yield* TestClock.setTime(NOW);
      const evaluator = yield* WatchEvaluator;

      yield* evaluator.sweep;
      yield* evaluator.drain;
      const inbox = yield* TradingEventInbox;
      assert.equal((yield* inbox.claimPending("mission_1")).length, 0);

      // Filled or cancelled, the row is gone — which is the update the harness
      // most needs to hear, so a missing row must fire rather than stay silent.
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM trading_orders WHERE cloid = '0xabc'`;
      yield* evaluator.sweep;
      yield* evaluator.drain;

      const claimed = yield* inbox.claimPending("mission_1");
      assert.equal(claimed.length, 1);
      assert.match(claimed[0]?.summary ?? "", /gone/);
    }),
  );

  /**
   * `pnl_above` is the runtime's half of the wake-and-decide profit target: the
   * strategy names the win worth banking, the evaluator wakes the harness when
   * the unrealised PnL reaches it. A flat position never fires it.
   *
   * Net of the exit, since plan 36 item 6. `unrealisedPnl` is gross and the
   * trade that realises it has not been paid for, so a target compared against
   * the gross number fires at a profit the mission cannot bank: one live plan
   * published a $0.34 target against $0.45 of fees.
   */
  // The bug this closes: the target fired at a number the mission could not
  // bank. One live plan published $0.34 against $0.5589 of round trip, so
  // hitting it exactly was worth minus eleven cents — and the wake said
  // "reached target" anyway.
  it.effect("does not fire on a gross PnL the exit has not been taken out of", () =>
    Effect.gen(function* () {
      yield* migrated;
      // Gross $25 exactly on 0.5 ETH: mark 3050, notional $1,525, $0.69 still
      // owed. Banking now is worth $24.31 — under the target, so no wake.
      stubPosition = {
        market: "ETH",
        size: 0.5,
        entryPrice: 3_000,
        unrealisedPnl: 25,
        cumulativeFunding: 0,
        marginUsed: 50,
        freshness,
      };
      yield* seed({ type: "pnl_above", market: "ETH", valueUsd: 25 });
      yield* TestClock.setTime(NOW);
      const evaluator = yield* WatchEvaluator;
      yield* evaluator.forgetDeliveredCandles;

      yield* evaluator.sweep;
      yield* evaluator.drain;

      const inbox = yield* TradingEventInbox;
      assert.deepStrictEqual([...(yield* inbox.claimPending("mission_1"))], []);
    }),
  );

  it.effect("fires a pnl_above watch when unrealised PnL NET of the exit reaches it", () =>
    Effect.gen(function* () {
      yield* migrated;
      // Gross $26 on 0.5 ETH: mark 3052, notional $1,526, so $0.69 is still
      // owed on the exit and $25.31 is what banking now is worth.
      stubPosition = {
        market: "ETH",
        size: 0.5,
        entryPrice: 3_000,
        unrealisedPnl: 26,
        cumulativeFunding: 0,
        marginUsed: 50,
        freshness,
      };
      const watch = yield* seed({ type: "pnl_above", market: "ETH", valueUsd: 25 });
      yield* TestClock.setTime(NOW);
      const evaluator = yield* WatchEvaluator;
      yield* evaluator.forgetDeliveredCandles;

      // Two sweeps; the triggered watch must not fire a second time.
      yield* evaluator.sweep;
      yield* evaluator.sweep;
      yield* evaluator.drain;

      const inbox = yield* TradingEventInbox;
      const claimed = yield* inbox.claimPending("mission_1");
      assert.equal(claimed.length, 1);
      assert.equal(claimed[0]?.deduplicationKey, `pnl_above:${watch.id}`);
      assert.equal(claimed[0]?.category, "market");
      assert.match(claimed[0]?.summary ?? "", /reached target/);

      const strategies = yield* TradingStrategyService;
      const persisted = (yield* strategies.listWatches("mission_1")).find((w) => w.id === watch.id);
      assert.equal(persisted?.status, "triggered");
      stubPosition = null;
    }),
  );

  it.effect("does not fire a pnl_above watch while flat, and leaves it active", () =>
    Effect.gen(function* () {
      yield* migrated;
      // size 0 is the gateway's flat shape.
      stubPosition = {
        market: "ETH",
        size: 0,
        unrealisedPnl: 0,
        cumulativeFunding: 0,
        marginUsed: 0,
        freshness,
      };
      const watch = yield* seed({ type: "pnl_above", market: "ETH", valueUsd: 10 });
      yield* TestClock.setTime(NOW);
      const evaluator = yield* WatchEvaluator;
      yield* evaluator.forgetDeliveredCandles;

      yield* evaluator.sweep;
      yield* evaluator.drain;

      const inbox = yield* TradingEventInbox;
      assert.equal((yield* inbox.claimPending("mission_1")).length, 0);

      // The watch stays active: a strategy publish or a later re-entry still
      // supersedes it like any other watch.
      const strategies = yield* TradingStrategyService;
      const persisted = (yield* strategies.listWatches("mission_1")).find((w) => w.id === watch.id);
      assert.equal(persisted?.status, "active");
      stubPosition = null;
    }),
  );

  it.effect("does not fire a pnl_above watch before the target is reached", () =>
    Effect.gen(function* () {
      yield* migrated;
      stubPosition = {
        market: "ETH",
        size: 0.5,
        entryPrice: 3_000,
        unrealisedPnl: 5,
        cumulativeFunding: 0,
        marginUsed: 50,
        freshness,
      };
      yield* seed({ type: "pnl_above", market: "ETH", valueUsd: 25 });
      yield* TestClock.setTime(NOW);
      const evaluator = yield* WatchEvaluator;
      yield* evaluator.forgetDeliveredCandles;

      yield* evaluator.sweep;
      yield* evaluator.drain;

      const inbox = yield* TradingEventInbox;
      assert.equal((yield* inbox.claimPending("mission_1")).length, 0);
      stubPosition = null;
    }),
  );

  // -------------------------------------------------------------------------
  // `pnl_below` — the mirror of `pnl_above`, and signed, because the level
  // worth watching on the way down is usually a loss.
  // -------------------------------------------------------------------------

  it.effect("fires a pnl_below watch when the loss reaches the level", () =>
    Effect.gen(function* () {
      yield* migrated;
      stubPosition = {
        market: "ETH",
        size: 0.5,
        entryPrice: 3_000,
        unrealisedPnl: -8,
        cumulativeFunding: 0,
        marginUsed: 50,
        freshness,
      };
      const watch = yield* seed({ type: "pnl_below", market: "ETH", valueUsd: -6 });
      yield* TestClock.setTime(NOW);
      const evaluator = yield* WatchEvaluator;
      yield* evaluator.forgetDeliveredCandles;

      yield* evaluator.sweep;
      yield* evaluator.drain;

      const inbox = yield* TradingEventInbox;
      const claimed = yield* inbox.claimPending("mission_1");
      assert.equal(claimed.length, 1);
      assert.equal(claimed[0]?.deduplicationKey, `pnl_below:${watch.id}`);
      stubPosition = null;
    }),
  );

  it.effect("does not fire a pnl_below watch while the position is above it", () =>
    Effect.gen(function* () {
      yield* migrated;
      stubPosition = {
        market: "ETH",
        size: 0.5,
        entryPrice: 3_000,
        unrealisedPnl: -2,
        cumulativeFunding: 0,
        marginUsed: 50,
        freshness,
      };
      yield* seed({ type: "pnl_below", market: "ETH", valueUsd: -6 });
      yield* TestClock.setTime(NOW);
      const evaluator = yield* WatchEvaluator;
      yield* evaluator.forgetDeliveredCandles;

      yield* evaluator.sweep;
      yield* evaluator.drain;

      const inbox = yield* TradingEventInbox;
      assert.equal((yield* inbox.claimPending("mission_1")).length, 0);
      stubPosition = null;
    }),
  );

  // -------------------------------------------------------------------------
  // `pnl_giveback` — measured against the reconciler's durable high-water mark,
  // which is the whole reason holding past a profit target can be made safe.
  // -------------------------------------------------------------------------

  it.effect("fires a pnl_giveback watch on the drawdown from the recorded peak", () =>
    Effect.gen(function* () {
      yield* migrated;
      yield* writePositionPeak({ size: 0.5, unrealisedPnl: 12, peak: 20 });
      stubPosition = {
        market: "ETH",
        size: 0.5,
        entryPrice: 3_000,
        unrealisedPnl: 12,
        cumulativeFunding: 0,
        marginUsed: 50,
        freshness,
      };
      const watch = yield* seed({ type: "pnl_giveback", market: "ETH", drawdownUsd: 8 });
      yield* TestClock.setTime(NOW);
      const evaluator = yield* WatchEvaluator;
      yield* evaluator.forgetDeliveredCandles;

      yield* evaluator.sweep;
      yield* evaluator.drain;

      const inbox = yield* TradingEventInbox;
      const claimed = yield* inbox.claimPending("mission_1");
      assert.equal(claimed.length, 1);
      assert.equal(claimed[0]?.deduplicationKey, `pnl_giveback:${watch.id}`);
      assert.match(claimed[0]?.summary ?? "", /gave back/);
      stubPosition = null;
    }),
  );

  // A trade that never worked has no winner to give back. Firing here would put
  // the give-back watch in the stop's job, on a position it knows nothing about.
  it.effect("does not fire a pnl_giveback watch on a position that never profited", () =>
    Effect.gen(function* () {
      yield* migrated;
      yield* writePositionPeak({ size: 0.5, unrealisedPnl: -30, peak: null });
      stubPosition = {
        market: "ETH",
        size: 0.5,
        entryPrice: 3_000,
        unrealisedPnl: -30,
        cumulativeFunding: 0,
        marginUsed: 50,
        freshness,
      };
      yield* seed({ type: "pnl_giveback", market: "ETH", drawdownUsd: 8 });
      yield* TestClock.setTime(NOW);
      const evaluator = yield* WatchEvaluator;
      yield* evaluator.forgetDeliveredCandles;

      yield* evaluator.sweep;
      yield* evaluator.drain;

      const inbox = yield* TradingEventInbox;
      assert.equal((yield* inbox.claimPending("mission_1")).length, 0);
      stubPosition = null;
    }),
  );

  // -------------------------------------------------------------------------
  // `metric_derived` — plan 38 §3.5. The metric is the archive's; these pin
  // the evaluator's half: the cadence, the write-backs, and the firing.
  // -------------------------------------------------------------------------

  /** Read a watch row's raw cadence/observation columns. */
  const watchRow = (watchId: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{
        readonly next_evaluate_at: number | null;
        readonly last_observed_value: number | null;
        readonly baseline_signature: string | null;
      }>`
        SELECT next_evaluate_at, last_observed_value, baseline_signature
        FROM trading_watches WHERE watch_id = ${watchId}
      `;
      return rows[0];
    });

  it.effect("evaluates a derived funding watch once per its 30m cadence, not per sweep", () =>
    Effect.gen(function* () {
      yield* migrated;
      resetDerivedFake();
      const watch = yield* seed({
        type: "metric_derived",
        market: "ETH",
        metric: "funding_mean",
        params: { metric: "funding_mean", windowDays: 7 },
        direction: "below",
        value: 0,
        mode: "cross",
      });
      yield* TestClock.setTime(NOW);
      const evaluator = yield* WatchEvaluator;

      yield* evaluator.sweep;
      // Three more sweeps at the 2s cadence: the archive must not be asked.
      for (let tick = 1; tick <= 3; tick += 1) {
        yield* TestClock.setTime(NOW + tick * 2_000);
        yield* evaluator.sweep;
      }
      assert.equal(derivedCalls.length, 1);

      // Past the due time, the next sweep computes again.
      yield* TestClock.setTime(NOW + 30 * 60_000 + 1);
      yield* evaluator.sweep;
      assert.equal(derivedCalls.length, 2);

      // The due sweep re-armed the next 30m window from its own clock.
      const row = yield* watchRow(watch.id);
      assert.equal(row?.next_evaluate_at, NOW + 30 * 60_000 + 1 + 1_800_000);
    }),
  );

  it.effect("never sweep-computes a bar_close-confirmed candle metric", () =>
    Effect.gen(function* () {
      yield* migrated;
      resetDerivedFake();
      const watch = yield* seed({
        type: "metric_derived",
        market: "ETH",
        metric: "sigma_return",
        params: { metric: "sigma_return", interval: "5m", period: 72 },
        direction: "below",
        value: -2,
        mode: "cross",
        confirm: "bar_close",
      });
      yield* TestClock.setTime(NOW);
      const evaluator = yield* WatchEvaluator;

      yield* evaluator.sweep;
      yield* TestClock.setTime(NOW + 60_000);
      yield* evaluator.sweep;
      assert.equal(derivedCalls.length, 0);

      // The sweep never even armed a cadence for it — delivery is its clock.
      const row = yield* watchRow(watch.id);
      assert.equal(row?.next_evaluate_at, null);
    }),
  );

  it.effect(
    "fires a cross watch exactly once on the out → in transition, and is terminal after",
    () =>
      Effect.gen(function* () {
        yield* migrated;
        // First evaluation: value above 0 (out of the "below 0" region).
        // Second: the mean has turned negative (in) — the entry.
        resetDerivedFake((index) => okMetric(index === 0 ? 1e-6 : -1.2e-6));
        const watch = yield* seed({
          type: "metric_derived",
          market: "ETH",
          metric: "funding_mean",
          params: { metric: "funding_mean", windowDays: 7 },
          direction: "below",
          value: 0,
          mode: "cross",
        });
        yield* TestClock.setTime(NOW);
        const evaluator = yield* WatchEvaluator;

        yield* evaluator.sweep;
        yield* evaluator.drain;
        const inbox = yield* TradingEventInbox;
        assert.equal((yield* inbox.claimPending("mission_1")).length, 0);
        // The arming evaluation persisted the "out" baseline.
        assert.equal((yield* watchRow(watch.id))?.baseline_signature, "out");

        yield* TestClock.setTime(NOW + 30 * 60_000 + 1);
        yield* evaluator.sweep;
        yield* evaluator.drain;
        const claimed = yield* inbox.claimPending("mission_1");
        assert.equal(claimed.length, 1);
        assert.equal(claimed[0]?.deduplicationKey, `metric_derived:${watch.id}:in`);
        assert.match(claimed[0]?.summary ?? "", /7d mean funding .* \(below 0\)/);

        const strategies = yield* TradingStrategyService;
        const persisted = (yield* strategies.listWatches("mission_1")).find(
          (w) => w.id === watch.id,
        );
        assert.equal(persisted?.status, "triggered");
      }),
  );

  it.effect("does not fire a cross watch on the in → out transition", () =>
    Effect.gen(function* () {
      yield* migrated;
      resetDerivedFake((index) => okMetric(index === 0 ? -1.2e-6 : 1.2e-6));
      const watch = yield* seed({
        type: "metric_derived",
        market: "ETH",
        metric: "funding_mean",
        params: { metric: "funding_mean", windowDays: 7 },
        direction: "below",
        value: 0,
        mode: "cross",
      });
      yield* TestClock.setTime(NOW);
      const evaluator = yield* WatchEvaluator;

      yield* evaluator.sweep;
      yield* TestClock.setTime(NOW + 30 * 60_000 + 1);
      yield* evaluator.sweep;
      yield* evaluator.drain;

      const inbox = yield* TradingEventInbox;
      assert.equal((yield* inbox.claimPending("mission_1")).length, 0);
      // Leaving only moved the baseline; the watch stays armed for a re-entry.
      assert.equal((yield* watchRow(watch.id))?.baseline_signature, "out");
      const strategies = yield* TradingStrategyService;
      const persisted = (yield* strategies.listWatches("mission_1")).find((w) => w.id === watch.id);
      assert.equal(persisted?.status, "active");
    }),
  );

  // The giveback instant-refire guard, generalised: a watch armed while
  // already inside its region records the baseline and stays silent until it
  // has LEFT and come back.
  it.effect(
    "arms silently while already inside the region, and fires only after leave + re-enter",
    () =>
      Effect.gen(function* () {
        yield* migrated;
        const values = [-1.2e-6, -1.3e-6, 1.2e-6, -1.5e-6];
        resetDerivedFake((index) => okMetric(values[Math.min(index, values.length - 1)] ?? 1));
        const watch = yield* seed({
          type: "metric_derived",
          market: "ETH",
          metric: "funding_mean",
          params: { metric: "funding_mean", windowDays: 1 },
          direction: "below",
          value: 0,
          mode: "cross",
        });
        yield* TestClock.setTime(NOW);
        const evaluator = yield* WatchEvaluator;
        const inbox = yield* TradingEventInbox;

        // Armed while "in": records the baseline, fires nothing.
        yield* evaluator.sweep;
        yield* evaluator.drain;
        assert.equal((yield* inbox.claimPending("mission_1")).length, 0);
        assert.equal((yield* watchRow(watch.id))?.baseline_signature, "in");

        // Still in: still nothing.
        yield* TestClock.setTime(NOW + 30 * 60_000 + 1);
        yield* evaluator.sweep;
        yield* evaluator.drain;
        assert.equal((yield* inbox.claimPending("mission_1")).length, 0);

        // Leaves: updates the baseline, never fires.
        yield* TestClock.setTime(NOW + 2 * (30 * 60_000) + 2);
        yield* evaluator.sweep;
        yield* evaluator.drain;
        assert.equal((yield* inbox.claimPending("mission_1")).length, 0);
        assert.equal((yield* watchRow(watch.id))?.baseline_signature, "out");

        // Re-enters: the one fire.
        yield* TestClock.setTime(NOW + 3 * (30 * 60_000) + 3);
        yield* evaluator.sweep;
        yield* evaluator.drain;
        const claimed = yield* inbox.claimPending("mission_1");
        assert.equal(claimed.length, 1);
        assert.match(claimed[0]?.summary ?? "", /\(below 0\)/);
      }),
  );

  it.effect("fires a level watch when the metric moves beyond the threshold", () =>
    Effect.gen(function* () {
      yield* migrated;
      resetDerivedFake((index) => okMetric(index === 0 ? 0.01 : 0.06));
      const watch = yield* seed({
        type: "metric_derived",
        market: "ETH",
        metric: "oi_change_rate",
        params: { metric: "oi_change_rate", windowMinutes: 60 },
        direction: "above",
        value: 0.05,
        mode: "level",
      });
      yield* TestClock.setTime(NOW);
      const evaluator = yield* WatchEvaluator;

      yield* evaluator.sweep;
      yield* evaluator.drain;
      const inbox = yield* TradingEventInbox;
      assert.equal((yield* inbox.claimPending("mission_1")).length, 0);

      yield* TestClock.setTime(NOW + 60_000 + 1);
      yield* evaluator.sweep;
      yield* evaluator.drain;
      const claimed = yield* inbox.claimPending("mission_1");
      assert.equal(claimed.length, 1);
      assert.equal(claimed[0]?.deduplicationKey, `metric_derived:${watch.id}`);
      assert.match(claimed[0]?.summary ?? "", /oi change rate 60m .* \(above 0.05\)/);
    }),
  );

  it.effect(
    "advances next_evaluate_at and writes nothing true when the archive is unavailable",
    () =>
      Effect.gen(function* () {
        yield* migrated;
        resetDerivedFake(() => ({
          status: "unavailable",
          kind: "archive",
          reason: "archive file not found",
        }));
        const watch = yield* seed({
          type: "metric_derived",
          market: "ETH",
          metric: "funding_mean",
          params: { metric: "funding_mean", windowDays: 7 },
          direction: "below",
          value: 0,
          mode: "cross",
        });
        yield* TestClock.setTime(NOW);
        const evaluator = yield* WatchEvaluator;

        yield* evaluator.sweep;
        yield* evaluator.drain;
        // No fire, no observation write — a missing archive must never read
        // as zero — but the retry clock advanced.
        const inbox = yield* TradingEventInbox;
        assert.equal((yield* inbox.claimPending("mission_1")).length, 0);
        const row = yield* watchRow(watch.id);
        assert.equal(row?.last_observed_value, null);
        assert.equal(row?.next_evaluate_at, NOW + 1_800_000);

        // And the sweep survives: the advanced cadence skips the next tick.
        yield* TestClock.setTime(NOW + 2_000);
        yield* evaluator.sweep;
        yield* evaluator.drain;
        assert.equal(derivedCalls.length, 1);
      }),
  );

  it.effect("writes the per-metric default cadence, and honours evaluateEveryMs", () =>
    Effect.gen(function* () {
      yield* migrated;
      resetDerivedFake();
      const funding = yield* seed({
        type: "metric_derived",
        market: "ETH",
        metric: "funding_mean",
        params: { metric: "funding_mean", windowDays: 7 },
        direction: "above",
        value: 1e9,
        mode: "cross",
      });
      const sampled = yield* seedMore({
        type: "metric_derived",
        market: "ETH",
        metric: "oi_change_rate",
        params: { metric: "oi_change_rate", windowMinutes: 60 },
        direction: "above",
        value: 1e9,
        mode: "cross",
      });
      // 4h is not a delivered interval, so this one rides the sweep at its
      // own bar cadence.
      const fourHour = yield* seedMore({
        type: "metric_derived",
        market: "ETH",
        metric: "sigma_return",
        params: { metric: "sigma_return", interval: "4h", period: 20 },
        direction: "above",
        value: 1e9,
        mode: "cross",
        confirm: "bar_close",
      });
      const overridden = yield* seedMore({
        type: "metric_derived",
        market: "ETH",
        metric: "funding_mean",
        params: { metric: "funding_mean", windowDays: 7 },
        direction: "above",
        value: 1e9,
        mode: "cross",
        evaluateEveryMs: 5_000,
      });
      yield* TestClock.setTime(NOW);
      const evaluator = yield* WatchEvaluator;

      yield* evaluator.sweep;
      yield* evaluator.drain;

      assert.equal((yield* watchRow(funding.id))?.next_evaluate_at, NOW + 1_800_000);
      assert.equal((yield* watchRow(sampled.id))?.next_evaluate_at, NOW + 60_000);
      assert.equal((yield* watchRow(fourHour.id))?.next_evaluate_at, NOW + 4 * 3_600_000);
      assert.equal((yield* watchRow(overridden.id))?.next_evaluate_at, NOW + 5_000);
    }),
  );

  it.effect(
    "evaluates a bar_close watch on a finalised bar via the delivery path, not the sweep",
    () =>
      Effect.gen(function* () {
        yield* migrated;
        resetDerivedFake((index) => okMetric(index === 0 ? -1 : -2.61));
        const watch = yield* seed({
          type: "metric_derived",
          market: "ETH",
          metric: "sigma_distance",
          params: { metric: "sigma_distance", interval: "5m", period: 20, basis: "mean" },
          direction: "below",
          value: -2.5,
          mode: "cross",
          confirm: "bar_close",
        });
        yield* TestClock.setTime(NOW);
        const evaluator = yield* WatchEvaluator;
        yield* evaluator.forgetDeliveredCandles;

        // The sweep never computes it (delivery is the clock)…
        yield* evaluator.sweep;
        assert.equal(derivedCalls.length, 0);

        // …a finalised 5m bar does. First delivery arms (out), the rollover
        // delivery sees the entry.
        yield* evaluator.evaluateDelivery(candleDelivery(PAST_CLOSE, 3_100));
        yield* evaluator.drain;
        assert.equal(derivedCalls.length, 1);
        const inbox = yield* TradingEventInbox;
        assert.equal((yield* inbox.claimPending("mission_1")).length, 0);

        yield* evaluator.evaluateDelivery(candleDelivery(PAST_CLOSE + 300_000, 3_100));
        yield* evaluator.drain;
        const claimed = yield* inbox.claimPending("mission_1");
        assert.equal(claimed.length, 1);
        assert.equal(claimed[0]?.deduplicationKey, `metric_derived:${watch.id}:in`);
        assert.equal(claimed[0]?.summary, "sigma_distance 5m -2.61 (below -2.5)");
      }),
  );

  // Plan 38 Phase 3 item 3: the baseline is durable, so a sign flip that
  // happens while the server is down fires on the FIRST sweep after restart.
  // Computation is real here — a temp archive seeded through the archiver's
  // own upserters, mutated between the two evaluator generations.
  it.effect("fires a sign flip on the first sweep after restart, from a durable baseline", () =>
    Effect.gen(function* () {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "watch-flip-restart-"));
      const path = NodePath.join(dir, "archive.sqlite");
      const DAY = 24 * 60 * 60_000;
      const seedFunding = (rate: number) => {
        const writer = openArchiveDatabase(path);
        // A holding reaching back before the 1d window start, then the
        // in-window rates whose mean the metric reads.
        upsertFunding(writer, [
          { coin: "ETH", time: NOW - 2 * DAY, fundingRate: rate, premium: 0 },
          { coin: "ETH", time: NOW - 12 * 3_600_000, fundingRate: rate, premium: 0 },
          { coin: "ETH", time: NOW - 6 * 3_600_000, fundingRate: rate, premium: 0 },
        ]);
        writer.close();
      };
      seedFunding(0.0001);

      const realArchive = makeTradingMarketArchive(path);
      derivedCalls.length = 0;
      derivedServe = (input) =>
        realArchive.derivedMetric({
          market: input.market,
          params: { metric: "funding_sign_flip", windowDays: 1 },
          now: input.now,
        });

      yield* migrated;
      const watch = yield* seed({
        type: "metric_derived",
        market: "ETH",
        metric: "funding_sign_flip",
        params: { metric: "funding_sign_flip", windowDays: 1 },
        mode: "cross",
      });
      yield* TestClock.setTime(NOW);
      const inbox = yield* TradingEventInbox;

      // The evaluator that was running before the restart records "pos".
      const before = yield* WatchEvaluator;
      yield* before.sweep;
      yield* before.drain;
      assert.equal((yield* inbox.claimPending("mission_1")).length, 0);
      assert.equal((yield* watchRow(watch.id))?.baseline_signature, "pos");

      // The mean flips while nothing is watching, and a fresh evaluator —
      // same state DB, empty in-memory state, same archive file — comes up.
      seedFunding(-0.0001);
      // The flip happened after the first evaluator's cadence window opened,
      // so the restart sweeps past that window.
      yield* TestClock.setTime(NOW + 30 * 60_000 + 1);
      yield* Effect.gen(function* () {
        const restarted = yield* WatchEvaluator;
        yield* restarted.sweep;
        yield* restarted.drain;
      }).pipe(Effect.provide(WatchEvaluatorLive));

      const claimed = yield* inbox.claimPending("mission_1");
      assert.equal(claimed.length, 1);
      assert.match(claimed[0]?.summary ?? "", /1d mean funding .* \(sign flip, was positive\)/);

      NodeFS.rmSync(dir, { recursive: true, force: true });
      resetDerivedFake();
    }),
  );
});
