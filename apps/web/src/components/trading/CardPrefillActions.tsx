/**
 * The row of "ask about this" affordances under a trading card.
 *
 * Deliberately not buttons that look like commands. Each one drops a sentence
 * into the composer and nothing else happens until the user presses send, so
 * they are styled as the quiet text links they behave like, and their labels
 * name the request rather than the effect: "Validate forward on paper", not
 * "Start validation".
 *
 * @module CardPrefillActions
 */
import { cn } from "../../lib/utils";
import type { ComposerPrefill } from "./composerPrefill";

export interface CardPrefillAction {
  readonly label: string;
  /** The sentence written into the composer. */
  readonly sentence: string;
}

/**
 * Renders nothing when there is no composer to write to - the alert feed shows
 * the validation card on the trade home, where there is no thread behind it.
 */
export function CardPrefillActions({
  prefill,
  actions,
  className,
}: {
  prefill: ComposerPrefill;
  actions: ReadonlyArray<CardPrefillAction>;
  className?: string;
}) {
  if (prefill === null || actions.length === 0) return null;
  return (
    <div
      data-testid="trading-card-prefill-actions"
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-1 border-border/45 border-t px-3 py-1.5",
        className,
      )}
    >
      {actions.map((action) => (
        <button
          key={action.label}
          type="button"
          data-scroll-anchor-ignore
          data-prefill-sentence={action.sentence}
          onClick={() => prefill(action.sentence)}
          className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground/85 hover:underline"
        >
          {action.label}
        </button>
      ))}
    </div>
  );
}
