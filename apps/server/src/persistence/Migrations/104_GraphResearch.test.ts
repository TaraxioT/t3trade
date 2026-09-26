import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("104_GraphResearch", (it) => {
  it.effect("adds dataset, row and job tables without changing legacy research records", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 103 });
      yield* sql`
        INSERT INTO trading_research_scenes (
          scene_id, thread_id, kind, status, title, market, interval,
          payload, calculation_version, created_at, updated_at
        ) VALUES (
          'legacy-scene', 'legacy-thread', 'annotation', 'active', 'legacy', 'ETH', NULL,
          '{}', 'v1', 1, 1
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 104 });
      const legacy = yield* sql<{ readonly scene_id: string }>`
        SELECT scene_id FROM trading_research_scenes WHERE scene_id = 'legacy-scene'
      `;
      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name IN ('graph_research_datasets', 'graph_research_rows', 'graph_research_jobs')
        ORDER BY name
      `;
      assert.deepEqual(
        legacy.map((row) => row.scene_id),
        ["legacy-scene"],
      );
      assert.deepEqual(
        tables.map((row) => row.name),
        ["graph_research_datasets", "graph_research_jobs", "graph_research_rows"],
      );
    }),
  );
});
