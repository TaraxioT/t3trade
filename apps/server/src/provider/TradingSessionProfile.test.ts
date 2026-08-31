// @effect-diagnostics nodeBuiltinImport:off
import { expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as NodeFSP from "node:fs/promises";

import { TradingToolkit } from "../mcp/toolkits/trading/tools.ts";
import { clearAllSessionProfiles, setSessionProfile } from "./SessionProfile.ts";
import {
  applyTradingTurnContract,
  resetTradingContractDelivery,
  TRADING_TOOL_NAMES,
  WORKSPACE_TRADING_PREAMBLE,
} from "./TradingSessionProfile.ts";

// The grounding is delivered as a first-turn contract, so the prompt-content
// assertions read it off that seam: one fresh session instance per kind.
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

it("mentions only registered tool names in the turn contracts", () => {
  // Every `trading_*` token a prefix uses must be a tool that exists. The
  // prompt this replaced directed the harness to `trading_stand_down` and a
  // "trading inbox", neither of which was ever registered.
  for (const prompt of [missionContractText(), analystContractText(), observeContractText()]) {
    const mentioned = new Set(prompt.match(/trading_[a-z_]+/g) ?? []);
    expect(mentioned.size).toBeGreaterThan(0);
    for (const name of mentioned) {
      expect(registeredToolNames).toContain(name);
    }
  }
});

it("grounds every thread in the workspace, in a bounded short block", () => {
  // It rides the first turn of every session instance in the workspace,
  // trading thread or not, so its size is paid everywhere and often. The
  // bound is a size class, not exact prose: content markers below pin what
  // must be in it, and the ceiling keeps it from growing back into a persona.
  expect(WORKSPACE_TRADING_PREAMBLE.length).toBeLessThan(1200);
  expect(WORKSPACE_TRADING_PREAMBLE).toContain("Hyperliquid testnet");
  expect(WORKSPACE_TRADING_PREAMBLE).toContain("market facts");
  // The TRADE.md control plane: where a persistent strategy lives, and that
  // activation is a typed, hash-gated call.
  expect(WORKSPACE_TRADING_PREAMBLE).toContain("TRADE.md");
  expect(WORKSPACE_TRADING_PREAMBLE).toContain("trading_plan_document");
  expect(WORKSPACE_TRADING_PREAMBLE).toContain("gated on the content hash");
  // And that a direct order is direct — an order must never mint a strategy
  // document, and a strategy request must never become an order.
  expect(WORKSPACE_TRADING_PREAMBLE).toContain("no TRADE.md required, created, or activated");
  // Authority and refusal are the server's, stated not argued with.
  expect(WORKSPACE_TRADING_PREAMBLE).toContain("authoritative");
  expect(WORKSPACE_TRADING_PREAMBLE).toContain("never authorization");
  // Plain sentences, no em-dashes, in anything a user or a model reads.
  expect(WORKSPACE_TRADING_PREAMBLE).not.toContain("\u2014");

  // And every first-turn contract in the workspace carries it.
  expect(missionContractText()).toContain(WORKSPACE_TRADING_PREAMBLE);
  expect(analystContractText()).toContain(WORKSPACE_TRADING_PREAMBLE);
  expect(observeContractText()).toContain(WORKSPACE_TRADING_PREAMBLE);
});

it("does not prescribe a workflow or claim missing native capability", () => {
  // The grounding states facts and boundaries. It may not resurrect the
  // prescribed universal loop, the forced research ceremony, or the old
  // starvation vocabulary telling a native agent it lacks tools it has.
  for (const prompt of [
    missionContractText(),
    analystContractText(),
    observeContractText(),
    WORKSPACE_TRADING_PREAMBLE,
  ]) {
    expect(prompt).not.toContain("PREDICT");
    expect(prompt).not.toContain("RESTATE THE CLAIM");
    expect(prompt).not.toContain("FILE IT WHEN");
    expect(prompt).not.toContain("no web access");
    expect(prompt).not.toContain("not in this session and the server refuses them anyway");
  }
});

it("states the analyst and observe scope as server-enforced fact", () => {
  expect(analystContractText()).toContain("server refuses");
  expect(analystContractText()).toContain("no mission");
  expect(observeContractText()).toContain("server refuses");
  expect(observeContractText()).toContain("no authority");
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
  expect(prefixed.text).toContain("t3-trade trading session");
  // An ordinary thread here is not a trading thread, but it still reaches the
  // trading tools and can still take a market on its first plan or entry, so it
  // carries the workspace grounding block and nothing else.
  const coding = applyTradingTurnContract(codingThread, wakeup);
  expect(coding.text).toContain("T3 Trade grounding");
  expect(coding.text).not.toContain("t3-trade trading session");
  expect(coding.text.endsWith(wakeup)).toBe(true);
  coding.markDelivered();
  // Once per session instance, like the contract itself.
  expect(applyTradingTurnContract(codingThread, wakeup).text).toBe(wakeup);
  resetTradingContractDelivery(codingThread);

  clearAllSessionProfiles();
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
  expect(first.text).toContain("the server refuses");
  first.markDelivered();

  const second = applyTradingTurnContract(analystThread, question);
  expect(second.text).toContain("t3-trade analyst session");
  expect(second.text).not.toContain("holds no mission");
  expect(second.text.length).toBeLessThan(first.text.length / 4);

  clearAllSessionProfiles();
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
  expect(first.text).toContain("no authority");
  first.markDelivered();

  const second = applyTradingTurnContract(observeThread, wake);
  expect(second.text).toContain("t3-trade observe session");
  expect(second.text).not.toContain("no authority");
  expect(second.text.length).toBeLessThan(first.text.length / 4);

  clearAllSessionProfiles();
});

it("has every provider adapter apply the profile", async () => {
  // The variance this guards against is not a behaviour one adapter got wrong;
  // it is an adapter that never opted in at all. Every adapter applies the
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

it("sends the contract once per session instance, and only once it has arrived", () => {
  clearAllSessionProfiles();
  const tradingThread = ThreadId.make("thread-trading-once");
  setSessionProfile({ threadId: tradingThread, kind: "trading" });
  resetTradingContractDelivery(tradingThread);

  const wakeup = '{"kind":"trading-harness-wakeup"}';

  // A turn that never dispatched must not swallow the contract.
  expect(applyTradingTurnContract(tradingThread, wakeup).text).toContain("T3 Trade grounding");

  const first = applyTradingTurnContract(tradingThread, wakeup);
  expect(first.text).toContain("T3 Trade grounding");
  first.markDelivered();

  const second = applyTradingTurnContract(tradingThread, wakeup);
  expect(second.text).not.toContain("T3 Trade grounding");
  expect(second.text).toContain("t3-trade trading session");
  expect(second.text.endsWith(wakeup)).toBe(true);
  expect(second.text.length).toBeLessThan(first.text.length / 2);

  // A new session instance starts the thread over.
  resetTradingContractDelivery(tradingThread);
  expect(applyTradingTurnContract(tradingThread, wakeup).text).toContain("T3 Trade grounding");

  clearAllSessionProfiles();
});
