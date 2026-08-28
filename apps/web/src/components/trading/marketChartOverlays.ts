/**
 * The market chart's honest-coverage overlays (final-form phase 6), as pure
 * time/price arithmetic so the shading rules are testable without an SVG.
 *
 * Two kinds of overlay ride on the missionless market chart: session-level
 * rules (prior-day H/L/C, today's O/H/L, VWAP) and coverage shading (the
 * stretches of the drawn window the archive never recorded). Both are derived
 * here from the chart response's own fields; the renderer only maps the
 * results through the geometry's `xForTime`/`yForPrice`.
 *
 * @module marketChartOverlays
 */
import type { TradingChartGap, TradingChartSessionLevels } from "@t3tools/contracts";

/** One horizontal session rule: where it sits and the short label it carries. */
export interface SessionLevelLine {
  readonly key: string;
  readonly label: string;
  readonly price: number;
}

/**
 * The session levels that can honestly be drawn: present in the response and
 * inside the price domain. A level outside the domain is dropped rather than
 * clamped — a "prior day high" pinned to the frame edge at the wrong price
 * would label a rule with a number it does not sit at.
 */
export function sessionLevelLines(
  levels: TradingChartSessionLevels | undefined,
  domainMin: number,
  domainMax: number,
): ReadonlyArray<SessionLevelLine> {
  if (levels === undefined) return [];
  const candidates: ReadonlyArray<readonly [string, string, number | undefined]> = [
    ["pdh", "pd hi", levels.priorDayHigh],
    ["pdl", "pd lo", levels.priorDayLow],
    ["pdc", "pd cl", levels.priorDayClose],
    ["do", "d op", levels.todayOpen],
    ["dh", "d hi", levels.todayHigh],
    ["dl", "d lo", levels.todayLow],
    ["vwap", "vwap", levels.vwap],
  ];
  const lines: Array<SessionLevelLine> = [];
  for (const [key, label, price] of candidates) {
    if (price === undefined) continue;
    if (price < domainMin || price > domainMax) continue;
    lines.push({ key, label, price });
  }
  return lines;
}

/**
 * How far apart two session labels must sit, in viewBox-height units.
 *
 * A label is one line of 9px text; on the ~160-unit viewBox the chart renders
 * at, eight units is a little over one line — the same arithmetic the price
 * gutter's `GUTTER_LABEL_MIN_SEPARATION` uses for its two-line tags.
 */
export const SESSION_LABEL_MIN_SEPARATION = 8;

/**
 * Hold the session labels apart vertically, the way the price gutter holds
 * its tags apart (`layoutGutterLabels`), only simpler: every label has the
 * same priority, so a forward sweep pushes overlaps down and a backward sweep
 * pulls the tail back inside the frame. The rule keeps its true y; only the
 * label moves. Returns each label's y, keyed by the line's `key`.
 *
 * Two levels at nearly the same price ("open 81.18" on "vwap 81.14") are the
 * common case this exists for — without it the two labels print on top of
 * each other and read as one garbled number.
 */
export function layoutSessionLabelYs(
  labels: ReadonlyArray<{ readonly key: string; readonly y: number }>,
  frameHeight: number,
): ReadonlyMap<string, number> {
  const placed = labels
    .map((label) => ({ key: label.key, labelY: label.y }))
    .sort((a, b) => a.labelY - b.labelY);
  // The label hangs below its anchor, so the bottom inset clears one line and
  // the top needs none.
  const bottom = frameHeight - SESSION_LABEL_MIN_SEPARATION;
  for (let i = 1; i < placed.length; i += 1) {
    const previous = placed[i - 1]!;
    const current = placed[i]!;
    current.labelY = Math.max(current.labelY, previous.labelY + SESSION_LABEL_MIN_SEPARATION);
  }
  const last = placed[placed.length - 1];
  if (last !== undefined) last.labelY = Math.min(last.labelY, bottom);
  for (let i = placed.length - 2; i >= 0; i -= 1) {
    const next = placed[i + 1]!;
    const current = placed[i]!;
    current.labelY = Math.min(current.labelY, next.labelY - SESSION_LABEL_MIN_SEPARATION);
  }
  for (const label of placed) {
    label.labelY = Math.max(label.labelY, 0);
  }
  return new Map(placed.map((label) => [label.key, label.labelY]));
}

/** One shaded stretch of the time axis, clipped to the drawn window. */
export interface CoverageBand {
  readonly key: string;
  readonly fromT: number;
  readonly toT: number;
  /** Why it is shaded — before recording started, or a known gap inside it. */
  readonly kind: "before_recording" | "gap";
}

/**
 * Everything in `[timeStart, timeEnd]` the archive does not vouch for.
 *
 * Two sources: the head of the window before `recordingSince` (recording that
 * started yesterday must not read as a market that started yesterday), and
 * the archive's own known-gap records. Bands are clipped to the window and
 * empty or inverted stretches are dropped. When the series was served live
 * from the exchange (`recordingSince` undefined but bars drawn anyway) there
 * is nothing to shade — the exchange's series has no recorded gaps to know.
 */
export function coverageBands(input: {
  readonly gaps: ReadonlyArray<TradingChartGap> | undefined;
  readonly recordingSince: number | undefined;
  readonly timeStart: number;
  readonly timeEnd: number;
}): ReadonlyArray<CoverageBand> {
  const { gaps, recordingSince, timeStart, timeEnd } = input;
  if (timeEnd <= timeStart) return [];
  const bands: Array<CoverageBand> = [];
  if (recordingSince !== undefined && recordingSince > timeStart) {
    bands.push({
      key: "before-recording",
      fromT: timeStart,
      toT: Math.min(recordingSince, timeEnd),
      kind: "before_recording",
    });
  }
  for (const gap of gaps ?? []) {
    const fromT = Math.max(gap.fromT, timeStart);
    const toT = Math.min(gap.toT, timeEnd);
    if (toT <= fromT) continue;
    bands.push({ key: `gap-${gap.fromT}`, fromT, toT, kind: "gap" });
  }
  return bands;
}
