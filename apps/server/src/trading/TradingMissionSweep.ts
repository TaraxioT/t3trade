/**
 * TradingMissionSweep - the boot-time revocation of missions with no thread left.
 *
 * An orphan is a mission whose thread was deleted out from under it while the
 * server was down. Nothing can wake it, nothing can settle it, no surface can
 * ever show it, and it holds authority over its market forever. The sweep
 * withdraws that authority.
 *
 * It does not delete. An earlier version did, and read orphanhood off
 * `projection_threads` — so the first projection rebuild made every live
 * mission look orphaned and the boot sweep erased a running soak. Mission rows
 * are the permanent record of what was traded (plan 27 H1); revoking frees the
 * market without destroying the record, and is safe even if the orphan test is
 * ever wrong again.
 *
 * A mission still holding a position is left alone entirely: revoking it would
 * leave real exposure that nobody is authorized to manage. Live deletion goes
 * through the reactor's close-then-revoke path instead; this sweep only picks
 * up what happened while the process was not running, and an orphan with
 * exposure is reported rather than touched.
 *
 * Runs at boot. Kept rather than made a one-off migration because it is
 * idempotent and cheap: on a clean database it finds nothing.
 *
 * @module TradingMissionSweep
 */
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { TradingMissionService } from "./TradingMissionService.ts";
import { TradingRuntimeLease } from "./TradingRuntimeLease.ts";

/**
 * Whether the mission still has exposure on the exchange, per the reconciled
 * snapshot. Authority is never withdrawn while this is true: doing so would
 * leave real money with nobody authorized to close it.
 */
const holdsPosition = (missionId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly open_count: number }>`
      SELECT COUNT(*) AS open_count FROM trading_position_snapshots
      WHERE mission_id = ${missionId} AND size != 0
    `;
    return (rows[0]?.open_count ?? 0) > 0;
  });

export const revokeOrphanedMissions = Effect.gen(function* () {
  // The sweep only runs while this process holds the trading lease: a second
  // runtime against the same database would otherwise revoke the same
  // missions the live holder still believes in.
  const lease = yield* TradingRuntimeLease;
  if (!lease.held) {
    yield* Effect.logWarning(
      "TradingMissionSweep: trading lease not held - skipping the boot sweep",
    );
    return;
  }
  const missions = yield* TradingMissionService;
  const candidates = yield* missions.listOrphanedMissions();
  if (candidates.length === 0) return;

  let revoked = 0;
  const stranded: Array<string> = [];
  for (const candidate of candidates) {
    if (yield* holdsPosition(candidate.missionId)) {
      stranded.push(candidate.missionId);
      continue;
    }
    const expectedVersion = yield* missions.getMissionVersion(candidate.missionId);
    yield* missions.transition({
      missionId: candidate.missionId,
      to: "revoked",
      expectedVersion,
    });
    revoked += 1;
  }

  yield* Effect.logInfo("TradingMissionSweep: revoked orphaned missions", {
    revoked,
    strandedHoldingPosition: stranded,
  });
});

/**
 * Runs the sweep once at layer build. A failure is logged rather than fatal:
 * housekeeping must never stop the server booting.
 */
export const TradingMissionSweepLive: Layer.Layer<
  never,
  never,
  SqlClient.SqlClient | TradingMissionService | TradingRuntimeLease
> = Layer.effectDiscard(
  revokeOrphanedMissions.pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("TradingMissionSweep: could not revoke orphaned missions", {
        cause: Cause.pretty(cause),
      }),
    ),
  ),
);
