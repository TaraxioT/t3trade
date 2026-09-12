/**
 * The Forge bridge hooks' read identity, disabled path, and retention
 * contract, pinned — the same shape of proof the market chart hook's test
 * carries, over the forge RPC families.
 *
 * The mock stands in for the atom subscription and records which atom
 * instance the hook read this render; refreshes go through the real
 * `appAtomRegistry.refresh`, so these tests prove the refreshed entry is the
 * very instance the panel-facing read uses.
 */
import {
  EnvironmentId,
  type ForgePoolSeriesView,
  type ForgePoolStateView,
  type ForgeThreadContextView,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  forgeDetectorSummaries,
  useForgePoolSeries,
  useForgePoolState,
  useForgeThreadContext,
  type ForgeReadState,
} from "./forgeBridgeState";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { orchestrationEnvironment } from "../state/orchestration";

const atomState = vi.hoisted(() => ({
  result: null as unknown,
  atom: null as unknown,
}));
vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@effect/atom-react")>()),
  // Stand-in subscription: records which atom instance the hook read this
  // render and returns the current simulated result.
  useAtomValue: (atom: unknown) => {
    atomState.atom = atom;
    return atomState.result;
  },
}));

const ENV = EnvironmentId.make("env_forge_test");
const POOL = "0xabc0000000000000000000000000000000000001";

const seriesView: ForgePoolSeriesView = {
  status: "ok",
  series: {
    poolId: POOL,
    chain: "ethereum-mainnet",
    quoteUnits: "USDC-per-WETH",
    domainUtcMs: { start: 1_700_000_000_000, end: 1_700_000_360_000 },
    maxPoints: 720,
    points: [
      {
        t: 1_700_000_000,
        priceQuotePerBaseMicros: 1_000,
        quoteVolumeMicros: 5,
        observationId: "0xtx:0",
      },
    ],
    anchor: { status: "missing" },
    anchorCandidates: [],
    gaps: [],
    coverage: { firstObservedUnixSeconds: 1_700_000_000, lastObservedUnixSeconds: 1_700_000_000 },
    provenance: { deployment: "dep-1", pinnedBlock: 42, fetchedAtMs: 1_700_000_360_001 },
    health: { status: "healthy", probedAtMs: 1_700_000_360_001 },
  },
  domainIso: { from: "2023-11-14T22:13:20.000Z", to: "2023-11-14T22:19:20.000Z" },
  complete: true,
};

const poolStateView: ForgePoolStateView = {
  proposal: { status: "unavailable", reason: "forge sepolia target not configured" },
  position: {
    status: "ok",
    position: {
      state: "none",
      positionId: null,
      tickLower: null,
      tickUpper: null,
      liquidity: null,
      note: "no liquidity intents recorded",
    },
  },
  controls: {
    localPause: false,
    controls: [],
    note: "direct controls run without any agent provider",
  },
  publication: { status: "ok", policy: null, pendingConfirmation: false, lastIntentId: null },
  chain: { snapshot: null, stale: null },
  moduleHash: { installed: null, confirmedOnChain: null, match: null },
  transactions: { items: [], moreAvailable: false },
  freshlyConfirmedExpiry: { status: "unknown", reason: "chain policy snapshot unavailable" },
};

/** The v2 half of a thread-context view: one detector with a committed reading. */
const detectorSummary = {
  status: "ok" as const,
  items: [
    {
      status: "available" as const,
      capabilityId: "flag-detector",
      version: 3,
      armed: true,
      stateRevision: 4,
      evaluationId: "dtev_1",
      asOfMs: 1_700_000_100_000,
      inputDigest: "ab".repeat(32),
      result: {
        status: "matched" as const,
        occurrenceKey: "occ_flag_1",
        validUntilMs: 1_700_000_400_000,
      },
      evidenceIds: ["forge_ev_v2_1"],
    },
    {
      status: "noEvaluation" as const,
      capabilityId: "quiet-detector",
      version: 1,
      armed: false,
      reason: "the installed detector program has not committed an evaluation yet",
    },
  ],
};

const threadContextBase = {
  sources: { status: "unavailable" as const, reason: "forge graph source not configured" },
  capabilities: [],
  latestEvaluation: {
    status: "none" as const,
    reason: "no evaluation has been committed for this thread",
  },
  comparison: {
    status: "unavailable" as const,
    reason: "v2 revision evidence does not exist yet (F5 pending)",
  },
} as const;

/** A payload from before the detector slot existed — the field is absent. */
const legacyThreadContextView: ForgeThreadContextView = {
  ...threadContextBase,
};

const detectorThreadContextView: ForgeThreadContextView = {
  ...threadContextBase,
  detectorEvaluations: detectorSummary,
};

let renderer: ReactTestRenderer | undefined;
let latestSeries: ForgeReadState<ForgePoolSeriesView>;
let latestPoolState: ForgeReadState<ForgePoolStateView>;
let latestThreadContext: ForgeReadState<ForgeThreadContextView>;
let refreshSpy: ReturnType<typeof spyOnRegistryRefresh>;

function spyOnRegistryRefresh() {
  return vi.spyOn(appAtomRegistry, "refresh").mockImplementation(() => {});
}

type SeriesOptions = Parameters<typeof useForgePoolSeries>[2];

function SeriesProbe({ poolId, options }: { poolId: string | null; options: SeriesOptions }) {
  const state = useForgePoolSeries(ENV, poolId, options);
  useLayoutEffect(() => {
    latestSeries = state;
  }, [state]);
  return null;
}

function PoolStateProbe({ options }: { options: Parameters<typeof useForgePoolState>[1] }) {
  const state = useForgePoolState(ENV, options);
  useLayoutEffect(() => {
    latestPoolState = state;
  }, [state]);
  return null;
}

function ThreadContextProbe({ options }: { options: Parameters<typeof useForgeThreadContext>[1] }) {
  const state = useForgeThreadContext(ENV, options);
  useLayoutEffect(() => {
    latestThreadContext = state;
  }, [state]);
  return null;
}

async function renderSeries(poolId: string | null, options: SeriesOptions) {
  await act(() => {
    renderer = create(<SeriesProbe poolId={poolId} options={options} />);
  });
}

async function rerenderSeries(poolId: string | null, options: SeriesOptions) {
  await act(() => {
    renderer?.update(<SeriesProbe poolId={poolId} options={options} />);
  });
}

async function renderPoolState(options: Parameters<typeof useForgePoolState>[1]) {
  await act(() => {
    renderer = create(<PoolStateProbe options={options} />);
  });
}

async function rerenderThreadContext(options: Parameters<typeof useForgeThreadContext>[1]) {
  await act(() => {
    renderer?.update(<ThreadContextProbe options={options} />);
  });
}

async function renderThreadContext(options: Parameters<typeof useForgeThreadContext>[1]) {
  await act(() => {
    renderer = create(<ThreadContextProbe options={options} />);
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", {
    setInterval: (...args: Parameters<typeof setInterval>) => setInterval(...args),
    clearInterval: (id: ReturnType<typeof setInterval>) => clearInterval(id),
  });
  refreshSpy = spyOnRegistryRefresh();
  atomState.result = AsyncResult.initial<ForgePoolSeriesView>();
  atomState.atom = null;
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("forge pool series", () => {
  it("the 30s poll refreshes the exact atom the series reads", async () => {
    vi.useFakeTimers();
    await renderSeries(POOL, { enabled: true, points: 120 });
    const readAtom = atomState.atom;
    expect(readAtom).not.toBeNull();
    expect(refreshSpy).not.toHaveBeenCalled();

    await act(() => {
      vi.advanceTimersByTime(30_000);
    });

    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(refreshSpy.mock.calls[0]![0]).toBe(readAtom);
  });

  it("a closed historical window does not poll", async () => {
    vi.useFakeTimers();
    await renderSeries(POOL, {
      enabled: true,
      poll: true,
      domain: { fromUtcMs: 1_700_000_000_000, toUtcMs: 1_700_000_360_000 },
    });
    expect(refreshSpy).not.toHaveBeenCalled();
    await act(() => {
      vi.advanceTimersByTime(120_000);
    });
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it("a disabled series reads nothing and reports an empty state", async () => {
    await renderSeries(null, { enabled: true });
    expect(latestSeries.data).toBeNull();
    expect(latestSeries.error).toBeNull();
    expect(latestSeries.isLoading).toBe(false);
    await act(() => {
      latestSeries.refresh();
    });
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it("holds the last good view across a failed poll tick, visibly stale", async () => {
    atomState.result = AsyncResult.success(seriesView);
    await renderSeries(POOL, { enabled: true });
    expect(latestSeries.data).toBe(seriesView);
    expect(latestSeries.error).toBeNull();
    expect(latestSeries.stale).toBe(false);

    atomState.result = AsyncResult.failure<ForgePoolSeriesView, Error>(
      Cause.fail(new Error("graph down")),
    );
    await rerenderSeries(POOL, { enabled: true });
    // Retained data stays on screen, but the failure is surfaced and the
    // view is marked stale — a failed poll must never look like a healthy one.
    expect(latestSeries.data).toBe(seriesView);
    expect(latestSeries.error).not.toBeNull();
    expect(latestSeries.stale).toBe(true);
  });

  it("a first-load failure surfaces the error, not a view", async () => {
    atomState.result = AsyncResult.failure<ForgePoolSeriesView, Error>(
      Cause.fail(new Error("offline")),
    );
    await renderSeries(POOL, { enabled: true });
    expect(latestSeries.data).toBeNull();
    expect(latestSeries.error).not.toBeNull();
    expect(latestSeries.stale).toBe(false);
  });

  it("drops the retained view when the pool changes", async () => {
    atomState.result = AsyncResult.success(seriesView);
    await renderSeries(POOL, { enabled: true });
    expect(latestSeries.data).toBe(seriesView);

    atomState.result = AsyncResult.initial<ForgePoolSeriesView>();
    await rerenderSeries("0xdef0000000000000000000000000000000000002", { enabled: true });
    expect(latestSeries.data).toBeNull();
  });

  it("the points cap and domain are part of the family key", () => {
    const plain = orchestrationEnvironment.forgePoolSeries({
      environmentId: ENV,
      input: { poolId: POOL },
    });
    const withPoints = orchestrationEnvironment.forgePoolSeries({
      environmentId: ENV,
      input: { poolId: POOL, points: 120 },
    });
    const withDomain = orchestrationEnvironment.forgePoolSeries({
      environmentId: ENV,
      input: {
        poolId: POOL,
        domain: { fromUtcMs: 1, toUtcMs: 2 },
      },
    });
    expect(plain).not.toBe(withPoints);
    expect(plain).not.toBe(withDomain);
    expect(withPoints).not.toBe(withDomain);
  });
});

describe("forge pool state", () => {
  it("a manual refresh targets the panel-facing atom and the identity holds across rerenders", async () => {
    atomState.result = AsyncResult.success(poolStateView);
    await renderPoolState({ enabled: true });
    const readAtom = atomState.atom;
    expect(latestPoolState.data).toBe(poolStateView);

    await act(() => {
      latestPoolState.refresh();
    });
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(refreshSpy.mock.calls[0]![0]).toBe(readAtom);
  });

  it("does not read or refresh while disabled", async () => {
    await renderPoolState({ enabled: false });
    expect(latestPoolState.data).toBeNull();
    await act(() => {
      latestPoolState.refresh();
    });
    expect(refreshSpy).not.toHaveBeenCalled();
  });
});

describe("forge thread context — v2 detector summaries", () => {
  it("carries the v2 summaries through the state mapping, retention included", async () => {
    atomState.result = AsyncResult.success(detectorThreadContextView);
    await renderThreadContext({ enabled: true, threadId: "thread-9" });
    // The hook's state mapping passes the whole view through by reference;
    // the summaries ride beside the v1 slots untouched.
    expect(latestThreadContext.data).toBe(detectorThreadContextView);
    expect(latestThreadContext.error).toBeNull();
    const summaries =
      latestThreadContext.data === null ? null : forgeDetectorSummaries(latestThreadContext.data);
    expect(summaries?.length).toBe(2);
    const [reading, quiet] = summaries ?? [];
    expect(reading?.status).toBe("available");
    if (reading?.status !== "available") return;
    expect(reading.armed).toBe(true);
    expect(reading.stateRevision).toBe(4);
    expect(reading.result.status).toBe("matched");
    expect(quiet?.status).toBe("noEvaluation");

    // A failed refresh keeps the retained summaries on screen, visibly stale.
    atomState.result = AsyncResult.failure<ForgeThreadContextView, Error>(
      Cause.fail(new Error("graph down")),
    );
    await rerenderThreadContext({ enabled: true, threadId: "thread-9" });
    expect(latestThreadContext.stale).toBe(true);
    expect(latestThreadContext.data).toBe(detectorThreadContextView);
  });

  it("a pre-detector payload (absent field) flows unchanged and reads as no summaries", async () => {
    atomState.result = AsyncResult.success(legacyThreadContextView);
    await renderThreadContext({ enabled: true });
    expect(latestThreadContext.data).toBe(legacyThreadContextView);
    expect(latestThreadContext.data?.detectorEvaluations).toBeUndefined();
    expect(
      latestThreadContext.data !== null ? forgeDetectorSummaries(latestThreadContext.data) : null,
    ).toEqual([]);
  });

  it("the selector never fabricates rows for absent or named-unavailable slots", () => {
    expect(forgeDetectorSummaries(legacyThreadContextView)).toEqual([]);
    expect(
      forgeDetectorSummaries({
        ...threadContextBase,
        detectorEvaluations: {
          status: "unavailable",
          reason: "the detector run store is not wired into this runtime",
        },
      }),
    ).toEqual([]);
    expect(forgeDetectorSummaries(detectorThreadContextView)).toEqual(detectorSummary.items);
  });
});
