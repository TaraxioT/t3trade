import type { PersistedWatch, TradingMissionStatus } from "@t3tools/trading-contracts";

import {
  MISSION_STATUS_LABELS,
  describeWatch,
  formatPrice,
  formatSignedUsd,
  formatSize,
  formatUsd,
  humanizeLiteral,
} from "./tradingFormat";
// ---------------------------------------------------------------------------
// §14.7 risk chrome
// ---------------------------------------------------------------------------
//
// Every surface below is DERIVED from the mission projection. None of them
// hold state of their own, and none of them can show something the projection
// does not say — which is what makes "renders from projections in its driving
// state" checkable rather than aspirational.

/** Statuses in which a mission is armed or exposed and the strip must show. */
const ARMED_OR_EXPOSED: ReadonlySet<TradingMissionStatus> = new Set<TradingMissionStatus>([
  "executing",
  "position_open",
  "waiting",
  "analysing",
  "paused",
  "blocked",
]);

/** The strip's state dot, matched to how urgent the mission's state is. */
export type MissionStripTone = "exposed" | "armed" | "paused" | "blocked";

/** The persistent mission strip (§14.7 risk chrome). */
export interface MissionStrip {
  readonly tone: MissionStripTone;
  readonly stateLabel: string;
  /** The market the mission trades, as the exchange names it. */
  readonly marketLabel: string;
  /**
   * What the market is doing right now, whether or not anything is held.
   *
   * The strip used to name a level the mission was waiting for with no way to
   * tell how far away it was — "waiting for a close below 1868" reads very
   * differently at 1869 than at 1890. Null when the exchange read failed; the
   * slot then disappears rather than showing a price nothing confirmed.
   */
  readonly markLabel: string | null;
  /**
   * What the mission is holding, or what it is waiting for. Exposure reads back
   * the fill; a flat mission reads back its armed watch, because the watch is
   * the only thing that can move it — a flat mission with no active watch is
   * saying something worth reading.
   */
  readonly detailPrimary: string;
  /** Live P&L and protection while exposed; null when there is nothing held. */
  readonly detailSecondary: string | null;
  /** The immutable §10.2 harness binding: which provider owns this mission. */
  readonly harnessLabel: string;
  /** Signed exposure in base units; zero when flat. */
  readonly exposure: number;
  readonly exposureLabel: string;
  /**
   * The most the mission can still lose: the authority's cumulative-loss
   * ceiling. The strip shows the ceiling rather than a live remaining figure
   * because the projection carries the ceiling, and a number the projection
   * cannot back would be a guess.
   */
  readonly maximumLossLabel: string;
  /**
   * The one primary action. Close-and-stop is always one click while exposed
   * (§14.7); with no exposure there is nothing to close, so the primary action
   * becomes the one that stops new exposure.
   */
  readonly primaryAction: "close_and_revoke" | "pause" | "resume";
  readonly primaryActionLabel: string;
}

/** True when the strip must be on screen at all (§14.7: armed or exposed). */
export function shouldShowMissionStrip(mission: {
  readonly status: TradingMissionStatus;
  readonly position: { readonly size: number } | null;
}): boolean {
  const exposed = (mission.position?.size ?? 0) !== 0;
  return exposed || ARMED_OR_EXPOSED.has(mission.status);
}

/**
 * What a flat mission is waiting on.
 *
 * Only `active` watches can still fire; a triggered or superseded one is
 * history. With none of them the mission is deaf — it holds authority but
 * nothing will wake it — and the strip says so rather than leaving the slot
 * blank, because a blank slot reads as "fine".
 */
function describeArmedWatch(watches: ReadonlyArray<PersistedWatch>): string {
  const active = watches.find((watch) => watch.status === "active");
  return active === undefined ? "No active watch" : `Waiting on ${describeWatch(active.watch)}`;
}

/**
 * "Entry 1,833.90" — where the exposure was taken.
 *
 * The mark is not repeated here: the strip carries the live one in its own
 * slot, and two marks a few seconds apart on the same line is a contradiction
 * the operator has to stop and resolve.
 */
function describeExposure(position: { readonly entryPrice?: number | undefined }): string {
  return position.entryPrice === undefined
    ? "Position open"
    : `Entry ${formatPrice(position.entryPrice)}`;
}

/**
 * How much of the position a stop actually covers (§16.1).
 *
 * The difference between a bounded loss and an open-ended one, so the strip
 * names it rather than leaving "there is a stop somewhere" to be assumed.
 */
function describeProtection(position: {
  readonly size: number;
  readonly protectedSize: number;
}): string {
  const covered = Math.abs(position.protectedSize);
  if (covered === 0) return "Unprotected";
  return covered >= Math.abs(position.size) ? "Protected" : "Partially protected";
}

export function deriveMissionStrip(mission: {
  readonly status: TradingMissionStatus;
  readonly market: string;
  readonly marketPrice?: number | undefined;
  readonly blockedReason: string | null;
  readonly harness: { readonly provider: string; readonly status: string };
  readonly watches: ReadonlyArray<PersistedWatch>;
  readonly position: {
    readonly size: number;
    readonly entryPrice?: number | undefined;
    readonly markPrice?: number | undefined;
    readonly unrealisedPnl: number;
    readonly protectedSize: number;
  } | null;
  readonly authority: { readonly maximumCumulativeLossUsd: number };
}): MissionStrip {
  const position = mission.position;
  const exposure = position?.size ?? 0;
  const exposed = exposure !== 0;
  const markPrice = mission.marketPrice ?? position?.markPrice ?? null;

  const tone: MissionStripTone =
    mission.status === "blocked"
      ? "blocked"
      : mission.status === "paused"
        ? "paused"
        : exposed
          ? "exposed"
          : "armed";

  // While exposed, the primary action is always the way out — one click, no
  // menu. It stays primary even when the mission is blocked or paused: those
  // states stop new exposure, they do not remove the exposure already taken.
  // A spent wake budget resumes on click (Phase 8) — resume grants another
  // tranche of the same budget, so it is the one blocked reason whose primary
  // action is the way back in rather than Pause.
  const primaryAction = exposed
    ? ("close_and_revoke" as const)
    : mission.status === "paused" ||
        (mission.status === "blocked" && mission.blockedReason === "wake_budget_exhausted")
      ? ("resume" as const)
      : ("pause" as const);

  // A blocked mission's reason outranks everything else the slot could say:
  // it is the one fact that explains why nothing is happening.
  const detailPrimary =
    mission.blockedReason !== null
      ? humanizeLiteral(mission.blockedReason)
      : exposed && position !== null
        ? describeExposure(position)
        : describeArmedWatch(mission.watches);

  const detailSecondary =
    exposed && position !== null
      ? `Unrealised ${formatSignedUsd(position.unrealisedPnl)} · ${describeProtection(position)}`
      : null;

  return {
    tone,
    stateLabel: MISSION_STATUS_LABELS[mission.status],
    marketLabel: mission.market,
    // The live read is preferred over the position's mark: a flat mission has
    // no position mark at all, and an exposed one's is as old as its last
    // reconcile.
    markLabel: markPrice === null ? null : formatPrice(markPrice),
    detailPrimary,
    detailSecondary,
    harnessLabel: `${mission.harness.provider} · ${humanizeLiteral(mission.harness.status)}`,
    exposure,
    exposureLabel: exposed
      ? `${exposure > 0 ? "Long" : "Short"} ${formatSize(Math.abs(exposure))}`
      : "Flat",
    maximumLossLabel: formatUsd(mission.authority.maximumCumulativeLossUsd),
    primaryAction,
    primaryActionLabel:
      primaryAction === "close_and_revoke"
        ? "Close and stop"
        : primaryAction === "resume"
          ? "Resume"
          : "Pause",
  };
}
