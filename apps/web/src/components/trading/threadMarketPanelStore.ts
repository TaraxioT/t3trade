// ---------------------------------------------------------------------------
// threadMarketPanelStore
// ---------------------------------------------------------------------------
//
// Whether the companion market panel is collapsed, per thread.
//
// Per thread rather than global: a trader watching ETH in one conversation and
// reading code in another wants the panel in one and not the other, and a
// single global toggle makes the second choice undo the first.
//
// The map holds only threads the user has actually chosen for. An untouched
// thread has no entry, and the default is the caller's — open beside a wide
// chat, collapsed to a chip on a narrow one, where an open panel would take
// the screen the conversation is on. Once chosen, the choice is the choice at
// both widths: the user said what they wanted.

import { create } from "zustand";
import { persist } from "zustand/middleware";

interface ThreadMarketPanelState {
  readonly collapsedByThreadKey: Readonly<Record<string, boolean>>;
  readonly setCollapsed: (threadKey: string, collapsed: boolean) => void;
}

export const useThreadMarketPanelStore = create<ThreadMarketPanelState>()(
  persist(
    (set) => ({
      collapsedByThreadKey: {},
      setCollapsed: (threadKey, collapsed) =>
        set((state) => ({
          collapsedByThreadKey: { ...state.collapsedByThreadKey, [threadKey]: collapsed },
        })),
    }),
    { name: "t3-thread-market-panel" },
  ),
);

/** The thread's collapsed choice, or `fallback` where it has never made one. */
export function useThreadMarketPanelCollapsed(threadKey: string, fallback: boolean): boolean {
  return useThreadMarketPanelStore((state) => state.collapsedByThreadKey[threadKey] ?? fallback);
}
