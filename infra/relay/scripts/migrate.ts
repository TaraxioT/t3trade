#!/usr/bin/env node

/**
 * Applies relay migrations directly to Neon using the schema-owner credentials.
 * The Worker deliberately has no DDL route; migrations run from the deploy host.
 */

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { listSqlFiles, type SqlFile } from "alchemy/SQL/SqlFile";
import { PlatformServices } from "alchemy/Util/PlatformServices";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import { Command, Flag } from "effect/unstable/cli";
import { Client, type ClientConfig } from "pg";

import { relayDatabaseName } from "../src/dbConfig.ts";

/** Matches upstream's `migrationsTable`. Renaming it orphans applied history. */
const MIGRATIONS_TABLE = "relay_migrations";
const MIGRATIONS_DIR = "migrations/postgres";

export class RelayMigrationError extends Data.TaggedError("RelayMigrationError")<{
  message: string;
  cause?: unknown;
}> {}

/**
 * A migration that has not been applied yet, with the id it will be recorded
 * under. Ids are sequential zero-padded 5-digit strings continuing from the
 * highest already in the table.
 */
export interface PendingMigration {
  readonly id: string;
  readonly name: string;
  readonly sql: string;
}

/**
 * Pairs each not-yet-applied file with its next sequential id. Pure, so the
 * ordering and the skip rule are testable without a database.
 */
export function planMigrations(
  files: ReadonlyArray<SqlFile>,
  appliedNames: ReadonlySet<string>,
  nextSeq: number,
): ReadonlyArray<PendingMigration> {
  const pending: Array<PendingMigration> = [];
  let seq = nextSeq;
  for (const file of files) {
    if (appliedNames.has(file.id)) continue;
    pending.push({ id: seq.toString().padStart(5, "0"), name: file.id, sql: file.sql });
    seq += 1;
  }
  return pending;
}

/** The next sequence number after the highest numeric id already recorded. */
export function nextMigrationSeq(appliedIds: ReadonlyArray<string>): number {
  let max = 0;
  for (const id of appliedIds) {
    if (/^\d+$/.test(id)) {
      max = Math.max(max, Number.parseInt(id, 10));
    }
  }
  return max + 1;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

const withPgClient = <A, E, R>(
  config: ClientConfig,
  use: (client: Client) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => new Client(config)),
    (client) =>
      Effect.tryPromise({
        try: () => client.connect(),
        catch: (cause) =>
          new RelayMigrationError({ message: "Could not connect to Postgres", cause }),
      }).pipe(Effect.andThen(use(client))),
    (client) => Effect.promise(() => client.end().catch(() => undefined)),
  );

const toMigrationError = (cause: unknown) =>
  new RelayMigrationError({
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });

const exec = (client: Client, sql: string, values?: ReadonlyArray<unknown>) =>
  Effect.tryPromise({
    try: () => client.query(sql, values as Array<unknown>).then(() => undefined),
    catch: toMigrationError,
  });

const rows = <A>(client: Client, sql: string) =>
  Effect.tryPromise({
    try: () => client.query(sql).then((result) => result.rows as Array<A>),
    catch: toMigrationError,
  });

const applyMigrations = (client: Client, files: ReadonlyArray<SqlFile>) =>
  Effect.gen(function* () {
    const table = quoteIdentifier(MIGRATIONS_TABLE);
    yield* exec(
      client,
      `CREATE TABLE IF NOT EXISTS ${table} (
         id TEXT PRIMARY KEY,
         name TEXT NOT NULL,
         applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
       );`,
    );

    const recorded = yield* rows<{ id: string; name: string }>(
      client,
      `SELECT id, name FROM ${table};`,
    );
    const pending = planMigrations(
      files,
      new Set(recorded.map((row) => row.name)),
      nextMigrationSeq(recorded.map((row) => row.id)),
    );

    if (pending.length === 0) {
      yield* Console.log(`No pending migrations. ${recorded.length} already applied.`);
      return 0;
    }

    for (const migration of pending) {
      yield* Effect.gen(function* () {
        yield* exec(client, "BEGIN");
        yield* exec(client, migration.sql);
        yield* exec(client, `INSERT INTO ${table} (id, name) VALUES ($1, $2);`, [
          migration.id,
          migration.name,
        ]);
        yield* exec(client, "COMMIT");
      }).pipe(
        Effect.catch((error) =>
          exec(client, "ROLLBACK").pipe(
            Effect.catch(() => Effect.void),
            Effect.andThen(Effect.fail(error)),
          ),
        ),
      );
      yield* Console.log(`Applied ${migration.id} ${migration.name}`);
    }
    return pending.length;
  });

export interface RelayMigrateOptions {
  readonly stage: Option.Option<string>;
  readonly envFile: Option.Option<string>;
}

export const migrate = Effect.fn("relay.migrate")(function* (options: RelayMigrateOptions) {
  const path = yield* Path.Path;
  const relayRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
  const configProvider = Option.isSome(options.envFile)
    ? yield* ConfigProvider.fromDotEnv({ path: path.resolve(relayRoot, options.envFile.value) })
    : yield* ConfigProvider.fromDotEnv({ path: path.join(relayRoot, ".env") }).pipe(
        Effect.orElseSucceed(() => ConfigProvider.fromEnv()),
      );

  const config = yield* Effect.all({
    host: Config.nonEmptyString("RELAY_DB_HOST"),
    user: Config.nonEmptyString("RELAY_DB_ADMIN_USER"),
    password: Config.redacted("RELAY_DB_ADMIN_PASSWORD"),
  }).pipe(Effect.provide(ConfigProvider.layer(configProvider)));

  const stage = Option.getOrElse(options.stage, () => "prod");
  const database = relayDatabaseName(stage);
  const files = yield* listSqlFiles(path.join(relayRoot, MIGRATIONS_DIR));

  yield* Console.log(
    `Migrating ${database} on ${config.host} (stage ${stage}); ${files.length} migration file(s) on disk.`,
  );

  const applied = yield* withPgClient(
    {
      host: config.host,
      port: 5432,
      database,
      user: config.user,
      password: Redacted.value(config.password),
      ssl: { rejectUnauthorized: true },
      connectionTimeoutMillis: 10_000,
    },
    (client) => applyMigrations(client, files),
  );

  yield* Console.log(`Migration complete: ${applied} applied.`);
});

export const relayMigrateCommand = Command.make(
  "relay-migrate",
  {
    envFile: Flag.string("env-file").pipe(
      Flag.withDescription("Configuration file relative to infra/relay. Defaults to .env."),
      Flag.optional,
    ),
    stage: Flag.string("stage").pipe(
      Flag.withDescription("Stage whose database to migrate. Defaults to prod."),
      Flag.optional,
    ),
  },
  migrate,
).pipe(Command.withDescription("Apply relay migrations directly to Neon over verified TLS."));

if (import.meta.main) {
  Command.run(relayMigrateCommand, { version: "0.0.0" }).pipe(
    Effect.provide(PlatformServices),
    NodeRuntime.runMain,
  );
}
