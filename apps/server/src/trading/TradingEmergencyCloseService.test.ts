/**
 * TradingEmergencyCloseService — §17.5.
 *
 * The properties worth proving here are all about boundedness and ordering:
 * that a partial IOC fill converges inside three attempts, that a market which
 * will not take the size stops at three rather than retrying forever, that the
 * failure path still reports the exact remaining size, and that the reduce-only
 * protection is never among the orders cancelled on the way out.
 *
 * The fake exchange fills a fixed fraction of whatever is asked, which is what
 * a marketable IOC does against a thin book — the case §17.5 step 6 exists for.
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
import {
  EMERGENCY_CLOSE_MAXIMUM_ATTEMPTS,
  describeEmergencyCloseOutcome,
  makeTradingEmergencyCloseService,
  type EmergencyCloseInput,
} from "./TradingEmergencyCloseService.ts";

const MISSION = "mission_emergency";

const INPUT: EmergencyCloseInput = {
  missionId: MISSION,
  masterAddress: "0xmaster",
  market: "ETH",
  reason: "protection could not be confirmed",
};

interface FakeExchange {
  /** Signed canonical position size. */
  positionSize: number;
  /** Fraction of the requested size each IOC fills. */
  fillFraction: number;
  /** IOC submissions, in order. */
  exits: number[];
  cancels: string[];
  transitions: Array<{ to: string; blockedReason: string | undefined }>;
  /** When set, every IOC submission fails outright. */
  submitFailure: boolean;
  /** Per-call canonical-read plan, consumed front-to-back; "ok" afterwards (06C). */
  snapshotReads: Array<"ok" | "fail">;
  /** When set, the mission-block transition write fails (06C). */
  blockWriteFails: boolean;
  /** When set, every entry-cancellation fails typed (RC03). */
  cancelRejection: string | null;
}

const makeFake = (overrides: Partial<FakeExchange> = {}): FakeExchange => ({
  positionSize: 0.5,
  fillFraction: 1,
  exits: [],
  cancels: [],
  transitions: [],
  submitFailure: false,
  snapshotReads: [],
  blockWriteFails: false,
  cancelRejection: null,
  ...overrides,
});

const gatewayLayer = (fake: FakeExchange) =>
  Layer.succeed(HyperliquidGateway, {
    getAccountSnapshot: () =>
      Effect.suspend(() => {
        const read = fake.snapshotReads.shift() ?? "ok";
        if (read === "fail") return Effect.fail("account snapshot read refused");
        return Effect.succeed({
          positions:
            Math.abs(fake.positionSize) < 1e-9
              ? []
              : [
                  {
                    market: "ETH",
                    size: fake.positionSize,
                    entryPrice: 3_000,
                    unrealisedPnl: 0,
                    marginUsed: 100,
                  },
                ],
        });
      }),
    getOrderBook: () =>
      Effect.succeed({
        bestBidOffer: { bidPrice: 2_999, askPrice: 3_001 },
      }),
    getOpenOrders: () => Effect.succeed([]),
    resolveMarket: () => Effect.die("not used"),
    getMarketSnapshot: () => Effect.die("not used"),
    getMarketHistory: () => Effect.die("not used"),
    getPosition: () => Effect.die("not used"),
    getTakerFeeRateBps: () => Effect.die("not used"),
  } as unknown as HyperliquidGateway["Service"]);

const executionLayer = (fake: FakeExchange) =>
  Layer.succeed(HyperliquidExecutionService, {
    submitReduceOnlyIoc: (input: { positionSize: number }) =>
      Effect.suspend(() => {
        fake.exits.push(input.positionSize);
        if (fake.submitFailure) {
          return Effect.succeed([] as ReadonlyArray<TradingOrderResult>);
        }
        // An IOC fills what it can and cancels the rest.
        const filled = Math.abs(input.positionSize) * fake.fillFraction;
        const sign = fake.positionSize > 0 ? 1 : -1;
        fake.positionSize = Number((fake.positionSize - sign * filled).toFixed(10));
        return Effect.succeed([
          { cloid: "0xexit", status: "filled", filledSize: filled, role: "entry" },
        ] as ReadonlyArray<TradingOrderResult>);
      }),
    submitCancel: (input: { cloid: string }) =>
      Effect.suspend(() => {
        fake.cancels.push(input.cloid);
        if (fake.cancelRejection !== null) {
          return Effect.fail(
            new TradingExecutionError({
              stage: "inspect_failed",
              detail: fake.cancelRejection,
            }),
          );
        }
        return Effect.void;
      }),
    submitOrder: () => Effect.die("not used"),
    submitProtectiveStop: () => Effect.die("not used"),
  } as unknown as HyperliquidExecutionService["Service"]);

/**
 * The reconciler's signature names the info client even though the fake never
 * calls it, so the context has to be satisfied.
 */
const infoLayer = Layer.succeed(
  HyperliquidInfoClient,
  {} as unknown as HyperliquidInfoClient["Service"],
);

const reconcilerLayer = Layer.succeed(HyperliquidReconciler, {
  reconcile: () =>
    Effect.succeed({
      position: null,
      openOrders: [],
      canonicalOrders: [],
      fills: [],
      observedAt: 0,
    }),
} as unknown as HyperliquidReconciler["Service"]);

const missionsLayer = (fake: FakeExchange) =>
  Layer.succeed(TradingMissionService, {
    getMissionVersion: () => Effect.succeed(1),
    transition: (input: { to: string; blockedReason?: string | undefined }) =>
      Effect.suspend(() => {
        if (fake.blockWriteFails) {
          return Effect.fail("mission transition write refused");
        }
        fake.transitions.push({ to: input.to, blockedReason: input.blockedReason });
        return Effect.succeed({ status: input.to });
      }),
  } as unknown as TradingMissionService["Service"]);

/** Migrate the shared in-memory db so the order-cancel query has tables. */
const migrated = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({});
  yield* sql`DELETE FROM trading_orders`;
  yield* sql`DELETE FROM trading_execution_records`;
});

const runClose = (
  fake: FakeExchange,
  seed: Effect.Effect<void, never, SqlClient.SqlClient> = Effect.void,
) =>
  Effect.gen(function* () {
    yield* migrated;
    yield* seed;
    const service = yield* makeTradingEmergencyCloseService;
    return yield* service.emergencyClose(INPUT);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        gatewayLayer(fake),
        executionLayer(fake),
        reconcilerLayer,
        missionsLayer(fake),
        infoLayer,
        NodeSqliteClient.layerMemory(),
      ),
    ),
  );

it.effect("blocks the mission before it closes anything", () =>
  Effect.gen(function* () {
    // §17.5 step 1 is first for a reason: the position being unwound must not
    // be able to grow while it is unwound.
    const fake = makeFake();
    yield* runClose(fake);

    assert.deepEqual(fake.transitions, [{ to: "blocked", blockedReason: "protection_failure" }]);
  }),
);

it.effect("flattens a fully filling position in one attempt", () =>
  Effect.gen(function* () {
    const fake = makeFake();
    const outcome = yield* runClose(fake);

    assert.equal(outcome.flat, true);
    assert.equal(outcome.remainingSize, 0);
    assert.equal(outcome.attempts, 1);
    assert.deepEqual(fake.exits, [0.5]);
  }),
);

it.effect("converges a partially filling IOC within three attempts", () =>
  Effect.gen(function* () {
    // The §17.6 evidence case: each IOC takes 60% of what is asked, so the
    // close only completes because step 6 re-reads and retries the REMAINDER.
    const fake = makeFake({ positionSize: 0.5, fillFraction: 0.6 });
    const outcome = yield* runClose(fake);

    assert.equal(outcome.attempts <= EMERGENCY_CLOSE_MAXIMUM_ATTEMPTS, true);
    // Each attempt asked for less than the one before — proof it re-read the
    // position rather than resubmitting the original size.
    assert.equal(fake.exits.length >= 2, true);
    assert.equal(fake.exits[1]! < fake.exits[0]!, true);
  }),
);

it.effect("stops at three attempts rather than retrying forever", () =>
  Effect.gen(function* () {
    // A market that will only ever take a sliver. Unbounded retrying here is
    // a way to pay fees indefinitely; §17.5 bounds it instead.
    const fake = makeFake({ positionSize: 0.5, fillFraction: 0.1 });
    const outcome = yield* runClose(fake);

    assert.equal(outcome.flat, false);
    assert.equal(outcome.attempts, EMERGENCY_CLOSE_MAXIMUM_ATTEMPTS);
    assert.equal(fake.exits.length, EMERGENCY_CLOSE_MAXIMUM_ATTEMPTS);
  }),
);

it.effect("reports the exact remaining size and reason when it cannot flatten", () =>
  Effect.gen(function* () {
    // §17.5 step 7. "Could not close" without the number is not actionable.
    const fake = makeFake({ positionSize: 0.5, fillFraction: 0 });
    const outcome = yield* runClose(fake);

    assert.equal(outcome.flat, false);
    assert.equal(outcome.remainingSize, 0.5);
    assert.ok(outcome.failureNotice?.includes("0.5"));
    assert.ok(outcome.failureNotice?.includes(INPUT.reason));
    assert.ok(outcome.failureNotice?.includes("stays blocked"));
  }),
);

it.effect("stays bounded when every submission fails outright", () =>
  Effect.gen(function* () {
    const fake = makeFake({ submitFailure: true });
    const outcome = yield* runClose(fake);

    assert.equal(outcome.flat, false);
    assert.equal(outcome.attempts, EMERGENCY_CLOSE_MAXIMUM_ATTEMPTS);
    assert.ok(outcome.failureNotice !== undefined);
  }),
);

it.effect("closes a short by buying, and reports it flat", () =>
  Effect.gen(function* () {
    const fake = makeFake({ positionSize: -0.4 });
    const outcome = yield* runClose(fake);

    assert.equal(outcome.flat, true);
    assert.deepEqual(fake.exits, [-0.4]);
  }),
);

it.effect("does nothing when the position is already flat", () =>
  Effect.gen(function* () {
    const fake = makeFake({ positionSize: 0 });
    const outcome = yield* runClose(fake);

    assert.equal(outcome.flat, true);
    assert.equal(outcome.attempts, 0);
    assert.deepEqual(fake.exits, []);
  }),
);

it.effect("cancels increasing orders but never the reduce-only protection", () =>
  Effect.gen(function* () {
    // §17.5 step 2. Cancelling the stop on the way out would remove the one
    // thing still limiting the loss if the close does not complete.
    const fake = makeFake();
    yield* Effect.gen(function* () {
      yield* migrated;
      const sql = yield* SqlClient.SqlClient;
      const rows: ReadonlyArray<[string, string, number]> = [
        ["0xentry", "open", 0],
        ["0xstop", "open", 1],
        ["0xclose", "close", 0],
      ];
      for (const [index, [cloid, actionType, reduceOnly]] of rows.entries()) {
        yield* sql`
          INSERT INTO trading_orders (
            mission_id, cloid, order_id, market, side, limit_price,
            remaining_size, reduce_only, observed_at
          ) VALUES (${MISSION}, ${cloid}, 1, 'ETH', 'sell', 3000, 0.5, ${reduceOnly}, 0)
        `;
        // (mission, sequence) is unique since migration 053; one per row.
        const executionSequence = index;
        yield* sql`
          INSERT INTO trading_execution_records (
            execution_id, mission_id, execution_sequence, action_type,
            cloid, idempotency_key, market, side, size, limit_price, time_in_force,
            reduce_only, signer_address, status, order_results_json, created_at, updated_at
          ) VALUES (
            ${`exec_${cloid}`}, ${MISSION}, ${executionSequence}, ${actionType}, ${cloid}, ${`idem_${cloid}`},
            'ETH', 'sell', 0.5, 3000, 'gtc', ${reduceOnly}, '0xsigner', 'accepted', '[]', 0, 0
          )
        `;
      }

      const service = yield* makeTradingEmergencyCloseService;
      yield* service.emergencyClose(INPUT);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          gatewayLayer(fake),
          executionLayer(fake),
          reconcilerLayer,
          missionsLayer(fake),
          infoLayer,
          NodeSqliteClient.layerMemory(),
        ),
      ),
    );

    // The entry is cancelled; the reduce-only stop and the close are not.
    assert.deepEqual(fake.cancels, ["0xentry"]);
  }),
);

/** Seed one resting order plus the execution record that names its action. */
let seededSequence = 0;
const seedRestingOrder = (
  cloid: string,
  actionType: string,
  reduceOnly: number,
): Effect.Effect<void, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO trading_orders (
        mission_id, cloid, order_id, market, side, limit_price,
        remaining_size, reduce_only, observed_at
      ) VALUES (${MISSION}, ${cloid}, 1, 'ETH', 'sell', 3000, 0.5, ${reduceOnly}, 0)
    `;
    const executionSequence = seededSequence++;
    yield* sql`
      INSERT INTO trading_execution_records (
        execution_id, mission_id, execution_sequence, action_type,
        cloid, idempotency_key, market, side, size, limit_price, time_in_force,
        reduce_only, signer_address, status, order_results_json, created_at, updated_at
      ) VALUES (
        ${`exec_${cloid}`}, ${MISSION}, ${executionSequence}, ${actionType}, ${cloid}, ${`idem_${cloid}`},
        'ETH', 'sell', 0.5, 3000, 'gtc', ${reduceOnly}, '0xsigner', 'accepted', '[]', 0, 0
      )
    `;
  }).pipe(Effect.orDie);

// ---------------------------------------------------------------------------
// Explicit uncertainty (06C): a failed canonical read is an explicit unknown
// outcome — never a fabricated flat, never a stale size, never a retry.
// ---------------------------------------------------------------------------

it.effect("a failed initial canonical read reports unknown with zero attempts", () =>
  Effect.gen(function* () {
    const fake = makeFake({ positionSize: 0.5, snapshotReads: ["fail"] });
    const outcome = yield* runClose(fake);

    assert.equal(outcome.flat, false);
    assert.equal(outcome.remainingSize, null);
    assert.equal(outcome.attempts, 0);
    assert.deepEqual(fake.exits, [], "no IOC may be submitted when nothing was read");
    assert.ok(outcome.failureNotice?.includes("outcome unknown"), outcome.failureNotice);
    assert.ok(outcome.failureNotice?.includes("no order was submitted"), outcome.failureNotice);
    // The block was attempted (and its write succeeded here).
    assert.deepEqual(fake.transitions, [{ to: "blocked", blockedReason: "protection_failure" }]);
    assert.ok(outcome.failureNotice?.includes("stays blocked"));
  }),
);

it.effect("a failed post-submit read reports unknown after exactly one IOC", () =>
  Effect.gen(function* () {
    // 0.5 fills 60% -> 0.2 remains, then the confirming read fails. One
    // submission, unknown outcome, no numeric size, no second IOC.
    const fake = makeFake({
      positionSize: 0.5,
      fillFraction: 0.6,
      snapshotReads: ["ok", "fail"],
    });
    const outcome = yield* runClose(fake);

    assert.equal(outcome.flat, false);
    assert.equal(outcome.remainingSize, null);
    assert.equal(outcome.attempts, 1);
    assert.deepEqual(fake.exits, [0.5]);
    assert.ok(outcome.failureNotice?.includes("may have executed"), outcome.failureNotice);
  }),
);

it.effect(
  "failed order discovery keeps risk reduction but warns cancellation was unconfirmed",
  () =>
    Effect.gen(function* () {
      // The increasing-order SELECT fails (table gone) while account reads are
      // healthy: the close still runs and reduces, and the notice carries the
      // unconfirmed-cancellation warning even though the close went flat.
      const fake = makeFake({ positionSize: 0.5 });
      const dropOrders = Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DROP TABLE trading_orders`;
      }).pipe(Effect.orDie);
      const outcome = yield* runClose(fake, dropOrders);

      assert.equal(outcome.flat, true);
      assert.equal(outcome.remainingSize, 0);
      assert.deepEqual(fake.exits, [0.5], "risk reduction still attempted");
      assert.deepEqual(fake.cancels, [], "nothing could be discovered to cancel");
      assert.ok(
        outcome.failureNotice?.includes("Increasing-order cancellation was unconfirmed"),
        outcome.failureNotice,
      );
      assert.ok(outcome.failureNotice?.includes("may reopen exposure"), outcome.failureNotice);
    }),
);

it.effect("a failed mission-block write is stated as attempted, never as established fact", () =>
  Effect.gen(function* () {
    const fake = makeFake({ positionSize: 0.5, fillFraction: 0, blockWriteFails: true });
    const outcome = yield* runClose(fake);

    assert.equal(outcome.flat, false);
    assert.deepEqual(fake.transitions, []);
    assert.ok(
      outcome.failureNotice?.includes("The mission block was attempted but could not be confirmed"),
      outcome.failureNotice,
    );
    assert.ok(!outcome.failureNotice?.includes("stays blocked"), outcome.failureNotice);
  }),
);

it.effect(
  "an unknown outcome from a failed block write also avoids the established-fact phrase",
  () =>
    Effect.gen(function* () {
      const fake = makeFake({
        positionSize: 0.5,
        blockWriteFails: true,
        snapshotReads: ["fail"],
      });
      const outcome = yield* runClose(fake);

      assert.equal(outcome.remainingSize, null);
      assert.ok(
        outcome.failureNotice?.includes("attempted but could not be confirmed"),
        outcome.failureNotice,
      );
    }),
);

// ---------------------------------------------------------------------------
// RC03 — cancellation and block-write uncertainty survive every outcome, both
// as prose and as typed facts, and never stop the risk reduction itself.
// ---------------------------------------------------------------------------

it.effect("a flat close with an unconfirmed entry cancellation still flattens and warns", () =>
  Effect.gen(function* () {
    // The exchange refused the entry's cancellation, but the close is not held
    // hostage by it: the position is flattened, and the warning — plus the
    // typed list — record that an entry may still be resting.
    const fake = makeFake({ positionSize: 0.5, cancelRejection: "rejected by exchange" });
    const outcome = yield* runClose(fake, seedRestingOrder("0xentry", "open", 0));

    assert.equal(outcome.flat, true);
    assert.equal(outcome.remainingSize, 0);
    assert.deepEqual(fake.exits, [0.5], "risk reduction still attempted");
    assert.deepEqual(fake.cancels, ["0xentry"], "the cancellation was still attempted");
    assert.ok(
      outcome.failureNotice?.includes("Increasing-order cancellation was unconfirmed for 1"),
      outcome.failureNotice,
    );
    assert.ok(outcome.failureNotice?.includes("0xentry"), outcome.failureNotice);
    if (outcome.flat === true) {
      assert.deepEqual(outcome.unconfirmedCancellations, [
        { cloid: "0xentry", reason: "rejected by exchange" },
      ]);
      assert.equal(outcome.blockWriteConfirmed, true);
    }
  }),
);

it.effect("a flat close with a failed block write reports the flat and the failed block", () =>
  Effect.gen(function* () {
    // The position was flattened, but the block write failed: both facts
    // travel. A summary that said only "flat" would hide that nothing stops
    // the mission from increasing exposure again.
    const fake = makeFake({ positionSize: 0.5, blockWriteFails: true });
    const outcome = yield* runClose(fake);

    assert.equal(outcome.flat, true);
    assert.equal(outcome.remainingSize, 0);
    if (outcome.flat === true) {
      assert.equal(outcome.blockWriteConfirmed, false);
      assert.deepEqual(outcome.unconfirmedCancellations, []);
      assert.ok(
        outcome.failureNotice?.includes("attempted but could not be confirmed"),
        outcome.failureNotice,
      );
    }
    assert.deepEqual(fake.transitions, [], "the block write never landed");
  }),
);

it.effect("a flat close can carry both warnings at once", () =>
  Effect.gen(function* () {
    const fake = makeFake({
      positionSize: 0.5,
      blockWriteFails: true,
      cancelRejection: "rejected by exchange",
    });
    const outcome = yield* runClose(fake, seedRestingOrder("0xentry", "open", 0));

    assert.equal(outcome.flat, true);
    if (outcome.flat === true) {
      assert.equal(outcome.blockWriteConfirmed, false);
      assert.equal(outcome.unconfirmedCancellations.length, 1);
      assert.ok(
        outcome.failureNotice?.includes("Increasing-order cancellation was unconfirmed for 1"),
        outcome.failureNotice,
      );
      assert.ok(
        outcome.failureNotice?.includes("attempted but could not be confirmed"),
        outcome.failureNotice,
      );
    }
    // The close itself still completed.
    assert.deepEqual(fake.exits, [0.5]);
  }),
);

it.effect("an unknown outcome can carry both warnings with no numeric size", () =>
  Effect.gen(function* () {
    const fake = makeFake({
      positionSize: 0.5,
      blockWriteFails: true,
      cancelRejection: "rejected by exchange",
      snapshotReads: ["fail"],
    });
    const outcome = yield* runClose(fake, seedRestingOrder("0xentry", "open", 0));

    assert.equal(outcome.flat, false);
    assert.equal(outcome.remainingSize, null);
    if (outcome.flat === false && outcome.remainingSize === null) {
      assert.equal(outcome.blockWriteConfirmed, false);
      assert.equal(outcome.unconfirmedCancellations.length, 1);
      assert.ok(
        outcome.failureNotice?.includes("Increasing-order cancellation was unconfirmed for 1"),
        outcome.failureNotice,
      );
      assert.ok(
        outcome.failureNotice?.includes("attempted but could not be confirmed"),
        outcome.failureNotice,
      );
      // No numeric size may ride along on an unknown outcome.
      assert.ok(!outcome.failureNotice?.includes("0.5"), outcome.failureNotice);
    }
    // Nothing was submitted against an unread position.
    assert.deepEqual(fake.exits, []);
    // The cancellation was still attempted — it does not depend on the read.
    assert.deepEqual(fake.cancels, ["0xentry"]);
  }),
);

// ---------------------------------------------------------------------------
// RC04 — the shared rendering callers put on their own channels.
// ---------------------------------------------------------------------------

it.effect("describeEmergencyCloseOutcome: flat and clean says exactly that", () =>
  Effect.gen(function* () {
    const outcome = yield* runClose(makeFake({ positionSize: 0 }));
    if (outcome.flat !== true) throw new Error("expected flat");
    const text = describeEmergencyCloseOutcome("ETH", outcome);
    assert.equal(text, "Emergency close flattened ETH.");
  }),
);

it.effect("describeEmergencyCloseOutcome: flat keeps its warnings", () =>
  Effect.gen(function* () {
    const outcome = yield* runClose(
      makeFake({ positionSize: 0.5, cancelRejection: "refused" }),
      seedRestingOrder("0xentry", "open", 0),
    );
    if (outcome.flat !== true) throw new Error("expected flat");
    const text = describeEmergencyCloseOutcome("ETH", outcome);
    assert.ok(text.startsWith("Emergency close flattened ETH."), text);
    assert.ok(text.includes("Increasing-order cancellation was unconfirmed"), text);
  }),
);

it.effect("describeEmergencyCloseOutcome: open carries the signed remainder", () =>
  Effect.gen(function* () {
    const outcome = yield* runClose(makeFake({ positionSize: 0.5, fillFraction: 0 }));
    const text = describeEmergencyCloseOutcome("ETH", outcome);
    assert.ok(text.includes("0.5 remains"), text);
  }),
);

it.effect("describeEmergencyCloseOutcome: unknown carries no numeric size", () =>
  Effect.gen(function* () {
    const outcome = yield* runClose(makeFake({ positionSize: 0.5, snapshotReads: ["fail"] }));
    const text = describeEmergencyCloseOutcome("ETH", outcome);
    assert.ok(text.includes("outcome unknown"), text);
    assert.ok(!text.includes("0.5"), text);
  }),
);
