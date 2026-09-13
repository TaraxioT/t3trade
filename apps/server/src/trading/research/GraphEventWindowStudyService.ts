/**
 * GraphEventWindowStudyService — the event-window study over REAL retained
 * Graph datasets: entry/holding-window variants around dated external
 * events, measured against an explicit every-bar baseline, with honest
 * coverage disclosure and an applies-now assessment.
 *
 * The direction this serves (07-direction-supersession.md): research a
 * question like "what does ETH do around Devcons" from REAL Graph-derived
 * prices — never the Hyperliquid archive (which cannot cover 2022–2024), and
 * never a non-Graph price source — then freeze windows and thresholds from
 * the result BEFORE any detector is armed. The study may be inconclusive;
 * a small covered sample disclosed plainly is the honest outcome, not a
 * failure to paper over.
 *
 * How it stays inside the existing seams:
 *
 * - Acquisition is `GraphResearchService.loadStudyDataset`, one call per
 *   (variant, measurable occurrence). The 90-segment / 24h-per-segment
 *   request budget makes ONE contiguous window across Devcons two years
 *   apart impossible, so each occurrence gets its own retained `ds_`
 *   dataset around its anchor — and the per-occurrence baseline limitation
 *   is DISCLOSED in the result instead of hidden.
 * - Return arithmetic, gap handling, truncation, and the every-bar baseline
 *   are `runEventStudy` (packages/trading-contracts/eventSets): expected
 *   grid slots not nearest rows, contiguous runs, one as-of cutoff, complete
 *   horizons only in aggregates. Nothing here reimplements that engine.
 * - A "variant" is an explicit, compared entry/holding design: an anchor
 *   (pre-event-start with a lead, or post-event-end with a tail), a holding
 *   horizon in bars, and an entry basis. ALL requested variants run and ALL
 *   are retained — picking the flattering one after the fact is exactly the
 *   cherry-picking the direction forbids.
 * - Occurrences whose anchor predates the pool dataset's declared coverage
 *   are reported uncovered BY DECLARATION (the declared boundary is part of
 *   the retained spec, and the actual earliest retained observation is
 *   recorded beside it, so a wrong declaration is visible).
 * - Retention: one content-addressed row per study (migration 113, file
 *   only until the coordinator registers it), spec echo + full result.
 *
 * Research replay stays ineligible for execution: everything this service
 * produces is research evidence over historical datasets, and the
 * eligibleAt/EvidenceMode boundaries elsewhere enforce that without this
 * module doing anything about it.
 *
 * SQL + the injected Graph research service only — no network of its own,
 * no signer, nothing that could reach an order.
 *
 * @module GraphEventWindowStudyService
 */
// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off - the content-derived study id hashes with node:crypto, and the disclosed window timestamps render through Date; both are this service's implementation details, not Effect abstractions.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { createHash } from "node:crypto";

import { FORGE_MAX_WINDOW_SECONDS, type ForgeSwapObservation } from "@t3tools/trading-contracts";
import {
  runEventStudy,
  type EventStudyEntryBasis,
  type EventStudyReport,
  type TradingEventOccurrence,
} from "@t3tools/trading-contracts/eventSets";
import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import { forgeJsonEncode } from "../forge/ForgeJsonEncode.ts";
import {
  GRAPH_STUDY_MAX_SEGMENTS,
  GraphResearchService,
  type GraphStudyDataset,
} from "./GraphResearchService.ts";

/** The most occurrences one study may carry (per-occurrence acquisition multiplies cost). */
export const EVENT_WINDOW_STUDY_MAX_OCCURRENCES = 32;

/** The most entry/holding variants one study may compare. */
export const EVENT_WINDOW_STUDY_MAX_VARIANTS = 8;

/** One compared entry/holding design. Every requested variant runs and is retained. */
export interface EventWindowStudyVariant {
  /** Short human label retained with every number (e.g. "pre-30d-hold-30d"). */
  readonly label: string;
  /** Where entry anchors: `leadMs` BEFORE the event start, or `tailMs` AFTER the event end. */
  readonly anchor: "pre-start" | "post-end";
  /** pre-start only: entry lead before event start, ms. */
  readonly leadMs: number;
  /** post-end only: entry tail after event end, ms. */
  readonly tailMs: number;
  /** Holding period in bars of `intervalMs`. */
  readonly horizonBars: number;
  readonly entryBasis: EventStudyEntryBasis;
}

/** The next not-yet-happened occurrence the applies-now assessment reads. */
export interface NextEventOccurrence {
  readonly startAt: number;
  readonly endAt: number;
  readonly label?: string | undefined;
  /** Where the date was verified; retained with the assessment. */
  readonly source: string;
}

export interface GraphEventWindowStudyInput {
  readonly environmentId: string;
  readonly poolId: string;
  readonly market: string;
  readonly eventSetName: string;
  readonly occurrences: ReadonlyArray<TradingEventOccurrence>;
  /**
   * The pool dataset's declared earliest coverage, ms. Occurrences anchored
   * before it are uncovered BY DECLARATION (the boundary is retained in the
   * spec and the actual earliest retained observation is recorded beside
   * it). When omitted, every occurrence is attempted and the 90-segment
   * acquisition budget may refuse the study outright.
   */
  readonly poolDataStartMs?: number | undefined;
  readonly intervalMs: number;
  readonly variants: ReadonlyArray<EventWindowStudyVariant>;
  readonly nextOccurrence?: NextEventOccurrence | undefined;
  readonly now: number;
}

/** One occurrence's outcome inside one variant. */
export interface EventWindowOccurrenceOutcome {
  readonly label: string | undefined;
  readonly startAt: number;
  readonly endAt: number;
  readonly anchorAt: number;
  readonly source: string;
  readonly covered: boolean;
  /** Present on uncovered occurrences: why nothing was measured. */
  readonly reason?: string | undefined;
  /** The retained dataset lineage when the occurrence was measured. */
  readonly datasetId?: string | undefined;
  readonly returnPct?: number | undefined;
  readonly truncated?: boolean | undefined;
  readonly baselineMeanReturnPct?: number | undefined;
  /** Trader net base acquisition over [anchor, anchor+24h), exact raw units (positive = net buying). */
  readonly entryDayNetBaseRaw?: string | undefined;
  /** Trader net base acquisition over the full entry lead window, exact raw units. */
  readonly entryLeadNetBaseRaw?: string | undefined;
}

/** One variant's outcome: per-occurrence results plus across-occurrence aggregates. */
export interface EventWindowVariantOutcome {
  readonly label: string;
  readonly anchor: "pre-start" | "post-end";
  readonly leadMs: number;
  readonly tailMs: number;
  readonly horizonBars: number;
  readonly entryBasis: EventStudyEntryBasis;
  readonly occurrences: ReadonlyArray<EventWindowOccurrenceOutcome>;
  /** Aggregates across COMPLETE horizons only (runEventStudy's discipline). */
  readonly aggregates: {
    readonly nRequested: number;
    readonly nCovered: number;
    readonly nComplete: number;
    readonly meanReturnPct: number | null;
    readonly bestReturnPct: number | null;
    readonly worstReturnPct: number | null;
    readonly meanBaselineReturnPct: number | null;
  };
  readonly disclosure: string;
}

/** The applies-now assessment for one variant against the next occurrence. */
export interface EventWindowAppliesNow {
  readonly label: string;
  /** Null when the variant's anchor design has no pre-event entry window. */
  readonly entryWindowStartMs: number | null;
  readonly entryWindowEndMs: number | null;
  readonly withinWindow: boolean | null;
  readonly note: string;
}

export interface GraphEventWindowStudyResult {
  readonly studyId: string;
  readonly createdAtMs: number;
  readonly eventSetName: string;
  readonly poolId: string;
  readonly intervalMs: number;
  readonly variants: ReadonlyArray<EventWindowVariantOutcome>;
  readonly appliesNow: ReadonlyArray<EventWindowAppliesNow>;
  /** The earliest observation actually retained across every dataset in this study. */
  readonly earliestRetainedObservationMs: number | null;
  readonly declaredPoolDataStartMs: number | null;
  readonly uncertainty: string;
}

export type GraphEventWindowStudyRead =
  | { readonly status: "ok"; readonly result: GraphEventWindowStudyResult }
  | { readonly status: "unavailable"; readonly reason: string };

export interface GraphEventWindowStudyServiceShape {
  readonly runStudy: (
    input: GraphEventWindowStudyInput,
  ) => Effect.Effect<GraphEventWindowStudyRead>;
  /** Read one retained study back by its content-derived id. */
  readonly readStudy: (
    studyId: string,
  ) => Effect.Effect<{ readonly specJson: string; readonly resultJson: string } | null>;
}

export class GraphEventWindowStudyService extends Context.Service<
  GraphEventWindowStudyService,
  GraphEventWindowStudyServiceShape
>()("t3/trading/research/GraphEventWindowStudyService") {}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

/** Trader net base acquisition (positive = net buying) from raw pool deltas, exact BigInt. */
const netBaseAcquisitionRaw = (
  observations: ReadonlyArray<ForgeSwapObservation>,
  fromMs: number,
  toMs: number,
): string => {
  let net = 0n;
  for (const observation of observations) {
    if (observation.timestamp * 1000 < fromMs || observation.timestamp * 1000 >= toMs) continue;
    const baseDelta = BigInt(observation.baseIsToken1 ? observation.amount1 : observation.amount0);
    // The pool's delta is the traders' negation: pool gaining base means
    // traders sold it. Trader net acquisition = -(pool base delta).
    net += -baseDelta;
  }
  return net.toString(10);
};

export const makeGraphEventWindowStudyService = Effect.gen(function* () {
  const research = yield* GraphResearchService;
  const sql = yield* SqlClient.SqlClient;

  const runStudy: GraphEventWindowStudyServiceShape["runStudy"] = (input) =>
    Effect.gen(function* () {
      // -- Boundary validation: refuse up front, before any acquisition. ----
      if (
        input.occurrences.length === 0 ||
        input.occurrences.length > EVENT_WINDOW_STUDY_MAX_OCCURRENCES
      ) {
        return {
          status: "unavailable" as const,
          reason: `the event set must hold 1–${EVENT_WINDOW_STUDY_MAX_OCCURRENCES} occurrences (event-window study cap)`,
        };
      }
      if (input.variants.length === 0 || input.variants.length > EVENT_WINDOW_STUDY_MAX_VARIANTS) {
        return {
          status: "unavailable" as const,
          reason: `the study must compare 1–${EVENT_WINDOW_STUDY_MAX_VARIANTS} entry/holding variants`,
        };
      }
      if (
        !Number.isSafeInteger(input.intervalMs) ||
        input.intervalMs < 3_600_000 ||
        !Number.isSafeInteger(input.now) ||
        input.now <= 0
      ) {
        return {
          status: "unavailable" as const,
          reason: "invalid study interval (≥ 1h) or clock",
        };
      }
      for (const occurrence of input.occurrences) {
        if (occurrence.endAt < occurrence.startAt || occurrence.source.trim() === "") {
          return {
            status: "unavailable" as const,
            reason: "every occurrence needs a sound span and a non-empty source",
          };
        }
      }
      const labels = new Set<string>();
      for (const variant of input.variants) {
        if (variant.label.trim() === "" || labels.has(variant.label)) {
          return {
            status: "unavailable" as const,
            reason: "every variant needs a unique non-empty label",
          };
        }
        labels.add(variant.label);
        const offsetMs = variant.anchor === "pre-start" ? variant.leadMs : variant.tailMs;
        if (
          !Number.isSafeInteger(offsetMs) ||
          offsetMs <= 0 ||
          !Number.isSafeInteger(variant.horizonBars) ||
          variant.horizonBars < 1
        ) {
          return {
            status: "unavailable" as const,
            reason: `variant ${variant.label}: the anchor offset and horizon must be positive integers`,
          };
        }
        // One per-occurrence acquisition must fit the existing request budget:
        // offset + horizon in segments of the source's 24h per-segment cap.
        const spanMs = offsetMs + variant.horizonBars * input.intervalMs;
        const segments = Math.ceil(spanMs / (FORGE_MAX_WINDOW_SECONDS * 1000));
        if (segments > GRAPH_STUDY_MAX_SEGMENTS) {
          return {
            status: "unavailable" as const,
            reason: `variant ${variant.label} spans ${segments} segments per occurrence, above the ${GRAPH_STUDY_MAX_SEGMENTS}-segment acquisition budget; shorten the offset or horizon`,
          };
        }
      }

      const createdAtMs = input.now;
      const specEcho = {
        environmentId: input.environmentId,
        eventSetName: input.eventSetName,
        poolId: input.poolId,
        market: input.market,
        intervalMs: input.intervalMs,
        occurrences: input.occurrences,
        variants: input.variants,
        ...(input.nextOccurrence === undefined ? {} : { nextOccurrence: input.nextOccurrence }),
        ...(input.poolDataStartMs === undefined
          ? {}
          : { declaredPoolDataStartMs: input.poolDataStartMs }),
        now: input.now,
      };

      // -- Per variant: every occurrence attempted, every outcome kept. ------
      const variantOutcomes: Array<EventWindowVariantOutcome> = [];
      const datasetIds = new Set<string>();
      let earliestRetained: number | null = null;

      for (const variant of input.variants) {
        const rows: Array<EventWindowOccurrenceOutcome> = [];
        const completeReturnsList: Array<number> = [];
        const baselineMeans: Array<number> = [];

        for (const occurrence of input.occurrences) {
          const anchorAt =
            variant.anchor === "pre-start"
              ? occurrence.startAt - variant.leadMs
              : occurrence.endAt + variant.tailMs;
          const base = {
            label: occurrence.label,
            startAt: occurrence.startAt,
            endAt: occurrence.endAt,
            anchorAt,
            source: occurrence.source,
          };
          // Uncovered BY DECLARATION: the anchor predates the pool dataset's
          // declared coverage. The declared boundary is retained in the spec
          // and the actual earliest observation is recorded beside it.
          if (input.poolDataStartMs !== undefined && anchorAt < input.poolDataStartMs) {
            rows.push({
              ...base,
              covered: false,
              reason:
                `the ${variant.anchor} anchor ${new Date(anchorAt).toISOString()} predates the pool dataset's declared coverage ` +
                `(from ${new Date(input.poolDataStartMs).toISOString()}); there is no Graph price for this window`,
            });
            continue;
          }
          // A future anchor has nothing to measure yet; an anchor whose
          // holding window is still open would measure a partial horizon.
          if (anchorAt > input.now) {
            rows.push({
              ...base,
              covered: false,
              reason: "the anchor is in the future; there is nothing to measure yet",
            });
            continue;
          }

          // One retained dataset around this occurrence's anchor, through the
          // existing research seam. The shifted instant IS the event the
          // honest engine measures from.
          const anchored: TradingEventOccurrence = {
            startAt: anchorAt,
            endAt: anchorAt,
            timePrecision: "instant",
            ...(occurrence.label === undefined ? {} : { label: occurrence.label }),
            source: occurrence.source,
          };
          const load = yield* research.loadStudyDataset({
            environmentId: input.environmentId,
            poolId: input.poolId,
            market: input.market,
            entryBasis: variant.entryBasis,
            occurrences: [anchored],
            intervalMs: input.intervalMs,
            horizonBars: variant.horizonBars,
            now: input.now,
          });
          if (load.status === "unavailable") {
            rows.push({
              ...base,
              covered: false,
              reason: `dataset acquisition refused: ${load.reason}`,
            });
            continue;
          }
          const dataset: GraphStudyDataset = load.dataset;
          datasetIds.add(dataset.manifest.id);
          const firstCandle = dataset.candles[0];
          const firstObservation = dataset.observations[0];
          const candidateEarliest = Math.min(
            firstCandle === undefined ? Number.POSITIVE_INFINITY : firstCandle.openTime,
            firstObservation === undefined
              ? Number.POSITIVE_INFINITY
              : firstObservation.timestamp * 1000,
          );
          if (Number.isFinite(candidateEarliest)) {
            earliestRetained =
              earliestRetained === null
                ? candidateEarliest
                : Math.min(earliestRetained, candidateEarliest);
          }

          const report: EventStudyReport = runEventStudy({
            occurrences: [anchored],
            candles: [...dataset.candles],
            intervalMs: input.intervalMs,
            horizonBars: variant.horizonBars,
            entryBasis: variant.entryBasis,
            now: input.now,
          });
          const row = report.rows[0];
          if (row === undefined || !row.covered) {
            rows.push({
              ...base,
              covered: false,
              reason: row?.reason ?? "the retained dataset could not measure this occurrence",
            });
            continue;
          }
          if (!row.truncated && row.returnPct !== undefined) {
            completeReturnsList.push(row.returnPct);
          }
          if (report.baseline !== null) baselineMeans.push(report.baseline.meanReturnPct);
          // Exact onchain flow. The entry day is always inside the retained
          // read window; the full lead window is only summed when the dataset
          // actually covers through the event start — a partial-span sum
          // presented as the lead flow would invent coverage.
          const entryDayNetBaseRaw = netBaseAcquisitionRaw(
            dataset.observations,
            anchorAt,
            anchorAt + 86_400_000,
          );
          const leadCoveredThrough =
            variant.anchor === "post-end" || dataset.manifest.coverage.toMs >= occurrence.startAt;
          const entryLeadNetBaseRaw = leadCoveredThrough
            ? variant.anchor === "pre-start"
              ? netBaseAcquisitionRaw(dataset.observations, anchorAt, occurrence.startAt)
              : entryDayNetBaseRaw
            : undefined;
          rows.push({
            ...base,
            covered: true,
            datasetId: dataset.manifest.id,
            returnPct: row.returnPct,
            truncated: row.truncated,
            ...(row.truncated && row.barsCovered !== undefined
              ? { reason: `truncated after ${row.barsCovered} of ${variant.horizonBars} bars` }
              : {}),
            ...(report.baseline === null
              ? {}
              : { baselineMeanReturnPct: report.baseline.meanReturnPct }),
            entryDayNetBaseRaw,
            ...(entryLeadNetBaseRaw === undefined ? {} : { entryLeadNetBaseRaw }),
          });
        }

        const nComplete = completeReturnsList.length;
        variantOutcomes.push({
          label: variant.label,
          anchor: variant.anchor,
          leadMs: variant.leadMs,
          tailMs: variant.tailMs,
          horizonBars: variant.horizonBars,
          entryBasis: variant.entryBasis,
          occurrences: rows,
          aggregates: {
            nRequested: input.occurrences.length,
            nCovered: rows.filter((row) => row.covered).length,
            nComplete,
            meanReturnPct:
              nComplete === 0
                ? null
                : Math.round(
                    (completeReturnsList.reduce((sum, value) => sum + value, 0) / nComplete) * 100,
                  ) / 100,
            bestReturnPct: nComplete === 0 ? null : Math.max(...completeReturnsList),
            worstReturnPct: nComplete === 0 ? null : Math.min(...completeReturnsList),
            meanBaselineReturnPct:
              baselineMeans.length === 0
                ? null
                : Math.round(
                    (baselineMeans.reduce((sum, value) => sum + value, 0) / baselineMeans.length) *
                      100,
                  ) / 100,
          },
          disclosure:
            `holding ${variant.horizonBars} bars of ${input.intervalMs / 3_600_000}h from a ${variant.anchor} anchor ` +
            `(${variant.anchor === "pre-start" ? `${variant.leadMs / 86_400_000}d before start` : `${variant.tailMs / 86_400_000}d after end`}, ${variant.entryBasis}); ` +
            "aggregates over complete horizons only; baseline sampled at every bar of each occurrence's own retained dataset " +
            "(the 90-segment acquisition budget forbids one contiguous window across events years apart)",
        });
      }

      // -- Applies-now: every pre-start variant against the next occurrence. --
      const appliesNow: Array<EventWindowAppliesNow> = [];
      for (const variant of variantOutcomes) {
        if (input.nextOccurrence === undefined || variant.anchor !== "pre-start") {
          appliesNow.push({
            label: variant.label,
            entryWindowStartMs: null,
            entryWindowEndMs: null,
            withinWindow: null,
            note:
              input.nextOccurrence === undefined
                ? "no next occurrence was provided; applies-now is not assessed"
                : "a post-event anchor has no pre-event entry window to apply now",
          });
          continue;
        }
        const start = input.nextOccurrence.startAt - variant.leadMs;
        const end = input.nextOccurrence.startAt;
        appliesNow.push({
          label: variant.label,
          entryWindowStartMs: start,
          entryWindowEndMs: end,
          withinWindow: input.now >= start && input.now < end,
          note:
            `entry window [${new Date(start).toISOString()}, ${new Date(end).toISOString()}) for the next ` +
            `${input.eventSetName} (${input.nextOccurrence.source}); research-fixed, not retuned`,
        });
      }

      const coveredAnywhere = variantOutcomes.some(
        (variant) => variant.aggregates.nComplete > 0 || variant.aggregates.nCovered > 0,
      );
      const totalComplete = variantOutcomes.reduce(
        (sum, variant) => sum + variant.aggregates.nComplete,
        0,
      );
      const uncertainty =
        `Sample sizes are tiny and stated per variant: ${totalComplete} complete horizon(s) across ` +
        `${input.occurrences.length} requested ${input.eventSetName} occurrence(s) and ${variantOutcomes.length} compared variants. ` +
        (coveredAnywhere
          ? "These numbers describe what happened around those dates; they are not evidence the pattern repeats, and no variant here was selected to make today qualify."
          : "Nothing was measurable; the honest verdict is inconclusive, and no rule should be armed from this study.");

      const result: GraphEventWindowStudyResult = {
        studyId: "",
        createdAtMs,
        eventSetName: input.eventSetName,
        poolId: input.poolId,
        intervalMs: input.intervalMs,
        variants: variantOutcomes,
        appliesNow,
        earliestRetainedObservationMs: earliestRetained,
        declaredPoolDataStartMs: input.poolDataStartMs ?? null,
        uncertainty,
      };
      // Content-derived id over the spec AND the measured result: the same
      // design over the same retained datasets replays idempotently.
      const studyId = `ges_${sha256(forgeJsonEncode({ specEcho, result })).slice(0, 24)}`;
      const finalResult = { ...result, studyId };

      // -- Retention: one content-addressed row, idempotent. -----------------
      const specJson = forgeJsonEncode(specEcho);
      const resultJson = forgeJsonEncode(finalResult);
      const retained = yield* sql`
        INSERT INTO forge_graph_event_studies (
          study_id, environment_id, created_at_ms, spec_json, result_json
        ) VALUES (
          ${studyId}, ${input.environmentId}, ${createdAtMs}, ${specJson}, ${resultJson}
        )
        ON CONFLICT (study_id) DO NOTHING
      `.pipe(
        Effect.as(true),
        Effect.mapError(toPersistenceSqlError("GraphEventWindowStudyService.runStudy")),
        Effect.orElseSucceed(() => false),
      );
      if (!retained) {
        // Idempotent replay is fine; a DIFFERENT result under the same id
        // would mean the content hash collided — refuse loudly rather than
        // serve a study that is not what was retained.
        const existing = yield* sql<{ readonly result_json: string }>`
          SELECT result_json FROM forge_graph_event_studies WHERE study_id = ${studyId}
        `.pipe(
          Effect.mapError(toPersistenceSqlError("GraphEventWindowStudyService.runStudy")),
          Effect.orElseSucceed(() => [] as Array<{ readonly result_json: string }>),
        );
        if (existing[0]?.result_json !== resultJson) {
          return {
            status: "unavailable" as const,
            reason: `study id collision: ${studyId} is already retained with different content`,
          };
        }
      }
      return { status: "ok" as const, result: finalResult };
    });

  const readStudy: GraphEventWindowStudyServiceShape["readStudy"] = (studyId) =>
    sql<{ readonly spec_json: string; readonly result_json: string }>`
      SELECT spec_json, result_json FROM forge_graph_event_studies WHERE study_id = ${studyId}
    `.pipe(
      Effect.mapError(toPersistenceSqlError("GraphEventWindowStudyService.readStudy")),
      Effect.orElseSucceed(() => null),
      Effect.map((rows) =>
        rows === null || rows[0] === undefined
          ? null
          : { specJson: rows[0].spec_json, resultJson: rows[0].result_json },
      ),
    );

  return GraphEventWindowStudyService.of({ runStudy, readStudy });
});

export const GraphEventWindowStudyServiceLive = Layer.effect(
  GraphEventWindowStudyService,
  makeGraphEventWindowStudyService,
);
