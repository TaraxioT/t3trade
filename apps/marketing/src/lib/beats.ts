/**
 * The one ordered list of mission beats (DESIGN-CONTRACT, "One mission state
 * drives everything"). Every scroll-scrubbed element in the cockpit replica
 * derives its animation range from this list by name: helpers below turn a
 * beat, a span of two beats, or a slice of one beat into the `--from/--to`
 * pair the shared scroll layer reads. No replica component carries a literal
 * timeline percentage of its own. Reweight a beat and the whole story
 * re-times consistently.
 *
 * The boundaries are the same numbers the page already played to, so this
 * table is an encoding of the existing timing, not a retelling.
 */

export const BEATS = [
  /* weight: share of the 100-point timeline the beat owns. */
  { name: "idle", weight: 1, note: "the quiet console arrives" },
  { name: "survey", weight: 8, note: "the agent reads the overnight range; grid rules in, early log rows" },
  { name: "plan", weight: 9, note: "plan published; target level, chip, and prediction draw" },
  { name: "watch-armed", weight: 14, note: "watch armed on the trigger; status flips to armed" },
  { name: "trigger-hit", weight: 15, note: "the watch fires; the break is marked, the met chip lands" },
  { name: "entry", weight: 6, note: "order worked and filled; entry level, long row, status long" },
  { name: "stop-placed", weight: 6, note: "reduce-only stop rests on-exchange; risk bar measures out" },
  { name: "wake-set", weight: 4, note: "wake level draws and the reward bar completes" },
  { name: "run", weight: 3, note: "the PnL reel starts counting; mark chip goes live" },
  { name: "wedge-open", weight: 10, note: "projection wedge opens; the price holds the mark" },
  { name: "drawdown", weight: 8, note: "price falls to the low; the stop flares and holds" },
  { name: "stop-holds", weight: 7, note: "recovery off the low" },
  { name: "target-hit", weight: 1, note: "the target prints; the status settles" },
  { name: "settle", weight: 8, note: "the check draws itself and the banked figures land" },
] as const;

export type BeatName = (typeof BEATS)[number]["name"];

/* Cumulative starts, computed once: run(63) -> wedge-open(66) etc. */
const START: Record<BeatName, number> = (() => {
  const starts = {} as Record<BeatName, number>;
  let at = 0;
  for (const beat of BEATS) {
    starts[beat.name] = round2(at);
    at += beat.weight;
  }
  return starts;
})();

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function beatStart(name: BeatName): number {
  return START[name];
}

export function beatEnd(name: BeatName): number {
  const index = BEATS.findIndex((beat) => beat.name === name);
  return round2(START[name] + BEATS[index].weight);
}

export function beatWidth(name: BeatName): number {
  return round2(beatEnd(name) - beatStart(name));
}

/* A point partway through a beat: beatPoint("entry", 1/2) is 50 in. */
export function beatPoint(name: BeatName, fraction: number): number {
  return round2(beatStart(name) + beatWidth(name) * fraction);
}

export function pct(value: number): string {
  const rounded = round2(value);
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(2)}%`;
}

/* The raw slice pair, for the rare span that crosses beats at hand-picked
   points. Inputs must themselves come from the beat helpers above. */
export function rangeOf(from: number, to: number): string {
  return `--from:${pct(from)};--to:${pct(to)}`;
}

/* A whole beat. */
export function beatSpan(name: BeatName): string {
  return rangeOf(beatStart(name), beatEnd(name));
}

/* From the start of beat a to the start of beat b: the natural
   "this element plays from that moment to that moment" form. */
export function beatRange(a: BeatName, b: BeatName): string {
  return rangeOf(beatStart(a), beatStart(b));
}

/* A sub-slice of one beat, as fractions of that beat. */
export function beatSlice(name: BeatName, from: number, to: number): string {
  return rangeOf(beatPoint(name, from), beatPoint(name, to));
}

/* How wide a log row's entrance is on the timeline, in percentage points. */
export const LOG_ROW_HOLD = 5;

/* A log row: it enters at `slot` (a fraction within its beat) and holds
   for LOG_ROW_HOLD points, exactly the way the feed stepped before the
   beat table existed. */
export function logRowSpan(beat: BeatName, slot: number): string {
  const from = beatPoint(beat, slot);
  return rangeOf(from, Math.min(from + LOG_ROW_HOLD, 100));
}

/* Which beat each story-critical state change hangs off, so the invariant
   test can assert prerequisites without re-deriving the wiring. */
export const STORY = {
  statusArmed: "watch-armed",
  statusLong: "entry",
  stopMark: "stop-placed",
  settledPnl: "settle",
  targetPrints: "target-hit",
} as const satisfies Record<string, BeatName>;
