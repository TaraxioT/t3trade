// ---------------------------------------------------------------------------
// missionTurnTimeline
// ---------------------------------------------------------------------------
//
// The turn timeline's pure half: mission projection → timeline cards, newest
// first. The panel renders; this module decides what a card IS.
//
// One card per WAKE (why it woke, what it read that turn, and what it
// decided), plus plan revision cards, journal note cards, and trade cards as
// their own kinds. Everything here is already pushed: `missionTimeline`
// carries the server's composed prose for every wake, publish, stop move and
// note, the wake entries also carry the run's recorded tool list, and
// `recentFills` carries every trade. One optional projection field was added
// for the reads line (the tool list), projected from data the run funnel
// already records.
//
// Wording rules (the plan's own register): plain language, no field names, no
// jargon, no em-dashes, times as clock times at render. Prose the server
// composed (a stop move's justification, a journal note) is quoted, so the
// only rewriting allowed is the em-dash swap — content is the author's own.

import { humanizeLiteral, formatPrice, formatSize, formatSignedUsd } from "./tradingPresentation";

/** How many turns the panel renders before it counts the rest. */
export const MAX_TURN_CARDS = 30;

/**
 * How long after a wake its decision can land and still be that wake's turn.
 *
 * A turn is the wake plus everything the harness did before the next one:
 * bounded by the NEXT wake where there is one, and by five minutes where there
 * is not, so a publish hours later is not attributed to a long-dead wake.
 */
const TURN_WINDOW_MILLIS = 5 * 60_000;

/** Which card kind a moment became. Drives the card's icon and tone. */
export type TurnCardKind = "wake" | "revision" | "note" | "trade";

/** One card of the timeline. Every field is display-ready text or null. */
export interface TurnTimelineCard {
  readonly kind: TurnCardKind;
  /**
   * Stable across polls and joinable both ways: a wake/revision/note id
   * matches the chart's past-marker moment (ids there are index-derived, so
   * the join is by time), and a trade id is the fill marker's own key.
   */
  readonly id: string;
  /** Epoch millis. The chart-side join and the clock time both read it. */
  readonly atMillis: number;
  /** The wake's trigger line: why the mission woke, in plain words. */
  readonly triggerLabel: string | null;
  /** The wake's read line: what the agent read and did that turn, in order. */
  readonly readLabel: string | null;
  /** The wake's decision line: the first thing the turn produced. */
  readonly decisionLabel: string | null;
  /** The secondary line: a justification, a note's body, a trade's net. */
  readonly detailLabel: string | null;
  /** A price the moment happened at, where it had one. */
  readonly priceLevel: number | null;
  /** Wakes the harness was owed and did not get, and losing trades. */
  readonly tone: "neutral" | "profit" | "loss";
}

/** Em-dashes are not allowed in card text; server prose arrives with them. */
export function deEmDash(text: string): string {
  return text.replaceAll(/\s*—\s*/g, " · ");
}

/**
 * Why a wake woke, in the plan's plain register.
 *
 * The timeline carries the run cause verbatim; a cause is a literal the
 * harness writes for itself, so the client translates. Unknown causes are
 * humanized rather than invented around: a new literal reads as itself.
 */
export function describeWakeTrigger(cause: string | undefined): string {
  switch (cause) {
    case "mission_created":
      return "The mission started";
    case "market_watch_triggered":
      return "A level it was watching was reached";
    case "scheduled_reassessment":
      return "A scheduled check-in came due";
    case "order_updated":
      return "The exchange reported an order change";
    case "position_updated":
      return "The exchange reported a position change";
    case "user_message":
      return "You wrote to it";
    case "mission_resumed":
      return "It was resumed";
    default:
      return cause === undefined ? "It woke" : deEmDash(humanizeLiteral(cause));
  }
}

/**
 * What a wake's turn read and did, in the plan's plain register.
 *
 * The server pushes the run's recorded tool names verbatim (the same funnel
 * list the decision report reads); a name is a literal the harness wrote for
 * itself, so the client translates, like the trigger. Unknown names are
 * humanized rather than hidden: a new tool reads as itself. Repeats collapse,
 * because the recorded list is one row per call.
 */
export function describeWakeReads(toolsCalled: ReadonlyArray<string>): string | null {
  const phrases = new Set<string>();
  for (const tool of toolsCalled) {
    switch (tool) {
      case "trading_look":
        phrases.add("looked at the market");
        break;
      case "trading_strategy":
        phrases.add("read a strategy sheet");
        break;
      case "trading_plan":
        phrases.add("revised the plan");
        break;
      case "trading_watch":
        phrases.add("changed a level it was watching");
        break;
      case "trading_enter":
        phrases.add("bought in");
        break;
      case "trading_exit":
        phrases.add("got out or adjusted");
        break;
      case "trading_journal":
        phrases.add("wrote a note");
        break;
      default:
        phrases.add(deEmDash(humanizeLiteral(tool)));
    }
  }
  return phrases.size === 0 ? null : [...phrases].join(" · ");
}

/** A decision entry's one line, or null when the entry is not a decision. */
function describeDecision(entry: { readonly kind: string; readonly label: string }): string | null {
  if (entry.kind === "strategy_published") return `It revised the plan (${entry.label})`;
  if (entry.kind === "stop_adjusted") return "It moved the stop";
  if (entry.kind === "journal") return "It wrote a note";
  return null;
}

/** A trade card's main line: what was bought or sold, and at what price. */
export function describeFill(
  market: string,
  fill: {
    readonly side?: string | undefined;
    readonly filledSize?: number | undefined;
    readonly avgFillPrice: number;
    readonly closedPnl: number;
    readonly direction?: string | undefined;
  },
): {
  readonly line: string;
  readonly detail: string | null;
  readonly tone: "neutral" | "profit" | "loss";
} {
  const size = fill.filledSize === undefined ? "" : `${formatSize(fill.filledSize)} `;
  const at = `at ${formatPrice(fill.avgFillPrice)}`;
  // `direction` says what the fill DID (open a long, close a short); `side`
  // alone cannot, and guessing from it would misname a reversal.
  const direction = fill.direction ?? null;
  const verb =
    direction === null
      ? null
      : direction.toLowerCase().startsWith("open")
        ? direction.toLowerCase().includes("short")
          ? "Sold to open a short"
          : "Bought to open"
        : direction.toLowerCase().includes("short")
          ? "Bought to close the short"
          : "Sold to close";
  const line =
    verb === null
      ? `${fill.side === "buy" ? "Bought" : "Sold"} ${size}${market} ${at}`
      : `${verb} ${size}${market} ${at}`;
  if (direction === null || direction.toLowerCase().startsWith("open")) {
    return { line, detail: null, tone: "neutral" };
  }
  return {
    line,
    detail: `net ${formatSignedUsd(fill.closedPnl)}`,
    tone: fill.closedPnl > 0 ? "profit" : fill.closedPnl < 0 ? "loss" : "neutral",
  };
}

/** The narrow slice of the projection the timeline is derived from. */
export interface TurnTimelineInput {
  readonly market: string;
  readonly missionTimeline: ReadonlyArray<{
    readonly at: string;
    readonly kind: string;
    readonly label: string;
    readonly cause?: string | undefined;
    readonly toolsCalled?: ReadonlyArray<string> | undefined;
    readonly author?: string | undefined;
    readonly priceLevel?: number | undefined;
  }>;
  readonly recentFills: ReadonlyArray<{
    readonly orderId: number;
    readonly tradedAt: string;
    readonly avgFillPrice: number;
    readonly closedPnl: number;
    readonly direction?: string | undefined;
    readonly side?: string | undefined;
    readonly filledSize?: number | undefined;
  }>;
}

/**
 * The turn timeline: one card per wake plus revision, note and trade cards,
 * newest first.
 *
 * A wake's decision is the first publish, stop move or note that landed after
 * it, before the next wake and inside the turn window — the same attribution
 * the watch stream's `actionLabel` makes, stated once more where the operator
 * reads the session. The decision entry still becomes its own card below; the
 * wake card carries the pointer, not the body.
 */
export function deriveTurnTimeline(input: TurnTimelineInput): {
  readonly cards: ReadonlyArray<TurnTimelineCard>;
  readonly earlierCount: number;
} {
  // Oldest first, unparseable times dropped: attribution scans forward.
  const entries = input.missionTimeline
    .map((entry) => ({
      kind: entry.kind,
      label: entry.label,
      cause: entry.cause,
      toolsCalled: entry.toolsCalled,
      author: entry.author,
      priceLevel: entry.priceLevel,
      at: Date.parse(entry.at),
    }))
    .filter((entry) => !Number.isNaN(entry.at))
    .sort((a, b) => a.at - b.at);

  const cards: TurnTimelineCard[] = [];

  entries.forEach((entry, index) => {
    const failed = entry.label.endsWith("(failed)");
    if (entry.kind === "wake") {
      // The turn's decision: first non-wake entry after the wake, inside the
      // window AND before the next wake — a publish after the next wake
      // belongs to that wake's turn, not this one's.
      const nextWakeAt = entries
        .slice(index + 1)
        .find((later) => later.kind === "wake" && later.at > entry.at);
      const bound = Math.min(entry.at + TURN_WINDOW_MILLIS, nextWakeAt?.at ?? Infinity);
      const decision = entries.find(
        (later) => later.at > entry.at && later.at <= bound && later.kind !== "wake",
      );
      cards.push({
        kind: "wake",
        id: `wake-${index}-${entry.at}`,
        atMillis: entry.at,
        triggerLabel: `${describeWakeTrigger(entry.cause)}${failed ? ", and the turn failed" : ""}`,
        readLabel: describeWakeReads(entry.toolsCalled ?? []),
        decisionLabel: decision === undefined ? null : describeDecision(decision),
        detailLabel: decision?.kind === "journal" ? deEmDash(decision.label) : null,
        priceLevel: null,
        tone: failed ? "loss" : "neutral",
      });
      return;
    }
    if (entry.kind === "strategy_published") {
      cards.push({
        kind: "revision",
        id: `rev-${index}-${entry.at}`,
        atMillis: entry.at,
        triggerLabel: `Plan revised (${entry.label})`,
        readLabel: null,
        decisionLabel: null,
        detailLabel: null,
        priceLevel: null,
        tone: "neutral",
      });
      return;
    }
    if (entry.kind === "stop_adjusted") {
      cards.push({
        kind: "revision",
        id: `stop-${index}-${entry.at}`,
        atMillis: entry.at,
        triggerLabel: "Stop moved",
        readLabel: null,
        decisionLabel: null,
        detailLabel: deEmDash(entry.label),
        priceLevel: entry.priceLevel ?? null,
        tone: "neutral",
      });
      return;
    }
    // journal: the model's (or the operator's) own words, as a card.
    cards.push({
      kind: "note",
      id: `note-${index}-${entry.at}`,
      atMillis: entry.at,
      triggerLabel: entry.author === "user" ? "You noted" : "It noted",
      readLabel: null,
      decisionLabel: null,
      detailLabel: deEmDash(entry.label),
      priceLevel: null,
      tone: "neutral",
    });
  });

  for (const fill of input.recentFills) {
    const at = Date.parse(fill.tradedAt);
    if (Number.isNaN(at)) continue;
    const described = describeFill(input.market, fill);
    cards.push({
      kind: "trade",
      // The fill marker's own key, so a hovered circle on the chart joins to
      // this card by id, not only by moment.
      id: `${fill.orderId}-${fill.tradedAt}`,
      atMillis: at,
      triggerLabel: described.line,
      readLabel: null,
      decisionLabel: null,
      detailLabel: described.detail,
      priceLevel: fill.avgFillPrice,
      tone: described.tone,
    });
  }

  cards.sort((a, b) => b.atMillis - a.atMillis);
  const shown = cards.slice(0, MAX_TURN_CARDS);
  return { cards: shown, earlierCount: cards.length - shown.length };
}
