import { expect, it } from "@effect/vitest";
import {
  TRADING_STRATEGY_TOOL,
  TRADING_PLAN_TOOL,
  TRADING_WATCH_TOOL,
} from "@t3tools/trading-contracts/tools";
import { TRADING_BACKTEST_TOOL } from "@t3tools/trading-contracts/backtest";
import { renderForwardMenu, TRADING_VALIDATE_TOOL } from "@t3tools/trading-contracts/forward";
import { TRADING_HYPOTHESIS_TOOL } from "@t3tools/trading-contracts/hypothesis";
import { TRADING_EVENTS_TOOL } from "@t3tools/trading-contracts/eventSets";
import { TRADING_LOOK_TOOL } from "@t3tools/trading-contracts/observation";
import { TRADING_ENTER_TOOL } from "@t3tools/trading-contracts/entry";
import { TRADING_JOURNAL_TOOL } from "@t3tools/trading-contracts/journal";
import { TRADING_EXIT_TOOL } from "@t3tools/trading-contracts/exit";
import * as Context from "effect/Context";
import { Tool } from "effect/unstable/ai";

import {
  TRADING_SYSTEM_PROMPT,
  TRADING_TOOL_NAMES,
} from "../../../provider/TradingSessionProfile.ts";
import { TradingToolkit } from "./tools.ts";

it("exposes the read, the plan, the watch, the journal, the research, and the two writes", () => {
  expect(
    Object.values(TradingToolkit.tools)
      .map((tool) => tool.name)
      .sort(),
  ).toEqual(
    [
      TRADING_LOOK_TOOL,
      TRADING_PLAN_TOOL,
      TRADING_STRATEGY_TOOL,
      TRADING_WATCH_TOOL,
      TRADING_JOURNAL_TOOL,
      TRADING_ENTER_TOOL,
      TRADING_EXIT_TOOL,
      TRADING_BACKTEST_TOOL,
      TRADING_VALIDATE_TOOL,
      TRADING_HYPOTHESIS_TOOL,
      TRADING_EVENTS_TOOL,
    ].sort(),
  );
});

it("exports provider-compatible object schemas the harness can fill in", () => {
  for (const tool of Object.values(TradingToolkit.tools)) {
    const schema = Tool.getJsonSchema(tool) as {
      readonly type?: unknown;
      readonly properties?: Readonly<Record<string, unknown>>;
      readonly anyOf?: unknown;
      readonly oneOf?: unknown;
    };
    expect(
      tool.description?.length ?? 0,
      `${tool.name} should have a useful description`,
    ).toBeGreaterThan(40);
    expect(schema.type, `${tool.name} must export a top-level object schema`).toBe("object");
    expect(schema.anyOf, `${tool.name} must not export a root anyOf`).toBeUndefined();
    expect(schema.oneOf, `${tool.name} must not export a root oneOf`).toBeUndefined();
    // Every trading call names the mission it is acting on, so the server can
    // check it against the mission the calling thread is bound to.
    expect(
      schema.properties?.missionId,
      `${tool.name} must take an explicit missionId`,
    ).toBeDefined();
  }
});

// Plan 29 step 6.2: entering is one call, and its input is only what the
// harness can actually see. Nothing about the order's identity — no sequence,
// no versions, no lease, no limit price, and no token to hand back — is
// advertised, because a field a harness can fill in is a field it can fill in
// wrongly.
it("advertises only what the harness can see, and asks for the stop", () => {
  const schema = Tool.getJsonSchema(TradingToolkit.tools[TRADING_ENTER_TOOL]) as {
    readonly properties?: Readonly<Record<string, unknown>>;
    readonly required?: ReadonlyArray<string>;
  };

  expect(Object.keys(schema.properties ?? {}).sort()).toEqual([
    "actionType",
    "market",
    "missionId",
    "notionalUsd",
    "side",
    "sizeEth",
    "stopPrice",
    "urgency",
  ]);
  // The mandatory stop is a required field, not a hope.
  expect(schema.required).toContain("stopPrice");
  expect(schema.required).toContain("side");
  for (const owned of ["quoteId", "executionSequence", "limitPrice", "activeHarnessRunId"]) {
    expect(schema.properties?.[owned], `${owned} is the server's`).toBeUndefined();
  }
});

// The publish description states the publish contract (optimistic
// concurrency, what a publish touches and does not, where the target comes
// from), not the doctrine — those live in the playbook.
it("publish description states the publish contract, not the methodology", () => {
  const publish = TradingToolkit.tools[TRADING_PLAN_TOOL].description ?? "";

  // Optimistic concurrency on the mission row's version.
  expect(publish).toContain("expectedMissionVersion");
  // A publish revises the plan in place; watches survive it (plan 29 step 4.2).
  expect(publish).toContain("watches survive");
  // The target is derived off measured volatility; nothing grades it (plan 29
  // step 3.2 took the basis ceremony out).
  expect(publish).toContain("measured volatility");
  expect(publish).not.toContain("targetProfitBasis");
  // How the harness records that no viable target exists: the explicit
  // no-position intent (plan 29 step 4.1).
  expect(publish).toContain("stand_aside");
  // The doctrine is gone.
  expect(publish).not.toContain("MEASURE TWO TIMEFRAMES");
});

// Twelve read tools became one (plan 29 step 6.1), so one description now
// carries what twelve carried. What it must still say is which fields answer
// the questions those tools existed for — and that the cost line is context.
it("points the one read at the fields that carry the answers", () => {
  const look = TradingToolkit.tools[TRADING_LOOK_TOOL].description ?? "";
  // The multi-timeframe read and its scored setups.
  expect(look).toContain("structure");
  expect(look).toContain("candidates");
  // Flat is a state, not an absence — the distinction a merged read can blur.
  expect(look).toContain("flat is size 0");
  // Cost survived the un-gating as context only (plan 29 step 3.1).
  expect(look).toContain("never a gate");
  expect(look).not.toContain("minimumViableTargetUsd");
});

// The two learning reads: what the mission believed before, and whether any of
// it worked. Both are useless unless the description names the field that
// carries the answer.
// Plan 29 step 6.5: the calibration read came off the hot path and onto the
// one read, so the doctrine has to point the model at the field rather than at
// a tool that no longer exists.
it("points at the calibration the one read now carries", () => {
  expect(TRADING_TOOL_NAMES).not.toContain("trading_get_target_calibration");
  expect(TRADING_SYSTEM_PROMPT).toContain("mission.targetCalibration");
});

// Re-levelling used to be cancel-then-register, with the side being re-levelled
// unwatched in between. The description has to name the parameter that closes
// that, and the case where it silently does not.
it("tells the harness how to move a level rather than add one", () => {
  const watch = TradingToolkit.tools[TRADING_WATCH_TOOL].description ?? "";
  expect(watch).toContain("replacesWatchId");
  expect(watch).toContain("one transaction");
  // The failure mode: a stale id means an addition, not a swap.
  expect(watch).toContain("ADDITION");
});

// Plan 29 step 6.3: one condition union replaced the eight sibling predicates,
// so the description has to name the five kinds and the one thing the server
// will not guess on the model's behalf.
it("names the five conditions and the interval it refuses to guess", () => {
  const watch = TradingToolkit.tools[TRADING_WATCH_TOOL].description ?? "";
  for (const kind of ["`price`", "`pnl`", "`giveback`", "`fill`", "`time`"]) {
    expect(watch, kind).toContain(kind);
  }
  expect(watch).toContain("interval");
  // A refusal is an outcome the harness can act on, not a dead end.
  expect(watch).toContain("recovery");
  // The eight-way type choice is gone from the vocabulary the model reads.
  for (const retired of ["price_cross", "candle_close", "pnl_above", "position_update"]) {
    expect(watch, retired).not.toContain(retired);
  }
});

// The bounded stop tool is only safe because a refusal costs nothing and the
// harness can read which bound it hit. The numbers behind each bound live in
// the server, not the description — what must survive is the bounds
// themselves and the free retry.
it("names the bounds trading_exit's move_stop actually enforces", () => {
  const exit = TradingToolkit.tools[TRADING_EXIT_TOOL].description ?? "";
  // The risk line: no move past what entry approval signed off on.
  expect(exit).toContain("approved stop");
  // And the other named bounds.
  expect(exit).toContain("noise floor");
  expect(exit).toContain("never below entry");
  expect(exit).toContain("rate-limited");
  // A refusal costs nothing, which is what makes trying one safe.
  expect(exit).toContain("A refusal sends nothing");
});

it("marks reading as safe and publishing as non-idempotent", () => {
  const annotations = (tool: Tool.Any) => ({
    readonly: Context.get(tool.annotations, Tool.Readonly),
    idempotent: Context.get(tool.annotations, Tool.Idempotent),
    destructive: Context.get(tool.annotations, Tool.Destructive),
    openWorld: Context.get(tool.annotations, Tool.OpenWorld),
  });

  expect(annotations(TradingToolkit.tools[TRADING_LOOK_TOOL])).toEqual({
    readonly: true,
    idempotent: true,
    destructive: false,
    openWorld: true,
  });
  expect(annotations(TradingToolkit.tools[TRADING_PLAN_TOOL])).toEqual({
    readonly: false,
    idempotent: false,
    destructive: false,
    openWorld: false,
  });
});

// A description says what the tool returns and the non-obvious behaviors —
// not rejection-code enumerations, cross-tool walkthroughs, formatting
// instructions, arithmetic, or parameters the schema already defines. Those
// belong to the runtime and the schemas, and restating them here just burns
// context on every turn.
//
// Plan 29 Step 1.3 cut the toolkit from ~15,000 to under 6,000 description
// chars on that rule; the budgets below keep it there. The per-tool cap sits
// above the measured maximum so small edits do not trip it, but any new
// enumeration will.
it("keeps every description on a budget", () => {
  const tools = Object.values(TradingToolkit.tools);

  expect(tools.length, "expected exactly 11 trading tools").toBe(11);

  const total = tools.reduce((sum, tool) => sum + (tool.description ?? "").length, 0);
  // Printed rather than only asserted: the budget is meant to be watched, and
  // a number nobody can see is a number that drifts to the cap.
  process.stdout.write(`TOOLKIT_DESCRIPTION_CHARS ${total}\n`);
  for (const tool of tools) {
    process.stdout.write(`  ${tool.name} ${(tool.description ?? "").length}\n`);
  }
  // Raised from 4,000 when `trading_validate` became the ninth tool, from
  // 4,250 when `trading_hypothesis` became the tenth, and from 4,750 when
  // `trading_events` became the eleventh. The cap is a budget, not a
  // discovered constant: each move is one tool's worth, taken deliberately,
  // rather than widening it until the measurement fitted.
  //
  // The decision behind this one: an idea anchored on an external date is the
  // one shape the research loop could not hold at all, and it cannot be
  // recorded or studied without a name the model can call. One more
  // description in every turn's system prompt is the price of that.
  expect(total, "total description chars must stay under 5,250").toBeLessThan(5_250);

  for (const tool of tools) {
    const len = (tool.description ?? "").length;
    // `trading_look` answers what twelve tools used to, so it carries the
    // longest description in the set. 500 leaves edit headroom, not room for
    // a new field glossary.
    expect(len, `${tool.name} description is ${len} chars, must be <= 500`).toBeLessThanOrEqual(
      500,
    );
  }
});

// Plan 29 Step 2.3: the harness speaks urgency, never a time-in-force. The
// write tools' descriptions are where it learns that vocabulary, so they name
// `urgency` and none of them names the execution-layer words the server owns.
it("teaches urgency and keeps time-in-force vocabulary out of the descriptions", () => {
  for (const tool of Object.values(TradingToolkit.tools)) {
    expect(tool.description ?? "", tool.name).not.toContain("IOC");
    expect(tool.description ?? "", tool.name).not.toContain("time-in-force");
  }

  const enter = TradingToolkit.tools[TRADING_ENTER_TOOL].description ?? "";
  expect(enter).toContain("urgency");
  expect(enter).toContain("patient");
  const exit = TradingToolkit.tools[TRADING_EXIT_TOOL].description ?? "";
  expect(exit).toContain("urgency");
  expect(exit).toContain("patient");
});

// Task 5's doctrine, as an assertion rather than a note in a commit message.
// Promotion is a sentence the user types, answered by the ordinary trading
// flow. Nothing in the validation surface may imply the tool itself can cross
// from paper to a real order, and nothing may offer to do it automatically.
it("says paper only, and points promotion at the ordinary trading flow", () => {
  const validate = TradingToolkit.tools[TRADING_VALIDATE_TOOL].description ?? "";
  const menu = renderForwardMenu();

  expect(validate, "the description must say it never places an order").toContain(
    "Never places an order",
  );
  expect(menu, "the menu must say the same").toContain("no order is ever placed");

  // The promotion sentence names the normal path rather than a verb of its own.
  expect(validate).toContain("plan and enter as normal");
  expect(menu).toContain("publish a plan and enter as normal");

  // No automatic crossing, in either surface.
  for (const text of [validate, menu]) {
    for (const forbidden of ["auto", "promote", "automatically", "go live"]) {
      expect(text.toLowerCase(), `must not offer to ${forbidden}`).not.toContain(forbidden);
    }
  }
});
