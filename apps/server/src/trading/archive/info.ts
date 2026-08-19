/**
 * The public Info client the archiver reads mainnet through.
 *
 * Not the repo's `HyperliquidInfoClient`: that one is Effect-shaped, points at
 * testnet, and carries the account-scoped reads this process must never make.
 * This client posts four public bodies at one endpoint and returns `null`
 * instead of failing, because the archiver's contract with itself is that no
 * single bad response ends the recording.
 *
 * Three rules hold for every request: one in flight at a time, a spacing that
 * starts at `MIN_REQUEST_GAP_MS` and widens whenever the exchange answers 429,
 * and an exponential backoff on 429 or 5xx that gives up after
 * `REQUEST_ATTEMPTS` rather than hammering. A 4xx that is not 429 is a bad
 * request, not congestion, so it is not retried at all.
 *
 * @module trading/archive/info
 */

// @effect-diagnostics globalFetch:off globalTimers:off globalDate:off - standalone poller.
import {
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  MAINNET_INFO_URL,
  MAX_REQUEST_GAP_MS,
  MIN_REQUEST_GAP_MS,
  REQUEST_ATTEMPTS,
  REQUEST_GAP_DECAY,
} from "./config.ts";
import { describeError, logWarn } from "./log.ts";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Counts what the wire did, for the heartbeat. */
export interface InfoStats {
  requests: number;
  failures: number;
  retries: number;
  /** The current adaptive spacing between requests, in milliseconds. */
  paceMs: number;
}

export interface InfoClient {
  /** POST one Info body; `null` when every attempt failed. */
  readonly post: (operation: string, body: unknown) => Promise<unknown>;
  readonly stats: InfoStats;
}

/** Non-2xx responses worth waiting out rather than abandoning. */
function isTransientStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export function makeInfoClient(url: string = MAINNET_INFO_URL): InfoClient {
  const stats: InfoStats = { requests: 0, failures: 0, retries: 0, paceMs: MIN_REQUEST_GAP_MS };
  // Serialises the whole client: each call chains onto the previous one's
  // completion, so "one request at a time" holds even if two loops overlap.
  let queue: Promise<unknown> = Promise.resolve();
  let lastRequestAt = 0;

  const attempt = async (operation: string, body: unknown): Promise<unknown> => {
    const since = Date.now() - lastRequestAt;
    if (since < stats.paceMs) {
      await sleep(stats.paceMs - since);
    }
    lastRequestAt = Date.now();
    stats.requests += 1;

    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const detail = `${operation} http ${response.status}`;
      if (response.status === 429) {
        // The exchange is pacing us, not failing us. Widen the gap for every
        // request from here so the backoff is not re-learned page by page.
        stats.paceMs = Math.min(stats.paceMs * 2, MAX_REQUEST_GAP_MS);
      }
      if (isTransientStatus(response.status)) {
        throw new Error(detail);
      }
      // A permanent rejection: consume the body so the socket is released,
      // then report it as a give-up rather than a retry.
      await response.text();
      logWarn(`info: ${detail} — not retried`);
      return null;
    }

    // A clean landing earns a little of the pace back.
    stats.paceMs = Math.max(MIN_REQUEST_GAP_MS, stats.paceMs * REQUEST_GAP_DECAY);
    return await response.json();
  };

  const post = async (operation: string, body: unknown): Promise<unknown> => {
    for (let tries = 0; tries < REQUEST_ATTEMPTS; tries += 1) {
      try {
        return await attempt(operation, body);
      } catch (error) {
        const last = tries === REQUEST_ATTEMPTS - 1;
        if (last) {
          stats.failures += 1;
          logWarn(`info: ${operation} gave up after ${REQUEST_ATTEMPTS}: ${describeError(error)}`);
          return null;
        }
        stats.retries += 1;
        const wait = Math.min(BACKOFF_BASE_MS * 2 ** tries, BACKOFF_MAX_MS);
        logWarn(`info: ${operation} failed (${describeError(error)}); retrying in ${wait}ms`);
        await sleep(wait);
      }
    }
    return null;
  };

  return {
    post: (operation, body) => {
      const next = queue.then(() => post(operation, body));
      // Keep the chain alive whatever `next` does; `post` already swallows
      // every failure, so this is belt-and-braces against a future throw.
      queue = next.catch(() => undefined);
      return next;
    },
    stats,
  };
}
