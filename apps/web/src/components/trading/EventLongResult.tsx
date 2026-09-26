import type { SavedEventStudy } from "@t3tools/trading-contracts/eventResearch";
import type { SavedEventLongSimulation } from "@t3tools/trading-contracts/eventLongSimulation";
import type { TradingChartCandle } from "@t3tools/contracts";

import { MissionPriceChart } from "./MissionPriceChart";

const money = (value: number): string => `${value >= 0 ? "+" : ""}${value.toFixed(2)} USDC`;

/** A saved hypothetical ledger, drawn at the same retained sample times as its arithmetic. */
export function EventLongResult(props: {
  readonly study: SavedEventStudy;
  readonly simulation: SavedEventLongSimulation;
  readonly selectedEventId: string;
  readonly onSelectEvent: (id: string) => void;
  readonly candles: ReadonlyArray<TradingChartCandle>;
}) {
  const { simulation, study } = props;
  const selected =
    simulation.report.outcomes.find((row) => row.eventId === props.selectedEventId) ??
    simulation.report.outcomes[0];
  const event = study.report.rows.find((row) => row.eventId === selected?.eventId)?.event;
  const scenario = simulation.scenario;
  return (
    <section className="flex min-h-0 flex-col gap-2 text-xs" data-testid="graph-long-result">
      <p className="text-muted-foreground">
        The Graph · Ethereum · WETH/USDC v3 · USDC per ETH · saved simulation{" "}
        {simulation.simulationId}
      </p>
      <div className="rounded border p-2" data-testid="graph-long-assumptions">
        {scenario.notionalQuote.toLocaleString()} USDC per independent long · entry{" "}
        {scenario.entryDelayMs / 60_000} minutes after statement · hold{" "}
        {scenario.holdMs / 3_600_000} hours · fee {scenario.feeBpsPerSide} bps/side · slippage{" "}
        {scenario.slippageBpsPerSide} bps/side
      </div>
      <div className="flex flex-wrap gap-3 font-medium">
        <span>
          {simulation.report.summary.coveredTrades}/{simulation.report.summary.eventCount} traded
        </span>
        <span>Net {money(simulation.report.summary.totalNetPnlQuote)}</span>
        <span>Fees {simulation.report.summary.totalFeesQuote.toFixed(2)} USDC</span>
        <span>Slippage {simulation.report.summary.totalSlippageCostQuote.toFixed(2)} USDC</span>
      </div>
      <p className="text-muted-foreground">
        Independent trades; returns are not compounded. Hypothetical spot prices; no order was
        placed.
      </p>
      {selected?.status === "traded" && props.candles.length >= 2 ? (
        <MissionPriceChart
          candles={props.candles}
          includeStudyPricesInDomain
          eventBands={[
            {
              key: selected.eventId,
              label: "hypothetical holding period",
              startAt: selected.entryAt,
              endAt: selected.exitAt,
              upcoming: false,
            },
          ]}
          studyOverlay={{
            activation:
              event?.statementAt == null
                ? null
                : { at: event.statementAt, label: "FOMC statement" },
            entry: {
              at: selected.entryAt,
              price: selected.entryPrice,
              label: "hypothetical entry",
            },
            exit: { at: selected.exitAt, price: selected.exitPrice, label: "hypothetical exit" },
            returnPct: selected.netReturnPct,
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
        <p>Retained candle context or trade samples are unavailable for this meeting.</p>
      )}
      <div className="max-h-56 overflow-auto" data-testid="graph-long-ledger">
        <table className="w-full text-left">
          <thead>
            <tr>
              <th>Meeting</th>
              <th>Outcome</th>
              <th>Entry / exit UTC</th>
              <th>Net P&amp;L</th>
              <th>Costs</th>
            </tr>
          </thead>
          <tbody>
            {simulation.report.outcomes.map((row) => {
              const meeting = study.report.rows.find((item) => item.eventId === row.eventId)?.event;
              return (
                <tr
                  key={row.eventId}
                  className={selected?.eventId === row.eventId ? "bg-accent/30" : ""}
                >
                  <td>
                    <button
                      type="button"
                      className="underline"
                      onClick={() => props.onSelectEvent(row.eventId)}
                    >
                      {meeting?.meetingTo ?? row.eventId}
                    </button>
                  </td>
                  <td>
                    {row.status === "traded"
                      ? `${row.entryPrice.toFixed(2)} → ${row.exitPrice.toFixed(2)} USDC/ETH`
                      : `skipped: ${row.reason}`}
                  </td>
                  <td>
                    {row.status === "traded"
                      ? `${new Date(row.entryAt).toISOString().slice(0, 16)} / ${new Date(row.exitAt).toISOString().slice(0, 16)}`
                      : "—"}
                  </td>
                  <td>{row.status === "traded" ? money(row.netPnlQuote) : "—"}</td>
                  <td>
                    {row.status === "traded"
                      ? `${(row.entryFeeQuote + row.exitFeeQuote + row.slippageCostQuote).toFixed(2)} USDC`
                      : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
