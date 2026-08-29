import type { MarketWatch, PersistedWatch, PersistedWatchStatus } from "@t3tools/trading-contracts";

import {
  formatPrice,
  formatSignedUsd,
  formatSize,
  formatUsd,
  humanizeLiteral,
} from "./tradingFormat";
import { readFillLifecycle } from "./tradingPositionLifecycle";
// ---------------------------------------------------------------------------
// armed-conditions checklist (state 04)
// ---------------------------------------------------------------------------
//
// A flat mission holding authority is "armed" while it has active watches:
// each one is a deterministic predicate the evaluator will wake it for (§11.3),
// and the prototype's conditions checklist reads them back as a row per
// condition, showing the live number a watch is measuring against rather than a
// bare checkbox. The server carries `lastObservedValue` / `lastEvaluatedAt` on
// each watch, and this derivation flattens those into a render-ready shape.
//
// Pure, like {@link deriveStrategyPlan}: the React component holds no logic of
// its own. The predicate is never re-evaluated client-side — `met` comes from
// `status === "triggered"`, which the server already tracks.

/** One row of the armed-conditions checklist. */
export interface WatchConditionRow {
  /** The watch's id, for React keys. */
  readonly id: string;
  /** One line describing what the predicate is waiting for. */
  readonly description: string;
  /** The watch's lifecycle status, for the ✓/○ glyph. */
  readonly status: PersistedWatchStatus;
  /**
   * The value the evaluator last read for this predicate (mark/mid price for
   * `price_cross`, unrealised PnL for `pnl_below`, drawdown for
   * `pnl_giveback`). Null when the watch has never been swept.
   *
   * `pnl_above` is the one that is not gross: the target is compared net of
   * the taker fee the exit has yet to pay, and this is the net figure, so the
   * row and the predicate agree about how far away the threshold is.
   */
  readonly observedValue: number | null;
  /**
   * The threshold the predicate is measuring against (`price` for `price_cross`,
   * `valueUsd`/`drawdownUsd` for the PnL watches). Null for `scheduled_reassessment`,
   * which carries no numeric level.
   */
  readonly thresholdValue: number | null;
  /** True when the predicate has fired (`status === "triggered"`). */
  readonly met: boolean;
  /** When the evaluator last swept this watch, epoch millis. */
  readonly evaluatedAt: number | null;
}

/**
 * The armed-conditions checklist, derived from a mission's watches.
 *
 * `rows` carries one row per active numeric or lifecycle watch. `nextReassessmentAt`
 * is the earliest `runAt` among active `scheduled_reassessment` watches — the
 * countdown the card shows next to its title. Returns null when no watch is
 * active, so the card is absent rather than empty.
 */
export interface ArmedConditions {
  readonly rows: ReadonlyArray<WatchConditionRow>;
  /** Epoch millis of the next scheduled reassessment, or null when none is armed. */
  readonly nextReassessmentAt: number | null;
}

/**
 * Describe a watch predicate as one line, without interpreting it.
 *
 * Inlined separately from {@link describeWatch} so the derivation covers the
 * full `MarketWatch` union (`pnl_below` / `pnl_giveback` included) regardless of
 * the pre-existing gap in that function.
 */
function describeWatchCondition(watch: MarketWatch): string {
  switch (watch.type) {
    case "price_cross":
      return `${watch.market} ${watch.priceSource} crosses ${watch.direction} ${formatPrice(watch.price)}`;
    case "candle_close":
      return `${watch.market} ${watch.interval} candle closes ${watch.direction} ${formatPrice(watch.price)}`;
    case "order_update":
      return `Order ${watch.cloid} updates`;
    case "position_update":
      return `${watch.market} position updates`;
    case "scheduled_reassessment":
      return `Scheduled reassessment`;
    case "pnl_above":
      // Net of the exit it has yet to pay: the evaluator subtracts the taker
      // fee on the way out before it compares, so a target that fires is one
      // the mission can actually bank.
      return `${watch.market} PnL net of the exit reaches ${formatUsd(watch.valueUsd)}`;
    case "pnl_below":
      return `${watch.market} unrealised PnL falls to ${formatSignedUsd(watch.valueUsd)}`;
    case "pnl_giveback":
      return `${watch.market} PnL gives back ${formatUsd(watch.drawdownUsd)}`;
    case "metric_threshold":
      // "ETH volume ratio above 2" / "ETH funding rate 8h below -0.0001":
      // the metric named in plain words, the threshold as the raw number the
      // evaluator compares — a formatter that guessed units would lie about
      // at least one metric.
      return `${watch.market} ${humanizeLiteral(watch.metric)} ${watch.direction} ${watch.value}`;
    case "metric_derived":
      // Same rule as above: the metric in plain words, the threshold as the
      // raw number the evaluator compares.
      return watch.direction === undefined
        ? `${watch.market} ${humanizeLiteral(watch.metric)} flips`
        : `${watch.market} ${humanizeLiteral(watch.metric)} ${watch.direction} ${watch.value}`;
  }
}

/**
 * Whether this predicate only means anything while a position is held.
 *
 * All three are measured against unrealised PnL, which is zero and meaningless
 * when flat — so the server retires them with the position rather than leaving
 * them to fire at a trade that is over. The stream says "retired" for those and
 * keeps "replaced" for a level a replan swapped out.
 */
function isPositionScopedWatch(watch: MarketWatch): boolean {
  return watch.type === "pnl_above" || watch.type === "pnl_below" || watch.type === "pnl_giveback";
}

/**
 * Read the threshold value off a watch predicate, where one exists.
 *
 * `scheduled_reassessment` and the event watches carry no numeric level, so they
 * return null.
 */
function readWatchThreshold(watch: MarketWatch): number | null {
  switch (watch.type) {
    case "price_cross":
    case "candle_close":
      return watch.price;
    case "pnl_above":
    case "pnl_below":
      return watch.valueUsd;
    case "pnl_giveback":
      return watch.drawdownUsd;
    case "metric_threshold":
      return watch.value;
    // A flip metric carries no threshold; everything else on the derived kind
    // does.
    case "metric_derived":
      return watch.value ?? null;
    case "order_update":
    case "position_update":
    case "scheduled_reassessment":
      return null;
  }
}

/**
 * Which side of its threshold a predicate waits on, where that means anything.
 *
 * The stream draws this as the chart gutter's own ▲ / ▼ glyph, so a row and the
 * dotted line it belongs to read as one object in two places. A give-back
 * measures a fall from a moving high-water mark rather than a fixed side, and
 * the event watches compare nothing, so all three return null.
 */
function readWatchDirection(watch: MarketWatch): "above" | "below" | null {
  switch (watch.type) {
    case "price_cross":
    case "candle_close":
    case "metric_threshold":
      return watch.direction;
    case "metric_derived":
      // A flip fires on the change itself, so it waits on no side.
      return watch.direction ?? null;
    case "pnl_above":
      return "above";
    case "pnl_below":
      return "below";
    case "pnl_giveback":
    case "order_update":
    case "position_update":
    case "scheduled_reassessment":
      return null;
  }
}

/**
 * The short qualifier that follows the row's figure.
 *
 * A candle close is only meaningful with the bar it closes on, and a metric
 * threshold is only meaningful with the metric it reads — both are the same
 * slot in the row, because both answer "the figure is what, exactly".
 */
function readWatchQualifier(watch: MarketWatch): string | null {
  if (watch.type === "candle_close") return watch.interval;
  if (watch.type === "metric_threshold" || watch.type === "metric_derived") {
    return humanizeLiteral(watch.metric);
  }
  return null;
}

/**
 * The armed-conditions checklist, or null when nothing is armed.
 *
 * The card is gated on at least one `active` watch (the mission must still hold
 * something that can wake it). Once it is armed, the row list shows both the
 * conditions already met (`triggered`, a ticked ✓) and those still waiting
 * (`active`, an empty ○) — the prototype reads each row back with its glyph, and
 * a checklist that hid the satisfied ones would read as a mission waiting on
 * conditions it had already cleared. `consumed` / `cancelled` / `expired` /
 * `superseded` watches are history and never make a row.
 *
 * `scheduled_reassessment` watches are excluded from `rows` (they carry no
 * numeric level the checklist could show) and instead contribute to
 * `nextReassessmentAt`, the countdown the card renders in its header. Only
 * active reassessments count toward that countdown: a triggered one has fired.
 */
export function deriveWatchConditions(mission: {
  readonly watches: ReadonlyArray<PersistedWatch>;
}): ArmedConditions | null {
  const active = mission.watches.filter((persisted) => persisted.status === "active");
  if (active.length === 0) return null;

  let nextReassessmentAt: number | null = null;
  for (const persisted of active) {
    const watch = persisted.watch;
    if (watch.type !== "scheduled_reassessment") continue;
    if (nextReassessmentAt === null || watch.runAt < nextReassessmentAt) {
      nextReassessmentAt = watch.runAt;
    }
  }

  const rows: WatchConditionRow[] = [];
  for (const persisted of mission.watches) {
    // `triggered` is kept (a met row shows ✓); `active` is kept (a waiting row
    // shows ○). Everything else is terminal and dropped.
    if (persisted.status !== "active" && persisted.status !== "triggered") continue;

    const watch = persisted.watch;
    if (watch.type === "scheduled_reassessment") continue;

    rows.push({
      id: persisted.id,
      description: describeWatchCondition(watch),
      status: persisted.status,
      observedValue: persisted.lastObservedValue ?? null,
      thresholdValue: readWatchThreshold(watch),
      met: persisted.status === "triggered",
      evaluatedAt: persisted.lastEvaluatedAt ?? null,
    });
  }

  return { rows, nextReassessmentAt };
}

// ---------------------------------------------------------------------------
// The watch stream — one list, armed at the top and everything settled beneath
// it, newest first.
// ---------------------------------------------------------------------------

/**
 * Where a watch is in its life.
 *
 * Four states because four things can happen to a watch and the operator needs
 * to tell them apart: it is still waiting, its predicate matched, someone took
 * it down, or its clock ran out. `replaced` is `disarmed` with a different word
 * in the row — a newer prediction moved the level, which is not the same event
 * as a level being cancelled, but it is the same fact about the watch.
 */
export type WatchLifecycleState = "armed" | "triggered" | "disarmed" | "expired";

/** Every watch predicate that can make a stream row (a reassessment cannot). */
export type WatchRowType = Exclude<MarketWatch["type"], "scheduled_reassessment">;

/** One row of the stream: a watch, where it is, and what it belongs to. */
export interface WatchStreamRow {
  /** Discriminates a single watch from a supersession group in the same list. */
  readonly kind: "watch";
  readonly id: string;
  readonly state: WatchLifecycleState;
  /** One line describing what the predicate is (or was) waiting for. */
  readonly description: string;
  /**
   * The predicate's own type. The row renders an icon per type, and reading the
   * type off the description string would be the panel parsing its own prose.
   */
  readonly watchType: WatchRowType;
  /**
   * Which side of the threshold the predicate waits on, where it has one. Null
   * for the event watches and for a give-back, which measure no direction.
   */
  readonly direction: "above" | "below" | null;
  /**
   * The short qualifier that follows the figure: a candle's interval, or a
   * metric's name in plain words. Null when the type has neither.
   */
  readonly intervalLabel: string | null;
  /**
   * The word the row shows for how it ended. `armed` rows carry null — they
   * have not ended. Distinguishes `replaced` from `cancelled`, which share a
   * dot but not a cause.
   */
  readonly outcomeLabel: string | null;
  /** Epoch millis: when it was armed, or when it settled. */
  readonly atMillis: number;
  /**
   * The plan version whose projection this was armed for, when the runtime
   * armed it for one. Null for everything the harness armed itself.
   */
  readonly predictionVersion: number | null;
  /** The live reading the evaluator last took, for a row still waiting. */
  readonly observedValue: number | null;
  /** The number the predicate compares against, where it has one. */
  readonly thresholdValue: number | null;
  /**
   * The first thing the mission did at or after the watch fired, read off the
   * timeline: a plan publish or stop move wins over the wake itself, because
   * "woke" is the mechanism and the publish is the decision. Null on rows that
   * did not fire, and on firings the timeline has not caught up with.
   */
  readonly actionLabel: string | null;
}

/**
 * A burst of take-downs, folded into one row.
 *
 * Every replan supersedes the previous prediction's watches, so one
 * reassessment retires three to six levels in the same tick. Left as
 * individual rows they open the settled half with a wall of near-identical
 * "cancelled" lines, and the row the operator came for — the one that fired —
 * is pushed off screen by administrative churn.
 */
export interface WatchStreamGroup {
  readonly kind: "group";
  /** Stable across polls: derived from the newest member's id. */
  readonly id: string;
  readonly count: number;
  /** `replaced` when every member was superseded, `retired` when they are mixed. */
  readonly outcomeLabel: "replaced" | "retired";
  /** The newest member's settle time, which is what the group's age reads from. */
  readonly atMillis: number;
  /** Newest first, so expanding the group reads in the same order as the stream. */
  readonly members: ReadonlyArray<WatchStreamRow>;
}

/** One entry in the stream: a watch, or a burst of take-downs standing for several. */
export type WatchStreamItem = WatchStreamRow | WatchStreamGroup;

/** Whether this entry is still live, which is what orders the stream. */
export function isArmedRow(item: WatchStreamItem): boolean {
  return item.kind === "watch" && item.state === "armed";
}

/**
 * How close two take-downs must settle to count as the same burst.
 *
 * One replan writes its supersessions inside a single transaction, so the real
 * spread is milliseconds; five seconds is slack for a slow write, and short
 * enough that two separate reassessments never merge into one row.
 */
const SUPERSESSION_BURST_MILLIS = 5_000;

/** Whether this settled row is a take-down, which is the only thing that groups. */
function isTakeDownRow(row: WatchStreamRow): boolean {
  return row.outcomeLabel === "replaced" || row.outcomeLabel === "cancelled";
}

/**
 * Fold consecutive take-downs that settled together into one row each.
 *
 * Only take-downs group. A firing is an event the operator follows to the
 * decision it produced, and an expiry is a level the mission let lapse; both
 * stay individual however many land at once. A burst of one is left as the
 * ordinary row it already was — group chrome for a lone cancel would be a
 * disclosure over a single line.
 */
function groupSupersessionBursts(
  settled: ReadonlyArray<WatchStreamRow>,
): ReadonlyArray<WatchStreamItem> {
  const items: WatchStreamItem[] = [];
  let index = 0;

  while (index < settled.length) {
    const first = settled[index]!;
    if (!isTakeDownRow(first)) {
      items.push(first);
      index += 1;
      continue;
    }

    // The window is anchored on the burst's newest member rather than chained
    // member to member, so a long drizzle of cancels cannot drift into one
    // group that spans minutes.
    const burst: WatchStreamRow[] = [first];
    let next = index + 1;
    while (next < settled.length) {
      const candidate = settled[next]!;
      if (!isTakeDownRow(candidate)) break;
      if (first.atMillis - candidate.atMillis > SUPERSESSION_BURST_MILLIS) break;
      burst.push(candidate);
      next += 1;
    }

    if (burst.length === 1) {
      items.push(first);
    } else {
      items.push({
        kind: "group",
        id: `group-${first.id}`,
        count: burst.length,
        outcomeLabel: burst.every((row) => row.outcomeLabel === "replaced")
          ? "replaced"
          : "retired",
        atMillis: first.atMillis,
        members: burst,
      });
    }
    index = next;
  }

  return items;
}

/**
 * Every watch the mission has, as one ordered stream.
 *
 * This used to be two derivations feeding two lists under two headings: a
 * checklist of what was armed, and a separate scrollback of what had fired.
 * They are the same objects at different points in one life, and splitting
 * them meant a watch disappeared from one list and reappeared in another — the
 * single event the operator most wants to follow was the one the layout hid.
 *
 * Armed rows come first, in the order the projection gave them. Everything
 * settled follows, newest first. `scheduled_reassessment` watches stay out of
 * both halves: they carry no level, and the panel already counts down to the
 * next one in its header.
 */
export function deriveWatchLifecycle(mission: {
  readonly watches: ReadonlyArray<PersistedWatch>;
  readonly missionTimeline: ReadonlyArray<{
    readonly at: string;
    readonly kind: "wake" | "stop_adjusted" | "strategy_published" | "journal" | "validation_event";
    readonly label: string;
  }>;
}): { readonly stream: ReadonlyArray<WatchStreamItem> } {
  // Timeline entries as (millis, kind, label), oldest first, so "the first
  // thing after the firing" is a forward scan.
  const timeline = mission.missionTimeline
    .map((entry) => ({ at: Date.parse(entry.at), kind: entry.kind, label: entry.label }))
    .filter((entry) => !Number.isNaN(entry.at))
    .sort((a, b) => a.at - b.at);

  const actionAfter = (firedAt: number): string | null => {
    // The wake for this firing lands within moments; the decision it produced
    // (a publish, a stop move) lands within the turn. Prefer the decision.
    const after = timeline.filter((entry) => entry.at >= firedAt - 2_000);
    // A validation event is news the turn was handed, not a decision it took.
    // Attributing one to a fired price level would label the firing "paper
    // long opened on ETH" — a sentence about a different market event.
    const decision = after.find(
      (entry) => entry.kind !== "wake" && entry.kind !== "validation_event",
    );
    if (decision !== undefined) return decision.label;
    const wake = after.find((entry) => entry.kind === "wake");
    return wake === undefined ? null : wake.label;
  };

  const armed: WatchStreamRow[] = [];
  const settled: WatchStreamRow[] = [];

  for (const persisted of mission.watches) {
    const watch = persisted.watch;
    if (watch.type === "scheduled_reassessment") continue;
    // Order lifecycle rows live in the positions card now (plan 39 phase 2):
    // the ledger draws the order itself, so a watch row saying "order X
    // updates" would be the same fact twice in two vocabularies.
    if (watch.type === "order_update") continue;

    const shared = {
      kind: "watch" as const,
      id: persisted.id,
      description: describeWatchCondition(watch),
      watchType: watch.type,
      direction: readWatchDirection(watch),
      intervalLabel: readWatchQualifier(watch),
      predictionVersion: persisted.predictionVersion ?? null,
      thresholdValue: readWatchThreshold(watch),
    };

    if (persisted.status === "active") {
      armed.push({
        ...shared,
        state: "armed",
        outcomeLabel: null,
        atMillis: persisted.createdAt,
        observedValue: persisted.lastObservedValue ?? null,
        actionLabel: null,
      });
      continue;
    }

    const fired = persisted.status === "triggered" || persisted.status === "consumed";
    settled.push({
      ...shared,
      state: fired
        ? "triggered"
        : persisted.status === "expired"
          ? "expired"
          : // `cancelled` and `superseded` both mean the level was taken down
            // rather than reached. The word below says which.
            "disarmed",
      outcomeLabel: fired
        ? null
        : persisted.status === "superseded"
          ? // A superseded price level was replaced by the plan that took it
            // down. A superseded PnL watch was not: nothing replaces it, the
            // position it measured ended and it went with the position.
            isPositionScopedWatch(watch)
            ? "retired"
            : "replaced"
          : persisted.status,
      atMillis: persisted.updatedAt,
      observedValue: persisted.lastObservedValue ?? null,
      actionLabel: fired ? actionAfter(persisted.updatedAt) : null,
    });
  }

  settled.sort((a, b) => b.atMillis - a.atMillis);
  return { stream: [...armed, ...groupSupersessionBursts(settled)] };
}

/** A drawable chart level derived from one armed watch. */
export interface DrawableCondition {
  readonly price: number;
  readonly direction: "above" | "below";
  readonly met: boolean;
  /**
   * The persisted watch id behind this level, when the row carried one.
   * Carried for the chart's hover selection — a level chip and its watch-list
   * row are the same object, and the id is the join.
   */
  readonly id?: string;
}

/**
 * The exposure a PnL watch has to be resolved against to become a price.
 *
 * Both figures come from the position snapshot. `size` is signed — that sign is
 * what decides which way price has to move for PnL to rise.
 */
export interface PnlLevelBasis {
  readonly entryPrice: number;
  readonly size: number;
}

/**
 * Turn an unrealised-PnL threshold into the price that produces it.
 *
 * `pnl = size × (mark − entry)`, so `mark = entry + pnl / size`. The signed
 * size carries the direction for free: a short's `size` is negative, so a
 * profit target resolves BELOW its entry, which is exactly where a short's
 * profit lives. Null without an exposure to divide by — a flat mission's PnL
 * watch has no price, and inventing one would put a line on the chart at a
 * level nothing is actually watching.
 */
export function derivePnlLevelPrice(valueUsd: number, basis: PnlLevelBasis | null): number | null {
  if (basis === null || basis.size === 0) return null;
  return basis.entryPrice + valueUsd / basis.size;
}

/**
 * The armed price levels a chart can draw; nearest-first is the caller's job.
 *
 * Three watch types resolve to a y. `price_cross` and `candle_close` carry a
 * price outright. `pnl_above` and `pnl_below` carry one too, once there is a
 * position to resolve them against — and those are the levels that matter most
 * while exposed, because they are where the plan has decided to bank a winner
 * or cut a loser. They used to be dropped as "no y on a price chart", which was
 * true only of a flat mission.
 *
 * `pnl_giveback` still has no level: it is measured from the position's peak
 * unrealised PnL, and `TradingPositionView` does not carry the peak even though
 * the reconciler records it. It stays a checklist row until the projection
 * surfaces `peakUnrealisedPnl`.
 *
 * A `pnl_above` line is drawn at the price that produces its threshold GROSS,
 * while the evaluator fires it net of the exit fee — so the real wake sits a
 * fee's worth further out (cents of price on a position this size). The
 * projection carries no fee rate, and a line drawn from a guessed one would be
 * wrong in a way nothing could check.
 */
export function deriveChartConditions(
  mission: { readonly watches: ReadonlyArray<PersistedWatch> },
  /** The open position, when there is one. Null while flat. */
  basis: PnlLevelBasis | null = null,
): ReadonlyArray<DrawableCondition> {
  const drawable: DrawableCondition[] = [];

  for (const persisted of mission.watches) {
    if (persisted.status !== "active" && persisted.status !== "triggered") continue;
    // A watch that has already fired is context while the position it fired
    // for is still open — "this is the level that woke me". Once the mission
    // is flat it is a level nothing is waiting on, and leaving it drawn is how
    // a closed trade's stop and target stayed on the chart with ticks beside
    // them for the rest of the session.
    if (persisted.status === "triggered" && basis === null) continue;
    const watch = persisted.watch;
    const met = persisted.status === "triggered";

    if (watch.type === "price_cross" || watch.type === "candle_close") {
      drawable.push({ price: watch.price, direction: watch.direction, met, id: persisted.id });
      continue;
    }

    if (watch.type === "pnl_above" || watch.type === "pnl_below") {
      const valueUsd = watch.valueUsd;
      const price = derivePnlLevelPrice(valueUsd, basis);
      if (price === null) continue;
      // Which way price must move to satisfy the watch. PnL rises with price
      // on a long and falls with it on a short, so a short's profit target is
      // a "below" and its loss floor is an "above".
      const pnlRisesWithPrice = basis!.size > 0;
      const wantsPnlUp = watch.type === "pnl_above";
      drawable.push({
        price,
        direction: wantsPnlUp === pnlRisesWithPrice ? "above" : "below",
        met,
        id: persisted.id,
      });
    }
  }

  return drawable;
}

/**
 * The moment the plan's armed entry triggers stop being the current plan.
 *
 * A plan states how long it stays fresh untriggered (`reassess.afterMinutes`),
 * measured from the publish that authored it. That is the honest right-hand
 * bound on drawing an entry trigger into the future: past it the mission is
 * meant to be reassessing, not still waiting at that price.
 *
 * Null once there is a position — `reassess` is about an *untriggered* plan,
 * and the levels a holding mission watches (its profit rung, its stop
 * proximity) are not on that clock. Null too without a plan to read.
 */
export function deriveTriggerExpiryMillis(mission: {
  readonly position?: { readonly size: number } | null;
  readonly strategy: {
    readonly updatedAt: number;
    readonly reassess: { readonly afterMinutes: number };
  } | null;
}): number | null {
  const strategy = mission.strategy;
  if (strategy === null) return null;
  if ((mission.position?.size ?? 0) !== 0) return null;
  const minutes = strategy.reassess?.afterMinutes;
  if (typeof minutes !== "number" || !(minutes > 0)) return null;
  return strategy.updatedAt + minutes * 60_000;
}

/**
 * What a fill was, in the one dimension a chart marker can carry.
 *
 * An open and a close are the two ends of a position's life, and a close is
 * worth colouring by what it realised — the chart is then a record of every
 * position the session took, not only the one it is in.
 */
export type ChartFillKind =
  | "open"
  | "close_profit"
  | "close_loss"
  | "close_flat"
  | "unknown"
  /**
   * A forward validation's paper trades. Separate kinds rather than a flag on
   * the existing ones because they must never read as fills: nothing was
   * bought, nothing was sold, and a chart that draws them identically is
   * telling the viewer their account did something it did not. The renderer
   * draws them hollow and dashed for the same reason.
   */
  | "paper_open"
  | "paper_profit"
  | "paper_loss"
  | "paper_flat";

/** One fill, ready to be placed on the chart's time axis. */
export interface ChartFillMarker {
  readonly key: string;
  /** Epoch millis of the fill. */
  readonly at: number;
  readonly price: number;
  readonly kind: ChartFillKind;
  /**
   * The tooltip line, composed from the fill's own figures: side, size, price
   * and, for a close, the net it realised. Null when the projection row
   * carried none of them — the marker then says only what its shape says.
   */
  readonly label?: string | null;
}

/**
 * Every fill in the mission, as markers for the chart's time axis.
 *
 * The panel used to draw only the current entry, so a session that had opened
 * and closed twice before the trade on screen showed no sign of either. These
 * are the session's activity: where it went in, where it came out, and whether
 * coming out paid.
 *
 * A fill whose `direction` the exchange did not label reads as `unknown` rather
 * than being guessed at — `side` alone cannot tell an open from a close.
 * Unparseable timestamps are dropped; there is no honest x for them.
 */
export function deriveChartFillMarkers(mission: {
  readonly recentFills: ReadonlyArray<{
    readonly orderId: number;
    readonly tradedAt: string;
    readonly avgFillPrice: number;
    readonly closedPnl: number;
    readonly direction?: string | undefined;
    readonly side?: string | undefined;
    readonly filledSize?: number | undefined;
  }>;
}): ReadonlyArray<ChartFillMarker> {
  const markers: ChartFillMarker[] = [];

  for (const fill of mission.recentFills) {
    const at = Date.parse(fill.tradedAt);
    if (Number.isNaN(at)) continue;

    const lifecycle = readFillLifecycle(fill.direction);
    const kind: ChartFillKind =
      lifecycle === null
        ? "unknown"
        : lifecycle.action === "open"
          ? "open"
          : fill.closedPnl > 0
            ? "close_profit"
            : fill.closedPnl < 0
              ? "close_loss"
              : "close_flat";

    // The tooltip: side, size, price, and the net a close realised. Each piece
    // is included only when the projection row carried it, so a sparse fill
    // reads as a sparse fact rather than a row of em-dashes.
    const labelParts: string[] = [];
    if (fill.side !== undefined) labelParts.push(fill.side);
    if (fill.filledSize !== undefined) labelParts.push(formatSize(fill.filledSize));
    labelParts.push(formatPrice(fill.avgFillPrice));
    if (kind !== "open" && kind !== "unknown" && fill.closedPnl !== 0) {
      labelParts.push(`${formatSignedUsd(fill.closedPnl)} net`);
    }
    const label = labelParts.join(" · ");

    markers.push({
      key: `${fill.orderId}-${fill.tradedAt}`,
      at,
      price: fill.avgFillPrice,
      kind,
      label: label === "" ? null : label,
    });
  }

  return markers;
}
