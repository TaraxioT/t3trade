import type { PersistedWatch, TradingMissionStatus } from "@t3tools/trading-contracts";
import { planPhase } from "@t3tools/trading-contracts";

import {
  formatDuration,
  formatUsd,
  formatSignedUsd,
  formatPrice,
  humanizeLiteral,
  MISSION_STATUS_LABELS,
} from "./tradingFormat";

export * from "./tradingFormat";
export * from "./tradingWakeup";
export * from "./tradingBacktest";
export * from "./tradingMissionStrip";
export * from "./tradingPositionLifecycle";
export * from "./tradingWatchStream";
export * from "./tradingOrderLedger";

// ---------------------------------------------------------------------------
// composer controls
// ---------------------------------------------------------------------------
//
// The three pills the composer carries in a mission-bound thread. Each is read
// back from the mission, never chosen here: the mandate is the authority the
// user granted (§10.4) and entries are governed by the mission's control block
// (§11.1), so a pill that let either be edited from the composer would be
// showing a value the server would not honour.

/**
 * The venue and network a mission trades on.
 *
 * Read from the account id, which is the only network signal the projection
 * carries. An id that does not name its network is shown verbatim rather than
 * assumed to be mainnet — guessing wrong here is the expensive direction.
 */
export function describeTradingAccount(tradingAccountId: string): string {
  const normalized = tradingAccountId.toLowerCase();
  if (normalized.includes("testnet")) return "Hyperliquid · Testnet";
  if (normalized.includes("mainnet")) return "Hyperliquid · Mainnet";
  return tradingAccountId;
}

/**
 * How late a position read may be before the surface says anything at all.
 *
 * This is NOT §13's 5s account window, and setting it to that window was the
 * bug. The refresh it measures is §18.2 #8's periodic reconcile, whose schedule
 * is `Schedule.spaced(5s)` — spaced from *completion*, so one cycle is five
 * seconds plus an exchange round trip plus the reconcile's own writes. On top of
 * that, `observed_at` is the server's clock at the top of the pass and this
 * compares it against the browser's, so any skew between the two lands here too.
 *
 * A threshold equal to the refresh period is therefore below the floor of what
 * it measures: the age sweeps past it near the end of every single cycle, and
 * the banner blinked on and off for the life of every position. Three missed
 * reconciles is the first age that means a read has actually stopped landing.
 */
export const POSITION_DELAYED_AFTER_MILLIS = 15_000;

/**
 * How late a read must be before the surface claims placement is suspended.
 *
 * "Order placement is suspended" is a strong claim about the execution path, so
 * it waits until the read has missed roughly nine reconciles — by then the feed
 * is not late, it is broken. Between the two thresholds the panel shows a quiet
 * `stale 20s` chip instead: enough to say the numbers are not current, without
 * asserting something about the order path that is probably not true yet.
 */
export const POSITION_STALE_AFTER_MILLIS = 45_000;

/** How current the position read is, in the three bands the surfaces show. */
export type PositionFreshness = "current" | "delayed" | "stale";

export interface StalenessSubject {
  readonly status: TradingMissionStatus;
  readonly position: { readonly size: number; readonly observedAt: string } | null;
}

/**
 * The age of the position read, or null when there is nothing to age.
 *
 * Null in three cases, each of which used to produce a false warning: a
 * completed mission (its final row never refreshes again), a flat mission
 * (§18.2 #8's reconcile only runs against exposure, so a flat snapshot ages out
 * once and stays aged out), and an unparseable timestamp.
 */
export function readPositionReadAge(subject: StalenessSubject, nowMs: number): number | null {
  if (isMissionComplete(subject.status)) return null;

  const position = subject.position;
  if (position === null || position.size === 0) return null;

  const observedAt = Date.parse(position.observedAt);
  if (Number.isNaN(observedAt)) return null;

  return Math.max(0, nowMs - observedAt);
}

export function readPositionFreshness(subject: StalenessSubject, nowMs: number): PositionFreshness {
  const age = readPositionReadAge(subject, nowMs);
  if (age === null) return "current";
  if (age > POSITION_STALE_AFTER_MILLIS) return "stale";
  if (age > POSITION_DELAYED_AFTER_MILLIS) return "delayed";
  return "current";
}

/** The panel header's quiet chip — `stale 20s` — or null while current. */
export function describeDelayedRead(subject: StalenessSubject, nowMs: number): string | null {
  const freshness = readPositionFreshness(subject, nowMs);
  if (freshness === "current") return null;

  const age = readPositionReadAge(subject, nowMs);
  return age === null ? "stale" : `stale ${formatDuration(age)}`;
}

/**
 * The staleness banner's own text, or null below the suspension threshold.
 *
 * The age is the whole point of the sentence: a read that is a second late and
 * one that stopped four minutes ago are very different situations to be holding
 * a position through, and "Position data is stale" alone said the same thing
 * about both.
 */
export function describeStaleness(subject: StalenessSubject, nowMs: number): string | null {
  if (readPositionFreshness(subject, nowMs) !== "stale") return null;

  const age = readPositionReadAge(subject, nowMs);
  const lastUpdate = age === null ? "" : ` Last update ${formatDuration(age)} ago.`;
  return `Position data is stale. Order placement is suspended until a fresh read lands.${lastUpdate}`;
}

/** The order-rejected surface, when the latest execution was refused. */
export interface RejectedOrderNotice {
  readonly actionType: string;
  readonly side: string;
  readonly size: number;
  /** True when re-arming is possible: the mission is not blocked or revoked. */
  readonly canReArm: boolean;
}

export function deriveRejectedOrder(mission: {
  readonly status: TradingMissionStatus;
  readonly inFlightExecution: {
    readonly status: string;
    readonly actionType: string;
    readonly side: string;
    readonly size: number;
  } | null;
}): RejectedOrderNotice | null {
  const execution = mission.inFlightExecution;
  if (execution === null) return null;
  if (execution.status !== "rejected" && execution.status !== "failed") return null;

  return {
    actionType: execution.actionType,
    side: execution.side,
    size: execution.size,
    // Re-arming a blocked mission would route around §16.4's no-auto-resume
    // rule, and a revoked one has no authority left to re-arm.
    canReArm: mission.status !== "blocked" && mission.status !== "revoked",
  };
}

/** The completion summary card (§14.7 risk chrome). */
export interface CompletionSummary {
  readonly realizedPnlUsd: number;
  readonly feesPaidUsd: number;
  /** Realised result net of the fees already paid (§16.2). */
  readonly netResultUsd: number;
  readonly fillCount: number;
  /** Traded duration in millis, first fill to last. Null with fewer than two. */
  readonly tradedDurationMillis: number | null;
  /**
   * The first fill's timestamp, carried so a review chart can window to the
   * trade's actual span. Null when there were no fills.
   */
  readonly firstFillAt: string | null;
  /**
   * The last fill's timestamp, carried so a review chart can window to the
   * trade's actual span. Null when there were no fills.
   */
  readonly lastFillAt: string | null;
  /** The loss the strategy planned to risk, when one was published. */
  readonly plannedLossUsd: number | null;
  /**
   * How the realised result compares to the plan. Null when nothing was
   * planned — an unpublished strategy has no plan to deviate from.
   */
  readonly deviationFromPlanUsd: number | null;
}

/** True when the mission has finished and the summary card should show. */
export function isMissionComplete(status: TradingMissionStatus): boolean {
  return status === "completed" || status === "revoked";
}

/**
 * The missions worth a full card in the workspace: the live ones.
 *
 * Finished missions survive in the projection now (plan 27 H1 stopped
 * deleting them at settle), so this filter is what keeps the workspace to the
 * missions that can still act. The finished ones render in the history list
 * instead — see {@link settledMissions}.
 *
 * Input order is the projection's: newest first.
 */
export function visibleMissions<T extends { readonly status: TradingMissionStatus }>(
  missions: ReadonlyArray<T>,
): ReadonlyArray<T> {
  return missions.filter((mission) => !isMissionComplete(mission.status));
}

/** The finished missions, newest first: the history list's input. */
export function settledMissions<T extends { readonly status: TradingMissionStatus }>(
  missions: ReadonlyArray<T>,
): ReadonlyArray<T> {
  return missions.filter((mission) => isMissionComplete(mission.status));
}

/** One line of the mission history list, everything already formatted. */
export interface MissionHistoryRow {
  readonly missionId: string;
  readonly threadId: string;
  readonly market: string;
  /** "Long" / "Short" / "Stand aside" from the published plan; null when none was. */
  readonly direction: string | null;
  readonly statusLabel: string;
  readonly netUsd: number;
  readonly netLabel: string;
  readonly feesLabel: string;
  readonly fillCount: number;
  /** First fill to last fill; null for a mission that never traded twice. */
  readonly durationLabel: string | null;
  /** When the mission reached its terminal status (the row's last write). */
  readonly settledAtIso: string;
}

/**
 * A settled mission compressed to the line the history list shows.
 *
 * The full record — fills, review chart, plan — lives on the mission's
 * thread; this row exists to find that thread and to make the ledger scan
 * well: market, direction, what it netted, what it cost, how long it traded.
 */
export function deriveMissionHistoryRow(mission: {
  readonly id: string;
  readonly threadId: string;
  readonly market: string;
  readonly status: TradingMissionStatus;
  readonly strategy: { readonly intent: string } | null;
  readonly result: {
    readonly realizedPnlUsd: number;
    readonly feesPaidUsd: number;
    readonly fillCount: number;
    readonly firstFillAt: string | null;
    readonly lastFillAt: string | null;
  };
  readonly updatedAt: string;
}): MissionHistoryRow {
  const net = mission.result.realizedPnlUsd - mission.result.feesPaidUsd;
  const tradedMillis =
    mission.result.firstFillAt === null ||
    mission.result.lastFillAt === null ||
    mission.result.fillCount < 2
      ? null
      : Date.parse(mission.result.lastFillAt) - Date.parse(mission.result.firstFillAt);
  return {
    missionId: mission.id,
    threadId: mission.threadId,
    market: mission.market,
    direction: mission.strategy === null ? null : planIntentLabel(mission.strategy.intent),
    statusLabel: MISSION_STATUS_LABELS[mission.status],
    netUsd: net,
    netLabel: formatSignedUsd(net),
    feesLabel: formatUsd(mission.result.feesPaidUsd),
    fillCount: mission.result.fillCount,
    durationLabel: tradedMillis === null || tradedMillis < 0 ? null : formatDuration(tradedMillis),
    settledAtIso: mission.updatedAt,
  };
}

export function deriveCompletionSummary(mission: {
  readonly result: {
    readonly realizedPnlUsd: number;
    readonly feesPaidUsd: number;
    readonly fillCount: number;
    readonly firstFillAt: string | null;
    readonly lastFillAt: string | null;
    /** Planned loss at the approved stop, scaled to what actually filled. */
    readonly plannedLossAtStopUsd?: number | null | undefined;
  };
  readonly strategy: {
    readonly stop: { readonly maximumPlannedLossUsd?: number | undefined };
  } | null;
}): CompletionSummary {
  const { result } = mission;
  // §16.2: paid fees live in the realised result and must not be counted
  // twice. They are shown separately AND netted once, never netted twice.
  const netResultUsd = result.realizedPnlUsd - result.feesPaidUsd;

  const tradedDurationMillis =
    result.firstFillAt === null || result.lastFillAt === null || result.fillCount < 2
      ? null
      : Date.parse(result.lastFillAt) - Date.parse(result.firstFillAt);

  // What was really at stake, preferred over what the plan said was — plan 34
  // step 7.3. `maximumPlannedLossUsd` is a number the model writes, and it
  // writes it from the authority's per-position ceiling; the entry records say
  // what the stop was actually going to cost at the size that actually filled.
  // On the mission that found this the two were $63 and $1.70.
  const plannedLossUsd =
    mission.result.plannedLossAtStopUsd ?? mission.strategy?.stop.maximumPlannedLossUsd ?? null;

  return {
    realizedPnlUsd: result.realizedPnlUsd,
    feesPaidUsd: result.feesPaidUsd,
    netResultUsd,
    fillCount: result.fillCount,
    tradedDurationMillis,
    firstFillAt: result.firstFillAt,
    lastFillAt: result.lastFillAt,
    plannedLossUsd,
    // Positive means the mission did better than the loss it planned to risk.
    deviationFromPlanUsd: plannedLossUsd === null ? null : netResultUsd + plannedLossUsd,
  };
}

/** The two prices a review chart marks: where the trade went on, and off. */
export interface ReviewMarkers {
  readonly entryPrice: number | null;
  readonly exitPrice: number | null;
}

/**
 * Read the entry and exit prices off a finished mission's fill receipts.
 *
 * `recentFills` is newest-first and capped at three, which is exactly right for
 * the ordinary shape (one open, one close) and honest about the rest: a mission
 * that scaled in and out more than that gets its most recent close as the exit
 * and the oldest fill still on the receipt list as the entry. The chart is a
 * review of what happened, not an audit trail, so an approximate entry beats no
 * chart at all.
 *
 * `direction` is preferred where the exchange supplied it ("Open Long" /
 * "Close Long"); fills recorded before that field was carried fall back to
 * position in the list.
 */
export function deriveReviewMarkers(
  fills: ReadonlyArray<{
    readonly avgFillPrice: number;
    readonly direction?: string | undefined;
  }>,
): ReviewMarkers {
  if (fills.length === 0) return { entryPrice: null, exitPrice: null };

  const opening = fills.toReversed().find((fill) => fill.direction?.startsWith("Open") === true);
  const closing = fills.find((fill) => fill.direction?.startsWith("Close") === true);

  const oldest = fills[fills.length - 1]!;
  const newest = fills[0]!;

  return {
    entryPrice: (opening ?? oldest).avgFillPrice,
    exitPrice: (closing ?? newest).avgFillPrice,
  };
}

/**
 * The published trading plan, rendered as a display-only timeline card.
 *
 * Mirrors {@link deriveCompletionSummary}'s shape: a flat, render-ready object
 * derived purely from the mission projection, so the React component holds no
 * logic of its own. Null when no strategy has been published yet.
 */
export interface StrategyPlan {
  /**
   * The narrative: setup, indicators, regime, and the plan in plain terms, in
   * one field. Null when the harness published none (decodes as "").
   */
  readonly because: string | null;
  /**
   * The plan's intent as a label — "Long", "Short", "Stand aside" — so every
   * surface that shows a plan names its direction the same way.
   */
  readonly intentLabel: string;
  /** Each entry trigger's prose description; empty when none were published. */
  readonly entryTriggers: ReadonlyArray<string>;
  /** How urgently the plan wants its entry to land, humanized ("now"/"patient"). */
  readonly orderType: string | null;
  readonly initialSizeUsd: number | null;
  /** "{method} · {price}" when a price was set, else just the method. */
  readonly stopSummary: string | null;
  /**
   * The plan's stated profit rung, when it named one. Null on a plan that
   * named none — including every stand-aside, where there is no target at all.
   */
  readonly targetUsd: number | null;
  /**
   * Whether this plan stood aside (`intent: "stand_aside"`): the turn read the
   * market, found nothing worth taking after costs, and published that
   * conclusion rather than inventing a target. Nothing is armed at
   * `targetUsd` on such a plan — there is no position and no `pnl_above`.
   */
  readonly isStandAside: boolean;
  readonly maxLossUsd: number | null;
  /** Each invalidation condition's prose; empty when none. */
  readonly invalidation: ReadonlyArray<string>;
  /** How much longer an untriggered plan stays fresh, in minutes. */
  readonly reassessMinutes: number;
  /**
   * The plan's phase, derived from what the mission holds: flat is waiting on
   * a trigger, a position is holding (plan 29 step 4.4's two-state model).
   */
  readonly planPhase: "waiting" | "holding";
}

/**
 * The plan's intent as a display label: "Long", "Short", "Stand aside".
 *
 * The old document carried this as a stand-down code the surfaces had to
 * interpret; the intent is the whole statement now, and this is the one place
 * that turns it into prose.
 */
function planIntentLabel(intent: string): string {
  const humanized = humanizeLiteral(intent);
  return humanized.charAt(0).toUpperCase() + humanized.slice(1);
}

/**
 * Read the prose description off a trigger the harness published.
 *
 * `AgentConditionInput` is a union of the full object and a bare string; after
 * decode the persisted form is always `{ description }`, but the TS type is the
 * union, so a structural guard is what reaches `.description` safely. Anything
 * the guard rejects returns null rather than a guess.
 */
function readConditionDescription(condition: unknown): string | null {
  if (typeof condition !== "object" || condition === null) return null;
  if (!("description" in condition)) return null;
  const description = (condition as { description?: unknown }).description;
  return typeof description === "string" ? description : null;
}

/**
 * The published plan as a render-ready card shape, or null before publish.
 *
 * Reads the strategy structurally via `mission.strategy?.<field>`: the contract
 * type is accessed only through the projection, never imported by name, so a
 * future field the schema gains still renders rather than failing the build.
 */
export function deriveStrategyPlan(mission: {
  /** The mission's position snapshot; absent or flat means the plan is waiting. */
  readonly position?: { readonly size: number } | null;
  readonly strategy: {
    readonly intent: string;
    readonly entry: {
      readonly triggers: ReadonlyArray<unknown>;
      readonly urgency: string;
      readonly initialNotionalUsd?: number | undefined;
    };
    readonly stop: {
      readonly method: string;
      readonly price?: number | undefined;
      readonly maximumPlannedLossUsd?: number | undefined;
    };
    readonly target: {
      readonly profitUsd?: number | undefined;
    };
    readonly invalidation: ReadonlyArray<unknown>;
    readonly reassess: { readonly afterMinutes: number };
    readonly because?: string | undefined;
  } | null;
}): StrategyPlan | null {
  const strategy = mission.strategy;
  if (strategy === null) return null;

  const entryTriggers = (strategy.entry?.triggers ?? [])
    .map(readConditionDescription)
    .filter((value): value is string => value !== null);

  const stopMethod = strategy.stop?.method ?? null;
  const stopPrice = strategy.stop?.price ?? null;
  const stopSummary =
    stopMethod === null
      ? null
      : stopPrice === undefined || stopPrice === null
        ? humanizeLiteral(stopMethod)
        : `${humanizeLiteral(stopMethod)} · ${formatPrice(stopPrice)}`;

  const because = strategy.because?.trim() ?? "";

  return {
    because: because === "" ? null : because,
    intentLabel: planIntentLabel(strategy.intent),
    entryTriggers,
    orderType:
      strategy.entry?.urgency === undefined ? null : humanizeLiteral(strategy.entry.urgency),
    initialSizeUsd: strategy.entry?.initialNotionalUsd ?? null,
    stopSummary,
    targetUsd: strategy.target?.profitUsd ?? null,
    isStandAside: strategy.intent === "stand_aside",
    maxLossUsd: strategy.stop?.maximumPlannedLossUsd ?? null,
    invalidation: (strategy.invalidation ?? []).filter(
      (line): line is string => typeof line === "string",
    ),
    reassessMinutes: strategy.reassess?.afterMinutes ?? 90,
    // The phase the nine-value `currentAction` pretended to be: flat is
    // waiting, holding is holding.
    planPhase: planPhase(mission.position?.size ?? 0),
  };
}

/**
 * The next scheduled reassessment, as epoch millis, or null when none is armed.
 *
 * Separate from {@link deriveWatchConditions} because it is wanted in states
 * that function is not called for: a reassessment is scheduled just as often
 * while a position is open as while one is being waited for, and the chart
 * marks it on the axis either way.
 */
export function deriveNextReassessmentAt(mission: {
  readonly watches: ReadonlyArray<PersistedWatch>;
}): number | null {
  let next: number | null = null;
  for (const persisted of mission.watches) {
    if (persisted.status !== "active") continue;
    const watch = persisted.watch;
    if (watch.type !== "scheduled_reassessment") continue;
    if (next === null || watch.runAt < next) next = watch.runAt;
  }
  return next;
}

/**
 * The reassessment moment the PLAN states, in epoch millis, or null when the
 * plan states none that is still ahead.
 *
 * The armed watch row is the better source and stays the first one asked. But a
 * `scheduled_reassessment` armed at runtime (the staleness floor, the
 * prediction roll-forward) is written straight to `trading_watches` without an
 * orchestration event, and the mission projection is rebuilt only on events, so
 * `watches` can read empty for minutes while a reassessment really is armed.
 * The plan is projected throughout and names the same moment: the reassessment
 * is measured from the publish that set `updatedAt`. Recomputing it here keeps
 * the heartbeat sentence and the time axis speaking in that window rather than
 * going silent, using only fields the projection already carries.
 *
 * Past moments are dropped. A plan whose reassessment has come and gone says
 * nothing about the next one, and a stale clock time reads as a live promise.
 */
export function plannedReassessmentAt(
  strategy:
    | {
        readonly reassess: { readonly afterMinutes: number };
        readonly updatedAt: number;
      }
    | null
    | undefined,
  nowMillis: number,
): number | null {
  if (strategy === null || strategy === undefined) return null;
  const at = strategy.updatedAt + strategy.reassess.afterMinutes * 60_000;
  return at > nowMillis ? at : null;
}

/** One past event, ready to hand to the chart's `pastMarkers` input. */
export interface ChartPastMarkerInput {
  readonly key: string;
  readonly kind: string;
  /** Epoch millis — the projection sends ISO, the axis wants a number. */
  readonly at: number;
  readonly cause?: string;
  readonly failed?: boolean;
}

/**
 * The mission's own turns, as ticks for the time axis — plan 24 §4.2.
 *
 * `missionTimeline` is newest-first and already bounded server-side, so this is
 * a parse and a filter rather than a derivation: entries whose `at` will not
 * parse are dropped, because a tick at a time it did not happen is worse than
 * no tick. The order is preserved, which is what lets the geometry's cap drop
 * the oldest rather than the nearest.
 *
 * A failed run is read off the label the projection composed — the entry
 * carries the raw cause separately, so the suffix is the only place the outcome
 * lives.
 */
export function deriveChartPastMarkers(mission: {
  readonly missionTimeline?:
    | ReadonlyArray<{
        readonly at: string;
        readonly kind: string;
        readonly label: string;
        readonly cause?: string | undefined;
      }>
    | undefined;
}): ReadonlyArray<ChartPastMarkerInput> {
  const markers: ChartPastMarkerInput[] = [];
  (mission.missionTimeline ?? []).forEach((entry, index) => {
    const at = Date.parse(entry.at);
    if (Number.isNaN(at)) return;
    markers.push({
      // The timeline carries no id of its own, and two wakes can share a
      // millisecond only if they share an index too.
      key: `${entry.kind}-${index}-${entry.at}`,
      kind: entry.kind,
      at,
      ...(entry.cause === undefined ? {} : { cause: entry.cause }),
      ...(entry.label.endsWith("(failed)") ? { failed: true } : {}),
    });
  });
  return markers;
}

/** How many future ticks the chart's gutter holds before it says "+N". */
export const MAX_DRAWN_TIME_MARKERS = 5;

/**
 * One future moment, ready to hand to the chart's `timeMarkers` input.
 *
 * `tone` separates the two kinds of schedule the mission keeps: `auto` is the
 * runtime's staleness floor — a backstop nobody chose — and `planned` is a time
 * the harness itself armed because it wants to see that moment. Drawing them
 * identically reads as "the plan has five appointments" when four of them are
 * the floor rearming itself.
 */
export interface ChartTimeMarkerInput {
  readonly key: string;
  /** Empty on every tick but the nearest: five captions in one gutter collide. */
  readonly label: string;
  readonly at: number;
  readonly tone: "auto" | "planned";
}

/**
 * Every armed reassessment, as ticks on the axis — not only the nearest.
 *
 * The panel drew one marker, from {@link deriveNextReassessmentAt}, which is
 * the countdown the header already shows. A mission that has republished a few
 * times can be holding several scheduled reassessments at once, and the shape
 * of that queue — three minutes apart and all `auto`, versus one at the funding
 * timestamp — is the difference between a loop idling and a plan waiting.
 *
 * Capped at {@link MAX_DRAWN_TIME_MARKERS}: beyond that the last slot becomes a
 * `+N` tick standing at the furthest moment, so the axis still says how far the
 * schedule reaches without drawing a picket fence.
 */
export function deriveChartTimeMarkers(
  mission: {
    readonly watches: ReadonlyArray<PersistedWatch>;
  },
  /**
   * The plan's own reassessment moment, from {@link plannedReassessmentAt},
   * used only when no reassessment watch is projected. Null (the default)
   * reads the watch rows alone.
   */
  plannedAt: number | null = null,
): ReadonlyArray<ChartTimeMarkerInput> {
  const scheduled: ChartTimeMarkerInput[] = [];
  for (const persisted of mission.watches) {
    if (persisted.status !== "active") continue;
    const watch = persisted.watch;
    if (watch.type !== "scheduled_reassessment") continue;
    scheduled.push({
      // Replaced by a rank-based key once sorted; see below.
      key: persisted.id,
      label: "",
      at: watch.runAt,
      tone: persisted.armedReason === "staleness_floor" ? "auto" : "planned",
    });
  }
  if (scheduled.length === 0) {
    // No watch row reached the projection. The plan still names the moment, so
    // the axis marks it rather than showing an empty future.
    if (plannedAt === null) return [];
    return [{ key: "reassess-0", label: "reassess", at: plannedAt, tone: "planned" }];
  }

  scheduled.sort((a, b) => a.at - b.at);

  // Re-keyed by rank once sorted, so the chart can render the queue as a set of
  // moving markers rather than as a set of rows. A reassessment is re-armed on
  // every wake: the old watch is consumed and a new row takes its place minutes
  // further out. Keyed by row id that is one marker unmounting and another
  // mounting, so the rule vanishes from one x and appears at another. Keyed by
  // rank, the nearest reassessment is one continuous thing whatever row is
  // currently carrying it, and the renderer can ease it to its new moment —
  // which is what makes a reset legible as a reset.
  const ranked = scheduled.map((marker, index) => ({ ...marker, key: `reassess-${index}` }));

  const nearest = ranked[0]!;
  const labelled: ChartTimeMarkerInput[] = [
    { ...nearest, label: nearest.tone === "auto" ? "reassess (auto)" : "reassess" },
    ...ranked.slice(1),
  ];
  if (labelled.length <= MAX_DRAWN_TIME_MARKERS) return labelled;

  const hidden = labelled.length - (MAX_DRAWN_TIME_MARKERS - 1);
  return [
    ...labelled.slice(0, MAX_DRAWN_TIME_MARKERS - 1),
    {
      key: "reassess-overflow",
      label: `+${hidden}`,
      // The furthest moment, so the tick marks how far out the queue runs
      // rather than piling onto the ones already drawn.
      at: labelled[labelled.length - 1]!.at,
      tone: "planned",
    },
  ];
}
