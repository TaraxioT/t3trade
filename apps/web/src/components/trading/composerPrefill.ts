/**
 * Cards ask; they never act.
 *
 * The chat-first doctrine of this fork is that a card is a rendering of
 * something the agent said, not a control surface bolted onto it. A button on
 * a backtest card that armed a validation would put a mutation behind a click
 * in a transcript, with no turn recording why it happened and nothing the user
 * could edit before it ran. So every affordance on a trading card does exactly
 * one thing: it writes a plain sentence into the composer of the thread the
 * card lives in, and stops. The user edits it, or deletes it, or presses send.
 *
 * Two write paths, because the composer is not always mounted where the card
 * is. The live composer's own handle is preferred - it is the one the user is
 * looking at, and `insertTextAtEnd` respects everything the composer knows
 * about its own state (a pending approval, a disconnected server) by refusing
 * rather than corrupting a draft. When there is no handle, or it refuses, the
 * draft store is written directly so the sentence is waiting the next time
 * that thread is opened.
 *
 * @module composerPrefill
 */
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useCallback } from "react";

import { useComposerHandleContext } from "../../composerHandleContext";
import { useComposerDraftStore } from "../../composerDraftStore";

/** Writes one sentence into a composer. Null when there is no composer to write to. */
export type ComposerPrefill = ((sentence: string) => void) | null;

/**
 * Append `sentence` to whatever the thread's stored draft already holds.
 *
 * Exported because a launch has no composer handle to reach for: the thread it
 * is prefilling has not been navigated to yet, so the store is the only place
 * the sentence can wait.
 *
 * Appending rather than replacing: the reader may have typed half a question
 * before pressing the affordance, and a card is not entitled to throw that
 * away. Two affordances pressed in a row stack into one message, which reads
 * correctly as one request.
 */
export function prefillThreadComposer(threadRef: ScopedThreadRef, sentence: string): void {
  const store = useComposerDraftStore.getState();
  const existing = store.getComposerDraft(threadRef)?.prompt ?? "";
  const next = existing.trim().length === 0 ? sentence : `${existing.trimEnd()}\n\n${sentence}`;
  store.setPrompt(threadRef, next);
}

/**
 * The prefill writer for the thread a card lives in.
 *
 * Returns null when the card has no thread behind it - the alert feed renders
 * the validation card on the trade home, where there is no conversation to put
 * a sentence into - and callers hide their affordances rather than rendering a
 * button that does nothing.
 */
export function useComposerPrefill(threadRef: ScopedThreadRef | null): ComposerPrefill {
  const composerRef = useComposerHandleContext();
  const write = useCallback(
    (sentence: string) => {
      if (threadRef === null) return;
      const inserted =
        composerRef?.current?.insertTextAtEnd(sentence, { ensureLeadingBoundary: true }) ?? false;
      if (inserted) return;
      prefillThreadComposer(threadRef, sentence);
    },
    [composerRef, threadRef],
  );
  return threadRef === null ? null : write;
}
