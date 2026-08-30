import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Research scenes: the durable record of what the graph is showing.
 *
 * A trading_events study used to be a tool result and nothing else: the
 * numbers were honest and then they were gone, with no path from the study
 * to the chart above the conversation. These rows are that path: one compact,
 * thread-scoped artifact per published scene, holding the recipe, the
 * deterministic output summary, the calculation version, and the archive
 * bounds it was measured over.
 *
 * ## Why the payload is one JSON column
 *
 * A scene is not a queryable entity; it is a document the graph renders and
 * the service round-trips through the schema that produced it. The recipe
 * fields that outlive a rendering (kind, market, interval) are real columns
 * so a thread's scene list answers without parsing JSON; the computed
 * summary stays one validated blob because nothing joins against a
 * per-occurrence return.
 *
 * ## What is deliberately absent
 *
 * No candles. The archive owns the bars; a scene holds bounded per-window
 * pointers the client reads through the ordinary windowed chart request. No
 * foreign key reaches an execution table, and nothing that reports real
 * money reads these rows: a scene is research, it places no order, and the
 * disclaimer that says so is part of the payload, not an afterthought.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS trading_research_scenes (
      scene_id TEXT PRIMARY KEY,
      -- The chat whose graph the scene belongs to. Scenes are scoped to their
      -- thread: research in one conversation never decorates another's chart.
      thread_id TEXT NOT NULL,
      -- event_study | strategy_replay | annotation. The payload decodes by it.
      kind TEXT NOT NULL,
      -- active | superseded | cleared. Exactly one active row per thread and
      -- market: a publish supersedes the previous active row in the same
      -- transaction, history stays, and clearing is a status change that
      -- retires nothing but the presentation.
      status TEXT NOT NULL DEFAULT 'active',
      title TEXT NOT NULL,
      market TEXT,
      interval TEXT,
      -- The validated payload document: recipe plus deterministic summary.
      payload TEXT NOT NULL,
      calculation_version TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `;

  // A thread's scene list, newest first. The read that backs every chart
  // open in a research conversation.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_trading_research_scenes_thread
    ON trading_research_scenes (thread_id, updated_at)
  `;

  // The active-scene lookup: one row per thread and market.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_trading_research_scenes_active
    ON trading_research_scenes (thread_id, market, status, updated_at)
  `;
});
