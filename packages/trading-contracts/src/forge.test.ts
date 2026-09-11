/**
 * What the Forge contracts claim, held to arithmetic and validation.
 *
 * The price fixtures here are hand-derived from the Uniswap v3 fixed-point
 * definition (`sqrtPriceX96 = sqrt(rawPrice) * 2^96`), not copied from the
 * adapter: if the normalization in `GraphSource` disagreed with these
 * numbers, the disagreement would be the bug, not the test.
 */
import { assert, describe, it } from "@effect/vitest";
import { Schema } from "effect";

import {
  capSeriesPoints,
  ForgeEvidenceRecord,
  ForgeEvaluation,
  ForgeExactRatio,
  forgeExactQuotePerBase,
  forgeQuoteVolume,
  forgeRatioMicros,
  ForgeJob,
  ForgePolicy,
  ForgePoolIdentity,
  ForgePoolSeries,
  ForgeSourceConfig,
  ForgeSourceHealth,
  ForgeSourceListing,
  ForgeSwapObservation,
  forgeSeriesGaps,
  ForgeWindowFetch,
  FORGE_HOOK_BASELINE_FEE,
  FORGE_MAX_SERIES_POINTS,
} from "./forge.ts";

const rejects = (decode: (value: unknown) => unknown, value: unknown): void => {
  assert.throws(() => decode(value));
};
const accepts = (decode: (value: unknown) => unknown, value: unknown): void => {
  decode(value);
};

const decodePoolIdentity = Schema.decodeUnknownSync(ForgePoolIdentity);
const decodeSourceConfig = Schema.decodeUnknownSync(ForgeSourceConfig);
const decodeExactRatio = Schema.decodeUnknownSync(ForgeExactRatio);
const decodeSwapObservation = Schema.decodeUnknownSync(ForgeSwapObservation);
const decodeWindowFetch = Schema.decodeUnknownSync(ForgeWindowFetch);
const decodeSourceHealth = Schema.decodeUnknownSync(ForgeSourceHealth);
const decodeEvidenceRecord = Schema.decodeUnknownSync(ForgeEvidenceRecord);
const decodeEvaluation = Schema.decodeUnknownSync(ForgeEvaluation);
const decodeJob = Schema.decodeUnknownSync(ForgeJob);
const decodePolicy = Schema.decodeUnknownSync(ForgePolicy);
const decodePoolSeries = Schema.decodeUnknownSync(ForgePoolSeries);
const decodeSourceListing = Schema.decodeUnknownSync(ForgeSourceListing);

// 2^96, the fixed-point shift inside sqrtPriceX96.
const Q96 = 1n << 96n;

/** The canonical USDC/WETH 0.05% pool: USDC sorts before WETH, so WETH is token1. */
const USDC_WETH_005 = {
  chain: "ethereum-mainnet",
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
} as const;

const sourceConfig = {
  kind: "uniswap-v3-graph",
  endpoint: "https://api.thegraph.com/subgraphs/id/5zNtXvLgpjH4Bt5nxQsHJ6TB2v5egTYqprKrzgAQybyo",
  deployment: "5zNtXvLgpjH4Bt5nxQsHJ6TB2v5egTYqprKrzgAQybyo",
  indexingEndpoint: "https://api.thegraph.com/indexing/graphql",
  pools: [USDC_WETH_005],
  maxLagBlocks: 40,
  pageSize: 1000,
  maxSwapsPerFetch: 5000,
} as const;

const observation = {
  chain: "ethereum-mainnet",
  poolId: USDC_WETH_005.poolId,
  observationId: "0x" + "ab".repeat(32) + ":7",
  transactionHash: "0x" + "ab".repeat(32),
  logIndex: 7,
  timestamp: 1_775_700_000,
  sender: "0x" + "11".repeat(20),
  recipient: "0x" + "22".repeat(20),
  amount0: "-2500000000",
  amount1: "1310000000000000000",
  sqrtPriceX96: "1985512970987355783429021034536192",
  tick: -196204,
  baseIsToken1: true,
  priceQuotePerBase: { numerator: "1946487500000000000000000000", denominator: "9799000000000" },
  priceQuotePerBaseMicros: 198_638_010_022,
  quoteVolumeRaw: "2500000000",
  quoteVolumeMicros: 2_500_000_000,
} as const;

// ---------------------------------------------------------------------------
// Exact normalization
// ---------------------------------------------------------------------------

describe("forgeExactQuotePerBase", () => {
  it("derives quote-per-base exactly for a WETH-is-token1 pool", () => {
    // raw price = m^2 token1 per token0; human WETH-per-USDC = m^2 * 10^(6-18).
    // m = 10^5 → 0.01 WETH per USDC → exactly 100 USDC per WETH.
    const sqrt = (100_000n * Q96).toString(10);
    const ratio = forgeExactQuotePerBase({
      sqrtPriceX96: sqrt,
      token0Decimals: 6,
      token1Decimals: 18,
      baseIsToken1: true,
    });
    assert.isNotNull(ratio);
    // 2^192 * 10^12 / (10^10 * 2^192) reduces to exactly 100/1.
    assert.equal(ratio!.numerator, "100");
    assert.equal(ratio!.denominator, "1");
    assert.equal(forgeRatioMicros(ratio!), 100_000_000);
  });

  it("derives quote-per-base directly when the base is token0", () => {
    // s = 2^96 → raw price exactly 1; decimals 12 vs 6 → human 10^6.
    const ratio = forgeExactQuotePerBase({
      sqrtPriceX96: Q96.toString(10),
      token0Decimals: 12,
      token1Decimals: 6,
      baseIsToken1: false,
    });
    assert.isNotNull(ratio);
    assert.equal(ratio!.numerator, (10n ** 6n).toString(10));
    assert.equal(ratio!.denominator, "1");
    assert.equal(forgeRatioMicros(ratio!), 1_000_000_000_000);
  });

  it("returns null for zero, negative, or non-integer sqrtPriceX96", () => {
    for (const bad of ["0", "-5", "1.5", "abc", ""]) {
      assert.isNull(
        forgeExactQuotePerBase({
          sqrtPriceX96: bad,
          token0Decimals: 6,
          token1Decimals: 18,
          baseIsToken1: true,
        }),
        `sqrtPriceX96=${JSON.stringify(bad)} must not normalize`,
      );
    }
  });

  it("keeps a negative decimal exponent exact, in the denominator", () => {
    // base token0 (18) against quote token1 (6): human = raw * 10^12.
    // raw = (10^6)^2 = 10^12 → human = 10^24, no floats anywhere.
    const sqrt = (1_000_000n * Q96).toString(10);
    const ratio = forgeExactQuotePerBase({
      sqrtPriceX96: sqrt,
      token0Decimals: 18,
      token1Decimals: 6,
      baseIsToken1: false,
    });
    assert.isNotNull(ratio);
    assert.equal(ratio!.numerator, (10n ** 24n).toString(10));
    assert.equal(ratio!.denominator, "1");
  });

  it("inverts the exact fraction when WETH is token1", () => {
    // WETH is token1: human ratio is WETH-per-USDC; quote-per-base inverts.
    // Choose raw = (2*10^9)^2 → WETH-per-USDC = 4*10^18 * 10^-12 = 4*10^6,
    // so quote-per-base = 1/(4*10^6) = 1/4000000 exactly.
    const sqrt = (2_000_000_000n * Q96).toString(10);
    const ratio = forgeExactQuotePerBase({
      sqrtPriceX96: sqrt,
      token0Decimals: 6,
      token1Decimals: 18,
      baseIsToken1: true,
    });
    assert.isNotNull(ratio);
    assert.equal(ratio!.numerator, "1");
    assert.equal(ratio!.denominator, "4000000");
    assert.equal(forgeRatioMicros(ratio!), 0);
  });
});

describe("forgeRatioMicros", () => {
  it("floors at the micro, never rounds up", () => {
    assert.equal(forgeRatioMicros({ numerator: "1", denominator: "3" }), 333_333);
    assert.equal(forgeRatioMicros({ numerator: "2", denominator: "3" }), 666_666);
  });

  it("is zero for a non-positive part, not a division by zero", () => {
    assert.equal(forgeRatioMicros({ numerator: "1", denominator: "0" }), 0);
    assert.equal(forgeRatioMicros({ numerator: "0", denominator: "5" }), 0);
  });
});

describe("forgeQuoteVolume", () => {
  it("takes the absolute USDC leg regardless of sign", () => {
    const sold = forgeQuoteVolume({
      amount0: "-2500000000",
      amount1: "1310000000000000000",
      quoteIsToken1: false,
      quoteDecimals: 6,
    });
    assert.isNotNull(sold);
    assert.equal(sold!.quoteVolumeRaw, "2500000000");
    assert.equal(sold!.quoteVolumeMicros, 2_500_000_000);

    const bought = forgeQuoteVolume({
      amount0: "1250000",
      amount1: "-655000000000000000",
      quoteIsToken1: false,
      quoteDecimals: 6,
    });
    assert.isNotNull(bought);
    assert.equal(bought!.quoteVolumeRaw, "1250000");
    assert.equal(bought!.quoteVolumeMicros, 1_250_000);
  });

  it("scales a quote token with other decimals exactly", () => {
    const volume = forgeQuoteVolume({
      amount0: "1",
      amount1: "1",
      quoteIsToken1: true,
      quoteDecimals: 18,
    });
    assert.isNotNull(volume);
    // 1 raw unit at 18 decimals is a fraction of a micro; floor, not round.
    assert.equal(volume!.quoteVolumeMicros, 0);
    assert.equal(volume!.quoteVolumeRaw, "1");
  });

  it("returns null for a malformed leg", () => {
    assert.isNull(
      forgeQuoteVolume({
        amount0: "1.5",
        amount1: "1",
        quoteIsToken1: false,
        quoteDecimals: 6,
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Series assembly
// ---------------------------------------------------------------------------

describe("forgeSeriesGaps", () => {
  const domain = { start: 0, end: 1000 };

  it("names every span longer than the bound, edges included", () => {
    const gaps = forgeSeriesGaps(
      [{ t: 100 }, { t: 400 }, { t: 500 }],
      domain.start,
      domain.end,
      200,
    );
    assert.deepEqual(gaps, [
      { fromUtcMs: 100_000, toUtcMs: 400_000 },
      { fromUtcMs: 500_000, toUtcMs: 1_000_000 },
    ]);
  });

  it("reports a fully empty domain as one gap, not silence", () => {
    const gaps = forgeSeriesGaps([], domain.start, domain.end, 60);
    assert.deepEqual(gaps, [{ fromUtcMs: 0, toUtcMs: 1_000_000 }]);
  });

  it("reports no gap for a dense series", () => {
    const points = Array.from({ length: 11 }, (_, i) => ({ t: i * 100 }));
    assert.deepEqual(forgeSeriesGaps(points, 0, 1000, 100), []);
  });
});

describe("capSeriesPoints", () => {
  it("keeps the newest points under the cap and never interpolates", () => {
    const points = [1, 2, 3, 4, 5].map((t) => ({ t }));
    assert.deepEqual(capSeriesPoints(points, 3), [{ t: 3 }, { t: 4 }, { t: 5 }]);
  });

  it("returns a series already under the cap untouched", () => {
    const points = [{ t: 1 }, { t: 2 }];
    assert.deepEqual(capSeriesPoints(points, FORGE_MAX_SERIES_POINTS), points);
  });
});

// ---------------------------------------------------------------------------
// Schema validation — every schema, accept and reject
// ---------------------------------------------------------------------------

describe("ForgePoolIdentity", () => {
  it("accepts the canonical 0.05% pool", () => accepts(decodePoolIdentity, USDC_WETH_005));

  it("rejects a negative-decimal token and a wrong-chain pool", () => {
    rejects(decodePoolIdentity, {
      ...USDC_WETH_005,
      token0: { ...USDC_WETH_005.token0, decimals: -1 },
    });
    rejects(decodePoolIdentity, { ...USDC_WETH_005, chain: "sepolia" });
  });
});

describe("ForgeSourceConfig", () => {
  it("accepts a complete host configuration", () => accepts(decodeSourceConfig, sourceConfig));

  it("rejects four pools, zero pools, plain-http endpoints, and out-of-range knobs", () => {
    const pool = sourceConfig.pools[0];
    rejects(decodeSourceConfig, {
      ...sourceConfig,
      pools: [pool, pool, pool, { ...pool, poolId: "0x1" }],
    });
    rejects(decodeSourceConfig, { ...sourceConfig, pools: [] });
    rejects(decodeSourceConfig, { ...sourceConfig, endpoint: "http://insecure.example" });
    rejects(decodeSourceConfig, { ...sourceConfig, pageSize: 1001 });
    rejects(decodeSourceConfig, { ...sourceConfig, maxLagBlocks: 0 });
  });
});

describe("ForgeExactRatio", () => {
  it("accepts positive integer parts", () =>
    accepts(decodeExactRatio, { numerator: "10", denominator: "3" }));

  it("rejects floats, negatives, zero denominators, and empty strings", () => {
    rejects(decodeExactRatio, { numerator: "1.5", denominator: "3" });
    rejects(decodeExactRatio, { numerator: "-1", denominator: "3" });
    rejects(decodeExactRatio, { numerator: "1", denominator: "0" });
    rejects(decodeExactRatio, { numerator: "", denominator: "3" });
  });
});

describe("ForgeSwapObservation", () => {
  it("accepts a normalized real-shaped observation", () =>
    accepts(decodeSwapObservation, observation));

  it("rejects a short transaction hash, negative log index, and fractional timestamps", () => {
    rejects(decodeSwapObservation, { ...observation, transactionHash: "0xabc" });
    rejects(decodeSwapObservation, { ...observation, logIndex: -1 });
    rejects(decodeSwapObservation, { ...observation, timestamp: 1.5 });
  });

  it("rejects float amounts and a negative micro price", () => {
    rejects(decodeSwapObservation, { ...observation, amount0: "1.5" });
    rejects(decodeSwapObservation, { ...observation, priceQuotePerBaseMicros: -1 });
  });
});

describe("ForgeWindowFetch", () => {
  const complete = {
    poolId: USDC_WETH_005.poolId,
    status: "complete",
    pinnedBlock: 22_000_000,
    pinnedBlockHash: "0x" + "cd".repeat(32),
    deployment: sourceConfig.deployment,
    fetchedAtMs: 1_775_700_500_000,
    window: { startedAt: 1_775_699_000, endedAt: 1_775_700_000 },
    historical: false,
    observations: [observation],
    anchorCoverage: "covered",
    anchorCandidates: [
      {
        observation: { ...observation, observationId: "0x" + "ab".repeat(32) + ":3", logIndex: 3 },
        ageBeforeWindowSeconds: 42,
      },
    ],
    lagBlocks: 2,
    duplicatesDropped: 1,
    sourceDigest: "a".repeat(64),
  } as const;

  it("accepts a complete fetch with anchor candidates", () => accepts(decodeWindowFetch, complete));

  it("accepts an honest empty fetch and an unavailable one with its reason", () => {
    accepts(decodeWindowFetch, {
      ...complete,
      status: "empty",
      observations: [],
      anchorCoverage: "missing",
      anchorCandidates: [],
    });
    accepts(decodeWindowFetch, {
      poolId: complete.poolId,
      status: "unavailable",
      reason: "graph endpoint unreachable",
      fetchedAtMs: complete.fetchedAtMs,
      historical: false,
    });
  });

  it("rejects a stale or unavailable fetch that will not say why", () => {
    rejects(decodeWindowFetch, { ...complete, status: "stale", reason: undefined });
    rejects(decodeWindowFetch, { ...complete, status: "unavailable", reason: undefined });
  });

  it("rejects a non-positive pinned block and a bad status", () => {
    rejects(decodeWindowFetch, { ...complete, pinnedBlock: 0 });
    rejects(decodeWindowFetch, { ...complete, status: "partial" });
  });
});

describe("ForgeSourceHealth", () => {
  it("accepts healthy and stale probes", () => {
    accepts(decodeSourceHealth, {
      status: "healthy",
      latestBlock: 22_000_000,
      chainHeadBlock: 22_000_002,
      lagBlocks: 2,
      probedAtMs: 1_775_700_500_000,
    });
    accepts(decodeSourceHealth, {
      status: "stale",
      reason: "indexed head 120 blocks behind chain head",
      probedAtMs: 1_775_700_500_000,
    });
  });

  it("rejects a missing probe time and an unknown status", () => {
    rejects(decodeSourceHealth, { status: "healthy" });
    rejects(decodeSourceHealth, { status: "degraded", probedAtMs: 1 });
  });
});

describe("ForgeEvidenceRecord", () => {
  const record = {
    evidenceId: "forge_ev_1",
    environmentId: "env_local",
    poolId: USDC_WETH_005.poolId,
    historical: true,
    endpoint: sourceConfig.endpoint,
    deployment: sourceConfig.deployment,
    pinnedBlock: 22_000_000,
    windowStart: 1_775_699_000,
    windowEnd: 1_775_700_000,
    fetchedAtMs: 1_775_700_500_000,
    digest: "b".repeat(64),
    observationCount: 1,
  } as const;

  it("accepts a retained historical evidence row", () => accepts(decodeEvidenceRecord, record));

  it("rejects a non-positive pinned block and an empty digest", () => {
    rejects(decodeEvidenceRecord, { ...record, pinnedBlock: 0 });
    rejects(decodeEvidenceRecord, { ...record, digest: "" });
  });
});

describe("ForgeEvaluation", () => {
  const evaluation = {
    evaluationId: "forge_eval_1",
    environmentId: "env_local",
    threadId: "thread_1",
    capabilityId: "forge-coordination-detector",
    capabilityVersion: 1,
    observationChain: "ethereum-mainnet",
    executionChain: "sepolia",
    window: { startedAt: 1_775_699_000, endedAt: 1_775_700_000 },
    historical: true,
    pinnedBlock: 22_000_000,
    sourceDigest: "c".repeat(64),
    evidenceIds: ["forge_ev_1"],
    status: "complete",
    createdAtMs: 1_775_700_600_000,
    completedAtMs: 1_775_700_601_000,
  } as const;

  it("accepts a completed evaluation with environment and thread identity", () =>
    accepts(decodeEvaluation, evaluation));

  it("accepts an environment-scoped evaluation without a thread", () =>
    accepts(decodeEvaluation, { ...evaluation, threadId: undefined }));

  it("rejects swapped chain labels and an unknown status", () => {
    rejects(decodeEvaluation, { ...evaluation, observationChain: "sepolia" });
    rejects(decodeEvaluation, { ...evaluation, executionChain: "ethereum-mainnet" });
    rejects(decodeEvaluation, { ...evaluation, status: "installed" });
  });
});

describe("ForgeJob", () => {
  it("accepts a queued build job and a cancelled one with its detail", () => {
    accepts(decodeJob, {
      jobId: "forge_job_1",
      kind: "build",
      status: "queued",
      environmentId: "env_local",
      createdAtMs: 1,
    });
    accepts(decodeJob, {
      jobId: "forge_job_1",
      kind: "policy-publication",
      status: "cancelled",
      environmentId: "env_local",
      createdAtMs: 1,
      detail: "cancelled by user before broadcast",
    });
  });

  it("rejects an unknown kind and status", () => {
    rejects(decodeJob, {
      jobId: "j",
      kind: "deploy",
      status: "queued",
      environmentId: "e",
      createdAtMs: 1,
    });
    rejects(decodeJob, {
      jobId: "j",
      kind: "build",
      status: "paused",
      environmentId: "e",
      createdAtMs: 1,
    });
  });
});

describe("ForgePolicy", () => {
  const policy = {
    policyId: "forge_policy_1",
    environmentId: "env_local",
    executionChain: "sepolia",
    detectionFeeHundredthsBps: 500,
    status: "confirmed",
    sourceEvaluationId: "forge_eval_1",
    observationDigest: "d".repeat(64),
    expiresAtUnix: 1_775_786_000,
    publishedAtMs: 1_775_700_700_000,
    txHash: "0x" + "ef".repeat(32),
    createdAtMs: 1_775_700_650_000,
  } as const;

  it("accepts a confirmed policy and carries the baseline as 3000", () => {
    accepts(decodePolicy, policy);
    assert.equal(FORGE_HOOK_BASELINE_FEE, 3000);
  });

  it("accepts the other fixed fee the hook allows", () =>
    accepts(decodePolicy, { ...policy, detectionFeeHundredthsBps: 3000 }));

  it("rejects a fee the fixed hook cannot apply and a mainnet execution label", () => {
    rejects(decodePolicy, { ...policy, detectionFeeHundredthsBps: 700 });
    rejects(decodePolicy, { ...policy, detectionFeeHundredthsBps: 30 });
    rejects(decodePolicy, { ...policy, executionChain: "ethereum-mainnet" });
  });
});

describe("ForgePoolSeries", () => {
  const series = {
    poolId: USDC_WETH_005.poolId,
    chain: "ethereum-mainnet",
    quoteUnits: "USDC-per-WETH",
    domainUtcMs: { start: 1_775_699_000_000, end: 1_775_700_000_000 },
    maxPoints: 720,
    points: [
      {
        t: 1_775_699_100,
        priceQuotePerBaseMicros: 198_638_010_022,
        quoteVolumeMicros: 2_500_000_000,
        observationId: observation.observationId,
      },
    ],
    anchor: {
      status: "covered",
      observationId: "0x" + "ab".repeat(32) + ":3",
      priceQuotePerBaseMicros: 198_638_000_000,
      ageBeforeWindowSeconds: 42,
    },
    anchorCandidates: [
      {
        observationId: "0x" + "ab".repeat(32) + ":3",
        priceQuotePerBaseMicros: 198_638_000_000,
        quoteVolumeMicros: 900_000,
        ageBeforeWindowSeconds: 42,
      },
      {
        observationId: "0x" + "ab".repeat(32) + ":5",
        priceQuotePerBaseMicros: 198_638_010_000,
        quoteVolumeMicros: 250_000_000,
        ageBeforeWindowSeconds: 30,
      },
    ],
    gaps: [{ fromUtcMs: 1_775_699_500_000, toUtcMs: 1_775_699_900_000 }],
    coverage: {
      firstObservedUnixSeconds: 1_775_699_100,
      lastObservedUnixSeconds: 1_775_699_100,
    },
    provenance: {
      deployment: sourceConfig.deployment,
      pinnedBlock: 22_000_000,
      sourceDigest: "e".repeat(64),
      fetchedAtMs: 1_775_700_500_000,
    },
    health: { status: "healthy", probedAtMs: 1_775_700_500_000 },
  } as const;

  it("accepts a provenance-complete series", () => accepts(decodePoolSeries, series));

  it("accepts an anchorless series when the pre-window buffer was empty", () =>
    accepts(decodePoolSeries, { ...series, anchor: { status: "missing" } }));

  it("rejects an inverted UTC domain and a foreign quote unit", () => {
    rejects(decodePoolSeries, {
      ...series,
      domainUtcMs: { start: series.domainUtcMs.end, end: series.domainUtcMs.start },
    });
    rejects(decodePoolSeries, { ...series, quoteUnits: "WETH-per-USDC" });
  });
});

describe("ForgeSourceListing", () => {
  it("accepts a listing with config, pools, and health", () =>
    accepts(decodeSourceListing, {
      config: sourceConfig,
      pools: [
        {
          poolId: USDC_WETH_005.poolId,
          label: USDC_WETH_005.label,
          feeTierHundredthsBps: 500,
          quoteUnits: "USDC-per-WETH",
        },
      ],
      health: { status: "healthy", probedAtMs: 1_775_700_500_000 },
    }));

  it("rejects a listing whose health is missing", () =>
    rejects(decodeSourceListing, { config: sourceConfig, pools: [] }));
});
