import * as Schema from "effect/Schema";

import { SavedEventStudy } from "@t3tools/trading-contracts/eventResearch";
import { SavedEventLongSimulation } from "@t3tools/trading-contracts/eventLongSimulation";
import { ResearchDatasetWindow, ResearchJobView } from "@t3tools/trading-contracts/researchData";
import { OpenResearchSceneAction as OpenResearchSceneActionSchema } from "@t3tools/trading-contracts/researchScenes";

import { ThreadId } from "./baseSchemas.ts";

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const GetResearchJobInput = Schema.Struct({ threadId: ThreadId, jobId: Schema.String });
export type GetResearchJobInput = typeof GetResearchJobInput.Type;

export const GetResearchJobResult = ResearchJobView;
export type GetResearchJobResult = typeof GetResearchJobResult.Type;

const DatasetWindowFields = {
  threadId: ThreadId,
  datasetId: Schema.String,
  from: NonNegativeInt,
  to: NonNegativeInt,
  resolution: Schema.Literals(["swaps", "1h", "1d"]),
  cursor: Schema.optional(Schema.String),
};
export const GetResearchDatasetWindowInput = Schema.Union([
  Schema.Struct({ ...DatasetWindowFields, studyId: Schema.String }),
  Schema.Struct({ ...DatasetWindowFields, simulationId: Schema.String }),
]);
export type GetResearchDatasetWindowInput = typeof GetResearchDatasetWindowInput.Type;

export const GetResearchDatasetWindowResult = ResearchDatasetWindow;
export type GetResearchDatasetWindowResult = typeof GetResearchDatasetWindowResult.Type;

export const GetSavedResearchInput = Schema.Struct({
  threadId: ThreadId,
  studyId: Schema.optional(Schema.String),
  simulationId: Schema.optional(Schema.String),
});
export type GetSavedResearchInput = typeof GetSavedResearchInput.Type;

export const GetSavedResearchResult = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("event_study"), study: SavedEventStudy }),
  Schema.Struct({ kind: Schema.Literal("long_simulation"), simulation: SavedEventLongSimulation }),
]);
export type GetSavedResearchResult = typeof GetSavedResearchResult.Type;

export const PublishSavedResearchInput = Schema.Union([
  Schema.Struct({ threadId: ThreadId, studyId: Schema.String }),
  Schema.Struct({ threadId: ThreadId, simulationId: Schema.String }),
]);
export type PublishSavedResearchInput = typeof PublishSavedResearchInput.Type;

export const PublishSavedResearchResult = Schema.Struct({
  openResearch: OpenResearchSceneActionSchema,
});
export type PublishSavedResearchResult = typeof PublishSavedResearchResult.Type;

/** Navigation intent to one retained result in one authenticated environment. */
export { OpenResearchSceneAction } from "@t3tools/trading-contracts/researchScenes";
