/**
 * TradingAnalystService — the analyst-thread registry (final-form Phase 8).
 *
 * One analyst thread per `{venue, asset}`, reused: asking about ETH from the
 * chart and again from a position lands in the same conversation. The client
 * mints a candidate thread id and asks `ensureThread`; when the market already
 * has a live analyst thread that one wins and the candidate is discarded
 * (nothing was created yet — it was only an id), otherwise the candidate is
 * registered and the client creates the thread under it.
 *
 * The registry is also what keeps the analyst profile honest across restarts:
 * the session-profile map is in-memory, so the layer replays every registered
 * row into it at boot. Without that, the first post-restart message on an
 * analyst thread would run as an ordinary coding agent with a full toolset.
 *
 * SQL-only on purpose, like `TradingMissionService`: asset validation lives
 * with the callers that already hold the gateway.
 *
 * @module TradingAnalystService
 */
import { ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError, type PersistenceSqlError } from "../persistence/Errors.ts";
import { setSessionProfile } from "../provider/SessionProfile.ts";
import { DEFAULT_TRADING_VENUE } from "./Schemas.ts";

export interface EnsureAnalystThreadInput {
  readonly asset: string;
  /** The client's freshly minted thread id, used only when no live one exists. */
  readonly candidateThreadId: string;
}

export interface EnsureAnalystThreadResult {
  readonly threadId: string;
  /** True when the candidate was registered — the caller must now create the thread. */
  readonly created: boolean;
}

export interface TradingAnalystServiceShape {
  readonly ensureThread: (
    input: EnsureAnalystThreadInput,
  ) => Effect.Effect<EnsureAnalystThreadResult, PersistenceSqlError>;
}

export class TradingAnalystService extends Context.Service<
  TradingAnalystService,
  TradingAnalystServiceShape
>()("t3/trading/TradingAnalystService") {}

const sqlFail = (operation: string) => toPersistenceSqlError(`TradingAnalystService.${operation}`);

const bindProfile = (threadId: string) =>
  Effect.sync(() =>
    setSessionProfile({ threadId: ThreadId.make(threadId), kind: "trading_analyst" }),
  );

const makeTradingAnalystService = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  /**
   * The registered thread for a market, but only while it still exists as a
   * live thread. A registration whose thread was deleted, archived, or never
   * created at all reads as absent and is replaced by the next ensure.
   */
  const findLiveThread = (asset: string) =>
    sql<{ readonly thread_id: string }>`
      SELECT a.thread_id
      FROM trading_analyst_threads a
      JOIN projection_threads t ON t.thread_id = a.thread_id
      WHERE a.venue = ${DEFAULT_TRADING_VENUE} AND a.asset = ${asset}
        AND t.deleted_at IS NULL AND t.archived_at IS NULL
    `.pipe(
      Effect.mapError(sqlFail("findLiveThread")),
      Effect.map((rows) => rows[0]?.thread_id ?? null),
    );

  const ensureThread: TradingAnalystServiceShape["ensureThread"] = (input) =>
    Effect.gen(function* () {
      const existing = yield* findLiveThread(input.asset);
      if (existing !== null) {
        // Re-binding an already-bound thread is a no-op; doing it here keeps
        // the profile correct even when the boot replay predates this row.
        yield* bindProfile(existing);
        return { threadId: existing, created: false };
      }

      const now = yield* Clock.currentTimeMillis;
      yield* sql`
        INSERT INTO trading_analyst_threads (venue, asset, thread_id, created_at)
        VALUES (${DEFAULT_TRADING_VENUE}, ${input.asset}, ${input.candidateThreadId}, ${now})
        ON CONFLICT (venue, asset) DO UPDATE SET
          thread_id = excluded.thread_id,
          created_at = excluded.created_at
      `.pipe(Effect.mapError(sqlFail("ensureThread")));

      yield* bindProfile(input.candidateThreadId);
      return { threadId: input.candidateThreadId, created: true };
    });

  // Boot replay: every registered analyst thread gets its profile back before
  // any message can reach it. Rows whose thread is gone are harmless here —
  // a profile on a dead thread binds nothing — and are replaced on next use.
  const rows = yield* sql<{ readonly thread_id: string }>`
    SELECT thread_id FROM trading_analyst_threads
  `.pipe(
    Effect.mapError(sqlFail("bootReplay")),
    Effect.catch((error) =>
      Effect.logWarning("TradingAnalystService: could not replay analyst profiles", {
        error: String(error),
      }).pipe(Effect.as([] as ReadonlyArray<{ readonly thread_id: string }>)),
    ),
  );
  yield* Effect.forEach(rows, (row) => bindProfile(row.thread_id));

  return { ensureThread } satisfies TradingAnalystServiceShape;
});

export const TradingAnalystServiceLive = Layer.effect(
  TradingAnalystService,
  makeTradingAnalystService,
);
