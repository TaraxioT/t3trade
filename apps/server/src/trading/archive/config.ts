/**
 * Market archive — what is recorded, from where, and how often.
 *
 * The archive exists because the Hyperliquid Info API is a window, not a
 * history: every candle interval is capped at roughly the most recent 5000
 * bars, so a 1m series reaches back about three and a half days and nothing
 * older is ever served again. The only way the lab owns that history is to
 * write it down as it goes by. Everything here is a value, not an operator
 * knob — adding a coin is a one-line edit to `ARCHIVE_COINS`.
 *
 * Mainnet only, public reads only. The archiver never authenticates, never
 * sees a key, and never touches an order endpoint.
 *
 * @module trading/archive/config
 */

// @effect-diagnostics nodeBuiltinImport:off - a standalone process resolves its own paths.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import { T3_HOME_DIR_NAME } from "@t3tools/shared/forkPaths";
import * as NodePath from "node:path";

/**
 * Coins recorded when nothing says otherwise — a fresh install with no
 * positions, no watches and no watchlist.
 *
 * The list used to be the whole of what the archiver tracked. It is now only
 * the floor: the server publishes a follow set derived from what the user is
 * actually paying attention to, and the archiver records the union.
 */
export const ARCHIVE_COINS = ["BTC", "ETH", "SOL"] as const;
export type ArchiveCoin = (typeof ARCHIVE_COINS)[number];

/**
 * How many coins are deeply recorded at once.
 *
 * Deep recording is candles at every interval plus a book sample per minute,
 * which is one request per series per tick. The follow set is already capped
 * server-side; this is the archiver's own floor against a control file that
 * says something unreasonable.
 */
export const MAX_ARCHIVE_COINS = 24;

/**
 * Where the server publishes the follow set. Read fresh each tick, so
 * following a new asset starts recording it within a minute without anything
 * being restarted.
 */
export function followSetPath(): string {
  return `${archiveDatabasePath()}.follow.json`;
}

/**
 * The coins to record this tick: the defaults, plus whatever the server says
 * attention is on.
 *
 * A missing, unreadable, or malformed control file yields the defaults. The
 * archiver is the process that must not stop, and "the server has not written
 * its file yet" is the ordinary state of a fresh install.
 */
export function readArchiveCoins(readFile: (path: string) => string): ReadonlyArray<string> {
  const coins = new Set<string>(ARCHIVE_COINS);
  try {
    const parsed: unknown = JSON.parse(readFile(followSetPath()));
    const followed = (parsed as { followed?: unknown } | null)?.followed;
    if (Array.isArray(followed)) {
      for (const entry of followed) {
        const asset = (entry as { asset?: unknown } | null)?.asset;
        if (typeof asset === "string" && asset.length > 0) coins.add(asset);
      }
    }
  } catch {
    // No file, bad file, no matter — the defaults are always recorded.
  }
  return [...coins].slice(0, MAX_ARCHIVE_COINS);
}

/**
 * Candle intervals recorded for every coin.
 *
 * `3m` is here because the watch contract accepts it as a candle-close
 * interval and the archive did not hold it, so every 3m derived metric refused
 * for want of data nobody had decided not to record.
 */
export const ARCHIVE_INTERVALS = ["1m", "3m", "5m", "15m", "1h", "4h", "1d"] as const;
export type ArchiveInterval = (typeof ARCHIVE_INTERVALS)[number];

/** Bar width per interval, in milliseconds. */
export const INTERVAL_MS: Record<ArchiveInterval, number> = {
  "1m": 60_000,
  "3m": 3 * 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
};

/**
 * Intervals refreshed with a short tail on every poll, and how many trailing
 * bars each asks for. Fast intervals get ~10 bars so a poll that failed a few
 * minutes ago is repaired by the next one without a separate retry path; slow
 * intervals only ever have one bar in progress, so 3 is generous.
 */
export const POLL_TAIL_BARS: Record<ArchiveInterval, number> = {
  "1m": 10,
  "3m": 10,
  "5m": 10,
  "15m": 10,
  "1h": 3,
  "4h": 3,
  "1d": 3,
};

/** Public mainnet Info endpoint. The archiver posts nothing else, anywhere. */
export const MAINNET_INFO_URL = "https://api.hyperliquid.xyz/info";

/**
 * Bars the exchange will serve for one (coin, interval). Measured, not
 * documented: a `candleSnapshot` with a very old `startTime` returns the most
 * recent ~5066 bars and a window entirely older than that returns nothing at
 * all. 5000 is the conservative figure the repair planner assumes recoverable.
 */
export const CANDLE_WINDOW_BARS = 5_000;

/** Rows one `fundingHistory` call returns before it must be paged. */
export const FUNDING_PAGE_ROWS = 500;

/** First funding hour Hyperliquid has (2023-05-12). Where a cold start begins. */
export const FUNDING_ORIGIN_MS = 1_683_849_600_000;

/** How often candles, asset contexts, and book summaries are sampled. */
export const POLL_INTERVAL_MS = 60_000;

/** How often funding is pulled forward from its stored high-water mark. */
export const FUNDING_INTERVAL_MS = 30 * 60_000;

/** Floor on the spacing between two Info requests. */
export const MIN_REQUEST_GAP_MS = 200;

/**
 * Ceiling on the adaptive pace.
 *
 * Hyperliquid rate-limits by request weight, and the historical calls — a
 * funding page, a candle window — are heavy enough that a cold start walking
 * three years of funding will hit 429 at the 200 ms floor. So the pace slows
 * itself whenever the exchange says to, up to this ceiling, and relaxes back
 * toward the floor once requests land cleanly again. Two seconds is thirty
 * requests a minute, well inside the limit for even the heaviest call.
 */
export const MAX_REQUEST_GAP_MS = 2_000;

/** How much the pace relaxes toward the floor per clean request. */
export const REQUEST_GAP_DECAY = 0.97;

/** First backoff step after a 429 or 5xx, doubled per attempt. */
export const BACKOFF_BASE_MS = 1_000;

/** Ceiling on one backoff sleep. */
export const BACKOFF_MAX_MS = 60_000;

/** Attempts per request before it is given up on and logged. */
export const REQUEST_ATTEMPTS = 6;

/**
 * Where the archive lives. Deliberately its own file: this data is not
 * application state, has its own tiny schema, and must never share a
 * migration chain with `state.sqlite`.
 */
export function archiveDatabasePath(): string {
  const home = process.env["T3CODE_HOME"] ?? NodePath.join(NodeOS.homedir(), T3_HOME_DIR_NAME);
  return NodePath.join(home, "userdata", "market-archive.sqlite");
}

/** `readArchiveCoins` against the real file. What the archiver actually calls. */
export function readArchiveCoinsFromDisk(): ReadonlyArray<string> {
  return readArchiveCoins((path) => NodeFS.readFileSync(path, "utf8"));
}
