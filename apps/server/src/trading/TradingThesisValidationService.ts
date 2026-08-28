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
 * Not by policy — by construction. This service depends on the market archive
 * and the SQL client, and on nothing else. `TradingEntryService`,
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
} from "@t3tools/trading-contracts/forward";
import type { MarketCandle } from "@t3tools/trading-contracts/market";
import { describeThesis, validateThesis, TradingThesis } from "@t3tools/trading-contracts/thesis";

import { toPersistenceSqlError, type PersistenceSqlError } from "../persistence/Errors.ts";
import { INTERVAL_MS, type ArchiveInterval } from "./archive/config.ts";
import type { CandleRow } from "./archive/candles.ts";
import { DEFAULT_TRADING_VENUE, type TradingVenue } from "./Schemas.ts";
import { halfSpreadBps } from "./TradingBacktestService.ts";
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
}

export type ArmValidationResult =
  | { readonly outcome: "armed"; readonly validation: ThesisValidation }
  | { readonly outcome: "refused"; readonly reason: string };

export interface TradingThesisValidationServiceShape {
  readonly arm: (input: {
    readonly thesis: TradingThesis;
    readonly durationMs: number;
    readonly label?: string | undefined;
    readonly threadId?: string | undefined;
    readonly notionalUsd?: number | undefined;
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
  }) => Effect.Effect<void, PersistenceSqlError>;

  /**
   * End every validation whose clock has run out, and return the final report
   * for each so the caller can deliver it.
   */
  readonly expireDue: (input: {
    readonly now: number;
  }) => Effect.Effect<ReadonlyArray<ForwardReport>, PersistenceSqlError>;

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

export const makeTradingThesisValidationService = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const archive = yield* TradingMarketArchive;

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
        costs: JSON.parse(row.costs_json) as BacktestCosts,
        baseline:
          row.baseline_json === null ? null : (JSON.parse(row.baseline_json) as BacktestStats),
        barsWatched: row.bars_watched,
        state: toForwardState(row, open[0]),
        lastBarTime: row.last_bar_time,
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
      const invalid = validateThesis(input.thesis);
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
      const existing = yield* sql<{ readonly validation_id: string }>`
        SELECT validation_id FROM trading_thesis_validations
        WHERE status IN ('armed', 'paused') AND asset = ${input.thesis.market}
          AND interval = ${input.thesis.interval}
      `.pipe(Effect.mapError(sqlFail("arm.existing")));
      if (existing.length > 0) {
        return {
          outcome: "refused",
          reason:
            `${input.thesis.market} ${input.thesis.interval} is already being validated. ` +
            "End that one first, or validate this idea on another interval",
        } as const;
      }

      const id = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
      const now = input.now;
      const notionalUsd = input.notionalUsd ?? DEFAULT_PAPER_NOTIONAL_USD;
      const costs = yield* measureCosts(input.thesis.market);

      yield* sql`
        INSERT INTO trading_thesis_validations (
          validation_id, thread_id, venue, asset, interval, thesis_json, label,
          status, armed_at, expires_at, ended_at, end_reason, notional_usd,
          costs_json, baseline_json, bars_watched, pending_entry_signal_time,
          pending_exit_reason, last_bar_time, created_at, updated_at
        ) VALUES (
          ${id}, ${input.threadId ?? null}, ${DEFAULT_TRADING_VENUE}, ${input.thesis.market},
          ${input.thesis.interval}, ${encodeThesisJson(input.thesis)}, ${input.label ?? null},
          'armed', ${now}, ${now + input.durationMs}, NULL, NULL, ${notionalUsd},
          ${JSON.stringify(costs)}, NULL, 0, NULL, NULL, NULL, ${now}, ${now}
        )
      `.pipe(Effect.mapError(sqlFail("arm.insert")));

      const validation = yield* get(id);
      return validation === null
        ? ({ outcome: "refused", reason: "the validation could not be read back" } as const)
        : ({ outcome: "armed", validation } as const);
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
    });

  /** Walk one validation over every archived bar it has not seen yet. */
  const advance = (validation: ThesisValidation, now: number) =>
    Effect.gen(function* () {
      const interval = validation.interval as ArchiveInterval;
      const width = INTERVAL_MS[interval];
      if (width === undefined) return;

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
      if (rows.length === 0) return;

      const candles = rows.map(toCandle);
      // Only bars that have closed. The archiver can store a forming bar, and
      // a rule read on one fires on numbers that are still moving.
      const closed = candles.filter((candle) => candle.closeTime <= now);
      if (closed.length === 0) return;

      // Bars this validation has not evaluated yet. On the first pass that is
      // every closed bar since it was armed: a bar that closed between arming
      // and the first delivery is one the thesis was live for, and skipping it
      // would quietly shorten the window the report is computed over.
      const lastSeen = validation.lastBarTime;
      const firstUnseen = closed.findIndex((candle) =>
        lastSeen === null ? candle.openTime >= validation.armedAt : candle.openTime > lastSeen,
      );
      if (firstUnseen < 0) return;

      let state = validation.state;
      let barsWatched = validation.barsWatched;
      let lastBarTime = lastSeen;

      for (let index = Math.max(firstUnseen, 0); index < closed.length; index += 1) {
        const window = closed.slice(0, index + 1);
        const tradeId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
        const step = stepForward({
          thesis: validation.thesis,
          candles: window,
          state,
          notionalUsd: validation.notionalUsd,
          nextTradeId: tradeId,
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
          `.pipe(Effect.mapError(sqlFail("advance.enter")));
        }

        if (step.exited !== null) {
          yield* settleFill({
            validation,
            tradeId: step.exited.tradeId,
            entryTime: step.exited.entryTime,
            entryPrice: step.exited.entryPrice,
            exitTime: step.exited.exitTime,
            exitPrice: step.exited.exitPrice,
            exitReason: step.exited.exitReason,
            barsHeld: step.exited.barsHeld,
            adverseExcursionUsd: step.exited.adverseExcursionUsd,
            now,
          });
        }

        state = step.state;
        barsWatched += 1;
        lastBarTime = (closed[index] as MarketCandle).openTime;
      }

      // The open position's running bar count and excursion live on its own
      // ledger row, so the report reads one place for it.
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
    });

  const onClosedBar: TradingThesisValidationServiceShape["onClosedBar"] = (input) =>
    Effect.gen(function* () {
      const rows = yield* sql<ValidationRow>`
        SELECT * FROM trading_thesis_validations
        WHERE status = 'armed' AND asset = ${input.asset} AND interval = ${input.interval}
      `.pipe(Effect.mapError(sqlFail("onClosedBar")));
      for (const row of rows) {
        const validation = yield* hydrate(row);
        yield* advance(validation, input.now);
      }
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
      for (const row of rows) {
        // Evaluate the last bars before ending, so the final report covers the
        // whole window rather than stopping wherever the last delivery landed.
        const live = yield* hydrate(row);
        if (live.status === "armed") yield* advance(live, input.now);
        yield* sql`
          UPDATE trading_thesis_validations
          SET status = 'ended', ended_at = ${input.now}, end_reason = 'expired',
              updated_at = ${input.now}
          WHERE validation_id = ${row.validation_id}
        `.pipe(Effect.mapError(sqlFail("expireDue.end")));
        const final = yield* report({ id: row.validation_id, now: input.now });
        if (final !== null) reports.push(final);
      }
      return reports;
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

  return {
    arm,
    list,
    get,
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
  TradingMarketArchive | SqlClient.SqlClient | Crypto.Crypto
> = Layer.effect(TradingThesisValidationService, makeTradingThesisValidationService);
