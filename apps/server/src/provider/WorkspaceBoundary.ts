/**
 * The repository-mutation boundary, shared by every provider adapter.
 *
 * Chat is the front door for trading, so an ordinary thread reaches the
 * trading tools, the provider's own web search, and a coding agent's
 * filesystem at the repository cwd all at once. Before this module the only
 * thing standing between a market conversation and `git commit` in this
 * repository was prompt prose, and only on some providers. A market session
 * that edits its own product while researching it is not a hypothetical
 * failure; it is the default state of every non-Claude adapter.
 *
 * The capability model is explicit and narrow:
 *
 * - `market_research` is the default and the fence. Asking about prices,
 *   sourced dates, charts, watchlists, alerts, hypotheses, backtests,
 *   forward validation, strategies, missions, or orders never widens it, and
 *   the model's own plan never infers coding permission from it.
 * - `coding` is a separate capability granted only by an explicit user
 *   action (the composer's Coding task control, or an explicitly started
 *   coding task's thread), shown to the user as the thread's state, and
 *   never silently granted to a thread that started fenced.
 * - Trading profiles (mission, analyst, observe) are fenced no matter what
 *   the thread's workspace mode says, because a mission wake must never
 *   depend on a mode flag someone forgot to set.
 *
 * The boundary is decided here and enforced by each adapter at the seams its
 * runtime actually offers: a tool allowlist (Claude), feature flags plus a
 * sandboxed scratch cwd (Codex), a scratch cwd plus rejected write
 * permissions (the ACP adapters), and a permission ruleset (OpenCode). One
 * rule binds them all: a provider that cannot express the fence refuses the
 * session with a capability error instead of falling back to a writable
 * coding session. Failing closed is the whole point of the fence.
 *
 * @module WorkspaceBoundary
 */
import type { ThreadId, WorkspaceMode } from "@t3tools/contracts";

import { hasTradingProfile } from "./SessionProfile.ts";

/** What a session may do to the repository it is attached to. */
export type WorkspaceWriteBoundary =
  | {
      readonly kind: "fenced";
      /**
       * For logs and refusals: why the fence is up. A trading session is
       * fenced by its profile; a market_research thread by its mode.
       */
      readonly reason: "trading session" | "market_research workspace";
    }
  | {
      /** A user-authorized coding task: the full coding surface. */
      readonly kind: "repo";
    };

/**
 * The one question every adapter asks at session start. Pure, and reads only
 * the in-process profile registry plus the turn's declared mode, so it can be
 * unit-tested without a server.
 */
export function workspaceWriteBoundary(input: {
  readonly threadId: ThreadId;
  readonly workspaceMode: WorkspaceMode | undefined;
}): WorkspaceWriteBoundary {
  if (hasTradingProfile(input.threadId)) {
    return { kind: "fenced", reason: "trading session" };
  }
  if ((input.workspaceMode ?? "market_research") !== "coding") {
    return { kind: "fenced", reason: "market_research workspace" };
  }
  return { kind: "repo" };
}

/**
 * ACP tool kinds a fenced session refuses outright. Everything on this list
 * changes the filesystem or runs a process. `edit` is special: an edit whose
 * every location sits inside the research scratch directory is the bounded
 * data-collection surface a fenced session is allowed to keep, so
 * {@link fencedAcpPermissionDecision} may allow it; `delete`, `move` and
 * `execute` have no scratch-scoped reading worth trusting. `switch_mode` and
 * `other` are deliberately absent: they are not write kinds, and an
 * unanticipated request belongs to the user, not to a blanket deny.
 */
const FENCED_ACP_TOOL_KINDS = new Set(["edit", "delete", "move", "execute"]);

/** One location an ACP permission request names, whatever else it carries. */
export interface AcpLocationLike {
  readonly path?: string | null | undefined;
}

export function isFencedAcpToolKind(kind: string | null | undefined): boolean {
  return kind !== null && kind !== undefined && FENCED_ACP_TOOL_KINDS.has(kind.trim());
}

/** Whether every location a request names sits inside the scratch directory. */
export function allLocationsWithinScratch(
  locations: ReadonlyArray<AcpLocationLike> | undefined,
  scratchDir: string,
): boolean {
  if (locations === undefined || locations.length === 0) return false;
  const prefix = scratchDir.endsWith("/") ? scratchDir : `${scratchDir}/`;
  return locations.every(
    (location) =>
      typeof location.path === "string" &&
      (location.path === scratchDir || location.path.startsWith(prefix)),
  );
}

/**
 * The answer a fenced session gives an ACP permission request.
 *
 * - `reject`: write-class request outside the scratch directory (or with no
 *   reject option offered, the denial is still the answer — the fence does
 *   not soften because the agent forgot to offer a no).
 * - `allow`: an edit whose every location is inside the scratch directory.
 * - `ask`: everything else, surfaced to the user exactly as an unfenced
 *   session would.
 *
 * Pure over the request's facts so the decision is testable without an agent.
 */
export function fencedAcpPermissionDecision(input: {
  readonly kind: string | null | undefined;
  readonly locations: ReadonlyArray<AcpLocationLike> | undefined;
  readonly scratchDir: string;
}): "reject" | "allow" | "ask" {
  const kind = input.kind;
  if (kind === null || kind === undefined || !FENCED_ACP_TOOL_KINDS.has(kind.trim())) {
    return "ask";
  }
  if (kind.trim() === "edit" && allLocationsWithinScratch(input.locations, input.scratchDir)) {
    return "allow";
  }
  return "reject";
}

/**
 * The reject option an ACP agent offered, preferring the durable one: a
 * fenced session never becomes a session where that tool is welcome, so
 * rejecting once would only buy the same question back next turn. Undefined
 * when the agent offered no reject option at all, which the caller must
 * treat as a denial, not as permission.
 */
export function selectFencedRejectOption(
  options: ReadonlyArray<{
    readonly optionId?: string | null | undefined;
    readonly kind?: string | null | undefined;
  }>,
): string | undefined {
  for (const kind of ["reject_always", "reject_once"]) {
    const option = options.find(
      (candidate) =>
        candidate.kind === kind &&
        typeof candidate.optionId === "string" &&
        candidate.optionId.trim().length > 0,
    );
    if (option !== undefined) return (option.optionId as string).trim();
  }
  return undefined;
}
