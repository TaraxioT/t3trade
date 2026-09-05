/**
 * TradingThesisValidationService — armed theses and their paper ledger.
 *
 * A user says "watch this idea on the live chart for two weeks and tell me if
 * it works". This is what watches it. An armed thesis evaluates on each closed
 * bar of its own market and interval, records the trades its rule would have
 * taken, and pays them the fees and funding a real trade would have paid.
 *
 * ## It cannot place an order
 *
 * Not by policy: by construction. This service depends on the market
 * archive, the SQL client and the event calendar service (itself SQL and
 * Crypto and nothing else), and on nothing else. `TradingEntryService`,
 * `TradingExitService`, `HyperliquidExecutionService` and the gateway are not
 * in its dependency set, so there is no expression here that could reach an
 * order even by mistake. Its writes go to `trading_thesis_validations` and
 * `trading_thesis_paper_fills`, which no projection that reports real money
 * reads. Both halves of that are asserted by tests rather than left to review.
 *
 * Promotion is therefore not a code path. A validated thesis becomes a live
 * position the same way any idea does: the user says so, and the agent
 * publishes a plan and enters, with this record as the context for the
 * decision.
 *
 * ## Evaluation is archive-driven, and catches up rather than skipping
 *
 * A candle delivery is the clock, never the data — the same rule the derived
 * watches follow. The archiver trails the websocket by up to a minute, so the
 * bar that just closed on the wire may not be stored yet. Rather than evaluate
 * a bar the archive cannot serve, each pass walks every archived bar newer
 * than the last one seen. A lagging archiver therefore evaluates a bar one
 * delivery late instead of never, and a restart or a brief outage catches up
 * on the next delivery instead of leaving a hole in the record.
 *
 * That also means evaluation costs no venue read at all. The watch evaluator's
 * sweep batches its exchange reads; this adds nothing to that batch.
 *
 * @module TradingThesisValidationService
 */
import { Context, Effect } from "effect";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type { BacktestCosts, BacktestStats } from "@t3tools/trading-contracts/backtest";
import {
  BACKTEST_FALLBACK_SLIPPAGE_BPS_PER_SIDE,
  BACKTEST_TAKER_FEE_BPS_PER_SIDE,
  summarizeTrades,
} from "@t3tools/trading-contracts/backtest";
import {
  EMPTY_FORWARD_STATE,
  FORWARD_INTERVALS,
  forwardWarmupBars,
  isForwardInterval,
  judgeForward,
  MAX_VALIDATION_MS,
  MIN_VALIDATION_MS,
  settledAsBacktestTrade,
  stepForward,
  type ForwardReport,
  type ForwardState,
  type PaperTrade,
  type ThesisValidationEndReason,
  type ThesisValidationStatus,
  describePaperEntry,
  describePaperExit,
  describeVerdictChange,
  type ForwardComparison,
  type ValidationEventBatch,
  type ValidationEventKind,
} from "@t3tools/trading-contracts/forward";
import type { MarketCandle } from "@t3tools/trading-contracts/market";
import {
  describeThesis,
  thesisEventSets,
  thesisReadsFunding,
  validateThesis,
  TradingThesis,
} from "@t3tools/trading-contracts/thesis";

import { toPersistenceSqlError, type PersistenceSqlError } from "../persistence/Errors.ts";
import { INTERVAL_MS, type ArchiveInterval } from "./archive/config.ts";
import type { CandleRow } from "./archive/candles.ts";
import { DEFAULT_TRADING_VENUE, type TradingVenue } from "./Schemas.ts";
import { halfSpreadBps } from "./TradingBacktestService.ts";
import { TradingEventService } from "./TradingEventService.ts";
import { TradingMarketArchive } from "./TradingMarketArchive.ts";

/**
 * The notional every paper trade is taken at.
 *
 * The backtest's own default, so an armed thesis and the backtest that armed
 * it price the same idea at the same size and their expectancies compare.
 */
export const DEFAULT_PAPER_NOTIONAL_USD = 1_000;

/** How many recorded book samples the crossing cost is measured over. */
const SLIPPAGE_SAMPLE_ROWS = 200;

const decodeThesisJson = Schema.decodeUnknownSync(Schema.fromJsonString(TradingThesis));
const encodeThesisJson = Schema.encodeUnknownSync(Schema.fromJsonString(TradingThesis));

/**
 * How many archived bars one pass will catch up on.
 *
 * A pass normally walks one bar. This bounds what happens after a long outage:
 * past the cap the missed stretch is skipped and the walk resumes at the live
 * edge, because replaying a day of bars inside a candle delivery would stall
 * the evaluator for every other watch on the machine. The report's
 * `barsWatched` counts what was actually evaluated, so a skipped stretch
 * shrinks the sample rather than being quietly counted as watched.
 */
const MAX_CATCHUP_BARS = 400;

/** A validation as the service reads and serves it. */
export interface ThesisValidation {
  readonly id: string;
  readonly threadId: string | null;
  readonly venue: TradingVenue;
  readonly asset: string;
  readonly interval: string;
  readonly thesis: TradingThesis;
  readonly label: string | null;
  readonly status: ThesisValidationStatus;
  readonly armedAt: number;
  readonly expiresAt: number;
  readonly endedAt: number | null;
  readonly endReason: ThesisValidationEndReason | null;
  readonly notionalUsd: number;
  readonly costs: BacktestCosts;
  readonly baseline: BacktestStats | null;
  readonly barsWatched: number;
  readonly state: ForwardState;
  readonly lastBarTime: number | null;
  /** The filed idea this run belongs to, when it belongs to one. */
  readonly hypothesisId: string | null;
  /** The version of that idea whose thesis this is. */
  readonly hypothesisVersion: number | null;
  /**
   * The comparison label this validation last reported, or null before its
   * first evaluation. A verdict change is a difference, and without the
   * previous reading there is nothing to take a difference against.
   */
  readonly lastComparison: ForwardComparison | null;
}

export type ArmValidationResult =
  | {
      readonly outcome: "armed";
      readonly validation: ThesisValidation;
      /**
       * The validation this one replaced, when the slot was held by an earlier
       * version of the same hypothesis. Reported rather than done quietly: two
       * things happened in one call and the user is owed both.
       */
      readonly superseded?: string;
    }
  | { readonly outcome: "refused"; readonly reason: string };

export interface TradingThesisValidationServiceShape {
  readonly arm: (input: {
    readonly thesis: TradingThesis;
    readonly durationMs: number;
    readonly label?: string | undefined;
    readonly threadId?: string | undefined;
    readonly notionalUsd?: number | undefined;
    /**
     * The filed idea this run tests. Naming one also buys the supersede rule:
     * an armed or paused validation on the same market and interval that
     * belongs to the SAME hypothesis is ended as `superseded` and this one
     * takes the slot, because a refinement is not a second opinion. A
     * collision with any other validation still refuses.
     */
    readonly hypothesisId?: string | undefined;
    readonly hypothesisVersion?: number | undefined;
    readonly now: number;
  }) => Effect.Effect<ArmValidationResult, PersistenceSqlError>;

  /** Every validation, newest first. Ended ones are included on request. */
  readonly list: (input: {
    readonly includeEnded?: boolean | undefined;
  }) => Effect.Effect<ReadonlyArray<ThesisValidation>, PersistenceSqlError>;

  readonly get: (id: string) => Effect.Effect<ThesisValidation | null, PersistenceSqlError>;

  /**
   * Move a validation between `armed` and `paused`, or end it. Returns the
   * refusal sentence when the move does not apply, so every reverse state
   * answers in the same shape.
   */
  readonly setStatus: (input: {
    readonly id: string;
    readonly to: ThesisValidationStatus;
    readonly endReason?: ThesisValidationEndReason | undefined;
    readonly now: number;
  }) => Effect.Effect<
    { readonly outcome: "ok" } | { readonly outcome: "refused"; readonly reason: string },
    PersistenceSqlError
  >;

  /** Every paper trade a validation has taken, oldest first. */
  readonly trades: (id: string) => Effect.Effect<ReadonlyArray<PaperTrade>, PersistenceSqlError>;

  /** The running verdict. Null when no such validation exists. */
  readonly report: (input: {
    readonly id: string;
    readonly now: number;
  }) => Effect.Effect<ForwardReport | null, PersistenceSqlError>;

  /**
   * Evaluate every armed validation on this market and interval against the
   * archive's newest bars. Driven by a candle delivery; reads no venue.
   */
  readonly onClosedBar: (input: {
    readonly asset: string;
    readonly interval: string;
    readonly now: number;
  }) => Effect.Effect<ReadonlyArray<ValidationEventBatch>, PersistenceSqlError>;

  /**
   * End every validation whose clock has run out, and return both deliveries
   * it earns: the final report for the alert feed, and the event batch for a
   * mission that is narrating it.
   */
  readonly expireDue: (input: { readonly now: number }) => Effect.Effect<
    {
      readonly reports: ReadonlyArray<ForwardReport>;
      readonly events: ReadonlyArray<ValidationEventBatch>;
    },
    PersistenceSqlError
  >;

  /**
   * Record the backtest figures the forward run will be scored against.
   *
   * Separate from `arm` because the backtest lives in another service, and
   * pulling it in here would put a second dependency on a service whose short
   * dependency list is the claim that it cannot trade. The caller runs the
   * backtest and hands the figures over.
   */
  readonly setBaseline: (input: {
    readonly id: string;
    readonly baseline: BacktestStats;
  }) => Effect.Effect<void, PersistenceSqlError>;

  /**
   * Which of these ids are validations at all.
   *
   * The alert feed carries one opaque id per row and cannot tell a watch from
   * a validation; this is the one query that answers the whole page.
   */
  readonly knownIds: (
    ids: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlySet<string>, PersistenceSqlError>;

  /** The armed validation on a market, with its paper trades, for the chart. */
  readonly forChart: (input: {
    readonly asset: string;
  }) => Effect.Effect<
    { readonly validation: ThesisValidation; readonly trades: ReadonlyArray<PaperTrade> } | null,
    PersistenceSqlError
  >;
}

export class TradingThesisValidationService extends Context.Service<
  TradingThesisValidationService,
  TradingThesisValidationServiceShape
>()("t3/trading/TradingThesisValidationService") {}

const sqlFail = (operation: string) =>
  toPersistenceSqlError(`TradingThesisValidationService.${operation}`);

const round2 = (value: number): number => Math.round(value * 100) / 100;
const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;

const toCandle = (row: CandleRow): MarketCandle =>
  ({
    openTime: row.t,
    closeTime: row.tClose,
    open: row.o,
    high: row.h,
    low: row.l,
    close: row.c,
    volume: row.v,
    trades: row.n,
  }) as MarketCandle;

interface ValidationRow {
  readonly validation_id: string;
  readonly thread_id: string | null;
  readonly venue: string;
  readonly asset: string;
  readonly interval: string;
  readonly thesis_json: string;
  readonly label: string | null;
  readonly status: string;
  readonly armed_at: number;
  readonly expires_at: number;
  readonly ended_at: number | null;
  readonly end_reason: string | null;
  readonly notional_usd: number;
  readonly costs_json: string;
  readonly baseline_json: string | null;
  readonly bars_watched: number;
  readonly pending_entry_signal_time: number | null;
  readonly pending_exit_reason: string | null;
  readonly last_bar_time: number | null;
  readonly hypothesis_id: string | null;
  readonly hypothesis_version: number | null;
  readonly last_comparison: string | null;
}

interface PaperFillRow {
  readonly paper_trade_id: string;
  readonly validation_id: string;
  readonly entry_time: number;
  readonly entry_price: number;
  readonly signal_time: number;
  readonly stop_price: number | null;
  readonly target_price: number | null;
  readonly exit_time: number | null;
  readonly exit_price: number | null;
  readonly exit_reason: string | null;
  readonly bars_held: number;
  readonly gross_usd: number | null;
  readonly fees_usd: number | null;
  readonly funding_usd: number | null;
  readonly net_usd: number | null;
  readonly adverse_excursion_usd: number | null;
}

/** What one `advance` pass produced. @see ValidationEventBatch */
interface AdvanceResult {
  readonly events: ReadonlyArray<{
    readonly kind: ValidationEventKind;
    readonly line: string;
  }>;
  /** The label the run held before this pass, when this pass changed it. */
  readonly previousComparison: ForwardComparison | null;
}

const toPaperTrade = (row: PaperFillRow): PaperTrade => ({
  id: row.paper_trade_id,
  entryTime: row.entry_time,
  entryPrice: row.entry_price,
  signalTime: row.signal_time,
  stopPrice: row.stop_price,
  targetPrice: row.target_price,
  exitTime: row.exit_time,
  exitPrice: row.exit_price,
  exitReason: row.exit_reason,
  barsHeld: row.bars_held,
  grossUsd: row.gross_usd,
  feesUsd: row.fees_usd,
  fundingUsd: row.funding_usd,
  netUsd: row.net_usd,
  adverseExcursionUsd: row.adverse_excursion_usd,
});

/**
 * The forward state a row carries, reassembled with the open trade.
 *
 * The open paper fill IS the open position — there is no second copy of it on
 * the validation row to drift out of step with the ledger.
 */
const toForwardState = (row: ValidationRow, open: PaperFillRow | undefined): ForwardState => ({
  open:
    open === undefined
      ? null
      : {
          id: open.paper_trade_id,
          entryTime: open.entry_time,
          entryPrice: open.entry_price,
          signalTime: open.signal_time,
          stopPrice: open.stop_price,
          targetPrice: open.target_price,
          barsHeld: open.bars_held,
          adverseExcursionUsd: open.adverse_excursion_usd ?? 0,
        },
  pendingEntrySignalTime: row.pending_entry_signal_time,
  pendingExitReason: (row.pending_exit_reason ?? null) as ForwardState["pendingExitReason"],
});

const rowJsonString = Schema.fromJsonString(Schema.Unknown);
const jsonValueFromRow = Schema.decodeUnknownSync(rowJsonString);
const rowJsonValue = Schema.encodeSync(rowJsonString);

export const makeTradingThesisValidationService = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const archive = yield* TradingMarketArchive;
  // Named `eventService`, not `events`: `advance` keeps its narration lines
  // in a local `events` array, and a service shadowed by an array of sentences
  // fails in a way no type check catches.
  const eventService = yield* TradingEventService;

  const openFillFor = (validationId: string) =>
    sql<PaperFillRow>`
      SELECT * FROM trading_thesis_paper_fills
      WHERE validation_id = ${validationId} AND exit_time IS NULL
      ORDER BY entry_time DESC LIMIT 1
    `.pipe(Effect.mapError(sqlFail("openFill")));

  const hydrate = (row: ValidationRow) =>
    Effect.gen(function* () {
      const open = yield* openFillFor(row.validation_id);
      return {
        id: row.validation_id,
        threadId: row.thread_id,
        venue: row.venue as TradingVenue,
        asset: row.asset,
        interval: row.interval,
        thesis: decodeThesisJson(row.thesis_json),
        label: row.label,
        status: row.status as ThesisValidationStatus,
        armedAt: row.armed_at,
        expiresAt: row.expires_at,
        endedAt: row.ended_at,
        endReason: row.end_reason as ThesisValidationEndReason | null,
        notionalUsd: row.notional_usd,
        costs: jsonValueFromRow(row.costs_json) as BacktestCosts,
        baseline:
          row.baseline_json === null
            ? null
            : (jsonValueFromRow(row.baseline_json) as BacktestStats),
        barsWatched: row.bars_watched,
        state: toForwardState(row, open[0]),
        lastBarTime: row.last_bar_time,
        hypothesisId: row.hypothesis_id,
        hypothesisVersion: row.hypothesis_version,
        lastComparison: (row.last_comparison ?? null) as ForwardComparison | null,
      } satisfies ThesisValidation;
    });

  const get: TradingThesisValidationServiceShape["get"] = (id) =>
    Effect.gen(function* () {
      const rows = yield* sql<ValidationRow>`
        SELECT * FROM trading_thesis_validations WHERE validation_id = ${id}
      `.pipe(Effect.mapError(sqlFail("get")));
      const row = rows[0];
      return row === undefined ? null : yield* hydrate(row);
    });

  const list: TradingThesisValidationServiceShape["list"] = ({ includeEnded }) =>
    Effect.gen(function* () {
      const rows =
        includeEnded === true
          ? yield* sql<ValidationRow>`
            SELECT * FROM trading_thesis_validations ORDER BY armed_at DESC LIMIT 100
          `.pipe(Effect.mapError(sqlFail("list")))
          : yield* sql<ValidationRow>`
            SELECT * FROM trading_thesis_validations
            WHERE status != 'ended' ORDER BY armed_at DESC LIMIT 100
          `.pipe(Effect.mapError(sqlFail("list")));
      return yield* Effect.forEach(rows, hydrate);
    });

  const trades: TradingThesisValidationServiceShape["trades"] = (id) =>
    Effect.gen(function* () {
      const rows = yield* sql<PaperFillRow>`
        SELECT * FROM trading_thesis_paper_fills
        WHERE validation_id = ${id} ORDER BY entry_time ASC
      `.pipe(Effect.mapError(sqlFail("trades")));
      return rows.map(toPaperTrade);
    });

  const arm: TradingThesisValidationServiceShape["arm"] = (input) =>
    Effect.gen(function* () {
      // The same event-calendar refusal the backtest makes: arming a thesis
      // whose set is unknown or retired would score a rule that never fires.
      const anchoredSets = thesisEventSets(input.thesis);
      let knownEventSets: ReadonlyArray<string> | undefined = undefined;
      if (anchoredSets.length > 0) {
        knownEventSets = yield* eventService.activeSetIds();
      }
      const invalid = validateThesis(
        input.thesis,
        knownEventSets === undefined ? {} : { knownEventSets },
      );
      if (invalid !== null) return { outcome: "refused", reason: invalid } as const;

      if (!isForwardInterval(input.thesis.interval)) {
        return {
          outcome: "refused",
          reason:
            `${input.thesis.interval} bars are archived but not delivered live, so a validation on ` +
            `them would never see a bar. Forward validation runs on ${FORWARD_INTERVALS.join(", ")}`,
        } as const;
      }
      if (input.durationMs < MIN_VALIDATION_MS || input.durationMs > MAX_VALIDATION_MS) {
        return {
          outcome: "refused",
          reason: "a validation runs for between one hour and 90 days",
        } as const;
      }

      // One armed validation per market and interval. Two rules watching the
      // same bars is not twice the evidence, and the chart has one badge.
      //
      // The one exception is a refinement of the idea already in the slot.
      // Without it the loop this whole layer exists for - test, revise, test
      // again - would dead-end at "end that one first", and the version the
      // user just improved on would sit there collecting bars nobody wants.
      // A collision with anything else keeps the refusal, because that really
      // is a second opinion competing for one badge.
      const existing = yield* sql<{
        readonly validation_id: string;
        readonly hypothesis_id: string | null;
      }>`
        SELECT validation_id, hypothesis_id FROM trading_thesis_validations
        WHERE status IN ('armed', 'paused') AND asset = ${input.thesis.market}
          AND interval = ${input.thesis.interval}
      `.pipe(Effect.mapError(sqlFail("arm.existing")));
      const held = existing[0];
      let superseded: string | null = null;
      if (held !== undefined) {
        const sameIdea =
          input.hypothesisId !== undefined && held.hypothesis_id === input.hypothesisId;
        if (!sameIdea) {
          return {
            outcome: "refused",
            reason:
              `${input.thesis.market} ${input.thesis.interval} is already being validated. ` +
              "End that one first, or validate this idea on another interval",
          } as const;
        }
      }
      // Everything that can fail OUTSIDE the tables is prepared before any
      // row changes: a cost measurement or id mint that failed after the
      // supersede used to leave the prior validation already ended — the
      // refinement loop's old version destroyed with nothing to replace it.
      // The supersede and the insert commit together or not at all.
      const id = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
      const now = input.now;
      const notionalUsd = input.notionalUsd ?? DEFAULT_PAPER_NOTIONAL_USD;
      const costs = yield* measureCosts(input.thesis.market);

      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            if (held !== undefined) {
              yield* sql`
              UPDATE trading_thesis_validations
              SET status = 'ended', ended_at = ${input.now}, end_reason = 'superseded',
                  updated_at = ${input.now}
              WHERE validation_id = ${held.validation_id}
            `.pipe(Effect.mapError(sqlFail("arm.supersede")));
            }
            yield* sql`
            INSERT INTO trading_thesis_validations (
              validation_id, thread_id, venue, asset, interval, thesis_json, label,
              status, armed_at, expires_at, ended_at, end_reason, notional_usd,
              costs_json, baseline_json, bars_watched, pending_entry_signal_time,
              pending_exit_reason, last_bar_time, hypothesis_id, hypothesis_version,
              created_at, updated_at
            ) VALUES (
              ${id}, ${input.threadId ?? null}, ${DEFAULT_TRADING_VENUE}, ${input.thesis.market},
              ${input.thesis.interval}, ${encodeThesisJson(input.thesis)}, ${input.label ?? null},
              'armed', ${now}, ${now + input.durationMs}, NULL, NULL, ${notionalUsd},
              ${rowJsonValue(costs as unknown)}, NULL, 0, NULL, NULL, NULL,
              ${input.hypothesisId ?? null}, ${input.hypothesisVersion ?? null}, ${now}, ${now}
            )
          `.pipe(Effect.mapError(sqlFail("arm.insert")));
          }),
        )
        .pipe(Effect.mapError(sqlFail("arm.transaction")));
      if (held !== undefined) {
        superseded = held.validation_id;
      }

      const validation = yield* get(id);
      return validation === null
        ? ({ outcome: "refused", reason: "the validation could not be read back" } as const)
        : ({
            outcome: "armed",
            validation,
            ...(superseded === null ? {} : { superseded }),
          } as const);
    });

  /**
   * The crossing cost for this market, measured off the archive's recorded
   * books where there are any. Frozen onto the validation at arm time: see the
   * migration's note on why a drifting fee assumption would be read as a
   * change in the thesis.
   */
  const measureCosts = (asset: string) =>
    Effect.gen(function* () {
      const book = yield* archive.bookHistory({ coin: asset, n: SLIPPAGE_SAMPLE_ROWS });
      const measured = book.status === "ok" ? halfSpreadBps(book.rows) : null;
      return {
        takerFeeBpsPerSide: BACKTEST_TAKER_FEE_BPS_PER_SIDE,
        slippageBpsPerSide: measured ?? BACKTEST_FALLBACK_SLIPPAGE_BPS_PER_SIDE,
        slippageSource: measured === null ? "assumed" : "archived_book",
      } satisfies BacktestCosts;
    });

  /** Record the backtest figures a forward run will be scored against. */
  const setBaseline = (input: { readonly id: string; readonly baseline: BacktestStats }) =>
    sql`
      UPDATE trading_thesis_validations
      SET baseline_json = ${JSON.stringify(input.baseline)}
      WHERE validation_id = ${input.id}
    `.pipe(Effect.mapError(sqlFail("setBaseline")), Effect.asVoid);

  const setStatus: TradingThesisValidationServiceShape["setStatus"] = (input) =>
    Effect.gen(function* () {
      const current = yield* get(input.id);
      if (current === null) {
        return { outcome: "refused", reason: "no validation with that id" } as const;
      }
      if (current.status === "ended") {
        return {
          outcome: "refused",
          reason: "that validation has already ended; arm a new one to run the idea again",
        } as const;
      }
      if (current.status === input.to) {
        return { outcome: "refused", reason: `it is already ${input.to}` } as const;
      }

      if (input.to === "ended") {
        yield* sql`
          UPDATE trading_thesis_validations
          SET status = 'ended', ended_at = ${input.now},
              end_reason = ${input.endReason ?? "ended_by_user"}, updated_at = ${input.now}
          WHERE validation_id = ${input.id}
        `.pipe(Effect.mapError(sqlFail("setStatus.end")));
        return { outcome: "ok" } as const;
      }

      // Resuming clears the pending fill. A rule that fired before a pause
      // would otherwise fill at whatever bar happens to open after the resume,
      // at a price the signal never saw — a trade the thesis did not take.
      //
      // Resuming also moves `last_bar_time` up to now, which is what makes a
      // pause mean anything. The catch-up walk starts from that mark, so
      // without this a resume would replay every bar the pause was supposed to
      // skip and the paused stretch would be counted after all — leaving pause
      // as a way to delay evaluation rather than to exclude it, and making
      // liars of the report's own "bars are passing unwatched" and of the
      // documentation that promises it. Found in a live pass, where a paused
      // validation resumed and immediately took the trades it had sat out.
      if (input.to === "armed") {
        yield* sql`
          UPDATE trading_thesis_validations
          SET status = 'armed',
              pending_entry_signal_time = NULL,
              last_bar_time = ${input.now},
              updated_at = ${input.now}
          WHERE validation_id = ${input.id}
        `.pipe(Effect.mapError(sqlFail("setStatus.resume")));
        return { outcome: "ok" } as const;
      }

      // Pausing leaves `last_bar_time` where it is. It is only a marker of what
      // has been evaluated; the resume above is what moves it forward.
      yield* sql`
        UPDATE trading_thesis_validations
        SET status = ${input.to}, pending_entry_signal_time = NULL, updated_at = ${input.now}
        WHERE validation_id = ${input.id}
      `.pipe(Effect.mapError(sqlFail("setStatus.pause")));
      return { outcome: "ok" } as const;
    });

  /**
   * Settle an open paper fill, charging it the same costs a backtested trade
   * pays: taker plus crossing on both legs, and the archive's own funding over
   * the hours it was held.
   */
  const settleFill = (input: {
    readonly validation: ThesisValidation;
    readonly tradeId: string;
    readonly entryTime: number;
    readonly entryPrice: number;
    readonly exitTime: number;
    readonly exitPrice: number;
    readonly exitReason: string;
    readonly barsHeld: number;
    readonly adverseExcursionUsd: number;
    readonly now: number;
  }) =>
    Effect.gen(function* () {
      const { validation } = input;
      const long = validation.thesis.side === "long";
      const notionalUsd = validation.notionalUsd;
      const size = input.entryPrice > 0 ? notionalUsd / input.entryPrice : 0;
      const grossUsd =
        (long ? input.exitPrice - input.entryPrice : input.entryPrice - input.exitPrice) * size;
      const costBps = validation.costs.takerFeeBpsPerSide + validation.costs.slippageBpsPerSide;
      const feesUsd = (notionalUsd + size * input.exitPrice) * (costBps / 10_000);

      // Half-open on the entry, closed on the exit — the backtest's own
      // convention: a payment stamped at the entry belongs to whoever held the
      // position through the hour before it.
      const funding = yield* archive.fundingInWindow({
        coin: validation.asset,
        fromT: input.entryTime,
        toT: input.exitTime,
      });
      const rate = funding
        .filter((row) => row.time > input.entryTime && row.time <= input.exitTime)
        .reduce((sum, row) => sum + row.fundingRate, 0);
      const fundingUsd = (long ? -1 : 1) * rate * notionalUsd;

      yield* sql`
        UPDATE trading_thesis_paper_fills
        SET exit_time = ${input.exitTime}, exit_price = ${round4(input.exitPrice)},
            exit_reason = ${input.exitReason}, bars_held = ${input.barsHeld},
            gross_usd = ${round2(grossUsd)}, fees_usd = ${round2(feesUsd)},
            funding_usd = ${round2(fundingUsd)},
            net_usd = ${round2(grossUsd - feesUsd + fundingUsd)},
            adverse_excursion_usd = ${round2(input.adverseExcursionUsd)},
            updated_at = ${input.now}
        WHERE paper_trade_id = ${input.tradeId}
      `.pipe(Effect.mapError(sqlFail("settleFill")));
      // Returned rather than re-read: the exit event quotes the same number the
      // ledger row just took, and a second read could quote a different one.
      return round2(grossUsd - feesUsd + fundingUsd);
    });

  /**
   * Walk one validation over every archived bar it has not seen yet, and say
   * what happened on the way.
   *
   * The lines are collected here rather than derived afterwards from the
   * ledger because a catch-up pass can open and close the same trade inside
   * one call: after it, the ledger holds one settled row and no record that
   * both halves happened in this pass rather than in two.
   */
  const advance = (validation: ThesisValidation, now: number) =>
    Effect.gen(function* () {
      const events: Array<{ readonly kind: ValidationEventKind; readonly line: string }> = [];
      const quiet: AdvanceResult = { events, previousComparison: null };
      const interval = validation.interval as ArchiveInterval;
      const width = INTERVAL_MS[interval];
      if (width === undefined) return quiet;

      const warmup = forwardWarmupBars(validation.thesis);
      // Reach back far enough for every indicator to converge before the first
      // bar this pass will actually evaluate — which on the first pass is the
      // bar the validation was armed on, not the live edge.
      const evaluateFrom = validation.lastBarTime ?? validation.armedAt;
      const fromT = evaluateFrom - warmup * width;
      const rows = yield* archive
        .candlesInWindow({
          coin: validation.asset,
          interval,
          fromT,
          toT: now,
          maxBars: warmup + MAX_CATCHUP_BARS,
        })
        .pipe(Effect.mapError(sqlFail("advance.candles")));
      if (rows.length === 0) return quiet;

      const candles = rows.map(toCandle);
      // Only fetched when a rule actually reads it. A funding operand has to
      // resolve through the SAME stepwise lookup the batch engine uses, or a
      // validation would disagree with the backtest that armed it on the one
      // thing the comparison exists to measure.
      const signalFunding = thesisReadsFunding(validation.thesis)
        ? yield* archive
            .fundingInWindow({
              coin: validation.asset,
              fromT,
              toT: now,
            })
            .pipe(Effect.mapError(sqlFail("advance.funding")))
        : [];
      // Only bars that have closed. The archiver can store a forming bar, and
      // a rule read on one fires on numbers that are still moving.
      const closed = candles.filter((candle) => candle.closeTime <= now);
      if (closed.length === 0) return quiet;

      // The event calendar is re-read on EVERY sweep, not frozen at arm time:
      // a future occurrence is the whole point of arming early (the operand
      // reads undefined until the date passes, then the window opens on live
      // bars), and a date recorded mid-validation takes effect on the next
      // bar. The table is tiny; the freshness is not optional.
      const anchoredSets = thesisEventSets(validation.thesis);
      let eventOccurrences: ReadonlyArray<{ readonly eventSetId: string; readonly endAt: number }> =
        [];
      if (anchoredSets.length > 0) {
        const loaded = eventService.occurrencesFor(anchoredSets);
        eventOccurrences = yield* loaded;
      }

      // Bars this validation has not evaluated yet. On the first pass that is
      // every closed bar since it was armed: a bar that closed between arming
      // and the first delivery is one the thesis was live for, and skipping it
      // would quietly shorten the window the report is computed over.
      const lastSeen = validation.lastBarTime;
      const firstUnseen = closed.findIndex((candle) =>
        lastSeen === null ? candle.openTime >= validation.armedAt : candle.openTime > lastSeen,
      );
      if (firstUnseen < 0) return quiet;

      let state = validation.state;
      let barsWatched = validation.barsWatched;
      let lastBarTime = lastSeen;

      // Every ledger effect of every processed bar, plus the checkpoint, in
      // ONE transaction: a fill insert without its checkpoint is the exact
      // inconsistency a redelivery would double-count, and a checkpoint
      // without its fills would mark bars watched that nobody paid for. The
      // archive reads above stay outside the transaction; the checkpoint is
      // re-read inside it so a concurrent advance that committed first is
      // refused rather than raced past.
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const raced = yield* sql<{ readonly last_bar_time: number | null }>`
            SELECT last_bar_time FROM trading_thesis_validations
            WHERE validation_id = ${validation.id}
          `.pipe(Effect.mapError(sqlFail("advance.reread")));
            const checkpointNow = raced[0]?.last_bar_time ?? null;
            if (checkpointNow !== validation.lastBarTime) {
              // Die, not fail: the transaction rolls back either way, and a
              // defect says "this pass's premise is stale, deliver again" —
              // the next delivery re-reads the committed checkpoint and
              // continues from it, having double-counted nothing.
              return yield* Effect.die(
                `advance lost the checkpoint race for ${validation.id}: ` +
                  `${validation.lastBarTime} moved to ${checkpointNow} before commit`,
              );
            }

            for (let index = Math.max(firstUnseen, 0); index < closed.length; index += 1) {
              const bar = closed[index] as MarketCandle;
              const window = closed.slice(0, index + 1);
              // The trade id is DERIVED from the validation and the bar its
              // entry fills on, not minted: a crash between the fill insert and
              // the checkpoint replays the same bar, and the same bar must
              // produce the same id or the retry would mint a second logical
              // fill. `INSERT ... ON CONFLICT DO NOTHING` makes the replay a
              // no-op instead of a duplicate.
              const tradeId = `${validation.id}:${bar.openTime}`;
              const step = stepForward({
                thesis: validation.thesis,
                candles: window,
                state,
                notionalUsd: validation.notionalUsd,
                nextTradeId: tradeId,
                funding: signalFunding,
                eventOccurrences,
              });

              if (step.entered !== null) {
                yield* sql`
                INSERT INTO trading_thesis_paper_fills (
                  paper_trade_id, validation_id, entry_time, entry_price, signal_time,
                  stop_price, target_price, exit_time, exit_price, exit_reason,
                  bars_held, gross_usd, fees_usd, funding_usd, net_usd,
                  adverse_excursion_usd, created_at, updated_at
                ) VALUES (
                  ${tradeId}, ${validation.id}, ${step.entered.entryTime},
                  ${round4(step.entered.entryPrice)}, ${step.entered.signalTime},
                  ${step.entered.stopPrice === null ? null : round4(step.entered.stopPrice)},
                  ${step.entered.targetPrice === null ? null : round4(step.entered.targetPrice)},
                  NULL, NULL, NULL, 1, NULL, NULL, NULL, NULL, 0, ${now}, ${now}
                )
                ON CONFLICT(paper_trade_id) DO NOTHING
              `.pipe(Effect.mapError(sqlFail("advance.enter")));
                events.push({
                  kind: "paper_entry",
                  line: describePaperEntry({
                    market: validation.asset,
                    direction: validation.thesis.side,
                    price: round4(step.entered.entryPrice),
                  }),
                });
              }

              // One bar can close TWO trades (a pending exit at the open plus a
              // same-bar stop on a position entered at that same open). Every
              // settlement is persisted, in the causal order the engine
              // produced; dropping all but the last was the ledger defect.
              for (const exit of step.exits) {
                const netUsd = yield* settleFill({
                  validation,
                  tradeId: exit.tradeId,
                  entryTime: exit.entryTime,
                  entryPrice: exit.entryPrice,
                  exitTime: exit.exitTime,
                  exitPrice: exit.exitPrice,
                  exitReason: exit.exitReason,
                  barsHeld: exit.barsHeld,
                  adverseExcursionUsd: exit.adverseExcursionUsd,
                  now,
                });
                events.push({
                  kind: "paper_exit",
                  line: describePaperExit({
                    market: validation.asset,
                    direction: validation.thesis.side,
                    price: round4(exit.exitPrice),
                    netUsd,
                    reason: exit.exitReason,
                  }),
                });
              }

              state = step.state;
              barsWatched += 1;
              lastBarTime = bar.openTime;
            }

            // The open position's running bar count and excursion live on its
            // own ledger row, so the report reads one place for it.
            if (state.open !== null) {
              yield* sql`
              UPDATE trading_thesis_paper_fills
              SET bars_held = ${state.open.barsHeld},
                  adverse_excursion_usd = ${round2(state.open.adverseExcursionUsd)},
                  updated_at = ${now}
              WHERE paper_trade_id = ${state.open.id} AND exit_time IS NULL
            `.pipe(Effect.mapError(sqlFail("advance.openTrade")));
            }

            yield* sql`
            UPDATE trading_thesis_validations
            SET bars_watched = ${barsWatched},
                pending_entry_signal_time = ${state.pendingEntrySignalTime},
                pending_exit_reason = ${state.pendingExitReason},
                last_bar_time = ${lastBarTime},
                updated_at = ${now}
            WHERE validation_id = ${validation.id}
          `.pipe(Effect.mapError(sqlFail("advance.state")));
          }),
        )
        .pipe(Effect.mapError(sqlFail("advance.transaction")));

      // The verdict, taken after the writes above so it reads the same ledger
      // the next `report` will. A validation whose label has never been
      // recorded is not reported as having changed: its FIRST reading is a
      // reading, not news, and every validation armed before migration 085 has
      // no previous one.
      const comparison = (yield* report({ id: validation.id, now }))?.comparison ?? null;
      let previousComparison: ForwardComparison | null = null;
      if (comparison !== null && comparison !== validation.lastComparison) {
        if (validation.lastComparison !== null) {
          previousComparison = validation.lastComparison;
          events.push({
            kind: "verdict_change",
            line: describeVerdictChange({ from: validation.lastComparison, to: comparison }),
          });
        }
        yield* sql`
          UPDATE trading_thesis_validations
          SET last_comparison = ${comparison}, updated_at = ${now}
          WHERE validation_id = ${validation.id}
        `.pipe(Effect.mapError(sqlFail("advance.comparison")));
      }

      return { events, previousComparison } satisfies AdvanceResult;
    });

  /**
   * One validation's batch, or null when the pass produced nothing worth
   * waking anyone for. Composed here so the candle path and the expiry path
   * cannot describe the same events two different ways.
   */
  const toEventBatch = (input: {
    readonly validation: ThesisValidation;
    readonly advanced: AdvanceResult;
    readonly extra?: { readonly kind: ValidationEventKind; readonly line: string } | undefined;
    readonly now: number;
  }) =>
    Effect.gen(function* () {
      const all = [...input.advanced.events, ...(input.extra === undefined ? [] : [input.extra])];
      if (all.length === 0) return null;
      const final = yield* report({ id: input.validation.id, now: input.now });
      if (final === null) return null;
      // Deduplicated in first-occurrence order: a catch-up pass that took three
      // trades has three lines and one `paper_entry`.
      const kinds: Array<ValidationEventKind> = [];
      for (const event of all) if (!kinds.includes(event.kind)) kinds.push(event.kind);
      return {
        validationId: input.validation.id,
        hypothesisId: input.validation.hypothesisId,
        threadId: input.validation.threadId,
        market: input.validation.asset,
        interval: input.validation.interval,
        label: final.headline,
        occurredAt: input.now,
        kinds,
        lines: all.map((event) => event.line),
        comparison: final.comparison,
        ...(input.advanced.previousComparison === null
          ? {}
          : { previousComparison: input.advanced.previousComparison }),
        tradesTaken: final.stats.tradesTaken,
        netUsd: final.stats.totalNetUsd,
      } satisfies ValidationEventBatch;
    });

  const onClosedBar: TradingThesisValidationServiceShape["onClosedBar"] = (input) =>
    Effect.gen(function* () {
      const rows = yield* sql<ValidationRow>`
        SELECT * FROM trading_thesis_validations
        WHERE status = 'armed' AND asset = ${input.asset} AND interval = ${input.interval}
      `.pipe(Effect.mapError(sqlFail("onClosedBar")));
      const batches: Array<ValidationEventBatch> = [];
      for (const row of rows) {
        const validation = yield* hydrate(row);
        const advanced = yield* advance(validation, input.now);
        const batch = yield* toEventBatch({ validation, advanced, now: input.now });
        if (batch !== null) batches.push(batch);
      }
      return batches;
    });

  const report: TradingThesisValidationServiceShape["report"] = (input) =>
    Effect.gen(function* () {
      const validation = yield* get(input.id);
      if (validation === null) return null;
      const all = yield* trades(input.id);
      return composeReport(validation, all);
    });

  const expireDue: TradingThesisValidationServiceShape["expireDue"] = (input) =>
    Effect.gen(function* () {
      const rows = yield* sql<ValidationRow>`
        SELECT * FROM trading_thesis_validations
        WHERE status IN ('armed', 'paused') AND expires_at <= ${input.now}
      `.pipe(Effect.mapError(sqlFail("expireDue")));

      const reports: Array<ForwardReport> = [];
      const events: Array<ValidationEventBatch> = [];
      for (const row of rows) {
        // Evaluate the last bars before ending, so the final report covers the
        // whole window rather than stopping wherever the last delivery landed.
        const live = yield* hydrate(row);
        const advanced =
          live.status === "armed"
            ? yield* advance(live, input.now)
            : ({ events: [], previousComparison: null } satisfies AdvanceResult);
        yield* sql`
          UPDATE trading_thesis_validations
          SET status = 'ended', ended_at = ${input.now}, end_reason = 'expired',
              updated_at = ${input.now}
          WHERE validation_id = ${row.validation_id}
        `.pipe(Effect.mapError(sqlFail("expireDue.end")));
        const final = yield* report({ id: row.validation_id, now: input.now });
        if (final !== null) reports.push(final);
        // The expiry itself is always an event, even on a validation that took
        // nothing: "the window closed and here is what it showed" is the whole
        // point of having watched. Composed against the ENDED row so the batch
        // reports the same verdict the final report does.
        const ended = yield* get(row.validation_id);
        const batch =
          ended === null
            ? null
            : yield* toEventBatch({
                validation: ended,
                advanced,
                extra: {
                  kind: "expiry",
                  line: `validation window closed after ${ended.barsWatched} bars`,
                },
                now: input.now,
              });
        if (batch !== null) events.push(batch);
      }
      return { reports, events };
    });

  const forChart: TradingThesisValidationServiceShape["forChart"] = (input) =>
    Effect.gen(function* () {
      const rows = yield* sql<ValidationRow>`
        SELECT * FROM trading_thesis_validations
        WHERE status IN ('armed', 'paused') AND asset = ${input.asset}
        ORDER BY armed_at DESC LIMIT 1
      `.pipe(Effect.mapError(sqlFail("forChart")));
      const row = rows[0];
      if (row === undefined) return null;
      const validation = yield* hydrate(row);
      return { validation, trades: yield* trades(validation.id) };
    });

  const knownIds: TradingThesisValidationServiceShape["knownIds"] = (ids) =>
    ids.length === 0
      ? Effect.succeed(new Set<string>())
      : sql<{ readonly validation_id: string }>`
          SELECT validation_id FROM trading_thesis_validations
          WHERE validation_id IN ${sql.in(ids)}
        `.pipe(
          Effect.mapError(sqlFail("knownIds")),
          Effect.map((rows) => new Set(rows.map((row) => row.validation_id))),
        );

  return {
    arm,
    list,
    get,
    knownIds,
    setStatus,
    trades,
    report,
    onClosedBar,
    expireDue,
    forChart,
    setBaseline,
  } satisfies TradingThesisValidationServiceShape;
});

/**
 * The report, composed from a validation and its ledger.
 *
 * Exported and pure so the shape can be tested without a database, and so the
 * expiry path and the on-demand path cannot compose two different reports.
 */
export function composeReport(
  validation: ThesisValidation,
  all: ReadonlyArray<PaperTrade>,
): ForwardReport {
  const settled = all
    .map(settledAsBacktestTrade)
    .filter((trade): trade is NonNullable<typeof trade> => trade !== null);
  const open = all.find((trade) => trade.exitTime === null) ?? null;

  const stats = summarizeTrades({
    trades: settled,
    setupsFound: all.length,
    setupsUnpriced: 0,
    bars: validation.barsWatched,
    // Buy-and-hold is a backtest comparison over a closed window. A forward
    // run's window is still open, so quoting one would be a return on a
    // position nobody could have closed. Left at zero and not shown.
    buyAndHoldNetUsd: 0,
    buyAndHoldReturnPercent: 0,
  });

  const { comparison, verdictReason } = judgeForward({
    stats,
    baselineExpectancyUsd: validation.baseline?.expectancyUsd ?? null,
    baselineTradesTaken: validation.baseline?.tradesTaken ?? null,
    barsWatched: validation.barsWatched,
    hasOpenTrade: open !== null,
    status: validation.status,
  });

  return {
    validationId: validation.id,
    thesis: validation.thesis,
    headline: validation.label ?? describeThesis(validation.thesis),
    status: validation.status,
    armedAt: validation.armedAt,
    expiresAt: validation.expiresAt,
    endedAt: validation.endedAt,
    endReason: validation.endReason,
    notionalUsd: validation.notionalUsd,
    barsWatched: validation.barsWatched,
    stats,
    openTrade: open,
    baselineExpectancyUsd: validation.baseline?.expectancyUsd ?? null,
    baselineWinRatePercent: validation.baseline?.winRatePercent ?? null,
    baselineTradesTaken: validation.baseline?.tradesTaken ?? null,
    comparison,
    verdictReason,
    paperOnly: true,
  };
}

export const TradingThesisValidationServiceLive: Layer.Layer<
  TradingThesisValidationService,
  never,
  TradingMarketArchive | SqlClient.SqlClient | Crypto.Crypto | TradingEventService
> = Layer.effect(TradingThesisValidationService, makeTradingThesisValidationService);
