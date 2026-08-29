/**
 * A forward validation's report, drawn.
 *
 * One renderer, two callers: the chat timeline row for a `trading_validate`
 * result, and the alert feed's expiry row, which pulls the same report over
 * its own RPC. They were never allowed to diverge - the numbers on a card the
 * user opens from an alert are the numbers on the card the agent showed them -
 * and the cheapest way to guarantee that is for there to be one card.
 *
 * @module ValidationReportCard
 */
import { ChevronDownIcon, ChevronRightIcon, FlaskConicalIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "../../lib/utils";
import type { ValidationCard } from "./tradingValidation";

const toneClass = (tone: "positive" | "negative" | "neutral") =>
  tone === "positive"
    ? "text-success-foreground"
    : tone === "negative"
      ? "text-destructive"
      : "text-foreground/85";

export function ValidationReportCard({ card }: { card: ValidationCard }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      className="my-1 rounded-xl border border-border/60 border-dashed bg-muted/20"
      data-testid="trading-validation-card"
    >
      <div className="flex flex-col gap-2 px-3 py-2.5">
        <div className="flex items-start gap-2">
          <span className="flex size-6 flex-none items-center justify-center rounded-md bg-foreground/[0.06] text-muted-foreground">
            <FlaskConicalIcon className="size-3.5" strokeWidth={2} aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm leading-snug text-foreground/90">{card.headline}</p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              {card.statusLine}
              {card.exits.length > 0 ? ` · ${card.exits.join(", ")}` : ""}
            </p>
          </div>
        </div>

        <div className="flex items-baseline gap-2 border-border/45 border-t pt-2">
          <span className="text-[11px] text-muted-foreground">{card.expectancy.label}</span>
          <span className={cn("font-mono font-medium text-base", toneClass(card.expectancy.tone))}>
            {card.expectancy.value}
          </span>
        </div>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
          {card.stats.map((stat) => (
            <div key={stat.label} className="min-w-0">
              <dt className="truncate text-[10px] text-muted-foreground uppercase tracking-wide">
                {stat.label}
              </dt>
              <dd className={cn("font-mono text-xs tabular-nums", toneClass(stat.tone))}>
                {stat.value}
              </dd>
            </div>
          ))}
        </dl>

        <p
          className={cn(
            "border-border/45 border-t pt-2 text-xs leading-relaxed",
            toneClass(card.comparisonTone),
          )}
        >
          <span className="font-medium">{card.comparisonLabel}.</span>{" "}
          <span className="text-muted-foreground">{card.verdictReason}</span>
        </p>

        {card.openLine === null ? null : (
          <p className="text-[11px] text-muted-foreground">{card.openLine}</p>
        )}
      </div>

      <button
        type="button"
        aria-expanded={expanded}
        data-scroll-anchor-ignore
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center gap-1.5 px-3 pb-2 text-left text-[11px] text-muted-foreground hover:text-foreground/85"
      >
        {expanded ? (
          <ChevronDownIcon className="size-3 flex-none" />
        ) : (
          <ChevronRightIcon className="size-3 flex-none" />
        )}
        Every number behind this
      </button>
      {expanded ? (
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all px-3 pb-2 text-[11px] text-muted-foreground">
          {card.rawJson}
        </pre>
      ) : null}
    </div>
  );
}
