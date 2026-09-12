/**
 * SwapExecutionService — the prepare-and-attempt ladder over real SQLite
 * (in-memory, migrations 105 + 106 + 107 run directly) with the REAL
 * envelope evaluator and detector run store, fake capability-store/sandbox
 * seams (the P5.3 harness), the real route resolver, and the broadcaster at
 * both of its honest states: absent (None) and the shipped refusing
 * implementation (Some). No Docker, no network, no signer.
 *
 * What is pinned here: the happy prepare lands one immutable intent and then
 * a DURABLE submit-refusal whose asymmetry holds (the proposal stays
 * proposed, nothing reserved); every ladder step refuses by name before any
 * write; idempotent replay and the superseded-quote rule; the
 * native-currency value convention and the envelope-capped gas ceiling in
 * the prepared bytes.
 */
// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off preferSchemaOverJson:off tryCatchInEffectGen:off runEffectInsideEffect:off - sqlite fixtures are the data under test; JSON is the storage codec under test; the fake sandbox's parse/decode refusals are the modeled verdicts.

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  type DetectorEvaluationRecordV2,
  detectorEvaluationId,
  type ExecutionEnvelope,
  type SwapQuoteRecord,
  encodeDetectorState,
} from "@t3tools/trading-contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import createDetectorTables from "../../persistence/Migrations/105_DetectorRuns.ts";
import createExecutionTables from "../../persistence/Migrations/106_ExecutionEnvelopes.ts";
import createSwapIntentTables from "../../persistence/Migrations/107_SwapIntents.ts";
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
  makeSwapExecutionService,
  type SwapExecutionRefusalName,
  type SwapExecutionServiceShape,
  type SwapPrepareOutcome,
} from "./SwapExecutionService.ts";
import {
  resolveSwapRouteSettings,
  SwapRouteConfig,
  type SwapRouteSettings,
} from "./UniswapQuoteService.ts";
import { ForgeBroadcastRefused, SignedTransactionBroadcaster } from "./UniswapTestnetAdapter.ts";

const ENV = "env_swap_exec";
const CAP = "flow-policy";
const NOW = 1_700_000_000_000;

const layer = it.layer(NodeSqliteClient.layerMemory());

// ---------------------------------------------------------------------------
// Fixtures: the P5.3 fake store/sandbox pair, plus the route and quote
// ---------------------------------------------------------------------------

interface FakeBundle {
  readonly version: number;
  readonly status: "installed" | "paused" | "uninstalled";
  readonly artifacts: Record<string, string>;
}

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
  '  proposal: { kind: "wait" },',
  "  nextState: {},",
  "});",
].join("\n");

const fakeManifest = (version = 1): string => {
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
    version,
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

const storeState: { bundle: FakeBundle | null } = { bundle: null };

const defaultBundle = (overrides: Partial<FakeBundle> = {}): FakeBundle => ({
  version: 1,
  status: "installed",
  artifacts: {
    "sdk.ts": FORGE_SDK_SOURCE_V2,
    "detector.ts": DETECTOR_TS,
    "detector.test.ts": DETECTOR_TEST_TS,
    "policy.ts": POLICY_TS,
    "manifest.json": fakeManifest(),
  },
  ...overrides,
});

const unused = () => Effect.die("unused in this test");

const fakeStore: ForgeCapabilityStoreShape = {
  activeState: () =>
    Effect.succeed(
      storeState.bundle === null
        ? null
        : {
            version: storeState.bundle.version,
            bundleSha256: "f".repeat(64),
            status: storeState.bundle.status,
            armed: true,
          },
    ),
  readArtifact: ({ path }) => Effect.succeed(storeState.bundle?.artifacts[path] ?? null),
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

interface SealedPolicyInput {
  readonly envelope: {
    readonly candidates: ReadonlyArray<{ readonly candidateId: string }>;
  };
  readonly detectorEvaluation: {
    readonly evaluationId: string;
    readonly result:
      | { readonly status: "matched"; readonly occurrenceKey: string }
      | { readonly status: "not-matched" | "unknown"; readonly explanation: string };
  };
  readonly priorProposals: ReadonlyArray<{ readonly stageKey: string }>;
}

/** A fixed-amount swap policy (the P5.3 harness's fixedSwapPolicy). */
const fixedSwapPolicy =
  (patch: {
    readonly amountInRaw: string;
    readonly stageKey: string;
    readonly kind?: "swap" | "wait";
  }) =>
  (input: SealedPolicyInput): object =>
    patch.kind === "wait"
      ? {
          proposal: { kind: "wait" },
          nextState: { stateSchemaVersion: 1, state: {} },
        }
      : {
          proposal: {
            kind: "swap",
            candidateId: input.envelope.candidates[0]?.candidateId ?? "cand_weth_usdc",
            amountInRaw: patch.amountInRaw,
            quoteId: "sq_fixture",
            occurrenceKey:
              input.detectorEvaluation.result.status === "matched"
                ? input.detectorEvaluation.result.occurrenceKey
                : "occ",
            stageKey: patch.stageKey,
            detectorEvaluationId: input.detectorEvaluation.evaluationId,
          },
          nextState: { stateSchemaVersion: 1, state: {} },
        };

const policyState: {
  impl: (input: SealedPolicyInput) => object;
} = { impl: fixedSwapPolicy({ amountInRaw: "1000000", stageKey: "entry" }) };

const fakeSandbox: ForgeCapabilitySandboxShape = {
  available: Effect.succeed(true),
  runBuildStep: () => Effect.die("build steps are not used by the policy evaluator"),
  runEvaluation: (request) =>
    Effect.gen(function* () {
      let input: unknown;
      try {
        input = JSON.parse(request.stdinJson);
      } catch {
        return yield* new ForgeSandboxError({
          kind: "invalid_result",
          reason: "evaluation input was not valid JSON",
        });
      }
      let output: unknown;
      try {
        output = policyState.impl(input as SealedPolicyInput);
      } catch (error) {
        return yield* new ForgeSandboxError({
          kind: "invalid_result",
          reason: error instanceof Error ? error.message : String(error),
        });
      }
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

// The approved route registry, resolved through the real resolver so the
// service's route gate sees exactly what production would.
const TOKEN_IN = `0x${"aa".repeat(20)}`;
const TOKEN_OUT = `0x${"bb".repeat(20)}`;
const NATIVE = `0x${"0".repeat(40)}`;
const ROUTE_ID = "weth-usdc-500";
const SWAP_TARGET = "0x9b6b46e2c869aa39918db7f52f5557fe577b6eee";

const routeEnv = (extra: ReadonlyArray<Record<string, unknown>> = []): Record<string, string> => ({
  T3_SWAP_ROUTES: JSON.stringify([
    {
      routeId: ROUTE_ID,
      chainId: "11155111",
      routeType: "v4-exact-input-single",
      tokenIn: TOKEN_IN,
      tokenOut: TOKEN_OUT,
      quoterAddress: "0x61b3f2011a92d183c7dbadbda940a7555ccf9227",
      swapTargetAddress: SWAP_TARGET,
      poolKey: {
        currency0: TOKEN_IN,
        currency1: TOKEN_OUT,
        fee: 500,
        tickSpacing: 60,
        hooks: `0x${"33".repeat(20)}`,
      },
      zeroForOne: true,
    },
    ...extra,
  ]),
});

const routeSettingsFor = (env: Record<string, string>): SwapRouteSettings => {
  const settings = resolveSwapRouteSettings(env);
  assert.isTrue(settings.configured, settings.reason ?? "routes must resolve");
  return settings;
};

const CANDIDATE = {
  candidateId: "cand_weth_usdc",
  chainId: "11155111",
  tokenIn: TOKEN_IN,
  tokenOut: TOKEN_OUT,
  recipient: `0x${"cc".repeat(20)}`,
  label: "WETH -> USDC",
} as const;

const envelopeFixture = (overrides: Partial<ExecutionEnvelope> = {}): ExecutionEnvelope => ({
  revision: 1,
  environmentId: ENV,
  accountId: "acct-1",
  expiresAtMs: NOW + 3_600_000,
  detectorBundleSha256: forgeSha256Hex(DETECTOR_TS),
  policyBundleSha256: forgeSha256Hex(POLICY_TS),
  candidates: [CANDIDATE],
  inputCapTotalRaw: "1500000",
  inputCapPerSwapRaw: "2000000",
  maxGasWei: "200000000000000",
  maxSlippageBps: 50,
  maxTransactions: 4,
  maxConcurrentIntents: 2,
  ...overrides,
});

/** One quote matching the fixture candidate/amount, fresh at NOW. */
const quoteFixture = (overrides: Partial<SwapQuoteRecord> = {}): SwapQuoteRecord => ({
  quoteId: "sq_fixturequote1",
  chainId: "11155111",
  routeId: ROUTE_ID,
  tokenIn: TOKEN_IN,
  tokenOut: TOKEN_OUT,
  amountInRaw: "1000000",
  minAmountOutRaw: "900000",
  gasEstimateWei: "40000000000000000",
  quotedAtMs: NOW - 1_000,
  expiresAtMs: NOW + 30_000,
  basis: "eth_call",
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
      validUntilMs: NOW + 60_000,
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
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM forge_detector_state`;
  yield* sql`DELETE FROM forge_detector_evaluations`;
  yield* sql`DELETE FROM execution_envelopes`;
  yield* sql`DELETE FROM execution_envelope_approvals`;
  yield* sql`DELETE FROM execution_proposals`;
  yield* sql`DELETE FROM execution_policy_state`;
  yield* sql`DELETE FROM execution_swap_intents`;
  storeState.bundle = defaultBundle();
  policyState.impl = fixedSwapPolicy({ amountInRaw: "1000000", stageKey: "entry" });
});

const commitEvaluation = (record: DetectorEvaluationRecordV2) => {
  const encoded = encodeDetectorState(record.state);
  assert.isTrue(encoded.ok);
  return encoded.ok
    ? Effect.flatMap(makeDetectorRunStore, (runs) =>
        runs.commitRun({ record, stateBytes: encoded.serialized }),
      )
    : Effect.die("fixture state failed to encode");
};

/** The P5.3 evaluator over the ambient SqlClient with the fake seams. */
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

/**
 * The swap service under test. `refusingDetail` null leaves the broadcaster
 * seam unwired (serviceOption None); otherwise the shipped honest-refusal
 * behavior is provided inline as a wired Some.
 */
const swapService = (
  refusingDetail: string | null,
  routes: Record<string, string> = routeEnv(),
): Effect.Effect<SwapExecutionServiceShape, never, SqlClient.SqlClient> => {
  const settings = routeSettingsFor(routes);
  const base = Effect.provideService(
    makeSwapExecutionService,
    SwapRouteConfig,
    SwapRouteConfig.of({ resolve: Effect.succeed(settings) }),
  ).pipe(Effect.provideService(ForgeCapabilityStore, fakeStore));
  if (refusingDetail === null) return base;
  return Effect.provideService(
    base,
    SignedTransactionBroadcaster,
    SignedTransactionBroadcaster.of({
      broadcast: () =>
        new ForgeBroadcastRefused({
          reason: "broadcaster-missing",
          detail: refusingDetail,
        }),
    }),
  );
};

/** Propose + approve the fixture envelope; returns the envelope id. */
const approvedEnvelope = (
  policy: ExecutionPolicyServiceShape,
  overrides: Partial<ExecutionEnvelope> = {},
  atMs = NOW,
): Effect.Effect<string, PersistenceSqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const proposed = yield* policy.proposeEnvelope({
      environmentId: ENV,
      envelope: envelopeFixture(overrides),
      now: atMs,
      proposedVia: "test",
      capabilityId: CAP,
    });
    assert.equal(proposed.status, "proposed");
    if (proposed.status !== "proposed") throw new Error("unreachable");
    const approved = yield* policy.approveEnvelope({
      envelopeId: proposed.envelopeId,
      now: atMs,
      approvedVia: "local-operator",
    });
    assert.equal(approved.status, "approved");
    return proposed.envelopeId;
  });

/** Seed one matched evaluation + one evaluated swap proposal; returns ids. */
const seededProposal = (
  policy: ExecutionPolicyServiceShape,
  options: {
    readonly envelopeOverrides?: Partial<ExecutionEnvelope>;
    readonly amountInRaw?: string;
    readonly stageKey?: string;
    readonly atMs?: number;
  } = {},
): Effect.Effect<
  { readonly envelopeId: string; readonly proposalId: string },
  PersistenceSqlError,
  SqlClient.SqlClient
> =>
  Effect.gen(function* () {
    const envelopeId = yield* approvedEnvelope(
      policy,
      options.envelopeOverrides,
      options.atMs ?? NOW,
    );
    yield* commitEvaluation(matchedRecord(0, "occ-entry-1"));
    policyState.impl = fixedSwapPolicy({
      amountInRaw: options.amountInRaw ?? "1000000",
      stageKey: options.stageKey ?? "entry",
    });
    const outcome = yield* policy.evaluatePolicy({
      environmentId: ENV,
      capabilityId: CAP,
      now: (options.atMs ?? NOW) + 1,
    });
    assert.equal(outcome.status, "proposed");
    if (outcome.status !== "proposed") throw new Error("unreachable");
    return { envelopeId, proposalId: outcome.proposalId };
  });

/** The refusal shape of an outcome, asserted. */
const refusedWith = (
  outcome: SwapPrepareOutcome,
  refusal: SwapExecutionRefusalName,
): { readonly detail: string } => {
  assert.equal(outcome.status, "refused", `expected a refusal, got ${JSON.stringify(outcome)}`);
  if (outcome.status !== "refused") throw new Error("unreachable");
  assert.equal(outcome.refusal, refusal);
  return { detail: outcome.detail };
};

const intentCount: Effect.Effect<number, never, SqlClient.SqlClient> = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) =>
    sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM execution_swap_intents`.pipe(
      Effect.map((rows) => rows[0]?.n ?? 0),
      Effect.orDie,
    ),
);

// ---------------------------------------------------------------------------
// The ladder
// ---------------------------------------------------------------------------

layer("SwapExecutionService prepareAndAttempt", (it) => {
  it.effect(
    "happy prepare: one immutable intent, then a durable broadcaster-missing submit-refusal; the proposal stays proposed and nothing is reserved",
    () =>
      Effect.gen(function* () {
        yield* reset;
        const policy = yield* policyService();
        const swap = yield* swapService(null);
        const { envelopeId, proposalId } = yield* seededProposal(policy);

        const outcome = yield* swap.prepareAndAttempt({
          environmentId: ENV,
          proposalId,
          quote: quoteFixture(),
          now: NOW + 2_000,
        });
        assert.equal(outcome.status, "submit-refused");
        if (outcome.status !== "submit-refused") throw new Error("unreachable");
        assert.equal(outcome.refusal, "broadcaster-missing");
        const intent = outcome.intent;
        assert.equal(intent.status, "submit-refused");
        assert.equal(intent.proposalId, proposalId);
        assert.equal(intent.envelopeId, envelopeId);
        assert.equal(intent.recipient, CANDIDATE.recipient);
        assert.equal(intent.swapTargetAddress, SWAP_TARGET);
        assert.equal(intent.minAmountOutRaw, "900000");
        // Both timestamps durable: prepared and attempted at the input clock.
        assert.equal(intent.preparedAtMs, NOW + 2_000);
        assert.equal(intent.attemptAtMs, NOW + 2_000);
        assert.include(intent.refusalReason ?? "", "broadcaster-missing");

        // The prepared bytes: canonical shape, envelope-capped gas (the
        // 4e16 placeholder clamped by the fixture's 2e14 maxGasWei), ERC-20
        // value convention (tokenIn is not the native marker).
        const prepared = JSON.parse(intent.preparedTxJson) as Record<string, unknown>;
        assert.equal(prepared["to"], SWAP_TARGET);
        assert.equal(prepared["value"], "0");
        assert.equal(prepared["chainId"], 11155111);
        assert.equal(prepared["gasWei"], "200000000000000");
        assert.isNull(prepared["nonce"]);
        const data = prepared["data"];
        assert.match(String(data), /^0x[0-9a-f]+$/);

        // THE ASYMMETRY: the proposal is untouched (still proposed, so no
        // budget is consumed and the stage is not spent), and exactly one
        // intent row exists, carrying both timestamps.
        const sql = yield* SqlClient.SqlClient;
        const proposalRow = yield* sql<{ readonly status: string }>`
          SELECT status FROM execution_proposals WHERE proposal_id = ${proposalId}
        `;
        assert.equal(proposalRow[0]?.status, "proposed");
        const row = yield* sql<{
          readonly status: string;
          readonly attempt_at_ms: number | null;
          readonly refusal_reason: string | null;
        }>`
          SELECT status, attempt_at_ms, refusal_reason FROM execution_swap_intents
          WHERE proposal_id = ${proposalId}
        `;
        assert.equal(row[0]?.status, "submit-refused");
        assert.equal(row[0]?.attempt_at_ms, NOW + 2_000);
        assert.include(row[0]?.refusal_reason ?? "", "broadcaster-missing");

        // The reads serve it.
        const byProposal = yield* swap.intentFor(proposalId);
        assert.equal(byProposal?.intentId, intent.intentId);
        const listed = yield* swap.listIntents({ envelopeId });
        assert.equal(listed.length, 1);
        assert.equal(listed[0]?.intentId, intent.intentId);
      }),
  );

  it.effect("a wired broadcaster's refusal is persisted verbatim (URLs redacted)", () =>
    Effect.gen(function* () {
      yield* reset;
      const policy = yield* policyService();
      const swap = yield* swapService(
        "no grant-controlled signer is wired; see https://sepolia.example/secret-key-path",
      );
      const { proposalId } = yield* seededProposal(policy);
      const outcome = yield* swap.prepareAndAttempt({
        environmentId: ENV,
        proposalId,
        quote: quoteFixture(),
        now: NOW + 2_000,
      });
      assert.equal(outcome.status, "submit-refused");
      if (outcome.status !== "submit-refused") throw new Error("unreachable");
      assert.equal(outcome.refusal, "broadcaster-missing");
      assert.include(outcome.detail, "no grant-controlled signer is wired");
      // The credential-bearing URL never survives into the durable reason.
      assert.notInclude(outcome.intent.refusalReason ?? "", "https://sepolia.example");
      assert.include(outcome.intent.refusalReason ?? "", "[redacted-url]");
    }),
  );

  it.effect("a stale (expired) quote refuses before any write", () =>
    Effect.gen(function* () {
      yield* reset;
      const policy = yield* policyService();
      const swap = yield* swapService(null);
      const { proposalId } = yield* seededProposal(policy);
      const outcome = yield* swap.prepareAndAttempt({
        environmentId: ENV,
        proposalId,
        quote: quoteFixture({ quotedAtMs: NOW - 40_000, expiresAtMs: NOW - 10_000 }),
        now: NOW + 2_000,
      });
      const refusal = refusedWith(outcome, "stale-quote");
      assert.include(refusal.detail, "not fresh");
      assert.equal(yield* intentCount, 0);
    }),
  );

  it.effect("each quote/proposal mismatch refuses stale-quote naming the field", () =>
    Effect.gen(function* () {
      yield* reset;
      const policy = yield* policyService();
      const swap = yield* swapService(null);
      const { proposalId } = yield* seededProposal(policy);

      const tokenIn = refusedWith(
        yield* swap.prepareAndAttempt({
          environmentId: ENV,
          proposalId,
          quote: quoteFixture({ tokenIn: `0x${"dd".repeat(20)}` }),
          now: NOW + 2_000,
        }),
        "stale-quote",
      );
      assert.include(tokenIn.detail, "tokenIn mismatch");

      const tokenOut = refusedWith(
        yield* swap.prepareAndAttempt({
          environmentId: ENV,
          proposalId,
          quote: quoteFixture({ tokenOut: `0x${"ee".repeat(20)}` }),
          now: NOW + 2_000,
        }),
        "stale-quote",
      );
      assert.include(tokenOut.detail, "tokenOut mismatch");

      const amount = refusedWith(
        yield* swap.prepareAndAttempt({
          environmentId: ENV,
          proposalId,
          quote: quoteFixture({ amountInRaw: "999999" }),
          now: NOW + 2_000,
        }),
        "stale-quote",
      );
      assert.include(amount.detail, "amountInRaw mismatch");
      assert.equal(yield* intentCount, 0);
    }),
  );

  it.effect("an unapproved route refuses route-unapproved", () =>
    Effect.gen(function* () {
      yield* reset;
      const policy = yield* policyService();
      const swap = yield* swapService(null);
      const { proposalId } = yield* seededProposal(policy);
      const outcome = yield* swap.prepareAndAttempt({
        environmentId: ENV,
        proposalId,
        quote: quoteFixture({ routeId: "uniswap-x-bridge" }),
        now: NOW + 2_000,
      });
      const refusal = refusedWith(outcome, "route-unapproved");
      assert.include(refusal.detail, "uniswap-x-bridge");
      assert.equal(yield* intentCount, 0);
    }),
  );

  it.effect("a changed installed bundle refuses bundle-changed", () =>
    Effect.gen(function* () {
      yield* reset;
      const policy = yield* policyService();
      const swap = yield* swapService(null);
      const { proposalId } = yield* seededProposal(policy);
      storeState.bundle = defaultBundle({
        artifacts: { ...defaultBundle().artifacts, "detector.ts": "export const changed = 1;\n" },
      });
      const outcome = yield* swap.prepareAndAttempt({
        environmentId: ENV,
        proposalId,
        quote: quoteFixture(),
        now: NOW + 2_000,
      });
      refusedWith(outcome, "bundle-changed");
      assert.equal(yield* intentCount, 0);
    }),
  );

  it.effect(
    "an amount that no longer fits the remaining budget refuses budget-exhausted at preparation, never clamps",
    () =>
      Effect.gen(function* () {
        yield* reset;
        const policy = yield* policyService();
        const swap = yield* swapService(null);
        yield* seededProposal(policy);

        // A SECOND proposal admitted while nothing was reserved; moving the
        // first to in-flight shrinks the remaining budget below it. This is
        // exactly the window the preparation-time re-check exists for.
        yield* commitEvaluation(matchedRecord(1, "occ-entry-2"));
        policyState.impl = fixedSwapPolicy({ amountInRaw: "1000000", stageKey: "second" });
        const second = yield* policy.evaluatePolicy({
          environmentId: ENV,
          capabilityId: CAP,
          now: NOW + 3,
        });
        assert.equal(second.status, "proposed");
        if (second.status !== "proposed") throw new Error("unreachable");

        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE execution_proposals SET status = 'executing' WHERE stage_key = 'entry'`;

        const outcome = yield* swap.prepareAndAttempt({
          environmentId: ENV,
          proposalId: second.proposalId,
          quote: quoteFixture(),
          now: NOW + 4_000,
        });
        const refusal = refusedWith(outcome, "budget-exhausted");
        assert.include(refusal.detail, "never clamping");
        assert.equal(yield* intentCount, 0);
      }),
  );

  it.effect("an executing or executed proposal refuses stage-already-executed", () =>
    Effect.gen(function* () {
      yield* reset;
      const policy = yield* policyService();
      const swap = yield* swapService(null);
      const { proposalId } = yield* seededProposal(policy);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE execution_proposals SET status = 'executing' WHERE proposal_id = ${proposalId}`;
      const executing = yield* swap.prepareAndAttempt({
        environmentId: ENV,
        proposalId,
        quote: quoteFixture(),
        now: NOW + 2_000,
      });
      const refusal = refusedWith(executing, "stage-already-executed");
      assert.include(refusal.detail, "executing");

      yield* sql`UPDATE execution_proposals SET status = 'executed' WHERE proposal_id = ${proposalId}`;
      refusedWith(
        yield* swap.prepareAndAttempt({
          environmentId: ENV,
          proposalId,
          quote: quoteFixture(),
          now: NOW + 3_000,
        }),
        "stage-already-executed",
      );
      assert.equal(yield* intentCount, 0);
    }),
  );

  it.effect(
    "re-preparing the same content is an idempotent no-op; a changed quote for the same proposal is superseded-quote",
    () =>
      Effect.gen(function* () {
        yield* reset;
        const policy = yield* policyService();
        const swap = yield* swapService(null);
        const { proposalId } = yield* seededProposal(policy);

        const first = yield* swap.prepareAndAttempt({
          environmentId: ENV,
          proposalId,
          quote: quoteFixture(),
          now: NOW + 2_000,
        });
        assert.equal(first.status, "submit-refused");
        if (first.status !== "submit-refused") throw new Error("unreachable");

        const replay = yield* swap.prepareAndAttempt({
          environmentId: ENV,
          proposalId,
          quote: quoteFixture(),
          now: NOW + 5_000,
        });
        assert.equal(replay.status, "already-prepared");
        if (replay.status !== "already-prepared") throw new Error("unreachable");
        // The stored row stands as-is: same id, no second attempt timestamp.
        assert.equal(replay.intent.intentId, first.intent.intentId);
        assert.equal(replay.intent.attemptAtMs, NOW + 2_000);
        assert.equal(yield* intentCount, 1);

        // A changed quote (new id, new numbers) mints a new content id; the
        // one-intent-per-proposal predicate refuses it by name.
        const superseded = yield* swap.prepareAndAttempt({
          environmentId: ENV,
          proposalId,
          quote: quoteFixture({
            quoteId: "sq_reprice",
            minAmountOutRaw: "850000",
            quotedAtMs: NOW + 4_000,
            expiresAtMs: NOW + 40_000,
          }),
          now: NOW + 6_000,
        });
        const refusal = refusedWith(superseded, "superseded-quote");
        assert.include(refusal.detail, "NEW proposal");
        assert.equal(yield* intentCount, 1);
      }),
  );

  it.effect("revoked and expired envelopes refuse by name", () =>
    Effect.gen(function* () {
      yield* reset;
      const policy = yield* policyService();
      const swap = yield* swapService(null);

      const revoked = yield* seededProposal(policy);
      yield* policy.revokeEnvelope({ envelopeId: revoked.envelopeId, now: NOW + 1_000 });
      refusedWith(
        yield* swap.prepareAndAttempt({
          environmentId: ENV,
          proposalId: revoked.proposalId,
          quote: quoteFixture(),
          now: NOW + 2_000,
        }),
        "envelope-revoked",
      );

      const expiring = yield* seededProposal(policy, {
        envelopeOverrides: { expiresAtMs: NOW + 1_500 },
        atMs: NOW + 100,
      });
      refusedWith(
        yield* swap.prepareAndAttempt({
          environmentId: ENV,
          proposalId: expiring.proposalId,
          quote: quoteFixture({
            quotedAtMs: NOW + 100,
            expiresAtMs: NOW + 1_600,
          }),
          now: NOW + 2_000,
        }),
        "envelope-expired",
      );
      assert.equal(yield* intentCount, 0);
    }),
  );

  it.effect("missing, foreign, and non-swap proposals refuse by name", () =>
    Effect.gen(function* () {
      yield* reset;
      const policy = yield* policyService();
      const swap = yield* swapService(null);
      yield* seededProposal(policy);

      refusedWith(
        yield* swap.prepareAndAttempt({
          environmentId: ENV,
          proposalId: "pprop_missing",
          quote: quoteFixture(),
          now: NOW + 2_000,
        }),
        "proposal-not-found",
      );

      // A wait proposal (a real policy output that is not a swap).
      yield* commitEvaluation(matchedRecord(1, "occ-wait"));
      policyState.impl = fixedSwapPolicy({ amountInRaw: "1", stageKey: "waiting", kind: "wait" });
      const wait = yield* policy.evaluatePolicy({
        environmentId: ENV,
        capabilityId: CAP,
        now: NOW + 3,
      });
      assert.equal(wait.status, "proposed");
      if (wait.status !== "proposed") throw new Error("unreachable");
      refusedWith(
        yield* swap.prepareAndAttempt({
          environmentId: ENV,
          proposalId: wait.proposalId,
          quote: quoteFixture(),
          now: NOW + 4_000,
        }),
        "proposal-not-swap",
      );
      assert.equal(yield* intentCount, 0);
    }),
  );

  it.effect("the native-currency convention: a native tokenIn pays msg.value", () =>
    Effect.gen(function* () {
      yield* reset;
      const policy = yield* policyService();
      const nativeEnv = routeEnv([
        {
          routeId: "native-usdc",
          chainId: "11155111",
          routeType: "v4-exact-input-single",
          tokenIn: NATIVE,
          tokenOut: TOKEN_OUT,
          quoterAddress: "0x61b3f2011a92d183c7dbadbda940a7555ccf9227",
          swapTargetAddress: SWAP_TARGET,
          poolKey: {
            currency0: NATIVE,
            currency1: TOKEN_OUT,
            fee: 500,
            tickSpacing: 60,
            hooks: `0x${"33".repeat(20)}`,
          },
          zeroForOne: true,
        },
      ]);
      const swap = yield* swapService(null, nativeEnv);

      // A SECOND envelope (proposed later, so it is the latest) whose
      // candidate pays native in; its proposal prices against the native route.
      const { proposalId } = yield* seededProposal(policy, {
        envelopeOverrides: {
          candidates: [{ ...CANDIDATE, tokenIn: NATIVE, label: "ETH -> USDC" }],
          expiresAtMs: NOW + 7_200_000,
        },
        atMs: NOW + 10_000,
      });
      const outcome = yield* swap.prepareAndAttempt({
        environmentId: ENV,
        proposalId,
        quote: quoteFixture({ routeId: "native-usdc", tokenIn: NATIVE }),
        now: NOW + 20_000,
      });
      assert.equal(outcome.status, "submit-refused");
      if (outcome.status !== "submit-refused") throw new Error("unreachable");
      const prepared = JSON.parse(outcome.intent.preparedTxJson) as Record<string, unknown>;
      // v4's currency0 convention: the native marker pays as msg.value.
      assert.equal(prepared["value"], "1000000");
    }),
  );

  it.effect("the envelope view reads serve budget, proposals, and intents together", () =>
    Effect.gen(function* () {
      yield* reset;
      const policy = yield* policyService();
      const swap = yield* swapService(null);
      const { envelopeId, proposalId } = yield* seededProposal(policy);

      const missing = yield* swap.envelopeById("env_nope");
      assert.isNull(missing);
      const noBudget = yield* swap.remainingInputBudgetFor("env_nope");
      assert.isNull(noBudget);

      const view = yield* swap.envelopeById(envelopeId);
      assert.isNotNull(view);
      assert.equal(view?.status, "approved");
      assert.equal(view?.approvedVia, "local-operator");
      assert.isNotNull(view?.envelope);

      const budget = yield* swap.remainingInputBudgetFor(envelopeId);
      assert.deepEqual(budget, {
        remainingInputCapRaw: "1500000",
        settledRaw: "0",
        inFlightRaw: "0",
      });

      yield* swap.prepareAndAttempt({
        environmentId: ENV,
        proposalId,
        quote: quoteFixture(),
        now: NOW + 2_000,
      });
      const after = yield* swap.remainingInputBudgetFor(envelopeId);
      // A refused submission reserves nothing: the budget is unchanged.
      assert.equal(after?.remainingInputCapRaw, "1500000");
    }),
  );
});
