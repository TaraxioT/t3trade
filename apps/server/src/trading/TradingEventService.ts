/**
 * TradingEventService: the authored calendar behind the event operand.
 *
 * ## It cannot place an order
 *
 * The same claim the hypothesis service makes, made the same way: this
 * depends on `SqlClient` and `Crypto` and nothing else. No execution service
 * is in its dependency set, so no expression here could reach an order even
 * by accident. It writes `trading_event_sets`,
 * `trading_event_occurrences` and `trading_event_confirmations`, three
 * research tables no projection that reports real money reads.
 *
 * ## The dates are somebody's claim, not a fetch
 *
 * This service never reaches the network. The occurrences arrive already
 * researched, each with its source and its time precision, and the refusals
 * that matter most here are the ones that keep the calendar honest: an
 * occurrence with no source is refused, and an occurrence that ends before
 * it starts is refused. `record` on an existing name replaces the whole
 * occurrence list, which is the correction path: a wrong date is fixed by
 * re-recording the set, not by appending a second version of the same event.
 *
 * ## The read-back confirmation
 *
 * A bulk record is a transcription, and transcription errors are silent: a
 * reordered row, a slipped timestamp, a swapped source all decode as
 * perfectly good dates. `previewConfirmation` persists the digest of the
 * exact payload that was read back to the caller, scoped to the calling
 * thread; `consumeConfirmation` refuses any write that cannot present that
 * digest again, unchanged. The digest is SHA-256 over the pure canonical
 * serialization the contracts module exports, so the server never invents
 * its own notion of "the same payload".
 *
 * @module TradingEventService
 */
import { Context, Effect } from "effect";
import * as Crypto from "effect/Crypto";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { createHash } from "node:crypto";

import {
  EVENT_SET_MAX_OCCURRENCES,
  serializeEventConfirmationPayload,
  validateEventOccurrence,
  type EventSetAuthor,
  type TradingEventOccurrence,
  type TradingEventSet,
  type TradingEventTimePrecision,
} from "@t3tools/trading-contracts/eventSets";

import { toPersistenceSqlError, type PersistenceSqlError } from "../persistence/Errors.ts";

/** One active set as a list row shows it. */
export interface EventSetSummary {
  readonly eventSetId: string;
  readonly name: string;
  readonly description: string | undefined;
  readonly occurrenceCount: number;
  /** The next occurrence that has not ended yet, when there is one. */
  readonly nextUpcomingEndAt: number | null;
  readonly updatedAt: number;
}

export type EventWriteResult =
  | { readonly outcome: "ok"; readonly set: TradingEventSet }
  | { readonly outcome: "refused"; readonly reason: string };

/**
 * What a read-back confirmation is taken over: the thread it is scoped to, the
 * action that will consume it (`add` carries no name, so its canonical name is
 * the empty string), and the ordered occurrences. The serialization itself is
 * the pure function the contracts module exports; this is its input shape.
 */
export interface EventConfirmationPayload {
  readonly threadId: string;
  readonly action: "record" | "add";
  readonly name: string;
  readonly occurrences: ReadonlyArray<TradingEventOccurrence>;
}

/** The read-back gate's verdict: consumed, or the refusal naming the rule. */
export type EventConfirmationResult =
  | { readonly outcome: "ok" }
  | { readonly outcome: "refused"; readonly reason: string };

export interface TradingEventServiceShape {
  /**
   * Create a set by name, or fully replace an existing set's occurrences and
   * clear `retiredAt`: re-recording is the correction path AND the revival
   * path. Matching on the name is case-insensitive, the same way the unique
   * index is.
   */
  readonly record: (input: {
    readonly name: string;
    readonly description?: string | undefined;
    readonly occurrences: ReadonlyArray<TradingEventOccurrence>;
    readonly threadId: string;
    readonly author: EventSetAuthor;
    readonly now: number;
  }) => Effect.Effect<EventWriteResult, PersistenceSqlError>;

  /** Append occurrences, refusing a duplicate start or an over-full set. */
  readonly add: (input: {
    readonly eventSetId: string;
    readonly occurrences: ReadonlyArray<TradingEventOccurrence>;
    readonly author: EventSetAuthor;
    readonly now: number;
  }) => Effect.Effect<EventWriteResult, PersistenceSqlError>;

  /**
   * Arm a read-back confirmation: hash the exact payload the caller was shown
   * and persist the digest as pending, scoped to this thread. A second preview
   * of the same payload re-arms it (a fresh confirmation cycle).
   */
  readonly previewConfirmation: (
    input: EventConfirmationPayload & { readonly now: number },
  ) => Effect.Effect<{ readonly digest: string }, PersistenceSqlError>;

  /**
   * The read-back gate for `record`/`add` with `requireReadBack`: the
   * presented digest must be this thread's, still pending, and must equal the
   * digest of THIS request's payload. Ok consumes the confirmation; every
   * other outcome is a refusal naming the broken rule and the next call.
   */
  readonly consumeConfirmation: (
    input: EventConfirmationPayload & {
      readonly confirmationDigest: string;
      readonly now: number;
    },
  ) => Effect.Effect<EventConfirmationResult, PersistenceSqlError>;

  /** Active sets, newest first, with their counts and next upcoming end. */
  readonly list: (input: {
    readonly now: number;
  }) => Effect.Effect<ReadonlyArray<EventSetSummary>, PersistenceSqlError>;

  /** One set with its occurrences, retired or not. Null when there is none. */
  readonly show: (eventSetId: string) => Effect.Effect<TradingEventSet | null, PersistenceSqlError>;

  /**
   * Retire a set: out of the vocabulary for new theses, still evaluated in
   * the ones already saved.
   */
  readonly retire: (input: {
    readonly eventSetId: string;
    readonly now: number;
  }) => Effect.Effect<EventWriteResult, PersistenceSqlError>;

  /**
   * The flat rows the engines read, every set named including retired ones:
   * a thesis saved while a set was live does not stop evaluating because the
   * set was tidied away later.
   */
  readonly occurrencesFor: (
    setIds: ReadonlyArray<string>,
  ) => Effect.Effect<
    ReadonlyArray<{ readonly eventSetId: string; readonly endAt: number }>,
    PersistenceSqlError
  >;

  /**
   * The occurrences that have not ended yet, for the alert bridge: an event
   * predicate with a future date can arm a time watch at it.
   */
  readonly upcomingFor: (input: {
    readonly setIds: ReadonlyArray<string>;
    readonly now: number;
  }) => Effect.Effect<
    ReadonlyArray<{ readonly eventSetId: string; readonly endAt: number }>,
    PersistenceSqlError
  >;

  /** The ids a new thesis may anchor on: the active sets, and only those. */
  readonly activeSetIds: () => Effect.Effect<ReadonlyArray<string>, PersistenceSqlError>;

  /**
   * Every id on record, retired sets included. The read side of the retire
   * rule: new theses refuse a retired set (activeSetIds), but a run of a
   * thesis that anchored the set while it was live keeps evaluating its dates,
   * so the backtest asks this question instead.
   */
  readonly knownSetIds: () => Effect.Effect<ReadonlyArray<string>, PersistenceSqlError>;
}

export class TradingEventService extends Context.Service<
  TradingEventService,
  TradingEventServiceShape
>()("t3/trading/TradingEventService") {}

const sqlFail = (operation: string) => toPersistenceSqlError(`TradingEventService.${operation}`);

interface SetRow {
  readonly event_set_id: string;
  readonly thread_id: string;
  readonly name: string;
  readonly description: string | null;
  readonly retired_at: number | null;
  readonly created_at: number;
  readonly updated_at: number;
}

interface OccurrenceRow {
  readonly event_set_id: string;
  readonly start_at: number;
  readonly end_at: number;
  /**
   * Null on every row written before migration 092: those decode with
   * `timePrecision` ABSENT, never re-derived from the timestamps.
   */
  readonly time_precision: string | null;
  readonly label: string | null;
  readonly source: string;
  readonly author: string;
  readonly created_at: number;
}

interface ConfirmationRow {
  readonly thread_id: string;
  readonly digest: string;
  readonly status: string;
  readonly created_at: number;
  readonly consumed_at: number | null;
}

/** The confirmation a payload's canonical serialization hashes to. */
const digestOf = (input: {
  readonly threadId: string;
  readonly action: "record" | "add";
  readonly name: string;
  readonly occurrences: ReadonlyArray<TradingEventOccurrence>;
}): string =>
  createHash("sha256").update(serializeEventConfirmationPayload(input), "utf8").digest("hex");

/**
 * The stored precision, narrowed to the union the schema speaks. NULL (every
 * legacy row) is `undefined`: the field decodes ABSENT. A non-null value the
 * union does not know violates the column's CHECK constraint — only manual
 * corruption could produce one — and dies loudly rather than hiding as
 * "absent", which would re-introduce exactly the ambiguity the column exists
 * to remove.
 */
const readTimePrecision = (value: string | null): TradingEventTimePrecision | undefined => {
  if (value === null) return undefined;
  if (value === "instant" || value === "window" || value === "date") return value;
  throw new Error(`unknown time_precision "${value}" in trading_event_occurrences`);
};

const toOccurrence = (row: OccurrenceRow): TradingEventOccurrence => {
  const timePrecision = readTimePrecision(row.time_precision);
  return {
    startAt: row.start_at,
    endAt: row.end_at,
    ...(timePrecision === undefined ? {} : { timePrecision }),
    ...(row.label === null ? {} : { label: row.label }),
    source: row.source,
  };
};

/** Every occurrence refusal names which one, so the caller can fix that one. */
const validateAll = (occurrences: ReadonlyArray<TradingEventOccurrence>): string | null => {
  if (occurrences.length > EVENT_SET_MAX_OCCURRENCES) {
    return `${occurrences.length} occurrences, at most ${EVENT_SET_MAX_OCCURRENCES}. Drop the oldest, or split the calendar into two sets`;
  }
  // Duplicate starts are refused BEFORE any write because the table keys on
  // (event_set_id, start_at): the second row of a pair would fail mid-write,
  // and a replacement that dies halfway has already deleted the old dates.
  const starts = new Set<number>();
  for (const [index, occurrence] of occurrences.entries()) {
    if (starts.has(occurrence.startAt)) {
      return (
        `occurrence ${index + 1} starts at a time another occurrence in this list ` +
        "already holds; one start time, one occurrence, and a re-record replaces the whole list anyway"
      );
    }
    starts.add(occurrence.startAt);
    const reason = validateEventOccurrence(occurrence);
    if (reason !== null) return `occurrence ${index + 1}: ${reason}`;
  }
  return null;
};

export const makeTradingEventService = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;

  const setRowForName = (name: string) =>
    sql<SetRow>`
      SELECT * FROM trading_event_sets WHERE lower(name) = lower(${name})
    `.pipe(
      Effect.mapError(sqlFail("setForName")),
      Effect.map((rows) => rows[0] ?? null),
    );

  const setRowForId = (eventSetId: string) =>
    sql<SetRow>`
      SELECT * FROM trading_event_sets WHERE event_set_id = ${eventSetId}
    `.pipe(
      Effect.mapError(sqlFail("setForId")),
      Effect.map((rows) => rows[0] ?? null),
    );

  const occurrencesForSet = (eventSetId: string) =>
    sql<OccurrenceRow>`
      SELECT * FROM trading_event_occurrences
      WHERE event_set_id = ${eventSetId}
      ORDER BY start_at ASC
    `.pipe(Effect.mapError(sqlFail("occurrences")));

  const show: TradingEventServiceShape["show"] = (eventSetId) =>
    Effect.gen(function* () {
      const row = yield* setRowForId(eventSetId);
      if (row === null) return null;
      const rows = yield* occurrencesForSet(eventSetId);
      return {
        eventSetId: row.event_set_id,
        name: row.name,
        ...(row.description === null ? {} : { description: row.description }),
        retiredAt: row.retired_at,
        occurrences: rows.map(toOccurrence),
      } satisfies TradingEventSet;
    });

  const insertOccurrences = (
    eventSetId: string,
    occurrences: ReadonlyArray<TradingEventOccurrence>,
    author: EventSetAuthor,
    now: number,
  ) =>
    Effect.forEach(occurrences, (occurrence) =>
      sql`
        INSERT INTO trading_event_occurrences (
          event_set_id, start_at, end_at, time_precision, label, source, author, created_at
        ) VALUES (
          ${eventSetId}, ${occurrence.startAt}, ${occurrence.endAt},
          ${occurrence.timePrecision ?? null}, ${occurrence.label ?? null},
          ${occurrence.source}, ${author}, ${now}
        )
      `.pipe(Effect.mapError(sqlFail("insert.occurrence"))),
    );

  /**
   * Arm a read-back confirmation: persist the digest of this exact payload as
   * pending, scoped to the calling thread. A preview of a payload already
   * confirmed (pending or consumed) re-arms it — each preview is a fresh
   * confirmation cycle — so the upsert resets status rather than failing.
   */
  const previewConfirmation: TradingEventServiceShape["previewConfirmation"] = (input) =>
    Effect.gen(function* () {
      const digest = digestOf(input);
      yield* sql`
        INSERT INTO trading_event_confirmations (thread_id, digest, status, created_at, consumed_at)
        VALUES (${input.threadId}, ${digest}, 'pending', ${input.now}, NULL)
        ON CONFLICT (thread_id, digest) DO UPDATE SET
          status = 'pending', created_at = excluded.created_at, consumed_at = NULL
      `.pipe(Effect.mapError(sqlFail("previewConfirmation")));
      return { digest };
    });

  /**
   * The read-back gate for `record`/`add` with `requireReadBack`. The lookup
   * is by the digest the call PRESENTED, so the refusal can name which rule
   * broke: no row at all means this thread never previewed that digest (an
   * unknown digest, or one read back in another conversation); a consumed row
   * is a replay; a pending row whose digest is not this request's own is a
   * payload that changed after the read-back. Only the exact digest, in its
   * own thread, still pending, consumes.
   */
  const consumeConfirmation: TradingEventServiceShape["consumeConfirmation"] = (input) =>
    Effect.gen(function* () {
      const expected = digestOf(input);
      const rows = yield* sql<ConfirmationRow>`
        SELECT thread_id, digest, status, created_at, consumed_at
        FROM trading_event_confirmations
        WHERE thread_id = ${input.threadId} AND digest = ${input.confirmationDigest}
      `.pipe(Effect.mapError(sqlFail("consumeConfirmation.lookup")));
      const row = rows[0] ?? null;
      if (row === null) {
        return {
          outcome: "refused",
          reason:
            "that confirmationDigest matches no read-back confirmation for this thread: " +
            "preview the dates in this thread first, then pass the digest that preview returned",
        } as const;
      }
      if (row.status === "consumed") {
        return {
          outcome: "refused",
          reason:
            "that read-back confirmation was already consumed by an earlier record: " +
            "replaying it confirms nothing. Preview the dates again for a fresh confirmation",
        } as const;
      }
      if (input.confirmationDigest !== expected) {
        return {
          outcome: "refused",
          reason:
            "the dates changed since the read-back this digest came from: " +
            "a read-back confirms the exact payload it previewed. Preview the changed dates again",
        } as const;
      }
      yield* sql`
        UPDATE trading_event_confirmations
        SET status = 'consumed', consumed_at = ${input.now}
        WHERE thread_id = ${input.threadId} AND digest = ${input.confirmationDigest}
      `.pipe(Effect.mapError(sqlFail("consumeConfirmation.consume")));
      return { outcome: "ok" } as const;
    });

  const record: TradingEventServiceShape["record"] = (input) =>
    Effect.gen(function* () {
      const name = input.name.trim();
      if (name.length === 0) return { outcome: "refused", reason: "name cannot be empty" } as const;

      const invalid = validateAll(input.occurrences);
      if (invalid !== null) return { outcome: "refused", reason: invalid } as const;

      const existing = yield* setRowForName(name);
      const eventSetId = existing?.event_set_id ?? (yield* crypto.randomUUIDv4.pipe(Effect.orDie));

      // One transaction around the whole replacement: the correction path
      // deletes the old dates before writing the new ones, so a write that
      // died halfway would leave neither. Rolling back restores the previous
      // complete set, which is the only acceptable failure state.
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            if (existing === null) {
              yield* sql`
                INSERT INTO trading_event_sets (
                  event_set_id, thread_id, name, description, retired_at, created_at, updated_at
                ) VALUES (
                  ${eventSetId}, ${input.threadId}, ${name},
                  ${input.description?.trim() || null}, NULL, ${input.now}, ${input.now}
                )
              `.pipe(Effect.mapError(sqlFail("record.insert")));
            } else {
              // Replacement is the correction path: the old dates go, the typed
              // dates arrive, and a retired set comes back active in the same move.
              yield* sql`
                UPDATE trading_event_sets
                SET name = ${name}, description = ${input.description?.trim() || null},
                    retired_at = NULL, updated_at = ${input.now}
                WHERE event_set_id = ${eventSetId}
              `.pipe(Effect.mapError(sqlFail("record.update")));
              yield* sql`
                DELETE FROM trading_event_occurrences WHERE event_set_id = ${eventSetId}
              `.pipe(Effect.mapError(sqlFail("record.clear")));
            }
            yield* insertOccurrences(eventSetId, input.occurrences, input.author, input.now);
          }),
        )
        .pipe(Effect.mapError(sqlFail("record.transaction")));

      const set = yield* show(eventSetId);
      return set === null
        ? ({ outcome: "refused", reason: "the set could not be read back" } as const)
        : ({ outcome: "ok", set } as const);
    });

  const add: TradingEventServiceShape["add"] = (input) =>
    Effect.gen(function* () {
      const row = yield* setRowForId(input.eventSetId);
      if (row === null) {
        return { outcome: "refused", reason: "no event set with that id" } as const;
      }
      if (row.retired_at !== null) {
        return {
          outcome: "refused",
          reason: "that set is retired; record its name again to revive it with new dates",
        } as const;
      }

      const invalid = validateAll(input.occurrences);
      if (invalid !== null) return { outcome: "refused", reason: invalid } as const;

      const existing = yield* occurrencesForSet(input.eventSetId);
      if (existing.length + input.occurrences.length > EVENT_SET_MAX_OCCURRENCES) {
        return {
          outcome: "refused",
          reason:
            `that would put the set at ${existing.length + input.occurrences.length} occurrences, ` +
            `at most ${EVENT_SET_MAX_OCCURRENCES}. Record the set again with the dates you want to keep`,
        } as const;
      }
      const starts = new Set(existing.map((occurrence) => occurrence.start_at));
      for (const [index, occurrence] of input.occurrences.entries()) {
        if (starts.has(occurrence.startAt)) {
          return {
            outcome: "refused",
            reason:
              `occurrence ${index + 1} starts at a time the set already holds; ` +
              "record the set again to correct a date rather than adding a second one",
          } as const;
        }
        starts.add(occurrence.startAt);
      }

      // The append is a transaction for the same reason the replacement is:
      // all rows arrive or none do, so a half-written add never stands in for
      // the calendar the caller asked for.
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* insertOccurrences(input.eventSetId, input.occurrences, input.author, input.now);
            yield* sql`
              UPDATE trading_event_sets SET updated_at = ${input.now}
              WHERE event_set_id = ${input.eventSetId}
            `.pipe(Effect.mapError(sqlFail("add.touch")));
          }),
        )
        .pipe(Effect.mapError(sqlFail("add.transaction")));

      const set = yield* show(input.eventSetId);
      return set === null
        ? ({ outcome: "refused", reason: "the set could not be read back" } as const)
        : ({ outcome: "ok", set } as const);
    });

  const list: TradingEventServiceShape["list"] = (input) =>
    sql<{
      readonly event_set_id: string;
      readonly name: string;
      readonly description: string | null;
      readonly occurrence_count: number;
      readonly next_end_at: number | null;
      readonly updated_at: number;
    }>`
      SELECT s.event_set_id, s.name, s.description, s.updated_at,
        (SELECT COUNT(*) FROM trading_event_occurrences o
         WHERE o.event_set_id = s.event_set_id) AS occurrence_count,
        (SELECT MIN(o.end_at) FROM trading_event_occurrences o
         WHERE o.event_set_id = s.event_set_id AND o.end_at > ${input.now}) AS next_end_at
      FROM trading_event_sets s
      WHERE s.retired_at IS NULL
      ORDER BY s.updated_at DESC
    `.pipe(
      Effect.mapError(sqlFail("list")),
      Effect.map((rows) =>
        rows.map((row) => ({
          eventSetId: row.event_set_id,
          name: row.name,
          description: row.description === null ? undefined : row.description,
          occurrenceCount: row.occurrence_count,
          nextUpcomingEndAt: row.next_end_at,
          updatedAt: row.updated_at,
        })),
      ),
    );

  const retire: TradingEventServiceShape["retire"] = (input) =>
    Effect.gen(function* () {
      const row = yield* setRowForId(input.eventSetId);
      if (row === null) {
        return { outcome: "refused", reason: "no event set with that id" } as const;
      }
      if (row.retired_at !== null) {
        return { outcome: "refused", reason: "that set is already retired" } as const;
      }
      yield* sql`
        UPDATE trading_event_sets SET retired_at = ${input.now}, updated_at = ${input.now}
        WHERE event_set_id = ${input.eventSetId}
      `.pipe(Effect.mapError(sqlFail("retire")));
      const set = yield* show(input.eventSetId);
      return set === null
        ? ({ outcome: "refused", reason: "the set could not be read back" } as const)
        : ({ outcome: "ok", set } as const);
    });

  const occurrencesFor: TradingEventServiceShape["occurrencesFor"] = (setIds) =>
    setIds.length === 0
      ? Effect.succeed([])
      : sql<{ readonly event_set_id: string; readonly end_at: number }>`
          SELECT event_set_id, end_at FROM trading_event_occurrences
          WHERE event_set_id IN ${sql.in(setIds)}
          ORDER BY end_at ASC
        `.pipe(
          Effect.mapError(sqlFail("occurrencesFor")),
          Effect.map((rows) =>
            rows.map((row) => ({ eventSetId: row.event_set_id, endAt: row.end_at })),
          ),
        );

  const upcomingFor: TradingEventServiceShape["upcomingFor"] = (input) =>
    input.setIds.length === 0
      ? Effect.succeed([])
      : sql<{ readonly event_set_id: string; readonly end_at: number }>`
          SELECT event_set_id, end_at FROM trading_event_occurrences
          WHERE event_set_id IN ${sql.in(input.setIds)} AND end_at > ${input.now}
          ORDER BY end_at ASC
        `.pipe(
          Effect.mapError(sqlFail("upcomingFor")),
          Effect.map((rows) =>
            rows.map((row) => ({ eventSetId: row.event_set_id, endAt: row.end_at })),
          ),
        );

  const activeSetIds: TradingEventServiceShape["activeSetIds"] = () =>
    sql<{ readonly event_set_id: string }>`
      SELECT event_set_id FROM trading_event_sets WHERE retired_at IS NULL
    `.pipe(
      Effect.mapError(sqlFail("activeSetIds")),
      Effect.map((rows) => rows.map((row) => row.event_set_id)),
    );

  const knownSetIds: TradingEventServiceShape["knownSetIds"] = () =>
    sql<{ readonly event_set_id: string }>`
      SELECT event_set_id FROM trading_event_sets
    `.pipe(
      Effect.mapError(sqlFail("knownSetIds")),
      Effect.map((rows) => rows.map((row) => row.event_set_id)),
    );

  return {
    record,
    add,
    previewConfirmation,
    consumeConfirmation,
    list,
    show,
    retire,
    occurrencesFor,
    upcomingFor,
    activeSetIds,
    knownSetIds,
  } satisfies TradingEventServiceShape;
});

export const TradingEventServiceLive: Layer.Layer<
  TradingEventService,
  never,
  SqlClient.SqlClient | Crypto.Crypto
> = Layer.effect(TradingEventService, makeTradingEventService);
