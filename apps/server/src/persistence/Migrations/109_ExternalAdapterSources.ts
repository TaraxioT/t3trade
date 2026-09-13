import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * The generated external-source adapter registry — one installed spec row per
 * (environment, sourceId).
 *
 * The spec document pins everything the host needs to run an agent-generated
 * adapter honestly: the https URL (exact-host allowlist enforced at capture
 * time), the GET method, the optional credential ENVIRONMENT VARIABLE NAME
 * (never a value), the transformRef (capabilityId + version + bundleSha256
 * of the installed capability whose `adapter.ts` artifact parses documents
 * network-less in the sealed sandbox), the declared output event schema the
 * host validates every parsed record against, and the capture policy.
 *
 * Replacing a spec overwrites the row and bumps `updated_at_ms`; retained
 * revisions in external_source_revisions are immutable, so history never
 * rewrites when a spec rotates. The transformRef must resolve to the
 * environment's active installed capability version at install time and is
 * re-verified against the pinned bundle hash on every capture.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS external_adapter_sources (
      environment_id  TEXT NOT NULL,
      source_id       TEXT NOT NULL,
      spec_json       TEXT NOT NULL,
      spec_sha256     TEXT NOT NULL,
      installed_at_ms INTEGER NOT NULL,
      updated_at_ms   INTEGER NOT NULL,
      PRIMARY KEY (environment_id, source_id)
    )
  `;
});
