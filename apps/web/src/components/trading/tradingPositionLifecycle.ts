import type { TradingMissionStatus } from "@t3tools/trading-contracts";

import { formatPrice, formatSize } from "./tradingFormat";
// ---------------------------------------------------------------------------
// small derivations ported from the execution prototype
// ---------------------------------------------------------------------------

/**
 * How far the fill landed from the limit the order was placed at, in percent.
 *
 * Signed so that positive always means "worse than the limit": a buy that
 * filled above it, a sell that filled below it. For a `marketable_ioc` the
 * server prices the limit from BBO as a slippage bound, so this is the number
 * that says how much of that bound the fill actually spent.
 *
 * Null when the fill cannot be attributed to a known intent — a fill whose
 * cloid does not match the execution on screen has no limit to compare against,
 * and inventing one would put a fabricated figure on a receipt.
 */
export function deriveFillSlippagePercent(
  fill: {
    readonly side: "buy" | "sell";
    readonly avgFillPrice: number;
    readonly cloid?: string | undefined;
  },
  intent: { readonly cloid: string; readonly limitPrice: number } | null,
): number | null {
  if (intent === null || fill.cloid === undefined || fill.cloid !== intent.cloid) return null;
  if (!(intent.limitPrice > 0)) return null;

  const delta =
    fill.side === "buy"
      ? fill.avgFillPrice - intent.limitPrice
      : intent.limitPrice - fill.avgFillPrice;
  return (delta / intent.limitPrice) * 100;
}

/**
 * Where a fill or an order sits in the life of a position.
 *
 * The mission's whole activity is this cycle — open, hold, close — and a
 * receipt that says only "sell 0.67" hides which half of it just happened. The
 * two facts that matter are the side the exposure was on and whether this took
 * it on or gave it back, and they are independent: a sell opens a short and
 * closes a long.
 */
export interface PositionLifecycle {
  /** The side of the exposure, not the side of the order. */
  readonly direction: "long" | "short";
  readonly action: "open" | "close" | "reverse";
  /** The action as a card labels it. */
  readonly actionLabel: string;
}

const exposureSide = (text: string): "long" | "short" | null => {
  if (text.includes("long")) return "long";
  if (text.includes("short")) return "short";
  return null;
};

/**
 * Read the exchange's own lifecycle label off a fill.
 *
 * Hyperliquid sends `dir` as "Open Long", "Close Short", "Long > Short", or
 * "Liquidated Isolated Long". Matching on words rather than on the exact
 * strings keeps a label the exchange words slightly differently readable — and
 * anything that carries neither "long" nor "short" (a spot "Buy", a settlement)
 * returns null rather than a guess, so the card falls back to naming the order.
 */
export function readFillLifecycle(dir: string | undefined): PositionLifecycle | null {
  if (dir === undefined) return null;
  const text = dir.toLowerCase();

  // A reversal reads "Long > Short". The side it ended on is the one the
  // mission now holds, so that is the side the card shows.
  const arrow = text.indexOf(">");
  if (arrow >= 0) {
    const direction = exposureSide(text.slice(arrow + 1));
    return direction === null ? null : { direction, action: "reverse", actionLabel: "Reverse" };
  }

  const direction = exposureSide(text);
  if (direction === null) return null;
  // A liquidation is a close the mission did not choose, and that is worth its
  // own word: every other close on the thread was a decision.
  if (text.includes("liquidat")) return { direction, action: "close", actionLabel: "Liquidation" };
  if (text.includes("close")) return { direction, action: "close", actionLabel: "Close" };
  if (text.includes("open")) return { direction, action: "open", actionLabel: "Open" };
  return null;
}

/**
 * The same reading for an order that has not filled yet.
 *
 * Nothing has to be inferred here: reduce-only is the flag that says the order
 * may only give exposure back, so it and the side together name the position
 * the order is about — a reduce-only sell closes a long, a plain sell opens a
 * short.
 */
export function readIntentLifecycle(intent: {
  readonly side: "buy" | "sell";
  readonly reduceOnly: boolean;
}): PositionLifecycle {
  if (intent.reduceOnly) {
    return {
      direction: intent.side === "sell" ? "long" : "short",
      action: "close",
      actionLabel: "Close",
    };
  }
  return {
    direction: intent.side === "buy" ? "long" : "short",
    action: "open",
    actionLabel: "Open",
  };
}

/**
 * The leverage a position is actually running at: notional over margin.
 *
 * The fallback for when the exchange's own `leverage` has not been read yet —
 * a mission whose last reconcile predates that field, or one that has never
 * held a position. Notional ÷ margin is the figure the exchange charges margin
 * on, so it matches what Hyperliquid shows next to the market for an isolated
 * position.
 *
 * Null when there is nothing to divide: a flat position, or a snapshot that
 * arrived with no margin or no price to value the size at. A fabricated "1x"
 * would read as a real, deliberately conservative setting.
 */
export function deriveEffectiveLeverage(position: {
  readonly size: number;
  readonly entryPrice?: number | undefined;
  readonly markPrice?: number | undefined;
  readonly marginUsed: number;
}): number | null {
  const price = position.markPrice ?? position.entryPrice ?? null;
  if (price === null || !(price > 0)) return null;
  if (!(position.marginUsed > 0)) return null;
  if (position.size === 0) return null;

  return (Math.abs(position.size) * price) / position.marginUsed;
}

/**
 * "20x" / "3.5x".
 *
 * Whole numbers stay whole — leverage is usually set as one — and anything else
 * keeps a single decimal, which is as fine as the figure is meaningful.
 */
export function formatLeverage(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}x` : `${rounded.toFixed(1)}x`;
}

/** "+0.12%" / "-0.04%". Two decimals: basis points are the scale that matters. */
export function formatSignedPercent(value: number): string {
  const magnitude = Math.abs(value).toFixed(2);
  if (value > 0) return `+${magnitude}%`;
  if (value < 0) return `-${magnitude}%`;
  return "0.00%";
}

/** The figures a paused mission still has at risk while it is not trading. */
export interface PausedExposure {
  readonly exposureLabel: string;
  readonly unrealisedUsd: number;
  readonly liquidationLabel: string;
}

/**
 * What pausing did not stop.
 *
 * The paused card explains that the stop stays live; the numbers underneath it
 * are what that stop is protecting. Null when the mission holds nothing, which
 * is the case where the sentence alone is the whole story.
 */
export function derivePausedExposure(
  position: {
    readonly size: number;
    readonly unrealisedPnl: number;
    readonly liquidationPrice?: number | undefined;
  } | null,
): PausedExposure | null {
  if (position === null || position.size === 0) return null;

  return {
    exposureLabel: `${position.size > 0 ? "Long" : "Short"} ${formatSize(Math.abs(position.size))}`,
    unrealisedUsd: position.unrealisedPnl,
    liquidationLabel:
      position.liquidationPrice === undefined ? "-" : formatPrice(position.liquidationPrice),
  };
}

/**
 * Where to see this mission on the exchange itself.
 *
 * The network comes from the account id, the same signal `describeTradingAccount`
 * reads, so a testnet mission never links at the mainnet book. An account id
 * that names neither gets no link at all — a wrong venue is worse than none.
 */
export function hyperliquidTradeUrl(market: string, tradingAccountId: string): string | null {
  const normalized = tradingAccountId.toLowerCase();
  const host = normalized.includes("testnet")
    ? "https://app.hyperliquid-testnet.xyz"
    : normalized.includes("mainnet")
      ? "https://app.hyperliquid.xyz"
      : null;
  return host === null ? null : `${host}/trade/${market}`;
}

/** One step of the mission-phase breadcrumb. */
export interface MissionPhase {
  readonly label: string;
  readonly state: "done" | "current" | "pending";
}

/** The §11.1 active loop, in the order a mission walks it. */
const LOOP_PHASES: ReadonlyArray<{
  readonly label: string;
  readonly status: TradingMissionStatus;
}> = [
  { label: "Analyse", status: "analysing" },
  { label: "Wait", status: "waiting" },
  { label: "Execute", status: "executing" },
  { label: "Position", status: "position_open" },
];

/**
 * The mission's progress through the §11.1 loop.
 *
 * Empty for every status outside the loop. A paused, blocked, or revoked
 * mission is not somewhere on this path — it has stepped off it — and a
 * breadcrumb that guessed at a position would be the surface contradicting the
 * status the strip is showing right next to it.
 */
export function deriveMissionPhases(status: TradingMissionStatus): ReadonlyArray<MissionPhase> {
  if (status === "completed") {
    return LOOP_PHASES.map((phase) => ({ label: phase.label, state: "done" as const }));
  }

  // `initializing` is before the first step rather than on it: the mission
  // exists and has walked nothing yet.
  if (status === "initializing") {
    return LOOP_PHASES.map((phase) => ({ label: phase.label, state: "pending" as const }));
  }

  const current = LOOP_PHASES.findIndex((phase) => phase.status === status);
  if (current === -1) return [];

  return LOOP_PHASES.map((phase, index) => ({
    label: phase.label,
    state: index < current ? ("done" as const) : index === current ? "current" : "pending",
  }));
}
