import type { MarketWatch, TradingMissionStatus } from "@t3tools/trading-contracts";

/** The ten §11.1 statuses, as the workspace names them. */
export const MISSION_STATUS_LABELS: Record<TradingMissionStatus, string> = {
  initializing: "Initializing",
  analysing: "Analysing",
  waiting: "Waiting",
  executing: "Executing",
  position_open: "Position open",
  paused: "Paused",
  agent_unavailable: "Agent unavailable",
  blocked: "Blocked",
  revoked: "Revoked",
  completed: "Completed",
};

export const formatUsd = (value: number): string =>
  value.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    // Whole dollars once the cents stop mattering, cents while they are the
    // whole figure. A plan targeting $0.66 printed "$1" — a 50% overstatement
    // of the only number on the panel that says what the trade is for — and
    // the same rounding turned a $0.40 risk into "$0".
    maximumFractionDigits: Math.abs(value) < 10 ? 2 : 0,
  });

/**
 * A signed dollar figure, so a P&L reads as a direction and not just a number.
 * Cents are kept: a result of "+$0" for eighty cents would be a lie.
 */
export const formatSignedUsd = (value: number): string => {
  const magnitude = Math.abs(value).toFixed(2);
  if (value > 0) return `+$${magnitude}`;
  if (value < 0) return `-$${magnitude}`;
  return "$0.00";
};

/**
 * A market price as the exchange quotes it.
 *
 * Precision varies by market — ETH trades to the cent, BTC to the dollar — so
 * this keeps whatever the projection carried up to two decimals rather than
 * padding every price to a fixed width it does not have.
 */
export const formatPrice = (value: number): string =>
  value.toLocaleString(undefined, { maximumFractionDigits: 2 });

/**
 * A position or fill size in base units.
 *
 * Sizes reach the UI as sums of partial fills, so a clean 3 ETH order arrives as
 * 2.9999999999999996 and rendered raw it reads as a broken feed. Four decimals
 * is the finest lot size the POC's markets quote, so nothing real is lost.
 */
export const formatSize = (value: number): string =>
  value.toLocaleString(undefined, { maximumFractionDigits: 4 });

/** Turn an underscored domain literal into prose without inventing wording. */
export const humanizeLiteral = (value: string): string => value.replaceAll("_", " ");

/**
 * One line describing what a watch is waiting for.
 *
 * Watches are deterministic predicates (§11.3), so this reads the predicate
 * back rather than summarizing or interpreting it.
 */
export function describeWatch(watch: MarketWatch): string {
  switch (watch.type) {
    case "price_cross":
      return `${watch.market} ${watch.priceSource} crosses ${watch.direction} ${watch.price}`;
    case "candle_close":
      return `${watch.market} ${watch.interval} candle closes ${watch.direction} ${watch.price}`;
    case "order_update":
      return `Order ${watch.cloid} updates`;
    case "position_update":
      return `${watch.market} position updates`;
    case "scheduled_reassessment":
      return `Scheduled reassessment at ${new Date(watch.runAt).toISOString()}`;
    case "pnl_above":
      return `${watch.market} unrealised PnL reaches $${watch.valueUsd}`;
    case "pnl_below":
      return `${watch.market} unrealised PnL falls to $${watch.valueUsd}`;
    case "pnl_giveback":
      return `${watch.market} unrealised PnL gives back $${watch.drawdownUsd} from its peak`;
    case "metric_threshold":
      return `${watch.market} ${humanizeLiteral(watch.metric)} crosses ${watch.direction} ${watch.value}`;
    // A derived metric reads the same in prose as a snapshot one; a flip has
    // no threshold to name.
    case "metric_derived":
      return watch.direction === undefined
        ? `${watch.market} ${humanizeLiteral(watch.metric)} flips`
        : `${watch.market} ${humanizeLiteral(watch.metric)} ${watch.mode === "level" ? "reaches" : "crosses"} ${watch.direction} ${watch.value}`;
  }
}

/**
 * How long ago something happened, in the coarsest true words: "just now",
 * "4m ago", "1h 12m ago".
 *
 * Deliberately not {@link formatDuration}. A stream of rows all reading
 * "armed 8m 47s ago" reprints every second, so every row looks freshly minted
 * and the eye is pulled to whichever digits happen to be changing — while the
 * seconds themselves answer nothing about a level armed eight minutes ago.
 * Countdowns keep their seconds (the bottom bar really is counting one down);
 * ages lose them the moment a minute has passed.
 */
export function formatAge(millis: number): string {
  const totalSeconds = Math.max(0, Math.floor(millis / 1_000));
  if (totalSeconds < 60) return "just now";
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ago`;
}

/** "2m 30s" from a duration in millis. */
export function formatDuration(millis: number): string {
  const totalSeconds = Math.max(0, Math.round(millis / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}
