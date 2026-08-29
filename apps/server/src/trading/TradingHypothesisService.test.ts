/**
 * Lineage, and the two refusals that keep it honest.
 *
 * A hypothesis is only worth having if a version's numbers stay that version's
 * numbers. Everything below is a way of asking that: that a revision writes a
 * new version rather than editing one, that a conclusion is dropped when the
 * thesis under it changes, that a run filed against a version is a run of that
 * version's thesis, and that a refinement takes the validation slot from its
 * own earlier version and from nothing else.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type { BacktestReport } from "@t3tools/trading-contracts/backtest";
import {
  HYPOTHESIS_SHOW_RUNS,
  HYPOTHESIS_SHOW_VERSIONS,
  thesesMatch,
} from "@t3tools/trading-contracts/hypothesis";
import type { TradingThesis } from "@t3tools/trading-contracts/thesis";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import type { CandleRow } from "./archive/candles.ts";
import { TradingMarketArchive, type TradingMarketArchiveShape } from "./TradingMarketArchive.ts";
import {
  TradingHypothesisService,
  TradingHypothesisServiceLive,
} from "./TradingHypothesisService.ts";
import {
  TradingThesisValidationService,
  TradingThesisValidationServiceLive,
} from "./TradingThesisValidationService.ts";

const MINUTE = 60_000;
const START = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1_000;

/** Flat bars: nothing here tests the engine, only what is filed about it. */
const ALL_BARS: ReadonlyArray<CandleRow> = Array.from({ length: 40 }, (_, i) => {
  const t = START + i * 5 * MINUTE;
  return {
    coin: "ETH",
    interval: "5m",
    t,
    tClose: t + 5 * MINUTE - 1,
    o: 100,
    h: 100,
    l: 100,
    c: 100,
    v: 1,
    n: 1,
  };
});

const stubArchive = Layer.succeed(TradingMarketArchive, {
  coverage: () => Effect.succeed({ recordingSince: START, gaps: [] }),
  candlesInWindow: (input: { readonly fromT: number; readonly toT: number }) =>
    Effect.succeed(ALL_BARS.filter((row) => row.t >= input.fromT && row.t <= input.toT)),
  fundingInWindow: () => Effect.succeed([]),
  bookHistory: () => Effect.succeed({ status: "unavailable", reason: "no rows" }),
} as unknown as TradingMarketArchiveShape);

const layer = it.layer(
  Layer.mergeAll(
    TradingHypothesisServiceLive,
    TradingThesisValidationServiceLive.pipe(Layer.provide(stubArchive)),
  ).pipe(
    Layer.provideMerge(stubArchive),
    Layer.provideMerge(NodeSqliteClient.layerMemory()),
    Layer.provideMerge(NodeServices.layer),
  ),
);

const migrated = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({});
  yield* sql`DELETE FROM trading_hypotheses`;
  yield* sql`DELETE FROM trading_hypothesis_versions`;
  yield* sql`DELETE FROM trading_backtest_runs`;
  yield* sql`DELETE FROM trading_thesis_validations`;
  yield* sql`DELETE FROM trading_thesis_paper_fills`;
});

const thesis = (target: number): TradingThesis => ({
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
  exits: { stop: { basis: "percent", value: 2 }, target: { basis: "percent", value: target } },
});

/** A report shaped like the engine's, with only the fields anything reads set. */
const report = (thesisFor: TradingThesis, expectancy: number): BacktestReport => ({
  thesis: thesisFor,
  notionalUsd: 1_000,
  costs: { takerFeeBpsPerSide: 4.5, slippageBpsPerSide: 1, slippageSource: "assumed" },
  coverage: {
    requestedFromT: START,
    requestedToT: START + DAY,
    servedFromT: START,
    servedToT: START + DAY,
    barsServed: 288,
    gaps: [],
    recordingSince: START,
    fundingServed: false,
  },
  stats: {
    setupsFound: 30,
    tradesTaken: 25,
    setupsUnpriced: 0,
    wins: 13,
    losses: 12,
    breakEven: 0,
    winRatePercent: 52,
    averageWinUsd: 4,
    averageLossUsd: -3,
    expectancyUsd: expectancy,
    totalGrossUsd: 40,
    totalFeesUsd: 15,
    totalFundingUsd: 0,
    totalNetUsd: expectancy * 25,
    maxDrawdownUsd: 8,
    timeInMarketPercent: 20,
    buyAndHoldNetUsd: 0,
    buyAndHoldReturnPercent: 0,
  },
  verdict: "positive_after_fees",
  verdictReason: "a fixture, not a finding",
});

const saved = Effect.fn("saved")(function* (title: string) {
  const service = yield* TradingHypothesisService;
  const created = yield* service.create({
    title,
    thesis: thesis(1),
    threadId: "thread-1",
    author: "agent",
    now: START,
  });
  assert.equal(created.outcome, "ok");
  if (created.outcome !== "ok") return yield* Effect.die("create refused");
  return created.hypothesis;
});

layer("TradingHypothesisService", (it) => {
  it.effect("a revision writes the next version and leaves the first one alone", () =>
    Effect.gen(function* () {
      yield* migrated;
      const service = yield* TradingHypothesisService;
      const first = yield* saved("the ETH cross");

      assert.equal(first.currentVersion, 1);
      assert.equal(first.status, "exploring");
      assert.equal(first.versions.length, 1);

      const revised = yield* service.revise({
        hypothesisId: first.hypothesisId,
        thesis: thesis(3),
        note: "one percent was inside the spread",
        author: "agent",
        now: START + 1,
      });
      assert.equal(revised.outcome, "ok");
      if (revised.outcome !== "ok") return;

      assert.equal(revised.hypothesis.currentVersion, 2);
      assert.equal(revised.hypothesis.versionCount, 2);
      // The point of the whole record: version 1's thesis is untouched.
      const v1 = yield* service.version({ hypothesisId: first.hypothesisId, version: 1 });
      assert.isTrue(thesesMatch(v1?.thesis ?? thesis(3), thesis(1)));
      assert.isTrue(thesesMatch(revised.hypothesis.thesis, thesis(3)));
      assert.equal(revised.hypothesis.currentNote, "one percent was inside the spread");
    }),
  );

  it.effect("concluding sets the sentence, and revising takes it back off", () =>
    Effect.gen(function* () {
      yield* migrated;
      const service = yield* TradingHypothesisService;
      const first = yield* saved("the ETH cross");

      const concluded = yield* service.setStatus({
        hypothesisId: first.hypothesisId,
        to: "unsupported",
        conclusion: "negative after fees on every window tested",
        now: START + 1,
      });
      assert.equal(concluded.outcome, "ok");
      if (concluded.outcome !== "ok") return;
      assert.equal(concluded.hypothesis.status, "unsupported");
      assert.equal(concluded.hypothesis.conclusion, "negative after fees on every window tested");

      const revised = yield* service.revise({
        hypothesisId: first.hypothesisId,
        thesis: thesis(3),
        note: "widen the target past the spread",
        author: "agent",
        now: START + 2,
      });
      assert.equal(revised.outcome, "ok");
      if (revised.outcome !== "ok") return;
      // A verdict about a thesis that has since changed is worse than none.
      assert.equal(revised.hypothesis.status, "exploring");
      assert.isNull(revised.hypothesis.conclusion);
    }),
  );

  it.effect("concluding without a sentence is refused", () =>
    Effect.gen(function* () {
      yield* migrated;
      const service = yield* TradingHypothesisService;
      const first = yield* saved("the ETH cross");
      const refused = yield* service.setStatus({
        hypothesisId: first.hypothesisId,
        to: "supported",
        now: START + 1,
      });
      assert.equal(refused.outcome, "refused");
    }),
  );

  it.effect("a run is kept with or without a hypothesis, and stamps the one it names", () =>
    Effect.gen(function* () {
      yield* migrated;
      const service = yield* TradingHypothesisService;
      const first = yield* saved("the ETH cross");

      yield* service.recordRun({ thesis: thesis(9), report: report(thesis(9), 0.4), now: START });
      yield* service.recordRun({
        thesis: thesis(1),
        report: report(thesis(1), 1.25),
        hypothesisId: first.hypothesisId,
        hypothesisVersion: 1,
        now: START + 1,
      });

      const sql = yield* SqlClient.SqlClient;
      const all = yield* sql<{
        readonly n: number;
      }>`SELECT COUNT(*) AS n FROM trading_backtest_runs`;
      assert.equal(all[0]?.n, 2, "a loose run is still kept");

      const shown = yield* service.show(first.hypothesisId);
      assert.equal(shown?.runs.length, 1, "only the stamped run belongs to the idea");
      assert.equal(shown?.runs[0]?.version, 1);
      assert.equal(shown?.runs[0]?.expectancyUsd, 1.25);
      assert.equal(shown?.runs[0]?.verdict, "positive_after_fees");
      // Filing a run against an idea is what moves it out of exploring; there
      // is no verb for it.
      assert.equal(shown?.status, "testing");
    }),
  );

  it.effect("a list scoped to a thread sees only that thread's ideas", () =>
    Effect.gen(function* () {
      yield* migrated;
      const service = yield* TradingHypothesisService;
      yield* saved("the ETH cross");
      yield* service.create({
        title: "somebody else's idea",
        thesis: thesis(1),
        threadId: "thread-2",
        author: "agent",
        now: START,
      });

      const mine = yield* service.list({ threadId: "thread-1" });
      assert.equal(mine.length, 1);
      assert.equal(mine[0]?.title, "the ETH cross");
      const everything = yield* service.list({});
      assert.equal(everything.length, 2);
    }),
  );
});

layer("the show payload", (it) => {
  /**
   * `trading_hypothesis` results are exempt from tool-result summarization,
   * which is only honest while the payload cannot grow without bound. A
   * hypothesis can accumulate versions and runs forever, so the cap is the
   * thing that keeps the exemption true, and 8 KB is the projection's ceiling.
   */
  it.effect("stays under the summarization ceiling however long the history gets", () =>
    Effect.gen(function* () {
      yield* migrated;
      const service = yield* TradingHypothesisService;
      const first = yield* saved("the ETH cross");

      for (let version = 2; version <= 30; version += 1) {
        yield* service.revise({
          hypothesisId: first.hypothesisId,
          thesis: thesis(version),
          note: `version ${version}: widen the target again and see what it costs`,
          author: "agent",
          now: START + version,
        });
        yield* service.recordRun({
          thesis: thesis(version),
          report: report(thesis(version), version / 10),
          hypothesisId: first.hypothesisId,
          hypothesisVersion: version,
          now: START + version,
        });
      }

      const shown = yield* service.show(first.hypothesisId);
      assert.equal(shown?.versions.length, HYPOTHESIS_SHOW_VERSIONS);
      assert.equal(shown?.runs.length, HYPOTHESIS_SHOW_RUNS);
      assert.equal(shown?.versionCount, 30);
      assert.equal(shown?.runCount, 29);

      // The handler ships this record plus one summary per linked validation.
      // Measured on the record itself, which is every unbounded part of it.
      // Measuring the wire size IS the assertion; there is nothing to decode.
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const bytes = JSON.stringify(shown).length;
      assert.isBelow(bytes, 8_000, `the show payload was ${bytes} chars`);
    }),
  );
});

layer("the supersede rule", (it) => {
  it.effect("a refinement of the same idea takes the slot; another idea does not", () =>
    Effect.gen(function* () {
      yield* migrated;
      const hypotheses = yield* TradingHypothesisService;
      const validations = yield* TradingThesisValidationService;

      const mine = yield* saved("the ETH cross");
      const theirs = yield* hypotheses.create({
        title: "a different ETH idea",
        thesis: thesis(1),
        threadId: "thread-1",
        author: "agent",
        now: START,
      });
      if (theirs.outcome !== "ok") return yield* Effect.die("create refused");

      const armed = yield* validations.arm({
        thesis: thesis(1),
        durationMs: 14 * DAY,
        hypothesisId: mine.hypothesisId,
        hypothesisVersion: 1,
        now: START,
      });
      assert.equal(armed.outcome, "armed");
      if (armed.outcome !== "armed") return;
      assert.isUndefined(armed.superseded, "nothing was in the slot");

      // Another hypothesis on the same market and interval still collides.
      const blocked = yield* validations.arm({
        thesis: thesis(3),
        durationMs: 14 * DAY,
        hypothesisId: theirs.hypothesis.hypothesisId,
        hypothesisVersion: 1,
        now: START + 1,
      });
      assert.equal(blocked.outcome, "refused");

      // So does an arm with no hypothesis at all.
      const bare = yield* validations.arm({
        thesis: thesis(3),
        durationMs: 14 * DAY,
        now: START + 1,
      });
      assert.equal(bare.outcome, "refused");

      // The same idea's next version takes the slot, and says so.
      const next = yield* validations.arm({
        thesis: thesis(3),
        durationMs: 14 * DAY,
        hypothesisId: mine.hypothesisId,
        hypothesisVersion: 2,
        now: START + 2,
      });
      assert.equal(next.outcome, "armed");
      if (next.outcome !== "armed") return;
      assert.equal(next.superseded, armed.validation.id);

      const previous = yield* validations.get(armed.validation.id);
      assert.equal(previous?.status, "ended");
      assert.equal(previous?.endReason, "superseded");
      assert.equal(next.validation.hypothesisVersion, 2);

      // Both runs stay attached to the idea, at the versions they tested.
      const shown = yield* hypotheses.show(mine.hypothesisId);
      assert.equal(shown?.validations.length, 2);
      assert.deepEqual((shown?.validations ?? []).map((entry) => entry.version).sort(), [1, 2]);
    }),
  );
});
