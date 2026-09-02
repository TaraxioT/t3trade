/**
 * The research scene panel, pinned on its static markup: the persisted
 * notional initializes the illustration (and survives a remount), the money
 * label says gross change rather than a balance, and the calendar stage draws
 * the server-composed semantic layers (a named activation rule, price-anchored
 * entry and exit, the signed return) instead of downgrading them to anonymous
 * event bands. Event aligned names the event mean against the baseline mean,
 * and says exactly when there is no baseline to draw. Rendered to static
 * markup because the panel is a document; the one thing markup cannot show,
 * motion, is asserted by its absence.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { ResearchScenePanel } from "./ResearchScenePanel";

const DAY = 24 * 60 * 60 * 1_000;
const T0 = 1_710_000_000_000;
const T1 = T0 + 60 * DAY;

// The windowed chart read, mocked at the hook so the panel and both its
// chart-fetching children see one archive: daily bars from six days before
// the first activation past both horizons.
const CANDLES = Array.from({ length: 110 }, (_, i) => ({
  openTime: T0 + (i - 6) * DAY,
  open: 100,
  high: 101,
  low: 99,
  close: 100,
  volume: 1,
  trades: 1,
}));

vi.mock("../../lib/tradingMarketChartState", () => ({
  useTradingMarketChart: () => ({ data: { candles: CANDLES }, error: null, stale: false }),
}));

const coveredRow = (startAt: number, label: string, returnPct: number) => ({
  startAt,
  endAt: startAt,
  label,
  source: "https://example.org/activation",
  covered: true,
  reason: undefined,
  entryTime: startAt + DAY - 1,
  entryPrice: 3900.5,
  exitTime: startAt + 31 * DAY - 1,
  exitPrice: returnPct === -10 ? 3510.45 : 4000,
  returnPct,
  truncated: false,
  barsCovered: 30,
});

const rows = [
  coveredRow(T0, "Dencun", -10),
  coveredRow(T1, "Pectra", 4),
  {
    startAt: T1 + 200 * DAY,
    endAt: T1 + 200 * DAY,
    label: "Futurera",
    source: "https://example.org/next",
    covered: false,
    reason: "still in the future: it ends after the last archived bar",
    entryTime: undefined,
    entryPrice: undefined,
    exitTime: undefined,
    exitPrice: undefined,
    returnPct: undefined,
    truncated: false,
    barsCovered: undefined,
  },
];

const payload = (
  baseline: { samples: number; meanReturnPct: number; medianReturnPct: number } | null,
) =>
  ({
    priceSource: "hyperliquid",
    entryBasis: "first_closed_bar_after_event",
    illustrativeNotionalUsd: 5_000,
    requestedFromT: T0,
    requestedToT: T1 + 31 * DAY,
    eventSetId: "set-1",
    eventSetName: "ETH upgrades",
    market: "ETH",
    interval: "1d",
    horizonBars: 30,
    report: {
      horizonBars: 30,
      horizonMs: 30 * DAY,
      n: 3,
      nCovered: 2,
      meanReturnPct: -3,
      medianReturnPct: -3,
      hitRatePercent: 33.33,
      bestReturnPct: 4,
      worstReturnPct: -10,
      baseline,
      rows,
      verdict: "2 of 3 occurrences fall inside archived data.",
    },
    occurrenceWindows: rows,
    archiveBounds: { recordingSince: T0 - 400 * DAY, fromT: T0, toT: T1 + 31 * DAY },
  }) as never;

const deterministic = [
  { kind: "event_span", startAt: T0, endAt: T0, label: "Dencun", occurrenceIndex: 0 },
  {
    kind: "study_entry",
    at: T0 + DAY - 1,
    price: 3900.5,
    occurrenceIndex: 0,
  },
  { kind: "study_exit", at: T0 + 31 * DAY - 1, price: 3510.45, occurrenceIndex: 0 },
  {
    kind: "return_span",
    fromT: T0 + DAY - 1,
    toT: T0 + 31 * DAY - 1,
    returnPct: -10,
    occurrenceIndex: 0,
  },
  { kind: "event_span", startAt: T1, endAt: T1, label: "Pectra", occurrenceIndex: 1 },
  { kind: "study_entry", at: T1 + DAY - 1, price: 3900.5, occurrenceIndex: 1 },
  { kind: "study_exit", at: T1 + 31 * DAY - 1, price: 4000, occurrenceIndex: 1 },
  {
    kind: "return_span",
    fromT: T1 + DAY - 1,
    toT: T1 + 31 * DAY - 1,
    returnPct: 4,
    occurrenceIndex: 1,
  },
  {
    kind: "event_span",
    startAt: T1 + 200 * DAY,
    endAt: T1 + 200 * DAY,
    label: "Futurera",
    occurrenceIndex: 2,
  },
] as never;

const renderPanel = (
  mode: "calendar" | "aligned",
  baseline: { samples: number; meanReturnPct: number; medianReturnPct: number } | null = {
    samples: 40,
    meanReturnPct: 1,
    medianReturnPct: 1,
  },
) =>
  renderToStaticMarkup(
    <ResearchScenePanel
      environmentId={"env" as never}
      scenes={[
        {
          sceneId: "scene-1",
          threadId: "thread-1",
          status: "active",
          referenceStatus: "ok",
          kind: "event_study",
          title: "ETH upgrades on ETH, 1d bars, 30 forward",
          createdAt: T0,
          updatedAt: T0,
          calculationVersion: "event-study-2",
          disclaimer: "Historical research. No order placed. Not a forecast.",
          scene: {
            sceneId: "scene-1",
            kind: "event_study",
            viewport: { kind: "event_aligned", anchorAt: T0 },
            deterministic,
            authored: [],
            sources: ["https://example.org/activation"],
            disclaimer: "Historical research. No order placed. Not a forecast.",
          },
          eventStudy: payload(baseline),
        } as never,
      ]}
      loading={false}
      error={null}
      mode={mode}
      prefill={null}
    />,
  );

describe("ResearchScenePanel: calendar mode", () => {
  const markup = renderPanel("calendar");

  it("initializes the illustration from the persisted notional, on every mount", () => {
    expect(markup).toContain('value="5000"');
    // A second mount is a reload's first render: the persisted 5,000 must
    // come back, never the UI's own 1,000 default.
    expect(renderPanel("calendar")).toContain('value="5000"');
    expect(markup).not.toContain('value="1000"');
  });

  it("labels the money figure as a signed gross change on the notional, before costs", () => {
    expect(markup).toContain("-$500");
    expect(markup).toContain("historical gross change on $5,000, before costs");
    // The ending balance mislabelled as a change is the exact lie this label
    // exists to prevent.
    expect(markup).not.toContain("4,500");
  });

  it("draws the server-composed activation rule and price-anchored entry and exit in the stage", () => {
    expect(markup).toContain('data-testid="research-calendar-stage"');
    expect(markup).toContain('data-testid="research-study-activation"');
    expect(markup).toContain('data-testid="research-study-entry"');
    expect(markup).toContain('data-testid="research-study-exit"');
    expect(markup).toContain('data-testid="research-study-return"');
    // The occurrence's own name rides the rule, not the word "event".
    expect(markup).toContain("Dencun");
    // The horizon rides the exit label.
    expect(markup).toContain("study exit after 30 bars");
    // Accessible text: historical measurements, explicitly not fills.
    expect(markup).toContain("study entry (historical, not a fill)");
    expect(markup).toContain("signed return -10.00%");
    expect(markup).toContain("no order was placed");
  });

  it("no longer downgrades the study to anonymous event/entry/exit bands", () => {
    // The old downgrade drew three zero-width bands labelled event, entry and
    // exit; an instantaneous activation now draws its named rule instead.
    expect(markup).not.toContain("event-band-event:");
    expect(markup).not.toContain("event-band-entry:");
    expect(markup).not.toContain("event-band-exit:");
  });

  it("keeps the honesty block, the occurrence navigation and the uncovered row's reason in the inspector", () => {
    expect(markup).toContain('data-testid="research-inspector"');
    expect(markup).toContain('data-testid="research-occurrence-nav"');
    expect(markup).toContain("2 of 3 occurrences fall inside archived data");
    expect(markup).toContain("entry basis: close of the first closed bar after the event");
    expect(markup).toContain("requested ");
    expect(markup).toContain("served ");
    expect(markup).toContain("not measured:");
    expect(markup).toContain("occurrence 1 of 3");
  });

  it("renders one source link per occurrence, the row's own URL", () => {
    expect(markup).toContain("https://example.org/activation");
    expect(markup).toContain("https://example.org/next");
  });

  it("adds no baseline price line to Calendar: a return baseline is not a price level", () => {
    expect(markup).not.toContain('data-testid="research-baseline-reference"');
    expect(markup).not.toContain("Baseline mean");
  });
});

describe("ResearchScenePanel: event-aligned mode, baseline present", () => {
  const markup = renderPanel("aligned");

  it("shows the aggregate comparison first, labelled with both means and the difference", () => {
    expect(markup).toContain('data-testid="research-aligned-stage"');
    expect(markup).toContain('data-testid="research-aggregate"');
    expect(markup).toContain('data-testid="research-baseline-summary"');
    expect(markup).toContain("Event mean -3.00%");
    expect(markup).toContain("Baseline mean +1.00%");
    expect(markup).toContain("event minus baseline -4.00%");
  });

  it("labels the horizon and the covered occurrence count beside the comparison", () => {
    expect(markup).toContain("30 bars (30 days)");
    expect(markup).toContain("2 covered occurrences");
  });

  it("keeps the per-occurrence traces and labels in the inspector, with the small-sample honesty", () => {
    expect(markup).toContain('data-testid="research-aligned-trace"');
    expect(markup).toContain("Dencun");
    expect(markup).toContain("Pectra");
    expect(markup).toContain("n = 2 occurrences");
    // The zero line is named for what it is, so it can never read as a baseline.
    expect(markup).toContain("zero change");
  });

  it("keeps the descriptive-not-significance baseline wording", () => {
    expect(markup).toContain("not a significance test");
    expect(markup).toContain("overlapping windows");
  });
});

describe("ResearchScenePanel: event-aligned mode, baseline unavailable", () => {
  const markup = renderPanel("aligned", null);

  it("states the missing baseline in one exact sentence", () => {
    expect(markup).toContain("Baseline unavailable for this served window");
    expect(markup).toContain('data-testid="research-baseline-unavailable"');
  });

  it("draws nothing that could be mistaken for a baseline line", () => {
    expect(markup).not.toContain("Baseline mean");
    expect(markup).not.toContain("event minus baseline");
    expect(markup).not.toContain('data-testid="research-baseline-reference"');
    // The event mean still has its own label; only the comparison is absent.
    expect(markup).toContain("Event mean -3.00%");
  });
});

describe("ResearchScenePanel: loading, empty and error states keep the panel's shape", () => {
  it("renders the error sentence, not a panel, when scenes fail to load", () => {
    const markup = renderToStaticMarkup(
      <ResearchScenePanel
        environmentId={"env" as never}
        scenes={[]}
        loading={false}
        error={"websocket closed"}
        mode="calendar"
        prefill={null}
      />,
    );
    expect(markup).toContain('data-testid="research-scenes-error"');
    expect(markup).toContain("research scenes unavailable: websocket closed");
  });

  it("renders a loading placeholder while the first read is in flight", () => {
    const markup = renderToStaticMarkup(
      <ResearchScenePanel
        environmentId={"env" as never}
        scenes={[]}
        loading={true}
        error={null}
        mode="calendar"
        prefill={null}
      />,
    );
    expect(markup).toContain('data-testid="research-scenes-loading"');
  });

  it("renders nothing when the thread holds no scenes", () => {
    const markup = renderToStaticMarkup(
      <ResearchScenePanel
        environmentId={"env" as never}
        scenes={[]}
        loading={false}
        error={null}
        mode="calendar"
        prefill={null}
      />,
    );
    expect(markup).toBe("");
  });
});
