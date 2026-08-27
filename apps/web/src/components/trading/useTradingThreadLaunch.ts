/**
 * Launching trading threads from the trade home (final-form Phase 8).
 *
 * Two launchers share one shape — resolve the environment's first project and
 * its default model, create a real server thread, then navigate to it:
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
 * - `useMissionLauncher` creates the thread a new mission binds to and
 *   dispatches `trading.mission.create`. Nothing on the trade home mounts it
 *   any more; it is kept only because `MissionCreateForm` still imports it.
 *
 * @module useTradingThreadLaunch
 */
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
import { newMessageId, newThreadId } from "../../lib/utils";
import { resolveDefaultProviderModelSelection } from "../../providerInstances";
import { refreshTradingMissions } from "../../lib/tradingMissionsState";
import { useProjects, useServerConfigs } from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";

interface LaunchContext {
  readonly projectId: ProjectId;
  readonly modelSelection: ModelSelection;
}

/** The environment's first project and its resolved default model, or the
 * one-line reason a thread cannot be launched. */
function useLaunchContext(environmentId: EnvironmentId): LaunchContext | string {
  const projects = useProjects();
  const serverConfigs = useServerConfigs();
  const project = projects.find((entry) => entry.environmentId === environmentId) ?? null;
  if (project === null) return "No project in this environment to home the thread in.";
  const providers = serverConfigs.get(environmentId)?.providers ?? [];
  const modelSelection = resolveDefaultProviderModelSelection(
    providers,
    project.defaultModelSelection,
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

export interface MissionLaunchInput {
  readonly asset: string;
  readonly instruction: string;
  readonly tradingAccountId: string;
  readonly allocatedCapitalUsd?: number;
  readonly maxWakes?: number;
}

export interface MissionLauncherHandle {
  readonly launch: (input: MissionLaunchInput) => Promise<void>;
  readonly busy: boolean;
  readonly error: string | null;
}

/**
 * The explicit mission form's submit: create the thread the mission binds to,
 * dispatch `trading.mission.create`, and navigate to the thread. The server
 * refuses a market already owned (mission or manual exposure); dispatch is an
 * acknowledgement, so the refusal lands asynchronously in the alert feed with
 * its reason verbatim (the reactor appends it and rings the account doorbell)
 * rather than here.
 */
export function useMissionLauncher(environmentId: EnvironmentId): MissionLauncherHandle {
  const context = useLaunchContext(environmentId);
  const createThread = useAtomCommand(threadEnvironment.create, { reportFailure: false });
  const missionCreate = useAtomCommand(orchestrationEnvironment.missionCreate, {
    reportFailure: false,
  });
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const launch = useCallback(
    async (input: MissionLaunchInput) => {
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
            title: `Mission — ${input.asset}`,
            modelSelection: context.modelSelection,
            runtimeMode: DEFAULT_RUNTIME_MODE,
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: new Date().toISOString(),
          },
        });
        if (created._tag === "Failure") {
          setError("Could not create the mission's thread.");
          return;
        }

        const dispatched = await missionCreate({
          environmentId,
          input: {
            threadId,
            tradingAccountId: input.tradingAccountId,
            instruction: input.instruction,
            market: input.asset,
            ...(input.allocatedCapitalUsd === undefined
              ? {}
              : { allocatedCapitalUsd: input.allocatedCapitalUsd }),
            ...(input.maxWakes === undefined ? {} : { maxWakes: input.maxWakes }),
          },
        });
        if (dispatched._tag === "Failure") {
          setError("The mission could not be created.");
          return;
        }

        refreshTradingMissions(environmentId);
        await waitForStartedServerThread(scopeThreadRef(environmentId, threadId));
        await router.navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(scopeThreadRef(environmentId, threadId)),
        });
      } finally {
        setBusy(false);
      }
    },
    [busy, context, createThread, environmentId, missionCreate, router],
  );

  return { launch, busy, error };
}
