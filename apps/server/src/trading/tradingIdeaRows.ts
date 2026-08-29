/**
 * What the trade home's ideas panel is a list of.
 *
 * Two things belong on it and they are not the same thing: a forward
 * validation is a run on the clock, and a hypothesis in `testing` is a filed
 * idea whose runs have all finished. The panel answers one question - what am
 * I currently testing - so both are rows in one list, and the selection rule
 * below is the whole difference between them.
 *
 * A hypothesis with a live run contributes NO row of its own. The run is the
 * more specific fact (it has a clock, a sample and a verdict), and two rows for
 * one idea would read as two ideas. So the validations claim their hypotheses
 * first and only the unclaimed ones fall through.
 *
 * Pure and database-free on purpose: the selection is the part worth pinning,
 * and it is testable without a schema. The caller reads the ledger for the
 * rows this returns and no others, which is what keeps a doorbell-driven read
 * from composing a report per validation that ever existed.
 *
 * @module tradingIdeaRows
 */
import type { ThreadId, TradingIdeaRow } from "@t3tools/contracts";
import type { ForwardReport } from "@t3tools/trading-contracts/forward";

/** A row before its paper ledger is read: identity, market, and sort order. */
export interface IdeaCandidate {
  readonly kind: "validation" | "hypothesis";
  readonly id: string;
  readonly title: string;
  readonly market: string;
  readonly interval: string;
  readonly status: "armed" | "paused" | "testing";
  readonly threadId: string | null;
  readonly hypothesisId: string | null;
  /** The validation this row's figures come from. Same as `id` for a run. */
  readonly reportValidationId: string;
  /** Newest first is by this. A run sorts by when it armed. */
  readonly sortAt: number;
}

/** The shape of a validation this module reads. A subset of `ThesisValidation`. */
export interface IdeaValidationInput {
  readonly id: string;
  readonly threadId: string | null;
  readonly asset: string;
  readonly interval: string;
  readonly label: string | null;
  readonly headline: string;
  readonly status: "armed" | "paused" | "ended";
  readonly armedAt: number;
  readonly hypothesisId: string | null;
}

/** The shape of a hypothesis this module reads. A subset of `HypothesisSummary`. */
export interface IdeaHypothesisInput {
  readonly hypothesisId: string;
  readonly title: string;
  readonly status: string;
  readonly updatedAt: number;
}

/**
 * Which ideas the panel shows, newest first, capped.
 *
 * A hypothesis row borrows its market, interval and figures from that idea's
 * newest validation, ended or not. Without one there is nothing to say beyond
 * a title, so the idea is left off rather than rendered as a row of dashes -
 * it is in `testing` because a run existed, and an idea whose run cannot be
 * found is a database in a state this panel should not narrate.
 */
export function selectIdeaCandidates(input: {
  readonly validations: ReadonlyArray<IdeaValidationInput>;
  readonly hypotheses: ReadonlyArray<IdeaHypothesisInput>;
  readonly cap: number;
}): ReadonlyArray<IdeaCandidate> {
  const live = input.validations.filter(
    (validation) => validation.status === "armed" || validation.status === "paused",
  );
  const claimed = new Set(
    live
      .map((validation) => validation.hypothesisId)
      .filter((id): id is string => id !== null && id.length > 0),
  );

  const candidates: Array<IdeaCandidate> = live.map((validation) => ({
    kind: "validation",
    id: validation.id,
    title: validation.label ?? validation.headline,
    market: validation.asset,
    interval: validation.interval,
    status: validation.status as "armed" | "paused",
    threadId: validation.threadId,
    hypothesisId: validation.hypothesisId,
    reportValidationId: validation.id,
    sortAt: validation.armedAt,
  }));

  // The newest validation per hypothesis, live or ended - what a testing idea
  // with no run on the clock is described by.
  const newestByHypothesis = new Map<string, IdeaValidationInput>();
  for (const validation of input.validations) {
    const key = validation.hypothesisId;
    if (key === null || key.length === 0) continue;
    const held = newestByHypothesis.get(key);
    if (held === undefined || validation.armedAt > held.armedAt) {
      newestByHypothesis.set(key, validation);
    }
  }

  for (const hypothesis of input.hypotheses) {
    if (hypothesis.status !== "testing") continue;
    if (claimed.has(hypothesis.hypothesisId)) continue;
    const newest = newestByHypothesis.get(hypothesis.hypothesisId);
    if (newest === undefined) continue;
    candidates.push({
      kind: "hypothesis",
      id: hypothesis.hypothesisId,
      title: hypothesis.title,
      market: newest.asset,
      interval: newest.interval,
      status: "testing",
      threadId: newest.threadId,
      hypothesisId: hypothesis.hypothesisId,
      reportValidationId: newest.id,
      sortAt: newest.armedAt,
    });
  }

  return candidates
    .sort((left, right) => right.sortAt - left.sortAt)
    .slice(0, Math.max(0, input.cap));
}

/**
 * A candidate plus its paper ledger, as the wire row.
 *
 * `expiresAt` is null on a hypothesis row: its runs have ended, so there is no
 * clock left to count down and sending the ended run's expiry would put a
 * deadline on a row that has none. A missing report leaves the figures empty
 * rather than zeroed - nought trades and $0.00 expectancy are two different
 * claims, and only one of them is true when the ledger could not be read.
 */
export function toIdeaRow(candidate: IdeaCandidate, report: ForwardReport | null): TradingIdeaRow {
  return {
    kind: candidate.kind,
    id: candidate.id,
    title: candidate.title,
    market: candidate.market,
    interval: candidate.interval as TradingIdeaRow["interval"],
    status: candidate.status,
    expectancyUsd:
      report === null || report.stats.tradesTaken === 0 ? null : report.stats.expectancyUsd,
    trades: report?.stats.tradesTaken ?? 0,
    expiresAt: candidate.kind === "validation" ? (report?.expiresAt ?? null) : null,
    comparison: report?.comparison ?? "too_few_trades",
    // Branded at the wire boundary rather than through the service: the
    // validation store holds the thread as a plain column, and the brand is a
    // claim the contract makes, not one the table can.
    threadId: candidate.threadId as ThreadId | null,
    hypothesisId: candidate.hypothesisId,
  };
}
