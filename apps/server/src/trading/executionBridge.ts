import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { ForgeExecutionStateView } from "@t3tools/contracts";
import { ExecutionPolicyService } from "./forge/ExecutionPolicyService.ts";
import { SwapExecutionService } from "./forge/SwapExecutionService.ts";

const UNAVAILABLE = "Execution state is unavailable in this environment";

/** Reads retained decisions only; never prices, evaluates, approves, or signs. */
export const forgeExecutionStateView = (input: {
  readonly environmentId: string;
  readonly capabilityId: string;
}): Effect.Effect<ForgeExecutionStateView> =>
  Effect.gen(function* () {
    const policy = yield* Effect.serviceOption(ExecutionPolicyService);
    const swaps = yield* Effect.serviceOption(SwapExecutionService);
    if (Option.isNone(policy) || Option.isNone(swaps)) {
      return { status: "unavailable" as const, reason: UNAVAILABLE };
    }
    const envelope = yield* policy.value.envelopeFor(input);
    if (envelope === null) {
      return { status: "none" as const, reason: "No execution envelope has been proposed" };
    }
    // Listings are keyed by envelope, so establish scope before reading them.
    if (
      envelope.environmentId !== input.environmentId ||
      envelope.capabilityId !== input.capabilityId
    ) {
      return { status: "unavailable" as const, reason: UNAVAILABLE };
    }
    const [proposals, intents, budget] = yield* Effect.all([
      policy.value.listProposals({ envelopeId: envelope.envelopeId, limit: 100 }),
      swaps.value.listIntents({ envelopeId: envelope.envelopeId, limit: 100 }),
      swaps.value.remainingInputBudgetFor(envelope.envelopeId),
    ]);
    if (budget === null) {
      return {
        status: "unavailable" as const,
        reason: "The retained execution budget cannot be read",
      };
    }
    return { status: "ok" as const, envelope, proposals, intents, budget };
  }).pipe(
    Effect.catch(() => Effect.succeed({ status: "unavailable" as const, reason: UNAVAILABLE })),
  );

/** Revocation is a direct user control and requires no provider or signer. */
export const forgeExecutionRevokeView = (input: {
  readonly environmentId: string;
  readonly capabilityId: string;
  readonly envelopeId: string;
}): Effect.Effect<{ readonly applied: boolean; readonly reason?: string }> =>
  Effect.gen(function* () {
    const policy = yield* Effect.serviceOption(ExecutionPolicyService);
    const swaps = yield* Effect.serviceOption(SwapExecutionService);
    if (Option.isNone(policy) || Option.isNone(swaps))
      return { applied: false, reason: UNAVAILABLE };
    const envelope = yield* swaps.value.envelopeById(input.envelopeId);
    if (
      envelope === null ||
      envelope.environmentId !== input.environmentId ||
      envelope.capabilityId !== input.capabilityId
    ) {
      return { applied: false, reason: "Envelope not found in this environment and capability" };
    }
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const result = yield* policy.value.revokeEnvelope({ envelopeId: input.envelopeId, now });
    return result.status === "revoked"
      ? { applied: true }
      : {
          applied: false,
          reason: result.status === "refused" ? result.detail : "Envelope was not revoked",
        };
  }).pipe(Effect.catch(() => Effect.succeed({ applied: false, reason: UNAVAILABLE })));

/**
 * Approval is a DIRECT user act over the authenticated WS surface — the same
 * boundary revocation uses. It binds the exact proposed envelope (immutable
 * digest, caps, expiry) and never flows through the agent/tool path: the
 * trading_forge approve_envelope action is refused by name. The env-derived
 * F0 origin "server-config" is refused by the service itself.
 */
export const forgeExecutionApproveView = (input: {
  readonly environmentId: string;
  readonly capabilityId: string;
  readonly envelopeId: string;
  readonly approvedVia: string;
}): Effect.Effect<{ readonly applied: boolean; readonly reason?: string }> =>
  Effect.gen(function* () {
    const policy = yield* Effect.serviceOption(ExecutionPolicyService);
    const swaps = yield* Effect.serviceOption(SwapExecutionService);
    if (Option.isNone(policy) || Option.isNone(swaps))
      return { applied: false, reason: UNAVAILABLE };
    const envelope = yield* swaps.value.envelopeById(input.envelopeId);
    if (
      envelope === null ||
      envelope.environmentId !== input.environmentId ||
      envelope.capabilityId !== input.capabilityId
    ) {
      return { applied: false, reason: "Envelope not found in this environment and capability" };
    }
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const result = yield* policy.value.approveEnvelope({
      envelopeId: input.envelopeId,
      now,
      approvedVia: input.approvedVia,
    });
    return result.status === "approved"
      ? { applied: true }
      : {
          applied: false,
          reason: result.status === "refused" ? result.detail : "Envelope was not approved",
        };
  }).pipe(Effect.catch(() => Effect.succeed({ applied: false, reason: UNAVAILABLE })));
