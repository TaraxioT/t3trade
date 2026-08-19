import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  OrchestrationReactor,
  type OrchestrationReactorShape,
} from "../Services/OrchestrationReactor.ts";
import { CheckpointReactor } from "../Services/CheckpointReactor.ts";
import { ProviderCommandReactor } from "../Services/ProviderCommandReactor.ts";
import { ProviderRuntimeIngestionService } from "../Services/ProviderRuntimeIngestion.ts";
import { ThreadDeletionReactor } from "../Services/ThreadDeletionReactor.ts";
import * as AgentAwarenessRelay from "../../relay/AgentAwarenessRelay.ts";
import { TradingMissionReactor } from "../../trading/TradingMissionReactor.ts";
import { TradingRuntimeLease } from "../../trading/TradingRuntimeLease.ts";
import { WatchEvaluator } from "../../trading/WatchEvaluator.ts";

export const makeOrchestrationReactor = Effect.gen(function* () {
  const providerRuntimeIngestion = yield* ProviderRuntimeIngestionService;
  const providerCommandReactor = yield* ProviderCommandReactor;
  const checkpointReactor = yield* CheckpointReactor;
  const threadDeletionReactor = yield* ThreadDeletionReactor;
  const agentAwarenessRelay = yield* AgentAwarenessRelay.AgentAwarenessRelay;
  const tradingMissionReactor = yield* TradingMissionReactor;
  const watchEvaluator = yield* WatchEvaluator;
  const tradingLease = yield* TradingRuntimeLease;

  const start: OrchestrationReactorShape["start"] = Effect.fn("start")(function* () {
    yield* providerRuntimeIngestion.start();
    yield* providerCommandReactor.start();
    yield* checkpointReactor.start();
    yield* threadDeletionReactor.start();
    yield* agentAwarenessRelay.start();
    // The trading runtime only runs while this process holds the trading
    // lease: a second server (or the live-derived harness) against the same
    // state database must not sweep watches or run mission housekeeping in
    // parallel with the live holder. Everything else starts regardless.
    if (tradingLease.held) {
      yield* tradingMissionReactor.start();
      yield* watchEvaluator.start();
    } else {
      yield* Effect.logWarning(
        "OrchestrationReactor: trading lease not held - mission reactor and watch evaluator stay down",
      );
    }
  });

  return {
    start,
  } satisfies OrchestrationReactorShape;
});

export const OrchestrationReactorLive = Layer.effect(
  OrchestrationReactor,
  makeOrchestrationReactor,
);
