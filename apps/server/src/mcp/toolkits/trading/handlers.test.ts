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
  TRADING_LOOK_FLAT_BAR_CAP,
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
import { TradingCostEstimator } from "../../../trading/TradingCostEstimator.ts";
import { TradingExecutionOutcome } from "../../../trading/TradingExecutionOutcome.ts";
import { TradingExitService } from "../../../trading/TradingExitService.ts";
import { TradingLayerLive } from "../../../trading/runtimeLayer.ts";
import {
  TradingMissionService,
  TradingMissionServiceLive,
} from "../../../trading/TradingMissionService.ts";
import { TradingPlanProtectionService } from "../../../trading/TradingPlanProtectionService.ts";
import { TradingEntryService } from "../../../trading/TradingEntryService.ts";
import { TradingStopAdjustmentServiceLive } from "../../../trading/TradingStopAdjustmentService.ts";
import { TradingStrategyServiceLive } from "../../../trading/TradingStrategyService.ts";
import { TradingTradeHistoryServiceLive } from "../../../trading/TradingTradeHistoryService.ts";
import { TradingWatchServiceLive } from "../../../trading/TradingWatchService.ts";
import { TradingJournalServiceLive } from "../../../trading/TradingJournalService.ts";
import { TradingEventInbox, TradingEventInboxLive } from "../../../trading/TradingEventInbox.ts";
import {
  makeTradingMarketArchive,
  TradingMarketArchive,
} from "../../../trading/TradingMarketArchive.ts";
import { openArchiveDatabase } from "../../../trading/archive/db.ts";
import { upsertAssetContexts } from "../../../trading/archive/assetCtx.ts";
import { upsertBookSummaries } from "../../../trading/archive/bookSummary.ts";
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
    submitReduceOnlyAlo: () => Effect.die("not used"),
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
) =>
  Layer.mergeAll(
    // `trading_look` reaches the exchange directly, so the fake gateway is part
    // of what this layer offers rather than only an input to the services.
    exchangeGatewayLayer(fake),
    // The fetch path's archive seam and inbox peek (plan 38 §2).
    Layer.succeed(TradingMarketArchive, makeTradingMarketArchive(archivePath)),
    TradingEventInboxLive,
    TradingMissionServiceLive,
    TradingStrategyServiceLive,
    TradingWatchServiceLive,
    TradingJournalServiceLive,
    TradingTradeHistoryServiceLive,
    TradingCalibrationServiceLive,
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
    // `trading_look` prices its one cost line through this. A fixed estimate
    // keeps the read deterministic; nothing under test grades the number.
    fakeCostEstimator,
    // The one read IS the composer's gather step (plan 29 step 6.1), so the
    // toolkit needs it wherever `trading_look` is exercised.
    TradingWakeupComposerLive.pipe(
      Layer.provide(exchangeGatewayLayer(fake)),
      Layer.provide(TradingMissionServiceLive),
      Layer.provide(TradingWatchServiceLive),
      Layer.provide(TradingStrategyServiceLive),
      Layer.provide(fakeCostEstimator),
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
    Layer.succeed(TradingEntryService, {} as unknown as TradingEntryService["Service"]),
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
  );

/** Either the real trading runtime or the fake-exchange rebuild above. */
type TradingLayerInput = typeof TradingLayerLive | ReturnType<typeof tradingLayerOverExchange>;

const mcpLayerOver = (tradingLayer: TradingLayerInput) =>
  McpHttpServer.layer.pipe(
    Layer.provideMerge(McpSessionRegistry.layer),
    Layer.provideMerge(tradingLayer),
    Layer.provideMerge(NodeSqliteClient.layerMemory()),
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
    /** What the open run recorded as its first execution refusal, if anything. */
    readonly readFirstRefusal: () => Effect.Effect<string | null, never, never>;
  }) => Effect.Effect<A, E, HttpServer.HttpServer>,
  tradingLayer: TradingLayerInput = TradingLayerLive,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      dispatchedCommands.length = 0;
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
      const readFirstRefusal = () =>
        sql<{ readonly first_preview_refusal: string | null }>`
          SELECT first_preview_refusal FROM trading_harness_runs WHERE run_id = 'run_funnel'
        `.pipe(
          Effect.map((rows) => rows[0]?.first_preview_refusal ?? null),
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
          scope: ["market", "position", "mission"],
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
          scope: ["mission"],
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
        scope: ["mission"],
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
        scope: ["mission"],
      });
      const watches = current.result.body.mission.watches;
      assert.equal(watches.length, 1);
      assert.equal(watches[0].status, "active");
    }),
  ),
);

// Phase 3.3: a lean wake hands the run a fired trigger and little else. The
// picture it needs back has to be reachable in at most two scoped looks, each
// bounded — otherwise the lean wake has only moved the context cost one call
// to the right.
it.effect("rebuilds a reacting turn's picture in two scoped, bounded looks", () => {
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

        // One: what price just did, bounded to the bars actually wanted.
        const bars = yield* callTool(BOUND_THREAD, "trading_look", {
          missionId: MISSION_ID,
          scope: ["candles"],
          bars: 6,
        });
        const barsRead = bars.result.body;
        assert.isAtMost(barsRead.candles.bars.length, 6);
        assert.equal(barsRead.volatility.market, "ETH");
        // Everything a reaction did not ask for stayed home.
        assert.equal(barsRead.structure, undefined);
        assert.equal(barsRead.account, undefined);
        assert.equal(barsRead.orderBook, undefined);
        assert.equal(barsRead.trades, undefined);
        // `mission.bound` is always answered — without it nothing else in the
        // response can be read as being about this mission.
        assert.equal(barsRead.mission.bound, true);
        // The live half of the mission read survives a scoped call; the
        // retrospective half is absent rather than reported empty.
        assert.equal(barsRead.mission.watches.length, 1);
        assert.equal(barsRead.mission.journal, undefined);
        assert.equal(barsRead.mission.strategyHistory, undefined);

        // Two: what the mission holds, and what it costs to get out of.
        const held = yield* callTool(BOUND_THREAD, "trading_look", {
          missionId: MISSION_ID,
          scope: ["position"],
        });
        const heldRead = held.result.body;
        assert.equal(heldRead.position.size, 0);
        assert.notEqual(heldRead.account, undefined);
        assert.equal(heldRead.candles, undefined);
        assert.equal(heldRead.structure, undefined);

        // And the unscoped read is unchanged: the assessment turn still gets
        // everything, retrospect included.
        const full = yield* callTool(BOUND_THREAD, "trading_look", {
          missionId: MISSION_ID,
          scope: ["market", "candles", "structure", "position", "mission", "retrospect", "trades"],
        });
        const fullRead = full.result.body;
        assert.notEqual(fullRead.structure, undefined);
        assert.notEqual(fullRead.account, undefined);
        assert.notEqual(fullRead.candles, undefined);
        assert.notEqual(fullRead.mission.strategyHistory, undefined);
        assert.notEqual(fullRead.mission.journal, undefined);

        // Plan 33 fix 2.2: `mission` is the live working set. The
        // back-catalogue is its own scope, so a turn that scoped correctly is
        // not still paying for it.
        const live = yield* callTool(BOUND_THREAD, "trading_look", {
          missionId: MISSION_ID,
          scope: ["mission"],
        });
        const liveRead = live.result.body;
        assert.equal(liveRead.mission.bound, true);
        assert.notEqual(liveRead.mission.mission, undefined);
        assert.notEqual(liveRead.mission.mission.authority, undefined);
        assert.notEqual(liveRead.mission.strategy, undefined);
        assert.equal(liveRead.mission.watches.length, 1);
        assert.equal(liveRead.mission.strategyHistory, undefined);
        assert.equal(liveRead.mission.journal, undefined);
        assert.equal(liveRead.mission.targetCalibration, undefined);

        const retrospect = yield* callTool(BOUND_THREAD, "trading_look", {
          missionId: MISSION_ID,
          scope: ["retrospect"],
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
const manyCandles = Array.from({ length: 150 }, (_, i) => ({
  openTime: 4_000_000 - (150 - i) * 60_000,
  closeTime: 4_000_000 - (150 - i) * 60_000 + 59_000,
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
          scope: ["candles"],
          bars: 150,
          indicators: [{ kind: "ema", period: 50 }],
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
        assert.equal(read.candles.bars.length, TRADING_LOOK_FLAT_BAR_CAP);
        assert.equal(read.candles.bars.at(-1)?.[3], manyCandles.at(-1)?.close);
      }),
    tradingLayerOverExchange(fake),
  );
});

it.effect("caps the chart a flat look echoes, and says that it did", () => {
  const fake = makeFakeExchange({ candles: manyCandles });
  return withMcpServer(
    ({ callTool, seedTradingAccount }) =>
      Effect.gen(function* () {
        yield* seedTradingAccount();
        const look = yield* callTool(BOUND_THREAD, "trading_look", {
          missionId: MISSION_ID,
          scope: ["candles"],
          bars: 120,
          indicators: [{ kind: "ema", period: 50 }],
        });
        const read = look.result.body;
        assert.equal(read.candles.bars.length, TRADING_LOOK_FLAT_BAR_CAP);
        // Silent truncation reads as the whole chart, so the cap says so.
        assert.include(read.candles.note ?? "", "capped");
        assert.include(read.candles.note ?? "", "120");
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
          scope: ["candles"],
          bars: 120,
          indicators: [{ kind: "ema", period: 50 }],
        });
        const narrow = yield* callTool(BOUND_THREAD, "trading_look", {
          missionId: MISSION_ID,
          scope: ["candles"],
          bars: 5,
          indicators: [{ kind: "ema", period: 50 }],
        });
        // The whole safety argument for the cap: readings are computed over the
        // full fetched lookback and only the echoed table is trimmed.
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
          scope: ["candles"],
          bars: 6,
          indicators: [{ kind: "ema", period: 3 }, { kind: "vwap" }, { kind: "sma", period: 200 }],
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

        // A look that names no indicators carries none.
        const bare = yield* callTool(BOUND_THREAD, "trading_look", {
          missionId: MISSION_ID,
          scope: ["candles"],
          bars: 6,
        });
        assert.equal(bare.result.body.indicators, undefined);
      }),
    tradingLayerOverExchange(fake),
  );
});

// Plan 34 step 1: the look that was 33,000 characters. A turn that pulled
// `ema(20)` and `ema(50)` also got the 120-bar window it read them from, the
// per-timeframe structure detail nothing downstream reads, and the mandate it
// already knows — three copies of the same context, once per wake.
it.effect("echoes the chart only when the chart is what was asked for", () => {
  const fake = makeFakeExchange();
  return withMcpServer(
    ({ callTool, seedTradingAccount }) =>
      Effect.gen(function* () {
        yield* seedTradingAccount();

        // Indicators named, bars not: the readings, and none of the window
        // they were read from.
        const pulled = yield* callTool(BOUND_THREAD, "trading_look", {
          missionId: MISSION_ID,
          scope: ["candles"],
          indicators: [{ kind: "ema", period: 20 }],
        });
        const pulledRead = pulled.result.body;
        assert.equal(pulledRead.candles.bars.length, 0);
        assert.equal(pulledRead.indicators.length, 1);
        // The measurements are still taken over the full fetched lookback.
        assert.isTrue(Number.isFinite(pulledRead.indicators[0].value));
        assert.equal(pulledRead.volatility.market, "ETH");

        // `bars: 0` asks for the same thing outright.
        const none = yield* callTool(BOUND_THREAD, "trading_look", {
          missionId: MISSION_ID,
          scope: ["candles"],
          bars: 0,
        });
        assert.equal(none.result.body.candles.bars.length, 0);

        // Neither named: a short tail, not the whole lookback.
        const tail = yield* callTool(BOUND_THREAD, "trading_look", {
          missionId: MISSION_ID,
          scope: ["candles"],
        });
        assert.equal(tail.result.body.candles.bars.length, 20);

        // A call that named bars beside indicators gets both.
        const both = yield* callTool(BOUND_THREAD, "trading_look", {
          missionId: MISSION_ID,
          scope: ["candles"],
          bars: 5,
          indicators: [{ kind: "ema", period: 20 }],
        });
        assert.equal(both.result.body.candles.bars.length, 5);

        // Plan 35 step 1: the window rides back as a table. Six numbers a row
        // in the column order the header names, and the stamps the row form
        // repeated on every bar are reconstructible from the two it states.
        const table = both.result.body.candles;
        assert.equal(table.columns, "open,high,low,close,volume,trades");
        assert.equal(table.intervalMillis, 60_000);
        assert.isTrue(Number.isFinite(table.firstOpenTime));
        assert.deepStrictEqual(
          table.bars.map((row: ReadonlyArray<number>) => row.length),
          [6, 6, 6, 6, 6],
        );
        // A window with no bars states no first stamp rather than a false one.
        assert.equal(none.result.body.candles.firstOpenTime, undefined);
        assert.equal(both.result.body.indicators.length, 1);
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
          scope: ["structure"],
        });
        const structure = look.result.body.structure;
        assert.notEqual(structure, undefined);
        assert.notEqual(structure.regime, undefined);
        assert.notEqual(structure.alignment, undefined);
        // This mission's mandate names no interval, so its thesis frame is the
        // 1m default — the one frame whose gated readings ride back whole.
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
        // A candidate carries every field of the setup it was built from plus
        // the cost of taking it, so the two tables are never both sent.
        assert.isTrue(structure.candidates === undefined || structure.setups === undefined);
      }),
    tradingLayerOverExchange(fake),
  );
});

// The `range_reversion` doctrine says to read `levelHistory` before arming and
// to compare this read's boundary against `previousStructureRead`. Both were
// gathered by `observe` and dropped at every exit, so both sentences pointed at
// fields no tool returned.
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
          scope: ["structure"],
        });

        const history = look.result.body.levelHistory;
        assert.isDefined(history, "expected the structure scope to carry the level memory");
        assert.equal(history[0].closedThrough, 2);

        // And the read this call just took is remembered for the next one to
        // compare against — the other half of the same doctrine sentence.
        const again = yield* callTool(BOUND_THREAD, "trading_look", {
          missionId: MISSION_ID,
          scope: ["structure"],
        });
        assert.isDefined(again.result.body.previousStructureRead);
      }),
    tradingLayerOverExchange(fake),
  );
});

// Plan 34 step 1.3: the mandate does not change for a mission's life, so a
// reacting turn does not re-read a thousand characters of it every wake.
it.effect("abridges the mandate off the hot path and serves it whole on retrospect", () => {
  const fake = makeFakeExchange();
  return withMcpServer(
    ({ callTool, seedTradingAccount }) =>
      Effect.gen(function* () {
        yield* seedTradingAccount();
        const live = yield* callTool(BOUND_THREAD, "trading_look", {
          missionId: MISSION_ID,
          scope: ["mission"],
        });
        const abridged = live.result.body.mission.mission.instruction;

        const whole = yield* callTool(BOUND_THREAD, "trading_look", {
          missionId: MISSION_ID,
          scope: ["mission", "retrospect"],
        });
        const full = whole.result.body.mission.mission.instruction;

        if (full.length > 120) {
          assert.isBelow(abridged.length, full.length);
          assert.include(abridged, "retrospect");
        } else {
          // A short mandate is already its own pointer.
          assert.equal(abridged, full);
        }
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
        scope: ["mission"],
      });
      assert.notEqual(unbound.result.isError, true);
      assert.equal(unbound.result.body.mission.bound, false);

      // A bound thread naming someone else's mission is still refused, firmly.
      const wrongMission = yield* callTool(BOUND_THREAD, "trading_look", {
        missionId: "mission_belonging_to_someone_else",
      });
      assert.equal(wrongMission.result.isError, true);
      assert.deepStrictEqual(wrongMission.result.content, [
        {
          type: "text",
          text: `TradingToolRejectedError: mission_not_bound_to_thread (thread=${BOUND_THREAD}, mission=mission_belonging_to_someone_else)`,
        },
      ]);
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
      assert.deepStrictEqual(published.result.content, [
        {
          type: "text",
          text: `TradingToolRejectedError: thread_not_bound_to_mission (thread=${UNBOUND_THREAD}, mission=${MISSION_ID})`,
        },
      ]);
    }),
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
        scope: ["mission"],
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
  withMcpServer(({ callTool }) =>
    Effect.gen(function* () {
      yield* callTool(BOUND_THREAD, "trading_watch", {
        missionId: MISSION_ID,
        condition: { kind: "giveback", market: "ETH", drawdownUsd: 4 },
      });

      const listed = yield* callTool(BOUND_THREAD, "trading_look", { scope: ["mission"] });
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
      const listed = yield* callTool(BOUND_THREAD, "trading_look", { scope: ["mission"] });
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
      const look = yield* callTool(BOUND_THREAD, "trading_look", { scope: ["retrospect"] });
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

      // The retired half is retrospect now, so the swap is read with it.
      const listed = yield* callTool(BOUND_THREAD, "trading_look", {
        scope: ["mission", "retrospect"],
      });
      const watches = listed.result.body.mission.watches;
      const byId = new Map(watches.map((w: { id: string; status: string }) => [w.id, w.status]));
      assert.equal(byId.get(originalId.slice(0, 8)), "cancelled");
      assert.equal(byId.get(moved.result.body.watch.id.slice(0, 8)), "active");

      // And a hot-path look carries only what can still fire.
      const armedOnly = yield* callTool(BOUND_THREAD, "trading_look", { scope: ["mission"] });
      assert.deepStrictEqual(
        armedOnly.result.body.mission.watches.map((w: { status: string }) => w.status),
        ["active"],
      );

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
          scope: ["mission"],
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
          scope: ["mission"],
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

      const read = yield* callTool(BOUND_THREAD, "trading_look", { scope: ["trades"] });
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
      const omitted = yield* callTool(BOUND_THREAD, "trading_look", { scope: ["mission"] });
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
      const after = yield* callTool(BOUND_THREAD, "trading_look", { scope: ["mission"] });
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
      assert.deepStrictEqual(wrong.result.content, [
        {
          type: "text",
          text: `TradingToolRejectedError: mission_not_bound_to_thread (thread=${BOUND_THREAD}, mission=mission_belonging_to_someone_else)`,
        },
      ]);
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
        scope: ["mission"],
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

      // The mandate guard refuses before any exchange read, which is the point:
      // an entry is priced and pre-checked before anything is dispatched, so
      // the reactor — which records its own refusals — never sees this one.
      const entered = yield* callTool(BOUND_THREAD, "trading_enter", {
        market: "BTC",
        side: "buy",
        stopPrice: 3_100,
        sizeEth: 0.1,
      });
      assert.equal(entered.result.body.status, "rejected");

      // Without this the turn records as `no_setup` — the same shape as a turn
      // that never wanted to trade at all.
      assert.include(yield* readFirstRefusal(), "market_is_eth");
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

it.effect("refuses a target the round trip would eat, and writes nothing", () =>
  withMcpServer(({ callTool, seedTradingAccount }) =>
    Effect.gen(function* () {
      // The cost read needs the master wallet the account carries.
      yield* seedTradingAccount();

      // Over the fake book the crossing round trip is ~$1.23 on $1,000, so the
      // rung is ~$2.46 and the floor under it ~$1.85. A $0.40 target is the
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
        scope: ["mission"],
      });
      assert.equal(after.result.body.mission.missionVersion, 1);
      assert.equal(after.result.body.mission.strategy, undefined);
    }),
  ),
);

it.effect("holds a patient plan to the round trip its own execution buys", () =>
  withMcpServer(({ callTool, seedTradingAccount }) =>
    Effect.gen(function* () {
      yield* seedTradingAccount();

      // Over the same book the taker/maker round trip is ~$0.77, so a resting
      // entry answers to a ~$1.15 floor rather than the crossing ~$1.85. A
      // $1.30 target pays for a patient trade and does not pay for a crossing
      // one, which is the whole reason the floor is priced at the execution
      // the plan named rather than at the rung.
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
          scope: ["position"],
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

// -- plan 38 phase 2c: the scope[] compatibility pin ---------------------------
//
// `fetch[]` ships alongside `scope[]` (§5.3), and the compatibility guarantee is
// byte identity: a call naming `scope` gets the pre-phase behaviour exactly.
// These goldens were captured against the pre-fetch build and are the
// regression oracle for every change to the read path. A changed digest here
// means the legacy path moved, whatever the intent was.
//
// sha256 of `result.content[0].text` — the exact JSON the model receives. The
// fixtures are fixed-timestamp throughout (freshness at 1_000_000, TestClock
// observedAt), so the digests are stable across runs; a digest rather than the
// full ~4k strings keeps the oracle reviewable as one line per call.
const GOLDEN_CALLS: ReadonlyArray<{ readonly label: string; readonly digest: string }> = [
  {
    label: "scope:market",
    digest: "72fcd3c985c19ed4b8f6d5ebc0e1bf00c171c8797dd9570896c0eeb140d9db85",
  },
  {
    label: "scope:candles",
    digest: "32ce5d278d0c516c68d27c6caa1f90225761da7391d35a3df38b0d1d116977dd",
  },
  {
    label: "scope:structure",
    digest: "90b6f494127d3839b07ab902b27d2e4fad91da094b3732477c7874b4137c8ad5",
  },
  {
    label: "scope:position",
    digest: "5e696f39165900b9900570b8cd8d62ff379534fe17d135ce8f3bdfdd9100071a",
  },
  {
    label: "scope:mission",
    digest: "a071eb3afa4a55b96238d8376d657fa80f8b0c9396f4f7541eed465425e38b3f",
  },
  {
    label: "scope:retrospect",
    digest: "90a262b49601757a7f9d2912aa0d9f89868b48a6e3f8ca5fa4ce6b5f35949645",
  },
  {
    label: "scope:trades",
    digest: "702e8827b6be9ee1bdd0ac6ccd82c104b5c7c5245c617f3bfd4923a1762752d1",
  },
  {
    // Identical to scope:market by design: the mission half is always answered,
    // so naming it changes nothing the call returns.
    label: "scope:market+mission",
    digest: "72fcd3c985c19ed4b8f6d5ebc0e1bf00c171c8797dd9570896c0eeb140d9db85",
  },
  {
    label: "scope:candles interval/bars/indicators",
    digest: "a35294d6ae5c2a42ef9b8d196c8bf97d81ca2e08a98fe890ef6e3b651b884c6f",
  },
  {
    label: "unbound scope:market+candles",
    digest: "2d2dd2c26c6894fbc09f3602137dc6935114b4f01b96104176b615589cc4d4d9",
  },
];

const GOLDEN_SETUP: ReadonlyArray<{
  readonly label: string;
  readonly args: unknown;
  readonly thread?: ThreadId;
}> = [
  { label: "scope:market", args: { missionId: MISSION_ID, scope: ["market"] } },
  { label: "scope:candles", args: { missionId: MISSION_ID, scope: ["candles"] } },
  { label: "scope:structure", args: { missionId: MISSION_ID, scope: ["structure"] } },
  { label: "scope:position", args: { missionId: MISSION_ID, scope: ["position"] } },
  { label: "scope:mission", args: { missionId: MISSION_ID, scope: ["mission"] } },
  { label: "scope:retrospect", args: { missionId: MISSION_ID, scope: ["retrospect"] } },
  { label: "scope:trades", args: { missionId: MISSION_ID, scope: ["trades"] } },
  {
    label: "scope:market+mission",
    args: { missionId: MISSION_ID, scope: ["market", "mission"] },
  },
  {
    label: "scope:candles interval/bars/indicators",
    args: {
      missionId: MISSION_ID,
      scope: ["candles"],
      interval: "1m",
      bars: 6,
      indicators: [{ kind: "ema", period: 20 }],
    },
  },
  {
    label: "unbound scope:market+candles",
    args: { scope: ["market", "candles"] },
    thread: UNBOUND_THREAD,
  },
];

it.effect("pins trading_look scope results byte for byte (plan 38 §5.3)", () => {
  const fake = makeFakeExchange();
  return withMcpServer(
    ({ callTool, seedTradingAccount, seedActiveWatch, seedFill }) =>
      Effect.gen(function* () {
        // One deterministic mission state: a published plan, one armed watch,
        // two completed fills. The digests below are of THAT state.
        yield* seedTradingAccount();
        yield* callTool(BOUND_THREAD, "trading_plan", {
          missionId: MISSION_ID,
          expectedMissionVersion: 1,
          strategy: strategyBody("golden pin v1"),
        });
        yield* seedActiveWatch("watch_golden_pin");
        yield* seedFill({ fillId: "golden_f1", orderId: 900, closedPnl: 12, feeUsd: 1 });
        yield* seedFill({ fillId: "golden_f2", orderId: 901, closedPnl: -4, feeUsd: 1 });

        for (const call of GOLDEN_SETUP) {
          const response = yield* callTool(call.thread ?? BOUND_THREAD, "trading_look", call.args);
          assert.equal(response.result.isError, false, call.label);
          const text = response.result.content[0].text as string;
          const digest = NodeCrypto.createHash("sha256").update(text).digest("hex");
          const expected = GOLDEN_CALLS.find((golden) => golden.label === call.label)?.digest;
          if (expected === undefined || expected === "GOLDEN") {
            // Capture mode: print the digest so it can be pinned. A pinned run
            // never takes this branch.
            process.stdout.write(`GOLDEN ${call.label} ${digest} chars=${text.length}\n`);
            continue;
          }
          assert.equal(digest, expected, call.label);
        }
      }),
    tradingLayerOverExchange(fake),
  );
});

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
        // Plan 38 phase 3: the menu carries all twelve derived metrics, one
        // line each — this and the watch refusals are where the model meets
        // them, never the tool descriptions (§4.1).
        for (const metric of DERIVED_METRIC_CATALOG) {
          assert.include(menu.result.body.menu, `derived:${metric.metric} `);
        }
        assert.equal((menu.result.body.menu.match(/derived:/g) ?? []).length, 12);
      }
      // The actual measured size of the menu — the number the phase report
      // carries, asserted so a catalog edit that grows it past the documented
      // budget has to say so here. Plan 38 phase 3 added the derived-metric
      // catalog (§3.3): measured 1,254 (JSON-stringified), ~540 of priced
      // keys plus ~710 of derived lines.
      const measured = sectionChars(renderTradingLookMenu());
      process.stdout.write(`MENU_CHARS ${measured}\n`);
      assert.isAtMost(measured, 1_350);
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

it.effect("refuses a call that names both scope and fetch", () =>
  withMcpServer(({ callTool }) =>
    Effect.gen(function* () {
      const refused = yield* callTool(BOUND_THREAD, "trading_look", {
        scope: ["market"],
        fetch: ["snapshot"],
      });
      assert.equal(refused.result.isError, true);
      assert.include(refused.result.content[0].text as string, "scope_and_fetch_conflict");
      assert.include(refused.result.content[0].text as string, "pass scope or fetch, not both");
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
              case "levels":
                return sectionChars(section("levelHistory"));
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
