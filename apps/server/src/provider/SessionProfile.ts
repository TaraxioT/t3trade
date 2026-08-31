import type { ThreadId } from "@t3tools/contracts";

/**
 * The kind of provider session a thread is running.
 *
 * `"trading"` is a mission thread: the full trading toolkit, bound to the
 * mission that owns the thread. `"trading_analyst"` is an on-demand analyst
 * (final-form Phase 8): reads and notify-alerts only, no mission and no
 * execution tools. `"trading_observe"` is a mission that holds no authority
 * and exists to narrate a hypothesis being validated - it has a mission, it is
 * woken, and it has no execution tool at all.
 */
export type SessionProfileKind = "trading" | "trading_analyst" | "trading_observe";

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

/** A thread that holds a mission, whatever that mission is for. */
export function isTradingMissionThread(threadId: ThreadId): boolean {
  const kind = profilesByThread.get(threadId)?.kind;
  return kind === "trading" || kind === "trading_observe";
}

export function isTradingAnalystThread(threadId: ThreadId): boolean {
  return profilesByThread.get(threadId)?.kind === "trading_analyst";
}

/**
 * An observe mission's thread: woken like a trading thread, toolled like less
 * than an analyst.
 *
 * The registry is in memory and per process, so this answers `false` for a
 * thread this process has not woken yet. That is why it is a courtesy and not
 * the fence: the handlers read the mission's own stored `purpose`, which
 * survives a restart, and refuse on that.
 */
export function isTradingObserveThread(threadId: ThreadId): boolean {
  return profilesByThread.get(threadId)?.kind === "trading_observe";
}

/**
 * Either trading kind. Mission metadata only: it decides which turn contract
 * a thread carries and which server-side mission checks apply, never the
 * session's native capabilities, cwd, or tools.
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
