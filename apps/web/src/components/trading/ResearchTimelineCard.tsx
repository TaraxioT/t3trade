import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, OpenResearchSceneAction, ThreadId } from "@t3tools/contracts";
import { OpenResearchSceneAction as OpenResearchSceneActionSchema } from "@t3tools/contracts";
import {
  ResearchJobView,
  type ResearchJobView as ResearchJobViewType,
} from "@t3tools/trading-contracts/researchData";
import {
  SavedResearchResultSummary,
  type SavedResearchResultSummary as SavedResearchResultSummaryType,
} from "@t3tools/trading-contracts/researchScenes";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useMemo, useState } from "react";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSavedResearch } from "../../lib/researchDatasetState";
import { asRecord, readTradingCardResult } from "./cardPayload";
import { ResearchOpenAction } from "./ResearchOpenAction";

type ResearchToolCard =
  | { readonly kind: "job"; readonly job: ResearchJobViewType }
  | {
      readonly kind: "open";
      readonly action: OpenResearchSceneAction;
      readonly summary?: SavedResearchResultSummaryType;
    };

export function deriveResearchToolCard(toolData: unknown): ResearchToolCard | null {
  const chart = asRecord(readTradingCardResult(toolData, "trading_chart"));
  if (chart !== null && Schema.is(OpenResearchSceneActionSchema)(chart.openResearch)) {
    const summary = Schema.is(SavedResearchResultSummary)(chart.savedResultSummary)
      ? chart.savedResultSummary
      : undefined;
    const matchingSummary =
      summary !== undefined &&
      (summary.kind === "event_study"
        ? summary.studyId === chart.openResearch.studyId
        : summary.simulationId === chart.openResearch.simulationId);
    return { kind: "open", action: chart.openResearch, ...(matchingSummary ? { summary } : {}) };
  }
  const events = asRecord(readTradingCardResult(toolData, "trading_events"));
  if (events !== null && Schema.is(ResearchJobView)(events.researchJob)) {
    return { kind: "job", job: events.researchJob };
  }
  return null;
}

function SavedResultSummary(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly threadKey: string;
  readonly job: ResearchJobViewType;
}) {
  const identity =
    props.job.studyId !== undefined
      ? { studyId: props.job.studyId }
      : { simulationId: props.job.simulationId! };
  const saved = useSavedResearch(props.environmentId, props.threadId, identity);
  const resultId = props.job.studyId ?? props.job.simulationId!;
  const resultKind = props.job.studyId !== undefined ? "event_study" : "long_simulation";
  return (
    <div className="mt-2 space-y-1" data-testid="saved-research-card">
      {saved.data === null ? (
        <p>{saved.error ?? "Loading saved report…"}</p>
      ) : saved.data.kind === "event_study" ? (
        <>
          <p>
            {saved.data.study.report.rows.length} FOMC meetings ·{" "}
            {saved.data.study.recipe.eventInventory.status} inventory · report{" "}
            {saved.data.study.reportHash.slice(0, 12)}
          </p>
          <div className="flex flex-wrap gap-2">
            {saved.data.study.report.summaries.map((summary) => (
              <span key={summary.horizonMs}>
                +{summary.horizonMs / 3_600_000}h: {summary.measuredCount}/{summary.eligibleCount}{" "}
                measured · mean{" "}
                {summary.meanReturnPct === null
                  ? "unavailable"
                  : `${summary.meanReturnPct >= 0 ? "+" : ""}${summary.meanReturnPct.toFixed(2)}%`}
              </span>
            ))}
          </div>
          <p>
            {
              saved.data.study.report.rows.filter((row) =>
                row.horizons.some((h) => h.status !== "measured"),
              ).length
            }{" "}
            meetings have an uncovered or pending horizon. Individual rows are retained in the
            graph.
          </p>
        </>
      ) : (
        <>
          <p>
            {saved.data.simulation.report.summary.coveredTrades}/
            {saved.data.simulation.report.summary.eventCount} hypothetical longs · net{" "}
            {saved.data.simulation.report.summary.totalNetPnlQuote.toFixed(2)} USDC
          </p>
          <p>
            Fees {saved.data.simulation.report.summary.totalFeesQuote.toFixed(2)} USDC · slippage{" "}
            {saved.data.simulation.report.summary.totalSlippageCostQuote.toFixed(2)} USDC ·
            independent trades
          </p>
        </>
      )}
      <ResearchOpenAction
        environmentId={props.environmentId}
        threadId={props.threadId}
        threadKey={props.threadKey}
        resultId={resultId}
        resultKind={resultKind}
      />
    </div>
  );
}

function ResearchJobCard(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly threadKey: string;
  readonly initial: ResearchJobViewType;
}) {
  const atom = useMemo(
    () =>
      orchestrationEnvironment.researchJob({
        environmentId: props.environmentId,
        input: { threadId: props.threadId, jobId: props.initial.jobId },
      }),
    [props.environmentId, props.threadId, props.initial.jobId],
  );
  const read = useAtomValue(atom);
  const value = Option.getOrNull(AsyncResult.value(read));
  const job = value ?? props.initial;
  const [controlError, setControlError] = useState<string | null>(null);
  const cancel = useAtomCommand(orchestrationEnvironment.cancelResearchJob);
  const resume = useAtomCommand(orchestrationEnvironment.resumeResearchJob);
  useEffect(() => {
    if (job.status !== "queued" && job.status !== "running") return;
    const timer = window.setInterval(() => appAtomRegistry.refresh(atom), 2_000);
    return () => window.clearInterval(timer);
  }, [atom, job.status]);
  const control = async (kind: "cancel" | "resume") => {
    setControlError(null);
    const result = await (kind === "cancel" ? cancel : resume)({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, jobId: job.jobId },
    });
    if (result._tag === "Failure") setControlError(`${kind} failed`);
    appAtomRegistry.refresh(atom);
  };
  return (
    <div
      className="rounded-md border border-border/60 px-3 py-2 text-xs"
      data-testid="research-job-card"
    >
      <strong>
        {job.resultKind === "long_simulation" ? "FOMC hypothetical longs" : "FOMC ETH event study"}
      </strong>
      <p>
        {job.status} · {job.completedWindows ?? 0}/{job.plannedWindows ?? 0} windows ·{" "}
        {job.rowCount} rows · {job.requestCount} source requests
      </p>
      {AsyncResult.isFailure(read) ? (
        <p>Job refresh unavailable; showing last saved progress.</p>
      ) : null}
      {job.failureReason ? <p className="text-destructive">{job.failureReason}</p> : null}
      {controlError ? <p role="alert">{controlError}</p> : null}
      {job.status === "queued" || job.status === "running" ? (
        <button type="button" className="underline" onClick={() => void control("cancel")}>
          Cancel acquisition
        </button>
      ) : job.status === "paused" || job.status === "cancelled" || job.status === "failed" ? (
        <button type="button" className="underline" onClick={() => void control("resume")}>
          Resume acquisition
        </button>
      ) : null}
      {job.status === "complete" &&
      (job.studyId !== undefined || job.simulationId !== undefined) ? (
        <SavedResultSummary
          environmentId={props.environmentId}
          threadId={props.threadId}
          threadKey={props.threadKey}
          job={job}
        />
      ) : null}
    </div>
  );
}

export function ResearchTimelineCard(props: {
  readonly card: ResearchToolCard;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly threadKey: string;
}) {
  if (props.card.kind === "open")
    return (
      <div className="rounded-md border p-2 text-xs">
        <p>Saved Graph research scene · {props.card.action.resultKind.replaceAll("_", " ")}</p>
        {props.card.summary?.kind === "long_simulation" ? (
          <p>
            {props.card.summary.coveredTrades}/{props.card.summary.eventCount} hypothetical longs ·
            net {props.card.summary.totalNetPnlQuote.toFixed(2)} USDC · fees{" "}
            {props.card.summary.totalFeesQuote.toFixed(2)} · slippage{" "}
            {props.card.summary.totalSlippageCostQuote.toFixed(2)}
          </p>
        ) : props.card.summary?.kind === "event_study" ? (
          <p>
            {props.card.summary.eventCount} meetings ·{" "}
            {props.card.summary.horizons
              .map(
                (horizon) =>
                  `+${horizon.horizonMs / 3_600_000}h ${horizon.measuredCount}/${horizon.eligibleCount} measured`,
              )
              .join(" · ")}
          </p>
        ) : null}
        <ResearchOpenAction
          environmentId={props.environmentId}
          threadId={props.threadId}
          threadKey={props.threadKey}
          resultId={props.card.action.studyId ?? props.card.action.simulationId ?? ""}
          resultKind={props.card.action.resultKind}
          action={props.card.action}
        />
      </div>
    );
  return (
    <ResearchJobCard
      environmentId={props.environmentId}
      threadId={props.threadId}
      threadKey={props.threadKey}
      initial={props.card.job}
    />
  );
}
