/**
 * What the account is currently testing, on the trade home's right column.
 *
 * Under the alert feed rather than beside it, and the pairing is deliberate:
 * the feed is what has already happened, this is what is being found out. Both
 * ride the account doorbell, so the two lists are always as fresh as each
 * other and neither adds a poll.
 *
 * A row is a validation on the clock or a filed idea whose runs have finished
 * (see the server's `tradingIdeaRows` for the selection rule). Every sentence
 * on it is composed client-side from the numbers the row carries.
 *
 * Two affordances, and neither of them mutates anything. Clicking the row
 * selects that market, so the chart in the middle column becomes a chart of
 * the idea being read. The chevron writes a status question into the composer
 * of the thread the idea was armed in - or, when the idea has no thread, opens
 * an analyst thread on its market with the same question waiting. The user
 * sends it, or does not.
 *
 * @module IdeasPanel
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { FlaskConicalIcon, MessageSquareIcon } from "lucide-react";
import { useMemo } from "react";

import { refreshTradingIdeas, useTradingIdeas } from "../../lib/tradingAccountState";
import { cn } from "../../lib/utils";
import { ideaRowView, ideaStatusSentence, type IdeaRowView } from "./tradingIdeaPresentation";
import { analystMarketPrompt, useAskAnalyst, useAskInThread } from "./useTradingThreadLaunch";

const TONE_CLASS = {
  positive: "text-profit",
  negative: "text-loss",
  neutral: "text-muted-foreground",
} as const;

function IdeaRow({
  row,
  onSelect,
  onAsk,
}: {
  readonly row: IdeaRowView;
  readonly onSelect: (market: string) => void;
  readonly onAsk: (row: IdeaRowView) => void;
}) {
  return (
    <li className="flex items-start gap-1 py-1.5">
      <button
        type="button"
        data-testid={`idea-row-${row.id}`}
        className="min-w-0 flex-1 rounded-sm px-1 text-left hover:bg-accent/40"
        onClick={() => onSelect(row.market)}
      >
        <span className="flex items-baseline gap-1.5">
          <span className="truncate text-[12.5px] font-medium text-foreground">{row.title}</span>
          <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground">
            {row.marketLine}
          </span>
        </span>
        <span className="mt-0.5 flex flex-wrap items-baseline gap-x-1.5 text-[10.5px] leading-tight text-muted-foreground">
          <span>{row.statusLabel}</span>
          {row.timeLeft === null ? null : <span>· {row.timeLeft}</span>}
        </span>
        <span className="mt-0.5 flex flex-wrap items-baseline gap-x-1.5 text-[10.5px] leading-tight">
          <span className={cn("tabular-nums", TONE_CLASS[row.expectancyTone])}>
            {row.expectancyLabel}
          </span>
          <span className="text-muted-foreground">· {row.tradesLabel}</span>
          <span className={TONE_CLASS[row.comparisonTone]}>· {row.comparisonLabel}</span>
        </span>
      </button>
      <button
        type="button"
        data-testid={`idea-ask-${row.id}`}
        aria-label={`Ask about ${row.title}`}
        className="mt-1 shrink-0 rounded-sm p-1 text-muted-foreground hover:bg-accent/40 hover:text-foreground"
        onClick={() => onAsk(row)}
      >
        <MessageSquareIcon className="size-3.5" />
      </button>
    </li>
  );
}

export function IdeasPanel({
  environmentId,
  onSelectMarket,
}: {
  readonly environmentId: EnvironmentId;
  /** Selecting a row drives the middle column's chart. */
  readonly onSelectMarket: (market: string) => void;
}) {
  const { data, error, isLoading } = useTradingIdeas(environmentId);
  const analyst = useAskAnalyst(environmentId);
  const askInThread = useAskInThread(environmentId);

  // `Date.now()` is read once per render rather than on a timer: a countdown
  // in days and hours does not need to tick, and a panel that repainted every
  // second to change nothing is exactly the kind of thing this app does not do.
  const rows = useMemo(() => {
    const now = Date.now();
    return (data?.ideas ?? []).map((row) => ideaRowView(row, now));
  }, [data]);

  const ask = (row: IdeaRowView): void => {
    const sentence = ideaStatusSentence(row);
    if (row.threadId !== null) {
      void askInThread({ threadId: row.threadId, sentence }).catch(() => undefined);
      return;
    }
    // No thread behind the idea - an agent armed it outside a conversation, or
    // the thread is gone. The launcher opens the market's analyst thread with
    // the same question waiting in it, which is the nearest thing to the
    // conversation this idea should have had.
    void analyst.ask({
      asset: row.market,
      prompt: `${sentence}\n\n${analystMarketPrompt(row.market)}`,
    });
  };

  return (
    <section aria-label="Ideas in forward validation" className="flex min-h-0 flex-col gap-2">
      <header className="flex items-center gap-1.5 px-1">
        <FlaskConicalIcon className="size-3.5 text-muted-foreground" />
        {/* Forward paper validation, not generic testing: these are theses
            being evaluated on future bars against a paper ledger. A backtest
            or event study never appears here and is never "paper trading". */}
        <h2 className="text-sm font-semibold text-foreground">Forward validation</h2>
        <button
          type="button"
          className="ml-auto text-[11px] text-muted-foreground hover:text-foreground"
          onClick={() => refreshTradingIdeas(environmentId)}
        >
          refresh
        </button>
      </header>
      {error !== null ? (
        <p className="px-1 text-sm text-destructive">{error}</p>
      ) : rows.length === 0 ? (
        // One sentence, and it needs no key: a validation runs on recorded
        // bars, so this panel says the same thing in research mode as it does
        // with a signer armed.
        <p className="px-1 py-2 text-sm text-muted-foreground" data-testid="ideas-panel-empty">
          {isLoading && data === null
            ? "Loading ideas…"
            : "Nothing on paper right now. Ask the agent to validate a thesis forward and it will show up here."}
        </p>
      ) : (
        <ul
          className="min-h-0 divide-y divide-border/40 overflow-y-auto"
          data-testid="ideas-panel-list"
        >
          {rows.map((row) => (
            <IdeaRow key={row.id} row={row} onSelect={onSelectMarket} onAsk={ask} />
          ))}
        </ul>
      )}
      {analyst.error === null ? null : (
        <p className="px-1 text-[11px] text-destructive">{analyst.error}</p>
      )}
    </section>
  );
}
