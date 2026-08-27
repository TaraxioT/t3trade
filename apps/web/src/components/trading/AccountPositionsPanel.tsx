/**
 * Open positions and working orders, addressed by account (final-form
 * Phase 4). Everything renders off `TradingAccountView` — the reconciled
 * tables read account-first — plus the mission projection for the owning
 * authority's thread link and controls.
 *
 * The two labels this panel exists for are the D4/D5 answers: who may act on
 * the position (mission link or "Manual"), and which promise protects it
 * ("Stop on exchange" rests on the venue and survives T3 being down;
 * "Server-executed" is the server watching the level itself).
 *
 * @module AccountPositionsPanel
 */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentId,
  OrchestrationTradingMission,
  TradingAccountOpenOrder,
  TradingAccountPosition,
  TradingAccountState,
  ThreadId,
} from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";

import { cn } from "../../lib/utils";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Button } from "../ui/button";
import { useState } from "react";

import { refreshTradingAccountView } from "../../lib/tradingAccountState";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useAtomCommand } from "../../state/use-atom-command";
import { describeProtection } from "./tradeHomePresentation";
import { formatPrice, formatSignedUsd, formatUsd } from "./tradingPresentation";
import { describeControlFailure, useMissionControls } from "./useMissionControls";

function missionForAuthority(
  position: TradingAccountPosition,
  missions: ReadonlyArray<OrchestrationTradingMission>,
): OrchestrationTradingMission | null {
  if (position.authority.kind !== "mission") return null;
  const missionId = position.authority.missionId;
  return missions.find((mission) => mission.id === missionId) ?? null;
}

/**
 * The account-scoped way out of a MANUAL position (final-form Phase 7): the
 * same reduce/close pair the mission rows get, through
 * `closeTradingManualPosition`. A refusal — a mission has since taken the
 * market, the exchange refused — renders verbatim beside the buttons.
 */
function ManualPositionControls({
  position,
  environmentId,
}: {
  position: TradingAccountPosition;
  environmentId: EnvironmentId;
}) {
  const close = useAtomCommand(orchestrationEnvironment.closeTradingManualPosition);
  const [isBusy, setIsBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const run = (percent?: 25 | 50 | 75 | 100) => {
    setIsBusy(true);
    setNote(null);
    void close({
      environmentId,
      input: {
        market: position.market,
        ...(percent === undefined ? {} : { percent }),
      },
    }).then((result) => {
      setIsBusy(false);
      const failure = describeControlFailure(result);
      if (failure !== null) {
        setNote(failure);
        return;
      }
      if (result._tag === "Success") {
        setNote(
          result.value.outcome === "refused"
            ? `${result.value.reason} — ${result.value.detail}`
            : result.value.summary,
        );
      }
      refreshTradingAccountView(environmentId);
    });
  };

  return (
    <span className="flex items-center gap-1.5">
      <Button size="sm" variant="secondary" disabled={isBusy} onClick={() => run(50)}>
        Reduce 50%
      </Button>
      <Button size="sm" variant="secondary" disabled={isBusy} onClick={() => run()}>
        Close
      </Button>
      {note === null ? null : <span className="text-xs text-muted-foreground">{note}</span>}
    </span>
  );
}

/** The compact §14.7 way out, only where a mission owns the position. */
function PositionMissionControls({
  mission,
  environmentId,
}: {
  mission: OrchestrationTradingMission;
  environmentId: EnvironmentId;
}) {
  const controls = useMissionControls(mission, environmentId);
  return (
    <span className="flex items-center gap-1.5">
      <Button
        size="sm"
        variant="secondary"
        disabled={controls.isBusy}
        onClick={() => controls.risk("reduce_position", 50)}
      >
        Reduce 50%
      </Button>
      <Button
        size="sm"
        variant="secondary"
        disabled={controls.isBusy}
        onClick={() => controls.risk("close_position")}
      >
        Close
      </Button>
      {controls.error === null ? null : (
        <span className="text-xs text-destructive">{controls.error}</span>
      )}
    </span>
  );
}

function PositionRow({
  position,
  missions,
  environmentId,
  selected,
  onSelect,
}: {
  position: TradingAccountPosition;
  missions: ReadonlyArray<OrchestrationTradingMission>;
  environmentId: EnvironmentId;
  selected: boolean;
  onSelect: (asset: string) => void;
}) {
  const router = useRouter();
  const mission = missionForAuthority(position, missions);
  const side = position.size >= 0 ? "Long" : "Short";

  return (
    <li
      className={cn(
        "flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md px-2 py-2",
        selected && "bg-accent/50",
      )}
    >
      <button
        type="button"
        className="flex items-baseline gap-2 text-left"
        onClick={() => onSelect(position.market.asset)}
      >
        <span className="text-sm font-medium text-foreground">{position.market.asset}</span>
        <span
          className={cn("text-xs font-medium", position.size >= 0 ? "text-long" : "text-short")}
        >
          {side} {Math.abs(position.size)}
        </span>
      </button>
      <span className="text-xs tabular-nums text-muted-foreground">
        entry {position.entryPrice === undefined ? "—" : formatPrice(position.entryPrice)}
      </span>
      <span className="text-xs tabular-nums text-muted-foreground">
        mark {position.markPrice === undefined ? "—" : formatPrice(position.markPrice)}
      </span>
      <span
        className={cn(
          "text-xs font-medium tabular-nums",
          position.unrealisedPnl >= 0 ? "text-profit" : "text-loss",
        )}
      >
        {formatSignedUsd(position.unrealisedPnl)}
      </span>
      <span
        className={cn(
          "text-xs",
          position.protectedSize === 0 || position.protection === null
            ? "text-armed"
            : "text-muted-foreground",
        )}
      >
        {describeProtection(position)}
      </span>
      {mission !== null ? (
        <button
          type="button"
          className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
          onClick={() =>
            void router.navigate({
              to: "/$environmentId/$threadId",
              params: buildThreadRouteParams(
                scopeThreadRef(environmentId, mission.threadId as ThreadId),
              ),
            })
          }
        >
          Mission
        </button>
      ) : (
        <span className="text-xs text-muted-foreground">
          {position.authority.kind === "mission" ? "Mission (settled)" : "Manual"}
        </span>
      )}
      <span className="ml-auto">
        {mission !== null ? (
          <PositionMissionControls mission={mission} environmentId={environmentId} />
        ) : position.authority.kind === "manual" ? (
          <ManualPositionControls position={position} environmentId={environmentId} />
        ) : null}
      </span>
    </li>
  );
}

function OpenOrderRow({ order }: { order: TradingAccountOpenOrder }) {
  return (
    <li className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-2 py-1 text-xs">
      <span className="font-medium text-foreground">{order.market.asset}</span>
      <span className={order.side === "buy" ? "text-long" : "text-short"}>
        {order.side} {order.remainingSize}
      </span>
      <span className="tabular-nums text-muted-foreground">@ {formatPrice(order.limitPrice)}</span>
      {order.reduceOnly ? <span className="text-muted-foreground">reduce-only</span> : null}
      <span className="ml-auto text-muted-foreground">
        {order.authority.kind === "mission" ? "mission" : "manual"}
      </span>
    </li>
  );
}

export function AccountPositionsPanel({
  accounts,
  missions,
  environmentId,
  selectedAsset,
  onSelect,
}: {
  accounts: ReadonlyArray<TradingAccountState>;
  missions: ReadonlyArray<OrchestrationTradingMission>;
  environmentId: EnvironmentId;
  selectedAsset: string | null;
  onSelect: (asset: string) => void;
}) {
  const positions = accounts.flatMap((account) => account.positions);
  const openOrders = accounts.flatMap((account) => account.openOrders);
  const balance = accounts.find((account) => account.balanceUsd !== null)?.balanceUsd ?? null;

  return (
    <section aria-label="Positions" className="flex min-h-0 flex-col gap-1.5">
      <header className="flex items-baseline justify-between px-1">
        <h2 className="text-sm font-semibold text-foreground">Positions</h2>
        {balance === null ? null : (
          <span className="text-xs tabular-nums text-muted-foreground">
            balance {formatUsd(balance)}
          </span>
        )}
      </header>
      {positions.length === 0 ? (
        <p className="px-1 py-2 text-sm text-muted-foreground">No open positions.</p>
      ) : (
        <ul className="divide-y divide-border/50">
          {positions.map((position) => (
            <PositionRow
              key={`${position.market.venue}:${position.market.asset}`}
              position={position}
              missions={missions}
              environmentId={environmentId}
              selected={position.market.asset === selectedAsset}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}
      {openOrders.length === 0 ? null : (
        <>
          <h3 className="px-1 pt-1 text-xs font-medium text-muted-foreground">Open orders</h3>
          <ul className="divide-y divide-border/40">
            {openOrders.map((order) => (
              <OpenOrderRow key={order.cloid} order={order} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
