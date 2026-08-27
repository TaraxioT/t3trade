/**
 * The trading home (final-form Phase 4): watchlist on the left, the selected
 * asset's chart in the center with positions beneath it, the alert feed on
 * the right.
 *
 * Everything on this page is a server read: the account view (doorbell-
 * invalidated), the watchlist, the alert feed, and the mission projection.
 * The chart is the shared chart pipeline — `getTradingMarketChart`, entitled
 * per market by a mission on it or by the follow set (see
 * `chartReadEntitlement`). A selected asset with a live mission draws that
 * mission's chart with its overlays; one without gets the standalone
 * `MarketChartPanel` (final-form phase 6).
 *
 * The archiver-health line is Phase 2.4's deferred surface: one quiet line in
 * the staleness banner's register, absent while recording is demonstrably
 * healthy.
 *
 * @module TradeHomePanel
 */
import type { EnvironmentId, OrchestrationTradingMission } from "@t3tools/contracts";
import { runtimeTimeframe } from "@t3tools/trading-contracts/strategy";
import { TrendingUpIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { isElectron } from "../../env";
import { useTradingAccountView } from "../../lib/tradingAccountState";
import { useTradingMarketChart } from "../../lib/tradingMarketChartState";
import { useTradingMissions } from "../../lib/tradingMissionsState";
import { useProjects } from "../../state/entities";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { Button } from "../ui/button";
import { AccountPositionsPanel } from "./AccountPositionsPanel";
import { AlertFeedPanel } from "./AlertFeedPanel";
import { MarketChartPanel } from "./MarketChartPanel";
import { MissionCreateForm } from "./MissionCreateForm";
import { MissionPriceChart } from "./MissionPriceChart";
import { OrderTicket } from "./OrderTicket";
import { describeArchiveHealth } from "./tradeHomePresentation";
import { useTradingUniverseAssets } from "./UniverseAssetSearch";
import { WatchlistPanel } from "./WatchlistPanel";
import { formatPrice } from "./tradingPresentation";

const CHART_HEIGHT_CLASS = "h-[300px] min-h-0 w-full";

/** The two §11.1 permanent terminals — no chart entitlement left in them. */
const TERMINAL_STATUSES = new Set(["revoked", "completed"]);

function liveMissionOnAsset(
  missions: ReadonlyArray<OrchestrationTradingMission>,
  asset: string,
): OrchestrationTradingMission | null {
  return (
    missions.find(
      (mission) => mission.market === asset && !TERMINAL_STATUSES.has(mission.status),
    ) ?? null
  );
}

/**
 * The Phase 2.4 archiver-health one-liner, in the staleness banner's visual
 * register. Renders nothing while recording is healthy.
 */
function ArchiveHealthLine({ message }: { message: string | null }) {
  if (message === null) return null;
  return (
    <div
      className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-sm text-foreground"
      data-testid="archive-health-line"
    >
      {message}
    </div>
  );
}

function TradeHomeChart({
  environmentId,
  asset,
  mission,
}: {
  environmentId: EnvironmentId;
  asset: string;
  mission: OrchestrationTradingMission | null;
}) {
  // The mandate's own timeframe, the same rule the mission panel uses; a
  // missionless asset has no chart read to make, so the interval is moot.
  const interval = runtimeTimeframe(mission?.instruction ?? "");
  const chart = useTradingMarketChart(environmentId, asset, interval, {
    enabled: mission !== null,
  });
  const universe = useTradingUniverseAssets(environmentId);
  const universeRow = universe.find((row) => row.asset === asset) ?? null;

  const position = mission?.position ?? null;
  const data = chart.data;

  return (
    <section aria-label={`${asset} chart`} className="flex flex-col gap-1.5">
      <header className="flex items-baseline gap-2 px-1">
        <h2 className="text-sm font-semibold text-foreground">{asset}</h2>
        {data !== null ? (
          <span className="text-xs tabular-nums text-muted-foreground">
            {formatPrice(data.markPrice)} · {interval}
            {chart.stale ? " · stale" : ""}
          </span>
        ) : universeRow !== null ? (
          <span className="text-xs tabular-nums text-muted-foreground">
            {formatPrice(universeRow.mark)} ·{" "}
            <span className={universeRow.change24hPct >= 0 ? "text-profit" : "text-loss"}>
              {universeRow.change24hPct >= 0 ? "+" : ""}
              {universeRow.change24hPct.toFixed(1)}%
            </span>
          </span>
        ) : null}
        {mission !== null ? (
          <span className="ml-auto text-[11px] text-muted-foreground">
            mission · {mission.status}
          </span>
        ) : null}
      </header>
      {mission !== null && data !== null && data.candles.length >= 2 ? (
        <MissionPriceChart
          candles={data.candles}
          entryPrice={position?.entryPrice ?? null}
          stopPrice={null}
          targetPrice={null}
          liquidationPrice={position?.liquidationPrice ?? null}
          entryTime={null}
          markPrice={data.markPrice}
          pnlSign={position === null ? null : position.unrealisedPnl >= 0 ? "profit" : "loss"}
          className={CHART_HEIGHT_CLASS}
        />
      ) : mission !== null ? (
        <div
          className={`${CHART_HEIGHT_CLASS} flex items-center justify-center rounded-md border border-border/60 text-xs text-muted-foreground`}
        >
          {chart.error !== null ? "Chart unavailable" : "Building chart…"}
        </div>
      ) : (
        // Phase 6: no mission on the asset means the standalone market chart,
        // entitled by the follow set — timeframes, volume, session levels,
        // coverage shading, and arm-at-price.
        <MarketChartPanel
          environmentId={environmentId}
          asset={asset}
          className={CHART_HEIGHT_CLASS}
        />
      )}
    </section>
  );
}

export function TradeHomePanel() {
  const projects = useProjects();
  const environmentId = useMemo<EnvironmentId | null>(
    () => projects[0]?.environmentId ?? null,
    [projects],
  );

  return (
    <SidebarInset className="isolate h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <span className="flex items-center gap-2 text-sm font-medium text-foreground">
            <TrendingUpIcon className="size-4" />
            Trade
          </span>
        </WorkspacePageHeader>
        {environmentId === null ? (
          <p className="px-5 py-4 text-sm text-muted-foreground">
            Connect an environment to trade.
          </p>
        ) : (
          <TradeHomeForEnvironment environmentId={environmentId} />
        )}
      </div>
    </SidebarInset>
  );
}

function TradeHomeForEnvironment({ environmentId }: { environmentId: EnvironmentId }) {
  const { missions, error: missionsError } = useTradingMissions(environmentId);
  const account = useTradingAccountView(environmentId);
  const accounts = account.data?.accounts ?? [];
  const positions = accounts.flatMap((state) => state.positions);

  const [pickedAsset, setPickedAsset] = useState<string | null>(null);
  // The Phase 8 "New mission" affordance — the only way a mission is born now
  // that draft-hero claiming is retired.
  const [missionFormOpen, setMissionFormOpen] = useState(false);
  // The chart follows attention: an explicit pick wins, else the first open
  // position, else nothing (the placeholder says how to get one).
  const selectedAsset = pickedAsset ?? positions[0]?.market.asset ?? null;
  const mission = selectedAsset === null ? null : liveMissionOnAsset(missions, selectedAsset);

  const archiveMessage = describeArchiveHealth(account.data?.archive, Date.now());

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="flex flex-col gap-3 px-4 py-3 sm:px-5">
        <ArchiveHealthLine message={archiveMessage} />
        {missionFormOpen ? (
          <MissionCreateForm
            environmentId={environmentId}
            accounts={accounts}
            initialAsset={selectedAsset}
            onClose={() => setMissionFormOpen(false)}
          />
        ) : (
          <div className="flex justify-end">
            <Button
              size="xs"
              variant="secondary"
              onClick={() => setMissionFormOpen(true)}
              data-testid="mission-create-open"
            >
              New mission
            </Button>
          </div>
        )}
        {account.error === null ? null : (
          <p className="text-sm text-destructive">{account.error}</p>
        )}
        {missionsError === null ? null : (
          <p className="text-sm text-destructive">{missionsError}</p>
        )}
        <div className="grid gap-4 lg:grid-cols-[minmax(15rem,18rem)_minmax(0,1fr)_minmax(16rem,20rem)]">
          <WatchlistPanel
            environmentId={environmentId}
            selectedAsset={selectedAsset}
            onSelect={setPickedAsset}
          />
          <div className="flex min-w-0 flex-col gap-4">
            {selectedAsset === null ? (
              <div className="flex h-[300px] items-center justify-center rounded-md border border-border/60 px-6 text-center text-sm text-muted-foreground">
                Pick a watchlist market or open a position to chart it here.
              </div>
            ) : (
              <>
                <TradeHomeChart
                  environmentId={environmentId}
                  asset={selectedAsset}
                  mission={mission}
                />
                {/* Phase 7: the manual ticket. Rendered even when a mission
                    owns the market — the server's market_owned_by_mission
                    refusal in the preview is the honest explanation of why
                    the ticket will not go through. */}
                <OrderTicket environmentId={environmentId} asset={selectedAsset} />
              </>
            )}
            <AccountPositionsPanel
              accounts={accounts}
              missions={missions}
              environmentId={environmentId}
              selectedAsset={selectedAsset}
              onSelect={setPickedAsset}
            />
          </div>
          <AlertFeedPanel environmentId={environmentId} />
        </div>
      </div>
    </ScrollArea>
  );
}
