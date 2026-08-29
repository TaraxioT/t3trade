// ---------------------------------------------------------------------------
// MissionAgentLog
// ---------------------------------------------------------------------------
//
// The agent log (plan 39 phase 3), split out of MissionLivePanel.tsx by size
// alone: nothing but log.

import {
  AlarmClock,
  BellRing,
  BookOpen,
  CircleSlash,
  Crosshair,
  FlaskConical,
  Eye,
  Hand,
  NotebookPen,
  Receipt,
  Route,
  ShieldCheck,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";

import { isMomentSelected, type ChartEventSelection } from "./missionSelectionStore";
import { type TurnTimelineCard } from "./missionTurnTimeline";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import {
  formatAge,
  formatPrice,
  isArmedRow,
  type WatchStreamGroup,
  type WatchStreamItem,
  type WatchStreamRow,
} from "./tradingPresentation";
import {
  BAND_PAD_CLASS,
  MAX_SETTLED_WATCH_ROWS,
  OverflowLevels,
  formatWatchFigure,
} from "./MissionLivePanelSections";

// ---------------------------------------------------------------------------
// The agent log (plan 39 phase 3): nothing but log.
// ---------------------------------------------------------------------------

/** The tone class pair for a log row's rail and icon token. */
const LOG_TONES: Record<string, { rail: string; token: string; icon: string }> = {
  armed: { rail: "bg-armed", token: "bg-armed/10", icon: "text-armed" },
  info: { rail: "bg-info", token: "bg-info/10", icon: "text-info" },
  profit: { rail: "bg-profit", token: "bg-profit/10", icon: "text-profit" },
  loss: { rail: "bg-loss", token: "bg-loss/10", icon: "text-loss" },
  muted: {
    rail: "bg-muted-foreground/30",
    token: "bg-foreground/[0.06]",
    icon: "text-muted-foreground",
  },
};

/**
 * One log row: a 2px tone rail, a 16px round icon token, one clamped prose
 * line, the mono figure, and the clock. Every row in the log — watch or turn —
 * is this one silhouette, readable at a glance without adding a word.
 */
function LogRow({
  tone,
  Icon,
  srWord,
  prose,
  detail,
  figure,
  timeLabel,
  isSelected,
  dataAttrs,
  hoverProps,
}: {
  readonly tone: keyof typeof LOG_TONES;
  readonly Icon: LucideIcon;
  /** The row's kind, read back to screen readers before the prose. */
  readonly srWord: string;
  readonly prose: ReactNode;
  /** The sentence behind the row, when it has more to say than the prose. */
  readonly detail?: string | undefined;
  readonly figure: string | null;
  readonly timeLabel: string;
  readonly isSelected: boolean;
  readonly dataAttrs?: Record<string, string> | undefined;
  readonly hoverProps?:
    | {
        readonly onMouseEnter: () => void;
        readonly onMouseLeave: () => void;
      }
    | undefined;
}): ReactNode {
  const tones = LOG_TONES[tone] ?? LOG_TONES["muted"]!;
  const rowClass = cn(
    BAND_PAD_CLASS,
    "mission-log-enter relative flex w-full items-center gap-x-2 py-2 text-[12px] leading-snug",
    isSelected && "bg-armed/10",
  );
  const body = (
    <>
      <span
        className={cn(
          "mission-log-rail absolute inset-y-1.5 left-1.5 w-[2px] rounded-full",
          tones.rail,
        )}
        aria-hidden
      />
      <span
        className={cn(
          "mission-log-token grid size-4 flex-none place-items-center rounded-full",
          tones.token,
        )}
      >
        <Icon className={cn("size-[11px]", tones.icon)} strokeWidth={2} aria-hidden />
      </span>
      <span className="sr-only">{srWord}: </span>
      <span className="min-w-0 flex-1 truncate text-foreground/90">{prose}</span>
      {figure === null ? null : (
        <span className="flex-none font-mono text-[11px] tabular-nums text-muted-foreground">
          {figure}
        </span>
      )}
      <span className="flex-none font-mono text-[10.5px] tabular-nums text-muted-foreground">
        {timeLabel}
      </span>
    </>
  );

  if (detail === undefined) {
    return (
      <div {...dataAttrs} {...hoverProps} className={rowClass}>
        {body}
      </div>
    );
  }

  // The detail is the row's second line — a watch's last read, a turn's
  // journal note. A native `title` only ever showed it to a mouse; the same
  // `openOnHover` popover the order legs use keeps the hover and gives touch
  // and keyboard the press. Rows with nothing more to say stay a plain div
  // rather than becoming an empty tab stop.
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={0}
        render={
          <button
            type="button"
            {...dataAttrs}
            {...hoverProps}
            className={cn(
              rowClass,
              "text-left outline-none hover:bg-foreground/[0.02] focus-visible:ring-2 focus-visible:ring-ring",
            )}
          />
        }
      >
        {body}
      </PopoverTrigger>
      <PopoverPopup side="left" tooltipStyle className="max-w-[280px] whitespace-normal text-left">
        {detail}
      </PopoverPopup>
    </Popover>
  );
}

/** A watch row's icon, tone and kind word, per the plan-39 icon map. */
function watchRowIdentity(row: WatchStreamRow): {
  Icon: LucideIcon;
  tone: keyof typeof LOG_TONES;
  word: string;
} {
  if (row.state === "armed") return { Icon: Crosshair, tone: "armed", word: "watch armed" };
  if (row.state === "triggered") return { Icon: BellRing, tone: "info", word: "watch fired" };
  return { Icon: CircleSlash, tone: "muted", word: "watch retired" };
}

/** A turn card's icon, tone and kind word, per the plan-39 icon map. */
function turnCardLogIdentity(card: TurnTimelineCard): {
  Icon: LucideIcon;
  tone: keyof typeof LOG_TONES;
  word: string;
} {
  if (card.kind === "trade") {
    // An opening fill is `neutral`: it has realised nothing yet, so painting
    // it with the profit rail would claim a gain that does not exist. Only a
    // closing fill's realised sign earns the profit/loss tones.
    return {
      Icon: Receipt,
      tone: card.tone === "loss" ? "loss" : card.tone === "profit" ? "profit" : "info",
      word: "trade",
    };
  }
  if (card.kind === "note") return { Icon: NotebookPen, tone: "muted", word: "journal note" };
  // Its own glyph and the info rail: a paper fill is an experiment reporting,
  // and drawing it with the trade receipt would put a position on the log that
  // nobody holds.
  if (card.kind === "validation") {
    return { Icon: FlaskConical, tone: "info", word: "validation event" };
  }
  if (card.kind === "revision") {
    // A stop move and a plan publish share the `revision` kind, and the id
    // prefix is the only thing that separates them without reaching into
    // `missionTurnTimeline.ts`, which this plan lists as out of scope. Both
    // prefixes are assigned in one place there, so the join is stable — but a
    // third `revision` kind added later must widen this, not fall through to
    // the publish glyph.
    if (card.id.startsWith("stop-"))
      return { Icon: ShieldCheck, tone: "armed", word: "stop moved" };
    return { Icon: Route, tone: "info", word: "plan published" };
  }
  // A wake: a level is an arrival, a timer is ambient. Stand-asides and pure
  // reads keep their own glyphs so the scrollback's silhouettes say what the
  // turn actually was. Read off the composed prose for the same reason the
  // revision split is read off the id: the phrases come from one authority
  // (`describeWakeTrigger` / `describeWakeReads`) that this plan does not
  // change, and an unmatched wake falls back to the clock glyph rather than
  // borrowing a shape that would claim something.
  if (card.decisionLabel !== null && /\baside\b/i.test(card.decisionLabel)) {
    return { Icon: Hand, tone: "muted", word: "stood aside" };
  }
  if (card.triggerLabel !== null && card.triggerLabel.startsWith("A level")) {
    return { Icon: Zap, tone: "info", word: "woke on a level" };
  }
  if (card.readLabel !== null && card.decisionLabel === null) {
    return {
      Icon: card.readLabel.includes("strategy sheet") ? BookOpen : Eye,
      tone: "muted",
      word: "looked at the market",
    };
  }
  return { Icon: AlarmClock, tone: card.tone === "loss" ? "loss" : "muted", word: "woke" };
}

/** One entry of the merged scrollback: a settled watch item or a turn card. */
type AgentLogEntry =
  | { readonly kind: "watch"; readonly item: WatchStreamItem }
  | { readonly kind: "card"; readonly card: TurnTimelineCard };

const logEntryAt = (entry: AgentLogEntry): number =>
  entry.kind === "watch" ? entry.item.atMillis : entry.card.atMillis;

/** A clock time, as every settled log row states it. */
function logClock(atMillis: number): string {
  return new Date(atMillis).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * The agent log: armed alerts pinned at the top, and one chronological
 * scrollback merging the settled watches and the turn cards, newest first.
 * More visual, not more text — every row is the same rail/token silhouette.
 */
export function AgentLog({
  stream,
  cards,
  earlierTurns,
  nowMillis,
  recentlyFired,
  droppedConditions,
  overflowRows,
  selection,
  onHoverEvent,
}: {
  readonly stream: ReadonlyArray<WatchStreamItem>;
  readonly cards: ReadonlyArray<TurnTimelineCard>;
  readonly earlierTurns: number;
  readonly nowMillis: number;
  readonly recentlyFired: ReadonlySet<string>;
  readonly droppedConditions: number;
  readonly overflowRows: ReadonlyArray<{
    readonly price: number;
    readonly direction: "above" | "below";
    readonly met: boolean;
    readonly id?: string | undefined;
  }>;
  readonly selection: ChartEventSelection | null;
  readonly onHoverEvent: (event: { id: string; atMillis: number } | null) => void;
}): ReactNode {
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const [overflowOpen, setOverflowOpen] = useState(false);
  const overflowRef = useRef<HTMLDivElement | null>(null);
  const overflowSeenRef = useRef(false);
  useEffect(() => {
    if (selection?.source !== "chart" || selection.eventId !== "chip-overflow") return;
    if (overflowSeenRef.current) return;
    overflowSeenRef.current = true;
    setOverflowOpen(true);
    overflowRef.current?.scrollIntoView({ block: "nearest", behavior: "instant" });
    return () => {
      overflowSeenRef.current = false;
    };
  }, [selection]);

  // A watch that just fired holds its place among the armed rows for a beat,
  // so the operator sees the dot change rather than the row jump.
  const held = (item: WatchStreamItem) => isArmedRow(item) || recentlyFired.has(item.id);
  const armed = stream.filter(held);
  const settledAll = stream.filter((item) => !held(item));
  const settledShown = settledAll.slice(0, MAX_SETTLED_WATCH_ROWS);
  const earlierSettled = settledAll.length - settledShown.length;

  const entries: AgentLogEntry[] = [
    ...settledShown.map((item): AgentLogEntry => ({ kind: "watch", item })),
    ...cards.map((card): AgentLogEntry => ({ kind: "card", card })),
  ].sort((a, b) => logEntryAt(b) - logEntryAt(a));

  // A chart-side selection scrolls to its row here — one effect, both
  // namespaces (watch ids and card ids), the same join the two old lists kept.
  useEffect(() => {
    if (selection?.source !== "chart" || scrollRef.current === null) return;
    if (selection.eventId === "chip-overflow") return;
    const card = cards.find(
      (candidate) =>
        candidate.id === selection.eventId || isMomentSelected(selection, candidate.atMillis),
    );
    const watchTarget = stream.find(
      (item) =>
        item.id === selection.eventId ||
        (item.kind === "watch" && isMomentSelected(selection, item.atMillis)) ||
        (item.kind === "group" &&
          item.members.some((member) => isMomentSelected(selection, member.atMillis))),
    );
    const element =
      (card === undefined
        ? null
        : scrollRef.current.querySelector(`[data-timeline-card="${CSS.escape(card.id)}"]`)) ??
      (watchTarget === undefined
        ? null
        : scrollRef.current.querySelector(`[data-watch-row="${CSS.escape(watchTarget.id)}"]`));
    element?.scrollIntoView({ block: "nearest", behavior: "instant" });
  }, [selection, cards, stream]);

  const rowIsSelected = (item: WatchStreamItem): boolean => {
    if (selection === null) return false;
    if (selection.eventId === item.id) return true;
    if (item.kind === "watch") return isMomentSelected(selection, item.atMillis);
    return item.members.some((member) => isMomentSelected(selection, member.atMillis));
  };

  const renderWatchRow = (row: WatchStreamRow, live: boolean): ReactNode => {
    const identity = watchRowIdentity(row);
    const threshold =
      row.thresholdValue === null ? null : formatWatchFigure(row.watchType, row.thresholdValue);
    const observed =
      row.observedValue === null ? null : formatWatchFigure(row.watchType, row.observedValue);
    // Only what the row's own prose does not already say earns the detail —
    // a description repeated back to itself would be a tab stop that reads
    // out nothing new.
    const beyondProse = [
      observed === null || threshold === null
        ? null
        : `last read ${observed}, against ${threshold}`,
      row.actionLabel === null ? null : `then: ${row.actionLabel}`,
    ].filter((part): part is string => part !== null);
    const detail =
      beyondProse.length === 0 ? undefined : [row.description, ...beyondProse].join(" — ");
    return (
      <LogRow
        key={row.id}
        tone={row.state === "triggered" && recentlyFired.has(row.id) ? "info" : identity.tone}
        Icon={identity.Icon}
        srWord={identity.word}
        prose={
          <>
            {row.direction === null ? null : (
              <span className="mr-1 text-[9px] text-muted-foreground" aria-hidden>
                {row.direction === "above" ? "▲" : "▼"}
              </span>
            )}
            {row.description}
            {row.outcomeLabel === null ? null : (
              <span className="text-muted-foreground"> · {row.outcomeLabel}</span>
            )}
          </>
        }
        detail={detail}
        figure={threshold}
        timeLabel={live ? formatAge(Math.max(0, nowMillis - row.atMillis)) : logClock(row.atMillis)}
        isSelected={rowIsSelected(row)}
        dataAttrs={{ "data-watch-row": row.id }}
        hoverProps={{
          onMouseEnter: () => onHoverEvent({ id: row.id, atMillis: row.atMillis }),
          onMouseLeave: () => onHoverEvent(null),
        }}
      />
    );
  };

  const renderGroup = (group: WatchStreamGroup): ReactNode => (
    <details key={group.id} className="group">
      <summary
        aria-label={`${group.count} watches ${group.outcomeLabel}, ${logClock(group.atMillis)}`}
        data-watch-row={group.id}
        onMouseEnter={() => onHoverEvent({ id: group.id, atMillis: group.atMillis })}
        onMouseLeave={() => onHoverEvent(null)}
        className={cn(
          BAND_PAD_CLASS,
          "relative flex cursor-pointer list-none select-none items-center gap-x-2 py-2 text-[12px] leading-snug text-muted-foreground marker:hidden hover:bg-foreground/[0.02]",
          rowIsSelected(group) && "bg-armed/10",
        )}
      >
        <span
          className="mission-log-rail absolute inset-y-1.5 left-1.5 w-[2px] rounded-full bg-muted-foreground/30"
          aria-hidden
        />
        <span className="mission-log-token grid size-4 flex-none place-items-center rounded-full bg-foreground/[0.06]">
          <CircleSlash className="size-[11px] text-muted-foreground" strokeWidth={2} aria-hidden />
        </span>
        <span className="sr-only">watches retired: </span>
        <span className="min-w-0 flex-1 truncate tabular-nums">
          {group.count} watches {group.outcomeLabel}
        </span>
        <span className="flex-none font-mono text-[10.5px] tabular-nums text-muted-foreground">
          {logClock(group.atMillis)}
        </span>
      </summary>
      <div className="pl-4">{group.members.map((member) => renderWatchRow(member, false))}</div>
    </details>
  );

  const renderCard = (card: TurnTimelineCard): ReactNode => {
    const identity = turnCardLogIdentity(card);
    return (
      <LogRow
        key={card.id}
        tone={identity.tone}
        Icon={identity.Icon}
        srWord={identity.word}
        prose={
          <>
            {card.triggerLabel}
            {card.readLabel === null ? null : (
              <span className="text-muted-foreground"> · it {card.readLabel}</span>
            )}
            {card.decisionLabel === null ? null : (
              <span className="text-muted-foreground"> · {card.decisionLabel}</span>
            )}
          </>
        }
        detail={card.detailLabel ?? undefined}
        figure={card.priceLevel === null ? null : formatPrice(card.priceLevel)}
        timeLabel={logClock(card.atMillis)}
        isSelected={
          selection !== null &&
          (selection.eventId === card.id || isMomentSelected(selection, card.atMillis))
        }
        dataAttrs={{ "data-timeline-card": card.id, "data-timeline-kind": card.kind }}
        hoverProps={{
          onMouseEnter: () => onHoverEvent({ id: card.id, atMillis: card.atMillis }),
          onMouseLeave: () => onHoverEvent(null),
        }}
      />
    );
  };

  return (
    <div
      data-testid="mission-watch-stream"
      className="flex min-h-0 flex-1 flex-col border-t border-border/40 pt-1"
    >
      {/* `flex-1` bounds this only inside a parent with a height, which is the
          panel's column layout. In the narrow chip layout the panel grows with
          its content, so the scrollback needs a bound of its own — without one
          a mission with fifty settled watches pushed the whole panel off the
          top of a row that does not scroll.

          981px, not `lg`: that is the width the thread panel switches from the
          chip to the full-height column at (`RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY`).
          At `lg` the bound outlived the chip by 43px of viewport, which showed
          as a 260px log with dead space under it. */}
      <div
        ref={scrollRef}
        className="max-h-[260px] min-h-0 flex-1 overflow-y-auto overscroll-contain min-[981px]:max-h-none"
      >
        {armed.length === 0 ? null : (
          // Pinned on an opaque strip, the same waterline the old stream kept:
          // live above, over below.
          <div className="sticky top-0 z-10 bg-card backdrop-blur-sm">
            <div className="divide-y divide-border/25">
              {armed.map((item) =>
                item.kind === "group" ? renderGroup(item) : renderWatchRow(item, true),
              )}
            </div>
            {entries.length === 0 ? null : <div className="h-px bg-border" />}
          </div>
        )}
        <div className="divide-y divide-border/15">
          {entries.map((entry) =>
            entry.kind === "card"
              ? renderCard(entry.card)
              : entry.item.kind === "group"
                ? renderGroup(entry.item)
                : renderWatchRow(entry.item, false),
          )}
        </div>
        {earlierSettled <= 0 && earlierTurns <= 0 ? null : (
          <p
            className={cn(
              BAND_PAD_CLASS,
              "py-2 font-mono text-[11px] tabular-nums text-muted-foreground",
            )}
          >
            {[
              earlierSettled > 0
                ? `${earlierSettled} earlier watch${earlierSettled === 1 ? "" : "es"}`
                : null,
              earlierTurns > 0
                ? `${earlierTurns} earlier turn${earlierTurns === 1 ? "" : "s"}`
                : null,
            ]
              .filter((part) => part !== null)
              .join(" · ")}{" "}
            not shown
          </p>
        )}
      </div>
      {droppedConditions === 0 ? null : (
        <OverflowLevels
          rows={overflowRows}
          watchRows={stream}
          open={overflowOpen}
          highlighted={selection?.source === "chart" && selection.eventId === "chip-overflow"}
          onToggle={() => setOverflowOpen((prev) => !prev)}
          onHoverEvent={onHoverEvent}
          sectionRef={overflowRef}
        />
      )}
    </div>
  );
}
