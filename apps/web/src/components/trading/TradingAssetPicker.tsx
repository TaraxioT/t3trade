/**
 * The start-page asset picker.
 *
 * A mission's market is fixed at creation (§10.1), so the picker lives in the
 * mission create form (`MissionCreateForm`), and the selected market goes out
 * with the form's `trading.mission.create` dispatch.
 *
 * It searches the venue's live universe. It used to be two buttons — BTC and
 * ETH — because those were the only two assets the contracts admitted; now that
 * a mission can be mandated on anything listed, the list comes from the venue
 * and the search is the only way through a couple of hundred rows.
 *
 * @module TradingAssetPicker
 */
import type { EnvironmentId, TradingUniverseView } from "@t3tools/contracts";
import type { TradingMarket } from "@t3tools/trading-contracts";
import { useAtomValue } from "@effect/atom-react";
import { ChevronDownIcon, SearchIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { orchestrationEnvironment } from "../../state/orchestration";
import { ComposerSelectControl } from "../chat/ComposerControl";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxTrigger,
} from "../ui/combobox";
import { Separator } from "../ui/separator";

/**
 * What the picker shows when the venue cannot be read. Not an empty list: the
 * two assets every install has traded are better than a picker with nothing in
 * it, and picking one still works — the create path resolves it against the
 * venue before the mission exists.
 */
const FALLBACK_ASSETS: ReadonlyArray<TradingMarket> = ["BTC", "ETH"];

/** How many rows the list shows before the search has to narrow it. */
const VISIBLE_LIMIT = 60;

const formatVolume = (usd: number): string => {
  if (usd >= 1_000_000_000) return `$${(usd / 1_000_000_000).toFixed(1)}B`;
  if (usd >= 1_000_000) return `$${Math.round(usd / 1_000_000)}M`;
  if (usd >= 1_000) return `$${Math.round(usd / 1_000)}K`;
  return `$${Math.round(usd)}`;
};

/**
 * Nothing to pick from before an environment connects — and nothing to send
 * either, so the picker simply is not there yet.
 */
export function TradingAssetPicker({
  environmentId,
  value,
  onChange,
}: {
  environmentId: EnvironmentId | null;
  value: TradingMarket;
  onChange: (market: TradingMarket) => void;
}) {
  if (environmentId === null) return null;
  return <AssetCombobox environmentId={environmentId} value={value} onChange={onChange} />;
}

function AssetCombobox({
  environmentId,
  value,
  onChange,
}: {
  environmentId: EnvironmentId;
  value: TradingMarket;
  onChange: (market: TradingMarket) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const universe = useAtomValue(
    orchestrationEnvironment.tradingUniverse({ environmentId, input: {} }),
  );

  // Busiest first: day volume is the closest thing to "which of these does
  // anyone trade", and it puts the majors at the top without hardcoding them.
  const assets = useMemo((): TradingUniverseView["assets"] => {
    const listed = universe._tag === "Success" ? universe.value.assets : [];
    return [...listed]
      .filter((asset) => asset.available)
      .sort((left, right) => right.dayVolumeUsd - left.dayVolumeUsd);
  }, [universe]);

  const filtered = useMemo(() => {
    const needle = query.trim().toUpperCase();
    const matches =
      needle.length === 0 ? assets : assets.filter((asset) => asset.asset.includes(needle));
    return matches.slice(0, VISIBLE_LIMIT);
  }, [assets, query]);

  const items = useMemo(
    () =>
      filtered.length > 0
        ? filtered.map((asset) => asset.asset)
        : assets.length === 0
          ? [...FALLBACK_ASSETS]
          : [],
    [assets.length, filtered],
  );
  const rows = useMemo(
    () => new Map(filtered.map((asset) => [asset.asset, asset] as const)),
    [filtered],
  );

  return (
    <>
      <Separator orientation="vertical" className="mx-0.5 hidden h-4 sm:block" />
      <Combobox
        items={items}
        filteredItems={items}
        autoHighlight
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setQuery("");
        }}
        value={value}
        onValueChange={(next) => {
          if (typeof next === "string" && next.length > 0) onChange(next);
        }}
      >
        <ComboboxTrigger render={<ComposerSelectControl className="font-medium" />}>
          <span aria-label="Trading asset">{value}</span>
          <ChevronDownIcon className="-me-1 size-3 shrink-0 text-muted-foreground opacity-50" />
        </ComboboxTrigger>
        <ComboboxPopup align="start" className="flex w-64 flex-col">
          <div className="shrink-0 px-3 pt-2.5">
            <div className="relative -translate-y-px border-b border-border/70 pb-1.5 transition-colors focus-within:border-ring">
              <SearchIcon
                aria-hidden="true"
                className="pointer-events-none absolute top-1.5 left-0 size-4 shrink-0 text-muted-foreground/55"
              />
              <ComboboxInput
                className="[&_input]:h-6.5 [&_input]:ps-5 [&_input]:leading-6.5"
                inputClassName="rounded-none bg-transparent text-sm"
                placeholder="Search assets…"
                showTrigger={false}
                size="sm"
                unstyled
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
          </div>
          <ComboboxEmpty>No asset matches.</ComboboxEmpty>
          <ComboboxList className="max-h-72">
            {items.map((asset) => {
              const row = rows.get(asset);
              return (
                <ComboboxItem key={asset} value={asset} className="justify-between gap-3">
                  <span className="font-medium">{asset}</span>
                  {row === undefined ? null : (
                    <span className="flex items-center gap-2 text-xs tabular-nums text-muted-foreground">
                      <span
                        className={
                          row.change24hPct >= 0
                            ? "text-emerald-600 dark:text-emerald-400"
                            : "text-red-600 dark:text-red-400"
                        }
                      >
                        {row.change24hPct >= 0 ? "+" : ""}
                        {row.change24hPct.toFixed(1)}%
                      </span>
                      <span>{formatVolume(row.dayVolumeUsd)}</span>
                    </span>
                  )}
                </ComboboxItem>
              );
            })}
          </ComboboxList>
        </ComboboxPopup>
      </Combobox>
    </>
  );
}
