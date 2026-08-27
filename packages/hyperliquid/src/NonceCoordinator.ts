/**
 * Serialized signing lane and monotonic-nonce coordinator - spec §15.6.
 *
 * Every action signed by the execution wallet passes through ONE serialized
 * lane. The coordinator guarantees:
 *
 *  - nonces are strictly monotonic (never duplicated);
 *  - the next nonce is fast-forwarded to current Unix milliseconds when the
 *    wall clock has moved past the last-issued value (the exchange accepts
 *    a current-or-future ms nonce and rejects stale ones). A restart
 *    therefore needs no persisted state: real time has always moved past
 *    anything signed before it.
 *
 * The lane serializes the whole "assign nonce → sign → submit" critical
 * section so two harness-requested actions can never race for the same
 * nonce. Callers pass the effect that consumes the assigned nonce; the
 * coordinator runs it under the single permit and only commits the nonce
 * once the effect succeeds.
 *
 * @module HyperliquidNonceCoordinator
 */
import { Context, Effect, Ref, Schema } from "effect";
import * as Clock from "effect/Clock";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

/** A nonce that could not be issued. */
export class HyperliquidNonceError extends Schema.TaggedErrorClass<HyperliquidNonceError>()(
  "HyperliquidNonceError",
  {
    reason: Schema.Literals(["clock_before_last", "persist_failed"]),
    lastIssued: Schema.optional(Schema.Number),
  },
) {
  override get message(): string {
    return `HyperliquidNonceError(${this.reason}): lastIssued=${this.lastIssued ?? "-"}`;
  }
}

/**
 * The serialized nonce lane. One instance per execution wallet.
 *
 * `nextNonce` returns the next monotonic nonce without running work; use it
 * only for previews. `runWithNonce` is the signing lane: it assigns a nonce,
 * runs the caller's effect (sign + submit) under the single permit, and
 * commits the nonce on success.
 */
export class HyperliquidNonceCoordinator extends Context.Service<
  HyperliquidNonceCoordinator,
  {
    /**
     * Peek the next nonce this lane would issue, without consuming it. Useful
     * for previews and dry-runs. The returned value is monotonic relative to
     * the last committed nonce but is not reserved.
     */
    readonly nextNonce: Effect.Effect<number, HyperliquidNonceError>;

    /**
     * Run `effect` under the serialized signing lane with a freshly issued,
     * strictly-monotonic nonce. The nonce is committed only if `effect`
     * succeeds, so a failed submission does not burn a gap unnecessarily
     * (though gaps are harmless to the exchange).
     */
    readonly runWithNonce: <A, E, R>(
      effect: (nonce: number) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | HyperliquidNonceError, R>;
  }
>()("@t3tools/hyperliquid/NonceCoordinator/HyperliquidNonceCoordinator") {}

/**
 * Build a coordinator. In-memory only: the clock fast-forward above makes a
 * fresh process's first nonce (current ms) strictly greater than anything a
 * previous process signed, so there is nothing to rehydrate.
 */
export const makeNonceCoordinator = Effect.fn("makeNonceCoordinator")(function* () {
  const lastRef = yield* Ref.make<number>(0);
  const lane = yield* Semaphore.make(1);

  const commit = (nonce: number): Effect.Effect<void> =>
    Ref.update(lastRef, (prev) => (nonce > prev ? nonce : prev));

  const issueNext: Effect.Effect<number, HyperliquidNonceError> = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const last = yield* Ref.get(lastRef);
    // Fast-forward to the current wall clock when it has moved past the last
    // issued nonce; otherwise increment by one. Both branches are strictly
    // greater than `last`, so the lane never duplicates a nonce.
    const next = now > last ? now : last + 1;
    return next;
  });

  return HyperliquidNonceCoordinator.of({
    nextNonce: issueNext,

    runWithNonce: <A, E, R>(effect: (nonce: number) => Effect.Effect<A, E, R>) =>
      lane.withPermits(1)(
        Effect.gen(function* () {
          const nonce = yield* issueNext;
          const result = yield* effect(nonce);
          yield* commit(nonce);
          return result;
        }),
      ),
  });
});

/** The live layer. */
export const HyperliquidNonceCoordinatorLive = () =>
  Layer.effect(HyperliquidNonceCoordinator, makeNonceCoordinator());
