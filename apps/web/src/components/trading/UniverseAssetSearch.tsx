/**
 * A small universe search: type, see the top matches with their day figures,
 * pick one. The watchlist's add row and the alert form's asset field are the
 * same interaction, so they share this rather than growing two.
 *
 * Reads `getTradingUniverse` through its long-held atom (the list moves when a
 * market is listed or delisted, not per keystroke) and filters client-side,
 * the same way `TradingAssetPicker` does.
 *
 * @module UniverseAssetSearch
 */
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, TradingUniverseView } from "@t3tools/contracts";
import { SearchIcon } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { orchestrationEnvironment } from "../../state/orchestration";
import { Input } from "../ui/input";

/** How many matches the dropdown shows; the search narrows the rest. */
const VISIBLE_LIMIT = 8;

export const formatDayVolume = (usd: number): string => {
  if (usd >= 1_000_000_000) return `$${(usd / 1_000_000_000).toFixed(1)}B`;
  if (usd >= 1_000_000) return `$${Math.round(usd / 1_000_000)}M`;
  if (usd >= 1_000) return `$${Math.round(usd / 1_000)}K`;
  return `$${Math.round(usd)}`;
};

type TradingUniverseEntry = TradingUniverseView["assets"][number];

export function useTradingUniverseAssets(
  environmentId: EnvironmentId,
): ReadonlyArray<TradingUniverseEntry> {
  const universe = useAtomValue(
    orchestrationEnvironment.tradingUniverse({ environmentId, input: {} }),
  );
  // Busiest first, the asset picker's own ordering: day volume is the closest
  // thing to "which of these does anyone trade".
  return useMemo(() => {
    const listed = universe._tag === "Success" ? universe.value.assets : [];
    return [...listed]
      .filter((asset) => asset.available)
      .sort((left, right) => right.dayVolumeUsd - left.dayVolumeUsd);
  }, [universe]);
}

export function UniverseAssetSearch({
  environmentId,
  placeholder,
  exclude,
  onPick,
}: {
  environmentId: EnvironmentId;
  placeholder: string;
  /** Assets to leave out of the results (already on the list). */
  exclude?: ReadonlySet<string>;
  onPick: (asset: string) => void;
}) {
  const assets = useTradingUniverseAssets(environmentId);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const matches = useMemo(() => {
    const needle = query.trim().toUpperCase();
    if (needle.length === 0) return [];
    return assets
      .filter((asset) => asset.asset.includes(needle) && !(exclude?.has(asset.asset) ?? false))
      .slice(0, VISIBLE_LIMIT);
  }, [assets, exclude, query]);

  const pick = (asset: string) => {
    onPick(asset);
    setQuery("");
    inputRef.current?.focus();
  };

  return (
    <div className="relative">
      <div className="relative">
        <SearchIcon
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground/55"
        />
        <Input
          ref={inputRef}
          className="h-8 ps-8 text-sm"
          placeholder={placeholder}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && matches[0] !== undefined) {
              event.preventDefault();
              pick(matches[0].asset);
            }
            if (event.key === "Escape") setQuery("");
          }}
        />
      </div>
      {matches.length > 0 ? (
        <ul className="absolute inset-x-0 top-full z-20 mt-1 overflow-hidden rounded-md border border-border bg-popover shadow-md">
          {matches.map((asset) => (
            <li key={asset.asset}>
              <button
                type="button"
                className="flex w-full items-baseline justify-between gap-3 px-2.5 py-1.5 text-left text-sm hover:bg-accent/60"
                onClick={() => pick(asset.asset)}
              >
                <span className="font-medium text-foreground">{asset.asset}</span>
                <span className="flex items-center gap-2 text-xs tabular-nums text-muted-foreground">
                  <span className={asset.change24hPct >= 0 ? "text-profit" : "text-loss"}>
                    {asset.change24hPct >= 0 ? "+" : ""}
                    {asset.change24hPct.toFixed(1)}%
                  </span>
                  <span>{formatDayVolume(asset.dayVolumeUsd)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : query.trim().length > 0 ? (
        <p className="absolute inset-x-0 top-full z-20 mt-1 rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs text-muted-foreground shadow-md">
          No asset matches.
        </p>
      ) : null}
    </div>
  );
}
