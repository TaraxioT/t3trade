/**
 * The TRADE.md plan document — the persistent, human-readable trading context.
 *
 * TRADE.md is to a trading workspace what AGENTS.md is to a coding one: a
 * document the agent reads with its native tools and interprets itself. It is
 * NOT a second order API. Nothing in it is ever parsed into an exchange call;
 * the agent acts through the typed trading tools, and the server's role is
 * only to read the file, pin an activated revision for stable background
 * execution, and refuse NEW exposure when the live file has drifted away from
 * that revision unacknowledged.
 *
 * Permissive Markdown on purpose: no YAML frontmatter, no custom parser, no
 * required thesis grammar. Paths the document names are agent instructions,
 * never server-executable hooks.
 *
 * @module TradingPlanDocument
 */
import { Schema } from "effect";

/** The one file name a workspace's trading plan document may have. */
export const TRADE_MD_FILENAME = "TRADE.md";

/** The largest TRADE.md the server will read (64 KiB). */
export const TRADE_MD_MAX_BYTES = 65_536;

/**
 * The skeleton the agent (not the server — the server never writes the
 * workspace file) starts a TRADE.md from. Four sections, so a stranger can
 * tell mandate from playbook from guardrails from history.
 */
export const TRADE_MD_TEMPLATE = `# TRADE.md

## Mandate

<!-- What this workspace trades for, in plain words: objectives, horizon,
     risk appetite, anything the user said about how they want this run. -->

## Strategies

<!-- The named playbooks in play and the conditions each is waiting for.
     Workspace-relative paths to scripts or data are instructions to the
     agent, not anything the server executes. -->

## Global Controls

<!-- Ceilings and standing rules that override any single setup: max size,
     max leverage, loss budgets, forbidden markets or times. -->

## Change Log

<!-- One line per deliberate change: date, what changed, why. The server
     pins each activated revision by content hash; this section is the
     human-readable half of that audit trail. -->
`;

/**
 * Where a workspace's TRADE.md stands against its activated revision.
 *
 * - `none` — no activated revision exists.
 * - `draft` — the file exists but was never activated.
 * - `active` — the file's hash matches the activated revision.
 * - `drifted` — the file changed after activation; NEW exposure pauses until
 *   the change is re-activated (or the revision is confirmed stale and
 *   re-synced). Exposure-reducing actions are never blocked by drift.
 */
export const TradingPlanActivationState = Schema.Literals(["none", "draft", "active", "drifted"]);
export type TradingPlanActivationState = typeof TradingPlanActivationState.Type;

/**
 * The typed facts a client needs to display a workspace's plan document:
 * where it lives, what revision is current, and where it stands. The content
 * itself is workspace state, not a wire contract — the server injects it into
 * turns as a bounded block, and background execution reads the persisted
 * snapshot server-side.
 */
export const TradingPlanDocumentFacts = Schema.Struct({
  /** Absolute, containment-checked path of the document inside the workspace. */
  path: Schema.String,
  /** SHA-256 of the current file content, hex. */
  contentHash: Schema.String,
  /** SHA-256 of the activated revision, hex, when one exists. */
  activatedHash: Schema.NullOr(Schema.String),
  activation: TradingPlanActivationState,
});
export type TradingPlanDocumentFacts = typeof TradingPlanDocumentFacts.Type;

/**
 * Drift policy, mirroring §16.4's exhaustion predicate on purpose: taking on
 * risk is what drift pauses; managing the risk already open is exactly what a
 * workspace with a stale plan document still has to be able to do. Pause,
 * emergency close and revoke never pass through an action type at all and are
 * structurally outside this gate.
 */
const DRIFT_PERMITTED_ACTIONS: ReadonlySet<string> = new Set([
  "cancel",
  "reduce",
  "close",
  // Tightening or repairing protection is managing open risk, not new risk.
  "modify_stop",
  "move_stop",
]);

/** True when `actionType` is permitted while the plan document has drifted. */
export function isPermittedUnderPlanDrift(actionType: string): boolean {
  return DRIFT_PERMITTED_ACTIONS.has(actionType);
}

/**
 * The plan-document tool's name. The agent maintains TRADE.md with its native
 * file tools; this tool is only the server's half of the contract — read the
 * activation facts, pin a revision, or stand one down.
 */
export const TRADING_PLAN_DOCUMENT_TOOL = "trading_plan_document";

/**
 * Why a plan-document tool call refused. One name per rule, so a provider can
 * branch on the answer without parsing prose.
 */
export const TradingPlanDocumentRejection = Schema.Literals([
  /** The thread has no persisted workspace root, so there is nowhere to look. */
  "no_workspace",
  /** The named rule of the document service refused; `detail` says which. */
  "document_refused",
  /** No activated revision exists to deactivate. */
  "not_activated",
  /** This session kind may read plan-document facts but not manage them. */
  "session_read_only",
]);
export type TradingPlanDocumentRejection = typeof TradingPlanDocumentRejection.Type;

/**
 * One call, three actions. Kept a flat struct — not a union — because the
 * toolkit's JSON-Schema contract is a top-level object a provider can fill in.
 *
 * `activate` without `expectedContentHash` is refused by the handler as a
 * value-level rejection that says what to read next, never guessed: the hash
 * is the optimistic-concurrency token, and an activation without it would pin
 * whatever happens to be on disk.
 */
export const TradingPlanDocumentInput = Schema.Struct({
  action: Schema.Literals(["show", "activate", "deactivate"]),
  /**
   * The content hash the caller read the document at, required by
   * `activate`. A file that changed since refuses with `stale_hash` and
   * nothing is written. Read the document, take its hash (the turn-context
   * block or `show` carries it), then activate.
   */
  expectedContentHash: Schema.optional(Schema.String),
  /** Optional mission linkage recorded against the activated revision. */
  missionId: Schema.optional(Schema.String),
  /**
   * One line for the revision audit trail — what changed and why. The
   * document's own Change Log is the human half; this is the row's half.
   */
  changeNote: Schema.optional(Schema.String),
  /** Why the revision is being stood down, for `deactivate`'s audit row. */
  note: Schema.optional(Schema.String),
});
export type TradingPlanDocumentInput = typeof TradingPlanDocumentInput.Type;

/** The activation facts every result branch carries, content excepted. */
export const TradingPlanDocumentFactsPublic = Schema.Struct({
  /** The document's activation state at the moment of the call. */
  activation: TradingPlanActivationState,
  /** The current file's hash, when a file exists. */
  contentHash: Schema.NullOr(Schema.String),
  /** The activated revision's hash, when one exists. */
  activatedHash: Schema.NullOr(Schema.String),
  /** When the activated revision was pinned, ISO, when one exists. */
  activatedAt: Schema.NullOr(Schema.String),
  /** The mission the revision is linked to, when it is. */
  missionId: Schema.NullOr(Schema.String),
});
export type TradingPlanDocumentFactsPublic = typeof TradingPlanDocumentFactsPublic.Type;

/** What the plan-document tool answers. */
export const TradingPlanDocumentResult = Schema.Union([
  Schema.Struct({
    outcome: Schema.Literal("shown"),
    facts: TradingPlanDocumentFactsPublic,
    /** Revisions ever activated for this workspace, newest first count. */
    revisionCount: Schema.Number,
  }),
  Schema.Struct({
    outcome: Schema.Literal("activated"),
    facts: TradingPlanDocumentFactsPublic,
    /** How many revisions this workspace has now activated, this one included. */
    revisionCount: Schema.Number,
  }),
  Schema.Struct({
    outcome: Schema.Literal("deactivated"),
    facts: TradingPlanDocumentFactsPublic,
    revisionCount: Schema.Number,
  }),
  Schema.Struct({
    outcome: Schema.Literal("rejected"),
    reason: TradingPlanDocumentRejection,
    detail: Schema.String,
  }),
]);
export type TradingPlanDocumentResult = typeof TradingPlanDocumentResult.Type;

/**
 * Pure classification of a document against its activated revision.
 *
 * `filePresent: false` is `none` regardless of the activated hash: the file is
 * the document, and an activated revision whose file has vanished is an
 * absence the injection treats as "inject nothing" while the persisted
 * snapshot keeps the audit trail.
 */
export function classifyPlanDocument(input: {
  readonly filePresent: boolean;
  readonly currentHash: string | null;
  readonly activatedHash: string | null;
}): TradingPlanActivationState {
  if (!input.filePresent) return "none";
  if (input.activatedHash === null) return "draft";
  return input.currentHash === input.activatedHash ? "active" : "drifted";
}
