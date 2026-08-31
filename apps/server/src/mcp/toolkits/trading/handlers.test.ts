/**
 * Trading toolkit integration tests.
 *
 * These drive the real `/mcp` HTTP endpoint with a credential minted by
 * `McpSessionRegistry.issue`, so what is under test is the whole path an
 * injected `t3-trade` harness takes: bearer auth, MCP session, tool dispatch,
 * capability check, thread-to-mission resolution, and the trading services.
 */
import {
  renderTradingLookMenu,
  TRADING_LOOK_CATALOG,
} from "@t3tools/trading-contracts/observation";
import { DERIVED_METRIC_CATALOG } from "@t3tools/trading-contracts/watch";
import { computeIndicator } from "@t3tools/trading-contracts/indicators";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "node:crypto";
// @effect-diagnostics nodeBuiltinImport:off - temp dirs for the archive fixture.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpBody, HttpClient, HttpRouter, HttpServer } from "effect/unstable/http";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type { OrchestrationCommand } from "@t3tools/contracts";
import * as Stream from "effect/Stream";

import { HyperliquidExecutionService } from "../../../trading/HyperliquidExecutionService.ts";
import { HyperliquidGateway } from "@t3tools/hyperliquid/Gateway";
import { TradingWakeupComposerLive } from "../../../trading/TradingWakeupComposer.ts";
import type { AgentOpenOrder } from "@t3tools/trading-contracts/account-snapshot";
import type { MarketCandle } from "@t3tools/trading-contracts/market";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import { ServerConfig } from "../../../config.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { runMigrations } from "../../../persistence/Migrations.ts";
import * as NodeSqliteClient from "../../../persistence/NodeSqliteClient.ts";
import type { PublishTradingPlanBody } from "../../../trading/Schemas.ts";
import {
  makeTradingWorkingOrderService,
  TradingWorkingOrderService,
} from "../../../trading/TradingWorkingOrderService.ts";
import { TradingCalibrationServiceLive } from "../../../trading/TradingCalibrationService.ts";
import { TradingAccountProjection } from "../../../trading/TradingAccountProjection.ts";
import { TradingAlertServiceLive } from "../../../trading/TradingAlertService.ts";
import { TradingThreadMarketServiceLive } from "../../../trading/TradingThreadMarketService.ts";
import { makeProviderRegistryLayer } from "../../../provider/testUtils/providerRegistryMock.ts";
import { TradingTurnCoordinator } from "../../../trading/TradingTurnCoordinator.ts";
import { LOCAL_TRADING_USER_ID } from "../../../trading/TradingMissionReactor.ts";
import { LOCAL_TRADING_ACCOUNT_ID } from "../../../trading/TradingAccountBootstrap.ts";
import {
  TradingCostEstimator,
  TradingCostEstimatorLive,
} from "../../../trading/TradingCostEstimator.ts";
import { TradingExecutionOutcome } from "../../../trading/TradingExecutionOutcome.ts";
import { TradingExitService } from "../../../trading/TradingExitService.ts";
import { TradingLayerLive } from "../../../trading/runtimeLayer.ts";
import { TradingLeaseTarget } from "../../../trading/TradingRuntimeLease.ts";
import {
  TradingMissionService,
  TradingMissionServiceLive,
} from "../../../trading/TradingMissionService.ts";
import { TradingPlanProtectionService } from "../../../trading/TradingPlanProtectionService.ts";
import { TradingEntryService } from "../../../trading/TradingEntryService.ts";
import { TradingStopAdjustmentServiceLive } from "../../../trading/TradingStopAdjustmentService.ts";
import { TradingStrategyServiceLive } from "../../../trading/TradingStrategyService.ts";
import { TradingTradeHistoryServiceLive } from "../../../trading/TradingTradeHistoryService.ts";
import { TradingPlanDocumentServiceLive } from "../../../trading/TradingPlanDocument.ts";
import { TradingWatchServiceLive } from "../../../trading/TradingWatchService.ts";
import { TradingJournalServiceLive } from "../../../trading/TradingJournalService.ts";
import { TradingEventInbox, TradingEventInboxLive } from "../../../trading/TradingEventInbox.ts";
import { TradingHypothesisServiceLive } from "../../../trading/TradingHypothesisService.ts";
import { TradingThesisValidationServiceLive } from "../../../trading/TradingThesisValidationService.ts";
import { TradingEventServiceLive } from "../../../trading/TradingEventService.ts";
import {
  makeTradingMarketArchive,
  TradingMarketArchive,
} from "../../../trading/TradingMarketArchive.ts";
import { openArchiveDatabase } from "../../../trading/archive/db.ts";
import { upsertAssetContexts } from "../../../trading/archive/assetCtx.ts";
import { upsertBookSummaries } from "../../../trading/archive/bookSummary.ts";
import { upsertCandles, type CandleRow } from "../../../trading/archive/candles.ts";
import { upsertFunding } from "../../../trading/archive/funding.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpSessionRegistry from "../../McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";

/** What `McpServer` returns for anything that is not a declared tool failure. */
const INTERNAL_ERROR_TEXT = "Tool execution failed due to an internal server error.";

const MISSION_ID = "mission_mcp_trading";
/** A mission mandate at the length operators actually write them. */
const MANDATE =
  "Trade ETH momentum on the 1m. Read ema(20) and ema(50) through trading_look " +
  "indicators rather than deriving them from raw bars. One gate decides whether " +
  "a trade is worth taking: is the expected move over the intended hold bigger " +
  "than the round trip? If it is not, stand down and say so in one line.";
const BOUND_THREAD = ThreadId.make("thread-bound-to-mission");
const UNBOUND_THREAD = ThreadId.make("thread-with-no-mission");
const PROVIDER_INSTANCE = ProviderInstanceId.make("claude");

const fakeEnvironment = ServerEnvironment.ServerEnvironment.of({
  getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-trading")),
  getDescriptor: Effect.die("unused"),
});

const strategyBody = (because: string): PublishTradingPlanBody => ({
  market: "ETH",
  intent: "long",
  entry: {
    triggers: [{ description: "5m candle closes above 3,200" }],
    urgency: "now",
  },
  stop: { method: "Structural stop beneath the breakout candle low." },
  target: { profitUsd: 20 },
  invalidation: ["Range high is lost on a 15m close."],
  reassess: { afterMinutes: 90 },
  because,
});

/**
 * The MCP HTTP transport answers either `application/json` or an SSE stream
 * depending on the negotiated session, so read the JSON-RPC envelope out of
 * whichever came back.
 */
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const parseJsonRpc = (body: string): { readonly result?: any; readonly error?: any } => {
  const payload = body.includes("data:")
    ? (body
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trim())
        .at(-1) ?? "{}")
    : body;
  try {
    return decodeJson(payload) as { readonly result?: any; readonly error?: any };
  } catch (e) {
    // eslint-disable-next-line
    require("node:fs").appendFileSync(
      "/tmp/mcp-body.txt",
      "BODY<<<" + body + ">>>\nPAYLOAD<<<" + payload + ">>>\n",
    );
    throw e;
  }
};

/**
 * The tool's own encoded result, decoded off the text content.
 *
 * The server sends it exactly once, as JSON text — `structuredContent` used to
 * carry a byte-identical second copy and no longer does, so a test reads the
 * one channel the model reads.
 */
const withDecodedBody = (response: { readonly result?: any; readonly error?: any }) => {
  const first = response.result?.content?.[0];
  if (first?.type !== "text") return response;
  // An `isError` result carries a plain sentence, not an encoded body. Those
  // tests read `result.content`, so leave `body` unset rather than throwing.
  try {
    return { ...response, result: { ...response.result, body: decodeJson(first.text) } };
  } catch {
    return response;
  }
};

/**
 * Records what the toolkit raises on the orchestration engine, so a test can
 * assert that an accepted publish reaches the ordered push path instead of
 * stopping at the database.
 */
const dispatchedCommands: Array<OrchestrationCommand> = [];

/** Every chat turn bind-on-first-use took the decision lease for. */
const adoptedTurns: Array<{ readonly missionId: string; readonly threadId: string }> = [];

const recordingEngine = Layer.succeed(OrchestrationEngineService, {
  dispatch: (command) =>
    Effect.sync(() => {
      dispatchedCommands.push(command);
      return { sequence: dispatchedCommands.length };
    }),
  readEvents: () => Stream.empty,
  streamDomainEvents: Stream.empty,
  latestSequence: Effect.succeed(0),
});

// -- a fake exchange for the publish/adjust-stop aftermaths -------------------
//
// The full TradingLayerLive wires its own Hyperliquid gateway deep inside, so
// an outer provide cannot swap it for a fake. `tradingLayerOverExchange`
// rebuilds the trading services those aftermaths actually use over the same
// memory SQLite, with the exchange faked exactly the way
// TradingWorkingOrderService.test.ts fakes it: a position, a book, a set of
// resting orders, and a record of what was cancelled.

interface FakeExchange {
  positionSize: number;
  markPrice: number;
  bidPrice: number | undefined;
  askPrice: number | undefined;
  orders: AgentOpenOrder[];
  cancels: string[];
  candles: MarketCandle[];
  /** How far back this fake's market goes; 0 means only `candles`. */
  historyDepth: number;
  /**
   * Realistic-magnitude overrides for the plan 38 size tests. Every one
   * defaults to the value the fake already served, so the byte-identity
   * goldens above are untouched by this.
   */
  book?: {
    bids: ReadonlyArray<{ price: number; size: number }>;
    asks: ReadonlyArray<{ price: number; size: number }>;
  };
  oraclePrice?: number;
  fundingRate8h?: number;
  change24hPercent?: number;
  openInterest?: number;
  dayVolumeUsd?: number;
  accountValue?: number;
  accountMarginUsed?: number;
  positionUnrealisedPnl?: number;
  positionCumulativeFunding?: number;
}

const makeFakeExchange = (overrides: Partial<FakeExchange> = {}): FakeExchange => ({
  positionSize: 0,
  markPrice: 3_010,
  bidPrice: 3_009.5,
  askPrice: 3_010.5,
  orders: [],
  cancels: [],
  historyDepth: 0,
  // Forty 1m candles ranging 12 USD, so the server's own ATR measures 12.
  candles: Array.from({ length: 40 }, (_, i) => ({
    openTime: 4_000_000 - (40 - i) * 60_000,
    closeTime: 4_000_000 - (40 - i) * 60_000 + 59_000,
    open: 3_010,
    close: 3_010,
    high: 3_016,
    low: 3_004,
    volume: 100,
  })),
  ...overrides,
});

/**
 * `count` bars older than a series, held at a price far from it.
 *
 * An EMA seeded here and one seeded inside the series answer differently, which
 * is the whole point: it makes "which window was this computed over" a question
 * the assertions can actually put to the reading.
 */
const olderBarsBefore = (series: ReadonlyArray<MarketCandle>, count: number): MarketCandle[] => {
  const first = series[0];
  if (first === undefined || count <= 0) return [];
  return Array.from({ length: count }, (_, i) => ({
    ...first,
    openTime: first.openTime - (count - i) * 60_000,
    closeTime: first.openTime - (count - i) * 60_000 + 59_000,
    open: 2_500,
    close: 2_500,
    high: 2_500,
    low: 2_500,
  }));
};

/** A resting non-reduce-only limit with a cloid — the working entry's shape. */
const restingWorkingEntry = (cloid: string, limitPrice: number): AgentOpenOrder =>
  ({
    market: "ETH",
    orderId: 11,
    cloid,
    side: "buy",
    limitPrice,
    size: 0.5,
    remainingSize: 0.5,
    status: "open",
    createdAt: 970_000,
    reduceOnly: false,
    isTrigger: false,
    orderType: "Limit",
  }) as AgentOpenOrder;

/** A reduce-only trigger under a 0.5 long — the resting stop's shape. */
const restingProtectiveStop = (triggerPrice: number): AgentOpenOrder =>
  ({
    ...restingWorkingEntry("0xstopcloid0000000000000000001", triggerPrice),
    side: "sell",
    reduceOnly: true,
    isTrigger: true,
    triggerPrice,
    orderType: "Stop Market",
  }) as AgentOpenOrder;

const exchangeGatewayLayer = (fake: FakeExchange) =>
  Layer.succeed(HyperliquidGateway, {
    getAccountSnapshot: () =>
      Effect.succeed({
        address: "0x1234567890abcdef1234567890abcdef12345678",
        accountValue: fake.accountValue ?? 1_000,
        marginUsed: fake.accountMarginUsed ?? 0,
        withdrawable: 1_000,
        freshness: { observedAt: 1_000_000, source: "info_api", staleAfterMillis: 5_000 },
        positions:
          fake.positionSize === 0
            ? []
            : [
                {
                  market: "ETH",
                  size: fake.positionSize,
                  entryPrice: 3_000,
                  unrealisedPnl: 0,
                  cumulativeFunding: 0,
                  marginUsed: 100,
                },
              ],
      }),
    getOpenOrders: () => Effect.succeed(fake.orders),
    getMarketSnapshot: () =>
      Effect.succeed({
        market: "ETH",
        markPrice: fake.markPrice,
        midPrice: fake.markPrice,
        oraclePrice: fake.oraclePrice ?? fake.markPrice,
        fundingRate8h: fake.fundingRate8h ?? 0,
        change24hPercent: fake.change24hPercent ?? 0,
        openInterest: fake.openInterest ?? 1_000,
        dayVolumeUsd: fake.dayVolumeUsd ?? 1_000_000,
        bestBidOffer: {
          bidPrice: fake.bidPrice,
          bidSize: 10,
          askPrice: fake.askPrice,
          askSize: 10,
          freshness: { observedAt: 1_000_000, source: "info_api", staleAfterMillis: 2_000 },
        },
        freshness: { observedAt: 1_000_000, source: "info_api", staleAfterMillis: 5_000 },
      }),
    // The real gateway answers `maxBars` with that many bars when the market
    // has them. `historyDepth` is how far back this fake pretends to go: left
    // at zero it hands back the fixture whatever is asked for, which is what
    // every test that does not care about lookback depth wants.
    getMarketHistory: (request: { readonly maxBars?: number }) =>
      Effect.succeed({
        market: "ETH",
        interval: "1m",
        candles: olderBarsBefore(
          fake.candles,
          Math.min(request.maxBars ?? 0, fake.historyDepth) - fake.candles.length,
        ).concat(fake.candles),
        freshness: { observedAt: 1_000_000, source: "info_api", staleAfterMillis: 5_000 },
      }),
    // `trading_look` reads all three (plan 29 step 6.1), so the fake answers
    // them from the same book the rest of the exchange stub is built on.
    resolveMarket: () =>
      Effect.succeed({
        symbol: "ETH",
        assetIndex: 1,
        szDecimals: 4,
        maxLeverage: 25,
        available: true,
      }),
    getOrderBook: () =>
      Effect.succeed({
        market: "ETH",
        bids: fake.book?.bids ?? [{ price: fake.bidPrice, size: 10 }],
        asks: fake.book?.asks ?? [{ price: fake.askPrice, size: 10 }],
        bestBidOffer: {
          bidPrice: fake.bidPrice,
          bidSize: 10,
          askPrice: fake.askPrice,
          askSize: 10,
          freshness: { observedAt: 1_000_000, source: "info_api", staleAfterMillis: 2_000 },
        },
        freshness: { observedAt: 1_000_000, source: "info_api", staleAfterMillis: 2_000 },
      }),
    getPosition: () =>
      Effect.succeed({
        market: "ETH",
        size: fake.positionSize,
        ...(fake.positionSize === 0 ? {} : { entryPrice: 3_000 }),
        unrealisedPnl: fake.positionUnrealisedPnl ?? 0,
        cumulativeFunding: fake.positionCumulativeFunding ?? 0,
        marginUsed: fake.positionSize === 0 ? 0 : 100,
        freshness: { observedAt: 1_000_000, source: "info_api", staleAfterMillis: 5_000 },
      }),
    // The real gateway answers with the rate AND when it was observed; the
    // caller applies its own staleness window to that timestamp.
    getTakerFeeRateBps: () => Effect.succeed({ feeBps: 4.5, observedAt: 1_000_000 }),
    // The cost estimator reads both sides at once. Without this the estimate
    // fell back to the authority's rate and priced every round trip wrong.
    getUserFeeRatesBps: () =>
      Effect.succeed({
        takerFeeBps: 4.5,
        makerFeeBps: 1.5,
        makerRateSource: "read" as const,
        observedAt: 1_000_000,
      }),
  } as unknown as HyperliquidGateway["Service"]);

const fakeCostEstimator = Layer.succeed(TradingCostEstimator, {
  estimate: (input: { readonly notionalUsd?: number | undefined }) =>
    Effect.succeed({
      market: "ETH",
      // Every field the contract declares as required, because the `as
      // unknown` cast below means an omitted one is a runtime undefined that
      // only surfaces when something encodes the whole estimate — which
      // `trading_look`'s position scope does, as a masked "internal server
      // error" (see the regression test at the bottom of this file).
      sizeEth: 0.25,
      notionalUsd: input.notionalUsd ?? 1_000,
      referencePrice: 4_000,
      takerFeeBpsPerSide: 4.5,
      makerFeeBpsPerSide: 1.5,
      feeRateSource: "hyperliquid_user_fees" as const,
      entryFeeUsd: 0.45,
      exitFeeUsd: 0.45,
      roundTripUsd: 1,
      roundTripFeeUsd: 0.9,
      halfSpreadUsd: 0.05,
      roundTripSpreadUsd: 0.1,
      buySlippageUsd: 0,
      sellSlippageUsd: 0,
      roundTripSlippageUsd: 0,
      bookDepthSufficient: true,
      // The resting orientations the flat cost line now carries; omitting
      // either is the encode failure this cast cannot surface at compile time.
      roundTripTakerMakerUsd: 0.7,
      roundTripMakerMakerUsd: 0.3,
      breakEvenPriceMoveUsd: 3,
      breakEvenPriceMovePercent: 0.075,
      // Twice the round trip, as the real estimator derives it. The `as
      // unknown` cast below means an omitted field is a runtime undefined the
      // contract declares as a number, so it must be stated.
      preferredTargetUsd: 2,
      measuredAt: 1_000_000,
      freshness: { observedAt: 1_000_000, source: "info_api", staleAfterMillis: 2_000 },
      degraded: false,
      notes: [],
    }),
} as unknown as TradingCostEstimator["Service"]);

/**
 * The REAL cost estimator, priced over the fake book.
 *
 * `fakeCostEstimator` above serves fixed numbers so reads stay byte-identical;
 * the two floor tests need the arithmetic itself under test, and the only
 * honest way to get it is the production estimator over a book that does not
 * move. The fake quotes 3,009.5 / 3,010.5 with ten ETH a side, so a $1,000
 * notional crosses a $1.00 spread and walks no depth at all: every figure
 * below is a constant, not a sample of whatever the testnet looked like.
 */
const measuredCostEstimator = (fake: FakeExchange) =>
  TradingCostEstimatorLive.pipe(Layer.provide(exchangeGatewayLayer(fake)));

const exchangeExecutionLayer = (fake: FakeExchange) =>
  Layer.succeed(HyperliquidExecutionService, {
    submitCancel: (input: { readonly cloid: string }) =>
      Effect.sync(() => {
        fake.cancels.push(input.cloid);
        fake.orders = fake.orders.filter((order) => order.cloid !== input.cloid);
      }),
    submitWorkingEntry: () => Effect.die("not used"),
    submitOrder: () => Effect.die("not used"),
    submitProtectiveStop: () => Effect.die("not used"),
    submitReduceOnlyIoc: () => Effect.die("not used"),
  } as unknown as HyperliquidExecutionService["Service"]);

/**
 * The fake-exchange trading layer, over a temp archive path.
 *
 * The default path deliberately does not exist, which is the honest fixture for
 * "the archiver has not been running": every archive-backed fetch key answers
 * `unavailable` with a reason (plan 38 §2.4). Tests that want archive data seed
 * a real file and pass its path.
 */
const tradingLayerOverExchange = (
  fake: FakeExchange,
  archivePath: string = NodePath.join(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-trading-mcp-archive-")),
    "market-archive.sqlite",
  ),
  costEstimator: Layer.Layer<TradingCostEstimator> = fakeCostEstimator,
  /** Bind-on-first-use drives the entry path, so its tests supply a real one. */
  entryService: Layer.Layer<TradingEntryService> = Layer.succeed(
    TradingEntryService,
    {} as unknown as TradingEntryService["Service"],
  ),
) =>
  Layer.mergeAll(
    // Bind-on-first-use reads the provider its credential belongs to and takes
    // the decision lease for the chat turn. Neither is an exchange service, so
    // both are stand-ins here; `adoptedTurns` is what the tests assert on.
    makeProviderRegistryLayer(),
    Layer.succeed(TradingTurnCoordinator, {
      requestRun: () => Effect.die("not used"),
      requestUserMessageRun: () => Effect.die("not used"),
      adoptTurn: (input: { readonly missionId: string; readonly threadId: string }) =>
        Effect.sync(() => {
          adoptedTurns.push(input);
          return true;
        }),
    } as unknown as TradingTurnCoordinator["Service"]),
    // `trading_look` reaches the exchange directly, so the fake gateway is part
    // of what this layer offers rather than only an input to the services.
    exchangeGatewayLayer(fake),
    // The fetch path's archive seam and inbox peek (plan 38 §2).
    Layer.succeed(TradingMarketArchive, makeTradingMarketArchive(archivePath)),
    TradingEventInboxLive,
    // The idea record and its paper ledger. Both read the same memory database
    // the rest of this layer does, and the validation service is here because
    // `trading_hypothesis` enriches a filed idea's runs with its verdicts.
    TradingHypothesisServiceLive,
    // The event calendar: read by the engines and by alert_when_setup.
    TradingEventServiceLive,
    TradingThesisValidationServiceLive.pipe(
      Layer.provide(Layer.succeed(TradingMarketArchive, makeTradingMarketArchive(archivePath))),
      Layer.provide(TradingEventServiceLive),
    ),
    TradingMissionServiceLive,
    TradingStrategyServiceLive,
    TradingWatchServiceLive,
    TradingJournalServiceLive,
    // The publish path's TRADE.md attribution refresh: SQL only, and a
    // workspace with no activated document is a no-op.
    TradingPlanDocumentServiceLive,
    TradingTradeHistoryServiceLive,
    TradingCalibrationServiceLive,
    // The analyst's `trading_watch` writes account-scoped notify alerts
    // (Phase 8) through the real service, over the same fake exchange. The
    // projection doorbell is a no-op: nothing in these tests subscribes.
    TradingAlertServiceLive.pipe(
      Layer.provide(exchangeGatewayLayer(fake)),
      Layer.provide(
        Layer.succeed(TradingAccountProjection, {
          invalidate: () => Effect.void,
        } as unknown as TradingAccountProjection["Service"]),
      ),
    ),
    // Which market the thread is about, written by `trading_look` and by
    // taking authority. Real, over the same memory database, so the tests can
    // read the row back; the doorbell is the same no-op stand-in.
    TradingThreadMarketServiceLive.pipe(
      Layer.provide(
        Layer.succeed(TradingAccountProjection, {
          invalidate: () => Effect.void,
        } as unknown as TradingAccountProjection["Service"]),
      ),
    ),
    // `trading_exit`'s `move_stop` runs for real against the fake book.
    TradingStopAdjustmentServiceLive.pipe(
      Layer.provide(exchangeGatewayLayer(fake)),
      Layer.provide(TradingMissionServiceLive),
      Layer.provide(TradingStrategyServiceLive),
    ),
    // The publish aftermath's direct withdrawal, through the same service the
    // reactor's retirement path uses.
    Layer.effect(TradingWorkingOrderService, makeTradingWorkingOrderService).pipe(
      Layer.provide(exchangeGatewayLayer(fake)),
      Layer.provide(exchangeExecutionLayer(fake)),
    ),
    // The publish aftermath reconciles protection through this service; the
    // retraction under test is the working-entry half, so the stop/target
    // reconcile is a no-op stand-in. Everything else the toolkit needs but
    // these paths never call is present only so the layer can build.
    Layer.succeed(TradingPlanProtectionService, {
      reconcilePlan: () => Effect.succeed(null),
    } as unknown as TradingPlanProtectionService["Service"]),
    // `trading_look` prices its one cost line through this. The default is a
    // fixed estimate, which keeps the read deterministic and byte-identical;
    // the tests that grade the number pass `measuredCostEstimator` instead.
    costEstimator,
    // The one read IS the composer's gather step (plan 29 step 6.1), so the
    // toolkit needs it wherever `trading_look` is exercised.
    TradingWakeupComposerLive.pipe(
      Layer.provide(exchangeGatewayLayer(fake)),
      Layer.provide(TradingMissionServiceLive),
      Layer.provide(TradingWatchServiceLive),
      Layer.provide(TradingStrategyServiceLive),
      Layer.provide(costEstimator),
    ),
    // The exit path stops at the reactor, which this layer does not run. These
    // two stand in for it so the handler's own AFTERMATH — the resting entry
    // withdrawn with the close — is reachable without a live execution loop.
    Layer.succeed(TradingExecutionOutcome, {
      awaitOutcome: () =>
        Effect.succeed({
          status: "filled" as const,
          cloid: "0xfakeexit000000000000000000000001",
          orderResults: [],
          budget: { remainingCumulativeLossUsd: 0, exhausted: false },
        }),
    } as unknown as TradingExecutionOutcome["Service"]),
    entryService,
    Layer.succeed(TradingExitService, {
      prepare: (request: { readonly missionId: string; readonly market?: string }) =>
        Effect.succeed({
          outcome: "accepted" as const,
          intent: {
            missionId: request.missionId,
            executionSequence: 7,
            actionType: "close" as const,
            market: "ETH" as const,
            side: "sell" as const,
            size: 0.0103,
            orderPreference: "marketable_ioc" as const,
            limitPrice: 3_000,
            reduceOnly: true,
          },
          expectedAuthorityVersion: 1,
          activeHarnessRunId: "run_funnel",
          note: null,
        }),
    } as unknown as TradingExitService["Service"]),
    // The test double occupies the real layer's seam. Its service set overlaps
    // but does not equal the real one, so the cast is what lets one
    // `mcpLayerOver` take either.
  ) as unknown as typeof TradingLayerLive;

/**
 * Either the real trading runtime or the fake-exchange rebuild above.
 *
 * The fake stands in for the real layer at the same seam, so it is typed as it
 * rather than unioned with it: the two offer overlapping but unequal service
 * sets, and a union of layers is not a layer anything can be provided from.
 * `tradingLayerOverExchange` casts itself into this shape.
 */
type TradingLayerInput = typeof TradingLayerLive;

const mcpLayerOver = (tradingLayer: TradingLayerInput) =>
  McpHttpServer.layer.pipe(
    Layer.provideMerge(McpSessionRegistry.layer),
    Layer.provideMerge(tradingLayer),
    Layer.provideMerge(NodeSqliteClient.layerMemory()),
    // Memory database: the trading lease trivially holds, no lock file.
    Layer.provide(Layer.succeed(TradingLeaseTarget, { dbPath: ":memory:" })),
    Layer.provide(recordingEngine),
    Layer.provide(PreviewAutomationBroker.layer),
    Layer.provide(Layer.succeed(ServerEnvironment.ServerEnvironment, fakeEnvironment)),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-trading-mcp-" })),
    Layer.provide(NodeServices.layer),
  );

const TradingMcpLayer = mcpLayerOver(TradingLayerLive);

/**
 * Boot the real endpoint, migrate, seed one mission bound to `BOUND_THREAD`,
 * and hand back a `callTool` bound to a freshly minted credential. The
 * trading layer is swappable so a test can run the same real endpoint over a
 * faked exchange.
 */
const withMcpServer = <A, E>(
  body: (context: {
    readonly callTool: (
      threadId: ThreadId,
      name: string,
      args: unknown,
    ) => Effect.Effect<{ readonly result?: any; readonly error?: any }, never, never>;
    readonly missions: TradingMissionService["Service"];
    /** Register one active watch, as a watch tool would. */
    readonly seedActiveWatch: (watchId: string) => Effect.Effect<void, never, never>;
    /** Record one level event, as the watch evaluator would. */
    readonly seedLevelEvent: (input: {
      readonly id: string;
      readonly level: number;
      readonly kind: string;
      readonly occurredAt: number;
    }) => Effect.Effect<void, never, never>;
    /** Queue one pending inbox event, as a watch evaluator would. */
    readonly seedInboxEvent: (input: {
      readonly id: string;
      readonly category: string;
      readonly summary: string;
      readonly occurredAt: number;
    }) => Effect.Effect<void, never, never>;
    /** Record one reconciled fill, as the reconciler would. */
    readonly seedFill: (input: {
      readonly fillId: string;
      readonly orderId: number;
      readonly closedPnl: number;
      readonly feeUsd: number;
    }) => Effect.Effect<void, never, never>;
    /** Record one closed trade, as the reconciler would when a position exits. */
    readonly seedClosedTrade: (input: {
      readonly tradeId: string;
      readonly closedAt: number;
      readonly strategyVersion: number;
      readonly targetProfitUsd: number;
      readonly peak: number;
      readonly trough: number;
      readonly netPnl: number;
      readonly stopNoiseFloorMultiple?: number | undefined;
    }) => Effect.Effect<void, never, never>;
    /** Give the mission's account a master wallet, as bootstrap would. */
    readonly seedTradingAccount: () => Effect.Effect<void, never, never>;
    /** Record an open position, as the reconciler would. */
    readonly seedPosition: (input: {
      readonly size: number;
      readonly entryPrice: number;
      readonly unrealisedPnl?: number | undefined;
      /** The reconciler's high-water mark, when the test needs a drawdown. */
      readonly peakUnrealisedPnl?: number | undefined;
    }) => Effect.Effect<void, never, never>;
    /** Publish a plan row directly, with a known `updatedAt`. */
    readonly seedPlan: (input: {
      readonly updatedAt: number;
      readonly profitUsd?: number | undefined;
    }) => Effect.Effect<void, never, never>;
    /** The entry record carrying this position's approved stop and planned loss. */
    readonly seedEntryRecord: (input: {
      readonly stopPrice: number;
      readonly plannedLossUsd: number;
      readonly createdAt: number;
    }) => Effect.Effect<void, never, never>;
    /** Open one harness run, as a wake would — the run the funnel records against. */
    readonly seedHarnessRun: () => Effect.Effect<void, never, never>;
    /** The account bind-on-first-use creates its missions against. */
    readonly seedLocalTradingAccount: () => Effect.Effect<void, never, never>;
    /** Give the local user an active mission on `market`, as a bind would. */
    readonly seedLocalMissionOn: (input: {
      readonly missionId: string;
      readonly market: string;
      readonly threadId: string;
      /**
       * The holding chat's title, when the test wants the refusal to name it.
       * Omitted seeds no `projection_threads` row, which is the deleted-thread
       * case the refusal has to survive.
       */
      readonly threadTitle?: string;
    }) => Effect.Effect<void, never, never>;
    /** What the open run recorded as its first execution refusal, if anything. */
    readonly readFirstRefusal: () => Effect.Effect<string | null, never, never>;
    /** The market noted on a thread, for the panel beside the chat. */
    readonly readThreadMarket: (threadId: string) => Effect.Effect<string | null, never, never>;
    /**
     * Persist the thread's workspace cwd, as the GLM-1 native-session seam
     * would: the row the plan-document tool resolves the workspace through.
     */
    readonly seedThreadWorkspace: (
      threadId: string,
      cwd: string,
    ) => Effect.Effect<void, never, never>;
    /** Count of activated TRADE.md revisions pinned for a workspace root. */
    readonly countPlanDocumentRows: (workspaceRoot: string) => Effect.Effect<number, never, never>;
    /**
     * Register an analyst thread in the persisted registry, as
     * `TradingAnalystService.ensureThread` would: the row the handlers'
     * analyst scope checks read.
     */
    readonly seedAnalystThread: (threadId: string) => Effect.Effect<void, never, never>;
  }) => Effect.Effect<A, E, HttpServer.HttpServer>,
  tradingLayer: TradingLayerInput = TradingLayerLive,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      dispatchedCommands.length = 0;
      adoptedTurns.length = 0;
      const built = yield* Layer.build(
        HttpRouter.serve(mcpLayerOver(tradingLayer), {
          disableListenLog: true,
          disableLogger: true,
        }),
      );
      const registry = Context.get(built, McpSessionRegistry.McpSessionRegistry);
      const missions = Context.get(built, TradingMissionService);
      const sql = Context.get(built, SqlClient.SqlClient);
      const seedActiveWatch = (watchId: string) =>
        sql`
          INSERT INTO trading_watches (
            watch_id, mission_id, watch_json, status, version,
            created_at, updated_at
          ) VALUES (
            ${watchId}, ${MISSION_ID},
            '{"type":"price_cross","market":"ETH","priceSource":"mark","direction":"above","price":3200}',
            'active', 1, 1, 1
          )
        `.pipe(Effect.asVoid, Effect.orDie);
      const seedFill = (input: {
        readonly fillId: string;
        readonly orderId: number;
        readonly closedPnl: number;
        readonly feeUsd: number;
      }) =>
        sql`
          INSERT INTO trading_fills (
            fill_id, mission_id, execution_id, cloid, order_id, market, side,
            filled_size, avg_fill_price, fee_usd, fee_token, closed_pnl,
            traded_at, observed_at
          ) VALUES (
            ${input.fillId}, ${MISSION_ID}, NULL, NULL, ${input.orderId}, 'ETH', 'sell',
            1, 3000, ${input.feeUsd}, 'USDC', ${input.closedPnl}, 1, 1
          )
        `.pipe(Effect.asVoid, Effect.orDie);
      const seedClosedTrade = (input: {
        readonly tradeId: string;
        readonly closedAt: number;
        readonly strategyVersion: number;
        readonly targetProfitUsd: number;
        readonly peak: number;
        readonly trough: number;
        readonly netPnl: number;
        readonly stopNoiseFloorMultiple?: number | undefined;
      }) =>
        sql`
          INSERT INTO trading_closed_trades (
            mission_id, market, opened_at, closed_at, hold_millis, direction, size,
            entry_price, exit_price, realized_pnl, fees_paid, net_pnl,
            peak_unrealised_pnl, trough_unrealised_pnl, giveback_from_peak,
            fill_count, strategy_version, target_profit_usd, stop_noise_floor_multiple
          ) VALUES (
            ${MISSION_ID}, 'ETH', ${input.closedAt - 60_000}, ${input.closedAt}, 60000, 'long', 1,
            1900, 1905, ${input.netPnl + 1}, 1, ${input.netPnl},
            ${input.peak}, ${input.trough}, 0, 2, ${input.strategyVersion},
            ${input.targetProfitUsd}, ${input.stopNoiseFloorMultiple ?? null}
          )
        `.pipe(Effect.asVoid, Effect.orDie);
      const seedTradingAccount = () =>
        sql`
          INSERT INTO trading_accounts (
            account_id, user_id, environment, master_wallet_json,
            execution_wallet_json, status, created_at, updated_at
          ) VALUES (
            'acct_mcp_trading', 'user_mcp_trading', 'testnet',
            ${JSON.stringify({
              privyWalletId: "wal_mcp_trading",
              address: "0x1234567890abcdef1234567890abcdef12345678",
              ownership: "user",
            })},
            '{"privyWalletId":"wal_mcp_trading","address":"0x0000000000000000000000000000000000000001","hyperliquidAgentName":"t3","status":"ready"}',
            'ready', 1, 1
          )
          ON CONFLICT (account_id) DO NOTHING
        `.pipe(Effect.asVoid, Effect.orDie);
      const seedPosition = (input: {
        readonly size: number;
        readonly entryPrice: number;
        readonly unrealisedPnl?: number | undefined;
        readonly peakUnrealisedPnl?: number | undefined;
      }) =>
        sql`
          INSERT INTO trading_position_snapshots (
            mission_id, market, size, entry_price, unrealised_pnl,
            margin_used, protected_size, observed_at, opened_at, peak_unrealised_pnl
          ) VALUES (
            ${MISSION_ID}, 'ETH', ${input.size}, ${input.entryPrice},
            ${input.unrealisedPnl ?? 5}, 100, 0, 1_000_000, 400_000,
            ${input.peakUnrealisedPnl ?? null}
          )
        `.pipe(Effect.asVoid, Effect.orDie);
      const seedPlan = (input: {
        readonly updatedAt: number;
        readonly profitUsd?: number | undefined;
      }) =>
        sql`
          INSERT INTO trading_plan_history (mission_id, version, strategy_json, created_at)
          VALUES (
            ${MISSION_ID}, 1,
            ${JSON.stringify({
              market: "ETH",
              intent: "long",
              entry: {
                triggers: [{ description: "5m candle closes above 3,200" }],
                urgency: "now",
              },
              stop: { method: "Beneath the breakout low." },
              target: { profitUsd: input.profitUsd ?? 20 },
              invalidation: ["Range high is lost on a 15m close."],
              reassess: { afterMinutes: 90 },
              because: "range break",
              updatedAt: input.updatedAt,
            })},
            ${input.updatedAt}
          )
        `.pipe(Effect.asVoid, Effect.orDie);
      /**
       * The entry record that carries this position's approved stop.
       *
       * `created_at` deliberately PRECEDES the position's `opened_at`: that is
       * the real order of the two stamps (the record is written before the
       * order is signed, the snapshot when a later pass sees the fill), and
       * the envelope lookup has to reach back past it.
       */
      const seedEntryRecord = (input: {
        readonly stopPrice: number;
        readonly plannedLossUsd: number;
        readonly createdAt: number;
      }) =>
        sql`
          INSERT INTO trading_execution_records (
            execution_id, mission_id, execution_sequence, action_type,
            cloid, idempotency_key, market, side, size, limit_price, time_in_force,
            reduce_only, signer_address, status, order_results_json,
            stop_price, planned_loss_at_stop_usd, created_at, updated_at
          ) VALUES (
            'exec_entry_envelope', ${MISSION_ID}, 1, 'open',
            '0xentrycloid00000000000000000001', 'idem_entry_envelope', 'ETH', 'buy', 0.5, 3000, 'ioc',
            0, '0x0000000000000000000000000000000000000001', 'filled', '[]',
            ${input.stopPrice}, ${input.plannedLossUsd}, ${input.createdAt}, ${input.createdAt}
          )
        `.pipe(Effect.asVoid, Effect.orDie);
      const seedLevelEvent = (input: {
        readonly id: string;
        readonly level: number;
        readonly kind: string;
        readonly occurredAt: number;
      }) =>
        sql`
          INSERT INTO trading_level_events
            (event_id, mission_id, market, level, kind, price, occurred_at)
          VALUES (
            ${input.id}, ${MISSION_ID}, 'ETH', ${input.level}, ${input.kind},
            ${input.level}, ${input.occurredAt}
          )
        `.pipe(Effect.asVoid, Effect.orDie);
      /** Queue one pending inbox event, as a watch evaluator would. */
      const seedInboxEvent = (input: {
        readonly id: string;
        readonly category: string;
        readonly summary: string;
        readonly occurredAt: number;
      }) =>
        sql`
          INSERT INTO trading_event_inbox
            (event_id, mission_id, category, deduplication_key, payload_json, status, occurred_at, summary, created_at)
          VALUES (
            ${input.id}, ${MISSION_ID}, ${input.category}, ${input.id}, '{}', 'pending',
            ${input.occurredAt}, ${input.summary}, 1
          )
        `.pipe(Effect.asVoid, Effect.orDie);
      const seedHarnessRun = () =>
        sql`
          INSERT INTO trading_harness_runs (run_id, mission_id, cause, status, started_at, created_at)
          VALUES ('run_funnel', ${MISSION_ID}, 'scheduled_reassessment', 'starting', 1000, 1000)
        `.pipe(Effect.asVoid, Effect.orDie);
      const seedLocalTradingAccount = () =>
        sql`
          INSERT INTO trading_accounts (
            account_id, user_id, environment, master_wallet_json,
            execution_wallet_json, status, created_at, updated_at
          ) VALUES (
            ${LOCAL_TRADING_ACCOUNT_ID}, ${LOCAL_TRADING_USER_ID}, 'testnet',
            ${JSON.stringify({
              privyWalletId: "wal_local_trading",
              address: "0x1234567890abcdef1234567890abcdef12345678",
              ownership: "user",
            })},
            '{"privyWalletId":"wal_local_trading","address":"0x0000000000000000000000000000000000000002","hyperliquidAgentName":"t3","status":"ready"}',
            'ready', 1, 1
          )
        `.pipe(Effect.asVoid, Effect.orDie);
      const seedLocalMissionOn = (input: {
        readonly missionId: string;
        readonly market: string;
        readonly threadId: string;
        readonly threadTitle?: string;
      }) =>
        Effect.gen(function* () {
          if (input.threadTitle !== undefined) {
            yield* sql`
              INSERT INTO projection_threads (
                thread_id, project_id, title, created_at, updated_at
              ) VALUES (
                ${input.threadId}, 'project_local', ${input.threadTitle},
                '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
              )
            `;
          }
          yield* missions.createMission({
            missionId: input.missionId,
            userId: LOCAL_TRADING_USER_ID,
            tradingAccountId: LOCAL_TRADING_ACCOUNT_ID,
            instruction: `Trade ${input.market}`,
            allocatedCapitalUsd: 500,
            market: input.market,
            harness: {
              provider: "claude",
              providerInstanceId: PROVIDER_INSTANCE,
              threadId: ThreadId.make(input.threadId),
              status: "available",
            },
          });
        }).pipe(Effect.asVoid, Effect.orDie);
      const readFirstRefusal = () =>
        sql<{ readonly first_preview_refusal: string | null }>`
          SELECT first_preview_refusal FROM trading_harness_runs WHERE run_id = 'run_funnel'
        `.pipe(
          Effect.map((rows) => rows[0]?.first_preview_refusal ?? null),
          Effect.orDie,
        );
      const readThreadMarket = (threadId: string) =>
        sql<{ readonly asset: string }>`
          SELECT asset FROM trading_thread_market_focus WHERE thread_id = ${threadId}
        `.pipe(
          Effect.map((rows) => rows[0]?.asset ?? null),
          Effect.orDie,
        );
      const seedThreadWorkspace = (threadId: string, cwd: string) =>
        sql`
          INSERT INTO provider_session_runtime (
            thread_id, provider_name, provider_instance_id, adapter_key,
            runtime_mode, workspace_mode, status, last_seen_at,
            resume_cursor_json, runtime_payload_json
          ) VALUES (
            ${threadId}, 'codex', 'instance_1', 'codex',
            'full-access', 'market_research', 'stopped', '2026-08-31T00:00:00Z',
            NULL, ${JSON.stringify({ cwd })}
          )
          ON CONFLICT (thread_id) DO UPDATE SET runtime_payload_json = excluded.runtime_payload_json
        `.pipe(Effect.asVoid, Effect.orDie);
      // The persisted analyst registry the handlers' scope checks read: the
      // server-side fence, independent of the in-memory session-profile map.
      const seedAnalystThread = (threadId: string) =>
        sql`
          INSERT INTO trading_analyst_threads (venue, asset, thread_id, created_at)
          VALUES ('hyperliquid_testnet', 'ETH', ${threadId}, 1)
          ON CONFLICT (venue, asset) DO UPDATE SET thread_id = excluded.thread_id
        `.pipe(Effect.asVoid, Effect.orDie);
      const countPlanDocumentRows = (workspaceRoot: string) =>
        sql<{ readonly n: number }>`
          SELECT COUNT(*) AS n FROM trading_plan_documents WHERE workspace_root = ${workspaceRoot}
        `.pipe(
          Effect.map((rows) => rows[0]?.n ?? 0),
          Effect.orDie,
        );
      const httpClient = yield* HttpClient.HttpClient;

      // Unpinned: this endpoint serves whatever the production schema is, and a
      // pin here silently withholds columns the handlers read. It was 66, so
      // migration 067's `trading_journal.author` was missing and every tool
      // call failed — the journal read rides every tool result, so one absent
      // column took the whole toolkit down in a test that named none of it.
      yield* runMigrations().pipe(Effect.provide(built), Effect.orDie);
      yield* missions
        .createMission({
          missionId: MISSION_ID,
          userId: "user_mcp_trading",
          tradingAccountId: "acct_mcp_trading",
          // A mandate the length real ones are: the abridging test below has
          // nothing to measure against an eighteen-character one.
          instruction: MANDATE,
          allocatedCapitalUsd: 1_000,
          harness: {
            provider: "claude",
            providerInstanceId: PROVIDER_INSTANCE,
            threadId: BOUND_THREAD,
            status: "available",
          },
        })
        .pipe(Effect.orDie);

      const callTool = (threadId: ThreadId, name: string, args: unknown) =>
        Effect.gen(function* () {
          const issued = yield* registry.issue({ threadId, providerInstanceId: PROVIDER_INSTANCE });
          const authorization = issued.config.authorizationHeader;
          const accept = "application/json, text/event-stream";

          const initialize = yield* httpClient.post("/mcp", {
            headers: { accept, authorization },
            body: HttpBody.jsonUnsafe({
              jsonrpc: "2.0",
              id: 1,
              method: "initialize",
              params: {
                protocolVersion: "2025-06-18",
                capabilities: {},
                clientInfo: { name: "trading-test", version: "1.0.0" },
              },
            }),
          });
          const sessionId = initialize.headers["mcp-session-id"];
          expect(initialize.status).toBe(200);

          const response = yield* httpClient.post("/mcp", {
            headers: {
              accept,
              authorization,
              "mcp-session-id": sessionId!,
              // 2025-06-18 requires every post-initialize request to name the
              // negotiated protocol version; without it the transport rejects
              // the call before it reaches a handler.
              "mcp-protocol-version": "2025-06-18",
            },
            body: HttpBody.jsonUnsafe({
              jsonrpc: "2.0",
              id: 2,
              method: "tools/call",
              params: { name, arguments: args },
            }),
          });
          return withDecodedBody(parseJsonRpc(yield* response.text));
        }).pipe(Effect.orDie);

      return yield* body({
        callTool,
        missions,
        seedActiveWatch,
        seedFill,
        seedClosedTrade,
        seedTradingAccount,
        seedPosition,
        seedPlan,
        seedEntryRecord,
        seedHarnessRun,
        seedLevelEvent,
        seedInboxEvent,
        readFirstRefusal,
        readThreadMarket,
        seedThreadWorkspace,
        seedAnalystThread,
        countPlanDocumentRows,
        seedLocalTradingAccount,
        seedLocalMissionOn,
      });
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest));

it.effect("serves trading_look and a versioned publish over the real /mcp endpoint", () =>
  withMcpServer(
    ({ callTool, seedTradingAccount }) =>
      Effect.gen(function* () {
        // The market half reads the account through the mission's master wallet.
        yield* seedTradingAccount();
        const initial = yield* callTool(BOUND_THREAD, "trading_look", {
          missionId: MISSION_ID,
          fetch: ["snapshot", "position", "watches"],
        });
        assert.equal(initial.result.isError, false);
        // The result rides once. A `structuredContent` copy beside the text was
        // byte-identical, so a 40k-char read was charged twice on every turn.
        assert.equal(initial.result.structuredContent, undefined);
        assert.equal(initial.result.content.length, 1);
        assert.equal(initial.result.content[0].type, "text");
        const before = initial.result.body.mission;
        assert.equal(before.mission.id, MISSION_ID);
        assert.equal(before.mission.status, "initializing");
        assert.equal(before.missionVersion, 1);
        assert.equal(before.strategy, undefined);
        // Plan 35: the authority, the harness and the control flags are read
        // off the mission row. They used to ride beside it as well.
        assert.equal(before.authority, undefined);
        assert.equal(before.harness, undefined);
        assert.equal(before.mission.authorityVersion, 1);
        assert.equal(before.mission.authority.allocatedCapitalUsd, 1_000);
        assert.equal(before.mission.harness.threadId, BOUND_THREAD);
        assert.deepStrictEqual(before.watches, []);
        // The market half of the same answer, which used to be eleven more calls.
        assert.equal(initial.result.body.market, "ETH");
        assert.equal(initial.result.body.position.size, 0);
        assert.equal(typeof initial.result.body.snapshot.markPrice, "number");

        const published = yield* callTool(BOUND_THREAD, "trading_plan", {
          missionId: MISSION_ID,
          expectedMissionVersion: 1,
          strategy: strategyBody("overnight range break"),
        });
        assert.equal(published.result.isError, false);
        assert.equal(published.result.body.outcome, "accepted");
        assert.equal(published.result.body.strategy.intent, "long");

        const after = yield* callTool(BOUND_THREAD, "trading_look", {
          missionId: MISSION_ID,
          fetch: ["plan"],
        });
        assert.equal(after.result.body.mission.missionVersion, 2);
        assert.equal(after.result.body.mission.strategy.because, "overnight range break");

        // The accepted publish was announced on the orchestration engine, which
        // is what puts it on the server's ordered WS push path — and so was the
        // status the publish settled the mission on (§11.1 `analysing → waiting`
        // happens inside the publish write, so the UI has to hear about it too).
        assert.deepStrictEqual(
          dispatchedCommands.map((command) => command.type),
          ["trading.mission.strategy-published", "trading.mission.status-set"],
        );
      }),
    // Over the faked exchange, so the market half of the one read is answered
    // without reaching Hyperliquid.
    tradingLayerOverExchange(makeFakeExchange()),
  ),
);

it.effect("rejects a stale expectedMissionVersion over MCP and leaves the plan intact", () =>
  withMcpServer(({ callTool }) =>
    Effect.gen(function* () {
      yield* callTool(BOUND_THREAD, "trading_plan", {
        missionId: MISSION_ID,
        expectedMissionVersion: 1,
        strategy: strategyBody("v1"),
      });

      const stale = yield* callTool(BOUND_THREAD, "trading_plan", {
        missionId: MISSION_ID,
        // The publish above bumped the mission row's version to 2.
        expectedMissionVersion: 1,
        strategy: strategyBody("v2 attempt from a stale reader"),
      });
      assert.equal(stale.result.isError, false);
      assert.deepStrictEqual(stale.result.body, {
        outcome: "rejected",
        reason: "stale_mission_state",
        currentVersion: 2,
      });

      // v1 survived the rejected publish untouched.
      const current = yield* callTool(BOUND_THREAD, "trading_look", {
        missionId: MISSION_ID,
        fetch: ["plan"],
      });
      assert.equal(current.result.body.mission.missionVersion, 2);
      assert.equal(current.result.body.mission.strategy.because, "v1");
    }),
  ),
);

it.effect("keeps the prior version's active watches working across an accepted publish", () =>
  withMcpServer(({ callTool, seedActiveWatch }) =>
    Effect.gen(function* () {
      yield* callTool(BOUND_THREAD, "trading_plan", {
        missionId: MISSION_ID,
        expectedMissionVersion: 1,
        strategy: strategyBody("v1"),
      });

      yield* seedActiveWatch("watch_v1_active");

      const republished = yield* callTool(BOUND_THREAD, "trading_plan", {
        missionId: MISSION_ID,
        expectedMissionVersion: 2,
        strategy: strategyBody("v2"),
      });
      assert.equal(republished.result.body.outcome, "accepted");

      // Plan 29 step 4.2: revising the plan does not touch the watches. The
      // trigger armed under v1 keeps working until the model itself cancels
      // or replaces it.
      const current = yield* callTool(BOUND_THREAD, "trading_look", {
        missionId: MISSION_ID,
        fetch: ["watches"],
      });
      const watches = current.result.body.mission.watches;
      assert.equal(watches.length, 1);
      assert.equal(watches[0].status, "active");
    }),
  ),
);

// Phase 3.3: a lean wake hands the run a fired trigger and little else. The
// picture it needs back has to be reachable in a couple of priced fetch
// calls, each bounded — otherwise the lean wake has only moved the context
// cost one call to the right.
it.effect("rebuilds a reacting turn's picture from priced fetch keys", () => {
  const fake = makeFakeExchange();
  return withMcpServer(
    ({ callTool, seedActiveWatch, seedTradingAccount }) =>
      Effect.gen(function* () {
        // The market half reads the account through the mission's master wallet.
        yield* seedTradingAccount();
        yield* callTool(BOUND_THREAD, "trading_plan", {
          missionId: MISSION_ID,
          expectedMissionVersion: 1,
          strategy: strategyBody("v1"),
        });
        yield* seedActiveWatch("watch_scoped_look");

        // One: what price just did, bounded to the bars actually named.
        const bars = yield* callTool(BOUND_THREAD, "trading_look", {
          missionId: MISSION_ID,
          fetch: ["candles:1m:6"],
        });
        const barsRead = bars.result.body;
        assert.isAtMost(barsRead.candles.bars.length, 6);
        // Everything a reaction did not ask for stayed home.
        assert.equal(barsRead.structure, undefined);
        assert.equal(barsRead.account, undefined);
        assert.equal(barsRead.orderBook, undefined);
        assert.equal(barsRead.trades, undefined);
        // A pure market key carries no mission half at all.
        assert.equal(barsRead.mission, undefined);

        // Two: what the mission holds, and the registry beside it.
        const held = yield* callTool(BOUND_THREAD, "trading_look", {
          missionId: MISSION_ID,
          fetch: ["position", "account", "watches"],
        });
        const heldRead = held.result.body;
        assert.equal(heldRead.position.size, 0);
        assert.notEqual(heldRead.account, undefined);
        assert.equal(heldRead.candles, undefined);
        assert.equal(heldRead.structure, undefined);
        assert.equal(heldRead.mission.bound, true);
        assert.notEqual(heldRead.mission.mission.authority, undefined);
        assert.equal(heldRead.mission.watches.length, 1);
        // The retrospective halves are their own keys, not implied.
        assert.equal(heldRead.mission.journal, undefined);
        assert.equal(heldRead.mission.strategyHistory, undefined);
        assert.equal(heldRead.mission.targetCalibration, undefined);

        // Three: the back-catalogue, priced by name.
        const retrospect = yield* callTool(BOUND_THREAD, "trading_look", {
          missionId: MISSION_ID,
          fetch: ["journal", "plan_history"],
        });
        const retrospectRead = retrospect.result.body;
        assert.notEqual(retrospectRead.mission.strategyHistory, undefined);
        assert.notEqual(retrospectRead.mission.journal, undefined);
      }),
    tradingLayerOverExchange(fake),
  );
});

// Plan 36 item 8. 17 `trading_look` calls came to 293,500 characters — 82% of
// one mission's entire context, against 35,589 for all 21 of its wake payloads
// combined. The model asked for 120 bars on essentially every turn and used
// them to recompute ema(20) and ema(50), which the server had already computed
// and sent beside them. Thirteen of those turns concluded "no setup".
// The epoch base is 20m ms, not the 4m the shared fixture uses: 150 bars plus
// the 100 the deeper indicator read prepends reach 250 minutes back, and a
// negative openTime cannot encode as `UnixMillis`.
const manyCandles = Array.from({ length: 150 }, (_, i) => ({
  openTime: 20_000_000 - (150 - i) * 60_000,
  closeTime: 20_000_000 - (150 - i) * 60_000 + 59_000,
  open: 3_010,
  close: 3_010 + (i % 7),
  high: 3_020,
  low: 3_000,
  volume: 100,
}));

it.effect("reads an ema(50) back far enough to be the chart's number", () => {
  // 150 bars in hand, and `ema(50)` wants 250. The 100 it does not have are
  // held at 2,500 against a series around 3,010, so a reading seeded inside the
  // short window and one seeded before it cannot be confused for each other.
  const fake = makeFakeExchange({ candles: manyCandles, historyDepth: 250 });
  return withMcpServer(
    ({ callTool, seedTradingAccount }) =>
      Effect.gen(function* () {
        yield* seedTradingAccount();
        const look = yield* callTool(BOUND_THREAD, "trading_look", {
          missionId: MISSION_ID,
          fetch: ["candles:1m:150", "indicators:ema50"],
        });
        const read = look.result.body;
        const reading = read.indicators[0];

        // What the shallow window would have said, computed the same way.
        const shallow = computeIndicator({ kind: "ema", period: 50 }, manyCandles);
        assert.notEqual(reading.value, shallow.value);

        // And what the deep one says: the far-off seed has not fully decayed
        // over 250 bars, so the reading sits below the series it ends in.
        const deep = computeIndicator(
          { kind: "ema", period: 50 },
          olderBarsBefore(manyCandles, 100).concat(manyCandles),
        );
        assert.equal(reading.value, deep.value);
        assert.isBelow(reading.value ?? 0, shallow.value ?? 0);

        // The chart is untouched by the deeper read — same bars, same window.
        // A look must not quote one series and compute its indicator on another.
        assert.equal(read.candles.bars.length, 150);
        assert.equal(read.candles.bars.at(-1)?.[3], manyCandles.at(-1)?.close);
      }),
    tradingLayerOverExchange(fake),
  );
});

it.effect("reads a 50-period EMA the same however much chart rode back", () => {
  const fake = makeFakeExchange({ candles: manyCandles });
  return withMcpServer(
    ({ callTool, seedTradingAccount }) =>
      Effect.gen(function* () {
        yield* seedTradingAccount();
        const wide = yield* callTool(BOUND_THREAD, "trading_look", {
          missionId: MISSION_ID,
          fetch: ["candles:1m:120", "indicators:ema50"],
        });
        const narrow = yield* callTool(BOUND_THREAD, "trading_look", {
          missionId: MISSION_ID,
          fetch: ["candles:1m:5", "indicators:ema50"],
        });
        // Readings are computed over the full fetched lookback and only the
        // echoed table is bounded by the candles key beside them.
        assert.isTrue(Number.isFinite(wide.result.body.indicators[0].value));
        assert.equal(wide.result.body.indicators[0].value, narrow.result.body.indicators[0].value);
        assert.equal(narrow.result.body.candles.bars.length, 5);
      }),
    tradingLayerOverExchange(fake),
  );
});

it.effect("computes the indicators a look asks for, on bars already fetched", () => {
  const fake = makeFakeExchange();
  return withMcpServer(
    ({ callTool, seedTradingAccount }) =>
      Effect.gen(function* () {
        yield* seedTradingAccount();
        const look = yield* callTool(BOUND_THREAD, "trading_look", {
          missionId: MISSION_ID,
          fetch: ["candles:1m:6", "indicators:ema3", "indicators:vwap", "indicators:sma200"],
        });
        const read = look.result.body;
        assert.equal(read.indicators.length, 3);
        // The request's kind and period are echoed; unnamed periods default.
        assert.equal(read.indicators[0].kind, "ema");
        assert.equal(read.indicators[0].period, 3);
        assert.equal(read.indicators[1].kind, "vwap");
        // Computed on the FULL fetched window, not the 6-bar slice riding
        // back — the values exist even though only 6 bars were returned.
        assert.isTrue(Number.isFinite(read.indicators[0].value));
        assert.isTrue(Number.isFinite(read.indicators[1].value));
        assert.isTrue(Number.isFinite(read.indicators[0].previous));
        // A period longer than the window is an absent value, never a zero.
        assert.equal(read.indicators[2].value, undefined);
      }),
    tradingLayerOverExchange(fake),
  );
});

// Plan 35 step 1: the window rides back as a table. Six numbers a row in the
// column order the header names, and the stamps the row form repeated on every
// bar are reconstructible from the two it states.
it.effect("returns the chart as a compact table, bounded to the bars named", () => {
  const fake = makeFakeExchange();
  return withMcpServer(
    ({ callTool, seedTradingAccount }) =>
      Effect.gen(function* () {
        yield* seedTradingAccount();

        const both = yield* callTool(BOUND_THREAD, "trading_look", {
          missionId: MISSION_ID,
          fetch: ["candles:1m:5"],
        });
        assert.equal(both.result.body.candles.bars.length, 5);
        const table = both.result.body.candles;
        assert.equal(table.columns, "open,high,low,close,volume,trades");
        assert.equal(table.intervalMillis, 60_000);
        assert.isTrue(Number.isFinite(table.firstOpenTime));
        assert.deepStrictEqual(
          table.bars.map((row: ReadonlyArray<number>) => row.length),
          [6, 6, 6, 6, 6],
        );

        // `candles:1m:0` asks for the measurements' window and none of the
        // chart, and a window with no bars states no first stamp.
        const none = yield* callTool(BOUND_THREAD, "trading_look", {
          missionId: MISSION_ID,
          fetch: ["candles:1m:0"],
        });
        assert.equal(none.result.body.candles.bars.length, 0);
        assert.equal(none.result.body.candles.firstOpenTime, undefined);
      }),
    tradingLayerOverExchange(fake),
  );
});

// Plan 34 step 1.2: the structure read rides back as verdicts, not as the
// thirty measured features per timeframe the detectors scored on.
it.effect("returns the structure read digested, and the candidate table once", () => {
  const fake = makeFakeExchange();
  return withMcpServer(
    ({ callTool, seedTradingAccount }) =>
      Effect.gen(function* () {
        yield* seedTradingAccount();
        const look = yield* callTool(BOUND_THREAD, "trading_look", {
          missionId: MISSION_ID,
          fetch: ["structure"],
        });
        const structure = look.result.body.structure;
        assert.notEqual(structure, undefined);
        assert.notEqual(structure.regime, undefined);
        assert.notEqual(structure.alignment, undefined);
        // This mission's mandate names the 1m, so its thesis frame is the
        // mandated 1m — the one frame whose gated readings ride back whole.
        for (const frame of structure.timeframes) {
          assert.isString(frame.interval);
          assert.isNumber(frame.directionScore);
          assert.isNumber(frame.atrUsd);
          if (frame.interval === "1m") continue;
          // The detector-only half stays behind on the context frames: nothing
          // downstream of the scoring reads it, and four frames of it was
          // 4,700 characters.
          assert.equal(frame.pivotTrend, undefined);
          assert.equal(frame.ema, undefined);
          assert.equal(frame.excursionSymmetryRatio, undefined);
        }
        // And the thesis frame carries what the playbooks gate on — the whole
        // of the `ema_cross` procedure reads fields that lived only here.
        const thesis = structure.timeframes.find(
          (frame: { readonly interval: string }) => frame.interval === "1m",
        );
        assert.isNumber(thesis?.ema?.separationAtr);
        assert.isDefined(thesis?.rsi?.condition);

        // A mission-less look names no interval and answers to no mandate, so
        // its thesis frame is the 5m base default — the doctrine's frame, and
        // the proof the unbound default moved off 1m.
        const unbound = yield* callTool(UNBOUND_THREAD, "trading_look", {
          fetch: ["structure"],
        });
        const unboundStructure = unbound.result.body.structure;
        assert.notEqual(unboundStructure, undefined);
        const unboundThesis = unboundStructure.timeframes.find(
          (frame: { readonly interval: string }) => frame.interval === "5m",
        );
        assert.isNumber(unboundThesis?.ema?.separationAtr);
        assert.isDefined(unboundThesis?.rsi?.condition);
        // A candidate carries every field of the setup it was built from plus
        // the cost of taking it, so the two tables are never both sent.
        assert.isTrue(structure.candidates === undefined || structure.setups === undefined);
      }),
    tradingLayerOverExchange(fake),
  );
});

// The `range_reversion` doctrine says to read `levelHistory` before arming.
// It was gathered by `observe` and dropped at every exit, so the sentence
// pointed at a field no tool returned. (Its sibling, `previousStructureRead`
// riding the `structure` key, is pinned by its own fetch test below.)
it.effect("serves the level memory the doctrine says to read before arming", () => {
  const fake = makeFakeExchange();
  return withMcpServer(
    ({ callTool, seedTradingAccount, seedLevelEvent }) =>
      Effect.gen(function* () {
        yield* seedTradingAccount();
        yield* seedLevelEvent({
          id: "e1",
          level: 3_010,
          kind: "closed_through",
          occurredAt: 900_000,
        });
        yield* seedLevelEvent({
          id: "e2",
          level: 3_010,
          kind: "closed_through",
          occurredAt: 950_000,
        });

        const look = yield* callTool(BOUND_THREAD, "trading_look", {
          missionId: MISSION_ID,
          fetch: ["levels"],
        });

        const history = look.result.body.levelHistory;
        assert.isDefined(history, "expected the levels key to carry the level memory");
        assert.equal(history[0].closedThrough, 2);
        // The key's archive half cannot answer here (no archive file); its
        // absence is named, never a zero.
        assert.include(look.result.body.unavailable?.[0]?.reason ?? "", "session levels");
      }),
    tradingLayerOverExchange(fake),
  );
});

// Plan 34 step 1.3: the mandate does not change for a mission's life, so a
// reacting turn does not re-read a thousand characters of it every wake.
it.effect("abridges the mandate on the mission half of a fetch read", () => {
  const fake = makeFakeExchange();
  return withMcpServer(
    ({ callTool, seedTradingAccount }) =>
      Effect.gen(function* () {
        yield* seedTradingAccount();
        const live = yield* callTool(BOUND_THREAD, "trading_look", {
          missionId: MISSION_ID,
          fetch: ["watches"],
        });
        const abridged = live.result.body.mission.mission.instruction;

        // The seeded mandate is the length real ones are, so it abridges.
        assert.isBelow(abridged.length, MANDATE.length);
        assert.include(abridged, "mandate abridged");
      }),
    tradingLayerOverExchange(fake),
  );
});

it.effect("answers an unbound thread instead of failing every tool on it", () =>
  withMcpServer(({ callTool }) =>
    Effect.gen(function* () {
      // A thread with no live mission is not an authorization failure for a
      // read: `trading_look` says so in-band, so the agent can learn that its
      // mission ended rather than seeing every tool error.
      const unbound = yield* callTool(UNBOUND_THREAD, "trading_look", {
        missionId: MISSION_ID,
        fetch: ["plan"],
      });
      assert.notEqual(unbound.result.isError, true);
      assert.equal(unbound.result.body.mission, undefined);
      assert.include(unbound.result.body.unavailable[0].reason, "no mission bound");

      // A bound thread naming someone else's mission is still refused, firmly.
      const wrongMission = yield* callTool(BOUND_THREAD, "trading_look", {
        missionId: "mission_belonging_to_someone_else",
      });
      assert.equal(wrongMission.result.isError, true);
      assert.match(wrongMission.result.content[0].text, /cannot act on the mission it named/);
      assert.include(
        wrongMission.result.content[0].text,
        `[reason=mission_not_bound_to_thread, thread=${BOUND_THREAD}, mission=mission_belonging_to_someone_else]`,
      );
      assert.notEqual(wrongMission.result.content[0].text, INTERNAL_ERROR_TEXT);
    }),
  ),
);

it.effect("keeps write tools closed on an unbound thread", () =>
  withMcpServer(({ callTool }) =>
    Effect.gen(function* () {
      const published = yield* callTool(UNBOUND_THREAD, "trading_plan", {
        missionId: MISSION_ID,
        expectedMissionVersion: 1,
        strategy: strategyBody("v1"),
      });
      assert.equal(published.result.isError, true);
      // Naming another thread's mission is a mismatch, not a market to take:
      // bind-on-first-use never answers it with a mission of its own.
      assert.match(published.result.content[0].text, /holds no trading authority/);
      assert.include(
        published.result.content[0].text,
        `[reason=thread_not_bound_to_mission, thread=${UNBOUND_THREAD}, mission=${MISSION_ID}]`,
      );
    }),
  ),
);

// -- bind-on-first-use -------------------------------------------------------
//
// Chat is the front door. A thread that has never held a mission places an
// order, and the order goes out: the mission is created, bound to that thread,
// and the entry carries on inside the SAME call. What is under test is that the
// agent never needs a second attempt.

/** The thread that has held nothing and is about to take a market. */
const FRESH_CHAT_THREAD = ThreadId.make("thread-fresh-chat");

/** An entry service that records what it was asked for and prepares an intent. */
const preparedEntries: Array<{ readonly missionId: string; readonly market: string }> = [];
const recordingEntryService = Layer.succeed(TradingEntryService, {
  prepare: (request: { readonly missionId: string; readonly market: string }) =>
    Effect.sync(() => {
      preparedEntries.push({ missionId: request.missionId, market: request.market });
      return {
        outcome: "prepared" as const,
        intent: {
          missionId: request.missionId,
          executionSequence: 1,
          actionType: "open" as const,
          market: request.market,
          side: "buy" as const,
          size: 0.1,
          orderPreference: "marketable_ioc" as const,
          limitPrice: 3_010,
          stop: { stopPrice: 2_900, plannedLossAtStopUsd: 11 },
          reduceOnly: false,
        },
        expectedAuthorityVersion: 1,
        activeHarnessRunId: "run_adopted",
        size: 0.1,
        constrainedBy: "requested" as const,
        notionalUsd: 301,
        plannedLossAtStopUsd: 11,
        estimatedRoundTripCostUsd: 1,
        notes: [],
      };
    }),
} as unknown as TradingEntryService["Service"]);

const bindLayer = () =>
  tradingLayerOverExchange(makeFakeExchange(), undefined, undefined, recordingEntryService);

it.effect("takes authority on a free market and enters in the same call", () =>
  withMcpServer(
    ({ callTool, missions, seedLocalTradingAccount }) =>
      Effect.gen(function* () {
        preparedEntries.length = 0;
        yield* seedLocalTradingAccount();

        // One call. No mission was created first, and none is named.
        const entered = yield* callTool(FRESH_CHAT_THREAD, "trading_enter", {
          market: "SOL",
          side: "buy",
          stopPrice: 2_900,
          sizeEth: 0.1,
        });

        assert.notEqual(entered.result.isError, true);
        assert.equal(entered.result.body.status, "filled");

        // The mission exists, holds the market that was named, and is bound to
        // the chat that named it.
        const bound = yield* missions.findMissionByThreadId(FRESH_CHAT_THREAD).pipe(Effect.orDie);
        assert.equal(bound._tag, "Some");
        const mission = (
          bound as {
            readonly value: {
              readonly market: string;
              readonly status: string;
              readonly id: string;
            };
          }
        ).value;
        assert.equal(mission.market, "SOL");
        // `waiting` is what an entry is reachable from; the §11.1 walk ran.
        assert.equal(mission.status, "waiting");

        // The entry carried on into the same invocation, against the mission
        // that had just been created for it.
        assert.deepStrictEqual(preparedEntries, [{ missionId: mission.id, market: "SOL" }]);

        // The chat turn took the decision lease, so the execution checks that
        // ask who owns it have an answer.
        assert.deepStrictEqual(adoptedTurns, [
          { missionId: mission.id, threadId: FRESH_CHAT_THREAD },
        ]);

        // And the order actually went to the reactor.
        const requested = dispatchedCommands.filter(
          (command) => command.type === "trading.execution.requested",
        );
        assert.equal(requested.length, 1);
      }),
    bindLayer(),
  ),
);

// -- the market beside the chat ---------------------------------------------
//
// The companion panel is driven by one row per thread. These assert that the
// two tool paths write it: the read the agent takes, and the market it takes
// authority on.

it.effect("notes the market a look resolved, so the chat panel follows it", () =>
  withMcpServer(({ callTool, readThreadMarket }) =>
    Effect.gen(function* () {
      // An unbound chat naming a market: the panel has something to draw before
      // any authority exists, which is the whole point of showing it.
      const looked = yield* callTool(UNBOUND_THREAD, "trading_look", { market: "SOL" });
      assert.notEqual(looked.result.isError, true);
      assert.equal(yield* readThreadMarket(UNBOUND_THREAD), "SOL");

      // Most recent wins: looking elsewhere moves the panel with the reading.
      yield* callTool(UNBOUND_THREAD, "trading_look", { market: "BTC", fetch: ["snapshot"] });
      assert.equal(yield* readThreadMarket(UNBOUND_THREAD), "BTC");

      // A bound thread's look resolves the mission's own market without being
      // told it, and the panel gets that.
      yield* callTool(BOUND_THREAD, "trading_look", {});
      assert.equal(yield* readThreadMarket(BOUND_THREAD), "ETH");
    }),
  ),
);

it.effect("notes the market a chat took authority on", () =>
  withMcpServer(
    ({ callTool, seedLocalTradingAccount, readThreadMarket }) =>
      Effect.gen(function* () {
        preparedEntries.length = 0;
        yield* seedLocalTradingAccount();

        yield* callTool(FRESH_CHAT_THREAD, "trading_enter", {
          market: "SOL",
          side: "buy",
          stopPrice: 2_900,
          sizeEth: 0.1,
        });

        assert.equal(yield* readThreadMarket(FRESH_CHAT_THREAD), "SOL");
      }),
    bindLayer(),
  ),
);

it.effect("refuses a market another authority holds, and places nothing", () =>
  withMcpServer(
    ({ callTool, missions, seedLocalTradingAccount, seedLocalMissionOn }) =>
      Effect.gen(function* () {
        preparedEntries.length = 0;
        yield* seedLocalTradingAccount();
        yield* seedLocalMissionOn({
          missionId: "mission_holding_sol",
          market: "SOL",
          threadId: "thread-holding-sol",
          threadTitle: "SOL momentum watch",
        });

        const refused = yield* callTool(FRESH_CHAT_THREAD, "trading_enter", {
          market: "SOL",
          side: "buy",
          stopPrice: 2_900,
          sizeEth: 0.1,
        });

        assert.equal(refused.result.isError, true);
        const text = refused.result.content[0].text as string;
        // The holder is named in words the model relays, and the ways out come
        // with it — a refusal the user cannot act on costs the turn twice.
        // "another mission" was all it used to say, which told the user a
        // market was taken and gave them nowhere to look: the chat's own title
        // is what they can find in the thread list.
        assert.include(text, 'The chat "SOL momentum watch" already holds SOL');
        // What that mission is doing, since a waiting one is not on the trade
        // home and a position-holding one is.
        assert.include(text, "starting up");
        assert.include(text, "the trade home does not list it");
        assert.include(text, "from that chat");
        assert.include(text, "What you can do:");
        assert.include(text, "[reason=market_held_by_other_authority");
        assert.notInclude(text, "—");

        // Nothing was taken and nothing was sent.
        const bound = yield* missions.findMissionByThreadId(FRESH_CHAT_THREAD).pipe(Effect.orDie);
        assert.equal(bound._tag, "None");
        assert.deepStrictEqual(preparedEntries, []);
        assert.deepStrictEqual(adoptedTurns, []);
        assert.equal(
          dispatchedCommands.filter((command) => command.type === "trading.execution.requested")
            .length,
          0,
        );
      }),
    bindLayer(),
  ),
);

it.effect("publishing a plan on a fresh chat takes the market it names, in one call", () =>
  withMcpServer(
    ({ callTool, missions, seedLocalTradingAccount }) =>
      Effect.gen(function* () {
        yield* seedLocalTradingAccount();

        // Zero is what a harness with no mission actually sends: it has never
        // seen a version because there was nothing to read one from. The bind
        // this same call performs creates the mission and walks it through
        // §11.1 to `waiting`, so by the time the publish runs the row is at 3
        // — and the optimistic lock used to refuse it as `stale_mission_state`,
        // spending the first plan of every chat-started thread on a retry.
        const published = yield* callTool(FRESH_CHAT_THREAD, "trading_plan", {
          expectedMissionVersion: 0,
          strategy: strategyBody("first plan from chat"),
        });

        assert.notEqual(published.result.isError, true);
        assert.equal(published.result.body.outcome, "accepted");

        const bound = yield* missions.findMissionByThreadId(FRESH_CHAT_THREAD).pipe(Effect.orDie);
        assert.equal(bound._tag, "Some");
      }),
    bindLayer(),
  ),
);

// The other half of the same rule: once a thread HOLDS its mission, the lock
// is real again. A second plan quoting the version the first one superseded is
// the concurrent-writer case the lock exists for, and it is still refused.
it.effect("keeps the version lock on a chat that already holds its mission", () =>
  withMcpServer(
    ({ callTool, seedLocalTradingAccount }) =>
      Effect.gen(function* () {
        yield* seedLocalTradingAccount();

        const first = yield* callTool(FRESH_CHAT_THREAD, "trading_plan", {
          expectedMissionVersion: 0,
          strategy: strategyBody("first plan from chat"),
        });
        assert.equal(first.result.body.outcome, "accepted");

        const stale = yield* callTool(FRESH_CHAT_THREAD, "trading_plan", {
          expectedMissionVersion: 0,
          strategy: strategyBody("second plan on a stale version"),
        });
        assert.equal(stale.result.body.outcome, "rejected");
        assert.equal(stale.result.body.reason, "stale_mission_state");
      }),
    bindLayer(),
  ),
);

it.effect("still refuses a second active mission for the same user", () =>
  withMcpServer(({ missions }) =>
    Effect.gen(function* () {
      const error = yield* missions
        .createMission({
          missionId: "mission_second",
          userId: "user_mcp_trading",
          tradingAccountId: "acct_mcp_trading",
          instruction: "Trade ETH momentum again",
          allocatedCapitalUsd: 500,
          harness: {
            provider: "claude",
            providerInstanceId: PROVIDER_INSTANCE,
            threadId: ThreadId.make("thread-second"),
            status: "available",
          },
        })
        .pipe(Effect.flip);

      assert.equal(error._tag, "TradingMissionAlreadyActiveError");
      assert.equal((error as { activeMissionId: string }).activeMissionId, MISSION_ID);
    }),
  ),
);

it.effect("registers a watch before the first plan is published", () =>
  withMcpServer(({ callTool }) =>
    Effect.gen(function* () {
      // The mission was seeded with no published plan. A watch registered now
      // must persist, result-encode, and announce — watches bind the mission,
      // not a plan (plan 29 step 4.2), so there is nothing to be below.
      const registered = yield* callTool(BOUND_THREAD, "trading_watch", {
        missionId: MISSION_ID,
        // A bare level: no `confirm`, no `priceSource`. Both default, and the
        // persisted predicate below is the proof of what they defaulted to.
        condition: { kind: "price", market: "ETH", direction: "above", price: 3200 },
      });
      assert.equal(registered.result.isError, false);
      assert.equal(registered.result.body.outcome, "armed");
      const registeredWatch = registered.result.body.watch;
      // Nothing was named to replace, so nothing was.
      assert.equal(registered.result.body.replaced, undefined);
      assert.equal(registeredWatch.status, "active");
      assert.equal(registeredWatch.watch.type, "price_cross");

      // The registry rides the one read now (plan 29 step 6.5).
      const listed = yield* callTool(BOUND_THREAD, "trading_look", {
        missionId: MISSION_ID,
        fetch: ["watches"],
      });
      assert.equal(listed.result.isError, false);
      const watches = listed.result.body.mission.watches;
      assert.equal(watches.length, 1);
      // Plan 35: the model is handed a handle, never the whole UUID.
      assert.equal(watches[0].id, registeredWatch.id.slice(0, 8));

      // Plan 33 fix B: the row is what the model reads, so it carries the
      // lifecycle and the re-armable condition and nothing that only restated
      // the look it arrived in.
      assert.deepStrictEqual(Object.keys(watches[0]).sort(), [
        "condition",
        "createdAt",
        "id",
        "status",
        "updatedAt",
      ]);

      // The announce path succeeded rather than hitting its
      // "could not announce a registered watch" warning: a watch-registered
      // command reached the recording engine.
      assert.deepStrictEqual(
        dispatchedCommands.map((command) => command.type),
        ["trading.mission.watch-registered"],
      );

      // And the handle it was handed is the one it can retire with. Plan 35:
      // the model is never shown an id it cannot send back.
      const retired = yield* callTool(BOUND_THREAD, "trading_watch", {
        missionId: MISSION_ID,
        cancel: watches[0].id,
      });
      assert.equal(retired.result.body.outcome, "cancelled");
      assert.equal(retired.result.body.watch.id, registeredWatch.id);
    }),
  ),
);

// Plan 29 step 6.3: the model writes conditions, so the model has to read
// conditions. `watch` is the persisted encoding and is no longer a name any
// call accepts — a harness that re-armed what it read would be writing
// `pnl_giveback` into a tool that only takes `giveback`.
it.effect("reads a watch back in the vocabulary it can re-arm it with", () =>
  withMcpServer(({ callTool, seedTradingAccount }) =>
    Effect.gen(function* () {
      // A `giveback` is account-scoped, so it needs an install that has an
      // account: without one the arm is refused at the door (see the keyless
      // suite below), and this test is about the vocabulary, not the refusal.
      yield* seedTradingAccount();
      yield* callTool(BOUND_THREAD, "trading_watch", {
        missionId: MISSION_ID,
        condition: { kind: "giveback", market: "ETH", drawdownUsd: 4 },
      });

      const listed = yield* callTool(BOUND_THREAD, "trading_look", { fetch: ["watches"] });
      const readBack = listed.result.body.mission.watches[0].condition;
      assert.deepStrictEqual(readBack, { kind: "giveback", market: "ETH", drawdownUsd: 4 });

      // The proof that matters: what came out of the read goes back into the
      // tool unedited and arms.
      const rearmed = yield* callTool(BOUND_THREAD, "trading_watch", { condition: readBack });
      assert.equal(rearmed.result.isError, false);
      assert.equal(rearmed.result.body.outcome, "armed");
    }),
  ),
);

// Plan 29 step 6.3: a condition the server will not arm comes back as an
// outcome carrying what to do about it, not as a thrown error. All three of
// these are rules about the condition, so all three stand down — retrying the
// identical call gets the identical answer.
it.effect("refuses a condition it cannot arm, and arms nothing", () =>
  withMcpServer(({ callTool }) =>
    Effect.gen(function* () {
      const cases = [
        {
          condition: {
            kind: "price",
            market: "ETH",
            direction: "above",
            price: 3200,
            confirm: "close",
          },
          reason: "close_needs_interval",
        },
        {
          condition: { kind: "pnl", market: "ETH", direction: "above", valueUsd: -4 },
          reason: "pnl_target_not_a_gain",
        },
        { condition: { kind: "fill" }, reason: "fill_needs_order_or_market" },
      ];

      for (const expected of cases) {
        const refused = yield* callTool(BOUND_THREAD, "trading_watch", {
          condition: expected.condition,
        });
        // A refusal is a successful call with a refusing answer.
        assert.equal(refused.result.isError, false);
        const body = refused.result.body;
        assert.equal(body.outcome, "refused");
        assert.equal(body.reason, expected.reason);
        assert.equal(body.recovery.action, "stand_down");
        assert.equal(body.recovery.retryable, false);
      }

      // Nothing was armed and nothing was announced, three refusals later.
      const listed = yield* callTool(BOUND_THREAD, "trading_look", { fetch: ["watches"] });
      assert.equal(listed.result.body.mission.watches.length, 0);
      assert.deepStrictEqual(dispatchedCommands, []);
    }),
  ),
);

// Plan 29 step 6.4: the journal is append-only, and one tool both writes and
// reads it — the field the model writes is the field it reads back.
it.effect("appends a note and reads it back in the words it was written in", () =>
  withMcpServer(({ callTool }) =>
    Effect.gen(function* () {
      const first = yield* callTool(BOUND_THREAD, "trading_journal", {
        missionId: MISSION_ID,
        // The leading space is deliberate: a note is normalised, not rejected,
        // for whitespace it did not mean.
        note: "  3200 chopped me twice; waiting for a 15m close above it ",
      });
      assert.equal(first.result.isError, false);
      assert.equal(first.result.body.outcome, "noted");
      assert.equal(
        first.result.body.entry.note,
        "3200 chopped me twice; waiting for a 15m close above it",
      );
      // A note the model wrote says so (plan 29 step 8.4). The tool never takes
      // an author from its caller — a model that could sign a note `user` could
      // manufacture an instruction it was never given — so this is the server's
      // statement about which surface made the call.
      assert.equal(first.result.body.entry.author, "model");

      yield* callTool(BOUND_THREAD, "trading_journal", { note: "the 1m read disagrees" });

      // A call with no `note` writes nothing and hands back what is there,
      // newest first.
      const read = yield* callTool(BOUND_THREAD, "trading_journal", {});
      assert.equal(read.result.body.outcome, "read");
      // Newest first, and the first note is still exactly what it was. This
      // file shares one mission across its tests, so assert the two notes'
      // relative order rather than the whole list.
      const notes: ReadonlyArray<string> = read.result.body.entries.map(
        (entry: { note: string }) => entry.note,
      );
      const older = notes.indexOf("3200 chopped me twice; waiting for a 15m close above it");
      const newer = notes.indexOf("the 1m read disagrees");
      assert.isAbove(older, -1);
      // Both notes land in the same millisecond, so this is only stable
      // because the read breaks the tie on insertion order rather than on the
      // random uuid the note is keyed by.
      assert.isAbove(older, newer);
      assert.equal(read.result.body.entry, undefined);

      // And the turn sees it without asking: the journal exists to survive a
      // plan revision, which it cannot do if the model has to spend a call to
      // remember it wrote something.
      const look = yield* callTool(BOUND_THREAD, "trading_look", { fetch: ["journal"] });
      const onTheTurn: ReadonlyArray<string> = look.result.body.mission.journal.map(
        (entry: { note: string }) => entry.note,
      );
      assert.include(onTheTurn, "the 1m read disagrees");
    }),
  ),
);

// The refusal carries a `recovery` from `classifyFailure`, like every other
// refusal in the toolkit — and it still returns the journal, so a model told
// its note was too long does not need a second call to see what it has.
it.effect("refuses a note it will not record, and records nothing", () =>
  withMcpServer(({ callTool }) =>
    Effect.gen(function* () {
      yield* callTool(BOUND_THREAD, "trading_journal", { note: "kept" });

      for (const bad of ["   ", "x".repeat(1_001)]) {
        const refused = yield* callTool(BOUND_THREAD, "trading_journal", { note: bad });
        assert.equal(refused.result.isError, false);
        const body = refused.result.body;
        assert.equal(body.outcome, "refused");
        assert.equal(body.recovery.action, "stand_down");
        assert.equal(body.recovery.retryable, false);
        // The journal rides the refusal.
        assert.include(
          body.entries.map((entry: { note: string }) => entry.note),
          "kept",
        );
      }
    }),
  ),
);

it.effect("moves a level atomically through replacesWatchId", () =>
  withMcpServer(({ callTool }) =>
    Effect.gen(function* () {
      const level = (price: number) => ({
        kind: "price" as const,
        market: "ETH" as const,
        direction: "above" as const,
        price,
      });

      const first = yield* callTool(BOUND_THREAD, "trading_watch", {
        condition: level(3200),
      });
      const originalId = first.result.body.watch.id;

      const moved = yield* callTool(BOUND_THREAD, "trading_watch", {
        condition: level(3250),
        replacesWatchId: originalId,
      });
      assert.equal(moved.result.isError, false);
      assert.equal(moved.result.body.replaced.id, originalId);

      // The `watches` key reads the registry in full, the swap included.
      const listed = yield* callTool(BOUND_THREAD, "trading_look", {
        fetch: ["watches"],
      });
      const watches = listed.result.body.mission.watches;
      const byId = new Map(watches.map((w: { id: string; status: string }) => [w.id, w.status]));
      assert.equal(byId.get(originalId.slice(0, 8)), "cancelled");
      assert.equal(byId.get(moved.result.body.watch.id.slice(0, 8)), "active");

      // Both halves of the swap reach the workspace: an unannounced cancel
      // leaves a level rendered that is no longer standing.
      assert.deepStrictEqual(
        dispatchedCommands.map((command) => command.type),
        [
          "trading.mission.watch-registered",
          "trading.mission.watch-registered",
          "trading.mission.watch-cancelled",
        ],
      );
    }),
  ),
);

// Plan 29 step 6.5: cancelling is a `trading_watch` shape, so it is the same
// tool with `cancel` — and the two ways a cancel can miss stay distinguishable.
it.effect("retires a watch through the same tool that armed it", () =>
  withMcpServer(({ callTool }) =>
    Effect.gen(function* () {
      const armed = yield* callTool(BOUND_THREAD, "trading_watch", {
        condition: { kind: "price", market: "ETH", direction: "above", price: 3200 },
      });
      const watchId = armed.result.body.watch.id;

      const cancelled = yield* callTool(BOUND_THREAD, "trading_watch", { cancel: watchId });
      assert.equal(cancelled.result.isError, false);
      assert.equal(cancelled.result.body.outcome, "cancelled");
      assert.equal(cancelled.result.body.watch.status, "cancelled");

      // Already terminal, and never there, stay different facts.
      const again = yield* callTool(BOUND_THREAD, "trading_watch", { cancel: watchId });
      assert.equal(again.result.body.outcome, "rejected");
      assert.equal(again.result.body.reason, "watch_not_active");
      const missing = yield* callTool(BOUND_THREAD, "trading_watch", { cancel: "watch_nope" });
      assert.equal(missing.result.body.reason, "watch_not_found");
    }),
  ),
);

// One call does one thing to the armed set.
// Plan 34 step 6. Armed under the drawdown it names, a giveback is true the
// moment it is written: it fires on the next sweep, and the run wakes to widen
// the same threshold again. The mission this was found on did that twice in
// ninety seconds.
it.effect("refuses a giveback the position has already given back", () => {
  const fake = makeFakeExchange({ positionSize: -0.474 });
  return withMcpServer(
    ({ callTool, seedTradingAccount, seedPosition }) =>
      Effect.gen(function* () {
        yield* seedTradingAccount();
        // Peaked at +$0.62, now +$0.21: $0.41 already given back.
        yield* seedPosition({
          size: -0.474,
          entryPrice: 1_905.11,
          unrealisedPnl: 0.21,
          peakUnrealisedPnl: 0.62,
        });

        const refused = yield* callTool(BOUND_THREAD, "trading_watch", {
          missionId: MISSION_ID,
          condition: { kind: "giveback", market: "ETH", drawdownUsd: 0.25 },
        });
        assert.equal(refused.result.body.outcome, "refused");
        assert.equal(refused.result.body.reason, "giveback_below_current_drawdown");
        assert.include(refused.result.body.detail, "0.41");
        // Reading is the answer, not standing down: the level is a fact about
        // the position, and the position keeps moving.
        assert.equal(refused.result.body.recovery.action, "read_state");

        // Nothing was armed — a refusal changes nothing.
        const look = yield* callTool(BOUND_THREAD, "trading_look", {
          missionId: MISSION_ID,
          fetch: ["watches"],
        });
        assert.equal(look.result.body.mission.watches.length, 0);

        // Above the current drawdown, the same call arms.
        const armed = yield* callTool(BOUND_THREAD, "trading_watch", {
          missionId: MISSION_ID,
          condition: { kind: "giveback", market: "ETH", drawdownUsd: 0.62 },
        });
        assert.equal(armed.result.body.outcome, "armed");
      }),
    tradingLayerOverExchange(fake),
  );
});

// Plan 36 item 6. A target below the round trip that reaches it is a loss with
// extra steps: the mission this was found on published profitUsd 0.34 while
// the same payload carried roundTripUsd 0.5589 and preferredTargetUsd 1.118,
// so hitting the target exactly banked minus eleven cents against $0.45 of
// actual fees. Nothing anywhere said so — the target was armed as published
// and then graded against itself.
// Plan 36 item 5. The mission this was found on published "1m close above
// 1900.14" and "1m close below 1900.14" on every plan and armed both, five
// pairs in a row: one of a straddle at the current price fires on the next bar
// whichever way the market goes. Twelve of its thirteen market wakes were its
// own polling, each paying a full turn to conclude "no setup" from indicators
// that had not moved.
it.effect("refuses a level armed on the other side of one already active", () => {
  const fake = makeFakeExchange({ positionSize: 0 });
  return withMcpServer(
    ({ callTool, seedTradingAccount }) =>
      Effect.gen(function* () {
        yield* seedTradingAccount();

        const above = yield* callTool(BOUND_THREAD, "trading_watch", {
          missionId: MISSION_ID,
          condition: {
            kind: "price",
            market: "ETH",
            price: 1_900.14,
            direction: "above",
            confirm: "close",
            interval: "1m",
          },
        });
        assert.equal(above.result.body.outcome, "armed");
        const incumbent = above.result.body.watch.id;

        const refused = yield* callTool(BOUND_THREAD, "trading_watch", {
          missionId: MISSION_ID,
          condition: {
            kind: "price",
            market: "ETH",
            price: 1_900.14,
            direction: "below",
            confirm: "close",
            interval: "1m",
          },
        });
        assert.equal(refused.result.body.outcome, "refused");
        assert.equal(refused.result.body.reason, "level_mirrors_active_watch");
        // The refusal names the incumbent, so the correction is available
        // without another read.
        assert.include(refused.result.body.detail, incumbent);

        // And nothing was armed: one level, not two.
        const look = yield* callTool(BOUND_THREAD, "trading_look", {
          missionId: MISSION_ID,
          fetch: ["watches"],
        });
        assert.equal(look.result.body.mission.watches.length, 1);
      }),
    tradingLayerOverExchange(fake),
  );
});

it.effect("arms a level genuinely apart, and re-levels the same side through replaces", () => {
  const fake = makeFakeExchange({ positionSize: 0 });
  return withMcpServer(
    ({ callTool, seedTradingAccount }) =>
      Effect.gen(function* () {
        yield* seedTradingAccount();

        const above = yield* callTool(BOUND_THREAD, "trading_watch", {
          missionId: MISSION_ID,
          condition: {
            kind: "price",
            market: "ETH",
            price: 1_900.14,
            direction: "above",
            confirm: "close",
            interval: "1m",
          },
        });
        assert.equal(above.result.body.outcome, "armed");

        // Two levels genuinely apart are two theses, and both arm.
        const farBelow = yield* callTool(BOUND_THREAD, "trading_watch", {
          missionId: MISSION_ID,
          condition: {
            kind: "price",
            market: "ETH",
            price: 1_880,
            direction: "below",
            confirm: "close",
            interval: "1m",
          },
        });
        assert.equal(farBelow.result.body.outcome, "armed");

        // Moving a level is not a mirror, and goes through replacesWatchId.
        const moved = yield* callTool(BOUND_THREAD, "trading_watch", {
          missionId: MISSION_ID,
          replacesWatchId: above.result.body.watch.id,
          condition: {
            kind: "price",
            market: "ETH",
            price: 1_900.14,
            direction: "below",
            confirm: "close",
            interval: "1m",
          },
        });
        assert.equal(moved.result.body.outcome, "armed");
      }),
    tradingLayerOverExchange(fake),
  );
});

it.effect("arms a giveback while the position is at its peak", () => {
  const fake = makeFakeExchange({ positionSize: -0.474 });
  return withMcpServer(
    ({ callTool, seedTradingAccount, seedPosition }) =>
      Effect.gen(function* () {
        yield* seedTradingAccount();
        yield* seedPosition({
          size: -0.474,
          entryPrice: 1_905.11,
          unrealisedPnl: 0.62,
          peakUnrealisedPnl: 0.62,
        });

        const armed = yield* callTool(BOUND_THREAD, "trading_watch", {
          missionId: MISSION_ID,
          condition: { kind: "giveback", market: "ETH", drawdownUsd: 0.1 },
        });
        assert.equal(armed.result.body.outcome, "armed");
      }),
    tradingLayerOverExchange(fake),
  );
});

it.effect("refuses a watch call that names neither a condition nor a cancel", () =>
  withMcpServer(({ callTool }) =>
    Effect.gen(function* () {
      for (const args of [
        {},
        {
          condition: { kind: "price", market: "ETH", direction: "above", price: 3200 },
          cancel: "watch_1",
        },
      ]) {
        const refused = yield* callTool(BOUND_THREAD, "trading_watch", args);
        assert.equal(refused.result.isError, false);
        assert.equal(refused.result.body.outcome, "refused");
        assert.equal(refused.result.body.reason, "needs_condition_or_cancel");
        assert.equal(refused.result.body.recovery.action, "stand_down");
      }
      assert.deepStrictEqual(dispatchedCommands, []);
    }),
  ),
);

it.effect("serves the mission its own completed trades over MCP", () =>
  withMcpServer(({ callTool, seedFill }) =>
    Effect.gen(function* () {
      yield* seedFill({ fillId: "f1", orderId: 100, closedPnl: 12, feeUsd: 1 });
      yield* seedFill({ fillId: "f2", orderId: 200, closedPnl: -4, feeUsd: 1 });

      const read = yield* callTool(BOUND_THREAD, "trading_look", { fetch: ["trades"] });
      assert.equal(read.result.isError, false);
      const history = read.result.body.trades;

      assert.equal(history.orders.length, 2);
      assert.equal(history.summary.realizedPnlUsd, 8);
      assert.equal(history.summary.feesPaidUsd, 2);
      assert.equal(history.summary.netPnlUsd, 6);
      assert.equal(history.summary.winningOrders, 1);
      assert.equal(history.summary.losingOrders, 1);
    }),
  ),
);

it.effect("resolves an omitted missionId to the bound mission for a read tool", () =>
  withMcpServer(({ callTool }) =>
    Effect.gen(function* () {
      // Omitting `missionId` entirely: the call resolves to the one mission the
      // thread is bound to, exactly as naming it would.
      const omitted = yield* callTool(BOUND_THREAD, "trading_look", { fetch: ["watches"] });
      assert.equal(omitted.result.isError, false);
      assert.equal(omitted.result.body.mission.mission.id, MISSION_ID);
    }),
  ),
);

it.effect("resolves an omitted missionId to the bound mission for a write tool", () =>
  withMcpServer(({ callTool }) =>
    Effect.gen(function* () {
      // A publish with no `missionId` reaches the bound mission and revises
      // its plan, just as a publish that named it would.
      const published = yield* callTool(BOUND_THREAD, "trading_plan", {
        expectedMissionVersion: 1,
        strategy: strategyBody("no missionId supplied"),
      });
      assert.equal(published.result.isError, false);
      assert.equal(published.result.body.outcome, "accepted");

      // The bound mission now carries the published plan.
      const after = yield* callTool(BOUND_THREAD, "trading_look", { fetch: ["plan"] });
      assert.equal(after.result.body.mission.strategy.because, "no missionId supplied");
    }),
  ),
);

it.effect("still rejects a wrong missionId with mission_not_bound_to_thread", () =>
  withMcpServer(({ callTool }) =>
    Effect.gen(function* () {
      // An explicit `missionId` that does not match the bound mission is still a
      // firm refusal — making the argument optional did not make it trusted.
      const wrong = yield* callTool(BOUND_THREAD, "trading_look", {
        missionId: "mission_belonging_to_someone_else",
      });
      assert.equal(wrong.result.isError, true);
      assert.match(wrong.result.content[0].text, /cannot act on the mission it named/);
      assert.include(
        wrong.result.content[0].text,
        `[reason=mission_not_bound_to_thread, thread=${BOUND_THREAD}, mission=mission_belonging_to_someone_else]`,
      );
    }),
  ),
);

it.effect("decodes a prose-string entry trigger and round-trips it as the object shape", () =>
  withMcpServer(({ callTool }) =>
    Effect.gen(function* () {
      // A bare prose string where the schema asked for `{ description }` used to
      // fail the whole publish. The lenient input union decodes it to the object
      // shape, and the persisted plan carries the object back out.
      const strategyBodyWithProseTrigger = {
        ...strategyBody("prose trigger"),
        entry: {
          triggers: ["Enter if a finalized 1m candle closes above 3,201."],
          urgency: "now",
        },
      };
      const published = yield* callTool(BOUND_THREAD, "trading_plan", {
        missionId: MISSION_ID,
        expectedMissionVersion: 1,
        strategy: strategyBodyWithProseTrigger,
      });
      assert.equal(published.result.isError, false);
      assert.equal(published.result.body.outcome, "accepted");

      const after = yield* callTool(BOUND_THREAD, "trading_look", {
        missionId: MISSION_ID,
        fetch: ["plan"],
      });
      const triggers = after.result.body.mission.strategy.entry.triggers;
      assert.equal(triggers.length, 1);
      // The persisted/encoded form is the object shape, not the bare string.
      assert.deepStrictEqual(triggers[0], {
        description: "Enter if a finalized 1m candle closes above 3,201.",
      });
    }),
  ),
);

it.effect("refuses an entry outside a turn that owns the decision lease", () =>
  withMcpServer(({ callTool }) =>
    Effect.gen(function* () {
      // No harness run has been opened for this mission, so nothing owns the
      // lease — the check preview item 5 was named for, made real by reading
      // the table the lease actually lives in rather than trusting an argument.
      const entered = yield* callTool(BOUND_THREAD, "trading_enter", {
        market: "ETH",
        side: "buy",
        stopPrice: 3_100,
        sizeEth: 0.1,
      });

      assert.equal(entered.result.isError, false);
      // A refusal reaches the harness in the same result shape a fill does,
      // so one outcome type covers every write it makes.
      assert.equal(entered.result.body.status, "rejected");
      assert.include(entered.result.body.detail, "harness_run_owns_lease");
      assert.equal(entered.result.body.recovery?.retryable, false);
    }),
  ),
);

it.effect("tells the run's funnel that an entry was attempted and refused", () =>
  withMcpServer(({ callTool, seedHarnessRun, readFirstRefusal }) =>
    Effect.gen(function* () {
      yield* seedHarnessRun();

      // An entry is priced and pre-checked before anything is dispatched, so
      // the reactor — which records its own refusals — never sees this one.
      // BTC is free here, so the mission EXTENDS onto it and the refusal comes
      // from the market read the fixture cannot serve; before the held set it
      // came from the mandate guard, which now only fires on a market some
      // other authority holds.
      const entered = yield* callTool(BOUND_THREAD, "trading_enter", {
        market: "BTC",
        side: "buy",
        stopPrice: 3_100,
        sizeEth: 0.1,
      });
      assert.equal(entered.result.body.status, "rejected");

      // Without this the turn records as `no_setup` — the same shape as a turn
      // that never wanted to trade at all.
      assert.include(yield* readFirstRefusal(), "market_data_unavailable");
    }),
  ),
);

it.effect("will not enter without a stop", () =>
  withMcpServer(({ callTool }) =>
    Effect.gen(function* () {
      // The mandatory stop is a required input, so an entry without one never
      // reaches the sizing at all.
      const entered = yield* callTool(BOUND_THREAD, "trading_enter", {
        market: "ETH",
        side: "buy",
      });

      assert.equal(entered.result.isError, true);
      assert.include(entered.result.content[0]?.text ?? "", "stopPrice");
    }),
  ),
);

it.effect("closes a position with a call carrying no arguments at all", () =>
  withMcpServer(({ callTool }) =>
    Effect.gen(function* () {
      // The whole point of the exit tools: there is nothing to get wrong. This
      // mission has no lease, so the refusal is about the turn — not about a
      // side, a size, a version, or a sequence the caller failed to supply.
      const closed = yield* callTool(BOUND_THREAD, "trading_exit", { action: "close" });

      assert.equal(closed.result.isError, false);
      assert.equal(closed.result.body.status, "rejected");
      assert.include(closed.result.body.detail, "harness_run_owns_lease");
      // And the harness is told what to do about it rather than left to guess.
      assert.equal(closed.result.body.recovery.retryable, false);
    }),
  ),
);

it.effect("refuses a reduce that names neither a size nor a fraction", () =>
  withMcpServer(({ callTool }) =>
    Effect.gen(function* () {
      const reduced = yield* callTool(BOUND_THREAD, "trading_exit", { action: "reduce" });

      // A named refusal now, not a decode error: the rule moved off the schema
      // and onto `readExitRequest` when the three exit tools merged, so the
      // model gets a `recovery` instead of a validation message (step 6.5).
      assert.equal(reduced.result.isError, false);
      assert.equal(reduced.result.body.status, "refused_request");
      assert.equal(reduced.result.body.reason, "reduce_needs_one_size");
      assert.equal(reduced.result.body.recovery.action, "stand_down");
    }),
  ),
);

it.effect("refuses a cancel that names no resting order", () =>
  withMcpServer(({ callTool }) =>
    Effect.gen(function* () {
      const cancelled = yield* callTool(BOUND_THREAD, "trading_exit", {
        action: "cancel_order",
        cloid: "",
      });

      assert.equal(cancelled.result.isError, false);
      assert.equal(cancelled.result.body.status, "refused_request");
      assert.equal(cancelled.result.body.reason, "cancel_needs_cloid");
    }),
  ),
);

// -- the stop-adjustment refusals and the publish retraction ------------------
//
// The stop-adjustment service had no coverage at all: the staleness guard
// re-keyed onto the plan's `updatedAt` (plan 29 step 4.2) and the cheap
// mission-state refusals were reachable but unwitnessed. These run the real
// `/mcp` path; the exchange-touching ones use `tradingLayerOverExchange`.

/** The `updatedAt` a stale caller must fail to quote. */
const PLAN_READ_AT = 900_000;

const adjustStopArgs = (expectedPlanUpdatedAt: number) => ({
  action: "move_stop",
  market: "ETH",
  newStopPrice: 2_984,
  justification: "trail_peak",
  expectedPlanUpdatedAt,
});

it.effect("refuses a stop adjustment when the mission holds no position", () =>
  withMcpServer(({ callTool }) =>
    Effect.gen(function* () {
      // The first read the service makes is the position; nothing is seeded.
      const refused = yield* callTool(BOUND_THREAD, "trading_exit", adjustStopArgs(PLAN_READ_AT));

      assert.equal(refused.result.isError, false);
      assert.equal(refused.result.body.status, "refused");
      assert.equal(refused.result.body.refusalCode, "no_position");
    }),
  ),
);

it.effect("refuses a stop adjustment asked against a plan the mission has revised", () => {
  const fake = makeFakeExchange({ orders: [restingProtectiveStop(2_980)] });
  return withMcpServer(
    ({ callTool, seedTradingAccount, seedPosition, seedPlan }) =>
      Effect.gen(function* () {
        yield* seedTradingAccount();
        yield* seedPosition({ size: 0.5, entryPrice: 3_000 });
        yield* seedPlan({ updatedAt: PLAN_READ_AT });

        const refused = yield* callTool(
          BOUND_THREAD,
          "trading_exit",
          adjustStopArgs(PLAN_READ_AT - 1),
        );

        assert.equal(refused.result.isError, false);
        const decision = refused.result.body;
        assert.equal(decision.status, "refused");
        assert.equal(decision.refusalCode, "stale_plan");
        // The refusal cost nothing: the stop the exchange holds is untouched.
        assert.deepEqual(fake.cancels, []);
        assert.equal(fake.orders.length, 1);
      }),
    tradingLayerOverExchange(fake),
  );
});

it.effect("lets a current plan through the staleness guard — the next check refuses", () => {
  // A fresh `expectedPlanUpdatedAt` gets past staleness; with a two-sided book
  // and nothing protective resting, the refusal that answers is
  // `no_resting_stop` — the check that runs after the guard.
  const fake = makeFakeExchange({ orders: [] });
  return withMcpServer(
    ({ callTool, seedTradingAccount, seedPosition, seedPlan }) =>
      Effect.gen(function* () {
        yield* seedTradingAccount();
        yield* seedPosition({ size: 0.5, entryPrice: 3_000 });
        yield* seedPlan({ updatedAt: PLAN_READ_AT });

        const refused = yield* callTool(BOUND_THREAD, "trading_exit", adjustStopArgs(PLAN_READ_AT));

        assert.equal(refused.result.isError, false);
        const decision = refused.result.body;
        assert.equal(decision.status, "refused");
        assert.equal(decision.refusalCode, "no_resting_stop");
      }),
    tradingLayerOverExchange(fake),
  );
});

it.effect("reads the entry's approved stop, which was written before the position was seen", () => {
  // Plan 29 A1a. The envelope query scoped itself to `created_at >= opened_at`
  // and so never found the entry record — the two stamps come from opposite
  // ends of an entry — and fell back to whatever stop was resting. That made a
  // tightened stop permanent: giving room back, even well inside the approval,
  // read as a widening past the envelope.
  //
  // Long 0.5 ETH from 3,000 with an approved stop at 2,946 ($27 of risk). The
  // stop has been trailed in to 2,970; moving it back to 2,955 is $22.50 of
  // risk, inside the approval. Whatever else answers, it must not be
  // `risk_envelope`.
  const fake = makeFakeExchange({ orders: [restingProtectiveStop(2_970)] });
  return withMcpServer(
    ({ callTool, seedTradingAccount, seedPosition, seedPlan, seedEntryRecord }) =>
      Effect.gen(function* () {
        yield* seedTradingAccount();
        yield* seedPosition({ size: 0.5, entryPrice: 3_000 });
        yield* seedEntryRecord({ stopPrice: 2_946, plannedLossUsd: 27, createdAt: 399_000 });
        yield* seedPlan({ updatedAt: PLAN_READ_AT });

        const decision = (yield* callTool(BOUND_THREAD, "trading_exit", {
          ...adjustStopArgs(PLAN_READ_AT),
          newStopPrice: 2_955,
        })).result.body;

        assert.notEqual(decision.refusalCode, "risk_envelope");
      }),
    tradingLayerOverExchange(fake),
  );
});

/**
 * The layer the two cost-floor tests run on: the fake book, priced by the real
 * estimator. A fresh fake per test, because a fake is mutable state.
 */
const costFloorLayer = () => {
  const fake = makeFakeExchange();
  return tradingLayerOverExchange(fake, undefined, measuredCostEstimator(fake));
};

it.effect("refuses a target the round trip would eat, and writes nothing", () =>
  withMcpServer(
    ({ callTool, seedTradingAccount }) =>
      Effect.gen(function* () {
        // The cost read needs the master wallet the account carries.
        yield* seedTradingAccount();

        // Over the fake book the crossing round trip is ~$1.23 on $1,000 (two
        // taker legs at 4.5bps = $0.90, plus the $1.00 spread on a $3,010 mid =
        // $0.33), so the rung is ~$2.46 and the floor under it ~$1.85. A $0.40 target is the
        // shape the measured session published twice after acknowledging the
        // warning both times — it wakes the mission to bank a move that did not
        // pay for itself, and now it does not publish at all.
        const refused = yield* callTool(BOUND_THREAD, "trading_plan", {
          missionId: MISSION_ID,
          expectedMissionVersion: 1,
          strategy: {
            ...strategyBody("a target under the floor"),
            target: { profitUsd: 0.4 },
          },
        });

        assert.equal(refused.result.isError, false);
        assert.equal(refused.result.body.outcome, "rejected");
        assert.equal(refused.result.body.reason, "target_below_cost_floor");
        // Nothing moved, so the version the harness retries against is the one
        // it already held.
        assert.equal(refused.result.body.currentVersion, 1);

        // The refusal names the field to raise and the number to raise it to —
        // a refusal the model cannot act on costs the same turn twice.
        const detail = refused.result.body.detail as string;
        assert.include(detail, "target.profitUsd 0.40 USD does not clear");
        assert.include(detail, "Nothing was published.");
        const [, roundTrip, floor, rung, raiseTo] =
          /round trip of ([\d.]+) USD.*floor is ([\d.]+) USD and the rung to aim at is ([\d.]+) USD\. Raise target\.profitUsd to at least ([\d.]+)/.exec(
            detail,
          ) ?? [];
        assert.isDefined(rung, detail);
        assert.equal(raiseTo, rung);
        assert.isAbove(Number(rung), Number(floor));
        assert.isAbove(Number(floor), Number(roundTrip));

        // And the plan really was not written: the mission still has none.
        const after = yield* callTool(BOUND_THREAD, "trading_look", {
          missionId: MISSION_ID,
          fetch: ["plan"],
        });
        assert.equal(after.result.body.mission.missionVersion, 1);
        assert.equal(after.result.body.mission.strategy, undefined);
        assert.include(after.result.body.unavailable[0].reason, "no plan published yet");
      }),
    costFloorLayer(),
  ),
);

it.effect("holds a patient plan to the round trip its own execution buys", () =>
  withMcpServer(
    ({ callTool, seedTradingAccount }) =>
      Effect.gen(function* () {
        yield* seedTradingAccount();

        // Over the same book the taker/maker round trip is ~$0.77 (one maker leg
        // at 1.5bps, one taker at 4.5, and the spread crossed once on the way
        // out), so a resting entry answers to a ~$1.15 floor rather than the
        // crossing ~$1.85. A $1.30 target pays for a patient trade and does not
        // pay for a crossing one, which is the whole reason the floor is priced
        // at the execution the plan named rather than at the rung.
        const patient = yield* callTool(BOUND_THREAD, "trading_plan", {
          missionId: MISSION_ID,
          expectedMissionVersion: 1,
          strategy: {
            ...strategyBody("resting at the level, so the maker leg is what it pays"),
            entry: { triggers: [{ description: "price returns to 3,000" }], urgency: "patient" },
            target: { profitUsd: 1.3 },
          },
        });
        assert.equal(patient.result.body.outcome, "accepted");
        // Accepted, and still told what the rung was — the warning the floor
        // sits underneath, not a replacement for it.
        const warning = (patient.result.body.warnings as string[]).find((line: string) =>
          line.includes("this trade should clear"),
        );
        assert.isDefined(warning, "expected the sub-rung warning to survive the floor");

        const crossing = yield* callTool(BOUND_THREAD, "trading_plan", {
          missionId: MISSION_ID,
          expectedMissionVersion: 2,
          strategy: {
            ...strategyBody("the same target, chasing"),
            target: { profitUsd: 1.3 },
          },
        });
        assert.equal(crossing.result.body.outcome, "rejected");
        assert.equal(crossing.result.body.reason, "target_below_cost_floor");
      }),
    costFloorLayer(),
  ),
);

it.effect("a close takes the resting entry with it, and says what had filled", () => {
  // Mission cf9dbd6f: the patient entry asked for 0.2613 ETH ($499.84) and had
  // 0.0103 of it when the model exited. Nothing withdrew the remainder on the
  // close — the publish path retracts entries on a REVISION and the reactor
  // takes everything at mission END, and a close in between fell through. A
  // close that leaves an entry working re-opens the position it just closed.
  const CLOID = "0xworkingentry0000000000000000002";
  const fake = makeFakeExchange({
    positionSize: 0.0103,
    orders: [{ ...restingWorkingEntry(CLOID, 2_990), size: 0.2613, remainingSize: 0.251 }],
  });
  return withMcpServer(
    ({ callTool, seedTradingAccount, seedHarnessRun }) =>
      Effect.gen(function* () {
        yield* seedTradingAccount();
        yield* seedHarnessRun();

        const closed = yield* callTool(BOUND_THREAD, "trading_exit", { action: "close" });

        assert.equal(closed.result.isError, false);
        assert.include(fake.cancels, CLOID);
        // And the split is stated, so the next plan is sized off what was
        // actually held rather than off what the entry asked for.
        assert.include(closed.result.body.detail, "0.0103 of the 0.2613");
      }),
    tradingLayerOverExchange(fake),
  );
});

it.effect("an accepted publish withdraws the mission's resting working entry", () => {
  // The audited risk fix (plan 29 step 4.2 aftermath): a resting patient entry
  // kept working up to the ~90s cross horizon even after the model changed
  // its mind. A publish IS the mind changing — the entry is withdrawn and the
  // response says so.
  const CLOID = "0xworkingentry0000000000000000001";
  const fake = makeFakeExchange({ orders: [restingWorkingEntry(CLOID, 2_990)] });
  return withMcpServer(
    ({ callTool, seedTradingAccount }) =>
      Effect.gen(function* () {
        yield* seedTradingAccount();

        const published = yield* callTool(BOUND_THREAD, "trading_plan", {
          missionId: MISSION_ID,
          expectedMissionVersion: 1,
          strategy: strategyBody("revised: no longer wants the resting entry"),
        });

        assert.equal(published.result.isError, false);
        const content = published.result.body;
        assert.equal(content.outcome, "accepted");
        // The entry was withdrawn through the same abandon() the reactor's
        // retirement path uses, and the model is told to re-place under the
        // new plan if it still wants in.
        assert.deepEqual(fake.cancels, [CLOID]);
        assert.deepEqual(fake.orders, []);
        const warning = (content.warnings as string[]).find((line: string) =>
          line.includes("resting patient entry was withdrawn"),
        );
        assert.isDefined(warning, "expected the publish response to report the retraction");
        // Nothing had filled here, so there is nothing to say about what is
        // held — the split rides the line only when it is a fact.
        assert.notInclude(warning ?? "", "had already");
      }),
    tradingLayerOverExchange(fake),
  );
});

// The fixture above is cast through `as unknown`, so a required field it omits
// is a runtime undefined nothing catches until something encodes the WHOLE
// estimate. `trading_look`'s position scope does exactly that — the estimate
// rides `positionCosts` — and the encode failure surfaces through
// `registerToolkitLenient` as a masked "internal server error", which is the
// trap plan 36 item 6a was reverted for. Every look in this file until now read
// a flat mission, so nothing had ever encoded it.
it.effect("serves the cost of the position it is holding", () => {
  const fake = makeFakeExchange({ positionSize: -0.474 });
  return withMcpServer(
    ({ callTool, seedTradingAccount }) =>
      Effect.gen(function* () {
        yield* seedTradingAccount();

        const held = yield* callTool(BOUND_THREAD, "trading_look", {
          missionId: MISSION_ID,
          fetch: ["position", "position_costs"],
        });

        assert.equal(held.result.isError, false);
        assert.equal(held.result.body.position.size, -0.474);
        assert.isDefined(held.result.body.positionCosts);
      }),
    tradingLayerOverExchange(fake),
  );
});

// -- plan 38 phase 3: the derived arm path ---------------------------------------
//
// The handler's derived arm is a compute-once-and-refuse against the archive
// (§3.2): every refusal code has a case here, and the ok path persists the
// ninth member of the `MarketWatch` union. The archive fixture is the
// read.test.ts convention — a temp file seeded through the writers, with
// hand-known values inside. A flat 0.00001 hourly rate makes the trailing
// 1-day mean exactly 0.00001.

/** A temp archive seeded with 48 hourly funding rows at a flat 0.00001. */
const seededFundingArchive = (): string => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-trading-derived-arm-"));
  const archivePath = NodePath.join(dir, "market-archive.sqlite");
  const db = openArchiveDatabase(archivePath);
  const HOUR = 3_600_000;
  // @effect-diagnostics globalDate:off - the live-clock fixture seeds archive rows around a real epoch.
  const now = Date.now();
  upsertFunding(
    db,
    Array.from({ length: 48 }, (_, i) => ({
      coin: "ETH",
      time: now - (48 - i) * HOUR,
      fundingRate: 0.00001,
      premium: 0.0000125,
    })),
  );
  db.close();
  return archivePath;
};

it.live("arms a derived funding_mean from a seeded archive", () => {
  const archivePath = seededFundingArchive();
  return withMcpServer(
    ({ callTool }) =>
      Effect.gen(function* () {
        const armed = yield* callTool(BOUND_THREAD, "trading_watch", {
          missionId: MISSION_ID,
          condition: {
            kind: "derived",
            market: "ETH",
            metric: "funding_mean",
            params: { metric: "funding_mean", windowDays: 1 },
            direction: "below",
            value: 0,
            mode: "cross",
          },
        });
        assert.equal(armed.result.isError, false);
        assert.equal(armed.result.body.outcome, "armed");
        // The persisted predicate is the ninth union member, with the
        // condition's own vocabulary carried beside it for re-arm.
        const watch = armed.result.body.watch.watch;
        assert.equal(watch.type, "metric_derived");
        assert.equal(watch.metric, "funding_mean");
        assert.deepEqual(watch.params, { metric: "funding_mean", windowDays: 1 });
        assert.equal(watch.direction, "below");
        assert.equal(watch.value, 0);
        assert.equal(watch.mode, "cross");
      }),
    tradingLayerOverExchange(makeFakeExchange(), archivePath),
  );
});

it.live(
  "refuses a level-mode derived watch that is already true, naming the observed value",
  () => {
    const archivePath = seededFundingArchive();
    return withMcpServer(
      ({ callTool }) =>
        Effect.gen(function* () {
          // The seeded mean is 0.00001, so "below 1" is true the moment it is
          // written — the giveback guard's instant-refire bug, generalised.
          const refused = yield* callTool(BOUND_THREAD, "trading_watch", {
            missionId: MISSION_ID,
            condition: {
              kind: "derived",
              market: "ETH",
              metric: "funding_mean",
              params: { metric: "funding_mean", windowDays: 1 },
              direction: "below",
              value: 1,
              mode: "level",
            },
          });
          assert.equal(refused.result.isError, false);
          assert.equal(refused.result.body.outcome, "refused");
          assert.equal(refused.result.body.reason, "derived_already_true");
          assert.include(refused.result.body.detail, "already below 1");
          assert.include(refused.result.body.detail, "observed 0.00001");
          // Every derived refusal carries the metric's catalog line (§4.1).
          assert.include(refused.result.body.detail, "funding_mean { windowDays 1-30 }");
        }),
      tradingLayerOverExchange(makeFakeExchange(), archivePath),
    );
  },
);

it.live("refuses a window the archive holdings do not cover", () => {
  const archivePath = seededFundingArchive();
  return withMcpServer(
    ({ callTool }) =>
      Effect.gen(function* () {
        // 48 hours of holdings against a 30-day window: the refusal names
        // what the archive actually holds, never a zero.
        const refused = yield* callTool(BOUND_THREAD, "trading_watch", {
          missionId: MISSION_ID,
          condition: {
            kind: "derived",
            market: "ETH",
            metric: "funding_mean",
            params: { metric: "funding_mean", windowDays: 30 },
            direction: "below",
            value: 0,
            mode: "cross",
          },
        });
        assert.equal(refused.result.isError, false);
        assert.equal(refused.result.body.outcome, "refused");
        assert.equal(refused.result.body.reason, "derived_window_unavailable");
        assert.include(refused.result.body.detail, "funding holdings for ETH start at");
      }),
    tradingLayerOverExchange(makeFakeExchange(), archivePath),
  );
});

it.effect("refuses a derived arm with derived_needs_archive when the archive is absent", () =>
  withMcpServer(
    ({ callTool }) =>
      Effect.gen(function* () {
        // The default tradingLayerOverExchange archive path is a temp dir with
        // no file in it — the honest "the archiver has not been running"
        // fixture, and the one state that must never degrade to a zero (§5.3).
        const refused = yield* callTool(BOUND_THREAD, "trading_watch", {
          missionId: MISSION_ID,
          condition: {
            kind: "derived",
            market: "ETH",
            metric: "funding_mean",
            params: { metric: "funding_mean", windowDays: 1 },
            direction: "below",
            value: 0,
            mode: "cross",
          },
        });
        assert.equal(refused.result.isError, false);
        assert.equal(refused.result.body.outcome, "refused");
        assert.equal(refused.result.body.reason, "derived_needs_archive");
        assert.include(refused.result.body.detail, "archive file not found");
      }),
    tradingLayerOverExchange(makeFakeExchange()),
  ),
);

it.effect("refuses handler-level derived params violations by name", () =>
  withMcpServer(
    ({ callTool, seedActiveWatch }) =>
      Effect.gen(function* () {
        // A reference watch the mission holds but that has not fired.
        yield* seedActiveWatch("watch_derived_ref_unfired");

        const notFound = yield* callTool(BOUND_THREAD, "trading_watch", {
          missionId: MISSION_ID,
          condition: {
            kind: "derived",
            market: "ETH",
            metric: "bars_since",
            params: { metric: "bars_since", interval: "5m", sinceWatchId: "watch_nope" },
            direction: "above",
            value: 3,
          },
        });
        assert.equal(notFound.result.body.outcome, "refused");
        assert.equal(notFound.result.body.reason, "derived_params_invalid");
        assert.include(notFound.result.body.detail, "no watch watch_nope");

        const notFired = yield* callTool(BOUND_THREAD, "trading_watch", {
          missionId: MISSION_ID,
          condition: {
            kind: "derived",
            market: "ETH",
            metric: "bars_since",
            params: {
              metric: "bars_since",
              interval: "5m",
              sinceWatchId: "watch_derived_ref_unfired",
            },
            direction: "above",
            value: 3,
          },
        });
        assert.equal(notFired.result.body.outcome, "refused");
        assert.equal(notFired.result.body.reason, "derived_params_invalid");
        assert.include(notFired.result.body.detail, "has not fired yet");

        // A sinceEntry metric against a mission holding no position.
        const flat = yield* callTool(BOUND_THREAD, "trading_watch", {
          missionId: MISSION_ID,
          condition: {
            kind: "derived",
            market: "ETH",
            metric: "funding_cumulative",
            params: { metric: "funding_cumulative", sinceEntry: true },
            direction: "above",
            value: 0.001,
          },
        });
        assert.equal(flat.result.body.outcome, "refused");
        assert.equal(flat.result.body.reason, "derived_params_invalid");
        assert.include(flat.result.body.detail, "holds no position");
      }),
    tradingLayerOverExchange(makeFakeExchange()),
  ),
);

// -- plan 38 phase 2c: the fetch path ------------------------------------------
//
// The catalog is a price list, and the price is the contract: §6 phase 2 item
// 1 says every key measures within ±20% of its published size against the
// fixture market, and a key whose honest size misses the band is corrected in
// the catalog (an estimate) or reported (a measurement) — never papered over.

/** One priced expectation: the catalog's figure and where the section lands. */
const CATALOG_CHARS = (key: string): number => {
  const entry = TRADING_LOOK_CATALOG.find((candidate) => candidate.key === key);
  if (entry === undefined) throw new Error(`no catalog entry for ${key}`);
  return entry.chars;
};

const sectionChars = (value: unknown): number => JSON.stringify(value)?.length ?? 0;

it.effect("returns the menu when fetch is absent, and when it is empty", () =>
  withMcpServer(({ callTool }) =>
    Effect.gen(function* () {
      for (const args of [{}, { fetch: [] }]) {
        const menu = yield* callTool(BOUND_THREAD, "trading_look", args);
        assert.equal(menu.result.isError, false);
        assert.equal(menu.result.body.menu, renderTradingLookMenu());
        // The menu is the whole answer: nothing else rides the catalog call.
        assert.equal(menu.result.body.mission, undefined);
        assert.equal(menu.result.body.snapshot, undefined);
        // Plan 38 phase 3: the menu carries every derived metric, one line
        // each — this and the watch refusals are where the model meets
        // them, never the tool descriptions (§4.1). R3 made it thirteen.
        for (const metric of DERIVED_METRIC_CATALOG) {
          assert.include(menu.result.body.menu, `derived:${metric.metric} `);
        }
        assert.equal((menu.result.body.menu.match(/derived:/g) ?? []).length, 13);
      }
      // The actual measured size of the menu — the number the phase report
      // carries, asserted so a catalog edit that grows it past the documented
      // budget has to say so here. R3 added the scan key, its legend clause,
      // and the thirteenth derived metric: measured 1,368.
      const measured = sectionChars(renderTradingLookMenu());
      process.stdout.write(`MENU_CHARS ${measured}\n`);
      assert.isAtMost(measured, 1_500);
    }),
  ),
);

it.effect("refuses unknown fetch keys by name, with the nearest valid key", () =>
  withMcpServer(({ callTool }) =>
    Effect.gen(function* () {
      const refused = yield* callTool(BOUND_THREAD, "trading_look", {
        fetch: ["structre"],
      });
      assert.equal(refused.result.isError, true);
      const text = refused.result.content[0].text as string;
      assert.include(text, "unknown_fetch_key");
      assert.include(text, '"structre"');
      assert.include(text, '"structure"');
    }),
  ),
);

it.effect("refuses oversize fetch parameters naming the bound, never truncating", () =>
  withMcpServer(({ callTool }) =>
    Effect.gen(function* () {
      const refused = yield* callTool(BOUND_THREAD, "trading_look", {
        fetch: ["candles:1m:5000"],
      });
      assert.equal(refused.result.isError, true);
      const text = refused.result.content[0].text as string;
      assert.include(text, "fetch_key_params_invalid");
      assert.include(text, '"candles:1m:5000"');
      assert.include(text, "0..200");
      assert.include(text, "not truncated");
    }),
  ),
);

it.effect("answers every archive key unavailable when the archive is absent", () => {
  // The default tradingLayerOverExchange archive path is a temp dir with no
  // file in it — the honest "the archiver has not been running" fixture.
  const fake = makeFakeExchange();
  return withMcpServer(
    ({ callTool }) =>
      Effect.gen(function* () {
        const read = yield* callTool(BOUND_THREAD, "trading_look", {
          fetch: ["funding_stats:7", "funding_series:24", "oi_premium:24", "book_history:24"],
        });
        assert.equal(read.result.isError, false);
        const body = read.result.body;
        // Named, with reasons — never zeros or empty arrays that read as data.
        assert.deepEqual(
          body.unavailable.map((entry: { key: string }) => entry.key),
          ["funding_stats:7", "funding_series:24", "oi_premium:24", "book_history:24"],
        );
        for (const entry of body.unavailable) {
          assert.isAbove((entry.reason as string).length, 0);
        }
        assert.equal(body.fundingStats, undefined);
        assert.equal(body.fundingSeries, undefined);
        assert.equal(body.oiPremium, undefined);
        assert.equal(body.bookHistory, undefined);
      }),
    tradingLayerOverExchange(fake),
  );
});

it.effect("no fetch key implies another: candles is bars only", () => {
  const fake = makeFakeExchange();
  return withMcpServer(
    ({ callTool, seedTradingAccount }) =>
      Effect.gen(function* () {
        yield* seedTradingAccount();
        const read = yield* callTool(BOUND_THREAD, "trading_look", {
          fetch: ["candles:1m:20"],
        });
        assert.equal(read.result.isError, false);
        const body = read.result.body;
        assert.isAbove(body.candles.bars.length, 0);
        assert.equal(body.candles.bars.length <= 20, true);
        // §2.3 rule 2: the implied bundle is gone. Volatility, the higher
        // timeframe, and the indicators are their own keys with their own
        // prices.
        assert.equal(body.volatility, undefined);
        assert.equal(body.higherTimeframeVolatility, undefined);
        assert.equal(body.indicators, undefined);
        // And no mission half: the bars are the same answer whoever asks.
        assert.equal(body.mission, undefined);
        assert.deepEqual(body.fetched, ["candles:1m:20"]);
      }),
    tradingLayerOverExchange(fake),
  );
});

// Plan 38 §4.2: nothing is deleted outright from the read. The scope path's
// structure scope carries the mission's previous structure read; the fetch
// `structure` key must carry it too, or its content is unreachable under fetch.
it.effect("the fetch structure key carries the previous structure read", () => {
  const fake = makeFakeExchange();
  return withMcpServer(
    ({ callTool, seedTradingAccount }) =>
      Effect.gen(function* () {
        yield* seedTradingAccount();
        // Earlier tests in this file may have already recorded structure reads
        // for this mission, so the first call's field is whatever memory
        // exists — what matters is that the key can carry it at all.
        yield* callTool(BOUND_THREAD, "trading_look", {
          fetch: ["structure"],
        });

        // The read this call just took is remembered; the next one carries it.
        const again = yield* callTool(BOUND_THREAD, "trading_look", {
          fetch: ["structure"],
        });
        assert.isDefined(again.result.body.previousStructureRead);
        assert.deepEqual(again.result.body.fetched, ["structure"]);
      }),
    tradingLayerOverExchange(fake),
  );
});

// -- plan 38 §6 phase 2 item 1: every catalog key within ±20% of its price ----
//
// The fixture is tuned to realistic magnitudes (real-decimal prices, a deep
// book, prose the length operators write); what it measures is what the
// catalog publishes, and the band is ±20%. Parameterized keys measure their
// per-unit figure (per bar, per row, per reading, per event).

/** Realistic 1m candles: two-decimal prices, decimal volume, 120 bars. */
const sizedCandles = Array.from({ length: 120 }, (_, i) => {
  const base = 1908.4 + i * 0.105 + Math.sin(i / 23) * 0.6;
  const round = (value: number): number => Number(value.toFixed(2));
  return {
    openTime: 7_200_000 - (120 - i) * 60_000,
    closeTime: 7_200_000 - (120 - i) * 60_000 + 59_000,
    open: round(base - 0.41),
    close: round(base + 0.33),
    high: round(base + 1.87),
    low: round(base - 1.94),
    volume: Number((87.3 + (i % 13)).toFixed(1)),
  };
});

/** A ten-level book with decimal prices and sizes, like the real gateway. */
const sizedBook = {
  bids: Array.from({ length: 10 }, (_, i) => ({
    price: Number((1914.62 - 0.1 * (i + 1)).toFixed(2)),
    size: Number((12.34 + i * 0.79).toFixed(2)),
  })),
  asks: Array.from({ length: 10 }, (_, i) => ({
    price: Number((1914.62 + 0.1 * (i + 1)).toFixed(2)),
    size: Number((11.87 + i * 0.68).toFixed(2)),
  })),
};

const sizedExchange = makeFakeExchange({
  positionSize: 0.474,
  orders: [restingWorkingEntry("0xsizedworkingentry00000000001", 1_912.4)],
  markPrice: 1914.62,
  bidPrice: 1914.5,
  askPrice: 1914.74,
  candles: sizedCandles,
  book: sizedBook,
  oraclePrice: 1914.4,
  fundingRate8h: 0.0000125,
  change24hPercent: -1.23,
  openInterest: 123_456,
  dayVolumeUsd: 812_345_678,
  accountValue: 10_123.45,
  accountMarginUsed: 512.3,
  positionUnrealisedPnl: 7.24,
  positionCumulativeFunding: -0.31,
});

/** A plan whose prose is the length real ones are. */
const sizedStrategyBody = (because: string): PublishTradingPlanBody => ({
  market: "ETH",
  intent: "long",
  entry: {
    triggers: [
      {
        description:
          "5m candle closes above 1,921.4 with the EMA(9/21) cross confirmed and the cross no older than five bars",
      },
      {
        description:
          "the breakout bar's volume clears 1.5x its 20-bar mean and the offer absorbs the first retest",
      },
    ],
    urgency: "patient",
  },
  stop: {
    method:
      "Structural stop beneath the breakout candle low at 1,912.8, outside the measured 5m noise floor and past the session's lowest wick.",
  },
  target: { profitUsd: 18.4 },
  invalidation: [
    "Range high 1,921.4 is lost on a 15m close.",
    "The cross ages past five bars without a close above the shelf.",
    "Funding flips and stays negative for six consecutive hourly prints.",
    "The 1,912.8 structural floor breaks on volume above the 20-bar mean.",
    "Two consecutive 5m closes back inside the range void the breakout entirely.",
    "The giveback watch fires before any of the above, as armed.",
  ],
  reassess: { afterMinutes: 90 },
  because,
});

it.live("serves every catalog key within ±20% of its published size", () => {
  // A seeded archive in a temp dir — the read.test.ts convention. Live clock:
  // `UnixMillis` is non-negative and the archive windows are relative to now,
  // so the rows are seeded around a real epoch (nothing measured depends on
  // the timestamps' values, only their digit counts, which do not move).
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-trading-fetch-sizes-"));
  const archivePath = NodePath.join(dir, "market-archive.sqlite");
  const db = openArchiveDatabase(archivePath);
  const HOUR = 3_600_000;
  // @effect-diagnostics globalDate:off - the live-clock fixture seeds archive rows around a real epoch.
  const now = Date.now();
  upsertFunding(
    db,
    Array.from({ length: 48 }, (_, i) => ({
      coin: "ETH",
      time: now - (48 - i) * HOUR,
      fundingRate: (i % 16 < 8 ? 1 : -1) * (0.0000094 + (i % 7) * 0.0000006),
      premium: 0.0000125,
    })),
  );
  upsertAssetContexts(
    db,
    Array.from({ length: 48 }, (_, i) => ({
      coin: "ETH",
      ts: now - (48 - i) * HOUR,
      openInterest: 123_456 + i * 12,
      premium: 0.000021 + (i % 5) * 0.000003,
      oraclePx: 1914.4,
      markPx: 1914.62,
      dayNtlVolume: 812_345_678.9,
      funding: 0.0000125,
    })),
  );
  upsertBookSummaries(
    db,
    Array.from({ length: 48 }, (_, i) => ({
      coin: "ETH",
      ts: now - (48 - i) * HOUR,
      bidPx: Number((1914.6 - (i % 7) * 0.05).toFixed(2)),
      bidSz: 2.4,
      askPx: Number((1914.64 + (i % 7) * 0.05).toFixed(2)),
      askSz: 2.2,
      bidDepth5: 412.3,
      askDepth5: 398.7,
    })),
  );
  // R3's cross-market reads: every archived coin gets two UTC days of 5m
  // candles (so `levels` serves its session half and `scan` its candle
  // half), eight days of funding (so the 7d mean is covered), and 25 hours
  // of asset_ctx (so the 24h OI change is covered). Realistic magnitudes:
  // the sizes below are what the catalog's prices were taken against.
  const FIVE_MIN = 5 * 60_000;
  const DAY_MS = 24 * HOUR;
  const dayStart = Math.floor(now / DAY_MS) * DAY_MS;
  const basePrice: Record<string, number> = { BTC: 61_234.5, ETH: 1_914.62, SOL: 141.37 };
  for (const coin of ["BTC", "ETH", "SOL"]) {
    const base = basePrice[coin] as number;
    const round = (value: number): number => Number(value.toFixed(2));
    const candles: Array<CandleRow> = [];
    for (let index = 0; index < 576; index += 1) {
      const t = dayStart - DAY_MS + index * FIVE_MIN;
      const drift = base * (1 + Math.sin(index / 37) * 0.004 + index * 0.000_02);
      candles.push({
        coin,
        interval: "5m",
        t,
        tClose: t + FIVE_MIN - 1,
        o: round(drift - base * 0.000_4),
        h: round(drift + base * 0.001_1),
        l: round(drift - base * 0.001_2),
        c: round(drift + base * 0.000_3),
        v: Number((87.3 + (index % 13)).toFixed(1)),
        n: 40 + (index % 5),
      });
    }
    upsertCandles(db, candles);
    upsertFunding(
      db,
      Array.from({ length: 192 }, (_, i) => ({
        coin,
        time: now - (192 - i) * HOUR,
        fundingRate: (i % 16 < 8 ? 1 : -1) * (0.0000094 + (i % 7) * 0.0000006),
        premium: 0.0000125,
      })),
    );
    upsertAssetContexts(
      db,
      Array.from({ length: 25 }, (_, i) => ({
        coin,
        ts: now - (25 - i) * HOUR,
        openInterest: coin === "BTC" ? 87_654 : coin === "ETH" ? 123_456 : 41_204,
        premium: 0.000021,
        oraclePx: base,
        markPx: base,
        dayNtlVolume: 812_345_678.9,
        funding: 0.0000125,
      })),
    );
  }
  db.close();

  return withMcpServer(
    ({
      callTool,
      seedTradingAccount,
      seedActiveWatch,
      seedFill,
      seedClosedTrade,
      seedLevelEvent,
      seedInboxEvent,
      seedPosition,
    }) =>
      Effect.gen(function* () {
        yield* seedTradingAccount();
        yield* seedPosition({ size: 0.474, entryPrice: 1_899.13, unrealisedPnl: 7.24 });
        // A mission with a history: three published plans, a dozen watches,
        // journal notes, fills, level memory, and a pending-event tail.
        const becauseFor = (index: number): string =>
          [
            "range break: the 1,921.4 shelf rejected twice overnight and the cross confirmed on rising volume, so the entry rests at the retest, the stop sits under the structure that made the thesis, and the target is the range height measured off the shelf",
            "revised: the first target banked at 1,929.8, trailing the stop under the 5m structure, banking a third if the grind stalls, and standing aside entirely on a close back inside the range",
            "holding: the grind is intact, the stop is structural beneath the wick, the trailing rule is armed, and nothing new is owed but the reassessment the 15m close will bring",
          ][index % 3] ??
          `reassessment ${index}: the read is unchanged, the levels are the same, and the plan stands — the shelf at 1,921.4 is still the decision, the stop is still structural, and the trailing rule has carried the hold this far, and nothing in the book, the funding, or the regime gives a reason to touch what is working`;
        for (let index = 0; index < 30; index += 1) {
          yield* callTool(BOUND_THREAD, "trading_plan", {
            expectedMissionVersion: 1 + index,
            strategy: sizedStrategyBody(becauseFor(index)),
          });
        }
        // The plan the mission holds as the size test measures it: the full
        // prose a real current plan carries, not the short revision branches.
        yield* callTool(BOUND_THREAD, "trading_plan", {
          expectedMissionVersion: 31,
          strategy: sizedStrategyBody(
            "holding the grind: the shelf at 1,921.4 decided the entry, the stop is structural beneath 1,912.8 and past the session's lowest wick, the trailing rule banked a third at 1,934 and moved the stop to entry, and nothing in the book, the funding, or the regime gives a reason to touch what is working — reassess on the 15m close or on the giveback, whichever comes first",
          ),
        });
        for (let index = 0; index < 14; index += 1) {
          yield* seedActiveWatch(`watch_sized_${index.toString().padStart(2, "0")}`);
        }
        for (const note of [
          "1,921.4 chopped me twice overnight; waiting for a 15m close above it before re-arming either side of the shelf",
          "the 1m read disagrees with the 5m — treating the 5m as the frame for this hold and sizing off its ATR only",
          "funding flipped negative while holding; re-checked the carry math and the hold still pays its round trip",
          "the entry filled 12% short of approved; sized the stop and the plan's risk off the fill, not the request",
          "the 1,918 shelf absorbed three retests on rising volume; it is the level that decides the next leg",
          "volume dried up into the NY open — the grind needs participation to continue and the book thinned with it",
          "the trailing rule banked a third at 1,934; the stop is now at entry, the rest of the hold is house money",
          "operator asked for half off if the grind stalls under 1,918; armed the giveback accordingly and said so here",
          "the 15m regime flipped to trend on the third retest of 1,918; the range thesis is retired with it",
          "the cost line moved — the round trip is now 0.62 USD and the target rung moved with it; 1.30 no longer publishes",
        ]) {
          yield* callTool(BOUND_THREAD, "trading_journal", { note });
        }
        yield* seedFill({ fillId: "sz_f1", orderId: 910, closedPnl: 12.4, feeUsd: 1.12 });
        yield* seedFill({ fillId: "sz_f2", orderId: 911, closedPnl: -4.2, feeUsd: 1.08 });
        yield* seedFill({ fillId: "sz_f3", orderId: 912, closedPnl: 18.4, feeUsd: 1.31 });
        yield* seedFill({ fillId: "sz_f4", orderId: 913, closedPnl: 6.7, feeUsd: 0.94 });
        // Fourteen closed trades, as a mission with a held target's history
        // would carry: eight under the plan now in force (v31, $20 target),
        // six under the revision before it (v30, $18). Two-thirds of them
        // touched the target, one in three banked it; stops sat 1.4 noise
        // floors out. That is the record `calibration` grades — and its
        // section lands near the catalog's measured 1,047 chars.
        for (let index = 0; index < 8; index += 1) {
          yield* seedClosedTrade({
            tradeId: `sz_t31_${index}`,
            closedAt: 600_000 - index * 10_000,
            strategyVersion: 31,
            targetProfitUsd: 20,
            peak: index % 3 === 0 ? 24 : 12,
            trough: -8,
            netPnl: index % 3 === 0 ? 14 : -6,
            stopNoiseFloorMultiple: 1.4,
          });
        }
        for (let index = 0; index < 6; index += 1) {
          yield* seedClosedTrade({
            tradeId: `sz_t30_${index}`,
            closedAt: 500_000 - index * 10_000,
            strategyVersion: 30,
            targetProfitUsd: 18,
            peak: index % 3 === 0 ? 21.6 : 10.8,
            trough: -7.2,
            netPnl: index % 3 === 0 ? 12.6 : -5.4,
            stopNoiseFloorMultiple: 1.4,
          });
        }
        const sizedLevels = [1_914.6, 1_918, 1_921.4, 1_909.8, 1_926.7, 1_905.2];
        for (const [index, level] of sizedLevels.entries()) {
          yield* seedLevelEvent({
            id: `sz_l${index}a`,
            level,
            kind: "closed_through",
            occurredAt: 900_000 + index * 10_000,
          });
          yield* seedLevelEvent({
            id: `sz_l${index}b`,
            level,
            kind: "stopped_out_at",
            occurredAt: 905_000 + index * 10_000,
          });
        }
        for (const [index, summary] of [
          "5m candle closed 1,914.6 (below 1,915.53)",
          "funding print -0.0000094 flipped the 7d mean negative",
          "operator: bank half if the grind stalls under 1,918",
        ].entries()) {
          yield* seedInboxEvent({
            id: `sz_e${index}`,
            category: index === 2 ? "user" : "market",
            summary,
            occurredAt: 800_000 + index * 1_000,
          });
        }

        const measure = (key: string): Effect.Effect<number> =>
          Effect.gen(function* () {
            const read = yield* callTool(BOUND_THREAD, "trading_look", { fetch: [key] });
            if (read.result.isError === true) {
              throw new Error(
                `${key}: ${read.result.content?.map((part: { text?: string }) => part.text ?? "").join("; ")}`,
              );
            }
            const body = read.result.body;
            const section = (path: string): unknown =>
              path
                .split(".")
                .reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], body);
            switch (key) {
              case "snapshot":
                return sectionChars(section("snapshot"));
              case "book":
                return sectionChars(section("book"));
              case "book_full":
                return sectionChars(section("orderBook"));
              case "microstructure":
                return sectionChars(section("microstructure"));
              case "candles:1m:20":
                return sectionChars(section("candles.bars")) / 20;
              case "indicators:ema20":
                return sectionChars(section("indicators")) / 1;
              case "volatility":
                return sectionChars(section("volatility"));
              case "volatility_htf":
                return sectionChars(section("higherTimeframeVolatility"));
              case "structure":
                return sectionChars(section("structure"));
              case "structure_brief":
                return sectionChars(section("structureBrief"));
              case "funding_stats:7":
                return sectionChars(section("fundingStats"));
              case "funding_series:24":
                return sectionChars(section("fundingSeries")) / 24;
              case "oi_premium:24":
                return sectionChars(section("oiPremium")) / 24;
              case "book_history:24":
                return sectionChars(section("bookHistory")) / 24;
              case "scan":
                return sectionChars(section("scan"));
              case "levels":
                // The key's two halves: the mission's level memory plus the
                // UTC-day anchored session levels (R3).
                return (
                  sectionChars(section("levelHistory")) + sectionChars(section("sessionLevels"))
                );
              case "position":
                return sectionChars(section("position"));
              case "position_costs":
                return sectionChars(section("positionCosts"));
              case "orders":
                return sectionChars(section("openOrders"));
              case "account":
                return sectionChars(section("account"));
              case "plan":
                return sectionChars(section("mission.strategy"));
              case "watches":
                return sectionChars(section("mission.watches"));
              case "events":
                return sectionChars(section("events")) / 3;
              case "journal":
                return sectionChars(section("mission.journal"));
              case "trades":
                return sectionChars(section("trades"));
              case "calibration":
                return sectionChars(section("mission.targetCalibration"));
              case "plan_history":
                return sectionChars(section("mission.strategyHistory"));
              case "cost":
                return sectionChars(section("cost"));
              default:
                throw new Error(`unmeasured key ${key}`);
            }
          });

        // One throwaway look, then a span past MARKET_SAMPLE_MIN_SPAN_MILLIS:
        // the second read's microstructure then carries the change fields a
        // real mission's does (fresh samples 200ms apart carry none).
        yield* callTool(BOUND_THREAD, "trading_look", { fetch: ["snapshot"] });
        yield* Effect.sleep(31_000);

        const keys = [
          "microstructure",
          "snapshot",
          "book",
          "book_full",
          "candles:1m:20",
          "indicators:ema20",
          "volatility",
          "volatility_htf",
          "structure",
          "structure_brief",
          "funding_stats:7",
          "funding_series:24",
          "oi_premium:24",
          "book_history:24",
          "scan",
          "levels",
          "position",
          "position_costs",
          "orders",
          "account",
          "plan",
          "watches",
          "events",
          "journal",
          "trades",
          "calibration",
          "plan_history",
          "cost",
        ];
        const measured: Record<string, number> = {};
        for (const key of keys) {
          measured[key] = yield* measure(key);
        }

        // Measured-(m) sizes the shared fixture cannot reproduce, each with
        // its reason. These assert the fixture's own honest band instead of
        // the catalog's, and every one is a reported deviation — the published
        // price still stands for the real market.
        const FIXTURE_DEVIATIONS: Readonly<Record<string, number>> = {
          // The cost estimator is pinned by the byte-identity goldens above, so
          // its fixed numbers cannot be re-tuned for this test.
          position_costs: 644,
          // A real registry's mean is 46 — between this fixture's empty array
          // (2) and one resting order (~180); neither lands in band.
          orders: 2,
          // The fake account's fixed withdrawable/address lengths put the
          // section 6% over the published band.
          account: 317,
        };

        for (const key of keys) {
          // `cost` prices a hypothetical entry only while flat — this mission
          // holds — so it is asserted as unavailable with a reason below,
          // not as a size.
          if (key === "cost") continue;
          const expected = FIXTURE_DEVIATIONS[key] ?? CATALOG_CHARS(key.split(":")[0] ?? key);
          const actual = measured[key] ?? 0;
          assert.isAtLeast(
            actual,
            expected * 0.8,
            `${key}: ${Math.round(actual)} is under 80% of its published ${expected}`,
          );
          assert.isAtMost(
            actual,
            expected * 1.2,
            `${key}: ${Math.round(actual)} is over 120% of its published ${expected}`,
          );
        }

        // The one key the holding fixture answers with a reason instead of
        // data — the never-a-zero rule, exercised.
        const cost = yield* callTool(BOUND_THREAD, "trading_look", { fetch: ["cost"] });
        assert.include(cost.result.body.unavailable?.[0]?.reason ?? "", "position_costs");
      }),
    tradingLayerOverExchange(sizedExchange, archivePath),
  ).pipe(Effect.ensuring(Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true }))));
});

// -- R3: the real-trader reads (scan, session levels, vwap_distance) -------------

/** Five-minute bars with hand-known OHLCV, seeded around a real epoch. */
const r3Bar = (
  coin: string,
  t: number,
  o: number,
  h: number,
  l: number,
  c: number,
  v: number,
  interval: "1m" | "5m" = "5m",
) => ({
  coin,
  interval,
  t,
  tClose: t + (interval === "1m" ? 60_000 : 5 * 60_000) - 1,
  o,
  h,
  l,
  c,
  v,
  n: 3,
});

it.effect("refuses the scan key with a reason when the archive is absent", () =>
  withMcpServer(
    ({ callTool }) =>
      Effect.gen(function* () {
        const read = yield* callTool(BOUND_THREAD, "trading_look", { fetch: ["scan"] });
        assert.equal(read.result.isError, false);
        assert.equal(read.result.body.scan, undefined);
        assert.equal(read.result.body.unavailable[0].key, "scan");
        assert.include(read.result.body.unavailable[0].reason, "archive file not found");
      }),
    tradingLayerOverExchange(makeFakeExchange()),
  ),
);

it.effect("refuses the levels key with a reason when the archive is absent", () =>
  // Plan 38 §2: an absent archive is unavailable with a reason — never the
  // zeros a flat session would read as.
  withMcpServer(
    ({ callTool }) =>
      Effect.gen(function* () {
        const read = yield* callTool(BOUND_THREAD, "trading_look", { fetch: ["levels"] });
        assert.equal(read.result.isError, false);
        assert.equal(read.result.body.sessionLevels, undefined);
        const refused = read.result.body.unavailable.find(
          (entry: { key: string }) => entry.key === "levels",
        );
        assert.isDefined(refused);
        assert.include(refused.reason, "archive file not found");
      }),
    tradingLayerOverExchange(makeFakeExchange()),
  ),
);

it.live("serves the scan digest for the coins the archive holds", () => {
  // Only BTC has rows, so only BTC appears — the scan enumerates what the
  // candle table actually holds, and the archived coin answers in full.
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-trading-scan-"));
  const archivePath = NodePath.join(dir, "market-archive.sqlite");
  const db = openArchiveDatabase(archivePath);
  // @effect-diagnostics globalDate:off - the live-clock fixture seeds archive rows around a real epoch.
  const now = Date.now();
  const DAY = 24 * 3_600_000;
  const HOUR = 3_600_000;
  // 24h of 5m bars ending at the newest completed one. Anchored to `now`
  // rather than to a day boundary because the digest withholds a mark that
  // stopped advancing, and a fixture whose last bar is hours old is exactly
  // the dead archiver that guard exists to catch.
  const FIVE_MIN = 5 * 60_000;
  const newestOpen = Math.floor(now / FIVE_MIN) * FIVE_MIN - FIVE_MIN;
  upsertCandles(
    db,
    Array.from({ length: 288 }, (_, i) =>
      r3Bar(
        "BTC",
        newestOpen - (287 - i) * FIVE_MIN,
        61_000 + i,
        61_100 + i,
        60_900 + i,
        61_050 + i,
        10,
      ),
    ),
  );
  upsertFunding(
    db,
    Array.from({ length: 192 }, (_, i) => ({
      coin: "BTC",
      time: now - (192 - i) * HOUR,
      fundingRate: 0.00001,
      premium: 0.0000125,
    })),
  );
  upsertAssetContexts(
    db,
    Array.from({ length: 25 }, (_, i) => ({
      coin: "BTC",
      ts: now - (25 - i) * HOUR,
      openInterest: 80_000 + i * 100,
      premium: 0.000021,
      oraclePx: 61_050,
      markPx: 61_050,
      dayNtlVolume: 500_000_000,
      funding: 0.00001,
    })),
  );
  db.close();

  return withMcpServer(
    ({ callTool }) =>
      Effect.gen(function* () {
        const read = yield* callTool(BOUND_THREAD, "trading_look", { fetch: ["scan"] });
        assert.equal(read.result.isError, false);
        const coins = read.result.body.scan;
        // The scan digests the coins the archive's candle table actually
        // holds — since v2 the follow set drives collection and there is no
        // config coin list left to enumerate. ETH and SOL have no rows here,
        // so they do not appear; per-coin absence marking is pinned by
        // TradingMarketArchive.test.ts against a coin with thin data.
        assert.deepEqual(
          coins.map((entry: { coin: string }) => entry.coin),
          ["BTC"],
        );
        // The archived coin answers in full.
        const btc = coins[0];
        assert.isAbove(btc.mark, 0);
        assert.isDefined(btc.change24hPct);
        assert.isDefined(btc.realizedVol24hPct);
        // Seeded hourly rows at 0.00001 → the digest serves 8h-equivalents
        // (x 8): the boundary conversion, proven end-to-end.
        assert.closeTo(btc.fundingNowPer8h, 0.00001 * 8, 1e-12);
        assert.closeTo(btc.funding7dMeanPer8h, 0.00001 * 8, 1e-12);
        assert.isDefined(btc.oiChange24hPct);
        assert.equal(btc.unavailable, undefined);
        assert.isUndefined(read.result.body.unavailable);
      }),
    tradingLayerOverExchange(makeFakeExchange(), archivePath),
  ).pipe(Effect.ensuring(Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true }))));
});

it.live("serves UTC-day anchored session levels from archived 5m candles", () => {
  // Hand-checked. One prior-day bar and two current-day bars; the prior bar
  // at dayStart − 5m is the boundary the anchor must exclude.
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-trading-session-levels-"));
  const archivePath = NodePath.join(dir, "market-archive.sqlite");
  const db = openArchiveDatabase(archivePath);
  // @effect-diagnostics globalDate:off - the live-clock fixture seeds archive rows around a real epoch.
  const now = Date.now();
  const DAY = 24 * 3_600_000;
  const dayStart = Math.floor(now / DAY) * DAY;
  upsertCandles(db, [
    r3Bar("ETH", dayStart - 5 * 60_000, 100, 110, 90, 105, 1),
    r3Bar("ETH", dayStart, 101, 107, 99, 103, 10),
    r3Bar("ETH", dayStart + 5 * 60_000, 103, 105, 101, 103, 30),
  ]);
  db.close();

  return withMcpServer(
    ({ callTool }) =>
      Effect.gen(function* () {
        const read = yield* callTool(BOUND_THREAD, "trading_look", { fetch: ["levels"] });
        assert.equal(read.result.isError, false);
        const session = read.result.body.sessionLevels;
        assert.isDefined(session);
        assert.equal(session.anchoredTo, "utc_day");
        assert.equal(session.interval, "5m");
        // Prior day from the prior bar alone.
        assert.deepEqual(session.priorUtcDay, { high: 110, low: 90, close: 105 });
        // Current day from the two in-day bars; the prior bar's 90 low and
        // 100 open must not leak across the boundary.
        assert.deepEqual(session.currentUtcDay, { open: 101, high: 107, low: 99 });
        // VWAP over typical prices 103 and 103, volumes 10 and 30 → 103.
        assert.equal(session.vwap, 103);
        assert.isUndefined(session.unavailable);
      }),
    tradingLayerOverExchange(makeFakeExchange(), archivePath),
  ).pipe(Effect.ensuring(Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true }))));
});

it.live("arms a derived vwap_distance watch from a seeded archive", () => {
  // The same hand-checked session as the derived.test.ts fixture: VWAP
  // 102.3, session σ √3.6875, last close 103 → distance ≈ +0.3645.
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-trading-vwap-arm-"));
  const archivePath = NodePath.join(dir, "market-archive.sqlite");
  const db = openArchiveDatabase(archivePath);
  // @effect-diagnostics globalDate:off - the live-clock fixture seeds archive rows around a real epoch.
  const now = Date.now();
  const DAY = 24 * 3_600_000;
  const dayStart = Math.floor(now / DAY) * DAY;
  const MINUTE = 60_000;
  // A day's worth of 1m bars up to the newest completed one, cycling through
  // four shapes. `vwap_distance` anchors its session to the UTC day, so the
  // bars have to reach both back to that boundary and forward to now: a
  // session that stopped advancing is refused as stale, and one that starts
  // mid-day would not be a session.
  const newest = Math.floor(now / MINUTE) * MINUTE - MINUTE;
  const shapes = [
    [101, 102, 100, 101, 10],
    [104, 106, 102, 104, 30],
    [99, 101, 97, 99, 20],
    [103, 105, 101, 103, 40],
  ] as const;
  const bars = [];
  for (let open = dayStart; open <= newest; open += MINUTE) {
    const shape = shapes[((open - dayStart) / MINUTE) % shapes.length] as (typeof shapes)[number];
    bars.push(r3Bar("ETH", open, shape[0], shape[1], shape[2], shape[3], shape[4], "1m"));
  }
  upsertCandles(db, bars);
  db.close();

  return withMcpServer(
    ({ callTool }) =>
      Effect.gen(function* () {
        const armed = yield* callTool(BOUND_THREAD, "trading_watch", {
          missionId: MISSION_ID,
          condition: {
            kind: "derived",
            market: "ETH",
            metric: "vwap_distance",
            params: { metric: "vwap_distance", interval: "1m" },
            direction: "above",
            value: 1,
            mode: "cross",
          },
        });
        assert.equal(armed.result.isError, false);
        assert.equal(armed.result.body.outcome, "armed");
        assert.equal(armed.result.body.watch.watch.type, "metric_derived");
        assert.equal(armed.result.body.watch.watch.metric, "vwap_distance");
      }),
    tradingLayerOverExchange(makeFakeExchange(), archivePath),
  ).pipe(Effect.ensuring(Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true }))));
});

// -- final-form Phase 8: the analyst session --------------------------------
//
// An analyst thread carries the trading capability and no mission. It may
// look, read strategies, and arm account-scoped notify alerts; a wake watch,
// and every acting tool, is refused.

const ANALYST_THREAD = ThreadId.make("thread-analyst-session");

it.effect("the analyst can look, read a strategy, and arm a notify alert", () =>
  withMcpServer(
    ({ callTool, seedAnalystThread }) =>
      Effect.gen(function* () {
        yield* seedAnalystThread(ANALYST_THREAD);

        // The mission-less read answers rather than refusing: the catalog
        // call serves the menu whoever asks.
        const look = yield* callTool(ANALYST_THREAD, "trading_look", {});
        assert.notEqual(look.result.isError, true);
        assert.isDefined(look.result.body.menu);

        // The strategy library is static contract data; the capability alone
        // entitles it.
        const strategy = yield* callTool(ANALYST_THREAD, "trading_strategy", {
          name: "classify",
        });
        assert.notEqual(strategy.result.isError, true);
        assert.equal(strategy.result.body.name, "classify");

        // Arming defaults to a notify alert: account-scoped, no mission id
        // anywhere in the result.
        const armed = yield* callTool(ANALYST_THREAD, "trading_watch", {
          condition: {
            kind: "price",
            market: "ETH",
            direction: "above",
            price: 3_200,
            confirm: "touch",
          },
        });
        assert.notEqual(armed.result.isError, true);
        assert.equal(armed.result.body.outcome, "armed_alert");
        assert.equal(armed.result.body.deliver, "notify");
        assert.equal(armed.result.body.market, "ETH");

        // …and the same watch can be retired again by its id.
        const cancelled = yield* callTool(ANALYST_THREAD, "trading_watch", {
          cancel: armed.result.body.watchId,
        });
        assert.notEqual(cancelled.result.isError, true);
        assert.equal(cancelled.result.body.outcome, "alert_cancelled");
      }),
    tradingLayerOverExchange(makeFakeExchange()),
  ),
);

it.effect("the analyst is refused a wake watch and every acting tool", () =>
  withMcpServer(
    ({ callTool, seedAnalystThread }) =>
      Effect.gen(function* () {
        yield* seedAnalystThread(ANALYST_THREAD);

        // deliver:'wake' (and 'both') is refused, never coerced to notify.
        for (const deliver of ["wake", "both"]) {
          const refused = yield* callTool(ANALYST_THREAD, "trading_watch", {
            condition: {
              kind: "price",
              market: "ETH",
              direction: "above",
              price: 3_200,
              confirm: "touch",
            },
            deliver,
          });
          assert.notEqual(refused.result.isError, true);
          assert.equal(refused.result.body.outcome, "alert_rejected");
          assert.match(refused.result.body.reason, /no mission/);
        }

        // The acting tools refuse on the missing mission binding.
        const plan = yield* callTool(ANALYST_THREAD, "trading_plan", {
          expectedMissionVersion: 1,
          strategy: strategyBody("v1"),
        });
        assert.equal(plan.result.isError, true);
        assert.match(plan.result.content[0].text, /thread_not_bound_to_mission/);

        const enter = yield* callTool(ANALYST_THREAD, "trading_enter", {
          market: "ETH",
          side: "buy",
          stopPrice: 2_900,
        });
        assert.equal(enter.result.isError, true);
        assert.match(enter.result.content[0].text, /thread_not_bound_to_mission/);

        const exit = yield* callTool(ANALYST_THREAD, "trading_exit", { action: "close" });
        assert.equal(exit.result.isError, true);
        assert.match(exit.result.content[0].text, /thread_not_bound_to_mission/);
      }),
    tradingLayerOverExchange(makeFakeExchange()),
  ),
);

it.effect(
  "a mission thread naming deliver:'notify' on trading_watch is answered, not coerced",
  () =>
    withMcpServer(
      ({ callTool }) =>
        Effect.gen(function* () {
          const refused = yield* callTool(BOUND_THREAD, "trading_watch", {
            missionId: MISSION_ID,
            condition: {
              kind: "price",
              market: "ETH",
              direction: "above",
              price: 3_200,
              confirm: "touch",
            },
            deliver: "notify",
          });
          assert.notEqual(refused.result.isError, true);
          assert.equal(refused.result.body.outcome, "alert_rejected");
          assert.match(refused.result.body.reason, /wake the mission/);
        }),
      tradingLayerOverExchange(makeFakeExchange()),
    ),
);

// -- the keyless install ------------------------------------------------------
//
// A T3 Trade install with no Hyperliquid signer has no `trading_accounts` row,
// because `TradingAccountBootstrap` writes one only when a signer is armed. That
// row - not the key - is what every account read needs, and its absence used to
// take the whole market half of a bound `trading_look` down with it: candles,
// volatility, the book and structure are public data and need neither an address
// nor a credential. The base fixture here IS a keyless install; the tests that
// want an armed one seed the account row explicitly.

it.effect("serves the market half of a bound look with no trading account", () => {
  const fake = makeFakeExchange();
  return withMcpServer(
    ({ callTool }) =>
      Effect.gen(function* () {
        const look = yield* callTool(BOUND_THREAD, "trading_look", {
          fetch: ["snapshot", "volatility", "candles:5m:10", "position", "account", "cost"],
        });
        assert.notEqual(look.result.isError, true);
        const body = look.result.body;

        // The public half answered in full.
        assert.isDefined(body.snapshot);
        assert.isDefined(body.volatility);
        assert.isDefined(body.candles);

        // The account half degraded one key at a time, each with the same
        // honest reason - not one `marketReadFailed` swallowing the call.
        assert.equal(body.marketReadFailed, undefined);
        assert.equal(body.position, undefined);
        assert.equal(body.account, undefined);
        assert.equal(body.cost, undefined);
        const refusedKeys = (body.unavailable as ReadonlyArray<{ key: string; reason: string }>)
          .filter((entry) => entry.reason.includes("no trading account exists"))
          .map((entry) => entry.key);
        assert.deepEqual(refusedKeys.sort(), ["account", "cost", "position"]);
      }),
    tradingLayerOverExchange(fake),
  );
});

it.effect("refuses a position-scoped watch that could never fire", () => {
  const fake = makeFakeExchange();
  return withMcpServer(
    ({ callTool, seedTradingAccount }) =>
      Effect.gen(function* () {
        // A `pnl` watch on an environment with no account arms cleanly and then
        // never fires, and silence reads to the model as "the level was not
        // reached". One honest refusal at arm time instead.
        const refused = yield* callTool(BOUND_THREAD, "trading_watch", {
          missionId: MISSION_ID,
          condition: { kind: "pnl", market: "ETH", direction: "above", valueUsd: 25 },
        });
        assert.notEqual(refused.result.isError, true);
        assert.equal(refused.result.body.outcome, "refused");
        assert.equal(refused.result.body.reason, "needs_trading_account");
        assert.match(refused.result.body.detail, /no trading account/);

        // A price level on the same call path is measured from public market
        // data, so it arms exactly as it always did.
        const armed = yield* callTool(BOUND_THREAD, "trading_watch", {
          missionId: MISSION_ID,
          condition: {
            kind: "price",
            market: "ETH",
            direction: "above",
            price: 4_500,
            confirm: "touch",
          },
        });
        assert.equal(armed.result.body.outcome, "armed");

        // And the same pnl condition arms once the environment has an account:
        // the refusal is about the install, not about the condition.
        yield* seedTradingAccount();
        const rearmed = yield* callTool(BOUND_THREAD, "trading_watch", {
          missionId: MISSION_ID,
          condition: { kind: "pnl", market: "ETH", direction: "above", valueUsd: 25 },
        });
        assert.equal(rearmed.result.body.outcome, "armed");
      }),
    tradingLayerOverExchange(fake),
  );
});

it.effect("publishes a plan with no account, and says nothing reached the venue", () => {
  const fake = makeFakeExchange();
  return withMcpServer(
    ({ callTool }) =>
      Effect.gen(function* () {
        const published = yield* callTool(BOUND_THREAD, "trading_plan", {
          missionId: MISSION_ID,
          expectedMissionVersion: 1,
          strategy: strategyBody("keyless"),
        });
        assert.notEqual(published.result.isError, true);
        // The plan is the agent's own read and the chart draws it, so it
        // publishes and records.
        assert.equal(published.result.body.outcome, "accepted");
        // But an accepted publish normally rests a stop and a target on the
        // venue, and here nothing did.
        assert.isTrue(
          (published.result.body.warnings as ReadonlyArray<string>).some((warning) =>
            warning.includes("nothing was placed on the venue"),
          ),
        );

        // And it is readable back, which is the half that still works.
        const look = yield* callTool(BOUND_THREAD, "trading_look", { fetch: ["plan"] });
        assert.equal(look.result.body.mission.strategy.because, "keyless");
      }),
    tradingLayerOverExchange(fake),
  );
});

// -- prompt W: the observe mission -------------------------------------------
//
// A mission whose whole job is to watch a hypothesis being validated. It is a
// mission in every way the runtime cares about, and it has no path to an order:
// the session profile grants no execution tool and these tests prove the
// handlers refuse one even when the model finds a way to emit the call.

const OBSERVE_CHAT_THREAD = ThreadId.make("thread-observe-chat");

/** The thesis an observe mission is created against. */
const observeThesis = {
  market: "ETH",
  interval: "5m",
  side: "long",
  entry: {
    predicates: [
      {
        left: { source: "price" },
        comparator: "crosses_above",
        right: { source: "constant", value: 3_000 },
      },
    ],
  },
  exits: { stop: { basis: "percent", value: 2 }, target: { basis: "percent", value: 1 } },
};

it.effect("validates an arm request before resolving its hypothesis", () =>
  withMcpServer(
    ({ callTool }) =>
      Effect.gen(function* () {
        const refused = yield* callTool(OBSERVE_CHAT_THREAD, "trading_validate", {
          action: "arm",
          hypothesisId: "missing-hypothesis",
        });
        assert.equal(refused.result.isError, true);
        assert.match(refused.result.content[0].text, /arm needs durationHours/);
        assert.notMatch(refused.result.content[0].text, /no hypothesis with that id/);
      }),
    tradingLayerOverExchange(makeFakeExchange()),
  ),
);

it.effect("an observe mission is created from a filed idea and cannot trade", () =>
  withMcpServer(
    ({ callTool, missions, seedLocalTradingAccount }) =>
      Effect.gen(function* () {
        // The account an auto-created mission is opened against, exactly as
        // the bind-on-first-use tests seed it.
        yield* seedLocalTradingAccount();

        const saved = yield* callTool(OBSERVE_CHAT_THREAD, "trading_hypothesis", {
          action: "save",
          title: "ETH holds above 3000",
          thesis: observeThesis,
        });
        if (saved.result.isError === true) {
          return assert.fail(`save refused: ${saved.result.content[0].text}`);
        }
        const hypothesisId = saved.result.body.hypothesis.hypothesisId as string;

        const watching = yield* callTool(OBSERVE_CHAT_THREAD, "trading_hypothesis", {
          action: "observe",
          hypothesisId,
        });
        if (watching.result.isError === true) {
          return assert.fail(`observe refused: ${watching.result.content[0].text}`);
        }
        assert.match(watching.result.body.outcome, /Watching "ETH holds above 3000" on ETH/);
        assert.match(watching.result.body.outcome, /cannot plan, enter or exit/);

        // The mission exists, is bound to this thread, and says what it is for.
        const bound = yield* missions.findMissionByThreadId(OBSERVE_CHAT_THREAD).pipe(Effect.orDie);
        assert.equal(bound._tag, "Some");
        if (bound._tag !== "Some") return;
        assert.equal(bound.value.purpose, "observe");
        assert.equal(bound.value.market, "ETH");

        // It holds NO market. Exclusivity exists because the venue nets
        // positions per asset, and a mission that cannot place an order is not
        // a second agent on anything - so watching ETH must not lock ETH out of
        // being traded. The market is unheld under the observer's own user.
        const holder = yield* missions
          .findActiveMissionOnMarket({
            userId: LOCAL_TRADING_USER_ID,
            venue: "hyperliquid",
            market: "ETH",
          })
          .pipe(Effect.orDie);
        assert.equal(holder._tag, "None", "an observe mission must not reserve its market");

        // The server refuses every execution call, whatever the allowlist did.
        const plan = yield* callTool(OBSERVE_CHAT_THREAD, "trading_plan", {
          expectedMissionVersion: 1,
          strategy: strategyBody("v1"),
        });
        assert.equal(plan.result.isError, true);
        assert.match(plan.result.content[0].text, /mission_cannot_trade/);

        const enter = yield* callTool(OBSERVE_CHAT_THREAD, "trading_enter", {
          market: "ETH",
          side: "buy",
          stopPrice: 2_900,
        });
        assert.equal(enter.result.isError, true);
        assert.match(enter.result.content[0].text, /mission_cannot_trade/);

        const exit = yield* callTool(OBSERVE_CHAT_THREAD, "trading_exit", { action: "close" });
        assert.equal(exit.result.isError, true);
        assert.match(exit.result.content[0].text, /mission_cannot_trade/);
        assert.match(exit.result.content[0].text, /watching, not trading/);

        // It survives the boot sweep exactly like a trade mission: the sweep
        // keys on a deleted thread, and this thread is alive.
        const orphans = yield* missions.listOrphanedMissions();
        assert.isFalse(orphans.some((row) => row.missionId === bound.value.id));

        // …and its lifecycle moves are the ordinary ones.
        const version = yield* missions.getMissionVersion(bound.value.id);
        yield* missions.transition({
          missionId: bound.value.id,
          to: "paused",
          expectedVersion: version,
        });
        const paused = yield* missions.getMission(bound.value.id);
        assert.equal(paused.status, "paused");
        assert.equal(paused.purpose, "observe", "purpose survives a lifecycle move");
        yield* missions.transition({
          missionId: bound.value.id,
          to: "analysing",
          expectedVersion: yield* missions.getMissionVersion(bound.value.id),
        });
        assert.equal((yield* missions.getMission(bound.value.id)).status, "analysing");

        // The way out is at the way in. Found live: an observer asked to stand
        // down had no exit tool and no mission control in its allowlist, so
        // "stop watching" was a request nothing in the session could answer.
        const stopped = yield* callTool(OBSERVE_CHAT_THREAD, "trading_hypothesis", {
          action: "observe",
          hypothesisId,
        });
        assert.notEqual(stopped.result.isError, true);
        assert.match(stopped.result.body.outcome, /stopped watching/);
        assert.match(stopped.result.body.outcome, /validations themselves are untouched/);
        assert.equal((yield* missions.getMission(bound.value.id)).status, "revoked");
        // The thread is free again, so asking to watch once more starts a new one.
        const restarted = yield* callTool(OBSERVE_CHAT_THREAD, "trading_hypothesis", {
          action: "observe",
          hypothesisId,
        });
        assert.notEqual(restarted.result.isError, true);
        assert.match(restarted.result.body.outcome, /Watching "ETH holds above 3000"/);
      }),
    tradingLayerOverExchange(makeFakeExchange()),
  ),
);

// -- prompt AA: the event calendar tool --------------------------------------
//
// The dispatch shape over the real endpoint: the menu, the sourced-date
// refusal, and a study over a seeded archive whose coverage the verdict has
// to state plainly. The engine's arithmetic and the service's lifecycle are
// pinned in their own files; what is pinned here is the tool boundary.

/**
 * A temp archive seeded with 700 daily ETH bars, opening 100 and closing 101:
 * long enough that the real Devcon SEA dates (November 2024) sit inside it,
 * and Devcon Bogota (October 2022) sits before it, which is the exact
 * coverage split the verdict has to state.
 */
const seededDailyArchive = (): string => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-trading-events-"));
  const archivePath = NodePath.join(dir, "market-archive.sqlite");
  const db = openArchiveDatabase(archivePath);
  const DAY = 24 * 60 * 60 * 1_000;
  // @effect-diagnostics globalDate:off - the live-clock fixture seeds archive rows around a real epoch.
  const now = Date.now();
  const todayStart = Math.floor(now / DAY) * DAY;
  upsertCandles(
    db,
    Array.from({ length: 700 }, (_, i) => ({
      coin: "ETH",
      interval: "1d",
      t: todayStart - (700 - i) * DAY,
      tClose: todayStart - (700 - i) * DAY + DAY - 1,
      o: 100,
      h: 101,
      l: 99,
      c: 101,
      v: 10,
      n: 5,
    })),
  );
  db.close();
  return archivePath;
};

it.live("serves the trading_events menu, records sourced dates, and studies them", () => {
  const archivePath = seededDailyArchive();
  return withMcpServer(
    ({ callTool }) =>
      Effect.gen(function* () {
        const menu = yield* callTool(BOUND_THREAD, "trading_events", {});
        assert.equal(menu.result.isError, false);
        assert.include(menu.result.body.menu, "record {name");

        // A date with no source is refused before anything is written.
        const unsourced = yield* callTool(BOUND_THREAD, "trading_events", {
          action: "record",
          name: "Devcon",
          occurrences: [{ start: "2024-11-12", end: "2024-11-15", source: "  " }],
        });
        assert.equal(unsourced.result.isError, true);

        // Devcon SEA, inside the archive's 90-day reach.
        const recorded = yield* callTool(BOUND_THREAD, "trading_events", {
          action: "record",
          name: "Devcon",
          occurrences: [
            {
              start: "2024-11-12",
              end: "2024-11-15",
              label: "Devcon SEA",
              source: "https://devcon.org/en/past-editions/",
            },
            {
              start: "2022-10-11",
              end: "2022-10-14",
              label: "Devcon Bogota",
              source: "https://devcon.org/en/past-editions/",
            },
          ],
        });
        assert.equal(recorded.result.isError, false);
        assert.equal(recorded.result.body.eventSet.name, "Devcon");

        const eventSetId = recorded.result.body.eventSet.eventSetId as string;
        const studied = yield* callTool(BOUND_THREAD, "trading_events", {
          action: "study",
          eventSetId,
          market: "ETH",
          interval: "1d",
          horizonBars: 30,
        });
        assert.equal(studied.result.isError, false);
        const study = studied.result.body.study;
        // The honesty sentence states coverage over the whole set...
        assert.match(studied.result.body.outcome, /1 of 2 occurrences fall inside archived data/);
        // ...and never claims significance.
        assert.include(studied.result.body.outcome, "not evidence");
        // The 2022 date predates the archive and is reported, not dropped.
        assert.equal(study.n, 2);
        assert.equal(study.nCovered, 1);
        const uncovered = study.rows.find(
          (row: { label?: string; covered: boolean }) => row.label === "Devcon Bogota",
        );
        assert.isDefined(uncovered);
        assert.isFalse(uncovered.covered);
      }),
    tradingLayerOverExchange(makeFakeExchange(), archivePath),
  );
});

// -- GLM-3: chat and TRADE.md as the strategy control plane -------------------
//
// The tool-level half of the control plane. The agent's side (writing and
// reading TRADE.md with native file tools) is simulated with plain fs, because
// the contract under test is what the TOOLS and SERVER do around the document:
// show/activate/revise through `trading_plan_document`, drift refusing new
// exposure, watch arming and replacement, and the direct-order path creating
// and activating no document ever.

/** The workspace TRADE.md an agent drafts from a persistent strategy request. */
const CONTROL_PLANE_TRADE_MD_V1 = `# TRADE.md

## Mandate
Trade BTC on the 20/50 EMA cross, closed 15-minute bars only.

## Strategies
- Entry: buy when ema(20) crosses above ema(50) on a closed 15m bar.
- Stop: 1.5x ATR(14) below entry. Target: 2R.

## Change Log
- 2026-08-31: drafted from the user's request; watching armed on activation.
`;

const CONTROL_PLANE_TRADE_MD_V2 = CONTROL_PLANE_TRADE_MD_V1.replace(
  "- 2026-08-31: drafted from the user's request; watching armed on activation.",
  "- 2026-08-31: drafted from the user's request; watching armed on activation.\n" +
    "- 2026-08-31: user revised to the 50/200 cross.",
).replace("20/50 EMA cross", "50/200 EMA cross");

const sha256Of = (content: string): string =>
  NodeCrypto.createHash("sha256").update(content, "utf8").digest("hex");

it.effect("control plane: draft, activate, arm, revise, and never order before the trigger", () => {
  const workspace = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3trade-ctl-plane-"));
  NodeFS.writeFileSync(NodePath.join(workspace, "TRADE.md"), CONTROL_PLANE_TRADE_MD_V1);
  return withMcpServer(
    ({ callTool, seedThreadWorkspace }) =>
      Effect.gen(function* () {
        yield* seedThreadWorkspace(BOUND_THREAD, workspace);

        // A material missing input refuses as data with one focused next
        // step, rather than guessing an activation of whatever is on disk.
        const hashless = yield* callTool(BOUND_THREAD, "trading_plan_document", {
          action: "activate",
        });
        assert.equal(hashless.result.body.outcome, "rejected");
        assert.equal(hashless.result.body.reason, "document_refused");
        assert.include(hashless.result.body.detail, "expectedContentHash");
        assert.include(hashless.result.body.detail, "exactly one question");

        // Show before anything: a draft, no revisions.
        const shown = yield* callTool(BOUND_THREAD, "trading_plan_document", { action: "show" });
        assert.equal(shown.result.body.outcome, "shown");
        assert.equal(shown.result.body.facts.activation, "draft");
        assert.equal(shown.result.body.revisionCount, 0);
        assert.equal(shown.result.body.facts.contentHash, sha256Of(CONTROL_PLANE_TRADE_MD_V1));

        // One activation, hash-gated, with the change note the audit keeps.
        const activated = yield* callTool(BOUND_THREAD, "trading_plan_document", {
          action: "activate",
          expectedContentHash: sha256Of(CONTROL_PLANE_TRADE_MD_V1),
          missionId: MISSION_ID,
          changeNote: "arm the 20/50 EMA cross watch",
        });
        assert.equal(activated.result.body.outcome, "activated");
        assert.equal(activated.result.body.facts.activation, "active");
        assert.equal(activated.result.body.revisionCount, 1);

        // Monitoring is armed as durable watch rows through the watch tool.
        const armed = yield* callTool(BOUND_THREAD, "trading_watch", {
          missionId: MISSION_ID,
          condition: {
            kind: "price",
            market: "ETH",
            direction: "above",
            price: 3_200,
            confirm: "close",
            interval: "15m",
          },
        });
        assert.equal(armed.result.body.outcome, "armed");
        const firstWatchId = armed.result.body.watch.id as string;

        // The strategy is armed, not traded: nothing reached the exchange.
        assert.equal(
          dispatchedCommands.filter((command) => command.type === "trading.execution.requested")
            .length,
          0,
        );

        // Revision through chat: the agent edits the file natively, the tool
        // re-pins against the new hash. The stale hash is refused first.
        NodeFS.writeFileSync(NodePath.join(workspace, "TRADE.md"), CONTROL_PLANE_TRADE_MD_V2);
        const drifted = yield* callTool(BOUND_THREAD, "trading_plan_document", {
          action: "show",
        });
        assert.equal(drifted.result.body.facts.activation, "drifted");
        const stale = yield* callTool(BOUND_THREAD, "trading_plan_document", {
          action: "activate",
          expectedContentHash: sha256Of(CONTROL_PLANE_TRADE_MD_V1),
          changeNote: "stale attempt",
        });
        assert.equal(stale.result.body.outcome, "rejected");
        assert.equal(stale.result.body.reason, "document_refused");
        assert.include(stale.result.body.detail, "stale_hash");

        const revised = yield* callTool(BOUND_THREAD, "trading_plan_document", {
          action: "activate",
          expectedContentHash: sha256Of(CONTROL_PLANE_TRADE_MD_V2),
          missionId: MISSION_ID,
          changeNote: "user revised to the 50/200 cross",
        });
        assert.equal(revised.result.body.outcome, "activated");
        assert.equal(revised.result.body.revisionCount, 2);

        // The watch that no longer represents the plan is replaced atomically.
        const replaced = yield* callTool(BOUND_THREAD, "trading_watch", {
          missionId: MISSION_ID,
          replacesWatchId: firstWatchId,
          condition: {
            kind: "price",
            market: "ETH",
            direction: "above",
            price: 3_350,
            confirm: "close",
            interval: "15m",
          },
        });
        assert.equal(replaced.result.body.outcome, "armed");
        const look = yield* callTool(BOUND_THREAD, "trading_look", { fetch: ["watches"] });
        const registry = (look.result.body.mission?.watches ??
          look.result.body.watches) as ReadonlyArray<{ readonly status: string }>;
        assert.equal(
          registry.filter((watch) => watch.status === "active").length,
          1,
          "the replaced watch must be retired, not duplicated",
        );

        // Still no order: the trigger has not fired.
        assert.equal(
          dispatchedCommands.filter((command) => command.type === "trading.execution.requested")
            .length,
          0,
        );
      }),
    tradingLayerOverExchange(makeFakeExchange()),
  );
});

it.effect("drift refuses new exposure through the enter tool, and never activates anything", () => {
  const workspace = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3trade-ctl-drift-"));
  NodeFS.writeFileSync(NodePath.join(workspace, "TRADE.md"), CONTROL_PLANE_TRADE_MD_V1);
  return withMcpServer(
    ({ callTool, seedThreadWorkspace, seedTradingAccount }) =>
      Effect.gen(function* () {
        yield* seedTradingAccount();
        yield* seedThreadWorkspace(BOUND_THREAD, workspace);
        yield* callTool(BOUND_THREAD, "trading_plan_document", {
          action: "activate",
          expectedContentHash: sha256Of(CONTROL_PLANE_TRADE_MD_V1),
          missionId: MISSION_ID,
        });

        // The document moves after activation: drifted.
        NodeFS.writeFileSync(NodePath.join(workspace, "TRADE.md"), CONTROL_PLANE_TRADE_MD_V2);
        const refused = yield* callTool(BOUND_THREAD, "trading_enter", {
          market: "ETH",
          side: "buy",
          stopPrice: 2_900,
          sizeEth: 0.1,
        });
        assert.equal(refused.result.body.status, "rejected");
        assert.include(refused.result.body.detail, "plan_document_drifted");
        assert.equal(
          dispatchedCommands.filter((command) => command.type === "trading.execution.requested")
            .length,
          0,
        );

        // The refused direct command did NOT activate the drifted revision:
        // the server is the only thing that pins one, and only when asked.
        const still = yield* callTool(BOUND_THREAD, "trading_plan_document", { action: "show" });
        assert.equal(still.result.body.facts.activation, "drifted");
        assert.equal(still.result.body.facts.activatedHash, sha256Of(CONTROL_PLANE_TRADE_MD_V1));

        // Re-activation unblocks the same entry.
        yield* callTool(BOUND_THREAD, "trading_plan_document", {
          action: "activate",
          expectedContentHash: sha256Of(CONTROL_PLANE_TRADE_MD_V2),
          missionId: MISSION_ID,
        });
        const entered = yield* callTool(BOUND_THREAD, "trading_enter", {
          market: "ETH",
          side: "buy",
          stopPrice: 2_900,
          sizeEth: 0.1,
        });
        assert.equal(entered.result.body.status, "filled");
      }),
    bindLayer(),
  );
});

const FRESH_DIRECT_THREAD = ThreadId.make("thread-direct-order");

it.effect("a direct order executes with no TRADE.md created, activated, or required", () => {
  const draftWorkspace = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3trade-ctl-direct-"));
  NodeFS.writeFileSync(NodePath.join(draftWorkspace, "TRADE.md"), CONTROL_PLANE_TRADE_MD_V1);
  return withMcpServer(
    ({ callTool, missions, seedThreadWorkspace, seedLocalTradingAccount, countPlanDocumentRows }) =>
      Effect.gen(function* () {
        yield* seedLocalTradingAccount();
        // A TRADE.md exists in the chat's workspace and was never activated.
        yield* seedThreadWorkspace(FRESH_DIRECT_THREAD, draftWorkspace);

        const entered = yield* callTool(FRESH_DIRECT_THREAD, "trading_enter", {
          market: "SOL",
          side: "buy",
          stopPrice: 2_900,
          sizeEth: 0.1,
        });
        assert.equal(entered.result.body.status, "filled");

        // No document row was created for the direct order...
        assert.equal(yield* countPlanDocumentRows(NodeFS.realpathSync(draftWorkspace)), 0);
        // ...and the workspace's document is still exactly what it was: a
        // draft, unactivated, untouched by the order.
        const shown = yield* callTool(FRESH_DIRECT_THREAD, "trading_plan_document", {
          action: "show",
        });
        assert.equal(shown.result.body.outcome, "shown");
        assert.equal(shown.result.body.facts.activation, "draft");
        assert.equal(shown.result.body.facts.activatedHash, null);
        assert.equal(shown.result.body.revisionCount, 0);

        // The mission the order bound is labelled as what it is.
        const bound = yield* missions.findMissionByThreadId(FRESH_DIRECT_THREAD).pipe(Effect.orDie);
        assert.equal(bound._tag, "Some");
        const instruction = (bound as { readonly value: { readonly instruction: string } }).value
          .instruction;
        assert.include(instruction, "Generated direct-order runtime record");
        assert.include(instruction, "NOT a user-authored TRADE.md strategy");
      }),
    bindLayer(),
  );
});

it.effect("an analyst session may show plan-document facts but not manage them", () => {
  const workspace = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3trade-ctl-analyst-"));
  NodeFS.writeFileSync(NodePath.join(workspace, "TRADE.md"), CONTROL_PLANE_TRADE_MD_V1);
  return withMcpServer(
    ({ callTool, seedAnalystThread, seedThreadWorkspace }) =>
      Effect.gen(function* () {
        yield* seedAnalystThread(ANALYST_THREAD);
        yield* seedThreadWorkspace(ANALYST_THREAD, workspace);

        const shown = yield* callTool(ANALYST_THREAD, "trading_plan_document", { action: "show" });
        assert.equal(shown.result.body.outcome, "shown");
        assert.equal(shown.result.body.facts.activation, "draft");

        const refused = yield* callTool(ANALYST_THREAD, "trading_plan_document", {
          action: "activate",
          expectedContentHash: sha256Of(CONTROL_PLANE_TRADE_MD_V1),
        });
        assert.equal(refused.result.body.outcome, "rejected");
        assert.equal(refused.result.body.reason, "session_read_only");
      }),
    tradingLayerOverExchange(makeFakeExchange()),
  );
});
