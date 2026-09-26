import { EnvironmentId, ThreadId, type ResearchSceneView } from "@t3tools/contracts";
import type { SavedEventStudy } from "@t3tools/trading-contracts/eventResearch";
import type { SavedEventLongSimulation } from "@t3tools/trading-contracts/eventLongSimulation";
import type { GraphSourceRef } from "@t3tools/trading-contracts/researchData";
import { useState } from "react";

import {
  researchCandles,
  useResearchDatasetWindow,
  useSavedResearch,
} from "../../lib/researchDatasetState";
import { EventLongResult } from "./EventLongResult";
import { EventResearchResult } from "./EventResearchResult";

const DAY = 86_400_000;

function sameSource(a: GraphSourceRef, b: GraphSourceRef): boolean {
  return (
    a.provider === b.provider &&
    a.chain === b.chain &&
    a.subgraphId === b.subgraphId &&
    a.deployment === b.deployment &&
    a.poolAddress === b.poolAddress &&
    a.baseTokenAddress === b.baseTokenAddress &&
    a.quoteTokenAddress === b.quoteTokenAddress &&
    a.feeTier === b.feeTier &&
    a.normalizationVersion === b.normalizationVersion
  );
}

function RetainedWindow(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly study: SavedEventStudy;
  readonly simulation?: SavedEventLongSimulation;
  readonly selectedEventId: string;
  readonly onSelectEvent: (id: string) => void;
  readonly mode: "calendar" | "aligned";
  readonly horizonMs: number;
  readonly onSelectHorizon: (ms: number) => void;
}) {
  const { study, simulation } = props;
  const event = study.report.rows.find((row) => row.eventId === props.selectedEventId)?.event;
  const datasetId = study.datasetIds[0];
  // The study retains a wide hourly context dataset. Its immutable manifest is
  // checked by the server before this read; no Graph request occurs here.
  if (event?.statementAt === null || event === undefined || datasetId === undefined) {
    return simulation === undefined ? (
      <EventResearchResult
        study={study}
        mode={props.mode}
        selectedEventId={props.selectedEventId}
        onSelectEvent={props.onSelectEvent}
        horizonMs={props.horizonMs}
        onSelectHorizon={props.onSelectHorizon}
        candles={[]}
      />
    ) : (
      <EventLongResult
        study={study}
        simulation={simulation}
        selectedEventId={props.selectedEventId}
        onSelectEvent={props.onSelectEvent}
        candles={[]}
      />
    );
  }
  return <WindowRead {...props} datasetId={datasetId} statementAt={event.statementAt} />;
}

function WindowRead(
  props: Parameters<typeof RetainedWindow>[0] & {
    readonly datasetId: string;
    readonly statementAt: number;
  },
) {
  const lastHorizon =
    props.simulation === undefined
      ? props.horizonMs
      : props.simulation.scenario.entryDelayMs + props.simulation.scenario.holdMs;
  const window = useResearchDatasetWindow({
    environmentId: props.environmentId,
    threadId: props.threadId,
    studyId: props.study.studyId,
    datasetId: props.datasetId,
    from: Math.max(0, props.statementAt - DAY),
    to: props.statementAt + lastHorizon + DAY,
    resolution: "1h",
  });
  const candles =
    window.data?.manifest.status === "complete" ? researchCandles(window.data.rows, "1h") : [];
  return (
    <div>
      {window.loading && window.data === null ? <p>Loading retained Graph window…</p> : null}
      {window.error !== null ? (
        <p className="text-amber-600">
          Retained window unavailable: {window.error} {window.stale ? "· showing prior data" : ""}
        </p>
      ) : null}
      {window.data?.nextCursor !== null && window.data !== null ? (
        <p>Window page continues; select a narrower event view.</p>
      ) : null}
      {props.simulation === undefined ? (
        <EventResearchResult
          study={props.study}
          mode={props.mode}
          selectedEventId={props.selectedEventId}
          onSelectEvent={props.onSelectEvent}
          horizonMs={props.horizonMs}
          onSelectHorizon={props.onSelectHorizon}
          candles={candles}
        />
      ) : (
        <EventLongResult
          study={props.study}
          simulation={props.simulation}
          selectedEventId={props.selectedEventId}
          onSelectEvent={props.onSelectEvent}
          candles={candles}
        />
      )}
    </div>
  );
}

function SavedGraphStudy(props: {
  readonly environmentId: EnvironmentId;
  readonly scene: ResearchSceneView;
  readonly studyId: string;
  readonly mode: "calendar" | "aligned";
  readonly simulation?: SavedEventLongSimulation;
}) {
  const threadId = ThreadId.make(props.scene.threadId);
  const saved = useSavedResearch(props.environmentId, threadId, { studyId: props.studyId });
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [selectedHorizon, setSelectedHorizon] = useState<number | null>(null);
  if (saved.data === null) return <p>{saved.error ?? "Loading saved study…"}</p>;
  if (saved.data.kind !== "event_study") return <p>Saved study type does not match scene.</p>;
  const study = saved.data.study;
  const pointer = props.scene.graphResearch;
  const datasetIds = props.simulation?.datasetIds ?? study.datasetIds;
  if (
    pointer === undefined ||
    !sameSource(study.recipe.source, pointer.source) ||
    datasetIds.length !== pointer.datasetIds.length ||
    datasetIds.some((id, index) => pointer.datasetIds[index] !== id) ||
    (props.simulation !== undefined && props.simulation.parentStudyId !== study.studyId) ||
    study.threadId !== props.scene.threadId ||
    study.environmentId !== props.environmentId
  ) {
    return <p>Saved study source or scope does not match this scene.</p>;
  }
  const eventId = selectedEventId ?? study.report.rows[0]?.eventId ?? "";
  const horizon = selectedHorizon ?? study.recipe.horizonsMs[0] ?? 3_600_000;
  return (
    <>
      {saved.error !== null ? (
        <p>
          Saved study refresh failed; showing retained result.{" "}
          <button type="button" onClick={saved.refresh}>
            Retry
          </button>
        </p>
      ) : null}
      <RetainedWindow
        environmentId={props.environmentId}
        threadId={threadId}
        study={study}
        {...(props.simulation === undefined ? {} : { simulation: props.simulation })}
        selectedEventId={eventId}
        onSelectEvent={setSelectedEventId}
        mode={props.mode}
        horizonMs={horizon}
        onSelectHorizon={setSelectedHorizon}
      />
    </>
  );
}

function SavedGraphLong(props: {
  readonly environmentId: EnvironmentId;
  readonly scene: ResearchSceneView;
  readonly mode: "calendar" | "aligned";
  readonly simulationId: string;
  readonly parentStudyId: string;
}) {
  const saved = useSavedResearch(props.environmentId, ThreadId.make(props.scene.threadId), {
    simulationId: props.simulationId,
  });
  if (saved.data === null) return <p>{saved.error ?? "Loading saved long simulation…"}</p>;
  if (
    saved.data.kind !== "long_simulation" ||
    saved.data.simulation.parentStudyId !== props.parentStudyId ||
    saved.data.simulation.environmentId !== props.environmentId ||
    saved.data.simulation.threadId !== props.scene.threadId
  ) {
    return <p>Saved simulation lineage or scope does not match this scene.</p>;
  }
  return (
    <SavedGraphStudy
      environmentId={props.environmentId}
      scene={props.scene}
      mode={props.mode}
      studyId={props.parentStudyId}
      simulation={saved.data.simulation}
    />
  );
}

export function GraphResearchScene(props: {
  readonly environmentId: EnvironmentId;
  readonly scene: ResearchSceneView;
  readonly mode: "calendar" | "aligned";
}) {
  const pointer = props.scene.graphResearch;
  if (pointer === undefined) return <p>Graph scene reference is unavailable.</p>;
  return pointer.kind === "graph_event_study" ? (
    <SavedGraphStudy {...props} studyId={pointer.studyId} />
  ) : (
    <SavedGraphLong
      {...props}
      simulationId={pointer.simulationId}
      parentStudyId={pointer.parentStudyId}
    />
  );
}
