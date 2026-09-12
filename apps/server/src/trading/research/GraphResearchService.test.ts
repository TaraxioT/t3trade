import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { createHash } from "node:crypto";
import type { ForgeSwapObservation, ForgeWindowFetch } from "@t3tools/trading-contracts";
import { eventStudyReadWindow } from "@t3tools/trading-contracts/eventSets";
import { PersistenceSqlError } from "../../persistence/Errors.ts";
import {
  ForgeGraphSource,
  FORGE_SWAPS_QUERY,
  type ForgeFetchWindowInput,
} from "../forge/GraphSource.ts";
import { ForgeSourceStore, type ForgeEvidenceInsert } from "../forge/ForgeSourceStore.ts";
import {
  GraphResearchService,
  makeGraphResearchService,
  GRAPH_STUDY_MAX_OCCURRENCES,
} from "./GraphResearchService.ts";

const POOL = "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640";
const HOUR = 3_600_000;
const START = 1_699_999_200_000; // Exact UTC-hour boundary.
const input = {
  environmentId: "env-1",
  poolId: POOL,
  market: "ETH",
  entryBasis: "first_closed_bar_after_event" as const,
  occurrences: [{ startAt: START - HOUR, endAt: START + 1_000, source: "test" }],
  intervalMs: HOUR,
  horizonBars: 1,
  now: START + 4 * HOUR,
};
const observation = (timestamp: number): ForgeSwapObservation => ({
  chain: "ethereum-mainnet",
  poolId: POOL,
  observationId: "tx:0",
  transactionHash: `0x${"1".repeat(64)}`,
  logIndex: 0,
  timestamp,
  sender: "0xa",
  recipient: "0xb",
  amount0: "2000000",
  amount1: "-1000",
  sqrtPriceX96: "1",
  tick: 0,
  baseIsToken1: true,
  priceQuotePerBase: { numerator: "2000", denominator: "1" },
  priceQuotePerBaseMicros: 2_000_000_000,
  quoteVolumeRaw: "2000000",
  quoteVolumeMicros: 2_000_000,
});
const fixture = (
  options: {
    configured?: boolean;
    retentionFails?: boolean;
    override?: (fetch: ForgeWindowFetch) => ForgeWindowFetch;
  } = {},
) => {
  const calls: ForgeFetchWindowInput[] = [];
  const retained: ForgeEvidenceInsert[] = [];
  const source = ForgeGraphSource.of({
    settings: Effect.succeed(
      options.configured === false
        ? { configured: false, reason: "source not configured" }
        : {
            configured: true,
            source: {
              kind: "uniswap-v3-graph",
              endpoint: "https://graph.example",
              deployment: "Qmdeploy",
              indexingEndpoint: "https://indexing.example",
              maxLagBlocks: 6,
              pageSize: 100,
              maxSwapsPerFetch: 500,
              pools: [
                {
                  chain: "ethereum-mainnet",
                  poolId: POOL,
                  feeTierHundredthsBps: 500,
                  label: "USDC/WETH",
                  baseIsToken1: true,
                  token0: { address: `0x${"2".repeat(40)}`, symbol: "USDC", decimals: 6 },
                  token1: { address: `0x${"3".repeat(40)}`, symbol: "WETH", decimals: 18 },
                },
              ],
            },
          },
    ),
    probeHealth: Effect.succeed({ status: "healthy", probedAtMs: input.now }),
    fetchWindow: (request) =>
      Effect.sync(() => {
        calls.push(request);
        const fetch: ForgeWindowFetch = {
          poolId: POOL,
          status: "complete",
          historical: true,
          fetchedAtMs: input.now + 100,
          deployment: "Qmdeploy",
          pinnedBlock: 18_500_000,
          pinnedBlockHash: "0xpin",
          window: { startedAt: request.startedAt, endedAt: request.endedAt },
          observations: [observation(request.startedAt + 1)],
          queryCapture: {
            query: FORGE_SWAPS_QUERY,
            variables: [
              {
                pool: POOL,
                first: 100,
                cursor: "",
                block: 18_500_000,
                from: String(request.startedAt - 300),
                to: String(request.endedAt),
              },
            ],
          },
        };
        return options.override?.(fetch) ?? fetch;
      }),
    fetchAllPools: () => Effect.die("not used"),
  });
  const store = ForgeSourceStore.of({
    insert: (capture) =>
      options.retentionFails
        ? Effect.fail(new PersistenceSqlError({ operation: "test.insert" }))
        : Effect.sync(() => {
            retained.push(capture);
          }),
    readRecord: () => Effect.succeed(null),
    readObservations: () => Effect.succeed(null),
    listRecent: () => Effect.succeed([]),
  });
  const layer = Layer.effect(
    GraphResearchService,
    makeGraphResearchService.pipe(
      Effect.provideService(ForgeGraphSource, source),
      Effect.provideService(ForgeSourceStore, store),
    ),
  );
  return { calls, retained, layer };
};

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

describe("Graph research capture integrity", () => {
  it.effect(
    "uses the study end and basis, captures the full exit bar and retains exact provenance",
    () => {
      const fake = fixture();
      return Effect.gen(function* () {
        const service = yield* GraphResearchService;
        for (const entryBasis of [
          "first_closed_bar_after_event",
          "first_bar_open_after_event",
        ] as const) {
          const read = yield* service.loadStudyDataset({ ...input, entryBasis });
          assert.equal(read.status, "ok");
          if (read.status !== "ok") return;
          const bounds = eventStudyReadWindow(input.occurrences, { ...input, entryBasis });
          const call = fake.calls.at(-1)!;
          assert.equal(call.startedAt * 1000, bounds.fromT);
          assert.equal((call.endedAt + 1) * 1000, bounds.toT + HOUR);
          const stored = fake.retained.at(-1)!;
          assert.equal(stored.record.evidenceId, read.dataset.manifest.id);
          assert.deepEqual(stored.observations, read.dataset.observations);
          assert.equal(read.dataset.manifest.contentSha256, hash(stored.observations));
          assert.equal(read.dataset.manifest.variablesSha256, hash(stored.queryCapture!.variables));
          assert.equal(
            read.dataset.manifest.programSha256,
            createHash("sha256").update(stored.queryCapture!.query).digest("hex"),
          );
          assert.equal(read.dataset.manifest.capturedAtMs, input.now + 100);
          assert.equal(read.dataset.quoteDecimals, 6);
          assert.equal(read.dataset.quoteSymbol, "USDC");
        }
      }).pipe(Effect.provide(fake.layer));
    },
  );

  it.effect("captures intervening baseline bars and keeps a healthy empty source sparse", () => {
    const fake = fixture({
      override: (fetch) => ({ ...fetch, status: "empty", observations: [] }),
    });
    return Effect.gen(function* () {
      const service = yield* GraphResearchService;
      const read = yield* service.loadStudyDataset({
        ...input,
        occurrences: [
          input.occurrences[0]!,
          {
            ...input.occurrences[0]!,
            endAt: START + 2 * HOUR + 1_000,
          },
        ],
        now: START + 5 * HOUR,
      });
      assert.equal(read.status, "ok");
      assert.equal(fake.calls.length, 1);
      assert.equal(fake.calls[0]!.startedAt * 1000, START);
      assert.equal((fake.calls[0]!.endedAt + 1) * 1000, START + 4 * HOUR);
      if (read.status === "ok") {
        assert.deepEqual(read.dataset.candles, []);
        assert.equal(read.dataset.manifest.coverage.rows, 0);
        assert.equal(read.dataset.manifest.status, "complete");
      }
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("refuses invalid scope and oversized contiguous baseline before fetching", () => {
    const fake = fixture();
    return Effect.gen(function* () {
      const service = yield* GraphResearchService;
      for (const change of [
        { market: "BTC" },
        { poolId: "0xunknown" },
        { intervalMs: 0 },
        { occurrences: [] },
        {
          occurrences: Array.from(
            { length: GRAPH_STUDY_MAX_OCCURRENCES + 1 },
            () => input.occurrences[0]!,
          ),
        },
        {
          occurrences: [
            input.occurrences[0]!,
            { ...input.occurrences[0]!, endAt: START + 48 * HOUR },
          ],
          now: START + 50 * HOUR,
        },
      ]) {
        assert.equal(
          (yield* service.loadStudyDataset({ ...input, ...change })).status,
          "unavailable",
        );
      }
      assert.equal(fake.calls.length, 0);
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("refuses unhealthy or unretained captures instead of manufacturing a manifest", () => {
    const cases = [
      fixture({ configured: false }),
      fixture({ retentionFails: true }),
      fixture({ override: (fetch) => ({ ...fetch, status: "stale", reason: "lagged" }) }),
      fixture({ override: (fetch) => ({ ...fetch, queryCapture: undefined }) }),
    ];
    return Effect.gen(function* () {
      for (const fake of cases) {
        const read = yield* Effect.gen(function* () {
          return yield* (yield* GraphResearchService).loadStudyDataset(input);
        }).pipe(Effect.provide(fake.layer));
        assert.equal(read.status, "unavailable");
        assert.equal(fake.retained.length, 0);
      }
    });
  });

  it.effect("hashes normalized content rather than identity alone", () => {
    const first = fixture();
    const changed = fixture({
      override: (fetch) => ({
        ...fetch,
        observations: fetch.observations!.map((row) => ({
          ...row,
          amount0: "3000000",
          quoteVolumeRaw: "3000000",
          quoteVolumeMicros: 3_000_000,
        })),
      }),
    });
    return Effect.gen(function* () {
      const read = (layer: typeof first.layer) =>
        Effect.gen(function* () {
          return yield* (yield* GraphResearchService).loadStudyDataset(input);
        }).pipe(Effect.provide(layer));
      const a = yield* read(first.layer);
      const b = yield* read(changed.layer);
      assert.equal(a.status, "ok");
      assert.equal(b.status, "ok");
      if (a.status === "ok" && b.status === "ok") {
        assert.notEqual(a.dataset.manifest.contentSha256, b.dataset.manifest.contentSha256);
        assert.notEqual(a.dataset.manifest.id, b.dataset.manifest.id);
      }
    });
  });
});
