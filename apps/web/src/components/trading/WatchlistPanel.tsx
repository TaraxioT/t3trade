/**
 * The watchlist (final-form Phase 4): the user-ordered list of markets the
 * trade home keeps warm.
 *
 * Rows render in the persisted `position` order the server serves. Adding a
 * market starts recording it within one follow-set publish tick — the server
 * reads `trading_watchlist` directly on every recompute — so the add button is
 * also the "start collecting data on this" button, and the hint under the
 * header says so.
 *
 * Each row also opens a chat about its market. That is how trading starts now:
 * a conversation with the market already beside it, which becomes an authority
 * over that market when the agent first plans or enters on it.
 *
 * @module WatchlistPanel
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { XIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { refreshTradingWatchlist, useTradingWatchlist } from "../../lib/tradingAccountState";
import { cn } from "../../lib/utils";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  formatDayVolume,
  useTradingUniverseAssets,
  UniverseAssetSearch,
} from "./UniverseAssetSearch";
import { formatPrice } from "./tradingPresentation";
import { describeControlFailure } from "./useMissionControls";
import { useMarketThreadLauncher } from "./useTradingThreadLaunch";

export function WatchlistPanel({
  environmentId,
  selectedAsset,
  onSelect,
}: {
  environmentId: EnvironmentId;
  selectedAsset: string | null;
  onSelect: (asset: string) => void;
}) {
  const { data, error, isLoading } = useTradingWatchlist(environmentId);
  const assets = useTradingUniverseAssets(environmentId);
  const universeByAsset = useMemo(
    () => new Map(assets.map((asset) => [asset.asset, asset] as const)),
    [assets],
  );
  const entries = data?.entries ?? [];
  const listed = useMemo(() => new Set(entries.map((entry) => entry.market.asset)), [entries]);

  const launcher = useMarketThreadLauncher(environmentId);
  const add = useAtomCommand(orchestrationEnvironment.addTradingWatchlistEntry);
  const remove = useAtomCommand(orchestrationEnvironment.removeTradingWatchlistEntry);
  const [mutationError, setMutationError] = useState<string | null>(null);

  const runMutation = (send: () => ReturnType<typeof add>) => {
    setMutationError(null);
    void send().then((result) => {
      const failure = describeControlFailure(result);
      if (failure === null && result._tag === "Success" && result.value.outcome === "rejected") {
        setMutationError(result.value.reason);
      } else {
        setMutationError(failure);
      }
      // The doorbell rings on every watchlist edit too; this refresh is what
      // makes the row land before the ring on a slow connection.
      refreshTradingWatchlist(environmentId);
    });
  };

  return (
    <section aria-label="Watchlist" className="flex min-h-0 flex-col gap-2">
      <header className="flex items-baseline justify-between px-1">
        <h2 className="text-sm font-semibold text-foreground">Watchlist</h2>
        <span className="text-[11px] text-muted-foreground">adding starts recording</span>
      </header>
      <UniverseAssetSearch
        environmentId={environmentId}
        placeholder="Add asset…"
        exclude={listed}
        onPick={(asset) =>
          runMutation(() =>
            add({ environmentId, input: { market: { venue: "hyperliquid", asset } } }),
          )
        }
      />
      {mutationError === null ? null : (
        <p className="px-1 text-xs text-destructive">{mutationError}</p>
      )}
      {launcher.error === null ? null : (
        <p className="px-1 text-xs text-destructive">{launcher.error}</p>
      )}
      {error !== null ? (
        <p className="px-1 text-sm text-destructive">{error}</p>
      ) : entries.length === 0 ? (
        <p className="px-1 py-3 text-sm text-muted-foreground">
          {isLoading
            ? "Loading watchlist…"
            : "Nothing here yet. Add a market to start watching and recording it."}
        </p>
      ) : (
        <ul className="min-h-0 divide-y divide-border/50 overflow-y-auto">
          {entries.map((entry) => {
            const asset = entry.market.asset;
            const row = universeByAsset.get(asset);
            return (
              <li key={`${entry.market.venue}:${asset}`} className="group flex items-center">
                <button
                  type="button"
                  onClick={() => onSelect(asset)}
                  className={cn(
                    "flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent/50",
                    asset === selectedAsset && "bg-accent/70",
                  )}
                >
                  <span className="font-medium text-foreground">{asset}</span>
                  {row === undefined ? null : (
                    <span className="ml-auto flex items-baseline gap-2 text-xs tabular-nums">
                      <span className="text-foreground">{formatPrice(row.mark)}</span>
                      <span className={row.change24hPct >= 0 ? "text-profit" : "text-loss"}>
                        {row.change24hPct >= 0 ? "+" : ""}
                        {row.change24hPct.toFixed(1)}%
                      </span>
                      <span className="text-muted-foreground">
                        {formatDayVolume(row.dayVolumeUsd)}
                      </span>
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  aria-label={`Trade ${asset} in chat`}
                  disabled={launcher.busy}
                  className="shrink-0 rounded-md px-1.5 py-1 text-[11px] text-muted-foreground opacity-0 transition-opacity duration-100 group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100 disabled:opacity-40"
                  onClick={() => void launcher.open(asset)}
                  data-testid="watchlist-trade-in-chat"
                >
                  Trade in chat
                </button>
                <button
                  type="button"
                  aria-label={`Remove ${asset} from the watchlist`}
                  className="shrink-0 rounded-md p-1 text-muted-foreground opacity-0 transition-opacity duration-100 group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100"
                  onClick={() =>
                    runMutation(() =>
                      remove({
                        environmentId,
                        input: { market: { venue: entry.market.venue, asset } },
                      }),
                    )
                  }
                >
                  <XIcon className="size-3.5" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
