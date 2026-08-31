/**
 * The plan-state card, pinned on its states: every activation state renders
 * its own explicit markup (never colour-only), drift says that the disk plan
 * changed and new exposure is paused, projectless and loading are their own
 * states rather than silent absences, and a refused acknowledge surfaces as an
 * error. Rendered to static markup because the card is a document; the states
 * under test are all text.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import type { OrchestrationTradingMission } from "@t3tools/contracts";

import { TradingPlanDocumentCard } from "./TradingPlanDocumentCard";

// The card's only live dependency is the activate command; every state under
// test is a render of projection data, so the atom layer is stubbed out.
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => vi.fn(),
}));
vi.mock("../../state/orchestration", () => ({
  orchestrationEnvironment: { activateTradingPlanDocument: {} },
}));

const BASE_MISSION = {
  id: "mission_1",
  threadId: "thread_1",
  mandateOrigin: "strategy",
} as unknown as OrchestrationTradingMission;

const withPlan = (planDocument: OrchestrationTradingMission["planDocument"]) =>
  ({ ...BASE_MISSION, planDocument }) as OrchestrationTradingMission;

const renderCard = (mission: OrchestrationTradingMission, isLoading = false) =>
  renderToStaticMarkup(
    <TradingPlanDocumentCard
      mission={mission}
      environmentId={"env_1" as never}
      threadId={"thread_1" as never}
      isLoading={isLoading}
      onOpenFile={() => {}}
    />,
  );

describe("TradingPlanDocumentCard", () => {
  it("renders the loading state rather than nothing while the snapshot is in flight", () => {
    const markup = renderCard(BASE_MISSION, true);
    expect(markup).toContain("Loading plan state");
  });

  it("renders projectless as its own state, not as a missing file", () => {
    const markup = renderCard(withPlan(null));
    expect(markup).toContain("No workspace on this thread");
  });

  it("labels an absent document without implying an active plan", () => {
    const markup = renderCard(
      withPlan({
        relativePath: "TRADE.md",
        activation: "none",
        contentHash: null,
        activatedHash: null,
        activatedAt: null,
        missionId: null,
      }),
    );
    expect(markup).toContain("No TRADE.md");
    expect(markup).not.toContain("rev ");
  });

  it("shows the draft state with an activate action", () => {
    const markup = renderCard(
      withPlan({
        relativePath: "TRADE.md",
        activation: "draft",
        contentHash: "a1b2c3d4e5f6",
        activatedHash: null,
        activatedAt: null,
        missionId: null,
      }),
    );
    expect(markup).toContain("Draft");
    expect(markup).toContain("Activate");
    expect(markup).not.toContain("changed on disk");
  });

  it("shows the active state with the short revision hash", () => {
    const markup = renderCard(
      withPlan({
        relativePath: "TRADE.md",
        activation: "active",
        contentHash: "a1b2c3d4e5f6",
        activatedHash: "a1b2c3d4e5f6",
        activatedAt: "2026-08-30T00:00:00.000Z",
        missionId: "mission_1",
      }),
    );
    expect(markup).toContain("Active");
    expect(markup).toContain("rev a1b2c3d");
    expect(markup).toContain("activated");
    expect(markup).not.toContain("Activate new revision");
  });

  it("says drift paused new exposure and offers the safe next actions", () => {
    const markup = renderCard(
      withPlan({
        relativePath: "TRADE.md",
        activation: "drifted",
        contentHash: "ffffffffffff",
        activatedHash: "a1b2c3d4e5f6",
        activatedAt: "2026-08-30T00:00:00.000Z",
        missionId: "mission_1",
      }),
    );
    expect(markup).toContain("Drifted");
    expect(markup).toContain("changed on disk after this revision was activated");
    expect(markup).toContain("New exposure is paused");
    expect(markup).toContain("Activate new revision");
  });

  it("always offers opening the document", () => {
    for (const activation of ["none", "draft", "active", "drifted"] as const) {
      const markup = renderCard(
        withPlan({
          relativePath: "TRADE.md",
          activation,
          contentHash: activation === "none" ? null : "a1b2c3d4e5f6",
          activatedHash:
            activation === "active" || activation === "drifted" ? "a1b2c3d4e5f6" : null,
          activatedAt: null,
          missionId: null,
        }),
      );
      expect(markup).toContain("TRADE.md");
      expect(markup).toContain("Open");
    }
  });
});
