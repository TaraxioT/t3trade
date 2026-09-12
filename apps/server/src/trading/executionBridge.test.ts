import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  ExecutionPolicyService,
  type ExecutionEnvelopeView,
} from "./forge/ExecutionPolicyService.ts";
import { SwapExecutionService } from "./forge/SwapExecutionService.ts";
import { forgeExecutionRevokeView, forgeExecutionStateView } from "./executionBridge.ts";

const scope = { environmentId: "env-a", capabilityId: "cap-a" };
const envelope: ExecutionEnvelopeView = {
  ...scope,
  envelopeId: "envelope-a",
  revision: 1,
  status: "approved",
  envelope: null,
  proposedAtMs: 1,
  approvedAtMs: 2,
  approvedVia: "user",
  revokedAtMs: null,
};
const unused = (): never => {
  throw new Error("unexpected side effect");
};

const services = (row: ExecutionEnvelopeView | null = envelope) => {
  let revoked = 0;
  let listed = 0;
  const policy = ExecutionPolicyService.of({
    proposeEnvelope: unused,
    approveEnvelope: unused,
    evaluatePolicy: unused,
    envelopeFor: () => Effect.succeed(row),
    listProposals: () =>
      Effect.sync(() => {
        listed++;
        return [];
      }),
    revokeEnvelope: ({ envelopeId }) =>
      Effect.sync(() => {
        revoked++;
        return { status: "revoked" as const, envelopeId };
      }),
  });
  const swaps = SwapExecutionService.of({
    prepareAndAttempt: unused,
    intentFor: unused,
    envelopeById: () => Effect.succeed(row),
    listIntents: () =>
      Effect.sync(() => {
        listed++;
        return [];
      }),
    remainingInputBudgetFor: () =>
      Effect.succeed({ remainingInputCapRaw: "10", settledRaw: "0", inFlightRaw: "0" }),
  });
  return { policy, swaps, counts: () => ({ revoked, listed }) };
};

describe("execution bridge", () => {
  it.effect("reports unwired state without inventing an empty envelope or budget", () =>
    Effect.gen(function* () {
      assert.equal((yield* forgeExecutionStateView(scope)).status, "unavailable");
      assert.equal(
        (yield* forgeExecutionRevokeView({ ...scope, envelopeId: "envelope-a" })).applied,
        false,
      );
    }),
  );

  it.effect("reads bounded retained execution state without approval or execution", () =>
    Effect.gen(function* () {
      const fake = services();
      const result = yield* forgeExecutionStateView(scope).pipe(
        Effect.provideService(ExecutionPolicyService, fake.policy),
        Effect.provideService(SwapExecutionService, fake.swaps),
      );
      assert.equal(result.status, "ok");
      if (result.status !== "ok") throw new Error("unreachable");
      assert.equal(result.budget.remainingInputCapRaw, "10");
      assert.deepEqual(fake.counts(), { revoked: 0, listed: 2 });
    }),
  );

  it.effect("distinguishes no proposed envelope from unavailable services", () =>
    Effect.gen(function* () {
      const fake = services(null);
      const result = yield* forgeExecutionStateView(scope).pipe(
        Effect.provideService(ExecutionPolicyService, fake.policy),
        Effect.provideService(SwapExecutionService, fake.swaps),
      );
      assert.equal(result.status, "none");
      assert.equal(fake.counts().listed, 0);
    }),
  );

  it.effect(
    "refuses cross-environment and cross-capability reads and revocation before side effects",
    () =>
      Effect.gen(function* () {
        for (const foreign of [
          { ...envelope, environmentId: "env-b" },
          { ...envelope, capabilityId: "cap-b" },
        ]) {
          const fake = services(foreign);
          const read = yield* forgeExecutionStateView(scope).pipe(
            Effect.provideService(ExecutionPolicyService, fake.policy),
            Effect.provideService(SwapExecutionService, fake.swaps),
          );
          const revoke = yield* forgeExecutionRevokeView({
            ...scope,
            envelopeId: envelope.envelopeId,
          }).pipe(
            Effect.provideService(ExecutionPolicyService, fake.policy),
            Effect.provideService(SwapExecutionService, fake.swaps),
          );
          assert.equal(read.status, "unavailable");
          assert.equal(revoke.applied, false);
          assert.deepEqual(fake.counts(), { revoked: 0, listed: 0 });
        }
      }),
  );

  it.effect("directly revokes only the connected environment's matching envelope", () =>
    Effect.gen(function* () {
      const fake = services();
      const result = yield* forgeExecutionRevokeView({
        ...scope,
        envelopeId: envelope.envelopeId,
      }).pipe(
        Effect.provideService(ExecutionPolicyService, fake.policy),
        Effect.provideService(SwapExecutionService, fake.swaps),
      );
      assert.equal(result.applied, true);
      assert.equal(fake.counts().revoked, 1);
    }),
  );
});
