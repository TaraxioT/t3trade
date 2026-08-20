#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - reserving a free ephemeral port and probing a local
// listener have no Effect equivalent; everything else here goes through Effect services.

/**
 * Applies `migrations/postgres/**` to the relay's self-hosted Postgres.
 *
 * The origin is only reachable through Cloudflare Access, so this opens a
 * short-lived `cloudflared access tcp` session with the admin service token,
 * runs the migrations as `t3relay_owner`, and always tears the session down —
 * the session is scoped, so an interrupt kills it too.
 *
 * The relay Worker deliberately has no DDL route: it is an authentication
 * service, and migrations run from the deploy host instead.
 */

import * as NodeNet from "node:net";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { listSqlFiles, type SqlFile } from "alchemy/SQL/SqlFile";
import { PlatformServices } from "alchemy/Util/PlatformServices";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import { Command, Flag } from "effect/unstable/cli";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import { Client } from "pg";

import { relayDatabaseName } from "../src/dbConfig.ts";

/** Matches upstream's `migrationsTable`. Renaming it orphans applied history. */
const MIGRATIONS_TABLE = "relay_migrations";
const MIGRATIONS_DIR = "migrations/postgres";
const TUNNEL_READY_TIMEOUT_MILLIS = 30_000;
const TUNNEL_POLL_INTERVAL_MILLIS = 250;

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

/**
 * Reserves a free ephemeral port. CI runs concurrent jobs, so a hardcoded port
 * would collide.
 */
const reserveEphemeralPort = Effect.callback<number, RelayMigrationError>((resume) => {
  const server = NodeNet.createServer();
  server.once("error", (cause) => {
    resume(Effect.fail(new RelayMigrationError({ message: "Could not reserve a port", cause })));
  });
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : undefined;
    server.close(() => {
      resume(
        port === undefined
          ? Effect.fail(new RelayMigrationError({ message: "Reserved port had no address" }))
          : Effect.succeed(port),
      );
    });
  });
});

const canConnect = (port: number) =>
  Effect.callback<boolean>((resume) => {
    const socket = NodeNet.connect({ port, host: "127.0.0.1" });
    const settle = (ok: boolean) => {
      socket.destroy();
      resume(Effect.succeed(ok));
    };
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
  });

/**
 * Opens an Access-authenticated TCP session to the origin and returns the local
 * port it listens on. Scoped: the process dies with the scope, including on
 * failure and on interrupt.
 */
const openAccessTunnel = (options: {
  hostname: string;
  clientId: Redacted.Redacted<string>;
  clientSecret: Redacted.Redacted<string>;
}) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner;
    const port = yield* reserveEphemeralPort;
    yield* spawner
      .spawn(
        ChildProcess.make("cloudflared", [
          "access",
          "tcp",
          "--hostname",
          options.hostname,
          "--url",
          `127.0.0.1:${port}`,
          "--service-token-id",
          Redacted.value(options.clientId),
          "--service-token-secret",
          Redacted.value(options.clientSecret),
        ]),
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new RelayMigrationError({
              message: "Could not start cloudflared. Is it installed and on PATH?",
              cause,
            }),
        ),
      );
    yield* waitForTunnel(port, options.hostname);
    return port;
  });

const waitForTunnel = (port: number, hostname: string) =>
  Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + TUNNEL_READY_TIMEOUT_MILLIS;
    while ((yield* Clock.currentTimeMillis) < deadline) {
      if (yield* canConnect(port)) return;
      yield* Effect.sleep(TUNNEL_POLL_INTERVAL_MILLIS);
    }
    return yield* new RelayMigrationError({
      message:
        `cloudflared did not open a local listener for ${hostname} within ` +
        `${TUNNEL_READY_TIMEOUT_MILLIS / 1000}s. Check that the Coolify Tunnel is healthy, that ` +
        `its ingress still routes ${hostname} to tcp://127.0.0.1:5432, and that the admin ` +
        `service token is in the Include list of the "T3 Relay Postgres" Access policy.`,
    });
  });

/**
 * The origin's certificate is self-signed, matching Hyperdrive's default
 * `sslmode=require`: encrypted, but not chain-verified.
 *
 * The mode is expressed through the `ssl` option rather than an `sslmode`
 * query parameter, because pg 8.22's connection-string parser treats
 * `sslmode=require` as `verify-full` and would reject the self-signed cert.
 */
const withPgClient = <A, E, R>(
  connectionString: string,
  use: (client: Client) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.gen(function* () {
      const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
      yield* Effect.tryPromise({
        try: () => client.connect(),
        catch: (cause) =>
          new RelayMigrationError({ message: "Could not connect to Postgres", cause }),
      });
      return client;
    }),
    use,
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
}

export const migrate = Effect.fn("relay.migrate")(function* (options: RelayMigrateOptions) {
  const path = yield* Path.Path;
  const relayRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
  const configProvider = yield* ConfigProvider.fromDotEnv({
    path: path.join(relayRoot, ".env"),
  }).pipe(Effect.orElseSucceed(() => ConfigProvider.fromEnv()));

  const config = yield* Effect.all({
    host: Config.nonEmptyString("RELAY_DB_HOST"),
    user: Config.nonEmptyString("RELAY_DB_ADMIN_USER"),
    password: Config.redacted("RELAY_DB_ADMIN_PASSWORD"),
    clientId: Config.redacted("RELAY_DB_ADMIN_ACCESS_CLIENT_ID"),
    clientSecret: Config.redacted("RELAY_DB_ADMIN_ACCESS_CLIENT_SECRET"),
  }).pipe(Effect.provide(ConfigProvider.layer(configProvider)));

  const stage = Option.getOrElse(options.stage, () => "prod");
  const database = relayDatabaseName(stage);
  const files = yield* listSqlFiles(path.join(relayRoot, MIGRATIONS_DIR));

  yield* Console.log(
    `Migrating ${database} on ${config.host} (stage ${stage}); ${files.length} migration file(s) on disk.`,
  );

  const applied = yield* Effect.gen(function* () {
    const port = yield* openAccessTunnel({
      hostname: config.host,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
    });
    const connectionString =
      `postgresql://${encodeURIComponent(config.user)}:` +
      `${encodeURIComponent(Redacted.value(config.password))}` +
      `@127.0.0.1:${port}/${database}`;
    return yield* withPgClient(connectionString, (client) => applyMigrations(client, files));
  }).pipe(Effect.scoped);

  yield* Console.log(`Migration complete: ${applied} applied.`);
});

export const relayMigrateCommand = Command.make(
  "relay-migrate",
  {
    stage: Flag.string("stage").pipe(
      Flag.withDescription("Stage whose database to migrate. Defaults to prod."),
      Flag.optional,
    ),
  },
  migrate,
).pipe(Command.withDescription("Apply relay migrations through the Access-fronted tunnel."));

if (import.meta.main) {
  Command.run(relayMigrateCommand, { version: "0.0.0" }).pipe(
    Effect.provide(PlatformServices),
    NodeRuntime.runMain,
  );
}
