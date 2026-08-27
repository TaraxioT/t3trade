/**
 * The manual order ticket (final-form Phase 7).
 *
 * Everything on it is a server truth relayed verbatim: as the trader types,
 * the ticket asks `previewTradingOrder` to price and pre-check the entry —
 * the live `deriveFeasibleSize` readout, the planned loss at the stop, the
 * round-trip cost — and shows a refusal exactly as the server worded it,
 * including D4's `market_owned_by_mission`. The stop field is mandatory: the
 * ticket will not preview, let alone place, without one.
 *
 * Placing dispatches `trading.order.place`; the dispatch is only the
 * acknowledgement, and the outcome — filled, resting, or refused — lands in
 * the alert feed and the positions panel over the account doorbell.
 *
 * @module OrderTicket
 */
import { useAtomCommand } from "../../state/use-atom-command";
import type { EnvironmentId, TradingOrderPreviewResult } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

import { cn } from "../../lib/utils";
import { orchestrationEnvironment } from "../../state/orchestration";
import { refreshTradingAccountView, refreshTradingAlerts } from "../../lib/tradingAccountState";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { describeControlFailure } from "./useMissionControls";
import { formatUsd } from "./tradingPresentation";

/** How long the ticket waits after the last keystroke before pricing. */
const PREVIEW_DEBOUNCE_MILLIS = 400;

type Side = "buy" | "sell";
type Urgency = "now" | "patient";

interface TicketInput {
  readonly market: string;
  readonly side: Side;
  readonly stopPrice: number;
  readonly sizeEth: number;
  readonly urgency: Urgency;
}

function parseTicket(
  asset: string,
  side: Side,
  urgency: Urgency,
  sizeText: string,
  stopText: string,
): TicketInput | null {
  const sizeEth = Number(sizeText);
  const stopPrice = Number(stopText);
  if (!Number.isFinite(sizeEth) || sizeEth <= 0) return null;
  if (!Number.isFinite(stopPrice) || stopPrice <= 0) return null;
  return { market: asset, side, stopPrice, sizeEth, urgency };
}

function PreviewReadout({ preview }: { preview: TradingOrderPreviewResult }) {
  if (preview.outcome === "refused") {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs">
        <span className="font-medium text-destructive">{preview.reason}</span>
        <span className="text-foreground"> — {preview.detail}</span>
        {preview.feasibleSize === undefined ? null : (
          <span className="text-muted-foreground"> (feasible: {preview.feasibleSize})</span>
        )}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-0.5 rounded-md border border-border/70 px-2 py-1.5 text-xs text-muted-foreground">
      <span className="tabular-nums">
        size {preview.size} · {formatUsd(preview.notionalUsd)} @ ~{preview.limitPrice}
      </span>
      <span className="tabular-nums">
        max feasible {preview.feasibleSize} · loss at stop {formatUsd(preview.plannedLossAtStopUsd)}{" "}
        · round trip ~{formatUsd(preview.estimatedRoundTripCostUsd)}
      </span>
      {preview.notes.map((note) => (
        <span key={note} className="text-armed">
          {note}
        </span>
      ))}
    </div>
  );
}

export function OrderTicket({
  environmentId,
  asset,
}: {
  environmentId: EnvironmentId;
  asset: string;
}) {
  const previewOrder = useAtomCommand(orchestrationEnvironment.previewTradingOrder);
  const placeOrder = useAtomCommand(orchestrationEnvironment.placeTradingOrder);

  const [side, setSide] = useState<Side>("buy");
  const [urgency, setUrgency] = useState<Urgency>("now");
  const [sizeText, setSizeText] = useState("");
  const [stopText, setStopText] = useState("");
  const [preview, setPreview] = useState<TradingOrderPreviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPlacing, setIsPlacing] = useState(false);
  const [placedNote, setPlacedNote] = useState<string | null>(null);
  const previewSeq = useRef(0);

  const ticket = parseTicket(asset, side, urgency, sizeText, stopText);

  // The live readout: debounce, then price the current ticket server-side.
  // Every response is matched against the latest request so a slow older
  // preview can never overwrite a newer one.
  useEffect(() => {
    setPlacedNote(null);
    if (ticket === null) {
      setPreview(null);
      return;
    }
    const seq = ++previewSeq.current;
    const handle = setTimeout(() => {
      void previewOrder({
        environmentId,
        input: {
          market: ticket.market,
          side: ticket.side,
          stopPrice: ticket.stopPrice,
          sizeEth: ticket.sizeEth,
          urgency: ticket.urgency,
        },
      }).then((result) => {
        if (previewSeq.current !== seq) return;
        const failure = describeControlFailure(result);
        if (failure !== null) {
          setError(failure);
          setPreview(null);
          return;
        }
        setError(null);
        if (result._tag === "Success") setPreview(result.value);
      });
    }, PREVIEW_DEBOUNCE_MILLIS);
    return () => clearTimeout(handle);
    // Keyed by the ticket's raw fields; `ticket` and `previewOrder` are
    // derived from them and stable respectively.
  }, [environmentId, asset, side, urgency, sizeText, stopText]);

  const canPlace = ticket !== null && preview?.outcome === "prepared" && !isPlacing;

  const place = () => {
    if (ticket === null || !canPlace) return;
    setIsPlacing(true);
    setError(null);
    void placeOrder({
      environmentId,
      input: {
        market: ticket.market,
        side: ticket.side,
        stopPrice: ticket.stopPrice,
        sizeEth: ticket.sizeEth,
        urgency: ticket.urgency,
      },
    }).then((result) => {
      setIsPlacing(false);
      const failure = describeControlFailure(result);
      if (failure !== null) {
        setError(failure);
        return;
      }
      setPlacedNote("Order sent — the outcome lands in the alert feed and positions.");
      setSizeText("");
      setPreview(null);
      refreshTradingAccountView(environmentId);
      refreshTradingAlerts(environmentId);
    });
  };

  return (
    <form
      aria-label={`${asset} order ticket`}
      className="flex flex-col gap-1.5 rounded-md border border-border/70 p-2"
      onSubmit={(event) => {
        event.preventDefault();
        place();
      }}
    >
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold text-foreground">Trade {asset}</span>
        <div className="ml-auto flex overflow-hidden rounded-md border border-border/70 text-xs">
          {(["buy", "sell"] as const).map((option) => (
            <button
              key={option}
              type="button"
              className={cn(
                "px-2 py-1",
                side === option
                  ? option === "buy"
                    ? "bg-accent font-medium text-long"
                    : "bg-accent font-medium text-short"
                  : "text-muted-foreground hover:text-foreground",
              )}
              onClick={() => setSide(option)}
            >
              {option}
            </button>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Input
          aria-label="Size"
          className="h-8 text-sm tabular-nums"
          inputMode="decimal"
          placeholder={`Size (${asset})`}
          value={sizeText}
          onChange={(event) => setSizeText(event.target.value)}
        />
        <Input
          aria-label="Stop price"
          className="h-8 text-sm tabular-nums"
          inputMode="decimal"
          placeholder="Stop price (required)"
          value={stopText}
          onChange={(event) => setStopText(event.target.value)}
        />
      </div>
      <div className="flex items-center gap-2">
        <div className="flex overflow-hidden rounded-md border border-border/70 text-xs">
          {(["now", "patient"] as const).map((option) => (
            <button
              key={option}
              type="button"
              className={cn(
                "px-2 py-1",
                urgency === option
                  ? "bg-accent font-medium text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
              onClick={() => setUrgency(option)}
            >
              {option}
            </button>
          ))}
        </div>
        <Button size="sm" type="submit" disabled={!canPlace} className="ml-auto">
          {isPlacing ? "Placing…" : `Place ${side}`}
        </Button>
      </div>
      {stopText.trim().length === 0 ? (
        <p className="text-xs text-muted-foreground">
          Every entry carries a stop — set one to price the ticket.
        </p>
      ) : null}
      {preview === null ? null : <PreviewReadout preview={preview} />}
      {error === null ? null : <p className="text-xs text-destructive">{error}</p>}
      {placedNote === null ? null : <p className="text-xs text-muted-foreground">{placedNote}</p>}
    </form>
  );
}
