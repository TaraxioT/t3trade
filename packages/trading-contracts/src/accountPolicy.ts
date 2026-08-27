/**
 * The account-level risk envelope for MANUAL execution — final-form Phase 7.
 *
 * A mission trades under a `TradingAuthority` the user granted it. A manual
 * order has no mission and no mandate, but the account still deserves a floor
 * under fat-fingered input: a ceiling on what one ticket can put on, and a
 * ceiling on what one stop-out can cost. This is that envelope — the same
 * spirit as `testnetAuthorityDefaults`, scaled off the live account value, and
 * adjustable through the environment the same way `TestnetAuthority` is.
 *
 * What it deliberately is NOT: a cumulative loss budget. Missions carry one
 * because an unattended agent must be stoppable by arithmetic; a manual trader
 * is present for every ticket, and the per-trade bound plus the mandatory stop
 * are the honest protections for that mode.
 *
 * @module TradingAccountPolicy
 */
import { Schema } from "effect";
import { UsdAmount } from "./primitives.ts";
import { pocRiskPolicyDefaults, TradingRiskPolicy } from "./authority.ts";

export const AccountTradingPolicy = Schema.Struct({
  /** The account value the ratios below were scaled from. */
  accountValueUsd: UsdAmount,
  /** Combined open notional ÷ account value may not exceed this. */
  maximumLeverage: Schema.Number.check(Schema.isGreaterThan(0)),
  /** Gross open notional (existing + proposed) may not exceed this. */
  maximumPositionNotionalUsd: UsdAmount,
  /** The planned loss at one ticket's stop may not exceed this. */
  perTradeLossBudgetUsd: UsdAmount,
  /** Fee/slippage accounting policy, shared verbatim with the mission path. */
  riskPolicy: TradingRiskPolicy,
});
export type AccountTradingPolicy = typeof AccountTradingPolicy.Type;

/**
 * Defaults, mirroring the testnet mission mandate's ratios (C = account value):
 * 20x leverage ceiling (documentation more than constraint — the notional cap
 * binds first), 8×C gross notional, 7% of C per-trade planned loss.
 */
export const accountPolicyDefaults = (accountValueUsd: number): AccountTradingPolicy => ({
  accountValueUsd,
  maximumLeverage: 20,
  maximumPositionNotionalUsd: accountValueUsd * 8,
  perTradeLossBudgetUsd: (accountValueUsd * 7) / 100,
  riskPolicy: pocRiskPolicyDefaults,
});

/** A positive finite override, or `null` when the variable is unset or junk. */
const positiveNumber = (raw: string | undefined): number | null => {
  if (raw === undefined) return null;
  const value = Number(raw.trim());
  return Number.isFinite(value) && value > 0 ? value : null;
};

/**
 * The manual envelope for this account: defaults scaled from the account
 * value, with any env override applied on top. Same rule as `TestnetAuthority`
 * for bad input — a typo'd ceiling falls back to the documented default
 * rather than refusing every ticket.
 *
 *   - `T3_TRADES_MANUAL_MAX_LEVERAGE`
 *   - `T3_TRADES_MANUAL_MAX_POSITION_NOTIONAL_USD`
 *   - `T3_TRADES_MANUAL_PER_TRADE_LOSS_USD`
 */
export const resolveAccountPolicy = (
  env: Record<string, string | undefined>,
  accountValueUsd: number,
): AccountTradingPolicy => {
  const base = accountPolicyDefaults(accountValueUsd);
  const maximumLeverage = positiveNumber(env["T3_TRADES_MANUAL_MAX_LEVERAGE"]);
  const maximumPositionNotionalUsd = positiveNumber(
    env["T3_TRADES_MANUAL_MAX_POSITION_NOTIONAL_USD"],
  );
  const perTradeLossBudgetUsd = positiveNumber(env["T3_TRADES_MANUAL_PER_TRADE_LOSS_USD"]);
  return {
    ...base,
    ...(maximumLeverage === null ? {} : { maximumLeverage }),
    ...(maximumPositionNotionalUsd === null ? {} : { maximumPositionNotionalUsd }),
    ...(perTradeLossBudgetUsd === null ? {} : { perTradeLossBudgetUsd }),
  };
};
