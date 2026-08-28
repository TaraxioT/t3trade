/**
 * How a refusal reads in the alert feed.
 *
 * The feed is read by the person whose order did not go on, and the server's
 * `reason` is a rule name: `stop_on_wrong_side` tells the code which gate
 * fired and tells the trader nothing. The rule name still travels, on the
 * alert's payload and in the warn line, which is where a rule name earns its
 * place; the summary carries the detail the rule already wrote, capitalized so
 * it reads as the sentence it is. The manual ticket applies the same rule to a
 * refused preview, so the two surfaces say a refusal the same way.
 *
 * @module alertProse
 */

/** A detail as its own sentence: trimmed and capitalized, or empty. */
export const asSentence = (detail: string): string => {
  const trimmed = detail.trim();
  if (trimmed === "") return "";
  return trimmed[0]!.toUpperCase() + trimmed.slice(1);
};

/** Every stage an execution can fail at, as the stages the feed can name. */
export type ExecutionStage =
  | "signer_not_configured"
  | "market_unresolved"
  | "preview_rejected"
  | "order_mapping_failed"
  | "persist_failed"
  | "sign_failed"
  | "submit_failed"
  | "inspect_failed"
  | "missing_stop"
  | "intent_invalid";

/**
 * What a stage means, for the one case that has no detail to show.
 *
 * The gateway usually supplies a detail and the summary shows that instead.
 * This is what the summary says when it does not, so a failed order never
 * reports itself as `submit_failed`.
 */
export const EXECUTION_STAGE_PROSE: Record<ExecutionStage, string> = {
  signer_not_configured: "This environment has no trading signer configured.",
  market_unresolved: "The venue did not resolve that market.",
  preview_rejected: "The pre-trade check rejected the order.",
  order_mapping_failed: "The order could not be put in the venue's own terms.",
  persist_failed: "The order could not be recorded before it went out.",
  sign_failed: "The order could not be signed.",
  submit_failed: "The venue did not accept the order.",
  inspect_failed: "The venue accepted the order but its response could not be read.",
  missing_stop: "The order had no protective stop, so it was not sent.",
  intent_invalid: "The order was malformed and was not sent.",
};

/**
 * The alert summary for a manual order that was refused or failed.
 *
 * One shape for both halves of the manual path: the refusal the checklist
 * writes before anything is sent, and the failure the venue answers with.
 */
export const manualOrderAlertSummary = (input: {
  readonly side: string;
  readonly market: string;
  readonly outcome: "refused" | "failed";
  readonly detail: string | undefined;
  /** Used only when `detail` says nothing, which only a failure can. */
  readonly stage?: ExecutionStage | undefined;
}): string => {
  const sentence = asSentence(input.detail ?? "");
  const fallback = input.stage === undefined ? "" : EXECUTION_STAGE_PROSE[input.stage];
  const body = sentence === "" ? fallback : sentence;
  const head = `Manual ${input.side} ${input.market} ${input.outcome}.`;
  return body === "" ? head : `${head} ${body}`;
};
