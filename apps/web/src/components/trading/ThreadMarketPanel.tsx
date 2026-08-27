/**
 * The market beside the conversation.
 *
 * When a chat thread is about a market — seeded from the trade home, looked at
 * by the agent, or taken as trading authority — that market's chart, the
 * position on it, and its alerts sit next to the chat instead of a page away.
 * Everything here is the trade home's own components, composed: the phase-6
 * {@link MarketChartPanel}, {@link AccountPositionsPanel} filtered to the one
 * market, and {@link AlertFeedPanel} scoped to it. Nothing is forked, so a fix
 * to any of the three lands on both surfaces.
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

import { useTradingAccountView } from "../../lib/tradingAccountState";
import { cn } from "../../lib/utils";
import { Skeleton } from "../ui/skeleton";
import { AccountPositionsPanel } from "./AccountPositionsPanel";
import { AlertFeedPanel } from "./AlertFeedPanel";
import { MarketChartPanel } from "./MarketChartPanel";
import { filterAccountsToMarket } from "./threadMarketPanelState";
import { useThreadMarketPanelCollapsed, useThreadMarketPanelStore } from "./threadMarketPanelStore";
import { formatPrice } from "./tradingPresentation";
import { useTradingUniverseAssets } from "./UniverseAssetSearch";

const CHART_HEIGHT_CLASS = "h-[220px] min-h-0 w-full";

/** The market's mark and day change, when the universe read has landed. */
function MarketQuote({ environmentId, asset }: { environmentId: EnvironmentId; asset: string }) {
  const universe = useTradingUniverseAssets(environmentId);
  const row = universe.find((entry) => entry.asset === asset) ?? null;
  if (row === null) return null;
  return (
    <span className="flex items-baseline gap-1.5 text-xs tabular-nums">
      <span className="text-foreground">{formatPrice(row.mark)}</span>
      <span className={row.change24hPct >= 0 ? "text-profit" : "text-loss"}>
        {row.change24hPct >= 0 ? "+" : ""}
        {row.change24hPct.toFixed(1)}%
      </span>
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
      <div className="flex flex-col gap-1.5">
        <Skeleton className="h-4 w-16" />
        <Skeleton className="h-16 w-full" />
      </div>
    </div>
  );
}

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
    <div className="flex flex-col gap-3">
      <MarketChartPanel
        environmentId={environmentId}
        asset={asset}
        className={CHART_HEIGHT_CLASS}
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
      <AlertFeedPanel environmentId={environmentId} market={asset} />
    </div>
  );
}

export interface ThreadMarketPanelProps {
  readonly environmentId: EnvironmentId;
  readonly asset: string;
  readonly missions: ReadonlyArray<OrchestrationTradingMission>;
  /** The scoped thread key the collapsed flag is stored under. */
  readonly threadKey: string;
  readonly layout: "column" | "chip";
}

export function ThreadMarketPanel({
  environmentId,
  asset,
  missions,
  threadKey,
  layout,
}: ThreadMarketPanelProps) {
  // Untouched, the panel is open beside a wide chat and a chip on a narrow one.
  // Once the user has collapsed or expanded it, that choice is what is read.
  const collapsed = useThreadMarketPanelCollapsed(threadKey, layout === "chip");
  const setCollapsed = useThreadMarketPanelStore((state) => state.setCollapsed);
  const isOpen = !collapsed;

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
          <MarketQuote environmentId={environmentId} asset={asset} />
        </button>
      ) : (
        <>
          <span className="text-sm font-semibold text-foreground">{asset}</span>
          <MarketQuote environmentId={environmentId} asset={asset} />
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
        {isOpen ? (
          <div className="pt-2 pb-1">
            <ThreadMarketBody environmentId={environmentId} asset={asset} missions={missions} />
          </div>
        ) : null}
      </section>
    );
  }

  return (
    <aside
      aria-label={`${asset} market`}
      className="thread-market-panel flex w-[21rem] shrink-0 flex-col gap-2 overflow-y-auto border-border/60 border-l px-2 py-2 xl:w-[24rem]"
      data-testid="thread-market-panel"
    >
      {header}
      <ThreadMarketBody environmentId={environmentId} asset={asset} missions={missions} />
    </aside>
  );
}
