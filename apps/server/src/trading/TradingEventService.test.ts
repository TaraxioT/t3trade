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

import {
  EVENT_SET_MAX_OCCURRENCES,
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
});

const occurrence = (startAt: number, endAt = startAt): TradingEventOccurrence => ({
  startAt,
  endAt,
  label: "the date",
  source: "https://example.com/dates",
});

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
});
