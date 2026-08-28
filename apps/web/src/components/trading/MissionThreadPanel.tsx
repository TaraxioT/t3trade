/**
 * The trading surfaces a mission-bound thread carries.
 *
 * Two mounts, deliberately separate:
 *
 * - {@link MissionThreadBanners} is chrome. The exception banners that sit with
 *   the strip above the thread, for as long as the mission is armed or exposed,
 *   so a feed or staleness warning stays on screen without hunting.
 * - {@link MissionThreadCards} is content. The mission's *events* — the result
 *   of a finished mission, an order the venue refused — render at the end of
 *   the message timeline and scroll with it.
 *
 * Nothing live is here. The position, the order about to go on and the fills
 * that made it are state, not events: they change every reconcile, and a
 * changing number parked in a scrolling log reads as a fact recorded at the
 * point you scrolled past. They are the order ledger in `ThreadMarketCard`,
 * directly below this stack and above the composer, where they update in
 * place. Saying them in both places was the same numbers twice, six inches
 * apart, with only one of them current.
 *
 * Everything here is read from the projection. These components hold no state
 * of their own and show nothing the projection does not say — there is no
 * placeholder row waiting for data that has not arrived, because a row of
 * em-dashes reads as a broken feed rather than as an absence.
 *
 * @module MissionThreadPanel
 */
import type { EnvironmentId, OrchestrationTradingMission } from "@t3tools/contracts";
import type { ReactNode } from "react";

import { useActiveEnvironmentId } from "../../state/entities";
import { Button } from "../ui/button";
import { MissionFeedErrorBanner, MissionStalenessBanner } from "./MissionStalenessBanner";
import { MissionReviewChart } from "./MissionReviewChart";
import { useMissionControls } from "./useMissionControls";
import {
  deriveCompletionSummary,
  deriveRejectedOrder,
  formatDuration,
  formatLeverage,
  formatSize,
  formatSignedUsd,
  formatUsd,
  humanizeLiteral,
  isMissionComplete,
  shouldShowMissionStrip,
  type CompletionSummary,
  type PositionLifecycle,
  type RejectedOrderNotice,
} from "./tradingPresentation";

type Tone = "profit" | "loss" | undefined;

const toneClass = (tone: Tone): string =>
  tone === "profit" ? "text-profit" : tone === "loss" ? "text-loss" : "text-foreground";

/** The tone a signed figure carries, so P&L reads as a direction. */
const pnlTone = (value: number): Tone => (value > 0 ? "profit" : value < 0 ? "loss" : undefined);

/** The shared card frame: a header row, then whatever the card reports. */
function Card({
  title,
  badge,
  meta,
  accentClassName,
  children,
}: {
  title: ReactNode;
  /** Rendered as-is, so a card can carry a tinted chip instead of plain text. */
  badge?: ReactNode;
  meta?: string | undefined;
  accentClassName?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className={`rounded-lg border bg-card/40 ${accentClassName ?? "border-border"}`}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border/60 px-3 py-2">
        <span className="text-xs font-medium text-foreground">{title}</span>
        {badge}
        {meta === undefined ? null : (
          <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">{meta}</span>
        )}
      </div>
      {children}
    </div>
  );
}

/** A two-column list of key/value rows: the intent shape from the prototype. */
function FieldRows({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-1 gap-x-8 px-3 py-1.5 sm:grid-cols-2">{children}</div>;
}

function Field({ label, value, tone }: { label: string; value: string; tone?: Tone }) {
  return (
    <div className="flex gap-3 border-b border-border/40 py-1.5 text-xs last:border-b-0">
      <span className="w-28 flex-none text-muted-foreground">{label}</span>
      <span className={`tabular-nums ${toneClass(tone)}`}>{value}</span>
    </div>
  );
}

/** The neutral chip: a card header's plain, untinted label. */
function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-full border border-border px-2 py-px text-[11px] text-muted-foreground">
      {children}
    </span>
  );
}

/**
 * What a card is about, in the one line every card carries: the market and its
 * leverage, the side of the exposure, and which half of the position's life
 * this is — `ETH 20x Long · Open`.
 *
 * The tint is the exchange's: green for the side that gains when the market
 * rises, red for the other. It is never the only signal — the chip spells the
 * direction out too, because red/green is the distinction an operator is most
 * likely to be unable to see, and on a trading surface that is the expensive
 * kind of guess.
 *
 * With no lifecycle to show (a fill recorded before the exchange's label was
 * carried), the chip goes neutral and names the order instead. An untinted
 * "Sell 0.67" is honest; tinting it red would assert a short the fill may well
 * have been closing.
 */
function LifecycleChips({
  market,
  leverage,
  lifecycle,
  fallbackDetail,
}: {
  market: string;
  /** The market's configured leverage, when the exchange has reported one. */
  leverage: number | null;
  lifecycle: PositionLifecycle | null;
  /** What to say instead when the lifecycle is unknown, e.g. "Sell 0.6729". */
  fallbackDetail: string;
}) {
  const leverageTag =
    leverage === null ? null : (
      <span className="rounded-sm bg-current/15 px-1 tabular-nums">{formatLeverage(leverage)}</span>
    );

  if (lifecycle === null) {
    return (
      <Chip>
        {market} {fallbackDetail}
      </Chip>
    );
  }

  const tone =
    lifecycle.direction === "long"
      ? "border-profit/40 bg-profit/10 text-profit"
      : "border-loss/40 bg-loss/10 text-loss";

  return (
    <>
      <span
        className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-px text-[11px] font-medium ${tone}`}
      >
        <span>{market}</span>
        {leverageTag}
        <span>{lifecycle.direction === "long" ? "Long" : "Short"}</span>
      </span>
      <Chip>{lifecycle.actionLabel}</Chip>
    </>
  );
}

/**
 * The order-rejected surface, with the affordance to re-arm (§14.7).
 *
 * Replaces {@link OrderIntentCard} when the in-flight execution was refused — a
 * rejected order must never render as a live one. Tinted loss-red because a
 * rejection is the failure shape the thread carries, and given the re-arm button
 * the plan calls for: `deriveRejectedOrder` already gates `canReArm` on the
 * mission not being blocked or revoked.
 *
 * Controls are bound here rather than threaded from the workspace panel, because
 * the timeline mounts wherever the mission's thread does — the workspace list, a
 * bound chat thread — and either way the active environment is the one that
 * sourced the mission. When no environment is active (no bound mission yet), the
 * buttons are absent and the card reads the rejection aloud instead.
 */
function OrderRejectedCard({
  notice,
  mission,
}: {
  notice: RejectedOrderNotice;
  mission: OrchestrationTradingMission;
}) {
  const environmentId = useActiveEnvironmentId();

  return (
    <Card
      title="Order rejected"
      badge={
        <LifecycleChips
          market={mission.market}
          leverage={mission.leverage ?? null}
          // A rejected order has no clean lifecycle — it never reached the book —
          // so the chip is neutral and names the order that was refused.
          lifecycle={null}
          fallbackDetail={`${humanizeLiteral(notice.actionType)} ${notice.side}`}
        />
      }
      accentClassName="border-loss/40 bg-loss/5"
    >
      <p className="px-3 py-2 text-xs text-foreground">
        The {humanizeLiteral(notice.actionType)} of {formatSize(notice.size)} ({notice.side}) was
        not accepted.
      </p>
      {/*
        Mounted only when an environment is active, so the controls hook inside
        is unconditional (rules-of-hooks) and a flat, environment-less render
        reads the rejection aloud without offering buttons it could not bind.
      */}
      {environmentId === null ? null : (
        <OrderRejectedActions notice={notice} mission={mission} environmentId={environmentId} />
      )}
    </Card>
  );
}

/** The button row for a rejected order: re-arm and cancel resting entries. */
function OrderRejectedActions({
  notice,
  mission,
  environmentId,
}: {
  notice: RejectedOrderNotice;
  mission: OrchestrationTradingMission;
  environmentId: EnvironmentId;
}) {
  // Bound per-mission so a press on one mission cannot grey out another's way
  // out, and so the busy state belongs to the mission it acts on.
  const controls = useMissionControls(mission, environmentId);

  return (
    <div className="flex flex-wrap gap-2 px-3 pb-3">
      {notice.canReArm ? (
        <Button
          size="sm"
          variant="secondary"
          disabled={controls.isBusy}
          onClick={() => controls.lifecycle("trading.mission.resume")}
        >
          Re-arm mission
        </Button>
      ) : (
        <p className="text-xs text-muted-foreground">
          The mission is blocked or revoked; re-arming needs an explicit review first.
        </p>
      )}
      <Button
        size="sm"
        variant="ghost"
        disabled={controls.isBusy}
        onClick={() => controls.risk("cancel_entries")}
      >
        Cancel resting entries
      </Button>
    </div>
  );
}

/**
 * The completion summary, as the headline card of a finished mission (§14.7).
 *
 * A finished mission's result is the thing the thread exists to report, so it
 * leads the card stack. Tinted by the net result — green for a profit, red for a
 * loss — the same convention every other P&L figure on the surface uses.
 *
 * Above the figures sits the review chart: the price series over the span the
 * trade occupied, windowed to `firstFillAt → lastFillAt` with the entry as a
 * level and the exit as a static dot. It is a one-shot read on a closed window,
 * not the live panel's 15s poll — see {@link MissionReviewChart}.
 */
function CompletionSummaryCard({ mission }: { mission: OrchestrationTradingMission }) {
  const summary: CompletionSummary = deriveCompletionSummary(mission);
  const environmentId = useActiveEnvironmentId();
  const accent =
    pnlTone(summary.netResultUsd) === "profit"
      ? "border-profit/40 bg-profit/5"
      : pnlTone(summary.netResultUsd) === "loss"
        ? "border-loss/40 bg-loss/5"
        : undefined;

  return (
    <Card
      title="Mission complete"
      meta={
        summary.tradedDurationMillis === null
          ? undefined
          : formatDuration(summary.tradedDurationMillis)
      }
      accentClassName={accent}
    >
      {environmentId === null ? null : (
        <div className="px-3 pb-2">
          <MissionReviewChart
            environmentId={environmentId}
            market={mission.market}
            firstFillAt={summary.firstFillAt}
            lastFillAt={summary.lastFillAt}
            recentFills={mission.recentFills}
            pnlSign={pnlTone(summary.netResultUsd) ?? null}
          />
        </div>
      )}
      <FieldRows>
        <Field
          label="Realized P&L"
          value={formatUsd(summary.realizedPnlUsd)}
          tone={pnlTone(summary.realizedPnlUsd)}
        />
        <Field label="Fees paid" value={formatUsd(summary.feesPaidUsd)} />
        <Field
          label="Net result"
          value={formatSignedUsd(summary.netResultUsd)}
          tone={pnlTone(summary.netResultUsd)}
        />
        <Field label="Fills" value={String(summary.fillCount)} />
        <Field
          label="Traded duration"
          value={
            summary.tradedDurationMillis === null
              ? "-"
              : formatDuration(summary.tradedDurationMillis)
          }
        />
        <Field
          label="Planned risk"
          value={summary.plannedLossUsd === null ? "-" : formatUsd(summary.plannedLossUsd)}
        />
        <Field
          label="Versus plan"
          value={
            summary.deviationFromPlanUsd === null
              ? "-"
              : formatSignedUsd(summary.deviationFromPlanUsd)
          }
          tone={
            summary.deviationFromPlanUsd === null
              ? undefined
              : pnlTone(summary.deviationFromPlanUsd)
          }
        />
      </FieldRows>
    </Card>
  );
}

/**
 * The exception banners that sit above the thread (§14.7).
 *
 * Renders nothing at all once the mission is settled: with no exposure to
 * unwind and no watch to report, there is nothing to flag.
 *
 * The two banners sit with the strip rather than with the cards below, because
 * both say the same kind of thing the strip does — something about this mission
 * needs attention right now — and both must stay on screen when the timeline
 * has scrolled away from the cards.
 */
export function MissionThreadBanners({
  mission,
  feedError,
}: {
  readonly mission: OrchestrationTradingMission;
  /** The projection poll's failure, when the feed itself has stopped. */
  readonly feedError: string | null;
}): ReactNode {
  if (!shouldShowMissionStrip(mission)) return null;

  return (
    <>
      {feedError === null ? null : <MissionFeedErrorBanner message={feedError} />}
      <MissionStalenessBanner mission={mission} />
    </>
  );
}

/**
 * The mission's own events, as the tail of the message timeline.
 *
 * What is here is what the market card above the composer cannot say: the
 * result of a finished mission, and an order the venue refused along with the
 * buttons that answer it. Both are events — they happened once and stay true —
 * and both scroll away with the conversation they belong to.
 *
 * What is deliberately NOT here is every live thing: the position, the order
 * about to go on, and the fills that made it. Those are state, one row per
 * order leg, and they are drawn in the market card directly below this stack,
 * where they update in place. Saying them in both places was the same numbers
 * twice, six inches apart, with only one of them current.
 */
export function MissionThreadCards({ mission }: { readonly mission: OrchestrationTradingMission }) {
  // A rejected order has to hold the stack up on its own: a flat mission whose
  // only event is a refusal would otherwise render nothing at all.
  const rejected = deriveRejectedOrder(mission);
  const hasCards = isMissionComplete(mission.status) || rejected !== null;

  if (!hasCards) return null;

  return (
    <div className="flex flex-col gap-2 pt-2">
      {/*
        A finished mission's result is the headline — it leads the stack so the
        thing the thread existed to report is the first thing read.
      */}
      {isMissionComplete(mission.status) && <CompletionSummaryCard mission={mission} />}
      {rejected === null ? null : <OrderRejectedCard notice={rejected} mission={mission} />}
    </div>
  );
}
