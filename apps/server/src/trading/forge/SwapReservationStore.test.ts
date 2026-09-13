/**
 * SwapReservationStore — the atomic admission contract over real SQLite
 * (in-memory; migrations 105-107 + 110-111 run directly), with the REAL
 * envelope evaluator and detector run store seeding one approved envelope
 * and one persisted swap proposal, the real route resolver carrying a
 * ur-v3 mainnet route, and the fake capability-store/sandbox seams.
 *
 * What is pinned here: the happy admission claims the stage ONCE and writes
 * reservation + intent + attempt together (the proposal moves to
 * executing); replay collapses; the caps (maxTransactions,
 * maxConcurrentIntents) are enforced by counting committed reservations;
 * the corrupt ledger refuses by name; the quote-identity contract refuses
 * missing fields and a STALE route-config digest (same routeId, changed
 * config); measured fees beyond maxGasWei refuse; deadline bounds refuse;
 * and the pre-sign release path gives the input back.
 *
 * @module SwapReservationStore.test
 */
// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off preferSchemaOverJson:off tryCatchInEffectGen:off runEffectInsideEffect:off - sqlite fixtures are the data under test; JSON is the storage codec under test.
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  type DetectorEvaluationRecordV2,
  detectorEvaluationId,
  type ExecutionEnvelope,
  type SwapQuoteRecord,
  encodeDetectorState,
  swapQuoteId,
} from "@t3tools/trading-contracts";
import { keccak256, toBytes } from "viem";
import { SpotMainnetTransport, type SpotMainnetTarget } from "./SpotMainnetTarget.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import createDetectorTables from "../../persistence/Migrations/105_DetectorRuns.ts";
import createExecutionTables from "../../persistence/Migrations/106_ExecutionEnvelopes.ts";
import createSwapIntentTables from "../../persistence/Migrations/107_SwapIntents.ts";
import createSwapReservationTables from "../../persistence/Migrations/110_SwapReservations.ts";
import createSwapLifecycleTables from "../../persistence/Migrations/111_SwapBroadcastLifecycle.ts";
import type { PersistenceSqlError } from "../../persistence/Errors.ts";
import {
  ForgeCapabilitySandbox,
  forgeSha256Hex,
  ForgeSandboxError,
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
  type ProtectedAdmissionOutcome,
  type SwapReservationStoreShape,
} from "./SwapReservationStore.ts";
import {
  resolveSwapRouteSettings,
  SwapRouteConfig,
  swapRouteConfigDigest,
  type SwapRouteSettings,
} from "./UniswapQuoteService.ts";
import { decodeProtectedExactInput } from "./MainnetProtectedRouter.ts";

const ENV = "env_reservations";
const CAP = "flow-policy";
const NOW = 1_700_000_000_000;

const layer = it.layer(NodeSqliteClient.layerMemory());

// ---------------------------------------------------------------------------
// Fixtures (the P5.3 fake store/sandbox pair, restated for this suite)
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
  '  proposal: { kind: "swap", candidateId: input.envelope.candidates[0]?.candidateId ?? "cand_1", amountInRaw: "400000000000000000", quoteId: "sq_fixture", occurrenceKey: "occ", stageKey: "entry", detectorEvaluationId: input.detectorEvaluation.evaluationId },',
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
    semantics: "fixture detector with an execution policy",
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

const unused = () => Effect.die("unused in this test");

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

/** The stage the fake policy proposes next (tests set it per evaluation). */
const policyStage: { stageKey: string } = { stageKey: "entry" };

const fakeSandbox: ForgeCapabilitySandboxShape = {
  available: Effect.succeed(true),
  runBuildStep: () => Effect.die("not used here"),
  runEvaluation: (request) =>
    Effect.gen(function* () {
      const input = JSON.parse(request.stdinJson) as {
        readonly envelope: { readonly candidates: ReadonlyArray<{ readonly candidateId: string }> };
        readonly detectorEvaluation: {
          readonly evaluationId: string;
          readonly result: { readonly status: string; readonly occurrenceKey?: string };
        };
      };
      const output = {
        proposal: {
          kind: "swap",
          candidateId: input.envelope.candidates[0]?.candidateId ?? "cand_1",
          amountInRaw: "400000000000000000",
          quoteId: "sq_fixture",
          occurrenceKey:
            input.detectorEvaluation.result.status === "matched"
              ? input.detectorEvaluation.result.occurrenceKey
              : "occ",
          stageKey: policyStage.stageKey,
          detectorEvaluationId: input.detectorEvaluation.evaluationId,
        },
        nextState: { stateSchemaVersion: 1, state: {} },
      };
      return yield* Effect.try({
        try: () => request.decodeResult(JSON.parse(JSON.stringify(output))),
        catch: () =>
          new ForgeSandboxError({
            kind: "invalid_result",
            reason: "evaluation output failed host schema validation",
          }),
      });
    }),
};

// ---------------------------------------------------------------------------
// The mainnet route + the full-identity quote
// ---------------------------------------------------------------------------

const ROUTER = "0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad";
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const QUOTER = "0x61ffe014ba17989e743c5f6cb21bf9697530b21e";
const NATIVE = `0x${"0".repeat(40)}`;
const RECIPIENT = `0x${"cc".repeat(20)}`;

const mainnetRoute = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  routeId: "mainnet-eth-usdc",
  chainId: "1",
  routeType: "ur-v3-exact-input",
  tokenIn: NATIVE,
  tokenOut: USDC,
  quoterAddress: QUOTER,
  swapTargetAddress: ROUTER,
  weth: WETH,
  feeTier: 500,
  ...overrides,
});

const routeEnv = (routes: ReadonlyArray<Record<string, unknown>>): Record<string, string> => ({
  T3_SWAP_ROUTES: JSON.stringify(routes),
});

const routeSettingsFor = (env: Record<string, string>): SwapRouteSettings => {
  const settings = resolveSwapRouteSettings(env);
  assert.isTrue(settings.configured, settings.reason ?? "routes must resolve");
  return settings;
};

const settingsOf = (
  routes: ReadonlyArray<Record<string, unknown>> = [mainnetRoute()],
): SwapRouteSettings => routeSettingsFor(routeEnv([...routes]));

/** The fake spot target every admission test resolves against. */
const POOL = "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640";
const FAKE_CODE = "0x6080";
/** Pins are 0x-prefixed (the production pin format); quote fields are bare. */
const FAKE_CODE_HASH_PIN = keccak256(toBytes(FAKE_CODE));
const FAKE_CODE_HASH = FAKE_CODE_HASH_PIN.replace(/^0x/, "");
const hexWord = (value: string | bigint): string =>
  (typeof value === "bigint"
    ? value.toString(16)
    : BigInt(value.toLowerCase()).toString(16)
  ).padStart(64, "0");

const spotTarget: SpotMainnetTarget = {
  chainId: 1,
  rpcUrl: "https://example.invalid",
  accountAddress: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
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
 * A fake mainnet RPC answering the full admission verification script:
 * chain id, uniform runtime code (whose keccak the target pins), the
 * factory's pool lookup, the pool's views, and both tokens' decimals.
 */
const makeSpotRpc = (overrides: Record<string, unknown> = {}) =>
  SpotMainnetTransport.of({
    target: () => spotTarget,
    request: (method, params) =>
      Effect.gen(function* () {
        if (Object.prototype.hasOwnProperty.call(overrides, method)) {
          const served = overrides[method];
          if (served === undefined) {
            return yield* Effect.fail(`no fixture for ${method}`);
          }
          return typeof served === "function" ? served(params) : served;
        }
        if (method === "eth_chainId") return "0x1";
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
          return yield* Effect.fail(`no eth_call fixture for ${to} ${selector}`);
        }
        return yield* Effect.fail(`no fixture for ${method}`);
      }),
  });

/** A complete v3-identity quote for the mainnet route, fresh at NOW.
 *  Overrides merge BEFORE the id is derived, so a customized quote stays
 *  content-consistent; tampering tests override `quoteId` itself. */
const identityQuote = (
  settings: SwapRouteSettings,
  overrides: Partial<SwapQuoteRecord> = {},
): SwapQuoteRecord => {
  const route = settings.routes?.[0];
  assert.isDefined(route);
  const base = {
    chainId: "1",
    routeId: route!.routeId,
    tokenIn: NATIVE,
    tokenOut: USDC,
    amountInRaw: "400000000000000000",
    minAmountOutRaw: "2493000000",
    gasEstimateWei: (220_000n * 40_000_000_000n).toString(10),
    quotedAtMs: NOW - 1_000,
    expiresAtMs: NOW + 30_000,
    basis: "eth_call" as const,
    routeConfigDigest: swapRouteConfigDigest(route!),
    quotedBlockNumber: "21000000",
    quotedBlockHash: "ab".repeat(32),
    quotedAmountOutRaw: "2500500000",
    quoterCodeHash: FAKE_CODE_HASH,
    targetCodeHash: FAKE_CODE_HASH,
    gasUnitsMeasured: "220000",
    maxFeePerGasWei: "40000000000",
    maxPriorityFeePerGasWei: "1500000000",
  };
  const merged = { ...base, ...overrides } as typeof base;
  return {
    ...merged,
    quoteId: swapQuoteId({
      chainId: merged.chainId,
      routeId: merged.routeId,
      tokenIn: merged.tokenIn,
      tokenOut: merged.tokenOut,
      amountInRaw: merged.amountInRaw,
      minAmountOutRaw: merged.minAmountOutRaw,
      quotedAtMs: merged.quotedAtMs,
      expiresAtMs: merged.expiresAtMs,
      routeConfigDigest: merged.routeConfigDigest,
      quotedBlockNumber: merged.quotedBlockNumber,
      quotedBlockHash: merged.quotedBlockHash,
      quotedAmountOutRaw: merged.quotedAmountOutRaw,
      quoterCodeHash: merged.quoterCodeHash,
      targetCodeHash: merged.targetCodeHash,
      gasUnitsMeasured: merged.gasUnitsMeasured,
      maxFeePerGasWei: merged.maxFeePerGasWei,
      maxPriorityFeePerGasWei: merged.maxPriorityFeePerGasWei,
    }),
  } as SwapQuoteRecord;
};

const CANDIDATE = {
  candidateId: "cand_eth_usdc",
  chainId: "1",
  tokenIn: NATIVE,
  tokenOut: USDC,
  recipient: RECIPIENT,
  label: "ETH -> USDC",
} as const;

const envelopeFixture = (overrides: Partial<ExecutionEnvelope> = {}): ExecutionEnvelope => ({
  revision: 1,
  environmentId: ENV,
  accountId: "acct-spot",
  expiresAtMs: NOW + 3_600_000,
  detectorBundleSha256: forgeSha256Hex(DETECTOR_TS),
  policyBundleSha256: forgeSha256Hex(POLICY_TS),
  candidates: [CANDIDATE],
  inputCapTotalRaw: "1000000000000000000",
  inputCapPerSwapRaw: "500000000000000000",
  maxGasWei: "20000000000000000",
  maxSlippageBps: 50,
  maxTransactions: 2,
  maxConcurrentIntents: 1,
  ...overrides,
});

const matchedRecord = (revision: number, occurrenceKey: string): DetectorEvaluationRecordV2 => {
  const inputDigest = "c".repeat(63) + String(revision % 10);
  return {
    manifestVersion: 2,
    evaluationId: detectorEvaluationId({
      environmentId: ENV,
      capabilityId: CAP,
      version: 1,
      stateRevision: revision,
      inputDigest,
    }),
    environmentId: ENV,
    capabilityId: CAP,
    version: 1,
    stateRevision: revision,
    inputDigest,
    asOfMs: NOW - 10_000,
    result: {
      status: "matched",
      occurrenceKey,
      evidenceIds: ["ev_1"],
      facts: [],
      validUntilMs: NOW + 600_000,
    },
    state: { stateSchemaVersion: 1, state: { count: revision } },
    evidenceIds: ["ev_1"],
    committedAtMs: NOW - 5_000 + revision,
  };
};

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
  settings: SwapRouteSettings = settingsOf(),
  rpc: ReturnType<typeof makeSpotRpc> = makeSpotRpc(),
): Effect.Effect<SwapReservationStoreShape, never, SqlClient.SqlClient> =>
  Effect.provideService(
    makeSwapReservationStore,
    SwapRouteConfig,
    SwapRouteConfig.of({ resolve: Effect.succeed(settings) }),
  ).pipe(
    Effect.provideService(ForgeCapabilityStore, fakeStore),
    Effect.provideService(SpotMainnetTransport, rpc),
  );

/** Propose + approve the mainnet envelope; returns the envelope id. */
const approvedEnvelope = (
  policy: ExecutionPolicyServiceShape,
  overrides: Partial<ExecutionEnvelope> = {},
): Effect.Effect<string, PersistenceSqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const proposed = yield* policy.proposeEnvelope({
      environmentId: ENV,
      envelope: envelopeFixture(overrides),
      now: NOW,
      proposedVia: "test",
      capabilityId: CAP,
    });
    assert.equal(proposed.status, "proposed");
    if (proposed.status !== "proposed") throw new Error("unreachable");
    const approved = yield* policy.approveEnvelope({
      envelopeId: proposed.envelopeId,
      now: NOW,
      approvedVia: "local-operator",
    });
    assert.equal(approved.status, "approved");
    return proposed.envelopeId;
  });

/** Commit a matched evaluation and run the policy once: one swap proposal. */
const seededProposal = (
  policy: ExecutionPolicyServiceShape,
  envelopeOverrides: Partial<ExecutionEnvelope> = {},
): Effect.Effect<string, PersistenceSqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    yield* approvedEnvelope(policy, envelopeOverrides);
    const encoded = encodeDetectorState(matchedRecord(0, "occ-entry-1").state);
    assert.isTrue(encoded.ok);
    if (!encoded.ok) throw new Error("unreachable");
    yield* Effect.flatMap(makeDetectorRunStore, (runs) =>
      runs.commitRun({ record: matchedRecord(0, "occ-entry-1"), stateBytes: encoded.serialized }),
    );
    const outcome = yield* policy.evaluatePolicy({
      environmentId: ENV,
      capabilityId: CAP,
      now: NOW + 1,
    });
    assert.equal(outcome.status, "proposed");
    if (outcome.status !== "proposed") throw new Error("unreachable");
    return outcome.proposalId;
  });

const refused = (
  outcome: ProtectedAdmissionOutcome,
  refusal: string,
): { readonly detail: string } => {
  assert.equal(outcome.status, "refused", `expected refusal, got ${JSON.stringify(outcome)}`);
  if (outcome.status !== "refused") throw new Error("unreachable");
  assert.equal(outcome.refusal, refusal);
  return { detail: outcome.detail };
};

const DEADLINE = Math.floor(NOW / 1000) + 600;

// ---------------------------------------------------------------------------
// The admission contract
// ---------------------------------------------------------------------------

layer("SwapReservationStore admission", (it) => {
  it.effect(
    "happy admission: one transaction claims the stage, reserves, and writes the protected intent",
    () =>
      Effect.gen(function* () {
        yield* reset;
        const policy = yield* policyService();
        const store = yield* reservationStore();
        const settings = settingsOf();
        const proposalId = yield* seededProposal(policy);

        const outcome = yield* store.admitProtectedSwap({
          environmentId: ENV,
          proposalId,
          quote: identityQuote(settings),
          deadlineUnix: DEADLINE,
          now: NOW + 2_000,
        });
        assert.equal(outcome.status, "admitted");
        if (outcome.status !== "admitted") throw new Error("unreachable");

        // The protected intent carries the decoded-and-verified calldata.
        const decoded = decodeProtectedExactInput(
          (JSON.parse(outcome.intent.preparedTxJson) as { readonly data: string }).data,
        );
        assert.isNotNull(decoded);
        assert.deepEqual(decoded?.commandTypes, [0x0b, 0x00]);
        assert.equal(decoded?.v3Swap?.recipient, RECIPIENT);
        assert.equal(decoded?.deadlineUnix, String(DEADLINE));
        assert.equal(outcome.feesReservedWei, (220_000n * 40_000_000_000n).toString(10));

        const sql = yield* SqlClient.SqlClient;
        const proposalRow = yield* sql<{ readonly status: string }>`
        SELECT status FROM execution_proposals WHERE proposal_id = ${proposalId}
      `;
        assert.equal(proposalRow[0]?.status, "executing");
        const reservation = yield* store.reservationForIntent(outcome.intent.intentId);
        assert.equal(reservation?.status, "reserved");
        assert.equal(reservation?.amountInRaw, "400000000000000000");
        assert.equal(reservation?.inputAsset, NATIVE);
        const attemptRow = yield* sql<{ readonly status: string }>`
        SELECT status FROM execution_swap_attempts WHERE intent_id = ${outcome.intent.intentId}
      `;
        assert.equal(attemptRow[0]?.status, "reserved");
      }),
  );

  it.effect("replaying the same stage collapses onto the existing reservation", () =>
    Effect.gen(function* () {
      yield* reset;
      const policy = yield* policyService();
      const store = yield* reservationStore();
      const settings = settingsOf();
      const proposalId = yield* seededProposal(policy);
      const quote = identityQuote(settings);

      const first = yield* store.admitProtectedSwap({
        environmentId: ENV,
        proposalId,
        quote,
        deadlineUnix: DEADLINE,
        now: NOW + 2_000,
      });
      assert.equal(first.status, "admitted");
      const replay = yield* store.admitProtectedSwap({
        environmentId: ENV,
        proposalId,
        quote,
        deadlineUnix: DEADLINE,
        now: NOW + 3_000,
      });
      assert.equal(replay.status, "already-admitted");
      if (replay.status !== "already-admitted") throw new Error("unreachable");
      if (first.status !== "admitted") throw new Error("unreachable");
      assert.equal(replay.reservationId, first.reservationId);

      const sql = yield* SqlClient.SqlClient;
      const count = yield* sql<{
        readonly n: number;
      }>`SELECT COUNT(*) AS n FROM execution_swap_reservations`;
      assert.equal(count[0]?.n, 1);
    }),
  );

  it.effect(
    "maxTransactions and maxConcurrentIntents are enforced by counting committed reservations",
    () =>
      Effect.gen(function* () {
        yield* reset;
        const policy = yield* policyService();
        const store = yield* reservationStore();
        const settings = settingsOf();
        // maxTransactions = 2, maxConcurrentIntents = 1 (the fixture); the
        // total cap is widened so the INPUT budget never binds before the
        // caps under test.
        const first = yield* seededProposal(policy, {
          inputCapTotalRaw: "4000000000000000000",
        });

        yield* store.admitProtectedSwap({
          environmentId: ENV,
          proposalId: first,
          quote: identityQuote(settings),
          deadlineUnix: DEADLINE,
          now: NOW + 2_000,
        });

        // A SECOND stage: the transaction cap has room, but the CONCURRENCY cap
        // is one in-flight reservation.
        const secondState = encodeDetectorState(matchedRecord(1, "occ-entry-2").state);
        assert.isTrue(secondState.ok);
        yield* Effect.flatMap(makeDetectorRunStore, (runs) =>
          runs.commitRun({
            record: matchedRecord(1, "occ-entry-2"),
            stateBytes: secondState.ok ? secondState.serialized : "die",
          }),
        ).pipe(Effect.flatMap(() => Effect.void));
        policyStage.stageKey = "second";
        const policyOutcome = yield* policy.evaluatePolicy({
          environmentId: ENV,
          capabilityId: CAP,
          now: NOW + 3,
        });
        assert.equal(policyOutcome.status, "proposed");
        if (policyOutcome.status !== "proposed") throw new Error("unreachable");

        const second = refused(
          yield* store.admitProtectedSwap({
            environmentId: ENV,
            proposalId: policyOutcome.proposalId,
            quote: identityQuote(settings),
            deadlineUnix: DEADLINE,
            now: NOW + 4_000,
          }),
          "concurrency-cap-exceeded",
        );
        assert.include(second.detail, "maxConcurrentIntents");

        // Settling the first as a success frees the concurrency slot; the
        // second then admits and consumes the LAST transaction slot.
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE execution_swap_reservations SET status = 'settled-success', settled_at_ms = ${NOW + 5000} WHERE status = 'reserved'`;
        const admitted = yield* store.admitProtectedSwap({
          environmentId: ENV,
          proposalId: policyOutcome.proposalId,
          quote: identityQuote(settings),
          deadlineUnix: DEADLINE,
          now: NOW + 5_000,
        });
        assert.equal(admitted.status, "admitted");

        // A THIRD stage: the transaction cap (2) is now consumed.
        const thirdState = encodeDetectorState(matchedRecord(2, "occ-entry-3").state);
        assert.isTrue(thirdState.ok);
        yield* Effect.flatMap(makeDetectorRunStore, (runs) =>
          runs.commitRun({
            record: matchedRecord(2, "occ-entry-3"),
            stateBytes: thirdState.ok ? thirdState.serialized : "die",
          }),
        ).pipe(Effect.flatMap(() => Effect.void));
        policyStage.stageKey = "third";
        const thirdOutcome = yield* policy.evaluatePolicy({
          environmentId: ENV,
          capabilityId: CAP,
          now: NOW + 6,
        });
        assert.equal(thirdOutcome.status, "proposed");
        if (thirdOutcome.status !== "proposed") throw new Error("unreachable");
        const third = refused(
          yield* store.admitProtectedSwap({
            environmentId: ENV,
            proposalId: thirdOutcome.proposalId,
            quote: identityQuote(settings),
            deadlineUnix: DEADLINE,
            now: NOW + 7_000,
          }),
          "transaction-cap-exceeded",
        );
        assert.include(third.detail, "maxTransactions");
      }),
  );

  it.effect(
    "a corrupt ledger row refuses corrupt-budget-ledger inside the admission transaction",
    () =>
      Effect.gen(function* () {
        yield* reset;
        const policy = yield* policyService();
        const store = yield* reservationStore();
        const settings = settingsOf();
        const proposalId = yield* seededProposal(policy);

        const sql = yield* SqlClient.SqlClient;
        yield* sql`
        INSERT INTO execution_proposals (
          proposal_id, environment_id, capability_id, envelope_id, envelope_revision,
          detector_evaluation_id, stage_key, proposal_json, status, proposed_at_ms
        ) VALUES (
          'pprop_corrupt', ${ENV}, ${CAP},
          (SELECT envelope_id FROM execution_envelopes LIMIT 1), 1,
          'dtev_corrupt', 'corrupt', '{"kind":"swap","amountInRaw":"1.5"}', 'executing', ${NOW}
        )
      `;
        refused(
          yield* store.admitProtectedSwap({
            environmentId: ENV,
            proposalId,
            quote: identityQuote(settings),
            deadlineUnix: DEADLINE,
            now: NOW + 2_000,
          }),
          "corrupt-budget-ledger",
        );
        const count = yield* sql<{
          readonly n: number;
        }>`SELECT COUNT(*) AS n FROM execution_swap_reservations`;
        assert.equal(count[0]?.n, 0);
      }),
  );

  it.effect("a quote without the v3 identity fields refuses quote-identity-missing", () =>
    Effect.gen(function* () {
      yield* reset;
      const policy = yield* policyService();
      const store = yield* reservationStore();
      const settings = settingsOf();
      const proposalId = yield* seededProposal(policy);

      const {
        routeConfigDigest: _d,
        quotedBlockNumber: _bn,
        quotedBlockHash: _bh,
        quotedAmountOutRaw: _qao,
        quoterCodeHash: _qc,
        targetCodeHash: _tc,
        gasUnitsMeasured: _gu,
        maxFeePerGasWei: _mf,
        maxPriorityFeePerGasWei: _mp,
        ...legacy
      } = identityQuote(settings);
      refused(
        yield* store.admitProtectedSwap({
          environmentId: ENV,
          proposalId,
          quote: legacy,
          deadlineUnix: DEADLINE,
          now: NOW + 2_000,
        }),
        "quote-identity-missing",
      );
    }),
  );

  it.effect(
    "a quote whose route-config digest is stale refuses even though the routeId is unchanged",
    () =>
      Effect.gen(function* () {
        yield* reset;
        const policy = yield* policyService();
        // The admission store sees the CURRENT registry; the quote was priced
        // under an older config (a different router address).
        const store = yield* reservationStore();
        const staleSettings = settingsOf([mainnetRoute()]);
        const proposalId = yield* seededProposal(policy);

        const staleQuote = identityQuote(staleSettings);
        const currentSettings = settingsOf([
          mainnetRoute({ swapTargetAddress: "0xcb640a86855f1a828c27241ba364348de28abe66" }),
        ]);
        const currentStore = yield* reservationStore(currentSettings);
        refused(
          yield* currentStore.admitProtectedSwap({
            environmentId: ENV,
            proposalId,
            quote: staleQuote,
            deadlineUnix: DEADLINE,
            now: NOW + 2_000,
          }),
          "quote-identity-missing",
        );
      }),
  );

  it.effect("measured fees beyond the envelope gas cap and out-of-range deadlines refuse", () =>
    Effect.gen(function* () {
      yield* reset;
      const policy = yield* policyService();
      const store = yield* reservationStore();
      const settings = settingsOf();
      const proposalId = yield* seededProposal(policy);

      const overGas = identityQuote(settings, {
        gasUnitsMeasured: "600000",
        gasEstimateWei: (600_000n * 40_000_000_000n).toString(10),
      });
      refused(
        yield* store.admitProtectedSwap({
          environmentId: ENV,
          proposalId,
          quote: overGas,
          deadlineUnix: DEADLINE,
          now: NOW + 2_000,
        }),
        "gas-cap-exceeded",
      );

      const tooLate = yield* store.admitProtectedSwap({
        environmentId: ENV,
        proposalId,
        quote: identityQuote(settings),
        deadlineUnix: Math.floor(NOW / 1000) + 10 * 3_600,
        now: NOW + 2_000,
      });
      refused(tooLate, "deadline-out-of-range");

      const tooSoon = yield* store.admitProtectedSwap({
        environmentId: ENV,
        proposalId,
        quote: identityQuote(settings),
        deadlineUnix: Math.floor(NOW / 1000) + 10,
        now: NOW + 2_000,
      });
      refused(tooSoon, "deadline-out-of-range");
    }),
  );

  it.effect("a slippage floor weaker than the envelope cap refuses", () =>
    Effect.gen(function* () {
      yield* reset;
      const policy = yield* policyService();
      const store = yield* reservationStore();
      const settings = settingsOf();
      const proposalId = yield* seededProposal(policy);

      // The envelope's cap is 50 bps; a 500 bps floor is weaker protection.
      const weak = identityQuote(settings, { minAmountOutRaw: "2380000000" });
      refused(
        yield* store.admitProtectedSwap({
          environmentId: ENV,
          proposalId,
          quote: weak,
          deadlineUnix: DEADLINE,
          now: NOW + 2_000,
        }),
        "stale-quote",
      );
    }),
  );

  it.effect("the pre-sign release path returns the reservation and frees the hold", () =>
    Effect.gen(function* () {
      yield* reset;
      const policy = yield* policyService();
      const store = yield* reservationStore();
      const settings = settingsOf();
      const proposalId = yield* seededProposal(policy);

      const admitted = yield* store.admitProtectedSwap({
        environmentId: ENV,
        proposalId,
        quote: identityQuote(settings),
        deadlineUnix: DEADLINE,
        now: NOW + 2_000,
      });
      assert.equal(admitted.status, "admitted");
      if (admitted.status !== "admitted") throw new Error("unreachable");

      const released = yield* store.releaseReservation({
        reservationId: admitted.reservationId,
        reason: "withdrawn before signing",
        now: NOW + 3_000,
      });
      assert.equal(released.status, "released");

      // Idempotent: releasing again reports already-released, not an error.
      const again = yield* store.releaseReservation({
        reservationId: admitted.reservationId,
        reason: "withdrawn before signing",
        now: NOW + 4_000,
      });
      assert.equal(again.status, "already-released");

      // Release TERMINALIZES the whole admission: the attempt records
      // released-before-sign, the proposal lands in the terminal no-spend
      // state (so budget folds stop counting it in flight), and replaying
      // the same stage REPORTS the release instead of already-admitted.
      const sql = yield* SqlClient.SqlClient;
      const attemptRow = yield* sql<{
        readonly status: string;
        readonly refusal_reason: string | null;
      }>`
        SELECT status, refusal_reason FROM execution_swap_attempts WHERE intent_id = ${admitted.intent.intentId}
      `;
      assert.equal(attemptRow[0]?.status, "released-before-sign");
      assert.include(attemptRow[0]?.refusal_reason ?? "", "withdrawn before signing");
      const proposalRow = yield* sql<{ readonly status: string }>`
        SELECT status FROM execution_proposals WHERE proposal_id = ${proposalId}
      `;
      assert.equal(proposalRow[0]?.status, "rejected");

      const replay = yield* store.admitProtectedSwap({
        environmentId: ENV,
        proposalId,
        quote: identityQuote(settings),
        deadlineUnix: DEADLINE,
        now: NOW + 4_500,
      });
      const replayRefusal = refused(replay, "stage-released");
      assert.include(replayRefusal.detail, admitted.reservationId);

      // A released reservation frees the transaction slot for a NEW stage.
      const secondState = encodeDetectorState(matchedRecord(1, "occ-2").state);
      assert.isTrue(secondState.ok);
      yield* Effect.flatMap(makeDetectorRunStore, (runs) =>
        runs.commitRun({
          record: matchedRecord(1, "occ-2"),
          stateBytes: secondState.ok ? secondState.serialized : "die",
        }),
      ).pipe(Effect.flatMap(() => Effect.void));
      policyStage.stageKey = "second";
      const second = yield* policy.evaluatePolicy({
        environmentId: ENV,
        capabilityId: CAP,
        now: NOW + 5,
      });
      assert.equal(second.status, "proposed");
      if (second.status !== "proposed") throw new Error("unreachable");
      const reAdmitted = yield* store.admitProtectedSwap({
        environmentId: ENV,
        proposalId: second.proposalId,
        quote: identityQuote(settings),
        deadlineUnix: DEADLINE,
        now: NOW + 5_500,
      });
      assert.equal(reAdmitted.status, "admitted");
    }),
  );

  it.effect("a tampered quote id, drifted code, and a missing transport each refuse by name", () =>
    Effect.gen(function* () {
      yield* reset;
      const policy = yield* policyService();
      const settings = settingsOf();
      const proposalId = yield* seededProposal(policy);
      const store = yield* reservationStore();

      // Tampered content id: a record whose id is not the one its own
      // content derives to (an agent-supplied id, or edited fields). The
      // forged id is applied AFTER the fixture derives the honest one.
      const honest = identityQuote(settings);
      const tampered: SwapQuoteRecord = { ...honest, quoteId: "sq_forged" };
      const tamperedRefusal = refused(
        yield* store.admitProtectedSwap({
          environmentId: ENV,
          proposalId,
          quote: tampered,
          deadlineUnix: DEADLINE,
          now: NOW + 2_000,
        }),
        "quote-identity-mismatch",
      );
      assert.include(tamperedRefusal.detail, "does not match");

      // Drifted live code: the swap target's runtime no longer matches the
      // PIN (the fake serves different bytes for the router only) — the
      // runtime verification fires before the quote-pin comparison.
      const drifted = reservationStore(
        settings,
        makeSpotRpc({
          eth_getCode: (params: ReadonlyArray<unknown>) =>
            (params[0] as string).toLowerCase() === ROUTER ? "0xdeadbeef" : FAKE_CODE,
        }),
      );
      const driftedStore = yield* drifted;
      refused(
        yield* driftedStore.admitProtectedSwap({
          environmentId: ENV,
          proposalId,
          quote: identityQuote(settings),
          deadlineUnix: DEADLINE,
          now: NOW + 2_500,
        }),
        "target-verification-failed",
      );
      // A quote pinning a DIFFERENT code than the live target (rebinding to
      // another deployment) is a quote-identity mismatch: pins still verify.
      refused(
        yield* store.admitProtectedSwap({
          environmentId: ENV,
          proposalId,
          quote: identityQuote(settings, {
            targetCodeHash: keccak256(toBytes("0xdeadbeef")).replace(/^0x/, ""),
          }),
          deadlineUnix: DEADLINE,
          now: NOW + 2_600,
        }),
        "quote-identity-mismatch",
      );

      // Verification failure: the chain is not mainnet.
      const wrongChain = yield* reservationStore(settings, makeSpotRpc({ eth_chainId: "0x2" }));
      refused(
        yield* wrongChain.admitProtectedSwap({
          environmentId: ENV,
          proposalId,
          quote: identityQuote(settings),
          deadlineUnix: DEADLINE,
          now: NOW + 3_000,
        }),
        "target-verification-failed",
      );

      // No transport wired: the funded gate refuses closed.
      const unwired = yield* Effect.provideService(
        Effect.provideService(
          makeSwapReservationStore,
          SwapRouteConfig,
          SwapRouteConfig.of({ resolve: Effect.succeed(settings) }),
        ),
        ForgeCapabilityStore,
        fakeStore,
      );
      refused(
        yield* unwired.admitProtectedSwap({
          environmentId: ENV,
          proposalId,
          quote: identityQuote(settings),
          deadlineUnix: DEADLINE,
          now: NOW + 3_500,
        }),
        "mainnet-transport-unavailable",
      );
    }),
  );

  it.effect("a revoked envelope refuses inside the admission transaction", () =>
    Effect.gen(function* () {
      yield* reset;
      const policy = yield* policyService();
      const store = yield* reservationStore();
      const settings = settingsOf();
      const proposalId = yield* seededProposal(policy);

      const sql = yield* SqlClient.SqlClient;
      const envelopeRows = yield* sql<{ readonly envelope_id: string }>`
        SELECT envelope_id FROM execution_envelopes LIMIT 1
      `;
      yield* policy.revokeEnvelope({
        envelopeId: envelopeRows[0]!.envelope_id,
        now: NOW + 1_000,
      });

      refused(
        yield* store.admitProtectedSwap({
          environmentId: ENV,
          proposalId,
          quote: identityQuote(settings),
          deadlineUnix: DEADLINE,
          now: NOW + 2_000,
        }),
        "envelope-revoked",
      );
      const count = yield* sql<{
        readonly n: number;
      }>`SELECT COUNT(*) AS n FROM execution_swap_reservations`;
      assert.equal(count[0]?.n, 0);
    }),
  );
});
