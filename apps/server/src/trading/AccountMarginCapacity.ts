/**
 * What the exchange account can actually fund, in gross notional.
 *
 * `account_value * leverage`, both from the reconciler's own snapshots. The
 * mandate's ceilings say what the mission MAY take; this says what the account
 * CAN settle, and when they disagree the account wins — an entry sized off an
 * 8x mandate against a 1x account fills an eighth of the request and reports
 * `filled`.
 *
 * Shared because two callers need the same number for opposite reasons: the
 * entry service bounds the order by it, and the wake's cost line prices by it.
 * They were not shared before, and the cost line quoted the plan's declared
 * $500 while every entry actually took ~$900 — so the round trip the model
 * reasoned against was half the one it paid, and every target it set cleared a
 * rung that was half as high as the real one.
 *
 * @module AccountMarginCapacity
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * The slice of the account's margin the sizer refuses to spend, in bps.
 *
 * `account_value * leverage` is the venue's REJECTION line, not a safe target,
 * and sizing to it made whether a first order landed a matter of tick timing: a
 * live entry sized to $857.2460 against an account value of $857.2857 was
 * rejected for insufficient margin, and the retry at $857.2301 — four cents
 * lower — went through. Four cents is not a decision, it is a coin flip.
 *
 * 100 bps, because three things sit between the number sized against and the
 * number the exchange checks, and the reserve has to cover all of them:
 *
 *   - the entry IOC crosses with a 50 bps allowance
 *     (`DEFAULT_IOC_SLIPPAGE_BPS`), so a fill that sweeps the book costs up to
 *     50 bps more notional than the far-side quote it was sized from;
 *   - one taker fee, about 4.5 bps of notional, leaves the account on the fill;
 *   - the mark moves between the book read and the exchange's own check — 0.5
 *     bps decided the rejection above.
 *
 * That is ~55 bps of known drift; 100 bps is the round number above it with
 * room to spare. It costs about $8.57 of usable notional on an $857 account,
 * which is the price of an entry that lands the first time.
 */
export const ACCOUNT_MARGIN_HEADROOM_BPS = 100;

/**
 * A conservative isolated-margin liquidation estimate for a NEW entry.
 *
 * Hyperliquid's real liquidation price depends on margin mode, transferred
 * margin, and the maintenance-margin tier; none of that is knowable at ticket
 * time without another exchange call. This is the standard isolated
 * approximation at full margin utilisation —
 * long: `entry * (1 - 1/L + mmf)`, short mirrored — where the maintenance
 * margin fraction is half the initial margin at the market's max leverage
 * (`1 / (2 * maxLeverage)`, the venue's published rule). Extra isolated
 * margin only pushes the true liquidation FURTHER from entry, so this
 * estimate errs toward refusing: a stop the estimate calls unprotective is
 * refused even when the exchange might have honoured it.
 *
 * Returns null when there is nothing to estimate from (no positive entry or
 * leverage) — null is "unknown", never "safe".
 */
export const estimateIsolatedLiquidationPrice = (input: {
  readonly side: "buy" | "sell";
  readonly entryPrice: number;
  /** The leverage the exchange has this market configured at for the account. */
  readonly leverage: number;
  /** The market's max leverage, for the maintenance fraction; falls back to `leverage`. */
  readonly maxLeverage?: number | undefined;
}): number | null => {
  const { entryPrice, leverage } = input;
  if (!(entryPrice > 0) || !(leverage > 0)) return null;
  const tierLeverage =
    input.maxLeverage !== undefined && input.maxLeverage > 0 ? input.maxLeverage : leverage;
  const maintenanceMarginFraction = 1 / (2 * tierLeverage);
  return input.side === "buy"
    ? Math.max(0, entryPrice * (1 - 1 / leverage + maintenanceMarginFraction))
    : entryPrice * (1 + 1 / leverage - maintenanceMarginFraction);
};

/**
 * The account's fundable notional, net of
 * {@link ACCOUNT_MARGIN_HEADROOM_BPS}, or null when there is no account value
 * to read. Null is "unknown", never "zero": an unreadable row must not bound an
 * entry, and must not price a cost line either.
 *
 * The headroom is applied here rather than at the one caller that sizes,
 * because the callers that PRICE must quote the notional an entry will really
 * be allowed to take. A cost line drawn against a notional the sizer will
 * refuse is the same lie this module was written to end.
 */
export const readAccountMarginCapacityUsd = (
  sql: SqlClient.SqlClient,
  input: {
    readonly missionId: string;
    readonly market: string;
  },
): Effect.Effect<number | null> =>
  Effect.gen(function* () {
    const accounts = yield* sql<{ readonly account_value: number }>`
      SELECT account_value FROM trading_account_observations
      WHERE mission_id = ${input.missionId}
    `;
    const positions = yield* sql<{ readonly leverage: number | null }>`
      SELECT leverage FROM trading_position_snapshots
      WHERE mission_id = ${input.missionId} AND market = ${input.market}
    `;
    const accountValue = accounts[0]?.account_value;
    if (accountValue == null || !(accountValue > 0)) return null;

    // No snapshot row exists until the mission has held a position, so the
    // FIRST entry of a mission read a null leverage — and a null capacity
    // removed the ceiling entirely rather than lowering it. That is how one
    // mission's opening order asked for $6,809 against a 1x account holding
    // $900: every later entry was bound by `account_margin`, and only the
    // first had nothing to bind it. Unlevered is the floor no account can be
    // below, so it is the honest stand-in for a leverage nobody has reported.
    const leverage = positions[0]?.leverage ?? 1;
    if (!(leverage > 0)) return null;
    return accountValue * leverage * (1 - ACCOUNT_MARGIN_HEADROOM_BPS / 10_000);
  }).pipe(
    // A sizing bound and a cost reference are both enrichments. An unreadable
    // row leaves each exactly as it was before this existed.
    //
    // `catchCause`, not `orElseSucceed`: a missing table is a DEFECT, not a
    // typed failure, and recovering only the error channel let one take a
    // whole `trading_look` down with "internal server error".
    Effect.catchCause(() => Effect.succeed(null)),
  );
