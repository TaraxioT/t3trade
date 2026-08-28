import { assert, describe, it } from "@effect/vitest";

import { manualOrderAlertSummary } from "./alertProse.ts";

describe("manualOrderAlertSummary", () => {
  it("says a refusal in prose, with no rule name and no dash", () => {
    const summary = manualOrderAlertSummary({
      side: "buy",
      market: "BTC",
      outcome: "refused",
      detail: "a buy entry at 81093 needs its stop below that price; got 82500",
    });
    assert.equal(
      summary,
      "Manual buy BTC refused. A buy entry at 81093 needs its stop below that price; got 82500",
    );
    assert.notInclude(summary, "—");
    assert.notInclude(summary, "stop_on_wrong_side");
  });

  it("falls back to the stage in prose when the venue said nothing", () => {
    assert.equal(
      manualOrderAlertSummary({
        side: "sell",
        market: "ETH",
        outcome: "failed",
        detail: undefined,
        stage: "submit_failed",
      }),
      "Manual sell ETH failed. The venue did not accept the order.",
    );
  });

  it("prefers the venue's own detail over the stage name", () => {
    const summary = manualOrderAlertSummary({
      side: "sell",
      market: "ETH",
      outcome: "failed",
      detail: "insufficient margin for this size",
      stage: "submit_failed",
    });
    assert.equal(summary, "Manual sell ETH failed. Insufficient margin for this size");
    assert.notInclude(summary, "submit_failed");
  });
});
