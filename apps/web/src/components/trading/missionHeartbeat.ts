// ---------------------------------------------------------------------------
// missionHeartbeat
// ---------------------------------------------------------------------------
//
// The heartbeat sentence: what the agent is doing, in one line a non-trader
// can read. This module is ONE pure function from mission state to a sentence;
// the strip that renders it (MissionLivePanel) holds no wording of its own.
//
// Rules the wording must keep (the brief's own):
//   - no field names, no jargon; times as clock times;
//   - the candle interval in "a 5m candle closes above" comes from the WATCH'S
//     OWN interval data, never hard-coded;
//   - a number appears at most once, and a missing number omits its clause
//     rather than guessing.
//
// Every clause is optional at the input boundary, so fixture states (flat,
// armed, holding, stand-aside, blocked) can be sparsely populated in tests
// exactly as sparse projections are in production.

import { formatPrice, formatSize } from "./tradingPresentation";

/** The armed price watch the heartbeat speaks for: the plan's nearest trigger. */
export interface HeartbeatWatch {
  /**
   * "candle_close" waits for a bar on its own interval to finish beyond the
   * level; "price_cross" fires the moment the mark trades through it. The
   * sentence differs because the promise differs.
   */
  readonly kind: "candle_close" | "price_cross";
  readonly direction: "above" | "below";
  readonly price: number;
  /**
   * The watch's own bar interval as a short label ("5m"), already rendered
   * from the watch data by the caller. Null on a price_cross, which measures
   * no bars.
   */
  readonly intervalLabel: string | null;
}

/** The position the heartbeat reports on, null while flat. */
export interface HeartbeatPosition {
  /** Signed: positive is long, negative is short. */
  readonly size: number;
  readonly entryPrice: number | null;
  readonly unrealisedPnl: number;
  /** Where the plan banks the profit, null when it stated none. */
  readonly targetPrice: number | null;
  /** The price that ends the trade for a loss, null when unprotected. */
  readonly stopPrice: number | null;
}

export interface HeartbeatInput {
  /** Which sentence shape to compose; the panel derives this from the projection. */
  readonly state: "planning" | "armed" | "holding" | "stand_aside" | "blocked";
  readonly market: string;
  /** The armed price watch to speak for, in the armed state. */
  readonly watch: HeartbeatWatch | null;
  /** The next scheduled reassessment, in epoch millis. */
  readonly nextCheckInAt: number | null;
  readonly position: HeartbeatPosition | null;
  /** The plan's narrative, whose first clause a stand-aside quotes. */
  readonly because: string | null;
  /** Why a blocked mission is standing down, already humanized. */
  readonly blockedReason: string | null;
  /** Wall clock, so the check-in can be said as a clock time. */
  readonly nowMillis: number;
}

/** "14:32" from epoch millis, in the host locale. */
function clockTime(atMillis: number): string {
  return new Date(atMillis).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * The first clause of the plan's narrative: everything up to the first period
 * or semicolon, trimmed and bounded. A stand-aside quotes it because the whole
 * sentence will not fit the strip, and the opening clause is where the reason
 * lives.
 */
export function firstClause(because: string | null): string | null {
  if (because === null) return null;
  const clause = because.split(/[.;]/)[0]!.trim();
  if (clause === "") return null;
  // Bounded so a single run-on sentence cannot fill the strip on its own; the
  // ellipsis says the plan says more, which is true and is the hover's job.
  return clause.length > 90 ? `${clause.slice(0, 89).trimEnd()}…` : clause;
}

/** The armed watch's clause: "will act if a 5m candle closes above 4,290". */
function watchClause(market: string, watch: HeartbeatWatch): string {
  const level = `${formatPrice(watch.price)}`;
  if (watch.kind === "candle_close") {
    // The interval is the watch's own data. Absent (a malformed row), the
    // sentence says "a candle" rather than inventing a bar size.
    const bars = watch.intervalLabel === null ? "a candle" : `a ${watch.intervalLabel} candle`;
    return `will act if ${bars} closes ${watch.direction} ${level}`;
  }
  return `will act if ${market} trades ${watch.direction} ${level}`;
}

/** "Long 0.12 ETH from 4,251 · up $8.40 · banking at 4,318, out below 4,205". */
function holdingSentence(market: string, position: HeartbeatPosition): string {
  const side = position.size > 0 ? "Long" : "Short";
  const isLong = position.size > 0;
  const segments = [
    `${side} ${formatSize(Math.abs(position.size))} ${market}${
      position.entryPrice === null ? "" : ` from ${formatPrice(position.entryPrice)}`
    }`,
    position.unrealisedPnl === 0
      ? "flat"
      : `${position.unrealisedPnl > 0 ? "up" : "down"} $${Math.abs(position.unrealisedPnl).toFixed(
          2,
        )}`,
  ];
  // The bracket, as one clause: where it banks, and where it is out. Either
  // half alone still reads; neither is invented.
  const bracket: string[] = [];
  if (position.targetPrice !== null)
    bracket.push(`banking at ${formatPrice(position.targetPrice)}`);
  if (position.stopPrice !== null) {
    bracket.push(`out ${isLong ? "below" : "above"} ${formatPrice(position.stopPrice)}`);
  }
  if (bracket.length > 0) segments.push(bracket.join(", "));
  return segments.join(" · ");
}

/**
 * Compose the heartbeat sentence. Pure: same input, same string, no clock
 * reads (the caller passes `nowMillis`), no locale of its own beyond what the
 * clock formatter itself uses.
 */
export function composeHeartbeatSentence(input: HeartbeatInput): string {
  if (input.state === "blocked") {
    const reason = input.blockedReason === null ? "paused by the operator" : input.blockedReason;
    return `Standing down: ${reason} · nothing trades until it is resumed`;
  }
  if (input.state === "planning") {
    return `Reading ${input.market} · first plan pending`;
  }
  if (input.state === "holding" && input.position !== null) {
    return holdingSentence(input.market, input.position);
  }
  if (input.state === "stand_aside") {
    const clause = firstClause(input.because);
    const checkIn =
      input.nextCheckInAt === null ? null : `re-reading at ${clockTime(input.nextCheckInAt)}`;
    const segments = [
      `Standing aside${clause === null ? "" : `: ${clause}`}`,
      ...(checkIn === null ? [] : [checkIn]),
    ];
    return segments.join(" · ");
  }
  // armed (and holding with no position row, which reads the same to a glance)
  const watchSegment =
    input.watch === null ? "waiting on the plan's moment" : watchClause(input.market, input.watch);
  const checkIn =
    input.nextCheckInAt === null ? null : `next check-in ${clockTime(input.nextCheckInAt)}`;
  return [
    `Watching ${input.market} · ${watchSegment}`,
    ...(checkIn === null ? [] : [checkIn]),
  ].join(" · ");
}
