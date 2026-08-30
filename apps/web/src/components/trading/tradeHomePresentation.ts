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
 * The archiver-health one-liner, rendered from the server's own typed status.
 *
 * `owned-writer` is the only silent state, on the same doctrine as ever: a
 * banner on a healthy cycle teaches people to ignore banners. Every other
 * state says what it is in one plain line, because the reader's next action
 * differs by state (wait, restart, or distrust derived numbers) and a status
 * the reader has to infer is a status they will infer wrong.
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
  const reason = archive.stoppedReason === null ? "" : ` — ${archive.stoppedReason}`;
  switch (archive.status) {
    case undefined:
      // An older server that does not report the typed status. Saying
      // anything would be a guess; saying nothing is the only honest line.
      return null;
    case "owned-writer":
      // The healthy state is the absence of the line: a banner on a healthy
      // cycle teaches people to ignore banners.
      return null;
    case "healthy-external-writer": {
      // Never "recording stopped": another T3 Trade process is recording
      // this archive right now, and this server reads it safely (read-only
      // snapshots of a WAL database the live writer keeps coherent).
      const who = !archive.externalWriter ? "" : ` (pid ${archive.externalWriter.pid})`;
      return (
        `Recorded by another T3 Trade process${who}. Charts and studies read its archive.` +
        " If this is unexpected in development, two servers share one state directory: return to the already-running environment, or restart this one with isolated state."
      );
    }
    case "restarting":
      return `Market recording is restarting${archive.restarts > 0 ? ` (restart ${archive.restarts} since boot)` : ""}.`;
    case "stopped":
      // Fresh bars stop arriving; the recorded history stays readable with
      // its own coverage and gap labels. The old line claimed reads would
      // refuse, which was never what the reads did.
      return `Market recording is stopped${reason}. New bars are not being collected; recorded history stays readable with its coverage shown.`;
    case "stale": {
      const minutes =
        archive.lastHeartbeatAt === null
          ? null
          : Math.max(1, Math.round((nowMillis - Date.parse(archive.lastHeartbeatAt)) / 60_000));
      return minutes === null
        ? "Market recording claims to run but has not had a heartbeat. Treat derived numbers as stale."
        : `Market recording has not had a heartbeat for ${minutes} min. Treat derived numbers as stale.`;
    }
    case "unavailable":
      // The server could not verify who owns the writer lease; its reads
      // are refusing, and the line says that rather than guessing a cause.
      return "Recording ownership cannot be verified, so charts and studies are refusing rather than guessing. Restarting this environment after closing any other T3 Trade instance on this machine resolves it.";
  }
}

/**
 * The one line that says this environment cannot sign, and what that does and
 * does not cost.
 *
 * Null when a signer is armed, and null when the server does not report the
 * field at all, every server that predates it had one. Deliberately not a
 * modal, not a nag, and not an onboarding flow: research mode is a working
 * state, and the only thing a user needs is to know it before an order is
 * refused rather than after.
 */
export const RESEARCH_MODE_LINE =
  "Research mode: no trading key is configured. Observation, backtests and validations work; " +
  "orders will be refused.";

export function describeSignerState(signerArmed: boolean | undefined): string | null {
  return signerArmed === false ? RESEARCH_MODE_LINE : null;
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
