/**
 * Alerts (final-form Phase 5): the fired-alert feed, the armed watches with
 * their cancels, and the arming form.
 *
 * The form arms an account-scoped price watch — no mission anywhere near it.
 * Delivery is pinned to `notify`, which is the only route the server accepts
 * for an account watch (a wake needs a mission thread to wake), so the form
 * does not offer a choice it would be refused.
 *
 * Desktop also raises an OS notification for each alert that arrives while
 * the panel is mounted: feature-detected off the desktop bridge, so web
 * silently skips it. Detection is pure (`selectNewAlerts`) and keyed off the
 * doorbell-driven feed reads — no timer of its own.
 *
 * @module AlertFeedPanel
 */
import type { EnvironmentId, TradingAccountWatch, TradingArmWatchInput } from "@t3tools/contracts";
import { BellIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  refreshTradingAlerts,
  refreshTradingWatches,
  useTradingAlerts,
  useTradingWatches,
} from "../../lib/tradingAccountState";
import { cn } from "../../lib/utils";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { UniverseAssetSearch } from "./UniverseAssetSearch";
import { alertNotificationText, selectNewAlerts } from "./tradeHomePresentation";
import { describeControlFailure } from "./useMissionControls";

/** The repeat cooldown the form arms when "repeat" is chosen: 5 minutes. */
const REPEAT_COOLDOWN_MILLIS = 5 * 60_000;

function describeAccountWatch(watch: TradingAccountWatch): string {
  const condition = watch.condition;
  if (condition.kind === "price") {
    return `${condition.market} crosses ${condition.direction} ${condition.price}`;
  }
  // The form only arms price watches today, but the list serves whatever the
  // server holds; fall back to the shared vocabulary for the rest.
  return `${watch.market.asset}: ${condition.kind}`;
}

function ArmWatchForm({ environmentId }: { environmentId: EnvironmentId }) {
  const arm = useAtomCommand(orchestrationEnvironment.armTradingWatch);
  const [asset, setAsset] = useState<string | null>(null);
  const [direction, setDirection] = useState<"above" | "below">("above");
  const [priceText, setPriceText] = useState("");
  const [repeat, setRepeat] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  const price = Number(priceText);
  const canSubmit =
    asset !== null && priceText.trim().length > 0 && Number.isFinite(price) && price > 0;

  const submit = () => {
    if (!canSubmit || asset === null) return;
    const input: TradingArmWatchInput = {
      condition: {
        kind: "price",
        market: asset,
        direction,
        price,
        confirm: "touch",
      },
      deliver: "notify",
      rearm: repeat ? { mode: "repeat", cooldownMs: REPEAT_COOLDOWN_MILLIS } : { mode: "once" },
    };
    setIsBusy(true);
    setError(null);
    void arm({ environmentId, input }).then((result) => {
      setIsBusy(false);
      const failure = describeControlFailure(result);
      if (failure !== null) {
        setError(failure);
        return;
      }
      if (result._tag === "Success" && result.value.outcome === "rejected") {
        setError(result.value.reason);
        return;
      }
      setAsset(null);
      setPriceText("");
      refreshTradingWatches(environmentId);
    });
  };

  return (
    <form
      className="flex flex-col gap-1.5 rounded-md border border-border/70 p-2"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {asset === null ? (
        <UniverseAssetSearch
          environmentId={environmentId}
          placeholder="Alert on asset…"
          onPick={setAsset}
        />
      ) : (
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-medium text-foreground">{asset}</span>
          <button
            type="button"
            aria-label="Change asset"
            className="rounded-md p-0.5 text-muted-foreground hover:text-foreground"
            onClick={() => setAsset(null)}
          >
            <XIcon className="size-3.5" />
          </button>
          <div className="ml-auto flex overflow-hidden rounded-md border border-border/70 text-xs">
            {(["above", "below"] as const).map((option) => (
              <button
                key={option}
                type="button"
                className={cn(
                  "px-2 py-1",
                  direction === option
                    ? "bg-accent font-medium text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
                onClick={() => setDirection(option)}
              >
                {option}
              </button>
            ))}
          </div>
        </div>
      )}
      {asset === null ? null : (
        <>
          <div className="flex items-center gap-2">
            <Input
              className="h-8 text-sm tabular-nums"
              inputMode="decimal"
              placeholder="Price"
              value={priceText}
              onChange={(event) => setPriceText(event.target.value)}
            />
            <Button size="sm" type="submit" disabled={!canSubmit || isBusy}>
              Arm
            </Button>
          </div>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={repeat}
              onChange={(event) => setRepeat(event.target.checked)}
            />
            Repeat with a 5 min cooldown (otherwise fires once)
          </label>
        </>
      )}
      {error === null ? null : <p className="text-xs text-destructive">{error}</p>}
    </form>
  );
}

function ArmedWatches({ environmentId }: { environmentId: EnvironmentId }) {
  const { data, error } = useTradingWatches(environmentId);
  const cancel = useAtomCommand(orchestrationEnvironment.cancelTradingWatch);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const active = (data?.watches ?? []).filter((watch) => watch.status === "active");

  if (error !== null) return <p className="px-1 text-xs text-destructive">{error}</p>;
  if (active.length === 0) return null;

  return (
    <div className="flex flex-col gap-0.5">
      <h3 className="px-1 text-xs font-medium text-muted-foreground">Armed</h3>
      <ul className="divide-y divide-border/40">
        {active.map((watch) => (
          <li key={watch.id} className="group flex items-center gap-2 px-1 py-1 text-xs">
            <span className="min-w-0 flex-1 truncate text-foreground">
              {describeAccountWatch(watch)}
            </span>
            {watch.rearm?.mode === "repeat" ? (
              <span className="shrink-0 text-muted-foreground">repeats</span>
            ) : null}
            <button
              type="button"
              aria-label="Cancel alert"
              className="shrink-0 rounded-md p-0.5 text-muted-foreground opacity-0 transition-opacity duration-100 group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100"
              onClick={() => {
                setCancelError(null);
                void cancel({ environmentId, input: { watchId: watch.id } }).then((result) => {
                  setCancelError(describeControlFailure(result));
                  refreshTradingWatches(environmentId);
                });
              }}
            >
              <XIcon className="size-3.5" />
            </button>
          </li>
        ))}
      </ul>
      {cancelError === null ? null : <p className="px-1 text-xs text-destructive">{cancelError}</p>}
    </div>
  );
}

/**
 * Raise an OS notification for each alert that arrives after the first read.
 * Desktop-only by feature detection; a web tab has no bridge and skips.
 */
function useDesktopAlertNotifications(
  alerts: ReadonlyArray<Parameters<typeof alertNotificationText>[0]> | null,
): void {
  const seenIdsRef = useRef<ReadonlySet<string> | null>(null);
  useEffect(() => {
    if (alerts === null) return;
    const fresh = selectNewAlerts(alerts, seenIdsRef.current);
    seenIdsRef.current = new Set(alerts.map((alert) => alert.id));
    const notify = window.desktopBridge?.showTradingNotification;
    if (notify === undefined) return;
    for (const alert of fresh) {
      const text = alertNotificationText(alert);
      void notify(text).catch(() => undefined);
    }
  }, [alerts]);
}

export function AlertFeedPanel({ environmentId }: { environmentId: EnvironmentId }) {
  const { data, error, isLoading } = useTradingAlerts(environmentId);
  const alerts = data?.alerts ?? null;
  useDesktopAlertNotifications(alerts);

  return (
    <section aria-label="Alerts" className="flex min-h-0 flex-col gap-2">
      <header className="flex items-center gap-1.5 px-1">
        <BellIcon className="size-3.5 text-muted-foreground" />
        <h2 className="text-sm font-semibold text-foreground">Alerts</h2>
        <button
          type="button"
          className="ml-auto text-[11px] text-muted-foreground hover:text-foreground"
          onClick={() => refreshTradingAlerts(environmentId)}
        >
          refresh
        </button>
      </header>
      <ArmWatchForm environmentId={environmentId} />
      <ArmedWatches environmentId={environmentId} />
      {error !== null ? (
        <p className="px-1 text-sm text-destructive">{error}</p>
      ) : alerts === null || alerts.length === 0 ? (
        <p className="px-1 py-2 text-sm text-muted-foreground">
          {isLoading && alerts === null ? "Loading alerts…" : "Nothing has fired yet."}
        </p>
      ) : (
        <ul className="min-h-0 divide-y divide-border/40 overflow-y-auto">
          {alerts.map((alert) => (
            <li key={alert.id} className="flex flex-col gap-0.5 px-1 py-1.5">
              <span className="text-sm text-foreground">{alert.summary}</span>
              <span className="text-[11px] tabular-nums text-muted-foreground">
                {alert.market.asset} · {new Date(alert.firedAt).toLocaleString()}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
