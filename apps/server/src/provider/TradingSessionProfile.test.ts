// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as NodeFSP from "node:fs/promises";

import { TRADING_BACKTEST_TOOL } from "@t3tools/trading-contracts/backtest";
import { TRADING_VALIDATE_TOOL } from "@t3tools/trading-contracts/forward";
import { TRADING_HYPOTHESIS_TOOL } from "@t3tools/trading-contracts/hypothesis";

import { TradingToolkit } from "../mcp/toolkits/trading/tools.ts";
import { clearAllSessionProfiles, setSessionProfile } from "./SessionProfile.ts";
import {
  applyTradingTurnContract,
  resetTradingContractDelivery,
  TRADING_ALLOWED_TOOL_NAMES,
  TRADING_ANALYST_ALLOWED_TOOL_NAMES,
  TRADING_ANALYST_TOOL_NAMES,
  TRADING_OBSERVE_ALLOWED_TOOL_NAMES,
  TRADING_OBSERVE_TOOL_NAMES,
  TRADING_TOOL_NAMES,
  WORKSPACE_CHAT_PREFIX,
  WORKSPACE_TRADING_PREAMBLE,
} from "./TradingSessionProfile.ts";

// The prompts are delivered as first-turn contracts now, so the prompt-content
// assertions read them off that seam: one fresh session instance per kind.
const missionContractText = (): string => {
  const threadId = ThreadId.make("thread-mission-contract");
  setSessionProfile({ threadId, kind: "trading" });
  resetTradingContractDelivery(threadId);
  const text = applyTradingTurnContract(threadId, "wakeup").text;
  clearAllSessionProfiles();
  return text;
};
const analystContractText = (): string => {
  const threadId = ThreadId.make("thread-analyst-contract");
  setSessionProfile({ threadId, kind: "trading_analyst" });
  resetTradingContractDelivery(threadId);
  const text = applyTradingTurnContract(threadId, "question").text;
  clearAllSessionProfiles();
  return text;
};
const observeContractText = (): string => {
  const threadId = ThreadId.make("thread-observe-contract");
  setSessionProfile({ threadId, kind: "trading_observe" });
  resetTradingContractDelivery(threadId);
  const text = applyTradingTurnContract(threadId, "wakeup").text;
  clearAllSessionProfiles();
  return text;
};

const registeredToolNames = Object.values(TradingToolkit.tools).map((tool) => tool.name);

it("names exactly the tools the toolkit registers", () => {
  expect([...TRADING_TOOL_NAMES].sort()).toEqual([...registeredToolNames].sort());
});

it("allowlists the trading tools by name rather than the whole MCP server", () => {
  expect(TRADING_ALLOWED_TOOL_NAMES).toHaveLength(registeredToolNames.length);
  expect(TRADING_ALLOWED_TOOL_NAMES.every((name) => name.startsWith("mcp__t3-trade__"))).toBe(true);
  expect(TRADING_ALLOWED_TOOL_NAMES).not.toContain("mcp__t3-trade__*");
});

it("gives the analyst the reads and alert watches, and none of the acting tools", () => {
  // The allowlist is a subset of the registered toolkit…
  for (const name of TRADING_ANALYST_TOOL_NAMES) {
    expect(registeredToolNames).toContain(name);
  }
  expect([...TRADING_ANALYST_TOOL_NAMES].sort()).toEqual(
    // `trading_backtest` is a read over the archive with no path to an order,
    // so it is research an analyst may run. `trading_validate` writes, but only
    // to the paper ledger, and no surface reporting real money reads it — so it
    // is research too, and an analyst may arm one and read its verdict.
    // `trading_hypothesis` is where that research becomes cumulative: three
    // tables, no execution path, and the analyst is the session that does most
    // of the work worth filing.
    [
      "trading_look",
      "trading_strategy",
      "trading_watch",
      "trading_backtest",
      "trading_validate",
      "trading_hypothesis",
      // The external calendar: research tables, no execution path.
      "trading_events",
      // Research presentation only: one scene table, no execution path.
      "trading_chart",
    ].sort(),
  );
  // …and the acting tools are exactly what it lacks.
  for (const excluded of ["trading_enter", "trading_exit", "trading_plan", "trading_journal"]) {
    expect(TRADING_ANALYST_TOOL_NAMES).not.toContain(excluded);
    expect(TRADING_ANALYST_ALLOWED_TOOL_NAMES).not.toContain(`mcp__t3-trade__${excluded}`);
  }
  expect(
    TRADING_ANALYST_ALLOWED_TOOL_NAMES.every((name) => name.startsWith("mcp__t3-trade__")),
  ).toBe(true);
  expect(TRADING_ANALYST_ALLOWED_TOOL_NAMES).not.toContain("mcp__t3-trade__*");

  // The analyst prompt mentions only tools the analyst actually has.
  const mentioned = new Set(analystContractText().match(/trading_[a-z_]+/g) ?? []);
  expect(mentioned.size).toBeGreaterThan(0);
  for (const name of mentioned) {
    expect(TRADING_ANALYST_TOOL_NAMES).toContain(name);
  }
});

it("prefixes the analyst contract onto an analyst thread's turn", () => {
  clearAllSessionProfiles();
  const analystThread = ThreadId.make("thread-analyst");
  setSessionProfile({ threadId: analystThread, kind: "trading_analyst" });
  resetTradingContractDelivery(analystThread);

  const question = "Read the current structure on ETH and tell me what matters.";
  const first = applyTradingTurnContract(analystThread, question);
  expect(first.text.endsWith(question)).toBe(true);
  expect(first.text).toContain("t3-trade analyst session");
  expect(first.text).toContain("You cannot enter, exit, publish a plan");
  first.markDelivered();

  const second = applyTradingTurnContract(analystThread, question);
  expect(second.text).toContain("t3-trade analyst session");
  expect(second.text).not.toContain("You cannot enter, exit, publish a plan");
  expect(second.text.length).toBeLessThan(first.text.length / 4);

  clearAllSessionProfiles();
});

it("gives an observe mission every research tool and no way to act", () => {
  for (const name of TRADING_OBSERVE_TOOL_NAMES) {
    expect(registeredToolNames).toContain(name);
  }
  // The analyst's set plus the journal. The journal is the difference: an
  // observe mission is woken and needs somewhere durable to put what it
  // concluded, where an analyst's transcript is its whole memory.
  expect([...TRADING_OBSERVE_TOOL_NAMES].sort()).toEqual(
    [
      "trading_look",
      "trading_strategy",
      "trading_watch",
      "trading_journal",
      "trading_backtest",
      "trading_validate",
      "trading_hypothesis",
      "trading_events",
      "trading_chart",
    ].sort(),
  );
  // The three execution tools are exactly what it lacks, and this is the
  // assertion the whole "structurally unable to trade" claim rests on.
  for (const excluded of ["trading_plan", "trading_enter", "trading_exit"]) {
    expect(TRADING_OBSERVE_TOOL_NAMES).not.toContain(excluded);
    expect(TRADING_OBSERVE_ALLOWED_TOOL_NAMES).not.toContain(`mcp__t3-trade__${excluded}`);
  }
  expect(TRADING_OBSERVE_ALLOWED_TOOL_NAMES.every((n) => n.startsWith("mcp__t3-trade__"))).toBe(
    true,
  );
  expect(TRADING_OBSERVE_ALLOWED_TOOL_NAMES).not.toContain("mcp__t3-trade__*");

  // The prompt names only tools it has, in both directions: it may not promise
  // one it lacks, and the three it names as absent are named as absent.
  const mentioned = new Set(observeContractText().match(/trading_[a-z_]+/g) ?? []);
  for (const name of mentioned) {
    if (["trading_plan", "trading_enter", "trading_exit"].includes(name)) continue;
    expect(TRADING_OBSERVE_TOOL_NAMES).toContain(name);
  }
  expect(observeContractText()).toContain("are not in this session");
  // The reverse state, named where the observer will look for it. Found live:
  // an observer asked to stand down reached for `shelve` — a verdict on the
  // idea — because nothing had told it that `observe` is also the way out.
  expect(observeContractText()).toContain("WHEN THE USER ASKS YOU TO STOP WATCHING");
  expect(observeContractText()).toContain("ends this watch");
  expect(observeContractText()).toContain(WORKSPACE_TRADING_PREAMBLE);
});

it("tells every woken agent what to do with a validation event", () => {
  // The doctrine reaches BOTH contracts: a trade mission with a validation on
  // its market gets these wakes too, and the rule there is the same one.
  for (const prompt of [missionContractText(), observeContractText()]) {
    expect(prompt).toContain("WHEN A VALIDATION WAKES YOU, NARRATE IT AND DO NOTHING ELSE");
    expect(prompt).toContain("validationEvents");
    expect(prompt).toContain("Do not publish a plan");
  }
  // …and not the analyst's, which holds no mission and is never woken.
  expect(analystContractText()).not.toContain("WHEN A VALIDATION WAKES YOU");
});

it("prefixes the observe contract onto an observe thread's turn", () => {
  clearAllSessionProfiles();
  const observeThread = ThreadId.make("thread-observe");
  setSessionProfile({ threadId: observeThread, kind: "trading_observe" });
  resetTradingContractDelivery(observeThread);

  const wake = "paper long opened on ETH at 2451";
  const first = applyTradingTurnContract(observeThread, wake);
  expect(first.text.endsWith(wake)).toBe(true);
  expect(first.text).toContain("t3-trade observe session");
  expect(first.text).toContain("are not in this session");
  first.markDelivered();

  const second = applyTradingTurnContract(observeThread, wake);
  expect(second.text).toContain("t3-trade observe session");
  expect(second.text).not.toContain("are not in this session");
  expect(second.text.length).toBeLessThan(first.text.length / 4);

  clearAllSessionProfiles();
});

it("grounds every thread in the workspace, in under 900 characters", () => {
  // It rides every turn in the workspace, trading thread or not, so its size is
  // paid on every call here. The five things it says are the five a thread
  // cannot work out from the tools alone. The budget moved from 800 to 900 for
  // exactly one of them: without the line saying an idea can be tested without
  // being traded, the only thing this block described was execution, and every
  // thread opened on the assumption that a trade was coming.
  expect(WORKSPACE_TRADING_PREAMBLE.length).toBeLessThan(900);
  expect(WORKSPACE_TRADING_PREAMBLE).toContain("Hyperliquid testnet");
  expect(WORKSPACE_TRADING_PREAMBLE).toContain("An idea does not have to become a trade");
  expect(WORKSPACE_TRADING_PREAMBLE).toContain("Every entry needs a stop");
  expect(WORKSPACE_TRADING_PREAMBLE).toContain("binds automatically");
  // And the presumption that an order is coming is gone from it.
  expect(WORKSPACE_TRADING_PREAMBLE).not.toContain("when you place the order");
  // Plain sentences, no em-dashes, in anything a user or a model reads.
  expect(WORKSPACE_TRADING_PREAMBLE).not.toContain("\u2014");

  // And every prompt in the workspace carries it: the mission's, the
  // analyst's, and both turn contracts.
  expect(missionContractText()).toContain(WORKSPACE_TRADING_PREAMBLE);
  expect(analystContractText()).toContain(WORKSPACE_TRADING_PREAMBLE);
});

it("mentions only registered tool names in the system prompt", () => {
  // Every `trading_*` token the prompt uses must be a tool that exists. The
  // prompt this replaced directed the harness to `trading_stand_down` and a
  // "trading inbox", neither of which was ever registered.
  const mentioned = new Set(missionContractText().match(/trading_[a-z_]+/g) ?? []);
  expect(mentioned.size).toBeGreaterThan(0);
  for (const name of mentioned) {
    expect(registeredToolNames).toContain(name);
  }
});

it("enumerates the playbook call order and the terminal decision outcomes", () => {
  expect(missionContractText()).toContain('"classify"');
  expect(missionContractText()).toContain('"standing_rules"');
  for (const outcome of [
    "entered",
    "managed_position",
    "waiting_with_setup",
    "no_setup",
    "blocked_by_data",
    "execution_refused",
    "researched",
  ]) {
    expect(missionContractText()).toContain(outcome);
  }
});

it("gives an ordinary chat thread the research loop, not only the grounding", () => {
  // The gap this closes: a thread takes a trading profile, and with it the full
  // decision contract, only when it publishes a plan or executes. A thread that
  // is exploring an idea does neither, so the exploratory doctrine used to ride
  // every mission wake and no chat turn — the exact inverse of where it is
  // needed. It rides the first turn of a chat session and nothing after it.
  expect(WORKSPACE_CHAT_PREFIX).toContain(WORKSPACE_TRADING_PREAMBLE);
  expect(WORKSPACE_CHAT_PREFIX).toContain("WHEN THE USER BRINGS AN IDEA AND NOT AN ORDER");
  expect(WORKSPACE_CHAT_PREFIX).toContain(
    "DO NOT PUBLISH A PLAN OR ARM AN EXECUTION WAKE FOR AN IDEA THE USER HAS NOT ASKED TO TRADE",
  );
  // Standing alone, it may not point at a loop that is not there.
  expect(WORKSPACE_CHAT_PREFIX).not.toContain("the loop above");

  const chatThread = ThreadId.make("thread_chat_research");
  resetTradingContractDelivery(chatThread);
  const first = applyTradingTurnContract(chatThread, "is this idea any good?");
  expect(first.text).toContain(WORKSPACE_CHAT_PREFIX);
  first.markDelivered();
  // And once only: the transcript keeps what it was already told.
  expect(applyTradingTurnContract(chatThread, "and now?").text).toBe("and now?");
  clearAllSessionProfiles();
});

it("makes the research loop a peer of the execution loop, not a footnote", () => {
  // The contract used to describe one thing to do with a market: predict, arm,
  // wait, react. A user who brought an IDEA got that loop pointed at them, and
  // the three research tools were never named in it at all.
  expect(missionContractText()).toContain("WHEN THE USER BRINGS AN IDEA AND NOT AN ORDER");
  for (const tool of [TRADING_HYPOTHESIS_TOOL, TRADING_BACKTEST_TOOL, TRADING_VALIDATE_TOOL]) {
    expect(missionContractText()).toContain(tool);
  }
  // The four moves the research path is made of.
  expect(missionContractText()).toContain("IN THE USER'S OWN WORDS");
  expect(missionContractText()).toContain("NEAREST TESTABLE FORM");
  expect(missionContractText()).toContain("OFFER FORWARD VALIDATION");
  expect(missionContractText()).toContain("REVISE, DO NOT REFILE");
  // And the one thing it forbids.
  expect(missionContractText()).toContain(
    "DO NOT PUBLISH A PLAN OR ARM AN EXECUTION WAKE FOR AN IDEA THE USER HAS NOT ASKED TO TRADE",
  );
  // The direct-order rule survives it untouched: research is the path for an
  // idea, never a reason to talk somebody out of a trade they asked for.
  expect(missionContractText()).toContain("WHEN THE USER TELLS YOU TO MAKE A TRADE, MAKE IT");
  expect(missionContractText()).toContain("say so in ONE line and then execute");
});

it("names every tool the analyst allowlist actually grants", () => {
  // The contract said "your three tools" while the allowlist granted six, so
  // the prompt was telling the model it could not do things it could.
  expect(analystContractText()).not.toContain("Your three tools");
  for (const tool of TRADING_ANALYST_TOOL_NAMES) {
    expect(analystContractText()).toContain(tool);
  }
  // Every trading tool the analyst prompt names is one the analyst can call:
  // naming an execution tool would be worse than naming too few.
  const mentioned = new Set(analystContractText().match(/trading_[a-z_]+/g) ?? []);
  for (const name of mentioned) {
    expect(TRADING_ANALYST_TOOL_NAMES).toContain(name);
  }
});

it("has every provider adapter apply the profile", async () => {
  // The variance this guards against is not a behaviour one adapter got wrong;
  // it is an adapter that never opted in at all. Every adapter now applies the
  // profile the same way — as a turn contract riding the first turn of each
  // session instance — so no native system prompt or base instructions are
  // replaced anywhere.
  const read = async (file: string) =>
    await NodeFSP.readFile(new URL(`./Layers/${file}`, import.meta.url), "utf8");

  const claude = await read("ClaudeAdapter.ts");
  expect(claude).toContain("applyTradingTurnContractWithContext(input.threadId");
  expect(claude).toContain("resetTradingContractDelivery(input.threadId)");
  expect(claude).toContain("markDelivered()");

  for (const adapter of [
    "CodexAdapter.ts",
    "CursorAdapter.ts",
    "GrokAdapter.ts",
    "OpenCodeAdapter.ts",
  ]) {
    const source = await read(adapter);
    expect(source, adapter).toContain("applyTradingTurnContractWithContext(input.threadId");
    // Both halves of the once-per-session delivery, or the adapter either
    // repeats the contract forever or drops it after a failed turn.
    expect(source, adapter).toContain("resetTradingContractDelivery(input.threadId)");
    expect(source, adapter).toContain("markDelivered()");
  }
});

it("prefixes the contract onto a trading thread's turn, and leaves other threads alone", () => {
  clearAllSessionProfiles();
  const tradingThread = ThreadId.make("thread-trading");
  const codingThread = ThreadId.make("thread-coding");
  setSessionProfile({ threadId: tradingThread, kind: "trading" });
  resetTradingContractDelivery(tradingThread);

  const wakeup = '{"kind":"trading-harness-wakeup"}';
  const prefixed = applyTradingTurnContract(tradingThread, wakeup);
  expect(prefixed.text.endsWith(wakeup)).toBe(true);
  expect(prefixed.text).toContain("trading_plan");
  expect(prefixed.text).toContain("blocked_by_data");
  // An ordinary thread here is not a trading thread, but it still reaches the
  // trading tools and can still take a market on its first plan or entry, so it
  // carries the workspace grounding block and nothing else.
  const coding = applyTradingTurnContract(codingThread, wakeup);
  expect(coding.text).toContain("T3 Trade grounding");
  expect(coding.text).not.toContain("blocked_by_data");
  expect(coding.text.endsWith(wakeup)).toBe(true);
  coding.markDelivered();
  // Once per session instance, like the contract itself.
  expect(applyTradingTurnContract(codingThread, wakeup).text).toBe(wakeup);
  resetTradingContractDelivery(codingThread);

  clearAllSessionProfiles();
});

// The contract is 9.5k chars and does not change. On the 206-wake thread the
// token audit measured, prefixing it to every turn was 1.9M characters of
// identical text the model paid to read again on each one.
it("sends the contract once per session instance, and only once it has arrived", () => {
  clearAllSessionProfiles();
  const tradingThread = ThreadId.make("thread-trading-once");
  setSessionProfile({ threadId: tradingThread, kind: "trading" });
  resetTradingContractDelivery(tradingThread);

  const wakeup = '{"kind":"trading-harness-wakeup"}';

  // A turn that never dispatched must not swallow the contract.
  expect(applyTradingTurnContract(tradingThread, wakeup).text).toContain("blocked_by_data");

  const first = applyTradingTurnContract(tradingThread, wakeup);
  expect(first.text).toContain("blocked_by_data");
  first.markDelivered();

  const second = applyTradingTurnContract(tradingThread, wakeup);
  expect(second.text).not.toContain("blocked_by_data");
  expect(second.text).toContain("t3-trade trading session");
  expect(second.text.endsWith(wakeup)).toBe(true);
  expect(second.text.length).toBeLessThan(first.text.length / 10);

  // A new session instance starts the thread over.
  resetTradingContractDelivery(tradingThread);
  expect(applyTradingTurnContract(tradingThread, wakeup).text).toContain("blocked_by_data");

  clearAllSessionProfiles();
});

describe("workspace research orchestration doctrine (task 3)", () => {
  const contract = WORKSPACE_CHAT_PREFIX;

  it("teaches the loop: restate, split facts from measurement, read dates back, narrate, labelled defaults", () => {
    expect(contract).toContain("RESTATE THE CLAIM FIRST");
    expect(contract).toContain("correlation a study can measure");
    expect(contract).toContain("SPLIT WHAT YOU LOOKED UP FROM WHAT YOU MEASURED");
    expect(contract).toContain("READ THE DATES BACK BEFORE RECORDING THEM");
    expect(contract).toContain("NARRATE THE RESULT, NOT THE TOOL CALL");
    expect(contract).toContain("USE A LABELLED DEFAULT INSTEAD OF ASKING");
  });

  it("keeps the intent boundaries byte-honest: no plan, no validation, no execution without an explicit ask", () => {
    expect(contract).toContain(
      "DO NOT PUBLISH A PLAN OR ARM AN EXECUTION WAKE FOR AN IDEA THE USER HAS NOT ASKED TO TRADE",
    );
    expect(contract).toContain("arm it only if the user agrees");
  });

  it("makes filing, backtesting and validation conditional on user intent, with exclusions winning", () => {
    expect(contract).toContain(
      "FILE IT WHEN THE USER WANTS THE IDEA KEPT, NEVER WHEN THEY EXCLUDED IT",
    );
    expect(contract).toContain("BACKTEST IT WHEN THE USER ASKS WHETHER THE IDEA EVER MADE MONEY");
    expect(contract).toContain("OFFER FORWARD VALIDATION WHEN THE USER HAS NOT EXCLUDED IT");
    expect(contract).toContain(
      "an explicit exclusion (no hypothesis, no backtest, no validation) holds",
    );
  });

  it("teaches the instant rule and the single-source rule for dated occurrences", () => {
    expect(contract).toContain("start and end as the SAME ISO instant");
    expect(contract).toContain("exactly one source URL per occurrence");
    expect(contract).toContain("several URLs joined into it render as one broken link");
    expect(contract).toContain(
      "recording the one you relied on in the occurrence's single source field",
    );
  });

  it("never teaches profit language", () => {
    for (const forbidden of ["you would have made", "predicts the next", "guaranteed profit"]) {
      expect(contract).not.toContain(forbidden);
    }
  });

  it("publishes to the graph and says what is visible", () => {
    expect(contract).toContain("SHOW IT ON THE GRAPH");
    expect(contract).toContain("Historical research. No order placed. Not a forecast.");
  });

  it("keeps an event-study-only request off trading_look and off a redundant show call", () => {
    expect(contract).toContain("An event-study-only request is web research");
    expect(contract).toContain(
      "do not call trading_look for historical bars or live context unless the user asked for current market conditions",
    );
    expect(contract).toContain("passing entryBasis and illustrativeNotionalUsd");
    expect(contract).toContain(
      "publish_event_study returns the scene on the graph; do not call show afterwards",
    );
  });
});
