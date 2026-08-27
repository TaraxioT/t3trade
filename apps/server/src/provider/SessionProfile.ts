import type { ThreadId } from "@t3tools/contracts";

/**
 * The kind of provider session a thread is running.
 *
 * `"trading"` is a mission thread: the full trading toolkit, bound to the
 * mission that owns the thread. `"trading_analyst"` is an on-demand analyst
 * (final-form Phase 8): reads and notify-alerts only, no mission and no
 * execution tools.
 */
export type SessionProfileKind = "trading" | "trading_analyst";

export interface SessionProfile {
  readonly threadId: ThreadId;
  readonly kind: SessionProfileKind;
}

const profilesByThread = new Map<ThreadId, SessionProfile>();

export function setSessionProfile(profile: SessionProfile): void {
  profilesByThread.set(profile.threadId, profile);
}

export function readSessionProfile(threadId: ThreadId): SessionProfile | undefined {
  return profilesByThread.get(threadId);
}

export function isTradingThread(threadId: ThreadId): boolean {
  return profilesByThread.get(threadId)?.kind === "trading";
}

export function isTradingAnalystThread(threadId: ThreadId): boolean {
  return profilesByThread.get(threadId)?.kind === "trading_analyst";
}

/**
 * Either trading kind: the seams that are the same for a mission and an
 * analyst — the trading-only MCP endpoint, the dropped cwd, the tool lock's
 * existence (its contents differ per kind).
 */
export function hasTradingProfile(threadId: ThreadId): boolean {
  return profilesByThread.get(threadId) !== undefined;
}

export function clearSessionProfile(threadId: ThreadId): void {
  profilesByThread.delete(threadId);
}

export function clearAllSessionProfiles(): void {
  profilesByThread.clear();
}
