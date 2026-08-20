// ---------------------------------------------------------------------------
// missionSizeUnitStore
// ---------------------------------------------------------------------------
//
// The positions card's one display preference: whether the SIZE column reads
// in USD notional or in the asset's own units (plan 39 phase 2). One store for
// the whole panel rather than per-row state, so every row switches together,
// and persisted so the choice survives a reload.
//
// USD is the default on purpose: the product realignment says consumer tool,
// and a consumer thinks in dollars. Units are the toggle's second reading.

import { create } from "zustand";
import { persist } from "zustand/middleware";

export type SizeUnit = "usd" | "units";

interface MissionSizeUnitState {
  readonly unit: SizeUnit;
  readonly toggle: () => void;
}

export const useMissionSizeUnit = create<MissionSizeUnitState>()(
  persist(
    (set) => ({
      unit: "usd",
      toggle: () => set((state) => ({ unit: state.unit === "usd" ? "units" : "usd" })),
    }),
    { name: "t3-mission-size-unit" },
  ),
);
