/**
 * The one panel beside the conversation.
 *
 * When a chat thread is about a market, that market sits next to the chat
 * instead of a page away. The panel is what the trader reads *about* the
 * market rather than the market itself, composed top to bottom:
 *
 *   1. the market header: the asset, its mark and the day's move
 *   2. the mission status strip, only when a mission is bound
 *   3. the agent log, which takes the rest and scrolls
 *
 * The chart and the positions are not here. They live in {@link
 * ThreadMarketCard}, docked above the composer in the chat column, because
 * that is where the trader is already looking and because a chart beside a
 * scrolling log is a chart nobody watches. One chart in the thread view, one
 * place per card: the panel draws the mission's `status` half and the card
 * draws its `market` half, off the same projection.
 *
 * Without a mission there is no strip and no log to draw, so the panel says
 * so in one line rather than standing empty; the market itself is in the card.
 *
 * No alerts here either. The alert feed and its arm form live on the trade
 * home, next to each other, where an armed watch can be read back.
 *
 * Two layouts, one component. `column` is the wide one: a fixed-width column
 * to the right of the chat, scrolling on its own. `chip` is the narrow one: a
 * single row above the timeline that expands in place. Both live inside the
 * chat's own layout rather than over it, so neither can ever cover the
 * composer.
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

import { cn } from "../../lib/utils";
import { MissionLivePanel } from "./MissionLivePanel";
import { useThreadMarketPanelCollapsed, useThreadMarketPanelStore } from "./threadMarketPanelStore";
import { formatPrice } from "./tradingPresentation";
import { useTradingUniverseAssets } from "./UniverseAssetSearch";

/**
 * The market's mark and day change.
 *
 * The mission's own 3s poll wins the mark when there is a mission: it is the
 * same read the chart draws its live edge from, so the header and the picture
 * under it cannot show two different prices. The universe read (which every
 * thread has) supplies the day's move, and the mark for threads with no
 * mission to ask.
 */
export function MarketQuote({
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
 * What the panel says on a thread that is only looking at a market.
 *
 * There is no mission, so there is no status to strip and no agent log to
 * draw. Saying that is better than an empty column: the market is in the card
 * above the composer, and this says where to look and what would fill this
 * space.
 */
function NoMissionBody({ asset }: { asset: string }) {
  return (
    <p
      data-testid="thread-market-no-mission"
      className="px-1 py-2 text-xs leading-relaxed text-muted-foreground"
    >
      No mission on {asset} from this chat yet. The chart and your positions are above the composer;
      ask for a trade here and this is where the agent&apos;s log will run.
    </p>
  );
}

export interface ThreadMarketPanelProps {
  readonly environmentId: EnvironmentId;
  readonly asset: string;
  /**
   * The mission bound to this thread, or null. It decides the body: with one,
   * the panel is the mission's status strip and agent log; without, it is one
   * line saying so.
   */
  readonly mission: OrchestrationTradingMission | null;
  /** The scoped thread key the collapsed flag is stored under. */
  readonly threadKey: string;
  readonly layout: "column" | "chip";
}

export function ThreadMarketPanel({
  environmentId,
  asset,
  mission,
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
      <NoMissionBody asset={asset} />
    ) : (
      <MissionLivePanel mission={mission} environmentId={environmentId} parts="status" />
    );

  // Which bars the mission wakes on. The card draws that interval's candles;
  // the label stays with the header, which is the panel's one line about the
  // market itself.
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
