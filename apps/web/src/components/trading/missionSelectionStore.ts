// ---------------------------------------------------------------------------
// missionSelectionStore
// ---------------------------------------------------------------------------
//
// The one shared selection model between the chart and the panel's timeline
// (plan 3: "one shared selection model"). Holds exactly what the brief asks
// for — a selected event id — plus the moment it happened at, because the
// join between a timeline row and a chart tick is a time, not an id: the
// chart's markers are keyed off the geometry while the rows are keyed off
// persisted watch ids, and neither namespace can name the other.
//
// `source` says which side set the selection, so a surface can ignore the
// echoes of its own hover without subscribing to a second store.

import { create } from "zustand";

export interface ChartEventSelection {
  /** The selected event's id, in whichever namespace set it. */
  readonly eventId: string;
  /** Epoch millis — the moment the event happened (or will, for a chip). */
  readonly atMillis: number;
  /** Which surface set the selection last. */
  readonly source: "chart" | "panel";
}

interface MissionSelectionState {
  readonly selected: ChartEventSelection | null;
  readonly select: (selection: ChartEventSelection) => void;
  readonly clear: (source: "chart" | "panel") => void;
}

export const useMissionSelection = create<MissionSelectionState>((set) => ({
  selected: null,
  select: (selection) => set({ selected: selection }),
  // Clearing is source-scoped: the chart firing mouseleave must not wipe a
  // selection the panel just set, or hovering a card would flicker the chart
  // the moment the pointer crossed a marker on the way there.
  clear: (source) =>
    set((state) => (state.selected?.source === source ? { selected: null } : state)),
}));

/**
 * Whether a chart moment matches the selection, within the tolerance two
 * clocks that read the same event can drift apart. Wakes are recorded to the
 * millisecond by the same server that arms the watch, but a watch that fired
 * "at" the wake settles a poll later, so the join needs a little slack.
 */
export const isMomentSelected = (
  selection: ChartEventSelection | null,
  atMillis: number,
  toleranceMillis = 2_000,
): boolean => selection !== null && Math.abs(selection.atMillis - atMillis) <= toleranceMillis;
