import { PlatformServices } from "alchemy/Util/PlatformServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const postgres = vi.hoisted(() => ({
  construct: vi.fn(),
  connect: vi.fn(),
  end: vi.fn(),
  query: vi.fn(),
}));
vi.mock("pg", () => ({
  Client: class {
    constructor(config: unknown) {
      postgres.construct(config);
    }
    connect = postgres.connect;
    end = postgres.end;
    query = postgres.query;
  },
}));
vi.mock("alchemy/SQL/SqlFile", () => ({
  listSqlFiles: () => Effect.succeed([{ id: "001-example", sql: "SELECT 42", hash: "example" }]),
}));

import { migrate, nextMigrationSeq, planMigrations } from "./migrate.ts";

const file = (id: string) => ({ id, sql: `-- ${id}`, hash: id });

describe("nextMigrationSeq", () => {
  it("starts at one when nothing is applied", () => {
    expect(nextMigrationSeq([])).toBe(1);
  });

  it("continues from the highest numeric id", () => {
    expect(nextMigrationSeq(["00001", "00002", "00003"])).toBe(4);
  });

  it("ignores ids that are not numeric", () => {
    expect(nextMigrationSeq(["00002", "baseline"])).toBe(3);
  });
});

describe("planMigrations", () => {
  it("keeps the order it was given and numbers sequentially", () => {
    const pending = planMigrations([file("a"), file("b"), file("c")], new Set(), 1);

    expect(pending.map((migration) => [migration.id, migration.name])).toEqual([
      ["00001", "a"],
      ["00002", "b"],
      ["00003", "c"],
    ]);
  });

  it("skips migrations that are already applied", () => {
    const pending = planMigrations([file("a"), file("b"), file("c")], new Set(["a", "b"]), 3);

    expect(pending.map((migration) => [migration.id, migration.name])).toEqual([["00003", "c"]]);
  });

  it("does not consume an id for a skipped migration", () => {
    const pending = planMigrations([file("a"), file("b"), file("c")], new Set(["b"]), 2);

    expect(pending.map((migration) => [migration.id, migration.name])).toEqual([
      ["00002", "a"],
      ["00003", "c"],
    ]);
  });

  it("is a no-op once every migration is applied", () => {
    expect(planMigrations([file("a"), file("b")], new Set(["a", "b"]), 3)).toEqual([]);
  });

  it("zero-pads ids to five digits", () => {
    const [pending] = planMigrations([file("a")], new Set(), 42);

    expect(pending?.id).toBe("00042");
  });
});

describe("migrate", () => {
  let directory: string;
  let envFile: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    const fs = await Effect.runPromise(
      Effect.service(FileSystem.FileSystem).pipe(Effect.provide(PlatformServices)),
    );
    directory = await Effect.runPromise(fs.makeTempDirectory({ prefix: "relay-migrate-" }));
    envFile = `${directory}/selected.env`;
    await Effect.runPromise(
      fs.writeFileString(
        envFile,
        [
          "RELAY_DB_HOST=ep-selected.neon.tech",
          "RELAY_DB_ADMIN_USER=owner",
          "RELAY_DB_ADMIN_PASSWORD=test-password",
        ].join("\n"),
      ),
    );
    postgres.connect.mockResolvedValue(undefined);
    postgres.end.mockResolvedValue(undefined);
    postgres.query.mockResolvedValue({ rows: [] });
  });

  afterEach(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.remove(directory, { recursive: true, force: true });
      }).pipe(Effect.provide(PlatformServices)),
    );
  });

  const run = (envFile: string) =>
    Effect.runPromise(
      migrate({
        stage: Option.some("prod"),
        envFile: Option.some(envFile),
      }).pipe(Effect.provide(PlatformServices)),
    );

  it("uses the selected environment and verifies the direct Neon TLS connection", async () => {
    await run(envFile);
    expect(postgres.construct).toHaveBeenCalledWith({
      host: "ep-selected.neon.tech",
      port: 5432,
      database: "t3coderelay",
      user: "owner",
      password: "test-password",
      ssl: { rejectUnauthorized: true },
      connectionTimeoutMillis: 10_000,
    });
    expect(postgres.query.mock.calls.slice(2)).toEqual([
      ["BEGIN", undefined],
      ["SELECT 42", undefined],
      ['INSERT INTO "relay_migrations" (id, name) VALUES ($1, $2);', ["00001", "001-example"]],
      ["COMMIT", undefined],
    ]);
    expect(postgres.end).toHaveBeenCalledOnce();
  });

  it("does not silently fall back when an explicitly selected env file is missing", async () => {
    await expect(run(`${directory}/missing.env`)).rejects.toBeDefined();
    expect(postgres.construct).not.toHaveBeenCalled();
  });

  it("closes the client after a failed connection", async () => {
    postgres.connect.mockRejectedValueOnce(new Error("unreachable"));
    await expect(run(envFile)).rejects.toThrow("Could not connect to Postgres");
    expect(postgres.end).toHaveBeenCalledOnce();
    expect(postgres.query).not.toHaveBeenCalled();
  });

  it("rolls back a failed migration and closes the client", async () => {
    postgres.query.mockImplementation(async (sql: string) => {
      if (sql === "SELECT 42") throw new Error("migration rejected");
      return { rows: [] };
    });
    await expect(run(envFile)).rejects.toThrow("migration rejected");
    expect(postgres.query).toHaveBeenLastCalledWith("ROLLBACK", undefined);
    expect(postgres.query.mock.calls.some(([sql]) => sql === "COMMIT")).toBe(false);
    expect(postgres.end).toHaveBeenCalledOnce();
  });

  it("does not rerun an already recorded migration", async () => {
    postgres.query.mockResolvedValue({ rows: [{ id: "00001", name: "001-example" }] });
    await run(envFile);
    expect(postgres.query).toHaveBeenCalledTimes(2);
    expect(postgres.end).toHaveBeenCalledOnce();
  });
});
