import { useAtomValue } from "@effect/atom-react";
import {
  ThreadId,
  type EnvironmentId,
  type ForgeDetectorEvaluationSummary,
  type ForgePoolSeriesView,
  type ForgePoolStateView,
  type ForgeThreadContextView,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { orchestrationEnvironment } from "../state/orchestration";

/**
 * Forge bridge state hooks (U0) — poll-based reads over the forge RPCs, thin
 * on purpose: no components, no client-side derivation. Every unavailable
 * thing arrives as a named state inside the payload (the server never fails a
 * read to say "not configured"), so the hooks only carry the result through.
 */

const FORGE_POLL_INTERVAL_MS = 30_000;

export interface ForgeReadState<View> {
  readonly data: View | null;
  readonly error: string | null;
  /** True when `data` is a retained view whose last refresh FAILED. */
  readonly stale: boolean;
  readonly isLoading: boolean;
  readonly refresh: () => void;
}

/** The UTC window a series read asks for, epoch millis. */
export interface ForgeSeriesDomain {
  readonly fromUtcMs: number;
  readonly toUtcMs: number;
}

function forgePoolSeriesAtom(
  environmentId: EnvironmentId,
  poolId: string,
  points: number | null,
  domain: ForgeSeriesDomain | null,
) {
  return orchestrationEnvironment.forgePoolSeries({
    environmentId,
    input: {
      poolId,
      ...(points === null ? {} : { points }),
      ...(domain === null
        ? {}
        : { domain: { fromUtcMs: domain.fromUtcMs, toUtcMs: domain.toUtcMs } }),
    },
  });
}

function forgePoolStateAtom(environmentId: EnvironmentId) {
  return orchestrationEnvironment.forgePoolState({ environmentId, input: {} });
}

function forgeThreadContextAtom(environmentId: EnvironmentId, threadId: string | null) {
  return orchestrationEnvironment.forgeThreadContext({
    environmentId,
    input: threadId === null ? {} : { threadId: ThreadId.make(threadId) },
  });
}

/**
 * The disabled sentinels must match their family atom types exactly so the
 * two branches of each `useMemo` unify (the market chart hook's pattern): a
 * real atom in a non-success state keeps `useAtomValue` unconditional
 * (rules-of-hooks) on the disabled path, and nothing is read off the wire.
 */
type ForgePoolSeriesAtom = ReturnType<typeof forgePoolSeriesAtom>;
type ForgePoolStateAtom = ReturnType<typeof forgePoolStateAtom>;
type ForgeThreadContextAtom = ReturnType<typeof forgeThreadContextAtom>;

const DISABLED_SERIES_ATOM: ForgePoolSeriesAtom = Atom.make(
  AsyncResult.initial<ForgePoolSeriesView>(),
);
const DISABLED_POOL_STATE_ATOM: ForgePoolStateAtom = Atom.make(
  AsyncResult.initial<ForgePoolStateView>(),
);
const DISABLED_THREAD_CONTEXT_ATOM: ForgeThreadContextAtom = Atom.make(
  AsyncResult.initial<ForgeThreadContextView>(),
);

/**
 * The per-atom bookkeeping every forge hook shares: keep the last good view
 * across a failed poll tick (the pool did not stop existing because a request
 * failed), reset when the atom identity changes so a different pool never
 * renders the previous one's series. A failed refresh NEVER stays silent when
 * retained data is on screen — the error is surfaced and the view is marked
 * stale, so retained data can never masquerade as a healthy live signal.
 */
function useRetainedAtomValue<View, E>(
  atom: Atom.Atom<AsyncResult.AsyncResult<View, E>>,
): {
  readonly data: View | null;
  readonly error: string | null;
  readonly stale: boolean;
  readonly isLoading: boolean;
} {
  const result = useAtomValue(atom);
  const fresh = Option.getOrNull(AsyncResult.value(result));
  const lastGood = useRef<View | null>(null);
  const lastAtom = useRef<Atom.Atom<AsyncResult.AsyncResult<View, E>> | null>(null);
  if (lastAtom.current !== atom) {
    lastAtom.current = atom;
    lastGood.current = null;
  }
  if (fresh !== null) lastGood.current = fresh;
  const data = fresh ?? lastGood.current;
  const failed = result._tag === "Failure";
  return {
    data,
    error: failed
      ? `Last refresh failed${data === null ? "." : "; showing the retained view."}`
      : null,
    stale: failed && data !== null,
    isLoading: result.waiting,
  };
}

/**
 * One pool's bounded swap series. The domain and point cap are part of the
 * atom key, so changing either re-reads under a new identity exactly like
 * changing the pool. The poll only runs while `enabled` and only when the
 * caller drives it (`poll`, default true) — a closed historical window passes
 * `poll: false` because it cannot change.
 */
export function useForgePoolSeries(
  environmentId: EnvironmentId,
  poolId: string | null,
  options: {
    readonly enabled: boolean;
    readonly poll?: boolean;
    readonly points?: number;
    readonly domain?: ForgeSeriesDomain;
  },
): ForgeReadState<ForgePoolSeriesView> {
  const enabled = options.enabled && poolId !== null;
  const polls = options.poll ?? true;
  const points = options.points ?? null;
  const domain = options.domain ?? null;
  const domainFrom = domain?.fromUtcMs ?? null;
  const domainTo = domain?.toUtcMs ?? null;

  const atom = useMemo<ForgePoolSeriesAtom>(() => {
    if (!enabled || poolId === null) return DISABLED_SERIES_ATOM;
    return forgePoolSeriesAtom(environmentId, poolId, points, domain);
    // The window is depended on by its two numbers rather than by object
    // identity, so a caller rebuilding the literal each render does not thrash
    // the atom.
  }, [enabled, poolId, environmentId, points, domainFrom, domainTo]);

  const retained = useRetainedAtomValue(atom);

  const refresh = useCallback(() => {
    if (!enabled || poolId === null) return;
    appAtomRegistry.refresh(atom);
  }, [enabled, poolId, atom]);

  const windowClosed = domainFrom !== null && domainTo !== null;
  useEffect(() => {
    if (!enabled || windowClosed || !polls) return;
    const id = window.setInterval(refresh, FORGE_POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [enabled, windowClosed, polls, refresh]);

  return { ...retained, refresh };
}

/**
 * The F3 pool-state handoff: proposal/grant, position, direct controls,
 * publication, chain snapshot, and the bounded intent list. Polled slowly —
 * every freshness signal the payload carries is chain- or store-side
 * (`asOfBlockNumber`, `fetchedAtMs`), never a client clock.
 */
export function useForgePoolState(
  environmentId: EnvironmentId,
  options: {
    readonly enabled: boolean;
    readonly poll?: boolean;
  },
): ForgeReadState<ForgePoolStateView> {
  const enabled = options.enabled;
  const polls = options.poll ?? true;

  const atom = useMemo<ForgePoolStateAtom>(
    () => (!enabled ? DISABLED_POOL_STATE_ATOM : forgePoolStateAtom(environmentId)),
    [enabled, environmentId],
  );

  const retained = useRetainedAtomValue(atom);

  const refresh = useCallback(() => {
    if (!enabled) return;
    appAtomRegistry.refresh(atom);
  }, [enabled, atom]);

  useEffect(() => {
    if (!enabled || !polls) return;
    const id = window.setInterval(refresh, FORGE_POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [enabled, polls, refresh]);

  return { ...retained, refresh };
}

/**
 * The in-scope v2 detector summaries a thread-context view carries — the
 * panel's one read for "what is my installed detector's armed standing and
 * latest reading". A payload from before the detector slot (absent field) and
 * a named-unavailable slot both read as the empty list: absence renders from
 * the view's own `detectorEvaluations` status, never as fabricated rows.
 */
export function forgeDetectorSummaries(
  view: ForgeThreadContextView,
): ReadonlyArray<ForgeDetectorEvaluationSummary> {
  const slot = view.detectorEvaluations;
  return slot !== undefined && slot.status === "ok" ? slot.items : [];
}

/**
 * Source/build discovery for a conversation — works with no Hyperliquid
 * market focus. Not polled: the panel re-asks when the user acts (installs a
 * capability, opens a pool) and freshness rides in the payload.
 */
export function useForgeThreadContext(
  environmentId: EnvironmentId,
  options: {
    readonly enabled: boolean;
    readonly threadId?: string;
  },
): ForgeReadState<ForgeThreadContextView> {
  const enabled = options.enabled;
  const threadId = options.threadId ?? null;

  const atom = useMemo<ForgeThreadContextAtom>(
    () =>
      !enabled ? DISABLED_THREAD_CONTEXT_ATOM : forgeThreadContextAtom(environmentId, threadId),
    [enabled, environmentId, threadId],
  );

  const retained = useRetainedAtomValue(atom);

  const refresh = useCallback(() => {
    if (!enabled) return;
    appAtomRegistry.refresh(atom);
  }, [enabled, atom]);

  return { ...retained, refresh };
}
