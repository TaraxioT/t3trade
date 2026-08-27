/**
 * Pure derivations for the trade home (final-form Phase 4).
 *
 * Kept out of the components for the same reason `tradingPresentation` is: a
 * label the panel shows is a claim about server state, and claims are easier
 * to pin in a test than a render tree.
 *
 * @module tradeHomePresentation
 */
import type {
  TradingAccountPosition,
  TradingArchiveHealth,
  TradingAlertEvent,
} from "@t3tools/contracts";

/**
 * How long a heartbeat may be quiet before "recording" stops being an honest
 * word for it. The archiver heartbeats every poll loop (seconds apart), so two
 * minutes of silence is a stall, not jitter.
 */
export const ARCHIVE_HEARTBEAT_STALE_MILLIS = 2 * 60_000;

/**
 * The archiver-health one-liner — the Phase 2.4 surface.
 *
 * Null while the archiver is demonstrably fine (running, heartbeat fresh):
 * the healthy state is the absence of the line, following the staleness
 * banner's rule that a banner on a cycle teaches people to ignore banners.
 */
export function describeArchiveHealth(
  archive: TradingArchiveHealth | undefined,
  nowMillis: number,
): string | null {
  if (archive === undefined) {
    // An older server that does not report health. Saying "stopped" would be
    // a guess; saying nothing is the only honest line.
    return null;
  }
  if (!archive.running) {
    const reason = archive.stoppedReason === null ? "" : ` — ${archive.stoppedReason}`;
    return `Market recording is stopped${reason}. Charts and derived metrics will refuse rather than serve stale data.`;
  }
  if (archive.lastHeartbeatAt !== null) {
    const quietMillis = nowMillis - Date.parse(archive.lastHeartbeatAt);
    if (quietMillis > ARCHIVE_HEARTBEAT_STALE_MILLIS) {
      const minutes = Math.max(1, Math.round(quietMillis / 60_000));
      return `Market recording has not heartbeat for ${minutes} min.`;
    }
  }
  if (archive.restarts > 0) {
    return `Market recording is running (restarted ${archive.restarts}× since boot).`;
  }
  return null;
}

/**
 * The D5 provenance label. "Unprotected" is a state, not an absence — a
 * position with no stop is exactly the thing this column exists to surface.
 */
export function describeProtection(position: TradingAccountPosition): string {
  if (position.protectedSize === 0 || position.protection === null) return "Unprotected";
  return position.protection === "resting_on_exchange" ? "Stop on exchange" : "Server-executed";
}

/**
 * Which alerts in a fresh read were not in the previous one, oldest first —
 * what the desktop notification path fires for.
 *
 * Keyed by id rather than by count so a feed that hit its window cap still
 * reports the new arrivals. `previousIds === null` means "first read": nothing
 * is new, because notifying the whole backlog on mount would ring fifty times
 * for history the user already lived through.
 */
export function selectNewAlerts(
  alerts: ReadonlyArray<TradingAlertEvent>,
  previousIds: ReadonlySet<string> | null,
): ReadonlyArray<TradingAlertEvent> {
  if (previousIds === null) return [];
  // The feed is newest-first; reverse so notifications fire in firing order.
  return alerts.filter((alert) => !previousIds.has(alert.id)).toReversed();
}

/** One OS-notification body for a fired alert. */
export function alertNotificationText(alert: TradingAlertEvent): {
  readonly title: string;
  readonly body: string;
} {
  return {
    title: `${alert.market.asset} alert`,
    body: alert.summary,
  };
}
