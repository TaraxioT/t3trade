// ---------------------------------------------------------------------------
// missionChartModeStore
// ---------------------------------------------------------------------------
//
// The chart's one display preference: whether the price series is drawn as
// candles or as a close line (final-form phase 6). One store rather than
// per-chart state so the live panel and the review chart read the same way,
// and persisted so the choice survives a reload.
//
// Candles are the default on purpose: the phase's goal is a chart readable as
// a real trading chart, and the bar a wick took a stop out on is invisible in
// a line of closes. The line is the toggle's second reading.
//
// The EMA pair is the other thing drawn over the price, and it is the one
// overlay a trader argues with: the strategy's own cross reads off it, and a
// trader who does not run that strategy wants the price alone. It is on by
// default, off is one click, and off means the lines and their legend are not
// drawn at all rather than drawn transparent.

import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ChartMode = "candle" | "line";

interface MissionChartModeState {
  readonly mode: ChartMode;
  readonly toggle: () => void;
  /** Whether the fast/slow EMA overlay is drawn over the candles. */
  readonly showEma: boolean;
  readonly toggleEma: () => void;
}

export const useMissionChartMode = create<MissionChartModeState>()(
  persist(
    (set) => ({
      mode: "candle",
      toggle: () => set((state) => ({ mode: state.mode === "candle" ? "line" : "candle" })),
      showEma: true,
      toggleEma: () => set((state) => ({ showEma: !state.showEma })),
    }),
    { name: "t3-mission-chart-mode" },
  ),
);
