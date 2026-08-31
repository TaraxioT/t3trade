/**
 * The compact plan-state display for a mission-bound thread.
 *
 * One line of facts — where the workspace's TRADE.md lives, whether it exists,
 * which revision is active (short hash), its activation state and when it was
 * pinned — plus the direct actions the conversation cannot express well on
 * its own: opening the document, and acknowledging a drifted revision. Pause,
 * resume and the emergency way out stay on the mission pill and strip; this
 * card never duplicates a control that already has a home.
 *
 * Drift is the state that earns the chrome: when the disk plan changed after
 * activation, NEW exposure is fenced server-side, and the card says exactly
 * that and offers the safe next actions rather than implying the plan is
 * active merely because a file exists.
 *
 * Explicit states, none of them animated: loading, projectless, absent,
 * draft, active, drifted, and activation-error (a refused acknowledge, e.g.
 * `stale_hash` when the file changed under the click).
 *
 * @module TradingPlanDocumentCard
 */
import { useAtomCommand } from "../../state/use-atom-command";
import { refreshTradingMissions } from "../../lib/tradingMissionsState";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { cn } from "~/lib/utils";
import { FileTextIcon } from "lucide-react";
import { useCallback, useState } from "react";
import type {
  EnvironmentId,
  OrchestrationActivatePlanDocumentResult,
  OrchestrationTradingMission,
  ThreadId,
} from "@t3tools/contracts";

import { orchestrationEnvironment } from "../../state/orchestration";
import { Button } from "../ui/button";
import { describeControlFailure } from "./useMissionControls";

/** The chip vocabulary: one tone per activation state, never colour-only. */
const ACTIVATION_LABEL: Record<string, string> = {
  none: "No TRADE.md",
  draft: "Draft",
  active: "Active",
  drifted: "Drifted",
};

const ACTIVATION_CLASS: Record<string, string> = {
  none: "border-border text-muted-foreground",
  draft: "border-border text-foreground",
  active: "border-profit/40 bg-profit/10 text-profit",
  drifted: "border-destructive/40 bg-destructive/10 text-destructive",
};

/** `a1b2c3…` — enough hex to eyeball a revision without a scrolling hash. */
const shortHash = (hash: string | null): string | null =>
  hash === null ? null : `${hash.slice(0, 8)}`;

/**
 * Translate a refused acknowledge into the sentence the operator needs. A
 * stale hash is not a retry: the file moved again, so the next read — not the
 * same click — is what can be activated.
 */
const refusalMessage = (result: OrchestrationActivatePlanDocumentResult): string => {
  if (result.outcome !== "rejected") return "The revision was not activated.";
  if (result.reason === "stale_hash") {
    return "TRADE.md changed again before the activation — re-read it and activate the newest revision.";
  }
  if (result.reason === "no_workspace") {
    return "This thread has no workspace root, so there is no TRADE.md to activate.";
  }
  return result.detail;
};

export interface TradingPlanDocumentCardProps {
  readonly mission: OrchestrationTradingMission;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  /** True while the mission snapshot itself is still in flight. */
  readonly isLoading: boolean;
  /** Opens a workspace-relative file in the existing file surface. */
  readonly onOpenFile: (relativePath: string) => void;
}

export function TradingPlanDocumentCard({
  mission,
  environmentId,
  threadId,
  isLoading,
  onOpenFile,
}: TradingPlanDocumentCardProps) {
  const activate = useAtomCommand(orchestrationEnvironment.activateTradingPlanDocument);
  const [isActivating, setIsActivating] = useState(false);
  const [activationError, setActivationError] = useState<string | null>(null);

  const plan = mission.planDocument;

  const handleActivate = useCallback(() => {
    const contentHash = plan?.contentHash;
    if (contentHash === null || contentHash === undefined) return;
    setIsActivating(true);
    setActivationError(null);
    void activate({
      environmentId,
      input: {
        threadId,
        expectedContentHash: contentHash,
        missionId: mission.id,
        changeNote: "Acknowledged from the workspace plan-state card",
      },
    })
      .then((result) => {
        const failure = describeControlFailure(result);
        if (failure !== null) {
          setActivationError(failure);
          return;
        }
        if (result._tag !== "Success") return;
        if (result.value.outcome === "rejected") {
          setActivationError(refusalMessage(result.value));
          return;
        }
        // The mission snapshot has no doorbell event for a plan-document
        // activation, so the card asks for its own re-read on success.
        refreshTradingMissions(environmentId);
      })
      .catch(() => {
        setActivationError("The revision was not activated.");
      })
      .finally(() => {
        setIsActivating(false);
      });
  }, [activate, environmentId, mission.id, plan?.contentHash, threadId]);

  if (isLoading) {
    return (
      <section
        aria-label="Trading plan document"
        className="rounded-lg border border-border bg-card/40 px-3 py-2 text-xs text-muted-foreground"
      >
        Loading plan state…
      </section>
    );
  }

  if (plan === null) {
    // No persisted workspace root: a projectless thread has nowhere for a
    // TRADE.md to live. Its own state, not a silent absence.
    return (
      <section
        aria-label="Trading plan document"
        className="rounded-lg border border-border bg-card/40 px-3 py-2 text-xs text-muted-foreground"
      >
        No workspace on this thread — TRADE.md lives in a project workspace.
      </section>
    );
  }

  const drifted = plan.activation === "drifted";
  const draft = plan.activation === "draft";
  const canAcknowledge = drifted || draft;

  return (
    <section
      aria-label="Trading plan document"
      className={cn(
        "rounded-lg border bg-card/40 px-3 py-2",
        drifted ? "border-destructive/40 bg-destructive/5" : "border-border",
      )}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full border px-2 py-px text-[11px] font-medium",
            ACTIVATION_CLASS[plan.activation],
          )}
        >
          <FileTextIcon aria-hidden="true" className="size-3" />
          {ACTIVATION_LABEL[plan.activation]}
        </span>
        <span className="font-mono text-[11px] text-muted-foreground">{plan.relativePath}</span>
        {shortHash(plan.activatedHash ?? plan.contentHash) === null ? null : (
          <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
            rev {shortHash(plan.activatedHash ?? plan.contentHash)}
          </span>
        )}
        {plan.activatedAt === null ? null : (
          <span className="text-[11px] text-muted-foreground">
            activated {formatRelativeTimeLabel(plan.activatedAt)}
          </span>
        )}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-[11px]"
          onClick={() => onOpenFile(plan.relativePath)}
        >
          Open
        </Button>
        {canAcknowledge ? (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="h-6 px-2 text-[11px]"
            disabled={isActivating || plan.contentHash === null}
            onClick={handleActivate}
          >
            {drifted ? "Activate new revision" : "Activate"}
          </Button>
        ) : null}
      </div>
      {drifted ? (
        <p className="mt-1.5 text-xs text-foreground">
          TRADE.md changed on disk after this revision was activated. New exposure is paused until
          the change is acknowledged — activate the new revision above, or pause the mission.
          Reducing, closing and protecting the open position stay available.
        </p>
      ) : null}
      {activationError === null ? null : (
        <p role="alert" className="mt-1.5 text-xs text-destructive">
          {activationError}
        </p>
      )}
    </section>
  );
}
