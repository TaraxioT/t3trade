import * as Schema from "effect/Schema";

const PositivePrice = Schema.Finite.check(Schema.isGreaterThan(0));
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** Public source identity. Credentials and gateway URLs never cross this boundary. */
export const GraphSourceRef = Schema.Struct({
  provider: Schema.Literal("the_graph"),
  chain: Schema.Literal("ethereum"),
  subgraphId: Schema.String,
  deployment: Schema.String,
  poolAddress: Schema.String,
  baseTokenAddress: Schema.String,
  quoteTokenAddress: Schema.String,
  feeTier: Schema.String,
  normalizationVersion: Schema.Literal(1),
});
export type GraphSourceRef = typeof GraphSourceRef.Type;

export const GraphSnapshotBlock = Schema.Struct({ number: NonNegativeInt, hash: Schema.String });
export type GraphSnapshotBlock = typeof GraphSnapshotBlock.Type;

export const ResearchPriceSample = Schema.Struct({
  id: Schema.String,
  at: NonNegativeInt,
  /** Human quote tokens per one human base token. */
  price: PositivePrice,
  blockNumber: NonNegativeInt,
  transactionId: Schema.String,
  logIndex: NonNegativeInt,
});
export type ResearchPriceSample = typeof ResearchPriceSample.Type;

export const ResearchCandle = Schema.Struct({
  id: Schema.String,
  from: NonNegativeInt,
  to: NonNegativeInt,
  resolution: Schema.Literals(["1h", "1d"]),
  /** Human quote tokens per one human base token. */
  open: PositivePrice,
  high: PositivePrice,
  low: PositivePrice,
  close: PositivePrice,
});
export type ResearchCandle = typeof ResearchCandle.Type;

const ManifestBase = {
  datasetId: Schema.String,
  source: GraphSourceRef,
  snapshotBlock: GraphSnapshotBlock,
  entityKind: Schema.Literals(["swaps", "hour", "day"]),
  from: NonNegativeInt,
  to: NonNegativeInt,
  rowCount: NonNegativeInt,
};

/** A complete manifest is immutable; progress is represented separately. */
export const ResearchDatasetManifest = Schema.Union([
  Schema.Struct({
    ...ManifestBase,
    status: Schema.Literal("complete"),
    completedAt: NonNegativeInt,
  }),
  Schema.Struct({ ...ManifestBase, status: Schema.Literal("incomplete") }),
]);
export type ResearchDatasetManifest = typeof ResearchDatasetManifest.Type;

export const GraphDataErrorReason = Schema.Literals([
  "configuration",
  "authentication",
  "schema_mismatch",
  "coverage",
  "indexing",
  "rate_limit",
  "upstream_failure",
]);
export type GraphDataErrorReason = typeof GraphDataErrorReason.Type;

export class GraphDataError extends Schema.TaggedError<GraphDataError>()("GraphDataError", {
  reason: GraphDataErrorReason,
  detail: Schema.String,
  retryAfterMs: Schema.optional(NonNegativeInt),
}) {
  override get message(): string {
    return `GraphDataError(${this.reason}): ${this.detail}`;
  }
}

export const GraphEntityKind = Schema.Literals(["swaps", "hour", "day"]);
export type GraphEntityKind = typeof GraphEntityKind.Type;

export interface GraphSourceCapabilities {
  readonly source: GraphSourceRef;
  readonly snapshotBlock: GraphSnapshotBlock;
  readonly indexedThrough: number;
  readonly token0: { readonly address: string; readonly decimals: number };
  readonly token1: { readonly address: string; readonly decimals: number };
  readonly coverage: Readonly<
    Record<GraphEntityKind, { readonly firstAt: number; readonly lastAt: number }>
  >;
}

export interface GraphWindowPage {
  readonly entityKind: GraphEntityKind;
  readonly rows: ReadonlyArray<ResearchPriceSample | ResearchCandle>;
  readonly nextCursor: string | null;
  readonly progress: {
    readonly rowsReturned: number;
    readonly hasMore: boolean;
    readonly snapshotBlock: GraphSnapshotBlock;
  };
}

export const ResearchJobStatus = Schema.Literals([
  "queued",
  "running",
  "paused",
  "cancelled",
  "complete",
  "failed",
]);
export type ResearchJobStatus = typeof ResearchJobStatus.Type;

export const ResearchJobView = Schema.Struct({
  jobId: Schema.String,
  datasetId: Schema.String,
  environmentId: Schema.String,
  threadId: Schema.String,
  source: GraphSourceRef,
  snapshotBlock: GraphSnapshotBlock,
  entityKind: GraphEntityKind,
  from: NonNegativeInt,
  to: NonNegativeInt,
  status: ResearchJobStatus,
  rowCount: NonNegativeInt,
  requestCount: NonNegativeInt,
  storedBytes: NonNegativeInt,
  cursor: Schema.NullOr(Schema.String),
  updatedAt: NonNegativeInt,
  failureReason: Schema.optional(Schema.String),
});
export type ResearchJobView = typeof ResearchJobView.Type;

export const ResearchAcquisitionRequest = Schema.Struct({
  environmentId: Schema.String,
  threadId: Schema.String,
  source: GraphSourceRef,
  snapshotBlock: GraphSnapshotBlock,
  entityKind: GraphEntityKind,
  from: NonNegativeInt,
  to: NonNegativeInt,
});
export type ResearchAcquisitionRequest = typeof ResearchAcquisitionRequest.Type;

export const ResearchDatasetWindow = Schema.Struct({
  manifest: ResearchDatasetManifest,
  rows: Schema.Array(Schema.Union([ResearchPriceSample, ResearchCandle])),
  nextCursor: Schema.NullOr(Schema.String),
});
export type ResearchDatasetWindow = typeof ResearchDatasetWindow.Type;

export const ResearchErrorReason = Schema.Literals([
  "invalid_request",
  "not_found",
  "conflict",
  "budget",
  "cancelled",
  "storage",
  "source",
]);
export type ResearchErrorReason = typeof ResearchErrorReason.Type;

export class ResearchError extends Schema.TaggedError<ResearchError>()("ResearchError", {
  reason: ResearchErrorReason,
  detail: Schema.String,
}) {
  override get message(): string {
    return `ResearchError(${this.reason}): ${this.detail}`;
  }
}

const FomcOccurrenceBase = {
  id: Schema.String,
  meetingFrom: Schema.String,
  meetingTo: Schema.String,
  classification: Schema.Literals(["scheduled", "unscheduled"]),
  sourceUrl: Schema.String,
  sourceHash: Schema.String,
  sourceExcerpt: Schema.String,
  calendarUrl: Schema.String,
  calendarHash: Schema.String,
  retrievedAt: NonNegativeInt,
  timezoneInterpretation: Schema.String,
  minutesReleasedOn: Schema.NullOr(Schema.String),
};
export const FomcEventOccurrence = Schema.Union([
  Schema.Struct({
    ...FomcOccurrenceBase,
    statementAt: NonNegativeInt,
    missingTimeReason: Schema.Null,
  }),
  Schema.Struct({
    ...FomcOccurrenceBase,
    statementAt: Schema.Null,
    missingTimeReason: Schema.Literals([
      "future_unpublished",
      "not_published",
      "source_unavailable",
      "source_missing",
    ]),
  }),
]);
export type FomcEventOccurrence = typeof FomcEventOccurrence.Type;

/** Frozen source inventory; incomplete periods remain visible for review. */
export const FomcEventInventory = Schema.Struct({
  id: Schema.String,
  category: Schema.Literals(["scheduled", "unscheduled", "all"]),
  from: Schema.String,
  to: Schema.String,
  asOf: NonNegativeInt,
  retrievedAt: NonNegativeInt,
  status: Schema.Literals(["complete", "incomplete"]),
  affectedPeriods: Schema.Array(Schema.String),
  occurrences: Schema.Array(FomcEventOccurrence),
});
export type FomcEventInventory = typeof FomcEventInventory.Type;
