import type { ForgeDetectorEvaluationsView, ForgeThreadContextView } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { DetectorReadings } from "./DetectorPanel";

vi.mock("../../lib/forgeBridgeState", () => ({ useForgeThreadContext: vi.fn() }));
vi.mock("./composerPrefill", () => ({ useComposerPrefill: vi.fn() }));

const NOW = 1_780_000_000_000;
function markup(slot: ForgeDetectorEvaluationsView | undefined, stale = false) {
  const data: ForgeThreadContextView = {
    sources: { status: "unavailable", reason: "not configured" },
    capabilities: [],
    latestEvaluation: { status: "none", reason: "no v1 evaluation" },
    comparison: { status: "unavailable", reason: "not compared" },
    ...(slot === undefined ? {} : { detectorEvaluations: slot }),
  };
  return renderToStaticMarkup(
    <DetectorReadings
      state={{
        data,
        stale,
        error: stale ? "Refresh failed" : null,
        isLoading: false,
        refresh: vi.fn(),
      }}
      now={NOW}
      prefill={null}
    />,
  );
}
const reading = {
  status: "available" as const,
  capabilityId: "release-flow",
  version: 2,
  armed: true,
  stateRevision: 3,
  evaluationId: "evaluation-1",
  asOfMs: NOW - 30_000,
  inputDigest: "a".repeat(64),
  evidenceIds: [],
};

describe("detector readings", () => {
  it("keeps absent, unavailable, empty and unevaluated distinct", () => {
    expect(markup(undefined)).toContain("does not expose detector readings");
    expect(markup({ status: "unavailable", reason: "run-store-unwired" })).toContain(
      "run-store-unwired",
    );
    expect(markup({ status: "ok", items: [] })).toContain("No installed detector");
    expect(
      markup({
        status: "ok",
        items: [
          {
            status: "noEvaluation",
            capabilityId: "release-flow",
            version: 2,
            armed: true,
            reason: "not-run",
          },
        ],
      }),
    ).toContain("No evaluation: not-run");
  });
  it("does not show an expired occurrence as a current match", () => {
    expect(
      markup({
        status: "ok",
        items: [
          {
            ...reading,
            result: { status: "matched", occurrenceKey: "release-1", validUntilMs: NOW },
          },
        ],
      }),
    ).toContain("Match expired");
    expect(
      markup({
        status: "ok",
        items: [
          {
            ...reading,
            result: { status: "matched", occurrenceKey: "release-1", validUntilMs: NOW + 1 },
          },
        ],
      }),
    ).toContain(">Matched<");
  });
  it("preserves unknown and not matched explanations with evaluation provenance", () => {
    for (const status of ["unknown", "not-matched"] as const) {
      const html = markup({
        status: "ok",
        items: [
          {
            ...reading,
            result: { status, explanation: "External source has no recorded availability" },
          },
        ],
      });
      expect(html).toContain("External source has no recorded availability");
      expect(html).toContain("evaluation-1");
      expect(html).toContain("state revision 3");
      expect(html).toContain("does not mean a trade executed");
    }
  });
  it("marks a retained result and armed standing stale after failed refresh", () => {
    const html = markup(
      {
        status: "ok",
        items: [{ ...reading, result: { status: "unknown", explanation: "missing evidence" } }],
      },
      true,
    );
    expect(html).toContain("Stale retained readings");
    expect(html).toContain("(retained)");
    expect(html).toContain("Refresh failed");
  });
  it("keeps direct disarm available for stale data while preventing a stale arm", () => {
    const data: ForgeThreadContextView = {
      sources: { status: "unavailable", reason: "not configured" },
      capabilities: [],
      latestEvaluation: { status: "none", reason: "no v1 evaluation" },
      comparison: { status: "unavailable", reason: "not compared" },
      detectorEvaluations: {
        status: "ok",
        items: [
          { ...reading, armed: false, result: { status: "unknown", explanation: "missing" } },
        ],
      },
    };
    const html = renderToStaticMarkup(
      <DetectorReadings
        state={{ data, stale: true, error: "Refresh failed", isLoading: false, refresh: vi.fn() }}
        now={NOW}
        prefill={null}
        onControl={vi.fn()}
        controlMessage="Control refused: paused"
      />,
    );
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Arm detector/);
    const disarmTag = html.slice(0, html.indexOf("Disarm detector")).split("<button").at(-1);
    expect(disarmTag).not.toContain(' disabled=""');
    expect(html).toContain("Control refused: paused");
    expect(html).toContain("grants no execution authority");
  });
  it("renders loading and failed initial reads without inventing data", () => {
    for (const isLoading of [true, false]) {
      const html = renderToStaticMarkup(
        <DetectorReadings
          state={{ data: null, stale: false, error: null, isLoading, refresh: vi.fn() }}
          now={NOW}
          prefill={null}
        />,
      );
      expect(html).toContain(isLoading ? "Loading detectors" : "Detector readings unavailable");
    }
  });
});
