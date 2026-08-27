// ---------------------------------------------------------------------------
// MissionPositionsCard
// ---------------------------------------------------------------------------
//
// The positions card (plan 39 phase 2), split out of MissionLivePanel.tsx by
// size alone: one list, one row per order leg.

import { Clock } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";

import { cn } from "~/lib/utils";

import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import {
  formatAge,
  formatPrice,
  formatSignedPercent,
  formatSignedUsd,
  formatSize,
  formatUsd,
  type OrderLedgerState,
  type OrderLedgerRow,
  type StrategyPlan,
} from "./tradingPresentation";
import { useMissionSizeUnit } from "./missionSizeUnitStore";
import {
  AnimatedUsd,
  BAND_LEGEND_CLASS,
  BAND_PAD_CLASS,
  MAX_ORDER_ROWS,
  SideChip,
} from "./MissionLivePanelSections";

// ---------------------------------------------------------------------------
// The positions card (plan 39 phase 2): one list, one row per order leg.
// ---------------------------------------------------------------------------

/** The word each order state shows, verbatim from the ledger's vocabulary. */
const ORDER_STATE_WORD: Record<OrderLedgerState, string> = {
  planned: "planned",
  queued: "queued",
  working: "working",
  partial: "partial",
  open: "open",
  closed: "closed",
  cancelled: "cancelled",
  rejected: "rejected",
};

/** The ink class an order state's word and dot wear. */
function orderStateTone(state: OrderLedgerState): string {
  switch (state) {
    case "working":
    case "partial":
      return "text-armed";
    case "open":
      return "text-info";
    case "rejected":
      return "text-loss";
    default:
      return "text-muted-foreground";
  }
}

/**
 * The state token: a dot and a word. Open vs close is carried by fill, reusing
 * the chart's own convention — open legs are a filled circle, closing legs a
 * hollow ring — so green and red stay reserved for money.
 */
function OrderStateToken({
  state,
  isClose,
  settleKey,
}: {
  readonly state: OrderLedgerState;
  readonly isClose: boolean;
  /** Changes when the state changes, so the cross-fade plays exactly once. */
  readonly settleKey: string;
}): ReactNode {
  const tone = orderStateTone(state);
  const dotClass =
    state === "working" || state === "partial"
      ? "bg-armed"
      : state === "open"
        ? "bg-info"
        : state === "rejected"
          ? "bg-loss"
          : "bg-muted-foreground/50";
  return (
    <span
      key={settleKey}
      className={cn("mission-order-settle flex items-center gap-1.5 whitespace-nowrap", tone)}
    >
      {isClose ? (
        <span
          className={cn("size-2 flex-none rounded-full border-[1.5px]", {
            "border-armed": state === "working" || state === "partial",
            "border-info": state === "open",
            "border-loss": state === "rejected",
            "border-muted-foreground/50":
              state !== "working" &&
              state !== "partial" &&
              state !== "open" &&
              state !== "rejected",
          })}
          aria-hidden
        />
      ) : (
        <span
          className={cn(
            "size-2 flex-none rounded-full",
            state === "planned" ? "border border-dashed border-muted-foreground/50" : dotClass,
          )}
          aria-hidden
        />
      )}
      <span className="uppercase tracking-[0.1em] text-[10px]">{ORDER_STATE_WORD[state]}</span>
    </span>
  );
}

/**
 * One order leg's full record, behind the row's hover/press — the same job
 * `LedgerDetail` did for round trips. The open leg carries the position's own
 * figures (mark, stop, liq, margin, protection), which is where the old stat
 * grid's cells live now.
 */
function OrderDetail({
  row,
  market,
  position,
  markPrice,
  stopPrice,
}: {
  readonly row: OrderLedgerRow;
  readonly market: string;
  readonly position: {
    readonly size: number;
    readonly entryPrice?: number | undefined;
    readonly liquidationPrice?: number | undefined;
    readonly marginUsed: number;
    readonly protectedSize: number;
  } | null;
  readonly markPrice: number | null;
  readonly stopPrice: number | null;
}): ReactNode {
  const lines: Array<{ readonly label: string; readonly value: string; readonly tone?: string }> =
    [];
  lines.push({ label: "State", value: ORDER_STATE_WORD[row.state] });
  if (row.sizeUnits !== null)
    lines.push({ label: "Size", value: `${formatSize(row.sizeUnits)} ${market}` });
  if (row.sizeUsd !== null) lines.push({ label: "Notional", value: formatUsd(row.sizeUsd) });
  if (row.price !== null)
    lines.push({ label: row.isClose ? "Exit" : "Entry", value: formatPrice(row.price) });
  if (row.state === "open" && position !== null) {
    if (markPrice !== null) lines.push({ label: "Mark", value: formatPrice(markPrice) });
    lines.push(
      stopPrice === null
        ? { label: "Stop", value: "None", tone: "text-loss" }
        : { label: "Stop", value: formatPrice(stopPrice) },
    );
    if (position.liquidationPrice !== undefined)
      lines.push({ label: "Liq", value: formatPrice(position.liquidationPrice) });
    if (position.marginUsed > 0)
      lines.push({ label: "Margin", value: formatUsd(position.marginUsed) });
    const covered = Math.abs(position.protectedSize);
    const held = Math.abs(position.size);
    if (stopPrice !== null && covered < held)
      lines.push({
        label: "Protected",
        value: covered === 0 ? "None" : `${formatSize(covered)} of ${formatSize(held)}`,
        tone: "text-loss",
      });
  }
  if (row.feeUsd !== null) lines.push({ label: "Fees", value: formatUsd(row.feeUsd) });
  if (row.valueUsd !== null)
    lines.push({
      label: row.state === "open" ? "Unrealised net" : "Net",
      value: formatSignedUsd(row.valueUsd),
      tone: row.valueUsd >= 0 ? "text-profit" : "text-loss",
    });
  if (row.orderRef !== null) lines.push({ label: "Order", value: row.orderRef });
  return (
    <div className="flex w-56 flex-col gap-1.5 text-left">
      {lines.map((line) => (
        <div key={line.label} className="flex items-baseline justify-between gap-4">
          <span className="text-xs text-muted-foreground">{line.label}</span>
          <span
            className={cn(
              "text-right font-mono text-[11px] tabular-nums",
              line.tone ?? "text-foreground",
            )}
          >
            {line.value}
          </span>
        </div>
      ))}
    </div>
  );
}

/** The positions card's column headings, in the ledger's legend ink. */
function OrderHeading({ children }: { readonly children: ReactNode }): ReactNode {
  return (
    <span className={cn(BAND_LEGEND_CLASS, "whitespace-nowrap text-right text-muted-foreground")}>
      {children}
    </span>
  );
}

/** One order leg as a row of the positions card. */
function OrderRowView({
  row,
  market,
  leverageLabel,
  position,
  markPrice,
  stopPrice,
  nowMillis,
  sizeUnit,
  onToggleUnit,
  ringToneClass,
}: {
  readonly row: OrderLedgerRow;
  readonly market: string;
  readonly leverageLabel: string | null;
  readonly position: {
    readonly size: number;
    readonly entryPrice?: number | undefined;
    readonly liquidationPrice?: number | undefined;
    readonly marginUsed: number;
    readonly protectedSize: number;
  } | null;
  readonly markPrice: number | null;
  readonly stopPrice: number | null;
  readonly nowMillis: number;
  readonly sizeUnit: "usd" | "units";
  readonly onToggleUnit: () => void;
  /** Non-null while the one-shot filled ring should play, carrying its tone. */
  readonly ringToneClass: string | null;
}): ReactNode {
  const isLong = row.direction === "long";
  const sizeReading =
    sizeUnit === "usd"
      ? row.sizeUsd === null
        ? "-"
        : formatUsd(row.sizeUsd)
      : row.sizeUnits === null
        ? "-"
        : `${formatSize(row.sizeUnits)} ${market}`;
  const otherReading =
    sizeUnit === "usd"
      ? row.sizeUnits === null
        ? "size in units unknown"
        : `${formatSize(row.sizeUnits)} ${market}`
      : row.sizeUsd === null
        ? "notional unknown"
        : formatUsd(row.sizeUsd);
  const timeLabel = row.isLive
    ? row.state === "planned"
      ? "-"
      : formatAge(Math.max(0, nowMillis - row.atMillis))
    : new Date(row.atMillis).toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
      });
  const label = [
    `${ORDER_STATE_WORD[row.state]} ${row.isClose ? "closing" : "opening"} ${
      isLong ? "long" : "short"
    } leg`,
    `size ${sizeReading} (${otherReading})`,
    row.price === null ? "no price yet" : `at ${formatPrice(row.price)}`,
    row.valueUsd === null ? "no value yet" : `worth ${formatSignedUsd(row.valueUsd)} net of fees`,
    `as of ${timeLabel}`,
    "press for the leg's full detail, and to switch the size column between dollars and units",
  ].join(", ");

  return (
    // A popover, not a tooltip: the detail carries the leg's stop, liquidation
    // and margin, and Base UI (correctly) never opens a tooltip for touch, so
    // on a phone those risk figures had no way in at all. `openOnHover` keeps
    // the pointer behaviour a hover exactly as it was, and gives touch and
    // keyboard the press they already expect. The press still flips the size
    // unit; the two are the row's read and its toggle, not one action.
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={0}
        render={
          <button
            type="button"
            aria-label={label}
            onClick={onToggleUnit}
            data-order-state={row.state}
            className={cn(
              "mission-order-enter relative col-span-full grid h-7 grid-cols-subgrid items-center gap-x-3 overflow-hidden rounded-full border px-2 text-left font-mono text-[11px] tabular-nums outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
              ringToneClass,
              row.state === "planned"
                ? "border-dashed border-border/70 bg-foreground/[0.02]"
                : row.isLive
                  ? "border-border bg-foreground/[0.06] hover:bg-foreground/[0.09]"
                  : "border-border/60 bg-foreground/[0.03] hover:bg-foreground/[0.06]",
            )}
          />
        }
      >
        {/* The partial-fill track, behind the row: a CSS width transition, not
            a keyframe, so successive partials grow it continuously. */}
        {row.filledFraction === null ? null : (
          <span
            className="absolute inset-y-0 left-0 rounded-full bg-armed/[0.12] transition-[width] duration-[600ms] ease-out"
            style={{ width: `${Math.round(row.filledFraction * 100)}%` }}
            aria-hidden
          />
        )}
        <SideChip market={market} leverageLabel={leverageLabel} isLong={isLong} size="sm" />
        <OrderStateToken
          state={row.state}
          isClose={row.isClose}
          settleKey={`${row.key}-${row.state}`}
        />
        <span className="whitespace-nowrap text-right text-muted-foreground">
          {row.price === null ? "-" : formatPrice(row.price)}
        </span>
        {/* The size column: tap anywhere on the row to flip its unit. The
            figure cross-fades; the column does not resize. */}
        <span className="whitespace-nowrap text-right text-muted-foreground">
          <span key={sizeUnit} className="mission-size-crossfade inline-block min-w-[64px]">
            {sizeReading}
          </span>
        </span>
        <span
          className={cn(
            "whitespace-nowrap text-right",
            row.valueUsd === null
              ? "text-muted-foreground"
              : row.valueUsd >= 0
                ? "text-profit"
                : "text-loss",
          )}
        >
          {row.valueUsd === null ? "-" : formatSignedUsd(row.valueUsd)}
        </span>
        <span className="whitespace-nowrap text-right text-muted-foreground">{timeLabel}</span>
      </PopoverTrigger>
      <PopoverPopup side="left" tooltipStyle className="max-w-none">
        <OrderDetail
          row={row}
          market={market}
          position={position}
          markPrice={markPrice}
          stopPrice={stopPrice}
        />
      </PopoverPopup>
    </Popover>
  );
}

/**
 * The positions card: header (legend + the money headline), the column
 * headings, and one row per order leg — the live band pinned, settled legs
 * scrolling beneath, `+N earlier` past the cap. The card's height is fixed by
 * its parent; the scroller is what bounds the list, never a dropped row.
 */
export function PositionsCard({
  rows,
  market,
  leverageLabel,
  position,
  markPrice,
  stopPrice,
  plan,
  roiPercent,
  pnlToneClass,
  nowMillis,
  staleLabel,
}: {
  readonly rows: ReadonlyArray<OrderLedgerRow>;
  readonly market: string;
  readonly leverageLabel: string | null;
  readonly position: {
    readonly size: number;
    readonly entryPrice?: number | undefined;
    readonly unrealisedPnl: number;
    readonly liquidationPrice?: number | undefined;
    readonly marginUsed: number;
    readonly protectedSize: number;
  } | null;
  readonly markPrice: number | null;
  readonly stopPrice: number | null;
  readonly plan: StrategyPlan | null;
  readonly roiPercent: number | null;
  readonly pnlToneClass: string;
  readonly nowMillis: number;
  /** The staleness word, qualifying every live figure on the card. */
  readonly staleLabel: string | null;
}): ReactNode {
  const sizeUnit = useMissionSizeUnit((store) => store.unit);
  const toggleUnit = useMissionSizeUnit((store) => store.toggle);

  // Past the cap the older settled legs are collapsed, not dropped: the
  // scrollback stays short by default and the count expands into the full
  // order history, which is the only record of what the mission did.
  const [showAllSettled, setShowAllSettled] = useState(false);

  // One-shot filled-ring bookkeeping: a leg that just became `open`, or a
  // closing leg that just settled, pulses once. Keyed on the state transition
  // the panel itself observed, so the 3s poll cannot replay it.
  const prevStates = useRef<Map<string, OrderLedgerState>>(new Map());
  const ringsAt = useRef<Map<string, { at: number; tone: string }>>(new Map());
  for (const row of rows) {
    const prev = prevStates.current.get(row.key);
    if (prev !== undefined && prev !== row.state) {
      if (row.state === "open") {
        ringsAt.current.set(row.key, { at: nowMillis, tone: "mission-order-filled-ring-info" });
      } else if (row.state === "closed" && row.isClose) {
        ringsAt.current.set(row.key, {
          at: nowMillis,
          tone:
            (row.valueUsd ?? 0) >= 0
              ? "mission-order-filled-ring-profit"
              : "mission-order-filled-ring-loss",
        });
      }
    }
    prevStates.current.set(row.key, row.state);
  }
  const ringFor = (key: string): string | null => {
    const ring = ringsAt.current.get(key);
    if (ring === undefined) return null;
    if (nowMillis - ring.at > 700) {
      ringsAt.current.delete(key);
      return null;
    }
    return ring.tone;
  };

  const live = rows.filter((row) => row.isLive);
  const settledAll = rows.filter((row) => !row.isLive);
  const settled = showAllSettled ? settledAll : settledAll.slice(0, MAX_ORDER_ROWS);
  const earlier = settledAll.length - settled.length;

  const renderRow = (row: OrderLedgerRow): ReactNode => (
    <OrderRowView
      key={row.key}
      row={row}
      market={market}
      leverageLabel={leverageLabel}
      position={position}
      markPrice={markPrice}
      stopPrice={stopPrice}
      nowMillis={nowMillis}
      sizeUnit={sizeUnit}
      onToggleUnit={toggleUnit}
      ringToneClass={ringFor(row.key)}
    />
  );

  return (
    <>
      {/* The header: the card's name, the staleness word when it applies, and
          the money headline — live unrealised while a leg is open, the plan's
          committed reading otherwise. The right slot is never blank. */}
      <div className={cn(BAND_PAD_CLASS, "flex flex-none items-center gap-x-3 pb-1.5 pt-2.5")}>
        {/* The left group gives ground first: the money figure on the right is
            the reading this header exists for, so it never truncates and the
            legend + staleness word shrink around it. */}
        <p className={cn(BAND_LEGEND_CLASS, "flex-none")}>positions</p>
        {staleLabel === null ? null : (
          <span
            className="flex min-w-0 items-center gap-1 truncate font-mono text-[11px] uppercase tracking-[0.1em] text-armed"
            // oxlint-disable-next-line t3code/no-native-title-tooltip -- Upstream's new rule wants the styled Tooltip here. Converting the mission panel's hover copy is a UI change with its own live verification, not part of an upstream sync.
            title="The position read is behind. Placement is only suspended once it stops landing altogether."
          >
            <Clock className="size-3" strokeWidth={2} aria-hidden />
            {staleLabel}
          </span>
        )}
        {position !== null ? (
          <span className="ml-auto flex flex-none items-baseline gap-2">
            <span className={cn(BAND_LEGEND_CLASS, "hidden uppercase tracking-[0.14em] xl:inline")}>
              unrealised
            </span>
            {roiPercent === null ? null : (
              <span className={cn("font-mono text-[11px] tabular-nums", pnlToneClass)}>
                {formatSignedPercent(roiPercent)}
              </span>
            )}
            <span
              className={cn(
                "font-mono text-[15px] leading-none tracking-[-0.02em] tabular-nums",
                pnlToneClass,
              )}
            >
              <AnimatedUsd value={position.unrealisedPnl} />
            </span>
          </span>
        ) : plan !== null &&
          plan.isStandAside !== true &&
          plan.maxLossUsd !== null &&
          plan.targetUsd !== null ? (
          <span className="ml-auto flex-none font-mono text-[12px] tabular-nums">
            <span className="text-loss">{formatSignedUsd(-plan.maxLossUsd)}</span>
            <span className="text-muted-foreground"> → </span>
            <span className="text-profit">{formatSignedUsd(plan.targetUsd)}</span>
          </span>
        ) : (
          <span className="ml-auto flex-none font-mono text-[12px] text-muted-foreground">-</span>
        )}
      </div>

      {rows.length === 0 ? (
        // The empty state, in the skeleton idiom: the same headings and row
        // rhythm, naming the columns that are about to fill. With the planned
        // ghost row this only appears before the first plan exists.
        <div className={cn(BAND_PAD_CLASS, "flex-1 pb-3")}>
          <div className="grid grid-cols-[auto_auto_repeat(3,minmax(max-content,1fr))_auto] gap-y-1.5">
            <div className="col-span-full grid grid-cols-subgrid gap-x-3 border border-transparent px-2 pb-0.5">
              <span />
              <OrderHeading>state</OrderHeading>
              <OrderHeading>entry / exit</OrderHeading>
              <OrderHeading>size</OrderHeading>
              <OrderHeading>usd</OrderHeading>
              <OrderHeading>time</OrderHeading>
            </div>
            <div
              data-testid="mission-positions-empty"
              className="col-span-full flex h-7 items-center rounded-full border border-dashed border-border/50 bg-foreground/[0.02] px-3 font-mono text-[11px] text-muted-foreground"
            >
              <span>{market}</span>
              <span className="ml-2 opacity-70">no orders yet</span>
              <span className={cn("ml-auto", BAND_LEGEND_CLASS)}>fills on the entry</span>
            </div>
          </div>
        </div>
      ) : (
        // ONE grid for the whole band — headings and rows share its column
        // tracks, so a heading can never drift off the figures it names. The
        // scroller wraps that single grid: vertically because the card's height
        // is fixed, horizontally because six columns of figures do not fit the
        // left column at every width, and a row that scrolls as a unit is the
        // house answer to a wide region (never a clipped figure).
        <div
          className={cn(
            BAND_PAD_CLASS,
            // Bounded below `lg` for the same reason the agent log is: the
            // stacked panel has no fixed parent to flex against.
            "max-h-[220px] min-h-0 flex-1 overflow-y-auto overflow-x-auto overscroll-contain pb-3 lg:max-h-none",
          )}
        >
          <div className="grid min-w-max grid-cols-[auto_auto_repeat(3,minmax(max-content,1fr))_auto] gap-y-1.5">
            {/* The headings ride the scroll: they are the first row of the same
                grid, pinned so the columns stay named while settled legs pass
                under them. */}
            <div className="sticky top-0 z-20 col-span-full grid grid-cols-subgrid gap-x-3 border border-transparent bg-card px-2 pb-0.5">
              <span />
              <OrderHeading>state</OrderHeading>
              <OrderHeading>entry / exit</OrderHeading>
              {/* The size column's unit is a panel-wide preference; the heading
                  is the keyboard path to the same toggle every row offers. */}
              <button
                type="button"
                onClick={toggleUnit}
                aria-pressed={sizeUnit === "usd"}
                aria-label={`Size column shows ${
                  sizeUnit === "usd" ? "USD notional" : `${market} units`
                }; press to switch to ${sizeUnit === "usd" ? `${market} units` : "USD notional"}`}
                className={cn(
                  BAND_LEGEND_CLASS,
                  "whitespace-nowrap rounded text-right text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
                )}
              >
                size · {sizeUnit === "usd" ? "$" : market.toLowerCase()}
              </button>
              <OrderHeading>usd</OrderHeading>
              <OrderHeading>time</OrderHeading>
            </div>
            {/* The live band — planned / queued / working / partial and the
                open leg — pinned under the headings, above the settled
                scrollback: the same shape the agent log keeps for its armed
                rows. Bounded to four rows, because pinned it covers the top of
                the scroller for the whole scroll: a long live band (scaled in
                several times, with working orders alongside) would otherwise
                sit over the settled legs and put their history out of reach.
                Past the cap the band scrolls on its own and the scrollback
                below it stays reachable. */}
            {live.length === 0 ? null : (
              <div className="sticky top-[19px] z-10 col-span-full grid max-h-[8.5rem] grid-cols-subgrid gap-y-1.5 overflow-y-auto overscroll-contain bg-card pb-0.5">
                {live.map(renderRow)}
                {settled.length === 0 ? null : (
                  <div className="col-span-full h-px bg-border" aria-hidden />
                )}
              </div>
            )}
            {settled.map(renderRow)}
            {settledAll.length <= MAX_ORDER_ROWS ? null : (
              <button
                type="button"
                onClick={() => setShowAllSettled((open) => !open)}
                data-testid="mission-positions-earlier"
                className="col-span-full rounded text-left font-mono text-[11px] tabular-nums text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
              >
                {showAllSettled ? "fewer" : `+${earlier} earlier`}
              </button>
            )}
          </div>
        </div>
      )}
    </>
  );
}
