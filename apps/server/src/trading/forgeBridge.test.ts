/**
 * What the forge bridge claims, held to its contract.
 *
 * The mapping rules under test are the U0 honesty rules: unavailable answers
 * are named states, never zeros; older evidence without diagnostics surfaces
 * `detailUnavailable`; the LP share of a swap fee stays null without
 * transaction-order evidence; expiry judgements stand on chain time alone.
 *
 * The layer graph in every service-backed test contains NO agent-provider
 * service and NO Hyperliquid dependency — the reads and controls here running
 * at all IS the "works with no HL market focus and the provider stopped"
 * proof, by construction.
 *
 * @module forgeBridge.test
 */
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  FORGE_BRIDGE_TX_PAGE,
  FORGE_DETECTOR_SUMMARY_MAX_EVIDENCE,
  type ForgeEvidenceDetail,
} from "@t3tools/contracts";
import type {
  ForgeBuildReceipt,
  ForgeCapabilityCatalogEntry,
  ForgeCapabilityStatus,
  ForgeEvaluationEvidence,
  ForgeSourceListing,
} from "@t3tools/trading-contracts";
import {
  detectorEvaluationId,
  type DetectionResult,
  type DetectorEvaluationRecordV2,
} from "@t3tools/trading-contracts";

import { ForgeCapabilityStore } from "./forge/CapabilityStore.ts";
import { DetectorRunStore } from "./forge/DetectorRunStore.ts";
import {
  ForgeSourceReads,
  type ForgePoolSeriesReadInput,
  type ForgePoolSeriesRead,
  type ForgeSourceListingRead,
} from "./forge/ForgeSourceReads.ts";
import {
  FeePolicyService,
  type ForgeDirectControlsRead,
  type ForgeOperationResult,
  type ForgePolicyStateRead,
  type ForgePoolProposalRead,
  type ForgePositionStateRead,
} from "./forge/FeePolicyService.ts";
import type { ForgeHookState, ForgeIntentRecord } from "./forge/UniswapTestnetAdapter.ts";
import {
  DETECTOR_RUNS_UNWIRED_REASON,
  forgeControlView,
  forgeDetectorControlView,
  forgeEvidenceView,
  forgePoolSeriesView,
  forgePoolStateView,
  forgeThreadContextView,
  mapControlResult,
  mapDetectorEvaluation,
  mapPoolSeriesRead,
  mapPoolState,
  mapPoolStateTransaction,
  pageEvaluations,
} from "./forgeBridge.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const POOL_ID = "0xabc0000000000000000000000000000000000001";

const listing: ForgeSourceListing = {
  config: {
    kind: "uniswap-v3-graph",
    endpoint: "https://graph.example",
    indexingEndpoint: "https://indexing.example",
    deployment: "dep-1",
    pools: [
      {
        chain: "ethereum-mainnet",
        poolId: POOL_ID,
        feeTierHundredthsBps: 5,
        label: "WETH/USDC 0.05%",
        token0: {
          address: "0xweth00000000000000000000000000000000000",
          symbol: "WETH",
          decimals: 18,
        },
        token1: {
          address: "0xusdc00000000000000000000000000000000000",
          symbol: "USDC",
          decimals: 6,
        },
        baseIsToken1: false,
      },
    ],
    maxLagBlocks: 6,
    pageSize: 100,
    maxSwapsPerFetch: 10_000,
  },
  pools: [
    {
      poolId: POOL_ID,
      label: "WETH/USDC 0.05%",
      feeTierHundredthsBps: 5,
      quoteUnits: "USDC-per-WETH",
    },
  ],
  health: { status: "healthy", probedAtMs: 1_700_000_000_000 },
};

const seriesOk: Extract<ForgePoolSeriesRead, { status: "ok" }>["series"] = {
  poolId: POOL_ID,
  chain: "ethereum-mainnet",
  quoteUnits: "USDC-per-WETH",
  domainUtcMs: { start: 1_700_000_000_000, end: 1_700_000_360_000 },
  maxPoints: 720,
  points: [
    {
      t: 1_700_000_000,
      priceQuotePerBaseMicros: 1_000,
      quoteVolumeMicros: 5,
      observationId: "0xtx:0",
    },
  ],
  anchor: { status: "missing" },
  anchorCandidates: [],
  gaps: [{ fromUtcMs: 1_700_000_000_000, toUtcMs: 1_700_000_360_000 }],
  coverage: { firstObservedUnixSeconds: 1_700_000_000, lastObservedUnixSeconds: 1_700_000_000 },
  provenance: { deployment: "dep-1", pinnedBlock: 42, fetchedAtMs: 1_700_000_360_001 },
  health: { status: "stale", reason: "indexed head lags", probedAtMs: 1_700_000_360_001 },
};

const intentRecord = (
  index: number,
  overrides: Partial<ForgeIntentRecord> = {},
): ForgeIntentRecord => ({
  intentId: `forge_intent_${index}`,
  idempotencyKey: `pause:env:${index}`,
  kind: "pause",
  environmentId: "env-1",
  createdAtMs: 1_700_000_000_000 + index,
  unsigned: {
    chainId: 11_155_111,
    to: "0xhook0000000000000000000000000000000000ff",
    data: "0xabc",
    valueWei: "0",
  },
  spend: {},
  status: "draft",
  gasAccounted: false,
  params: {},
  summary: "pause the forge hook",
  ...overrides,
});

const hookState = (overrides: Partial<ForgeHookState> = {}): ForgeHookState => ({
  hookAddress: "0xhook0000000000000000000000000000000000ff",
  chainId: 11_155_111,
  boundPoolId: "0xbound",
  policy: { revision: "3", expiryUnix: "1775700900", evidenceDigest: "0xcdcd" },
  policyActive: true,
  paused: false,
  owner: "0xowner",
  operator: "0xoperator",
  effectiveFeeHundredthsBps: 500,
  beforeSwapFeeOverrideRaw: "500",
  baselineFeeHundredthsBps: 3000,
  policyFeeHundredthsBps: 500,
  asOfBlockNumber: 7_500_000,
  asOfBlockTimestampUnix: 1_775_700_000,
  fetchedAtMs: 1_775_700_001,
  ...overrides,
});

const unconfiguredPolicyState: ForgePolicyStateRead = {
  status: "unavailable",
  reason: "forge sepolia target not configured",
  local: { policy: null, pendingConfirmation: false, lastIntentId: null },
  chain: { snapshot: null, stale: null },
  moduleHash: { installed: null, confirmedOnChain: null, match: null },
  effectiveFeeHundredthsBps: null,
};

const grantMissingProposal: ForgePoolProposalRead = {
  status: "ok",
  target: {
    chainId: 11_155_111,
    chainName: "sepolia",
    addresses: {
      hook: "0xhook0000000000000000000000000000000000ff",
      poolManager: "0xpm00000000000000000000000000000000000ff",
      positionManager: "0xptm000000000000000000000000000000000ff",
      swapRoute: "0xsr00000000000000000000000000000000000ff",
    },
    poolKey: {
      currency0: "0xc00000000000000000000000000000000000aa",
      currency1: "0xc10000000000000000000000000000000001aa",
      fee: 500,
      tickSpacing: 60,
      hookAddress: "0xhook0000000000000000000000000000000000ff",
    },
    bindingId: "0xbinding",
    fullPoolId: "0xfullpool",
  },
  grant: { status: "missing", missingReason: "no approved forge spend grant" },
};

const noPositionState: ForgePositionStateRead = {
  status: "ok",
  position: {
    status: "none",
    positionId: null,
    tickLower: null,
    tickUpper: null,
    liquidity: null,
    note: "no liquidity intents recorded",
  },
};

const controlsRead: ForgeDirectControlsRead = {
  localPause: false,
  controls: [
    { name: "pause", availableUnderLocalPause: true, blockedBy: "grant" },
    { name: "unpause", availableUnderLocalPause: false, blockedBy: null },
    { name: "revoke", availableUnderLocalPause: true, blockedBy: "grant" },
    { name: "remove-liquidity", availableUnderLocalPause: true, blockedBy: "grant" },
  ],
  note: "direct controls run without any agent provider",
};

const evaluation = (overrides: Partial<ForgeEvaluationEvidence> = {}): ForgeEvaluationEvidence => ({
  evaluationId: "forge_ev_1",
  environmentId: "env-1",
  capabilityId: "cap-1",
  capabilityVersion: 2,
  bundleSha256: "e".repeat(64),
  window: { startedAt: 1_700_000_000_000, endedAt: 1_700_000_060_000 },
  historical: false,
  evidenceIds: ["forge_ev_src_1"],
  status: "complete",
  createdAtMs: 1_700_000_060_000,
  ...overrides,
});

// ---------------------------------------------------------------------------
// Pure mappers
// ---------------------------------------------------------------------------

describe("mapPoolSeriesRead", () => {
  it.effect("serves an unavailable series as a named state, never zeros", () =>
    Effect.gen(function* () {
      const view = mapPoolSeriesRead({
        status: "unavailable",
        reason: "forge graph source not configured",
      });
      assert.strictEqual(view.status, "unavailable");
    }),
  );

  it.effect("renders the exact domain as ISO instants and keeps stale incomplete", () =>
    Effect.gen(function* () {
      const view = mapPoolSeriesRead({ status: "ok", series: seriesOk });
      assert.strictEqual(view.status, "ok");
      if (view.status !== "ok") return;
      assert.strictEqual(view.domainIso.from, "2023-11-14T22:13:20.000Z");
      // end = start + 360_000 ms (a six-minute window in this fixture).
      assert.strictEqual(view.domainIso.to, "2023-11-14T22:19:20.000Z");
      // A stale source keeps its real points and gaps under complete: false.
      assert.strictEqual(view.complete, false);
      assert.strictEqual(view.series.points.length, 1);
      assert.strictEqual(view.series.gaps.length, 1);
    }),
  );
});

describe("mapPoolStateTransaction", () => {
  it.effect("serves the total swap fee only when exactly one decoded swap matches our pool", () =>
    Effect.gen(function* () {
      const ourPool = "0xfullpool";
      const withSwap = intentRecord(1, {
        receipt: {
          txHash: "0x" + "a".repeat(64),
          status: "confirmed",
          blockNumber: 10,
          gasUsedUnits: "1",
          effectiveGasPriceWei: "1",
          gasCostWei: "1",
          hookEvents: [],
          poolEvents: [
            {
              kind: "Swap",
              blockNumber: 10,
              logIndex: 0,
              txHash: "0x" + "a".repeat(64),
              poolId: "0xFULLPOOL",
              amount0: "-1",
              amount1: "1",
              sqrtPriceX96: "1",
              liquidity: "1",
              tick: 0,
              totalSwapFeeHundredthsBps: 500,
            },
          ],
        },
      });
      const mapped = mapPoolStateTransaction(withSwap, ourPool);
      assert.strictEqual(mapped.totalSwapFeeHundredthsBps, 500);
      // The LP share requires transaction-order evidence; the total alone
      // never establishes a split.
      assert.strictEqual(mapped.lpFeeHundredthsBps, null);
    }),
  );

  it.effect("nulls the fee for foreign pools, undecoded receipts, and ambiguity", () =>
    Effect.gen(function* () {
      const swapTwice = intentRecord(2, {
        receipt: {
          txHash: "0x" + "b".repeat(64),
          status: "confirmed",
          blockNumber: 10,
          gasUsedUnits: "1",
          effectiveGasPriceWei: "1",
          gasCostWei: "1",
          hookEvents: [],
          poolEvents: [
            {
              kind: "Swap",
              blockNumber: 10,
              logIndex: 0,
              txHash: "0x" + "b".repeat(64),
              poolId: "0xfullpool",
              amount0: "-1",
              amount1: "1",
              sqrtPriceX96: "1",
              liquidity: "1",
              tick: 0,
              totalSwapFeeHundredthsBps: 500,
            },
            {
              kind: "Swap",
              blockNumber: 10,
              logIndex: 1,
              txHash: "0x" + "b".repeat(64),
              poolId: "0xfullpool",
              amount0: "-2",
              amount1: "2",
              sqrtPriceX96: "1",
              liquidity: "1",
              tick: 0,
              totalSwapFeeHundredthsBps: 3000,
            },
          ],
        },
      });
      assert.strictEqual(
        mapPoolStateTransaction(swapTwice, "0xfullpool").totalSwapFeeHundredthsBps,
        null,
      );
      assert.strictEqual(
        mapPoolStateTransaction(intentRecord(3), "0xfullpool").totalSwapFeeHundredthsBps,
        null,
      );
      // A foreign pool id: no matching swap, so no fee claim at all.
      const foreign = mapPoolStateTransaction(swapTwice, "0xotherpool");
      assert.strictEqual(foreign.totalSwapFeeHundredthsBps, null);
    }),
  );
});

describe("mapPoolState", () => {
  it.effect("maps the unconfigured target to named unavailable states, grant gap included", () =>
    Effect.gen(function* () {
      const view = mapPoolState({
        proposal: { status: "unavailable", reason: "forge sepolia target not configured" },
        position: noPositionState,
        controls: controlsRead,
        policyState: unconfiguredPolicyState,
        intents: [],
      });
      assert.strictEqual(view.proposal.status, "unavailable");
      assert.strictEqual(view.publication.status, "unavailable");
      assert.strictEqual(view.publication.reason, "forge sepolia target not configured");
      assert.strictEqual(view.chain.snapshot, null);
      assert.strictEqual(view.chain.stale, null);
      assert.strictEqual(view.moduleHash.match, null);
      // No snapshot means no chain-time expiry proof — unknown, never a guess.
      assert.strictEqual(view.freshlyConfirmedExpiry.status, "unknown");
      assert.strictEqual(view.transactions.items.length, 0);
      assert.strictEqual(view.transactions.moreAvailable, false);
    }),
  );

  it.effect("keeps the grant-missing reason and the honest no-position state", () =>
    Effect.gen(function* () {
      const view = mapPoolState({
        proposal: grantMissingProposal,
        position: noPositionState,
        controls: controlsRead,
        policyState: unconfiguredPolicyState,
        intents: [],
      });
      assert.strictEqual(view.proposal.status, "ok");
      if (view.proposal.status !== "ok") return;
      assert.strictEqual(view.proposal.grant.status, "missing");
      assert.strictEqual(view.position.status, "ok");
      if (view.position.status !== "ok") return;
      assert.strictEqual(view.position.position.state, "none");
      assert.strictEqual(view.position.position.note, "no liquidity intents recorded");
    }),
  );

  it.effect("carries the chain snapshot's own block time and expiry judgement", () =>
    Effect.gen(function* () {
      const policyState: ForgePolicyStateRead = {
        status: "ok",
        local: { policy: null, pendingConfirmation: false, lastIntentId: "forge_intent_9" },
        chain: {
          snapshot: hookState({ asOfBlockTimestampUnix: 1_775_700_100 }),
          stale: true,
          staleReason: "snapshot pinned to block 7500000; head is 7500010 (max lag 6)",
        },
        moduleHash: { installed: "e".repeat(64), confirmedOnChain: null, match: null },
        effectiveFeeHundredthsBps: 500,
      };
      const view = mapPoolState({
        proposal: grantMissingProposal,
        position: noPositionState,
        controls: controlsRead,
        policyState,
        intents: [],
      });
      assert.strictEqual(view.chain.snapshot?.asOfBlockNumber, 7_500_000);
      assert.strictEqual(view.chain.stale, true);
      assert.strictEqual(
        view.chain.staleReason,
        "snapshot pinned to block 7500000; head is 7500010 (max lag 6)",
      );
      // Expiry 1775700900 vs chain time 1775700100: expired by chain time only.
      const expiry = view.freshlyConfirmedExpiry;
      assert.strictEqual(expiry.status, "chainConfirmed");
      if (expiry.status !== "chainConfirmed") return;
      assert.strictEqual(expiry.expiryUnix, 1_775_700_900);
      assert.strictEqual(expiry.asOfUnix, 1_775_700_100);
      assert.strictEqual(expiry.expired, false);
    }),
  );

  it.effect("treats a zero expiry as no live policy rather than a confirmed one", () =>
    Effect.gen(function* () {
      const policyState: ForgePolicyStateRead = {
        status: "ok",
        local: { policy: null, pendingConfirmation: false, lastIntentId: null },
        chain: {
          snapshot: hookState({
            policy: { revision: "0", expiryUnix: "0", evidenceDigest: "0x" + "0".repeat(64) },
          }),
          stale: false,
        },
        moduleHash: { installed: null, confirmedOnChain: null, match: null },
        effectiveFeeHundredthsBps: 3000,
      };
      const view = mapPoolState({
        proposal: grantMissingProposal,
        position: noPositionState,
        controls: controlsRead,
        policyState,
        intents: [],
      });
      assert.strictEqual(view.freshlyConfirmedExpiry.status, "unknown");
    }),
  );

  it.effect(`serves the newest ${FORGE_BRIDGE_TX_PAGE} intents and names the rest`, () =>
    Effect.gen(function* () {
      const intents = Array.from({ length: FORGE_BRIDGE_TX_PAGE + 3 }, (_, index) =>
        intentRecord(index),
      );
      const view = mapPoolState({
        proposal: grantMissingProposal,
        position: noPositionState,
        controls: controlsRead,
        policyState: unconfiguredPolicyState,
        intents,
      });
      assert.strictEqual(view.transactions.items.length, FORGE_BRIDGE_TX_PAGE);
      assert.strictEqual(view.transactions.moreAvailable, true);
      assert.strictEqual(view.transactions.items[0]?.intentId, "forge_intent_0");
    }),
  );
});

describe("mapControlResult", () => {
  it.effect("maps a built pause intent and a refusal", () =>
    Effect.gen(function* () {
      const ok = mapControlResult({ status: "ok", record: intentRecord(1) });
      assert.strictEqual(ok.status, "ok");
      if (ok.status !== "ok") return;
      assert.strictEqual(ok.intent.kind, "pause");
      assert.strictEqual(ok.intent.status, "draft");

      const refused = mapControlResult({
        status: "refused",
        reason: "unconfigured",
        detail: "forge sepolia target not configured",
      });
      assert.strictEqual(refused.status, "refused");
      if (refused.status !== "refused") return;
      assert.strictEqual(refused.reason, "unconfigured");
    }),
  );
});

describe("mapDetectorEvaluation", () => {
  /** A committed v2 record whose identity the contract itself would accept. */
  const record = (result: DetectionResult): DetectorEvaluationRecordV2 => {
    const identity = {
      environmentId: "tm_env1",
      capabilityId: "flag-detector",
      version: 2,
      stateRevision: 4,
      inputDigest: "ab".repeat(32),
    };
    return {
      manifestVersion: 2,
      evaluationId: detectorEvaluationId(identity),
      environmentId: identity.environmentId,
      capabilityId: identity.capabilityId,
      version: identity.version,
      stateRevision: identity.stateRevision,
      inputDigest: identity.inputDigest,
      asOfMs: 1_700_000_100_000,
      result,
      state: { stateSchemaVersion: 1, state: { count: 4 } },
      evidenceIds: ["forge_ev_v2_1"],
      committedAtMs: 1_700_000_100_500,
    };
  };

  it.effect("renders the three result shapes with their bounded meaning", () =>
    Effect.gen(function* () {
      const matched = mapDetectorEvaluation(
        record({
          status: "matched",
          occurrenceKey: "occ_flag_1",
          evidenceIds: ["forge_ev_v2_1"],
          facts: [],
          validUntilMs: 1_700_000_400_000,
        }),
        true,
      );
      assert.strictEqual(matched.status, "available");
      if (matched.status !== "available") return;
      assert.deepStrictEqual(matched.result, {
        status: "matched",
        occurrenceKey: "occ_flag_1",
        validUntilMs: 1_700_000_400_000,
      });
      // The run's own clock, the committed revision, and the armed standing
      // ride beside the reading.
      assert.strictEqual(matched.asOfMs, 1_700_000_100_000);
      assert.strictEqual(matched.stateRevision, 4);
      assert.strictEqual(matched.inputDigest, "ab".repeat(32));
      assert.strictEqual(matched.armed, true);
      assert.deepStrictEqual(matched.evidenceIds, ["forge_ev_v2_1"]);

      const notMatched = mapDetectorEvaluation(
        record({
          status: "not-matched",
          evidenceIds: ["forge_ev_v2_1"],
          explanation: "flag not set in the sealed window",
        }),
        false,
      );
      assert.strictEqual(notMatched.status, "available");
      if (notMatched.status !== "available") return;
      assert.deepStrictEqual(notMatched.result, {
        status: "not-matched",
        explanation: "flag not set in the sealed window",
      });
      assert.strictEqual(notMatched.armed, false);

      const unknown = mapDetectorEvaluation(
        record({
          status: "unknown",
          missingSourceIds: ["github-releases:o/r"],
          explanation: "the source revision is still landing",
        }),
        true,
      );
      assert.strictEqual(unknown.status, "available");
      if (unknown.status !== "available") return;
      assert.deepStrictEqual(unknown.result, {
        status: "unknown",
        explanation: "the source revision is still landing",
      });
    }),
  );

  it.effect("bounds the evidence ids to the wire cap, newest provenance first", () =>
    Effect.gen(function* () {
      const many = record({
        status: "not-matched",
        evidenceIds: [],
        explanation: "quiet window",
      });
      const padded: DetectorEvaluationRecordV2 = {
        ...many,
        evidenceIds: Array.from({ length: 20 }, (_, index) => `forge_ev_v2_${index}`),
      };
      const mapped = mapDetectorEvaluation(padded, true);
      assert.strictEqual(mapped.status, "available");
      if (mapped.status !== "available") return;
      assert.strictEqual(mapped.evidenceIds.length, FORGE_DETECTOR_SUMMARY_MAX_EVIDENCE);
      assert.strictEqual(mapped.evidenceIds[0], "forge_ev_v2_0");
    }),
  );
});

describe("pageEvaluations", () => {
  const rows = [
    evaluation({ evaluationId: "forge_ev_old", createdAtMs: 100 }),
    evaluation({
      evaluationId: "forge_ev_new",
      createdAtMs: 300,
      diagnostics: [
        {
          poolId: POOL_ID,
          qualifyingCount: 3,
          excludedCount: 1,
          quoteVolumeMicros: "1500",
          anchorObservationId: "0xtx:4",
          tradeIds: ["0xtx:1", "0xtx:2", "0xtx:3"],
        },
      ],
    }),
    evaluation({ evaluationId: "forge_ev_mid", createdAtMs: 200 }),
  ];

  it.effect("orders newest first, pages by exclusive cursor, and names detail gaps", () =>
    Effect.gen(function* () {
      const first = pageEvaluations(rows, 2, undefined);
      assert.deepStrictEqual(
        first.items.map((item: ForgeEvidenceDetail) => item.evaluationId),
        ["forge_ev_new", "forge_ev_mid"],
      );
      assert.strictEqual(first.hasMore, true);
      // The cursor keys the last served row; the next page serves strictly older.
      assert.strictEqual(first.nextCursor, "200:forge_ev_mid");

      const second = pageEvaluations(rows, 2, first.nextCursor ?? undefined);
      assert.deepStrictEqual(
        second.items.map((item: ForgeEvidenceDetail) => item.evaluationId),
        ["forge_ev_old"],
      );
      assert.strictEqual(second.hasMore, false);
      assert.strictEqual(second.nextCursor, null);

      // Diagnostics ride only where the retained evidence carries them.
      assert.strictEqual(first.items[0]?.pools.status, "available");
      assert.strictEqual(first.items[1]?.pools.status, "detailUnavailable");
    }),
  );
});

// ---------------------------------------------------------------------------
// Service-backed reads (stubbed services; no provider, no Hyperliquid)
// ---------------------------------------------------------------------------

const die = Effect.die("not under test");

const sourceReadsLayer = (input: {
  readonly listing: ForgeSourceListingRead;
  readonly series: (input: ForgePoolSeriesReadInput) => ForgePoolSeriesRead;
}) =>
  Layer.succeed(
    ForgeSourceReads,
    ForgeSourceReads.of({
      listSources: Effect.succeed(input.listing),
      readPoolSeries: (seriesInput) => Effect.succeed(input.series(seriesInput)),
      readEvidence: () => die,
      captureHistoricalWindow: () => die,
    }),
  );

/**
 * A minimal v2 detector manifest as the store would serve its bytes: the
 * discriminator reads only `manifestVersion`, so this stays a two-field
 * honest fixture.
 */
const V2_MANIFEST_JSON = JSON.stringify({ manifestVersion: 2 });
/** A v1 manifest's bytes: the four-artifact vocabulary. */
const V1_MANIFEST_JSON = JSON.stringify({ schemaVersion: 1 });

const capabilityStoreLayer = (input: {
  readonly catalog: ReadonlyArray<ForgeCapabilityCatalogEntry>;
  readonly latest?: ForgeEvaluationEvidence | null;
  readonly list?: ReadonlyArray<ForgeEvaluationEvidence>;
  /** manifest.json bytes by capabilityId; a capability absent here reads null
   * (the fail-closed v1 discrimination). */
  readonly manifests?: Readonly<Record<string, string>>;
  /** Active states by capabilityId; absent capabilities read null. */
  readonly active?: Readonly<
    Record<
      string,
      { version: number; bundleSha256: string; status: ForgeCapabilityStatus; armed: boolean }
    >
  >;
  readonly builds?: ReadonlyArray<ForgeBuildReceipt>;
  readonly control?: (input: {
    environmentId: string;
    capabilityId: string;
    action: "arm" | "disarm";
  }) => boolean;
}) =>
  Layer.succeed(
    ForgeCapabilityStore,
    ForgeCapabilityStore.of({
      listCatalog: () => Effect.succeed(input.catalog),
      latestEvaluation: () => Effect.succeed(input.latest ?? null),
      listEvaluations: () => Effect.succeed(input.list ?? []),
      readArtifact: ({ capabilityId, path }) =>
        path === "manifest.json"
          ? Effect.succeed((input.manifests ?? {})[capabilityId] ?? null)
          : Effect.succeed(null),
      activeState: ({ capabilityId }) => Effect.succeed(input.active?.[capabilityId] ?? null),
      listBuilds: ({ capabilityId }) =>
        Effect.succeed((input.builds ?? []).filter((build) => build.capabilityId === capabilityId)),
      startBuild: () => die,
      appendBuildStage: () => die,
      getBuild: () => die,
      nextVersion: () => die,
      stageVersion: () => die,
      readVersion: () => die,
      install: () => die,
      pause: () => die,
      resume: () => die,
      uninstall: () => die,
      arm: (args) => Effect.sync(() => input.control?.({ ...args, action: "arm" }) ?? false),
      disarm: (args) => Effect.sync(() => input.control?.({ ...args, action: "disarm" }) ?? false),
      recordEvaluation: () => die,
      proposePool: () => die,
      approvePool: () => die,
      rejectPool: () => die,
      findApprovedPool: () => die,
      listProposals: () => die,
      bindPolicy: () => die,
      revokePolicy: () => die,
      listPolicies: () => die,
    }),
  );

const detectorRunStoreLayer = (input: { readonly latest?: DetectorEvaluationRecordV2 | null }) =>
  Layer.succeed(
    DetectorRunStore,
    DetectorRunStore.of({
      readState: () => die,
      commitRun: () => die,
      latestEvaluation: () => Effect.succeed(input.latest ?? null),
      listEvaluations: () => die,
    }),
  );

/** A cataloged v2 capability with its active standing. */
const V2_ENTRY: ForgeCapabilityCatalogEntry = {
  capabilityId: "flag-detector",
  version: 3,
  bundleSha256: "f".repeat(64),
  description: "release-flag detector",
  status: "installed",
  installedAtMs: 1_700_000_000_000,
};

const V2_ACTIVE = {
  version: 3,
  bundleSha256: "f".repeat(64),
  status: "installed" as const,
  armed: true,
};

/** The installed-build receipt that proves the preparing thread. */
const installedBuild = (threadId: string | undefined): ForgeBuildReceipt => ({
  buildId: `fbuild_${threadId ?? "env"}`,
  environmentId: "env-1",
  ...(threadId === undefined ? {} : { threadId }),
  capabilityId: V2_ENTRY.capabilityId,
  requestedSemantics: "flag when the release lands",
  stage: "installed",
  stages: [{ stage: "requested", atMs: 1 }],
  bundleSha256: V2_ENTRY.bundleSha256,
  createdAtMs: 1,
  updatedAtMs: 2,
});

/** A committed v2 record for the cataloged fixture capability. */
const committedV2Record = (
  result: DetectionResult = {
    status: "not-matched",
    evidenceIds: [],
    explanation: "quiet window",
  },
): DetectorEvaluationRecordV2 => {
  const identity = {
    environmentId: "env-1",
    capabilityId: V2_ENTRY.capabilityId,
    version: V2_ENTRY.version,
    stateRevision: 4,
    inputDigest: "cd".repeat(32),
  };
  return {
    manifestVersion: 2,
    evaluationId: detectorEvaluationId(identity),
    environmentId: identity.environmentId,
    capabilityId: identity.capabilityId,
    version: identity.version,
    stateRevision: identity.stateRevision,
    inputDigest: identity.inputDigest,
    asOfMs: 1_700_000_100_000,
    result,
    state: { stateSchemaVersion: 1, state: { count: 4 } },
    evidenceIds: ["forge_ev_v2_1"],
    committedAtMs: 1_700_000_100_500,
  };
};

/** The source-reads half every thread-context test shares. */
const okSources = sourceReadsLayer({
  listing: { status: "ok", listing },
  series: () => ({ status: "unavailable", reason: "unused" }),
});

describe("forgeThreadContextView", () => {
  it.effect(
    "serves discovery with no capability store wired: sources still answer, gaps named",
    () =>
      Effect.gen(function* () {
        const view = yield* forgeThreadContextView({
          environmentId: "env-1",
          threadId: undefined,
        }).pipe(
          Effect.provide(
            sourceReadsLayer({
              listing: { status: "ok", listing },
              series: () => ({ status: "unavailable", reason: "unused" }),
            }),
          ),
        );
        assert.strictEqual(view.sources.status, "ok");
        assert.deepStrictEqual(view.capabilities, []);
        assert.strictEqual(view.latestEvaluation.status, "none");
        if (view.latestEvaluation.status !== "none") return;
        assert.match(view.latestEvaluation.reason, /capability store is not wired/);
        // The detector slot degrades to the same named wiring fact.
        assert.strictEqual(view.detectorEvaluations?.status, "unavailable");
        if (view.detectorEvaluations?.status !== "unavailable") return;
        assert.match(view.detectorEvaluations.reason, /capability store is not wired/);
        assert.strictEqual(view.comparison.status, "unavailable");
        assert.match(view.comparison.reason, /F5 pending/);
      }),
  );

  it.effect("serves the newest evaluation, diagnostics only where recorded", () =>
    Effect.gen(function* () {
      const view = yield* forgeThreadContextView({
        environmentId: "env-1",
        threadId: undefined,
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            sourceReadsLayer({
              listing: { status: "ok", listing },
              series: () => ({ status: "unavailable", reason: "unused" }),
            }),
            capabilityStoreLayer({
              catalog: [
                {
                  capabilityId: "cap-1",
                  version: 2,
                  bundleSha256: "e".repeat(64),
                  description: "net-flow watcher",
                  status: "installed",
                  installedAtMs: 1_700_000_000_000,
                },
              ],
              // A v1 manifest (bytes the discriminator reads): the detector
              // slot stays the honest empty for a v1-only catalog.
              manifests: { "cap-1": V1_MANIFEST_JSON },
              latest: evaluation({
                evaluationId: "forge_ev_new",
                createdAtMs: 300,
                diagnostics: [
                  {
                    poolId: POOL_ID,
                    qualifyingCount: 2,
                    excludedCount: 1,
                    quoteVolumeMicros: "1500",
                    anchorObservationId: "0xtx:4",
                    tradeIds: ["0xtx:1", "0xtx:2"],
                  },
                ],
              }),
              list: [],
            }),
          ),
        ),
      );
      assert.strictEqual(view.latestEvaluation.status, "available");
      if (view.latestEvaluation.status !== "available") return;
      assert.strictEqual(view.latestEvaluation.pools.length, 1);
      assert.strictEqual(view.latestEvaluation.pools[0]?.qualifyingCount, 2);
      assert.strictEqual(view.latestEvaluation.pools[0]?.tradeIds.length, 2);
      // A v1-only catalog is unchanged by the detector half: no run store is
      // even consulted.
      assert.strictEqual(view.detectorEvaluations?.status, "ok");
      if (view.detectorEvaluations?.status !== "ok") return;
      assert.deepStrictEqual(view.detectorEvaluations.items, []);
    }),
  );

  it.effect("a thread-scoped read skips evaluations another conversation caused", () =>
    Effect.gen(function* () {
      const view = yield* forgeThreadContextView({
        environmentId: "env-1",
        threadId: "thread-9",
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            sourceReadsLayer({
              listing: { status: "ok", listing },
              series: () => ({ status: "unavailable", reason: "unused" }),
            }),
            capabilityStoreLayer({
              catalog: [
                {
                  capabilityId: "cap-1",
                  version: 2,
                  bundleSha256: "e".repeat(64),
                  description: "net-flow watcher",
                  status: "installed",
                  installedAtMs: 1_700_000_000_000,
                },
              ],
              latest: evaluation({ threadId: "thread-other" }),
              list: [],
            }),
          ),
        ),
      );
      assert.strictEqual(view.latestEvaluation.status, "none");
      if (view.latestEvaluation.status !== "none") return;
      assert.match(view.latestEvaluation.reason, /this thread/);
    }),
  );

  it.effect(
    "environment scope: a v2 capability with a committed evaluation serves its summary",
    () =>
      Effect.gen(function* () {
        const view = yield* forgeThreadContextView({
          environmentId: "env-1",
          threadId: undefined,
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              okSources,
              capabilityStoreLayer({
                catalog: [V2_ENTRY],
                manifests: { [V2_ENTRY.capabilityId]: V2_MANIFEST_JSON },
                active: { [V2_ENTRY.capabilityId]: V2_ACTIVE },
                builds: [installedBuild("thread-9")],
              }),
              detectorRunStoreLayer({ latest: committedV2Record() }),
            ),
          ),
        );
        assert.strictEqual(view.detectorEvaluations?.status, "ok");
        if (view.detectorEvaluations?.status !== "ok") return;
        assert.strictEqual(view.detectorEvaluations.items.length, 1);
        const item = view.detectorEvaluations.items[0];
        assert.strictEqual(item?.status, "available");
        if (item?.status !== "available") return;
        assert.strictEqual(item.capabilityId, V2_ENTRY.capabilityId);
        assert.strictEqual(item.version, V2_ENTRY.version);
        assert.strictEqual(item.armed, true);
        assert.strictEqual(item.stateRevision, 4);
        assert.deepStrictEqual(item.result, {
          status: "not-matched",
          explanation: "quiet window",
        });
        assert.deepStrictEqual(item.evidenceIds, ["forge_ev_v2_1"]);
      }),
  );

  it.effect("thread scope keys on the installed build's preparing thread, never a guess", () =>
    Effect.gen(function* () {
      const read = (builds: ReadonlyArray<ForgeBuildReceipt>) =>
        forgeThreadContextView({ environmentId: "env-1", threadId: "thread-9" }).pipe(
          Effect.provide(
            Layer.mergeAll(
              okSources,
              capabilityStoreLayer({
                catalog: [V2_ENTRY],
                manifests: { [V2_ENTRY.capabilityId]: V2_MANIFEST_JSON },
                active: { [V2_ENTRY.capabilityId]: V2_ACTIVE },
                builds,
              }),
              detectorRunStoreLayer({ latest: committedV2Record() }),
            ),
          ),
        );
      // The build receipt that installed the active bundle carries the
      // requesting thread: in scope, summary served.
      const mine = yield* read([installedBuild("thread-9")]);
      assert.strictEqual(mine.detectorEvaluations?.status, "ok");
      if (mine.detectorEvaluations?.status !== "ok") return;
      assert.strictEqual(mine.detectorEvaluations.items.length, 1);
      // Another conversation's build: out of scope, the honest empty list.
      const theirs = yield* read([installedBuild("thread-other")]);
      assert.strictEqual(theirs.detectorEvaluations?.status, "ok");
      if (theirs.detectorEvaluations?.status !== "ok") return;
      assert.deepStrictEqual(theirs.detectorEvaluations.items, []);
      // An environment-scoped build (no thread recorded): it never matches
      // a thread filter — exactly as v1 environment rows never do.
      const unattributed = yield* read([installedBuild(undefined)]);
      assert.strictEqual(unattributed.detectorEvaluations?.status, "ok");
      if (unattributed.detectorEvaluations?.status !== "ok") return;
      assert.deepStrictEqual(unattributed.detectorEvaluations.items, []);
    }),
  );

  it.effect("a replacement version does not inherit the previous version's reading", () =>
    Effect.gen(function* () {
      const view = yield* forgeThreadContextView({
        environmentId: "env-1",
        threadId: undefined,
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            okSources,
            capabilityStoreLayer({
              catalog: [{ ...V2_ENTRY, version: V2_ENTRY.version + 1 }],
              manifests: { [V2_ENTRY.capabilityId]: V2_MANIFEST_JSON },
              active: {
                [V2_ENTRY.capabilityId]: {
                  ...V2_ACTIVE,
                  version: V2_ENTRY.version + 1,
                  armed: false,
                },
              },
            }),
            detectorRunStoreLayer({ latest: committedV2Record() }),
          ),
        ),
      );
      assert.equal(view.detectorEvaluations?.status, "ok");
      if (view.detectorEvaluations?.status !== "ok") return;
      assert.equal(view.detectorEvaluations.items[0]?.status, "noEvaluation");
      assert.equal(view.detectorEvaluations.items[0]?.version, V2_ENTRY.version + 1);
    }),
  );

  it.effect("an installed v2 capability with no committed run serves the named absence", () =>
    Effect.gen(function* () {
      const view = yield* forgeThreadContextView({
        environmentId: "env-1",
        threadId: undefined,
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            okSources,
            capabilityStoreLayer({
              catalog: [V2_ENTRY],
              manifests: { [V2_ENTRY.capabilityId]: V2_MANIFEST_JSON },
              active: {
                [V2_ENTRY.capabilityId]: { ...V2_ACTIVE, armed: false },
              },
            }),
            detectorRunStoreLayer({ latest: null }),
          ),
        ),
      );
      assert.strictEqual(view.detectorEvaluations?.status, "ok");
      if (view.detectorEvaluations?.status !== "ok") return;
      assert.strictEqual(view.detectorEvaluations.items.length, 1);
      const item = view.detectorEvaluations.items[0];
      assert.strictEqual(item?.status, "noEvaluation");
      if (item?.status !== "noEvaluation") return;
      assert.strictEqual(item.armed, false);
      assert.match(item.reason, /has not committed an evaluation/);
    }),
  );

  it.effect("a v2 capability in scope with the run store unwired names the wiring fact", () =>
    Effect.gen(function* () {
      const view = yield* forgeThreadContextView({
        environmentId: "env-1",
        threadId: undefined,
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            okSources,
            capabilityStoreLayer({
              catalog: [V2_ENTRY],
              manifests: { [V2_ENTRY.capabilityId]: V2_MANIFEST_JSON },
              active: { [V2_ENTRY.capabilityId]: V2_ACTIVE },
            }),
          ),
        ),
      );
      assert.strictEqual(view.detectorEvaluations?.status, "unavailable");
      if (view.detectorEvaluations?.status !== "unavailable") return;
      assert.strictEqual(view.detectorEvaluations.reason, DETECTOR_RUNS_UNWIRED_REASON);
    }),
  );

  it.effect("a bundle whose manifest cannot be read stays out: no v2 claim without the bytes", () =>
    Effect.gen(function* () {
      const view = yield* forgeThreadContextView({
        environmentId: "env-1",
        threadId: undefined,
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            okSources,
            capabilityStoreLayer({
              catalog: [V2_ENTRY],
              manifests: {},
              active: { [V2_ENTRY.capabilityId]: V2_ACTIVE },
            }),
            detectorRunStoreLayer({ latest: committedV2Record() }),
          ),
        ),
      );
      assert.strictEqual(view.detectorEvaluations?.status, "ok");
      if (view.detectorEvaluations?.status !== "ok") return;
      assert.deepStrictEqual(view.detectorEvaluations.items, []);
    }),
  );
});

describe("forgePoolSeriesView", () => {
  it.effect("passes the bounded request through and maps the read", () =>
    Effect.gen(function* () {
      const seen: Array<ForgePoolSeriesReadInput> = [];
      const view = yield* forgePoolSeriesView({
        poolId: POOL_ID,
        points: 120,
        domain: { fromUtcMs: 1_700_000_000_000, toUtcMs: 1_700_000_360_000 },
      }).pipe(
        Effect.provide(
          sourceReadsLayer({
            listing: { status: "ok", listing },
            series: (seriesInput) => {
              seen.push(seriesInput);
              return { status: "ok", series: seriesOk };
            },
          }),
        ),
      );
      // The schema-bounded input reaches the read unchanged: the handler
      // never widens what the schema already refused.
      assert.strictEqual(seen.length, 1);
      assert.strictEqual(seen[0]?.maxPoints, 120);
      assert.strictEqual(seen[0]?.startUtcMs, 1_700_000_000_000);
      assert.strictEqual(view.status, "ok");
    }),
  );
});

describe("forgeEvidenceView", () => {
  it.effect("narrows by evaluationId and pages newest-first across capabilities", () =>
    Effect.gen(function* () {
      const store = capabilityStoreLayer({
        catalog: [
          {
            capabilityId: "cap-1",
            version: 2,
            bundleSha256: "e".repeat(64),
            description: "eth coordination",
            status: "installed",
            installedAtMs: 1,
          },
        ],
        list: [evaluation(), evaluation({ evaluationId: "forge_ev_2", createdAtMs: 200 })],
      });
      const byId = yield* forgeEvidenceView({
        environmentId: "env-1",
        evaluationId: "forge_ev_2",
        limit: undefined,
        cursor: undefined,
      }).pipe(Effect.provide(store));
      assert.deepStrictEqual(
        byId.items.map((item) => item.evaluationId),
        ["forge_ev_2"],
      );
      assert.strictEqual(byId.hasMore, false);

      const paged = yield* forgeEvidenceView({
        environmentId: "env-1",
        evaluationId: undefined,
        limit: 1,
        cursor: undefined,
      }).pipe(Effect.provide(store));
      assert.deepStrictEqual(
        paged.items.map((item) => item.evaluationId),
        ["forge_ev_1"],
      );
      assert.strictEqual(paged.hasMore, true);
      assert.strictEqual(paged.nextCursor, `${evaluation().createdAtMs}:forge_ev_1`);
      const older = yield* forgeEvidenceView({
        environmentId: "env-1",
        evaluationId: undefined,
        limit: 1,
        cursor: paged.nextCursor ?? undefined,
      }).pipe(Effect.provide(store));
      assert.deepStrictEqual(
        older.items.map((item) => item.evaluationId),
        ["forge_ev_2"],
      );
      assert.strictEqual(older.hasMore, false);
    }),
  );
});

// ---------------------------------------------------------------------------
// Fee-policy-backed pool state and controls (provider-independent by
// construction: no provider service appears anywhere in the graph)
// ---------------------------------------------------------------------------

const feePolicyLayer = (input: {
  readonly proposal: ForgePoolProposalRead;
  readonly position: ForgePositionStateRead;
  readonly controls: ForgeDirectControlsRead;
  readonly policyState: ForgePolicyStateRead;
  readonly intents: ReadonlyArray<ForgeIntentRecord>;
  readonly controlResult?: ForgeOperationResult;
}) =>
  Layer.succeed(
    FeePolicyService,
    FeePolicyService.of({
      readPoolProposal: Effect.succeed(input.proposal),
      readPositionState: Effect.succeed(input.position),
      readDirectControls: Effect.succeed(input.controls),
      readPolicyState: Effect.succeed(input.policyState),
      listIntents: (limit) => Effect.succeed(input.intents.slice(0, limit)),
      readSwapFeeEvidence: () => die,
      publishFromEvidence: () => die,
      requestRevoke: () =>
        Effect.succeed(
          input.controlResult ?? {
            status: "ok",
            record: intentRecord(1, { kind: "revoke-policy" }),
          },
        ),
      requestPause: () =>
        Effect.succeed(input.controlResult ?? { status: "ok", record: intentRecord(1) }),
      requestUnpause: () =>
        Effect.succeed(
          input.controlResult ?? { status: "ok", record: intentRecord(1, { kind: "unpause" }) },
        ),
      requestRemoveLiquidity: () => die,
      requestInitializePool: () => die,
      requestAddLiquidity: () => die,
      requestBoundedSwap: () => die,
      broadcast: () => die,
      reconcile: () => die,
      reconcileOpenIntents: die,
      setLocalPause: () => die,
    }),
  );

describe("forgePoolStateView", () => {
  it.effect("aggregates the five fee-policy reads into the pool-state view", () =>
    Effect.gen(function* () {
      const view = yield* forgePoolStateView().pipe(
        Effect.provide(
          feePolicyLayer({
            proposal: grantMissingProposal,
            position: noPositionState,
            controls: controlsRead,
            policyState: unconfiguredPolicyState,
            intents: [intentRecord(1), intentRecord(2)],
          }),
        ),
      );
      assert.strictEqual(view.proposal.status, "ok");
      assert.strictEqual(view.controls.localPause, false);
      assert.strictEqual(view.transactions.items.length, 2);
    }),
  );
});

describe("forgeControlView", () => {
  it.effect("builds a pause intent through the service with a fresh identity per call", () =>
    Effect.gen(function* () {
      const layer = feePolicyLayer({
        proposal: grantMissingProposal,
        position: noPositionState,
        controls: controlsRead,
        policyState: unconfiguredPolicyState,
        intents: [],
      });
      const first = yield* forgeControlView("pause", "env-1").pipe(Effect.provide(layer));
      const second = yield* forgeControlView("pause", "env-1").pipe(Effect.provide(layer));
      assert.strictEqual(first.status, "ok");
      assert.strictEqual(second.status, "ok");
      if (first.status !== "ok" || second.status !== "ok") return;
      assert.strictEqual(first.intent.kind, "pause");
      assert.strictEqual(first.intent.idempotencyKey, "pause:env:1");
      // The service mints the idempotency key; each call is its own attempt.
      assert.strictEqual(second.intent.idempotencyKey, "pause:env:1");
    }),
  );

  it.effect("surfaces a service refusal as the typed refused result", () =>
    Effect.gen(function* () {
      const refused = yield* forgeControlView("unpause", "env-1").pipe(
        Effect.provide(
          feePolicyLayer({
            proposal: grantMissingProposal,
            position: noPositionState,
            controls: controlsRead,
            policyState: unconfiguredPolicyState,
            intents: [],
            controlResult: {
              status: "refused",
              reason: "locally-paused",
              detail: "local pause is set; unpause is blocked until it is cleared",
            },
          }),
        ),
      );
      assert.strictEqual(refused.status, "refused");
      if (refused.status !== "refused") return;
      assert.strictEqual(refused.reason, "locally-paused");
    }),
  );
});

describe("direct detector standing controls", () => {
  it.effect("refuses an unwired store without inventing standing", () =>
    Effect.gen(function* () {
      const result = yield* forgeDetectorControlView({
        environmentId: "env",
        capabilityId: "cap",
        action: "disarm",
      });
      assert.equal(result.applied, false);
    }),
  );
  it.effect("forwards both actions in the connected environment without a provider", () =>
    Effect.gen(function* () {
      const calls: Array<{
        environmentId: string;
        capabilityId: string;
        action: "arm" | "disarm";
      }> = [];
      yield* Effect.gen(function* () {
        for (const action of ["arm", "disarm"] as const) {
          const result = yield* forgeDetectorControlView({
            environmentId: "connected",
            capabilityId: "installed",
            action,
          });
          assert.equal(result.applied, true);
        }
        const missing = yield* forgeDetectorControlView({
          environmentId: "connected",
          capabilityId: "missing",
          action: "arm",
        });
        assert.equal(missing.applied, false);
      }).pipe(
        Effect.provide(
          capabilityStoreLayer({
            catalog: [],
            control: (input) => {
              calls.push(input);
              return input.capabilityId === "installed";
            },
          }),
        ),
      );
      assert.deepEqual(
        calls.map((call) => [call.environmentId, call.action]),
        [
          ["connected", "arm"],
          ["connected", "disarm"],
          ["connected", "arm"],
        ],
      );
    }),
  );
});
