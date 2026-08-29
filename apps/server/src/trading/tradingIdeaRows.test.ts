/**
 * The ideas panel's selection rule, which is the whole of what this module
 * decides: which ideas are rows, and which validation each row's figures come
 * from. Every sentence on the panel is composed on the client.
 */
import { describe, expect, it } from "vite-plus/test";

import { selectIdeaCandidates, toIdeaRow, type IdeaValidationInput } from "./tradingIdeaRows.ts";

const validation = (over: Partial<IdeaValidationInput> = {}): IdeaValidationInput => ({
  id: "v1",
  threadId: "t1",
  asset: "ETH",
  interval: "5m",
  label: null,
  headline: "Buy ETH 5m when RSI(14) is below 30",
  status: "armed",
  armedAt: 1_000,
  hypothesisId: null,
  ...over,
});

describe("selectIdeaCandidates", () => {
  it("takes every armed and paused validation, and no ended one", () => {
    const candidates = selectIdeaCandidates({
      validations: [
        validation({ id: "a", status: "armed", armedAt: 3 }),
        validation({ id: "b", status: "paused", armedAt: 2 }),
        validation({ id: "c", status: "ended", armedAt: 1 }),
      ],
      hypotheses: [],
      cap: 20,
    });
    expect(candidates.map((row) => row.id)).toEqual(["a", "b"]);
  });

  it("prefers the label over the composed thesis line", () => {
    const [row] = selectIdeaCandidates({
      validations: [validation({ label: "The 5m fade" })],
      hypotheses: [],
      cap: 20,
    });
    expect(row!.title).toBe("The 5m fade");
  });

  it("gives a testing hypothesis with a live run no second row", () => {
    const candidates = selectIdeaCandidates({
      validations: [validation({ id: "a", hypothesisId: "h1" })],
      hypotheses: [{ hypothesisId: "h1", title: "The fade", status: "testing", updatedAt: 5 }],
      cap: 20,
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ kind: "validation", id: "a", hypothesisId: "h1" });
  });

  it("rows a testing hypothesis whose runs have all ended, off its newest run", () => {
    const candidates = selectIdeaCandidates({
      validations: [
        validation({ id: "old", status: "ended", hypothesisId: "h1", armedAt: 1, asset: "BTC" }),
        validation({
          id: "new",
          status: "ended",
          hypothesisId: "h1",
          armedAt: 9,
          asset: "ETH",
          interval: "1m",
        }),
      ],
      hypotheses: [{ hypothesisId: "h1", title: "The fade", status: "testing", updatedAt: 5 }],
      cap: 20,
    });
    expect(candidates).toEqual([
      {
        kind: "hypothesis",
        id: "h1",
        title: "The fade",
        market: "ETH",
        interval: "1m",
        status: "testing",
        threadId: "t1",
        hypothesisId: "h1",
        reportValidationId: "new",
        sortAt: 9,
      },
    ]);
  });

  it("leaves out an idea in any other status, and one with no run at all", () => {
    const candidates = selectIdeaCandidates({
      validations: [validation({ id: "a", status: "ended", hypothesisId: "h2", armedAt: 1 })],
      hypotheses: [
        { hypothesisId: "h1", title: "No runs", status: "testing", updatedAt: 5 },
        { hypothesisId: "h2", title: "Concluded", status: "supported", updatedAt: 5 },
        { hypothesisId: "h3", title: "Still an idea", status: "exploring", updatedAt: 5 },
      ],
      cap: 20,
    });
    expect(candidates).toEqual([]);
  });

  it("caps at the newest, so the ledger read below it is bounded", () => {
    const validations = Array.from({ length: 30 }, (_, index) =>
      validation({ id: `v${index}`, armedAt: index }),
    );
    const candidates = selectIdeaCandidates({ validations, hypotheses: [], cap: 20 });
    expect(candidates).toHaveLength(20);
    expect(candidates[0]!.id).toBe("v29");
    expect(candidates[19]!.id).toBe("v10");
  });
});

describe("toIdeaRow", () => {
  const candidate = selectIdeaCandidates({
    validations: [validation()],
    hypotheses: [],
    cap: 20,
  })[0]!;

  it("sends no expectancy when nothing has settled", () => {
    const row = toIdeaRow(candidate, {
      expiresAt: 5_000,
      comparison: "too_few_trades",
      stats: { tradesTaken: 0, expectancyUsd: 0 },
    } as never);
    expect(row.expectancyUsd).toBeNull();
    expect(row.trades).toBe(0);
  });

  it("carries the figures and the clock of a run that has traded", () => {
    const row = toIdeaRow(candidate, {
      expiresAt: 5_000,
      comparison: "tracking",
      stats: { tradesTaken: 12, expectancyUsd: 1.25 },
    } as never);
    expect(row).toMatchObject({
      expectancyUsd: 1.25,
      trades: 12,
      expiresAt: 5_000,
      comparison: "tracking",
    });
  });

  it("gives a hypothesis row no clock: its runs have ended", () => {
    const hypothesisCandidate = selectIdeaCandidates({
      validations: [validation({ status: "ended", hypothesisId: "h1" })],
      hypotheses: [{ hypothesisId: "h1", title: "The fade", status: "testing", updatedAt: 5 }],
      cap: 20,
    })[0]!;
    const row = toIdeaRow(hypothesisCandidate, {
      expiresAt: 5_000,
      comparison: "tracking",
      stats: { tradesTaken: 12, expectancyUsd: 1.25 },
    } as never);
    expect(row.expiresAt).toBeNull();
  });

  it("reports nothing rather than zero when the ledger could not be read", () => {
    const row = toIdeaRow(candidate, null);
    expect(row).toMatchObject({ expectancyUsd: null, trades: 0, expiresAt: null });
  });
});
