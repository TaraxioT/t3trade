import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { clearAllSessionProfiles, isTradingAnalystThread } from "../provider/SessionProfile.ts";
import { TradingAnalystService, TradingAnalystServiceLive } from "./TradingAnalystService.ts";

const layer = it.layer(
  TradingAnalystServiceLive.pipe(Layer.provideMerge(NodeSqliteClient.layerMemory())),
);

/** A live thread row, as the projector writes one. */
const seedThread = (threadId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_threads (
        thread_id, project_id, title, created_at, updated_at
      ) VALUES (${threadId}, 'project_1', 'Analyst — ETH', '2026-01-01', '2026-01-01')
    `;
  });

layer("TradingAnalystService", (it) => {
  it.effect("registers, reuses, and replaces the market's analyst thread", () =>
    Effect.gen(function* () {
      yield* runMigrations({});
      clearAllSessionProfiles();
      const analysts = yield* TradingAnalystService;

      // No registered thread: the candidate is registered and the caller owes
      // the thread's creation. The profile binds immediately.
      const first = yield* analysts.ensureThread({ asset: "ETH", candidateThreadId: "thread_a" });
      assert.deepEqual(first, { threadId: "thread_a", created: true });
      assert.equal(isTradingAnalystThread(ThreadId.make("thread_a")), true);

      // Once the thread exists, the same market reuses it and a second
      // candidate id is discarded unused.
      yield* seedThread("thread_a");
      const second = yield* analysts.ensureThread({ asset: "ETH", candidateThreadId: "thread_b" });
      assert.deepEqual(second, { threadId: "thread_a", created: false });

      // Another market is another thread.
      const btc = yield* analysts.ensureThread({ asset: "BTC", candidateThreadId: "thread_c" });
      assert.deepEqual(btc, { threadId: "thread_c", created: true });

      // A deleted thread no longer counts as live: the registration is
      // replaced rather than handed back as a dead link.
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE projection_threads SET deleted_at = '2026-01-02' WHERE thread_id = 'thread_a'`;
      const replaced = yield* analysts.ensureThread({
        asset: "ETH",
        candidateThreadId: "thread_d",
      });
      assert.deepEqual(replaced, { threadId: "thread_d", created: true });

      const rows = yield* sql<{ readonly thread_id: string }>`
        SELECT thread_id FROM trading_analyst_threads WHERE asset = 'ETH'
      `;
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.thread_id, "thread_d");

      clearAllSessionProfiles();
    }),
  );
});
