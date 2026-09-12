/**
 * ForgeGraphSource — the pinned-block Uniswap v3 adapter over The Graph.
 *
 * Forge observes real mainnet WETH/USDC swaps. This module is the only thing
 * that talks to The Graph network for it: it resolves host configuration,
 * measures indexing lag, pins ONE block across every page of a fetch, and
 * normalizes each swap into an exact, runtime-validated
 * `ForgeSwapObservation`.
 *
 * Safety properties this module is load-bearing for:
 *
 * - Credentials ride the `Authorization` header and nothing else. They never
 *   appear in a URL, a log line, or an error reason: every reason string is
 *   passed through `redact` before it becomes an `unavailable` state.
 * - A fetch never serves mixed-block data. Every page must echo the pinned
 *   block number (and hash, when served); a page that does not makes the
 *   whole fetch `unavailable`, never a partial series.
 * - States are named, never faked: `complete`, `empty`, `stale` (indexed
 *   head behind the chain head past `maxLagBlocks`, or freshness unverifiable),
 *   and `unavailable` with a reason. No zeros, no fixtures, no silent
 *   truncation — exceeding the swap budget is an `unavailable`.
 * - Nothing here calls Hyperliquid, touches a signer, or can place an order.
 *   The Graph is a read-only public source; the signer base is never read.
 *
 * @module ForgeGraphSource
 */
import { Context, Effect, Layer, Schema } from "effect";
import * as Clock from "effect/Clock";
import * as NodeCrypto from "node:crypto";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import {
  FORGE_ANCHOR_CANDIDATE_WINDOW_SECONDS,
  FORGE_MAX_WINDOW_SECONDS,
  FORGE_OBSERVATION_CHAIN,
  forgeExactQuotePerBase,
  ForgeSwapObservation,
  forgeQuoteVolume,
  forgeRatioMicros,
  ForgeSourceHealth,
  ForgeWindowFetch,
  type ForgeSourceConfig,
  type ForgePoolIdentity,
} from "@t3tools/trading-contracts";

// ---------------------------------------------------------------------------
// Host configuration
// ---------------------------------------------------------------------------

/**
 * The three approved mainnet WETH/USDC v3 pools, with the token metadata the
 * exact normalization needs. Public constants, not credentials; the host can
 * narrow the list through `T3_FORGE_POOLS` but cannot add unknown pools —
 * an address without vetted metadata would invert prices silently.
 */
export const DEFAULT_FORGE_POOLS: ReadonlyArray<ForgePoolIdentity> = [
  {
    chain: FORGE_OBSERVATION_CHAIN,
    poolId: "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640",
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
    baseIsToken1: true,
  },
  {
    chain: FORGE_OBSERVATION_CHAIN,
    poolId: "0x8ad599c3a0ff1de082011efddc58f1908eb6e6d8",
    feeTierHundredthsBps: 3000,
    label: "USDC/WETH 0.3%",
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
    baseIsToken1: true,
  },
  {
    chain: FORGE_OBSERVATION_CHAIN,
    poolId: "0x7bea39867e4169dbe237d55c8242fe839056b1dc",
    feeTierHundredthsBps: 10_000,
    label: "USDC/WETH 1%",
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
    baseIsToken1: true,
  },
];

const DEFAULT_INDEXING_ENDPOINT = "https://api.thegraph.com/indexing/graphql";
const DEFAULT_MAX_LAG_BLOCKS = 40;
const DEFAULT_PAGE_SIZE = 1000;
const DEFAULT_MAX_SWAPS_PER_FETCH = 5000;

/** Resolved Forge source settings. `configured: false` carries the named reason. */
export interface ForgeGraphSettings {
  readonly configured: boolean;
  readonly reason?: string;
  /** Present only when configured. Never logged, never in a URL. */
  readonly apiKey?: string;
  readonly source?: ForgeSourceConfig;
}

const toIntOr = (raw: string | undefined, fallback: number): number => {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

/**
 * Read the Forge source settings out of an env bag. Exposed for tests.
 *
 *   - `T3_FORGE_GRAPH_ENDPOINT` — query endpoint (required)
 *   - `T3_FORGE_GRAPH_API_KEY` — The Graph API key (required; header-only)
 *   - `T3_FORGE_GRAPH_DEPLOYMENT` — deployment id (required)
 *   - `T3_FORGE_INDEXING_ENDPOINT` — status probe (default shown above)
 *   - `T3_FORGE_POOLS` — comma-separated subset of the approved pools
 *   - `T3_FORGE_MAX_LAG_BLOCKS`, `T3_FORGE_PAGE_SIZE`, `T3_FORGE_MAX_SWAPS`
 *
 * Missing required variables produce `configured: false` with the variable
 * names in the reason — an honest unavailable state, not a default endpoint
 * with someone else's credentials.
 */
export const resolveForgeGraphSettings = (
  env: Record<string, string | undefined>,
): ForgeGraphSettings => {
  const endpoint = env.T3_FORGE_GRAPH_ENDPOINT?.trim();
  const apiKey = env.T3_FORGE_GRAPH_API_KEY?.trim();
  const deployment = env.T3_FORGE_GRAPH_DEPLOYMENT?.trim();
  const missing = [
    endpoint === undefined || endpoint === "" ? "T3_FORGE_GRAPH_ENDPOINT" : undefined,
    apiKey === undefined || apiKey === "" ? "T3_FORGE_GRAPH_API_KEY" : undefined,
    deployment === undefined || deployment === "" ? "T3_FORGE_GRAPH_DEPLOYMENT" : undefined,
  ].filter((name): name is string => name !== undefined);
  if (
    missing.length > 0 ||
    endpoint === undefined ||
    apiKey === undefined ||
    deployment === undefined
  ) {
    return {
      configured: false,
      reason: `forge graph source not configured (missing ${missing.join(", ")})`,
    };
  }

  // The host may narrow the approved list; unknown addresses are refused with
  // the address named, because a pool without vetted metadata cannot be
  // normalized honestly.
  let pools = DEFAULT_FORGE_POOLS;
  const requested = env.T3_FORGE_POOLS?.trim();
  if (requested !== undefined && requested !== "") {
    const wanted = requested
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry !== "");
    const known = new Map(DEFAULT_FORGE_POOLS.map((pool) => [pool.poolId.toLowerCase(), pool]));
    const unknown = wanted.filter((address) => !known.has(address));
    if (unknown.length > 0) {
      return {
        configured: false,
        reason: `T3_FORGE_POOLS names pools without vetted metadata: ${unknown.join(", ")}`,
      };
    }
    pools = wanted.map((address) => known.get(address)!);
  }

  return {
    configured: true,
    apiKey,
    source: {
      kind: "uniswap-v3-graph",
      endpoint,
      deployment,
      indexingEndpoint: env.T3_FORGE_INDEXING_ENDPOINT?.trim() || DEFAULT_INDEXING_ENDPOINT,
      pools: [...pools],
      maxLagBlocks: toIntOr(env.T3_FORGE_MAX_LAG_BLOCKS, DEFAULT_MAX_LAG_BLOCKS),
      pageSize: Math.min(toIntOr(env.T3_FORGE_PAGE_SIZE, DEFAULT_PAGE_SIZE), 1000),
      maxSwapsPerFetch: toIntOr(env.T3_FORGE_MAX_SWAPS, DEFAULT_MAX_SWAPS_PER_FETCH),
    },
  };
};

/** Per-call resolution, so a knob changed between reads takes effect without a restart. */
export class ForgeGraphConfig extends Context.Service<
  ForgeGraphConfig,
  { readonly resolve: Effect.Effect<ForgeGraphSettings> }
>()("t3/trading/forge/GraphSource/ForgeGraphConfig") {}

export const ForgeGraphConfigLive = Layer.succeed(
  ForgeGraphConfig,
  ForgeGraphConfig.of({ resolve: Effect.sync(() => resolveForgeGraphSettings(process.env)) }),
);

// ---------------------------------------------------------------------------
// Transport — the one seam credentials cross, as a header and nothing else
// ---------------------------------------------------------------------------

export interface ForgeGraphHttpResponse {
  readonly status: number;
  readonly body: unknown;
}

export interface ForgeGraphTransportShape {
  readonly post: (input: {
    readonly url: string;
    readonly body: unknown;
    readonly apiKey: string;
  }) => Effect.Effect<ForgeGraphHttpResponse, string>;
}

export class ForgeGraphTransport extends Context.Service<
  ForgeGraphTransport,
  ForgeGraphTransportShape
>()("t3/trading/forge/GraphSource/ForgeGraphTransport") {}

/**
 * HttpClient-backed transport. The API key crosses as the `Authorization`
 * header here and only here — never the URL, never a log line. Tests inject a
 * fake at this seam; production composes the shared HTTP layer.
 */
export const ForgeGraphTransportLive = Layer.effect(
  ForgeGraphTransport,
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return ForgeGraphTransport.of({
      post: ({ url, body, apiKey }) =>
        HttpClientRequest.post(url).pipe(
          HttpClientRequest.setHeader("authorization", `Bearer ${apiKey}`),
          HttpClientRequest.bodyJson(body),
          Effect.flatMap(client.execute),
          Effect.flatMap((response) =>
            response.json.pipe(
              Effect.map((parsed) => ({ status: response.status, body: parsed as unknown })),
              // A body that will not parse still names its HTTP status; the
              // caller treats a null body as a malformed response.
              Effect.orElseSucceed(() => ({ status: response.status, body: null })),
            ),
          ),
          Effect.mapError((cause): string => `forge graph transport failed: ${String(cause)}`),
        ),
    });
  }),
);

/** Remove the API key from any string before it can become an error reason. */
export const redact = (message: string, apiKey: string | undefined): string =>
  apiKey === undefined || apiKey === "" ? message : message.split(apiKey).join("[redacted]");

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;

const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);

const asInt = (value: unknown): number | null => {
  const number = typeof value === "string" && /^-?[0-9]+$/.test(value) ? Number(value) : value;
  return typeof number === "number" && Number.isSafeInteger(number) ? number : null;
};

// Graph BigDecimal amounts are token units; the shared observation uses raw units.
const rawTokenAmount = (value: unknown, decimals: number): string | null => {
  if (typeof value !== "string" || value.length > 128 || !/^-?[0-9]+(?:\.[0-9]+)?$/.test(value))
    return null;
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = (negative ? value.slice(1) : value).split(".");
  if (fraction.slice(decimals).replace(/0/g, "") !== "") return null;
  const raw =
    BigInt(whole!) * 10n ** BigInt(decimals) +
    BigInt(fraction.slice(0, decimals).padEnd(decimals, "0") || "0");
  return (negative ? -raw : raw).toString();
};

// ---------------------------------------------------------------------------
// GraphQL documents
// ---------------------------------------------------------------------------

/**
 * The one swaps query this source is allowed to run: cursor-paginated by id,
 * timestamp-bounded to the window plus the anchor buffer, pinned to one block.
 */
const SWAPS_QUERY = `query ForgeSwaps($pool: ID!, $first: Int!, $cursor: ID!, $block: Int!, $from: Int!, $to: Int!) {
  swaps(
    first: $first
    where: { pool: $pool, id_gt: $cursor, timestamp_gte: $from, timestamp_lte: $to }
    block: { number: $block }
    orderBy: id
    orderDirection: asc
  ) {
    id
    timestamp
    sender
    recipient
    amount0
    amount1
    sqrtPriceX96
    tick
    logIndex
    transaction { id }
  }
  _meta(block: { number: $block }) { deployment block { number hash } }
}`;

const META_QUERY = `query ForgeMeta {
  _meta { deployment block { number hash } }
}`;

const INDEXING_QUERY = `query ForgeIndexingStatus($deployments: [String!]!) {
  indexingStatuses(subgraphs: $deployments) {
    subgraph
    health
    fatalError { message }
    chains { latestBlock { number } chainHeadBlock { number } }
  }
}`;

// ---------------------------------------------------------------------------
// The source service
// ---------------------------------------------------------------------------

export interface ForgeFetchWindowInput {
  readonly poolId: string;
  /** Unix seconds, inclusive window start. */
  readonly startedAt: number;
  /** Unix seconds, inclusive window end. */
  readonly endedAt: number;
  /** Label the retained window historical; it carries its original block/time. */
  readonly historical?: boolean;
  /** Pin override, so one capture pins every pool to the same block. */
  readonly pinnedBlock?: number;
}

export interface ForgeGraphSourceShape {
  readonly settings: Effect.Effect<ForgeGraphSettings>;
  /** Probe indexing status. Never fails; every failure is a named state. */
  readonly probeHealth: Effect.Effect<ForgeSourceHealth>;
  readonly fetchWindow: (input: ForgeFetchWindowInput) => Effect.Effect<ForgeWindowFetch>;
  /**
   * Fetch every approved pool over one window, pinned to ONE block across
   * pools and pages. Comparisons (v1/v2) need the three pools to describe the
   * same chain state, so the pin is resolved once and passed down.
   */
  readonly fetchAllPools: (input: {
    readonly startedAt: number;
    readonly endedAt: number;
    readonly historical?: boolean;
  }) => Effect.Effect<{
    readonly pinnedBlock: number | null;
    readonly fetches: ReadonlyArray<ForgeWindowFetch>;
  }>;
}

export class ForgeGraphSource extends Context.Service<ForgeGraphSource, ForgeGraphSourceShape>()(
  "t3/trading/forge/GraphSource/ForgeGraphSource",
) {}

interface IndexingProbe {
  readonly latestBlock: number | null;
  readonly chainHeadBlock: number | null;
  readonly lagBlocks: number | null;
  /** Non-empty means the subgraph itself reported it cannot serve truthfully. */
  readonly unhealthyReason: string | null;
  /** Non-empty means the probe failed and freshness cannot be proven. */
  readonly failedReason: string | null;
}

export const makeForgeGraphSource = Effect.gen(function* () {
  const config = yield* ForgeGraphConfig;
  const transport = yield* ForgeGraphTransport;

  /** One authenticated POST, with the reason redacted on failure. */
  const post = (
    url: string,
    body: unknown,
    apiKey: string,
  ): Effect.Effect<Record<string, unknown>, string> =>
    transport.post({ url, body, apiKey }).pipe(
      Effect.mapError((cause) => redact(cause, apiKey)),
      Effect.flatMap((response) => {
        if (response.status !== 200) {
          return Effect.fail(`graph endpoint answered HTTP ${response.status}`);
        }
        const parsed = asRecord(response.body);
        return parsed === null
          ? Effect.fail("graph endpoint returned a non-JSON body")
          : Effect.succeed(parsed);
      }),
    );

  /** The post, with its failure folded into the value — never a thrown error. */
  const postOrError = (
    url: string,
    body: unknown,
    apiKey: string,
  ): Effect.Effect<
    | { readonly ok: true; readonly body: Record<string, unknown> }
    | { readonly ok: false; readonly reason: string }
  > =>
    post(url, body, apiKey).pipe(
      Effect.map((parsed): { readonly ok: true; readonly body: Record<string, unknown> } => ({
        ok: true,
        body: parsed,
      })),
      // `orElseSucceed` cannot carry the failure forward; `catch` can, and
      // folding a failure into the value is the whole point here.
      Effect.catch((reason): Effect.Effect<{ readonly ok: false; readonly reason: string }> =>
        Effect.succeed({ ok: false, reason }),
      ),
    );

  const probeIndexing = Effect.gen(function* () {
    const settings = yield* config.resolve;
    if (!settings.configured || settings.source === undefined || settings.apiKey === undefined) {
      return {
        latestBlock: null,
        chainHeadBlock: null,
        lagBlocks: null,
        unhealthyReason: null,
        failedReason: settings.reason ?? "forge graph source not configured",
      } satisfies IndexingProbe;
    }
    const probe = yield* postOrError(
      settings.source.indexingEndpoint,
      { query: INDEXING_QUERY, variables: { deployments: [settings.source.deployment] } },
      settings.apiKey,
    );
    if (!probe.ok) {
      return {
        latestBlock: null,
        chainHeadBlock: null,
        lagBlocks: null,
        unhealthyReason: null,
        failedReason: `indexing status probe failed: ${probe.reason}`,
      } satisfies IndexingProbe;
    }
    const data = asRecord(probe.body["data"]);
    const statuses = data === null ? undefined : data["indexingStatuses"];
    if (!Array.isArray(statuses) || statuses.length === 0) {
      return {
        latestBlock: null,
        chainHeadBlock: null,
        lagBlocks: null,
        unhealthyReason: null,
        failedReason: "indexing status returned no entry for the deployment",
      } satisfies IndexingProbe;
    }
    const status = asRecord(statuses[0]);
    const health = status === null ? null : asString(status["health"]);
    if (status !== null && health !== null && health !== "healthy") {
      return {
        latestBlock: null,
        chainHeadBlock: null,
        lagBlocks: null,
        unhealthyReason: `subgraph reported health '${health}'`,
        failedReason: null,
      } satisfies IndexingProbe;
    }
    const chains = status === null ? undefined : status["chains"];
    const chain = Array.isArray(chains) ? asRecord(chains[0]) : null;
    const latestBlock = chain === null ? null : blockNumber(asRecord(chain["latestBlock"]));
    const chainHeadBlock = chain === null ? null : blockNumber(asRecord(chain["chainHeadBlock"]));
    const lagBlocks =
      latestBlock !== null && chainHeadBlock !== null ? chainHeadBlock - latestBlock : null;
    return {
      latestBlock,
      chainHeadBlock,
      lagBlocks,
      unhealthyReason: null,
      failedReason:
        health !== "healthy" ||
        latestBlock === null ||
        chainHeadBlock === null ||
        lagBlocks === null ||
        lagBlocks < 0
          ? "indexing status omitted valid health or block heads"
          : null,
    } satisfies IndexingProbe;
  });

  const probeHealth: Effect.Effect<ForgeSourceHealth> = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const probe = yield* probeIndexing;
    if (probe.failedReason !== null) {
      return { status: "unavailable", reason: probe.failedReason, probedAtMs: now };
    }
    if (probe.unhealthyReason !== null) {
      return { status: "unavailable", reason: probe.unhealthyReason, probedAtMs: now };
    }
    const settings = yield* config.resolve;
    const maxLag = settings.source?.maxLagBlocks ?? DEFAULT_MAX_LAG_BLOCKS;
    if (probe.lagBlocks !== null && probe.lagBlocks > maxLag) {
      return {
        status: "stale",
        reason: `indexed head lags chain head by ${probe.lagBlocks} blocks (max ${maxLag})`,
        ...(probe.latestBlock === null ? {} : { latestBlock: probe.latestBlock }),
        ...(probe.chainHeadBlock === null ? {} : { chainHeadBlock: probe.chainHeadBlock }),
        lagBlocks: probe.lagBlocks,
        probedAtMs: now,
      };
    }
    return {
      status: "healthy",
      ...(probe.latestBlock === null ? {} : { latestBlock: probe.latestBlock }),
      ...(probe.chainHeadBlock === null ? {} : { chainHeadBlock: probe.chainHeadBlock }),
      ...(probe.lagBlocks === null ? {} : { lagBlocks: probe.lagBlocks }),
      probedAtMs: now,
    };
  });

  const unavailable = (
    poolId: string,
    fetchedAtMs: number,
    historical: boolean,
    reason: string,
  ): ForgeWindowFetch => ({
    poolId,
    status: "unavailable",
    reason,
    fetchedAtMs,
    historical,
  });

  const fetchWindow = (input: ForgeFetchWindowInput): Effect.Effect<ForgeWindowFetch> =>
    Effect.gen(function* () {
      const fetchedAtMs = yield* Clock.currentTimeMillis;
      const settings = yield* config.resolve;
      if (!settings.configured || settings.source === undefined) {
        return unavailable(
          input.poolId,
          fetchedAtMs,
          input.historical === true,
          settings.reason ?? "forge graph source not configured",
        );
      }
      const source = settings.source;
      const pool = source.pools.find(
        (candidate) => candidate.poolId.toLowerCase() === input.poolId.toLowerCase(),
      );
      if (pool === undefined) {
        return unavailable(
          input.poolId,
          fetchedAtMs,
          input.historical === true,
          `pool ${input.poolId} is not in the approved forge pool list`,
        );
      }
      if (
        !Number.isSafeInteger(input.startedAt) ||
        !Number.isSafeInteger(input.endedAt) ||
        input.startedAt < 0 ||
        input.startedAt >= input.endedAt
      ) {
        return unavailable(
          input.poolId,
          fetchedAtMs,
          input.historical === true,
          "window start must be before window end",
        );
      }
      if (input.endedAt - input.startedAt > FORGE_MAX_WINDOW_SECONDS) {
        return unavailable(
          input.poolId,
          fetchedAtMs,
          input.historical === true,
          `window exceeds the 24h (86400s) bound`,
        );
      }

      const probe = yield* probeIndexing;
      if (probe.unhealthyReason !== null) {
        return unavailable(
          input.poolId,
          fetchedAtMs,
          input.historical === true,
          probe.unhealthyReason,
        );
      }
      let pinnedBlock = input.pinnedBlock ?? probe.latestBlock;
      if (pinnedBlock === null) {
        // The status probe failed, so freshness is already unverifiable — but
        // the data endpoint still names its own indexed head, and pinning to
        // THAT is better than no read at all. The fetch stays consistent (one
        // block, every page) and is served `stale`, not `complete`.
        const meta = yield* postOrError(source.endpoint, { query: META_QUERY }, settings.apiKey!);
        const metaData = meta.ok ? asRecord(meta.body["data"]) : null;
        const metaBlockRow = metaData === null ? null : asRecord(metaData["_meta"]);
        const metaBlock =
          metaBlockRow === null ? null : blockNumber(asRecord(metaBlockRow["block"]));
        if (metaBlock === null) {
          return unavailable(
            input.poolId,
            fetchedAtMs,
            input.historical === true,
            `could not resolve a block to pin: ${probe.failedReason ?? "unknown"}`,
          );
        }
        pinnedBlock = metaBlock;
      }

      // Bounded cursor walk. The timestamp bounds keep the walk inside the
      // window plus the anchor buffer; the page cap keeps it finite.
      const observations: Array<ForgeSwapObservation> = [];
      const seen = new Set<string>();
      let duplicatesDropped = 0;
      let cursor = "";
      let rowsRead = 0;
      let pinnedBlockHash: string | undefined;
      while (true) {
        const page = yield* postOrError(
          source.endpoint,
          {
            query: SWAPS_QUERY,
            variables: {
              pool: pool.poolId,
              first: source.pageSize,
              cursor,
              block: pinnedBlock,
              from: input.startedAt - FORGE_ANCHOR_CANDIDATE_WINDOW_SECONDS,
              to: input.endedAt,
            },
          },
          settings.apiKey!,
        );
        if (!page.ok) {
          return unavailable(
            input.poolId,
            fetchedAtMs,
            input.historical === true,
            `graph query failed: ${page.reason}`,
          );
        }
        const graphErrors = page.body["errors"];
        if (Array.isArray(graphErrors) && graphErrors.length > 0) {
          const first = asString(asRecord(graphErrors[0])?.["message"]) ?? "unknown graphql error";
          return unavailable(
            input.poolId,
            fetchedAtMs,
            input.historical === true,
            `graphql error: ${redact(first, settings.apiKey)}`,
          );
        }
        const data = asRecord(page.body["data"]);
        if (data === null) {
          return unavailable(
            input.poolId,
            fetchedAtMs,
            input.historical === true,
            "graph response carried no data object",
          );
        }
        // Pinned-block consistency: every page must echo the pin. A page that
        // does not means the indexer moved or rolled back under the fetch —
        // mixed-block data is never served.
        const meta = asRecord(data["_meta"]);
        const metaBlock = asRecord(meta?.["block"]);
        const servedBlock = asInt(metaBlock?.["number"]);
        if (servedBlock !== pinnedBlock) {
          return unavailable(
            input.poolId,
            fetchedAtMs,
            input.historical === true,
            `graph served block ${servedBlock ?? "unknown"} under a fetch pinned to ${pinnedBlock}`,
          );
        }
        const servedHash = asString(metaBlock?.["hash"]);
        if (servedHash !== null) {
          if (pinnedBlockHash === undefined) {
            pinnedBlockHash = servedHash;
          } else if (servedHash !== pinnedBlockHash) {
            return unavailable(
              input.poolId,
              fetchedAtMs,
              input.historical === true,
              "block hash changed across pages of a pinned fetch (possible reorg)",
            );
          }
        }
        const rows = data["swaps"];
        if (!Array.isArray(rows)) {
          return unavailable(
            input.poolId,
            fetchedAtMs,
            input.historical === true,
            "graph response carried no swaps array",
          );
        }

        rowsRead += rows.length;
        if (rowsRead > source.maxSwapsPerFetch) {
          return unavailable(
            input.poolId,
            fetchedAtMs,
            input.historical === true,
            `window exceeded the swap budget (${rowsRead} > ${source.maxSwapsPerFetch}); narrow the window`,
          );
        }
        for (const row of rows) {
          const normalized = normalizeSwap(row, pool);
          if (normalized._tag === "Left") {
            return unavailable(
              input.poolId,
              fetchedAtMs,
              input.historical === true,
              normalized.left,
            );
          }
          const observation = normalized.right;
          if (seen.has(observation.observationId)) {
            duplicatesDropped += 1;
            continue;
          }
          seen.add(observation.observationId);
          observations.push(observation);
        }

        if (rows.length < source.pageSize) break;
        const lastRow = asRecord(rows[rows.length - 1]);
        const lastId = asString(lastRow?.["id"]);
        if (lastId === null || lastId <= cursor) {
          return unavailable(
            input.poolId,
            fetchedAtMs,
            input.historical === true,
            "pagination cursor failed to advance",
          );
        }
        cursor = lastId;
        if (observations.length > source.maxSwapsPerFetch) {
          return unavailable(
            input.poolId,
            fetchedAtMs,
            input.historical === true,
            `window exceeded the swap budget (${observations.length} > ${source.maxSwapsPerFetch}); narrow the window`,
          );
        }
      }

      // Deterministic order regardless of the id-string cursor: time first,
      // then log index within a transaction.
      observations.sort((a, b) => a.timestamp - b.timestamp || a.logIndex - b.logIndex);

      const inWindow = observations.filter(
        (observation) =>
          observation.timestamp >= input.startedAt && observation.timestamp <= input.endedAt,
      );
      const anchorCandidates = observations
        .filter((observation) => observation.timestamp < input.startedAt)
        .map((observation) => ({
          observation,
          ageBeforeWindowSeconds: input.startedAt - observation.timestamp,
        }));

      const staleReason =
        probe.failedReason !== null
          ? `freshness unverifiable: ${probe.failedReason}`
          : probe.lagBlocks !== null && probe.lagBlocks > source.maxLagBlocks
            ? `indexed head lags chain head by ${probe.lagBlocks} blocks (max ${source.maxLagBlocks})`
            : null;

      const digest = digestFetch({
        deployment: source.deployment,
        poolId: pool.poolId,
        pinnedBlock,
        pinnedBlockHash,
        startedAt: input.startedAt,
        endedAt: input.endedAt,
        observations,
      });

      const envelope: unknown = {
        poolId: pool.poolId,
        status: staleReason !== null ? "stale" : inWindow.length === 0 ? "empty" : "complete",
        ...(staleReason === null ? {} : { reason: staleReason }),
        pinnedBlock,
        ...(pinnedBlockHash === undefined ? {} : { pinnedBlockHash }),
        deployment: source.deployment,
        fetchedAtMs,
        window: { startedAt: input.startedAt, endedAt: input.endedAt },
        historical: input.historical === true,
        observations: inWindow,
        anchorCoverage: anchorCandidates.length === 0 ? "missing" : "covered",
        anchorCandidates,
        ...(probe.lagBlocks === null ? {} : { lagBlocks: probe.lagBlocks }),
        ...(duplicatesDropped === 0 ? {} : { duplicatesDropped }),
        sourceDigest: digest,
      };
      // Self-check: the envelope the adapter built must satisfy the contract
      // it claims to be. A construction bug surfaces as unavailable here
      // rather than as a malformed value downstream.
      return yield* decodeWindowFetchEnvelope(envelope).pipe(
        Effect.orElseSucceed(() =>
          unavailable(
            input.poolId,
            fetchedAtMs,
            input.historical === true,
            "adapter produced an invalid fetch envelope",
          ),
        ),
      );
    });

  const fetchAllPools = (input: {
    readonly startedAt: number;
    readonly endedAt: number;
    readonly historical?: boolean;
  }): Effect.Effect<{
    readonly pinnedBlock: number | null;
    readonly fetches: ReadonlyArray<ForgeWindowFetch>;
  }> =>
    Effect.gen(function* () {
      const settings = yield* config.resolve;
      const pools = settings.source?.pools ?? [];
      // Resolve the shared pin once; a probe that fails leaves every pool to
      // name its own unavailability honestly.
      const probe = yield* probeIndexing;
      let pinnedBlock = probe.latestBlock;
      if (pinnedBlock === null && settings.source !== undefined && settings.apiKey !== undefined) {
        const meta = yield* postOrError(
          settings.source.endpoint,
          { query: META_QUERY },
          settings.apiKey,
        );
        const data = meta.ok ? asRecord(meta.body["data"]) : null;
        pinnedBlock = blockNumber(asRecord(asRecord(data?.["_meta"])?.["block"]));
      }
      const fetches: Array<ForgeWindowFetch> = [];
      for (const pool of pools) {
        if (pinnedBlock === null) {
          fetches.push(
            unavailable(
              pool.poolId,
              yield* Clock.currentTimeMillis,
              input.historical === true,
              "could not resolve a shared block to pin",
            ),
          );
          continue;
        }
        fetches.push(
          yield* fetchWindow({
            poolId: pool.poolId,
            startedAt: input.startedAt,
            endedAt: input.endedAt,
            ...(input.historical === undefined ? {} : { historical: input.historical }),
            ...(pinnedBlock === null ? {} : { pinnedBlock }),
          }),
        );
      }
      return { pinnedBlock, fetches };
    });

  return ForgeGraphSource.of({
    settings: config.resolve,
    probeHealth,
    fetchWindow,
    fetchAllPools,
  });
});

/**
 * The source layer. Deliberately open about `ForgeGraphConfig` and
 * `ForgeGraphTransport`: the wiring point composes them (and tests inject a
 * fake transport), following the same pattern as the other trading services.
 */
export const ForgeGraphSourceLive = Layer.effect(ForgeGraphSource, makeForgeGraphSource);

// ---------------------------------------------------------------------------
// Row normalization
// ---------------------------------------------------------------------------

const blockNumber = (block: Record<string, unknown> | null): number | null => {
  if (block === null) return null;
  const number = asInt(block["number"]);
  return number !== null && number > 0 ? number : null;
};

/**
 * One subgraph swap row into a validated, exactly-normalized observation.
 * Every malformed field is a named error — never a zero, never a dropped row.
 */
const normalizeSwap = (
  row: unknown,
  pool: ForgePoolIdentity,
):
  | { readonly _tag: "Left"; readonly left: string }
  | { readonly _tag: "Right"; readonly right: ForgeSwapObservation } => {
  const record = asRecord(row);
  if (record === null) return { _tag: "Left", left: "swap row was not an object" };
  const id = asString(record["id"]) ?? "unknown";
  const txHash = asString(asRecord(record["transaction"])?.["id"]);
  if (txHash === null) return { _tag: "Left", left: `swap ${id} has no transaction id` };
  const logIndex = asInt(record["logIndex"]);
  if (logIndex === null || logIndex < 0) {
    return { _tag: "Left", left: `swap ${id} has an invalid logIndex` };
  }
  const timestamp = asInt(record["timestamp"]);
  if (timestamp === null || timestamp < 0) {
    return { _tag: "Left", left: `swap ${id} has an invalid timestamp` };
  }
  const amount0 = rawTokenAmount(record["amount0"], pool.token0.decimals);
  const amount1 = rawTokenAmount(record["amount1"], pool.token1.decimals);
  const sqrtPriceX96 = asString(record["sqrtPriceX96"]);
  const tick = asInt(record["tick"]);
  if (amount0 === null || amount1 === null) {
    return { _tag: "Left", left: `swap ${id} has non-string amounts` };
  }
  if (sqrtPriceX96 === null) {
    return { _tag: "Left", left: `swap ${id} has a non-string sqrtPriceX96` };
  }
  if (tick === null) return { _tag: "Left", left: `swap ${id} has an invalid tick` };

  const ratio = forgeExactQuotePerBase({
    sqrtPriceX96,
    token0Decimals: pool.token0.decimals,
    token1Decimals: pool.token1.decimals,
    baseIsToken1: pool.baseIsToken1,
  });
  if (ratio === null) {
    return { _tag: "Left", left: `swap ${id} has an invalid sqrtPriceX96` };
  }
  // The quote token is whichever slot the base (WETH) does not occupy.
  const volume = forgeQuoteVolume({
    amount0,
    amount1,
    quoteIsToken1: !pool.baseIsToken1,
    quoteDecimals: pool.baseIsToken1 ? pool.token0.decimals : pool.token1.decimals,
  });
  if (volume === null) {
    return { _tag: "Left", left: `swap ${id} has a malformed quote leg` };
  }

  const candidate: unknown = {
    chain: FORGE_OBSERVATION_CHAIN,
    poolId: pool.poolId,
    observationId: `${txHash}:${logIndex}`,
    transactionHash: txHash,
    logIndex,
    timestamp,
    sender: asString(record["sender"]) ?? "",
    recipient: asString(record["recipient"]) ?? "",
    amount0,
    amount1,
    sqrtPriceX96,
    tick,
    baseIsToken1: pool.baseIsToken1,
    priceQuotePerBase: ratio,
    priceQuotePerBaseMicros: forgeRatioMicros(ratio),
    quoteVolumeRaw: volume.quoteVolumeRaw,
    quoteVolumeMicros: volume.quoteVolumeMicros,
  };
  try {
    // Runtime validation: the row becomes a contract value or the fetch fails.
    return { _tag: "Right", right: Schema.decodeUnknownSync(ForgeSwapObservation)(candidate) };
  } catch (cause) {
    return { _tag: "Left", left: `swap ${id} failed observation validation: ${String(cause)}` };
  }
};

const decodeWindowFetchEnvelope = Schema.decodeUnknownEffect(ForgeWindowFetch);

/** SHA-256 over the canonical fetch artifact; arrays keep the JSON deterministic. */
const digestFetch = (input: {
  readonly deployment: string;
  readonly poolId: string;
  readonly pinnedBlock: number;
  readonly pinnedBlockHash: string | undefined;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly observations: ReadonlyArray<ForgeSwapObservation>;
}): string =>
  NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify({
        deployment: input.deployment,
        poolId: input.poolId,
        pinnedBlock: input.pinnedBlock,
        pinnedBlockHash: input.pinnedBlockHash ?? null,
        window: [input.startedAt, input.endedAt],
        swaps: input.observations.map((observation) => [
          observation.observationId,
          observation.timestamp,
          observation.logIndex,
          observation.amount0,
          observation.amount1,
          observation.sqrtPriceX96,
        ]),
      }),
    )
    .digest("hex");
