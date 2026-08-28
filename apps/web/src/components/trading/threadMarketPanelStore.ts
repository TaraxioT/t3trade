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
  /**
   * The market card above the composer, which collapses on its own.
   *
   * A separate map, because the two surfaces answer different questions: the
   * panel is "do I want the mission's log beside this conversation", the card
   * is "do I want the chart and my positions under it". A trader reading the
   * log while the chart is folded away is a real thing to want, and one flag
   * for both would make it impossible.
   */
  readonly cardCollapsedByThreadKey: Readonly<Record<string, boolean>>;
  readonly setCardCollapsed: (threadKey: string, collapsed: boolean) => void;
}

export const useThreadMarketPanelStore = create<ThreadMarketPanelState>()(
  persist(
    (set) => ({
      collapsedByThreadKey: {},
      setCollapsed: (threadKey, collapsed) =>
        set((state) => ({
          collapsedByThreadKey: { ...state.collapsedByThreadKey, [threadKey]: collapsed },
        })),
      cardCollapsedByThreadKey: {},
      setCardCollapsed: (threadKey, collapsed) =>
        set((state) => ({
          cardCollapsedByThreadKey: { ...state.cardCollapsedByThreadKey, [threadKey]: collapsed },
        })),
    }),
    { name: "t3-thread-market-panel" },
  ),
);

/** The thread's collapsed choice, or `fallback` where it has never made one. */
export function useThreadMarketPanelCollapsed(threadKey: string, fallback: boolean): boolean {
  return useThreadMarketPanelStore((state) => state.collapsedByThreadKey[threadKey] ?? fallback);
}

/**
 * Whether the market card above the composer is folded away.
 *
 * Expanded until the thread says otherwise: the card is the chart and the
 * position the conversation is about, and hiding that by default would make
 * the chat about a market with the market missing.
 */
export function useThreadMarketCardCollapsed(threadKey: string): boolean {
  return useThreadMarketPanelStore((state) => state.cardCollapsedByThreadKey[threadKey] ?? false);
}
