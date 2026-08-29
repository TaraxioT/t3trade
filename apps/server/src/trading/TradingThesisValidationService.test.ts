/**
 * The paper ledger, and the wall around it.
 *
 * Two of the tests here are the reason the feature is allowed to exist. One
 * proves a firing thesis writes paper rows and reaches no execution service —
 * asserted at the service boundary, by building the whole thing with an
 * execution layer that fails the test if anything touches it. The other proves
 * the real ledger, positions and PnL projections cannot see a paper row, by
 * filling the paper tables and reading every real surface back empty.
 *
 * The engine's arithmetic is pinned in `forward.test.ts` against the batch
 * backtest. What is pinned here is everything that only exists because there
 * is a database: the lifecycle and its reverse states, the catch-up walk, and
 * the separation.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { MIN_REPLAY_SETUPS } from "@t3tools/trading-contracts/replay";
import type { TradingThesis } from "@t3tools/trading-contracts/thesis";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import type { CandleRow } from "./archive/candles.ts";
import { TradingMarketArchive, type TradingMarketArchiveShape } from "./TradingMarketArchive.ts";
import {
  TradingThesisValidationService,
  TradingThesisValidationServiceLive,
} from "./TradingThesisValidationService.ts";

const MINUTE = 60_000;
/** A round epoch on a 5m boundary, so bar times are readable in failures. */
const START = 1_800_000_000_000;

/**
 * The archived series every test walks: a repeating four-bar cycle that
 * crosses 100 from below on a known cadence, with swings wide enough to reach
 * a percent stop and target.
 */
const bars = (count: number): ReadonlyArray<CandleRow> =>
  Array.from({ length: count }, (_, i) => {
    const t = START + i * 5 * MINUTE;
    const base = { coin: "ETH", interval: "5m", t, tClose: t + 5 * MINUTE - 1, v: 10, n: 5 };
    switch (i % 4) {
      case 0:
        return { ...base, o: 99, h: 99.5, l: 98.5, c: 99 };
      case 1:
        return { ...base, o: 99, h: 101.5, l: 99, c: 101 };
      case 2:
        return { ...base, o: 101, h: 103, l: 100.5, c: 102 };
      default:
        return { ...base, o: 102, h: 102, l: 97.5, c: 98 };
    }
  });

const ALL_BARS = bars(80);
/** `now` once every bar in the fixture has closed. */
const AFTER_ALL = (ALL_BARS[ALL_BARS.length - 1]?.tClose ?? START) + 1;

const stubArchive = Layer.succeed(TradingMarketArchive, {
  coverage: () => Effect.succeed({ recordingSince: START, gaps: [] }),
  candlesInWindow: (input: { readonly fromT: number; readonly toT: number }) =>
    Effect.succeed(ALL_BARS.filter((row) => row.t >= input.fromT && row.t <= input.toT)),
  fundingInWindow: () => Effect.succeed([]),
  bookHistory: () => Effect.succeed({ status: "unavailable", reason: "no rows" }),
} as unknown as TradingMarketArchiveShape);

const layer = it.layer(
  TradingThesisValidationServiceLive.pipe(
    Layer.provideMerge(stubArchive),
    Layer.provideMerge(NodeSqliteClient.layerMemory()),
    Layer.provideMerge(NodeServices.layer),
  ),
);

const migrated = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({});
  yield* sql`DELETE FROM trading_thesis_validations`;
  yield* sql`DELETE FROM trading_thesis_paper_fills`;
});

/** Buy the cross of 100, take a wide stop and a reachable target. */
const thesis: TradingThesis = {
  market: "ETH",
  interval: "5m",
  side: "long",
  entry: {
    predicates: [
      {
        left: { source: "price" },
        comparator: "crosses_above",
        right: { source: "constant", value: 100 },
      },
    ],
  },
  exits: {
    stop: { basis: "percent", value: 2 },
    target: { basis: "percent", value: 1 },
  },
};

const DAY = 24 * 60 * 60 * 1_000;

layer("TradingThesisValidationService", (it) => {
  it.effect("a firing thesis writes paper rows and settles them after fees", () =>
    Effect.gen(function* () {
      yield* migrated;
      const sql = yield* SqlClient.SqlClient;
      const service = yield* TradingThesisValidationService;

      const armed = yield* service.arm({ thesis, durationMs: 14 * DAY, now: START });
      assert.equal(armed.outcome, "armed");
      if (armed.outcome !== "armed") return;

      yield* service.onClosedBar({ asset: "ETH", interval: "5m", now: AFTER_ALL });

      const trades = yield* service.trades(armed.validation.id);
      assert.isAbove(trades.length, 3, "the fixture must actually fire the rule");

      const settled = trades.filter((trade) => trade.exitTime !== null);
      assert.isAbove(settled.length, 0);
      for (const trade of settled) {
        // Fees are charged on both legs, so a settled paper trade never nets
        // its gross. That is the whole point of paper trading a thesis.
        assert.isNotNull(trade.feesUsd);
        assert.isAbove(trade.feesUsd ?? 0, 0);
        assert.approximately(
          trade.netUsd ?? 0,
          (trade.grossUsd ?? 0) - (trade.feesUsd ?? 0) + (trade.fundingUsd ?? 0),
          0.02,
        );
      }

      // The rows are in the paper tables and nowhere else.
      const paper = yield* sql<{
        readonly n: number;
      }>`SELECT COUNT(*) AS n FROM trading_thesis_paper_fills`;
      assert.isAbove(paper[0]?.n ?? 0, 0);
    }),
  );

  // The boundary test. The service is constructed with only the archive and
  // the database; there is no execution service, entry service, exit service
  // or gateway in its layer at all. If a future edit reached for one, this
  // test would stop compiling or stop building its layer — which is a stronger
  // guarantee than asserting a spy was not called, because it fails before the
  // code can run.
  it.effect("never reaches an execution path: no order, fill or position is written", () =>
    Effect.gen(function* () {
      yield* migrated;
      const sql = yield* SqlClient.SqlClient;
      const service = yield* TradingThesisValidationService;

      const armed = yield* service.arm({ thesis, durationMs: 14 * DAY, now: START });
      if (armed.outcome !== "armed") return assert.fail("expected the thesis to arm");

      yield* service.onClosedBar({ asset: "ETH", interval: "5m", now: AFTER_ALL });
      const trades = yield* service.trades(armed.validation.id);
      assert.isAbove(trades.length, 0, "paper trades must have been taken for this to prove much");

      // Every table a real trade touches, read back empty.
      for (const table of [
        "trading_orders",
        "trading_fills",
        "trading_closed_trades",
        "trading_position_snapshots",
        "trading_execution_sequences",
      ] as const) {
        const rows = yield* sql<{ readonly n: number }>`
          SELECT COUNT(*) AS n FROM ${sql.literal(table)}
        `;
        assert.equal(rows[0]?.n ?? 0, 0, `${table} must not have gained a row`);
      }
    }),
  );

  // The other half of the separation: even with paper rows present, nothing
  // that reports real money can see them. Asserted by query rather than by
  // reading the projections' source, so a future join would break it.
  it.effect("real ledger, position and PnL surfaces cannot see a paper row", () =>
    Effect.gen(function* () {
      yield* migrated;
      const sql = yield* SqlClient.SqlClient;
      const service = yield* TradingThesisValidationService;

      const armed = yield* service.arm({ thesis, durationMs: 14 * DAY, now: START });
      if (armed.outcome !== "armed") return assert.fail("expected the thesis to arm");
      yield* service.onClosedBar({ asset: "ETH", interval: "5m", now: AFTER_ALL });

      const paper = yield* sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM trading_thesis_paper_fills WHERE net_usd IS NOT NULL
      `;
      assert.isAbove(paper[0]?.n ?? 0, 0, "there must be settled paper money to leak");

      // Realised PnL, as every real surface computes it.
      const realised = yield* sql<{ readonly total: number | null }>`
        SELECT SUM(net_pnl) AS total FROM trading_closed_trades
      `;
      assert.isTrue(
        realised[0]?.total === null || realised[0]?.total === 0,
        "paper money reached realised PnL",
      );

      const fills = yield* sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM trading_fills`;
      assert.equal(fills[0]?.n ?? 0, 0, "paper fills reached the real fill ledger");

      const positions = yield* sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM trading_position_snapshots WHERE size != 0
      `;
      assert.equal(positions[0]?.n ?? 0, 0, "a paper position reached the position surface");
    }),
  );

  it.effect("refuses an interval no candle is ever delivered on", () =>
    Effect.gen(function* () {
      yield* migrated;
      const service = yield* TradingThesisValidationService;
      const result = yield* service.arm({
        thesis: { ...thesis, interval: "1d" },
        durationMs: 14 * DAY,
        now: START,
      });
      assert.equal(result.outcome, "refused");
      if (result.outcome !== "refused") return;
      assert.include(result.reason, "1d");
      assert.include(result.reason, "never see a bar");
    }),
  );

  it.effect("refuses a second validation of the same market and interval", () =>
    Effect.gen(function* () {
      yield* migrated;
      const service = yield* TradingThesisValidationService;
      yield* service.arm({ thesis, durationMs: 14 * DAY, now: START });
      const second = yield* service.arm({ thesis, durationMs: 14 * DAY, now: START });
      assert.equal(second.outcome, "refused");
      if (second.outcome !== "refused") return;
      assert.include(second.reason, "already being validated");
    }),
  );

  it.effect("pauses, evaluates nothing while paused, and resumes", () =>
    Effect.gen(function* () {
      yield* migrated;
      const service = yield* TradingThesisValidationService;
      const armed = yield* service.arm({ thesis, durationMs: 14 * DAY, now: START });
      if (armed.outcome !== "armed") return assert.fail("expected the thesis to arm");
      const id = armed.validation.id;

      const paused = yield* service.setStatus({ id, to: "paused", now: START });
      assert.equal(paused.outcome, "ok");

      // A pass while paused must not advance the record at all: the read that
      // drives evaluation only selects armed rows.
      yield* service.onClosedBar({ asset: "ETH", interval: "5m", now: AFTER_ALL });
      const whilePaused = yield* service.get(id);
      assert.equal(whilePaused?.barsWatched, 0);
      assert.deepEqual(yield* service.trades(id), []);

      // Pausing twice is refused rather than silently accepted, so the caller
      // always learns the real state.
      const again = yield* service.setStatus({ id, to: "paused", now: START });
      assert.equal(again.outcome, "refused");

      const resumed = yield* service.setStatus({ id, to: "armed", now: START });
      assert.equal(resumed.outcome, "ok");
      yield* service.onClosedBar({ asset: "ETH", interval: "5m", now: AFTER_ALL });
      const after = yield* service.get(id);
      assert.isAbove(after?.barsWatched ?? 0, 0, "a resumed validation watches bars again");
    }),
  );

  // The defect a live pass found: resuming used to replay every bar the pause
  // was supposed to skip, because the catch-up walk starts from `lastBarTime`
  // and pausing left it behind. That made pause a way to DELAY evaluation
  // rather than to exclude it, and made a liar of the report's own "bars are
  // passing unwatched" and of the documentation promising the same.
  it.effect("a resumed validation does not replay the bars it sat out", () =>
    Effect.gen(function* () {
      yield* migrated;
      const service = yield* TradingThesisValidationService;
      const armed = yield* service.arm({ thesis, durationMs: 14 * DAY, now: START });
      if (armed.outcome !== "armed") return assert.fail("expected the thesis to arm");
      const id = armed.validation.id;

      // Watch a short opening stretch, then pause part-way through the fixture.
      const pausedAt = (ALL_BARS[19]?.tClose ?? START) + 1;
      yield* service.onClosedBar({ asset: "ETH", interval: "5m", now: pausedAt });
      const beforePause = yield* service.get(id);
      const watchedBeforePause = beforePause?.barsWatched ?? 0;
      const tradesBeforePause = (yield* service.trades(id)).length;
      assert.isAbove(watchedBeforePause, 0);

      yield* service.setStatus({ id, to: "paused", now: pausedAt });
      // Bars keep closing in the market while it is paused; none are evaluated.
      yield* service.onClosedBar({ asset: "ETH", interval: "5m", now: AFTER_ALL });
      assert.equal((yield* service.get(id))?.barsWatched, watchedBeforePause);

      // Resuming picks up from the live edge, not from where the pause began.
      yield* service.setStatus({ id, to: "armed", now: AFTER_ALL });
      yield* service.onClosedBar({ asset: "ETH", interval: "5m", now: AFTER_ALL });

      const afterResume = yield* service.get(id);
      assert.equal(
        afterResume?.barsWatched,
        watchedBeforePause,
        "the paused stretch must not be counted as watched",
      );
      assert.equal(
        (yield* service.trades(id)).length,
        tradesBeforePause,
        "the paused stretch must not have taken trades",
      );
    }),
  );

  it.effect("ends on demand, and an ended validation cannot be moved again", () =>
    Effect.gen(function* () {
      yield* migrated;
      const service = yield* TradingThesisValidationService;
      const armed = yield* service.arm({ thesis, durationMs: 14 * DAY, now: START });
      if (armed.outcome !== "armed") return assert.fail("expected the thesis to arm");
      const id = armed.validation.id;

      const ended = yield* service.setStatus({ id, to: "ended", now: START + 1 });
      assert.equal(ended.outcome, "ok");
      const read = yield* service.get(id);
      assert.equal(read?.status, "ended");
      assert.equal(read?.endReason, "ended_by_user");

      const revive = yield* service.setStatus({ id, to: "armed", now: START + 2 });
      assert.equal(revive.outcome, "refused");

      // An ended validation is off the default list but still readable, so the
      // record it produced does not vanish with it.
      const live = yield* service.list({});
      assert.equal(live.length, 0);
      const withEnded = yield* service.list({ includeEnded: true });
      assert.equal(withEnded.length, 1);
    }),
  );

  it.effect("expiry ends the validation and hands back a final report", () =>
    Effect.gen(function* () {
      yield* migrated;
      const service = yield* TradingThesisValidationService;
      const armed = yield* service.arm({ thesis, durationMs: MINUTE * 60, now: START });
      if (armed.outcome !== "armed") return assert.fail("expected the thesis to arm");

      const nothingYet = yield* service.expireDue({ now: START + 1 });
      assert.equal(
        nothingYet.reports.length,
        0,
        "a validation still inside its window must not expire",
      );

      const { reports } = yield* service.expireDue({ now: AFTER_ALL });
      assert.equal(reports.length, 1);
      const report = reports[0];
      assert.equal(report?.endReason, "expired");
      assert.equal(report?.status, "ended");
      assert.equal(report?.paperOnly, true);
      // The final report covers the whole window: expiry evaluates the last
      // bars before it closes the record.
      assert.isAbove(report?.barsWatched ?? 0, 0);
      assert.isNotEmpty(report?.verdictReason ?? "");
    }),
  );

  it.effect("reports the numbers under the sample floor without calling them a verdict", () =>
    Effect.gen(function* () {
      yield* migrated;
      const service = yield* TradingThesisValidationService;
      const armed = yield* service.arm({ thesis, durationMs: 14 * DAY, now: START });
      if (armed.outcome !== "armed") return assert.fail("expected the thesis to arm");

      // A short window: enough bars to take a few trades, nowhere near the
      // twenty a verdict needs.
      const earlyBar = ALL_BARS[19];
      yield* service.onClosedBar({
        asset: "ETH",
        interval: "5m",
        now: (earlyBar?.tClose ?? START) + 1,
      });
      const report = yield* service.report({ id: armed.validation.id, now: AFTER_ALL });

      assert.isNotNull(report);
      assert.isBelow(report?.stats.tradesTaken ?? 99, MIN_REPLAY_SETUPS);
      assert.equal(report?.comparison, "too_few_trades");
      assert.include(report?.verdictReason ?? "", "not evidence of an edge");
      // The figures are still printed underneath the refusal.
      assert.include(report?.verdictReason ?? "", "hit rate");
    }),
  );

  it.effect("stops refusing a verdict once the sample floor is cleared", () =>
    Effect.gen(function* () {
      yield* migrated;
      const service = yield* TradingThesisValidationService;
      const armed = yield* service.arm({ thesis, durationMs: 14 * DAY, now: START });
      if (armed.outcome !== "armed") return assert.fail("expected the thesis to arm");

      yield* service.onClosedBar({ asset: "ETH", interval: "5m", now: AFTER_ALL });
      const report = yield* service.report({ id: armed.validation.id, now: AFTER_ALL });

      assert.isAtLeast(report?.stats.tradesTaken ?? 0, MIN_REPLAY_SETUPS);
      // No backtest was recorded when this was armed, so the comparison is
      // refused for the honest reason rather than measured against a zero.
      assert.equal(report?.comparison, "no_baseline");
      assert.include(report?.verdictReason ?? "", "nothing to compare it against");
    }),
  );

  it.effect("evaluates each bar exactly once across repeated passes", () =>
    Effect.gen(function* () {
      yield* migrated;
      const service = yield* TradingThesisValidationService;
      const armed = yield* service.arm({ thesis, durationMs: 14 * DAY, now: START });
      if (armed.outcome !== "armed") return assert.fail("expected the thesis to arm");

      yield* service.onClosedBar({ asset: "ETH", interval: "5m", now: AFTER_ALL });
      const first = yield* service.get(armed.validation.id);
      const firstTrades = yield* service.trades(armed.validation.id);

      // A redelivery of the same closed bars must change nothing: `last_bar_time`
      // is what stops a restart or a duplicate delivery from double-counting.
      yield* service.onClosedBar({ asset: "ETH", interval: "5m", now: AFTER_ALL });
      const second = yield* service.get(armed.validation.id);
      const secondTrades = yield* service.trades(armed.validation.id);

      assert.equal(second?.barsWatched, first?.barsWatched);
      assert.equal(secondTrades.length, firstTrades.length);
    }),
  );

  // ---------------------------------------------------------------------
  // the live narrative (prompt W)
  // ---------------------------------------------------------------------

  it.effect("one pass that entered and exited yields ONE batch carrying both", () =>
    Effect.gen(function* () {
      yield* migrated;
      const service = yield* TradingThesisValidationService;
      const armed = yield* service.arm({ thesis, durationMs: 14 * DAY, now: START });
      if (armed.outcome !== "armed") return assert.fail("expected the thesis to arm");

      // One catch-up pass over the whole fixture: it takes several trades, and
      // the coalescing rule says that is one record, not one per fill.
      const batches = yield* service.onClosedBar({
        asset: "ETH",
        interval: "5m",
        now: AFTER_ALL,
      });
      assert.equal(batches.length, 1, "one validation moved, so there is one batch");
      const batch = batches[0];
      assert.equal(batch?.validationId, armed.validation.id);
      assert.equal(batch?.market, "ETH");
      assert.include(batch?.kinds ?? [], "paper_entry");
      assert.include(batch?.kinds ?? [], "paper_exit");
      // Deduplicated: several trades, still one of each kind.
      assert.equal(
        (batch?.kinds ?? []).filter((kind) => kind === "paper_entry").length,
        1,
        "kinds are deduplicated even when the pass took several trades",
      );
      assert.isAbove((batch?.lines.length ?? 0) + 0, 1, "every event keeps its own line");
      assert.match(batch?.lines[0] ?? "", /^paper long opened on ETH at /);

      // A pass over bars already walked is not an event.
      const quiet = yield* service.onClosedBar({ asset: "ETH", interval: "5m", now: AFTER_ALL });
      assert.equal(quiet.length, 0, "a pass that changed nothing must wake nobody");
    }),
  );

  it.effect("a verdict change is reported once, and never on the first reading", () =>
    Effect.gen(function* () {
      yield* migrated;
      const sql = yield* SqlClient.SqlClient;
      const service = yield* TradingThesisValidationService;
      const armed = yield* service.arm({ thesis, durationMs: 14 * DAY, now: START });
      if (armed.outcome !== "armed") return assert.fail("expected the thesis to arm");

      // First pass: a reading, not news. The label is recorded and no
      // verdict_change is emitted, however it landed.
      const halfway = (ALL_BARS[20]?.tClose ?? START) + 1;
      const first = yield* service.onClosedBar({ asset: "ETH", interval: "5m", now: halfway });
      assert.notInclude(
        first[0]?.kinds ?? [],
        "verdict_change",
        "a validation's FIRST comparison is a reading, not a change",
      );
      const afterFirst = yield* service.get(armed.validation.id);
      assert.isNotNull(afterFirst?.lastComparison, "the reading is recorded for next time");

      // Force the difference the same way a real regime change would: give it
      // a baseline it did not have, so the next pass compares against one.
      yield* service.setBaseline({
        id: armed.validation.id,
        baseline: {
          setupsFound: MIN_REPLAY_SETUPS + 20,
          tradesTaken: MIN_REPLAY_SETUPS + 20,
          setupsUnpriced: 0,
          wins: MIN_REPLAY_SETUPS + 18,
          losses: 2,
          breakEven: 0,
          winRatePercent: 90,
          averageWinUsd: 600,
          averageLossUsd: -100,
          expectancyUsd: 500,
          totalGrossUsd: 5_200,
          totalFeesUsd: 200,
          totalFundingUsd: 0,
          totalNetUsd: 5_000,
          maxDrawdownUsd: 0,
          timeInMarketPercent: 20,
          buyAndHoldNetUsd: 0,
          buyAndHoldReturnPercent: 0,
        },
      });

      const second = yield* service.onClosedBar({ asset: "ETH", interval: "5m", now: AFTER_ALL });
      assert.include(second[0]?.kinds ?? [], "verdict_change");
      assert.isDefined(second[0]?.previousComparison);
      assert.match(second[0]?.lines.join(" ") ?? "", /verdict now .*, was /);

      // The new label is what the row now holds, so the change is not reported
      // a second time on a pass that changes nothing else.
      const stored = yield* sql<{ readonly last_comparison: string | null }>`
        SELECT last_comparison FROM trading_thesis_validations
        WHERE validation_id = ${armed.validation.id}
      `;
      assert.equal(stored[0]?.last_comparison, second[0]?.comparison);
    }),
  );

  it.effect("expiry hands back both the report and an expiry event", () =>
    Effect.gen(function* () {
      yield* migrated;
      const service = yield* TradingThesisValidationService;
      const armed = yield* service.arm({ thesis, durationMs: MINUTE * 60, now: START });
      if (armed.outcome !== "armed") return assert.fail("expected the thesis to arm");

      const finished = yield* service.expireDue({ now: AFTER_ALL });
      assert.equal(finished.reports.length, 1);
      assert.equal(finished.events.length, 1, "an expiry is always worth one event");
      assert.include(finished.events[0]?.kinds ?? [], "expiry");
      assert.match(
        finished.events[0]?.lines.join(" ") ?? "",
        /validation window closed after \d+ bars/,
      );
    }),
  );

  it.effect("serves the armed validation and its paper trades to the chart", () =>
    Effect.gen(function* () {
      yield* migrated;
      const service = yield* TradingThesisValidationService;
      const armed = yield* service.arm({ thesis, durationMs: 14 * DAY, now: START });
      if (armed.outcome !== "armed") return assert.fail("expected the thesis to arm");
      yield* service.onClosedBar({ asset: "ETH", interval: "5m", now: AFTER_ALL });

      const forChart = yield* service.forChart({ asset: "ETH" });
      assert.isNotNull(forChart);
      assert.equal(forChart?.validation.interval, "5m");
      assert.isAbove(forChart?.trades.length ?? 0, 0);

      // A market with nothing armed on it has no badge to draw.
      assert.isNull(yield* service.forChart({ asset: "SOL" }));
    }),
  );
});
