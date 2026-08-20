import type { PgClient } from "@effect/sql-pg/PgClient";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Drizzle from "alchemy/Drizzle";
import * as Alchemy from "alchemy";
import type { EffectPgDatabase } from "drizzle-orm/effect-postgres";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { relayDatabaseName } from "./dbConfig.ts";

export class RelayDb extends Context.Service<
  RelayDb,
  EffectPgDatabase & {
    readonly $client: PgClient;
  }
>()("t3code-relay/db/RelayDb") {}

export class RelayTransactions extends Context.Service<
  RelayTransactions,
  {
    readonly withTransaction: RelayDb["Service"]["$client"]["withTransaction"];
  }
>()("t3code-relay/db/RelayTransactions") {
  static readonly layer = Layer.effect(
    RelayTransactions,
    Effect.gen(function* () {
      const db = yield* RelayDb;
      return RelayTransactions.of({
        withTransaction: db.$client.withTransaction,
      });
    }),
  );
}

/**
 * Regenerates the migration SQL whenever `schema.ts` drifts. The stack yields
 * this so drift is caught at deploy time; the SQL itself is applied by
 * `scripts/migrate.ts`, not by a database resource.
 */
export const RelaySchema = Drizzle.Schema("RelaySchema", {
  schema: "./src/persistence/schema.ts",
  out: "./migrations/postgres",
  dialect: "postgres",
});

/**
 * The relay's Postgres lives on a self-hosted origin behind Cloudflare Access,
 * reached through a Cloudflare Tunnel. Access supplies the origin credential,
 * so there is no port here — the tunnel's TCP ingress owns it.
 */
export const RelayHyperdrive = Effect.gen(function* () {
  const { stage } = yield* Alchemy.Stack;
  const host = yield* Config.nonEmptyString("RELAY_DB_HOST");
  const user = yield* Config.nonEmptyString("RELAY_DB_USER");
  const password = yield* Config.redacted("RELAY_DB_PASSWORD");
  const accessClientId = yield* Config.redacted("RELAY_DB_ACCESS_CLIENT_ID");
  const accessClientSecret = yield* Config.redacted("RELAY_DB_ACCESS_CLIENT_SECRET");

  return yield* Cloudflare.Hyperdrive.Connection("RelayHyperdrive", {
    origin: {
      scheme: "postgres",
      host,
      database: relayDatabaseName(stage),
      user,
      password,
      accessClientId,
      accessClientSecret,
    },
    // The relay reads credentials, allocations and DPoP proofs. A stale read
    // here is an auth bug, so this cache stays off.
    caching: {
      disabled: true,
    },
    originConnectionLimit: 20,
  });
});
