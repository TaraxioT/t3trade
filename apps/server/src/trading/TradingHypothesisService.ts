/**
 * TradingHypothesisService: ideas, their versions, and the runs against them.
 *
 * ## It cannot place an order
 *
 * The same claim the validation service makes, made the same way: this
 * depends on `SqlClient` and `Crypto` and nothing else. `TradingEntryService`,
 * `TradingExitService`, `HyperliquidExecutionService` and the gateway are not
 * in its dependency set, so no expression here could reach an order even by
 * accident. It writes `trading_hypotheses`, `trading_hypothesis_versions` and
 * `trading_backtest_runs`, and reads `trading_thesis_validations` for the
 * lineage; none of the four is read by any projection that reports real money.
 *
 * ## Why the validation summaries come back unpriced
 *
 * `show` returns validation references, not validation reports. Composing a
 * forward report means walking the paper ledger and running `judgeForward`
 * over it, which is the validation service's arithmetic and exists there once.
 * Duplicating it here to avoid a second call would give the product two
 * expectancy figures that could disagree, which is worse than the extra hop.
 * The caller enriches the refs.
 *
 * @module TradingHypothesisService
 */
import { Context, Effect } from "effect";
import * as Crypto from "effect/Crypto";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { BacktestReport } from "@t3tools/trading-contracts/backtest";
import type { ThesisValidationStatus } from "@t3tools/trading-contracts/forward";
import {
  HYPOTHESIS_LIST_LIMIT,
  HYPOTHESIS_NOTE_MAX_CHARS,
  HYPOTHESIS_SHOW_RUNS,
  HYPOTHESIS_SHOW_VERSIONS,
  HYPOTHESIS_TITLE_MAX_CHARS,
  type HypothesisAuthor,
  type HypothesisConclusionStatus,
  type HypothesisRunSummary,
  type HypothesisStatus,
  type HypothesisSummary,
  type HypothesisVersion,
} from "@t3tools/trading-contracts/hypothesis";
import { describeThesis, validateThesis, TradingThesis } from "@t3tools/trading-contracts/thesis";

import { toPersistenceSqlError, type PersistenceSqlError } from "../persistence/Errors.ts";

const decodeThesisJson = Schema.decodeUnknownSync(Schema.fromJsonString(TradingThesis));
const encodeThesisJson = Schema.encodeUnknownSync(Schema.fromJsonString(TradingThesis));
const decodeReportJson = Schema.decodeUnknownSync(Schema.fromJsonString(BacktestReport));
const encodeReportJson = Schema.encodeUnknownSync(Schema.fromJsonString(BacktestReport));

/**
 * A linked validation, without its paper-ledger arithmetic. See the module
 * note on why the numbers are not computed here.
 */
export interface HypothesisValidationRef {
  readonly validationId: string;
  readonly version: number | null;
  readonly market: string;
  readonly interval: string;
  readonly status: ThesisValidationStatus;
  readonly armedAt: number;
  readonly expiresAt: number;
  readonly endedAt: number | null;
}

/** A hypothesis and everything filed against it. */
export interface HypothesisRecord {
  readonly hypothesisId: string;
  readonly threadId: string;
  readonly title: string;
  readonly status: HypothesisStatus;
  readonly conclusion: string | null;
  readonly currentVersion: number;
  readonly thesis: TradingThesis;
  readonly currentNote: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** Newest first, capped. */
  readonly versions: ReadonlyArray<HypothesisVersion>;
  /** Newest first, capped. */
  readonly runs: ReadonlyArray<HypothesisRunSummary>;
  readonly validations: ReadonlyArray<HypothesisValidationRef>;
  readonly versionCount: number;
  readonly runCount: number;
}

export type HypothesisWriteResult =
  | { readonly outcome: "ok"; readonly hypothesis: HypothesisRecord }
  | { readonly outcome: "refused"; readonly reason: string };

/** What a version holds, for a caller checking a submitted thesis against it. */
export interface HypothesisVersionRef {
  readonly version: number;
  readonly thesis: TradingThesis;
}

export interface TradingHypothesisServiceShape {
  /** File a new idea as version 1. */
  readonly create: (input: {
    readonly title: string;
    readonly thesis: TradingThesis;
    readonly threadId: string;
    readonly author: HypothesisAuthor;
    readonly now: number;
  }) => Effect.Effect<HypothesisWriteResult, PersistenceSqlError>;

  /**
   * Write the next version. A concluded or shelved idea reopens to
   * `exploring` and drops its conclusion: a verdict about a thesis that has
   * since changed is worse than no verdict.
   */
  readonly revise: (input: {
    readonly hypothesisId: string;
    readonly thesis: TradingThesis;
    readonly note: string;
    readonly author: HypothesisAuthor;
    readonly now: number;
  }) => Effect.Effect<HypothesisWriteResult, PersistenceSqlError>;

  /** Newest first. A `threadId` scopes to one conversation's ideas. */
  readonly list: (input: {
    readonly threadId?: string | undefined;
    readonly limit?: number | undefined;
  }) => Effect.Effect<ReadonlyArray<HypothesisSummary>, PersistenceSqlError>;

  readonly show: (
    hypothesisId: string,
  ) => Effect.Effect<HypothesisRecord | null, PersistenceSqlError>;

  /**
   * Shelve an idea, or conclude it supported or unsupported with the sentence
   * that says why.
   */
  readonly setStatus: (input: {
    readonly hypothesisId: string;
    readonly to: HypothesisConclusionStatus | "shelved";
    readonly conclusion?: string | undefined;
    readonly now: number;
  }) => Effect.Effect<HypothesisWriteResult, PersistenceSqlError>;

  /** The thesis a version holds, for a caller checking a submitted one. */
  readonly version: (input: {
    readonly hypothesisId: string;
    readonly version: number;
  }) => Effect.Effect<HypothesisVersionRef | null, PersistenceSqlError>;

  /** The version a new run or validation should be stamped with. */
  readonly currentVersion: (
    hypothesisId: string,
  ) => Effect.Effect<HypothesisVersionRef | null, PersistenceSqlError>;

  /**
   * Persist one completed backtest. `hypothesisId` is optional because a
   * backtest is still allowed to be a loose question; a stamped run also moves
   * its hypothesis out of `exploring`.
   */
  readonly recordRun: (input: {
    readonly thesis: TradingThesis;
    readonly report: BacktestReport;
    readonly hypothesisId?: string | undefined;
    readonly hypothesisVersion?: number | undefined;
    readonly now: number;
  }) => Effect.Effect<string, PersistenceSqlError>;

  /**
   * Mark a hypothesis as under test. Called when a run or a validation is
   * filed against it, so `testing` is derived from what happened rather than
   * from a verb the model has to remember.
   */
  readonly noteTested: (input: {
    readonly hypothesisId: string;
    readonly now: number;
  }) => Effect.Effect<void, PersistenceSqlError>;
}

export class TradingHypothesisService extends Context.Service<
  TradingHypothesisService,
  TradingHypothesisServiceShape
>()("t3/trading/TradingHypothesisService") {}

const sqlFail = (operation: string) =>
  toPersistenceSqlError(`TradingHypothesisService.${operation}`);

interface HypothesisRow {
  readonly hypothesis_id: string;
  readonly thread_id: string;
  readonly title: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly current_version: number;
  readonly created_at: number;
  readonly updated_at: number;
}

interface VersionRow {
  readonly hypothesis_id: string;
  readonly version: number;
  readonly thesis_json: string;
  readonly note: string;
  readonly author: string;
  readonly created_at: number;
}

interface RunRow {
  readonly run_id: string;
  readonly hypothesis_id: string | null;
  readonly hypothesis_version: number | null;
  readonly thesis_json: string;
  readonly report_json: string;
  readonly created_at: number;
}

interface LinkedValidationRow {
  readonly validation_id: string;
  readonly hypothesis_version: number | null;
  readonly asset: string;
  readonly interval: string;
  readonly status: string;
  readonly armed_at: number;
  readonly expires_at: number;
  readonly ended_at: number | null;
}

/** Trim and length-check one free-text field, or say what is wrong with it. */
const readText = (
  value: string,
  field: string,
  max: number,
): { readonly text: string } | { readonly reason: string } => {
  const text = value.trim();
  if (text.length === 0) return { reason: `${field} cannot be empty` };
  if (text.length > max) {
    return { reason: `${field} is ${text.length} chars, at most ${max}` };
  }
  return { text };
};

const toVersion = (row: VersionRow): HypothesisVersion => ({
  version: row.version,
  thesis: decodeThesisJson(row.thesis_json),
  note: row.note,
  author: row.author as HypothesisAuthor,
  createdAt: row.created_at,
});

const toRunSummary = (row: RunRow): HypothesisRunSummary => {
  const report = decodeReportJson(row.report_json);
  return {
    runId: row.run_id,
    version: row.hypothesis_version,
    market: report.thesis.market,
    interval: report.thesis.interval,
    createdAt: row.created_at,
    expectancyUsd: report.stats.expectancyUsd,
    tradesTaken: report.stats.tradesTaken,
    winRatePercent: report.stats.winRatePercent,
    maxDrawdownUsd: report.stats.maxDrawdownUsd,
    totalNetUsd: report.stats.totalNetUsd,
    barsServed: report.coverage.barsServed,
    verdict: report.verdict,
  };
};

export const makeTradingHypothesisService = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;

  const rowFor = (hypothesisId: string) =>
    sql<HypothesisRow>`
      SELECT * FROM trading_hypotheses WHERE hypothesis_id = ${hypothesisId}
    `.pipe(
      Effect.mapError(sqlFail("row")),
      Effect.map((rows) => rows[0] ?? null),
    );

  const show: TradingHypothesisServiceShape["show"] = (hypothesisId) =>
    Effect.gen(function* () {
      const row = yield* rowFor(hypothesisId);
      if (row === null) return null;

      const versions = yield* sql<VersionRow>`
        SELECT * FROM trading_hypothesis_versions
        WHERE hypothesis_id = ${hypothesisId}
        ORDER BY version DESC LIMIT ${HYPOTHESIS_SHOW_VERSIONS}
      `.pipe(Effect.mapError(sqlFail("show.versions")));
      const current = versions.find((version) => version.version === row.current_version);
      // A hypothesis row without its current version is a torn write, and
      // there is nothing honest to render for it.
      if (current === undefined) return null;

      const runs = yield* sql<RunRow>`
        SELECT * FROM trading_backtest_runs
        WHERE hypothesis_id = ${hypothesisId}
        ORDER BY created_at DESC LIMIT ${HYPOTHESIS_SHOW_RUNS}
      `.pipe(Effect.mapError(sqlFail("show.runs")));

      const validations = yield* sql<LinkedValidationRow>`
        SELECT validation_id, hypothesis_version, asset, interval, status,
               armed_at, expires_at, ended_at
        FROM trading_thesis_validations
        WHERE hypothesis_id = ${hypothesisId}
        ORDER BY armed_at DESC
      `.pipe(Effect.mapError(sqlFail("show.validations")));

      const versionCount = yield* sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM trading_hypothesis_versions
        WHERE hypothesis_id = ${hypothesisId}
      `.pipe(
        Effect.mapError(sqlFail("show.versionCount")),
        Effect.map((rows) => rows[0]?.n ?? 0),
      );
      const runCount = yield* sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM trading_backtest_runs
        WHERE hypothesis_id = ${hypothesisId}
      `.pipe(
        Effect.mapError(sqlFail("show.runCount")),
        Effect.map((rows) => rows[0]?.n ?? 0),
      );

      return {
        hypothesisId: row.hypothesis_id,
        threadId: row.thread_id,
        title: row.title,
        status: row.status as HypothesisStatus,
        conclusion: row.conclusion,
        currentVersion: row.current_version,
        thesis: decodeThesisJson(current.thesis_json),
        currentNote: current.note,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        versions: versions.map(toVersion),
        runs: runs.map(toRunSummary),
        validations: validations.map((validation) => ({
          validationId: validation.validation_id,
          version: validation.hypothesis_version,
          market: validation.asset,
          interval: validation.interval,
          status: validation.status as ThesisValidationStatus,
          armedAt: validation.armed_at,
          expiresAt: validation.expires_at,
          endedAt: validation.ended_at,
        })),
        versionCount,
        runCount,
      } satisfies HypothesisRecord;
    });

  /** Read a hypothesis back after a write, or say the write did not stick. */
  const readBack = (hypothesisId: string) =>
    show(hypothesisId).pipe(
      Effect.map((record) =>
        record === null
          ? ({ outcome: "refused", reason: "the hypothesis could not be read back" } as const)
          : ({ outcome: "ok", hypothesis: record } as const),
      ),
    );

  const create: TradingHypothesisServiceShape["create"] = (input) =>
    Effect.gen(function* () {
      const title = readText(input.title, "title", HYPOTHESIS_TITLE_MAX_CHARS);
      if ("reason" in title) return { outcome: "refused", reason: title.reason } as const;

      const invalid = validateThesis(input.thesis);
      if (invalid !== null) return { outcome: "refused", reason: invalid } as const;

      const id = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
      yield* sql`
        INSERT INTO trading_hypotheses (
          hypothesis_id, thread_id, title, status, conclusion, current_version,
          created_at, updated_at
        ) VALUES (
          ${id}, ${input.threadId}, ${title.text}, 'exploring', NULL, 1,
          ${input.now}, ${input.now}
        )
      `.pipe(Effect.mapError(sqlFail("create.hypothesis")));
      yield* sql`
        INSERT INTO trading_hypothesis_versions (
          hypothesis_id, version, thesis_json, note, author, created_at
        ) VALUES (
          ${id}, 1, ${encodeThesisJson(input.thesis)}, 'the idea as first written',
          ${input.author}, ${input.now}
        )
      `.pipe(Effect.mapError(sqlFail("create.version")));

      return yield* readBack(id);
    });

  const revise: TradingHypothesisServiceShape["revise"] = (input) =>
    Effect.gen(function* () {
      const note = readText(input.note, "note", HYPOTHESIS_NOTE_MAX_CHARS);
      if ("reason" in note) return { outcome: "refused", reason: note.reason } as const;

      const invalid = validateThesis(input.thesis);
      if (invalid !== null) return { outcome: "refused", reason: invalid } as const;

      const row = yield* rowFor(input.hypothesisId);
      if (row === null)
        return { outcome: "refused", reason: "no hypothesis with that id" } as const;

      const next = row.current_version + 1;
      yield* sql`
        INSERT INTO trading_hypothesis_versions (
          hypothesis_id, version, thesis_json, note, author, created_at
        ) VALUES (
          ${input.hypothesisId}, ${next}, ${encodeThesisJson(input.thesis)},
          ${note.text}, ${input.author}, ${input.now}
        )
      `.pipe(Effect.mapError(sqlFail("revise.version")));

      // Reopening: a conclusion belongs to the thesis it was reached about,
      // and this is no longer that thesis. Shelved reopens for the same
      // reason - picking an idea back up is exactly what a revision is.
      const reopened =
        row.status === "supported" || row.status === "unsupported" || row.status === "shelved";
      yield* sql`
        UPDATE trading_hypotheses
        SET current_version = ${next},
            status = ${reopened ? "exploring" : row.status},
            conclusion = ${reopened ? null : row.conclusion},
            updated_at = ${input.now}
        WHERE hypothesis_id = ${input.hypothesisId}
      `.pipe(Effect.mapError(sqlFail("revise.hypothesis")));

      return yield* readBack(input.hypothesisId);
    });

  const list: TradingHypothesisServiceShape["list"] = (input) =>
    Effect.gen(function* () {
      const limit = Math.max(1, Math.min(input.limit ?? HYPOTHESIS_LIST_LIMIT, 100));
      const rows =
        input.threadId === undefined
          ? yield* sql<HypothesisRow>`
              SELECT * FROM trading_hypotheses ORDER BY updated_at DESC LIMIT ${limit}
            `.pipe(Effect.mapError(sqlFail("list")))
          : yield* sql<HypothesisRow>`
              SELECT * FROM trading_hypotheses WHERE thread_id = ${input.threadId}
              ORDER BY updated_at DESC LIMIT ${limit}
            `.pipe(Effect.mapError(sqlFail("list.thread")));
      if (rows.length === 0) return [];

      // One read for every current version rather than one per row: a list of
      // twenty-five ideas should not be twenty-six queries.
      const current = yield* sql<VersionRow>`
        SELECT * FROM trading_hypothesis_versions
        WHERE hypothesis_id IN ${sql.in(rows.map((row) => row.hypothesis_id))}
      `.pipe(Effect.mapError(sqlFail("list.versions")));
      const byKey = new Map(
        current.map((version) => [`${version.hypothesis_id}:${version.version}`, version]),
      );

      return rows.flatMap((row) => {
        const version = byKey.get(`${row.hypothesis_id}:${row.current_version}`);
        if (version === undefined) return [];
        return [
          {
            hypothesisId: row.hypothesis_id,
            title: row.title,
            status: row.status as HypothesisStatus,
            currentVersion: row.current_version,
            headline: describeThesis(decodeThesisJson(version.thesis_json)),
            conclusion: row.conclusion,
            updatedAt: row.updated_at,
          } satisfies HypothesisSummary,
        ];
      });
    });

  const setStatus: TradingHypothesisServiceShape["setStatus"] = (input) =>
    Effect.gen(function* () {
      const row = yield* rowFor(input.hypothesisId);
      if (row === null)
        return { outcome: "refused", reason: "no hypothesis with that id" } as const;

      let conclusion: string | null = null;
      if (input.to === "shelved") {
        // Shelving without a reason is allowed: putting an idea down is often
        // the whole of what happened to it.
        if (input.conclusion !== undefined) {
          const read = readText(input.conclusion, "conclusion", HYPOTHESIS_NOTE_MAX_CHARS);
          if ("reason" in read) return { outcome: "refused", reason: read.reason } as const;
          conclusion = read.text;
        }
      } else {
        if (input.conclusion === undefined) {
          return {
            outcome: "refused",
            reason: "concluding needs one sentence saying what the evidence showed",
          } as const;
        }
        const read = readText(input.conclusion, "conclusion", HYPOTHESIS_NOTE_MAX_CHARS);
        if ("reason" in read) return { outcome: "refused", reason: read.reason } as const;
        conclusion = read.text;
      }

      yield* sql`
        UPDATE trading_hypotheses
        SET status = ${input.to}, conclusion = ${conclusion}, updated_at = ${input.now}
        WHERE hypothesis_id = ${input.hypothesisId}
      `.pipe(Effect.mapError(sqlFail("setStatus")));

      return yield* readBack(input.hypothesisId);
    });

  const version: TradingHypothesisServiceShape["version"] = (input) =>
    sql<VersionRow>`
      SELECT * FROM trading_hypothesis_versions
      WHERE hypothesis_id = ${input.hypothesisId} AND version = ${input.version}
    `.pipe(
      Effect.mapError(sqlFail("version")),
      Effect.map((rows) => {
        const row = rows[0];
        return row === undefined
          ? null
          : { version: row.version, thesis: decodeThesisJson(row.thesis_json) };
      }),
    );

  const currentVersion: TradingHypothesisServiceShape["currentVersion"] = (hypothesisId) =>
    Effect.gen(function* () {
      const row = yield* rowFor(hypothesisId);
      if (row === null) return null;
      return yield* version({ hypothesisId, version: row.current_version });
    });

  const noteTested: TradingHypothesisServiceShape["noteTested"] = (input) =>
    sql`
      UPDATE trading_hypotheses SET status = 'testing', updated_at = ${input.now}
      WHERE hypothesis_id = ${input.hypothesisId} AND status = 'exploring'
    `.pipe(Effect.mapError(sqlFail("noteTested")), Effect.asVoid);

  const recordRun: TradingHypothesisServiceShape["recordRun"] = (input) =>
    Effect.gen(function* () {
      const runId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
      yield* sql`
        INSERT INTO trading_backtest_runs (
          run_id, hypothesis_id, hypothesis_version, thesis_json, report_json, created_at
        ) VALUES (
          ${runId}, ${input.hypothesisId ?? null}, ${input.hypothesisVersion ?? null},
          ${encodeThesisJson(input.thesis)}, ${encodeReportJson(input.report)}, ${input.now}
        )
      `.pipe(Effect.mapError(sqlFail("recordRun")));
      if (input.hypothesisId !== undefined) {
        yield* noteTested({ hypothesisId: input.hypothesisId, now: input.now });
      }
      return runId;
    });

  return {
    create,
    revise,
    list,
    show,
    setStatus,
    version,
    currentVersion,
    recordRun,
    noteTested,
  } satisfies TradingHypothesisServiceShape;
});

export const TradingHypothesisServiceLive: Layer.Layer<
  TradingHypothesisService,
  never,
  SqlClient.SqlClient | Crypto.Crypto
> = Layer.effect(TradingHypothesisService, makeTradingHypothesisService);
