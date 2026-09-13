import type { EnvironmentId, ForgeExecutionStateView } from "@t3tools/contracts";
import { useEffect, useMemo, useRef, useState } from "react";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useAtomCommand } from "../../state/use-atom-command";
import { useRetainedAtomValue } from "../../lib/forgeBridgeState";
import { Button } from "../ui/button";
import { describeControlFailure } from "./useMissionControls";

export function ExecutionStateDetails({
  data,
  onApprove,
  onRevoke,
  busy,
}: {
  data: ForgeExecutionStateView;
  onApprove: (envelopeId: string) => void;
  onRevoke: (envelopeId: string) => void;
  busy: boolean;
}) {
  if (data.status !== "ok") return <p>{data.reason}</p>;
  const { envelope, budget } = data;
  const grant = envelope.envelope;
  return (
    <div className="space-y-2 break-words">
      <p className="font-medium">
        Envelope {envelope.revision} · recorded status: {envelope.status}
      </p>
      <p>
        {grant === null
          ? "Envelope terms unavailable."
          : `Expires ${new Date(grant.expiresAtMs).toISOString()}`}
      </p>
      <p>Approval origin: {envelope.approvedVia ?? "No approval recorded"}</p>
      <p>
        Input cap: {grant?.inputCapTotalRaw ?? "unknown"} total ·{" "}
        {grant?.inputCapPerSwapRaw ?? "unknown"} per swap (raw token units)
      </p>
      <p>
        Remaining {budget.remainingInputCapRaw} · settled {budget.settledRaw} · in flight{" "}
        {budget.inFlightRaw} (raw token units)
      </p>
      {budget.budgetLedger === "corrupt" ? (
        <p role="alert">
          Budget ledger is CORRUPT — spending is refused and the remaining cap reads as zero, never
          as fresh budget.
          {budget.corruptDetail === undefined ? null : ` (${budget.corruptDetail})`}
        </p>
      ) : null}
      <ul className="space-y-1">
        {(grant?.candidates ?? []).map((candidate) => (
          <li key={candidate.candidateId}>
            <p>
              {candidate.candidateId} · chain {candidate.chainId}
            </p>
            <p className="break-all">
              {candidate.tokenIn} → {candidate.tokenOut}
            </p>
            <p className="break-all text-muted-foreground">Recipient {candidate.recipient}</p>
          </li>
        ))}
      </ul>
      {envelope.status === "proposed" ? (
        <Button
          size="xs"
          disabled={busy}
          onClick={() => onApprove(envelope.envelopeId)}
          variant="default"
        >
          Approve execution envelope
        </Button>
      ) : null}
      <Button
        size="xs"
        variant="outline"
        disabled={busy || envelope.status !== "approved"}
        onClick={() => onRevoke(envelope.envelopeId)}
      >
        Revoke execution envelope
      </Button>
      <p className="text-muted-foreground">
        Approval binds exactly the terms above and only this envelope. Revocation stops future
        admissions; it does not reverse an already submitted transaction. Neither the agent nor any
        tool can approve.
      </p>
      {grant === null ? null : (
        <details>
          <summary className="cursor-pointer">Execution limits and program identity</summary>
          <p>
            Maximum gas {grant.maxGasWei} wei · slippage {grant.maxSlippageBps} bps
          </p>
          <p>
            Maximum transactions {grant.maxTransactions} · concurrent {grant.maxConcurrentIntents}
          </p>
          <p className="break-all">Detector bundle {grant.detectorBundleSha256}</p>
          <p className="break-all">Policy bundle {grant.policyBundleSha256}</p>
        </details>
      )}
      <details>
        <summary className="cursor-pointer">
          Recent policy decisions ({data.proposals.length}, up to 100)
        </summary>
        {data.proposals.length === 0 ? (
          <p>No policy proposals recorded.</p>
        ) : (
          <ul className="space-y-2 pt-2">
            {data.proposals.map((record) => (
              <li key={record.proposalId}>
                <p>
                  {record.proposal.kind} · {record.status} ·{" "}
                  {new Date(record.proposedAtMs).toISOString()}
                </p>
                {record.proposal.kind === "swap" ? (
                  <p>
                    Candidate {record.proposal.candidateId} · input {record.proposal.amountInRaw}{" "}
                    raw · stage {record.proposal.stageKey} · quote {record.proposal.quoteId}
                  </p>
                ) : record.proposal.kind === "price" ||
                  record.proposal.kind === "stop-future-actions" ? (
                  <p>{record.proposal.reason}</p>
                ) : record.proposal.kind === "complete" ? (
                  <p>{record.proposal.summary}</p>
                ) : null}
                <p className="break-all text-muted-foreground">
                  Detector evaluation {record.detectorEvaluationId}
                </p>
              </li>
            ))}
          </ul>
        )}
      </details>
      <details open={data.intents.length > 0}>
        <summary className="cursor-pointer">
          Recent swap intents ({data.intents.length}, up to 100)
        </summary>
        {data.intents.length === 0 ? (
          <p>No swap intents recorded.</p>
        ) : (
          <ul className="space-y-2 pt-2">
            {data.intents.map((intent) => (
              <li key={intent.intentId}>
                <p className="font-medium">
                  {intent.status === "submit-refused"
                    ? "Submission refused — no trade executed"
                    : intent.status === "prepared"
                      ? "Prepared — not submitted"
                      : intent.status}
                </p>
                {intent.refusalReason === undefined ? null : <p>{intent.refusalReason}</p>}
                <p>
                  Input {intent.amountInRaw} · minimum output {intent.minAmountOutRaw} (raw token
                  units)
                </p>
                <p className="break-all text-muted-foreground">
                  Quote {intent.quoteId} · route {intent.routeId} · intent {intent.intentId}
                </p>
              </li>
            ))}
          </ul>
        )}
      </details>
    </div>
  );
}

export function DetectorExecutionPanel({
  environmentId,
  capabilityId,
}: {
  environmentId: EnvironmentId;
  capabilityId: string;
}) {
  const atom = useMemo(
    () => orchestrationEnvironment.forgeExecutionState({ environmentId, input: { capabilityId } }),
    [environmentId, capabilityId],
  );
  const state = useRetainedAtomValue(atom);
  const revoke = useAtomCommand(orchestrationEnvironment.forgeExecutionRevoke);
  const approve = useAtomCommand(orchestrationEnvironment.forgeExecutionApprove);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [message, setMessage] = useState<string | null>(null);
  const refresh = () => appAtomRegistry.refresh(atom);
  useEffect(() => {
    appAtomRegistry.refresh(atom);
    const timer = window.setInterval(() => appAtomRegistry.refresh(atom), 30_000);
    return () => window.clearInterval(timer);
  }, [atom]);
  const describeResult = (label: string, result: Awaited<ReturnType<typeof revoke>>): string =>
    result._tag === "Failure"
      ? (describeControlFailure(result) ??
        "Result unavailable; refresh to check envelope standing.")
      : result.value.applied
        ? `${label} applied.`
        : `${label} refused: ${result.value.reason ?? "No reason supplied"}`;
  const runControl = async (label: string, run: () => Promise<unknown>) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setMessage(null);
    try {
      const result = (await run()) as Awaited<ReturnType<typeof revoke>>;
      setMessage(describeResult(label, result));
      refresh();
    } catch {
      setMessage("Result unavailable; refresh to check envelope standing.");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const onApprove = (envelopeId: string) =>
    void runControl("Approval", () =>
      approve({ environmentId, input: { capabilityId, envelopeId, approvedVia: "web-ui" } }),
    );
  const onRevoke = (envelopeId: string) =>
    void runControl("Revoke", () => revoke({ environmentId, input: { capabilityId, envelopeId } }));
  return (
    <div className="space-y-2 border-t border-border/50 pt-2">
      <Button size="xs" variant="ghost" onClick={refresh} disabled={state.isLoading}>
        {state.isLoading ? "Refreshing execution…" : "Refresh execution"}
      </Button>
      {message === null ? null : <p role="status">{message}</p>}
      {state.error === null ? null : <p role="alert">{state.error}</p>}
      {state.stale ? <p>Stale execution state; retained values may have changed.</p> : null}
      {state.data === null ? (
        <p>{state.isLoading ? "Loading execution state…" : "Execution state unavailable."}</p>
      ) : (
        <ExecutionStateDetails
          data={state.data}
          onApprove={(id) => onApprove(id)}
          onRevoke={(id) => onRevoke(id)}
          busy={busy}
        />
      )}
    </div>
  );
}

export function DetectorExecutionSection(props: {
  environmentId: EnvironmentId;
  capabilityId: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="pt-2">
      <Button size="xs" variant="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? "Hide execution" : "Execution details"}
      </Button>
      {open ? <DetectorExecutionPanel {...props} /> : null}
    </div>
  );
}
