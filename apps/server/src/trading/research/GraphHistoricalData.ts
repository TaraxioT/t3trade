import { Context, Effect, Layer, Schema } from "effect";

import {
  GraphDataError,
  type GraphEntityKind,
  type GraphSnapshotBlock,
  type GraphSourceCapabilities,
  type GraphSourceRef,
  type GraphWindowPage,
  type ResearchCandle,
  type ResearchPriceSample,
} from "@t3tools/trading-contracts/researchData";

import {
  normalizeGraphOhlc,
  normalizeGraphSwapPrice,
  type GraphTokenMetadata,
} from "./GraphPriceNormalization.ts";

export interface GraphSourceConfig {
  readonly subgraphId: string;
  readonly poolAddress: string;
  readonly baseTokenAddress: string;
  readonly quoteTokenAddress: string;
  readonly feeTier: string;
  readonly requiredFrom: number;
  readonly requiredTo: number;
}

/** Uniswap's listed Ethereum v3 deployment, not a caller-selected chain alias. */
export const UNISWAP_V3_ETHEREUM_SUBGRAPH_ID = "5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV";

export interface GraphWindowRequest {
  readonly source: GraphSourceRef;
  readonly poolAddress: string;
  readonly snapshotBlock: GraphSnapshotBlock;
  readonly from: number;
  readonly to: number;
  readonly entityKind: GraphEntityKind;
  readonly pageSize?: number;
  readonly cursor?: string;
}

export interface GraphHistoricalDataShape {
  readonly inspectSource: (
    config: GraphSourceConfig,
  ) => Effect.Effect<GraphSourceCapabilities, GraphDataError>;
  readonly readWindow: (
    request: GraphWindowRequest,
  ) => Effect.Effect<GraphWindowPage, GraphDataError>;
}

export class GraphHistoricalData extends Context.Service<
  GraphHistoricalData,
  GraphHistoricalDataShape
>()("t3/trading/research/GraphHistoricalData") {}

type GraphFetch = typeof globalThis.fetch;
type UnknownRecord = Record<string, unknown>;
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const INSPECT_QUERY = `query Inspect($pool: ID!) {
  _meta { deployment block { number hash timestamp } hasIndexingErrors }
  pool(id: $pool) { id feeTier createdAtTimestamp token0 { id symbol decimals } token1 { id symbol decimals } }
  firstSwap: swaps(first: 1, orderBy: timestamp, orderDirection: asc, where: { pool: $pool }) { id timestamp }
  lastSwap: swaps(first: 1, orderBy: timestamp, orderDirection: desc, where: { pool: $pool }) { id timestamp }
  firstHour: poolHourDatas(first: 1, orderBy: periodStartUnix, orderDirection: asc, where: { pool: $pool }) { id periodStartUnix }
  lastHour: poolHourDatas(first: 1, orderBy: periodStartUnix, orderDirection: desc, where: { pool: $pool }) { id periodStartUnix }
  firstDay: poolDayDatas(first: 1, orderBy: date, orderDirection: asc, where: { pool: $pool }) { id date }
  lastDay: poolDayDatas(first: 1, orderBy: date, orderDirection: desc, where: { pool: $pool }) { id date }
}`;

const SWAP_QUERY = `query Window($pool: ID!, $block: Int!, $from: BigInt!, $to: BigInt!, $cursor: String!, $first: Int!) {
  _meta(block: { number: $block }) { deployment block { number hash } hasIndexingErrors }
  pool(id: $pool, block: { number: $block }) { id feeTier token0 { id decimals } token1 { id decimals } }
  swaps(first: $first, orderBy: id, orderDirection: asc, where: { pool: $pool, timestamp_gte: $from, timestamp_lt: $to, id_gt: $cursor }, block: { number: $block }) {
    id timestamp sqrtPriceX96 logIndex transaction { id blockNumber }
  }
}`;

const HOUR_QUERY = `query Window($pool: ID!, $block: Int!, $from: Int!, $to: Int!, $cursor: String!, $first: Int!) {
  _meta(block: { number: $block }) { deployment block { number hash } hasIndexingErrors }
  pool(id: $pool, block: { number: $block }) { id feeTier token0 { id decimals } token1 { id decimals } }
  poolHourDatas(first: $first, orderBy: id, orderDirection: asc, where: { pool: $pool, periodStartUnix_gte: $from, periodStartUnix_lt: $to, id_gt: $cursor }, block: { number: $block }) {
    id periodStartUnix open high low close
  }
}`;

const DAY_QUERY = `query Window($pool: ID!, $block: Int!, $from: Int!, $to: Int!, $cursor: String!, $first: Int!) {
  _meta(block: { number: $block }) { deployment block { number hash } hasIndexingErrors }
  pool(id: $pool, block: { number: $block }) { id feeTier token0 { id decimals } token1 { id decimals } }
  poolDayDatas(first: $first, orderBy: id, orderDirection: asc, where: { pool: $pool, date_gte: $from, date_lt: $to, id_gt: $cursor }, block: { number: $block }) {
    id date open high low close
  }
}`;

function fail(
  reason: GraphDataError["reason"],
  detail: string,
  retryAfterMs?: number,
): GraphDataError {
  return new GraphDataError({
    reason,
    detail,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
}

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function integer(value: unknown): number | null {
  const parsed =
    typeof value === "number" || typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function list(value: unknown): ReadonlyArray<unknown> | null {
  return Array.isArray(value) ? value : null;
}

function parseMeta(data: UnknownRecord): {
  readonly deployment: string;
  readonly block: GraphSnapshotBlock;
  readonly indexedThrough: number | null;
} {
  const meta = record(data._meta);
  const block = record(meta?.block);
  const deployment = string(meta?.deployment);
  const number = integer(block?.number);
  const hash = string(block?.hash);
  if (meta?.hasIndexingErrors === true) throw fail("indexing", "Subgraph reports indexing errors");
  if (!deployment || number === null || !hash || typeof meta?.hasIndexingErrors !== "boolean") {
    throw fail("schema_mismatch", "Subgraph metadata is missing required fields");
  }
  const timestamp = integer(block?.timestamp);
  return {
    deployment,
    block: { number, hash },
    indexedThrough: timestamp === null ? null : timestamp * 1_000,
  };
}

function parseToken(value: unknown): GraphTokenMetadata {
  const token = record(value);
  const address = string(token?.id);
  const decimals = integer(token?.decimals);
  if (!address || decimals === null || decimals > 36)
    throw fail("schema_mismatch", "Pool token metadata is invalid");
  return { address: address.toLowerCase(), decimals };
}

function parsePool(
  data: UnknownRecord,
  expected: {
    readonly poolAddress: string;
    readonly baseTokenAddress: string;
    readonly quoteTokenAddress: string;
    readonly feeTier: string;
  },
): { readonly token0: GraphTokenMetadata; readonly token1: GraphTokenMetadata } {
  const pool = record(data.pool);
  if (!pool) throw fail("coverage", "Requested pool is absent from the subgraph");
  const address = string(pool.id);
  const feeTier = string(pool.feeTier);
  if (
    address?.toLowerCase() !== expected.poolAddress.toLowerCase() ||
    feeTier !== expected.feeTier
  ) {
    throw fail("schema_mismatch", "Pool identity or fee tier does not match the configured source");
  }
  const token0 = parseToken(pool.token0);
  const token1 = parseToken(pool.token1);
  const actual = new Set([token0.address, token1.address]);
  if (
    actual.size !== 2 ||
    !actual.has(expected.baseTokenAddress.toLowerCase()) ||
    !actual.has(expected.quoteTokenAddress.toLowerCase())
  ) {
    throw fail("schema_mismatch", "Pool token addresses do not match the configured pair");
  }
  return { token0, token1 };
}

function endpointFor(subgraphId: string, apiKey: string): string {
  return `https://gateway.thegraph.com/api/${encodeURIComponent(apiKey)}/subgraphs/id/${encodeURIComponent(subgraphId)}`;
}

function isValidWindow(from: number, to: number): boolean {
  return Number.isSafeInteger(from) && Number.isSafeInteger(to) && from >= 0 && to > from;
}

function classifyGraphQlErrors(errors: ReadonlyArray<unknown>): GraphDataError {
  const messages = errors.map((error) => string(record(error)?.message)?.toLowerCase() ?? "");
  if (
    messages.some(
      (message) => message.includes("indexing_error") || message.includes("indexing error"),
    )
  )
    return fail("indexing", "Subgraph reported an indexing error");
  if (
    messages.some(
      (message) => message.includes("rate limit") || message.includes("too many requests"),
    )
  )
    return fail("rate_limit", "Graph gateway rate limit reached");
  if (
    messages.some(
      (message) => message.includes("not indexed") || message.includes("block not found"),
    )
  )
    return fail("coverage", "Requested snapshot block is unavailable");
  if (
    messages.some(
      (message) =>
        message.includes("cannot query field") ||
        message.includes("unknown argument") ||
        message.includes("unknown type"),
    )
  )
    return fail("schema_mismatch", "Subgraph schema does not support required research fields");
  return fail("upstream_failure", "Graph gateway returned a GraphQL error");
}

function firstTimestamp(data: UnknownRecord, field: string, timeField: string): number {
  const rows = list(data[field]);
  const row = rows?.length === 1 ? record(rows[0]) : null;
  const timestamp = integer(row?.[timeField]);
  if (timestamp === null)
    throw fail("coverage", `No ${field} entity is available for the requested pool`);
  return timestamp * 1_000;
}

export function makeGraphHistoricalData(
  options: {
    readonly env?: Record<string, string | undefined>;
    readonly fetch?: GraphFetch;
  } = {},
): GraphHistoricalDataShape {
  const env = options.env ?? process.env;
  const fetchGraph = options.fetch ?? globalThis.fetch;

  const query = (
    subgraphId: string,
    graphql: string,
    variables: UnknownRecord,
  ): Effect.Effect<UnknownRecord, GraphDataError> =>
    Effect.gen(function* () {
      const apiKey = env.T3_GRAPH_API_KEY?.trim();
      if (!apiKey || !subgraphId.trim())
        return yield* fail("configuration", "Graph API key or subgraph ID is not configured");
      const response = yield* Effect.tryPromise({
        try: () =>
          fetchGraph(endpointFor(subgraphId, apiKey), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: encodeJson({ query: graphql, variables }),
            signal: AbortSignal.timeout(15_000),
          }),
        catch: () => fail("upstream_failure", "Graph gateway request failed"),
      });
      if (response.status === 401 || response.status === 403)
        return yield* fail("authentication", "Graph gateway rejected the configured credential");
      if (response.status === 429) {
        const seconds = integer(response.headers.get("retry-after"));
        return yield* fail(
          "rate_limit",
          "Graph gateway rate limit reached",
          seconds === null ? undefined : seconds * 1_000,
        );
      }
      if (!response.ok)
        return yield* fail("upstream_failure", `Graph gateway returned HTTP ${response.status}`);
      const body = yield* Effect.tryPromise({
        try: () => response.json() as Promise<unknown>,
        catch: () => fail("upstream_failure", "Graph gateway returned invalid JSON"),
      });
      const envelope = record(body);
      if (!envelope)
        return yield* fail("schema_mismatch", "Graph gateway response is not an object");
      const errors = list(envelope.errors);
      if (errors && errors.length > 0) return yield* classifyGraphQlErrors(errors);
      const data = record(envelope.data);
      if (!data) return yield* fail("schema_mismatch", "Graph gateway response has no data object");
      return data;
    });

  return {
    inspectSource: (config) =>
      Effect.gen(function* () {
        if (!isValidWindow(config.requiredFrom, config.requiredTo))
          return yield* fail("configuration", "Required historical window is invalid");
        if (config.subgraphId !== UNISWAP_V3_ETHEREUM_SUBGRAPH_ID)
          return yield* fail(
            "configuration",
            "Only the verified Ethereum Uniswap v3 subgraph ID is supported",
          );
        const data = yield* query(config.subgraphId, INSPECT_QUERY, {
          pool: config.poolAddress.toLowerCase(),
        });
        const meta = yield* Effect.try({
          try: () => parseMeta(data),
          catch: (error) => error as GraphDataError,
        });
        const tokens = yield* Effect.try({
          try: () => parsePool(data, config),
          catch: (error) => error as GraphDataError,
        });
        if (meta.indexedThrough === null || meta.indexedThrough < config.requiredTo)
          return yield* fail("indexing", "Subgraph has not indexed through the required window");
        const coverage = yield* Effect.try({
          try: () => ({
            swaps: {
              firstAt: firstTimestamp(data, "firstSwap", "timestamp"),
              lastAt: firstTimestamp(data, "lastSwap", "timestamp"),
            },
            hour: {
              firstAt: firstTimestamp(data, "firstHour", "periodStartUnix"),
              lastAt: firstTimestamp(data, "lastHour", "periodStartUnix"),
            },
            day: {
              firstAt: firstTimestamp(data, "firstDay", "date"),
              lastAt: firstTimestamp(data, "lastDay", "date"),
            },
          }),
          catch: (error) => error as GraphDataError,
        });
        if (
          Object.values(coverage).some(
            (bounds) =>
              bounds.firstAt > config.requiredFrom ||
              bounds.lastAt < config.requiredTo - 86_400_000,
          )
        ) {
          return yield* fail(
            "coverage",
            "Pool entities do not bound the required historical window",
          );
        }
        const source: GraphSourceRef = {
          provider: "the_graph",
          chain: "ethereum",
          subgraphId: config.subgraphId,
          deployment: meta.deployment,
          poolAddress: config.poolAddress.toLowerCase(),
          baseTokenAddress: config.baseTokenAddress.toLowerCase(),
          quoteTokenAddress: config.quoteTokenAddress.toLowerCase(),
          feeTier: config.feeTier,
          normalizationVersion: 1,
        };
        return {
          source,
          snapshotBlock: meta.block,
          indexedThrough: meta.indexedThrough,
          ...tokens,
          coverage,
        };
      }),
    readWindow: (request) =>
      Effect.gen(function* () {
        if (
          !isValidWindow(request.from, request.to) ||
          request.source.provider !== "the_graph" ||
          request.source.chain !== "ethereum" ||
          request.source.subgraphId !== UNISWAP_V3_ETHEREUM_SUBGRAPH_ID ||
          request.source.normalizationVersion !== 1 ||
          request.poolAddress.toLowerCase() !== request.source.poolAddress.toLowerCase() ||
          !Number.isSafeInteger(request.snapshotBlock.number) ||
          request.snapshotBlock.number < 0
        ) {
          return yield* fail("configuration", "Graph window or pool identity is invalid");
        }
        const first = request.pageSize ?? 1_000;
        if (!Number.isInteger(first) || first < 1 || first > 1_000)
          return yield* fail("configuration", "Graph page size must be between 1 and 1000");
        const cursor = request.cursor ?? "";
        const from = Math.floor(request.from / 1_000);
        const to = Math.ceil(request.to / 1_000);
        const graphql =
          request.entityKind === "swaps"
            ? SWAP_QUERY
            : request.entityKind === "hour"
              ? HOUR_QUERY
              : DAY_QUERY;
        const data = yield* query(request.source.subgraphId, graphql, {
          pool: request.poolAddress,
          block: request.snapshotBlock.number,
          from: request.entityKind === "swaps" ? String(from) : from,
          to: request.entityKind === "swaps" ? String(to) : to,
          cursor,
          first,
        });
        const meta = yield* Effect.try({
          try: () => parseMeta(data),
          catch: (error) => error as GraphDataError,
        });
        if (
          meta.deployment !== request.source.deployment ||
          meta.block.number !== request.snapshotBlock.number ||
          meta.block.hash !== request.snapshotBlock.hash
        ) {
          return yield* fail("indexing", "Subgraph deployment or snapshot block changed");
        }
        const tokens = yield* Effect.try({
          try: () => parsePool(data, request.source),
          catch: (error) => error as GraphDataError,
        });
        const field =
          request.entityKind === "swaps"
            ? "swaps"
            : request.entityKind === "hour"
              ? "poolHourDatas"
              : "poolDayDatas";
        const rawRows = list(data[field]);
        if (!rawRows)
          return yield* fail(
            "schema_mismatch",
            "Subgraph did not return the requested entity collection",
          );
        const rows = yield* Effect.try({
          try: (): ReadonlyArray<ResearchPriceSample | ResearchCandle> =>
            rawRows.flatMap((value): Array<ResearchPriceSample | ResearchCandle> => {
              const raw = record(value);
              const id = string(raw?.id);
              const timeField =
                request.entityKind === "swaps"
                  ? "timestamp"
                  : request.entityKind === "hour"
                    ? "periodStartUnix"
                    : "date";
              const atSeconds = integer(raw?.[timeField]);
              if (!raw || !id || atSeconds === null)
                throw fail("schema_mismatch", "Graph entity has invalid ID or timestamp");
              const at = atSeconds * 1_000;
              if (at < request.from || at >= request.to) return [];
              if (request.entityKind === "swaps") {
                const transaction = record(raw.transaction);
                const transactionId = string(transaction?.id);
                const blockNumber = integer(transaction?.blockNumber);
                const logIndex = integer(raw.logIndex);
                if (
                  !transactionId ||
                  blockNumber === null ||
                  logIndex === null ||
                  !string(raw.sqrtPriceX96)
                )
                  throw fail("schema_mismatch", "Swap entity is missing price provenance");
                return [
                  {
                    id,
                    at,
                    price: normalizeGraphSwapPrice({
                      sqrtPriceX96: raw.sqrtPriceX96 as string,
                      ...tokens,
                      baseTokenAddress: request.source.baseTokenAddress,
                      quoteTokenAddress: request.source.quoteTokenAddress,
                    }),
                    blockNumber,
                    transactionId,
                    logIndex,
                  },
                ];
              }
              if (
                ![raw.open, raw.high, raw.low, raw.close].every((item) => typeof item === "string")
              )
                throw fail("schema_mismatch", "Graph OHLC fields are missing");
              const invert = request.source.baseTokenAddress === tokens.token0.address;
              const ohlc = normalizeGraphOhlc(
                raw as { open: string; high: string; low: string; close: string },
                invert,
              );
              const duration = request.entityKind === "hour" ? 3_600_000 : 86_400_000;
              return [
                {
                  id,
                  from: at,
                  to: at + duration,
                  resolution: request.entityKind === "hour" ? ("1h" as const) : ("1d" as const),
                  ...ohlc,
                },
              ];
            }),
          catch: (error) =>
            Schema.is(GraphDataError)(error)
              ? error
              : fail("schema_mismatch", "Graph entity could not be normalized"),
        });
        const last = rawRows.length > 0 ? string(record(rawRows[rawRows.length - 1])?.id) : null;
        const hasMore = rawRows.length === first;
        return {
          entityKind: request.entityKind,
          rows,
          nextCursor: hasMore ? last : null,
          progress: { rowsReturned: rows.length, hasMore, snapshotBlock: request.snapshotBlock },
        };
      }),
  };
}

export const GraphHistoricalDataLive: Layer.Layer<GraphHistoricalData> = Layer.succeed(
  GraphHistoricalData,
  makeGraphHistoricalData(),
);
