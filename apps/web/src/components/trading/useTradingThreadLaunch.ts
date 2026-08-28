/**
 * Launching trading threads from the trade home (final-form Phase 8).
 *
 * Two launchers share one shape — resolve where the thread belongs and which
 * model runs it, create a real server thread, then navigate to it:
 *
 * - `useAskAnalyst` rides the analyst-thread registry: one analyst thread per
 *   market, reused, with the question sent as an ordinary turn. The server
 *   binds the `trading_analyst` session profile, so the thread runs with the
 *   three read tools and nothing else.
 * - `useMarketThreadLauncher` opens an ordinary chat thread with a market
 *   already noted on it, so the companion panel is up when the user arrives.
 *   No mission is created: the thread takes authority on the market only when
 *   its first plan or entry does. This is how trading starts from the trade
 *   home now.
 *
 * @module useTradingThreadLaunch
 */
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  DEFAULT_RUNTIME_MODE,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useState } from "react";

import { waitForServerThread, waitForStartedServerThread } from "../ChatView.logic";
import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { resolveThreadActionProjectRef } from "../../lib/chatThreadActions";
import { newMessageId, newThreadId } from "../../lib/utils";
import { resolveDefaultProviderModelSelection } from "../../providerInstances";
import {
  readThreadShell,
  readThreadShells,
  useProjects,
  useServerConfigs,
} from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";

interface LaunchContext {
  readonly projectId: ProjectId;
  readonly modelSelection: ModelSelection;
}

/**
 * The thread this environment was last worked in, or null when it has none.
 *
 * Stands in for "the thread being viewed" on routes that have none, which is
 * every route the trade home is reached by. Recency is the last user message,
 * so a thread nobody has written to does not count: without that, each launch
 * would leave its own freshly created thread as the most recent one and pin
 * every later launch to wherever the first one happened to land. Archived
 * threads are not somewhere the user is working either.
 */
function mostRecentlyWorkedShell(environmentId: EnvironmentId): EnvironmentThreadShell | null {
  let best: EnvironmentThreadShell | null = null;
  let bestAt = -1;
  for (const shell of readThreadShells()) {
    if (shell.environmentId !== environmentId || shell.archivedAt !== null) continue;
    if (shell.latestUserMessageAt === null) continue;
    const at = Date.parse(shell.latestUserMessageAt);
    if (Number.isNaN(at) || at <= bestAt) continue;
    best = shell;
    bestAt = at;
  }
  return best;
}

/**
 * Where a launched thread lands and what runs it, or the one-line reason it
 * cannot be launched.
 *
 * Both answers are the ones a thread the user made by hand would get, and they
 * used to be neither: the project was whichever came first in the environment's
 * list, and the model was that project's default. A user who lives in one
 * project and launches from the trade home got a thread in some other project,
 * running some other project's model, with no way to tell from the screen.
 *
 * So the project comes from {@link resolveThreadActionProjectRef} — the same
 * precedence the command palette and the sidebar use for "new thread": the
 * thread being viewed, then the draft being viewed, then the user's own
 * first-ordered project. The model follows the same carry rule: the viewed
 * thread's, since that is the working mode the user is in, and the target
 * project's default when there is no thread to carry from. No trading-specific
 * model is imposed at any point.
 *
 * The trade home is its own route, though, so none of those three is ever set
 * when the watchlist's "Trade in chat" is the caller — the precedence collapses
 * to "first project in the list", which is the bug it was meant to end. So when
 * the route carries no thread, the most recently worked thread in this
 * environment stands in for the one being viewed, and carries both its project
 * and its model. That is the same answer "where was I" has everywhere else in
 * the app, and it needs no state that is not already loaded.
 *
 * The one thing that does not carry is a project on another environment. A
 * project id is only meaningful to the server that owns it, and this launch
 * creates its thread on `environmentId`; a ref from elsewhere names nothing
 * here, so it falls back to this environment's own first project.
 */
function useLaunchContext(environmentId: EnvironmentId): LaunchContext | string {
  const projects = useProjects();
  const serverConfigs = useServerConfigs();
  const newThreadContext = useHandleNewThread();

  const contextRef = resolveThreadActionProjectRef({
    activeThread: newThreadContext.activeThread ?? undefined,
    activeDraftThread: newThreadContext.activeDraftThread,
    defaultProjectRef: newThreadContext.defaultProjectRef,
    handleNewThread: newThreadContext.handleNewThread,
  });
  const viewedThreadRef =
    newThreadContext.routeThreadRef !== null &&
    newThreadContext.routeThreadRef.environmentId === environmentId
      ? newThreadContext.routeThreadRef
      : null;
  const viewedShell = viewedThreadRef === null ? null : readThreadShell(viewedThreadRef);
  const carriedShell = viewedShell ?? mostRecentlyWorkedShell(environmentId);

  const contextProjectId =
    carriedShell !== null
      ? carriedShell.projectId
      : contextRef !== null && contextRef.environmentId === environmentId
        ? contextRef.projectId
        : null;
  const here = projects.filter((entry) => entry.environmentId === environmentId);
  const project = here.find((entry) => entry.id === contextProjectId) ?? here[0] ?? null;
  if (project === null) return "No project in this environment to home the thread in.";

  const providers = serverConfigs.get(environmentId)?.providers ?? [];
  // Only carry the model when the thread it came from is the one we homed in;
  // a model from another project's thread would be as surprising as the
  // project mix-up this replaced.
  const carriedModelSelection =
    carriedShell !== null && carriedShell.projectId === project.id
      ? carriedShell.modelSelection
      : null;
  const modelSelection = resolveDefaultProviderModelSelection(
    providers,
    carriedModelSelection ?? project.defaultModelSelection,
  );
  if (modelSelection === null) return "No provider is available to run the thread.";
  return { projectId: project.id, modelSelection };
}

export interface AskAnalystHandle {
  readonly ask: (input: { readonly asset: string; readonly prompt: string }) => Promise<void>;
  readonly busy: boolean;
  readonly error: string | null;
}

/**
 * "Ask the analyst": resolve (or register) the market's analyst thread, create
 * it when it is new, send the question as a turn, and navigate to it.
 */
export function useAskAnalyst(environmentId: EnvironmentId): AskAnalystHandle {
  const context = useLaunchContext(environmentId);
  const ensureAnalystThread = useAtomCommand(orchestrationEnvironment.ensureTradingAnalystThread);
  const createThread = useAtomCommand(threadEnvironment.create, { reportFailure: false });
  const startThreadTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ask = useCallback(
    async ({ asset, prompt }: { asset: string; prompt: string }) => {
      if (busy) return;
      if (typeof context === "string") {
        setError(context);
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const candidate = newThreadId();
        const ensured = await ensureAnalystThread({
          environmentId,
          input: { asset, candidateThreadId: candidate },
        });
        if (ensured._tag === "Failure") {
          setError("Could not reach the analyst registry.");
          return;
        }
        const threadId = ensured.value.threadId as ThreadId;

        if (ensured.value.created) {
          const created = await createThread({
            environmentId,
            input: {
              threadId,
              projectId: context.projectId,
              title: `Analyst — ${asset}`,
              modelSelection: context.modelSelection,
              runtimeMode: DEFAULT_RUNTIME_MODE,
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              createdAt: new Date().toISOString(),
            },
          });
          if (created._tag === "Failure") {
            setError("Could not create the analyst thread.");
            return;
          }
        }

        const sent = await startThreadTurn({
          environmentId,
          input: {
            threadId,
            message: { messageId: newMessageId(), role: "user", text: prompt, attachments: [] },
            runtimeMode: DEFAULT_RUNTIME_MODE,
            interactionMode: "default",
            createdAt: new Date().toISOString(),
          },
        });
        if (sent._tag === "Failure") {
          setError("The analyst thread exists, but the question could not be sent.");
          return;
        }

        await waitForStartedServerThread(scopeThreadRef(environmentId, threadId));
        await router.navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(scopeThreadRef(environmentId, threadId)),
        });
      } finally {
        setBusy(false);
      }
    },
    [busy, context, createThread, ensureAnalystThread, environmentId, router, startThreadTurn],
  );

  return { ask, busy, error };
}

/** The default analyst prompt for a market read. */
export function analystMarketPrompt(asset: string): string {
  return `Read the current structure on ${asset} and tell me what matters right now — regime, the levels in play, and whether any strategy setup is close.`;
}

/** The analyst prompt for a held position. */
export function analystPositionPrompt(input: {
  readonly asset: string;
  readonly side: string;
  readonly sizeText: string;
}): string {
  return (
    `I hold a ${input.side} position of ${input.sizeText} on ${input.asset}. ` +
    `Read the current structure and tell me what matters for this position — where it is at risk, what would confirm the move, and what you would watch.`
  );
}

export interface MarketThreadLauncherHandle {
  readonly open: (asset: string) => Promise<void>;
  readonly busy: boolean;
  readonly error: string | null;
}

/**
 * "Trade in chat": open a fresh thread already about a market.
 *
 * The thread is created, the market is noted on it, and the workspace
 * navigates there. No mission is created and no turn is sent — the thread is
 * a conversation about a market, and it becomes an authority over that market
 * only when the agent's first plan or entry takes it. Seeding is what makes
 * the companion panel show the chart before a word has been said.
 *
 * A failed seed is not a failed launch: the thread is real either way, and
 * arriving in it without its panel beats not arriving at all.
 */
export function useMarketThreadLauncher(environmentId: EnvironmentId): MarketThreadLauncherHandle {
  const context = useLaunchContext(environmentId);
  const createThread = useAtomCommand(threadEnvironment.create, { reportFailure: false });
  const setThreadMarket = useAtomCommand(orchestrationEnvironment.setTradingThreadMarket, {
    reportFailure: false,
  });
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = useCallback(
    async (asset: string) => {
      if (busy) return;
      if (typeof context === "string") {
        setError(context);
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const threadId = newThreadId();
        const created = await createThread({
          environmentId,
          input: {
            threadId,
            projectId: context.projectId,
            title: `${asset} — trade`,
            modelSelection: context.modelSelection,
            runtimeMode: DEFAULT_RUNTIME_MODE,
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: new Date().toISOString(),
          },
        });
        if (created._tag === "Failure") {
          setError("Could not create the thread.");
          return;
        }

        await setThreadMarket({ environmentId, input: { threadId, asset } });

        // The route bounces a thread this client has not synced yet, so the
        // navigation waits for it to exist rather than for it to have started:
        // a thread opened on a market has no first turn to wait for.
        await waitForServerThread(scopeThreadRef(environmentId, threadId));

        await router.navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(scopeThreadRef(environmentId, threadId)),
        });
      } finally {
        setBusy(false);
      }
    },
    [busy, context, createThread, environmentId, router, setThreadMarket],
  );

  return { open, busy, error };
}
