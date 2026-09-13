/**
 * SwapBroadcastLifecycle — the post-admission contract over real SQLite
 * (migrations 105-107 + 110-111), seeded through the real reservation store
 * admission with fake capability/store/route seams.
 *
 * What is pinned here: the signing snapshot is immutable (a different nonce
 * refuses, the same nonce is idempotent); the shipped refusing broadcast
 * sink makes signAndBroadcast refuse broadcaster-missing BEFORE the signer
 * is ever read (no signed bytes exist); with a fake sink and a synthetic
 * (throwaway, publicly-known) test key the full gate runs — balance, TWAP
 * price-impact reference, deterministic signing, uncertain broadcast — and
 * the receipt settlement is idempotent, validates asset-movement evidence
 * (status 1 without the expected transfer REFUSES), and reverts settle fees
 * only while releasing the principal.
 *
 * @module SwapBroadcastLifecycle.test
 */
// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off preferSchemaOverJson:off tryCatchInEffectGen:off runEffectInsideEffect:off - sqlite fixtures and synthetic keys are the data under test.
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  detectorEvaluationId,
  type ExecutionEnvelope,
  type SwapQuoteRecord,
  swapQuoteId,
} from "@t3tools/trading-contracts";
import type { PersistenceSqlError } from "../../persistence/Errors.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { keccak256, toBytes } from "viem";

import createDetectorTables from "../../persistence/Migrations/105_DetectorRuns.ts";
import createExecutionTables from "../../persistence/Migrations/106_ExecutionEnvelopes.ts";
import createSwapIntentTables from "../../persistence/Migrations/107_SwapIntents.ts";
import createSwapReservationTables from "../../persistence/Migrations/110_SwapReservations.ts";
import createSwapLifecycleTables from "../../persistence/Migrations/111_SwapBroadcastLifecycle.ts";
import {
  ForgeCapabilitySandbox,
  forgeSha256Hex,
  type ForgeCapabilitySandboxShape,
} from "./CapabilitySandbox.ts";
import { FORGE_SDK_SOURCE_V2 } from "./CapabilityBuilder.ts";
import { ForgeCapabilityStore, type ForgeCapabilityStoreShape } from "./CapabilityStore.ts";
import { DetectorRunStore, makeDetectorRunStore } from "./DetectorRunStore.ts";
import {
  makeExecutionPolicyService,
  type ExecutionPolicyServiceShape,
} from "./ExecutionPolicyService.ts";
import {
  makeSwapReservationStore,
  type SwapReservationStoreShape,
} from "./SwapReservationStore.ts";
import {
  makeSwapBroadcastLifecycle,
  SpotBroadcastSink,
  spotBroadcastSinkRefusing,
  type ChainReceipt,
  type SignAndBroadcastOutcome,
  type SwapBroadcastLifecycleShape,
} from "./SwapBroadcastLifecycle.ts";
import {
  SpotDemoSignerConfig,
  SpotMainnetTransport,
  type SpotMainnetTarget,
} from "./SpotMainnetTarget.ts";
import {
  resolveSwapRouteSettings,
  SwapRouteConfig,
  swapRouteConfigDigest,
} from "./UniswapQuoteService.ts";
import { ERC20_TRANSFER_TOPIC } from "./SwapBroadcastLifecycle.ts";

const ENV = "env_lifecycle";
const CAP = "flow-policy";
const NOW = 1_700_000_000_000;
const DEADLINE = Math.floor(NOW / 1000) + 600;

const layer = it.layer(NodeSqliteClient.layerMemory());

const ROUTER = "0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad";
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const QUOTER = "0x61ffe014ba17989e743c5f6cb21bf9697530b21e";
const NATIVE = `0x${"0".repeat(40)}`;
const RECIPIENT = `0x${"cc".repeat(20)}`;

// A throwaway, publicly-documented test key (viem docs' example key); it
// exists only so deterministic signing is exercised. It funds nothing.
const TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const TEST_ADDRESS = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const TEST_KEY_BYTES: Uint8Array = Uint8Array.from(
  Array.from({ length: 32 }, (_, i) => Number.parseInt(TEST_KEY.slice(2 + i * 2, 4 + i * 2), 16)),
);

// ---------------------------------------------------------------------------
// The shared seeding fixtures (condensed from SwapReservationStore.test.ts)
// ---------------------------------------------------------------------------

const DETECTOR_TEST_TS = 'import { detect } from "./detector";\nexport const t = 1;\n';
const DETECTOR_TS = [
  'import type { Detect, DetectorProgramInput, DetectorProgramOutput } from "./sdk";',
  "export const detect: Detect = (input: DetectorProgramInput): DetectorProgramOutput => ({",
  '  result: { status: "not-matched", evidenceIds: [], explanation: "fixture" },',
  "  nextState: {},",
  "});",
].join("\n");
const POLICY_TS = [
  'import type { PolicyInput, PolicyOutput, Propose } from "./sdk";',
  "export const propose: Propose = (input: PolicyInput): PolicyOutput => ({",
  '  proposal: { kind: "swap", candidateId: "cand_eth_usdc", amountInRaw: "400000000000000000", quoteId: "sq_fixture", occurrenceKey: "occ", stageKey: "entry", detectorEvaluationId: input.detectorEvaluation.evaluationId },',
  "  nextState: {},",
  "});",
].join("\n");

const fakeManifest = (): string => {
  const artifacts: Record<string, string> = {
    "sdk.ts": FORGE_SDK_SOURCE_V2,
    "detector.ts": DETECTOR_TS,
    "detector.test.ts": DETECTOR_TEST_TS,
    "policy.ts": POLICY_TS,
  };
  const roleOf = (path: string): string =>
    path === "sdk.ts"
      ? "sdk"
      : path === "detector.ts"
        ? "detector"
        : path === "policy.ts"
          ? "execution-policy"
          : "acceptance";
  return JSON.stringify({
    manifestVersion: 2,
    capabilityId: CAP,
    version: 1,
    semantics: "fixture",
    requiredSourceIds: ["src_graph_1"],
    outputFactKeys: ["flag"],
    artifacts: Object.entries(artifacts).map(([path, content]) => ({
      role: roleOf(path),
      path,
      sha256: forgeSha256Hex(content),
    })),
    createdAtMs: NOW - 10_000,
  });
};

const BUNDLE: Record<string, string> = {
  "sdk.ts": FORGE_SDK_SOURCE_V2,
  "detector.ts": DETECTOR_TS,
  "detector.test.ts": DETECTOR_TEST_TS,
  "policy.ts": POLICY_TS,
  "manifest.json": fakeManifest(),
};

const unused = () => Effect.die("unused");
const fakeStore: ForgeCapabilityStoreShape = {
  activeState: () =>
    Effect.succeed({ version: 1, bundleSha256: "f".repeat(64), status: "installed", armed: true }),
  readArtifact: ({ path }) => Effect.succeed(BUNDLE[path] ?? null),
  startBuild: unused,
  appendBuildStage: unused,
  getBuild: unused,
  listBuilds: unused,
  nextVersion: unused,
  stageVersion: unused,
  readVersion: unused,
  install: unused,
  pause: unused,
  resume: unused,
  uninstall: unused,
  arm: unused,
  disarm: unused,
  listCatalog: unused,
  recordEvaluation: unused,
  latestEvaluation: unused,
  listEvaluations: unused,
  proposePool: unused,
  approvePool: unused,
  rejectPool: unused,
  findApprovedPool: unused,
  listProposals: unused,
  bindPolicy: unused,
  revokePolicy: unused,
  listPolicies: unused,
};

/** The stage the fake policy proposes next; each seeding takes a fresh one. */
const policyStage: { stageKey: string; counter: number } = { stageKey: "entry", counter: 0 };

const fakeSandbox: ForgeCapabilitySandboxShape = {
  available: Effect.succeed(true),
  runBuildStep: () => Effect.die("not used"),
  runEvaluation: (request) =>
    Effect.gen(function* () {
      const input = JSON.parse(request.stdinJson) as {
        readonly detectorEvaluation: {
          readonly evaluationId: string;
          readonly result: { readonly status: string; readonly occurrenceKey?: string };
        };
      };
      const output = {
        proposal: {
          kind: "swap",
          candidateId: "cand_eth_usdc",
          amountInRaw: "400000000000000000",
          quoteId: "sq_fixture",
          occurrenceKey:
            input.detectorEvaluation.result.status === "matched"
              ? (input.detectorEvaluation.result.occurrenceKey ?? "occ")
              : "occ",
          stageKey: policyStage.stageKey,
          detectorEvaluationId: input.detectorEvaluation.evaluationId,
        },
        nextState: { stateSchemaVersion: 1, state: {} },
      };
      return yield* Effect.sync(() => request.decodeResult(JSON.parse(JSON.stringify(output))));
    }),
};

/** The resolved route settings, computed lazily (per call, like production). */
const settingsFor = (): ReturnType<typeof resolveSwapRouteSettings> => {
  const resolved = resolveSwapRouteSettings({
    T3_SWAP_ROUTES: JSON.stringify([
      {
        routeId: "mainnet-eth-usdc",
        chainId: "1",
        routeType: "ur-v3-exact-input",
        tokenIn: NATIVE,
        tokenOut: USDC,
        quoterAddress: QUOTER,
        swapTargetAddress: ROUTER,
        weth: WETH,
        feeTier: 500,
      },
    ]),
  });
  assert.isTrue(resolved.configured, resolved.reason ?? "routes must resolve");
  return resolved;
};

const identityQuote = (): SwapQuoteRecord => {
  const route = settingsFor().routes?.[0]!;
  const base = {
    chainId: "1",
    routeId: route.routeId,
    tokenIn: NATIVE,
    tokenOut: USDC,
    amountInRaw: "400000000000000000",
    minAmountOutRaw: "2493000000",
    gasEstimateWei: (220_000n * 40_000_000_000n).toString(10),
    quotedAtMs: NOW - 1_000,
    expiresAtMs: NOW + 3_600_000,
    basis: "eth_call" as const,
    routeConfigDigest: swapRouteConfigDigest(route),
    quotedBlockNumber: "21000000",
    quotedBlockHash: "ab".repeat(32),
    quotedAmountOutRaw: "2500500000",
    quoterCodeHash: FAKE_CODE_HASH,
    targetCodeHash: FAKE_CODE_HASH,
    gasUnitsMeasured: "220000",
    maxFeePerGasWei: "40000000000",
    maxPriorityFeePerGasWei: "1500000000",
  };
  return {
    ...base,
    quoteId: swapQuoteId(base),
  } as SwapQuoteRecord;
};

const ENVELOPE: ExecutionEnvelope = {
  revision: 1,
  environmentId: ENV,
  accountId: "acct-spot",
  expiresAtMs: NOW + 3_600_000,
  detectorBundleSha256: forgeSha256Hex(DETECTOR_TS),
  policyBundleSha256: forgeSha256Hex(POLICY_TS),
  candidates: [
    {
      candidateId: "cand_eth_usdc",
      chainId: "1",
      tokenIn: NATIVE,
      tokenOut: USDC,
      recipient: RECIPIENT,
      label: "ETH -> USDC",
    },
  ],
  inputCapTotalRaw: "1000000000000000000",
  inputCapPerSwapRaw: "500000000000000000",
  maxGasWei: "20000000000000000",
  maxSlippageBps: 50,
  maxTransactions: 2,
  maxConcurrentIntents: 1,
};

// ---------------------------------------------------------------------------
// Fake chain + sink + signer
// ---------------------------------------------------------------------------

/** The observe(uint32[]) return that implies the fixture's reference price. */
const OBSERVE_RETURN = (() => {
  const word = (value: bigint): string =>
    (value >= 0n ? value : (1n << 256n) + value).toString(16).padStart(64, "0");
  // tickCumulative chosen so twapTick = -87400 → the reference output for
  // 0.4 ETH ≈ 2.499e9 USDC units, within 200 bps of the fixture quote floor.
  const tickCumulative = BigInt(-87400) * 1800n;
  return `0x${word(0x40n)}${word(0xa0n)}${word(1n)}${word(tickCumulative)}${word(1n)}${word(0n)}`;
})();

const POOL = "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640";
const FAKE_CODE = "0x6080";
const FAKE_CODE_HASH_PIN = keccak256(toBytes(FAKE_CODE));
const FAKE_CODE_HASH = FAKE_CODE_HASH_PIN.replace(/^0x/, "");
const hexWord = (value: string | bigint): string =>
  (typeof value === "bigint"
    ? value.toString(16)
    : BigInt(value.toLowerCase()).toString(16)
  ).padStart(64, "0");

/** The spot target every test resolves against, with honest pins. */
const spotTarget: SpotMainnetTarget = {
  chainId: 1,
  rpcUrl: "https://example.invalid",
  accountAddress: TEST_ADDRESS,
  universalRouter: ROUTER,
  quoterV2: QUOTER,
  permit2: "0x000000000022d473030f116ddee9f6b43ac78ba3",
  v3Factory: "0x1f98431c8ad98523631ae4a59f267346ea31f984",
  weth9: WETH,
  usdc: USDC,
  pool: POOL,
  feeTier: 500,
  deadlineWindowSeconds: 120,
  codeHashPins: {
    universalRouter: FAKE_CODE_HASH_PIN,
    quoterV2: FAKE_CODE_HASH_PIN,
    permit2: FAKE_CODE_HASH_PIN,
    v3Factory: FAKE_CODE_HASH_PIN,
    weth9: FAKE_CODE_HASH_PIN,
    usdc: FAKE_CODE_HASH_PIN,
    pool: FAKE_CODE_HASH_PIN,
  },
};

/**
 * A fake mainnet transport: a per-method script sits ON TOP of the full
 * admission/sign verification defaults (chain id, uniform runtime code the
 * target pins, the factory's pool lookup, pool views, decimals, observe).
 */
const makeFakeRpc = (script: (method: string, params: ReadonlyArray<unknown>) => unknown) =>
  SpotMainnetTransport.of({
    target: () => spotTarget,
    request: (method, params) =>
      Effect.gen(function* () {
        const served = script(method, params);
        if (served !== undefined) return served;
        if (method === "eth_chainId") return "0x1";
        if (method === "eth_getBalance") return "0x3635c9adc5dea00000"; // 1000 ETH.
        if (method === "eth_getBlockByNumber") {
          return { timestamp: `0x${Math.floor(NOW / 1000).toString(16)}` };
        }
        if (method === "eth_getCode") return FAKE_CODE;
        if (method === "eth_call") {
          const call = params[0] as { readonly to: string; readonly data: string };
          const selector = call.data.slice(0, 10);
          const to = call.to.toLowerCase();
          if (to === spotTarget.v3Factory && selector === "0x1698ee82") {
            return `0x${hexWord(POOL)}`;
          }
          if (to === POOL && selector === "0x0dfe1681") return `0x${hexWord(USDC)}`;
          if (to === POOL && selector === "0xd21220a7") return `0x${hexWord(WETH)}`;
          if (to === POOL && selector === "0xddca3f43") return `0x${hexWord(500n)}`;
          if (selector === "0x313ce567") {
            return `0x${hexWord(to === WETH ? 18n : 6n)}`;
          }
          if (selector === "0x883bdbfd") return OBSERVE_RETURN;
          return yield* Effect.fail(`no eth_call fixture for ${to} ${selector}`);
        }
        return yield* Effect.fail(`no fixture for ${method}`);
      }),
  });

const healthyChain = makeFakeRpc((method, params) => {
  switch (method) {
    case "eth_getBalance":
      return "0x3635c9adc5dea00000"; // 1000 ETH — covers value + fees.
    case "eth_getBlockByNumber":
      return { timestamp: `0x${Math.floor(NOW / 1000).toString(16)}` };
    case "eth_call": {
      // Only the oracle read is overridden; pool views and decimals fall
      // through to the verification defaults.
      const call = params[0] as { readonly data: string };
      return call.data.slice(0, 10) === "0x883bdbfd" ? OBSERVE_RETURN : undefined;
    }
    default:
      return undefined;
  }
});

const fakeSink = (responses: { readonly available: boolean; readonly txHash?: string }) => {
  const broadcasts: Array<string> = [];
  return {
    broadcasts,
    service: SpotBroadcastSink.of({
      available: Effect.succeed(responses.available),
      broadcast: (signedTxRlp: string) =>
        Effect.gen(function* () {
          broadcasts.push(signedTxRlp);
          return { txHash: responses.txHash ?? `0x${"9".repeat(64)}` };
        }),
    }),
  };
};

const armedSigner = SpotDemoSignerConfig.of({
  resolve: Effect.succeed({
    armed: true,
    signer: { address: TEST_ADDRESS, privateKeyBytes: TEST_KEY_BYTES },
  }),
});

const unarmedSigner = SpotDemoSignerConfig.of({
  resolve: Effect.succeed({ armed: false }),
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const reset = Effect.gen(function* () {
  yield* createDetectorTables;
  yield* createExecutionTables;
  yield* createSwapIntentTables;
  yield* createSwapReservationTables;
  yield* createSwapLifecycleTables;
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM forge_detector_state`;
  yield* sql`DELETE FROM forge_detector_evaluations`;
  yield* sql`DELETE FROM execution_envelopes`;
  yield* sql`DELETE FROM execution_envelope_approvals`;
  yield* sql`DELETE FROM execution_proposals`;
  yield* sql`DELETE FROM execution_policy_state`;
  yield* sql`DELETE FROM execution_swap_intents`;
  yield* sql`DELETE FROM execution_swap_reservations`;
  yield* sql`DELETE FROM execution_swap_attempts`;
  yield* sql`DELETE FROM execution_swap_receipts`;
  policyStage.counter = 0;
  policyStage.stageKey = "entry";
});

const policyService = (): Effect.Effect<ExecutionPolicyServiceShape, never, SqlClient.SqlClient> =>
  Effect.flatMap(makeDetectorRunStore, (runs) =>
    Effect.provideService(
      Effect.provideService(
        Effect.provideService(makeExecutionPolicyService, ForgeCapabilityStore, fakeStore),
        ForgeCapabilitySandbox,
        fakeSandbox,
      ),
      DetectorRunStore,
      runs,
    ),
  );

const reservationStore = (
  rpc: ReturnType<typeof makeFakeRpc> = healthyChain,
): Effect.Effect<SwapReservationStoreShape, never, SqlClient.SqlClient> =>
  Effect.provideService(
    makeSwapReservationStore,
    SwapRouteConfig,
    SwapRouteConfig.of({ resolve: Effect.sync(settingsFor) }),
  ).pipe(
    Effect.provideService(ForgeCapabilityStore, fakeStore),
    Effect.provideService(SpotMainnetTransport, rpc),
  );

const buildLifecycle = (
  sink: ReturnType<typeof fakeSink>["service"],
  signer: ReturnType<typeof SpotDemoSignerConfig.of>,
  transport: ReturnType<typeof SpotMainnetTransport.of>,
): Effect.Effect<SwapBroadcastLifecycleShape, never, SqlClient.SqlClient> =>
  Effect.flatMap(makeDetectorRunStore, (runs) =>
    Effect.provideService(
      Effect.provideService(
        Effect.provideService(
          Effect.provideService(makeSwapBroadcastLifecycle, SpotBroadcastSink, sink),
          SpotDemoSignerConfig,
          signer,
        ),
        SpotMainnetTransport,
        transport,
      ),
      DetectorRunStore,
      runs,
    ),
  );

/** Seed envelope + evaluation + proposal + admission; returns the intent id. */
const admittedIntent = (
  envelopeOverrides: Partial<ExecutionEnvelope> = {},
): Effect.Effect<
  { readonly intentId: string; readonly reservationId: string },
  PersistenceSqlError,
  SqlClient.SqlClient
> =>
  Effect.gen(function* () {
    const policy = yield* policyService();
    const proposed = yield* policy.proposeEnvelope({
      environmentId: ENV,
      envelope: { ...ENVELOPE, ...envelopeOverrides },
      now: NOW,
      proposedVia: "test",
      capabilityId: CAP,
    });
    if (proposed.status !== "proposed" && proposed.status !== "already-proposed") {
      throw new Error("seeding failed");
    }
    if (proposed.status === "proposed") {
      const approved = yield* policy.approveEnvelope({
        envelopeId: proposed.envelopeId,
        now: NOW,
        approvedVia: "local-operator",
      });
      assert.equal(approved.status, "approved");
    }

    // A fresh stage + evaluation per seeding so the unique (envelope, stage)
    // slot is always uncontended.
    policyStage.counter += 1;
    policyStage.stageKey = `entry-${policyStage.counter}`;
    const stateRevision = policyStage.counter - 1;
    const runs = yield* makeDetectorRunStore;
    const inputDigest = `${"c".repeat(62)}${String(policyStage.counter).padStart(2, "0")}`;
    const evaluationId = detectorEvaluationId({
      environmentId: ENV,
      capabilityId: CAP,
      version: 1,
      stateRevision,
      inputDigest,
    });
    yield* runs.commitRun({
      record: {
        manifestVersion: 2,
        evaluationId,
        environmentId: ENV,
        capabilityId: CAP,
        version: 1,
        stateRevision,
        inputDigest,
        asOfMs: NOW - 1_000,
        result: {
          status: "matched",
          occurrenceKey: `occ-${policyStage.counter}`,
          evidenceIds: ["ev_1"],
          facts: [],
          validUntilMs: NOW + 600_000,
        },
        state: { stateSchemaVersion: 1, state: {} },
        evidenceIds: ["ev_1"],
        committedAtMs: NOW,
      },
      stateBytes: JSON.stringify({ stateSchemaVersion: 1, state: {} }),
    });

    const outcome = yield* policy.evaluatePolicy({
      environmentId: ENV,
      capabilityId: CAP,
      now: NOW + 1,
    });
    assert.equal(outcome.status, "proposed");
    if (outcome.status !== "proposed") throw new Error("unreachable");

    const store = yield* reservationStore();
    const admitted = yield* store.admitProtectedSwap({
      environmentId: ENV,
      proposalId: outcome.proposalId,
      quote: identityQuote(),
      deadlineUnix: DEADLINE,
      now: NOW + 2_000,
    });
    assert.equal(admitted.status, "admitted");
    if (admitted.status !== "admitted") throw new Error("unreachable");
    return { intentId: admitted.intent.intentId, reservationId: admitted.reservationId };
  });

// ---------------------------------------------------------------------------
// The lifecycle contract
// ---------------------------------------------------------------------------

const fakeSinkWithTxHash = fakeSink({ available: true, txHash: `0x${"7".repeat(64)}` }).service;

layer("SwapBroadcastLifecycle", (it) => {
  it.effect("the signing snapshot stamps once and is immutable", () =>
    Effect.gen(function* () {
      yield* reset;
      const { intentId } = yield* admittedIntent();
      const svc = yield* buildLifecycle(
        fakeSink({ available: true }).service,
        armedSigner,
        healthyChain,
      );

      const stamped = yield* svc.createSigningSnapshot({ intentId, nonce: 7, now: NOW + 3_000 });
      assert.equal(stamped.status, "stamped");
      if (stamped.status !== "stamped") throw new Error("unreachable");
      assert.equal(stamped.snapshot.nonce, 7);
      assert.equal(stamped.snapshot.chainId, 1);
      assert.equal(stamped.snapshot.maxFeePerGasWei, "40000000000");

      const same = yield* svc.createSigningSnapshot({ intentId, nonce: 7, now: NOW + 4_000 });
      assert.equal(same.status, "already-stamped");

      const changed = yield* svc.createSigningSnapshot({ intentId, nonce: 8, now: NOW + 5_000 });
      assert.equal(changed.status, "refused");
      if (changed.status !== "refused") throw new Error("unreachable");
      assert.equal(changed.refusal, "snapshot-mismatch");
    }),
  );

  it.effect("the shipped refusing sink refuses broadcaster-missing BEFORE the signer is read", () =>
    Effect.gen(function* () {
      yield* reset;
      const { intentId } = yield* admittedIntent();
      yield* buildLifecycle(fakeSink({ available: true }).service, armedSigner, healthyChain);
      // Build with an UNAVAILABLE sink and an ARMED signer: the refusal must
      // come first, so no signed bytes ever exist.
      const svc = Effect.provideService(
        Effect.provideService(
          Effect.provideService(
            Effect.provideService(
              makeSwapBroadcastLifecycle,
              SpotBroadcastSink,
              spotBroadcastSinkRefusing,
            ),
            SpotDemoSignerConfig,
            armedSigner,
          ),
          SpotMainnetTransport,
          healthyChain,
        ),
        DetectorRunStore,
        DetectorRunStore.of({
          latestEvaluation: () => Effect.succeed(null),
        } as never),
      );
      const lifecycleService = yield* svc;
      const outcome = yield* lifecycleService.signAndBroadcast({ intentId, now: NOW + 3_000 });
      assert.equal(outcome.status, "refused");
      if (outcome.status !== "refused") throw new Error("unreachable");
      assert.equal(outcome.refusal, "broadcaster-missing");
      assert.include(outcome.detail, "nothing was signed");

      const sqlClient = yield* SqlClient.SqlClient;
      const attempt = yield* sqlClient<{ readonly signed_tx_rlp: string | null }>`
        SELECT signed_tx_rlp FROM execution_swap_attempts WHERE intent_id = ${intentId}
      `;
      assert.isNull(attempt[0]?.signed_tx_rlp);
    }),
  );

  it.effect("signAndBroadcast runs the full gate and persists deterministic signed bytes", () =>
    Effect.gen(function* () {
      yield* reset;
      const { intentId } = yield* admittedIntent();
      const svc = yield* buildLifecycle(fakeSinkWithTxHash, armedSigner, healthyChain);
      yield* svc.createSigningSnapshot({ intentId, nonce: 3, now: NOW + 3_000 });

      const outcome = yield* svc.signAndBroadcast({ intentId, now: NOW + 4_000 });
      assert.equal(outcome.status, "signed-and-broadcast", JSON.stringify(outcome));
      if (outcome.status !== "signed-and-broadcast") throw new Error("unreachable");
      assert.match(outcome.txHash, /^0x[0-9a-f]{64}$/);

      const sqlClient = yield* SqlClient.SqlClient;
      const attempt = yield* sqlClient<{
        readonly status: string;
        readonly signed_tx_rlp: string;
        readonly signed_tx_hash: string;
      }>`
        SELECT status, signed_tx_rlp, signed_tx_hash FROM execution_swap_attempts WHERE intent_id = ${intentId}
      `;
      assert.equal(attempt[0]?.status, "broadcast-uncertain");
      assert.match(attempt[0]?.signed_tx_rlp ?? "", /^0x[0-9a-f]+$/);
      assert.equal(attempt[0]?.signed_tx_hash, outcome.txHash);
      // The signed bytes never surface in the intent's public row.
      const intent = yield* sqlClient<{
        readonly prepared_tx_json: string;
        readonly status: string;
      }>`
        SELECT prepared_tx_json, status FROM execution_swap_intents WHERE intent_id = ${intentId}
      `;
      assert.equal(intent[0]?.status, "submitted");
      assert.notInclude(intent[0]?.prepared_tx_json ?? "", attempt[0]?.signed_tx_rlp ?? "x");
    }),
  );

  it.effect("a success receipt settles actuals only with the expected transfer evidence", () =>
    Effect.gen(function* () {
      yield* reset;
      const { intentId } = yield* admittedIntent();
      const svc = yield* buildLifecycle(
        fakeSink({ available: true }).service,
        armedSigner,
        healthyChain,
      );
      yield* svc.createSigningSnapshot({ intentId, nonce: 3, now: NOW + 3_000 });
      const sent = yield* svc.signAndBroadcast({ intentId, now: NOW + 4_000 });
      assert.equal(sent.status, "signed-and-broadcast");
      if (sent.status !== "signed-and-broadcast") throw new Error("unreachable");
      const txHash = sent.txHash;

      const word = (value: string | bigint): string =>
        (typeof value === "bigint" ? value.toString(16) : BigInt(value).toString(16)).padStart(
          64,
          "0",
        );
      const topicFor = (address: string): string =>
        `0x${address.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
      const goodReceipt: ChainReceipt = {
        txHash,
        status: "success",
        blockNumber: 21_000_100,
        blockHash: `0x${"5".repeat(64)}`,
        gasUsed: "150000",
        effectiveGasPrice: "30000000000",
        logs: [
          {
            address: USDC,
            topics: [
              ERC20_TRANSFER_TOPIC,
              topicFor("0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640"),
              topicFor(RECIPIENT),
            ],
            data: `0x${word("2499000000")}`,
          },
        ],
      };

      const settled = yield* svc.settleFromReceipt({
        intentId,
        receipt: goodReceipt,
        now: NOW + 6_000,
      });
      assert.equal(settled.status, "settled", JSON.stringify(settled));
      if (settled.status !== "settled") throw new Error("unreachable");
      assert.equal(settled.settlement.status, "settled-success");
      assert.equal(settled.settlement.actualOutputRaw, "2499000000");
      assert.equal(settled.settlement.actualFeeWei, (150_000n * 30_000_000_000n).toString(10));

      // Idempotent: settling the same receipt again settles nothing new.
      const again = yield* svc.settleFromReceipt({
        intentId,
        receipt: goodReceipt,
        now: NOW + 7_000,
      });
      assert.equal(again.status, "already-settled");

      const sqlClient = yield* SqlClient.SqlClient;
      const reservation = yield* sqlClient<{ readonly status: string }>`
        SELECT status FROM execution_swap_reservations WHERE intent_id = ${intentId}
      `;
      assert.equal(reservation[0]?.status, "settled-success");
      const intent = yield* sqlClient<{ readonly status: string }>`
        SELECT status FROM execution_swap_intents WHERE intent_id = ${intentId}
      `;
      assert.equal(intent[0]?.status, "confirmed");
      const proposal = yield* sqlClient<{ readonly status: string }>`
        SELECT p.status FROM execution_proposals p
        JOIN execution_swap_intents i ON i.proposal_id = p.proposal_id
        WHERE i.intent_id = ${intentId}
      `;
      assert.equal(proposal[0]?.status, "executed");
      const receipts = yield* sqlClient<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM execution_swap_receipts WHERE tx_hash = ${txHash}
      `;
      assert.equal(receipts[0]?.n, 1);
    }),
  );

  it.effect("status 1 WITHOUT the expected transfer evidence refuses to settle", () =>
    Effect.gen(function* () {
      yield* reset;
      const { intentId } = yield* admittedIntent();
      const svc = yield* buildLifecycle(
        fakeSink({ available: true }).service,
        armedSigner,
        healthyChain,
      );
      yield* svc.createSigningSnapshot({ intentId, nonce: 3, now: NOW + 3_000 });
      const sent = yield* svc.signAndBroadcast({ intentId, now: NOW + 4_000 });
      assert.equal(sent.status, "signed-and-broadcast");
      if (sent.status !== "signed-and-broadcast") throw new Error("unreachable");

      const emptyReceipt: ChainReceipt = {
        txHash: sent.txHash,
        status: "success",
        blockNumber: 21_000_100,
        blockHash: `0x${"6".repeat(64)}`,
        gasUsed: "150000",
        effectiveGasPrice: "30000000000",
        logs: [],
      };
      const refused = yield* svc.settleFromReceipt({
        intentId,
        receipt: emptyReceipt,
        now: NOW + 6_000,
      });
      assert.equal(refused.status, "refused");
      if (refused.status !== "refused") throw new Error("unreachable");
      assert.equal(refused.refusal, "evidence-mismatch");

      const sqlClient = yield* SqlClient.SqlClient;
      const reservation = yield* sqlClient<{ readonly status: string }>`
        SELECT status FROM execution_swap_reservations WHERE intent_id = ${intentId}
      `;
      assert.equal(reservation[0]?.status, "reserved");
      const receipts = yield* sqlClient<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM execution_swap_receipts
      `;
      assert.equal(receipts[0]?.n, 0);
    }),
  );

  it.effect("a reverted receipt settles fees only and releases the principal", () =>
    Effect.gen(function* () {
      yield* reset;
      const { intentId } = yield* admittedIntent();
      const svc = yield* buildLifecycle(
        fakeSink({ available: true }).service,
        armedSigner,
        healthyChain,
      );
      yield* svc.createSigningSnapshot({ intentId, nonce: 3, now: NOW + 3_000 });
      const sent = yield* svc.signAndBroadcast({ intentId, now: NOW + 4_000 });
      assert.equal(sent.status, "signed-and-broadcast");
      if (sent.status !== "signed-and-broadcast") throw new Error("unreachable");

      const reverted: ChainReceipt = {
        txHash: sent.txHash,
        status: "reverted",
        blockNumber: 21_000_100,
        blockHash: `0x${"7".repeat(64)}`,
        gasUsed: "120000",
        effectiveGasPrice: "30000000000",
        logs: [],
      };
      const settled = yield* svc.settleFromReceipt({
        intentId,
        receipt: reverted,
        now: NOW + 6_000,
      });
      assert.equal(settled.status, "settled");
      if (settled.status !== "settled") throw new Error("unreachable");
      assert.equal(settled.settlement.status, "settled-revert");
      assert.equal(settled.settlement.actualFeeWei, (120_000n * 30_000_000_000n).toString(10));
      assert.isNull(settled.settlement.actualOutputRaw);

      const sqlClient = yield* SqlClient.SqlClient;
      const reservation = yield* sqlClient<{ readonly status: string }>`
        SELECT status FROM execution_swap_reservations WHERE intent_id = ${intentId}
      `;
      assert.equal(reservation[0]?.status, "settled-revert");
      const proposal = yield* sqlClient<{ readonly status: string }>`
        SELECT p.status FROM execution_proposals p
        JOIN execution_swap_intents i ON i.proposal_id = p.proposal_id
        WHERE i.intent_id = ${intentId}
      `;
      // The stage is consumed but the input was never spent.
      assert.equal(proposal[0]?.status, "rejected");
      const budget = yield* sqlClient<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM execution_proposals WHERE status = 'executed'
      `;
      assert.equal(budget[0]?.n, 0);
    }),
  );

  // -------------------------------------------------------------------------
  // Review repairs: released reservations, sign-gate refusals, resumption
  // -------------------------------------------------------------------------

  it.effect(
    "a released reservation refuses signAndBroadcast — by name when the attempt row still says reserved",
    () =>
      Effect.gen(function* () {
        yield* reset;
        const { intentId } = yield* admittedIntent();
        const svc = yield* buildLifecycle(
          fakeSink({ available: true }).service,
          armedSigner,
          healthyChain,
        );
        yield* svc.createSigningSnapshot({ intentId, nonce: 3, now: NOW + 3_000 });

        // The DORMANT defect state: the reservation is released but the
        // attempt row still says reserved. Signing must refuse BY NAME.
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
        UPDATE execution_swap_reservations SET status = 'released', released_at_ms = ${NOW + 3_500}, release_reason = 'withdrawn'
        WHERE intent_id = ${intentId}
      `;
        const dormant = yield* svc.signAndBroadcast({ intentId, now: NOW + 4_000 });
        assert.equal(dormant.status, "refused", JSON.stringify(dormant));
        if (dormant.status !== "refused") throw new Error("unreachable");
        assert.equal(dormant.refusal, "reservation-released");
        // The repair also lands the documented exit on the attempt row.
        const attempt = yield* sql<{ readonly status: string }>`
        SELECT status FROM execution_swap_attempts WHERE intent_id = ${intentId}
      `;
        assert.equal(attempt[0]?.status, "released-before-sign");
        const noSigned = yield* sql<{ readonly signed_tx_rlp: string | null }>`
        SELECT signed_tx_rlp FROM execution_swap_attempts WHERE intent_id = ${intentId}
      `;
        assert.isNull(noSigned[0]?.signed_tx_rlp);

        // The CLEAN release path writes the same exit itself; signing then
        // refuses on the written state.
        const { intentId: second } = yield* admittedIntent();
        const secondSvc = yield* buildLifecycle(
          fakeSink({ available: true }).service,
          armedSigner,
          healthyChain,
        );
        yield* secondSvc.createSigningSnapshot({ intentId: second, nonce: 4, now: NOW + 3_000 });
        yield* sql`
        UPDATE execution_swap_reservations SET status = 'released', released_at_ms = ${NOW + 3_500}, release_reason = 'withdrawn'
        WHERE intent_id = ${second}
      `;
        yield* sql`
        UPDATE execution_swap_attempts SET status = 'released-before-sign' WHERE intent_id = ${second}
      `;
        const clean = yield* secondSvc.signAndBroadcast({ intentId: second, now: NOW + 4_000 });
        assert.equal(clean.status, "refused");
        if (clean.status !== "refused") throw new Error("unreachable");
        assert.equal(clean.refusal, "wrong-state");
      }),
  );

  it.effect(
    "sign-gate refusals: signer unarmed, funding insufficient, price impact, stale reference, wrong chain",
    () =>
      Effect.gen(function* () {
        // Each variant re-seeds its own admission under a widened envelope so
        // five parallel unspent admissions never hit the caps.
        const wide = {
          inputCapTotalRaw: "10000000000000000000",
          maxTransactions: 8,
          maxConcurrentIntents: 8,
        };
        const expectRefusal = (
          sink: ReturnType<typeof fakeSink>["service"],
          signer: ReturnType<typeof SpotDemoSignerConfig.of>,
          rpc: ReturnType<typeof makeFakeRpc>,
          refusal: string,
        ) =>
          Effect.gen(function* () {
            const seeded = yield* admittedIntent(wide);
            const svc = yield* buildLifecycle(sink, signer, rpc);
            yield* svc.createSigningSnapshot({
              intentId: seeded.intentId,
              nonce: 5,
              now: NOW + 3_000,
            });
            const outcome: SignAndBroadcastOutcome = yield* svc.signAndBroadcast({
              intentId: seeded.intentId,
              now: NOW + 4_000,
            });
            assert.equal(outcome.status, "refused", JSON.stringify(outcome));
            if (outcome.status !== "refused") throw new Error("unreachable");
            assert.equal(outcome.refusal, refusal);
            const sql = yield* SqlClient.SqlClient;
            const noSigned = yield* sql<{ readonly signed_tx_rlp: string | null }>`
          SELECT signed_tx_rlp FROM execution_swap_attempts WHERE intent_id = ${seeded.intentId}
        `;
            assert.isNull(noSigned[0]?.signed_tx_rlp);
          });

        yield* expectRefusal(
          fakeSink({ available: true }).service,
          unarmedSigner,
          healthyChain,
          "signer-unarmed",
        );

        const poor = makeFakeRpc((method) => (method === "eth_getBalance" ? "0x1000" : undefined));
        yield* expectRefusal(
          fakeSink({ available: true }).service,
          armedSigner,
          poor,
          "funding-insufficient",
        );

        // A TWAP far from the quote floor (tick an order of magnitude away).
        const skewedWord = (value: bigint): string =>
          (value >= 0n ? value : (1n << 256n) + value).toString(16).padStart(64, "0");
        const skewedObserve = `0x${skewedWord(0x40n)}${skewedWord(0xa0n)}${skewedWord(1n)}${skewedWord(BigInt(-874000) * 1800n)}${skewedWord(1n)}${skewedWord(0n)}`;
        const skewed = makeFakeRpc((method, params) => {
          if (method === "eth_call") {
            const call = params[0] as { readonly data: string };
            return call.data.slice(0, 10) === "0x883bdbfd" ? skewedObserve : undefined;
          }
          return undefined;
        });
        yield* expectRefusal(
          fakeSink({ available: true }).service,
          armedSigner,
          skewed,
          "price-impact",
        );

        const stale = makeFakeRpc((method) =>
          method === "eth_getBlockByNumber"
            ? { timestamp: `0x${Math.floor((NOW - 10 * 60_000) / 1000).toString(16)}` }
            : undefined,
        );
        yield* expectRefusal(
          fakeSink({ available: true }).service,
          armedSigner,
          stale,
          "reference-unavailable",
        );

        const wrongChain = makeFakeRpc((method) => (method === "eth_chainId" ? "0x2" : undefined));
        yield* expectRefusal(
          fakeSink({ available: true }).service,
          armedSigner,
          wrongChain,
          "route-unapproved",
        );
      }),
  );

  it.effect(
    "crash-after-sign resumption broadcasts the SAME bytes and hash, never a second signature",
    () =>
      Effect.gen(function* () {
        yield* reset;
        const { intentId } = yield* admittedIntent();
        const sink = fakeSink({ available: true, txHash: `0x${"7".repeat(64)}` });
        const svc = yield* buildLifecycle(sink.service, armedSigner, healthyChain);
        yield* svc.createSigningSnapshot({ intentId, nonce: 6, now: NOW + 3_000 });

        const first = yield* svc.signAndBroadcast({ intentId, now: NOW + 4_000 });
        assert.equal(first.status, "signed-and-broadcast");
        if (first.status !== "signed-and-broadcast") throw new Error("unreachable");

        // The crash window: re-entering signAndBroadcast resumes the SAME
        // intent/hash and re-broadcasts identical bytes only.
        const resumed = yield* svc.signAndBroadcast({ intentId, now: NOW + 5_000 });
        assert.equal(resumed.status, "already-broadcast");
        if (resumed.status !== "already-broadcast") throw new Error("unreachable");
        assert.equal(resumed.txHash, first.txHash);
        assert.equal(sink.broadcasts.length, 2);
        assert.strictEqual(sink.broadcasts[1], sink.broadcasts[0]);
      }),
  );

  it.effect(
    "reconcile resolves by the same hash: pending, dropped-retransmitted, and nonce-consumed-elsewhere",
    () =>
      Effect.gen(function* () {
        // Pending: the tx is known to the node, no receipt yet.
        yield* reset;
        {
          const { intentId } = yield* admittedIntent();
          const sink = fakeSink({ available: true, txHash: `0x${"7".repeat(64)}` });
          const rpc = makeFakeRpc((method, params) => {
            if (method === "eth_getTransactionByHash") return { nonce: "0x9" };
            if (method === "eth_getTransactionReceipt") return null;
            return undefined;
          });
          const svc = yield* buildLifecycle(sink.service, armedSigner, rpc);
          yield* svc.createSigningSnapshot({ intentId, nonce: 9, now: NOW + 3_000 });
          yield* svc.signAndBroadcast({ intentId, now: NOW + 4_000 });
          const outcome = yield* svc.reconcile({ intentId, now: NOW + 5_000 });
          assert.equal(outcome.status, "no-receipt-yet", JSON.stringify(outcome));
          const sql = yield* SqlClient.SqlClient;
          const attempt = yield* sql<{ readonly status: string }>`
          SELECT status FROM execution_swap_attempts WHERE intent_id = ${intentId}
        `;
          assert.equal(attempt[0]?.status, "unknown");
        }

        // Dropped with the nonce still free: byte-identical retransmission.
        yield* reset;
        {
          const { intentId } = yield* admittedIntent();
          const sink = fakeSink({ available: true, txHash: `0x${"7".repeat(64)}` });
          const rpc = makeFakeRpc((method) => {
            if (method === "eth_getTransactionByHash") return null;
            if (method === "eth_getTransactionReceipt") return null;
            if (method === "eth_getTransactionCount") return "0x0";
            return undefined;
          });
          const svc = yield* buildLifecycle(sink.service, armedSigner, rpc);
          yield* svc.createSigningSnapshot({ intentId, nonce: 10, now: NOW + 3_000 });
          const first = yield* svc.signAndBroadcast({ intentId, now: NOW + 4_000 });
          assert.equal(first.status, "signed-and-broadcast");
          const retransmitted = yield* svc.reconcile({ intentId, now: NOW + 5_000 });
          assert.equal(
            retransmitted.status,
            "dropped-retransmitted",
            JSON.stringify(retransmitted),
          );
          // Identical bytes only.
          assert.equal(sink.broadcasts.length, 2);
          assert.strictEqual(sink.broadcasts[1], sink.broadcasts[0]);
        }

        // Nonce consumed by an unexpected transaction: explicit state, no new
        // economic action.
        yield* reset;
        {
          const { intentId } = yield* admittedIntent();
          const sink = fakeSink({ available: true, txHash: `0x${"7".repeat(64)}` });
          const rpc = makeFakeRpc((method) => {
            if (method === "eth_getTransactionByHash") return null;
            if (method === "eth_getTransactionReceipt") return null;
            if (method === "eth_getTransactionCount") return "0x20";
            return undefined;
          });
          const svc = yield* buildLifecycle(sink.service, armedSigner, rpc);
          yield* svc.createSigningSnapshot({ intentId, nonce: 11, now: NOW + 3_000 });
          yield* svc.signAndBroadcast({ intentId, now: NOW + 4_000 });
          const outcome = yield* svc.reconcile({ intentId, now: NOW + 5_000 });
          assert.equal(outcome.status, "nonce-consumed-elsewhere", JSON.stringify(outcome));
          const sql = yield* SqlClient.SqlClient;
          const attempt = yield* sql<{
            readonly status: string;
            readonly refusal_reason: string | null;
          }>`
          SELECT status, refusal_reason FROM execution_swap_attempts WHERE intent_id = ${intentId}
        `;
          assert.equal(attempt[0]?.status, "unknown");
          assert.include(attempt[0]?.refusal_reason ?? "", "reconciliation needed");
          // No retransmission was attempted.
          assert.equal(sink.broadcasts.length, 1);
        }
      }),
  );

  it.effect("a success receipt whose Transfer emits from the WRONG token refuses to settle", () =>
    Effect.gen(function* () {
      yield* reset;
      const { intentId } = yield* admittedIntent();
      const svc = yield* buildLifecycle(
        fakeSink({ available: true }).service,
        armedSigner,
        healthyChain,
      );
      yield* svc.createSigningSnapshot({ intentId, nonce: 3, now: NOW + 3_000 });
      const sent = yield* svc.signAndBroadcast({ intentId, now: NOW + 4_000 });
      assert.equal(sent.status, "signed-and-broadcast");
      if (sent.status !== "signed-and-broadcast") throw new Error("unreachable");

      const word = (value: string | bigint): string =>
        (typeof value === "bigint" ? value.toString(16) : BigInt(value).toString(16)).padStart(
          64,
          "0",
        );
      const topicFor = (address: string): string =>
        `0x${address.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
      const wrongTokenReceipt: ChainReceipt = {
        txHash: sent.txHash,
        status: "success",
        blockNumber: 21_000_100,
        blockHash: `0x${"8".repeat(64)}`,
        gasUsed: "150000",
        effectiveGasPrice: "30000000000",
        logs: [
          {
            // A plausible-looking USDC-sized transfer emitted by some OTHER
            // ERC20 — value and recipient match, the token does not.
            address: "0x1111111111111111111111111111111111111111",
            topics: [
              ERC20_TRANSFER_TOPIC,
              topicFor("0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640"),
              topicFor(RECIPIENT),
            ],
            data: `0x${word("2499000000")}`,
          },
        ],
      };
      const refusedSettlement = yield* svc.settleFromReceipt({
        intentId,
        receipt: wrongTokenReceipt,
        now: NOW + 6_000,
      });
      assert.equal(refusedSettlement.status, "refused", JSON.stringify(refusedSettlement));
      if (refusedSettlement.status !== "refused") throw new Error("unreachable");
      assert.equal(refusedSettlement.refusal, "evidence-mismatch");

      const sql = yield* SqlClient.SqlClient;
      const reservation = yield* sql<{ readonly status: string }>`
        SELECT status FROM execution_swap_reservations WHERE intent_id = ${intentId}
      `;
      assert.equal(reservation[0]?.status, "reserved");
      const receipts = yield* sql<{
        readonly n: number;
      }>`SELECT COUNT(*) AS n FROM execution_swap_receipts`;
      assert.equal(receipts[0]?.n, 0);
    }),
  );
});
