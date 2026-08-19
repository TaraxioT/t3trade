/**
 * The archive database: a thin synchronous SQLite handle and the schema it
 * owns.
 *
 * Deliberately not `SqlClient`, not a migration chain, not Effect. This is a
 * standalone recorder whose whole job is "open a file, upsert rows, never
 * lose them", and a plain `node:sqlite` handle behind three methods is the
 * smallest thing that does it. The app's `state.sqlite` and its migrations
 * (067-072 and counting) are untouched and unaware.
 *
 * Versioning is one row in `meta`. When the schema changes, bump
 * `ARCHIVE_SCHEMA_VERSION` and add the statement to `SCHEMA_STATEMENTS` —
 * every one of them is `IF NOT EXISTS`, so applying the list to an existing
 * file is a no-op and applying it to a new one builds it whole.
 *
 * Everything goes through prepared statements, including the DDL. That is
 * partly for the statement cache and partly because `ProviderBoundary.test.ts`
 * scans this tree for process-spawning calls by name, and sqlite's
 * multi-statement method shares one of those names. A false positive is
 * better avoided than carved into a guard that exists to stay strict.
 *
 * @module trading/archive/db
 */

// @effect-diagnostics nodeBuiltinImport:off - the archiver owns its own sqlite handle.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

/** Values SQLite accepts as a bound parameter. */
export type SqlValue = string | number | null;

/**
 * The archive handle. Three methods wide on purpose: every statement lives in
 * the module that owns the table, so nothing here has to know the schema.
 */
export interface ArchiveDatabase {
  /** Run one statement, with or without parameters, discarding any result. */
  readonly run: (sql: string, ...params: ReadonlyArray<SqlValue>) => void;
  /** Run `fn` inside a transaction, rolling back if it throws. */
  readonly transaction: <A>(fn: () => A) => A;
  /** Read rows. The caller declares the row shape; columns are not checked. */
  readonly all: <Row>(sql: string, ...params: ReadonlyArray<SqlValue>) => ReadonlyArray<Row>;
  readonly close: () => void;
}

/** Bumped whenever `SCHEMA_STATEMENTS` gains a table or column. */
export const ARCHIVE_SCHEMA_VERSION = 1;

/**
 * The whole schema, one statement per entry.
 *
 * Prices and sizes are stored as REAL rather than the exchange's decimal
 * strings: everything downstream does arithmetic on them, and a float is
 * exact enough for analysis of a market that quotes four significant figures.
 *
 * The candle close time is `t_close`, not `T` as the wire calls it — SQLite
 * identifiers are case-insensitive, so `t` and `T` would be one column.
 */
const SCHEMA_STATEMENTS: ReadonlyArray<string> = [
  `CREATE TABLE IF NOT EXISTS meta (
     key   TEXT PRIMARY KEY,
     value TEXT NOT NULL
   ) WITHOUT ROWID`,

  `CREATE TABLE IF NOT EXISTS candles (
     coin     TEXT    NOT NULL,
     interval TEXT    NOT NULL,
     t        INTEGER NOT NULL,
     t_close  INTEGER NOT NULL,
     o        REAL    NOT NULL,
     h        REAL    NOT NULL,
     l        REAL    NOT NULL,
     c        REAL    NOT NULL,
     v        REAL    NOT NULL,
     n        INTEGER NOT NULL,
     PRIMARY KEY (coin, interval, t)
   ) WITHOUT ROWID`,

  `CREATE TABLE IF NOT EXISTS funding (
     coin         TEXT    NOT NULL,
     time         INTEGER NOT NULL,
     funding_rate REAL    NOT NULL,
     premium      REAL    NOT NULL,
     PRIMARY KEY (coin, time)
   ) WITHOUT ROWID`,

  `CREATE TABLE IF NOT EXISTS asset_ctx (
     coin           TEXT    NOT NULL,
     ts             INTEGER NOT NULL,
     open_interest  REAL    NOT NULL,
     premium        REAL    NOT NULL,
     oracle_px      REAL    NOT NULL,
     mark_px        REAL    NOT NULL,
     day_ntl_volume REAL    NOT NULL,
     funding        REAL    NOT NULL,
     PRIMARY KEY (coin, ts)
   ) WITHOUT ROWID`,

  `CREATE TABLE IF NOT EXISTS book_summary (
     coin       TEXT    NOT NULL,
     ts         INTEGER NOT NULL,
     bid_px     REAL    NOT NULL,
     bid_sz     REAL    NOT NULL,
     ask_px     REAL    NOT NULL,
     ask_sz     REAL    NOT NULL,
     bid_depth5 REAL    NOT NULL,
     ask_depth5 REAL    NOT NULL,
     PRIMARY KEY (coin, ts)
   ) WITHOUT ROWID`,

  `CREATE TABLE IF NOT EXISTS known_gaps (
     coin        TEXT    NOT NULL,
     interval    TEXT    NOT NULL,
     from_t      INTEGER NOT NULL,
     to_t        INTEGER NOT NULL,
     recorded_at INTEGER NOT NULL,
     PRIMARY KEY (coin, interval, from_t, to_t)
   ) WITHOUT ROWID`,
];

/** Create every table and stamp the schema version. Safe to run on each boot. */
export function applySchema(db: ArchiveDatabase): void {
  for (const statement of SCHEMA_STATEMENTS) {
    db.run(statement);
  }
  db.run(
    "INSERT INTO meta (key, value) VALUES ('schema_version', ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    String(ARCHIVE_SCHEMA_VERSION),
  );
}

/**
 * Open (or create) an archive file with its schema applied.
 *
 * WAL keeps a reader — the future toolkit, or a `sqlite3` session poking at
 * the file — from blocking the writer, which matters for a process whose
 * whole point is to never stop writing. Statements are cached per SQL text
 * because a cold backfill prepares the same insert ninety thousand times.
 */
export function openArchiveDatabase(filePath: string): ArchiveDatabase {
  NodeFS.mkdirSync(NodePath.dirname(filePath), { recursive: true });
  const database = new NodeSqlite.DatabaseSync(filePath);
  const statements = new Map<string, ReturnType<NodeSqlite.DatabaseSync["prepare"]>>();

  const prepare = (sql: string) => {
    const cached = statements.get(sql);
    if (cached !== undefined) {
      return cached;
    }
    const statement = database.prepare(sql);
    statements.set(sql, statement);
    return statement;
  };

  const db: ArchiveDatabase = {
    run: (sql, ...params) => {
      prepare(sql).run(...params);
    },
    transaction: (fn) => {
      prepare("BEGIN").run();
      try {
        const result = fn();
        prepare("COMMIT").run();
        return result;
      } catch (error) {
        prepare("ROLLBACK").run();
        throw error;
      }
    },
    // The row shape is the caller's claim about columns it just named in its
    // own SELECT; sqlite reports them as an untyped record either way.
    all: <Row>(sql: string, ...params: ReadonlyArray<SqlValue>) =>
      prepare(sql).all(...params) as unknown as ReadonlyArray<Row>,
    close: () => {
      statements.clear();
      database.close();
    },
  };

  // PRAGMAs answer with a row, so they are read rather than run.
  db.all("PRAGMA journal_mode = WAL");
  db.all("PRAGMA synchronous = NORMAL");
  applySchema(db);
  return db;
}

/**
 * Open an existing archive file for reading only, or `null` when it is absent.
 *
 * This is the seam the trading toolkit reads through. It must never create the
 * file, its parent directory, or any table: an archive that does not exist is
 * the archiver-not-running state, and a reader that silently materialised an
 * empty file would turn "no data" into "a database with zeros in it". Verified
 * against Node's `node:sqlite`: `DatabaseSync(path, { readOnly: true })` throws
 * `unable to open database file` on a missing path and never creates it, and a
 * write through such a handle fails with `attempt to write a readonly
 * database`.
 *
 * Absence returns `null` rather than throwing because the callers above this
 * layer treat "no archive" as a first-class answer with a reason, not an
 * exceptional control flow. The file being present but not a database (or
 * empty) is left to surface at query time, where the reader's own error
 * handling turns it into an explained refusal.
 *
 * The statement cache is shared with the writer's shape so reads are cheap on
 * a hot path; `run` and `transaction` are carried only to satisfy the
 * `ArchiveDatabase` interface and throw if anything ever calls them.
 */
export function openArchiveDatabaseReadOnly(filePath: string): ArchiveDatabase | null {
  if (!NodeFS.existsSync(filePath)) {
    return null;
  }

  let database: NodeSqlite.DatabaseSync;
  try {
    database = new NodeSqlite.DatabaseSync(filePath, { readOnly: true });
  } catch {
    // Exists but cannot be opened (a directory, a permissions failure, a file
    // mid-copy). Indistinguishable from absent for a reader's purposes.
    return null;
  }

  const statements = new Map<string, ReturnType<NodeSqlite.DatabaseSync["prepare"]>>();
  const prepare = (sql: string) => {
    const cached = statements.get(sql);
    if (cached !== undefined) {
      return cached;
    }
    const statement = database.prepare(sql);
    statements.set(sql, statement);
    return statement;
  };

  return {
    run: () => {
      throw new Error("archive handle is read-only");
    },
    transaction: () => {
      throw new Error("archive handle is read-only");
    },
    all: <Row>(sql: string, ...params: ReadonlyArray<SqlValue>) =>
      prepare(sql).all(...params) as unknown as ReadonlyArray<Row>,
    close: () => {
      statements.clear();
      database.close();
    },
  };
}
