import { createHash } from "node:crypto";
import { Clock, Context, DateTime, Effect, Layer, Option, Schema } from "effect";

import {
  ResearchError,
  type FomcEventInventory,
  type FomcEventOccurrence,
} from "@t3tools/trading-contracts/researchData";

export interface FomcCalendarRequest {
  readonly from: string;
  readonly to: string;
  readonly asOf: number;
  readonly category: "scheduled" | "unscheduled" | "all";
}

export interface FomcCalendarServiceShape {
  readonly resolve: (
    request: FomcCalendarRequest,
  ) => Effect.Effect<FomcEventInventory, ResearchError>;
}

export class FomcCalendarService extends Context.Service<
  FomcCalendarService,
  FomcCalendarServiceShape
>()("t3/trading/research/FomcCalendarService") {}

const ORIGIN = "https://www.federalreserve.gov";
const CALENDAR_URL = `${ORIGIN}/monetarypolicy/fomccalendars.htm`;
const MAX_OCCURRENCES = 200;
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

interface CalendarEntry {
  readonly meetingFrom: string;
  readonly meetingTo: string;
  readonly classification: "scheduled" | "unscheduled";
  readonly statementUrl: string | null;
  readonly minutesReleasedOn: string | null;
  readonly calendarUrl: string;
  readonly calendarHash: string;
}

interface SourcePage {
  readonly html: string;
  readonly hash: string;
}

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function fail(detail: string): ResearchError {
  return new ResearchError({ reason: "invalid_request", detail });
}

function clean(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function monthNumber(value: string): number | null {
  const index = MONTHS.findIndex((month) => month.toLowerCase() === value.toLowerCase());
  return index < 0 ? null : index + 1;
}

function isoDate(year: number, month: number, day: number): string | null {
  const text = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const parsed = DateTime.make(`${text}T00:00:00Z`);
  return Option.isSome(parsed) && DateTime.formatIsoDateUtc(parsed.value) === text ? text : null;
}

function linkToStatement(html: string, archive: boolean): string | null {
  if (archive) {
    const match = html.match(/<a\s+href=["']([^"']+)["'][^>]*>\s*Statement\s*<\/a>/i);
    return match ? new URL(match[1]!, ORIGIN).href : null;
  }
  const statementAt = html.search(/<strong>\s*Statement:\s*<\/strong>/i);
  if (statementAt < 0) return null;
  const section = html.slice(statementAt, html.indexOf("</div>", statementAt));
  const match = section.match(/<a\s+href=["']([^"']+)["'][^>]*>\s*HTML\s*<\/a>/i);
  return match ? new URL(match[1]!, ORIGIN).href : null;
}

function parseCalendar(html: string, hash: string): ReadonlyArray<CalendarEntry> {
  const entries: CalendarEntry[] = [];
  const headings = [
    ...html.matchAll(
      /<h4>\s*<a[^>]*>\s*(20\d{2}) FOMC Meetings\s*<\/a>\s*<\/h4>|<h4>\s*(20\d{2}) FOMC Meetings\s*<\/h4>/gi,
    ),
  ];
  for (let sectionIndex = 0; sectionIndex < headings.length; sectionIndex++) {
    const heading = headings[sectionIndex]!;
    const year = Number(heading[1] ?? heading[2]);
    const start = heading.index! + heading[0].length;
    const end = headings[sectionIndex + 1]?.index ?? html.length;
    const section = html.slice(start, end);
    const rowStarts = [
      ...section.matchAll(/<div\s+class=["'][^"']*\brow fomc-meeting\b[^"']*["'][^>]*>/gi),
    ];
    for (let rowIndex = 0; rowIndex < rowStarts.length; rowIndex++) {
      const rowStart = rowStarts[rowIndex]!;
      const row = section.slice(rowStart.index!, rowStarts[rowIndex + 1]?.index ?? section.length);
      const monthText = row
        .match(/fomc-meeting__month[^>]*>\s*<strong>\s*([^<]+)\s*<\/strong>/i)?.[1]
        ?.trim();
      const dateText = clean(row.match(/fomc-meeting__date[^>]*>([^<]+)/i)?.[1] ?? "").replace(
        /\*/g,
        "",
      );
      if (!monthText || !dateText) continue;
      const months = monthText
        .split("/")
        .map((part) =>
          monthNumber(
            part.length <= 3
              ? (MONTHS.find((month) => month.toLowerCase().startsWith(part.toLowerCase())) ?? part)
              : part,
          ),
        );
      const days = dateText.match(/^(\d{1,2})(?:\s*[-–]\s*(\d{1,2}))?$/);
      if (!days || months.some((month) => month === null)) continue;
      const startMonth = months[0]!;
      const endMonth = months[1] ?? startMonth;
      const from = isoDate(year, startMonth, Number(days[1]));
      const to = isoDate(year, endMonth, Number(days[2] ?? days[1]));
      if (!from || !to) continue;
      const released = row.match(/\(Released\s+([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})\)/i);
      entries.push({
        meetingFrom: from,
        meetingTo: to,
        classification: /unscheduled|notation vote/i.test(row) ? "unscheduled" : "scheduled",
        statementUrl: linkToStatement(row, false),
        minutesReleasedOn: released
          ? isoDate(Number(released[3]), monthNumber(released[1]!) ?? 0, Number(released[2]))
          : null,
        calendarUrl: CALENDAR_URL,
        calendarHash: hash,
      });
    }
  }
  return entries;
}

function parseArchive(
  html: string,
  hash: string,
  year: number,
  url: string,
): ReadonlyArray<CalendarEntry> {
  const entries: CalendarEntry[] = [];
  const headings = [
    ...html.matchAll(
      /<h5[^>]*>\s*([A-Za-z]+)\s+(\d{1,2})(?:\s*[-–]\s*(\d{1,2}))?\s*(?:\((unscheduled|notation vote|cancelled)\))?\s*(?:Meeting)?\s*-\s*(20\d{2})\s*<\/h5>/gi,
    ),
  ];
  for (let index = 0; index < headings.length; index++) {
    const match = headings[index]!;
    if (Number(match[5]) !== year || match[4]?.toLowerCase() === "cancelled") continue;
    const month = monthNumber(match[1]!);
    if (month === null) continue;
    const from = isoDate(year, month, Number(match[2]));
    const to = isoDate(year, month, Number(match[3] ?? match[2]));
    if (!from || !to) continue;
    const body = html.slice(
      match.index! + match[0].length,
      headings[index + 1]?.index ?? html.length,
    );
    const statementUrl = linkToStatement(body, true);
    const released = body.match(/Minutes\s*\(Released\s+([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})\)/i);
    entries.push({
      meetingFrom: from,
      meetingTo: to,
      classification: match[4] ? "unscheduled" : "scheduled",
      statementUrl,
      minutesReleasedOn: released
        ? isoDate(Number(released[3]), monthNumber(released[1]!) ?? 0, Number(released[2]))
        : null,
      calendarUrl: url,
      calendarHash: hash,
    });
  }
  return entries;
}

function releaseTime(page: SourcePage): { at: number; excerpt: string; timezone: string } | null {
  const dateText = clean(
    page.html.match(/<p\s+class=["']article__time["'][^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? "",
  );
  const timeText = clean(
    page.html.match(/<p\s+class=["']releaseTime["'][^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? "",
  );
  const date = dateText.match(/^([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})$/);
  const time = timeText.match(/For release at\s+(\d{1,2}):(\d{2})\s*(a\.m\.|p\.m\.)\s*(EST|EDT)/i);
  if (!date || !time) return null;
  const month = monthNumber(date[1]!);
  if (month === null) return null;
  const day = isoDate(Number(date[3]), month, Number(date[2]));
  if (!day) return null;
  if (Number(time[1]) < 1 || Number(time[1]) > 12) return null;
  const hour = (Number(time[1]) % 12) + (time[3]!.toLowerCase() === "p.m." ? 12 : 0);
  const minute = Number(time[2]);
  if (minute > 59) return null;
  const abbreviation = time[4]!.toUpperCase();
  const offset = abbreviation === "EST" ? 5 : 4;
  const at = Date.parse(`${day}T00:00:00Z`) + (hour + offset) * 3_600_000 + minute * 60_000;
  const actual = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    timeZoneName: "short",
  }).format(DateTime.toDateUtc(DateTime.makeUnsafe(at)));
  if (!actual.endsWith(abbreviation)) return null;
  return {
    at,
    excerpt: `${dateText}; ${timeText}`,
    timezone: `America/New_York (${abbreviation}, UTC-0${offset}:00)`,
  };
}

export function makeFomcCalendarService(
  options: {
    readonly fetch?: typeof globalThis.fetch;
    readonly retrievedAt?: number;
  } = {},
): FomcCalendarServiceShape {
  const fetchPage = options.fetch ?? globalThis.fetch;
  const encodeInventory = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
  const getPage = async (url: string): Promise<SourcePage | null> => {
    try {
      const response = await fetchPage(url, { headers: { accept: "text/html" } });
      if (!response.ok) return null;
      const html = await response.text();
      return { html, hash: digest(html) };
    } catch {
      return null;
    }
  };
  return {
    resolve: (request) =>
      Effect.flatMap(Clock.currentTimeMillis, (now) =>
        Effect.tryPromise({
          try: async () => {
            const retrievedAt = options.retrievedAt ?? now;
            if (
              !/^\d{4}-\d{2}-\d{2}$/.test(request.from) ||
              !/^\d{4}-\d{2}-\d{2}$/.test(request.to) ||
              isoDate(
                Number(request.from.slice(0, 4)),
                Number(request.from.slice(5, 7)),
                Number(request.from.slice(8, 10)),
              ) !== request.from ||
              isoDate(
                Number(request.to.slice(0, 4)),
                Number(request.to.slice(5, 7)),
                Number(request.to.slice(8, 10)),
              ) !== request.to ||
              Date.parse(request.from) >= Date.parse(request.to) ||
              !Number.isSafeInteger(request.asOf) ||
              request.asOf < 0 ||
              !["scheduled", "unscheduled", "all"].includes(request.category)
            ) {
              throw fail("FOMC request needs valid half-open dates and a frozen asOf timestamp");
            }
            const firstYear = Number(request.from.slice(0, 4));
            const lastYear = Number(request.to.slice(0, 4));
            if (firstYear < 2000 || lastYear > 2027)
              throw fail("FOMC inventory supports 2000 through 2027");
            const affected = new Set<string>();
            const observedAt = Math.min(request.asOf, retrievedAt);
            const entries: CalendarEntry[] = [];
            if (lastYear >= 2021) {
              const page = await getPage(CALENDAR_URL);
              if (!page) {
                for (let year = Math.max(firstYear, 2021); year <= lastYear; year++)
                  affected.add(String(year));
              } else {
                const parsed = parseCalendar(page.html, page.hash);
                entries.push(...parsed);
                for (let year = Math.max(firstYear, 2021); year <= lastYear; year++) {
                  if (!parsed.some((entry) => entry.meetingFrom.startsWith(String(year))))
                    affected.add(String(year));
                }
              }
            }
            for (let year = firstYear; year <= Math.min(lastYear, 2020); year++) {
              const url = `${ORIGIN}/monetarypolicy/fomchistorical${year}.htm`;
              const page = await getPage(url);
              if (!page) {
                affected.add(String(year));
                continue;
              }
              const parsed = parseArchive(page.html, page.hash, year, url);
              if (parsed.length === 0) affected.add(String(year));
              entries.push(...parsed);
            }
            const scoped = entries.filter(
              (entry) =>
                entry.meetingTo >= request.from &&
                entry.meetingTo < request.to &&
                (request.category === "all" || entry.classification === request.category),
            );
            if (scoped.length > MAX_OCCURRENCES)
              throw fail(
                `FOMC inventory supports at most ${MAX_OCCURRENCES} occurrences per request`,
              );
            const unique = [
              ...new Map(
                scoped.map((entry) => [
                  `${entry.meetingTo}:${entry.classification}:${entry.statementUrl ?? ""}`,
                  entry,
                ]),
              ).values(),
            ];
            const occurrences: FomcEventOccurrence[] = [];
            for (const entry of unique) {
              const period = entry.meetingTo.slice(0, 7);
              const base = {
                id: `fomc:${entry.classification}:${entry.meetingTo}`,
                meetingFrom: entry.meetingFrom,
                meetingTo: entry.meetingTo,
                classification: entry.classification,
                sourceUrl: entry.statementUrl ?? entry.calendarUrl,
                calendarUrl: entry.calendarUrl,
                calendarHash: entry.calendarHash,
                retrievedAt,
                minutesReleasedOn: entry.minutesReleasedOn,
              };
              if (Date.parse(`${entry.meetingTo}T23:59:59Z`) > observedAt) {
                occurrences.push({
                  ...base,
                  statementAt: null,
                  missingTimeReason: "future_unpublished",
                  sourceHash: entry.calendarHash,
                  sourceExcerpt: "Statement not yet published as of cutoff",
                  timezoneInterpretation: "America/New_York (release time pending)",
                });
                continue;
              }
              if (!entry.statementUrl) {
                affected.add(period);
                occurrences.push({
                  ...base,
                  statementAt: null,
                  missingTimeReason: "source_missing",
                  sourceHash: entry.calendarHash,
                  sourceExcerpt: "Calendar has no statement link",
                  timezoneInterpretation: "America/New_York (release time missing)",
                });
                continue;
              }
              const page = await getPage(entry.statementUrl);
              if (!page) {
                affected.add(period);
                occurrences.push({
                  ...base,
                  statementAt: null,
                  missingTimeReason: "source_unavailable",
                  sourceHash: entry.calendarHash,
                  sourceExcerpt: "Statement source unavailable",
                  timezoneInterpretation: "America/New_York (release time unavailable)",
                });
                continue;
              }
              const release = releaseTime(page);
              if (release && release.at > observedAt) {
                occurrences.push({
                  ...base,
                  statementAt: null,
                  missingTimeReason: "future_unpublished",
                  sourceHash: entry.calendarHash,
                  sourceExcerpt: "Statement not yet published as of cutoff",
                  timezoneInterpretation: "America/New_York (release time pending)",
                });
                continue;
              }
              if (release) {
                occurrences.push({
                  ...base,
                  statementAt: release.at,
                  missingTimeReason: null,
                  sourceHash: page.hash,
                  sourceExcerpt: release.excerpt,
                  timezoneInterpretation: release.timezone,
                });
              } else {
                const excerpt = clean(
                  page.html.match(/<p\s+class=["']releaseTime["'][^>]*>([\s\S]*?)<\/p>/i)?.[1] ??
                    "No release time in statement",
                );
                if (/For release at/i.test(excerpt)) affected.add(period);
                occurrences.push({
                  ...base,
                  statementAt: null,
                  missingTimeReason: "not_published",
                  sourceHash: page.hash,
                  sourceExcerpt: excerpt,
                  timezoneInterpretation: "America/New_York (release time missing)",
                });
              }
            }
            occurrences.sort(
              (a, b) => a.meetingTo.localeCompare(b.meetingTo) || a.id.localeCompare(b.id),
            );
            const affectedPeriods = [...affected].sort();
            const inventoryCore = {
              category: request.category,
              from: request.from,
              to: request.to,
              asOf: request.asOf,
              retrievedAt,
              status: affectedPeriods.length ? ("incomplete" as const) : ("complete" as const),
              affectedPeriods,
              occurrences,
            };
            return { ...inventoryCore, id: digest(encodeInventory(inventoryCore)) };
          },
          catch: (cause) =>
            Schema.is(ResearchError)(cause)
              ? cause
              : new ResearchError({ reason: "source", detail: "FOMC source retrieval failed" }),
        }),
      ),
  };
}

export const FomcCalendarServiceLive = Layer.succeed(
  FomcCalendarService,
  makeFomcCalendarService(),
);
