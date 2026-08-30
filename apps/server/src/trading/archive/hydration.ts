/**
 * On-demand hydration: bounded requests for recoverable market windows,
 * consumed by the sole archive writer, with explicit outcomes.
 *
 * The archive records what someone was paying attention to, so a study or
 * backtest can name a window the archive has not covered even though the one
 * approved source could still serve it. The reader cannot fetch (reads stay
 * deterministic), and nothing but the single lease holder may write. Between
 * those two facts sits this file: a typed request-and-result queue beside the
 * archive database, written by readers through {@link TradingMarketArchive},
 * drained by the archiver's tick, bounded in count, span, and wait.
 *
 * ## The vocabulary is the contract
 *
 * Every request ends in one of the outcome words below, and every answer the
 * system gives a user is one of them — never "no data," never silence:
 * - `already_covered` — the archive already holds the window; nothing fetched.
 * - `queued` / `hydrating` — accepted; the writer is on it (or will be).
 * - `hydrated` — fetched and stored; a re-read will see the bars.
 * - `partial` — some of the window was served; the rest may be re-asked.
 * - `source_window_exhausted` — the one provider's own history ends inside
 *   the window; the remainder can never come from this source. This is also
 *   the enqueue answer for a sound window that predates the reach outright:
 *   the input is hydratable, the history simply is not there.
 * - `rate_limited` — the source said slow down; the request may be re-asked.
 * - `unsupported` — input the queue will never take: a venue or interval it
 *   does not record, a window past the fetch cap, or a deadline out of
 *   bounds.
 * - `timed_out` — the request's deadline passed before an answer.
 * - `failed` — the attempt errored, or the request was displaced; the queue
 *   keeps the sentence.
 *
 * ## Identity, coalescing, and provenance
 *
 * Every accepted request carries a stable `id` that its waiter keeps for the
 * whole wait, and every terminal result names the request `id` it answers.
 * Coalescing therefore happens at exactly one place — the writer, when it
 * plans its fetches — where identical and overlapping compatible requests
 * share one provider call while each still receives its own result, assessed
 * against its own requested window. Nothing ever rewrites a queued request's
 * window, so a widened fetch can never strand a waiter whose key vanished,
 * and a widened group can never silently exceed the span cap: groups that
 * would exceed it are fetched separately. Coalescing never crosses venue,
 * coin, or interval, and a request whose venue does not match the writer's
 * own is `unsupported`, not best-effort — mainnet and testnet series can
 * never merge silently.
 *
 * The provider decision stays typed and narrow: the only source the archive
 * hydrates from is Hyperliquid itself, within the window `candleSnapshot`
 * still serves. Older windows (a 2022 event on a 2023-listed venue) refuse
 * with the sentence that says why, and the adapter decision record in
 * docs/internals is where a second source would have to be argued first.
 *
 * ## The transport
 *
 * The queue is one JSON file with two classes of writer: readers enqueue
 * (server process) and the sole archive writer drains (archiver process).
 * Both sides take a filesystem lock around their read-modify-write, write
 * atomically (temp file + rename), and treat a malformed or unreadable file
 * as `unusable` — never as an empty queue, which would erase pending work.
 * Capacity overflow displaces the request with the least time left and
 * records a terminal `failed` result for it; expired requests are answered
 * `timed_out` by the writer, exactly once each.
 *
 * @module archiveHydration
 */
// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - shared by the standalone archiver and the server.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";

import { Effect } from "effect";

import {
  ARCHIVE_DATA_PROVIDER_ID,
  CANDLE_WINDOW_BARS,
  HYDRATION_MAX_BARS,
  HYDRATION_MAX_PENDING,
  HYDRATION_MAX_PER_TICK,
  HYDRATION_MAX_WAIT_MS,
  HYDRATION_QUEUE_LOCK_STALE_MS,
  HYDRATION_QUEUE_LOCK_WAIT_MS,
  hydrationRequestsPath,
  INTERVAL_MS,
  MAINNET_ARCHIVE_VENUE,
  TESTNET_ARCHIVE_VENUE,
} from "./config.ts";

/** Why the window is being fetched; rides the queue for diagnostics. */
export type HydrationPurpose = "chart" | "study" | "backtest";

/** The two isolated series recorded from the one approved data provider. */
export const HYDRATION_VENUES = [MAINNET_ARCHIVE_VENUE, TESTNET_ARCHIVE_VENUE] as const;
export type HydrationVenue = (typeof HYDRATION_VENUES)[number];

/** One queued window. `id` is the stable identity its waiter and result share. */
export interface HydrationRequest {
  readonly id: string;
  readonly venue: HydrationVenue;
  readonly coin: string;
  readonly interval: string;
  readonly fromT: number;
  readonly toT: number;
  readonly purpose: HydrationPurpose;
  readonly requestedAt: number;
  /** Requests past their deadline are answered `timed_out` and dropped. */
  readonly deadlineAt: number;
}

/** The terminal vocabulary. `queued`/`hydrating` are queue states, not results. */
export const HYDRATION_OUTCOMES = [
  "already_covered",
  "hydrating",
  "hydrated",
  "partial",
  "source_window_exhausted",
  "rate_limited",
  "unsupported",
  "timed_out",
  "failed",
] as const;
export type HydrationOutcome = (typeof HYDRATION_OUTCOMES)[number];

/** Outcomes the writer may record against a request id. */
export type HydrationResultOutcome = Exclude<HydrationOutcome, "hydrating" | "queued">;

/**
 * The enqueue path's local answers, mapped from the vocabulary above. A
 * queued answer carries the request id its waiter will watch.
 *
 * `unsupported` names input the queue will never take (an interval or venue
 * it does not record, a span past the fetch cap, a deadline out of bounds).
 * `source_window_exhausted` names sound input the one provider cannot reach:
 * the interval and venue are supported, the history simply predates the
 * source — a different sentence from "we do not hydrate that", because the
 * caller's next move differs (nothing to re-ask on a coarser interval will
 * ever make 2015 bars exist).
 */
export type HydrationEnqueueAnswer =
  | { readonly outcome: "queued"; readonly id: string }
  | { readonly outcome: "unsupported"; readonly reason: string }
  | { readonly outcome: "source_window_exhausted"; readonly reason: string }
  | { readonly outcome: "failed"; readonly reason: string };

/** One finished request, as the writer (or a displacing producer) reported it. */
export interface HydrationResult {
  /** The stable id of the request this answers. */
  readonly id: string;
  readonly outcome: HydrationResultOutcome;
  readonly finishedAt: number;
  readonly barsFetched?: number;
  readonly reason?: string;
}

/** The queue file: pending requests plus the writer's recent answers. */
export interface HydrationQueue {
  readonly requests: ReadonlyArray<HydrationRequest>;
  readonly results: ReadonlyArray<HydrationResult>;
}

/** Reading the file: an empty queue, or an unusable one that must not be erased. */
export type HydrationQueueRead =
  | { readonly status: "ok"; readonly queue: HydrationQueue }
  | { readonly status: "unusable"; readonly reason: string };

/** A display key for logs: venue:coin:interval:fromT-toT. */
export const requestKey = (request: {
  readonly venue: string;
  readonly coin: string;
  readonly interval: string;
  readonly fromT: number;
  readonly toT: number;
}): string =>
  `${request.venue}:${request.coin}:${request.interval}:${request.fromT}-${request.toT}`;

/** How many finished answers the file keeps. A log, not a ledger. */
export const HYDRATION_MAX_RESULTS = 32;

// ---------------------------------------------------------------------------
// pure window math
// ---------------------------------------------------------------------------

/** Grid-aligned opens in `[fromT, toT]` for a bar width, oldest first. */
export function gridOpens(fromT: number, toT: number, intervalMs: number): ReadonlyArray<number> {
  const first = Math.ceil(fromT / intervalMs) * intervalMs;
  const last = Math.floor(toT / intervalMs) * intervalMs;
  if (last < first || intervalMs <= 0) return [];
  const opens: number[] = [];
  for (let open = first; open <= last; open += intervalMs) opens.push(open);
  return opens;
}

/** How many grid-aligned opens `[fromT, toT]` holds — the honest span unit. */
export function gridBarCount(fromT: number, toT: number, intervalMs: number): number {
  const first = Math.ceil(fromT / intervalMs) * intervalMs;
  const last = Math.floor(toT / intervalMs) * intervalMs;
  return last < first || intervalMs <= 0 ? 0 : (last - first) / intervalMs + 1;
}

/**
 * The oldest instant the one data provider can still serve for an interval,
 * with a one-bar margin so a request at exactly the reach is not refused for
 * the sake of a bar the planner would fetch anyway.
 */
export function providerReachFloor(interval: string, now: number): number | null {
  const width = INTERVAL_MS[interval as keyof typeof INTERVAL_MS];
  if (width === undefined) return null;
  return now - (CANDLE_WINDOW_BARS - 1) * width;
}

/**
 * What the archive honestly holds for a requested candle window, as one pure
 * assessment both sides of the queue share.
 *
 * `archivedOpens` are the open times actually stored for the series inside
 * the window (the caller queries them; passing the opens rather than a count
 * is what keeps a present in-progress bar from masking a missing closed one).
 * `gaps` are the known-gap records; an overlapping unreconciled gap keeps the
 * window incomplete even when every required bar is present, because a later
 * read would still report the stretch as missing. `providerFloor` bounds what
 * the one source can ever serve: grid bars older than it are counted as
 * beyond reach, not as missing from this source's recoverable part.
 */
export interface WindowCoverageAssessment {
  /** Grid-aligned opens in `[fromT, toT]` whose bars have already closed. */
  readonly expectedClosedBars: number;
  /** Expected closed opens at or after the provider floor — the recoverable part. */
  readonly requiredBars: number;
  /** Expected closed opens before the provider floor — the source can never serve them. */
  readonly unavailableBars: number;
  /** How many of the stored opens fall inside the window. */
  readonly archivedBars: number;
  /** Recoverable opens with no stored bar. */
  readonly missingBars: number;
  /** The recoverable missing opens themselves, oldest first, for reasons and splits. */
  readonly missingOpens: ReadonlyArray<number>;
  /** True when the window's newest grid bar has not closed yet — its absence is not a hole. */
  readonly finalBarMayBeOpen: boolean;
  /** Known-gap records overlapping the window, clipped to it, oldest first. */
  readonly overlappingGaps: ReadonlyArray<{ readonly fromT: number; readonly toT: number }>;
  /**
   * Every closed open the window requested is stored AND no gap record
   * overlaps it. A window whose historical prefix predates the provider's
   * reach is never complete, however much of it is recoverable: `complete`
   * describes the requested window, not the part the source happens to serve.
   */
  readonly complete: boolean;
}

export function assessWindowCoverage(input: {
  readonly intervalMs: number;
  readonly fromT: number;
  readonly toT: number;
  readonly now: number;
  readonly archivedOpens: ReadonlyArray<number>;
  readonly providerFloor: number | null;
  readonly gaps: ReadonlyArray<{ readonly fromT: number; readonly toT: number }>;
}): WindowCoverageAssessment {
  const { intervalMs, fromT, toT, now, archivedOpens, providerFloor, gaps } = input;
  const inWindow = gridOpens(fromT, toT, intervalMs);
  // A bar has closed when its close (open + width) is in the past.
  const lastClosedOpen = Math.floor((now - intervalMs) / intervalMs) * intervalMs;
  const newestOpen = inWindow[inWindow.length - 1];
  const finalBarMayBeOpen = newestOpen !== undefined && newestOpen > lastClosedOpen;
  const floorOpen =
    providerFloor === null ? -Infinity : Math.ceil(providerFloor / intervalMs) * intervalMs;
  const expectedClosed = inWindow.filter((open) => open <= lastClosedOpen);
  const recoverable = expectedClosed.filter((open) => open >= floorOpen);
  const unavailable = expectedClosed.filter((open) => open < floorOpen);
  const stored = new Set(archivedOpens);
  const missingOpens = recoverable.filter((open) => !stored.has(open));
  const overlappingGaps = gaps
    .filter((gap) => gap.toT >= fromT && gap.fromT <= toT)
    .map((gap) => ({
      fromT: Math.max(gap.fromT, fromT),
      toT: Math.min(gap.toT, toT),
    }));
  return {
    expectedClosedBars: expectedClosed.length,
    requiredBars: recoverable.length,
    unavailableBars: unavailable.length,
    archivedBars: Math.min(archivedOpens.length, inWindow.length),
    missingBars: missingOpens.length,
    missingOpens,
    finalBarMayBeOpen,
    overlappingGaps,
    complete: expectedClosed.every((open) => stored.has(open)) && overlappingGaps.length === 0,
  };
}

/**
 * Classify one drain attempt into the outcome vocabulary, from the
 * before/after assessments plus what the fetch actually saw. Pure: the writer
 * reports, this maps to the one honest word.
 *
 * `effectiveFloorT` is the oldest instant the source is proven to serve for
 * this market: the generic reach, or the first bar it actually returned when
 * the market's own history begins later than the generic reach does. An empty
 * successful response means the market's own history does not reach the
 * window at all — that is exhaustion, not failure.
 *
 * `completeBefore` is the same window's assessment taken before the fetch:
 * `already_covered` is legal only when the complete window already existed,
 * and `hydrated` only when this attempt finished making it whole. Rows the
 * fetch merely re-served can never turn pre-existing coverage into a fresh
 * recovery.
 */
export function classifyHydrationOutcome(input: {
  readonly after: WindowCoverageAssessment;
  readonly completeBefore: boolean;
  readonly barsFetched: number;
  readonly effectiveFloorT: number | null;
  readonly emptySuccessfulResponse: boolean;
  readonly error?: string | undefined;
  readonly rateLimited?: boolean | undefined;
}): { readonly outcome: HydrationResultOutcome; readonly reason: string | null } {
  if (input.error !== undefined) {
    return input.rateLimited === true
      ? { outcome: "rate_limited", reason: input.error }
      : { outcome: "failed", reason: input.error };
  }
  if (input.after.complete) {
    return input.completeBefore
      ? {
          outcome: "already_covered",
          reason: "the window was already whole when the writer reached it",
        }
      : { outcome: "hydrated", reason: null };
  }
  const floor =
    input.emptySuccessfulResponse || input.effectiveFloorT === null
      ? Infinity
      : input.effectiveFloorT;
  const missingBeyond = input.after.missingOpens.filter((open) => open < floor).length;
  const missingWithin = input.after.missingBars - missingBeyond;
  if (missingWithin > 0) {
    const older =
      input.after.unavailableBars > 0
        ? `; ${input.after.unavailableBars} older bar(s) predate the source's own history`
        : "";
    return {
      outcome: "partial",
      reason:
        `${missingWithin} recoverable bar(s) inside ${ARCHIVE_DATA_PROVIDER_ID}'s reach were still ` +
        `not served; the request can be asked again${older}`,
    };
  }
  const exhausted = input.after.unavailableBars + missingBeyond;
  if (exhausted === 0) {
    // Incomplete with every expected bar stored: only an unresolved gap
    // record keeps it so, and the writer reconciles that on the next pass.
    return {
      outcome: "partial",
      reason: "an unresolved gap record still overlaps the window; asking again reconciles it",
    };
  }
  const served = input.after.requiredBars - input.after.missingBars;
  return {
    outcome: "source_window_exhausted",
    reason:
      `${ARCHIVE_DATA_PROVIDER_ID}'s own candle history ends inside this window: ${exhausted} of the ` +
      `requested bar(s) predate it and can never be recovered from it (${served} recoverable bar(s) ` +
      `served); mixing another provider's series into the archive is a decision this product has not made`,
  };
}

// ---------------------------------------------------------------------------
// the queue, purely
// ---------------------------------------------------------------------------

const parseRequest = (entry: unknown): HydrationRequest | null => {
  const record = entry as Partial<HydrationRequest> | null;
  if (record === null) return null;
  const { id, venue, coin, interval, fromT, toT, purpose, requestedAt, deadlineAt } = record;
  if (
    typeof id !== "string" ||
    id.length === 0 ||
    (HYDRATION_VENUES as readonly string[]).includes(venue ?? "") !== true ||
    typeof coin !== "string" ||
    typeof interval !== "string" ||
    typeof fromT !== "number" ||
    typeof toT !== "number" ||
    (purpose !== "chart" && purpose !== "study" && purpose !== "backtest") ||
    typeof requestedAt !== "number" ||
    typeof deadlineAt !== "number"
  ) {
    return null;
  }
  return {
    id,
    venue: venue as HydrationVenue,
    coin,
    interval,
    fromT,
    toT,
    purpose,
    requestedAt,
    deadlineAt,
  };
};

const parseResult = (entry: unknown): HydrationResult | null => {
  const record = entry as Partial<HydrationResult> | null;
  if (record === null) return null;
  const { id, finishedAt } = record;
  const outcome = record.outcome as string | undefined;
  if (
    typeof id !== "string" ||
    id.length === 0 ||
    typeof finishedAt !== "number" ||
    (HYDRATION_OUTCOMES as readonly string[]).includes(outcome ?? "") !== true ||
    outcome === "hydrating" ||
    outcome === "queued"
  ) {
    return null;
  }
  return {
    id,
    outcome: outcome as HydrationResultOutcome,
    finishedAt,
    ...(record.barsFetched === undefined ? {} : { barsFetched: record.barsFetched }),
    ...(record.reason === undefined ? {} : { reason: record.reason }),
  };
};

/**
 * Parse queue content. `null` (no file) is an honest empty queue; anything
 * that fails to parse — a truncated write, a wrong shape, a single invalid
 * entry — is `unusable`, because rewriting it as empty would erase pending
 * work nobody has answered yet.
 */
export function parseHydrationQueue(raw: string | null): HydrationQueueRead {
  if (raw === null) return { status: "ok", queue: { requests: [], results: [] } };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: "unusable", reason: "the queue file is not valid JSON" };
  }
  const record = parsed as { requests?: unknown; results?: unknown } | null;
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    return { status: "unusable", reason: "the queue file is not an object" };
  }
  if (!Array.isArray(record.requests) || !Array.isArray(record.results)) {
    return { status: "unusable", reason: "the queue file lacks its requests or results array" };
  }
  const requests: HydrationRequest[] = [];
  for (const entry of record.requests) {
    const request = parseRequest(entry);
    if (request === null) {
      return { status: "unusable", reason: "the queue file holds an unreadable request" };
    }
    requests.push(request);
  }
  const results: HydrationResult[] = [];
  for (const entry of record.results) {
    const result = parseResult(entry);
    if (result === null) {
      return { status: "unusable", reason: "the queue file holds an unreadable result" };
    }
    results.push(result);
  }
  const ids = new Set<string>();
  for (const request of requests) {
    if (ids.has(request.id)) {
      return { status: "unusable", reason: "the queue file holds a duplicate request id" };
    }
    ids.add(request.id);
  }
  return { status: "ok", queue: { requests, results } };
}

/** Serialize for the file. */
export function renderHydrationQueue(queue: HydrationQueue): string {
  return `${JSON.stringify({ requests: queue.requests, results: queue.results }, null, 2)}\n`;
}

/**
 * Validate and enqueue one request against the caps. Pure: the caller owns
 * the lock, the read, and the write, so the queue decision is testable
 * without a disk.
 *
 * Requests are never merged or widened here — every accepted caller keeps its
 * stable id until a terminal result names it. An identical live request (same
 * venue, coin, interval, and window) shares its id so concurrent equal asks
 * cost one entry; its deadline stretches to the furthest of the two, which
 * can only delay a `timed_out`, never orphan a waiter. Overlapping but
 * different windows stay separate entries; the writer coalesces them into
 * shared fetches when it drains. Expired entries are left in place for the
 * writer to answer `timed_out` exactly once. When the live count is at the
 * cap, the live request with the least time left is displaced with a terminal
 * `failed` result recorded here — capacity pressure answers somebody, it
 * never silently slices work away.
 */
export function enqueueHydrationRequest(
  queue: HydrationQueue,
  request: HydrationRequest,
  now: number,
): { readonly queue: HydrationQueue; readonly answer: HydrationEnqueueAnswer } {
  const width = INTERVAL_MS[request.interval as keyof typeof INTERVAL_MS];
  if (width === undefined) {
    return {
      queue,
      answer: { outcome: "unsupported", reason: `interval ${request.interval} is not recorded` },
    };
  }
  if (request.toT < request.fromT) {
    return { queue, answer: { outcome: "unsupported", reason: "the window is empty" } };
  }
  if (gridBarCount(request.fromT, request.toT, width) > HYDRATION_MAX_BARS) {
    return {
      queue,
      answer: {
        outcome: "unsupported",
        reason: `the window is wider than the ${HYDRATION_MAX_BARS} bars one recovery may fetch; ask on a coarser interval`,
      },
    };
  }
  const floor = providerReachFloor(request.interval, now);
  if (floor !== null && request.toT < floor) {
    return {
      queue,
      answer: {
        outcome: "source_window_exhausted",
        reason:
          `the window is older than ${ARCHIVE_DATA_PROVIDER_ID}'s own candle history, and mixing ` +
          "another provider's series into the archive is a decision this product has not made",
      },
    };
  }
  if (request.deadlineAt <= now) {
    return {
      queue,
      answer: { outcome: "unsupported", reason: "the deadline is already in the past" },
    };
  }
  if (request.deadlineAt - now > HYDRATION_MAX_WAIT_MS) {
    return {
      queue,
      answer: {
        outcome: "unsupported",
        reason: `a request may wait at most ${HYDRATION_MAX_WAIT_MS / 1000}s`,
      },
    };
  }

  const live = queue.requests.filter((existing) => existing.deadlineAt > now);
  const expired = queue.requests.filter((existing) => existing.deadlineAt <= now);

  const identical = live.find(
    (existing) =>
      existing.venue === request.venue &&
      existing.coin === request.coin &&
      existing.interval === request.interval &&
      existing.fromT === request.fromT &&
      existing.toT === request.toT,
  );
  if (identical !== undefined) {
    // Share the entry; stretch the deadline so the newer, longer-lived waiter
    // does not lose the older one's place in line.
    const stretched: HydrationRequest = {
      ...identical,
      deadlineAt: Math.max(identical.deadlineAt, request.deadlineAt),
    };
    const nextRequests = queue.requests.map((existing) =>
      existing.id === identical.id ? stretched : existing,
    );
    return {
      queue: { requests: nextRequests, results: queue.results },
      answer: { outcome: "queued", id: identical.id },
    };
  }

  let results = queue.results;
  let pending = live;
  if (live.length >= HYDRATION_MAX_PENDING) {
    // Displace the request with the least time left: it is the closest to
    // answering itself `timed_out` anyway, and displacement is terminal, on
    // the record, and carries its sentence.
    const [displaced] = [...live].sort((a, b) => a.deadlineAt - b.deadlineAt);
    if (displaced !== undefined) {
      pending = live.filter((existing) => existing.id !== displaced.id);
      results = [
        {
          id: displaced.id,
          outcome: "failed" as const,
          finishedAt: now,
          reason:
            "displaced: the queue was full when a newer request arrived; ask again if the window still matters",
        },
        ...results.filter((existing) => existing.id !== displaced.id),
      ].slice(0, HYDRATION_MAX_RESULTS);
    }
  }

  return {
    queue: { requests: [...expired, ...pending, request], results },
    answer: { outcome: "queued", id: request.id },
  };
}

/** Record a finished answer; capped, newest first, one per request id. */
export function recordHydrationResult(
  queue: HydrationQueue,
  result: HydrationResult,
): HydrationQueue {
  const older = queue.results.filter((existing) => existing.id !== result.id);
  return { requests: queue.requests, results: [result, ...older].slice(0, HYDRATION_MAX_RESULTS) };
}

/** The requests the writer will act on this tick: live (not past deadline), oldest first, bounded. */
export function claimHydrationBatch(
  queue: HydrationQueue,
  now: number,
): {
  readonly batch: ReadonlyArray<HydrationRequest>;
  readonly rest: ReadonlyArray<HydrationRequest>;
  readonly expired: ReadonlyArray<HydrationRequest>;
} {
  const live = queue.requests.filter((request) => request.deadlineAt > now);
  const expired = queue.requests.filter((request) => request.deadlineAt <= now);
  const ordered = [...live].sort((a, b) => a.requestedAt - b.requestedAt);
  // Only the batch is re-ordered (oldest first, for the writer); the rest
  // keeps the queue's own order, so the write-back does not churn it.
  const batch = ordered.slice(0, HYDRATION_MAX_PER_TICK);
  const claimed = new Set(batch.map((request) => request.id));
  return {
    batch,
    rest: live.filter((request) => !claimed.has(request.id)),
    expired,
  };
}

/** One planned provider fetch: a union window plus the requests it serves. */
export interface HydrationFetchGroup {
  readonly venue: HydrationVenue;
  readonly coin: string;
  readonly interval: string;
  readonly fromT: number;
  readonly toT: number;
  readonly requests: ReadonlyArray<HydrationRequest>;
}

/**
 * The writer's coalescing step: group same-series requests, then merge
 * overlapping or adjacent windows while the union stays inside the span cap.
 * A union that would exceed the cap starts its own group — widening can never
 * make an accepted fetch silently exceed what one recovery may fetch. Requests
 * for other venues, coins, or intervals never share a group by construction.
 */
export function planHydrationFetches(
  batch: ReadonlyArray<HydrationRequest>,
): ReadonlyArray<HydrationFetchGroup> {
  const bySeries = new Map<string, HydrationRequest[]>();
  for (const request of batch) {
    const key = `${request.venue}\u0000${request.coin}\u0000${request.interval}`;
    const list = bySeries.get(key) ?? [];
    list.push(request);
    bySeries.set(key, list);
  }
  const groups: HydrationFetchGroup[] = [];
  for (const requests of bySeries.values()) {
    const width = INTERVAL_MS[requests[0]?.interval as keyof typeof INTERVAL_MS] ?? 0;
    const ordered = [...requests].sort((a, b) => a.fromT - b.fromT || a.toT - b.toT);
    let current: HydrationRequest[] = [];
    let fromT = 0;
    let toT = 0;
    const closeGroup = () => {
      if (current.length === 0) return;
      const first = current[0] as HydrationRequest;
      groups.push({
        venue: first.venue,
        coin: first.coin,
        interval: first.interval,
        fromT,
        toT,
        requests: current,
      });
      current = [];
    };
    for (const request of ordered) {
      if (
        current.length === 0 ||
        (request.fromT <= toT + width &&
          gridBarCount(Math.min(fromT, request.fromT), Math.max(toT, request.toT), width) <=
            HYDRATION_MAX_BARS)
      ) {
        current.push(request);
        fromT = current.length === 1 ? request.fromT : Math.min(fromT, request.fromT);
        toT = current.length === 1 ? request.toT : Math.max(toT, request.toT);
      } else {
        closeGroup();
        current = [request];
        fromT = request.fromT;
        toT = request.toT;
      }
    }
    closeGroup();
  }
  return groups;
}

// ---------------------------------------------------------------------------
// the transport: locked, atomic, and honest about unusable state
// ---------------------------------------------------------------------------

/** The queue file's path, exported for the writer and for tests that stub fs. */
export { hydrationRequestsPath };

/** Reading the queue file: absent, read, or refused with a reason. */
export type HydrationFileRead =
  | { readonly status: "absent" }
  | { readonly status: "read"; readonly content: string }
  | { readonly status: "unreadable"; readonly reason: string };

/**
 * Read the queue file off disk with the three states a filesystem actually
 * has. Only a proven-absent file (`ENOENT`) is the honest empty queue; a
 * permission failure, an I/O error, or a directory where the file should be
 * is `unreadable`, which callers must refuse rather than treat as absence —
 * rewriting "could not read" as "nothing pending" would erase work nobody has
 * answered. The reason carries the errno name only, never file content.
 */
export const readHydrationQueueFile = (path: string): HydrationFileRead => {
  let content: string;
  try {
    content = NodeFS.readFileSync(path, "utf8");
  } catch (error) {
    const code =
      error instanceof Error && "code" in error
        ? String((error as { readonly code?: unknown }).code)
        : "";
    if (code === "ENOENT") {
      return { status: "absent" };
    }
    return {
      status: "unreadable",
      reason: `the queue file could not be read (${code === "" ? "unknown error" : code})`,
    };
  }
  return { status: "read", content };
};

/** Read and parse the queue file. Unusable state stays unusable, never empty. */
export const loadHydrationQueue = (path: string): HydrationQueueRead => {
  const file = readHydrationQueueFile(path);
  if (file.status === "absent") {
    return { status: "ok", queue: { requests: [], results: [] } };
  }
  if (file.status === "unreadable") {
    return { status: "unusable", reason: file.reason };
  }
  return parseHydrationQueue(file.content);
};

/** Does the queue hold a live request right now? The writer's watcher-free fallback peek. */
export const hydrationQueueHasLiveRequests = (path: string, now: number): boolean => {
  const loaded = loadHydrationQueue(path);
  return loaded.status === "ok" && claimHydrationBatch(loaded.queue, now).batch.length > 0;
};

/**
 * Write the queue atomically: a temp file in the same directory, then rename
 * over the target, so a reader never observes a half-written queue and a
 * crash mid-write leaves the previous content intact.
 */
export function storeHydrationQueue(path: string, queue: HydrationQueue): void {
  const temp = `${path}.${process.pid}.${NodeCrypto.randomUUID()}.tmp`;
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  try {
    NodeFS.writeFileSync(temp, renderHydrationQueue(queue));
    NodeFS.renameSync(temp, path);
  } catch (error) {
    try {
      NodeFS.rmSync(temp, { force: true });
    } catch {
      // The rename either happened or the temp file is gone; nothing to clean.
    }
    throw error;
  }
}

/** A deliberate synchronous wait: the critical section is milliseconds, and
 * the alternative (an async lock) would spread a synchronous read-modify-write
 * across the event loop where nothing else may run anyway. */
const spinMs = (ms: number): void => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // Busy by design; see the doc comment above.
  }
};

const lockHolderPath = (lockDir: string): string => NodePath.join(lockDir, "holder.json");

const lockIsStale = (lockDir: string, now: number): boolean => {
  try {
    const stats = NodeFS.statSync(
      NodeFS.existsSync(lockHolderPath(lockDir)) ? lockHolderPath(lockDir) : lockDir,
    );
    return now - stats.mtimeMs > HYDRATION_QUEUE_LOCK_STALE_MS;
  } catch {
    // The holder vanished between mkdir and stat: not stale, just raced. The
    // next acquisition attempt wins it cleanly.
    return false;
  }
};

export type HydrationLockResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string };

/**
 * Run one critical section against the queue file under a cross-process
 * filesystem lock (a directory created exclusively), so the server's producers
 * and the archiver's drain cannot read-modify-write over each other. A stale
 * lock — a crashed holder — is broken after `HYDRATION_QUEUE_LOCK_STALE_MS`.
 * Gives up honestly after `HYDRATION_QUEUE_LOCK_WAIT_MS` without touching the
 * file, so a busy queue can never cause an uncoordinated write.
 */
export function withHydrationQueueLock<T>(path: string, critical: () => T): HydrationLockResult<T> {
  const lockDir = `${path}.lock`;
  const deadline = Date.now() + HYDRATION_QUEUE_LOCK_WAIT_MS;
  for (;;) {
    let acquired = false;
    try {
      NodeFS.mkdirSync(lockDir, { recursive: false });
      acquired = true;
    } catch {
      acquired = false;
    }
    if (acquired) {
      try {
        NodeFS.writeFileSync(lockHolderPath(lockDir), JSON.stringify({ pid: process.pid }));
        return { ok: true, value: critical() };
      } finally {
        try {
          NodeFS.rmSync(lockDir, { recursive: true, force: true });
        } catch {
          // Releasing is best effort; a leaked lock is stale-broken later.
        }
      }
    }
    const now = Date.now();
    if (lockIsStale(lockDir, now)) {
      try {
        NodeFS.rmSync(lockDir, { recursive: true, force: true });
      } catch {
        // Raced another breaker; loop and re-judge.
      }
      continue;
    }
    if (now >= deadline) {
      return { ok: false, reason: "the hydration queue lock is held by another writer" };
    }
    spinMs(25);
  }
}

// ---------------------------------------------------------------------------
// waking and waiting
// ---------------------------------------------------------------------------

/** Watches the queue file's directory for changes to the queue file itself. */
export interface HydrationFileWatcher {
  /** Resolve `true` on a queue-file event, `false` after `ms`. */
  readonly waitOrTimeout: (ms: number) => Promise<boolean>;
  readonly close: () => void;
}

/**
 * The event-driven wake for the sole writer and the reader's wait: a kernel
 * watch on the queue file's directory, filtered to the queue file's name —
 * directory watches survive the atomic rename the transport writes with,
 * where a watch on the file itself can go blind on Linux. `null` when no
 * watcher can be installed; callers fall back to the bounded slice.
 */
export function makeHydrationFileWatcher(path: string): HydrationFileWatcher | null {
  const dir = NodePath.dirname(path);
  const name = NodePath.basename(path);
  try {
    NodeFS.mkdirSync(dir, { recursive: true });
  } catch {
    return null;
  }
  let signalled = false;
  let closed = false;
  const waiters = new Map<(woken?: boolean) => void, () => void>();
  let watcher: NodeFS.FSWatcher;
  try {
    watcher = NodeFS.watch(dir, (event, filename) => {
      // An unnamed event still wakes (the re-read that follows is cheap and
      // decisive); a named one must be about the queue file.
      if (closed || (filename != null && filename !== name && !filename.startsWith(`${name}.`))) {
        return;
      }
      signalled = true;
      for (const [resolve, cancelTimer] of waiters) {
        cancelTimer();
        resolve(true);
      }
      waiters.clear();
    });
  } catch {
    return null;
  }
  return {
    waitOrTimeout: (ms) =>
      new Promise<boolean>((resolve) => {
        if (closed) {
          resolve(false);
          return;
        }
        if (signalled) {
          signalled = false;
          resolve(true);
          return;
        }
        const finish = (woken: boolean) => {
          waiters.delete(settled);
          resolve(woken);
        };
        const timer = setTimeout(() => finish(false), ms);
        const settled = () => {
          clearTimeout(timer);
          finish(true);
        };
        waiters.set(settled, () => clearTimeout(timer));
      }),
    close: () => {
      closed = true;
      for (const [, cancelTimer] of waiters) cancelTimer();
      waiters.clear();
      watcher.close();
    },
  };
}

/**
 * Wait for one request's answer, event-driven: the directory watch is the
 * receipt, so the waiter sleeps nothing and polls nothing. Resolves the
 * result the moment the writer records it, and `null` when the deadline
 * passes first (the queue will still answer `timed_out` on its own; the
 * caller does not need to write that). A watcher that cannot be installed
 * falls back to the deadline-bounded re-read: better one extra read than an
 * unwatched hang.
 *
 * Every timestamp here is Unix milliseconds — the same representation the
 * queue, the intervals, and the archive's candle rows carry — so the
 * deadline arithmetic never mixes units.
 */
export const waitForHydrationResult = (
  path: string,
  id: string,
  deadlineAt: number,
): Effect.Effect<HydrationResult | null> => {
  const read = (): HydrationResult | null => {
    // A waiter only ever reads. Absence and unreadability both mean "no
    // answer for this id right now"; the wait stays bounded by its deadline
    // and never mutates state it could not read.
    const file = readHydrationQueueFile(path);
    if (file.status !== "read") return null;
    const loaded = parseHydrationQueue(file.content);
    if (loaded.status !== "ok") return null;
    return loaded.queue.results.find((result) => result.id === id) ?? null;
  };

  return Effect.gen(function* () {
    const immediate = read();
    if (immediate !== null) return immediate;
    yield* Effect.callback<HydrationResult | null>((resume) => {
      const watcher = makeHydrationFileWatcher(path);
      if (watcher === null) {
        // No watcher (exotic fs): the deadline race below still bounds the
        // stay, and the final re-read after the race is the fallback read.
        return Effect.sync(() => undefined);
      }
      let settled = false;
      const settle = (value: HydrationResult | null) => {
        if (settled) return;
        settled = true;
        watcher.close();
        resume(Effect.succeed(value));
      };
      // Event-driven, re-armed on queue writes that were not this request's
      // answer, and settled by the deadline at the latest.
      const arm = () => {
        void watcher.waitOrTimeout(Math.max(0, deadlineAt - Date.now())).then((woken) => {
          const found = read();
          if (found !== null || !woken || Date.now() >= deadlineAt) {
            settle(found);
            return;
          }
          arm();
        });
      };
      arm();
      return Effect.sync(() => settle(null));
    });
    return null;
  }).pipe(
    Effect.raceFirst(Effect.sleep(Math.max(0, deadlineAt - Date.now())).pipe(Effect.as(null))),
    Effect.map((result) => result ?? read()),
  );
};
