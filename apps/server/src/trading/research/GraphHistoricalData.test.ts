import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";

import { makeGraphHistoricalData, UNISWAP_V3_ETHEREUM_SUBGRAPH_ID } from "./GraphHistoricalData.ts";

const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const POOL = "0x8ad599c3a0ff1de082011efddc58f1908eb6e6d8";
const config = {
  subgraphId: UNISWAP_V3_ETHEREUM_SUBGRAPH_ID,
  poolAddress: POOL,
  baseTokenAddress: WETH,
  quoteTokenAddress: USDC,
  feeTier: "3000",
  requiredFrom: 1_700_000_000_000,
  requiredTo: 1_700_010_000_000,
} as const;

const metadata = {
  data: {
    _meta: {
      deployment: "QmDeployment",
      block: { number: 19_000_000, hash: "0xabc", timestamp: 1_700_020_000 },
      hasIndexingErrors: false,
    },
    pool: {
      id: POOL,
      feeTier: "3000",
      createdAtTimestamp: "1600000000",
      token0: { id: USDC, symbol: "USDC", decimals: "6" },
      token1: { id: WETH, symbol: "WETH", decimals: "18" },
    },
    firstSwap: [{ id: "first", timestamp: "1600000001" }],
    lastSwap: [{ id: "last", timestamp: "1700020000" }],
    firstHour: [{ id: "first-hour", periodStartUnix: 1600000000 }],
    lastHour: [{ id: "last-hour", periodStartUnix: 1700020000 }],
    firstDay: [{ id: "first-day", date: 1600000000 }],
    lastDay: [{ id: "last-day", date: 1700020000 }],
  },
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("GraphHistoricalData", () => {
  it("refuses absent configuration without issuing a request", async () => {
    let calls = 0;
    const graph = makeGraphHistoricalData({
      env: {},
      fetch: async () => {
        calls++;
        return response(metadata);
      },
    });
    const result = await Effect.runPromise(Effect.result(graph.inspectSource(config)));
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure.reason).toBe("configuration");
    expect(calls).toBe(0);
  });

  it("checks deployment, token addresses, decimals, fee and coverage", async () => {
    const graph = makeGraphHistoricalData({
      env: { T3_GRAPH_API_KEY: "secret" },
      fetch: async () => response(metadata),
    });
    const capability = await Effect.runPromise(graph.inspectSource(config));
    expect(capability.source.deployment).toBe("QmDeployment");
    expect(capability.token0.decimals).toBe(6);
    expect(capability.coverage.swaps.firstAt).toBe(1_600_000_001_000);
    expect(capability.snapshotBlock.hash).toBe("0xabc");
  });

  it("refuses a different subgraph ID and wrong pool token metadata", async () => {
    const graph = makeGraphHistoricalData({
      env: { T3_GRAPH_API_KEY: "secret" },
      fetch: async () => response(metadata),
    });
    const wrongDeployment = await Effect.runPromise(
      Effect.result(graph.inspectSource({ ...config, subgraphId: "other" })),
    );
    expect(wrongDeployment._tag).toBe("Failure");
    if (wrongDeployment._tag === "Failure")
      expect(wrongDeployment.failure.reason).toBe("configuration");
    const wrongTokenGraph = makeGraphHistoricalData({
      env: { T3_GRAPH_API_KEY: "secret" },
      fetch: async () =>
        response({
          data: {
            ...metadata.data,
            pool: {
              ...metadata.data.pool,
              token1: { id: "0xwrong", symbol: "WETH", decimals: "18" },
            },
          },
        }),
    });
    const wrongToken = await Effect.runPromise(
      Effect.result(wrongTokenGraph.inspectSource(config)),
    );
    expect(wrongToken._tag).toBe("Failure");
    if (wrongToken._tag === "Failure") expect(wrongToken.failure.reason).toBe("schema_mismatch");
  });

  it("refuses a stale deployment and an absent pool", async () => {
    for (const data of [
      {
        ...metadata.data,
        _meta: {
          ...metadata.data._meta,
          block: { ...metadata.data._meta.block, timestamp: 1_600_000_000 },
        },
      },
      { ...metadata.data, pool: null },
    ]) {
      const graph = makeGraphHistoricalData({
        env: { T3_GRAPH_API_KEY: "secret" },
        fetch: async () => response({ data }),
      });
      const result = await Effect.runPromise(Effect.result(graph.inspectSource(config)));
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(["indexing", "coverage"]).toContain(result.failure.reason);
    }
  });

  it("classifies HTTP 200 GraphQL indexing errors and hides the credential", async () => {
    const secret = "sensitive-key";
    const graph = makeGraphHistoricalData({
      env: { T3_GRAPH_API_KEY: secret },
      fetch: async () =>
        response({ data: metadata.data, errors: [{ message: `indexing_error ${secret}` }] }),
    });
    const result = await Effect.runPromise(Effect.result(graph.inspectSource(config)));
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure.reason).toBe("indexing");
      expect(JSON.stringify(result.failure)).not.toContain(secret);
    }
  });

  it("classifies a GraphQL authentication error without exposing the credential in the URL", async () => {
    const secret = "sensitive-key";
    let requestUrl = "";
    let authorization = "";
    const graph = makeGraphHistoricalData({
      env: { T3_GRAPH_API_KEY: secret },
      fetch: async (url, init) => {
        requestUrl = String(url);
        authorization = new Headers(init?.headers).get("authorization") ?? "";
        return response({ errors: [{ message: `auth error: malformed API key ${secret}` }] });
      },
    });
    const result = await Effect.runPromise(Effect.result(graph.inspectSource(config)));
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure.reason).toBe("authentication");
      expect(JSON.stringify(result.failure)).not.toContain(secret);
    }
    expect(requestUrl).not.toContain(secret);
    expect(authorization).toBe(`Bearer ${secret}`);
  });

  it("distinguishes authentication, rate limit, and a missing aggregate entity", async () => {
    for (const [status, reason] of [
      [401, "authentication"],
      [429, "rate_limit"],
    ] as const) {
      const graph = makeGraphHistoricalData({
        env: { T3_GRAPH_API_KEY: "secret" },
        fetch: async () => response({}, status),
      });
      const result = await Effect.runPromise(Effect.result(graph.inspectSource(config)));
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure.reason).toBe(reason);
    }
    const graph = makeGraphHistoricalData({
      env: { T3_GRAPH_API_KEY: "secret" },
      fetch: async () => response({ data: { ...metadata.data, firstHour: [] } }),
    });
    const result = await Effect.runPromise(Effect.result(graph.inspectSource(config)));
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure.reason).toBe("coverage");
  });

  it("refuses a snapshot hash change instead of mixing page provenance", async () => {
    let calls = 0;
    const graph = makeGraphHistoricalData({
      env: { T3_GRAPH_API_KEY: "secret" },
      fetch: async () => {
        calls++;
        return response({
          data:
            calls === 1
              ? metadata.data
              : {
                  _meta: {
                    ...metadata.data._meta,
                    block: { ...metadata.data._meta.block, hash: "0xdifferent" },
                  },
                  pool: metadata.data.pool,
                  swaps: [],
                },
        });
      },
    });
    const capability = await Effect.runPromise(graph.inspectSource(config));
    const result = await Effect.runPromise(
      Effect.result(
        graph.readWindow({
          source: capability.source,
          poolAddress: POOL,
          snapshotBlock: capability.snapshotBlock,
          from: config.requiredFrom,
          to: config.requiredTo,
          entityKind: "swaps",
        }),
      ),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure.reason).toBe("indexing");
  });

  it("reads a half-open paged swap window at the inspected snapshot", async () => {
    const queries: string[] = [];
    const graph = makeGraphHistoricalData({
      env: { T3_GRAPH_API_KEY: "secret" },
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { query: string };
        queries.push(body.query);
        if (queries.length === 1) return response(metadata);
        return response({
          data: {
            _meta: metadata.data._meta,
            pool: metadata.data.pool,
            swaps: [
              {
                id: "a",
                timestamp: "1700000001",
                sqrtPriceX96: (2n ** 96n * 1_000_000n).toString(),
                logIndex: "1",
                transaction: { id: "0xtx", blockNumber: "18000000" },
              },
            ],
          },
        });
      },
    });
    const capability = await Effect.runPromise(graph.inspectSource(config));
    const page = await Effect.runPromise(
      graph.readWindow({
        source: capability.source,
        poolAddress: POOL,
        snapshotBlock: capability.snapshotBlock,
        from: 1_700_000_000_000,
        to: 1_700_010_000_000,
        entityKind: "swaps",
        pageSize: 1,
      }),
    );
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0] && "price" in page.rows[0] ? page.rows[0].price : null).toBeCloseTo(1, 12);
    expect(page.nextCursor).toBe("a");
    expect(queries[1]).toContain("timestamp_lt");
  });
});
