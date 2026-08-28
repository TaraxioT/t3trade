/**
 * The one panel beside the conversation.
 *
 * When a chat thread is about a market — seeded from the trade home, looked at
 * by the agent, or taken as trading authority — that market sits next to the
 * chat instead of a page away. One panel, one market, one chart, composed top
 * to bottom:
 *
 *   1. the market header: the asset, its mark and the day's move
 *   2. one chart: the mission chart with the plan's levels on it when a
 *      mission is bound, the plain market chart otherwise, never both
 *   3. the mission status strip, only when a mission is bound
 *   4. the positions on this market
 *   5. the agent log, which takes the rest and scrolls
 *
 * A bound mission owns 2 to 5: `MissionLivePanel` draws all four from the
 * projection, and this file draws the header above it. Without a mission the
 * panel is the trade home's own components, composed — the phase-6
 * {@link MarketChartPanel} and {@link AccountPositionsPanel} filtered to the
 * one market. Nothing is forked, so a fix to either lands on both surfaces.
 *
 * No alerts here, in either case. The alert feed and its arm form live on the
 * trade home, next to each other, where an armed watch can be read back;
 * arming one from a thread put it somewhere the operator could not see it. The
 * chart's own hover-to-arm chip goes with them, gated off by `armable={false}`
 * rather than by a second chart component.
 *
 * Two layouts, one component. `column` is the wide one: a fixed-width column to
 * the right of the chat, scrolling on its own. `chip` is the narrow one: a
 * single row above the timeline that expands in place. Both live inside the
 * chat's own layout rather than over it, so neither can ever cover the composer.
 *
 * Collapse is persisted per thread (see `threadMarketPanelStore`) and is the
 * way out: the panel arrives on its own, so it must be dismissible without
 * ending the conversation it arrived in.
 *
 * @module ThreadMarketPanel
 */
import type { EnvironmentId, OrchestrationTradingMission } from "@t3tools/contracts";
import { ChevronDownIcon, ChevronRightIcon, PanelRightCloseIcon } from "lucide-react";

import { runtimeTimeframe } from "@t3tools/trading-contracts/strategy";

import { useTradingAccountView } from "../../lib/tradingAccountState";
import { cn } from "../../lib/utils";
import { Skeleton } from "../ui/skeleton";
import { AccountPositionsPanel } from "./AccountPositionsPanel";
import { MarketChartPanel } from "./MarketChartPanel";
import { MissionLivePanel } from "./MissionLivePanel";
import { filterAccountsToMarket } from "./threadMarketPanelState";
import { useThreadMarketPanelCollapsed, useThreadMarketPanelStore } from "./threadMarketPanelStore";
import { formatPrice } from "./tradingPresentation";
import { useTradingUniverseAssets } from "./UniverseAssetSearch";

const CHART_HEIGHT_CLASS = "h-[220px] min-h-0 w-full";

/**
 * The market's mark and day change.
 *
 * The mission's own 3s poll wins the mark when there is a mission: it is the
 * same read the chart draws its live edge from, so the header and the picture
 * under it cannot show two different prices. The universe read (which every
 * thread has) supplies the day's move, and the mark for threads with no
 * mission to ask.
 */
function MarketQuote({
  environmentId,
  asset,
  missionMark,
}: {
  environmentId: EnvironmentId;
  asset: string;
  missionMark: number | null;
}) {
  const universe = useTradingUniverseAssets(environmentId);
  const row = universe.find((entry) => entry.asset === asset) ?? null;
  const mark = missionMark ?? row?.mark ?? null;
  if (mark === null && row === null) return null;
  return (
    <span className="flex items-baseline gap-1.5 text-xs tabular-nums">
      {mark === null ? null : <span className="text-foreground">{formatPrice(mark)}</span>}
      {row === null ? null : (
        <span className={row.change24hPct >= 0 ? "text-profit" : "text-loss"}>
          {row.change24hPct >= 0 ? "+" : ""}
          {row.change24hPct.toFixed(1)}%
        </span>
      )}
    </span>
  );
}

/**
 * The panel's shape while the account read is in flight.
 *
 * Blocks at the heights their content will take, in the order it will take
 * them, so nothing jumps when the read lands. No spinner: a spinner says "wait"
 * without saying what for, and the layout it replaces already says it.
 */
function ThreadMarketSkeleton() {
  return (
    <div className="flex flex-col gap-3" data-testid="thread-market-skeleton">
      <Skeleton className={CHART_HEIGHT_CLASS} />
      <div className="flex flex-col gap-1.5">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-8 w-full" />
      </div>
    </div>
  );
}

/** The panel without a mission: the market's own chart and what is on it. */
function ThreadMarketBody({
  environmentId,
  asset,
  missions,
}: {
  environmentId: EnvironmentId;
  asset: string;
  missions: ReadonlyArray<OrchestrationTradingMission>;
}) {
  const account = useTradingAccountView(environmentId);
  const accounts = account.data?.accounts ?? [];
  const scoped = filterAccountsToMarket(accounts, asset);

  if (account.data === null && account.isLoading) return <ThreadMarketSkeleton />;

  return (
    // Scrolls itself in the column layout, where the aside is bounded and does
    // not. In the chip layout nothing bounds it, so nothing overflows.
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
      <MarketChartPanel
        environmentId={environmentId}
        asset={asset}
        className={CHART_HEIGHT_CLASS}
        // The armed watch would land in the alert list on the trade home, one
        // surface away from the chart that armed it.
        armable={false}
      />
      {account.error === null ? null : (
        <p className="px-1 text-xs text-destructive">{account.error}</p>
      )}
      <AccountPositionsPanel
        accounts={scoped}
        missions={missions}
        environmentId={environmentId}
        selectedAsset={asset}
        // The panel is already about one market, so selecting a row would be
        // selecting what is already selected.
        onSelect={() => {}}
      />
    </div>
  );
}

export interface ThreadMarketPanelProps {
  readonly environmentId: EnvironmentId;
  readonly asset: string;
  /**
   * The mission bound to this thread, or null. It decides the whole body: with
   * one, the panel is the mission's chart, strip, positions and log; without,
   * it is the market's chart and the positions on it.
   */
  readonly mission: OrchestrationTradingMission | null;
  readonly missions: ReadonlyArray<OrchestrationTradingMission>;
  /** The scoped thread key the collapsed flag is stored under. */
  readonly threadKey: string;
  readonly layout: "column" | "chip";
}

export function ThreadMarketPanel({
  environmentId,
  asset,
  mission,
  missions,
  threadKey,
  layout,
}: ThreadMarketPanelProps) {
  // Untouched, the panel is open beside a wide chat and a chip on a narrow one.
  // Once the user has collapsed or expanded it, that choice is what is read.
  const collapsed = useThreadMarketPanelCollapsed(threadKey, layout === "chip");
  const setCollapsed = useThreadMarketPanelStore((state) => state.setCollapsed);
  const isOpen = !collapsed;

  const body =
    mission === null ? (
      <ThreadMarketBody environmentId={environmentId} asset={asset} missions={missions} />
    ) : (
      <MissionLivePanel mission={mission} environmentId={environmentId} />
    );

  // Which bars the mission's chart is made of. Derived from the mandate with
  // the same function the panel resolves its own candles with, so the label
  // and the picture cannot disagree. The market chart offers its own timeframe
  // selector, so it states nothing here.
  const intervalLabel = mission === null ? null : runtimeTimeframe(mission.instruction);

  const header = (
    <div className="flex items-center gap-2 px-1">
      {layout === "chip" ? (
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md py-1 text-left"
          aria-expanded={isOpen}
          onClick={() => setCollapsed(threadKey, isOpen)}
          data-testid="thread-market-chip"
        >
          {isOpen ? (
            <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="text-sm font-semibold text-foreground">{asset}</span>
          <MarketQuote
            environmentId={environmentId}
            asset={asset}
            missionMark={mission?.marketPrice ?? null}
          />
        </button>
      ) : (
        <>
          <span className="text-sm font-semibold text-foreground">{asset}</span>
          <MarketQuote
            environmentId={environmentId}
            asset={asset}
            missionMark={mission?.marketPrice ?? null}
          />
          {intervalLabel === null ? null : (
            <span
              data-testid="thread-market-interval"
              // Lower case, deliberately: "1M" is a month in every chart app
              // the operator has ever used, and this is one minute.
              className="flex-none rounded-full border border-border/60 px-1.5 py-0.5 font-mono text-[10px] lowercase tracking-[0.08em] text-muted-foreground"
            >
              {intervalLabel}
            </span>
          )}
          <button
            type="button"
            aria-label={`Hide the ${asset} panel`}
            className="ml-auto rounded-md p-1 text-muted-foreground hover:text-foreground"
            onClick={() => setCollapsed(threadKey, true)}
            data-testid="thread-market-collapse"
          >
            <PanelRightCloseIcon className="size-4" />
          </button>
        </>
      )}
    </div>
  );

  if (layout === "column" && !isOpen) {
    // The way back in on a wide viewport: a rail the width of its own button,
    // so a hidden panel is still visibly there.
    return (
      <aside
        aria-label={`${asset} market`}
        className="flex w-9 shrink-0 flex-col items-center border-border/60 border-l pt-2"
      >
        <button
          type="button"
          aria-label={`Show the ${asset} panel`}
          className="flex flex-col items-center gap-1 rounded-md px-1 py-2 text-muted-foreground hover:text-foreground"
          onClick={() => setCollapsed(threadKey, false)}
          data-testid="thread-market-expand"
        >
          <ChevronRightIcon className="size-4 rotate-180" />
          <span className="[writing-mode:vertical-rl] text-[11px] font-medium tracking-wide">
            {asset}
          </span>
        </button>
      </aside>
    );
  }

  if (layout === "chip") {
    return (
      <section
        aria-label={`${asset} market`}
        className={cn(
          "thread-market-panel shrink-0 border-border/60 border-b px-2 py-1",
          isOpen && "max-h-[45vh] overflow-y-auto",
        )}
        data-testid="thread-market-panel"
      >
        {header}
        {isOpen ? <div className="pt-2 pb-1">{body}</div> : null}
      </section>
    );
  }

  return (
    <aside
      aria-label={`${asset} market`}
      // `overflow-hidden` rather than `overflow-y-auto`: the agent log is the
      // section that scrolls, and a scrollbar on the column as well would put
      // the log inside a second one.
      className="thread-market-panel flex w-[21rem] shrink-0 flex-col gap-2 overflow-hidden border-border/60 border-l px-2 py-2 xl:w-[24rem]"
      data-testid="thread-market-panel"
    >
      {header}
      {body}
    </aside>
  );
}
