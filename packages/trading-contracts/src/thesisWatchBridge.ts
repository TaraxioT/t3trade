/**
 * Arming live alerts from a thesis, where the two vocabularies overlap.
 *
 * A validated idea sits in an awkward place: the paper validation is watching
 * it bar by bar and scoring it, but the user is not, and "tell me when this
 * setup is shaping up" is an ordinary thing to want. The watch layer can
 * already say some of what a thesis says - a price level, a funding
 * threshold, a volume pace - so for those predicates an alert is a translation
 * rather than a new mechanism.
 *
 * ## What this is honest about
 *
 * Three things, and the result carries all three in words rather than leaving
 * the caller to infer them.
 *
 * 1. **Legs, not setups.** An `all` condition becomes one watch per predicate,
 *    and watches fire independently. Two of them arming does not mean the
 *    setup fired - it means each leg was reached at some point, possibly on
 *    different days. The setup itself is what the paper validation decides.
 * 2. **Sequences do not survive.** The watch layer has no memory of "Y
 *    happened first", so an `after` clause is dropped, named, and left to the
 *    validation.
 * 3. **A cross is a crossing.** A watch is edge-triggered, so `above` and
 *    `crosses_above` both become "notify when it becomes above". For a rule
 *    that is already true when the alert is armed, that is a later fire than
 *    the thesis would have counted, and it is the closest the layer gets.
 *
 * Nothing here can arm an execution consequence. The bridge returns
 * {@link WatchCondition} values only, and the caller arms them at
 * `deliver: "notify"`; an alert from a thesis is a message to a person.
 *
 * @module TradingThesisWatchBridge
 */
import { TradingTimeframe } from "./strategy.ts";
import {
  describeCondition,
  describeOperand,
  type ThesisComparator,
  type ThesisCondition,
  type ThesisOperand,
  type ThesisPredicate,
  type TradingThesis,
} from "./thesis.ts";
import type { WatchCondition, WatchCrossDirection } from "./watch.ts";

/** What a thesis translated to, and what it could not. */
export interface ThesisSetupAlerts {
  /** Ready to arm at `deliver: "notify"`, in the order the predicates read. */
  readonly conditions: ReadonlyArray<WatchCondition>;
  /**
   * One sentence per predicate the watch vocabulary cannot express, naming the
   * predicate and saying what is still watching it. Empty when the whole entry
   * translated.
   */
  readonly inexpressible: ReadonlyArray<string>;
}

/** Which side of the level the watch fires on, given where price has to sit. */
const directionOf = (comparator: ThesisComparator): WatchCrossDirection =>
  comparator === "above" || comparator === "crosses_above" ? "above" : "below";

/**
 * A predicate split into the side that reads the market and the number it is
 * compared against, whichever order it was written in.
 *
 * `3900 below close` is `close above 3900` written backwards, so the direction
 * flips with the operand order - the same reading {@link thesisEntryPriceLevels}
 * already applies to the chart.
 */
const readComparison = (
  predicate: ThesisPredicate,
): {
  readonly subject: ThesisOperand;
  readonly value: number;
  readonly direction: WatchCrossDirection;
} | null => {
  const straight = directionOf(predicate.comparator);
  if (predicate.right.source === "constant" && predicate.left.source !== "constant") {
    return { subject: predicate.left, value: predicate.right.value, direction: straight };
  }
  if (predicate.left.source === "constant" && predicate.right.source !== "constant") {
    return {
      subject: predicate.right,
      value: predicate.left.value,
      // The comparator describes where the NUMBER sits, so the market side is
      // on the other side of it.
      direction: straight === "above" ? "below" : "above",
    };
  }
  return null;
};

const isTimeframe = (interval: string): interval is TradingTimeframe =>
  (TradingTimeframe.literals as ReadonlyArray<string>).includes(interval);

/**
 * The alerts a thesis's entry can be watched by, and a sentence for every part
 * it cannot.
 *
 * The `after` clause is read only to report that it was dropped. Exits are not
 * read at all: an alert says a setup is forming, and a stop on a position
 * nobody has opened is not a thing to be told about.
 */
export function thesisSetupAlerts(thesis: TradingThesis): ThesisSetupAlerts {
  const conditions: Array<WatchCondition> = [];
  const inexpressible: Array<string> = [];
  const market = thesis.market;
  const interval = thesis.interval;

  const cannot = (what: string, why: string): void => {
    inexpressible.push(
      `${what} cannot be armed as an alert because ${why}; the paper validation evaluates it on every closed bar, which is where that predicate is still being watched`,
    );
  };

  for (const predicate of thesis.entry.predicates) {
    const comparison = readComparison(predicate);
    if (comparison === null) {
      cannot(
        `"${describeOperand(predicate.left)} vs ${describeOperand(predicate.right)}"`,
        "an alert compares one market reading against a fixed number, and this compares two moving readings",
      );
      continue;
    }
    const { subject, value, direction } = comparison;
    switch (subject.source) {
      case "price": {
        if (!isTimeframe(interval)) {
          cannot(
            `"${describeOperand(subject)} ${predicate.comparator} ${value}"`,
            `an alert confirms on bars up to ${TradingTimeframe.literals[TradingTimeframe.literals.length - 1]} and this thesis runs on ${interval}`,
          );
          continue;
        }
        // Confirmed on the close of the thesis's own bar, not on a touch: the
        // rule it is standing in for is evaluated on closed bars, and a touch
        // alert would fire on wicks the thesis never counted.
        conditions.push({
          kind: "price",
          market,
          direction,
          price: value,
          confirm: "close",
          interval,
        });
        continue;
      }
      case "metric": {
        if (subject.metric === "funding_rate_8h") {
          // Same number, same units, same sign convention on both sides.
          conditions.push({ kind: "metric", market, metric: "funding_rate_8h", direction, value });
          continue;
        }
        if (subject.metric === "volume_ratio") {
          if (!isTimeframe(interval)) {
            cannot(
              `"volume vs its recent pace ${predicate.comparator} ${value}"`,
              `the alert measures the pace on bars up to ${TradingTimeframe.literals[TradingTimeframe.literals.length - 1]} and this thesis runs on ${interval}`,
            );
            continue;
          }
          conditions.push({
            kind: "metric",
            market,
            metric: "volume_ratio",
            direction,
            value,
            interval,
          });
          continue;
        }
        cannot(
          `"bar volume ${predicate.comparator} ${value}"`,
          "the alert layer measures volume as a 24h notional or as a pace ratio, never as one bar's raw volume",
        );
        continue;
      }
      case "indicator": {
        cannot(
          `"${describeOperand(subject)} ${predicate.comparator} ${value}"`,
          "an alert holds a threshold against a market number, and an indicator reading is computed off a bar series the alert layer does not carry",
        );
        continue;
      }
      case "constant":
        // Both sides constant is refused by validateThesis long before here.
        continue;
    }
  }

  if (thesis.after !== undefined) {
    inexpressible.push(
      `the "after ${describeCondition(thesis.after.condition)}" ordering cannot be armed as an alert because an alert has no memory of what happened before it; the paper validation is what checks the sequence`,
    );
  }

  return { conditions, inexpressible };
}

/**
 * What was armed, in one line, said in a way that cannot be misread as "the
 * setup fired".
 *
 * The distinction between a leg and a setup is the single most misleading
 * thing about this feature, so the sentence names it every time rather than
 * only when several watches were armed.
 */
export function describeSetupAlerts(thesis: TradingThesis, alerts: ThesisSetupAlerts): string {
  if (alerts.conditions.length === 0) {
    return `Nothing in this entry can be armed as an alert. ${alerts.inexpressible.join(". ")}`;
  }
  const legs = alerts.conditions.length === 1 ? "leg" : "legs";
  const combinator = thesis.entry.match === "any" ? "any of which is" : "each of which is only";
  return (
    `Armed ${alerts.conditions.length} notify-only ${legs} of ${describeCondition(thesis.entry)} on ${thesis.market}, ` +
    `${combinator} one part of the setup: the legs fire independently and reaching them all is not the same as the entry firing. ` +
    `No order is placed and nothing wakes a mission.`
  );
}
