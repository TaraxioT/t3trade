import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import { POC_STANDING_INSTRUCTION } from "@t3tools/trading-contracts/strategy";

import { AUTO_MISSION_DEFAULT_ACCOUNT_ID, resolveAutoMission } from "./AutoMissionConfig.ts";

const ON = { T3_TRADES_AUTO_MISSION: "1" };

describe("resolveAutoMission", () => {
  // The shortcut creates authority to spend money without anyone asking for it.
  // Nothing short of the knob saying so turns it on — it used to be inferred
  // from the signer being armed, which is a key being present, not consent.
  it("is off unless the knob says otherwise", () => {
    expect(Option.isNone(resolveAutoMission({}))).toBe(true);
    expect(Option.isNone(resolveAutoMission({ T3_TRADES_AUTO_MISSION: "0" }))).toBe(true);
    expect(Option.isNone(resolveAutoMission({ T3_TRADES_AUTO_MISSION: "true" }))).toBe(true);
    expect(
      Option.isNone(
        resolveAutoMission({
          T3_TRADES_AUTO_MISSION_CAPITAL_USD: "500",
          T3_TRADES_AUTO_MISSION_INSTRUCTION: "Trade something",
          T3_TRADES_AUTO_MISSION_WORKSPACE: "/lab/t3-trade-test",
        }),
      ),
    ).toBe(true);
  });

  it("is on for the knob alone, with no workspace narrowing by default", () => {
    expect(Option.getOrThrow(resolveAutoMission(ON))).toEqual({
      workspaceRoot: null,
      standingInstruction: POC_STANDING_INSTRUCTION,
      // Unset means "size the mandate from the live account value at
      // creation" — see `MissionCapital`.
      allocatedCapitalUsd: null,
      tradingAccountId: AUTO_MISSION_DEFAULT_ACCOUNT_ID,
    });
  });

  it("takes the overrides when they are given", () => {
    const settings = resolveAutoMission({
      ...ON,
      T3_TRADES_AUTO_MISSION_WORKSPACE: "/lab/t3-trade-test",
      T3_TRADES_AUTO_MISSION_CAPITAL_USD: "250",
      T3_TRADES_AUTO_MISSION_INSTRUCTION: "Trade ETH momentum on 5m candles.",
      T3_TRADES_AUTO_MISSION_ACCOUNT: "acct_2",
    });

    expect(Option.getOrThrow(settings)).toEqual({
      workspaceRoot: "/lab/t3-trade-test",
      standingInstruction: "Trade ETH momentum on 5m candles.",
      allocatedCapitalUsd: 250,
      tradingAccountId: "acct_2",
    });
  });

  // The note is appended to the user's own mandate, so "append nothing" has to
  // be sayable. It is the one knob where set-but-empty differs from unset.
  it("appends nothing when the standing note is set empty", () => {
    const settings = resolveAutoMission({ ...ON, T3_TRADES_AUTO_MISSION_INSTRUCTION: "  " });
    expect(Option.getOrThrow(settings).standingInstruction).toBe("");
  });

  // The note carries the interval the loop turns on and nothing else. A market
  // named here would contradict whatever market the user's mandate names — the
  // same drift this rename exists to close, pointing the other way.
  it("keeps the default note free of any market or direction", () => {
    expect(POC_STANDING_INSTRUCTION).not.toMatch(/\bETH\b|\bBTC\b|\blong\b|\bshort\b/);
    expect(POC_STANDING_INSTRUCTION).toContain("5m");
  });

  it("treats a whitespace-only workspace root as no narrowing", () => {
    const settings = resolveAutoMission({ ...ON, T3_TRADES_AUTO_MISSION_WORKSPACE: "   " });
    expect(Option.getOrThrow(settings).workspaceRoot).toBe(null);
  });

  // A capital value that is not a positive number would create a mission whose
  // whole mandate is derived from it — a $0 or NaN mandate. Falling through to
  // the account value is a better answer than either.
  it("defers to the account for an unusable capital value", () => {
    for (const raw of ["", "0", "-100", "abc"]) {
      const settings = resolveAutoMission({ ...ON, T3_TRADES_AUTO_MISSION_CAPITAL_USD: raw });
      expect(Option.getOrThrow(settings).allocatedCapitalUsd).toBe(null);
    }
  });

  // The whole point of an explicit grant: it is the operator's statement of a
  // mandate, not a request to be checked against the balance.
  it("takes an explicit capital value verbatim, however large", () => {
    const settings = resolveAutoMission({ ...ON, T3_TRADES_AUTO_MISSION_CAPITAL_USD: "5000" });
    expect(Option.getOrThrow(settings).allocatedCapitalUsd).toBe(5000);
  });
});
