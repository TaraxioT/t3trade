/**
 * MarketChartPanel (final-form phase 6): the chart of any followed market —
 * no mission required.
 *
 * The server entitles the read off the follow set (watchlist, positions,
 * armed watches, recent chart opens), so this panel simply asks for the
 * series and renders it through the same `MissionPriceChart` the mission
 * panels use, with the phase-6 overlays that only make sense here: a
 * timeframe selector over the archive's interval set, a volume underlay,
 * session-level rules, and coverage shading for the stretches the archive
 * never recorded.
 *
 * The one interaction it adds is arm-at-price: hovering the plot docks a
 * chip in the gutter at the pointer's price, and clicking it arms a notify
 * watch there — above/below by where the price sits relative to the mark.
 * The chip goes through the same `armTradingWatch` RPC the alert panel's
 * form uses, so the armed watch shows up in that panel's list immediately.
 *
 * No clock of its own: the chart poll lives in `useTradingMarketChart`, and
 * nothing here animates continuously.
 *
 * @module MarketChartPanel
 */
import type { EnvironmentId, TradingArmWatchInput } from "@t3tools/contracts";
import { useState } from "react";

import { refreshTradingWatches } from "../../lib/tradingAccountState";
import { useTradingMarketChart, type ChartInterval } from "../../lib/tradingMarketChartState";
import { cn } from "../../lib/utils";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatPrice } from "./tradingPresentation";
import { MissionPriceChart } from "./MissionPriceChart";
import { describeControlFailure } from "./useMissionControls";

/** The intervals offered, in axis order — the archive's own set. */
const INTERVALS: ReadonlyArray<ChartInterval> = ["1m", "3m", "5m", "15m", "1h", "4h", "1d"];

/** What the last arm-at-price click came to. */
type ArmStatus =
  | { readonly kind: "armed"; readonly text: string }
  | { readonly kind: "failed"; readonly text: string };

export function MarketChartPanel({
  environmentId,
  asset,
  className,
}: {
  environmentId: EnvironmentId;
  asset: string;
  /** Sizing for the chart frame itself, e.g. the trade home's height class. */
  className?: string;
}) {
  const [interval, setChartInterval] = useState<ChartInterval>("5m");
  const chart = useTradingMarketChart(environmentId, asset, interval, { enabled: true });
  const arm = useAtomCommand(orchestrationEnvironment.armTradingWatch);
  const [armStatus, setArmStatus] = useState<ArmStatus | null>(null);
  const [isArming, setIsArming] = useState(false);

  const data = chart.data;

  const armAtPrice = (price: number) => {
    if (isArming || data === null) return;
    const direction: "above" | "below" = price >= data.markPrice ? "above" : "below";
    const input: TradingArmWatchInput = {
      condition: { kind: "price", market: asset, direction, price, confirm: "touch" },
      deliver: "notify",
      rearm: { mode: "once" },
    };
    setIsArming(true);
    setArmStatus(null);
    void arm({ environmentId, input }).then((result) => {
      setIsArming(false);
      const failure = describeControlFailure(result);
      if (failure !== null) {
        setArmStatus({ kind: "failed", text: failure });
        return;
      }
      if (result._tag === "Success" && result.value.outcome === "rejected") {
        setArmStatus({ kind: "failed", text: result.value.reason });
        return;
      }
      setArmStatus({
        kind: "armed",
        text: `Alert armed: ${asset} ${direction} ${formatPrice(price)}`,
      });
      refreshTradingWatches(environmentId);
    });
  };

  return (
    <div className="flex flex-col gap-1">
      {data !== null && data.candles.length >= 2 ? (
        <MissionPriceChart
          candles={data.candles}
          entryPrice={null}
          stopPrice={null}
          targetPrice={null}
          liquidationPrice={null}
          entryTime={null}
          markPrice={data.markPrice}
          pnlSign={null}
          showVolume
          {...(data.sessionLevels === undefined ? {} : { sessionLevels: data.sessionLevels })}
          {...(data.recordingSince === undefined ? {} : { recordingSince: data.recordingSince })}
          {...(data.gaps === undefined ? {} : { gaps: data.gaps })}
          onArmAtPrice={armAtPrice}
          {...(className === undefined ? {} : { className })}
        />
      ) : (
        <div
          className={cn(
            "flex items-center justify-center rounded-md border border-border/60 px-6 text-center text-sm text-muted-foreground",
            className,
          )}
        >
          {chart.error !== null
            ? "Chart unavailable"
            : data !== null
              ? `Not enough ${interval} bars recorded for ${asset} yet.`
              : "Loading chart…"}
        </div>
      )}
      <div className="flex items-center gap-2 px-1">
        <div
          className="flex overflow-hidden rounded-md border border-border/60 font-mono text-[10.5px] leading-none"
          role="group"
          aria-label="Chart timeframe"
        >
          {INTERVALS.map((option) => (
            <button
              key={option}
              type="button"
              data-testid={`market-chart-interval-${option}`}
              className={cn(
                "cursor-pointer px-1.5 py-1 transition-colors",
                option === interval
                  ? "bg-accent font-medium text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
              onClick={() => setChartInterval(option)}
            >
              {option}
            </button>
          ))}
        </div>
        {armStatus === null ? (
          <span className="text-[10.5px] text-muted-foreground/80">
            Hover the chart and click the chip to arm a price alert.
          </span>
        ) : (
          <span
            data-testid="market-chart-arm-status"
            className={cn(
              "text-[10.5px]",
              armStatus.kind === "failed" ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {armStatus.text}
          </span>
        )}
      </div>
    </div>
  );
}
