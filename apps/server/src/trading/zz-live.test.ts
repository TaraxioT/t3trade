import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { makeTradingBacktestService } from "./TradingBacktestService.ts";
import { makeTradingMarketArchive } from "./TradingMarketArchive.ts";
import type { TradingThesis } from "@t3tools/trading-contracts/thesis";

const PATH = NodePath.join(NodeOS.homedir(), ".t3trade", "userdata", "market-archive.sqlite");
const svc = makeTradingBacktestService(makeTradingMarketArchive(PATH, "hyperliquid"));

const show = (name: string, o: unknown) => {
  const r = o as { status: string; detail?: string; report?: any; elapsedMillis?: number };
  if (r.status !== "ok") {
    console.log(`\n### ${name}\nREFUSED ${(r as any).reason}: ${r.detail}`);
    return;
  }
  const s = r.report.stats,
    c = r.report.coverage,
    k = r.report.costs;
  console.log(`\n### ${name}
  ${r.report.verdict.toUpperCase()}  (${r.elapsedMillis} ms)
  setups ${s.setupsFound}  trades ${s.tradesTaken}  unpriced ${s.setupsUnpriced}
  wins ${s.wins} / losses ${s.losses}   win rate ${s.winRatePercent}%
  avg win ${s.averageWinUsd}  avg loss ${s.averageLossUsd}
  EXPECTANCY AFTER FEES ${s.expectancyUsd}   total net ${s.totalNetUsd}
  gross ${s.totalGrossUsd}  fees ${s.totalFeesUsd}  funding ${s.totalFundingUsd}
  max drawdown ${s.maxDrawdownUsd}  time in market ${s.timeInMarketPercent}%
  buy and hold ${s.buyAndHoldNetUsd} (${s.buyAndHoldReturnPercent}%)
  coverage: ${c.barsServed} bars, gaps ${c.gaps.length}, funding ${c.fundingServed}
  costs: ${k.takerFeeBpsPerSide} bps taker, ${k.slippageBpsPerSide.toFixed(3)} bps crossing (${k.slippageSource})
  verdict: ${r.report.verdictReason}`);
};

const emaCross = (market: string, interval: any, side: "long" | "short"): TradingThesis => ({
  market,
  interval,
  side,
  entry: {
    predicates: [
      {
        left: { source: "indicator", indicator: "ema", period: 9 },
        comparator: side === "long" ? "crosses_above" : "crosses_below",
        right: { source: "indicator", indicator: "ema", period: 21 },
      },
    ],
  },
  exits: {
    stop: { basis: "atr", multiple: 1.5, period: 14 },
    target: { basis: "r", multiple: 1.5 },
    maxHoldBars: 48,
  },
});

it(
  "live",
  () =>
    Effect.gen(function* () {
      const now = Date.now();
      // The sanity check: ema_cross was killed on this fork for having no gross
      // edge on 5m. If this shows a large positive edge, suspect the engine.
      show(
        "ema9/21 cross LONG, BTC 5m",
        yield* svc.run({ thesis: emaCross("BTC", "5m", "long"), now }),
      );
      show(
        "ema9/21 cross SHORT, BTC 5m",
        yield* svc.run({ thesis: emaCross("BTC", "5m", "short"), now }),
      );
      show(
        "ema9/21 cross LONG, ETH 5m",
        yield* svc.run({ thesis: emaCross("ETH", "5m", "long"), now }),
      );

      // The brief's own example.
      show(
        "RSI(14) < 30 mean reversion, ETH 15m",
        yield* svc.run({
          thesis: {
            market: "ETH",
            interval: "15m",
            side: "long",
            entry: {
              predicates: [
                {
                  left: { source: "indicator", indicator: "rsi", period: 14 },
                  comparator: "crosses_below",
                  right: { source: "constant", value: 30 },
                },
              ],
            },
            exits: {
              stop: { basis: "atr", multiple: 1.5, period: 14 },
              target: { basis: "r", multiple: 1.5 },
              maxHoldBars: 48,
            },
          },
          now,
        }),
      );

      // Refusals.
      show(
        "a year of 1m",
        yield* svc.run({ thesis: { ...emaCross("BTC", "1m", "long") }, lookbackDays: 365, now }),
      );
      show(
        "no exits",
        yield* svc.run({ thesis: { ...emaCross("BTC", "5m", "long"), exits: {} }, now }),
      );
    }).pipe(Effect.runPromise),
  120_000,
);
