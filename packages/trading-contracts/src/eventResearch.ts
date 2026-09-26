import * as Schema from "effect/Schema";

import {
  FomcEventInventory,
  FomcEventOccurrence,
  GraphSnapshotBlock,
  GraphSourceRef,
  ResearchPriceSample,
} from "./researchData.ts";

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));

export const EventResearchRecipe = Schema.Struct({
  environmentId: Schema.String,
  threadId: Schema.String,
  eventInventory: FomcEventInventory,
  source: GraphSourceRef,
  snapshotBlock: GraphSnapshotBlock,
  from: Schema.String,
  to: Schema.String,
  /** Clock-time offsets after the sourced statement timestamp. */
  horizonsMs: Schema.Array(PositiveInt),
  referencePriceRule: Schema.Struct({
    beforeMaxAgeMs: NonNegativeInt,
    afterMaxDelayMs: NonNegativeInt,
  }),
  cutoffAt: NonNegativeInt,
});
export type EventResearchRecipe = typeof EventResearchRecipe.Type;

const HorizonBase = { horizonMs: PositiveInt };
export const EventHorizonOutcome = Schema.Union([
  Schema.Struct({
    ...HorizonBase,
    status: Schema.Literal("measured"),
    referenceSampleId: Schema.String,
    horizonSampleId: Schema.String,
    referenceAt: NonNegativeInt,
    horizonAt: NonNegativeInt,
    referencePrice: Schema.Finite.check(Schema.isGreaterThan(0)),
    horizonPrice: Schema.Finite.check(Schema.isGreaterThan(0)),
    returnPct: Schema.Finite,
  }),
  Schema.Struct({
    ...HorizonBase,
    status: Schema.Literal("uncovered"),
    reason: Schema.Literals(["timestamp_unknown", "missing_reference", "missing_horizon"]),
  }),
  Schema.Struct({
    ...HorizonBase,
    status: Schema.Literal("pending"),
    reason: Schema.Literal("future_endpoint"),
  }),
]);
export type EventHorizonOutcome = typeof EventHorizonOutcome.Type;

export const EventResearchRow = Schema.Struct({
  eventId: Schema.String,
  event: FomcEventOccurrence,
  horizons: Schema.Array(EventHorizonOutcome),
});
export type EventResearchRow = typeof EventResearchRow.Type;

export const EventHorizonSummary = Schema.Struct({
  horizonMs: PositiveInt,
  eligibleCount: NonNegativeInt,
  measuredCount: NonNegativeInt,
  uncoveredCount: NonNegativeInt,
  pendingCount: NonNegativeInt,
  unknownTimeCount: NonNegativeInt,
  meanReturnPct: Schema.NullOr(Schema.Finite),
});
export type EventHorizonSummary = typeof EventHorizonSummary.Type;

export const EventResearchReport = Schema.Struct({
  version: Schema.Literal(1),
  inventoryId: Schema.String,
  source: GraphSourceRef,
  snapshotBlock: GraphSnapshotBlock,
  cutoffAt: NonNegativeInt,
  rows: Schema.Array(EventResearchRow),
  summaries: Schema.Array(EventHorizonSummary),
});
export type EventResearchReport = typeof EventResearchReport.Type;

export interface EventResearchInput {
  readonly recipe: EventResearchRecipe;
  readonly priceSamples: ReadonlyArray<ResearchPriceSample>;
  /** Presentation choice; numerical results use only the retained samples. */
  readonly renderResolution?: "1h" | "1d";
}

export const SavedEventStudy = Schema.Struct({
  studyId: Schema.String,
  environmentId: Schema.String,
  threadId: Schema.String,
  recipe: EventResearchRecipe,
  report: EventResearchReport,
  reportHash: Schema.String,
  datasetIds: Schema.Array(Schema.String),
  priceSamples: Schema.Array(ResearchPriceSample),
  createdAt: NonNegativeInt,
});
export type SavedEventStudy = typeof SavedEventStudy.Type;

function validate(input: EventResearchInput): void {
  if (!Schema.is(EventResearchRecipe)(input.recipe))
    throw new Error("Invalid event research recipe");
  if (
    input.recipe.horizonsMs.length === 0 ||
    new Set(input.recipe.horizonsMs).size !== input.recipe.horizonsMs.length
  ) {
    throw new Error("Horizons must be nonempty and unique");
  }
  if (
    new Set(input.recipe.eventInventory.occurrences.map((event) => event.id)).size !==
    input.recipe.eventInventory.occurrences.length
  ) {
    throw new Error("Event IDs must be unique");
  }
  const ids = new Set<string>();
  for (const sample of input.priceSamples) {
    if (!Schema.is(ResearchPriceSample)(sample) || ids.has(sample.id))
      throw new Error("Invalid or duplicate price sample");
    ids.add(sample.id);
  }
}

/** Compute descriptive spot returns from one frozen event inventory and price source. */
export function calculateEventResearch(input: EventResearchInput): EventResearchReport {
  validate(input);
  const { recipe } = input;
  const samples = [...input.priceSamples].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  const rows: EventResearchRow[] = recipe.eventInventory.occurrences.map((event) => {
    const horizons: EventHorizonOutcome[] = recipe.horizonsMs.map((horizonMs) => {
      if (event.statementAt === null)
        return { horizonMs, status: "uncovered", reason: "timestamp_unknown" };
      const endpoint = event.statementAt + horizonMs;
      if (endpoint > recipe.cutoffAt)
        return { horizonMs, status: "pending", reason: "future_endpoint" };
      const reference = samples.findLast(
        (sample) =>
          sample.at <= event.statementAt &&
          event.statementAt - sample.at <= recipe.referencePriceRule.beforeMaxAgeMs,
      );
      if (!reference) return { horizonMs, status: "uncovered", reason: "missing_reference" };
      const horizon = samples.find(
        (sample) =>
          sample.at >= endpoint &&
          sample.at <= endpoint + recipe.referencePriceRule.afterMaxDelayMs &&
          sample.at <= recipe.cutoffAt,
      );
      if (!horizon) return { horizonMs, status: "uncovered", reason: "missing_horizon" };
      return {
        horizonMs,
        status: "measured",
        referenceSampleId: reference.id,
        horizonSampleId: horizon.id,
        referenceAt: reference.at,
        horizonAt: horizon.at,
        referencePrice: reference.price,
        horizonPrice: horizon.price,
        returnPct: ((horizon.price - reference.price) / reference.price) * 100,
      };
    });
    return { eventId: event.id, event, horizons };
  });
  const summaries: EventHorizonSummary[] = recipe.horizonsMs.map((horizonMs, index) => {
    const outcomes = rows.map((row) => row.horizons[index]!);
    const measured = outcomes.filter((outcome) => outcome.status === "measured");
    const uncovered = outcomes.filter(
      (outcome) => outcome.status === "uncovered" && outcome.reason !== "timestamp_unknown",
    );
    return {
      horizonMs,
      eligibleCount: measured.length + uncovered.length,
      measuredCount: measured.length,
      uncoveredCount: uncovered.length,
      pendingCount: outcomes.filter((outcome) => outcome.status === "pending").length,
      unknownTimeCount: outcomes.filter(
        (outcome) => outcome.status === "uncovered" && outcome.reason === "timestamp_unknown",
      ).length,
      meanReturnPct:
        measured.length === 0
          ? null
          : measured.reduce((sum, outcome) => sum + outcome.returnPct, 0) / measured.length,
    };
  });
  return {
    version: 1,
    inventoryId: recipe.eventInventory.id,
    source: recipe.source,
    snapshotBlock: recipe.snapshotBlock,
    cutoffAt: recipe.cutoffAt,
    rows,
    summaries,
  };
}
