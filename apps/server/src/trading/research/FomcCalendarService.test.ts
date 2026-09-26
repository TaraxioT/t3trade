import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";

import { makeFomcCalendarService } from "./FomcCalendarService.ts";

const calendarUrl = "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm";
const archiveUrl = "https://www.federalreserve.gov/monetarypolicy/fomchistorical2020.htm";
const winterUrl = "https://www.federalreserve.gov/newsevents/pressreleases/monetary20260128a.htm";
const summerUrl = "https://www.federalreserve.gov/newsevents/pressreleases/monetary20260617a.htm";

const calendar = `
<h4>2026 FOMC Meetings</h4>
<div class="row fomc-meeting"><div class="fomc-meeting__month"><strong>January</strong></div>
<div class="fomc-meeting__date">27-28</div><strong>Statement:</strong>
<a href="/newsevents/pressreleases/monetary20260128a.htm">HTML</a>
<div class="fomc-meeting__minutes"><strong>Minutes:</strong> (Released February 18, 2026)</div></div>
<div class="row fomc-meeting"><div class="fomc-meeting__month"><strong>June</strong></div>
<div class="fomc-meeting__date">16-17*</div><strong>Statement:</strong>
<a href="/newsevents/pressreleases/monetary20260617a.htm">HTML</a>
<div class="fomc-meeting__minutes">(Released July 08, 2026)</div></div>
<div class="row fomc-meeting"><div class="fomc-meeting__month"><strong>December</strong></div>
<div class="fomc-meeting__date">8-9</div></div><div class="panel-footer">end</div>`;

const archive = `<h5 class="panel-heading panel-heading--shaded">March 15 (unscheduled) Meeting - 2020</h5>
<p><a href="/newsevents/pressreleases/monetary20200315a.htm">Statement</a></p>`;

function page(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html" } });
}

function fixtureFetch(overrides: Record<string, Response> = {}): typeof fetch {
  const pages: Record<string, Response> = {
    [calendarUrl]: page(calendar),
    [archiveUrl]: page(archive),
    [winterUrl]: page(
      '<p class="article__time">January 28, 2026</p><p class="releaseTime">For release at 2:00 p.m. EST</p>',
    ),
    [summerUrl]: page(
      '<p class="article__time">June 17, 2026</p><p class="releaseTime">For release at 2:00 p.m. EDT</p>',
    ),
    "https://www.federalreserve.gov/newsevents/pressreleases/monetary20200315a.htm": page(
      '<p class="article__time">March 15, 2020</p><p class="releaseTime">For release at 5:00 p.m. EDT</p>',
    ),
    ...overrides,
  };
  return (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    return pages[url]?.clone() ?? page("unavailable", 404);
  }) as typeof fetch;
}

describe("FomcCalendarService", () => {
  it.runIf(process.env.T3_FOMC_SMOKE === "1")(
    "resolves an official January 2026 statement",
    async () => {
      const service = makeFomcCalendarService();
      const inventory = await Effect.runPromise(
        service.resolve({
          from: "2026-01-01",
          to: "2026-02-01",
          asOf: Date.parse("2026-09-26T00:00:00Z"),
          category: "scheduled",
        }),
      );
      expect(inventory.status).toBe("complete");
      expect(inventory.occurrences).toHaveLength(1);
      expect(inventory.occurrences[0]?.statementAt).toBe(Date.parse("2026-01-28T19:00:00Z"));
    },
  );

  it.runIf(process.env.T3_FOMC_SMOKE === "1")(
    "resolves the five-year official meeting inventory",
    async () => {
      const service = makeFomcCalendarService();
      const inventory = await Effect.runPromise(
        service.resolve({
          from: "2021-09-26",
          to: "2026-09-27",
          asOf: Date.parse("2026-09-26T23:59:59Z"),
          category: "scheduled",
        }),
      );
      expect(inventory.occurrences.length).toBeGreaterThan(30);
      expect(inventory.status).toBe("complete");
      expect(
        inventory.occurrences.filter((event) => event.statementAt !== null).length,
      ).toBeGreaterThan(30);
    },
  );

  it("uses statement release time, not the later minutes date, across EST and EDT", async () => {
    const service = makeFomcCalendarService({
      fetch: fixtureFetch(),
      retrievedAt: 1_800_000_000_000,
    });
    const inventory = await Effect.runPromise(
      service.resolve({
        from: "2026-01-01",
        to: "2026-07-01",
        asOf: 1_800_000_000_000,
        category: "scheduled",
      }),
    );
    expect(inventory.status).toBe("complete");
    expect(inventory.occurrences).toHaveLength(2);
    expect(inventory.occurrences.map((row) => row.statementAt)).toEqual([
      Date.parse("2026-01-28T19:00:00Z"),
      Date.parse("2026-06-17T18:00:00Z"),
    ]);
    expect(inventory.occurrences[0]?.meetingFrom).toBe("2026-01-27");
    expect(inventory.occurrences[0]?.minutesReleasedOn).toBe("2026-02-18");
    expect(inventory.occurrences[0]?.sourceExcerpt).toContain("2:00 p.m. EST");
    expect(inventory.occurrences[0]?.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(inventory.occurrences[0]?.timezoneInterpretation).toBe(
      "America/New_York (EST, UTC-05:00)",
    );
  });

  it("keeps future meetings with an explicit missing-time reason", async () => {
    const service = makeFomcCalendarService({
      fetch: fixtureFetch(),
      retrievedAt: 1_800_000_000_000,
    });
    const inventory = await Effect.runPromise(
      service.resolve({
        from: "2026-12-01",
        to: "2027-01-01",
        asOf: Date.parse("2026-09-26T00:00:00Z"),
        category: "scheduled",
      }),
    );
    expect(inventory.occurrences[0]).toMatchObject({
      statementAt: null,
      missingTimeReason: "future_unpublished",
      sourceUrl: calendarUrl,
    });
  });

  it("reads official historical archives and classifies unscheduled decisions", async () => {
    const service = makeFomcCalendarService({
      fetch: fixtureFetch(),
      retrievedAt: 1_800_000_000_000,
    });
    const inventory = await Effect.runPromise(
      service.resolve({
        from: "2020-03-01",
        to: "2020-04-01",
        asOf: 1_800_000_000_000,
        category: "all",
      }),
    );
    expect(inventory.occurrences).toHaveLength(1);
    expect(inventory.occurrences[0]).toMatchObject({
      classification: "unscheduled",
      statementAt: Date.parse("2020-03-15T21:00:00Z"),
    });
  });

  it("keeps a historical meeting without a statement link as a missing row", async () => {
    const missing =
      '<h5 class="panel-heading panel-heading--shaded">March 15 (unscheduled) Meeting - 2020</h5><p>No statement</p>';
    const service = makeFomcCalendarService({
      fetch: fixtureFetch({ [archiveUrl]: page(missing) }),
      retrievedAt: 1_800_000_000_000,
    });
    const inventory = await Effect.runPromise(
      service.resolve({
        from: "2020-03-01",
        to: "2020-04-01",
        asOf: 1_800_000_000_000,
        category: "all",
      }),
    );
    expect(inventory.occurrences).toHaveLength(1);
    expect(inventory.occurrences[0]?.missingTimeReason).toBe("source_missing");
    expect(inventory.status).toBe("incomplete");
  });

  it("does not expose a release that occurred after the frozen cutoff", async () => {
    const lateArchive =
      '<h5 class="panel-heading panel-heading--shaded">March 2 (unscheduled) Meeting - 2020</h5><p><a href="/newsevents/pressreleases/monetary20200303a.htm">Statement</a></p>';
    const service = makeFomcCalendarService({
      fetch: fixtureFetch({
        [archiveUrl]: page(lateArchive),
        "https://www.federalreserve.gov/newsevents/pressreleases/monetary20200303a.htm": page(
          '<p class="article__time">March 3, 2020</p><p class="releaseTime">For release at 5:00 p.m. EST</p>',
        ),
      }),
      retrievedAt: 1_800_000_000_000,
    });
    const inventory = await Effect.runPromise(
      service.resolve({
        from: "2020-03-01",
        to: "2020-04-01",
        asOf: Date.parse("2020-03-03T12:00:00Z"),
        category: "all",
      }),
    );
    expect(inventory.occurrences[0]?.statementAt).toBeNull();
    expect(inventory.occurrences[0]?.missingTimeReason).toBe("future_unpublished");
  });

  it("deduplicates duplicate source entries and preserves missing release times", async () => {
    const duplicateCalendar = calendar.replace(
      '<div class="panel-footer">end</div>',
      calendar.slice(
        calendar.indexOf('<div class="row fomc-meeting">'),
        calendar.indexOf(
          '<div class="row fomc-meeting">',
          calendar.indexOf('<div class="row fomc-meeting">') + 1,
        ),
      ) + '<div class="panel-footer">end</div>',
    );
    const service = makeFomcCalendarService({
      fetch: fixtureFetch({
        [calendarUrl]: page(duplicateCalendar),
        [summerUrl]: page(
          '<p class="article__time">June 17, 2026</p><p class="releaseTime">Time to be announced</p>',
        ),
      }),
      retrievedAt: 1_800_000_000_000,
    });
    const inventory = await Effect.runPromise(
      service.resolve({
        from: "2026-01-01",
        to: "2026-07-01",
        asOf: 1_800_000_000_000,
        category: "scheduled",
      }),
    );
    expect(inventory.occurrences).toHaveLength(2);
    expect(inventory.occurrences[1]).toMatchObject({
      statementAt: null,
      missingTimeReason: "not_published",
    });
  });

  it("marks affected periods incomplete after a statement fetch or parse failure", async () => {
    const service = makeFomcCalendarService({
      fetch: fixtureFetch({ [winterUrl]: page("down", 503) }),
      retrievedAt: 1_800_000_000_000,
    });
    const inventory = await Effect.runPromise(
      service.resolve({
        from: "2026-01-01",
        to: "2026-02-01",
        asOf: 1_800_000_000_000,
        category: "scheduled",
      }),
    );
    expect(inventory.status).toBe("incomplete");
    expect(inventory.affectedPeriods).toEqual(["2026-01"]);
    expect(inventory.occurrences[0]?.missingTimeReason).toBe("source_unavailable");
    const malformed = makeFomcCalendarService({
      fetch: fixtureFetch({
        [winterUrl]: page(
          '<p class="article__time">January 28, 2026</p><p class="releaseTime">For release at 25:99 p.m. EST</p>',
        ),
      }),
      retrievedAt: 1_800_000_000_000,
    });
    const malformedInventory = await Effect.runPromise(
      malformed.resolve({
        from: "2026-01-01",
        to: "2026-02-01",
        asOf: 1_800_000_000_000,
        category: "scheduled",
      }),
    );
    expect(malformedInventory.status).toBe("incomplete");
    expect(malformedInventory.affectedPeriods).toEqual(["2026-01"]);
  });

  it("refuses inventories over the exact 200-occurrence bound", async () => {
    const rows = Array.from({ length: 201 }, (_, index) => {
      const date = DateTime.toDateUtc(DateTime.makeUnsafe(Date.UTC(2026, 0, index + 1)));
      const month = date.toLocaleString("en-US", { month: "long", timeZone: "UTC" });
      return `<div class="row fomc-meeting"><div class="fomc-meeting__month"><strong>${month}</strong></div><div class="fomc-meeting__date">${date.getUTCDate()}</div></div>`;
    }).join("");
    const service = makeFomcCalendarService({
      fetch: fixtureFetch({
        [calendarUrl]: page(
          `<h4>2026 FOMC Meetings</h4>${rows}<div class="panel-footer">end</div>`,
        ),
      }),
      retrievedAt: 1_800_000_000_000,
    });
    const result = await Effect.runPromise(
      Effect.result(
        service.resolve({
          from: "2026-01-01",
          to: "2027-01-01",
          asOf: 1_800_000_000_000,
          category: "all",
        }),
      ),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure.detail).toContain("200");
  });

  it("rejects an invalid civil date before fetching", async () => {
    let calls = 0;
    const service = makeFomcCalendarService({
      fetch: (async () => {
        calls++;
        return page(calendar);
      }) as typeof fetch,
      retrievedAt: 1_800_000_000_000,
    });
    const result = await Effect.runPromise(
      Effect.result(
        service.resolve({
          from: "2026-02-30",
          to: "2026-03-01",
          asOf: 1_800_000_000_000,
          category: "scheduled",
        }),
      ),
    );
    expect(result._tag).toBe("Failure");
    expect(calls).toBe(0);
  });
});
