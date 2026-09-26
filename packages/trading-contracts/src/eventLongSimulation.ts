import * as Schema from "effect/Schema";

import { SavedEventStudy } from "./eventResearch.ts";
import { ResearchPriceSample } from "./researchData.ts";

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));
const PositiveMoney = Schema.Finite.check(Schema.isGreaterThan(0));
const NonNegativeBps = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)).check(
  Schema.isLessThan(10_000),
);

export const EventLongScenario = Schema.Struct({
  /** Initial quote-currency entry notional, excluding modeled fees. */
  notionalQuote: PositiveMoney,
  entryDelayMs: NonNegativeInt,
  holdMs: PositiveInt,
  maxEntryWaitMs: NonNegativeInt,
  maxExitWaitMs: NonNegativeInt,
  feeBpsPerSide: NonNegativeBps,
  slippageBpsPerSide: NonNegativeBps,
});
export type EventLongScenario = typeof EventLongScenario.Type;

export const EventLongSimulationRequest = Schema.Struct({
  parentStudyId: Schema.String,
  scenario: EventLongScenario,
});
export type EventLongSimulationRequest = typeof EventLongSimulationRequest.Type;

export const EventLongOutcome = Schema.Union([
  Schema.Struct({
    eventId: Schema.String,
    status: Schema.Literal("traded"),
    entrySampleId: Schema.String,
    exitSampleId: Schema.String,
    entryAt: NonNegativeInt,
    exitAt: NonNegativeInt,
    entryPrice: PositiveMoney,
    exitPrice: PositiveMoney,
    quantityBase: PositiveMoney,
    notionalQuote: PositiveMoney,
    grossPnlQuote: Schema.Finite,
    entryFeeQuote: Schema.Finite,
    exitFeeQuote: Schema.Finite,
    slippageCostQuote: Schema.Finite,
    netPnlQuote: Schema.Finite,
    netReturnPct: Schema.Finite,
  }),
  Schema.Struct({
    eventId: Schema.String,
    status: Schema.Literal("skipped"),
    reason: Schema.Literals([
      "timestamp_unknown",
      "entry_unavailable",
      "exit_unavailable",
      "future_endpoint",
    ]),
  }),
]);
export type EventLongOutcome = typeof EventLongOutcome.Type;

export const EventLongSimulationReport = Schema.Struct({
  version: Schema.Literal(1),
  parentStudyId: Schema.String,
  parentReportHash: Schema.String,
  parentReportVersion: Schema.Literal(1),
  scenario: EventLongScenario,
  outcomes: Schema.Array(EventLongOutcome),
  summary: Schema.Struct({
    eventCount: NonNegativeInt,
    coveredTrades: NonNegativeInt,
    skippedEvents: NonNegativeInt,
    totalGrossPnlQuote: Schema.Finite,
    totalFeesQuote: Schema.Finite,
    totalSlippageCostQuote: Schema.Finite,
    totalNetPnlQuote: Schema.Finite,
    meanNetReturnPct: Schema.NullOr(Schema.Finite),
    isCompoundReturn: Schema.Literal(false),
  }),
});
export type EventLongSimulationReport = typeof EventLongSimulationReport.Type;

export interface EventLongSimulationInput {
  readonly parentStudy: SavedEventStudy;
  readonly scenario: EventLongScenario;
}

export const SavedEventLongSimulation = Schema.Struct({
  simulationId: Schema.String,
  environmentId: Schema.String,
  threadId: Schema.String,
  parentStudyId: Schema.String,
  parentReportHash: Schema.String,
  parentReportVersion: Schema.Literal(1),
  datasetIds: Schema.Array(Schema.String),
  scenario: EventLongScenario,
  report: EventLongSimulationReport,
  reportHash: Schema.String,
  priceSamples: Schema.Array(ResearchPriceSample),
  createdAt: NonNegativeInt,
});
export type SavedEventLongSimulation = typeof SavedEventLongSimulation.Type;

/** Independent hypothetical spot longs; no exchange, funding, order book, or compounding. */
export function simulateEventLongs(input: EventLongSimulationInput): EventLongSimulationReport {
  if (
    !Schema.is(EventLongScenario)(input.scenario) ||
    !Schema.is(SavedEventStudy)(input.parentStudy)
  ) {
    throw new Error("Invalid long simulation input");
  }
  const { parentStudy, scenario } = input;
  const samples = [...parentStudy.priceSamples].sort(
    (a, b) => a.at - b.at || a.id.localeCompare(b.id),
  );
  const outcomes: EventLongOutcome[] = parentStudy.recipe.eventInventory.occurrences.map(
    (event) => {
      if (event.statementAt === null)
        return { eventId: event.id, status: "skipped", reason: "timestamp_unknown" };
      const targetEntry = event.statementAt + scenario.entryDelayMs;
      if (targetEntry > parentStudy.recipe.cutoffAt)
        return { eventId: event.id, status: "skipped", reason: "future_endpoint" };
      const entry = samples.find(
        (sample) =>
          sample.at >= targetEntry &&
          sample.at <= targetEntry + scenario.maxEntryWaitMs &&
          sample.at <= parentStudy.recipe.cutoffAt,
      );
      if (!entry) return { eventId: event.id, status: "skipped", reason: "entry_unavailable" };
      const targetExit = entry.at + scenario.holdMs;
      if (targetExit > parentStudy.recipe.cutoffAt)
        return { eventId: event.id, status: "skipped", reason: "future_endpoint" };
      const exit = samples.find(
        (sample) =>
          sample.at >= targetExit &&
          sample.at <= targetExit + scenario.maxExitWaitMs &&
          sample.at <= parentStudy.recipe.cutoffAt,
      );
      if (!exit) return { eventId: event.id, status: "skipped", reason: "exit_unavailable" };
      const feeRate = scenario.feeBpsPerSide / 10_000;
      const slipRate = scenario.slippageBpsPerSide / 10_000;
      const effectiveEntryPrice = entry.price * (1 + slipRate);
      const effectiveExitPrice = exit.price * (1 - slipRate);
      const quantityBase = scenario.notionalQuote / effectiveEntryPrice;
      const grossPnlQuote = quantityBase * (exit.price - entry.price);
      const entryFeeQuote = scenario.notionalQuote * feeRate;
      const exitFeeQuote = quantityBase * effectiveExitPrice * feeRate;
      const slippageCostQuote = quantityBase * (entry.price * slipRate + exit.price * slipRate);
      const netPnlQuote = grossPnlQuote - entryFeeQuote - exitFeeQuote - slippageCostQuote;
      const netReturnPct = (netPnlQuote / scenario.notionalQuote) * 100;
      if (
        ![
          effectiveEntryPrice,
          effectiveExitPrice,
          quantityBase,
          grossPnlQuote,
          entryFeeQuote,
          exitFeeQuote,
          slippageCostQuote,
          netPnlQuote,
          netReturnPct,
        ].every(Number.isFinite) ||
        quantityBase <= 0
      ) {
        throw new Error("Long simulation arithmetic exceeded finite bounds");
      }
      return {
        eventId: event.id,
        status: "traded",
        entrySampleId: entry.id,
        exitSampleId: exit.id,
        entryAt: entry.at,
        exitAt: exit.at,
        entryPrice: entry.price,
        exitPrice: exit.price,
        quantityBase,
        notionalQuote: scenario.notionalQuote,
        grossPnlQuote,
        entryFeeQuote,
        exitFeeQuote,
        slippageCostQuote,
        netPnlQuote,
        netReturnPct,
      };
    },
  );
  const trades = outcomes.filter((outcome) => outcome.status === "traded");
  const totalGrossPnlQuote = trades.reduce((sum, trade) => sum + trade.grossPnlQuote, 0);
  const totalFeesQuote = trades.reduce(
    (sum, trade) => sum + trade.entryFeeQuote + trade.exitFeeQuote,
    0,
  );
  const totalSlippageCostQuote = trades.reduce((sum, trade) => sum + trade.slippageCostQuote, 0);
  const totalNetPnlQuote = trades.reduce((sum, trade) => sum + trade.netPnlQuote, 0);
  const meanNetReturnPct =
    trades.length === 0
      ? null
      : trades.reduce((sum, trade) => sum + trade.netReturnPct, 0) / trades.length;
  if (
    ![
      totalGrossPnlQuote,
      totalFeesQuote,
      totalSlippageCostQuote,
      totalNetPnlQuote,
      meanNetReturnPct ?? 0,
    ].every(Number.isFinite)
  ) {
    throw new Error("Long simulation summary exceeded finite bounds");
  }
  return {
    version: 1,
    parentStudyId: parentStudy.studyId,
    parentReportHash: parentStudy.reportHash,
    parentReportVersion: parentStudy.report.version,
    scenario,
    outcomes,
    summary: {
      eventCount: outcomes.length,
      coveredTrades: trades.length,
      skippedEvents: outcomes.length - trades.length,
      totalGrossPnlQuote,
      totalFeesQuote,
      totalSlippageCostQuote,
      totalNetPnlQuote,
      meanNetReturnPct,
      isCompoundReturn: false,
    },
  };
}
