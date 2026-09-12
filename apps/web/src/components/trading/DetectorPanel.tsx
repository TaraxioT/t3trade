import type { EnvironmentId, ForgeThreadContextView, ScopedThreadRef } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

import { useForgeThreadContext, type ForgeReadState } from "../../lib/forgeBridgeState";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useAtomCommand } from "../../state/use-atom-command";
import { describeControlFailure } from "./useMissionControls";
import { DetectorExecutionSection } from "./DetectorExecutionPanel";
import { Button } from "../ui/button";
import { useComposerPrefill, type ComposerPrefill } from "./composerPrefill";

export function DetectorReadings({
  state,
  now,
  prefill,
  onControl,
  controlBusy = false,
  controlMessage = null,
  environmentId,
}: {
  state: ForgeReadState<ForgeThreadContextView>;
  now: number;
  prefill: ComposerPrefill;
  onControl?: (capabilityId: string, action: "arm" | "disarm") => void;
  controlBusy?: boolean;
  controlMessage?: string | null;
  environmentId?: EnvironmentId;
}) {
  const slot = state.data?.detectorEvaluations;
  return (
    <div className="space-y-3 p-3 text-xs" data-testid="detector-readings">
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground">Latest recorded readings</span>
        <Button size="xs" variant="ghost" onClick={state.refresh} disabled={state.isLoading}>
          {state.isLoading ? "Refreshing…" : "Refresh"}
        </Button>
      </div>
      {controlMessage === null ? null : <p role="status">{controlMessage}</p>}
      {state.error === null ? null : <p role="alert">{state.error}</p>}
      {state.stale ? (
        <p role="status">Stale retained readings. Refresh before relying on these results.</p>
      ) : null}
      {state.data === null ? (
        <p>{state.isLoading ? "Loading detectors…" : "Detector readings unavailable."}</p>
      ) : slot === undefined ? (
        <p>This server does not expose detector readings.</p>
      ) : slot.status === "unavailable" ? (
        <p>Detector readings unavailable: {slot.reason}</p>
      ) : slot.items.length === 0 ? (
        <p>No installed detector is associated with this conversation.</p>
      ) : (
        <ul className="space-y-3">
          {slot.items.map((item) => (
            <li
              key={item.capabilityId}
              className="space-y-1 rounded-md border border-border/60 p-3"
            >
              <p className="flex flex-wrap justify-between gap-2 font-medium">
                <span>
                  {item.capabilityId} · v{item.version}
                </span>
                <span>
                  {item.armed ? "Armed" : "Disarmed"}
                  {state.stale ? " (retained)" : ""}
                </span>
              </p>
              {item.status === "noEvaluation" ? (
                <p>No evaluation: {item.reason}</p>
              ) : (
                <>
                  <p className="font-medium">
                    {item.result.status === "matched"
                      ? now >= item.result.validUntilMs
                        ? "Match expired"
                        : "Matched"
                      : item.result.status === "not-matched"
                        ? "Not matched"
                        : "Unknown"}
                  </p>
                  {item.result.status === "matched" ? (
                    <p>
                      Occurrence {item.result.occurrenceKey}. Valid until{" "}
                      {new Date(item.result.validUntilMs).toISOString()}.
                    </p>
                  ) : (
                    <p className="whitespace-pre-wrap break-words">{item.result.explanation}</p>
                  )}
                  <p className="text-muted-foreground">
                    Evaluated {new Date(item.asOfMs).toISOString()} · state revision{" "}
                    {item.stateRevision}
                  </p>
                  <details>
                    <summary className="cursor-pointer">Evidence references</summary>
                    <div className="space-y-1 break-all pt-2 font-mono text-[10px]">
                      <p>Evaluation: {item.evaluationId}</p>
                      <p>Input digest: {item.inputDigest}</p>
                      {item.evidenceIds.length === 0 ? (
                        <p>No evidence references supplied.</p>
                      ) : (
                        item.evidenceIds.map((id) => <p key={id}>{id}</p>)
                      )}
                    </div>
                  </details>
                </>
              )}
              {onControl === undefined ? null : (
                <div className="flex gap-2">
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={controlBusy || item.armed || state.stale}
                    onClick={() => onControl(item.capabilityId, "arm")}
                  >
                    Arm detector
                  </Button>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={controlBusy}
                    onClick={() => onControl(item.capabilityId, "disarm")}
                  >
                    Disarm detector
                  </Button>
                </div>
              )}
              {environmentId === undefined ? null : (
                <DetectorExecutionSection
                  environmentId={environmentId}
                  capabilityId={item.capabilityId}
                />
              )}
              {prefill === null ? null : (
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() =>
                    prefill(
                      `Explain detector ${item.capabilityId}: show its source health, latest evidence, generated policy, and any execution envelope, quote, proposal, or swap intent. Distinguish replay from live evidence and prepared intents from executed trades.`,
                    )
                  }
                >
                  Ask about evidence and execution
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="text-muted-foreground">
        A detector reading does not mean a trade executed. Arming permits scheduled evaluation and
        grants no execution authority; inspect the evidence and execution receipt separately.
      </p>
    </div>
  );
}

export function DetectorPanel({ threadRef }: { threadRef: ScopedThreadRef }) {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(Date.now);
  const state = useForgeThreadContext(threadRef.environmentId, {
    enabled: open,
    threadId: threadRef.threadId,
  });
  const prefill = useComposerPrefill(threadRef);
  const sendControl = useAtomCommand(orchestrationEnvironment.forgeDetectorControl);
  const [controlBusy, setControlBusy] = useState(false);
  const pendingControl = useRef(false);
  const [controlMessage, setControlMessage] = useState<string | null>(null);
  const onControl = async (capabilityId: string, action: "arm" | "disarm") => {
    if (pendingControl.current) return;
    pendingControl.current = true;
    setControlBusy(true);
    setControlMessage(null);
    try {
      const result = await sendControl({
        environmentId: threadRef.environmentId,
        input: { capabilityId, action },
      });
      if (result._tag === "Failure") {
        setControlMessage(
          describeControlFailure(result) ??
            "Control result unavailable. Refresh to check detector standing.",
        );
      } else if (!result.value.applied) {
        setControlMessage(`Control refused: ${result.value.reason ?? "No reason supplied"}`);
      } else {
        setControlMessage(
          `${capabilityId}: ${action === "arm" ? "armed" : "disarmed"}. No execution authority granted.`,
        );
      }
      state.refresh();
    } catch {
      setControlMessage("Control result unavailable. Refresh to check detector standing.");
    } finally {
      pendingControl.current = false;
      setControlBusy(false);
    }
  };
  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    state.refresh();
    const timer = window.setInterval(() => {
      setNow(Date.now());
      state.refresh();
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [open, state.refresh]);
  return (
    <section
      className="pointer-events-auto border-b border-border/50"
      aria-label="Research detectors"
    >
      <button
        type="button"
        className="w-full px-4 py-2 text-left text-xs font-medium"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {open ? "▾" : "▸"} Research detectors
      </button>
      {open ? (
        <div className="max-h-[35vh] overflow-y-auto">
          <DetectorReadings
            state={state}
            now={now}
            prefill={prefill}
            onControl={(capabilityId, action) => void onControl(capabilityId, action)}
            controlBusy={controlBusy}
            controlMessage={controlMessage}
            environmentId={threadRef.environmentId}
          />
        </div>
      ) : null}
    </section>
  );
}
