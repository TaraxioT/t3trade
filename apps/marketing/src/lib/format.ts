/**
 * Number formatters for the cockpit replica, ported from the app's own
 * presentation layer (apps/web/src/components/trading/tradingPresentation.ts)
 * so the replica's strings cannot drift from the product's.
 *
 * One deliberate divergence, preserved from the page's original inline
 * formatters rather than introduced here: the app's signed formatters print
 * "$0.00" / "0.00%" at exactly zero, while the page's replay reels count up
 * from a zero frame rendered as "+$0.00" / "+0.00%". The reels rest on their
 * final step, but step zero is the pre-scroll frame, and changing its sign
 * would be a visible change. Non-zero output is byte-identical to the app.
 */

/** A market price as the exchange quotes it (app formatPrice). */
export const formatPrice = (value: number): string =>
  value.toLocaleString("en-US", { maximumFractionDigits: 2 });

/** A signed dollar P&L figure (app formatSignedUsd; see the header note on zero). */
export const formatSignedUsd = (value: number): string =>
  `${value >= 0 ? "+" : "-"}$${Math.abs(value).toFixed(2)}`;

/** A signed ROI/percent figure (app formatSignedPercent; see the header note on zero). */
export const formatSignedPercent = (value: number): string =>
  `${value >= 0 ? "+" : "-"}${Math.abs(value).toFixed(2)}%`;

/** A 24h change: unsigned plus, minus carried by the value itself. */
export const formatChangePercent = (value: number): string =>
  `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;

/** A rounded notional in whole dollars, the way the positions card prints size in USD. */
export const formatNotionalUsd = (price: number, size: number): string =>
  `$${Math.round(price * size).toLocaleString("en-US")}`;
