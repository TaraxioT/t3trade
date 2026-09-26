import type { SavedEventStudy } from "@t3tools/trading-contracts/eventResearch";
import type { TradingChartCandle } from "@t3tools/contracts";

import { MissionPriceChart } from "./MissionPriceChart";

function horizonLabel(ms: number): string {
  if (ms % 86_400_000 === 0) return `+${ms / 86_400_000}d`;
  if (ms % 3_600_000 === 0) return `+${ms / 3_600_000}h`;
  return `+${ms / 60_000}m`;
}

function dateTime(at: number | null): string {
  return at === null
    ? "time unavailable"
    : new Date(at).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

export function EventResearchResult(props: {
  readonly study: SavedEventStudy;
  readonly mode: "calendar" | "aligned";
  readonly selectedEventId: string;
  readonly onSelectEvent: (id: string) => void;
  readonly horizonMs: number;
  readonly onSelectHorizon: (ms: number) => void;
  readonly candles: ReadonlyArray<TradingChartCandle>;
}) {
  const { study } = props;
  const selected =
    study.report.rows.find((row) => row.eventId === props.selectedEventId) ?? study.report.rows[0];
  const outcome = selected?.horizons.find((row) => row.horizonMs === props.horizonMs);
  const source = study.recipe.source;
  return (
    <section className="flex min-h-0 flex-col gap-2 text-xs" data-testid="graph-event-study-result">
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        <span>The Graph · Ethereum · WETH/USDC v3 · USDC per ETH</span>
        <span>pool {source.poolAddress}</span>
        <span>block {study.recipe.snapshotBlock.number}</span>
        <span>report {study.reportHash.slice(0, 12)}</span>
      </div>
      {study.recipe.eventInventory.status === "incomplete" ? (
        <p className="text-amber-600">
          Official FOMC inventory incomplete:{" "}
          {study.recipe.eventInventory.affectedPeriods.join(", ")}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-1" role="tablist" aria-label="Research horizon">
        {study.recipe.horizonsMs.map((horizon) => {
          const summary = study.report.summaries.find((item) => item.horizonMs === horizon);
          return (
            <button
              key={horizon}
              type="button"
              role="tab"
              aria-selected={horizon === props.horizonMs}
              className="rounded border px-2 py-1"
              onClick={() => props.onSelectHorizon(horizon)}
            >
              {horizonLabel(horizon)} · {summary?.measuredCount ?? 0}/{summary?.eligibleCount ?? 0}{" "}
              measured
            </button>
          );
        })}
      </div>
      {study.report.rows.length === 0 ? <p>No FOMC occurrences in this inventory.</p> : null}
      {props.mode === "aligned" ? (
        <div className="rounded border p-2" data-testid="graph-event-aligned">
          <strong>{horizonLabel(props.horizonMs)} across meetings</strong>
          <p>
            Mean descriptive spot return:{" "}
            {(() => {
              const value = study.report.summaries.find(
                (item) => item.horizonMs === props.horizonMs,
              )?.meanReturnPct;
              return value === null || value === undefined
                ? "unavailable"
                : `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
            })()}
          </p>
          <p>Each occurrence below keeps its own measured or uncovered outcome.</p>
        </div>
      ) : selected === undefined ? null : (
        <div data-testid="graph-event-calendar-chart">
          <p>
            {selected.event.meetingFrom}–{selected.event.meetingTo} · statement{" "}
            {dateTime(selected.event.statementAt)}
          </p>
          {props.candles.length >= 2 ? (
            <MissionPriceChart
              candles={props.candles}
              includeStudyPricesInDomain
              researchMarkers={
                selected.event.statementAt === null
                  ? []
                  : [
                      {
                        key: selected.eventId,
                        label: "FOMC statement",
                        startAt: selected.event.statementAt,
                        endAt: selected.event.statementAt,
                        sourceUrl: selected.event.sourceUrl,
                        covered: outcome?.status === "measured",
                        upcoming: false,
                      },
                    ]
              }
              studyOverlay={{
                activation:
                  selected.event.statementAt === null
                    ? null
                    : { at: selected.event.statementAt, label: "FOMC statement" },
                entry:
                  outcome?.status === "measured"
                    ? { at: outcome.referenceAt, price: outcome.referencePrice, label: "reference" }
                    : null,
                exit:
                  outcome?.status === "measured"
                    ? {
                        at: outcome.horizonAt,
                        price: outcome.horizonPrice,
                        label: horizonLabel(props.horizonMs),
                      }
                    : null,
                returnPct: outcome?.status === "measured" ? outcome.returnPct : null,
              }}
              entryPrice={null}
              stopPrice={null}
              targetPrice={null}
              liquidationPrice={null}
              entryTime={null}
              markPrice={null}
              pnlSign={null}
              markMotion="static"
              showVolume={false}
              className="h-[180px]"
            />
          ) : (
            <p>Retained candle context is unavailable for this meeting.</p>
          )}
          <p>
            {outcome?.status === "measured"
              ? `${outcome.returnPct >= 0 ? "+" : ""}${outcome.returnPct.toFixed(2)}% · ${outcome.referencePrice.toFixed(2)} → ${outcome.horizonPrice.toFixed(2)} USDC/ETH`
              : outcome?.status === "pending"
                ? "Future horizon pending"
                : `Uncovered: ${outcome?.reason ?? "no measurement"}`}
          </p>
        </div>
      )}
      <div className="max-h-56 overflow-auto" data-testid="graph-fomc-meetings">
        <table className="w-full text-left">
          <thead>
            <tr>
              <th>Meeting</th>
              <th>Statement UTC</th>
              <th>{horizonLabel(props.horizonMs)} spot return</th>
              <th>Source</th>
            </tr>
          </thead>
          <tbody>
            {study.report.rows.map((row) => {
              const value = row.horizons.find((item) => item.horizonMs === props.horizonMs);
              return (
                <tr
                  key={row.eventId}
                  className={row.eventId === selected?.eventId ? "bg-accent/30" : ""}
                >
                  <td>
                    <button
                      type="button"
                      className="underline"
                      onClick={() => props.onSelectEvent(row.eventId)}
                    >
                      {row.event.meetingTo}
                    </button>
                  </td>
                  <td>{dateTime(row.event.statementAt)}</td>
                  <td>
                    {value?.status === "measured"
                      ? `${value.returnPct >= 0 ? "+" : ""}${value.returnPct.toFixed(2)}%`
                      : value?.status === "pending"
                        ? "pending"
                        : `uncovered: ${value?.reason ?? "unknown"}`}
                  </td>
                  <td>
                    <a href={row.event.sourceUrl} target="_blank" rel="noreferrer">
                      Fed statement
                    </a>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-muted-foreground">
        Descriptive spot returns from retained Graph samples; no order was placed.
      </p>
    </section>
  );
}
