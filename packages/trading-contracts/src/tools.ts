/**
 * Mission and strategy tool contracts - spec §14.3.
 *
 * Tools accept intent-level inputs. Publishing is a versioned, side-effecting
 * operation: `trading_plan` requires an expected current
 * version, and a stale expected-version publish is rejected rather than
 * silently overwriting current state.
 *
 * §14.3 publishes `TradingPublishPlanInput` and
 * `TradingPublishPlanResult` in full; both are mirrored here
 * field-for-field.
 *
 * Scope note: §14.1/§14.2/§14.4-§14.7 name their tools but publish no input or
 * output schemas, and execution is out of scope for this phase. Only the two
 * §14.3 mission tools are modeled here.
 *
 * @module TradingTools
 */
import { Schema } from "effect";
import { TargetCalibration } from "./calibration.ts";
import { TradingJournalEntry } from "./journal.ts";
import { TradingMissionModeState } from "./mode.ts";
import { TradingMission } from "./mission.ts";
import { TradingId, UnixMillis } from "./primitives.ts";
import { StopAdjustmentRefusalCode } from "./stopAdjustment.ts";
import { TradingOrderTimeInForce } from "./execution.ts";
import { EntrySizeConstraint } from "./entry.ts";
import { TradingExitRefusalCode } from "./exit.ts";
import { FailureRecovery } from "./recovery.ts";
import { tradingPlanAuthoredFields, TradingPlanState } from "./strategy.ts";
import {
  PersistedWatch,
  TradingWatchDeliver,
  TradingWatchRow,
  WatchCondition,
  WatchRefusalCode,
} from "./watch.ts";
import { TradingPlaybookName } from "./playbook.ts";

// Renamed from `trading_plan` — plan 29 step 6.5. The behaviour is
// unchanged: the same eight authored fields, the same mission-version guard,
// the same publish aftermath. What went is the verb the model had to spell out
// to reach the plan at all.
export const TRADING_PLAN_TOOL = "trading_plan";

// The twelve read-tool names that used to live here retired into
// `TRADING_LOOK_TOOL` (./observation.ts) — plan 29 step 6.1.

// `trading_get_target_calibration` retired off the hot path — plan 29 step
// 6.5. The grading is a read of the mission's own closed trades, so it rides
// `trading_look` as `mission.targetCalibration` instead of costing a turn a
// tool call to ask a question the one read was already answering.
export const TRADING_STRATEGY_TOOL = "trading_strategy";
// `trading_adjust_stop` retired into `trading_exit`'s `move_stop` action —
// plan 29 step 6.5. The policy it answered to did not move; only the name did.

// `trading_execute` and its `trading_request_entry` alias retired into
// `TRADING_ENTER_TOOL` (./entry.ts) — plan 29 step 6.2. Both existed to spend
// a quote the harness had just been handed; with the quote gone, entering is
// one call and its name is what it does.

// -- shared tool rejection ---------------------------------------------------

/**
 * Why a trading tool refused to act at all.
 *
 * These are distinct from `trading_plan`'s in-band
 * `outcome: "rejected"`, which reports a *published* result the harness can
 * retry against. A `TradingToolRejectedError` means the call never reached the
 * mission: the credential did not carry the capability, the calling thread is
 * not the thread an active mission is bound to (§10.2), or the market read the
 * answer is made of could not be taken.
 *
 * Fork-owned: the spec names the tools and their payloads but does not publish
 * a tool-level failure type.
 */
export const TradingToolRejectionReason = Schema.Literals([
  "capability_not_granted",
  /**
   * No authority, and none could be taken: the call named no market, or the
   * session is one that may never hold a mission (an analyst).
   *
   * Since chat became the front door this is no longer the ordinary state of a
   * thread that has not traded yet — a plan or an entry naming a free market
   * takes authority on the spot. What is left here is the case where there is
   * nothing to take authority on.
   */
  "thread_not_bound_to_mission",
  "mission_not_bound_to_thread",
  "mission_not_found",
  /**
   * The market is already held by another authority — another chat's mission,
   * or the user's own hand on the exchange. The `detail` names the holder and
   * the ways out, because the model has to relay both to the user.
   */
  "market_held_by_other_authority",
  /** A required exchange read failed. The tool has nothing to answer with, and
      saying so is better than the opaque crash a defect produces. */
  "market_data_unavailable",
  /** A `fetch` key that is not in the catalog — the detail names the nearest
      valid key (plan 38 §2.3 rule 4). */
  "unknown_fetch_key",
  /** A `fetch` key whose parameters are out of range — the detail names the
      bound, so the caller can re-ask inside it (plan 38 §2.3 rule 5). */
  "fetch_key_params_invalid",
  /** A `trading_backtest` thesis the engine cannot run as written. The detail
      is `validateThesis`'s own sentence, which names the field and the fix. */
  "thesis_invalid",
  /** A thesis interval the market archive does not record. */
  "interval_not_archived",
  /** More bars than one run walks. The detail names a coarser interval. */
  "window_too_large",
  /** The archive holds nothing for that market, interval and window. */
  "no_archived_bars",
  /** A `vary` clause naming a parameter no sweep can move, too many values,
      or more total bar walks than the sweep budget. The detail names which. */
  "sweep_invalid",
  /** A forward validation call that changed nothing. The detail is the
      service's own sentence: the interval that gets no bars, the duration
      that is out of range, the market already being validated, or the
      lifecycle move that does not apply from where the validation is. */
  "validation_refused",
  /** A `trading_hypothesis` call that changed nothing: an id that names no
      idea, a missing title, note or verdict, or a thesis that is not the
      version it was filed against. The detail is the service's own sentence. */
  "hypothesis_refused",
  /** An execution call from an observe mission - a mission that exists to
      watch a hypothesis being validated and holds authority on nothing. The
      detail names the market it is watching. */
  "mission_cannot_trade",
]);
export type TradingToolRejectionReason = typeof TradingToolRejectionReason.Type;

/**
 * What each rejection says to the person reading it.
 *
 * One sentence pattern, every time: what was refused, why, and what to do
 * next. The reason code alone is a label — it told a model that something
 * named `thread_not_bound_to_mission` had happened and left it to guess
 * whether that was its fault, the user's, or the server's, and the guess cost
 * the same turn twice. The machine-readable half still rides the end of the
 * message, so telemetry and the tests can key off the code.
 */
const REJECTION_PROSE: Record<TradingToolRejectionReason, string> = {
  capability_not_granted:
    "Refused: this session cannot reach the trading tools. Its credential was issued without the trading capability. Start a new turn on this thread, and tell the user the server needs a restart if it happens again.",
  thread_not_bound_to_mission:
    "Refused: this chat holds no trading authority, and the call named no market to take authority on. Name the market on the call, or start the market you want from the trade home.",
  mission_not_bound_to_thread:
    "Refused: this chat cannot act on the mission it named. Authority is held by the chat a mission is bound to, and that is not this one. Omit missionId to act on this chat's own authority, or move to the chat that holds that mission.",
  mission_not_found:
    "Refused: the mission this chat held is no longer active, so nothing was changed. Take a fresh look, and place a new plan or entry if you still want the market.",
  market_held_by_other_authority:
    "Refused: another authority already holds this market, so nothing was placed.",
  market_data_unavailable:
    "Refused: the market read this answer is built from could not be taken, so nothing was placed. Try the same call again in a moment, and say which read failed if it keeps failing.",
  unknown_fetch_key:
    "Refused: that fetch key is not in the catalog, so nothing was read. Ask again with a key the catalog lists.",
  fetch_key_params_invalid:
    "Refused: that fetch key's parameters are out of range, so nothing was read. Ask again inside the bound named below.",
  thesis_invalid:
    "Refused: that thesis cannot be run as written, so nothing was tested. The line below names the field and what it needs; fix that one thing and ask again.",
  interval_not_archived:
    "Refused: that bar interval is not recorded, so there is nothing to test on. Ask again on one of the intervals named below.",
  window_too_large:
    "Refused: that window is more bars than one run walks, so nothing was tested. Ask again on the coarser interval named below, or over a shorter window.",
  no_archived_bars:
    "Refused: the archive holds no bars for that market and window, so there is nothing to test. Tell the user how far back recording actually reaches.",
  sweep_invalid:
    "Refused: that sweep was not run, so no window was read. The line below says whether the parameter, the value count or the total work was the problem; the thesis itself is untouched and still testable on its own.",
  validation_refused:
    "Refused: that forward validation was not changed, and nothing is running that was not already. The line below says what stopped it; no paper trade was taken and no order was ever in question.",
  hypothesis_refused:
    "Refused: nothing was written to the idea record. The line below says what stopped it; the hypothesis, its versions and everything filed against them are exactly as they were.",
  mission_cannot_trade:
    "Refused: this mission is watching, not trading, so nothing was planned, placed or closed. Say what you see and tell the user that trading the idea needs a mission that holds the market.",
};

export class TradingToolRejectedError extends Schema.TaggedErrorClass<TradingToolRejectedError>()(
  "TradingToolRejectedError",
  {
    reason: TradingToolRejectionReason,
    /** The thread whose MCP credential made the call. */
    threadId: Schema.String,
    /** The mission the call named, when it named one. */
    missionId: Schema.optional(Schema.String),
    /**
     * What to do about it, when the reason alone does not say — the fetch-key
     * refusals name the key and the nearest valid key or the bound (plan 38
     * §2.3 rules 4–5), because a refusal the model cannot act on costs the
     * same turn twice.
     */
    detail: Schema.optional(Schema.String),
  },
) {
  /**
   * The MCP tool boundary passes a *declared* failure's message through
   * verbatim and collapses anything else to a generic internal-error string, so
   * this message is what makes the rejection legible to the harness. Keep the
   * tag and every field in it.
   */
  override get message(): string {
    const mission = this.missionId === undefined ? "" : `, mission=${this.missionId}`;
    const detail = this.detail === undefined ? "" : ` ${this.detail}`;
    return `${REJECTION_PROSE[this.reason]}${detail} [reason=${this.reason}, thread=${this.threadId}${mission}]`;
  }
}

// -- trading_look -----------------------------------------------------

export const TradingGetMissionInput = Schema.Struct({
  /**
   * Optional since the calling thread is bound to exactly one mission; omit it
   * and the call acts on the bound mission. A wrong `missionId` is still
   * rejected with `mission_not_bound_to_thread`.
   */
  missionId: Schema.optional(TradingId),
});
export type TradingGetMissionInput = typeof TradingGetMissionInput.Type;

/**
 * An execution this mission has written but the exchange has not yet answered.
 *
 * While one of these exists, preview item 16 refuses every new intent. The
 * harness could previously see only the refusal, never the thing causing it,
 * so the same summary is published here too.
 */
export const TradingPendingExecution = Schema.Struct({
  cloid: Schema.String,
  actionType: Schema.String,
  status: Schema.String,
  /** How long it has sat in a non-terminal status, in milliseconds. */
  ageMillis: Schema.Number,
});
export type TradingPendingExecution = typeof TradingPendingExecution.Type;

/**
 * One plan version the mission published, as its own history reads it.
 *
 * `trading_look` returns the CURRENT plan, so a mission that has
 * republished four times can see only its latest thesis — and "did the last
 * three targets work?" was a question with no way to ask it. This is the
 * skeleton of each: what it intended, what it targeted, and why.
 */
export const PublishedStrategySummary = Schema.Struct({
  version: Schema.Number,
  publishedAt: UnixMillis,
  /** The plan's intent that version — `long`, `short`, or `stand_aside`. */
  intent: Schema.String,
  /** The conservative target rung that version named, when it named one. */
  targetProfitUsd: Schema.optional(Schema.Number),
  /** The narrative that version was published on. */
  because: Schema.optional(Schema.String),
});
export type PublishedStrategySummary = typeof PublishedStrategySummary.Type;

/** Current mission, authority, strategy, watches, and control flags. */
export const TradingBoundMissionResult = Schema.Struct({
  /** Discriminates this from the unbound-thread answer below. */
  bound: Schema.Literal(true),
  /**
   * The mission row, which is where `authority`, `harness`, `control` and
   * `authorityVersion` are read from.
   *
   * They used to sit here as siblings as well, and `TradingMission` carries
   * all four — so every look shipped the authority twice, 718 characters of a
   * payload that rides every turn (plan 35 phase 2). One copy, on the row that
   * owns them.
   */
  mission: TradingMission,
  /**
   * Which mode this mission runs in — plan 29 phase 9. Derived from the
   * mandate on every read rather than stored, so it cannot disagree with the
   * words in `mission.instruction` sitting beside it. `discretionary` unless
   * the mandate names a playbook to execute, and in execute mode it carries
   * the doctrine that says what executing means.
   */
  mode: TradingMissionModeState,
  strategy: Schema.optional(TradingPlanState),
  /**
   * The mission row's optimistic-lock version (plan 29 step 4.2). Publishing
   * a plan refuses a stale `expectedMissionVersion`, and this is the number
   * the harness compares against — the mission no longer carries a
   * strategy-version counter of its own.
   */
  missionVersion: Schema.Number,
  /**
   * The armed set, as rows — see {@link TradingWatchRow}. The persisted
   * encoding and the mission id each row used to repeat are not here
   * (plan 33 fix B).
   *
   * What has already settled comes with the `retrospect` scope. A watch that
   * fired arrived as its own wake's `triggeringWatch`, and no turn of the
   * mission this was measured on ever referred back to a retired one — while
   * on the last read of that mission they were 46% of the registry, on the hot
   * path, every turn (plan 35 phase 2).
   */
  watches: Schema.optional(Schema.Array(TradingWatchRow)),
  /** Executions written but not yet answered — what a lock rejection means. */
  pendingExecutions: Schema.Array(TradingPendingExecution),
  /**
   * Every plan this mission has published, newest first.
   *
   * `strategy` above is only the current one. Without the rest, a harness that
   * has republished three times cannot see what it previously believed, what it
   * targeted, or on what basis — which makes "was the last target the right
   * rung?" unanswerable from inside the loop.
   *
   * Optional since scoped looks: ABSENT means this call did not read it, and
   * an EMPTY ARRAY means the mission has published nothing. Collapsing the two
   * would tell a scoped read that its own history is empty.
   */
  strategyHistory: Schema.optional(Schema.Array(PublishedStrategySummary)),
  /**
   * Those targets, graded against what the mission's trades actually reached —
   * plan 29 step 6.5, where `trading_get_target_calibration` came off the hot
   * path.
   *
   * Here rather than in a tool of its own because it answers a question the
   * one read was already half-answering: `strategyHistory` says what was
   * targeted, and this says whether any of it was reachable. Absent until the
   * mission has a closed trade to grade, so a mission that has not traded
   * carries nothing extra.
   */
  targetCalibration: Schema.optional(TargetCalibration),
  /**
   * The mission's most recent journal notes, newest first, capped at
   * `TRADING_JOURNAL_TURN_READ_LIMIT`.
   *
   * Here for the reason the journal exists (plan 29 step 6.4): it is what the
   * model told itself across plan revisions, and a memory that has to be asked
   * for is a memory a turn will run without. `trading_journal` with no note
   * reads the longer tail.
   *
   * Optional on the same terms as `strategyHistory`: absent means unread, and
   * empty means the mission has written nothing down.
   */
  journal: Schema.optional(Schema.Array(TradingJournalEntry)),
});
export type TradingBoundMissionResult = typeof TradingBoundMissionResult.Type;

/**
 * What `trading_look` answers on a thread no live mission owns.
 *
 * A mission that ends — revoked, completed — stops matching the binding query,
 * and every tool on the thread then failed with `thread_not_bound_to_mission`,
 * including the reads that would have explained why. The agent could not learn
 * that its own mission had finished. This says so, names the terminal status it
 * finished in, and points at the mission that took the slot if one did.
 */
export const TradingUnboundMissionResult = Schema.Struct({
  bound: Schema.Literal(false),
  /** The last mission this thread was bound to, when there was one. */
  lastMission: Schema.optional(TradingMission),
  /** The mission that holds the active slot now, when a newer one does. */
  activeMissionId: Schema.optional(TradingId),
});
export type TradingUnboundMissionResult = typeof TradingUnboundMissionResult.Type;

export const TradingGetMissionResult = Schema.Union([
  TradingBoundMissionResult,
  TradingUnboundMissionResult,
]);
export type TradingGetMissionResult = typeof TradingGetMissionResult.Type;

// -- trading_plan ----------------------------------------------------

/**
 * The plan body the harness publishes — the eight authored fields of the
 * position-centric document (plan 29 step 4.1): `market`, `intent`, `entry`,
 * `stop`, `target`, `invalidation`, `reassess`, `because`.
 *
 * `updatedAt` is assigned by the server on acceptance, so the harness does not
 * supply it. The accepted plan's identity in `trading_plan_history` is the
 * row itself; the document carries no version number.
 */
export const PublishTradingPlanBody = Schema.Struct(tradingPlanAuthoredFields);
export type PublishTradingPlanBody = typeof PublishTradingPlanBody.Type;

export const TradingPublishPlanInput = Schema.Struct({
  /** Optional — omit to act on the mission this session is bound to. */
  missionId: Schema.optional(TradingId),
  /**
   * The mission row's optimistic-lock version as the harness last read it
   * (`trading_look` returns it as `missionVersion`). A publish against
   * a mission that has moved on is refused — plan 29 step 4.2 re-keyed this
   * guard from the retired strategy-version counter onto the mission row's
   * own version, keeping the strength without the version semantics.
   */
  expectedMissionVersion: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  strategy: PublishTradingPlanBody,
});
export type TradingPublishPlanInput = typeof TradingPublishPlanInput.Type;

export const PublishTradingPlanRejection = Schema.Literals([
  "stale_mission_state",
  "mission_not_active",
  /**
   * The target cannot pay the round trip of the execution the plan named —
   * see `MINIMUM_TARGET_COST_MULTIPLE` in `./costs.ts`. Nothing was written;
   * `detail` names the number to raise and what to raise it to.
   */
  "target_below_cost_floor",
]);
export type PublishTradingPlanRejection = typeof PublishTradingPlanRejection.Type;

export const TradingPublishPlanResult = Schema.Union([
  Schema.Struct({
    outcome: Schema.Literal("accepted"),
    strategy: TradingPlanState,
    /**
     * The plan-history version this publish wrote — the id of the prediction
     * it published. Watches armed from its projection carry it, and the next
     * revision supersedes everything armed below it.
     */
    version: Schema.Number,
    /**
     * Things wrong with the published strategy that did not stop the publish —
     * today, prose the server clipped to its published bound.
     *
     * In-band rather than a rejection: the plan is usable, and the harness is
     * told what changed.
     */
    warnings: Schema.Array(Schema.String),
    /**
     * What the publish actually recorded about the prediction, in one sentence.
     *
     * `projection` is optional on the input, and an accepted publish that
     * carried none used to look exactly like one that carried a projection:
     * same `accepted`, same version, no warning either way. A live run had no
     * way to tell whether its horizon and invalidation wakes had armed, so it
     * assumed they had. This says which happened, every time.
     */
    projectionNote: Schema.String,
  }),
  Schema.Struct({
    outcome: Schema.Literal("rejected"),
    reason: PublishTradingPlanRejection,
    /** The mission version the server actually holds, so the harness can retry. */
    currentVersion: Schema.Number,
    /** What specifically was wrong, when the reason alone does not say. */
    detail: Schema.optional(Schema.String),
  }),
]);
export type TradingPublishPlanResult = typeof TradingPublishPlanResult.Type;

// The §14.2 read-tool input/result schemas that used to live here retired
// with `trading_look`'s fetch catalog — the one read answers them all.

/**
 * Shared mission-binding field on every read tool input.
 *
 * `missionId` is optional: the calling thread is bound to exactly one mission,
 * so omitting it resolves to that mission. A wrong `missionId` is still
 * rejected with `mission_not_bound_to_thread`.
 */
const missionBound = {
  missionId: Schema.optional(TradingId),
} as const;

export const TradingRequestEntryResult = Schema.Struct({
  /**
   * The execution record this request wrote, when it wrote one.
   *
   * Absent for the two outcomes that have no record: a request refused before
   * signing, and a request still in flight when the tool gave up waiting.
   * `TradingId` is a non-empty string, so reporting those as `""` made the
   * result unencodable — and an unencodable result reaches the harness as a
   * generic internal error, hiding the refusal reason it most needed to read.
   */
  executionId: Schema.optional(TradingId),
  /**
   * What actually became of the request.
   *
   * Mirrors the persisted execution record's own status rather than
   * flattening it: `accepted` used to be reported for a record that had been
   * cancelled or had failed, which tells the harness it has a live order when
   * it has none.
   *
   * - `submitted` — still in flight when the tool stopped waiting;
   * - `accepted` — acknowledged and resting on the book;
   * - `filled`, `cancelled`, `rejected`, `failed` — the record's terminal word;
   * - `succeeded` — a deterministic action with no order of its own (a
   *   `cancel`, a `modify_stop`) that did what it was asked.
   */
  status: Schema.Literals([
    "submitted",
    "accepted",
    "filled",
    "cancelled",
    "rejected",
    "failed",
    "succeeded",
  ]),
  cloid: Schema.String,
  orderResults: Schema.Array(Schema.Unknown),
  budget: Schema.Struct({
    remainingCumulativeLossUsd: Schema.Number,
    exhausted: Schema.Boolean,
  }),
  /**
   * Why the request ended the way it did — the refusal reason for a
   * `rejected`, the record's exchange status for an `accepted`, and for a
   * `submitted` the fact that the outcome is not yet known.
   *
   * `status` alone cannot distinguish "refused at preview, no order exists"
   * from "the exchange rejected the order", and a harness that cannot tell
   * those apart cannot decide what to do next.
   */
  detail: Schema.optional(Schema.String),
  /**
   * Signed canonical position size after a `reduce` or `close`, read from the
   * reconciled snapshot the post-submit convergence wrote.
   *
   * A scale-out that reports only "accepted" leaves the harness to guess how
   * much it still holds, and the guess is what it then sizes its stop against.
   */
  remainingSize: Schema.optional(Schema.Number),
  /**
   * The limit price the server actually placed, not the one the intent named.
   *
   * A `marketable_ioc` limit is derived from the fresh BBO ± the configured
   * slippage allowance, so the intent's `limitPrice` and the order's are two
   * different numbers. Reporting only the intent's is what left a standing gap
   * between the fills T3 reported and the price column in the Hyperliquid UI.
   */
  limitPrice: Schema.optional(Schema.Number),
  /**
   * The time-in-force the order actually went out with — `ioc` when it crossed,
   * `alo` when it rested as maker, `gtc` for a resting limit.
   *
   * The harness asks in urgency, never in TIF; this is the server's answer for
   * what that urgency became on the wire, so what was done can be told apart
   * from what was asked. Absent when no order was placed (a refusal, or an
   * outcome still unknown).
   */
  timeInForce: Schema.optional(TradingOrderTimeInForce),
  /**
   * Size-weighted average price of the fills recorded under this execution's
   * cloid, when any filled. This is what the position was actually opened or
   * closed at — the limit above is only the bound it could not cross.
   */
  avgFillPrice: Schema.optional(Schema.Number),
  /**
   * Whether this outcome is worth trying again, and what to do if it is not.
   *
   * Every failure used to arrive as the same thing — a turn that did not trade
   * — so a rate-limited read and an authority that forbids the direction were
   * indistinguishable, and standing down was the only response available to
   * both. This says which one happened. `retryable` is never true for anything
   * that spent a nonce: an unknown submission is settled by reading state, not
   * by sending it again.
   */
  recovery: Schema.optional(FailureRecovery),
});
export type TradingRequestEntryResult = typeof TradingRequestEntryResult.Type;

/**
 * What `trading_enter` reports back: the execution outcome, plus what the
 * server decided on the way to it.
 *
 * The sizing fields are the half the retired quote used to return in its own
 * call. They are not decoration: a harness that asked for one size and got
 * another has to know which ceiling bound it before it sizes the next
 * decision, and `notes` carries the things that are true of the entry without
 * stopping it — a size under the mandate's own floor, a target the ceilings
 * cannot fund.
 */
export const TradingEnterResult = Schema.Struct({
  ...TradingRequestEntryResult.fields,
  /** Size the server actually sent, in base units. Absent on a refusal. */
  size: Schema.optional(Schema.Number),
  /** Which ceiling produced that size. `requested` means none did. */
  constrainedBy: Schema.optional(EntrySizeConstraint),
  /** Notional at the entry price, in USD. */
  notionalUsd: Schema.optional(Schema.Number),
  /** Planned loss if the stop is hit, at the size that went out. */
  plannedLossAtStopUsd: Schema.optional(Schema.Number),
  /** Round trip at this size, so the target can be held against it. */
  estimatedRoundTripCostUsd: Schema.optional(Schema.Number),
  /**
   * The largest size that would have cleared, when a smaller one would.
   * Absent when the refusal is not about size at all.
   */
  feasibleSize: Schema.optional(Schema.Number),
  /** True of this entry, but not reasons to refuse it. */
  notes: Schema.optional(Schema.Array(Schema.String)),
});
export type TradingEnterResult = typeof TradingEnterResult.Type;

// -- trading_exit's move_stop (plan 24 §5.2) --------------------------------

/**
 * The refusals that are about the mission rather than the policy.
 *
 * `checkStopAdjustment` answers "is this move within the rules"; these are the
 * cases where the question could not be asked at all — nothing to adjust, no
 * price to measure against, or a harness reasoning against a plan the mission
 * has since revised.
 */
export const TradingAdjustStopRefusalContext = Schema.Literals([
  "no_position",
  "no_resting_stop",
  /** The plan has been revised since the harness last read it. */
  "stale_plan",
  "market_data_unavailable",
  /** The policy passed but the exchange replacement did not confirm. */
  "replacement_failed",
]);
export type TradingAdjustStopRefusalContext = typeof TradingAdjustStopRefusalContext.Type;

export const TradingAdjustStopResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("adjusted"),
    previousStop: Schema.Number,
    newStop: Schema.Number,
    /** Distance from the current mark to the new stop. */
    stopDistanceUsd: Schema.Number,
    /** What the position now loses if it stops out. */
    plannedLossAtStopUsd: Schema.Number,
    /** Adjustments left on this position before the budget refuses. */
    remainingAdjustments: Schema.Number,
  }),
  Schema.Struct({
    status: Schema.Literal("refused"),
    refusalCode: Schema.Union([StopAdjustmentRefusalCode, TradingAdjustStopRefusalContext]),
    /** The stop still resting, unchanged. */
    previousStop: Schema.Number,
    /** What was asked for, so the harness can see the two numbers together. */
    newStop: Schema.Number,
    /** Which bound was hit, in the numbers the rule is expressed in. */
    detail: Schema.String,
  }),
]);
export type TradingAdjustStopResult = typeof TradingAdjustStopResult.Type;

/**
 * What one `trading_exit` call answers with.
 *
 * A union rather than a widened struct, because the two halves report
 * genuinely different things: three actions send an order and report the
 * execution record, and `move_stop` reports where the stop now rests. The
 * `status` literals do not overlap, so the discriminator is unambiguous.
 */
export const TradingExitResult = Schema.Union([
  TradingRequestEntryResult,
  ...TradingAdjustStopResult.members,
  Schema.Struct({
    status: Schema.Literal("refused_request"),
    reason: TradingExitRefusalCode,
    detail: Schema.String,
    recovery: FailureRecovery,
  }),
]);
export type TradingExitResult = typeof TradingExitResult.Type;

/**
 * Read one named playbook.
 *
 * The doctrine the harness used to carry inside `POC_DEFAULT_INSTRUCTION`, split
 * into one mode per strategy and reachable by name. The result is the procedure the harness
 * reads in the turn it decides what to do — it never reaches a database and is
 * the same for every mission.
 */
export const TradingGetPlaybookInput = Schema.Struct({
  ...missionBound,
  name: TradingPlaybookName,
});
export type TradingGetPlaybookInput = typeof TradingGetPlaybookInput.Type;

// -- §14.4 watch tools (Phase 3) ---------------------------------------------
//
// Watches are registered against the mission, not a plan revision (plan 29
// step 4.2). A cancel only affects an active watch; already-terminal watches
// keep their terminal status. The handler resolves the bound mission through
// the same `resolveBoundCall` path as the §14.2/§14.3 tools.

export const TRADING_WATCH_TOOL = "trading_watch";

/**
 * Arm one condition, or retire one armed watch.
 *
 * Both, because they are one operation on one set: cancelling is a `watch`
 * shape, and having a second tool for the retirement half meant the model had
 * to learn two names for the registry it can already read off `trading_look`
 * (plan 29 step 6.5). Exactly one of `condition` and `cancel` per call —
 * neither, or both, is refused rather than guessed at.
 */
export const TradingWatchInput = Schema.Struct({
  ...missionBound,
  /** What has to become true. One union, five kinds (plan 29 step 6.3). */
  condition: Schema.optional(WatchCondition),
  /**
   * An active watch to retire outright. Only an active watch can be
   * cancelled: one that already fired, or was already cancelled, is terminal.
   *
   * Distinct from `replacesWatchId`, which retires a watch *as* another is
   * armed. This one leaves the side unwatched, which is sometimes exactly
   * what is meant.
   */
  cancel: Schema.optional(TradingId),
  /**
   * An active watch to retire as this one is armed, in a single transaction.
   *
   * A watch fires once and is terminal, so keeping a level standing means
   * re-arming it — and doing that as cancel-then-arm leaves the side being
   * re-levelled unwatched in between. This closes that window.
   */
  replacesWatchId: Schema.optional(TradingId),
  /**
   * How the firing is delivered (final-form Phase 8).
   *
   * On a mission thread the only route is `"wake"` (the default there): the
   * mission's watches exist to wake the mission. On an analyst thread the only
   * route is `"notify"` (the default there): the alert lands in the trader's
   * feed, because an analyst session holds no mission to wake. Naming the
   * route the session cannot have is refused, never coerced.
   */
  deliver: Schema.optional(TradingWatchDeliver),
});
export type TradingWatchInput = typeof TradingWatchInput.Type;

/**
 * Why a `cancel` did not retire a watch.
 *
 * Kept apart from `WatchRefusalCode` because it is not a rule about a
 * condition: nothing was malformed, the watch named is simply not one that can
 * be cancelled.
 */
export const TradingCancelWatchRejection = Schema.Literals(["watch_not_found", "watch_not_active"]);
export type TradingCancelWatchRejection = typeof TradingCancelWatchRejection.Type;

/**
 * What arming a condition did.
 *
 * A refusal is an outcome rather than a thrown error for the same reason
 * `trading_enter`'s is (plan 29 step 6.2): the harness's next move depends on
 * which kind of refusal it was, and that answer has to survive as data. The
 * `recovery` it carries is the same three-way answer as everywhere else —
 * a rule refuses this, read what is actually true, or try again.
 */
export const TradingWatchResult = Schema.Union([
  Schema.Struct({
    outcome: Schema.Literal("armed"),
    watch: PersistedWatch,
    /**
     * The watch `replacesWatchId` actually cancelled.
     *
     * Absent when none was named — and, importantly, also absent when the one
     * named was already terminal. That case is the harness's cue that the
     * level it meant to retire had already fired or been cancelled, so what it
     * just armed is an addition, not a swap.
     */
    replaced: Schema.optional(PersistedWatch),
  }),
  /** What `cancel` retired. The watch is returned in its cancelled state. */
  Schema.Struct({
    outcome: Schema.Literal("cancelled"),
    watch: PersistedWatch,
  }),
  Schema.Struct({
    outcome: Schema.Literal("rejected"),
    reason: TradingCancelWatchRejection,
  }),
  Schema.Struct({
    outcome: Schema.Literal("refused"),
    reason: WatchRefusalCode,
    detail: Schema.String,
    recovery: FailureRecovery,
  }),
  /**
   * The analyst arms (final-form Phase 8): an account-scoped alert with no
   * mission anywhere near it. Its own shapes rather than `armed`/`cancelled`
   * because those carry a `PersistedWatch`, whose `missionId` an account watch
   * does not have.
   */
  Schema.Struct({
    outcome: Schema.Literal("armed_alert"),
    watchId: TradingId,
    /** The asset the alert watches, or "" for a time alert. */
    market: Schema.String,
    deliver: Schema.Literal("notify"),
  }),
  Schema.Struct({
    outcome: Schema.Literal("alert_cancelled"),
    watchId: TradingId,
  }),
  /** Why an analyst arm or cancel did nothing. Plain prose; nothing was armed. */
  Schema.Struct({
    outcome: Schema.Literal("alert_rejected"),
    reason: Schema.String,
  }),
]);
export type TradingWatchResult = typeof TradingWatchResult.Type;

// `trading_list_watches` retired into `trading_look` — plan 29 step 6.5. The
// registry rides `mission.watches` on the one read, bounded by
// `listWatchesForRead`, so a separate list call was a second name for a thing
// the model already had in front of it.
