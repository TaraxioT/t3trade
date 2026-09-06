/**
 * The explicit trading-environment selection shared by the two global trading
 * surfaces — the trade home and the trading workspace (07A).
 *
 * The old derivation (`projects[0]`) answered "which environment does the
 * Trade tab trade on?" with "whatever project sorts first", which is not a
 * choice anyone made and can silently change under the user. This module
 * replaces it with an explicit, session-scoped selection:
 *
 * - Initial selection is the primary environment when the catalog holds it,
 *   else the sole catalog entry, else none — several entries with no valid
 *   primary require an explicit choice before any trading query or control.
 * - A stored selection that disappears from the catalog is "unavailable":
 *   never a silent fallback to another environment.
 * - The store is module-scoped memory, so the selection survives navigation
 *   between the two surfaces for the app session and is never persisted.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useMemo, useSyncExternalStore } from "react";

import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";

let selectedEnvironmentId: EnvironmentId | null = null;
const listeners = new Set<() => void>();

function emitChange(): void {
  for (const listener of listeners) {
    listener();
  }
}

/** Set (or clear) the explicit selection for this app session. */
export function setTradingEnvironmentId(environmentId: EnvironmentId | null): void {
  selectedEnvironmentId = environmentId;
  emitChange();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): EnvironmentId | null {
  return selectedEnvironmentId;
}

/** The explicit selection. `null` means "not chosen yet this session". */
export function useTradingEnvironmentSelection(): EnvironmentId | null {
  return useSyncExternalStore(subscribe, getSnapshot, () => null);
}

export function __resetTradingEnvironmentSelectionForTests(): void {
  selectedEnvironmentId = null;
  emitChange();
}

/**
 * The initial (implicit) selection for a catalog: the primary environment
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

/** What the trading surfaces should render, given catalog + selection. */
export type TradingEnvironmentGate =
  | { readonly state: "no-environments" }
  | { readonly state: "choose" }
  | { readonly state: "unavailable"; readonly environmentId: EnvironmentId }
  | { readonly state: "selected"; readonly environmentId: EnvironmentId };

export function resolveTradingEnvironmentGate(input: {
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
}): TradingEnvironmentGate {
  if (input.environmentIds.length === 0) return { state: "no-environments" };
  if (input.selectedEnvironmentId !== null) {
    // An explicit choice stays authoritative: valid while present, explicitly
    // unavailable when it vanishes — never a silent switch to another entry.
    return input.environmentIds.includes(input.selectedEnvironmentId)
      ? { state: "selected", environmentId: input.selectedEnvironmentId }
      : { state: "unavailable", environmentId: input.selectedEnvironmentId };
  }
  const initial = resolveInitialTradingEnvironmentId(input);
  return initial === null ? { state: "choose" } : { state: "selected", environmentId: initial };
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
  const selected = useTradingEnvironmentSelection();

  const environmentIds = useMemo(
    () => environments.map((environment) => environment.environmentId),
    [environments],
  );
  const gate = useMemo(
    () =>
      resolveTradingEnvironmentGate({
        selectedEnvironmentId: selected,
        primaryEnvironmentId,
        environmentIds,
      }),
    [selected, primaryEnvironmentId, environmentIds],
  );
  const select = useCallback((environmentId: EnvironmentId) => {
    setTradingEnvironmentId(environmentId);
  }, []);

  return { environments, isReady, gate, select } as const;
}
