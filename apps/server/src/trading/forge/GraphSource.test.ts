/**
 * What the pinned-block Graph adapter claims, held to its contract.
 *
 * Every Graph response in here is a fixture served by a fake transport —
 * fixtures belong to tests, and the production path has no fixture fallback
 * to accidentally reach. The exactness assertions recompute the expected
 * prices from the Uniswap fixed-point definition, not from the adapter.
 */
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { runMigrations } from "../../persistence/Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import {
  ForgeGraphConfig,
  ForgeGraphSource,
  ForgeGraphSourceLive,
  ForgeGraphTransport,
  ForgeGraphTransportLive,
  FORGE_SWAPS_QUERY,
  redact,
  resolveForgeGraphSettings,
  type ForgeGraphTransportShape,
} from "./GraphSource.ts";
import { FetchHttpClient } from "effect/unstable/http";
import { ForgeSourceStoreLive } from "./ForgeSourceStore.ts";
import { ForgeSourceReads, ForgeSourceReadsLive } from "./ForgeSourceReads.ts";

const ENDPOINT = "https://graph.test/subgraphs/id/testdep";
const API_KEY = "graph-test-secret-3f9a2b";
const DEPLOYMENT = "testdep";

const BASE_ENV: Record<string, string | undefined> = {
  T3_FORGE_GRAPH_ENDPOINT: ENDPOINT,
  T3_FORGE_GRAPH_API_KEY: API_KEY,
  T3_FORGE_GRAPH_DEPLOYMENT: DEPLOYMENT,
  T3_FORGE_MAX_LAG_BLOCKS: "40",
  T3_FORGE_PAGE_SIZE: "2",
  T3_FORGE_MAX_SWAPS: "1000",
};

// ---------------------------------------------------------------------------
// Fixtures: a fake transport that behaves like a graph-node
// ---------------------------------------------------------------------------

interface GraphRow {
  readonly id: string;
  readonly timestamp: number;
  readonly sender: string;
  readonly recipient: string;
  readonly amount0: string;
  readonly amount1: string;
  readonly sqrtPriceX96: string;
  readonly tick: number;
  readonly logIndex: number;
  readonly transaction: { readonly id: string };
}

/** sqrtPriceX96 for exactly 100 USDC per WETH (WETH is token1, 6/18 decimals). */
const SQRT_100 = (100_000n * (1n << 96n)).toString(10);
const TX_A = "0x" + "aa".repeat(32);
const TX_B = "0x" + "bb".repeat(32);
const POOL_005 = "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640";
const POOL_030 = "0x8ad599c3a0ff1de082011efddc58f1908eb6e6d8";
const BLOCK_HASH = "0x" + "cd".repeat(32);

const row = (input: {
  readonly tx: string;
  readonly log: number;
  readonly timestamp: number;
  readonly amount0?: string;
  readonly amount1?: string;
  readonly sqrtPriceX96?: string;
}): GraphRow => ({
  id: `${input.tx}-${input.log}`,
  timestamp: input.timestamp,
  sender: "0x" + "11".repeat(20),
  recipient: "0x" + "22".repeat(20),
  amount0: input.amount0 ?? "-2.5",
  amount1: input.amount1 ?? "1.3",
  sqrtPriceX96: input.sqrtPriceX96 ?? SQRT_100,
  tick: -196204,
  logIndex: input.log,
  transaction: { id: input.tx },
});

const swapsPage = (
  block: number,
  swaps: ReadonlyArray<GraphRow>,
  hash: string = BLOCK_HASH,
): unknown => ({
  data: {
    swaps,
    _meta: { deployment: DEPLOYMENT, block: { number: block, hash } },
  },
});

const indexingOk = (latest: number, head: number): unknown => ({
  data: {
    indexingStatuses: [
      {
        subgraph: DEPLOYMENT,
        health: "healthy",
        fatalError: null,
        chains: [{ latestBlock: { number: latest }, chainHeadBlock: { number: head } }],
      },
    ],
  },
});

interface RecordedCall {
  readonly url: string;
  readonly body: { readonly query: string; readonly variables: Record<string, unknown> };
  readonly apiKey: string;
}

/**
 * A fake graph-node: filters swaps by pool and timestamp like the real
 * `where` clause, paginates by `id_gt`, echoes the pinned block in `_meta`.
 */
interface FakeGraphOptions {
  /** All swaps available, in id order; the fake filters per request. */
  readonly rows: ReadonlyArray<GraphRow>;
  readonly pool?: string;
  readonly latestBlock?: number;
  readonly chainHeadBlock?: number;
  /** Override any page (index 0-based) to inject reorgs or malformed rows. */
  readonly pageOverrides?: Readonly<Record<number, unknown>>;
  readonly failIndexing?: boolean;
  readonly health?: string;
}

const makeFakeGraph = (options: FakeGraphOptions) => {
  const calls: Array<RecordedCall> = [];
  const latestBlock = options.latestBlock ?? 22_000_000;
  const chainHeadBlock = options.chainHeadBlock ?? latestBlock + 2;
  const shape: ForgeGraphTransportShape = {
    post: ({ url, body, apiKey }) =>
      Effect.sync(() => {
        const parsed = body as { query: string; variables: Record<string, unknown> };
        calls.push({ url, body: parsed, apiKey });
        if (parsed.query.includes("indexingStatuses")) {
          if (options.failIndexing === true) return { kind: "fail" } as const;
          return { kind: "indexing" } as const;
        }
        if (parsed.query.includes("swaps")) {
          return { kind: "swaps", parsed } as const;
        }
        return { kind: "meta" } as const;
      }).pipe(
        Effect.flatMap((routed) => {
          if (routed.kind === "fail") return Effect.fail("indexing endpoint down");
          if (routed.kind === "meta") {
            return Effect.succeed({
              status: 200,
              body: swapsPage(options.latestBlock ?? 22_000_000, []),
            });
          }
          if (routed.kind === "indexing") {
            return Effect.succeed({
              status: 200,
              body:
                options.health === undefined
                  ? indexingOk(latestBlock, chainHeadBlock)
                  : {
                      data: {
                        indexingStatuses: [
                          {
                            subgraph: DEPLOYMENT,
                            health: options.health,
                            fatalError: { message: "subgraph failed to sync" },
                            chains: [
                              {
                                latestBlock: { number: latestBlock },
                                chainHeadBlock: { number: chainHeadBlock },
                              },
                            ],
                          },
                        ],
                      },
                    },
            });
          }
          const vars = routed.parsed.variables ?? {};
          const pool = typeof vars.pool === "string" ? vars.pool : "";
          const cursor = typeof vars.cursor === "string" ? vars.cursor : "";
          const from = Number(vars.from);
          const to = Number(vars.to);
          const first = typeof vars.first === "number" ? vars.first : 1000;
          const pageNumber =
            calls.filter(
              (call) => call.body.query.includes("swaps") && call.body.variables?.pool === pool,
            ).length - 1;
          const override = options.pageOverrides?.[pageNumber];
          if (override !== undefined) {
            return Effect.succeed({ status: 200, body: override });
          }
          const filtered = options.rows
            .filter(
              (entry) =>
                (options.pool === undefined || options.pool === pool) &&
                entry.id > cursor &&
                entry.timestamp >= from &&
                entry.timestamp <= to,
            )
            .sort((a, b) => (a.id < b.id ? -1 : 1))
            .slice(0, first);
          return Effect.succeed({
            status: 200,
            body: swapsPage(typeof vars.block === "number" ? vars.block : latestBlock, filtered),
          });
        }),
      ),
  };
  return { shape, calls };
};

/** A transport that fails every request. */
const deadTransport: ForgeGraphTransportShape = {
  post: () => Effect.fail("network unreachable"),
};

/** Serialize a value for leak assertions. */
const serializedText = (value: unknown): string => JSON.stringify(value);

const configLayer = (env: Record<string, string | undefined>) =>
  Layer.succeed(
    ForgeGraphConfig,
    ForgeGraphConfig.of({ resolve: Effect.sync(() => resolveForgeGraphSettings(env)) }),
  );

const sourceLayer = (transport: ForgeGraphTransportShape, env = BASE_ENV) =>
  ForgeGraphSourceLive.pipe(
    Layer.provide(configLayer(env)),
    Layer.provide(Layer.succeed(ForgeGraphTransport, ForgeGraphTransport.of(transport))),
  );

const fullLayer = (transport: ForgeGraphTransportShape, env = BASE_ENV) =>
  ForgeSourceReadsLive.pipe(
    Layer.provideMerge(sourceLayer(transport, env)),
    Layer.provideMerge(ForgeSourceStoreLive),
    Layer.provideMerge(NodeSqliteClient.layerMemory()),
  );

const WINDOW = { startedAt: 1_775_700_000, endedAt: 1_775_700_600 };
const inWindowRow = (log: number, timestamp = WINDOW.startedAt + 60) =>
  row({ tx: TX_A, log, timestamp });

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

describe("resolveForgeGraphSettings", () => {
  it("is unconfigured with the missing variables named", () => {
    const settings = resolveForgeGraphSettings({});
    assert.equal(settings.configured, false);
    assert.include(settings.reason ?? "", "T3_FORGE_GRAPH_ENDPOINT");
    assert.include(settings.reason ?? "", "T3_FORGE_GRAPH_API_KEY");
    assert.include(settings.reason ?? "", "T3_FORGE_GRAPH_DEPLOYMENT");
  });

  it("refuses pool addresses without vetted metadata", () => {
    const settings = resolveForgeGraphSettings({
      ...BASE_ENV,
      T3_FORGE_POOLS: "0x000000000000000000000000000000000000dead",
    });
    assert.equal(settings.configured, false);
    assert.include(settings.reason ?? "", "without vetted metadata");
  });

  it("narrows to the requested approved subset", () => {
    const settings = resolveForgeGraphSettings({
      ...BASE_ENV,
      T3_FORGE_POOLS: POOL_030,
    });
    assert.equal(settings.configured, true);
    assert.equal(settings.source?.pools.length, 1);
    assert.equal(settings.source?.pools[0]?.poolId, POOL_030);
  });

  it("keeps the API key out of the source config", () => {
    const settings = resolveForgeGraphSettings(BASE_ENV);
    assert.equal(settings.configured, true);
    assert.equal(settings.apiKey, API_KEY);
    // The config itself (what anything might log) carries no key.
    assert.ok(!JSON.stringify(settings.source).includes(API_KEY));
  });
});

// ---------------------------------------------------------------------------
// fetchWindow
// ---------------------------------------------------------------------------

it.effect("serves a complete window with exact normalization", () =>
  Effect.gen(function* () {
    const fake = makeFakeGraph({
      rows: [
        row({ tx: TX_A, log: 1, timestamp: WINDOW.startedAt - 200 }),
        row({ tx: TX_A, log: 2, timestamp: WINDOW.startedAt + 10 }),
        row({ tx: TX_B, log: 5, timestamp: WINDOW.startedAt + 100, amount0: "1.25" }),
      ],
      pool: POOL_005,
    });
    const source = yield* ForgeGraphSource.pipe(Effect.provide(sourceLayer(fake.shape)));
    const fetch = yield* source.fetchWindow({ poolId: POOL_005, ...WINDOW });

    assert.equal(fetch.status, "complete");
    assert.equal(fetch.pinnedBlock, 22_000_000);
    assert.equal(fetch.pinnedBlockHash, BLOCK_HASH);
    assert.equal(fetch.observations?.length, 2);
    const [first, second] = fetch.observations ?? [];
    // Exactly 100 USDC per WETH from the fixture sqrt, 2.5 USDC quote leg.
    assert.equal(first?.priceQuotePerBaseMicros, 100_000_000);
    assert.equal(first?.priceQuotePerBase?.numerator, "100");
    assert.equal(first?.priceQuotePerBase?.denominator, "1");
    assert.equal(first?.quoteVolumeMicros, 2_500_000);
    assert.equal(first?.quoteVolumeRaw, "2500000");
    assert.equal(first?.observationId, `${TX_A}:2`);
    assert.equal(second?.quoteVolumeMicros, 1_250_000);
    // The pre-window swap is an anchor candidate, not a point.
    assert.equal(fetch.anchorCoverage, "covered");
    assert.equal(fetch.anchorCandidates?.length, 1);
    assert.equal(fetch.anchorCandidates?.[0]?.ageBeforeWindowSeconds, 200);
    assert.equal(fetch.anchorCandidates?.[0]?.observation.observationId, `${TX_A}:1`);
    assert.ok(fetch.sourceDigest && fetch.sourceDigest.length === 64);
  }),
);

it.effect("paginates with an id_gt cursor until the short page, pinned to one block", () =>
  Effect.gen(function* () {
    const rows = Array.from({ length: 5 }, (_, index) =>
      row({ tx: TX_A, log: index + 1, timestamp: WINDOW.startedAt + index }),
    );
    const fake = makeFakeGraph({ rows, pool: POOL_005 });
    const source = yield* ForgeGraphSource.pipe(Effect.provide(sourceLayer(fake.shape)));

    const fetch = yield* source.fetchWindow({ poolId: POOL_005, ...WINDOW });

    assert.equal(fetch.status, "complete");
    assert.equal(fetch.observations?.length, 5);
    // pageSize 2: pages [1,2], [3,4], [5] — three swaps pages plus the probe.
    const swapsCalls = fake.calls.filter((call) => !call.body.query.includes("indexingStatuses"));
    assert.equal(swapsCalls.length, 3);
    assert.equal(swapsCalls[0]?.body.variables.cursor, "");
    assert.equal(swapsCalls[1]?.body.variables.cursor, `${TX_A}-2`);
    assert.equal(swapsCalls[2]?.body.variables.cursor, `${TX_A}-4`);
    // One pin across every page.
    for (const call of swapsCalls) {
      assert.equal(call.body.variables.block, 22_000_000);
    }
    // The window query is bounded to the anchor buffer on the low side.
    assert.equal(swapsCalls[0]?.body.variables.from, String(WINDOW.startedAt - 300));
    assert.equal(swapsCalls[0]?.body.variables.to, String(WINDOW.endedAt));
    assert.deepEqual(fetch.queryCapture, {
      query: swapsCalls[0]!.body.query,
      // The fake transport records variables as untyped JSON; the capture
      // types them, so the assertion compares values through that lens.
      variables: swapsCalls.map((call) => call.body.variables) as unknown as NonNullable<
        typeof fetch.queryCapture
      >["variables"],
    });
  }),
);

it.effect("sorts by log index within equal timestamps, not by id string", () =>
  Effect.gen(function* () {
    const fake = makeFakeGraph({
      // Log 10 sorts before log 2 as a string; the adapter must not keep it.
      rows: [
        row({ tx: TX_A, log: 10, timestamp: WINDOW.startedAt + 5 }),
        row({ tx: TX_A, log: 2, timestamp: WINDOW.startedAt + 5 }),
      ],
      pool: POOL_005,
    });
    const source = yield* ForgeGraphSource.pipe(Effect.provide(sourceLayer(fake.shape)));
    const fetch = yield* source.fetchWindow({ poolId: POOL_005, ...WINDOW });
    assert.equal(fetch.status, "complete");
    assert.deepEqual(
      (fetch.observations ?? []).map((observation) => observation.logIndex),
      [2, 10],
    );
  }),
);

it.effect("drops duplicate (transaction, log) rows across pages", () =>
  Effect.gen(function* () {
    const duplicate = row({ tx: TX_A, log: 7, timestamp: WINDOW.startedAt + 1 });
    const fake = makeFakeGraph({
      rows: [
        duplicate,
        row({ tx: TX_B, log: 1, timestamp: WINDOW.startedAt + 2 }),
        row({ tx: TX_B, log: 2, timestamp: WINDOW.startedAt + 3 }),
        // The same swap served again on a later page.
        duplicate,
        row({ tx: TX_B, log: 3, timestamp: WINDOW.startedAt + 4 }),
      ],
      pool: POOL_005,
    });
    const source = yield* ForgeGraphSource.pipe(Effect.provide(sourceLayer(fake.shape)));
    const fetch = yield* source.fetchWindow({ poolId: POOL_005, ...WINDOW });

    assert.equal(fetch.status, "complete");
    assert.equal(fetch.observations?.length, 4);
    assert.equal(fetch.duplicatesDropped, 1);
    const ids = new Set((fetch.observations ?? []).map((observation) => observation.observationId));
    assert.equal(ids.size, 4);
  }),
);

it.effect("reports an honestly empty window, never zeroed", () =>
  Effect.gen(function* () {
    const fake = makeFakeGraph({ rows: [], pool: POOL_005 });
    const source = yield* ForgeGraphSource.pipe(Effect.provide(sourceLayer(fake.shape)));
    const fetch = yield* source.fetchWindow({ poolId: POOL_005, ...WINDOW });

    assert.equal(fetch.status, "empty");
    assert.deepEqual(fetch.observations, []);
    assert.equal(fetch.anchorCoverage, "missing");
    assert.deepEqual(fetch.anchorCandidates, []);
    assert.equal(fetch.pinnedBlock, 22_000_000);
    assert.ok(fetch.sourceDigest);
  }),
);

it.effect("marks the indexed head stale past the configured lag", () =>
  Effect.gen(function* () {
    const fake = makeFakeGraph({
      rows: [inWindowRow(1)],
      pool: POOL_005,
      latestBlock: 22_000_000,
      chainHeadBlock: 22_000_000 + 120,
    });
    const source = yield* ForgeGraphSource.pipe(Effect.provide(sourceLayer(fake.shape)));
    const fetch = yield* source.fetchWindow({ poolId: POOL_005, ...WINDOW });

    assert.equal(fetch.status, "stale");
    assert.include(fetch.reason ?? "", "120 blocks");
    assert.equal(fetch.lagBlocks, 120);
    // Stale data is served, labeled — never hidden.
    assert.equal(fetch.observations?.length, 1);
  }),
);

it.effect("marks freshness unverifiable when the indexing probe fails", () =>
  Effect.gen(function* () {
    const fake = makeFakeGraph({ rows: [inWindowRow(1)], pool: POOL_005, failIndexing: true });
    const source = yield* ForgeGraphSource.pipe(Effect.provide(sourceLayer(fake.shape)));
    const fetch = yield* source.fetchWindow({ poolId: POOL_005, ...WINDOW });

    assert.equal(fetch.status, "stale");
    assert.include(fetch.reason ?? "", "freshness unverifiable");
  }),
);

it.effect("refuses an unhealthy subgraph outright", () =>
  Effect.gen(function* () {
    const fake = makeFakeGraph({ rows: [inWindowRow(1)], pool: POOL_005, health: "failed" });
    const source = yield* ForgeGraphSource.pipe(Effect.provide(sourceLayer(fake.shape)));
    const fetch = yield* source.fetchWindow({ poolId: POOL_005, ...WINDOW });

    assert.equal(fetch.status, "unavailable");
    assert.include(fetch.reason ?? "", "health 'failed'");
  }),
);

it.effect("makes every transport failure a named unavailable state", () =>
  Effect.gen(function* () {
    const source = yield* ForgeGraphSource.pipe(Effect.provide(sourceLayer(deadTransport)));
    const fetch = yield* source.fetchWindow({ poolId: POOL_005, ...WINDOW });
    assert.equal(fetch.status, "unavailable");
    // No probe, no meta: nothing to pin to, and the reason says so.
    assert.include(fetch.reason ?? "", "could not resolve a block to pin");
    assert.isUndefined(fetch.observations);
  }),
);

it.effect("never serves a page that broke the pinned block", () =>
  Effect.gen(function* () {
    const fake = makeFakeGraph({
      rows: [
        row({ tx: TX_A, log: 1, timestamp: WINDOW.startedAt + 1 }),
        row({ tx: TX_A, log: 2, timestamp: WINDOW.startedAt + 2 }),
        row({ tx: TX_A, log: 3, timestamp: WINDOW.startedAt + 3 }),
      ],
      pool: POOL_005,
      // Page two claims the indexer moved on.
      pageOverrides: { 1: swapsPage(22_000_001, []) },
    });
    const source = yield* ForgeGraphSource.pipe(Effect.provide(sourceLayer(fake.shape)));
    const fetch = yield* source.fetchWindow({ poolId: POOL_005, ...WINDOW });

    assert.equal(fetch.status, "unavailable");
    assert.include(fetch.reason ?? "", "pinned to 22000000");
    assert.isUndefined(fetch.observations);
  }),
);

it.effect("never serves a page with a different block hash under the same pin", () =>
  Effect.gen(function* () {
    const fake = makeFakeGraph({
      rows: [
        row({ tx: TX_A, log: 1, timestamp: WINDOW.startedAt + 1 }),
        row({ tx: TX_A, log: 2, timestamp: WINDOW.startedAt + 2 }),
        row({ tx: TX_A, log: 3, timestamp: WINDOW.startedAt + 3 }),
      ],
      pool: POOL_005,
      pageOverrides: { 1: swapsPage(22_000_000, [], "0x" + "ee".repeat(32)) },
    });
    const source = yield* ForgeGraphSource.pipe(Effect.provide(sourceLayer(fake.shape)));
    const fetch = yield* source.fetchWindow({ poolId: POOL_005, ...WINDOW });

    assert.equal(fetch.status, "unavailable");
    assert.include(fetch.reason ?? "", "hash changed");
  }),
);

it.effect("refuses a window that exceeds the swap budget instead of truncating", () =>
  Effect.gen(function* () {
    const rows = Array.from({ length: 8 }, (_, index) =>
      row({ tx: TX_A, log: index + 1, timestamp: WINDOW.startedAt + index }),
    );
    const fake = makeFakeGraph({ rows, pool: POOL_005 });
    const source = yield* ForgeGraphSource.pipe(
      Effect.provide(sourceLayer(fake.shape, { ...BASE_ENV, T3_FORGE_MAX_SWAPS: "3" })),
    );
    const fetch = yield* source.fetchWindow({ poolId: POOL_005, ...WINDOW });

    assert.equal(fetch.status, "unavailable");
    assert.include(fetch.reason ?? "", "swap budget");
  }),
);

it.effect("refuses windows over 24h and unapproved pools", () =>
  Effect.gen(function* () {
    const fake = makeFakeGraph({ rows: [], pool: POOL_005 });
    const source = yield* ForgeGraphSource.pipe(Effect.provide(sourceLayer(fake.shape)));
    const tooLong = yield* source.fetchWindow({
      poolId: POOL_005,
      startedAt: WINDOW.startedAt,
      endedAt: WINDOW.startedAt + 24 * 60 * 60 + 1,
    });
    assert.equal(tooLong.status, "unavailable");
    assert.include(tooLong.reason ?? "", "24h");

    const unapproved = yield* source.fetchWindow({
      poolId: "0x000000000000000000000000000000000000dead",
      ...WINDOW,
    });
    assert.equal(unapproved.status, "unavailable");
    assert.include(unapproved.reason ?? "", "approved forge pool list");
  }),
);

it.effect("names the missing configuration instead of inventing a source", () =>
  Effect.gen(function* () {
    const fake = makeFakeGraph({ rows: [], pool: POOL_005 });
    const source = yield* ForgeGraphSource.pipe(
      Effect.provide(sourceLayer(fake.shape, { ...BASE_ENV, T3_FORGE_GRAPH_API_KEY: undefined })),
    );
    const fetch = yield* source.fetchWindow({ poolId: POOL_005, ...WINDOW });

    assert.equal(fetch.status, "unavailable");
    assert.include(fetch.reason ?? "", "T3_FORGE_GRAPH_API_KEY");
    // Nothing was asked of the network.
    assert.equal(fake.calls.length, 0);
  }),
);

it.effect("keeps anchor candidates within the five-minute pre-window buffer", () =>
  Effect.gen(function* () {
    const fake = makeFakeGraph({
      rows: [
        // Just outside the buffer: the server filters it via timestamp_gte.
        row({ tx: TX_A, log: 1, timestamp: WINDOW.startedAt - 301 }),
        row({ tx: TX_A, log: 2, timestamp: WINDOW.startedAt - 300 }),
        row({ tx: TX_A, log: 3, timestamp: WINDOW.startedAt - 1 }),
        row({ tx: TX_B, log: 4, timestamp: WINDOW.startedAt }),
      ],
      pool: POOL_005,
    });
    const source = yield* ForgeGraphSource.pipe(Effect.provide(sourceLayer(fake.shape)));
    const fetch = yield* source.fetchWindow({ poolId: POOL_005, ...WINDOW });

    const candidates = fetch.anchorCandidates ?? [];
    assert.equal(candidates.length, 2);
    for (const candidate of candidates) {
      assert.ok(candidate.ageBeforeWindowSeconds <= 300);
    }
    assert.equal(candidates[0]?.ageBeforeWindowSeconds, 300);
    assert.equal(candidates[1]?.ageBeforeWindowSeconds, 1);
    // The swap at window start is a point, not a candidate.
    assert.equal(fetch.observations?.length, 1);
  }),
);

it.effect("redacts the API key from every error reason and keeps it off the URL", () =>
  Effect.gen(function* () {
    // A graphql error whose message echoes the key: the reason must not.
    const leaky: ForgeGraphTransportShape = {
      post: ({ body }) =>
        Effect.succeed({
          status: 200,
          body: (body as { query: string }).query.includes("indexingStatuses")
            ? indexingOk(22_000_000, 22_000_002)
            : { errors: [{ message: `unauthorized for key ${API_KEY}` }] },
        }),
    };
    const source = yield* ForgeGraphSource.pipe(Effect.provide(sourceLayer(leaky)));
    const fetch = yield* source.fetchWindow({ poolId: POOL_005, ...WINDOW });

    assert.equal(fetch.status, "unavailable");
    assert.ok(!serializedText(fetch).includes(API_KEY));
    assert.include(fetch.reason ?? "", "[redacted]");
    assert.equal(redact(`key ${API_KEY} leaked`, API_KEY), "key [redacted] leaked");
  }),
);

it.effect("pinches one block across every pool in fetchAllPools", () =>
  Effect.gen(function* () {
    const fake = makeFakeGraph({
      rows: [
        row({ tx: TX_A, log: 1, timestamp: WINDOW.startedAt + 1 }),
        row({ tx: TX_B, log: 2, timestamp: WINDOW.startedAt + 2 }),
      ],
      pool: POOL_005,
    });
    const source = yield* ForgeGraphSource.pipe(Effect.provide(sourceLayer(fake.shape)));
    const result = yield* source.fetchAllPools({ ...WINDOW });

    assert.equal(result.pinnedBlock, 22_000_000);
    assert.equal(result.fetches.length, 3);
    for (const fetch of result.fetches) {
      assert.equal(fetch.pinnedBlock, 22_000_000);
      // Only the 0.05% pool has fixture swaps; the others are honestly empty.
      assert.equal(fetch.status, fetch.poolId === POOL_005 ? "complete" : "empty");
    }
    const withObservations = result.fetches.filter(
      (fetch) => (fetch.observations ?? []).length > 0,
    );
    assert.equal(withObservations.length, 1);
    assert.equal(withObservations[0]?.poolId, POOL_005);
  }),
);

/** A structurally validated variant of the pinned query, byte-different. */
const BUNDLE_QUERY = `query BundleSwaps($pool: String!, $first: Int!, $cursor: ID!, $block: Int!, $from: BigInt!, $to: BigInt!) {
  swaps(first: $first, where: { pool: $pool, id_gt: $cursor, timestamp_gte: $from, timestamp_lte: $to }, block: { number: $block }, orderBy: id, orderDirection: asc) {
    id timestamp sender recipient amount0 amount1 sqrtPriceX96 tick logIndex transaction { id }
  }
  _meta(block: { number: $block }) { deployment block { number hash } }
}`;

it.effect("sends a provided validated query verbatim on every page of every pool", () =>
  Effect.gen(function* () {
    const fake = makeFakeGraph({
      rows: [
        row({ tx: TX_A, log: 1, timestamp: WINDOW.startedAt + 1 }),
        row({ tx: TX_B, log: 2, timestamp: WINDOW.startedAt + 2 }),
      ],
      pool: POOL_005,
    });
    const source = yield* ForgeGraphSource.pipe(Effect.provide(sourceLayer(fake.shape)));
    const result = yield* source.fetchAllPools({ ...WINDOW, query: BUNDLE_QUERY });

    assert.equal(result.pinnedBlock, 22_000_000);
    const swapsCalls = fake.calls.filter((call) => call.body.query.includes("swaps"));
    assert.isTrue(swapsCalls.length >= 3);
    for (const call of swapsCalls) {
      assert.equal(call.body.query, BUNDLE_QUERY);
    }
    // The operational probes stay host-owned regardless.
    for (const call of fake.calls.filter((call) => !call.body.query.includes("swaps"))) {
      assert.notEqual(call.body.query, BUNDLE_QUERY);
    }
  }),
);

it.effect("defaults to the pinned host query when none is provided", () =>
  Effect.gen(function* () {
    const fake = makeFakeGraph({ rows: [], pool: POOL_005 });
    const source = yield* ForgeGraphSource.pipe(Effect.provide(sourceLayer(fake.shape)));
    yield* source.fetchAllPools({ ...WINDOW });
    const swapsCalls = fake.calls.filter((call) => call.body.query.includes("swaps"));
    assert.isTrue(swapsCalls.length > 0);
    for (const call of swapsCalls) assert.equal(call.body.query, FORGE_SWAPS_QUERY);
  }),
);

// ---------------------------------------------------------------------------
// The real transport: credentials as a header, never a URL
// ---------------------------------------------------------------------------

it("sends the API key as a bearer header and keeps the URL clean", async () => {
  const originalFetch = globalThis.fetch;
  const seen: { value?: { url: string; headers: Record<string, string> } } = {};
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    seen.value = {
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    return new Response(
      JSON.stringify({ data: { _meta: { deployment: DEPLOYMENT, block: { number: 1 } } } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const transport = yield* ForgeGraphTransport;
        const response = yield* transport.post({
          url: ENDPOINT,
          body: { query: "{ _meta { deployment } }" },
          apiKey: API_KEY,
        });
        assert.equal(response.status, 200);
      }).pipe(
        Effect.scoped,
        Effect.provide(ForgeGraphTransportLive.pipe(Layer.provide(FetchHttpClient.layer))),
      ),
    );
    assert.ok(seen.value);
    assert.equal(seen.value.url, ENDPOINT);
    assert.ok(!seen.value.url.includes(API_KEY));
    assert.equal(seen.value.headers.authorization, `Bearer ${API_KEY}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// Read models (store + reads, over the in-memory SQLite with migrations)
// ---------------------------------------------------------------------------

const readsLayer = (transport: ForgeGraphTransportShape, env = BASE_ENV) =>
  fullLayer(transport, env);

const captureFake = makeFakeGraph({
  rows: [
    row({ tx: TX_A, log: 1, timestamp: WINDOW.startedAt - 100 }),
    row({ tx: TX_A, log: 2, timestamp: WINDOW.startedAt + 60 }),
    row({ tx: TX_B, log: 3, timestamp: WINDOW.startedAt + 120 }),
  ],
});
it.effect("captures one historical window across pools, labeled and queryable by id", () =>
  Effect.gen(function* () {
    yield* runMigrations({});
    const reads = yield* ForgeSourceReads;

    const capture = yield* reads.captureHistoricalWindow({
      environmentId: "env_test",
      startedAt: WINDOW.startedAt,
      endedAt: WINDOW.endedAt,
    });
    assert.equal(capture.status, "ok");
    if (capture.status !== "ok") return;
    assert.equal(capture.capture.pinnedBlock, 22_000_000);
    assert.equal(capture.capture.window.startedAt, WINDOW.startedAt);
    assert.equal(capture.capture.pools.length, 3);

    // Evidence reads back by id, labeled historical, with its observations.
    const evidenceId = capture.capture.pools[0]!.evidenceId;
    const evidence = yield* reads.readEvidence(evidenceId);
    assert.isNotNull(evidence);
    assert.equal(evidence!.record.historical, true);
    assert.equal(evidence!.record.pinnedBlock, 22_000_000);
    assert.equal(evidence!.record.windowStart, WINDOW.startedAt);
    assert.ok(!evidence!.record.endpoint.includes(API_KEY));
    assert.equal(evidence!.observations.length, evidence!.claimedCount);

    // A retried capture of the same window is idempotent, not a fork.
    const again = yield* reads.captureHistoricalWindow({
      environmentId: "env_test",
      startedAt: WINDOW.startedAt,
      endedAt: WINDOW.endedAt,
    });
    assert.equal(again.status, "ok");
    if (again.status === "ok") {
      assert.equal(again.capture.pools[0]!.evidenceId, capture.capture.pools[0]!.evidenceId);
    }
  }).pipe(Effect.provide(readsLayer(captureFake.shape))),
);
const refuseFake = makeFakeGraph({ rows: [] });
it.effect("refuses a historical window beyond the 24h bound", () =>
  Effect.gen(function* () {
    yield* runMigrations({});
    const reads = yield* ForgeSourceReads;
    const capture = yield* reads.captureHistoricalWindow({
      environmentId: "env_test",
      startedAt: WINDOW.startedAt,
      endedAt: WINDOW.startedAt + 24 * 60 * 60 + 1,
    });
    assert.equal(capture.status, "unavailable");
    assert.include(capture.status === "unavailable" ? capture.reason : "", "24h");
  }).pipe(Effect.provide(readsLayer(refuseFake.shape))),
);
const seriesFake = makeFakeGraph({
  rows: [
    row({ tx: TX_A, log: 1, timestamp: WINDOW.startedAt - 60 }),
    row({ tx: TX_A, log: 2, timestamp: WINDOW.startedAt + 10 }),
    row({ tx: TX_A, log: 3, timestamp: WINDOW.startedAt + 400 }),
    row({ tx: TX_B, log: 4, timestamp: WINDOW.startedAt + 500 }),
  ],
  pool: POOL_005,
});
it.effect("serves a bounded series with domain, anchors, gaps, and provenance", () =>
  Effect.gen(function* () {
    yield* runMigrations({});
    const reads = yield* ForgeSourceReads;
    const read = yield* reads.readPoolSeries({
      poolId: POOL_005,
      startUtcMs: WINDOW.startedAt * 1000,
      endUtcMs: WINDOW.endedAt * 1000,
      maxPoints: 720,
    });
    assert.equal(read.status, "ok");
    if (read.status !== "ok") return;
    const series = read.series;
    assert.equal(series.poolId, POOL_005);
    assert.deepEqual(series.domainUtcMs, {
      start: WINDOW.startedAt * 1000,
      end: WINDOW.endedAt * 1000,
    });
    assert.equal(series.points.length, 3);
    assert.equal(series.anchor.status, "covered");
    assert.equal(series.anchor.ageBeforeWindowSeconds, 60);
    assert.equal(series.anchorCandidates.length, 1);
    assert.equal(series.provenance.pinnedBlock, 22_000_000);
    assert.ok(series.provenance.sourceDigest);
    // Swaps at +10s then silence until +400s: one gap inside the domain.
    assert.equal(series.gaps.length, 1);
    assert.equal(series.gaps[0]?.fromUtcMs, (WINDOW.startedAt + 10) * 1000);
    assert.equal(series.gaps[0]?.toUtcMs, (WINDOW.startedAt + 400) * 1000);
    assert.equal(series.health.status, "healthy");
  }).pipe(Effect.provide(readsLayer(seriesFake.shape))),
);
const capFake = makeFakeGraph({
  rows: Array.from({ length: 5 }, (_, index) =>
    row({ tx: TX_A, log: index + 1, timestamp: WINDOW.startedAt + index }),
  ),
  pool: POOL_005,
});
it.effect("caps series points to maxPoints keeping the newest", () =>
  Effect.gen(function* () {
    yield* runMigrations({});
    const reads = yield* ForgeSourceReads;
    const read = yield* reads.readPoolSeries({
      poolId: POOL_005,
      startUtcMs: WINDOW.startedAt * 1000,
      endUtcMs: WINDOW.endedAt * 1000,
      maxPoints: 3,
    });
    assert.equal(read.status, "ok");
    if (read.status !== "ok") return;
    assert.equal(read.series.maxPoints, 3);
    assert.deepEqual(
      read.series.points.map((point) => point.observationId),
      [`${TX_A}:3`, `${TX_A}:4`, `${TX_A}:5`],
    );
  }).pipe(Effect.provide(readsLayer(capFake.shape))),
);

it.effect("answers unavailable, not zeros, when the source is down", () =>
  Effect.gen(function* () {
    yield* runMigrations({});
    const reads = yield* ForgeSourceReads;
    const read = yield* reads.readPoolSeries({
      poolId: POOL_005,
      startUtcMs: WINDOW.startedAt * 1000,
      endUtcMs: WINDOW.endedAt * 1000,
    });
    assert.equal(read.status, "unavailable");
    if (read.status !== "unavailable") return;
    assert.include(read.reason, "could not resolve a block to pin");
  }).pipe(Effect.provide(readsLayer(deadTransport))),
);

const staleFake = makeFakeGraph({
  rows: [inWindowRow(1)],
  pool: POOL_005,
  chainHeadBlock: 22_000_000 + 120,
});
it.effect("labels a lagging source stale on the series health", () =>
  Effect.gen(function* () {
    yield* runMigrations({});
    const reads = yield* ForgeSourceReads;
    const read = yield* reads.readPoolSeries({
      poolId: POOL_005,
      startUtcMs: WINDOW.startedAt * 1000,
      endUtcMs: WINDOW.endedAt * 1000,
    });
    assert.equal(read.status, "ok");
    if (read.status !== "ok") return;
    assert.equal(read.series.health.status, "stale");
    assert.include(read.series.health.reason ?? "", "120 blocks");
  }).pipe(Effect.provide(readsLayer(staleFake.shape))),
);
const listingFake = makeFakeGraph({ rows: [] });
it.effect("discovers sources without any Hyperliquid market row", () =>
  Effect.gen(function* () {
    yield* runMigrations({});
    const reads = yield* ForgeSourceReads;
    const listing = yield* reads.listSources;

    assert.equal(listing.status, "ok");
    if (listing.status !== "ok") return;
    assert.equal(listing.listing.pools.length, 3);
    assert.equal(listing.listing.health.status, "healthy");
    for (const pool of listing.listing.pools) {
      assert.equal(pool.quoteUnits, "USDC-per-WETH");
    }
    // No Hyperliquid notion appears anywhere in the listing.
    assert.ok(!serializedText(listing).toLowerCase().includes("hyperliquid"));
  }).pipe(Effect.provide(readsLayer(listingFake.shape))),
);

const unconfiguredFake = makeFakeGraph({ rows: [] });
it.effect("names the unconfigured state on discovery too", () =>
  Effect.gen(function* () {
    yield* runMigrations({});
    const reads = yield* ForgeSourceReads;
    const listing = yield* reads.listSources;
    assert.equal(listing.status, "unavailable");
    if (listing.status !== "unavailable") return;
    assert.include(listing.reason, "T3_FORGE_GRAPH_ENDPOINT");
  }).pipe(
    Effect.provide(
      readsLayer(unconfiguredFake.shape, { ...BASE_ENV, T3_FORGE_GRAPH_ENDPOINT: undefined }),
    ),
  ),
);

it.effect("decodes Graph BigInt strings and decimal token amounts", () =>
  Effect.gen(function* () {
    const swap = row({
      tx: TX_A,
      log: 1,
      timestamp: WINDOW.startedAt + 1,
      amount0: "-2.500001",
      amount1: "1.300000000000000001",
    });
    const fake = makeFakeGraph({
      rows: [],
      pageOverrides: {
        0: {
          data: {
            swaps: [{ ...swap, timestamp: String(swap.timestamp), logIndex: "1", tick: "-196204" }],
            _meta: { deployment: DEPLOYMENT, block: { number: 22_000_000, hash: BLOCK_HASH } },
          },
        },
      },
    });
    const source = yield* ForgeGraphSource.pipe(Effect.provide(sourceLayer(fake.shape)));
    const fetch = yield* source.fetchWindow({ poolId: POOL_005, ...WINDOW });
    assert.equal(fetch.status, "complete");
    assert.equal(fetch.observations?.[0]?.amount0, "-2500001");
    assert.equal(fetch.observations?.[0]?.amount1, "1300000000000000001");
    assert.equal(fetch.observations?.[0]?.quoteVolumeMicros, 2_500_001);
    assert.ok(
      fake.calls
        .find((call) => call.body.query.includes("swaps"))
        ?.body.query.includes("_meta(block: { number: $block })"),
    );
  }),
);

it.effect("applies the swap cap to a short last page", () =>
  Effect.gen(function* () {
    const fake = makeFakeGraph({ rows: [inWindowRow(1), inWindowRow(2), inWindowRow(3)] });
    const source = yield* ForgeGraphSource.pipe(
      Effect.provide(sourceLayer(fake.shape, { ...BASE_ENV, T3_FORGE_MAX_SWAPS: "2" })),
    );
    const fetch = yield* source.fetchWindow({ poolId: POOL_005, ...WINDOW });
    assert.equal(fetch.status, "unavailable");
    assert.include(fetch.reason ?? "", "swap budget");
  }),
);

it.effect("does not report healthy when indexing heads are missing", () =>
  Effect.gen(function* () {
    const fake = makeFakeGraph({ rows: [] });
    const source = yield* ForgeGraphSource.pipe(
      Effect.provide(
        sourceLayer({
          post: (input) =>
            JSON.stringify(input.body).includes("indexingStatuses")
              ? Effect.succeed({
                  status: 200,
                  body: { data: { indexingStatuses: [{ health: "healthy", chains: [] }] } },
                })
              : fake.shape.post(input),
        }),
      ),
    );
    assert.equal((yield* source.probeHealth).status, "unavailable");
    assert.equal((yield* source.fetchWindow({ poolId: POOL_005, ...WINDOW })).status, "stale");
  }),
);

it.effect("feeds the reactor a real source capture with retained per-pool provenance", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(WINDOW.endedAt * 1000);
    const { ForgeSourceWindowLive } = yield* Effect.promise(() => import("./ForgeSourceWindow.ts"));
    const { ForgeSourceWindowProvider } = yield* Effect.promise(() => import("./ForgeReactor.ts"));
    const { createHash } = yield* Effect.promise(() => import("node:crypto"));
    const sha256 = (value: string): string =>
      createHash("sha256").update(value, "utf8").digest("hex");
    const fake = makeFakeGraph({ rows: [] });
    const layer = ForgeSourceWindowLive.pipe(
      Layer.provide(sourceLayer(fake.shape)),
      Layer.provide(ForgeSourceStoreLive),
      Layer.provideMerge(NodeSqliteClient.layerMemory()),
    );
    yield* Effect.gen(function* () {
      yield* runMigrations({});
      const provider = yield* ForgeSourceWindowProvider;
      const captured = yield* provider.currentWindow({ environmentId: "env-window" });
      assert.equal(captured.evidence.complete, true);
      assert.equal(captured.historical, false);
      assert.equal(captured.pools.length, 3);
      assert.equal(captured.evidenceIds.length, 3);
      assert.equal(new Set(captured.evidenceIds).size, 3);
      assert.equal(captured.window.endedAtMs - captured.window.startedAtMs, 300_000);
      // Without a bundle query the executed bytes are the host constant.
      assert.equal(captured.evidence.querySha256, sha256(FORGE_SWAPS_QUERY));

      // With the bundle's validated bytes, those bytes are executed (the fake
      // transport saw them verbatim) and hashed into the evidence.
      const withBundle = yield* provider.currentWindow({
        environmentId: "env-window",
        query: BUNDLE_QUERY,
      });
      assert.equal(withBundle.evidence.querySha256, sha256(BUNDLE_QUERY));
      assert.notEqual(withBundle.evidence.querySha256, captured.evidence.querySha256);
      const swapsCalls = fake.calls.filter((call) => call.body.query.includes("swaps")).slice(-3);
      for (const call of swapsCalls) assert.equal(call.body.query, BUNDLE_QUERY);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("refuses invalid chart bounds before querying the source", () =>
  Effect.gen(function* () {
    yield* runMigrations({});
    const reads = yield* ForgeSourceReads;
    for (const maxPoints of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = yield* reads.readPoolSeries({
        poolId: POOL_005,
        startUtcMs: WINDOW.startedAt * 1000,
        endUtcMs: WINDOW.endedAt * 1000,
        maxPoints,
      });
      assert.equal(result.status, "unavailable");
    }
    for (const startUtcMs of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = yield* reads.readPoolSeries({
        poolId: POOL_005,
        startUtcMs,
        endUtcMs: WINDOW.endedAt * 1000,
      });
      assert.equal(result.status, "unavailable");
    }
  }).pipe(Effect.provide(readsLayer(deadTransport))),
);

it.effect("independent mainnet head proves lag without passing Graph credentials to RPC", () =>
  Effect.gen(function* () {
    const rpcCalls: Array<{ readonly url: string; readonly body: unknown }> = [];
    const transport: ForgeGraphTransportShape = {
      post: ({ body, apiKey }) => {
        assert.equal(apiKey, API_KEY);
        if (JSON.stringify(body).includes("indexingStatuses")) return Effect.fail("HTTP404");
        return Effect.succeed({
          status: 200,
          body: {
            data: {
              _meta: {
                deployment: DEPLOYMENT,
                hasIndexingErrors: false,
                block: { number: 100 },
              },
            },
          },
        });
      },
      postRpc: (input) => {
        rpcCalls.push(input);
        assert.ok(!JSON.stringify(input).includes(API_KEY));
        assert.ok(!("apiKey" in input));
        const request = input.body as { id: number; method: string };
        return Effect.succeed({
          status: 200,
          body: {
            jsonrpc: "2.0",
            id: request.id,
            result: request.method === "eth_chainId" ? "0x1" : "0x69",
          },
        });
      },
    };
    const health = yield* Effect.flatMap(ForgeGraphSource, (source) => source.probeHealth).pipe(
      Effect.provide(
        sourceLayer(transport, { ...BASE_ENV, T3_FORGE_CHAIN_HEAD_RPC: "https://rpc.test" }),
      ),
    );
    assert.equal(health.status, "healthy");
    assert.equal(health.latestBlock, 100);
    assert.equal(health.chainHeadBlock, 105);
    assert.equal(health.lagBlocks, 5);
    assert.equal(rpcCalls.length, 2);
  }),
);

it.effect(
  "independent freshness refuses forged, malformed, unhealthy and wrong-chain responses",
  () =>
    Effect.gen(function* () {
      const cases = [
        { deployment: "forged" },
        { hasIndexingErrors: true },
        { hasIndexingErrors: undefined },
        { latest: -1 },
        { latest: Number.MAX_SAFE_INTEGER + 1 },
        { chainId: "0xaa36a7" },
        { chainId: "0x01" },
        { head: "0x20000000000000" },
        { head: "0x63" },
        { head: "105" },
        { responseId: 999 },
        { rpcError: true },
      ];
      for (const override of cases) {
        const options = {
          deployment: DEPLOYMENT,
          hasIndexingErrors: false as boolean | undefined,
          latest: 100,
          chainId: "0x1",
          head: "0x69",
          responseId: null as number | null,
          rpcError: false,
          ...override,
        };
        const transport: ForgeGraphTransportShape = {
          post: ({ body }) =>
            JSON.stringify(body).includes("indexingStatuses")
              ? Effect.fail("HTTP404")
              : Effect.succeed({
                  status: 200,
                  body: {
                    data: {
                      _meta: {
                        deployment: options.deployment,
                        hasIndexingErrors: options.hasIndexingErrors,
                        block: { number: options.latest },
                      },
                    },
                  },
                }),
          postRpc: ({ body }) => {
            const request = body as { id: number; method: string };
            return Effect.succeed({
              status: 200,
              body: {
                jsonrpc: "2.0",
                id: options.responseId ?? request.id,
                ...(options.rpcError ? { error: { message: API_KEY } } : {}),
                result: request.method === "eth_chainId" ? options.chainId : options.head,
              },
            });
          },
        };
        const health = yield* Effect.flatMap(ForgeGraphSource, (source) => source.probeHealth).pipe(
          Effect.provide(
            sourceLayer(transport, { ...BASE_ENV, T3_FORGE_CHAIN_HEAD_RPC: "https://rpc.test" }),
          ),
        );
        assert.equal(health.status, "unavailable", Object.keys(override).join(", "));
        if (health.status === "unavailable") assert.ok(!(health.reason ?? "").includes(API_KEY));
      }
    }),
);

it("the real independent RPC transport omits authorization", async () => {
  let headers: Headers | undefined;
  const fetchStub = (async (_input: unknown, init?: RequestInit) => {
    headers = new Headers(init?.headers);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  await Effect.runPromise(
    Effect.gen(function* () {
      const transport = yield* ForgeGraphTransport;
      assert.ok(transport.postRpc);
      yield* transport.postRpc({
        url: "https://rpc.test",
        body: {
          jsonrpc: "2.0",
          id: 1,
          method: "eth_chainId",
          params: [],
        },
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(ForgeGraphTransportLive.pipe(Layer.provide(FetchHttpClient.layer))),
      Effect.provideService(FetchHttpClient.Fetch, fetchStub),
    ),
  );
  assert.ok(headers);
  assert.equal(headers.get("authorization"), null);
});

it.effect("number-pinned Graph pages retain independently verified hashes and refuse reorgs", () =>
  Effect.gen(function* () {
    for (const mode of ["stable", "changed", "wrong-chain", "wrong-number", "malformed"] as const) {
      const block = 22_000_000;
      const fake = makeFakeGraph({
        rows: [],
        pageOverrides: {
          0: {
            data: {
              swaps: [],
              _meta: { deployment: DEPLOYMENT, block: { number: block, hash: null } },
            },
          },
        },
      });
      let reads = 0;
      const transport: ForgeGraphTransportShape = {
        ...fake.shape,
        postRpc: ({ body }) => {
          const input = body as { method: string; id: number; params: unknown[] };
          let result: unknown;
          if (input.method === "eth_chainId") result = mode === "wrong-chain" ? "0x2" : "0x1";
          else {
            assert.equal(input.method, "eth_getBlockByNumber");
            assert.deepEqual(input.params, [`0x${block.toString(16)}`, false]);
            reads++;
            result = {
              number: `0x${(mode === "wrong-number" ? block + 1 : block).toString(16)}`,
              hash:
                mode === "malformed"
                  ? "0x123"
                  : mode === "changed" && reads === 2
                    ? `0x${"ef".repeat(32)}`
                    : BLOCK_HASH,
            };
          }
          return Effect.succeed({ status: 200, body: { jsonrpc: "2.0", id: input.id, result } });
        },
      };
      const fetch = yield* Effect.flatMap(ForgeGraphSource, (source) =>
        source.fetchWindow({
          poolId: POOL_005,
          ...WINDOW,
        }),
      ).pipe(
        Effect.provide(
          sourceLayer(transport, {
            ...BASE_ENV,
            T3_FORGE_CHAIN_HEAD_RPC: "https://rpc.test",
          }),
        ),
      );
      if (mode === "stable") {
        assert.equal(fetch.status, "empty");
        assert.equal(fetch.pinnedBlockHash, BLOCK_HASH);
        assert.deepEqual(fetch.queryCapture?.blockHashVerification, [
          {
            method: "independent-rpc",
            chainId: 1,
            blockNumber: block,
            beforeHash: BLOCK_HASH,
            afterHash: BLOCK_HASH,
          },
        ]);
        assert.equal(reads, 2);
      } else assert.equal(fetch.status, "unavailable", mode);
    }
  }),
);
