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

import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ChartMode = "candle" | "line";

interface MissionChartModeState {
  readonly mode: ChartMode;
  readonly toggle: () => void;
}

export const useMissionChartMode = create<MissionChartModeState>()(
  persist(
    (set) => ({
      mode: "candle",
      toggle: () => set((state) => ({ mode: state.mode === "candle" ? "line" : "candle" })),
    }),
    { name: "t3-mission-chart-mode" },
  ),
);
