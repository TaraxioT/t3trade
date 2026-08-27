import { assert, describe, it } from "@effect/vitest";

import { foldFollowSet, watchMarket, type FollowedMarket } from "./FollowSetRegistry.ts";

const market = (asset: string, reason: FollowedMarket["reason"]): FollowedMarket => ({
  venue: "hyperliquid",
  asset,
  reason,
});

describe("foldFollowSet", () => {
  it("follows a market once, for the strongest reason", () => {
    const folded = foldFollowSet([
      market("ETH", "chart"),
      market("ETH", "position"),
      market("ETH", "watchlist"),
    ]);
    assert.deepEqual(folded, [market("ETH", "position")]);
  });

  // The cap is what keeps attention-driven recording from becoming
  // universe-wide recording, so what it drops matters: never the thing
  // somebody has money in.
  it("drops glances before it drops positions", () => {
    const charts = Array.from({ length: 30 }, (_, index) => market(`ALT${index}`, "chart"));
    const folded = foldFollowSet([...charts, market("BTC", "position")], 3);
    assert.equal(folded.length, 3);
    assert.equal(folded[0]?.asset, "BTC");
  });

  it("keeps the venue as part of the identity", () => {
    const folded = foldFollowSet([
      { venue: "hyperliquid", asset: "ETH", reason: "watchlist" },
      { venue: "hyperliquid", asset: "BTC", reason: "watchlist" },
    ]);
    assert.deepEqual(folded.map((entry) => entry.asset).sort(), ["BTC", "ETH"]);
  });
});

describe("watchMarket", () => {
  it("reads the market out of a persisted watch", () => {
    assert.equal(watchMarket('{"type":"price_cross","market":"SOL"}'), "SOL");
  });

  it("answers null rather than throwing on anything else", () => {
    assert.isNull(watchMarket("not json"));
    assert.isNull(watchMarket("{}"));
    assert.isNull(watchMarket('{"market":""}'));
  });
});
