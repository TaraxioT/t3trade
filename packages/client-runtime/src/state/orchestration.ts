import { ORCHESTRATION_WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import * as Crypto from "effect/Crypto";

import {
  createEnvironmentCommand,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";
import {
  type TradingMissionControlInput,
  type TradingMissionCreateInput,
  type TradingOrderPlaceInput,
  type TradingRiskControlInput,
  tradingMissionControl,
  tradingMissionCreate,
  tradingOrderPlace,
  tradingRiskControl,
} from "../operations/commands.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

export type {
  TradingMissionControlInput,
  TradingMissionCreateInput,
  TradingOrderPlaceInput,
  TradingRiskControlInput,
};

export function createOrchestrationEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Crypto.Crypto | R, E>,
) {
  return {
    turnDiff: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:turn-diff",
      tag: ORCHESTRATION_WS_METHODS.getTurnDiff,
    }),
    workflowScript: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:workflow-script",
      tag: ORCHESTRATION_WS_METHODS.getWorkflowScript,
      // Scripts are immutable per run: cache generously.
      staleTimeMs: 300_000,
      idleTtlMs: 300_000,
    }),
    fullThreadDiff: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:full-thread-diff",
      tag: ORCHESTRATION_WS_METHODS.getFullThreadDiff,
    }),
    threadSearch: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:thread-search",
      tag: ORCHESTRATION_WS_METHODS.searchThreads,
      staleTimeMs: 30_000,
      idleTtlMs: 60_000,
    }),
    archivedShellSnapshot: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:archived-shell-snapshot",
      tag: ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot,
    }),
    tradingMissionSnapshot: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:trading-mission-snapshot",
      tag: ORCHESTRATION_WS_METHODS.getTradingMissionSnapshot,
    }),
    tradingMarketChart: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:trading-market-chart",
      tag: ORCHESTRATION_WS_METHODS.getTradingMarketChart,
    }),
    // The venue's listed assets. Held long because the list changes when a
    // market is added or delisted, which is not a per-keystroke event; the
    // server caches under it too.
    tradingUniverse: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:trading-universe",
      tag: ORCHESTRATION_WS_METHODS.getTradingUniverse,
      staleTimeMs: 60_000,
    }),
    // The account read model (final-form Phase 3): venue-keyed accounts with
    // positions, open orders and balance. Push-invalidated — consumers refresh
    // it when `tradingAccountInvalidations` emits, so no poll interval here.
    tradingAccountView: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:trading-account-view",
      tag: ORCHESTRATION_WS_METHODS.getTradingAccountView,
    }),
    // The doorbell stream behind the account view and the mission snapshot:
    // the atom's value is the latest invalidation event, so a consumer that
    // watches it refetches once per server-side change instead of polling.
    tradingAccountInvalidations: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:orchestration:trading-account-invalidations",
      tag: ORCHESTRATION_WS_METHODS.subscribeTradingAccount,
    }),
    // The trade home's three lists (final-form Phases 4+5). All ride the same
    // doorbell as the account view — no poll interval on any of them.
    tradingWatchlist: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:trading-watchlist",
      tag: ORCHESTRATION_WS_METHODS.listTradingWatchlist,
    }),
    tradingWatches: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:trading-watches",
      tag: ORCHESTRATION_WS_METHODS.listTradingWatches,
    }),
    tradingAlerts: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:trading-alerts",
      tag: ORCHESTRATION_WS_METHODS.listTradingAlerts,
    }),
    // Watch + watchlist mutations. RPC commands rather than dispatched
    // orchestration commands for the same reason `reviseTradingPlan` is one:
    // the user needs the refusal reason on screen, not an acknowledgement.
    armTradingWatch: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:commands:trading:arm-watch",
      tag: ORCHESTRATION_WS_METHODS.armTradingWatch,
    }),
    cancelTradingWatch: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:commands:trading:cancel-watch",
      tag: ORCHESTRATION_WS_METHODS.cancelTradingWatch,
    }),
    addTradingWatchlistEntry: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:commands:trading:watchlist-add",
      tag: ORCHESTRATION_WS_METHODS.addTradingWatchlistEntry,
    }),
    removeTradingWatchlistEntry: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:commands:trading:watchlist-remove",
      tag: ORCHESTRATION_WS_METHODS.removeTradingWatchlistEntry,
    }),

    // §14.7's deterministic controls. Ordinary environment commands: a
    // workspace button dispatches straight to the server, which is the whole
    // point — no harness turn stands between the press and the action.
    missionControl: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:trading:mission-control",
      execute: (input: TradingMissionControlInput) => tradingMissionControl(input),
    }),
    riskControl: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:trading:risk-control",
      execute: (input: TradingRiskControlInput) => tradingRiskControl(input),
    }),
    // Plan 29 step 8.4: dragging a level on the chart. An RPC command rather
    // than a dispatched orchestration command because the operator needs the
    // answer, not an acknowledgement — a lost optimistic lock and a reconcile
    // that refused to widen a stop both have to be on screen before they let
    // go of the level.
    reviseTradingPlan: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:commands:trading:revise-plan",
      tag: ORCHESTRATION_WS_METHODS.reviseTradingPlan,
    }),
    missionCreate: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:trading:mission-create",
      execute: (input: TradingMissionCreateInput) => tradingMissionCreate(input),
    }),
    // The manual order ticket (final-form Phase 7). Preview and the manual
    // close are RPC commands — the user needs the refusal on screen; the
    // place itself is an event-sourced dispatch, answered through the feed.
    previewTradingOrder: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:commands:trading:preview-order",
      tag: ORCHESTRATION_WS_METHODS.previewTradingOrder,
    }),
    closeTradingManualPosition: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:commands:trading:close-manual-position",
      tag: ORCHESTRATION_WS_METHODS.closeTradingManualPosition,
    }),
    // "Ask the analyst" (final-form Phase 8): resolve the market's standing
    // analyst thread, or register the caller's candidate id as it. An RPC
    // command because the caller branches on `created`.
    ensureTradingAnalystThread: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:commands:trading:ensure-analyst-thread",
      tag: ORCHESTRATION_WS_METHODS.ensureTradingAnalystThread,
    }),
    // Which market a chat thread is about (the companion panel beside the
    // conversation). The read rides the account doorbell like every other
    // trading view; the write is the trade home's "Trade in chat", which needs
    // the answer before it navigates, so it is an RPC command.
    tradingThreadMarket: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:trading-thread-market",
      tag: ORCHESTRATION_WS_METHODS.getTradingThreadMarket,
    }),
    setTradingThreadMarket: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:commands:trading:set-thread-market",
      tag: ORCHESTRATION_WS_METHODS.setTradingThreadMarket,
    }),
    placeTradingOrder: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:trading:place-order",
      execute: (input: TradingOrderPlaceInput) => tradingOrderPlace(input),
    }),
  };
}
