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

/** Which price of a bar an operand reads. Defaults to the close. */
export const ThesisPriceField = Schema.Literals(["open", "high", "low", "close"]);
export type ThesisPriceField = typeof ThesisPriceField.Type;

/**
 * One side of a comparison: a price off the bar, a reading off an indicator,
 * or a number the user named.
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
    source: Schema.Literal("constant"),
    value: Schema.Number,
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

export const TradingThesis = Schema.Struct({
  market: TradingMarket,
  interval: BacktestInterval,
  side: Schema.Literals(["long", "short"]),
  entry: ThesisCondition,
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

/** Every distinct indicator a thesis needs computed, deduplicated. */
export const thesisIndicators = (thesis: TradingThesis): ReadonlyArray<IndicatorRequest> => {
  const requests = new Map<string, IndicatorRequest>();
  const add = (request: IndicatorRequest | null): void => {
    if (request === null) return;
    requests.set(`${request.kind}:${request.period ?? "default"}`, request);
  };
  const addCondition = (condition: ThesisCondition | undefined): void => {
    for (const predicate of condition?.predicates ?? []) {
      add(operandIndicator(predicate.left));
      add(operandIndicator(predicate.right));
    }
  };
  addCondition(thesis.entry);
  addCondition(thesis.exits.opposite);
  for (const distance of [thesis.exits.stop, thesis.exits.target]) {
    if (distance?.basis === "atr") {
      add({ kind: "atr", ...(distance.period === undefined ? {} : { period: distance.period }) });
    }
  }
  return [...requests.values()];
};

const validateOperand = (operand: ThesisOperand, where: string): string | null => {
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
    return `${where}: ${condition.predicates.length} comparisons, at most ${THESIS_MAX_PREDICATES} — split the idea into two theses instead of nesting it`;
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
 * Everything the schema deliberately does not check, as one refusal string the
 * model can act on. `null` means the thesis is testable as written.
 */
export function validateThesis(thesis: TradingThesis): string | null {
  const entry = validateCondition(thesis.entry, "entry");
  if (entry !== null) return entry;

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
    return "exits: name at least one of a stop, a target, a bar limit, or an exit condition — a thesis with no way out cannot be scored";
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
    case "constant":
      return String(operand.value);
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

/** The whole thesis in one line, for a card heading. */
export function describeThesis(thesis: TradingThesis): string {
  const side = thesis.side === "long" ? "Buy" : "Sell";
  return `${side} ${thesis.market} ${thesis.interval} when ${describeCondition(thesis.entry)}`;
}
