/**
 * The TRADE.md turn-context seam.
 *
 * One shared, provider-neutral place that reads the thread workspace's
 * CURRENT TRADE.md and appends one bounded, clearly delimited context block
 * to a turn — riding directly on `applyTradingTurnContract`, so Claude,
 * Codex, Cursor, Grok and OpenCode receive the same facts without any of
 * their native system prompts being replaced or appended to. The block is
 * data (path, hash, activation state, content), not instructions: the agent
 * interprets the document with its native tools and acts through the typed
 * trading tools.
 *
 * Absent file means no block and no mention. A read that refuses (escape,
 * oversize, bad encoding, unreadable state) also means no block — the turn
 * is never held hostage by the document — but the refusal is logged so the
 * failure is observable rather than silent.
 *
 * @module TradingPlanTurnContext
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { TRADE_MD_FILENAME } from "@t3tools/trading-contracts/plan-document";

import {
  applyTradingTurnContract,
  type TradingTurnContract,
} from "../provider/TradingSessionProfile.ts";
import {
  makeTradingPlanDocumentService,
  readThreadWorkspaceRoot,
  type CurrentPlanDocument,
} from "./TradingPlanDocument.ts";

/** Hard bound on the injected block, content included. */
const PLAN_CONTEXT_MAX_CHARS = 70_000;

/** The one-line header every injected block carries, facts first. */
const blockHeader = (input: {
  readonly path: string;
  readonly contentHash: string;
  readonly activation: string;
}): string =>
  `[t3-trade plan document] path=${input.path} sha256=${input.contentHash} activation=${input.activation}`;

/**
 * Compose the delimited context block for a thread's workspace, or null when
 * there is nothing to say: no persisted thread cwd, no document, or a read
 * that refused. Every refusal path is logged, never raised — the turn goes
 * out regardless, and the document's problems are surfaced by the tools that
 * own them (activation, the drift guard) rather than by every conversation.
 */
export const readTradingPlanTurnContext = Effect.fn("TradingPlanTurnContext.read")(
  (threadId: string): Effect.Effect<string | null, never, SqlClient.SqlClient> =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const workspaceRoot = yield* readThreadWorkspaceRoot(sql, threadId);
      if (workspaceRoot === null) return null;

      const documents = yield* makeTradingPlanDocumentService;
      // A typed refusal (escape, oversize, encoding) is a fact about the
      // document, not a reason to fail the turn; the catchCause recovery
      // below already absorbs the whole failure channel into null.
      const current: CurrentPlanDocument | null = yield* documents.readCurrent(workspaceRoot).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("trading plan document could not be read for turn context", {
            threadId,
            cause: String(cause),
          }).pipe(Effect.as(null)),
        ),
      );
      if (current === null || current.status === "missing") return null;

      const block =
        `${blockHeader({
          path: current.path,
          contentHash: current.contentHash,
          activation: current.activation,
        })}\n` +
        `--- ${TRADE_MD_FILENAME} begin ---\n` +
        `${current.content}\n` +
        `--- ${TRADE_MD_FILENAME} end ---`;
      return block.length <= PLAN_CONTEXT_MAX_CHARS ? block : null;
    }),
);

/**
 * The registered context reader, or null before the runtime has wired one.
 *
 * The adapters' turn functions declare no service context, and the seam they
 * share must not add any — so the database-backed read is installed once, at
 * layer composition, by {@link TradingPlanTurnContextLive} (same pattern as
 * the module-level registries the MCP session glue uses). Until it is
 * installed the seam is a pure pass-through, which is also what tests that
 * never touch the document get.
 */
let planContextReader: ((threadId: string) => Effect.Effect<string | null>) | null = null;

/** Install the context reader. Called once by `TradingPlanTurnContextLive`. */
export function registerTradingPlanTurnContextReader(
  reader: (threadId: string) => Effect.Effect<string | null>,
): void {
  planContextReader = reader;
}

/**
 * The shared turn seam every adapter calls in place of
 * `applyTradingTurnContract`: the contract prefix first (unchanged), the
 * plan-document block appended after the turn's own text, and the same
 * `markDelivered` discipline — delivered is only recorded by the adapter
 * once the turn is away. No service context: the read rides the registered
 * reader, and an unregistered or refusing reader means no block, never a
 * failed turn.
 */
export const applyTradingTurnContractWithContext = Effect.fn("TradingPlanTurnContext.apply")(
  (
    threadId: Parameters<typeof applyTradingTurnContract>[0],
    text: string,
  ): Effect.Effect<TradingTurnContract> =>
    Effect.gen(function* () {
      const block = planContextReader === null ? null : yield* planContextReader(threadId);
      return applyTradingTurnContract(threadId, block === null ? text : `${text}\n\n${block}`);
    }),
);

/**
 * Compose-time wiring: builds the document service off the SQL client and
 * registers the turn-context reader. Merged into the trading layer, so every
 * surface that runs the trading tools also serves the plan-document seam.
 */
export const TradingPlanTurnContextLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const read = (threadId: string): Effect.Effect<string | null> =>
      readTradingPlanTurnContext(threadId).pipe(Effect.provideService(SqlClient.SqlClient, sql));
    registerTradingPlanTurnContextReader(read);
  }),
);
