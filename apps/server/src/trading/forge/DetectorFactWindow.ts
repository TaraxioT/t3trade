/**
 * DetectorFactWindow — the sealed fact-set builder for detector-program (v2)
 * evaluation jobs.
 *
 * A v2 capability's manifest declares `requiredSourceIds`: opaque strings that
 * name the RETAINED evidence the detector runs over. This service resolves
 * each id against the durable evidence stores and produces the bounded fact
 * set plus one `SealedSourceRecord` per source that actually resolved. It is
 * the v2 sibling of the v1 pool window (`ForgeSourceWindow`): same role —
 * everything the contained program is allowed to see, sealed by the host —
 * over general sources instead of one live pool window.
 *
 * Source id conventions (the manifest vocabulary this service resolves):
 *
 * - `graph-dataset:<ds_id>` — a retained Graph dataset row (the `ds_` ids
 *   `GraphResearchService` mints) read back by evidence id through
 *   `ForgeSourceStore.readObservations`. The dataset's own recorded span is
 *   the detector's window; the study-window coverage rule of research reuse
 *   deliberately does NOT apply here.
 * - `external:<sourceKind>:<documentIdentity>` — the latest non-retracted
 *   revision chain head for one external document, through
 *   `ExternalSourceStore.latestRevision`. `documentIdentity` may itself
 *   contain colons; only the FIRST colon after `external:` splits the kind.
 *
 * FACT BOUNDING (the load-bearing decision): one CapturedFact per observation
 * would make the window unbounded — a dataset can hold tens of thousands of
 * rows. Each resolving source instead contributes a FIXED, small set of
 * summary facts (at most four for a graph dataset, two for an external
 * document), every value exact (decimal strings from decimals-free fields).
 * Flow-denominated facts need the pool's quote decimals, which the retained
 * observation rows do not carry; deriving them half-way would be dishonest,
 * so they arrive with the P4S/P7 scenario work where the provider gains the
 * vetted pool config. Nothing here guesses a decimal scaling.
 *
 * Absence discipline (the v2 SDK rule): a required source that cannot be
 * resolved — not retained, environment mismatch, retracted latest, or an
 * integrity shortfall — is simply ABSENT from `sources` and named in
 * `missingSourceIds` (information for logs and jobs; NOT part of the frozen
 * program input schema). The generated program knows its own manifest's
 * required ids and emits `DetectionResult` unknown on absence — unqualified
 * or incomplete is unknown, never silent absence. Only when EVERY required
 * source is missing does the window refuse (`unavailable`), naming them.
 *
 * Named-state shaped throughout; decoding failures surface as absence, never
 * throws. SQL only — no network, no signer, nothing that could reach an order.
 *
 * @module DetectorFactWindow
 */
// @effect-diagnostics nodeBuiltinImport:off - the digest and fact-id computations are node:crypto; hashing is this service's implementation, not an Effect abstraction.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { Schema } from "effect";
import * as Layer from "effect/Layer";
import { createHash } from "node:crypto";

import {
  CapturedFact,
  DETECTOR_FACTS_MAX_COUNT,
  type EvidenceRef,
  type ExternalSourceManifest,
  type FactValue,
  SealedSourceRecord,
} from "@t3tools/trading-contracts";

import { toPersistenceSqlError, PersistenceSqlError } from "../../persistence/Errors.ts";
import { forgeJsonEncode } from "./ForgeJsonEncode.ts";
import { ForgeSourceStore } from "./ForgeSourceStore.ts";
import { ExternalSourceStore } from "../research/ExternalSourceStore.ts";

/** The most required sources one sealed window may resolve. */
export const DETECTOR_WINDOW_MAX_SOURCE_IDS = 16;

/**
 * Historical-replay evidence pinned to a block and live external documents
 * have no reorg/expiry horizon this slice can compute honestly; corrections
 * and retractions arrive as NEW revisions, which changes the resolved head
 * rather than expiring the old bytes. The far-future constant keeps the
 * required `EvidenceRef.expiresAtMs` honest ("final until superseded")
 * without inventing a horizon.
 */
const NO_EXPIRY_MS = Number.MAX_SAFE_INTEGER;

/** Graph subgraph timestamps are whole seconds — the precision they can claim. */
const GRAPH_TIME_PRECISION = "second" as const;

/** The honest manifest precision per document precision (the store's mapping). */
const externalTimePrecision = (
  precision: "instant" | "window" | "date",
): ExternalSourceManifest["timePrecision"] => (precision === "date" ? "day" : "second");

export type DetectorWindowOutcome =
  | {
      readonly status: "ok";
      readonly facts: ReadonlyArray<CapturedFact>;
      readonly sources: ReadonlyArray<SealedSourceRecord>;
      /** Required ids that did not resolve — information only, never program input. */
      readonly missingSourceIds: ReadonlyArray<string>;
    }
  | { readonly status: "unavailable"; readonly reason: string };

export interface DetectorFactWindowShape {
  /**
   * Resolve the manifest's required source ids into the sealed fact window.
   * `ok` carries only the sources that resolved; `unavailable` only when the
   * request is over cap or every required source is missing (total refusal,
   * named). Store errors stay in the typed error channel for the caller.
   */
  readonly buildWindow: (input: {
    readonly environmentId: string;
    readonly requiredSourceIds: ReadonlyArray<string>;
    readonly asOfMs: number;
  }) => Effect.Effect<DetectorWindowOutcome, PersistenceSqlError>;
}

export class DetectorFactWindow extends Context.Service<
  DetectorFactWindow,
  DetectorFactWindowShape
>()("t3/trading/forge/DetectorFactWindow") {}

const sqlFail = (operation: string) => toPersistenceSqlError(`DetectorFactWindow.${operation}`);

/** Content-derived fact id: the same sealed fact always mints the same id. */
const factId = (sourceId: string, key: string, entityId: string, value: FactValue): string =>
  `dfact_${createHash("sha256")
    .update(forgeJsonEncode([sourceId, key, entityId, value]))
    .digest("hex")
    .slice(0, 24)}`;

/** One evidence reference every fact from `sourceId` carries. */
const graphEvidenceRef = (input: {
  readonly environmentId: string;
  readonly sourceId: string;
  readonly evidenceId: string;
  readonly digest: string;
  readonly windowStartMs: number;
  readonly capturedAtMs: number;
  readonly blockNumber: number;
}): EvidenceRef => ({
  id: input.evidenceId,
  environmentId: input.environmentId,
  sourceId: input.sourceId,
  mode: "historical-replay",
  contentSha256: input.digest,
  // A dataset's events span its window; the earliest event time is the only
  // single instant an EvidenceRef can honestly claim.
  eventAtMs: input.windowStartMs,
  availableAtMs: input.capturedAtMs,
  availabilityBasis: "recorded",
  timePrecision: GRAPH_TIME_PRECISION,
  capturedAtMs: input.capturedAtMs,
  expiresAtMs: NO_EXPIRY_MS,
  sourceRevision: String(input.blockNumber),
});

const externalEvidenceRef = (input: {
  readonly environmentId: string;
  readonly sourceId: string;
  readonly revision: {
    readonly revisionId: string;
    readonly contentSha256: string;
    readonly publishedAtMs: number | null;
    readonly timePrecision: "instant" | "window" | "date";
    readonly firstObservedAtMs: number;
  };
}): EvidenceRef => ({
  id: input.revision.revisionId,
  environmentId: input.environmentId,
  sourceId: input.sourceId,
  mode: "live",
  contentSha256: input.revision.contentSha256,
  // An undated document's only honest event time is when it was first
  // observable; SealedSourceRecord.eventAtMs stays omitted for those.
  eventAtMs: input.revision.publishedAtMs ?? input.revision.firstObservedAtMs,
  availableAtMs: input.revision.firstObservedAtMs,
  availabilityBasis: "recorded",
  timePrecision: externalTimePrecision(input.revision.timePrecision),
  capturedAtMs: input.revision.firstObservedAtMs,
  expiresAtMs: NO_EXPIRY_MS,
  sourceRevision: input.revision.revisionId,
});

/** A validated fact, or null when the assembled shape fails its own contract
 * (for example a stored digest that is not 64-hex) — absence, never a throw. */
const sealedFact = (
  sourceId: string,
  key: string,
  entityId: string,
  value: FactValue,
  evidence: ReadonlyArray<EvidenceRef>,
): CapturedFact | null => {
  const fact: CapturedFact = {
    id: factId(sourceId, key, entityId, value),
    key,
    entityId,
    value,
    evidence: [...evidence],
  };
  return Schema.is(CapturedFact)(fact) ? fact : null;
};

const decimal = (value: string | number, unit: string): FactValue => ({
  kind: "decimal",
  value: String(value),
  unit,
});

/**
 * Resolve one `graph-dataset:<ds_id>` source. Integrity is the
 * `GraphResearchService.tryReuse` discipline minus the study-window coverage
 * rule (a detector's window is the dataset's own recorded span): environment
 * match, claimed row count, and the content digest over the retained bytes.
 * Any shortfall is absence. (The concrete resolver lives inside the maker
 * below, where both stores are in scope; the module-level helpers above stay
 * pure and store-free.)
 */

export const makeDetectorFactWindow = Effect.gen(function* () {
  const graph = yield* ForgeSourceStore;
  const external = yield* ExternalSourceStore;

  /**
   * Resolve one graph dataset into its BOUNDED fact set (at most four facts:
   * observation count, last price in micros, and the dataset's own window
   * span — the record's recorded bounds, present even for an empty dataset).
   */
  const graphSource = (
    environmentId: string,
    sourceId: string,
    datasetId: string,
  ): Effect.Effect<
    { readonly source: SealedSourceRecord; readonly facts: ReadonlyArray<CapturedFact> } | null,
    PersistenceSqlError
  > =>
    graph.readObservations(datasetId).pipe(
      Effect.mapError(sqlFail("buildWindow")),
      Effect.map((retained) => {
        if (retained === null) return null;
        const { record, observations, claimedCount } = retained;
        if (record.environmentId !== environmentId) return null;
        // Integrity: the row must hold exactly what it claims, and the
        // retained bytes must hash to the row's digest (the same formula
        // GraphResearchService mints ids under).
        if (claimedCount !== observations.length) return null;
        if (
          createHash("sha256").update(forgeJsonEncode(observations)).digest("hex") !== record.digest
        ) {
          return null;
        }
        const evidence: ReadonlyArray<EvidenceRef> = [
          graphEvidenceRef({
            environmentId,
            sourceId,
            evidenceId: record.evidenceId,
            digest: record.digest,
            windowStartMs: record.windowStart * 1000,
            capturedAtMs: record.fetchedAtMs,
            blockNumber: record.pinnedBlock,
          }),
        ];
        // Bounded summary facts; the last price exists only when a trade did.
        const ordered = [...observations].sort(
          (a, b) => a.timestamp - b.timestamp || a.logIndex - b.logIndex,
        );
        const last = ordered[ordered.length - 1];
        const candidates: Array<CapturedFact | null> = [
          sealedFact(
            sourceId,
            "graph.pool.observation-count",
            record.poolId,
            decimal(observations.length, "observations"),
            evidence,
          ),
          ...(last === undefined
            ? []
            : [
                sealedFact(
                  sourceId,
                  "graph.pool.last-price-micros",
                  record.poolId,
                  decimal(last.priceQuotePerBaseMicros, "micros"),
                  evidence,
                ),
              ]),
          sealedFact(
            sourceId,
            "graph.pool.trade-window-start-ms",
            record.poolId,
            decimal(record.windowStart * 1000, "ms"),
            evidence,
          ),
          sealedFact(
            sourceId,
            "graph.pool.trade-window-end-ms",
            record.poolId,
            decimal(record.windowEnd * 1000, "ms"),
            evidence,
          ),
        ];
        const facts = candidates.flatMap((fact) => (fact === null ? [] : [fact]));
        // A source whose facts cannot even be assembled honestly (schema
        // shortfall in the derived records) is absent, not partial.
        if (facts.length === 0) return null;
        const source: SealedSourceRecord = {
          sourceId,
          evidenceId: record.evidenceId,
          mode: "historical-replay",
          contentSha256: record.digest,
          // The dataset's events span its window; no single event instant to
          // claim, so the event-time field stays omitted on purpose.
          complete: true,
          availableAtMs: record.fetchedAtMs,
          availabilityBasis: "recorded",
          sourceRevision: String(record.pinnedBlock),
        };
        return { source, facts };
      }),
    );

  /**
   * Resolve one `external:<kind>:<identity>` source against its revision
   * chain head. A latest retraction makes the document absent (named in
   * `missingSourceIds`); a resolvable head contributes at most two facts —
   * publication happened, and when (undated documents carry no instant).
   */
  const externalSource = (
    environmentId: string,
    sourceId: string,
    sourceKind: string,
    documentIdentity: string,
  ): Effect.Effect<
    { readonly source: SealedSourceRecord; readonly facts: ReadonlyArray<CapturedFact> } | null,
    PersistenceSqlError
  > =>
    external.latestRevision({ environmentId, sourceKind, documentIdentity }).pipe(
      Effect.mapError(sqlFail("buildWindow")),
      Effect.map((latest) => {
        if (latest === null) return null;
        // The chain currently ends in a retraction: the document's current
        // state IS retracted, which is absence for a detector.
        if (latest.retraction !== null) return null;
        const revision = latest.revision;
        if (revision.retracted) return null;
        const evidence: ReadonlyArray<EvidenceRef> = [
          externalEvidenceRef({
            environmentId,
            sourceId,
            revision,
          }),
        ];
        // Free text never crosses as fact values beyond ids (the P3
        // discipline): only the publication boolean and its instant.
        const facts = [
          sealedFact(
            sourceId,
            "external.document.published",
            documentIdentity,
            { kind: "boolean", value: true },
            evidence,
          ),
          ...(revision.publishedAtMs === null
            ? []
            : [
                sealedFact(
                  sourceId,
                  "external.document.publication-ms",
                  documentIdentity,
                  decimal(revision.publishedAtMs, "ms"),
                  evidence,
                ),
              ]),
        ].flatMap((fact) => (fact === null ? [] : [fact]));
        if (facts.length === 0) return null;
        const source: SealedSourceRecord = {
          sourceId,
          evidenceId: revision.revisionId,
          mode: "live",
          contentSha256: revision.contentSha256,
          ...(revision.publishedAtMs === undefined || revision.publishedAtMs === null
            ? {}
            : { eventAtMs: revision.publishedAtMs }),
          availableAtMs: revision.firstObservedAtMs,
          availabilityBasis: "recorded",
          // Published, or intentionally undated (eventAtMs omitted above):
          // both are complete live documents, never partial ones.
          complete: true,
          sourceRevision: revision.revisionId,
        };
        return { source, facts };
      }),
    );

  const buildWindow: DetectorFactWindowShape["buildWindow"] = ({
    environmentId,
    requiredSourceIds,
    asOfMs,
  }) =>
    Effect.gen(function* () {
      // Deduped, order-preserving: the manifest's own order is the window's
      // order, and a repeated id resolves once.
      const ids: Array<string> = [];
      for (const id of requiredSourceIds) {
        if (!ids.includes(id)) ids.push(id);
      }
      if (ids.length > DETECTOR_WINDOW_MAX_SOURCE_IDS) {
        return {
          status: "unavailable" as const,
          reason: `the manifest requires ${ids.length} sources, over the ${DETECTOR_WINDOW_MAX_SOURCE_IDS}-source window cap`,
        };
      }
      if (!Number.isFinite(asOfMs) || asOfMs < 0) {
        return { status: "unavailable" as const, reason: "invalid window clock" };
      }

      const sources: Array<SealedSourceRecord> = [];
      const facts: Array<CapturedFact> = [];
      const missing: Array<string> = [];
      for (const sourceId of ids) {
        const datasetPrefix = "graph-dataset:";
        const externalPrefix = "external:";
        let resolved: {
          readonly source: SealedSourceRecord;
          readonly facts: ReadonlyArray<CapturedFact>;
        } | null = null;
        if (sourceId.startsWith(datasetPrefix)) {
          const datasetId = sourceId.slice(datasetPrefix.length);
          resolved =
            datasetId === "" ? null : yield* graphSource(environmentId, sourceId, datasetId);
        } else if (sourceId.startsWith(externalPrefix)) {
          const rest = sourceId.slice(externalPrefix.length);
          const split = rest.indexOf(":");
          const sourceKind = split > 0 ? rest.slice(0, split) : "";
          const documentIdentity = split > 0 ? rest.slice(split + 1) : "";
          resolved =
            sourceKind === "" || documentIdentity === ""
              ? null
              : yield* externalSource(environmentId, sourceId, sourceKind, documentIdentity);
        }
        // An id outside both conventions is a required source that cannot
        // resolve: absent and named, the same as an unretained dataset.
        if (resolved === null) {
          missing.push(sourceId);
          continue;
        }
        sources.push(resolved.source);
        facts.push(...resolved.facts);
      }

      if (facts.length > DETECTOR_FACTS_MAX_COUNT) {
        return {
          status: "unavailable" as const,
          reason: `the sealed window holds ${facts.length} facts, over the ${DETECTOR_FACTS_MAX_COUNT}-fact cap`,
        };
      }
      if (sources.length === 0) {
        return {
          status: "unavailable" as const,
          reason:
            missing.length === 0
              ? "the manifest declares no required sources; a detector window needs at least one"
              : `no required source resolved: ${missing.join(", ")}`,
        };
      }
      return {
        status: "ok" as const,
        facts,
        sources,
        missingSourceIds: missing,
      };
    });

  return DetectorFactWindow.of({ buildWindow });
});

export const DetectorFactWindowLive = Layer.effect(DetectorFactWindow, makeDetectorFactWindow);
