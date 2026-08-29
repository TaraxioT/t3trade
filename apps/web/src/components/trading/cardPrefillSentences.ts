/**
 * What each card affordance writes into the composer.
 *
 * Kept as pure functions in their own module so the sentences are testable
 * without a React tree, and so the wording lives in one place rather than
 * being spelled slightly differently on three cards.
 *
 * Two rules shape them. They are written as the USER would write them, because
 * that is who is about to press send. And they name an id only where ambiguity
 * is real: a backtest card sits directly under the run it reports, so "this
 * thesis" resolves, while a thread may hold several ideas at once, so a
 * hypothesis affordance names the idea it means.
 *
 * @module cardPrefillSentences
 */

/** How long a first forward validation runs, when the user does not say. */
export const DEFAULT_VALIDATION_DAYS = 7;

/** Backtest card: take this thesis forward on paper. */
export function validateThisThesisSentence(days = DEFAULT_VALIDATION_DAYS): string {
  return `Validate this thesis forward on paper for the next ${days} days.`;
}

/**
 * Backtest card: run it again with something changed.
 *
 * Ends open on purpose. The change is the user's to type, and a sentence that
 * guessed at one would be a worse starting point than a blank.
 */
export function rerunBacktestSentence(): string {
  return "Run this backtest again, with this change: ";
}

/** Validation card, still running: how is it doing? */
export function validationStatusSentence(): string {
  return "How is this paper validation doing so far, and is it still tracking the backtest?";
}

/** Validation card, ended: sharpen it and go again. */
export function reviseAndRevalidateSentence(): string {
  return "Revise this thesis based on what the paper run showed, then validate the new version forward again.";
}

/** Hypothesis card: measure the newest version. */
export function backtestLatestVersionSentence(input: {
  readonly title: string;
  readonly hypothesisId: string;
}): string {
  return `Backtest the latest version of "${input.title}" (${input.hypothesisId}).`;
}

/** Hypothesis card: put the newest version on paper. */
export function armValidationSentence(input: {
  readonly title: string;
  readonly hypothesisId: string;
  readonly days?: number;
}): string {
  const days = input.days ?? DEFAULT_VALIDATION_DAYS;
  return `Validate the latest version of "${input.title}" (${input.hypothesisId}) forward on paper for the next ${days} days.`;
}
