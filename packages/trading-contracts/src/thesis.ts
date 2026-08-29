/**
 * A trading thesis, as structured data.
 *
 * The user says "buy when RSI(14) drops under 30 and price is still above the
 * 50 EMA, get out at two R or after 48 bars". That sentence is a complete,
 * testable idea, and the only thing standing between it and a backtest is a
 * shape to put it in. This is that shape.
 *
 * Deliberately NOT a language. There is no expression grammar, no parser, no
 * precedence, and no place to write arithmetic — the model emits this object
 * from the user's own words the way it emits any other tool argument, and
 * every field is something a chart can be pointed at. The whole boolean
 * vocabulary is a list of comparisons and one word saying whether all of them
 * or any of them has to hold. One level deep, no nesting: a thesis that needs
 * `(a and b) or (c and d)` is two theses, and testing them separately is a
 * better answer than expressing them together.
 *
 * The four comparators are the two a chart shows (`above`, `below`) and the
 * two that only exist across a bar boundary (`crosses_above`, `crosses_below`).
 * A cross is the pair the indicator reading has always reported — the relation
 * holds on this closed bar and did not hold on the one before it — so nothing
 * here needs a series the model has to carry.
 *
 * Ranges and consistency are checked in {@link validateThesis} rather than in
 * the schema, following the same rule as the watch contract: an out-of-range
 * field should come back as a named refusal the model can act on, not as a
 * decode failure it cannot read.
 *
 * @module TradingThesis
 */
import * as Schema from "effect/Schema";

import {
  INDICATOR_COMPONENTS,
  INDICATOR_MAX_PERIOD,
  IndicatorComponent,
  IndicatorKind,
  type IndicatorRequest,
} from "./indicators.ts";
import { TradingMarket } from "./primitives.ts";

/**
 * The bar intervals a thesis can be tested on — the archive's own recorded
 * set, because the archive is the only place the history comes from. Wider
 * than `TradingTimeframe`, which stops at 1h: a thesis run over months of 4h
 * or daily bars is an ordinary question, and refusing it would push the user
 * onto an interval whose bar count the run then refuses for being too large.
 */
export const BacktestInterval = Schema.Literals(["1m", "3m", "5m", "15m", "1h", "4h", "1d"]);
export type BacktestInterval = typeof BacktestInterval.Type;

/**
 * One bar of each interval, in milliseconds.
 *
 * The event operand needs it to turn wall-clock time since an occurrence into
 * whole bars of the interval the thesis itself names, so the distance a rule
 * reads is the same number the backtest's `withinBars` and `maxHoldBars`
 * already count. Lives here, beside the interval vocabulary it measures.
 */
export const BACKTEST_INTERVAL_MILLIS: Readonly<Record<BacktestInterval, number>> = {
  "1m": 60_000,
  "3m": 180_000,
  "5m": 300_000,
  "15m": 900_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "1d": 86_400_000,
};

/**
 * The archive-backed numbers a thesis can compare against, beyond the bar's
 * own price and the indicator library.
 *
 * Deliberately short, and bounded by what the archive actually records. Open
 * interest and the premium index are not here because the archive stores no
 * history of either, and an operand the archive cannot serve is a rule that
 * silently never fires.
 *
 * - `funding_rate_8h` is the archived funding rate in force at the bar's close
 *   time, held STEPWISE between the hourly rows the archive writes: the rate
 *   from the most recent row at or before the close, never interpolated
 *   towards the next one, because the rate genuinely is a step. Expressed as
 *   the 8h rate (0.0001 = 1bp/8h) and signed, which is the same number and the
 *   same units the `funding_rate_8h` watch metric compares against, so a
 *   threshold moves between a watch and a thesis unchanged.
 * - `volume` is the bar's own traded volume, in the units the archive stores.
 * - `volume_ratio` is the bar's volume over the simple mean of the previous
 *   {@link THESIS_VOLUME_RATIO_BARS} closed bars' volumes. 2.0 means the bar
 *   traded twice its recent pace. Undefined until that many priors exist, and
 *   undefined when they sum to zero.
 */
export const ThesisMetricName = Schema.Literals(["funding_rate_8h", "volume", "volume_ratio"]);
export type ThesisMetricName = typeof ThesisMetricName.Type;

/**
 * Bars the `volume_ratio` mean is taken over, counting backwards from the bar
 * before the one being read.
 *
 * Fixed rather than a parameter, and fixed at the number the `volume_ratio`
 * WATCH metric already averages over, so "volume is twice its recent pace"
 * means one thing in this fork rather than two. Making it settable would also
 * make every thesis that used it incomparable with every other one.
 */
export const THESIS_VOLUME_RATIO_BARS = 20;

/** Which price of a bar an operand reads. Defaults to the close. */
export const ThesisPriceField = Schema.Literals(["open", "high", "low", "close"]);
export type ThesisPriceField = typeof ThesisPriceField.Type;

/**
 * One side of a comparison: a price off the bar, a reading off an indicator,
 * a number the user named, or the calendar distance since an external event.
 *
 * `component` picks which number a multi-part indicator contributes — the
 * signal line rather than the MACD line, the upper band rather than the basis.
 * Absent means the kind's primary component, which is the only one the
 * single-value kinds have.
 */
export const ThesisOperand = Schema.Union([
  Schema.Struct({
    source: Schema.Literal("price"),
    field: Schema.optional(ThesisPriceField),
  }),
  Schema.Struct({
    source: Schema.Literal("indicator"),
    indicator: IndicatorKind,
    /** The kind's own default when absent. For `macd` this is the fast leg. */
    period: Schema.optional(Schema.Number),
    component: Schema.optional(IndicatorComponent),
  }),
  Schema.Struct({
    source: Schema.Literal("metric"),
    metric: ThesisMetricName,
  }),
  Schema.Struct({
    source: Schema.Literal("constant"),
    value: Schema.Number,
  }),
  Schema.Struct({
    /**
     * Bars since the most recent ended occurrence of an event set: an event is
     * the one operand the market data itself carries no trace of, so the set
     * it points at is an authored record rather than an archived series.
     *
     * `eventSetId` is the semantic reference; `label` is a display snapshot
     * ("Devcon") so the prose helpers stay pure and a chart can caption the
     * band without a lookup. Renaming a set later does not rewrite stored
     * theses, and that is fine: the id still resolves, and the label a thesis
     * froze is the name the idea was written under.
     */
    source: Schema.Literal("event"),
    eventSetId: Schema.String,
    label: Schema.String,
  }),
]);
export type ThesisOperand = typeof ThesisOperand.Type;

/**
 * `above` and `below` read one bar. `crosses_above` and `crosses_below` read
 * two: the relation holds on this closed bar and did not hold on the previous
 * one. A cross therefore fires exactly once per crossing rather than on every
 * bar the relation happens to hold, which is the whole difference between an
 * entry rule and a state.
 */
export const ThesisComparator = Schema.Literals([
  "crosses_above",
  "crosses_below",
  "above",
  "below",
]);
export type ThesisComparator = typeof ThesisComparator.Type;

export const ThesisPredicate = Schema.Struct({
  left: ThesisOperand,
  comparator: ThesisComparator,
  right: ThesisOperand,
});
export type ThesisPredicate = typeof ThesisPredicate.Type;

/**
 * A list of comparisons and how they combine. `match` defaults to `all`, so a
 * single-predicate condition needs no combinator at all and the common case
 * writes as a one-element list.
 */
export const ThesisCondition = Schema.Struct({
  match: Schema.optional(Schema.Literals(["all", "any"])),
  predicates: Schema.Array(ThesisPredicate),
});
export type ThesisCondition = typeof ThesisCondition.Type;

/** Predicates one condition may hold. Past this the idea wants splitting. */
export const THESIS_MAX_PREDICATES = 4;

/**
 * How far an exit sits from the entry.
 *
 * `percent` is a share of the entry price. `atr` is a multiple of the ATR at
 * the entry bar, which is how a stop that respects the market's own noise gets
 * written. `r` is a multiple of the stop distance and is therefore only
 * meaningful for a target, and only when a stop exists to measure it against —
 * {@link validateThesis} refuses the pair rather than inventing a stop.
 */
export const ThesisDistance = Schema.Union([
  Schema.Struct({
    basis: Schema.Literal("percent"),
    value: Schema.Number,
  }),
  Schema.Struct({
    basis: Schema.Literal("atr"),
    multiple: Schema.Number,
    /** ATR period. `DEFAULT_INDICATOR_PERIODS.atr` when absent. */
    period: Schema.optional(Schema.Number),
  }),
  Schema.Struct({
    basis: Schema.Literal("r"),
    multiple: Schema.Number,
  }),
]);
export type ThesisDistance = typeof ThesisDistance.Type;

/**
 * How a position ends. At least one has to be present, because a thesis with
 * no exit is not a thesis — it is an opinion, and it cannot be scored.
 *
 * All four are checked on every held bar, and the first one to trigger settles
 * the trade. Stop before target when a single bar contains both, which is the
 * settlement rule the fixture replay already used: OHLC cannot say which came
 * first inside the bar, and resolving the ambiguity in the trade's favour
 * flatters every thesis by exactly the trades whose outcome is unknown.
 */
export const ThesisExits = Schema.Struct({
  stop: Schema.optional(ThesisDistance),
  target: Schema.optional(ThesisDistance),
  /** Close at this many bars held, whatever the price is doing. */
  maxHoldBars: Schema.optional(Schema.Number),
  /** Close when this condition holds on a closed bar — the mirror of the entry. */
  opposite: Schema.optional(ThesisCondition),
});
export type ThesisExits = typeof ThesisExits.Type;

/** The longest hold a thesis may name, in bars. */
export const THESIS_MAX_HOLD_BARS = 5_000;

/**
 * "X, but only if Y happened first."
 *
 * The one thing the flat predicate list could not say. `condition` is the
 * antecedent and `withinBars` is how recently it has to have matched, counted
 * in closed bars ending at the bar BEFORE the entry bar. The entry bar itself
 * never counts as its own antecedent: a rule that fires because the thing it
 * was waiting for happened on the same bar is just a two-predicate `all`, and
 * writing it as a sequence would say something the data does not.
 *
 * No nesting: an antecedent is a flat condition like any other and cannot
 * carry its own `after`. Two-step sequences are the shape people actually
 * hypothesize, three-step ones are usually a curve being fitted, and the cap
 * is the honest place to stop.
 */
export const ThesisSequence = Schema.Struct({
  condition: ThesisCondition,
  /** Closed bars before the entry bar the antecedent may have matched on. */
  withinBars: Schema.Number,
});
export type ThesisSequence = typeof ThesisSequence.Type;

/**
 * The longest lookback an antecedent may be given.
 *
 * A hundred bars is a long memory on any interval this engine runs, and past
 * it "Y happened first" stops being a sequence and becomes a regime the thesis
 * should name directly.
 */
export const THESIS_MAX_WITHIN_BARS = 100;

export const TradingThesis = Schema.Struct({
  market: TradingMarket,
  interval: BacktestInterval,
  side: Schema.Literals(["long", "short"]),
  entry: ThesisCondition,
  /** When present, the entry only fires on a bar this antecedent preceded. */
  after: Schema.optional(ThesisSequence),
  exits: ThesisExits,
});
export type TradingThesis = typeof TradingThesis.Type;

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------

const distanceMagnitude = (distance: ThesisDistance): number =>
  distance.basis === "percent" ? distance.value : distance.multiple;

/** The indicator request an operand implies, or null when it reads no indicator. */
export const operandIndicator = (operand: ThesisOperand): IndicatorRequest | null =>
  operand.source === "indicator"
    ? {
        kind: operand.indicator,
        ...(operand.period === undefined ? {} : { period: operand.period }),
      }
    : null;

/**
 * A predicate split into the side that reads the market and the fixed number
 * it is compared against, whichever order it was written in. `null` when the
 * comparison holds no constant, or when it is constant on both sides.
 *
 * `3900 below close` is `close above 3900` written backwards, so the direction
 * flips with the operand order. Shared rather than read twice because two
 * surfaces the user sees side by side depend on it agreeing: the chart draws
 * the level from {@link thesisEntryPriceLevels}, and the alert layer arms the
 * watch from it. A rule drawn on one side of a number and fired on the other
 * would look correct on each surface alone.
 */
export function readThresholdPredicate(predicate: ThesisPredicate): {
  readonly subject: ThesisOperand;
  readonly value: number;
  /** Which side the SUBJECT sits on when the relation holds. */
  readonly direction: "above" | "below";
} | null {
  // `crosses_above` is `above` plus a memory of the previous bar, and both
  // hold with the subject on the same side of the number, so a chart draws
  // them alike.
  const straight =
    predicate.comparator === "above" || predicate.comparator === "crosses_above"
      ? "above"
      : "below";
  if (predicate.right.source === "constant" && predicate.left.source !== "constant") {
    return { subject: predicate.left, value: predicate.right.value, direction: straight };
  }
  if (predicate.left.source === "constant" && predicate.right.source !== "constant") {
    // The constant is the left operand, so the comparator describes where the
    // NUMBER sits. The market side is on the other side of it.
    return {
      subject: predicate.right,
      value: predicate.left.value,
      direction: straight === "above" ? "below" : "above",
    };
  }
  return null;
}

/**
 * The entry rule's price constants, as levels a chart can draw.
 *
 * Only predicates that compare the bar's price against a number the user named
 * yield one: "close above 3900" is a line, "close above the 50 EMA" is a line
 * that moves and the chart already draws the average itself.
 *
 * Deduplicated, because a rule that names the same level twice is still one
 * level. Bounded by {@link THESIS_MAX_PREDICATES}, so there is no cap here.
 */
export function thesisEntryPriceLevels(
  thesis: TradingThesis,
): ReadonlyArray<{ readonly price: number; readonly direction: "above" | "below" }> {
  const seen = new Set<string>();
  const levels: Array<{ readonly price: number; readonly direction: "above" | "below" }> = [];
  for (const predicate of thesis.entry.predicates) {
    const threshold = readThresholdPredicate(predicate);
    if (threshold === null || threshold.subject.source !== "price") continue;
    const key = `${threshold.value}:${threshold.direction}`;
    if (seen.has(key)) continue;
    seen.add(key);
    levels.push({ price: threshold.value, direction: threshold.direction });
  }
  return levels;
}

/**
 * Every condition a thesis evaluates: the entry, the antecedent, the exit
 * rule. Named once so a fourth slot cannot be added to one reader and
 * forgotten in the other, which would surface as a rule that never fires
 * rather than as an error.
 */
const thesisConditions = (thesis: TradingThesis): ReadonlyArray<ThesisCondition> =>
  [thesis.entry, thesis.after?.condition, thesis.exits.opposite].filter(
    (condition): condition is ThesisCondition => condition !== undefined,
  );

/**
 * Every metric a thesis reads, across the entry, the antecedent and the exit
 * condition, deduplicated.
 *
 * The callers that matter are the ones deciding what a run has to load and
 * what it can refuse before loading anything: a funding operand needs archived
 * funding rows, and `volume_ratio` needs a warm-up the price rules do not.
 */

export const thesisMetrics = (thesis: TradingThesis): ReadonlyArray<ThesisMetricName> => {
  const found = new Set<ThesisMetricName>();
  for (const condition of thesisConditions(thesis)) {
    for (const predicate of condition.predicates) {
      for (const operand of [predicate.left, predicate.right]) {
        if (operand.source === "metric") found.add(operand.metric);
      }
    }
  }
  return [...found];
};

/** Whether any rule in the thesis reads the archive's funding history. */
export const thesisReadsFunding = (thesis: TradingThesis): boolean =>
  thesisMetrics(thesis).includes("funding_rate_8h");

/**
 * Every event set a thesis anchors on, deduplicated, in first-mention order.
 *
 * The callers are the ones resolving authored records before a run loads
 * anything: an event operand whose set is unknown would read undefined on
 * every bar and report zero trades, which the user would read as "the idea
 * does not work" rather than "the calendar was never recorded".
 */
export const thesisEventSets = (thesis: TradingThesis): ReadonlyArray<string> => {
  const found: Array<string> = [];
  for (const condition of thesisConditions(thesis)) {
    for (const predicate of condition.predicates) {
      for (const operand of [predicate.left, predicate.right]) {
        if (operand.source === "event" && !found.includes(operand.eventSetId)) {
          found.push(operand.eventSetId);
        }
      }
    }
  }
  return found;
};

/** Every distinct indicator a thesis needs computed, deduplicated. */
export const thesisIndicators = (thesis: TradingThesis): ReadonlyArray<IndicatorRequest> => {
  const requests = new Map<string, IndicatorRequest>();
  const add = (request: IndicatorRequest | null): void => {
    if (request === null) return;
    requests.set(`${request.kind}:${request.period ?? "default"}`, request);
  };
  for (const condition of thesisConditions(thesis)) {
    for (const predicate of condition.predicates) {
      add(operandIndicator(predicate.left));
      add(operandIndicator(predicate.right));
    }
  }
  for (const distance of [thesis.exits.stop, thesis.exits.target]) {
    if (distance?.basis === "atr") {
      add({ kind: "atr", ...(distance.period === undefined ? {} : { period: distance.period }) });
    }
  }
  return [...requests.values()];
};

const validateOperand = (operand: ThesisOperand, where: string): string | null => {
  if (operand.source === "event") {
    if (operand.eventSetId.trim().length === 0 || operand.label.trim().length === 0) {
      return `${where}: an event operand needs both an eventSetId and a label`;
    }
    return null;
  }
  if (operand.source !== "indicator") return null;
  const period = operand.period;
  if (period !== undefined) {
    if (!Number.isInteger(period) || period < 0 || period > INDICATOR_MAX_PERIOD) {
      return `${where}: ${operand.indicator} period must be a whole number from 0 to ${INDICATOR_MAX_PERIOD}`;
    }
    if (period === 0 && operand.indicator !== "vwap") {
      return `${where}: only vwap reads a period of 0 (its whole window)`;
    }
  }
  const component = operand.component;
  const available = INDICATOR_COMPONENTS[operand.indicator];
  if (component !== undefined && !available.includes(component)) {
    return `${where}: ${operand.indicator} reports ${available.join(", ")}, not ${component}`;
  }
  return null;
};

const validateCondition = (condition: ThesisCondition, where: string): string | null => {
  if (condition.predicates.length === 0) return `${where}: name at least one comparison`;
  if (condition.predicates.length > THESIS_MAX_PREDICATES) {
    return `${where}: ${condition.predicates.length} comparisons, at most ${THESIS_MAX_PREDICATES}. Split the idea into two theses instead of nesting it`;
  }
  for (const [index, predicate] of condition.predicates.entries()) {
    const at = `${where} comparison ${index + 1}`;
    const left = validateOperand(predicate.left, at);
    if (left !== null) return left;
    const right = validateOperand(predicate.right, at);
    if (right !== null) return right;
    if (predicate.left.source === "constant" && predicate.right.source === "constant") {
      return `${at}: both sides are constants, so the comparison never reads the market`;
    }
  }
  return null;
};

/**
 * What the caller knows about the archive that the thesis itself cannot.
 *
 * The funding question and the event-set question, for the same reason: an
 * operand that would read `undefined` on every bar is not a grammar error, it
 * is a rule that can never fire, and a thesis that can never fire should
 * refuse loudly rather than come back with zero trades and let the user
 * conclude the idea was wrong. Optional because the grammar check is also run
 * in places that have no archive to ask - the menus and the contract tests -
 * and there it stays a pure check of the shape.
 */
export interface ThesisArchiveContext {
  /** True when the archive holds funding rows for this thesis's market. */
  readonly fundingArchived?: boolean;
  /** The event sets on record (active ones), when the caller can ask. */
  readonly knownEventSets?: ReadonlyArray<string>;
}

/**
 * Everything the schema deliberately does not check, as one refusal string the
 * model can act on. `null` means the thesis is testable as written.
 */
export function validateThesis(
  thesis: TradingThesis,
  archive: ThesisArchiveContext = {},
): string | null {
  const entry = validateCondition(thesis.entry, "entry");
  if (entry !== null) return entry;

  const after = thesis.after;
  if (after !== undefined) {
    const antecedent = validateCondition(after.condition, "after");
    if (antecedent !== null) return antecedent;
    if (
      !Number.isInteger(after.withinBars) ||
      after.withinBars < 1 ||
      after.withinBars > THESIS_MAX_WITHIN_BARS
    ) {
      return `after: withinBars is a whole number of bars from 1 to ${THESIS_MAX_WITHIN_BARS}`;
    }
  }

  if (archive.fundingArchived === false && thesisReadsFunding(thesis)) {
    return `funding_rate_8h: the archive holds no funding history for ${thesis.market}, so this rule would read nothing on every bar. Test it on a market the archive funds, or drop the funding comparison`;
  }

  // Same refusal, one layer up: an event operand whose set is not on record
  // has no calendar to read. `knownEventSets` lists only active sets, so a
  // retired set refuses here too - while still evaluating inside a thesis
  // saved while it was live, which never re-validates its grammar.
  const known = archive.knownEventSets;
  if (known !== undefined) {
    for (const condition of thesisConditions(thesis)) {
      for (const predicate of condition.predicates) {
        for (const operand of [predicate.left, predicate.right]) {
          if (operand.source !== "event") continue;
          if (!known.includes(operand.eventSetId)) {
            return `${operand.label}: no active event set with that id is on record, so this rule would read nothing on every bar. Record the set first, or drop the event comparison`;
          }
        }
      }
    }
  }

  const exits = thesis.exits;
  if (exits.opposite !== undefined) {
    const opposite = validateCondition(exits.opposite, "exit condition");
    if (opposite !== null) return opposite;
  }

  const hasExit =
    exits.stop !== undefined ||
    exits.target !== undefined ||
    exits.maxHoldBars !== undefined ||
    exits.opposite !== undefined;
  if (!hasExit) {
    return "exits: name at least one of a stop, a target, a bar limit, or an exit condition. A thesis with no way out cannot be scored";
  }

  for (const [name, distance] of [
    ["stop", exits.stop],
    ["target", exits.target],
  ] as const) {
    if (distance === undefined) continue;
    if (!(distanceMagnitude(distance) > 0)) {
      return `${name}: the distance must be greater than zero`;
    }
    if (distance.basis === "atr" && distance.period !== undefined) {
      if (!Number.isInteger(distance.period) || distance.period < 1) {
        return `${name}: the ATR period must be a whole number of at least 1`;
      }
    }
  }
  if (exits.stop?.basis === "r") {
    return "stop: R is a multiple of the stop distance, so a stop cannot be measured in it";
  }
  if (exits.target?.basis === "r" && exits.stop === undefined) {
    return "target: R is a multiple of the stop distance, so a target in R needs a stop to measure against";
  }

  if (exits.maxHoldBars !== undefined) {
    if (
      !Number.isInteger(exits.maxHoldBars) ||
      exits.maxHoldBars < 1 ||
      exits.maxHoldBars > THESIS_MAX_HOLD_BARS
    ) {
      return `maxHoldBars: a whole number of bars from 1 to ${THESIS_MAX_HOLD_BARS}`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// prose
// ---------------------------------------------------------------------------
//
// Shared by every client rather than composed on the server: the card renders
// the thesis it was given, and web and mobile say the same words about it
// without the server having to guess which of them is asking.

const COMPARATOR_PROSE: Readonly<Record<ThesisComparator, string>> = {
  crosses_above: "crosses above",
  crosses_below: "crosses below",
  above: "is above",
  below: "is below",
};

const COMPONENT_PROSE: Readonly<Record<IndicatorComponent, string>> = {
  value: "",
  signal: " signal",
  histogram: " histogram",
  upper: " upper band",
  lower: " lower band",
};

const METRIC_PROSE: Readonly<Record<ThesisMetricName, string>> = {
  funding_rate_8h: "8h funding",
  volume: "bar volume",
  volume_ratio: "volume vs its 20-bar pace",
};

const INDICATOR_PROSE: Readonly<Record<IndicatorKind, string>> = {
  ema: "EMA",
  sma: "SMA",
  rsi: "RSI",
  vwap: "VWAP",
  atr: "ATR",
  macd: "MACD",
  bollinger: "Bollinger",
};

/** One operand in the words a trader would use for it. */
export function describeOperand(operand: ThesisOperand): string {
  switch (operand.source) {
    case "price":
      return operand.field === undefined || operand.field === "close"
        ? "price"
        : `bar ${operand.field}`;
    case "metric":
      return METRIC_PROSE[operand.metric];
    case "constant":
      return String(operand.value);
    case "event":
      return `bars since ${operand.label}`;
    case "indicator": {
      const name = INDICATOR_PROSE[operand.indicator];
      const period = operand.period === undefined ? "" : `(${operand.period})`;
      const component = COMPONENT_PROSE[operand.component ?? "value"];
      return `${name}${period}${component}`;
    }
  }
}

/** One condition as a sentence fragment: "RSI(14) is below 30 and price is above EMA(50)". */
export function describeCondition(condition: ThesisCondition): string {
  const joiner = condition.match === "any" ? " or " : " and ";
  return condition.predicates
    .map(
      (predicate) =>
        `${describeOperand(predicate.left)} ${COMPARATOR_PROSE[predicate.comparator]} ${describeOperand(predicate.right)}`,
    )
    .join(joiner);
}

/** One distance in prose: "2.0x ATR", "1.5R", "0.8% of entry". */
export function describeDistance(distance: ThesisDistance): string {
  switch (distance.basis) {
    case "percent":
      return `${distance.value}% of entry`;
    case "atr":
      return `${distance.multiple}x ATR${distance.period === undefined ? "" : `(${distance.period})`}`;
    case "r":
      return `${distance.multiple}R`;
  }
}

/** Every exit rule the thesis carries, in the order they are checked. */
export function describeExits(exits: ThesisExits): ReadonlyArray<string> {
  const lines: Array<string> = [];
  if (exits.stop !== undefined) lines.push(`stop at ${describeDistance(exits.stop)}`);
  if (exits.target !== undefined) lines.push(`target at ${describeDistance(exits.target)}`);
  if (exits.opposite !== undefined) lines.push(`exit when ${describeCondition(exits.opposite)}`);
  if (exits.maxHoldBars !== undefined) lines.push(`close after ${exits.maxHoldBars} bars`);
  return lines;
}

/**
 * The antecedent as a leading clause: "after 8h funding is below 0, within 12
 * bars". Reads before the entry it qualifies, the way the user said it.
 */
export function describeSequence(sequence: ThesisSequence): string {
  return `after ${describeCondition(sequence.condition)}, within ${sequence.withinBars} bars`;
}

/** The whole thesis in one line, for a card heading. */
export function describeThesis(thesis: TradingThesis): string {
  const side = thesis.side === "long" ? "Buy" : "Sell";
  const lead = thesis.after === undefined ? "" : `${describeSequence(thesis.after)}, `;
  return `${side} ${thesis.market} ${thesis.interval} when ${lead}${describeCondition(thesis.entry)}`;
}
