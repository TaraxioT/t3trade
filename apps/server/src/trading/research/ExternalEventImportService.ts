/**
 * ExternalEventImportService — explicit event-set integration over retained
 * external revisions.
 *
 * One `import_external` tool call is ONE bounded capture attempt followed by
 * a deterministic projection of what the store already retains: no loop, no
 * schedule, no background collection. The projection goes through
 * `TradingEventService.record` exactly as an agent-authored set does (author
 * `agent`, whole-list replacement on re-import), so the authored calendar's
 * lifecycle, constraints and read-back semantics are never bypassed or
 * weakened — this service CALLS that lifecycle, it never writes its tables.
 *
 * Honesty rules this module is load-bearing for:
 *
 * - Publication times are NOT availability times. Every ok result carries the
 *   first-observed window of the imported documents, because a study over
 *   imported releases is a research snapshot of what this server had retained,
 *   never a live feed.
 * - A document whose payload cannot be read, or that states no publication
 *   time, is skipped and counted, never guessed or padded.
 * - A capture failure with retained revisions present is an IMPORT with the
 *   staleness named, not a refusal; a capture failure with nothing retained
 *   is a refusal, because then there is nothing honest to import.
 * - Persistence failures (the capture's store write, the record, the lineage
 *   row) stay in the error channel; source availability is a value, never a
 *   thrown error.
 *
 * SQL, the external-source connector and the event service — nothing here can
 * reach a signer, Hyperliquid, or an order.
 *
 * @module ExternalEventImportService
 */
import { Context, DateTime, Effect, Layer, Option, Schema } from "effect";
import * as NodeCrypto from "node:crypto";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  serializeEventSetContent,
  type TradingEventOccurrence,
  type TradingEventSet,
} from "@t3tools/trading-contracts/eventSets";

import { toPersistenceSqlError, type PersistenceSqlError } from "../../persistence/Errors.ts";
import { TradingEventService } from "../TradingEventService.ts";
import { contentDigestHex } from "../TradingHypothesisService.ts";
import { ExternalSourceConnector } from "./ExternalSourceConnector.ts";
import { ExternalSourceStore } from "./ExternalSourceStore.ts";
import { GeneratedExternalSourceService } from "./GeneratedExternalSourceService.ts";

/** Only the GitHub releases family has a projection today. */
const IMPORTABLE_SOURCE_KIND = "github-releases";

/** Generated adapters project through the same path with their own extraction. */
const GENERATED_SOURCE_KIND_PREFIX = "generated:";

/** The document cap one import walks; matches the store's listing cap. */
const MAX_IMPORTED_DOCUMENTS = 100;

export interface ExternalEventImportInput {
  readonly environmentId: string;
  /** The event set to create or amend (whole-list replacement, per `record`). */
  readonly eventSetName: string;
  /** The import instant, supplied by the caller so tests are deterministic. */
  readonly now: number;
  /** The thread scoping the tool call; passed to `record` unchanged. */
  readonly threadId: string;
  /**
   * Which retained source family to import: the GitHub connector (default),
   * or a generated adapter by its `generated:<sourceId>` kind. The capture
   * step follows the kind — one bounded capture either way.
   */
  readonly sourceKind?: string | undefined;
  /**
   * Refuse when the pre-import capture fails instead of importing over the
   * retained revisions. Absent means the honest default: import what is
   * retained and name the capture failure.
   */
  readonly requireCapture?: boolean | undefined;
}

/** How the one capture attempt this import made answered. */
export type ImportCaptureOutcome =
  | { readonly status: "ok" }
  | { readonly status: "unavailable"; readonly reason: string };

export type ExternalEventImportResult =
  | {
      readonly outcome: "ok";
      readonly eventSet: TradingEventSet;
      /** Retained revisions skipped: payload unreadable or extraction fields missing. */
      readonly skippedUnreadable: number;
      /** Retained revisions skipped: the document states no publication time. */
      readonly skippedUnpublished: number;
      /** Documents the capture attempted reported changed content. */
      readonly correctionsObserved: number;
      readonly capture: ImportCaptureOutcome;
      /** First-observed window of the PROJECTED documents (availability, not publication). */
      readonly firstObservedFromMs: number;
      readonly firstObservedToMs: number;
      readonly importId: string;
      /** sha256 over serializeEventSetContent of the set `record` read back. */
      readonly contentSha256: string;
      /** The availability honesty line, composed where the numbers are. */
      readonly availabilityNote: string;
    }
  | { readonly outcome: "refused"; readonly reason: string };

export interface ExternalEventImportServiceShape {
  readonly importExternalSource: (
    input: ExternalEventImportInput,
  ) => Effect.Effect<ExternalEventImportResult, PersistenceSqlError>;
}

export class ExternalEventImportService extends Context.Service<
  ExternalEventImportService,
  ExternalEventImportServiceShape
>()("t3/trading/research/ExternalEventImportService") {}

const sqlFail = (operation: string) =>
  toPersistenceSqlError(`ExternalEventImportService.${operation}`);

const sha256Hex = (value: string): string =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");

// encodeSync stays inside this module-level (non-generator) helper.
const encodeJsonText = (value: unknown): string =>
  Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(value);

/**
 * The deterministic extraction: the fields a github-release revision's own
 * retained bytes contribute to an occurrence. `tag_name` is the structured id
 * (the occurrence label; absent when the release carried no tag), and
 * `html_url` is the one source URL an occurrence may carry. Everything else
 * in the payload — including all free text — stays in the retained bytes.
 * Null means the document does not extract: skipped, never guessed.
 */
interface ExtractedRelease {
  readonly tagName: string | null;
  readonly htmlUrl: string;
}

const extractRelease = (document: unknown): ExtractedRelease | null => {
  if (typeof document !== "object" || document === null || Array.isArray(document)) return null;
  const record = document as Record<string, unknown>;
  const tagName = record["tag_name"];
  const htmlUrl = record["html_url"];
  if (
    (typeof tagName !== "string" && tagName !== null) ||
    typeof htmlUrl !== "string" ||
    htmlUrl === ""
  ) {
    return null;
  }
  return { tagName, htmlUrl };
};

/**
 * The generated-adapter occurrence projection. A generated revision's payload
 * carries `{ kind: "generated-adapter-record", record }`; the record's own
 * declared fields are the whole vocabulary. Convention, pinned here: `start`
 * anchors the occurrence (ISO date or instant — an event's own date, NOT its
 * publication time), optional `end` closes a window, `url` is the one source
 * URL, and the adapter's identity field labels it. Null = skipped, never
 * guessed.
 */
interface ExtractedGeneratedEvent {
  readonly startAt: number;
  readonly endAt: number;
  readonly timePrecision: "instant" | "window" | "date";
  readonly label: string | null;
  readonly sourceUrl: string;
}

const parseIsoDateOrInstant = (
  value: unknown,
): { readonly ms: number; readonly precision: "instant" | "date" } | null => {
  if (typeof value !== "string") return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const ms = Date.parse(`${value}T00:00:00Z`);
    return Number.isNaN(ms) ? null : { ms, precision: "date" };
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$/.test(value)) {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : { ms, precision: "instant" };
  }
  return null;
};

const extractGeneratedEvent = (document: unknown): ExtractedGeneratedEvent | null => {
  if (typeof document !== "object" || document === null || Array.isArray(document)) return null;
  const outer = document as Record<string, unknown>;
  const record = outer["record"];
  if (typeof record !== "object" || record === null || Array.isArray(record)) return null;
  const fields = record as Record<string, unknown>;
  const start = parseIsoDateOrInstant(fields["start"]);
  if (start === null) return null;
  let end = start;
  let windowed = false;
  if (fields["end"] !== undefined && fields["end"] !== null) {
    const parsedEnd = parseIsoDateOrInstant(fields["end"]);
    if (parsedEnd === null || parsedEnd.ms < start.ms) return null;
    end = parsedEnd;
    windowed = true;
  }
  const label = fields["name"] ?? fields["id"];
  const url = fields["url"];
  return {
    startAt: start.ms,
    endAt: end.ms,
    timePrecision: windowed ? "window" : start.precision,
    label: typeof label === "string" && label !== "" ? label : null,
    sourceUrl: typeof url === "string" && url !== "" ? url : "",
  };
};

/** Publication honesty, composed where the first-observed numbers live. */
const renderAvailabilityNote = (fromMs: number, toMs: number): string =>
  `publication times are the source's claims, not availability times — this server first observed these documents between ${DateTime.formatIso(DateTime.makeUnsafe(fromMs))} and ${DateTime.formatIso(DateTime.makeUnsafe(toMs))}; import is a research snapshot, not a live feed`;

export const makeExternalEventImportService = Effect.gen(function* () {
  const connector = yield* ExternalSourceConnector;
  const store = yield* ExternalSourceStore;
  const events = yield* TradingEventService;
  const generated = yield* Effect.serviceOption(GeneratedExternalSourceService);
  const sql = yield* SqlClient.SqlClient;

  const importExternalSource: ExternalEventImportServiceShape["importExternalSource"] = ({
    environmentId,
    eventSetName,
    now,
    threadId,
    sourceKind,
    requireCapture,
  }) =>
    Effect.gen(function* () {
      const name = eventSetName.trim();
      if (name.length === 0) {
        return { outcome: "refused", reason: "name cannot be empty" } as const;
      }
      const kind =
        sourceKind === undefined || sourceKind.trim() === ""
          ? IMPORTABLE_SOURCE_KIND
          : sourceKind.trim();
      const isGenerated = kind.startsWith(GENERATED_SOURCE_KIND_PREFIX);
      if (kind !== IMPORTABLE_SOURCE_KIND && !isGenerated) {
        return {
          outcome: "refused",
          reason: `no projection exists for source kind ${kind}`,
        } as const;
      }
      const generatedService = Option.isSome(generated) ? generated.value : null;
      if (isGenerated && generatedService === null) {
        return {
          outcome: "refused",
          reason: "the generated external-source service is not wired into this runtime",
        } as const;
      }

      // Exactly ONE bounded capture per explicit tool call. No loop, no
      // schedule; a source-side failure is a named value the result records.
      // The capture follows the kind: the GitHub connector, or the generated
      // adapter's host fetch + sandbox parse.
      const toCaptureOutcome = Effect.map(
        (
          result:
            | { status: "ok"; documents: ReadonlyArray<{ readonly changed: boolean }> }
            | { status: "unavailable"; reason: string },
        ) =>
          result.status === "ok"
            ? {
                status: "ok" as const,
                changedCount: result.documents.filter((document) => document.changed).length,
              }
            : { status: "unavailable" as const, reason: result.reason },
      );
      const captureEffect =
        isGenerated && generatedService !== null
          ? generatedService
              .captureLatest({
                environmentId,
                sourceId: kind.slice(GENERATED_SOURCE_KIND_PREFIX.length),
                now,
              })
              .pipe(toCaptureOutcome, Effect.orDie)
          : connector.captureLatest({ environmentId, now }).pipe(toCaptureOutcome, Effect.orDie);
      const capture:
        | { status: "ok"; changedCount: number }
        | { status: "unavailable"; reason: string } = yield* captureEffect;
      if (capture.status === "unavailable" && requireCapture === true) {
        return {
          outcome: "refused",
          reason: `the capture before this import failed: ${capture.reason}`,
        } as const;
      }

      const documents = yield* store.listDocuments({
        environmentId,
        sourceKind: kind,
        limit: MAX_IMPORTED_DOCUMENTS,
      });
      if (documents.length === 0) {
        return {
          outcome: "refused",
          reason:
            capture.status === "unavailable"
              ? `no external revisions retained and the capture failed: ${capture.reason}`
              : "no external revisions retained: the capture succeeded but retained no documents",
        } as const;
      }

      // Projection: newest retained revision per document, in listing order.
      // The lineage's revision ids follow this same order.
      const occurrences: Array<TradingEventOccurrence> = [];
      const revisionIds: Array<string> = [];
      const firstObserved: Array<number> = [];
      let skippedUnreadable = 0;
      let skippedUnpublished = 0;
      for (const { revision } of documents) {
        const read = yield* store.readDocument({ revisionId: revision.revisionId });
        if (read === null) {
          skippedUnreadable += 1;
          continue;
        }
        if (isGenerated) {
          // A generated record anchors on the EVENT's own date, never on a
          // publication claim; the occurrence's time precision follows what
          // the record's own fields can support.
          const extracted = extractGeneratedEvent(read.document);
          if (extracted === null) {
            skippedUnreadable += 1;
            continue;
          }
          occurrences.push({
            startAt: extracted.startAt,
            endAt: extracted.endAt,
            timePrecision: extracted.timePrecision,
            ...(extracted.label === null ? {} : { label: extracted.label }),
            source: extracted.sourceUrl !== "" ? extracted.sourceUrl : revision.sourceUrl,
          });
          revisionIds.push(revision.revisionId);
          firstObserved.push(revision.firstObservedAtMs);
          continue;
        }
        // A document without a publication time cannot anchor a study window;
        // skip it before even reading its bytes.
        if (revision.publishedAtMs === null) {
          skippedUnpublished += 1;
          continue;
        }
        const extracted = extractRelease(read.document);
        if (extracted === null) {
          skippedUnreadable += 1;
          continue;
        }
        // The row's time-precision vocabulary is already the event-set's; a
        // github release publishes an instant, so start = end at that ms.
        occurrences.push({
          startAt: revision.publishedAtMs,
          endAt: revision.publishedAtMs,
          timePrecision: revision.timePrecision,
          ...(extracted.tagName === null ? {} : { label: extracted.tagName }),
          source: extracted.htmlUrl,
        });
        revisionIds.push(revision.revisionId);
        firstObserved.push(revision.firstObservedAtMs);
      }

      if (occurrences.length === 0) {
        return {
          outcome: "refused",
          reason:
            `every retained revision was skipped (${skippedUnpublished} with no publication time, ` +
            `${skippedUnreadable} unextractable); an import needs at least one document that ` +
            "can anchor a study window — an occurrence without one cannot anchor a study window",
        } as const;
      }

      const captureOutcome: ImportCaptureOutcome =
        capture.status === "ok"
          ? { status: "ok" }
          : { status: "unavailable", reason: capture.reason };

      // The authored path, untouched: the same record call, the same author,
      // the same whole-list replacement an agent's correction takes. A
      // duplicate start time across records refuses here (the occurrence
      // rule is one start time, one occurrence) — surfaced, never
      // deduplicated by guesswork.
      const written = yield* events.record({
        name,
        occurrences,
        threadId,
        author: "agent",
        now,
      });
      if (written.outcome === "refused") {
        return { outcome: "refused", reason: written.reason } as const;
      }

      // The digest over the set record read back — the same honest source
      // eventSetContentDigestsFor pins hypothesis provenance with.
      const contentSha256 = contentDigestHex(serializeEventSetContent(written.set));
      const importId = `evimp_${sha256Hex(`${name}\n${revisionIds.join("\n")}\n${now}`)}`;
      yield* sql`
        INSERT INTO trading_event_set_imports (
          import_id, event_set_name, source_kind, revision_ids_json,
          event_set_content_sha256, imported_at_ms, capture_status, capture_note
        ) VALUES (
          ${importId}, ${name}, ${kind}, ${encodeJsonText(revisionIds)},
          ${contentSha256}, ${now}, ${captureOutcome.status},
          ${captureOutcome.status === "ok" ? null : captureOutcome.reason}
        )
        ON CONFLICT (import_id) DO NOTHING
      `.pipe(Effect.asVoid, Effect.mapError(sqlFail("recordLineage")));

      const firstObservedFromMs = Math.min(...firstObserved);
      const firstObservedToMs = Math.max(...firstObserved);
      return {
        outcome: "ok",
        eventSet: written.set,
        skippedUnreadable,
        skippedUnpublished,
        correctionsObserved: capture.status === "ok" ? capture.changedCount : 0,
        capture: captureOutcome,
        firstObservedFromMs,
        firstObservedToMs,
        importId,
        contentSha256,
        availabilityNote: renderAvailabilityNote(firstObservedFromMs, firstObservedToMs),
      } as const;
    });

  return { importExternalSource } satisfies ExternalEventImportServiceShape;
});

export const ExternalEventImportServiceLive = Layer.effect(
  ExternalEventImportService,
  makeExternalEventImportService,
);
