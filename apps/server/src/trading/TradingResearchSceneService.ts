/**
 * TradingResearchSceneService: the durable record of what a thread's graph
 * is showing.
 *
 * ## It cannot place an order
 *
 * The same claim the hypothesis and event services make, made the same way:
 * this depends on `SqlClient` and `Crypto` and nothing else. It writes one
 * table, `trading_research_scenes`, that no projection reporting real money
 * reads. A scene is research output rendered as a picture; publishing one
 * arms nothing, validates nothing, and trades nothing.
 *
 * ## The service stores, the handler computes
 *
 * Every number inside a payload arrived from the deterministic engines
 * (`runEventStudy`, the backtest service) before this service ever saw it.
 * This file does no math and no archive reads: it validates the document's
 * shape, persists it, decodes it back, and enforces the two house rules of
 * scoping: a scene belongs to one thread forever, and a thread holds at most
 * a handful, with the oldest evicted when a new publish crosses the cap.
 *
 * @module TradingResearchSceneService
 */
import { Context, Effect, Schema } from "effect";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  AnnotationScenePayload,
  composeEventStudyScene,
  EventStudyScenePayload,
  RESEARCH_DISCLAIMER,
  RESEARCH_SCENES_MAX_PER_THREAD,
  ResearchSceneKind,
  ResearchSceneStatus,
  ResearchSceneView,
  SCENE_MAX_JSON_CHARS,
  StrategyReplayScenePayload,
  validateTradingChartScene,
} from "@t3tools/trading-contracts/researchScenes";
import { UnixMillis } from "@t3tools/trading-contracts/primitives";

import { toPersistenceSqlError, type PersistenceSqlError } from "../persistence/Errors.ts";

/** What one publish hands the service, already computed by the engines. */
export interface ResearchSceneWrite {
  readonly threadId: string;
  readonly kind: ResearchSceneKind;
  readonly title: string;
  readonly market: string | null;
  readonly interval: string | null;
  readonly calculationVersion: string;
  readonly payload:
    | { readonly kind: "eventStudy"; readonly document: EventStudyScenePayload }
    | { readonly kind: "strategyReplay"; readonly document: StrategyReplayScenePayload }
    | { readonly kind: "annotation"; readonly document: AnnotationScenePayload };
  readonly now: number;
}

export type ResearchSceneWriteResult =
  | { readonly outcome: "ok"; readonly scene: ResearchSceneView }
  | { readonly outcome: "refused"; readonly reason: string };

export interface TradingResearchSceneServiceShape {
  /** Persist one scene, evicting the thread's oldest past the cap. */
  readonly publish: (
    input: ResearchSceneWrite,
  ) => Effect.Effect<ResearchSceneWriteResult, PersistenceSqlError>;
  /** One scene by id. Null when the id names nothing. */
  readonly show: (sceneId: string) => Effect.Effect<ResearchSceneView | null, PersistenceSqlError>;
  /** A thread's scenes, newest first. */
  readonly list: (
    threadId: string,
  ) => Effect.Effect<ReadonlyArray<ResearchSceneView>, PersistenceSqlError>;
  /** Clear one scene, or a thread's whole scene list. Returns rows removed. */
  readonly clear: (input: {
    readonly threadId: string;
    readonly sceneId?: string | undefined;
  }) => Effect.Effect<number, PersistenceSqlError>;
}

export class TradingResearchSceneService extends Context.Service<
  TradingResearchSceneService,
  TradingResearchSceneServiceShape
>()("t3/trading/TradingResearchSceneService") {}

/**
 * Compose and attach each view's deterministic layers, and say whether the
 * recipe's references still resolve.
 *
 * The graph renders the scene the SERVER composes from the recorded payload:
 * the model never writes layers, and the graph never re-derives numbers. That
 * only holds if every read path decorates the same way — the publish and show
 * tool results AND the graph's polling read — so the one implementation lives
 * here and takes the event-set lookup as a function, keeping this module's
 * SqlClient-plus-Crypto doctrine while every caller hands it the same service.
 *
 * A composed scene the caps refuse is served without its `scene` (the numbers
 * stay honest) rather than dropping the whole view.
 */
export const composeSceneViews = (input: {
  readonly views: ReadonlyArray<ResearchSceneView>;
  readonly showEventSet: (
    eventSetId: string,
  ) => Effect.Effect<{ readonly retiredAt: number | null } | null>;
}): Effect.Effect<ReadonlyArray<ResearchSceneView>> =>
  Effect.forEach(input.views, (view) => {
    const eventStudy = view.eventStudy;
    if (eventStudy === undefined) return Effect.succeed(view);
    return Effect.gen(function* () {
      const set = yield* input.showEventSet(eventStudy.eventSetId);
      const composed = { ...composeEventStudyScene(eventStudy), sceneId: view.sceneId };
      const invalid = validateTradingChartScene(composed);
      return {
        ...view,
        referenceStatus:
          set === null
            ? ("retired" as const)
            : set.retiredAt === null
              ? ("ok" as const)
              : ("retired" as const),
        ...(invalid === null ? { scene: composed } : {}),
      };
    });
  });

interface SceneRow {
  readonly scene_id: string;
  readonly status: string;
  readonly thread_id: string;
  readonly kind: string;
  readonly title: string;
  readonly market: string | null;
  readonly interval: string | null;
  readonly payload: string;
  readonly calculation_version: string;
  readonly created_at: number;
  readonly updated_at: number;
}

const payloadFromJsonString = Schema.fromJsonString(Schema.Unknown);
const decodePayload = Schema.decodeUnknownSync(payloadFromJsonString);
const encodePayload = Schema.encodeSync(payloadFromJsonString);
const decodeEventStudy = Schema.decodeUnknownSync(EventStudyScenePayload);
const decodeStrategyReplay = Schema.decodeUnknownSync(StrategyReplayScenePayload);
const decodeAnnotation = Schema.decodeUnknownSync(AnnotationScenePayload);

/**
 * Row to view. A payload that no longer decodes (a scene written by an older
 * calculation whose schema moved) is skipped rather than fatal: the list
 * answers with the scenes it can still render, and the row's time on the
 * graph simply ends.
 */
const rowToView = (row: SceneRow): ResearchSceneView | null => {
  const base = {
    sceneId: row.scene_id,
    // The lifecycle word rides every view so no reader has to infer it from
    // absence: an old study is superseded, a cleared one says cleared.
    status: (["active", "superseded", "cleared"] as const).includes(
      row.status as ResearchSceneStatus,
    )
      ? (row.status as ResearchSceneStatus)
      : "superseded",
    // Storage cannot resolve external recipe references on its own. Readers
    // that also hold the event service replace this with ok or retired.
    referenceStatus: "unknown" as const,
    threadId: row.thread_id,
    kind: row.kind as ResearchSceneView["kind"],
    title: row.title,
    createdAt: row.created_at as UnixMillis,
    updatedAt: row.updated_at as UnixMillis,
    calculationVersion: row.calculation_version,
    disclaimer: RESEARCH_DISCLAIMER as typeof RESEARCH_DISCLAIMER,
  };
  let parsed: unknown;
  try {
    parsed = decodePayload(row.payload);
  } catch {
    return null;
  }
  if (row.kind === "event_study") {
    try {
      return { ...base, eventStudy: decodeEventStudy(parsed) };
    } catch {
      return null;
    }
  }
  if (row.kind === "strategy_replay") {
    try {
      return { ...base, strategyReplay: decodeStrategyReplay(parsed) };
    } catch {
      return null;
    }
  }
  if (row.kind === "annotated_market") {
    try {
      return { ...base, annotation: decodeAnnotation(parsed) };
    } catch {
      return null;
    }
  }
  return null;
};

export const makeTradingResearchSceneService = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;

  const sqlFail = (operation: string) =>
    toPersistenceSqlError(`TradingResearchSceneService.${operation}`);

  const publish: TradingResearchSceneServiceShape["publish"] = (input) =>
    Effect.gen(function* () {
      const sceneId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
      // The serialized document is checked against the payload cap before
      // any write: an oversized or invalid artifact is refused, not stored.
      const document = encodePayload(input.payload.document as unknown);
      if (document.length > SCENE_MAX_JSON_CHARS) {
        return {
          outcome: "refused",
          reason:
            `the scene is ${document.length} characters serialized, over the ` +
            `${SCENE_MAX_JSON_CHARS} a scene may occupy; narrow the study and publish again`,
        } as const;
      }
      // One transaction around supersession, insert, and history pruning: a
      // publish either lands as the one active scene for its thread and
      // market with the previous one honestly superseded, or nothing changes.
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`
              UPDATE trading_research_scenes
              SET status = 'superseded', updated_at = ${input.now}
              WHERE thread_id = ${input.threadId}
                AND market = ${input.market}
                AND status = 'active'
            `.pipe(Effect.mapError(sqlFail("publish.supersede")));
            yield* sql`
              INSERT INTO trading_research_scenes (
                scene_id, thread_id, kind, status, title, market, interval,
                payload, calculation_version, created_at, updated_at
              ) VALUES (
                ${sceneId}, ${input.threadId}, ${input.kind}, 'active', ${input.title},
                ${input.market}, ${input.interval},
                ${document}, ${input.calculationVersion},
                ${input.now}, ${input.now}
              )
            `.pipe(Effect.mapError(sqlFail("publish.insert")));
            // The history cap counts every row; only superseded or cleared
            // rows are ever pruned, oldest first, and never the row just
            // written. Active scenes are untouchable here by construction
            // (one per market, and this one is fresh).
            const held = yield* sql<{ readonly n: number }>`
              SELECT COUNT(*) AS n FROM trading_research_scenes
              WHERE thread_id = ${input.threadId}
            `.pipe(Effect.mapError(sqlFail("publish.count")));
            const overflow = Number(held[0]?.n ?? 0) - RESEARCH_SCENES_MAX_PER_THREAD;
            if (overflow > 0) {
              yield* sql`
                DELETE FROM trading_research_scenes
                WHERE scene_id IN (
                  SELECT scene_id FROM trading_research_scenes
                  WHERE thread_id = ${input.threadId}
                    AND status != 'active'
                    AND scene_id != ${sceneId}
                  ORDER BY updated_at ASC
                  LIMIT ${overflow}
                )
              `.pipe(Effect.mapError(sqlFail("publish.prune")));
            }
          }),
        )
        .pipe(Effect.mapError(sqlFail("publish.transaction")));

      const scene = yield* show(sceneId);
      return scene === null
        ? ({
            outcome: "refused",
            reason: "the scene was written but could not be read back; nothing is on the graph",
          } as const)
        : ({ outcome: "ok", scene } as const);
    });

  const show: TradingResearchSceneServiceShape["show"] = (sceneId) =>
    sql<SceneRow>`
      SELECT * FROM trading_research_scenes WHERE scene_id = ${sceneId}
    `.pipe(
      Effect.mapError(sqlFail("show")),
      Effect.map((rows) => {
        const row = rows[0];
        return row === undefined ? null : rowToView(row);
      }),
    );

  const list: TradingResearchSceneServiceShape["list"] = (threadId) =>
    sql<SceneRow>`
      SELECT * FROM trading_research_scenes
      WHERE thread_id = ${threadId}
      ORDER BY updated_at DESC
    `.pipe(
      Effect.mapError(sqlFail("list")),
      Effect.map((rows) =>
        rows.flatMap((row) => {
          const view = rowToView(row);
          return view === null ? [] : [view];
        }),
      ),
    );

  const clear: TradingResearchSceneServiceShape["clear"] = ({ threadId, sceneId }) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      // Clearing is a presentation state change, not a deletion: history
      // stays queryable, and nothing outside research presentation is
      // touched (no event set retires, no validation ends, no mission or
      // order changes). The WHERE carries the thread even when the id alone
      // would have identified the row: a scene is never cleared from
      // outside its own conversation.
      const cleared =
        sceneId === undefined
          ? sql<{ readonly scene_id: string }>`
            UPDATE trading_research_scenes
            SET status = 'cleared', updated_at = ${now}
            WHERE thread_id = ${threadId} AND status = 'active'
            RETURNING scene_id
          `
          : sql<{ readonly scene_id: string }>`
            UPDATE trading_research_scenes
            SET status = 'cleared', updated_at = ${now}
            WHERE thread_id = ${threadId} AND scene_id = ${sceneId} AND status = 'active'
            RETURNING scene_id
          `;
      return yield* cleared.pipe(
        Effect.mapError(sqlFail("clear")),
        Effect.map((result) => result.length),
      );
    });

  return { publish, show, list, clear } satisfies TradingResearchSceneServiceShape;
});

export const TradingResearchSceneServiceLive: Layer.Layer<
  TradingResearchSceneService,
  never,
  SqlClient.SqlClient | Crypto.Crypto
> = Layer.effect(TradingResearchSceneService, makeTradingResearchSceneService);
