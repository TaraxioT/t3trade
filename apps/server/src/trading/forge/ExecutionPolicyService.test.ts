/**
 * ExecutionPolicyService — the envelope lifecycle, the evaluation gate ladder,
 * and the two-stage changing-evidence proof, over real SQLite (in-memory,
 * migrations 105 + 106 run directly) with the REAL DetectorRunStore and fake
 * capability-store/sandbox seams.
 *
 * The fake sandbox interprets the policy program in JavaScript (the same
 * Propose contract the runner enforces) and round-trips stdout JSON through
 * the host decoder exactly as the container would; its hook lets a test act
 * between the service's state read and its transaction (the CAS-conflict
 * window). No Docker, no network, no signer.
 */
// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off preferSchemaOverJson:off tryCatchInEffectGen:off runEffectInsideEffect:off - sqlite fixtures and wall-clock record fields are the data under test; JSON is the codec under test; the fake sandbox's parse/decode refusals are the modeled verdicts; the CAS-conflict hook runs raw SQL from inside the faked container run by design.

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  decodeDetectorState,
  type DetectionResult,
  type DetectorEvaluationRecordV2,
  detectorEvaluationId,
  type ExecutionEnvelope,
  encodeDetectorState,
  proposalId,
} from "@t3tools/trading-contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import createDetectorTables from "../../persistence/Migrations/105_DetectorRuns.ts";
import createExecutionTables from "../../persistence/Migrations/106_ExecutionEnvelopes.ts";
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
  type PolicyEvaluationOutcome,
} from "./ExecutionPolicyService.ts";

const ENV = "env_policy";
const CAP = "flow-policy";
const NOW = 1_700_000_000_000;

const layer = it.layer(NodeSqliteClient.layerMemory());

// ---------------------------------------------------------------------------
// Fixtures: the fake capability store and the fake contained policy run
// ---------------------------------------------------------------------------

/** The fake bundle the store serves: exactly the declared role paths + manifest. */
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

/** The manifest the fake bundle's manifest.json carries (a valid v2 one). */
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
    semantics: "fixture detector with a two-stage execution policy",
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

/** One sealed policy input as the fake program receives it. */
interface SealedPolicyInput {
  readonly policySchemaVersion: number;
  readonly asOfMs: number;
  readonly envelope: {
    readonly candidates: ReadonlyArray<{ readonly candidateId: string }>;
  };
  readonly detectorEvaluation: {
    readonly evaluationId: string;
    readonly asOfMs: number;
    readonly result:
      | {
          readonly status: "matched";
          readonly occurrenceKey: string;
          readonly validUntilMs: number;
        }
      | { readonly status: "not-matched" | "unknown"; readonly explanation: string };
  };
  readonly priorProposals: ReadonlyArray<{ readonly stageKey: string }>;
  readonly remainingInputCapRaw: string;
  readonly priorState?: { readonly stateSchemaVersion: number; readonly state: unknown } | null;
}

/**
 * The two-stage fake policy (the runner fixture's logic): swap "entry" on the
 * first matched evaluation, the IDENTICAL swap re-emitted when the same
 * evaluation is seen again (the host collapses it), swap "exit" when a NEW
 * evaluation arrives.
 */
const twoStagePolicy = (input: SealedPolicyInput): object => {
  const envelope = input.priorState ?? null;
  const prior =
    envelope !== null && typeof envelope === "object"
      ? ((envelope.state ?? {}) as { entryFor?: string; runs?: number })
      : {};
  const runs = (prior.runs ?? 0) + 1;
  const carry = { ...prior, runs };
  const evaluation = input.detectorEvaluation;
  const result = evaluation.result;
  if (result.status !== "matched") {
    return { proposal: { kind: "wait" }, nextState: { stateSchemaVersion: 1, state: carry } };
  }
  const matched = result;
  const candidate = input.envelope.candidates[0];
  const swap = (stageKey: string) => ({
    kind: "swap",
    candidateId: candidate?.candidateId ?? "cand_weth_usdc",
    amountInRaw: "1000000",
    quoteId: "sq_fixture",
    occurrenceKey: matched.occurrenceKey,
    stageKey,
    detectorEvaluationId: evaluation.evaluationId,
  });
  if (!input.priorProposals.some((proposal) => proposal.stageKey === "entry")) {
    return {
      proposal: swap("entry"),
      nextState: { stateSchemaVersion: 1, state: { ...carry, entryFor: evaluation.evaluationId } },
    };
  }
  if (prior.entryFor === evaluation.evaluationId) {
    return { proposal: swap("entry"), nextState: { stateSchemaVersion: 1, state: carry } };
  }
  return {
    proposal: swap("exit"),
    nextState: {
      stateSchemaVersion: 1,
      state: { ...carry, entryFor: prior.entryFor, exitFor: evaluation.evaluationId },
    },
  };
};

/** A fixed-amount swap policy for the budget and refusal cases. */
const fixedSwapPolicy =
  (patch: {
    readonly amountInRaw: string;
    readonly stageKey: string;
    readonly candidateId?: string;
    readonly detectorEvaluationId?: string;
    readonly occurrenceKey?: string;
  }) =>
  (input: SealedPolicyInput): object => ({
    proposal: {
      kind: "swap",
      candidateId: patch.candidateId ?? input.envelope.candidates[0]?.candidateId ?? "cand_unknown",
      amountInRaw: patch.amountInRaw,
      quoteId: "sq_fixture",
      occurrenceKey:
        patch.occurrenceKey ??
        (input.detectorEvaluation.result.status === "matched"
          ? input.detectorEvaluation.result.occurrenceKey
          : "occ"),
      stageKey: patch.stageKey,
      detectorEvaluationId: patch.detectorEvaluationId ?? input.detectorEvaluation.evaluationId,
    },
    nextState: { stateSchemaVersion: 1, state: {} },
  });

const policyState: {
  impl: (input: SealedPolicyInput) => object;
  hook: null | (() => Promise<void>);
  failWith: null | string;
  seen: SealedPolicyInput | null;
} = { impl: twoStagePolicy, hook: null, failWith: null, seen: null };

// The fake sandbox: the same entrypoint/decode contract the sealed container
// honors, interpreted in JavaScript.
const fakeSandbox: ForgeCapabilitySandboxShape = {
  available: Effect.succeed(true),
  runBuildStep: () => Effect.die("build steps are not used by the policy evaluator"),
  runEvaluation: (request) =>
    Effect.gen(function* () {
      if (policyState.failWith !== null) {
        return yield* new ForgeSandboxError({
          kind: "sandbox_unavailable",
          reason: policyState.failWith,
        });
      }
      if (policyState.hook !== null) {
        const hook = policyState.hook;
        yield* Effect.promise(() => hook());
      }
      let input: unknown;
      try {
        input = JSON.parse(request.stdinJson);
      } catch {
        return yield* new ForgeSandboxError({
          kind: "invalid_result",
          reason: "evaluation input was not valid JSON",
        });
      }
      policyState.seen = input as SealedPolicyInput;
      let output: unknown;
      try {
        output = policyState.impl(input as SealedPolicyInput);
      } catch (error) {
        return yield* new ForgeSandboxError({
          kind: "invalid_result",
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      // The real sandbox round-trips stdout JSON before the host decoder runs.
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
// Helpers
// ---------------------------------------------------------------------------

const CANDIDATE = {
  candidateId: "cand_weth_usdc",
  chainId: "11155111",
  tokenIn: "0x" + "a".repeat(40),
  tokenOut: "0x" + "b".repeat(40),
  recipient: "0x" + "c".repeat(40),
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
  // per-swap cap 2_000_000, total cap 1_500_000: the remaining-budget and
  // per-swap-cap refusals are separable at the boundaries.
  inputCapTotalRaw: "1500000",
  inputCapPerSwapRaw: "2000000",
  maxGasWei: "200000000000000",
  maxSlippageBps: 50,
  maxTransactions: 4,
  maxConcurrentIntents: 2,
  ...overrides,
});

/** A matched detector evaluation record for the real run store. */
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

/** A non-matched evaluation record (not-matched / unknown). */
const resultRecord = (
  revision: number,
  result: DetectionResult,
  digestSeed = "d",
): DetectorEvaluationRecordV2 => {
  const inputDigest = digestSeed.repeat(63) + String(revision % 10);
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
    result,
    state: { stateSchemaVersion: 1, state: { count: revision } },
    evidenceIds: ["ev_1"],
    committedAtMs: NOW - 5_000 + revision,
  };
};

const commitEvaluation = (record: DetectorEvaluationRecordV2) => {
  const encoded = encodeDetectorState(record.state);
  assert.isTrue(encoded.ok);
  return encoded.ok
    ? Effect.flatMap(makeDetectorRunStore, (runs) =>
        runs.commitRun({ record, stateBytes: encoded.serialized }),
      )
    : Effect.die("fixture state failed to encode");
};

/** Fresh tables + fakes; every case starts from zero. */
const reset = Effect.gen(function* () {
  yield* createDetectorTables;
  yield* createExecutionTables;
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM forge_detector_state`;
  yield* sql`DELETE FROM forge_detector_evaluations`;
  yield* sql`DELETE FROM execution_envelopes`;
  yield* sql`DELETE FROM execution_envelope_approvals`;
  yield* sql`DELETE FROM execution_proposals`;
  yield* sql`DELETE FROM execution_policy_state`;
  storeState.bundle = defaultBundle();
  policyState.impl = twoStagePolicy;
  policyState.hook = null;
  policyState.failWith = null;
  policyState.seen = null;
});

/** The service over the ambient SqlClient with the fake seams. */
const service = (): Effect.Effect<ExecutionPolicyServiceShape, never, SqlClient.SqlClient> =>
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

/** Propose + approve the fixture envelope; returns the id. */
const approvedEnvelope = (
  svc: ExecutionPolicyServiceShape,
  overrides: Partial<ExecutionEnvelope> = {},
): Effect.Effect<string, PersistenceSqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const proposed = yield* svc.proposeEnvelope({
      environmentId: ENV,
      envelope: envelopeFixture(overrides),
      now: NOW,
      proposedVia: "test",
      capabilityId: CAP,
    });
    assert.equal(proposed.status, "proposed");
    if (proposed.status !== "proposed") throw new Error("unreachable");
    const approved = yield* svc.approveEnvelope({
      envelopeId: proposed.envelopeId,
      now: NOW,
      approvedVia: "local-operator",
    });
    assert.equal(approved.status, "approved");
    return proposed.envelopeId;
  });

/** The refusal shape of an evaluation outcome, asserted. */
const refusedWith = (
  outcome: PolicyEvaluationOutcome,
  refusal: string,
): { readonly detail: string } => {
  assert.equal(outcome.status, "refused", `expected a refusal, got ${JSON.stringify(outcome)}`);
  if (outcome.status !== "refused") throw new Error("unreachable");
  assert.equal(outcome.refusal, refusal);
  return { detail: outcome.detail };
};

// ---------------------------------------------------------------------------
// Envelope lifecycle
// ---------------------------------------------------------------------------

layer("ExecutionPolicyService envelope lifecycle", (it) => {
  it.effect("propose lands as proposed, never approved; identical re-propose is a no-op", () =>
    Effect.gen(function* () {
      yield* reset;
      const svc = yield* service();
      const first = yield* svc.proposeEnvelope({
        environmentId: ENV,
        envelope: envelopeFixture(),
        now: NOW,
        proposedVia: "tool",
        capabilityId: CAP,
      });
      assert.equal(first.status, "proposed");
      const id = first.status === "proposed" ? first.envelopeId : "";

      const again = yield* svc.proposeEnvelope({
        environmentId: ENV,
        envelope: envelopeFixture(),
        now: NOW + 1_000,
        proposedVia: "tool",
        capabilityId: CAP,
      });
      assert.equal(again.status, "already-proposed");
      if (again.status === "already-proposed") assert.equal(again.envelopeId, id);

      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly status: string }>`
        SELECT status FROM execution_envelopes WHERE envelope_id = ${id}
      `;
      assert.equal(rows[0]?.status, "proposed");
      const approvals = yield* sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM execution_envelope_approvals
      `;
      assert.equal(approvals[0]?.n, 0);
      const view = yield* svc.envelopeFor({ environmentId: ENV, capabilityId: CAP });
      assert.isNotNull(view);
      assert.equal(view?.status, "proposed");
      assert.equal(view?.capabilityId, CAP);
      assert.isNotNull(view?.envelope);
    }),
  );

  it.effect("an invalid envelope or a foreign environment refuses before any write", () =>
    Effect.gen(function* () {
      yield* reset;
      const svc = yield* service();
      const invalid = yield* svc.proposeEnvelope({
        environmentId: ENV,
        // Zero revision fails the schema's own check.
        envelope: envelopeFixture({ revision: 0 }),
        now: NOW,
        proposedVia: "tool",
        capabilityId: CAP,
      });
      assert.equal(invalid.status, "refused");
      if (invalid.status === "refused") assert.equal(invalid.reason, "invalid-envelope");

      const foreign = yield* svc.proposeEnvelope({
        environmentId: "env_other",
        envelope: envelopeFixture(),
        now: NOW,
        proposedVia: "tool",
        capabilityId: CAP,
      });
      assert.equal(foreign.status, "refused");
      if (foreign.status === "refused") assert.equal(foreign.reason, "invalid-envelope");

      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{
        readonly n: number;
      }>`SELECT COUNT(*) AS n FROM execution_envelopes`;
      assert.equal(rows[0]?.n, 0);
    }),
  );

  it.effect("the same envelope id with different stored bytes is a collision refusal", () =>
    Effect.gen(function* () {
      yield* reset;
      const svc = yield* service();
      const first = yield* svc.proposeEnvelope({
        environmentId: ENV,
        envelope: envelopeFixture(),
        now: NOW,
        proposedVia: "tool",
        capabilityId: CAP,
      });
      assert.equal(first.status, "proposed");
      const id = first.status === "proposed" ? first.envelopeId : "";

      // Tamper the stored bytes under the same content-derived id: the only
      // way this state exists is corruption, and the byte-compare must catch
      // it rather than treat it as a no-op.
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        UPDATE execution_envelopes SET envelope_json = ${'{"tampered":true}'}
        WHERE envelope_id = ${id}
      `;
      const outcome = yield* svc.proposeEnvelope({
        environmentId: ENV,
        envelope: envelopeFixture(),
        now: NOW,
        proposedVia: "tool",
        capabilityId: CAP,
      });
      assert.equal(outcome.status, "refused");
      if (outcome.status === "refused") {
        assert.equal(outcome.reason, "envelope-id-collision");
        assert.include(outcome.detail, "bytes differ");
      }
    }),
  );

  it.effect(
    "approve is one-way from proposed, records its own origin, and refuses the F0 origin",
    () =>
      Effect.gen(function* () {
        yield* reset;
        const svc = yield* service();
        const proposed = yield* svc.proposeEnvelope({
          environmentId: ENV,
          envelope: envelopeFixture(),
          now: NOW,
          proposedVia: "tool",
          capabilityId: CAP,
        });
        const id = proposed.status === "proposed" ? proposed.envelopeId : "";

        // The F0 env-derived grant origin can NEVER approve an envelope.
        const forbidden = yield* svc.approveEnvelope({
          envelopeId: id,
          now: NOW,
          approvedVia: "server-config",
        });
        assert.equal(forbidden.status, "refused");
        if (forbidden.status === "refused") assert.equal(forbidden.reason, "forbidden-origin");

        const approved = yield* svc.approveEnvelope({
          envelopeId: id,
          now: NOW,
          approvedVia: "local-operator",
          approverNote: "reviewed the caps",
        });
        assert.equal(approved.status, "approved");

        // One-way: approving again refuses, and nothing new is recorded.
        const again = yield* svc.approveEnvelope({
          envelopeId: id,
          now: NOW + 1,
          approvedVia: "local-operator",
        });
        assert.equal(again.status, "refused");
        if (again.status === "refused") assert.equal(again.reason, "not-proposed");

        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{
          readonly approved_via: string;
          readonly approver_note: string | null;
        }>`
        SELECT approved_via, approver_note FROM execution_envelope_approvals WHERE envelope_id = ${id}
      `;
        assert.equal(rows.length, 1);
        assert.equal(rows[0]?.approved_via, "local-operator");
        assert.equal(rows[0]?.approver_note, "reviewed the caps");
        const missing = yield* svc.approveEnvelope({
          envelopeId: "env_nope",
          now: NOW,
          approvedVia: "local-operator",
        });
        assert.equal(missing.status, "refused");
        if (missing.status === "refused") assert.equal(missing.reason, "not-found");
      }),
  );

  it.effect("an expired envelope cannot be approved", () =>
    Effect.gen(function* () {
      yield* reset;
      const svc = yield* service();
      const proposed = yield* svc.proposeEnvelope({
        environmentId: ENV,
        envelope: envelopeFixture({ expiresAtMs: NOW + 1_000 }),
        now: NOW,
        proposedVia: "tool",
        capabilityId: CAP,
      });
      const id = proposed.status === "proposed" ? proposed.envelopeId : "";
      const outcome = yield* svc.approveEnvelope({
        envelopeId: id,
        now: NOW + 2_000,
        approvedVia: "local-operator",
      });
      assert.equal(outcome.status, "refused");
      if (outcome.status === "refused") assert.equal(outcome.reason, "expired");
    }),
  );

  it.effect("revoke is one-way from approved, and evaluation refuses afterwards", () =>
    Effect.gen(function* () {
      yield* reset;
      const svc = yield* service();
      const id = yield* approvedEnvelope(svc);

      const revoked = yield* svc.revokeEnvelope({ envelopeId: id, now: NOW + 5_000 });
      assert.equal(revoked.status, "revoked");

      const again = yield* svc.revokeEnvelope({ envelopeId: id, now: NOW + 6_000 });
      assert.equal(again.status, "refused");
      if (again.status === "refused") assert.equal(again.reason, "not-approved");

      // The committed evidence still exists; the revoked envelope is the gate.
      yield* commitEvaluation(matchedRecord(0, "occ-entry-1"));
      const outcome = yield* svc.evaluatePolicy({
        environmentId: ENV,
        capabilityId: CAP,
        now: NOW + 7_000,
      });
      const refusal = refusedWith(outcome, "envelope-revoked");
      assert.include(refusal.detail, "revoked");
    }),
  );
});

// ---------------------------------------------------------------------------
// The evaluation gate ladder
// ---------------------------------------------------------------------------

layer("ExecutionPolicyService evaluatePolicy gates", (it) => {
  it.effect("no installed capability or no envelope refuses by name", () =>
    Effect.gen(function* () {
      yield* reset;
      const svc = yield* service();

      storeState.bundle = null;
      const unconfigured = yield* svc.evaluatePolicy({
        environmentId: ENV,
        capabilityId: CAP,
        now: NOW,
      });
      refusedWith(unconfigured, "unconfigured");

      storeState.bundle = defaultBundle({ status: "paused" });
      const paused = yield* svc.evaluatePolicy({ environmentId: ENV, capabilityId: CAP, now: NOW });
      refusedWith(paused, "paused");

      storeState.bundle = defaultBundle();
      const noEnvelope = yield* svc.evaluatePolicy({
        environmentId: ENV,
        capabilityId: CAP,
        now: NOW,
      });
      refusedWith(noEnvelope, "envelope-not-approved");

      // Proposed-but-not-approved is still not approved.
      yield* svc.proposeEnvelope({
        environmentId: ENV,
        envelope: envelopeFixture(),
        now: NOW,
        proposedVia: "tool",
        capabilityId: CAP,
      });
      const notApproved = yield* svc.evaluatePolicy({
        environmentId: ENV,
        capabilityId: CAP,
        now: NOW,
      });
      refusedWith(notApproved, "envelope-not-approved");
    }),
  );

  it.effect("an envelope refuses evaluation at its expiry instant", () =>
    Effect.gen(function* () {
      yield* reset;
      const svc = yield* service();
      yield* approvedEnvelope(svc, { expiresAtMs: NOW + 1_000 });
      const outcome = yield* svc.evaluatePolicy({
        environmentId: ENV,
        capabilityId: CAP,
        now: NOW + 1_000,
      });
      refusedWith(outcome, "envelope-expired");
    }),
  );

  it.effect(
    "no committed detector evaluation is stale evidence; not-matched and unknown are no-proposals",
    () =>
      Effect.gen(function* () {
        yield* reset;
        const svc = yield* service();
        yield* approvedEnvelope(svc);

        const noEvidence = yield* svc.evaluatePolicy({
          environmentId: ENV,
          capabilityId: CAP,
          now: NOW,
        });
        const stale = refusedWith(noEvidence, "stale-evidence");
        assert.include(stale.detail, "no committed detector evaluation");

        yield* commitEvaluation(
          resultRecord(0, { status: "not-matched", evidenceIds: [], explanation: "flag not set" }),
        );
        const notMatched = yield* svc.evaluatePolicy({
          environmentId: ENV,
          capabilityId: CAP,
          now: NOW,
        });
        assert.equal(notMatched.status, "no-proposal");
        if (notMatched.status === "no-proposal") {
          assert.include(notMatched.reason, "not-matched");
          assert.include(notMatched.reason, "flag not set");
        }

        yield* commitEvaluation(
          resultRecord(
            1,
            { status: "unknown", missingSourceIds: ["src_graph_1"], explanation: "lag" },
            "e",
          ),
        );
        const unknown = yield* svc.evaluatePolicy({
          environmentId: ENV,
          capabilityId: CAP,
          now: NOW,
        });
        assert.equal(unknown.status, "no-proposal");

        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{
          readonly n: number;
        }>`SELECT COUNT(*) AS n FROM execution_proposals`;
        assert.equal(rows[0]?.n, 0);
      }),
  );

  it.effect("a committed evaluation whose recorded as-of is in the future is stale evidence", () =>
    Effect.gen(function* () {
      yield* reset;
      const svc = yield* service();
      yield* approvedEnvelope(svc);
      const future: DetectorEvaluationRecordV2 = {
        ...matchedRecord(0, "occ-future"),
        asOfMs: NOW + 60_000,
      };
      yield* commitEvaluation(future);
      const outcome = yield* svc.evaluatePolicy({
        environmentId: ENV,
        capabilityId: CAP,
        now: NOW,
      });
      const refusal = refusedWith(outcome, "stale-evidence");
      assert.include(refusal.detail, "after now");
    }),
  );

  it.effect(
    "a changed detector artifact, a missing policy artifact, and a stale bundle version all refuse bundle-changed",
    () =>
      Effect.gen(function* () {
        yield* reset;
        const svc = yield* service();
        yield* approvedEnvelope(svc);
        yield* commitEvaluation(matchedRecord(0, "occ-entry-1"));

        // The installed detector bytes differ from the envelope's pin.
        storeState.bundle = defaultBundle({
          artifacts: { ...defaultBundle().artifacts, "detector.ts": "export const changed = 1;\n" },
        });
        refusedWith(
          yield* svc.evaluatePolicy({ environmentId: ENV, capabilityId: CAP, now: NOW }),
          "bundle-changed",
        );

        // A bundle with no execution-policy artifact cannot be the pinned one.
        const manifestJson = fakeManifest();
        const withoutPolicy = {
          ...(JSON.parse(manifestJson) as { artifacts: Array<{ role: string }> }),
          artifacts: (
            JSON.parse(manifestJson) as { artifacts: Array<{ role: string }> }
          ).artifacts.filter((artifact) => artifact.role !== "execution-policy"),
        };
        const { "policy.ts": _policy, ...withoutPolicyArtifacts } = defaultBundle().artifacts;
        storeState.bundle = defaultBundle({
          artifacts: { ...withoutPolicyArtifacts, "manifest.json": JSON.stringify(withoutPolicy) },
        });
        refusedWith(
          yield* svc.evaluatePolicy({ environmentId: ENV, capabilityId: CAP, now: NOW }),
          "bundle-changed",
        );

        // The committed evaluation came from a different bundle version.
        storeState.bundle = defaultBundle({
          version: 2,
          artifacts: { ...defaultBundle().artifacts, "manifest.json": fakeManifest(2) },
        });
        const outcome = yield* svc.evaluatePolicy({
          environmentId: ENV,
          capabilityId: CAP,
          now: NOW,
        });
        const refusal = refusedWith(outcome, "bundle-changed");
        assert.include(refusal.detail, "v1");
      }),
  );

  it.effect("a sandbox refusal is execution-unavailable with the sandbox reason", () =>
    Effect.gen(function* () {
      yield* reset;
      const svc = yield* service();
      yield* approvedEnvelope(svc);
      yield* commitEvaluation(matchedRecord(0, "occ-entry-1"));

      policyState.failWith = "the container runner is unavailable (fixture)";
      const outcome = yield* svc.evaluatePolicy({
        environmentId: ENV,
        capabilityId: CAP,
        now: NOW,
      });
      const refusal = refusedWith(outcome, "execution-unavailable");
      assert.include(refusal.detail, "fixture");
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{
        readonly n: number;
      }>`SELECT COUNT(*) AS n FROM execution_proposals`;
      assert.equal(rows[0]?.n, 0);
    }),
  );

  it.effect("swap proposals violating the output contract refuse invalid-policy-output", () =>
    Effect.gen(function* () {
      yield* reset;
      const svc = yield* service();
      yield* approvedEnvelope(svc);
      yield* commitEvaluation(matchedRecord(0, "occ-entry-1"));

      // Unknown candidate.
      policyState.impl = fixedSwapPolicy({
        amountInRaw: "1000000",
        stageKey: "s1",
        candidateId: "cand_unknown",
      });
      refusedWith(
        yield* svc.evaluatePolicy({ environmentId: ENV, capabilityId: CAP, now: NOW }),
        "invalid-policy-output",
      );

      // Wrong evaluation binding.
      policyState.impl = fixedSwapPolicy({
        amountInRaw: "1000000",
        stageKey: "s2",
        detectorEvaluationId: "dtev_other",
      });
      refusedWith(
        yield* svc.evaluatePolicy({ environmentId: ENV, capabilityId: CAP, now: NOW }),
        "invalid-policy-output",
      );

      // Occurrence key that does not echo the committed evaluation.
      policyState.impl = fixedSwapPolicy({
        amountInRaw: "1000000",
        stageKey: "s3",
        occurrenceKey: "wrong-occ",
      });
      refusedWith(
        yield* svc.evaluatePolicy({ environmentId: ENV, capabilityId: CAP, now: NOW }),
        "invalid-policy-output",
      );

      // Next state that is not a state envelope (the output schema passes it
      // through as unknown; the host envelope check must refuse).
      policyState.impl = () => ({ proposal: { kind: "wait" }, nextState: { nope: true } });
      refusedWith(
        yield* svc.evaluatePolicy({ environmentId: ENV, capabilityId: CAP, now: NOW }),
        "invalid-policy-output",
      );

      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{
        readonly n: number;
      }>`SELECT COUNT(*) AS n FROM execution_proposals`;
      assert.equal(rows[0]?.n, 0);
    }),
  );

  it.effect("out-of-cap amounts are refused budget-exhausted, never clamped, with no row", () =>
    Effect.gen(function* () {
      yield* reset;
      const svc = yield* service();
      yield* approvedEnvelope(svc);
      yield* commitEvaluation(matchedRecord(0, "occ-entry-1"));

      // Over the per-swap cap (2_000_000).
      policyState.impl = fixedSwapPolicy({ amountInRaw: "2000001", stageKey: "over-swap" });
      const overPerSwap = yield* svc.evaluatePolicy({
        environmentId: ENV,
        capabilityId: CAP,
        now: NOW,
      });
      const refusalA = refusedWith(overPerSwap, "budget-exhausted");
      assert.include(refusalA.detail, "never clamping");

      // Over the remaining total (1_500_000) while inside the per-swap cap.
      policyState.impl = fixedSwapPolicy({ amountInRaw: "1500001", stageKey: "over-total" });
      refusedWith(
        yield* svc.evaluatePolicy({ environmentId: ENV, capabilityId: CAP, now: NOW }),
        "budget-exhausted",
      );

      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{
        readonly n: number;
      }>`SELECT COUNT(*) AS n FROM execution_proposals`;
      assert.equal(rows[0]?.n, 0);
    }),
  );

  it.effect("exactly-at-cap amounts are admitted; settled and in-flight spend deducts", () =>
    Effect.gen(function* () {
      yield* reset;
      const svc = yield* service();
      yield* approvedEnvelope(svc);
      yield* commitEvaluation(matchedRecord(0, "occ-entry-1"));
      const sql = yield* SqlClient.SqlClient;

      // A first swap of 1_000_000, then settled: remaining becomes 500_000.
      policyState.impl = fixedSwapPolicy({ amountInRaw: "1000000", stageKey: "first" });
      const first = yield* svc.evaluatePolicy({ environmentId: ENV, capabilityId: CAP, now: NOW });
      assert.equal(first.status, "proposed");
      yield* sql`
        UPDATE execution_proposals SET status = 'executed' WHERE stage_key = 'first'
      `;

      // Settled deduction: 600_000 is over the 500_000 remaining.
      policyState.impl = fixedSwapPolicy({ amountInRaw: "600000", stageKey: "second" });
      refusedWith(
        yield* svc.evaluatePolicy({ environmentId: ENV, capabilityId: CAP, now: NOW + 1 }),
        "budget-exhausted",
      );

      // Exact remaining is admitted; proposed rows do not reserve, so the
      // admission path marks them in flight — and in-flight deducts too.
      policyState.impl = fixedSwapPolicy({ amountInRaw: "500000", stageKey: "third" });
      const third = yield* svc.evaluatePolicy({
        environmentId: ENV,
        capabilityId: CAP,
        now: NOW + 2,
      });
      assert.equal(third.status, "proposed");
      yield* sql`
        UPDATE execution_proposals SET status = 'executing' WHERE stage_key = 'third'
      `;
      policyState.impl = fixedSwapPolicy({ amountInRaw: "1", stageKey: "fourth" });
      refusedWith(
        yield* svc.evaluatePolicy({ environmentId: ENV, capabilityId: CAP, now: NOW + 3 }),
        "budget-exhausted",
      );

      // Rejected rows release their hold: with the in-flight swap rejected,
      // the 500_000 is spendable once more (a reverse action is a new stage).
      yield* sql`
        UPDATE execution_proposals SET status = 'rejected' WHERE stage_key = 'third'
      `;
      policyState.impl = fixedSwapPolicy({ amountInRaw: "500000", stageKey: "fifth" });
      const fifth = yield* svc.evaluatePolicy({
        environmentId: ENV,
        capabilityId: CAP,
        now: NOW + 4,
      });
      assert.equal(fifth.status, "proposed");
    }),
  );

  it.effect(
    "a corrupt spend ledger refuses corrupt-budget-ledger instead of proposing against a fresh budget",
    () =>
      Effect.gen(function* () {
        yield* reset;
        const svc = yield* service();
        yield* approvedEnvelope(svc);
        yield* commitEvaluation(matchedRecord(0, "occ-entry-1"));
        const sql = yield* SqlClient.SqlClient;

        // A valid executed row first, then a corrupt one: any malformed row
        // in the ledger — before or after valid rows — refuses the fold.
        policyState.impl = fixedSwapPolicy({ amountInRaw: "100000", stageKey: "first" });
        const first = yield* svc.evaluatePolicy({
          environmentId: ENV,
          capabilityId: CAP,
          now: NOW,
        });
        assert.equal(first.status, "proposed");
        yield* sql`
          UPDATE execution_proposals SET status = 'executed' WHERE stage_key = 'first'
        `;
        const envelopeRows = yield* sql<{ readonly envelope_id: string }>`
          SELECT envelope_id FROM execution_envelopes LIMIT 1
        `;
        yield* sql`
          INSERT INTO execution_proposals (
            proposal_id, environment_id, capability_id, envelope_id, envelope_revision,
            detector_evaluation_id, stage_key, proposal_json, status, proposed_at_ms
          ) VALUES (
            'pprop_corrupt', ${ENV}, ${CAP}, ${envelopeRows[0]!.envelope_id}, 1,
            'dtev_corrupt', 'corrupt', '{"kind":"swap","amountInRaw":"1.5"}', 'executing', ${NOW}
          )
        `;
        policyState.impl = fixedSwapPolicy({ amountInRaw: "1", stageKey: "second" });
        const outcome = yield* svc.evaluatePolicy({
          environmentId: ENV,
          capabilityId: CAP,
          now: NOW + 1,
        });
        const refusal = refusedWith(outcome, "corrupt-budget-ledger");
        assert.include(refusal.detail, "corrupt");
        // Nothing was proposed against the unreadable ledger.
        const rows = yield* sql<{ readonly n: number }>`
          SELECT COUNT(*) AS n FROM execution_proposals WHERE stage_key = 'second'
        `;
        assert.equal(rows[0]?.n, 0);
      }),
  );
});

// ---------------------------------------------------------------------------
// Stage uniqueness, policy state, and the two-stage proof
// ---------------------------------------------------------------------------

layer("ExecutionPolicyService proposals and policy state", (it) => {
  it.effect("the two-stage proof: entry, idempotent re-run, then exit on new evidence", () =>
    Effect.gen(function* () {
      yield* reset;
      const svc = yield* service();
      const envelopeId = yield* approvedEnvelope(svc);
      const sql = yield* SqlClient.SqlClient;

      // Stage 1: the first matched evaluation proposes the entry swap.
      const firstEval = matchedRecord(0, "occ-entry-1");
      yield* commitEvaluation(firstEval);
      const entry = yield* svc.evaluatePolicy({ environmentId: ENV, capabilityId: CAP, now: NOW });
      assert.equal(entry.status, "proposed");
      if (entry.status !== "proposed") throw new Error("unreachable");
      assert.equal(entry.proposal.kind, "swap");
      if (entry.proposal.kind === "swap") {
        assert.equal(entry.proposal.stageKey, "entry");
        assert.equal(entry.proposal.detectorEvaluationId, firstEval.evaluationId);
        assert.equal(entry.proposal.amountInRaw, "1000000");
      }
      // The content id is exactly the contracts' derivation.
      assert.equal(
        entry.proposalId,
        proposalId({
          envelopeRevision: 1,
          capabilityId: CAP,
          detectorEvaluationId: firstEval.evaluationId,
          stageKey: "entry",
          proposedAtMs: NOW,
        }),
      );
      const entryRow = yield* sql<{
        readonly proposal_id: string;
        readonly stage_key: string;
        readonly status: string;
        readonly envelope_id: string;
      }>`
        SELECT proposal_id, stage_key, status, envelope_id
        FROM execution_proposals WHERE stage_key = 'entry'
      `;
      assert.equal(entryRow[0]?.proposal_id, entry.proposalId);
      assert.equal(entryRow[0]?.status, "proposed");
      assert.equal(entryRow[0]?.envelope_id, envelopeId);

      // The policy state advanced atomically with the proposal: revision 0,
      // carrying the counter and the entry's evaluation id.
      const state0 = yield* sql<{ readonly state_revision: number; readonly state_json: string }>`
        SELECT state_revision, state_json FROM execution_policy_state
        WHERE environment_id = ${ENV} AND capability_id = ${CAP}
      `;
      assert.equal(state0[0]?.state_revision, 0);
      assert.include(state0[0]?.state_json ?? "", firstEval.evaluationId);

      // Stage 2: the SAME committed evaluation re-evaluated proposes nothing
      // new — the identical swap collapses onto the existing proposal.
      const replay = yield* svc.evaluatePolicy({
        environmentId: ENV,
        capabilityId: CAP,
        now: NOW + 1_000,
      });
      assert.equal(replay.status, "already-proposed");
      if (replay.status === "already-proposed") assert.equal(replay.proposalId, entry.proposalId);
      const afterReplay = yield* sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM execution_proposals
      `;
      assert.equal(afterReplay[0]?.n, 1);
      const stateAfterReplay = yield* sql<{ readonly state_revision: number }>`
        SELECT state_revision FROM execution_policy_state
        WHERE environment_id = ${ENV} AND capability_id = ${CAP}
      `;
      assert.equal(stateAfterReplay[0]?.state_revision, 0);

      // The sealed input carried the prior state and the prior proposals.
      assert.isNotNull(policyState.seen);
      assert.equal(policyState.seen?.priorState?.stateSchemaVersion, 1);
      assert.deepEqual(
        (policyState.seen?.priorProposals ?? []).map((proposal) => proposal.stageKey),
        ["entry"],
      );

      // Stage 3: a NEW detector evaluation (different evaluationId) proposes
      // the exit swap — changing evidence changes the proposal.
      const secondEval = matchedRecord(1, "occ-entry-2");
      yield* commitEvaluation(secondEval);
      const exit = yield* svc.evaluatePolicy({
        environmentId: ENV,
        capabilityId: CAP,
        now: NOW + 2_000,
      });
      assert.equal(exit.status, "proposed");
      if (exit.status !== "proposed") throw new Error("unreachable");
      if (exit.proposal.kind === "swap") {
        assert.equal(exit.proposal.stageKey, "exit");
        assert.equal(exit.proposal.detectorEvaluationId, secondEval.evaluationId);
        assert.equal(exit.proposal.occurrenceKey, "occ-entry-2");
      }
      assert.notEqual(exit.proposalId, entry.proposalId);
      const state1 = yield* sql<{ readonly state_revision: number; readonly state_json: string }>`
        SELECT state_revision, state_json FROM execution_policy_state
        WHERE environment_id = ${ENV} AND capability_id = ${CAP}
      `;
      assert.equal(state1[0]?.state_revision, 1);
      assert.include(state1[0]?.state_json ?? "", secondEval.evaluationId);

      // The listing serves both, newest first.
      const listed = yield* svc.listProposals({ envelopeId });
      assert.deepEqual(
        listed.map((record) => (record.proposal.kind === "swap" ? record.proposal.stageKey : "?")),
        ["exit", "entry"],
      );
      assert.deepEqual(
        listed.map((record) => record.status),
        ["proposed", "proposed"],
      );
    }),
  );

  it.effect(
    "the same stage from a different evaluation, or with different bytes, is stage-already-executed",
    () =>
      Effect.gen(function* () {
        yield* reset;
        const svc = yield* service();
        yield* approvedEnvelope(svc);
        const sql = yield* SqlClient.SqlClient;

        yield* commitEvaluation(matchedRecord(0, "occ-entry-1"));
        const entry = yield* svc.evaluatePolicy({
          environmentId: ENV,
          capabilityId: CAP,
          now: NOW,
        });
        assert.equal(entry.status, "proposed");

        // Same evaluation, same stage, DIFFERENT bytes: a stage conflict.
        policyState.impl = fixedSwapPolicy({ amountInRaw: "999999", stageKey: "entry" });
        const differentBytes = yield* svc.evaluatePolicy({
          environmentId: ENV,
          capabilityId: CAP,
          now: NOW + 1_000,
        });
        const refusalA = refusedWith(differentBytes, "stage-already-executed");
        assert.include(refusalA.detail, "entry");

        // A NEW evaluation proposing the same stage: the storage predicate
        // holds even when the evaluation differs.
        yield* commitEvaluation(matchedRecord(1, "occ-entry-2"));
        policyState.impl = fixedSwapPolicy({ amountInRaw: "1000000", stageKey: "entry" });
        refusedWith(
          yield* svc.evaluatePolicy({ environmentId: ENV, capabilityId: CAP, now: NOW + 2_000 }),
          "stage-already-executed",
        );

        // The unique index itself: a direct duplicate insert fails (04:113 —
        // the stage uniqueness is a STORAGE predicate, not writer discipline).
        const attempted = yield* Effect.exit(sql`
        INSERT INTO execution_proposals (
          proposal_id, environment_id, capability_id, envelope_id, envelope_revision,
          detector_evaluation_id, stage_key, proposal_json, status, proposed_at_ms
        ) VALUES (
          'pprop_dup', ${ENV}, ${CAP},
          (SELECT envelope_id FROM execution_envelopes LIMIT 1), 1,
          'dtev_dup', 'entry', '{}', 'proposed', ${NOW}
        )
      `);
        assert.isTrue(attempted._tag === "Failure");

        // Different stage on the new evaluation is fine.
        policyState.impl = fixedSwapPolicy({ amountInRaw: "1000000", stageKey: "exit-2" });
        const fresh = yield* svc.evaluatePolicy({
          environmentId: ENV,
          capabilityId: CAP,
          now: NOW + 3_000,
        });
        assert.equal(fresh.status, "proposed");
        const rows = yield* sql<{
          readonly n: number;
        }>`SELECT COUNT(*) AS n FROM execution_proposals`;
        assert.equal(rows[0]?.n, 2);
      }),
  );

  it.effect(
    "a policy-state revision moved between read and commit refuses state-revision-conflict, writing nothing",
    () =>
      Effect.gen(function* () {
        yield* reset;
        const svc = yield* service();
        yield* approvedEnvelope(svc);
        const sql = yield* SqlClient.SqlClient;

        yield* commitEvaluation(matchedRecord(0, "occ-entry-1"));
        const entry = yield* svc.evaluatePolicy({
          environmentId: ENV,
          capabilityId: CAP,
          now: NOW,
        });
        assert.equal(entry.status, "proposed");

        // The hook fires INSIDE the contained run — after the service read the
        // state row, before the transaction — and moves the revision under it.
        policyState.hook = async () => {
          await Effect.runPromise(
            sql`UPDATE execution_policy_state SET state_revision = state_revision + 1
              WHERE environment_id = ${ENV} AND capability_id = ${CAP}`,
          );
        };
        yield* commitEvaluation(matchedRecord(1, "occ-entry-2"));
        const conflicted = yield* svc.evaluatePolicy({
          environmentId: ENV,
          capabilityId: CAP,
          now: NOW + 1_000,
        });
        const refusal = refusedWith(conflicted, "state-revision-conflict");
        assert.include(refusal.detail, "expected policy state revision 0");

        // Nothing was written: no exit proposal, no state overwrite.
        const rows = yield* sql<{
          readonly n: number;
        }>`SELECT COUNT(*) AS n FROM execution_proposals`;
        assert.equal(rows[0]?.n, 1);
        const state = yield* sql<{ readonly state_revision: number; readonly state_json: string }>`
        SELECT state_revision, state_json FROM execution_policy_state
        WHERE environment_id = ${ENV} AND capability_id = ${CAP}
      `;
        assert.equal(state[0]?.state_revision, 1);
        // The hook's own bump is the ONLY change — the entry bytes survive.
        assert.include(state[0]?.state_json ?? "", matchedRecord(0, "occ-entry-1").evaluationId);
      }),
  );

  it.effect("a stored policy state that does not decode refuses invalid-policy-state", () =>
    Effect.gen(function* () {
      yield* reset;
      const svc = yield* service();
      yield* approvedEnvelope(svc);
      const sql = yield* SqlClient.SqlClient;

      yield* sql`
        INSERT INTO execution_policy_state (environment_id, capability_id, state_json, state_revision, updated_at_ms)
        VALUES (${ENV}, ${CAP}, ${"{not an envelope"}, 0, ${NOW})
      `;
      yield* commitEvaluation(matchedRecord(0, "occ-entry-1"));
      const outcome = yield* svc.evaluatePolicy({
        environmentId: ENV,
        capabilityId: CAP,
        now: NOW,
      });
      const refusal = refusedWith(outcome, "invalid-policy-state");
      assert.include(refusal.detail, "decode");
    }),
  );

  it.effect(
    "the committed policy state decodes through the envelope contract and counts runs",
    () =>
      Effect.gen(function* () {
        yield* reset;
        const svc = yield* service();
        yield* approvedEnvelope(svc);

        yield* commitEvaluation(matchedRecord(0, "occ-entry-1"));
        yield* svc.evaluatePolicy({ environmentId: ENV, capabilityId: CAP, now: NOW });
        yield* commitEvaluation(matchedRecord(1, "occ-entry-2"));
        yield* svc.evaluatePolicy({ environmentId: ENV, capabilityId: CAP, now: NOW + 1_000 });

        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{ readonly state_json: string }>`
        SELECT state_json FROM execution_policy_state
        WHERE environment_id = ${ENV} AND capability_id = ${CAP}
      `;
        const decoded = decodeDetectorState(rows[0]?.state_json ?? "");
        assert.isTrue(decoded.ok);
        if (decoded.ok) {
          const state = decoded.envelope.state as { runs?: number };
          assert.equal(state.runs, 2);
        }
      }),
  );
});
