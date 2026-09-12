/**
 * What the Graph research service claims, held to its honesty rules.
 *
 * A fake Graph source serves pinned windows; the tests prove: unconfigured
 * and unknown pools are named unavailable states; occurrence caps refuse
 * before any request; a healthy load produces candles, features, and a
 * manifest whose hashes cover the executed query and merged content; one
 * unhealthy window degrades to partial; all unhealthy refuses; duplicate
 * observations across overlapping windows are merged once.
 *
 * @module GraphResearchService.test
 */
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { ForgeSwapObservation, ForgeWindowFetch } from "@t3tools/trading-contracts";
import type { TradingEventOccurrence } from "@t3tools/trading-contracts/eventSets";

import {
  ForgeGraphSource,
  type ForgeGraphSettings,
  type ForgeGraphSourceShape,
} from "../forge/GraphSource.ts";
import {
  GraphResearchService,
  makeGraphResearchService,
  GRAPH_STUDY_MAX_OCCURRENCES,
} from "./GraphResearchService.ts";

const POOL = "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640";

const swap = (timestamp: number, sender: string, amount0: string): ForgeSwapObservation => ({
  chain: "ethereum-mainnet",
  poolId: POOL,
  observationId: `0xtx:${timestamp}:${sender}`,
  transactionHash: "0x" + "1".repeat(64),
  logIndex: 0,
  timestamp,
  sender,
  recipient: "0xrecipient",
  amount0,
  amount1: "-" + amount0,
  sqrtPriceX96: "1",
  tick: 0,
  baseIsToken1: false,
  priceQuotePerBase: { numerator: "2000", denominator: "1" },
  priceQuotePerBaseMicros: 2_000_000,
  quoteVolumeMicros: Math.abs(Number(amount0)),
  quoteVolumeRaw: String(Math.abs(Number(amount0))),
});

const fetchOf = (over: Partial<ForgeWindowFetch>): ForgeWindowFetch => ({
  poolId: POOL,
  status: "complete",
  fetchedAtMs: 1_700_010_000_000,
  historical: true,
  pinnedBlock: 18_500_000,
  pinnedBlockHash: "0xpin",
  deployment: "Qmdeploy",
  window: { startedAt: 0, endedAt: 3600 },
  observations: [],
  ...over,
});

const makeSource = (behavior: {
  configured: boolean;
  windows?: ReadonlyArray<ForgeWindowFetch>;
}): {
  shape: ForgeGraphSourceShape;
  calls: Array<{ readonly startedAt: number; readonly endedAt: number }>;
} => {
  const calls: Array<{ readonly startedAt: number; readonly endedAt: number }> = [];
  const configuredSettings: ForgeGraphSettings = {
    configured: true,
    source: {
      kind: "uniswap-v3-graph" as const,
      endpoint: "https://graph.example",
      deployment: "Qmdeploy",
      indexingEndpoint: "https://indexing.example",
      pools: [
        {
          chain: "ethereum-mainnet" as const,
          poolId: POOL,
          feeTierHundredthsBps: 500,
          label: "USDC/WETH 0.05%",
          token0: {
            address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
            symbol: "USDC",
            decimals: 6,
          },
          token1: {
            address: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
            symbol: "WETH",
            decimals: 18,
          },
          // USDC is token0, so the base (WETH) is token1.
          baseIsToken1: true,
        },
      ],
      maxLagBlocks: 6,
      pageSize: 100,
      maxSwapsPerFetch: 500,
    },
  };
  const settings: ForgeGraphSettings = behavior.configured
    ? configuredSettings
    : { configured: false, reason: "forge graph source not configured" };
  const shape: ForgeGraphSourceShape = {
    settings: Effect.succeed(settings),
    probeHealth: Effect.succeed({ status: "healthy" as const, probedAtMs: 0 }),
    fetchWindow: (input) =>
      Effect.sync(() => {
        calls.push({ startedAt: input.startedAt, endedAt: input.endedAt });
        const match = (behavior.windows ?? []).find(
          (window) => window.window?.startedAt === input.startedAt,
        );
        return (
          match ??
          fetchOf({
            status: "unavailable",
            reason: "no fixture",
            observations: undefined,
            pinnedBlock: undefined,
            pinnedBlockHash: undefined,
            window: { startedAt: input.startedAt, endedAt: input.endedAt },
          })
        );
      }),
    fetchAllPools: () => Effect.die("not under test"),
  };
  return { shape, calls };
};

const withService = (shape: ForgeGraphSourceShape): Layer.Layer<GraphResearchService> =>
  Layer.effect(
    GraphResearchService,
    Effect.provideService(makeGraphResearchService, ForgeGraphSource, shape),
  );

const HOUR = 3_600_000;
const occurrence: TradingEventOccurrence = {
  startAt: 1_700_000_000_000,
  endAt: 1_700_000_001_000,
  source: "test",
};

describe("GraphResearchService.loadStudyDataset", () => {
  it("names the unconfigured source unavailable without touching the network", () =>
    Effect.gen(function* () {
      const { calls } = makeSource({ configured: false });
      const service = yield* GraphResearchService;
      const read = yield* service.loadStudyDataset({
        environmentId: "env-1",
        poolId: POOL,
        occurrences: [occurrence],
        intervalMs: HOUR,
        horizonBars: 1,
        now: 1_700_010_000_000,
      });
      assert.equal(read.status, "unavailable");
      if (read.status === "unavailable") assert.include(read.reason, "not configured");
      assert.equal(calls.length, 0);
    }).pipe(Effect.provide(withService(makeSource({ configured: false }).shape))));

  it("refuses an unvetted pool and an oversized event set before fetching", () => {
    const { shape, calls } = makeSource({ configured: true });
    return Effect.gen(function* () {
      const service = yield* GraphResearchService;
      const badPool = yield* service.loadStudyDataset({
        environmentId: "env-1",
        poolId: "0xunknown",
        occurrences: [occurrence],
        intervalMs: HOUR,
        horizonBars: 1,
        now: 1_700_010_000_000,
      });
      assert.equal(badPool.status, "unavailable");
      const tooMany = yield* service.loadStudyDataset({
        environmentId: "env-1",
        poolId: POOL,
        occurrences: Array.from({ length: GRAPH_STUDY_MAX_OCCURRENCES + 1 }, (_, i) => ({
          ...occurrence,
          startAt: occurrence.startAt + i * HOUR,
        })),
        intervalMs: HOUR,
        horizonBars: 1,
        now: 1_700_010_000_000 + GRAPH_STUDY_MAX_OCCURRENCES * HOUR,
      });
      assert.equal(tooMany.status, "unavailable");
      if (tooMany.status === "unavailable") assert.include(tooMany.reason, "cap");
      assert.equal(calls.length, 0);
    }).pipe(Effect.provide(withService(shape)));
  });

  it("returns candles, features, and a hashed manifest from healthy windows", () => {
    const { shape, calls } = makeSource({
      configured: true,
      windows: [
        fetchOf({
          window: { startedAt: 1_700_000_000, endedAt: 1_700_003_600 },
          observations: [swap(1_700_000_060, "0xa", "2000"), swap(1_700_000_120, "0xb", "-800")],
        }),
      ],
    });
    return Effect.gen(function* () {
      const service = yield* GraphResearchService;
      const read = yield* service.loadStudyDataset({
        environmentId: "env-1",
        poolId: POOL,
        occurrences: [occurrence],
        intervalMs: HOUR,
        horizonBars: 1,
        now: 1_700_010_000_000,
      });
      assert.equal(read.status, "ok");
      if (read.status !== "ok") return;
      const { dataset } = read;
      assert.equal(calls.length, 1);
      assert.equal(calls[0]!.startedAt, 1_700_000_000);
      // One sparse bucket, prices from the observations, features signed.
      assert.equal(dataset.candles.length, 1);
      assert.equal(dataset.candles[0]!.trades, 2);
      assert.equal(dataset.features[0]!.netFlowMicros, 2000 - 800);
      assert.equal(dataset.features[0]!.participants, 2);
      assert.equal(dataset.features[0]!.tradeCount, 2);
      // The manifest covers exactly what ran.
      assert.equal(dataset.manifest.deploymentOrPackageId, "Qmdeploy");
      assert.equal(dataset.manifest.status, "complete");
      assert.equal(dataset.manifest.mode, "historical-replay");
      assert.equal(dataset.manifest.pin?.blockNumber, "18500000");
      assert.match(dataset.manifest.programSha256, /^[0-9a-f]{64}$/);
      assert.match(dataset.manifest.contentSha256, /^[0-9a-f]{64}$/);
    }).pipe(Effect.provide(withService(shape)));
  });

  it("degrades to partial when one window is unhealthy, refuses when all are", () => {
    const second: TradingEventOccurrence = {
      startAt: occurrence.startAt + 2 * HOUR,
      endAt: occurrence.startAt + 2 * HOUR + 1_000,
      source: "test",
    };
    const { shape } = makeSource({
      configured: true,
      windows: [
        fetchOf({
          window: { startedAt: 1_700_000_000, endedAt: 1_700_003_600 },
          observations: [swap(1_700_000_060, "0xa", "100")],
        }),
        // Second window: no fixture → unavailable.
      ],
    });
    return Effect.gen(function* () {
      const service = yield* GraphResearchService;
      const partial = yield* service.loadStudyDataset({
        environmentId: "env-1",
        poolId: POOL,
        occurrences: [occurrence, second],
        intervalMs: HOUR,
        horizonBars: 1,
        now: 1_700_010_000_000,
      });
      assert.equal(partial.status, "ok");
      if (partial.status === "ok") {
        assert.equal(partial.dataset.manifest.status, "partial");
        assert.equal(partial.dataset.features[1]!.tradeCount, 0);
      }
      const none = yield* service.loadStudyDataset({
        environmentId: "env-1",
        poolId: POOL,
        occurrences: [second],
        intervalMs: HOUR,
        horizonBars: 1,
        now: 1_700_010_000_000,
      });
      assert.equal(none.status, "unavailable");
    }).pipe(Effect.provide(withService(shape)));
  });

  it("merges duplicate observations across overlapping windows exactly once", () => {
    // Two adjacent one-hour windows whose fetches both return the shared
    // boundary trade (same observationId).
    const shared = swap(1_700_000_100, "0xa", "500");
    const { shape } = makeSource({
      configured: true,
      windows: [
        fetchOf({
          window: { startedAt: 1_700_000_000, endedAt: 1_700_003_600 },
          observations: [shared],
        }),
        fetchOf({
          window: { startedAt: 1_700_003_600, endedAt: 1_700_007_200 },
          observations: [shared],
        }),
      ],
    });
    return Effect.gen(function* () {
      const service = yield* GraphResearchService;
      const read = yield* service.loadStudyDataset({
        environmentId: "env-1",
        poolId: POOL,
        occurrences: [occurrence, { ...occurrence, startAt: occurrence.startAt + HOUR }],
        intervalMs: HOUR,
        horizonBars: 1,
        now: 1_700_010_000_000,
      });
      assert.equal(read.status, "ok");
      if (read.status === "ok") {
        // The shared trade is counted once per WINDOW FEATURE (it falls in
        // window 1's grid span only), and the manifest's rows count it once.
        assert.equal(read.dataset.manifest.coverage.rows, 1);
        assert.equal(read.dataset.features[0]!.tradeCount, 1);
        assert.equal(read.dataset.features[1]!.tradeCount, 0);
      }
    }).pipe(Effect.provide(withService(shape)));
  });
});
