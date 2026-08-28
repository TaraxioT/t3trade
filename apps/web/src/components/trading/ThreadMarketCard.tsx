/**
 * The market, where the trader is already looking.
 *
 * A trading thread's chart and positions sit in the chat column, docked above
 * the composer: the picture of the market and what is on it, directly under
 * the sentence being typed about them. They used to live in the panel beside
 * the chat, a column away from the conversation and beside the agent log they
 * had nothing to do with — and the fills among them were said twice, once as a
 * card in the timeline and once as a row in the panel.
 *
 * What the card holds is the same in both of the thread's two states, only
 * sourced differently:
 *
 *   bound     the mission chart with the plan's levels across it, and the
 *             mission's own order ledger — `MissionLivePanel parts="market"`
 *   unbound   the plain market chart with its timeframe selector, and the
 *             account's positions on that market
 *
 * The panel beside the chat keeps what is left: the market header, the mission
 * status strip and the agent log. So there is exactly one chart in a thread
 * view, and every card renders in exactly one place.
 *
 * Collapse is per thread and persisted, and collapsing unmounts the body
 * rather than hiding it: a folded card holds no chart poll, no ticker and no
 * subscription, so a thread whose market the trader is not watching costs the
 * websocket nothing.
 *
 * @module ThreadMarketCard
 */
import type { EnvironmentId, OrchestrationTradingMission } from "@t3tools/contracts";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";

import { useTradingAccountView } from "../../lib/tradingAccountState";
import { cn } from "../../lib/utils";
import { Skeleton } from "../ui/skeleton";
import { AccountPositionsPanel } from "./AccountPositionsPanel";
import { MarketChartPanel } from "./MarketChartPanel";
import { MissionLivePanel } from "./MissionLivePanel";
import { MarketQuote } from "./ThreadMarketPanel";
import { filterAccountsToMarket } from "./threadMarketPanelState";
import { useThreadMarketCardCollapsed, useThreadMarketPanelStore } from "./threadMarketPanelStore";

/** The card's chart, at the panel's own height so both surfaces read alike. */
const CHART_HEIGHT_CLASS = "h-[200px] min-h-0 w-full";

/** The market's own chart and the account's positions on it: no mission. */
function UnboundMarketBody({
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

  if (account.data === null && account.isLoading) {
    return (
      <div className="flex flex-col gap-3" data-testid="thread-market-card-skeleton">
        <Skeleton className={CHART_HEIGHT_CLASS} />
        <Skeleton className="h-8 w-full" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
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
        // The card is already about one market, so selecting a row would be
        // selecting what is already selected.
        onSelect={() => {}}
      />
    </div>
  );
}

export interface ThreadMarketCardProps {
  readonly environmentId: EnvironmentId;
  readonly asset: string;
  /** The mission bound to this thread, or null for a market the agent looked at. */
  readonly mission: OrchestrationTradingMission | null;
  readonly missions: ReadonlyArray<OrchestrationTradingMission>;
  /** The scoped thread key the collapsed flag is stored under. */
  readonly threadKey: string;
}

export function ThreadMarketCard({
  environmentId,
  asset,
  mission,
  missions,
  threadKey,
}: ThreadMarketCardProps) {
  const collapsed = useThreadMarketCardCollapsed(threadKey);
  const setCollapsed = useThreadMarketPanelStore((state) => state.setCardCollapsed);
  const isOpen = !collapsed;

  return (
    <section
      aria-label={`${asset} market`}
      data-testid="thread-market-card"
      data-open={isOpen ? "true" : "false"}
      className="pointer-events-auto mx-auto mb-1.5 w-full max-w-3xl rounded-xl border border-border/60 bg-background/95 px-2 pt-1 pb-2 backdrop-blur-sm"
    >
      <button
        type="button"
        className="flex w-full min-w-0 items-center gap-2 rounded-md px-1 py-1 text-left"
        aria-expanded={isOpen}
        onClick={() => setCollapsed(threadKey, isOpen)}
        data-testid="thread-market-card-toggle"
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
      {/* Unmounted rather than hidden while folded: see the module note. The
          cap is on the card, so a mission with a long ledger scrolls inside it
          instead of pushing the conversation off the top of the column. */}
      {isOpen ? (
        <div className={cn("max-h-[46vh] overflow-y-auto pt-1")}>
          {mission === null ? (
            <UnboundMarketBody environmentId={environmentId} asset={asset} missions={missions} />
          ) : (
            <MissionLivePanel mission={mission} environmentId={environmentId} parts="market" />
          )}
        </div>
      ) : null}
    </section>
  );
}
