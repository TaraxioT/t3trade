import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("105_GraphResearchResults", (it) => {
  it.effect("adds durable result and job tables without pruning legacy scenes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 104 });
      yield* sql`
        INSERT INTO trading_research_scenes (
          scene_id, thread_id, kind, status, title, market, interval,
          payload, calculation_version, created_at, updated_at
        ) VALUES ('old-scene', 'thread', 'annotation', 'active', 'old', 'ETH', NULL, '{}', 'v1', 1, 1)
      `;
      yield* runMigrations({ toMigrationInclusive: 105 });
      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'graph_research_result%'
        ORDER BY name
      `;
      const scene = yield* sql<{ readonly scene_id: string }>`
        SELECT scene_id FROM trading_research_scenes WHERE scene_id = 'old-scene'
      `;
      assert.deepEqual(
        tables.map((row) => row.name),
        [
          "graph_research_result_datasets",
          "graph_research_result_job_datasets",
          "graph_research_result_jobs",
          "graph_research_results",
        ],
      );
      assert.deepEqual(
        scene.map((row) => row.scene_id),
        ["old-scene"],
      );
    }),
  );
});
