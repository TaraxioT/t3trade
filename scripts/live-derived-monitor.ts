/**
 * Plan 38 Phase 3 live-soak monitor. Every 60s appends a timestamped line per
 * watch (status, last_observed_value, baseline_signature, next_evaluate_at)
 * plus any trading_harness_runs for the soak mission, to artifacts/investigations/live-derived-soak.md.
 * Read-only DB access (mode=ro URI).
 *
 * Run: bun scripts/live-derived-monitor.ts <missionId>
 */
const MISSION_ID = process.argv[2];
const REPORT = "/Users/george/Workspace/t3trade/artifacts/investigations/live-derived-soak.md";
if (!MISSION_ID) throw new Error("usage: bun scripts/live-derived-monitor.ts <missionId>");

const { Database } = require("bun:sqlite");
const fs = require("node:fs");
const db = new Database(`file:/Users/george/Workspace/t3trade/.t3/userdata/state.sqlite?mode=ro`, {
  readonly: true,
});

let lastRunCount = -1;
function tick() {
  const now = new Date().toISOString();
  const watches = db
    .query(
      "SELECT watch_id, status, last_observed_value, baseline_signature, next_evaluate_at FROM trading_watches WHERE mission_id = ?",
    )
    .all(MISSION_ID);
  let line = `\n[monitor ${now}] mission ${MISSION_ID}\n`;
  for (const w of watches as any[]) {
    line += `  watch ${w.watch_id.slice(0, 8)} status=${w.status} observed=${w.last_observed_value} baseline=${w.baseline_signature} next_eval=${w.next_evaluate_at ? new Date(w.next_evaluate_at).toISOString() : null}\n`;
  }
  const runs = db
    .query(
      "SELECT run_id, cause, outcome, started_at FROM trading_harness_runs WHERE mission_id = ? ORDER BY started_at",
    )
    .all(MISSION_ID) as any[];
  if (runs.length !== lastRunCount && lastRunCount !== -1) {
    for (const r of runs.slice(lastRunCount)) {
      line += `  HARNESS RUN ${r.run_id} cause=${r.cause} outcome=${r.outcome}\n`;
    }
  }
  lastRunCount = runs.length;
  fs.appendFileSync(REPORT, line);
  console.log(line.trim());
}
tick();
setInterval(tick, 60_000);
