/**
 * The trading services the server runtime provides.
 *
 * The SQL-backed services sit on the migration-035/-036/-037 tables; the
 * Hyperliquid transport and execution services are composed here so callers
 * receive a complete trading runtime.
 *
 * @module TradingRuntimeLayer
 */
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import { ServerConfig } from "../config.ts";
import { ForgeCapabilityStoreConfig, ForgeCapabilityStoreLive } from "./forge/CapabilityStore.ts";
import { ForgeCapabilityBuilderLive } from "./forge/CapabilityBuilder.ts";
import {
  ForgeCapabilitySandboxLive,
  ForgeSandboxConfigFromEnv,
  ForgeContainerRunnerFromEnv,
} from "./forge/CapabilitySandbox.ts";
import { ForgeReactorLive } from "./forge/ForgeReactor.ts";
import { DetectorSchedulerLive, DetectorSchedulerStartLive } from "./forge/DetectorScheduler.ts";
import { ForgeAcceptanceLive } from "./forge/ForgeAcceptance.ts";
import { ForgeSourceWindowLive } from "./forge/ForgeSourceWindow.ts";
import { FetchHttpClient } from "effect/unstable/http";
import * as NodeServices from "@effect/platform-node/NodeServices";

import {
  HyperliquidExchangeClientLive,
  HyperliquidGatewayLive,
  HyperliquidInfoClientLive,
  HyperliquidMarketResolverLive,
  HyperliquidNonceCoordinatorLive,
  HyperliquidWebSocketClientLive,
} from "@t3tools/hyperliquid";
import { HyperliquidExecutionServiceLive } from "./HyperliquidExecutionService.ts";
import { TradingAccountBootstrapLive } from "./TradingAccountBootstrap.ts";
import { TradingAccountProjectionLive } from "./TradingAccountProjection.ts";
import { TradingAlertServiceLive } from "./TradingAlertService.ts";
import { TradingAnalystServiceLive } from "./TradingAnalystService.ts";
import { TradingThreadMarketServiceLive } from "./TradingThreadMarketService.ts";
import { TradingWatchlistServiceLive } from "./TradingWatchlistService.ts";
import { HyperliquidReconcilerLive } from "./HyperliquidReconciler.ts";
import { TradingEventInboxLive } from "./TradingEventInbox.ts";
import { TradingExecutionOutcomeLive } from "./TradingExecutionOutcome.ts";
import { TradingExecutionReceiptsLive } from "./TradingExecutionReceipts.ts";
import { TradingExecutionGuardLive } from "./TradingExecutionGuard.ts";
import { InterimSignerConfigLive } from "./InterimSignerConfig.ts";
import { IocSlippageConfigLive } from "./IocSlippageConfig.ts";
import { ArchiveSupervisorLive } from "./ArchiveSupervisor.ts";
import { FollowSetRegistryLive } from "./FollowSetRegistry.ts";
import { TradingMarketChartLive } from "./TradingMarketChart.ts";
import { TradingUniverseLive } from "./TradingUniverse.ts";
import { TradingMarketPriceLive } from "./TradingMarketPrice.ts";
import { TradingMissionProjectionLive } from "./TradingMissionProjection.ts";
import { TradingMissionServiceLive } from "./TradingMissionService.ts";
import { TradingMissionSweepLive } from "./TradingMissionSweep.ts";
import { TradingRuntimeLeaseLive } from "./TradingRuntimeLease.ts";
import { TradingPreviewServiceLive } from "./TradingPreviewService.ts";
import { TradingStrategyServiceLive } from "./TradingStrategyService.ts";
import { TradingTurnCoordinatorLive } from "./TradingTurnCoordinator.ts";
import { TradingWakeupComposerLive } from "./TradingWakeupComposer.ts";
import { TradingWatchServiceLive } from "./TradingWatchService.ts";
import { TradingJournalServiceLive } from "./TradingJournalService.ts";
import { TradingBudgetReaderLive } from "./TradingBudgetReader.ts";
import { TradingFillReconcilerLive } from "./TradingFillReconciler.ts";
import { TradingProtectionServiceLive } from "./TradingProtectionService.ts";
import { TradingPlanDocumentServiceLive } from "./TradingPlanDocument.ts";
import { TradingPlanTurnContextLive } from "./TradingPlanTurnContext.ts";
import { TradingPlanProtectionServiceLive } from "./TradingPlanProtectionService.ts";
import { TradingWorkingOrderServiceLive } from "./TradingWorkingOrderService.ts";
import { TradingEmergencyCloseServiceLive } from "./TradingEmergencyCloseService.ts";
import { TradingControlServiceLive } from "./TradingControlService.ts";
import { TradingCostEstimatorLive } from "./TradingCostEstimator.ts";
import { TradingTradeHistoryServiceLive } from "./TradingTradeHistoryService.ts";
import { TradingCalibrationServiceLive } from "./TradingCalibrationService.ts";
import { TradingStopAdjustmentServiceLive } from "./TradingStopAdjustmentService.ts";
import { TradingExitServiceLive } from "./TradingExitService.ts";
import { TradingEntryServiceLive } from "./TradingEntryService.ts";
import { TradingManualEntryServiceLive } from "./TradingManualEntryService.ts";
import { TradingMarketArchiveLive } from "./TradingMarketArchive.ts";
import { TradingBacktestServiceLive } from "./TradingBacktestService.ts";
import { TradingHypothesisServiceLive } from "./TradingHypothesisService.ts";
import { TradingThesisValidationServiceLive } from "./TradingThesisValidationService.ts";
import { TradingEventServiceLive } from "./TradingEventService.ts";
import { TradingResearchSceneServiceLive } from "./TradingResearchSceneService.ts";
import { ForgeSourceStoreLive } from "./forge/ForgeSourceStore.ts";
import { DetectorRunStoreLive } from "./forge/DetectorRunStore.ts";
import {
  ForgeGraphConfigLive,
  ForgeGraphSourceLive,
  ForgeGraphTransportLive,
} from "./forge/GraphSource.ts";
import { ForgeSourceReadsLive } from "./forge/ForgeSourceReads.ts";
import { DetectorFactWindowLive } from "./forge/DetectorFactWindow.ts";
import { ExecutionPolicyServiceLive } from "./forge/ExecutionPolicyService.ts";
import { GraphResearchService, makeGraphResearchService } from "./research/GraphResearchService.ts";
import { ExternalSourceStoreLive } from "./research/ExternalSourceStore.ts";
import {
  ExternalSourceConfigLive,
  ExternalSourceConnectorLive,
  ExternalSourceTransportLive,
} from "./research/ExternalSourceConnector.ts";
import { ExternalEventImportServiceLive } from "./research/ExternalEventImportService.ts";
import {
  FeePolicyConfigLive,
  FeePolicyService,
  FeePolicyServiceLive,
} from "./forge/FeePolicyService.ts";
import {
  ForgeTestnetConfigLive,
  ForgeSepoliaTransportLive,
  SignedTransactionBroadcasterUnavailable,
  UniswapTestnetAdapterLive,
} from "./forge/UniswapTestnetAdapter.ts";
import { SwapRouteConfigLive, UniswapQuoteServiceLive } from "./forge/UniswapQuoteService.ts";
import { SwapExecutionServiceLive } from "./forge/SwapExecutionService.ts";
import {
  ForgeGrantGuardLive,
  ForgeIntentLedgerSqliteLive,
} from "./forge/ForgeIntentLedgerSqlite.ts";

const httpWithNode = FetchHttpClient.layer.pipe(Layer.provide(NodeServices.layer));

// The Forge Graph source with its config and transport composed once, so
// every Forge consumer (reads now, builder/reactor later) shares one instance.
// The transport rides the same node-backed HTTP layer the Hyperliquid clients
// use, so no new HTTP requirement leaks out of the trading layer.
const forgeGraphSource = ForgeGraphSourceLive.pipe(
  Layer.provide(ForgeGraphConfigLive),
  Layer.provide(ForgeGraphTransportLive.pipe(Layer.provide(httpWithNode))),
);
// The external-source connector (GitHub official releases first). The store is
// SQL-only, and the connector's own HTTP requirement is satisfied here over
// the same node-backed layer, so no new HTTP requirement leaks out of the
// trading layer to any consumer. Its fetch URL comes from vetted config only;
// nothing in this composition can reach a signer or an order.
const externalSourceConnector = ExternalSourceConnectorLive.pipe(
  Layer.provide(ExternalSourceConfigLive),
  Layer.provide(ExternalSourceTransportLive.pipe(Layer.provide(httpWithNode))),
  Layer.provide(ExternalSourceStoreLive),
);
// Explicit event-set integration: one import call captures once through the
// connector above and projects the retained revisions through the AUTHORED
// TradingEventService.record path (author "agent"). Dependencies are provided
// explicitly, the same style the backtest/validation wirings use, so the
// import service's whole dependency set is readable here: SQL, the connector,
// the store, the event service — nothing that could reach an order. Layer
// memoization shares the one TradingEventService instance the merge below
// also builds, so imports and every other reader see one calendar.
const externalEventImport = ExternalEventImportServiceLive.pipe(
  Layer.provide(externalSourceConnector),
  Layer.provide(ExternalSourceStoreLive),
  Layer.provide(TradingEventServiceLive),
);
// Use the server's resolved state directory so worktrees and installed apps never share a writer.
const forgeStoreConfig = Layer.effect(
  ForgeCapabilityStoreConfig,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const path = yield* Path.Path;
    return { stateRoot: path.join(config.stateDir, "forge") };
  }),
);
const forgeStore = ForgeCapabilityStoreLive.pipe(Layer.provide(forgeStoreConfig));
const forgeSandbox = ForgeCapabilitySandboxLive.pipe(
  Layer.provide(ForgeSandboxConfigFromEnv),
  Layer.provide(ForgeContainerRunnerFromEnv),
);
const forgeWindow = ForgeSourceWindowLive.pipe(
  Layer.provide(forgeGraphSource),
  Layer.provide(ForgeSourceStoreLive),
);
// The sealed fact-set window for detector-program (v2) jobs, over the same
// shared evidence stores the research paths read — one instance, referenced
// by the reactor through serviceOption so nothing can fork it.
const detectorFactWindow = DetectorFactWindowLive.pipe(
  Layer.provide(ForgeSourceStoreLive),
  Layer.provide(ExternalSourceStoreLive),
);
// P5.3: the execution-policy evaluator and durable envelope store (migration
// 106 tables) over the SAME store, sandbox, and detector-run instances the
// wiring above builds (layer memoization — no second anything). Envelope
// approval stays a direct user-service act; this service only proposes and
// persists. SQL + contained runs only — nothing here reaches an order, a
// signer, or an exchange.
const executionPolicyService = ExecutionPolicyServiceLive.pipe(
  Layer.provide(forgeStore),
  Layer.provide(forgeSandbox),
  Layer.provide(DetectorRunStoreLive),
);
const forgeBuilder = ForgeCapabilityBuilderLive.pipe(
  Layer.provide(forgeStore),
  Layer.provide(forgeSandbox),
);
const forgeReactor = ForgeReactorLive.pipe(
  Layer.provide(forgeStore),
  Layer.provide(forgeSandbox),
  Layer.provide(forgeWindow),
  Layer.provide(forgeStoreConfig),
  // v2 detector jobs' commit boundary and sealed window. DetectorRunStoreLive
  // is the same layer reference the merge below mounts, so layer memoization
  // shares the one instance — no second detector store exists.
  Layer.provide(DetectorRunStoreLive),
  Layer.provide(detectorFactWindow),
);
// The provider-free detector heartbeat: one sweep per interval over the SAME
// store and reactor instances the merge below mounts (layer memoization),
// lease-gated per tick. The start layer forks the loop into its scope, so
// the sweep begins when the trading runtime builds and stops with it; a
// runtime that does not hold the lease runs the loop as a per-tick no-op.
const detectorScheduler = DetectorSchedulerLive.pipe(
  Layer.provide(forgeStore),
  Layer.provide(forgeStoreConfig),
  Layer.provide(forgeReactor),
  Layer.provide(TradingRuntimeLeaseLive),
);
const detectorSchedulerStart = DetectorSchedulerStartLive.pipe(
  Layer.provideMerge(detectorScheduler),
);

// T3 Forge F3: the durable intent machinery. SQLite ledger + immutable grant
// guard on the shared SqlClient (satisfied where TradingLayerLive is
// provided, exactly like the other SQL-backed trading services), the Sepolia
// adapter over the node-backed HTTP transport, and the fee-policy service on
// top. The broadcaster is the honest refusal — no signer is wired, so every
// broadcast still fails closed at that seam.
const forgeDurable = Layer.mergeAll(ForgeIntentLedgerSqliteLive, ForgeGrantGuardLive);
// The ONE Sepolia JSON-RPC transport, named so the adapter and the quote
// service below share a single memoized instance (layer memoization is by
// reference — an inline pipe in each consumer would build a second transport
// and fork the RPC seam). It resolves the target itself, so its config
// requirement is satisfied here and leaks into no consumer.
const forgeSepoliaTransport = ForgeSepoliaTransportLive.pipe(
  Layer.provide(ForgeTestnetConfigLive),
  Layer.provide(httpWithNode),
);
const forgeAdapter = UniswapTestnetAdapterLive.pipe(
  Layer.provide(ForgeTestnetConfigLive),
  Layer.provide(forgeSepoliaTransport),
  Layer.provideMerge(forgeDurable),
  Layer.provideMerge(SignedTransactionBroadcasterUnavailable),
);
// P5 exact-input quotes over the SAME transport instance: an eth_call read
// through the approved-route registry. Signer-free by construction — nothing
// here can reach an order, a signature, or Hyperliquid.
const forgeQuoteService = UniswapQuoteServiceLive.pipe(
  Layer.provide(SwapRouteConfigLive),
  Layer.provide(forgeSepoliaTransport),
);
// P5.4: the swap-intent flow — prepare an exact-input transaction from a
// persisted proposal plus a fresh quote, then honestly refuse submission at
// the broadcaster seam. Rides the SAME route registry the quote service
// resolves and the SAME honest broadcaster the forge adapter is gated on
// (provided, so the real serviceOption call path runs and refuses
// broadcaster-missing; a runtime that omits it lands on the same durable
// refusal through the None branch). SQL + calldata encoding only — no
// signer, no RPC, no Hyperliquid, and no F0 ledger write.
const swapExecutionService = SwapExecutionServiceLive.pipe(
  Layer.provide(forgeStore),
  Layer.provide(SwapRouteConfigLive),
  Layer.provide(SignedTransactionBroadcasterUnavailable),
);
const forgeFeePolicy = FeePolicyServiceLive.pipe(
  Layer.provide(forgeAdapter),
  Layer.provide(FeePolicyConfigLive),
  Layer.provide(ForgeSourceStoreLive),
  // The publish path verifies installed capabilities; same instance the rest
  // of the forge wiring shares.
  Layer.provide(forgeStore),
);
export const ForgeF3ServicesLive = Layer.mergeAll(forgeAdapter, forgeFeePolicy);

// Restart-safe reconciliation: once, when the layer builds, settle whatever
// the previous process left open. Non-fatal by design — an unconfigured
// target or an unreachable RPC logs and lets the server come up.
const forgeStartupReconciliation = Layer.effectDiscard(
  Effect.gen(function* () {
    const service = yield* FeePolicyService;
    const result = yield* service.reconcileOpenIntents;
    yield* Effect.logInfo("forge open-intent reconciliation complete").pipe(
      Effect.annotateLogs({
        reconciled: result.reconciled.length,
        skippedCrossTarget: result.skippedCrossTarget.length,
      }),
    );
    // reconcileOpenIntents is total by contract (it reports per-intent
    // failures inside its read), so there is no error channel to catch here.
  }),
).pipe(Layer.provide(ForgeF3ServicesLive));
const infoWithHttp = HyperliquidInfoClientLive.pipe(Layer.provide(httpWithNode));
const resolverWithInfo = HyperliquidMarketResolverLive.pipe(Layer.provide(infoWithHttp));
const gatewayWithRead = HyperliquidGatewayLive.pipe(
  Layer.provide(Layer.mergeAll(infoWithHttp, resolverWithInfo)),
);

export const HyperliquidReadLayerLive = Layer.mergeAll(
  infoWithHttp,
  resolverWithInfo,
  gatewayWithRead,
);

export const HyperliquidWsLayerLive = HyperliquidWebSocketClientLive;

/**
 * Mission services that do not require the exchange write path. This layer is
 * kept for the reactor's narrow unit tests.
 */
export const TradingCoreLayerLive = Layer.mergeAll(
  TradingMissionProjectionLive,
  HyperliquidReadLayerLive,
  // The read surfaces quote a live mark even while the mission is flat, which
  // no local table carries — so this sits with the projection it feeds.
  TradingMarketPriceLive.pipe(Layer.provide(gatewayWithRead)),
  // The chart surface pairs the same live snapshot with candle history; it
  // shares the read gateway so the two never disagree on freshness.
  // The chart reads a closed window out of the archive before it asks the
  // exchange, which only serves the last ~5,000 bars.
  TradingMarketChartLive.pipe(
    Layer.provide(gatewayWithRead),
    Layer.provide(TradingMarketArchiveLive),
    // The chart draws an armed thesis's paper trades as markers. A read, and
    // one that can never fail the chart: a price series must still render when
    // the paper ledger does not answer.
    Layer.provide(
      TradingThesisValidationServiceLive.pipe(
        Layer.provide(TradingMarketArchiveLive),
        Layer.provide(TradingEventServiceLive),
      ),
    ),
    // The same thesis's event bands, off the same calendar.
    Layer.provide(TradingEventServiceLive),
  ),
  // What the venue lists, for the picker and the watchlist search. Same read
  // gateway again, so the universe and a resolve of one asset never disagree.
  TradingUniverseLive.pipe(Layer.provide(gatewayWithRead)),
  TradingMissionServiceLive,
  TradingStrategyServiceLive,
);

const costEstimatorWithGateway = TradingCostEstimatorLive.pipe(
  Layer.provide(HyperliquidReadLayerLive),
);

const composerWithDeps = TradingWakeupComposerLive.pipe(
  Layer.provide(HyperliquidReadLayerLive),
  // The wakeup carries the round trip on the size actually held, so the
  // composer prices it through the same estimator the tool uses.
  Layer.provide(costEstimatorWithGateway),
  Layer.provideMerge(TradingMissionServiceLive),
  Layer.provideMerge(TradingWatchServiceLive),
  // The wakeup publishes the full armed-watch list, which `listWatches` owns.
  Layer.provideMerge(TradingStrategyServiceLive),
);

const coordinatorWithDeps = TradingTurnCoordinatorLive.pipe(
  Layer.provideMerge(TradingMissionServiceLive),
  Layer.provideMerge(TradingStrategyServiceLive),
  Layer.provideMerge(TradingEventInboxLive),
  Layer.provideMerge(composerWithDeps),
);

const exchangeWithHttp = HyperliquidExchangeClientLive.pipe(Layer.provide(httpWithNode));

/**
 * The full trading layer. Foundations are built first, then supplied to the
 * preview/budget consumers and finally to the execution consumers.
 */
const TradingFoundation = Layer.mergeAll(
  TradingCoreLayerLive,
  InterimSignerConfigLive,
  // Both IOC crossing allowances, read per call so a testnet run can move them.
  IocSlippageConfigLive,
  exchangeWithHttp,
  // One shared set of execution latches: the reactor opens them, the tool
  // waiting on `trading_enter` blocks on them. Built here so both sides see
  // the same instance rather than two maps that never meet.
  TradingExecutionReceiptsLive,
  HyperliquidNonceCoordinatorLive(),
  HyperliquidWebSocketClientLive,
);

const TradingWithPreview = Layer.mergeAll(TradingPreviewServiceLive, TradingBudgetReaderLive).pipe(
  Layer.provideMerge(TradingFoundation),
);

const TradingExecutionCore = Layer.mergeAll(
  HyperliquidExecutionServiceLive,
  // The reconciler writes an inbox event when the exchange moved a position no
  // order of T3's explains, so it needs the inbox at build.
  // It also rings the account-view doorbell at the end of every pass; the
  // same layer instance is memoized into the projection pipeline and the WS
  // read path, so one bus serves all three.
  HyperliquidReconcilerLive.pipe(
    Layer.provide(TradingEventInboxLive),
    Layer.provide(TradingAccountProjectionLive),
  ),
).pipe(Layer.provideMerge(TradingWithPreview));

const TradingProtectionLayerLive = TradingProtectionServiceLive.pipe(
  Layer.provideMerge(TradingExecutionCore),
);

// Plan 29 step 2.4: the working-order loop re-places resting patient entries
// through the constrained preview-free path on the execution service, so it
// builds on the same core the protection service does. Plain `provide` (not
// provideMerge): it sits inside the merge below, and re-exporting the core's
// services there would make the build order ambiguous.
const TradingWorkingOrderLayerLive = TradingWorkingOrderServiceLive.pipe(
  Layer.provide(TradingExecutionCore),
);

// The control service sits on top of protection: `cancel_entries` routes
// through `cancelEntriesWithProtection` (§17.3), so protection has to be built
// first rather than merged alongside.
const TradingExecutionLayerLive = Layer.mergeAll(
  TradingExecutionGuardLive,
  TradingFillReconcilerLive,
  TradingEmergencyCloseServiceLive,
  TradingControlServiceLive,
  // Provisions the account row a mission names. Merged here because it needs
  // the resolved interim signer, which the foundation below supplies.
  TradingAccountBootstrapLive,
  // Reports an execution's real outcome back to `trading_enter`; needs
  // the budget reader and the gateway the layers below supply, plus the inbox
  // the reactor records refusals in.
  TradingExecutionOutcomeLive.pipe(Layer.provide(TradingEventInboxLive)),
  // The mission reactor's working-order guard pass; also the direct
  // withdrawal the terminal transitions call.
  TradingWorkingOrderLayerLive,
).pipe(Layer.provideMerge(TradingProtectionLayerLive));

// Graph-backed dataset acquisition for the research tools: reads through the
// same vetted-pool Graph source the detectors use, self-contained in its
// provides, so the merge builds it in parallel safely.
const graphResearchServices = Layer.effect(GraphResearchService, makeGraphResearchService).pipe(
  Layer.provide(forgeGraphSource),
  Layer.provide(ForgeSourceStoreLive),
);

export const TradingLayerLive = Layer.mergeAll(
  // `trading_look`'s archive-backed fetch keys (plan 38 §2.4). Read-only over
  // the archiver's own file; a missing archive answers unavailable, not zero.
  TradingMarketArchiveLive,
  // `trading_backtest` reads the same archive and nothing else. Provided the
  // archive layer explicitly rather than relying on merge order, so the one
  // dependency it has is visible at the wiring.
  TradingBacktestServiceLive.pipe(
    Layer.provide(TradingMarketArchiveLive),
    Layer.provide(TradingEventServiceLive),
  ),
  // Forward validation reads the same archive and writes only its own paper
  // tables. Provided the archive explicitly for the same reason the backtest
  // is: the whole dependency set is meant to be readable at the wiring, and
  // this one is the claim that it cannot place an order.
  TradingThesisValidationServiceLive.pipe(
    Layer.provide(TradingMarketArchiveLive),
    Layer.provide(TradingEventServiceLive),
  ),
  // The hypothesis record: ideas, their versions, and the runs against them.
  // Its dependency set is SQL and Crypto, which is the same claim again - a
  // filed idea is research, and nothing here can reach an order.
  TradingHypothesisServiceLive,
  // The event calendar the engines read. Same dependency set, same claim.
  TradingEventServiceLive,
  // The research scene record the trading_chart tool publishes into. Same
  // dependency set once more: SQL and Crypto, and nothing that could reach
  // an order.
  TradingResearchSceneServiceLive,
  TradingMissionServiceLive,
  // The workspace plan-document lifecycle: read, activate, drift. SQL only —
  // the document is a file read, the revisions are rows, and nothing here can
  // reach an order.
  TradingPlanDocumentServiceLive,
  // Installs the turn-context reader the provider adapters' shared seam
  // reads TRADE.md through. Effect-free at the adapter boundary on purpose.
  TradingPlanTurnContextLive,
  // The single-writer lease for this database. Merged here so every consumer
  // of the trading layer — the sweep below, the reactors above — sees the
  // same acquisition, and so a refused boot leaves the layer built but the
  // destructive runtime down. See `TradingRuntimeLease`.
  TradingRuntimeLeaseLive,
  // Housekeeping, once at boot: settled missions and missions whose thread is
  // gone are deleted rather than accumulated. Runs only while the lease is
  // held. See `TradingMissionSweep`.
  TradingMissionSweepLive.pipe(
    Layer.provide(TradingMissionServiceLive),
    Layer.provide(TradingRuntimeLeaseLive),
  ),
  TradingStrategyServiceLive,
  TradingWatchServiceLive,
  // `trading_journal` appends to and reads back the mission's memory.
  TradingJournalServiceLive,
  TradingEventInboxLive,
  // `trading_look` reads the book, the mark, and the fee rate — all
  // through the gateway the read layer already builds.
  costEstimatorWithGateway,
  // `trading_look` is a pure read-join over the mission's own
  // fills and strategy versions.
  TradingTradeHistoryServiceLive,
  // `trading_look` scores the published targets against the closed
  // trades the reconciler recorded.
  TradingCalibrationServiceLive,
  // `trading_exit`'s `move_stop` measures the position, the resting stop and the
  // server's own ATR before it allows a move, so it needs the read gateway and
  // both mission services at build.
  TradingStopAdjustmentServiceLive.pipe(
    Layer.provide(HyperliquidReadLayerLive),
    Layer.provide(TradingMissionServiceLive),
    Layer.provide(TradingStrategyServiceLive),
  ),
  // `trading_enter` prices and sizes an entry against the mission, the
  // lease, the live book and the budget, so it needs the mission service and
  // the slippage config at build; everything else it reads per call.
  TradingEntryServiceLive.pipe(
    Layer.provide(TradingMissionServiceLive),
    Layer.provide(IocSlippageConfigLive),
    Layer.provide(TradingBudgetReaderLive),
    Layer.provide(costEstimatorWithGateway),
    Layer.provide(HyperliquidReadLayerLive),
  ),
  // The manual order ticket (final-form Phase 7): prices and pre-checks a
  // user-placed entry against the account envelope and the live book — the
  // mirror of `trading_enter` with the mission machinery removed.
  TradingManualEntryServiceLive.pipe(
    Layer.provide(TradingMissionServiceLive),
    Layer.provide(IocSlippageConfigLive),
    Layer.provide(costEstimatorWithGateway),
    Layer.provide(HyperliquidReadLayerLive),
  ),
  // The three exit tools size themselves from the canonical position, so they
  // need the mission service, the book, and the slippage allowance the crossing
  // reduce-only IOC is priced with.
  TradingExitServiceLive.pipe(
    Layer.provide(TradingMissionServiceLive),
    Layer.provide(IocSlippageConfigLive),
    Layer.provide(HyperliquidReadLayerLive),
  ),
  // Plan 29 step 4.5: an accepted publish reconciles the exchange's stop and
  // resting target to the plan immediately. Built on the protection layer (it
  // routes its legs through the same reconciles the watchdog uses) and the
  // read gateway for the canonical position.
  TradingPlanProtectionServiceLive.pipe(
    Layer.provide(HyperliquidReadLayerLive),
    Layer.provide(TradingProtectionLayerLive),
  ),
  coordinatorWithDeps,
  // The market archiver, supervised: spawned while this process holds the
  // trading lease, restarted with backoff, its heartbeat read off stdout.
  ArchiveSupervisorLive,
  // What attention is on, published to the archiver so recording follows it.
  FollowSetRegistryLive,
  TradingExecutionLayerLive,
  HyperliquidWsLayerLive,
  // The account read model + invalidation bus (final-form Phase 3). Merged so
  // `ws.ts` can serve the view and its subscription off the same instance the
  // reconciler and the projection pipeline publish into.
  TradingAccountProjectionLive,
  // Account-scoped watches + the alert feed (Phase 5) and the watchlist
  // (Phase 4). Both validate assets through the read gateway and ring the
  // same account doorbell, so they are built on the same instances.
  TradingAlertServiceLive.pipe(
    Layer.provide(HyperliquidReadLayerLive),
    Layer.provide(TradingAccountProjectionLive),
  ),
  TradingWatchlistServiceLive.pipe(
    Layer.provide(HyperliquidReadLayerLive),
    Layer.provide(TradingAccountProjectionLive),
  ),
  // The analyst-thread registry (Phase 8). SQL-only; its layer also replays
  // every registered analyst profile into the session-profile map at boot.
  TradingAnalystServiceLive,
  // Which market a chat thread is about, so the companion panel beside the
  // conversation knows what to draw. Rings the same account doorbell, so it
  // is built on the projection instance every other trading read shares.
  TradingThreadMarketServiceLive.pipe(Layer.provide(TradingAccountProjectionLive)),
  // T3 Forge: The Graph observation source, its evidence store, and the
  // read models. SQL + its own HTTP transport only — nothing here can reach
  // an order, a signer, or Hyperliquid, so mounting it changes no trading
  // guard. One shared source/store instance feeds the reads and any later
  // Forge consumer. ForgeGraphConfig is exposed ambiently too (stateless
  // per-call env resolution) for the WS read that labels a retained
  // dataset's quote symbol without touching the source itself.
  ForgeGraphConfigLive,
  forgeGraphSource,
  forgeStore,
  forgeBuilder,
  ForgeAcceptanceLive,
  forgeReactor,
  ForgeSourceStoreLive,
  // Durable v2 detector runs: committed evaluations + revision-CAS state on
  // the shared SqlClient (migration 105), the same ambient shape the other
  // SQL-backed forge services use. Additive — nothing here reaches an order,
  // a signer, or an exchange.
  DetectorRunStoreLive,
  // P5.3 execution-policy evaluator + envelope store (migration 106). Built
  // on the shared forge store/sandbox/detector-run instances; the SqlClient
  // rides the same ambient provision the other SQL-backed services use.
  executionPolicyService,
  // The periodic sweep that enqueues v2 evaluations for armed detectors with
  // no provider turn in the loop. Starts and stops with this layer; every
  // tick re-checks the lease, so only the trading-lease owner ever enqueues.
  detectorSchedulerStart,
  ForgeSourceReadsLive.pipe(Layer.provide(forgeGraphSource), Layer.provide(ForgeSourceStoreLive)),
  graphResearchServices,
  // P5 quote service: exact-input Sepolia quotes over the approved-route
  // registry, riding the same memoized Sepolia transport the forge adapter
  // uses (see forgeQuoteService). Additive — a read-only eth_call, so
  // mounting it changes no trading guard and adds no requirements here.
  forgeQuoteService,
  // P5.4 swap-intent flow (migration 107): prepared exact-input transactions
  // ending at the honest broadcaster-missing refusal. Additive — SQL and
  // calldata encoding only, sharing the route registry above.
  swapExecutionService,
  // External research evidence: the durable source-revision store, the
  // GitHub releases connector over it, and the explicit import path from
  // retained revisions into the authored event calendar. Additive — SQL and
  // its own HTTP transport only, so mounting it changes no trading guard and
  // no consumer's requirements.
  ExternalSourceStoreLive,
  externalSourceConnector,
  externalEventImport,
).pipe(
  Layer.provideMerge(infoWithHttp),
  // T3 Forge F3 durable machinery: SQLite intent ledger + grant guard +
  // Sepolia adapter + fee-policy service, plus the one-shot startup
  // reconciliation over them — provideMerge'd AFTER the merge (they depend
  // on the merged SqlClient source and each other, which a parallel mergeAll
  // would not order). Fails closed — no signer, no approved grant, nothing
  // executes; the layers beneath the future live pass are real.
  Layer.provideMerge(ForgeF3ServicesLive),
  Layer.provideMerge(forgeStartupReconciliation),
);
