/**
 * The calendar as a record: replacement, retirement, revival, and the caps.
 *
 * The dates themselves are somebody's claim; what this file pins is that the
 * record behaves like one. A correction replaces rather than accumulates, a
 * retirement takes a set out of the vocabulary without taking it out of the
 * theses already saved, and the caps hold at their edges.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { createHash } from "node:crypto";

import {
  EVENT_SET_MAX_OCCURRENCES,
  serializeEventConfirmationPayload,
  type TradingEventOccurrence,
} from "@t3tools/trading-contracts/eventSets";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { TradingEventService, TradingEventServiceLive } from "./TradingEventService.ts";

const START = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1_000;

const layer = it.layer(
  TradingEventServiceLive.pipe(
    Layer.provideMerge(NodeSqliteClient.layerMemory()),
    Layer.provideMerge(NodeServices.layer),
  ),
);

const migrated = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({});
  yield* sql`DELETE FROM trading_event_sets`;
  yield* sql`DELETE FROM trading_event_occurrences`;
  yield* sql`DELETE FROM trading_event_confirmations`;
});

const occurrence = (startAt: number, endAt = startAt): TradingEventOccurrence => ({
  startAt,
  endAt,
  label: "the date",
  source: "https://example.com/dates",
});

/** The digest the server should produce, computed the pure way. */
const expectedDigest = (input: {
  readonly threadId: string;
  readonly action: "record" | "add";
  readonly name: string;
  readonly occurrences: ReadonlyArray<TradingEventOccurrence>;
}): string =>
  createHash("sha256").update(serializeEventConfirmationPayload(input), "utf8").digest("hex");

const recorded = Effect.fn("recorded")(function* (name: string, starts: ReadonlyArray<number>) {
  const service = yield* TradingEventService;
  const result = yield* service.record({
    name,
    occurrences: starts.map((startAt) => occurrence(startAt, startAt + DAY)),
    threadId: "thread-1",
    author: "agent",
    now: START,
  });
  assert.equal(result.outcome, "ok");
  if (result.outcome !== "ok") return yield* Effect.die("record refused");
  return result.set;
});

layer("TradingEventService", (it) => {
  it.effect("creates a set by name, and re-recording replaces rather than accumulates", () =>
    Effect.gen(function* () {
      yield* migrated;
      const service = yield* TradingEventService;

      const first = yield* recorded("Devcon", [START, START + 10 * DAY]);
      assert.equal(first.occurrences.length, 2);

      // The same name in a different casing is the same calendar: the unique
      // index is on lower(name), and so is the lookup.
      const replaced = yield* service.record({
        name: "devcon",
        occurrences: [occurrence(START + 20 * DAY, START + 21 * DAY)],
        threadId: "thread-1",
        author: "agent",
        now: START + 1,
      });
      assert.equal(replaced.outcome, "ok");
      if (replaced.outcome !== "ok") return;

      assert.equal(replaced.set.eventSetId, first.eventSetId);
      assert.equal(replaced.set.occurrences.length, 1);
      assert.equal(replaced.set.occurrences[0]?.startAt, START + 20 * DAY);
    }),
  );

  it.effect("retire takes the set out of the vocabulary, not out of the record", () =>
    Effect.gen(function* () {
      yield* migrated;
      const service = yield* TradingEventService;
      const set = yield* recorded("Breakpoint", [START]);

      assert.deepEqual(yield* service.activeSetIds(), [set.eventSetId]);

      const retired = yield* service.retire({ eventSetId: set.eventSetId, now: START + 2 });
      assert.equal(retired.outcome, "ok");

      assert.deepEqual(yield* service.activeSetIds(), []);
      // The engine read does not filter: a thesis saved while the set was
      // live keeps evaluating its dates.
      assert.deepEqual(yield* service.occurrencesFor([set.eventSetId]), [
        { eventSetId: set.eventSetId, endAt: START + DAY },
      ]);
      // And the second retire is a refusal, not a quiet no-op.
      const again = yield* service.retire({ eventSetId: set.eventSetId, now: START + 3 });
      assert.equal(again.outcome, "refused");
      if (again.outcome === "refused") assert.include(again.reason, "already retired");
    }),
  );

  it.effect("recording the name again is the way back from retired", () =>
    Effect.gen(function* () {
      yield* migrated;
      const service = yield* TradingEventService;
      const set = yield* recorded("Devcon", [START]);

      yield* service.retire({ eventSetId: set.eventSetId, now: START + 2 });
      const revived = yield* service.record({
        name: "Devcon",
        occurrences: [occurrence(START + 30 * DAY, START + 31 * DAY)],
        threadId: "thread-1",
        author: "agent",
        now: START + 4,
      });
      assert.equal(revived.outcome, "ok");
      if (revived.outcome !== "ok") return;

      assert.equal(revived.set.eventSetId, set.eventSetId);
      assert.equal(revived.set.retiredAt, null);
      assert.deepEqual(yield* service.activeSetIds(), [set.eventSetId]);
    }),
  );

  it.effect("add appends, refuses a duplicate start, and holds the cap", () =>
    Effect.gen(function* () {
      yield* migrated;
      const service = yield* TradingEventService;
      const set = yield* recorded("Devcon", [START]);

      const added = yield* service.add({
        eventSetId: set.eventSetId,
        // Five days in: the filler below walks in tens, so this start is
        // unique both against them and against the recorded date.
        occurrences: [occurrence(START + 5 * DAY, START + 6 * DAY)],
        author: "agent",
        now: START + 1,
      });
      assert.equal(added.outcome, "ok");
      if (added.outcome !== "ok") return;
      assert.equal(added.set.occurrences.length, 2);

      // The primary key is (set, start): the same start is a correction, and
      // corrections go through record.
      const duplicate = yield* service.add({
        eventSetId: set.eventSetId,
        occurrences: [occurrence(START, START + DAY)],
        author: "agent",
        now: START + 2,
      });
      assert.equal(duplicate.outcome, "refused");
      if (duplicate.outcome === "refused") assert.include(duplicate.reason, "already holds");

      // Fill to the cap, then refuse the one past it.
      const filler = Array.from({ length: EVENT_SET_MAX_OCCURRENCES - 2 }, (_, i) =>
        occurrence(START + (i + 1) * 10 * DAY, START + (i + 1) * 10 * DAY + DAY),
      );
      const bulk = yield* service.add({
        eventSetId: set.eventSetId,
        occurrences: filler,
        author: "agent",
        now: START + 3,
      });
      assert.equal(bulk.outcome, "ok");

      const over = yield* service.add({
        eventSetId: set.eventSetId,
        occurrences: [occurrence(START + 500 * DAY, START + 501 * DAY)],
        author: "agent",
        now: START + 4,
      });
      assert.equal(over.outcome, "refused");
      if (over.outcome === "refused")
        assert.include(over.reason, String(EVENT_SET_MAX_OCCURRENCES));
    }),
  );

  it.effect("add refuses an unknown set, and record refuses an unsourced date", () =>
    Effect.gen(function* () {
      yield* migrated;
      const service = yield* TradingEventService;

      const unknown = yield* service.add({
        eventSetId: "no-such-set",
        occurrences: [occurrence(START)],
        author: "agent",
        now: START,
      });
      assert.equal(unknown.outcome, "refused");

      const unsourced = yield* service.record({
        name: "Devcon",
        occurrences: [{ startAt: START, endAt: START + DAY, source: " " }],
        threadId: "thread-1",
        author: "agent",
        now: START,
      });
      assert.equal(unsourced.outcome, "refused");
      if (unsourced.outcome === "refused") assert.include(unsourced.reason, "occurrence 1");
    }),
  );

  it.effect("list reports the active sets with their counts and next upcoming end", () =>
    Effect.gen(function* () {
      yield* migrated;
      const service = yield* TradingEventService;
      const past = yield* recorded("Devcon", [START - 10 * DAY]);
      const future = yield* recorded("Breakpoint", [START - 5 * DAY, START + 5 * DAY]);

      const rows = yield* service.list({ now: START });
      assert.equal(rows.length, 2);
      const devcon = rows.find((row) => row.eventSetId === past.eventSetId);
      const breakpoint = rows.find((row) => row.eventSetId === future.eventSetId);
      assert.isDefined(devcon);
      assert.isDefined(breakpoint);
      // A set whose dates have all ended has no upcoming end, and that is a
      // null rather than the nearest past one.
      assert.equal(devcon?.nextUpcomingEndAt, null);
      assert.equal(breakpoint?.nextUpcomingEndAt, START + 5 * DAY + DAY);
      assert.equal(breakpoint?.occurrenceCount, 2);
    }),
  );

  it.effect("persists the time precision of every occurrence and reads it back", () =>
    Effect.gen(function* () {
      yield* migrated;
      const service = yield* TradingEventService;
      const written = yield* service.record({
        name: "Ethereum forks",
        occurrences: [
          { startAt: START, endAt: START, timePrecision: "instant", source: "https://e.org/1" },
          {
            startAt: START + DAY,
            endAt: START + 2 * DAY,
            timePrecision: "date",
            label: "a conference",
            source: "https://e.org/2",
          },
          {
            startAt: START + 3 * DAY,
            endAt: START + 3 * DAY + 60_000,
            timePrecision: "window",
            source: "https://e.org/3",
          },
        ],
        threadId: "thread-1",
        author: "agent",
        now: START,
      });
      assert.equal(written.outcome, "ok");
      if (written.outcome !== "ok") return;

      const shown = yield* service.show(written.set.eventSetId);
      if (shown === null) return yield* Effect.die("set vanished");
      assert.deepEqual(shown.occurrences[0], {
        startAt: START,
        endAt: START,
        timePrecision: "instant",
        source: "https://e.org/1",
      });
      assert.equal(shown.occurrences[1]?.timePrecision, "date");
      assert.equal(shown.occurrences[1]?.label, "a conference");
      assert.equal(shown.occurrences[2]?.timePrecision, "window");
    }),
  );

  it.effect("decodes legacy rows with the precision ABSENT, never re-derived", () =>
    Effect.gen(function* () {
      yield* migrated;
      const service = yield* TradingEventService;
      // A row written before migration 092: no time_precision. Its span is a
      // whole UTC day, exactly the shape a re-derivation would mislabel.
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO trading_event_sets (
          event_set_id, thread_id, name, description, retired_at, created_at, updated_at
        ) VALUES ('legacy-set', 'thread-1', 'Legacy', NULL, NULL, ${START}, ${START})
      `;
      yield* sql`
        INSERT INTO trading_event_occurrences (
          event_set_id, start_at, end_at, time_precision, label, source, author, created_at
        ) VALUES ('legacy-set', ${START}, ${START + DAY}, NULL, NULL, 'https://old.example', 'agent', ${START})
      `;

      const shown = yield* service.show("legacy-set");
      assert.isDefined(shown);
      const row = shown?.occurrences[0];
      assert.isDefined(row);
      // ABSENT, not undefined-by-a-different-path and not guessed "date".
      assert.notProperty(row, "timePrecision");
    }),
  );

  it.effect("previewConfirmation digests the pure canonical payload, scoped per thread", () =>
    Effect.gen(function* () {
      yield* migrated;
      const service = yield* TradingEventService;
      const occurrences = [
        {
          startAt: START,
          endAt: START,
          timePrecision: "instant" as const,
          source: "https://e.org/1",
        },
      ];
      const { digest } = yield* service.previewConfirmation({
        threadId: "thread-1",
        action: "record",
        name: "Forks",
        occurrences,
        now: START,
      });
      assert.equal(
        digest,
        expectedDigest({ threadId: "thread-1", action: "record", name: "Forks", occurrences }),
      );
      // The same payload in another thread is another confirmation.
      const { digest: other } = yield* service.previewConfirmation({
        threadId: "thread-2",
        action: "record",
        name: "Forks",
        occurrences,
        now: START,
      });
      assert.notEqual(digest, other);
    }),
  );

  it.effect("consumeConfirmation accepts the exact payload and consumes it", () =>
    Effect.gen(function* () {
      yield* migrated;
      const service = yield* TradingEventService;
      const occurrences = [
        {
          startAt: START,
          endAt: START,
          timePrecision: "instant" as const,
          source: "https://e.org/1",
        },
        {
          startAt: START + DAY,
          endAt: START + 2 * DAY,
          timePrecision: "date" as const,
          label: "first",
          source: "https://e.org/2",
        },
      ];
      const { digest } = yield* service.previewConfirmation({
        threadId: "thread-1",
        action: "record",
        name: "Forks",
        occurrences,
        now: START,
      });

      const ok = yield* service.consumeConfirmation({
        threadId: "thread-1",
        action: "record",
        name: "Forks",
        occurrences,
        confirmationDigest: digest,
        now: START + 1,
      });
      assert.equal(ok.outcome, "ok");

      // Consumed: the same call again is a replay, named as one.
      const replay = yield* service.consumeConfirmation({
        threadId: "thread-1",
        action: "record",
        name: "Forks",
        occurrences,
        confirmationDigest: digest,
        now: START + 2,
      });
      assert.equal(replay.outcome, "refused");
      if (replay.outcome === "refused") assert.include(replay.reason, "already consumed");

      // A fresh preview re-arms the same digest.
      yield* service.previewConfirmation({
        threadId: "thread-1",
        action: "record",
        name: "Forks",
        occurrences,
        now: START + 3,
      });
      const reArmed = yield* service.consumeConfirmation({
        threadId: "thread-1",
        action: "record",
        name: "Forks",
        occurrences,
        confirmationDigest: digest,
        now: START + 4,
      });
      assert.equal(reArmed.outcome, "ok");
    }),
  );

  it.effect("consumeConfirmation refuses a payload that changed since the read-back", () =>
    Effect.gen(function* () {
      yield* migrated;
      const service = yield* TradingEventService;
      const first = {
        startAt: START,
        endAt: START,
        timePrecision: "instant" as const,
        label: "the merge",
        source: "https://e.org/1",
      };
      const second = {
        startAt: START + DAY,
        endAt: START + 2 * DAY,
        timePrecision: "date" as const,
        label: "shapella",
        source: "https://e.org/2",
      };
      const base = { threadId: "thread-1", action: "record" as const, name: "Forks" };
      const { digest } = yield* service.previewConfirmation({
        ...base,
        occurrences: [first, second],
        now: START,
      });

      // Reordered.
      const reordered = yield* service.consumeConfirmation({
        ...base,
        occurrences: [second, first],
        confirmationDigest: digest,
        now: START,
      });
      assert.equal(reordered.outcome, "refused");
      if (reordered.outcome === "refused") assert.include(reordered.reason, "dates changed");

      // Re-timed.
      const retimed = yield* service.consumeConfirmation({
        ...base,
        occurrences: [{ ...first, endAt: first.startAt + 1 }, second],
        confirmationDigest: digest,
        now: START,
      });
      assert.equal(retimed.outcome, "refused");

      // Re-sourced.
      const resourced = yield* service.consumeConfirmation({
        ...base,
        occurrences: [{ ...first, source: "user provided" }, second],
        confirmationDigest: digest,
        now: START,
      });
      assert.equal(resourced.outcome, "refused");

      // Re-labeled.
      const relabeled = yield* service.consumeConfirmation({
        ...base,
        occurrences: [{ ...first, label: "the Merge" }, second],
        confirmationDigest: digest,
        now: START,
      });
      assert.equal(relabeled.outcome, "refused");

      // Renamed.
      const renamed = yield* service.consumeConfirmation({
        ...base,
        name: "Ethereum forks",
        occurrences: [first, second],
        confirmationDigest: digest,
        now: START,
      });
      assert.equal(renamed.outcome, "refused");

      // Nothing above consumed the confirmation: the exact payload still can.
      const exact = yield* service.consumeConfirmation({
        ...base,
        occurrences: [first, second],
        confirmationDigest: digest,
        now: START,
      });
      assert.equal(exact.outcome, "ok");
    }),
  );

  it.effect("consumeConfirmation refuses unknown digests and other threads' confirmations", () =>
    Effect.gen(function* () {
      yield* migrated;
      const service = yield* TradingEventService;
      const occurrences = [
        {
          startAt: START,
          endAt: START,
          timePrecision: "instant" as const,
          source: "https://e.org/1",
        },
      ];
      const { digest } = yield* service.previewConfirmation({
        threadId: "thread-1",
        action: "record",
        name: "Forks",
        occurrences,
        now: START,
      });

      const unknown = yield* service.consumeConfirmation({
        threadId: "thread-1",
        action: "record",
        name: "Forks",
        occurrences,
        confirmationDigest: "0".repeat(64),
        now: START,
      });
      assert.equal(unknown.outcome, "refused");
      if (unknown.outcome === "refused")
        assert.include(unknown.reason, "matches no read-back confirmation for this thread");

      // The right digest, but read back in another conversation.
      const crossThread = yield* service.consumeConfirmation({
        threadId: "thread-2",
        action: "record",
        name: "Forks",
        occurrences,
        confirmationDigest: digest,
        now: START,
      });
      assert.equal(crossThread.outcome, "refused");
      if (crossThread.outcome === "refused")
        assert.include(crossThread.reason, "no read-back confirmation for this thread");

      // Still pending in its own thread: nobody else spent it.
      const own = yield* service.consumeConfirmation({
        threadId: "thread-1",
        action: "record",
        name: "Forks",
        occurrences,
        confirmationDigest: digest,
        now: START,
      });
      assert.equal(own.outcome, "ok");
    }),
  );
});
