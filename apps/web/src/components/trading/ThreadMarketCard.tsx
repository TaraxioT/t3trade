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
import type { EnvironmentId, OrchestrationTradingMission, ThreadId } from "@t3tools/contracts";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useCallback } from "react";

import { useTradingAccountView } from "../../lib/tradingAccountState";
import { refreshTradingThreadMarket } from "../../lib/tradingThreadMarketState";
import { cn } from "../../lib/utils";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useAtomCommand } from "../../state/use-atom-command";
import { Skeleton } from "../ui/skeleton";
import { AccountPositionsPanel } from "./AccountPositionsPanel";
import { MarketChartPanel } from "./MarketChartPanel";
import { MissionLivePanel } from "./MissionLivePanel";
import { MarketQuote } from "./ThreadMarketPanel";
import { filterAccountsToMarket, missionOnMarket } from "./threadMarketPanelState";
import { useThreadMarketCardCollapsed, useThreadMarketPanelStore } from "./threadMarketPanelStore";
import { isMissionComplete } from "./tradingPresentation";

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

/**
 * Which of the mission's markets the card is showing.
 *
 * Only drawn when the mission holds more than one, which most do not: a single
 * market needs no choosing, and a one-tab control is chrome. Pressing a tab
 * writes the thread's market focus - the same row the agent's own look writes -
 * so there is one answer to "which market is this thread about" rather than a
 * server one and a client one that can disagree.
 */
function MarketSwitcher({
  markets,
  selected,
  onSelect,
}: {
  readonly markets: ReadonlyArray<string>;
  readonly selected: string;
  readonly onSelect: (market: string) => void;
}) {
  if (markets.length < 2) return null;
  return (
    <div
      role="tablist"
      aria-label="Markets this chat holds"
      data-testid="thread-market-switcher"
      className="flex shrink-0 items-center gap-0.5 rounded-md bg-muted/50 p-0.5"
    >
      {markets.map((market) => {
        const isSelected = market === selected;
        return (
          <button
            key={market}
            type="button"
            role="tab"
            aria-selected={isSelected}
            data-market={market}
            onClick={(event) => {
              // The tab strip lives inside the card's collapse button, so a
              // press that reached it would fold the card away too.
              event.stopPropagation();
              onSelect(market);
            }}
            className={cn(
              "rounded px-2 py-0.5 text-xs font-medium",
              isSelected
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {market}
          </button>
        );
      })}
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
  /** The thread itself, so the switcher can write its market focus. */
  readonly threadId: ThreadId;
}

export function ThreadMarketCard({
  environmentId,
  asset,
  mission,
  missions,
  threadKey,
  threadId,
}: ThreadMarketCardProps) {
  const collapsed = useThreadMarketCardCollapsed(threadKey);
  const setCollapsed = useThreadMarketPanelStore((state) => state.setCardCollapsed);
  const isOpen = !collapsed;

  // The switcher writes the thread's focus row, which `selectThreadPanel` then
  // reads back to pick `asset`. Failing to write costs the tab press and
  // nothing else - the card keeps drawing the market it was drawing.
  const setThreadMarket = useAtomCommand(orchestrationEnvironment.setTradingThreadMarket, {
    reportFailure: false,
  });
  const selectMarket = useCallback(
    (market: string) => {
      void setThreadMarket({ environmentId, input: { threadId, asset: market } })
        .then(() => refreshTradingThreadMarket(environmentId, threadId))
        .catch(() => undefined);
    },
    [environmentId, setThreadMarket, threadId],
  );

  // Every other held market that has something on it, so the card lists a
  // position card per held market while still drawing exactly one chart.
  const otherHeld = mission === null ? [] : mission.markets.filter((market) => market !== asset);

  // A finished mission has no live market to card: its chart and its result are
  // the completion summary in the timeline, and the panel states the net in one
  // line. Rendering the header alone would leave a bar of chrome over an empty
  // body, which is what a card with nothing in it is.
  if (mission !== null && isMissionComplete(mission.status)) return null;

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
        {mission === null ? null : (
          <div className="ml-auto">
            <MarketSwitcher markets={mission.markets} selected={asset} onSelect={selectMarket} />
          </div>
        )}
      </button>
      {/* Unmounted rather than hidden while folded: see the module note. The
          cap is on the card, so a mission with a long ledger scrolls inside it
          instead of pushing the conversation off the top of the column. */}
      {isOpen ? (
        <div className={cn("max-h-[46vh] overflow-y-auto pt-1")}>
          {mission === null ? (
            <UnboundMarketBody environmentId={environmentId} asset={asset} missions={missions} />
          ) : (
            <div className="flex flex-col gap-3">
              {/* One chart, of the market the switcher selected. */}
              <MissionLivePanel
                mission={missionOnMarket(mission, asset)}
                environmentId={environmentId}
                parts="market"
              />
              {/* And what is on the mission's other markets, listed under it.
                  A market with nothing on it draws nothing rather than an
                  empty card per held market. */}
              {otherHeld.map((market) => (
                <MissionLivePanel
                  key={market}
                  mission={missionOnMarket(mission, market)}
                  environmentId={environmentId}
                  parts="positions"
                />
              ))}
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}
