/**
 * Server-side re-exports of the trading domain contracts.
 *
 * Every trading module inside apps/server imports its schemas from here rather
 * than reaching into @t3tools/trading-contracts directly, so the server has one
 * place where the contract surface it depends on is visible.
 *
 * @module TradingSchemas
 */
export {
  TradingAccount,
  TradingAccountStatus,
  TradingEnvironment,
  TradingExecutionWallet,
  TradingExecutionWalletStatus,
  TradingMasterWallet,
} from "@t3tools/trading-contracts/account";

export {
  pocAuthorityDefaults,
  pocRiskPolicyDefaults,
  TradingAuthority,
  TradingAuthorityValidUntil,
  TradingCapitalSource,
  TradingDirection,
  TradingMarginMode,
  TradingRiskPolicy,
} from "@t3tools/trading-contracts/authority";

export {
  MissionInboxEvent,
  MissionInboxEventCategory,
  MissionInboxEventStatus,
} from "@t3tools/trading-contracts/events";

export {
  TradingHarnessBinding,
  TradingHarnessRun,
  TradingHarnessRunCause,
  TradingHarnessRunStatus,
  TradingHarnessStatus,
  TradingMission,
  TradingMissionBlockedReason,
  TradingMissionControl,
  TradingMissionStatus,
  TradingProvider,
} from "@t3tools/trading-contracts/mission";

export {
  DEFAULT_TRADING_VENUE,
  EvmAddress,
  MarketRef,
  Price,
  TradingId,
  TradingMarket,
  TradingText,
  TradingVenue,
  UnixMillis,
  UsdAmount,
} from "@t3tools/trading-contracts/primitives";

export {
  AgentConditionDescription,
  TradingPlanEntry,
  TradingPlanIntent,
  TradingPlanState,
  TradingPlanStop,
  TradingPlanTarget,
  TradingTimeframe,
  planPhase,
} from "@t3tools/trading-contracts/strategy";

export {
  measureVolatility,
  ObservedVolatility,
  VOLATILITY_LOOKBACK_BARS,
  VolatilityHorizon,
} from "@t3tools/trading-contracts/volatility";

export {
  PublishTradingPlanBody,
  PublishTradingPlanRejection,
  TRADING_PLAN_TOOL,
  TradingBoundMissionResult,
  TradingGetMissionInput,
  TradingGetMissionResult,
  TradingPendingExecution,
  TradingUnboundMissionResult,
  TradingPublishPlanInput,
  TradingPublishPlanResult,
  TradingToolRejectedError,
  TradingToolRejectionReason,
} from "@t3tools/trading-contracts/tools";

export {
  findMisarmedEntryConditions,
  findUnarmedEntryConditions,
  isWatchRefusal,
  MarketWatch,
  MisarmedEntryCondition,
  PersistedWatch,
  PersistedWatchStatus,
  toMarketWatch,
  toWatchCondition,
  TradingWatchDeliver,
  TradingWatchRearm,
  UnarmedEntryCondition,
  WatchArmedReason,
  WatchCondition,
} from "@t3tools/trading-contracts/watch";

export {
  describeArmedWatch,
  describeArmedWatchLine,
  describePositionCostLine,
  describeTriggeringWatchLine,
  describeWorkingEntryLine,
  HarnessRunRequest,
  HarnessRunOutcome,
  TradingDomainEventSummary,
  TradingHarnessWakeup,
  WakeupArmedWatch,
} from "@t3tools/trading-contracts/wakeup";

export type {
  WakeupArmedWatchLine,
  WakeupPositionCostLine,
  WakeupTriggeringWatchLine,
  WakeupWorkingEntry,
} from "@t3tools/trading-contracts/wakeup";

export {
  TRADING_WATCH_TOOL,
  TradingCancelWatchRejection,
  TradingWatchInput,
  TradingWatchResult,
} from "@t3tools/trading-contracts/tools";
