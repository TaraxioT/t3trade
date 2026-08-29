/**
 * Prefill, and the one thing it must never do.
 *
 * Every assertion here is about the same rule: a card affordance writes a
 * sentence and stops. Nothing is sent, no RPC is called, and whatever the
 * reader had already typed survives.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { useComposerDraftStore } from "../../composerDraftStore";
import { CardPrefillActions } from "./CardPrefillActions";
import {
  armValidationSentence,
  backtestLatestVersionSentence,
  rerunBacktestSentence,
  reviseAndRevalidateSentence,
  validateThisThesisSentence,
  validationStatusSentence,
} from "./cardPrefillSentences";
import { prefillThreadComposer } from "./composerPrefill";
import { ValidationReportCard } from "./ValidationReportCard";
import type { ValidationCard } from "./tradingValidation";

const threadRef = {
  environmentId: "env_prefill" as EnvironmentId,
  threadId: "thread_prefill" as ThreadId,
};

describe("prefillThreadComposer", () => {
  beforeEach(() => {
    useComposerDraftStore.getState().setPrompt(threadRef, "");
  });

  it("leaves the sentence in the thread's draft", () => {
    prefillThreadComposer(threadRef, validateThisThesisSentence());
    expect(useComposerDraftStore.getState().getComposerDraft(threadRef)?.prompt).toBe(
      "Validate this thesis forward on paper for the next 7 days.",
    );
  });

  it("does not throw away what the reader had already typed", () => {
    useComposerDraftStore.getState().setPrompt(threadRef, "only if it clears fees");
    prefillThreadComposer(threadRef, validateThisThesisSentence(3));
    expect(useComposerDraftStore.getState().getComposerDraft(threadRef)?.prompt).toBe(
      "only if it clears fees\n\nValidate this thesis forward on paper for the next 3 days.",
    );
  });
});

describe("card affordances", () => {
  it("renders nothing when there is no composer to write into", () => {
    // The alert feed shows the validation card on the trade home, where there
    // is no conversation behind it.
    const markup = renderToStaticMarkup(
      <CardPrefillActions
        prefill={null}
        actions={[{ label: "Validate forward on paper", sentence: validateThisThesisSentence() }]}
      />,
    );
    expect(markup).toBe("");
  });

  it("carries the sentence it would write, and no send affordance", () => {
    const markup = renderToStaticMarkup(
      <CardPrefillActions
        prefill={() => {}}
        actions={[
          { label: "Validate forward on paper", sentence: validateThisThesisSentence() },
          { label: "Rerun with a change", sentence: rerunBacktestSentence() },
        ]}
      />,
    );
    expect(markup).toContain("Validate this thesis forward on paper for the next 7 days.");
    expect(markup).toContain("Run this backtest again, with this change: ");
    expect(markup).toContain("Validate forward on paper");
    expect(markup).not.toContain("<form");
  });

  it("asks a running validation how it is doing, and a finished one to revise", () => {
    const card = (running: boolean): ValidationCard => ({
      headline: "Buy ETH 5m when RSI(14) is below 30",
      exits: ["take profit at 1.5R"],
      statusLine: running ? "Validating on paper" : "Paper validation ran its course",
      running,
      expectancy: {
        label: "Paper expectancy after fees",
        value: "+$1.20 a trade",
        tone: "positive",
      },
      stats: [],
      comparisonLabel: "Tracking the backtest",
      comparisonTone: "neutral",
      verdictReason: "within a standard error of the backtest",
      openLine: null,
      rawJson: "{}",
    });

    const armed = renderToStaticMarkup(
      <ValidationReportCard card={card(true)} prefill={() => {}} />,
    );
    expect(armed).toContain(validationStatusSentence());
    expect(armed).not.toContain(reviseAndRevalidateSentence());

    const ended = renderToStaticMarkup(
      <ValidationReportCard card={card(false)} prefill={() => {}} />,
    );
    expect(ended).toContain(reviseAndRevalidateSentence());
    expect(ended).not.toContain(validationStatusSentence());
  });

  it("names the idea a hypothesis affordance means, because a thread holds several", () => {
    const card = { title: "double EMA cross under", hypothesisId: "hyp_42" };
    expect(backtestLatestVersionSentence(card)).toBe(
      'Backtest the latest version of "double EMA cross under" (hyp_42).',
    );
    expect(armValidationSentence(card)).toBe(
      'Validate the latest version of "double EMA cross under" (hyp_42) forward on paper for the next 7 days.',
    );
  });
});
