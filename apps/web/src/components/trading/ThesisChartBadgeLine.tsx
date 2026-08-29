/**
 * The line under a chart that names the validation running on it.
 *
 * One component rather than three copies, because it now appears under every
 * chart surface - the trade home's, the market panel's, and the one docked
 * above the composer - and a badge that said "tracking" on one and nothing on
 * another would be the same defect this stage exists to fix.
 *
 * It is also the chart's one chat affordance about a validation. Clicking it
 * writes a question into the composer of the thread the chart lives in and
 * stops there: the badge asks, it never acts. Where there is no thread behind
 * the chart (the trade home has no conversation), it is a plain line of text
 * rather than a button that would do nothing.
 *
 * @module ThesisChartBadgeLine
 */
import type { TradingChartThesis } from "@t3tools/contracts";
import { useMemo } from "react";

import { cn } from "../../lib/utils";
import type { ComposerPrefill } from "./composerPrefill";
import { thesisChartBadge } from "./thesisChartMarkers";

/** What clicking the badge puts in the composer. */
export function thesisBadgeSentence(headline: string): string {
  return `How is the paper validation of "${headline}" doing, and what has it done on the chart so far?`;
}

/** What clicking one of the paper markers puts in the composer. */
export function paperMarkerSentence(input: {
  readonly headline: string;
  readonly atMillis: number;
}): string {
  const at = new Date(input.atMillis).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `What happened with the paper validation of "${input.headline}" at ${at}?`;
}

/**
 * The chart's `onAskAboutMarker` prop, built here so every surface wires the
 * same click the same way: the question goes into the thread's composer and
 * the user sends it, or does not.
 */
export function askAboutPaperMarker(
  prefill: Exclude<ComposerPrefill, null>,
  headline: string,
): (marker: { readonly at: number }) => void {
  return (marker) => prefill(paperMarkerSentence({ headline, atMillis: marker.at }));
}

const TONE_CLASS = {
  positive: "text-profit",
  negative: "text-loss",
  neutral: "text-muted-foreground",
} as const;

export function ThesisChartBadgeLine({
  thesis,
  prefill,
  className,
}: {
  readonly thesis: TradingChartThesis | null | undefined;
  /** Null on a surface with no thread; the badge renders as text. */
  readonly prefill: ComposerPrefill;
  readonly className?: string;
}) {
  const badge = useMemo(
    () => (thesis === null || thesis === undefined ? null : thesisChartBadge(thesis)),
    [thesis],
  );
  if (badge === null) return null;

  const body = (
    <>
      <span
        aria-hidden
        className={cn(
          "size-1.5 shrink-0 translate-y-[-1px] rounded-full border border-dashed",
          badge.paused ? "border-muted-foreground/60" : "border-foreground/70",
        )}
      />
      <span className="truncate font-medium text-foreground/90">{badge.headline}</span>
      <span className="shrink-0 text-muted-foreground">{badge.note}</span>
      {/* The verdict, last and in its own tone: the reader who only glances at
          this line should still learn whether the idea is working. */}
      <span
        data-testid="market-chart-thesis-comparison"
        className={cn("shrink-0", TONE_CLASS[badge.comparisonTone])}
      >
        · {badge.comparisonLabel}
      </span>
    </>
  );

  const classes = cn(
    "flex items-baseline gap-1.5 px-1 text-left text-[10.5px] leading-tight",
    className,
  );

  if (prefill === null) {
    return (
      <div className={classes} data-testid="market-chart-thesis-badge">
        {body}
      </div>
    );
  }
  return (
    <button
      type="button"
      data-testid="market-chart-thesis-badge"
      data-scroll-anchor-ignore
      className={cn(classes, "w-full rounded-sm hover:bg-accent/40")}
      aria-label={`Ask about the validation of ${badge.headline}`}
      onClick={() => prefill(thesisBadgeSentence(badge.headline))}
    >
      {body}
    </button>
  );
}
