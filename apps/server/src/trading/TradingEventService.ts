/**
 * TradingEventService: the authored calendar behind the event operand.
 *
 * ## It cannot place an order
 *
 * The same claim the hypothesis service makes, made the same way: this
 * depends on `SqlClient` and `Crypto` and nothing else. No execution service
 * is in its dependency set, so no expression here could reach an order even
 * by accident. It writes `trading_event_sets` and
 * `trading_event_occurrences`, two tables no projection that reports real
 * money reads.
 *
 * ## The dates are somebody's claim, not a fetch
 *
 * This service never reaches the network. The occurrences arrive already
 * researched, each with its source, and the two refusals that matter most
 * here are the ones that keep the calendar honest: an occurrence with no
 * source is refused, and an occurrence that ends before it starts is refused.
 * `record` on an existing name replaces the whole occurrence list, which is
 * the correction path: a wrong date is fixed by re-recording the set, not by
 * appending a second version of the same event.
 *
 * @module TradingEventService
 */
import { Context, Effect } from "effect";
import * as Crypto from "effect/Crypto";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  EVENT_SET_MAX_OCCURRENCES,
  validateEventOccurrence,
  type EventSetAuthor,
  type TradingEventOccurrence,
  type TradingEventSet,
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
  readonly label: string | null;
  readonly source: string;
  readonly author: string;
  readonly created_at: number;
}

const toOccurrence = (row: OccurrenceRow): TradingEventOccurrence => ({
  startAt: row.start_at,
  endAt: row.end_at,
  ...(row.label === null ? {} : { label: row.label }),
  source: row.source,
});

/** Every occurrence refusal names which one, so the caller can fix that one. */
const validateAll = (occurrences: ReadonlyArray<TradingEventOccurrence>): string | null => {
  if (occurrences.length > EVENT_SET_MAX_OCCURRENCES) {
    return `${occurrences.length} occurrences, at most ${EVENT_SET_MAX_OCCURRENCES}. Drop the oldest, or split the calendar into two sets`;
  }
  for (const [index, occurrence] of occurrences.entries()) {
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
          event_set_id, start_at, end_at, label, source, author, created_at
        ) VALUES (
          ${eventSetId}, ${occurrence.startAt}, ${occurrence.endAt},
          ${occurrence.label ?? null}, ${occurrence.source}, ${author}, ${now}
        )
      `.pipe(Effect.mapError(sqlFail("insert.occurrence"))),
    );

  const record: TradingEventServiceShape["record"] = (input) =>
    Effect.gen(function* () {
      const name = input.name.trim();
      if (name.length === 0) return { outcome: "refused", reason: "name cannot be empty" } as const;

      const invalid = validateAll(input.occurrences);
      if (invalid !== null) return { outcome: "refused", reason: invalid } as const;

      const existing = yield* setRowForName(name);
      const eventSetId = existing?.event_set_id ?? (yield* crypto.randomUUIDv4.pipe(Effect.orDie));

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

      yield* insertOccurrences(input.eventSetId, input.occurrences, input.author, input.now);
      yield* sql`
        UPDATE trading_event_sets SET updated_at = ${input.now}
        WHERE event_set_id = ${input.eventSetId}
      `.pipe(Effect.mapError(sqlFail("add.touch")));

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

  return {
    record,
    add,
    list,
    show,
    retire,
    occurrencesFor,
    upcomingFor,
    activeSetIds,
  } satisfies TradingEventServiceShape;
});

export const TradingEventServiceLive: Layer.Layer<
  TradingEventService,
  never,
  SqlClient.SqlClient | Crypto.Crypto
> = Layer.effect(TradingEventService, makeTradingEventService);
