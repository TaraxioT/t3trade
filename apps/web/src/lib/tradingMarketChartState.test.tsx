/**
 * The chart hook's refresh identity and staleness contract, pinned.
 *
 * The atom family keys each series by `JSON.stringify([environmentId, input])`
 * and `maxBars` is part of that input, so a refresh that rebuilds the key from
 * a different field set refreshes a DIFFERENT cache entry than the one the
 * chart is subscribed to. These tests drive the real refresh paths (the 15s
 * poll and the manual retry) against the real family and assert the refreshed
 * entry is the very instance the panel-facing read uses.
 */
import {
  EnvironmentId,
  type TradingChartInterval,
  type TradingMarketChartView,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useTradingMarketChart, type TradingMarketChartState } from "./tradingMarketChartState";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { orchestrationEnvironment } from "../state/orchestration";

const atomState = vi.hoisted(() => ({
  result: null as unknown,
  atom: null as unknown,
}));
vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@effect/atom-react")>()),
  // Stand-in subscription: records which atom instance the hook read this
  // render (the panel-facing one) and returns the current simulated result.
  useAtomValue: (atom: unknown) => {
    atomState.atom = atom;
    return atomState.result;
  },
}));

const ENV = EnvironmentId.make("env_chart_test");
const INTERVAL: TradingChartInterval = "15m";

function view(market: string, markPrice = 100): TradingMarketChartView {
  return {
    market,
    interval: INTERVAL,
    candles: [{ openTime: 0, open: 90, high: 110, low: 80, close: markPrice, volume: 10 }],
    markPrice,
    change24hPercent: 0,
    fundingRate8h: 0,
    openInterest: 0,
    dayVolumeUsd: 0,
    observedAt: "2026-09-12T00:00:00Z",
  };
}

type ChartOptions = Parameters<typeof useTradingMarketChart>[3];

let renderer: ReactTestRenderer | undefined;
let latest: TradingMarketChartState;
let refreshSpy: ReturnType<typeof spyOnRegistryRefresh>;

function spyOnRegistryRefresh() {
  return vi.spyOn(appAtomRegistry, "refresh").mockImplementation(() => {});
}

function Probe({ market, options }: { market: string | null; options: ChartOptions }) {
  const state = useTradingMarketChart(ENV, market, INTERVAL, options);
  useLayoutEffect(() => {
    latest = state;
  }, [state]);
  return null;
}

async function renderChart(market: string | null, options: ChartOptions) {
  await act(() => {
    renderer = create(<Probe market={market} options={options} />);
  });
}

async function rerenderChart(market: string | null, options: ChartOptions) {
  await act(() => {
    renderer?.update(<Probe market={market} options={options} />);
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // The hook's poll goes through `window.setInterval`; delegate to the (fake-
  // or real-timer) global so vi.useFakeTimers() controls it in node env.
  vi.stubGlobal("window", {
    setInterval: (...args: Parameters<typeof setInterval>) => setInterval(...args),
    clearInterval: (id: ReturnType<typeof setInterval>) => clearInterval(id),
  });
  refreshSpy = spyOnRegistryRefresh();
  atomState.result = AsyncResult.initial<TradingMarketChartView>();
  atomState.atom = null;
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("refresh identity", () => {
  it("the 15s poll refreshes the exact atom the chart reads when maxBars is in the key", async () => {
    vi.useFakeTimers();
    await renderChart("ETH", { enabled: true, range: "1w", maxBars: 5000 });
    const readAtom = atomState.atom;
    expect(readAtom).not.toBeNull();
    expect(refreshSpy).not.toHaveBeenCalled();

    await act(() => {
      vi.advanceTimersByTime(15_000);
    });

    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(refreshSpy.mock.calls[0]![0]).toBe(readAtom);
  });

  it("a manual retry refreshes the exact atom the chart reads when maxBars is in the key", async () => {
    await renderChart("ETH", { enabled: true, range: "1w", maxBars: 5000 });
    const readAtom = atomState.atom;

    await act(() => {
      latest.refresh();
    });

    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(refreshSpy.mock.calls[0]![0]).toBe(readAtom);
  });

  it("holds the atom identity across re-renders and refreshes, re-keys on market or range change", async () => {
    await renderChart("ETH", { enabled: true, range: "1w", maxBars: 5000 });
    const ethAtom = atomState.atom;

    await rerenderChart("ETH", { enabled: true, range: "1w", maxBars: 5000 });
    expect(atomState.atom).toBe(ethAtom);

    await act(() => {
      latest.refresh();
    });
    expect(refreshSpy.mock.calls[0]![0]).toBe(ethAtom);
    expect(atomState.atom).toBe(ethAtom);

    await rerenderChart("BTC", { enabled: true, range: "1w", maxBars: 5000 });
    const btcAtom = atomState.atom;
    expect(btcAtom).not.toBe(ethAtom);

    await act(() => {
      latest.refresh();
    });
    expect(refreshSpy.mock.calls.at(-1)![0]).toBe(btcAtom);

    await rerenderChart("BTC", { enabled: true, range: "1m", maxBars: 5000 });
    expect(atomState.atom).not.toBe(btcAtom);
  });

  it("does not refresh while disabled", async () => {
    await renderChart("ETH", { enabled: false, range: "1w", maxBars: 5000 });
    await act(() => {
      latest.refresh();
    });
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it("maxBars is part of the family key, so a refresh that drops it targets a different entry", () => {
    const withMaxBars = orchestrationEnvironment.tradingMarketChart({
      environmentId: ENV,
      input: { market: "ETH", interval: INTERVAL, range: "1w", maxBars: 5000 },
    });
    const withoutMaxBars = orchestrationEnvironment.tradingMarketChart({
      environmentId: ENV,
      input: { market: "ETH", interval: INTERVAL, range: "1w" },
    });
    expect(withoutMaxBars).not.toBe(withMaxBars);
  });
});

describe("staleness and last success", () => {
  it("preserves the read timestamp across rerenders and an in-flight refresh", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const success = AsyncResult.success(view("ETH"));
    atomState.result = success;
    await renderChart("ETH", { enabled: true });

    nowSpy.mockReturnValue(2_000);
    await rerenderChart("ETH", { enabled: true });
    expect(latest.lastSuccessAt).toBe(1_000);

    atomState.result = AsyncResult.waiting(success);
    await rerenderChart("ETH", { enabled: true });
    expect(latest.isLoading).toBe(true);
    expect(latest.lastSuccessAt).toBe(1_000);
  });

  it("marks a failed refresh carrying cached success as stale with its original timestamp", async () => {
    const cachedView = view("ETH");
    atomState.result = AsyncResult.failure<TradingMarketChartView, Error>(
      Cause.fail(new Error("offline")),
      { previousSuccess: Option.some(AsyncResult.success(cachedView, { timestamp: 1_000 })) },
    );
    await renderChart("ETH", { enabled: true });
    expect(latest.data).toBe(cachedView);
    expect(latest.stale).toBe(true);
    expect(latest.error).toBeNull();
    expect(latest.lastSuccessAt).toBe(1_000);
  });

  it("flips stale on a failed poll, clears it on recovery, and stamps lastSuccessAt only on success", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const ethView = view("ETH", 100);
    atomState.result = AsyncResult.success(ethView);
    await renderChart("ETH", { enabled: true, range: "1w", maxBars: 5000 });

    expect(latest.data).toBe(ethView);
    expect(latest.stale).toBe(false);
    expect(latest.lastSuccessAt).toBe(1_000);

    // A poll tick that fails with no value the atom can report: the hook holds
    // the last good view, flags it stale, and does NOT advance the stamp.
    nowSpy.mockReturnValue(2_000);
    atomState.result = AsyncResult.failure<TradingMarketChartView, Error>(
      Cause.fail(new Error("exchange down")),
    );
    await rerenderChart("ETH", { enabled: true, range: "1w", maxBars: 5000 });

    expect(latest.data).toBe(ethView);
    expect(latest.stale).toBe(true);
    expect(latest.error).toBeNull();
    expect(latest.lastSuccessAt).toBe(1_000);

    // Recovery: fresh success clears stale and advances the stamp.
    nowSpy.mockReturnValue(3_000);
    const recoveredView = view("ETH", 200);
    atomState.result = AsyncResult.success(recoveredView);
    await rerenderChart("ETH", { enabled: true, range: "1w", maxBars: 5000 });

    expect(latest.data).toBe(recoveredView);
    expect(latest.stale).toBe(false);
    expect(latest.lastSuccessAt).toBe(3_000);
  });

  it("marks a server-served stale view as stale while still showing it", async () => {
    atomState.result = AsyncResult.success({ ...view("ETH"), stale: true });
    await renderChart("ETH", { enabled: true, range: "1w", maxBars: 5000 });
    expect(latest.data).not.toBeNull();
    expect(latest.stale).toBe(true);
    // The read itself succeeded, so the stamp still advances.
    expect(latest.lastSuccessAt).not.toBeNull();
  });

  it("a first-load failure shows the error, never goes stale, and has no success stamp", async () => {
    atomState.result = AsyncResult.failure<TradingMarketChartView, Error>(
      Cause.fail(new Error("offline")),
    );
    await renderChart("ETH", { enabled: true, range: "1w", maxBars: 5000 });
    expect(latest.data).toBeNull();
    expect(latest.error).toBe("Failed to load trading market chart.");
    expect(latest.stale).toBe(false);
    expect(latest.lastSuccessAt).toBeNull();
  });

  it("drops the retained view and the success stamp when the series identity changes", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);
    atomState.result = AsyncResult.success(view("ETH"));
    await renderChart("ETH", { enabled: true });
    expect(latest.lastSuccessAt).toBe(1_000);

    nowSpy.mockReturnValue(2_000);
    atomState.result = AsyncResult.initial<TradingMarketChartView>();
    await rerenderChart("BTC", { enabled: true });
    expect(latest.data).toBeNull();
    expect(latest.lastSuccessAt).toBeNull();
  });
});
