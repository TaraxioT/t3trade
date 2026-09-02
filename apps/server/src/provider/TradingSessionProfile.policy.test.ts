// @effect-diagnostics nodeBuiltinImport:off
import { expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";

import { TradingToolkit } from "../mcp/toolkits/trading/tools.ts";
import { clearAllSessionProfiles, setSessionProfile } from "./SessionProfile.ts";
import {
  applyTradingTurnContract,
  resetTradingContractDelivery,
  TRADING_TOOL_POLICY,
} from "./TradingSessionProfile.ts";

// The tool policy is the doctrine a model needs BEFORE its first
// market-research call: the persona prompt that used to carry it was deleted,
// and the avoidable invalid calls that followed (unknown fetch keys, a 4h look
// interval, a 672-bar horizon, a 500-bar candle fetch) were the bill. These
// assertions hold the policy to the seven rules it was restored to carry, and
// to the delivery seam that makes a market-research session actually receive
// it — a research thread has no trading profile, so the turn-contract seam is
// the only one that reaches it.

it("carries all seven rules by their key phrases", () => {
  // 1. Catalog-first: the menu call before any guessed key.
  expect(TRADING_TOOL_POLICY).toContain("trading_look({}) once");
  expect(TRADING_TOOL_POLICY).toContain("Never guess");
  // 2. Separation: the look and study grammars differ on purpose.
  expect(TRADING_TOOL_POLICY).toContain("never cross them");
  // 3. Coarsest interval, with the four-week daily example.
  expect(TRADING_TOOL_POLICY).toContain('{interval: "1d", horizonBars: 28}');
  expect(TRADING_TOOL_POLICY).toContain("coarsest interval");
  // 4. No shell or public-endpoint bypass of a refused data call.
  expect(TRADING_TOOL_POLICY).toContain("shell command");
  expect(TRADING_TOOL_POLICY).toContain("only market-data source");
  // 5. Publish-before-claiming: the sceneId is the proof.
  expect(TRADING_TOOL_POLICY).toContain("publish_event_study");
  expect(TRADING_TOOL_POLICY).toContain("sceneId");
  // 6. Read-back before record: preview, then requireReadBack + digest.
  expect(TRADING_TOOL_POLICY).toContain("preview");
  expect(TRADING_TOOL_POLICY).toContain("requireReadBack: true");
  expect(TRADING_TOOL_POLICY).toContain("confirmationDigest");
  // 7. Event timing honesty, in all three shapes.
  expect(TRADING_TOOL_POLICY).toContain("date precision");
  expect(TRADING_TOOL_POLICY).toContain("Never invent a midnight");
});

it("stays a turn prefix: bounded, plain, provider-neutral, no resurrected persona", () => {
  // A turn prefix is paid on the first turn of every session instance in the
  // workspace. The bound is a size class like the preamble's, not exact prose.
  expect(TRADING_TOOL_POLICY.length).toBeLessThanOrEqual(1_800);
  // Plain sentences, no em-dashes, in anything a user or a model reads — the
  // preamble's discipline, held here too.
  expect(TRADING_TOOL_POLICY).not.toContain("\u2014");
  // The deleted persona's ceremony vocabulary may not ride back in.
  for (const retired of ["PREDICT", "RESTATE THE CLAIM", "FILE IT WHEN", "no web access"]) {
    expect(TRADING_TOOL_POLICY, retired).not.toContain(retired);
  }
  // Provider-neutral: every `trading_*` token it names is a registered tool.
  const registered = Object.values(TradingToolkit.tools).map((tool) => tool.name);
  const mentioned = new Set(TRADING_TOOL_POLICY.match(/trading_[a-z_]+/g) ?? []);
  expect(mentioned.size).toBeGreaterThan(0);
  for (const name of mentioned) {
    expect(registered, name).toContain(name);
  }
});

it("reaches a market-research thread on the turn-contract seam, once per session instance", () => {
  clearAllSessionProfiles();
  // No profile set: this is the market-research shape — a thread that has not
  // published a plan or executed, so nothing else in the product would hand it
  // tool guidance.
  const threadId = ThreadId.make("thread-policy-research");
  const question = "Does ETH rise in the week after a funding flip?";

  const first = applyTradingTurnContract(threadId, question);
  expect(first.text).toContain(TRADING_TOOL_POLICY);
  expect(first.text.endsWith(question)).toBe(true);
  first.markDelivered();

  const second = applyTradingTurnContract(threadId, question);
  expect(second.text).not.toContain("T3 Trade tool policy");
  expect(second.text).toBe(question);

  // A new session instance delivers it again.
  resetTradingContractDelivery(threadId);
  expect(applyTradingTurnContract(threadId, question).text).toContain(TRADING_TOOL_POLICY);

  clearAllSessionProfiles();
});

it("rides every first-turn contract that carries the workspace preamble", () => {
  clearAllSessionProfiles();
  const contractFor = (kind: "trading" | "trading_analyst" | "trading_observe"): string => {
    const threadId = ThreadId.make(`thread-policy-${kind}`);
    setSessionProfile({ threadId, kind });
    resetTradingContractDelivery(threadId);
    const text = applyTradingTurnContract(threadId, "wakeup").text;
    clearAllSessionProfiles();
    return text;
  };

  for (const kind of ["trading", "trading_analyst", "trading_observe"] as const) {
    const text = contractFor(kind);
    expect(text, kind).toContain(TRADING_TOOL_POLICY);
    // The grounding still rides with it — the policy extends the preamble, it
    // does not replace it.
    expect(text, kind).toContain("T3 Trade grounding");
  }
});
