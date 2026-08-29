/**
 * Harness-facing trading tools - spec §14.3.
 *
 * These ride the existing upstream MCP boundary: the first-party MCP server in
 * `apps/server`, reached with the per-session bearer credential every provider
 * adapter already injects as `t3-trade`. There is no second transport and no
 * per-harness MCP configuration.
 *
 * Every schema here is imported from `@t3tools/trading-contracts/tools`; none
 * is redeclared.
 *
 * @module TradingToolkitTools
 */
import {
  TradingGetPlaybookInput,
  TradingPublishPlanInput,
  TradingPublishPlanResult,
  TradingWatchInput,
  TradingWatchResult,
  TradingExitResult,
  TradingEnterResult,
  TradingToolRejectedError,
} from "@t3tools/trading-contracts/tools";
import { TradingLookInput, TradingObservation } from "@t3tools/trading-contracts/observation";
import { TradingBacktestInput, TradingBacktestResult } from "@t3tools/trading-contracts/backtest";
import { TradingValidateInput, TradingValidateResult } from "@t3tools/trading-contracts/forward";
import {
  TradingHypothesisInput,
  TradingHypothesisResult,
} from "@t3tools/trading-contracts/hypothesis";
import { TradingEnterInput } from "@t3tools/trading-contracts/entry";
import { TradingExitInput } from "@t3tools/trading-contracts/exit";
import { Playbook } from "@t3tools/trading-contracts/playbook";
import { TradingJournalInput, TradingJournalResult } from "@t3tools/trading-contracts/journal";
import * as Crypto from "effect/Crypto";
import { Tool, Toolkit } from "effect/unstable/ai";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { TradingCostEstimator } from "../../../trading/TradingCostEstimator.ts";
import { TradingCalibrationService } from "../../../trading/TradingCalibrationService.ts";
import { TradingTradeHistoryService } from "../../../trading/TradingTradeHistoryService.ts";
import { TradingExecutionOutcome } from "../../../trading/TradingExecutionOutcome.ts";
import { TradingMissionService } from "../../../trading/TradingMissionService.ts";
import { TradingExitService } from "../../../trading/TradingExitService.ts";
import { TradingPlanProtectionService } from "../../../trading/TradingPlanProtectionService.ts";
import { TradingWorkingOrderService } from "../../../trading/TradingWorkingOrderService.ts";
import { TradingEntryService } from "../../../trading/TradingEntryService.ts";
import { TradingStrategyService } from "../../../trading/TradingStrategyService.ts";
import { TradingStopAdjustmentService } from "../../../trading/TradingStopAdjustmentService.ts";
import { TradingWatchService } from "../../../trading/TradingWatchService.ts";
import { TradingJournalService } from "../../../trading/TradingJournalService.ts";
import { TradingWakeupComposer } from "../../../trading/TradingWakeupComposer.ts";
import { TradingEventInbox } from "../../../trading/TradingEventInbox.ts";
import { TradingMarketArchive } from "../../../trading/TradingMarketArchive.ts";
import { TradingAlertService } from "../../../trading/TradingAlertService.ts";
import { HyperliquidGateway } from "@t3tools/hyperliquid/Gateway";
import { ProviderRegistry } from "../../../provider/Services/ProviderRegistry.ts";
import { TradingTurnCoordinator } from "../../../trading/TradingTurnCoordinator.ts";
import { TradingThreadMarketService } from "../../../trading/TradingThreadMarketService.ts";
import { TradingBacktestService } from "../../../trading/TradingBacktestService.ts";
import { TradingThesisValidationService } from "../../../trading/TradingThesisValidationService.ts";
import { TradingHypothesisService } from "../../../trading/TradingHypothesisService.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  TradingMissionService,
  TradingStrategyService,
  // `trading_watch` arms and retires through the watch service.
  TradingWatchService,
  // An accepted publish or watch change is announced on the orchestration event
  // stream so the workspace sees it over the ordered WS push path.
  OrchestrationEngineService,
  Crypto.Crypto,
  // `trading_look` reaches Hyperliquid through the gateway.
  HyperliquidGateway,
  // `trading_look` prices its cost line from the live fee rate and book.
  TradingCostEstimator,
  // `trading_look` reads the mission's own completed orders.
  TradingTradeHistoryService,
  // `trading_look` grades the mission's published targets against those
  // trades — the retired calibration tool's read, off the hot path.
  TradingCalibrationService,
  // `trading_enter` reports what the reactor actually did with the request,
  // not that the request was raised.
  TradingExecutionOutcome,
  // `trading_exit`'s `move_stop` measures the mission before it moves the stop.
  TradingStopAdjustmentService,
  // `trading_enter` prices, sizes and pre-checks the entry it then submits.
  TradingEntryService,
  // `trading_exit` sizes itself from the canonical position.
  TradingExitService,
  // An accepted publish reconciles the exchange's stop and target to the plan
  // (plan 29 step 4.5) and retracts the mission's resting working entries.
  TradingPlanProtectionService,
  TradingWorkingOrderService,
  // `trading_look` is the composer's gather step, returned rather than
  // rendered (plan 29 step 6.1).
  TradingWakeupComposer,
  // `trading_look`'s `events` fetch key peeks the pending tail without
  // claiming it (plan 38 §2.2).
  TradingEventInbox,
  // `trading_look`'s archive-backed fetch keys read funding, OI/premium and
  // book history from the market archive (plan 38 §2.4).
  TradingMarketArchive,
  // `trading_journal` appends to and reads back the mission's memory.
  TradingJournalService,
  // An analyst session's `trading_watch` arms account-scoped notify alerts
  // (final-form Phase 8) — no mission anywhere near them.
  TradingAlertService,
  // Bind-on-first-use: `trading_plan` and `trading_enter` take authority on the
  // market they name when this thread holds none, which needs the provider the
  // credential belongs to (the frozen §10.2 harness binding) and the decision
  // lease for the chat turn already in flight.
  ProviderRegistry,
  TradingTurnCoordinator,
  // Which market this thread is about, so the panel beside the chat follows
  // the conversation. Written by `trading_look` and by taking authority.
  TradingThreadMarketService,
  // `trading_backtest` walks the market archive and nothing else. It is the
  // only tool here with no path to an order.
  TradingBacktestService,
  // `trading_validate` writes the paper ledger and nothing else. Same claim,
  // and the same absence of a dependency behind it.
  TradingThesisValidationService,
  // `trading_hypothesis` writes the idea record and reads the paper ledger for
  // the lineage. Same absence of a dependency again: SQL and Crypto.
  TradingHypothesisService,
  SqlClient.SqlClient,
];

export const TradingLookTool = Tool.make("trading_look", {
  description:
    "The one read. `fetch[]` names catalog keys at published sizes — snapshot, book, microstructure, candles:tf:n, indicators:spec (ema20 rsi14 atr14 macd bollinger20), volatility(_htf), structure (scored `candidates[]`), structure_brief, levels, position (flat is size 0), position_costs, orders, account, plan, watches, events, journal, trades, calibration, plan_history, cost (context, never a gate), funding/oi/book/scan archive keys. Menu: trading_look({})",
  parameters: TradingLookInput,
  success: TradingObservation,
  failure: TradingToolRejectedError,
  dependencies,
})
  .annotate(Tool.Title, "Look")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

export const TradingPlanTool = Tool.make("trading_plan", {
  description:
    'Publish the plan: market, intent, entry, stop, target, invalidation, reassess, projection, because. `projection` is the prediction, never omitted: {direction, price, zone?, byMinutes, invalidationPrice} — where the read is WRONG, not your stop. Publishing arms its horizon+invalidation wakes; the next retires only those. Declining is intent "stand_aside". Derive the target off measured volatility. `expectedMissionVersion` from trading_look; stale is rejected. Your watches survive a revision.',
  parameters: TradingPublishPlanInput,
  success: TradingPublishPlanResult,
  failure: TradingToolRejectedError,
  dependencies,
})
  .annotate(Tool.Title, "Plan")
  .annotate(Tool.Readonly, false)
  // Publishing revises the mission's state (and the plan the exchange is
  // reconciled to), so it is not a repeatable no-op.
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

// -- §14.4 watch tools (Phase 3) ---------------------------------------------

export const TradingWatchTool = Tool.make("trading_watch", {
  description:
    'Arm one `condition` — `price` (`confirm: "close"` needs an `interval`, else touch), `metric` (funding_rate_8h (rate not %), open_interest, spread_bps, volume_ratio vs a value), `derived` (archive metrics; menu: trading_look({})), `pnl`, `giveback`, `fill`, `time` (clock fallback) — or retire with `cancel`. Fires once, terminal — re-arm to keep it. `replacesWatchId` swaps in one transaction; if it already fired, the arm is an ADDITION. A refusal changes nothing; `recovery` says what to do.',
  parameters: TradingWatchInput,
  success: TradingWatchResult,
  failure: TradingToolRejectedError,
  dependencies,
})
  .annotate(Tool.Title, "Watch")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const TradingJournalTool = Tool.make("trading_journal", {
  description:
    "Append one `note` to the mission's memory; omit `note` to read it back. Append-only — a note survives the plan revisions that overwrite `because`, so write what will still matter next turn: a level that chopped you, a read you are waiting on. Every call returns `entries`, newest first.",
  parameters: TradingJournalInput,
  success: TradingJournalResult,
  failure: TradingToolRejectedError,
  dependencies,
})
  .annotate(Tool.Title, "Journal")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  // A second identical call appends a second note. Reading (no `note`) is
  // idempotent, but the annotation describes the tool, not the branch.
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const TradingEnterTool = Tool.make("trading_enter", {
  description:
    "Enter in one call: name the market, the side and your stop; the server derives the limit, the precision, the versions, the lease, and the largest size every risk ceiling allows — the approved trade — pre-checks it, and sends it. Omit the size for that ceiling; too large comes back smaller with `constrainedBy`. `urgency` defaults to `now` (cross); `patient` rests at the near side and the server works it. Refuses stops inside the noise floor. `notes` is what is true of it but does not stop it.",
  parameters: TradingEnterInput,
  success: TradingEnterResult,
  failure: TradingToolRejectedError,
  dependencies,
})
  .annotate(Tool.Title, "Enter")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  // Deliberately NOT idempotent: with the quote token retired there is nothing
  // for a second call to replay, so it allocates a fresh sequence, derives a
  // fresh cloid, and is a second trade. Saying otherwise would invite exactly
  // the double entry the annotation is supposed to prevent.
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const TradingStrategyTool = Tool.make("trading_strategy", {
  description:
    "Read one named strategy — a playbook, never an indicator. Each returns whenItApplies (the setup it is for), procedure[] (ordered steps), gates[] (must clear before entry), standDownIf[] (retire a setup). Check your candidates against these for fit at every assessment and reassessment, and rank them; an indicator reading is evidence inside a strategy, not one. In discretionary mode this is reference; when trading_look reports mode execute_strategy it is the decision procedure for the named one.",
  parameters: TradingGetPlaybookInput,
  success: Playbook,
  failure: TradingToolRejectedError,
  dependencies,
})
  .annotate(Tool.Title, "Strategy")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const TradingExitTool = Tool.make("trading_exit", {
  description:
    'One `action`. `close` flattens the position, no size or side. `reduce` takes part off by `sizeEth` or `fraction`, closing if the rest is dust. `cancel_order` cancels a resting order by `cloid`. `move_stop` trails the stop in policy (never past the approved stop, bounded steps, outside the noise floor, never below entry, rate-limited) and needs `expectedPlanUpdatedAt` from trading_look. `release_market` hands one held market back once flat. `urgency: "patient"` rests. A refusal sends nothing.',
  parameters: TradingExitInput,
  success: TradingExitResult,
  failure: TradingToolRejectedError,
  dependencies,
})
  .annotate(Tool.Title, "Exit")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  // `cancel_order` and `move_stop` are repeatable no-ops; `close` and `reduce`
  // are not. The annotation describes the tool, so it takes the stricter half.
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const TradingBacktestTool = Tool.make("trading_backtest", {
  description:
    "Research one `thesis` over archived bars. Never places an order. `thesis` = market, interval, side, an `entry` condition (comparisons plus match all/any), and `exits` (stop, target, maxHoldBars, opposite) — at least one. Signals read closed bars and fill at the NEXT bar open; every trade pays taker fees both sides, crossing, and archived funding. Returns expectancy after fees, win rate, drawdown, buy-and-hold, and coverage. Under 20 trades there is no verdict. Vocabulary: trading_backtest({})",
  parameters: TradingBacktestInput,
  success: TradingBacktestResult,
  failure: TradingToolRejectedError,
  dependencies,
})
  .annotate(Tool.Title, "Backtest")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  // The archive grows, so the same thesis run tomorrow reads more bars. That
  // is an open world even though nothing here leaves the machine.
  .annotate(Tool.OpenWorld, true);

export const TradingValidateTool = Tool.make("trading_validate", {
  description:
    "Validate a thesis forward on live bars, on paper. Never places an order. `arm` a `thesis` (trading_backtest's shape) with `durationHours`; every closed bar is evaluated and the trades it would have taken are recorded at real fees. Also `list` `pause` `resume` `end` `report`. `report` gives trades, hit rate, after-fee expectancy, drawdown and how it compares to the backtest that armed it; expiry reports itself. To trade a validated idea, plan and enter as normal. Menu: trading_validate({})",
  parameters: TradingValidateInput,
  success: TradingValidateResult,
  failure: TradingToolRejectedError,
  dependencies,
})
  .annotate(Tool.Title, "Validate")
  // Arming, pausing and ending write. The annotation describes the tool, so it
  // takes the writing half even though `list` and `report` are pure reads.
  .annotate(Tool.Readonly, false)
  // Nothing here can lose money. The paper ledger is the only thing it writes,
  // and no surface that reports real money reads it.
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  // Live bars keep arriving, so the same report read twice differs.
  .annotate(Tool.OpenWorld, true);

export const TradingHypothesisTool = Tool.make("trading_hypothesis", {
  description:
    "The durable record of an idea, so refinement has a history. `save` {title, thesis} files it as v1; `revise` {hypothesisId, thesis, note} writes the next version and reopens a concluded one. Pass `hypothesisId` ALONE to trading_backtest or trading_validate arm and it runs that idea's current version, filed against it. `show` gives versions, runs and validations together; also `list` `shelve` `conclude` {verdict, conclusion}. Never places an order. Menu: trading_hypothesis({})",
  parameters: TradingHypothesisInput,
  success: TradingHypothesisResult,
  failure: TradingToolRejectedError,
  dependencies,
})
  .annotate(Tool.Title, "Hypothesis")
  // `save`, `revise`, `shelve` and `conclude` write. The annotation describes
  // the tool, so it takes the writing half.
  .annotate(Tool.Readonly, false)
  // Three research tables and nothing else. No surface that reports real money
  // reads any of them.
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  // Runs and validations keep landing against a filed idea, so the same `show`
  // read twice differs.
  .annotate(Tool.OpenWorld, true);

export const TradingToolkit = Toolkit.make(
  TradingLookTool,
  TradingPlanTool,
  TradingStrategyTool,
  TradingWatchTool,
  TradingJournalTool,
  TradingEnterTool,
  TradingExitTool,
  TradingBacktestTool,
  TradingValidateTool,
  TradingHypothesisTool,
);
