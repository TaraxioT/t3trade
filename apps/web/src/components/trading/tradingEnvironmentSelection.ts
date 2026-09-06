/**
 * The explicit trading-environment selection shared by the two global trading
 * surfaces — the trade home and the trading workspace (07A, RC05).
 *
 * The old derivation (`projects[0]`) answered "which environment does the
 * Trade tab trade on?" with "whatever project sorts first", which is not a
 * choice anyone made and can silently change under the user. This module
 * replaces it with an explicit, session-scoped destination:
 *
 * - The initial destination is latched ONCE, when the catalog first becomes
 *   ready: the valid primary, else the sole entry, else none — several entries
 *   with no valid primary require an explicit choice before any trading query
 *   or control (RC05). After that, catalog, project, and primary changes never
 *   move the destination; only the user does.
 * - Before the catalog is ready (and before the latch has run) the surfaces
 *   render "Loading trading environments…" and mount no environment-bound
 *   queries or controls; a partial catalog is never used to choose.
 * - A destination that disappears from the catalog is "unavailable": its
 *   identity stays, an explicit choice among the remaining entries is offered,
 *   and there is never a silent fallback to another environment. With no
 *   entries at all the destination is retained internally for recovery rather
 *   than cleared back into automatic selection.
 * - The store is module-scoped memory, so the destination survives navigation
 *   between the two surfaces for the app session and is never persisted.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";

/** The session's routing state: the destination, and whether the one-time initial choice happened. */
export interface TradingEnvironmentSession {
  /** The environment the trading surfaces route to; `null` until chosen. */
  readonly destinationId: EnvironmentId | null;
  /** Whether the automatic initial choice already ran for this session. */
  readonly initialChoiceComplete: boolean;
}

const INITIAL_SESSION: TradingEnvironmentSession = {
  destinationId: null,
  initialChoiceComplete: false,
};

let session: TradingEnvironmentSession = INITIAL_SESSION;
const listeners = new Set<() => void>();

function commitSession(next: TradingEnvironmentSession): void {
  session = next;
  for (const listener of listeners) {
    listener();
  }
}

/** Set (or clear) the destination explicitly — the user's choice is final for the session. */
export function setTradingEnvironmentId(environmentId: EnvironmentId | null): void {
  // An explicit choice is itself a completed initialization: the automatic
  // latch must never overwrite or revisit it.
  commitSession({ destinationId: environmentId, initialChoiceComplete: true });
}

/**
 * The one-time initialization transition (RC05): latch the initial destination
 * from the first ready catalog. Later calls are no-ops — a primary or catalog
 * change after this never selects a different destination automatically, and
 * several entries with no valid primary resolve to "require an explicit
 * choice" exactly once.
 *
 * Returns the session it left in place, for callers and tests that need it.
 */
export function initializeTradingEnvironmentDestination(input: {
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
}): TradingEnvironmentSession {
  if (session.initialChoiceComplete) return session;
  const initial = session.destinationId ?? resolveInitialTradingEnvironmentId(input);
  commitSession({ destinationId: initial, initialChoiceComplete: true });
  return session;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): TradingEnvironmentSession {
  return session;
}

const SERVER_SESSION: TradingEnvironmentSession = INITIAL_SESSION;

/** The session-scoped destination state, as reactive state. */
export function useTradingEnvironmentSession(): TradingEnvironmentSession {
  return useSyncExternalStore(subscribe, getSnapshot, () => SERVER_SESSION);
}

export function __resetTradingEnvironmentSelectionForTests(): void {
  commitSession(INITIAL_SESSION);
}

/**
 * The initial (implicit) destination for a catalog: the primary environment
 * when it is actually present, otherwise the sole entry, otherwise none.
 */
export function resolveInitialTradingEnvironmentId(input: {
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
}): EnvironmentId | null {
  if (
    input.primaryEnvironmentId !== null &&
    input.environmentIds.includes(input.primaryEnvironmentId)
  ) {
    return input.primaryEnvironmentId;
  }
  return input.environmentIds.length === 1 ? input.environmentIds[0]! : null;
}

/** What the trading surfaces should render, given catalog + session (RC05). */
export type TradingEnvironmentGate =
  /** The catalog is not ready, or the one-time latch has not run yet. */
  | { readonly state: "loading" }
  | { readonly state: "no-environments" }
  | { readonly state: "choose" }
  | { readonly state: "unavailable"; readonly environmentId: EnvironmentId }
  | { readonly state: "selected"; readonly environmentId: EnvironmentId };

export function resolveTradingEnvironmentGate(input: {
  readonly destinationId: EnvironmentId | null;
  readonly initialChoiceComplete: boolean;
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
  readonly catalogReady: boolean;
}): TradingEnvironmentGate {
  // A partial or unread catalog never chooses, and the pre-latch window is
  // still "no destination" — both render as loading rather than guessing.
  if (input.destinationId === null && (!input.catalogReady || !input.initialChoiceComplete)) {
    return { state: "loading" };
  }
  // No entries: the destination (if any) stays in session memory for recovery,
  // but there is nothing to route to.
  if (input.environmentIds.length === 0) return { state: "no-environments" };
  if (input.destinationId === null) return { state: "choose" };
  // An explicit choice stays authoritative: valid while present, explicitly
  // unavailable when it vanishes — never a silent switch to another entry.
  return input.environmentIds.includes(input.destinationId)
    ? { state: "selected", environmentId: input.destinationId }
    : { state: "unavailable", environmentId: input.destinationId };
}

/**
 * The two global trading surfaces' environment routing. The environment-scoped
 * subtree under it must be keyed by the resolved environment id so local
 * market/draft state resets on switch and late responses from the previous
 * environment cannot land in the new one.
 */
export function useTradingEnvironmentRouting() {
  const { environments, isReady } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const session = useTradingEnvironmentSession();

  const environmentIds = useMemo(
    () => environments.map((environment) => environment.environmentId),
    [environments],
  );

  // RC05: the automatic initial choice is an explicit effect-run transition,
  // never a render side effect. It runs when the catalog first becomes ready
  // and never again — the store ignores later calls by construction.
  useEffect(() => {
    if (!isReady || session.initialChoiceComplete) return;
    initializeTradingEnvironmentDestination({ primaryEnvironmentId, environmentIds });
  }, [isReady, session.initialChoiceComplete, primaryEnvironmentId, environmentIds]);

  const gate = useMemo(
    () =>
      resolveTradingEnvironmentGate({
        destinationId: session.destinationId,
        initialChoiceComplete: session.initialChoiceComplete,
        environmentIds,
        catalogReady: isReady,
      }),
    [session, environmentIds, isReady],
  );
  const select = useCallback((environmentId: EnvironmentId) => {
    setTradingEnvironmentId(environmentId);
  }, []);

  return { environments, isReady, gate, select } as const;
}
