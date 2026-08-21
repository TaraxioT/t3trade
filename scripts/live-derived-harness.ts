/**
 * Plan 38 Phase 3 §6 item 5 — HARNESS-LEVEL live verification driver.
 *
 * The dev server's orchestration command queue never drained in this run
 * (zero decideOrchestrationCommand spans after boot), so mission-level arming
 * via the WS dispatchCommand RPC hangs. This script drives the REAL
 * WatchEvaluator (the same sweep the server runs, at the real 2s sweep cadence
 * stepped here every 60s) and the REAL TradingWakeupComposer against the REAL
 * market archive (worktree snapshot of the live archive, kept current by the
 * worktree archiver), with state in the worktree .t3.
 *
 * OrchestrationEngineService is stubbed to a recorder. When a watch fires, the
 * main loop (not the stub, to avoid circular service deps) composes the wake
 * with the real composer and appends the rendered text to the report file.
 *
 * Run: T3CODE_HOME=/Users/george/Workspace/t3trade/.t3 node scripts/live-derived-harness.ts
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeFS from "node:fs";

import { toMarketWatch } from "../packages/trading-contracts/src/watch.ts";
import { runMigrations } from "../apps/server/src/persistence/Migrations.ts";
import * as NodeSqliteClient from "../apps/server/src/persistence/NodeSqliteClient.ts";
import { OrchestrationEngineService } from "../apps/server/src/orchestration/Services/OrchestrationEngine.ts";
import { TradingLayerLive } from "../apps/server/src/trading/runtimeLayer.ts";
import { TradingLeaseTarget } from "../apps/server/src/trading/TradingRuntimeLease.ts";
import { TradingEventInbox } from "../apps/server/src/trading/TradingEventInbox.ts";
import { TradingMissionService } from "../apps/server/src/trading/TradingMissionService.ts";
import { TradingWakeupComposer } from "../apps/server/src/trading/TradingWakeupComposer.ts";
import { TradingWatchService } from "../apps/server/src/trading/TradingWatchService.ts";
import { WatchEvaluator, WatchEvaluatorLive } from "../apps/server/src/trading/WatchEvaluator.ts";

const REPORT = "/Users/george/Workspace/t3trade/artifacts/investigations/live-derived-soak.md";
// The state database this harness shares with the server. The trading layer
// takes the single-writer lease scoped to this path, so a harness boot and a
// server boot can never both run trading housekeeping against it silently:
// whoever boots second refuses and says so.
const STATE_DB = "/Users/george/Workspace/t3trade/.t3/userdata/state.sqlite";
const THREAD_ID = globalThis.crypto.randomUUID();
const HARNESS = {
  provider: "codex",
  providerInstanceId: "live-derived-soak",
  threadId: THREAD_ID,
  status: "available" as const,
};
const ETH_CROSS = {
  kind: "derived" as const,
  market: "ETH" as const,
  metric: "funding_mean" as const,
  params: { metric: "funding_mean" as const, windowDays: 7 },
  direction: "below" as const,
  value: 0,
  mode: "cross" as const,
};
const BTC_FLIP = {
  kind: "derived" as const,
  market: "BTC" as const,
  metric: "funding_sign_flip" as const,
  params: { metric: "funding_sign_flip" as const, windowDays: 1 },
};
// The two §3.4 examples only fire on a real funding crossing, which the live
// series may not produce for days. This third watch reads a genuinely
// oscillating archive series (ETH book depth ratio, sampled ~1/min, seen
// swinging 0.5 → 6 within minutes) so the fire path — one wake, the observed
// value on the `triggered` line — is verified against live data in the same
// run. The crossing is real; only the threshold is chosen to be near it.
const ETH_DEPTH = {
  kind: "derived" as const,
  market: "ETH" as const,
  metric: "depth_ratio" as const,
  params: { metric: "depth_ratio" as const, windowMinutes: 5 },
  direction: "above" as const,
  value: 2,
  mode: "cross" as const,
};
/** The project the soak thread row is filed under, so surfaces can find it. */
const PROJECT_ID = "b2406278-faf6-4113-ab76-2cca20e0b89d";

const log = (...args: unknown[]) => console.log(new Date().toISOString(), ...args);
const appendReport = (text: string) => Effect.sync(() => NodeFS.appendFileSync(REPORT, text));

/** Commands the stubbed engine received (watch-fired announcements). */
const firedCommands: Array<Record<string, unknown>> = [];

const engineStubLayer = Layer.succeed(OrchestrationEngineService, {
  dispatch: (command: never) =>
    Effect.sync(() => {
      firedCommands.push(command as Record<string, unknown>);
      NodeFS.appendFileSync(
        REPORT,
        `\n## WATCH-FIRED DISPATCH ${new Date().toISOString()}\n\n\`\`\`json\n${JSON.stringify(command, null, 2)}\n\`\`\`\n`,
      );
      return { sequence: 0 };
    }),
} as never);

const sqlLayer = NodeSqliteClient.layer({
  filename: STATE_DB,
});

// Mirrors runtimeLayer.ts's provisioning: mergeAll members do not see each
// other's services in Effect v4, so dependents get explicit provideMerge.
// Mirrors the server's own stack (server.ts ReactorLayerLive): the evaluator's
// requirements are satisfied by merging TradingLayerLive beneath it.
const mainLayer = Layer.empty
  .pipe(Layer.provideMerge(WatchEvaluatorLive))
  .pipe(Layer.provideMerge(engineStubLayer))
  .pipe(Layer.provideMerge(TradingLayerLive))
  .pipe(Layer.provide(Layer.succeed(TradingLeaseTarget, { dbPath: STATE_DB })))
  .pipe(Layer.provide(sqlLayer))
  .pipe(Layer.provide(NodeServices.layer))
  .pipe(Layer.provide(engineStubLayer));

const program = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 73 });
  const missions = yield* TradingMissionService;
  const watches = yield* TradingWatchService;
  const evaluator = yield* WatchEvaluator;
  const inbox = yield* TradingEventInbox;
  const composer = yield* TradingWakeupComposer;

  // A mission whose threadId has no projection_threads row is an ORPHAN, and
  // TradingMissionSweep purges orphans at every trading-layer boot — any other
  // process starting the layer would delete this soak mid-run (it did once).
  // Seeding the thread row is what makes the soak survive its neighbours.
  const nowIso = new Date().toISOString();
  yield* sql`
    INSERT INTO projection_threads
      (thread_id, project_id, title, created_at, updated_at)
    VALUES
      (${THREAD_ID}, ${PROJECT_ID}, 'Plan 38 derived-watch live soak', ${nowIso}, ${nowIso})
  `;

  // -- create the mission (service-level; the orchestration event stream is
  // the one piece this harness bypasses — hence the harness-level label) -----
  const missionId = globalThis.crypto.randomUUID();
  const mission = yield* missions.createMission({
    missionId,
    userId: "local", // findActiveMission("local") is how the sweep resolves the mission
    tradingAccountId: "local-hyperliquid-testnet",
    instruction: [
      "Stand-aside watch mission for derived-metric verification (plan 38 phase 3 §6 item 5).",
      "Hold no position and place no orders. Two derived watches are armed",
      "deterministically: ETH funding_mean 7d cross below 0, and BTC",
      "funding_sign_flip 1d. When one fires, note the observed value and keep",
      "standing aside. Do not cancel or re-arm the derived watches.",
    ].join(" "),
    allocatedCapitalUsd: 100,
    harness: HARNESS,
  } as never);
  // The evaluator only tracks watches of a mission in an ACTIVE status; the
  // server's reactor does this transition on the mission_created bootstrap run.
  const version = yield* missions.getMissionVersion(missionId);
  const active = yield* missions.transition({
    missionId,
    to: "analysing",
    expectedVersion: version,
  } as never);
  log("mission transitioned", missionId, "status", (active as { status?: string }).status);
  log(
    "mission created",
    (mission as { id?: string }).id ?? missionId,
    "status",
    (mission as { status?: string }).status,
  );

  // -- arm the two watches deterministically ----------------------------------
  const ethWatch = yield* watches.registerWatch({
    missionId,
    watch: toMarketWatch(ETH_CROSS) as never,
    armedReason: "wake_retry", // valid enum; arming is deterministic from this script
  } as never);
  log("ETH watch", ethWatch.watch.id, JSON.stringify(ETH_CROSS));
  const btcWatch = yield* watches.registerWatch({
    missionId,
    watch: toMarketWatch(BTC_FLIP) as never,
    armedReason: "wake_retry", // valid enum; arming is deterministic from this script
  } as never);
  log("BTC watch", btcWatch.watch.id, JSON.stringify(BTC_FLIP));
  const depthWatch = yield* watches.registerWatch({
    missionId,
    watch: toMarketWatch(ETH_DEPTH) as never,
    armedReason: "wake_retry", // valid enum; arming is deterministic from this script
  } as never);
  log("ETH depth watch", depthWatch.watch.id, JSON.stringify(ETH_DEPTH));

  // -- first sweep: evaluates watches with NULL next_evaluate_at --------------
  yield* evaluator.sweep;
  yield* evaluator.drain;

  const readRows = () =>
    sql`
      SELECT watch_id, status, last_observed_value, last_evaluated_at, next_evaluate_at, watch_json
      FROM trading_watches WHERE mission_id = ${missionId}
    ` as unknown as Effect.Effect<ReadonlyArray<Record<string, unknown>>, never, never>;

  let rows = (yield* readRows()) as any[];
  for (const row of rows) {
    log(
      "WATCH ROW",
      JSON.stringify({
        watch_id: row.watch_id,
        status: row.status,
        last_observed_value: row.last_observed_value,
        last_evaluated_at: row.last_evaluated_at,
        next_evaluate_at: row.next_evaluate_at,
        watch_json:
          typeof row.watch_json === "string" ? JSON.parse(row.watch_json) : row.watch_json,
      }),
    );
  }
  yield* appendReport(
    `\n## HARNESS START ${new Date().toISOString()} (HARNESS-LEVEL: real WatchEvaluator + real TradingWakeupComposer + real archive; orchestration stream stubbed)\n\n` +
      `- missionId: ${missionId}\n- threadId: ${THREAD_ID}\n- ETH watch: ${ethWatch.watch.id}\n- BTC watch: ${btcWatch.watch.id}\n- ETH depth watch: ${depthWatch.watch.id}\n\n` +
      `Initial rows after first sweep:\n\n\`\`\`json\n${JSON.stringify(rows, null, 2)}\n\`\`\`\n`,
  );

  // -- sweep loop: real cadence. Funding watches self-schedule at 30 min via
  // next_evaluate_at; the sweep itself is stepped every 60s like the server. --
  yield* Effect.gen(function* () {
    let lastFiredHandled = 0;
    yield* Effect.forever(
      Effect.gen(function* () {
        yield* evaluator.sweep.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("sweep failed", { cause: String(cause).slice(0, 800) }),
          ),
        );
        yield* evaluator.drain;

        // Compose the real wake text for any firing the evaluator announced.
        for (const command of firedCommands.slice(lastFiredHandled)) {
          lastFiredHandled = firedCommands.length;
          const fired = command as { missionId?: string; watchId?: string };
          if (fired.missionId !== missionId || fired.watchId === undefined) continue;
          const firedMission = yield* missions.getMission(fired.missionId).pipe(Effect.orDie);
          const pending = yield* inbox.peekPending(fired.missionId, 10);
          const composed = yield* composer
            .compose({
              mission: firedMission,
              harnessRunId: globalThis.crypto.randomUUID(),
              cause: "market_watch_triggered",
              occurredAt: Date.now(),
              triggeringWatchId: fired.watchId,
              pendingEvents: pending as never,
            })
            .pipe(
              Effect.catchCause((cause) =>
                appendReport(
                  `\n### compose failed\n\n\`\`\`\n${String(cause).slice(0, 2000)}\n\`\`\`\n`,
                ).pipe(Effect.as(null)),
              ),
            );
          if (composed !== null) {
            yield* appendReport(
              `\n### COMPOSED WAKE (rendered text)\n\n\`\`\`\n${composed.text}\n\`\`\`\n`,
            );
          }
        }

        rows = (yield* readRows()) as any[];
        yield* appendReport(
          `\n--- sweep ${new Date().toISOString()}\n${JSON.stringify(
            rows.map((r) => ({
              watch_id: r.watch_id,
              status: r.status,
              last_observed_value: r.last_observed_value,
              next_evaluate_at: r.next_evaluate_at,
            })),
          )}\n`,
        );
        yield* Effect.sleep("60 seconds");
      }),
    );
  });
}).pipe(
  Effect.scoped,
  Effect.provide(mainLayer),
  Effect.provide(sqlLayer),
  Effect.provide(NodeServices.layer),
  Effect.provide(engineStubLayer),
);

await Effect.runPromise(program).catch((e) => {
  console.error("HARNESS FAILED", (e && e.stack) || e);
  process.exit(1);
});
