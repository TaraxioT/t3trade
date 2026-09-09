import type {
  EnvironmentId,
  OrchestrationReviseTradingPlanResult,
  TradingMissionId,
} from "@t3tools/contracts";
import type { TradingPlanState } from "@t3tools/trading-contracts/strategy";
import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  applyPlanDrag,
  missionRevisionScopeKey,
  useMissionPlanRevision,
  usePlanRevisionStore,
  type MissionPlanRevision,
} from "./useMissionPlanRevision";

const plan: TradingPlanState = {
  market: "ETH",
  intent: "long",
  entry: {
    triggers: [
      { description: "breaks 1,860", priceLevel: 1860, confirmation: "close" },
      { description: "retests 1,850", priceLevel: 1850 },
    ],
    urgency: "patient",
    initialNotionalUsd: 500,
  },
  stop: { method: "below the last swing", price: 1840, maximumPlannedLossUsd: 25 },
  target: { method: "the range high", price: 1900, profitUsd: 40 },
  invalidation: ["the 1m regime flips"],
  reassess: { afterMinutes: 45 },
  because: "the range has held three times",
  updatedAt: 1_000,
};

describe("applyPlanDrag", () => {
  it("replaces exactly one leaf and leaves the other seven fields identical", () => {
    const next = applyPlanDrag(plan, { kind: "stop", price: 1858.1 });
    expect(next.stop).toEqual({
      method: "below the last swing",
      price: 1858.1,
      maximumPlannedLossUsd: 25,
    });
    expect(next.market).toBe(plan.market);
    expect(next.intent).toBe(plan.intent);
    expect(next.entry).toEqual(plan.entry);
    expect(next.target).toEqual(plan.target);
    expect(next.invalidation).toEqual(plan.invalidation);
    expect(next.reassess).toEqual(plan.reassess);
    expect(next.because).toBe(plan.because);
  });

  it("keeps a target's method and rung when only its price moved", () => {
    const next = applyPlanDrag(plan, { kind: "target", price: 1912 });
    expect(next.target).toEqual({ method: "the range high", price: 1912, profitUsd: 40 });
  });

  it("does not mutate the plan it was given", () => {
    applyPlanDrag(plan, { kind: "stop", price: 1 });
    expect(plan.stop.price).toBe(1840);
  });
});

type DispatchCommandPayload = {
  readonly environmentId: EnvironmentId;
  readonly input: {
    readonly missionId: TradingMissionId;
    readonly expectedMissionVersion: number;
    readonly strategy: unknown;
  };
};

type DispatchResult =
  | { readonly _tag: "Success"; readonly value: OrchestrationReviseTradingPlanResult }
  | { readonly _tag: "Failure"; readonly cause: { readonly message: string } };

const mockDispatch = vi.fn<(payload: DispatchCommandPayload) => Promise<DispatchResult>>();

vi.mock("../../lib/tradingMissionsState", () => ({
  refreshTradingMissions: vi.fn(),
}));

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => mockDispatch,
}));

function TestRevisionConsumer({
  missionId,
  environmentId,
  onUpdate,
}: {
  readonly missionId: TradingMissionId;
  readonly environmentId: EnvironmentId;
  readonly onUpdate: (revision: MissionPlanRevision) => void;
}) {
  const revision = useMissionPlanRevision(missionId, environmentId);
  onUpdate(revision);
  return createElement("div", { "data-mission-id": missionId });
}

describe("useMissionPlanRevision: scoped by environmentId AND missionId", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    usePlanRevisionStore.setState({ byScopeKey: {} });
    mockDispatch.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("computes the canonical scope key combining environment and mission", () => {
    expect(
      missionRevisionScopeKey("env-alpha" as EnvironmentId, "mission-1" as TradingMissionId),
    ).toBe("env-alpha:mission-1");
  });

  it("chart and persistent information in the same scope share feedback", async () => {
    let chartRevision!: MissionPlanRevision;
    let infoRevision!: MissionPlanRevision;

    let resolveCommand!: (res: DispatchResult) => void;
    mockDispatch.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCommand = resolve;
        }),
    );

    let root!: ReactTestRenderer;
    act(() => {
      root = create(
        createElement(
          "div",
          null,
          createElement(TestRevisionConsumer, {
            missionId: "mission-eth" as TradingMissionId,
            environmentId: "env-1" as EnvironmentId,
            onUpdate: (rev) => {
              chartRevision = rev;
            },
          }),
          createElement(TestRevisionConsumer, {
            missionId: "mission-eth" as TradingMissionId,
            environmentId: "env-1" as EnvironmentId,
            onUpdate: (rev) => {
              infoRevision = rev;
            },
          }),
        ),
      );
    });

    expect(chartRevision.isBusy).toBe(false);
    expect(infoRevision.isBusy).toBe(false);

    // Revise triggered from chart
    act(() => {
      chartRevision.revise(plan, { kind: "stop", price: 1850 }, 1);
    });

    // Both chart and info are busy in the same scope
    expect(chartRevision.isBusy).toBe(true);
    expect(infoRevision.isBusy).toBe(true);

    // Command returns refusal
    await act(async () => {
      resolveCommand({
        _tag: "Success",
        value: {
          outcome: "accepted",
          strategy: plan,
          warnings: [],
          target: null,
          stop: {
            status: "refused",
            refusal: "Stop price too close to mark",
            planStopPrice: 1850,
            restingStopPrice: null,
          },
        },
      });
    });

    // Both chart and info share the refusedStop feedback
    expect(chartRevision.isBusy).toBe(false);
    expect(infoRevision.isBusy).toBe(false);
    expect(chartRevision.refusedStop).toEqual({
      planPrice: 1850,
      detail: "Stop price too close to mark",
    });
    expect(infoRevision.refusedStop).toEqual({
      planPrice: 1850,
      detail: "Stop price too close to mark",
    });

    act(() => {
      root.unmount();
    });
  });

  it("identical mission IDs in different environments remain independent", async () => {
    let env1Revision!: MissionPlanRevision;
    let env2Revision!: MissionPlanRevision;

    let resolveEnv1!: (res: DispatchResult) => void;
    mockDispatch.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveEnv1 = resolve;
        }),
    );

    let root!: ReactTestRenderer;
    act(() => {
      root = create(
        createElement(
          "div",
          null,
          createElement(TestRevisionConsumer, {
            missionId: "shared-id" as TradingMissionId,
            environmentId: "env-1" as EnvironmentId,
            onUpdate: (rev) => {
              env1Revision = rev;
            },
          }),
          createElement(TestRevisionConsumer, {
            missionId: "shared-id" as TradingMissionId,
            environmentId: "env-2" as EnvironmentId,
            onUpdate: (rev) => {
              env2Revision = rev;
            },
          }),
        ),
      );
    });

    act(() => {
      env1Revision.revise(plan, { kind: "stop", price: 1850 }, 1);
    });

    // env-1 is busy, but env-2 is completely untouched
    expect(env1Revision.isBusy).toBe(true);
    expect(env2Revision.isBusy).toBe(false);
    expect(env2Revision.refusedStop).toBeNull();
    expect(env2Revision.error).toBeNull();

    await act(async () => {
      resolveEnv1({
        _tag: "Success",
        value: {
          outcome: "accepted",
          strategy: plan,
          warnings: [],
          target: null,
          stop: {
            status: "refused",
            refusal: "Refused in env 1",
            planStopPrice: 1850,
            restingStopPrice: null,
          },
        },
      });
    });

    expect(env1Revision.refusedStop?.detail).toBe("Refused in env 1");
    // env-2 remains completely clean
    expect(env2Revision.refusedStop).toBeNull();
    expect(env2Revision.isBusy).toBe(false);

    act(() => {
      root.unmount();
    });
  });

  it("a late completion updates only its originating scope", async () => {
    let env1Revision!: MissionPlanRevision;
    let env2Revision!: MissionPlanRevision;

    let resolveEnv1!: (res: DispatchResult) => void;
    let resolveEnv2!: (res: DispatchResult) => void;

    mockDispatch.mockImplementation((payload) => {
      if (payload.environmentId === "env-1") {
        return new Promise((resolve) => {
          resolveEnv1 = resolve;
        });
      }
      return new Promise((resolve) => {
        resolveEnv2 = resolve;
      });
    });

    let root!: ReactTestRenderer;
    act(() => {
      root = create(
        createElement(
          "div",
          null,
          createElement(TestRevisionConsumer, {
            missionId: "mission-target" as TradingMissionId,
            environmentId: "env-1" as EnvironmentId,
            onUpdate: (rev) => {
              env1Revision = rev;
            },
          }),
          createElement(TestRevisionConsumer, {
            missionId: "mission-target" as TradingMissionId,
            environmentId: "env-2" as EnvironmentId,
            onUpdate: (rev) => {
              env2Revision = rev;
            },
          }),
        ),
      );
    });

    // Launch dispatch in env-1 (which will be late)
    act(() => {
      env1Revision.revise(plan, { kind: "stop", price: 1845 }, 1);
    });

    // In the meantime, launch dispatch in env-2
    act(() => {
      env2Revision.revise(plan, { kind: "stop", price: 1848 }, 1);
    });

    // Resolve env-2 first
    await act(async () => {
      resolveEnv2({
        _tag: "Success",
        value: {
          outcome: "accepted",
          strategy: plan,
          warnings: [],
          stop: null,
          target: null,
        },
      });
    });

    expect(env2Revision.isBusy).toBe(false);
    expect(env2Revision.error).toBeNull();
    expect(env1Revision.isBusy).toBe(true);

    // Finally resolve env-1 late with rejected outcome
    await act(async () => {
      resolveEnv1({
        _tag: "Success",
        value: {
          outcome: "rejected",
          reason: "mission_not_active",
          currentVersion: 2,
          detail: "Mission expired on env-1",
        },
      });
    });

    expect(env1Revision.isBusy).toBe(false);
    expect(env1Revision.error).toBe("Mission expired on env-1");
    // env-2 was NOT overwritten by env-1's late resolution
    expect(env2Revision.error).toBeNull();

    act(() => {
      root.unmount();
    });
  });

  it("switching graph presentation during a pending revision preserves its result/refusal feedback", async () => {
    let chartRevision: MissionPlanRevision | null = null;
    let infoRevision!: MissionPlanRevision;

    let resolveCommand!: (res: DispatchResult) => void;
    mockDispatch.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCommand = resolve;
        }),
    );

    // Both chart and info initially mounted in "mission" graph mode
    let root!: ReactTestRenderer;
    act(() => {
      root = create(
        createElement(
          "div",
          null,
          createElement(TestRevisionConsumer, {
            missionId: "mission-eth" as TradingMissionId,
            environmentId: "env-1" as EnvironmentId,
            onUpdate: (rev) => {
              chartRevision = rev;
            },
          }),
          createElement(TestRevisionConsumer, {
            missionId: "mission-eth" as TradingMissionId,
            environmentId: "env-1" as EnvironmentId,
            onUpdate: (rev) => {
              infoRevision = rev;
            },
          }),
        ),
      );
    });

    act(() => {
      chartRevision?.revise(plan, { kind: "stop", price: 1855 }, 1);
    });
    expect(infoRevision.isBusy).toBe(true);

    // User switches to "research" graph mode: chart unmounts, info remains mounted
    chartRevision = null;
    act(() => {
      root.update(
        createElement(TestRevisionConsumer, {
          missionId: "mission-eth" as TradingMissionId,
          environmentId: "env-1" as EnvironmentId,
          onUpdate: (rev) => {
            infoRevision = rev;
          },
        }),
      );
    });

    // Pending revision completes while chart is unmounted
    await act(async () => {
      resolveCommand({
        _tag: "Success",
        value: {
          outcome: "accepted",
          strategy: plan,
          warnings: [],
          target: null,
          stop: {
            status: "refused",
            refusal: "Market is closed",
            planStopPrice: 1855,
            restingStopPrice: null,
          },
        },
      });
    });

    expect(infoRevision.isBusy).toBe(false);
    expect(infoRevision.refusedStop).toEqual({
      planPrice: 1855,
      detail: "Market is closed",
    });

    // User switches back to "mission" graph mode: chart remounts
    act(() => {
      root.update(
        createElement(
          "div",
          null,
          createElement(TestRevisionConsumer, {
            missionId: "mission-eth" as TradingMissionId,
            environmentId: "env-1" as EnvironmentId,
            onUpdate: (rev) => {
              chartRevision = rev;
            },
          }),
          createElement(TestRevisionConsumer, {
            missionId: "mission-eth" as TradingMissionId,
            environmentId: "env-1" as EnvironmentId,
            onUpdate: (rev) => {
              infoRevision = rev;
            },
          }),
        ),
      );
    });

    // Remounted chart and persistent info both reflect the refusal feedback
    expect((chartRevision as MissionPlanRevision | null)?.refusedStop).toEqual({
      planPrice: 1855,
      detail: "Market is closed",
    });
    expect(infoRevision.refusedStop).toEqual({
      planPrice: 1855,
      detail: "Market is closed",
    });

    act(() => {
      root.unmount();
    });
  });
});
