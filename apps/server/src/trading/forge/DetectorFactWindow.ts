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
 * - `substreams:<sourceId>:<windowMs>` — one complete live window over a
 *   committed Substreams source (Worker A's durable sink), resolved through
 *   the frozen A→B reader port below. `windowMs` (decimal milliseconds,
 *   60_000..86_400_000) is the stream binding's own window selector: windows
 *   are UTC-grid aligned, ending at the last grid boundary at or before the
 *   evaluation clock. Only the LAST colon splits the id; the source id itself
 *   must not be empty.
 *
 * FACT BOUNDING (the load-bearing decision): one CapturedFact per observation
 * would make the window unbounded — a dataset can hold tens of thousands of
 * rows. Each resolving source instead contributes a FIXED, small set of
 * summary facts (at most six for a graph dataset, two for an external
 * document). Flow is exact quote-token raw units, scoped to the source pool;
 * it must never be interpreted as USD or combined across pools without
 * verified token metadata. No decimal scaling is guessed.
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
import * as Option from "effect/Option";
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

// -- Substreams live-window policy (the frozen binding rules) ------------------
//
// A live stream window is FINAL data with a FINITE freshness horizon — never
// NO_EXPIRY_MS. Mainnet finality (~2 epochs) is already satisfied by the
// store's final-block mode; this horizon bounds how long a sealed window may
// still ground an as-of decision after it closed, so stale windows expire
// instead of lingering forever.
export const SUBSTREAMS_WINDOW_MIN_MS = 60_000;
export const SUBSTREAMS_WINDOW_MAX_MS = 86_400_000;
export const SUBSTREAMS_WINDOW_VALIDITY_MS = 24 * 60 * 60 * 1000;
/**
 * Envelope lookback: mainnet slots are 12 s, so a window of `windowMs` holds
 * at most `windowMs / 10_000` blocks at a conservative 10 s floor, plus a
 * margin for the pre-window proof block. Bounded by the window cap (≤ 8 768).
 */
const substreamsLookbackBlocks = (windowMs: number): number => Math.ceil(windowMs / 10_000) + 128;

/** The decimal-string block numbers this module compares, as ordered BigInts. */
const blockNumberValue = (raw: string): bigint | null =>
  /^[0-9]+$/.test(raw) ? BigInt(raw) : null;

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

// ---------------------------------------------------------------------------
// The frozen A→B Substreams reader port (parallel-checkpoint.md; names on A's
// side may differ, shapes bind). Committed-only, ordered, final-block mode.
// Until Worker A's SubstreamsSourceStore lands, tests bind a local fake that
// implements exactly this shape — replaced at integration, never shipped.
// ---------------------------------------------------------------------------

/** Block envelopes in a committed range; zero eventCount proves an empty block. */
export interface SubstreamsCommittedBlocks {
  readonly blocks: ReadonlyArray<{
    readonly number: string; // decimal string, uint64 preserved
    readonly hash: string;
    readonly timestampMs: number;
    readonly eventCount: number;
  }>;
}

/** One committed pool event, signed raw decimal strings exactly as decoded. */
export interface SubstreamsPoolEvent {
  readonly blockNumber: string;
  readonly blockHash: string;
  readonly transactionHash: string;
  readonly logIndex: number;
  readonly pool: string;
  readonly amount0Raw: string;
  readonly amount1Raw: string;
  readonly sqrtPriceX96: string;
  readonly sender: string;
  readonly recipient: string;
}

export interface SubstreamsSourceHealthSnapshot {
  readonly state: "healthy" | "stale" | "unhealthy";
  readonly reason: string;
  /** Highest committed FINAL block. */
  readonly finalWatermarkBlock: string;
  readonly finalWatermarkTimestampMs: number;
  readonly lastCommitAtMs: number;
  readonly cursor: string | null;
  readonly packageSha256: string;
  readonly moduleDigest: string;
}

/** The A→B seam: committed chain data for one Substreams source. */
export interface SubstreamsSourceReaderShape {
  readonly committedWatermark: (
    environmentId: string,
    sourceId: string,
  ) => { readonly finalWatermarkBlock: string; readonly finalWatermarkTimestampMs: number } | null;
  readonly readBlockEnvelopes: (
    environmentId: string,
    sourceId: string,
    fromBlock: string,
    toBlock: string,
  ) => SubstreamsCommittedBlocks;
  readonly readPoolEvents: (
    environmentId: string,
    sourceId: string,
    fromBlock: string,
    toBlock: string,
  ) => ReadonlyArray<SubstreamsPoolEvent>;
  readonly sourceHealth: (
    environmentId: string,
    sourceId: string,
  ) => SubstreamsSourceHealthSnapshot;
  /** Package+module+params digest, or null when the source is unknown. */
  readonly sourceRevision: (environmentId: string, sourceId: string) => string | null;
}

export class SubstreamsSourceReader extends Context.Service<
  SubstreamsSourceReader,
  SubstreamsSourceReaderShape
>()("t3/trading/forge/DetectorFactWindow/SubstreamsSourceReader") {}

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
  // Ambiently optional (the ForgeReactor pattern): a wiring without Worker A's
  // store keeps both existing source kinds working, and every `substreams:`
  // id resolves as absence until the real reader is provided at integration.
  const substreamsOption = yield* Effect.serviceOption(SubstreamsSourceReader);
  const substreams = Option.isSome(substreamsOption) ? substreamsOption.value : null;

  /**
   * Resolve one graph dataset into its BOUNDED fact set (at most six facts:
   * observation count, last price in micros, net/gross raw quote flow, and the dataset's own window
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
        // Raw units preserve every retained digit. Net flow is positive for
        // base purchases (negative pool base delta), unlike gross turnover.
        let netFlowRaw = 0n;
        let grossFlowRaw = 0n;
        const baseIsToken1 = observations[0]?.baseIsToken1;
        for (const observation of observations) {
          if (
            observation.poolId !== record.poolId ||
            observation.baseIsToken1 !== baseIsToken1 ||
            observation.timestamp < record.windowStart ||
            observation.timestamp > record.windowEnd
          )
            return null;
          const base = BigInt(observation.baseIsToken1 ? observation.amount1 : observation.amount0);
          const quote = BigInt(
            observation.baseIsToken1 ? observation.amount0 : observation.amount1,
          );
          const magnitude = quote < 0n ? -quote : quote;
          if (magnitude !== BigInt(observation.quoteVolumeRaw)) return null;
          if (
            (base < 0n && quote < 0n) ||
            (base > 0n && quote > 0n) ||
            (base === 0n && quote !== 0n)
          )
            return null;
          grossFlowRaw += magnitude;
          netFlowRaw += base < 0n ? magnitude : base > 0n ? -magnitude : 0n;
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
            "graph.pool.net-flow-quote-raw",
            record.poolId,
            decimal(netFlowRaw.toString(), "quote-token-raw"),
            evidence,
          ),
          sealedFact(
            sourceId,
            "graph.pool.gross-flow-quote-raw",
            record.poolId,
            decimal(grossFlowRaw.toString(), "quote-token-raw"),
            evidence,
          ),
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
   * Resolve one `external:<sourceKind>:<documentIdentity>` source against its
   * revision chain head. A latest retraction makes the document absent (named
   * in `missingSourceIds`); a resolvable head contributes at most two facts —
   * publication happened, and when (undated documents carry no instant).
   *
   * The reference grammar carries a colon-bearing ambiguity on purpose: the
   * sourceKind ITSELF may contain colons (generated adapters retain revisions
   * under `generated:<sourceId>`), so the kind/identity boundary cannot be a
   * positional split. It resolves against the store instead: the leftmost
   * colon split whose exact (sourceKind, documentIdentity) pair has a
   * retained revision wins; a document that exists but ends in a retraction
   * resolves AS that document (absence), never falling through to a different
   * split; a reference no split resolves is absence, as before.
   */
  const externalSource = (
    environmentId: string,
    sourceId: string,
    rest: string,
  ): Effect.Effect<
    { readonly source: SealedSourceRecord; readonly facts: ReadonlyArray<CapturedFact> } | null,
    PersistenceSqlError
  > => {
    const splits: Array<{ readonly sourceKind: string; readonly documentIdentity: string }> = [];
    let colon = rest.indexOf(":");
    while (colon > 0) {
      splits.push({
        sourceKind: rest.slice(0, colon),
        documentIdentity: rest.slice(colon + 1),
      });
      colon = rest.indexOf(":", colon + 1);
    }
    return Effect.forEach(splits, (split) =>
      external
        .latestRevision({
          environmentId,
          sourceKind: split.sourceKind,
          documentIdentity: split.documentIdentity,
        })
        .pipe(
          Effect.mapError(sqlFail("buildWindow")),
          Effect.map((latest) => (latest === null ? null : { split, latest })),
        ),
    ).pipe(
      Effect.map((attempts) => {
        const resolved = attempts.find((attempt) => attempt !== null);
        if (resolved === undefined) return null;
        const { documentIdentity } = resolved.split;
        const latest = resolved.latest;
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
  };

  /**
   * Resolve one `substreams:<sourceId>:<windowMs>` source reference through
   * the frozen A→B reader port.
   *
   * Outcomes, per the frozen binding rules:
   * - COMPLETE window (facts + `complete: true`) — the source is healthy, the
   *   committed FINAL watermark timestamp is at or past the window end, and
   *   the committed block envelopes cover the window's block range with no
   *   gaps up to the watermark block. Evidence is `live`, availabilityBasis
   *   `recorded`, availableAtMs the store's recorded commit time (the exact
   *   closing-block commit when the watermark IS the proving block, otherwise
   *   a conservative later instant), and expiresAtMs FINITE (window close +
   *   the validity horizon — stream windows never carry NO_EXPIRY_MS).
   * - INCOMPLETE window (`complete: false`, NO facts) — stale/unhealthy
   *   source, watermark short of the window end, envelope gaps, an envelope
   *   lookback that cannot prove the window's start, or an event whose shape
   *   fails integrity. The sealed record carries no available instant and an
   *   `unknown` availability basis: a window that never provably closed has
   *   no availability to cite. The PROGRAM grounds unknown on it — an
   *   incomplete window can never ground a confident matched.
   * - ABSENCE (null → `missingSourceIds`) — the reader is unwired, the source
   *   id is malformed, or the store does not know the source (no revision).
   *
   * Every reader call is total here: a store that throws degrades to an
   * incomplete window with a named internal reason, never a crashed build.
   */
  const substreamsSource = (
    environmentId: string,
    fullSourceId: string,
    bareSourceId: string,
    windowMs: number,
    asOfMs: number,
  ): {
    readonly source: SealedSourceRecord;
    readonly facts: ReadonlyArray<CapturedFact>;
  } | null => {
    if (substreams === null) return null;
    // UTC-grid aligned window ending at the last boundary at or before the
    // evaluation clock: [start, end).
    const end = Math.floor(asOfMs / windowMs) * windowMs;
    const start = end - windowMs;

    const attempt = <T>(thunk: () => T): { ok: true; value: T } | { ok: false; reason: string } => {
      try {
        return { ok: true, value: thunk() };
      } catch (error) {
        return {
          ok: false,
          reason: `the substreams store read failed: ${String(error).slice(0, 120)}`,
        };
      }
    };
    const incomplete = (
      reason: string,
    ): { source: SealedSourceRecord; facts: ReadonlyArray<CapturedFact> } => {
      const revision = attempt(() => substreams.sourceRevision(environmentId, bareSourceId));
      const revisionTag = revision.ok && typeof revision.value === "string" ? revision.value : null;
      const refusalDigest = createHash("sha256")
        .update(forgeJsonEncode({ fullSourceId, start, end, reason, revisionTag }))
        .digest("hex");
      return {
        source: {
          sourceId: fullSourceId,
          evidenceId: `sev_${refusalDigest.slice(0, 24)}`,
          mode: "live",
          contentSha256: refusalDigest,
          complete: false,
          availabilityBasis: "unknown",
          ...(revisionTag === null ? {} : { sourceRevision: revisionTag }),
        },
        facts: [],
      };
    };

    const revisionRead = attempt(() => substreams.sourceRevision(environmentId, bareSourceId));
    if (!revisionRead.ok) return incomplete(revisionRead.reason);
    if (revisionRead.value === null) return null;
    const sourceRevision = revisionRead.value;

    const healthRead = attempt(() => substreams.sourceHealth(environmentId, bareSourceId));
    if (!healthRead.ok) return incomplete(healthRead.reason);
    const health = healthRead.value;
    if (health.state !== "healthy") {
      return incomplete(`the substreams source is ${health.state}: ${health.reason}`);
    }

    const watermarkRead = attempt(() => substreams.committedWatermark(environmentId, bareSourceId));
    if (!watermarkRead.ok) return incomplete(watermarkRead.reason);
    const watermark = watermarkRead.value;
    if (watermark === null) return incomplete("no committed final watermark exists yet");
    const watermarkBlockNumber = blockNumberValue(watermark.finalWatermarkBlock);
    if (watermarkBlockNumber === null) {
      return incomplete("the committed watermark block number is malformed");
    }
    if (watermark.finalWatermarkTimestampMs < end) {
      return incomplete(
        `the committed final watermark (block ${watermark.finalWatermarkBlock}, ts ${watermark.finalWatermarkTimestampMs}) has not reached the window end ${end}`,
      );
    }

    // Bounded envelope read ending at the watermark. The lookback is the
    // conservative block count of one window plus margin; it must reach at
    // least one block BEFORE the window start or start coverage is unprovable.
    const fromBlockNumber = watermarkBlockNumber - BigInt(substreamsLookbackBlocks(windowMs));
    const envelopesRead = attempt(() =>
      substreams.readBlockEnvelopes(
        environmentId,
        bareSourceId,
        (fromBlockNumber < 0n ? 0n : fromBlockNumber).toString(10),
        watermark.finalWatermarkBlock,
      ),
    );
    if (!envelopesRead.ok) return incomplete(envelopesRead.reason);
    // One validated envelope, its number widened to BigInt for exact compare.
    interface ValidatedEnvelope {
      readonly number: bigint;
      readonly hash: string;
      readonly timestampMs: number;
      readonly eventCount: number;
    }
    const fetched: Array<ValidatedEnvelope> = envelopesRead.value.blocks
      .map((block): ValidatedEnvelope | null => {
        const number = blockNumberValue(block.number);
        return number !== null && Number.isFinite(block.timestampMs) && block.timestampMs >= 0
          ? {
              number,
              hash: block.hash,
              timestampMs: block.timestampMs,
              eventCount: block.eventCount,
            }
          : null;
      })
      .flatMap((block) => (block === null ? [] : [block]))
      .sort((a, b) => (a.number < b.number ? -1 : a.number > b.number ? 1 : 0));
    if (fetched.length === 0) return incomplete("no committed block envelopes in the bounded read");
    const watermarkEnvelope = fetched[fetched.length - 1]!;
    if (watermarkEnvelope.number !== watermarkBlockNumber) {
      return incomplete("the watermark block itself is not committed in the envelope read");
    }
    const earliest = fetched[0]!;
    if (earliest.number === watermarkBlockNumber || earliest.timestampMs >= start) {
      return incomplete(
        "the bounded envelope lookback cannot prove the window's start is fully covered",
      );
    }

    const windowBlocks = fetched.filter(
      (block) => block.timestampMs >= start && block.timestampMs < end,
    );
    if (windowBlocks.length === 0) {
      return incomplete("no committed block envelope falls inside the window yet");
    }
    const committedNumbers = new Set(fetched.map((block) => block.number.toString(10)));
    for (let number = windowBlocks[0]!.number; number <= watermarkBlockNumber; number += 1n) {
      if (!committedNumbers.has(number.toString(10))) {
        return incomplete(
          `block ${number.toString(10)} is not committed inside the window's block range; the window has a gap`,
        );
      }
    }
    const startBlock = windowBlocks[0]!;
    const endBlock = windowBlocks[windowBlocks.length - 1]!;

    const eventsRead = attempt(() =>
      substreams.readPoolEvents(
        environmentId,
        bareSourceId,
        startBlock.number.toString(10),
        endBlock.number.toString(10),
      ),
    );
    if (!eventsRead.ok) return incomplete(eventsRead.reason);
    let netAmount0 = 0n;
    let netAmount1 = 0n;
    let grossAmount0 = 0n;
    let grossAmount1 = 0n;
    let eventCount = 0;
    let pool: string | null = null;
    let lastPrice: string | null = null;
    let lastOrder = { block: -1n, logIndex: -1 };
    for (const event of eventsRead.value) {
      const number = blockNumberValue(event.blockNumber);
      if (
        number === null ||
        number < startBlock.number ||
        number > endBlock.number ||
        !/^-?[0-9]+$/.test(event.amount0Raw) ||
        !/^-?[0-9]+$/.test(event.amount1Raw) ||
        !/^[0-9]+$/.test(event.sqrtPriceX96) ||
        !Number.isSafeInteger(event.logIndex) ||
        event.logIndex < 0 ||
        event.pool.trim() === ""
      ) {
        return incomplete("a committed event failed shape or range integrity");
      }
      // One stream source is one pool by its own specification; sums across
      // pools would be meaningless, so a second pool is an integrity failure.
      if (pool === null) pool = event.pool.toLowerCase();
      else if (pool !== event.pool.toLowerCase()) {
        return incomplete(
          "the stream source carries more than one pool; window facts would mix pools",
        );
      }
      const amount0 = BigInt(event.amount0Raw);
      const amount1 = BigInt(event.amount1Raw);
      netAmount0 += amount0;
      netAmount1 += amount1;
      grossAmount0 += amount0 < 0n ? -amount0 : amount0;
      grossAmount1 += amount1 < 0n ? -amount1 : amount1;
      eventCount += 1;
      const order = { block: number, logIndex: event.logIndex };
      if (
        order.block > lastOrder.block ||
        (order.block === lastOrder.block && order.logIndex > lastOrder.logIndex)
      ) {
        lastOrder = order;
        lastPrice = event.sqrtPriceX96;
      }
    }

    // Content-derived live evidence: the sealed window's blocks and events.
    const contentSha256 = createHash("sha256")
      .update(
        forgeJsonEncode({
          sourceId: bareSourceId,
          startMs: start,
          endMs: end,
          sourceRevision,
          blocks: windowBlocks.map((block) => [
            block.number.toString(10),
            block.hash,
            block.timestampMs,
            block.eventCount,
          ]),
          events: eventsRead.value.map((event) => [
            event.blockNumber,
            event.transactionHash,
            event.logIndex,
            event.amount0Raw,
            event.amount1Raw,
            event.sqrtPriceX96,
          ]),
        }),
      )
      .digest("hex");
    const evidenceId = `sev_${contentSha256.slice(0, 24)}`;
    // The window closed when its proving watermark committed; the store's
    // recorded last commit is exact when the watermark IS the proving block
    // and a conservative later instant when the stream has moved on.
    const availableAtMs = health.lastCommitAtMs;
    const expiresAtMs = end + SUBSTREAMS_WINDOW_VALIDITY_MS;
    const evidence: ReadonlyArray<EvidenceRef> = [
      {
        id: evidenceId,
        environmentId,
        sourceId: bareSourceId,
        mode: "live",
        contentSha256,
        eventAtMs: end,
        availableAtMs,
        availabilityBasis: "recorded",
        timePrecision: "second",
        capturedAtMs: availableAtMs,
        expiresAtMs,
        sourceRevision,
      },
    ];
    const entityId = bareSourceId;
    const candidates: Array<CapturedFact | null> = [
      sealedFact(
        fullSourceId,
        "stream.window.event-count",
        entityId,
        decimal(eventCount, "events"),
        evidence,
      ),
      sealedFact(
        fullSourceId,
        "stream.window.net-amount0-raw",
        entityId,
        decimal(netAmount0.toString(10), "token0-raw"),
        evidence,
      ),
      sealedFact(
        fullSourceId,
        "stream.window.net-amount1-raw",
        entityId,
        decimal(netAmount1.toString(10), "token1-raw"),
        evidence,
      ),
      sealedFact(
        fullSourceId,
        "stream.window.gross-amount0-raw",
        entityId,
        decimal(grossAmount0.toString(10), "token0-raw"),
        evidence,
      ),
      sealedFact(
        fullSourceId,
        "stream.window.gross-amount1-raw",
        entityId,
        decimal(grossAmount1.toString(10), "token1-raw"),
        evidence,
      ),
      ...(lastPrice === null
        ? []
        : [
            sealedFact(
              fullSourceId,
              "stream.window.last-sqrt-price-x96",
              entityId,
              decimal(lastPrice, "raw"),
              evidence,
            ),
          ]),
      sealedFact(fullSourceId, "stream.window.start-ms", entityId, decimal(start, "ms"), evidence),
      sealedFact(fullSourceId, "stream.window.end-ms", entityId, decimal(end, "ms"), evidence),
      sealedFact(
        fullSourceId,
        "stream.window.end-block",
        entityId,
        decimal(endBlock.number.toString(10), "block"),
        evidence,
      ),
    ];
    const facts = candidates.flatMap((fact) => (fact === null ? [] : [fact]));
    if (facts.length === 0)
      return incomplete("the complete window's facts failed their own contract");
    const source: SealedSourceRecord = {
      sourceId: fullSourceId,
      evidenceId,
      mode: "live",
      contentSha256,
      eventAtMs: end,
      availableAtMs,
      availabilityBasis: "recorded",
      expiresAtMs,
      complete: true,
      sourceRevision,
    };
    return { source, facts };
  };

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
        const substreamsPrefix = "substreams:";
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
          resolved =
            rest.includes(":") && !rest.startsWith(":") && !rest.endsWith(":")
              ? yield* externalSource(environmentId, sourceId, rest)
              : null;
        } else if (sourceId.startsWith(substreamsPrefix)) {
          // The LAST colon splits the stream binding's window selector, so the
          // source id itself may never contain one past this point.
          const rest = sourceId.slice(substreamsPrefix.length);
          const split = rest.lastIndexOf(":");
          const bareSourceId = split > 0 ? rest.slice(0, split) : "";
          const windowMsRaw = split > 0 ? rest.slice(split + 1) : "";
          const windowMs = /^[0-9]+$/.test(windowMsRaw) ? Number(windowMsRaw) : Number.NaN;
          resolved =
            bareSourceId === "" ||
            !Number.isSafeInteger(windowMs) ||
            windowMs < SUBSTREAMS_WINDOW_MIN_MS ||
            windowMs > SUBSTREAMS_WINDOW_MAX_MS
              ? null
              : substreamsSource(environmentId, sourceId, bareSourceId, windowMs, asOfMs);
        }
        // An id outside every convention is a required source that cannot
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
