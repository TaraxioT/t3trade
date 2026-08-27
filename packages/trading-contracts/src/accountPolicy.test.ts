import { describe, expect, it } from "vite-plus/test";

import { accountPolicyDefaults, resolveAccountPolicy } from "./accountPolicy.ts";

describe("accountPolicy", () => {
  it("scales the defaults off the account value with the testnet mandate's ratios", () => {
    const policy = accountPolicyDefaults(100);
    expect(policy.maximumLeverage).toBe(20);
    expect(policy.maximumPositionNotionalUsd).toBe(800);
    expect(policy.perTradeLossBudgetUsd).toBe(7);
    expect(policy.riskPolicy.stopSlippageReserveBps).toBe(25);
  });

  it("applies env overrides and falls back to the default on junk", () => {
    const policy = resolveAccountPolicy(
      {
        T3_TRADES_MANUAL_MAX_LEVERAGE: "5",
        T3_TRADES_MANUAL_MAX_POSITION_NOTIONAL_USD: "not a number",
        T3_TRADES_MANUAL_PER_TRADE_LOSS_USD: "-3",
      },
      100,
    );
    expect(policy.maximumLeverage).toBe(5);
    // Junk and negatives fall back rather than refusing every ticket.
    expect(policy.maximumPositionNotionalUsd).toBe(800);
    expect(policy.perTradeLossBudgetUsd).toBe(7);
  });
});
