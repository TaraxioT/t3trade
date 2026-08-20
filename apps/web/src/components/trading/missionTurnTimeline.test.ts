import { describe, expect, it } from "vite-plus/test";

import {
  deEmDash,
  describeFill,
  describeWakeReads,
  describeWakeTrigger,
  deriveTurnTimeline,
  MAX_TURN_CARDS,
} from "./missionTurnTimeline";

const iso = (hhmm: string): string => `2026-01-15T${hhmm}:00`;

const baseFill = {
  orderId: 1,
  tradedAt: iso("14:10"),
  avgFillPrice: 4251,
  closedPnl: 0,
};

describe("deriveTurnTimeline", () => {
  it("carries what the wake's turn read and did, in plain words", () => {
    const { cards } = deriveTurnTimeline({
      market: "ETH",
      missionTimeline: [
        {
          at: iso("14:30"),
          kind: "wake",
          label: "market_watch_triggered",
          toolsCalled: ["trading_look", "trading_journal", "trading_look"],
        },
      ],
      recentFills: [],
    });
    const wake = cards.find((card) => card.kind === "wake");
    // Repeats collapse and the wording is the plan's register: no tool names.
    expect(wake?.readLabel).toBe("looked at the market · wrote a note");
  });

  it("leaves the read line off when the run called nothing", () => {
    const { cards } = deriveTurnTimeline({
      market: "ETH",
      missionTimeline: [{ at: iso("14:30"), kind: "wake", label: "user_message" }],
      recentFills: [],
    });
    expect(cards.find((card) => card.kind === "wake")?.readLabel).toBeNull();
  });

  it("makes one wake card per wake, with its trigger and its decision", () => {
    const { cards } = deriveTurnTimeline({
      market: "ETH",
      missionTimeline: [
        { at: iso("14:31"), kind: "strategy_published", label: "v3" },
        // A wake carries its raw cause alongside the label, the way the
        // projection writes it — the trigger line is translated from `cause`.
        {
          at: iso("14:30"),
          kind: "wake",
          label: "market_watch_triggered",
          cause: "market_watch_triggered",
        },
      ],
      recentFills: [],
    });
    const wake = cards.find((card) => card.kind === "wake");
    expect(wake?.triggerLabel).toBe("A level it was watching was reached");
    expect(wake?.decisionLabel).toBe("It revised the plan (v3)");
    // The publish is its own card too, newest first.
    expect(cards[0]?.kind).toBe("revision");
  });

  it("does not attribute a decision that landed after the next wake", () => {
    const { cards } = deriveTurnTimeline({
      market: "ETH",
      missionTimeline: [
        { at: iso("14:20"), kind: "wake", label: "market_watch_triggered" },
        { at: iso("14:19"), kind: "wake", label: "scheduled_reassessment" },
        { at: iso("14:21"), kind: "strategy_published", label: "v2" },
      ],
      recentFills: [],
    });
    // 14:21 publish is after the 14:20 wake, so it belongs to that turn.
    const late = cards.find(
      (card) => card.id.startsWith("wake") && card.atMillis === Date.parse(iso("14:19")),
    );
    expect(late?.decisionLabel).toBeNull();
  });

  it("a decision outside the five-minute window is not attributed", () => {
    const { cards } = deriveTurnTimeline({
      market: "ETH",
      missionTimeline: [
        { at: iso("14:40"), kind: "strategy_published", label: "v2" },
        { at: iso("14:30"), kind: "wake", label: "market_watch_triggered" },
      ],
      recentFills: [],
    });
    const wake = cards.find((card) => card.kind === "wake");
    expect(wake?.decisionLabel).toBeNull();
  });

  it("marks a failed wake in the loss tone and says so in plain words", () => {
    const { cards } = deriveTurnTimeline({
      market: "ETH",
      missionTimeline: [
        { at: iso("14:30"), kind: "wake", label: "market_watch_triggered (failed)" },
      ],
      recentFills: [],
    });
    const wake = cards[0]!;
    expect(wake.tone).toBe("loss");
    expect(wake.triggerLabel).toContain("failed");
  });

  it("quotes a stop move's justification as the revision's detail", () => {
    const { cards } = deriveTurnTimeline({
      market: "ETH",
      missionTimeline: [
        {
          at: iso("14:30"),
          kind: "stop_adjusted",
          label: "Trailing the stop under the higher low.",
          priceLevel: 4210.5,
        },
      ],
      recentFills: [],
    });
    const revision = cards[0]!;
    expect(revision.kind).toBe("revision");
    expect(revision.triggerLabel).toBe("Stop moved");
    expect(revision.detailLabel).toBe("Trailing the stop under the higher low.");
    expect(revision.priceLevel).toBe(4210.5);
  });

  it("a journal note is its own card, and names who wrote it", () => {
    const { cards } = deriveTurnTimeline({
      market: "ETH",
      missionTimeline: [
        { at: iso("14:30"), kind: "journal", label: "Range is compressing.", author: "user" },
        { at: iso("14:20"), kind: "journal", label: "Waiting for the bar.", author: "model" },
      ],
      recentFills: [],
    });
    const user = cards.find((card) => card.atMillis === Date.parse(iso("14:30")));
    const model = cards.find((card) => card.atMillis === Date.parse(iso("14:20")));
    expect(user?.triggerLabel).toBe("You noted");
    expect(model?.triggerLabel).toBe("It noted");
    expect(model?.detailLabel).toBe("Waiting for the bar.");
  });

  it("trade cards speak in the plain register and join by the fill marker key", () => {
    const { cards } = deriveTurnTimeline({
      market: "ETH",
      missionTimeline: [],
      recentFills: [
        {
          ...baseFill,
          side: "buy",
          filledSize: 0.12,
          direction: "Open Long",
          closedPnl: 0,
        },
        {
          orderId: 2,
          tradedAt: iso("14:40"),
          avgFillPrice: 4318,
          side: "sell",
          filledSize: 0.12,
          direction: "Close Long",
          closedPnl: 8.4,
        },
      ],
    });
    const open = cards.find((card) => card.atMillis === Date.parse(iso("14:10")))!;
    const close = cards.find((card) => card.atMillis === Date.parse(iso("14:40")))!;
    expect(open.triggerLabel).toBe("Bought to open 0.12 ETH at 4,251");
    expect(open.id).toBe(`1-${iso("14:10")}`);
    expect(close.triggerLabel).toBe("Sold to close 0.12 ETH at 4,318");
    expect(close.detailLabel).toBe("net +$8.40");
    expect(close.tone).toBe("profit");
    // Newest first.
    expect(cards[0]?.id).toBe(close.id);
  });

  it("a fill with no direction speaks by its side, without inventing an outcome", () => {
    const described = describeFill("ETH", { ...baseFill, side: "buy" });
    expect(described.line).toBe("Bought ETH at 4,251");
    expect(described.detail).toBeNull();
    expect(described.tone).toBe("neutral");
  });

  it("caps the timeline and counts what was left off", () => {
    const timeline = Array.from({ length: MAX_TURN_CARDS + 5 }, (_, index) => ({
      at: iso("14:00"),
      kind: "wake" as const,
      label: "scheduled_reassessment",
      // Distinct moments, one minute apart, so ids stay unique.
      ...(index === 0 ? {} : {}),
    })).map((entry, index) => ({
      ...entry,
      at: `2026-01-15T14:${String(index % 60).padStart(2, "0")}:00`,
    }));
    const { cards, earlierCount } = deriveTurnTimeline({
      market: "ETH",
      missionTimeline: timeline,
      recentFills: [],
    });
    expect(cards).toHaveLength(MAX_TURN_CARDS);
    expect(earlierCount).toBe(5);
  });

  it("drops entries whose time will not parse rather than guessing a moment", () => {
    const { cards } = deriveTurnTimeline({
      market: "ETH",
      missionTimeline: [{ at: "not-a-time", kind: "wake", label: "x" }],
      recentFills: [{ ...baseFill, tradedAt: "not-a-time" }],
    });
    expect(cards).toHaveLength(0);
  });

  it("never composes an em-dash", () => {
    const { cards } = deriveTurnTimeline({
      market: "ETH",
      missionTimeline: [
        { at: iso("14:30"), kind: "wake", label: "market_watch_triggered" },
        { at: iso("14:31"), kind: "stop_adjusted", label: "one — two", priceLevel: 1 },
      ],
      recentFills: [baseFill],
    });
    for (const card of cards) {
      for (const text of [card.triggerLabel, card.decisionLabel, card.detailLabel]) {
        expect(text === null || !text.includes("—")).toBe(true);
      }
    }
  });
});

describe("describeWakeTrigger", () => {
  it("translates every cause the harness can wake with", () => {
    expect(describeWakeTrigger("scheduled_reassessment")).toBe("A scheduled check-in came due");
    expect(describeWakeTrigger("user_message")).toBe("You wrote to it");
    expect(describeWakeTrigger(undefined)).toBe("It woke");
  });

  it("an unknown cause is humanized, not invented around", () => {
    expect(describeWakeTrigger("new_cause")).toBe("new cause");
  });
});

describe("describeWakeReads", () => {
  it("translates every tool the harness can call during a wake", () => {
    expect(
      describeWakeReads([
        "trading_look",
        "trading_strategy",
        "trading_plan",
        "trading_watch",
        "trading_enter",
        "trading_exit",
        "trading_journal",
      ]),
    ).toBe(
      "looked at the market · read a strategy sheet · revised the plan · " +
        "changed a level it was watching · bought in · got out or adjusted · wrote a note",
    );
  });

  it("an unknown tool is humanized, not hidden and not invented around", () => {
    expect(describeWakeReads(["trading_new_thing"])).toBe("trading new thing");
  });

  it("returns null for an empty list", () => {
    expect(describeWakeReads([])).toBeNull();
  });
});

describe("deEmDash", () => {
  it("swaps em-dashes for the panel's separator, whatever the spacing", () => {
    expect(deEmDash("one — two")).toBe("one · two");
    expect(deEmDash("one—two")).toBe("one · two");
    expect(deEmDash("plain")).toBe("plain");
  });
});
