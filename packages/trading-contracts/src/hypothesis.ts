/**
 * The hypothesis: an idea with an identity, a history, and an ending.
 *
 * Everything else in the research layer is an event. A backtest is a
 * measurement, a validation is a run, a plan is a claim about the next hour.
 * None of them is the idea itself, and before this there was nowhere for the
 * idea to live: a user refined a thesis three times over a week and the
 * product held three unrelated tool calls and no thread between them.
 *
 * A hypothesis is that thread. It carries a title somebody would recognise, a
 * status that says where it is in its life, and an ordered list of versions.
 * The thesis lives on the version rather than on the hypothesis, because the
 * whole point of a lineage is that version 2's numbers are not version 1's,
 * and a thesis edited in place silently reassigns every measurement ever taken
 * against it.
 *
 * ## Nothing here can trade
 *
 * Same claim the backtest and validation surfaces make, and by the same means:
 * a hypothesis is rows in three tables no execution path reads. Concluding one
 * `supported` places no order and arms nothing. Trading a supported idea is
 * the ordinary flow, said out loud by the user.
 *
 * @module TradingHypothesis
 */
import * as Schema from "effect/Schema";

import { BacktestVerdict } from "./backtest.ts";
import { ForwardComparison, ThesisValidationStatus } from "./forward.ts";
import { describeThesis, TradingThesis } from "./thesis.ts";

/**
 * Where an idea is in its life.
 *
 * `exploring` is written down and untested. `testing` is anything with a run
 * or a validation against it. `supported` and `unsupported` are conclusions,
 * and both are results: an idea proven wrong is the cheapest thing this
 * product can give you. `shelved` is put down without a verdict, which happens
 * far more often than either conclusion and deserves a word of its own rather
 * than being filed as a failure.
 */
export const HypothesisStatus = Schema.Literals([
  "exploring",
  "testing",
  "supported",
  "unsupported",
  "shelved",
]);
export type HypothesisStatus = typeof HypothesisStatus.Type;

/** The two conclusions. Shelving is not one of them; it is the absence of one. */
export const HypothesisConclusionStatus = Schema.Literals(["supported", "unsupported"]);
export type HypothesisConclusionStatus = typeof HypothesisConclusionStatus.Type;

/**
 * Who wrote a version.
 *
 * `user` exists for a surface that can genuinely attribute one. A tool call is
 * not such a surface: a chat turn the user started is still the model emitting
 * the arguments, so every version written through `trading_hypothesis` is
 * `agent`. See the handler's note.
 */
export const HypothesisAuthor = Schema.Literals(["user", "agent"]);
export type HypothesisAuthor = typeof HypothesisAuthor.Type;

/** Titles longer than this are a paragraph wearing a title's clothes. */
export const HYPOTHESIS_TITLE_MAX_CHARS = 120;

/** A revision note, and a conclusion, are one sentence each. */
export const HYPOTHESIS_NOTE_MAX_CHARS = 400;

/**
 * How much of a hypothesis's history `show` serves.
 *
 * The result is exempt from tool-result summarization, which is only honest
 * while the payload cannot grow without bound. Versions and runs both can, so
 * both are capped at the newest ten; validations cannot, because one market
 * and interval holds one at a time. The card says when it is looking at a
 * window rather than the whole history.
 */
export const HYPOTHESIS_SHOW_VERSIONS = 10;
export const HYPOTHESIS_SHOW_RUNS = 10;

/** How many hypotheses a `list` returns, newest first. */
export const HYPOTHESIS_LIST_LIMIT = 25;

export const HypothesisVersion = Schema.Struct({
  version: Schema.Number,
  thesis: TradingThesis,
  /** Why this version exists, in the words of whoever wrote it. */
  note: Schema.String,
  author: HypothesisAuthor,
  createdAt: Schema.Number,
});
export type HypothesisVersion = typeof HypothesisVersion.Type;

/**
 * One persisted backtest, as the card reads it.
 *
 * The headline numbers rather than the whole report: a hypothesis with ten
 * runs would otherwise carry ten full reports, and the run the reader wants in
 * full is one `trading_backtest` call away.
 */
export const HypothesisRunSummary = Schema.Struct({
  runId: Schema.String,
  /** Null on a run taken before the idea was filed, or against no version. */
  version: Schema.NullOr(Schema.Number),
  market: Schema.String,
  interval: Schema.String,
  createdAt: Schema.Number,
  expectancyUsd: Schema.Number,
  tradesTaken: Schema.Number,
  winRatePercent: Schema.Number,
  maxDrawdownUsd: Schema.Number,
  totalNetUsd: Schema.Number,
  barsServed: Schema.Number,
  verdict: BacktestVerdict,
});
export type HypothesisRunSummary = typeof HypothesisRunSummary.Type;

/** One linked forward validation, at the size a card needs. */
export const HypothesisValidationSummary = Schema.Struct({
  validationId: Schema.String,
  version: Schema.NullOr(Schema.Number),
  market: Schema.String,
  interval: Schema.String,
  status: ThesisValidationStatus,
  armedAt: Schema.Number,
  expiresAt: Schema.Number,
  endedAt: Schema.NullOr(Schema.Number),
  tradesTaken: Schema.Number,
  expectancyUsd: Schema.Number,
  comparison: ForwardComparison,
});
export type HypothesisValidationSummary = typeof HypothesisValidationSummary.Type;

/** One line per idea, for the list. */
export const HypothesisSummary = Schema.Struct({
  hypothesisId: Schema.String,
  title: Schema.String,
  status: HypothesisStatus,
  currentVersion: Schema.Number,
  /** The current version's thesis as one line, so a list reads as English. */
  headline: Schema.String,
  conclusion: Schema.NullOr(Schema.String),
  updatedAt: Schema.Number,
});
export type HypothesisSummary = typeof HypothesisSummary.Type;

export const HypothesisDetail = Schema.Struct({
  hypothesisId: Schema.String,
  threadId: Schema.String,
  title: Schema.String,
  status: HypothesisStatus,
  conclusion: Schema.NullOr(Schema.String),
  currentVersion: Schema.Number,
  /** The current version's thesis, so a card needs no lookup to render it. */
  thesis: TradingThesis,
  /** The reason the current version exists. */
  currentNote: Schema.String,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  /** Newest first, capped at {@link HYPOTHESIS_SHOW_VERSIONS}. */
  versions: Schema.Array(HypothesisVersion),
  /** Newest first, capped at {@link HYPOTHESIS_SHOW_RUNS}. */
  runs: Schema.Array(HypothesisRunSummary),
  validations: Schema.Array(HypothesisValidationSummary),
  /** Total counts, so a capped list can say what it is a window onto. */
  versionCount: Schema.Number,
  runCount: Schema.Number,
});
export type HypothesisDetail = typeof HypothesisDetail.Type;

/**
 * The same thesis, whatever order the keys arrived in.
 *
 * A run is stamped with a version only when the thesis it measured IS that
 * version's, so this has to say yes to two objects that differ by key order or
 * by an optional field written as `undefined` rather than left out - both of
 * which happen routinely between a model's tool arguments and a decoded row -
 * and no to any real difference, however small. Sorting keys and dropping
 * undefined does exactly that, and a change of one comparator or one period
 * still reads as a different thesis.
 */
const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object" && value !== null) {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (source[key] === undefined) continue;
      out[key] = canonical(source[key]);
    }
    return out;
  }
  return value;
};

/** Whether two theses are the same idea, character for character once ordered. */
export const thesesMatch = (left: TradingThesis, right: TradingThesis): boolean =>
  JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));

// ---------------------------------------------------------------------------
// prose
// ---------------------------------------------------------------------------

const STATUS_PROSE: Readonly<Record<HypothesisStatus, string>> = {
  exploring: "Exploring",
  testing: "Testing",
  supported: "Supported",
  unsupported: "Not supported",
  shelved: "Shelved",
};

/** The status in the words a card shows, never the token. */
export const describeHypothesisStatus = (status: HypothesisStatus): string =>
  STATUS_PROSE[status] ?? "Exploring";

/** The one line a list row or a card heading uses under the title. */
export const describeHypothesis = (input: {
  readonly thesis: TradingThesis;
  readonly currentVersion: number;
  readonly status: HypothesisStatus;
}): string =>
  `${describeHypothesisStatus(input.status)} · v${input.currentVersion} · ${describeThesis(input.thesis)}`;

// ---------------------------------------------------------------------------
// the tool surface
// ---------------------------------------------------------------------------

export const TRADING_HYPOTHESIS_TOOL = "trading_hypothesis";

/**
 * One tool for the whole life of an idea, for the reason every other lifecycle
 * tool here is one tool: six verbs as six tools would cost six descriptions in
 * every turn's system prompt, and the vocabulary is served to the one call
 * that asks for it. An empty call returns the menu.
 */
export const TradingHypothesisAction = Schema.Literals([
  "save",
  "revise",
  "list",
  "show",
  "shelve",
  "conclude",
]);
export type TradingHypothesisAction = typeof TradingHypothesisAction.Type;

export const TradingHypothesisInput = Schema.Struct({
  /** Attribution, never authority. A hypothesis takes no mission state. */
  missionId: Schema.optional(Schema.String),
  action: Schema.optional(TradingHypothesisAction),
  /** Required by everything except `save` and `list`. */
  hypothesisId: Schema.optional(Schema.String),
  /** Required by `save`. */
  title: Schema.optional(Schema.String),
  /** Required by `save` and `revise`; the shape `trading_backtest` takes. */
  thesis: Schema.optional(TradingThesis),
  /** Why this version exists. Required by `revise`. */
  note: Schema.optional(Schema.String),
  /** Required by `conclude`. */
  verdict: Schema.optional(HypothesisConclusionStatus),
  /** One sentence saying why. Required by `conclude`, optional on `shelve`. */
  conclusion: Schema.optional(Schema.String),
  /** `list` defaults to this thread's ideas; `all` is every one on the box. */
  scope: Schema.optional(Schema.Literals(["thread", "all"])),
});
export type TradingHypothesisInput = typeof TradingHypothesisInput.Type;

export const TradingHypothesisResult = Schema.Struct({
  /** Set by `save`, `revise`, `show`, `shelve` and `conclude`. */
  hypothesis: Schema.optional(HypothesisDetail),
  /** Set by `list`. */
  hypotheses: Schema.optional(Schema.Array(HypothesisSummary)),
  /** What the call did, in one sentence the model can relay. */
  outcome: Schema.optional(Schema.String),
  /** Why a call changed nothing. Present only on a refusal. */
  refused: Schema.optional(Schema.String),
  /** The vocabulary, when this call was the menu call. */
  menu: Schema.optional(Schema.String),
});
export type TradingHypothesisResult = typeof TradingHypothesisResult.Type;

/** The vocabulary, served to the call that asked rather than to every turn. */
export function renderTradingHypothesisMenu(): string {
  return [
    "save {title, thesis} files an idea as version 1; thesis is trading_backtest's shape",
    "revise {hypothesisId, thesis, note} writes the next version and reopens a concluded or shelved idea",
    "show {hypothesisId} gives the versions, every backtest run against them, and every linked validation",
    "list {scope: thread|all}; shelve {hypothesisId, conclusion?}; conclude {hypothesisId, verdict: supported|unsupported, conclusion}",
    "pass hypothesisId alone to trading_backtest or to trading_validate arm and it runs that idea's current version, filed against it; restating the thesis is allowed but has to match that version",
    "arming a second validation for the SAME hypothesis on one market and interval supersedes the first; a different idea's still refuses",
    "nothing here places an order; a supported idea is traded the ordinary way, when the user says so",
  ].join(" · ");
}
