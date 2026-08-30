/**
 * Market archive — what is recorded, from where, and how often.
 *
 * The archive exists because the Hyperliquid Info API is a window, not a
 * history: every candle interval is capped at roughly the most recent 5000
 * bars, so a 1m series reaches back about three and a half days and nothing
 * older is ever served again. The only way the lab owns that history is to
 * write it down as it goes by. Everything here is a value, not an operator
 * knob — the coins recorded come from the server's follow set.
 *
 * Public reads only. The archiver never authenticates, never sees a key, and
 * never touches an order endpoint. Which Hyperliquid network it reads —
 * mainnet or testnet — is decided by whoever starts the process: the
 * supervised in-app archiver records the venue the app actually trades
 * (passed down via `ARCHIVE_NETWORK_ENV`), while a hand-run archiver with no
 * environment set keeps its historical default of mainnet.
 *
 * @module trading/archive/config
 */

// @effect-diagnostics nodeBuiltinImport:off - a standalone process resolves its own paths.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import { T3_HOME_DIR_NAME } from "@t3tools/shared/forkPaths";
import * as NodePath from "node:path";

/**
 * Coins recorded before the server has ever written a follow set — a fresh
 * install with no positions, no watches and no watchlist.
 *
 * This is only the cold-start floor, so a brand-new archive is not empty.
 * Once a follow file exists, it is the sole source of coins and this list is
 * never consulted again.
 */
export const DEFAULT_SEED_COINS = ["BTC", "ETH"] as const;

/**
 * The Hyperliquid network a run of the archiver records from. The schema is
 * (venue, coin)-keyed since v2, so the two networks coexist in one file as
 * two venues; every read and write pins the venue of the network it is for.
 */
export type ArchiveNetwork = "mainnet" | "testnet";

/**
 * The env var the ArchiveSupervisor sets on the spawned archiver child so the
 * recorder reads the same network the app trades. The value is an
 * `ArchiveNetwork`; anything else (including absence) means mainnet, which
 * keeps a hand-run `node archive/main.ts` recording what it always has.
 */
export const ARCHIVE_NETWORK_ENV = "T3TRADE_ARCHIVE_NETWORK";

/** Decode the env var (or any string) into a network. Unrecognized → mainnet. */
export function archiveNetworkFromEnv(value: string | undefined): ArchiveNetwork {
  return value === "testnet" ? "testnet" : "mainnet";
}

/**
 * The venue string stamped on every row recorded from a network. `hyperliquid`
 * is the only venue v1 ever recorded (mainnet); testnet rows carry their own
 * venue so a chart of the traded market never silently mixes the two
 * exchanges' prices.
 */
export const MAINNET_ARCHIVE_VENUE = "hyperliquid";
export const TESTNET_ARCHIVE_VENUE = "hyperliquid-testnet";

export function archiveVenue(network: ArchiveNetwork): string {
  return network === "testnet" ? TESTNET_ARCHIVE_VENUE : MAINNET_ARCHIVE_VENUE;
}

/**
 * The default venue for writes and reads that do not name one — the mainnet
 * venue, matching every row recorded before the network became a choice.
 */
export const ARCHIVE_VENUE = MAINNET_ARCHIVE_VENUE;

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
 * The coins to record this tick: the follow set verbatim, capped at
 * `MAX_ARCHIVE_COINS`.
 *
 * A missing, unreadable, malformed, or empty control file yields the seed
 * coins instead. The archiver is the process that must not stop, and "the
 * server has not written its file yet" is the ordinary state of a fresh
 * install — an archive recording nothing at all would be a dead archive.
 */
export function readArchiveCoins(readFile: (path: string) => string): ReadonlyArray<string> {
  try {
    const parsed: unknown = JSON.parse(readFile(followSetPath()));
    const followed = (parsed as { followed?: unknown } | null)?.followed;
    if (Array.isArray(followed)) {
      const coins = new Set<string>();
      for (const entry of followed) {
        const asset = (entry as { asset?: unknown } | null)?.asset;
        if (typeof asset === "string" && asset.length > 0) coins.add(asset);
      }
      if (coins.size > 0) {
        return [...coins].slice(0, MAX_ARCHIVE_COINS);
      }
    }
  } catch {
    // No file, bad file, no matter — the seeds keep the recorder recording.
  }
  return [...DEFAULT_SEED_COINS];
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

/** Public mainnet WebSocket endpoint — the candle feed's counterpart to the Info URL. */
export const MAINNET_WS_URL = "wss://api.hyperliquid.xyz/ws";

/** Public testnet Info endpoint — the same pair the trading gateway uses. */
export const TESTNET_INFO_URL = "https://api.hyperliquid-testnet.xyz/info";

/** Public testnet WebSocket endpoint. */
export const TESTNET_WS_URL = "wss://api.hyperliquid-testnet.xyz/ws";

/** The Info endpoint for a network — a matched pair with `archiveWsUrl`. */
export function archiveInfoUrl(network: ArchiveNetwork): string {
  return network === "testnet" ? TESTNET_INFO_URL : MAINNET_INFO_URL;
}

/** The WebSocket endpoint for a network — a matched pair with `archiveInfoUrl`. */
export function archiveWsUrl(network: ArchiveNetwork): string {
  return network === "testnet" ? TESTNET_WS_URL : MAINNET_WS_URL;
}

/**
 * How often the candle feed pings the socket. Hyperliquid closes a connection
 * it has heard nothing from for about a minute, and inbound candles do not
 * count — the client has to speak.
 */
export const WS_PING_INTERVAL_MS = 45_000;

/**
 * Bars the exchange will serve for one (coin, interval). Measured, not
 * documented: a `candleSnapshot` with a very old `startTime` returns the most
 * recent ~5066 bars and a window entirely older than that returns nothing at
 * all. 5000 is the conservative figure the repair planner assumes recoverable.
 */
export const CANDLE_WINDOW_BARS = 5_000;

/**
 * The one data provider the archive is allowed to hydrate from. Hyperliquid
 * is both the execution venue and the historical source; a second provider
 * would put two provenances in one candle series, and that is a typed,
 * deliberate decision this fork has not made — never an improvised crawl and
 * never a silent mix. Every hydration path refuses windows outside this
 * provider's own reach and says so in words.
 */
export const ARCHIVE_DATA_PROVIDER_ID = "hyperliquid";

/** Pending on-demand hydration requests the queue may hold. */
export const HYDRATION_MAX_PENDING = 4;
/** Bars one hydration request may ask the writer to fetch. */
export const HYDRATION_MAX_BARS = CANDLE_WINDOW_BARS;
/** Requests the sole writer will drain on one tick. */
export const HYDRATION_MAX_PER_TICK = 2;
/** How long one hydration request may wait from asking to answer. */
export const HYDRATION_MAX_WAIT_MS = 30_000;
/**
 * The longest the sole writer may sit between looks at the hydration queue
 * when no file watch can be installed. Pinned at half of
 * {@link HYDRATION_MAX_WAIT_MS}: a request that arrives the instant a slice
 * begins is still observed a full half-deadline before it expires, so the
 * 60-second poll cadence can never swallow a live request whole. With a
 * working watch the wake is immediate and this is only the guarantee floor.
 */
export const HYDRATION_WRITER_SLICE_MS = HYDRATION_MAX_WAIT_MS / 2;
/**
 * A hydration queue lock older than this is a crashed holder and may be
 * broken. The critical section is a read-parse-write of a small JSON file —
 * milliseconds — so ten seconds is generous without making a crashed reader
 * wait meaningfully.
 */
export const HYDRATION_QUEUE_LOCK_STALE_MS = 10_000;
/** How long a producer waits for the queue lock before giving up honestly. */
export const HYDRATION_QUEUE_LOCK_WAIT_MS = 2_000;

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

/**
 * Where the on-demand hydration queue lives: beside the archive database it
 * serves, in the writer's own state tree. Readers write requests here; the
 * sole lease holder drains them. A malformed or unreadable file is refused
 * as unusable — never rewritten as an empty queue, which would erase pending
 * work — because the queue is an optimization for recoverable windows, not a
 * promise the archive is measured by.
 */
export function hydrationRequestsPath(): string {
  return `${archiveDatabasePath()}.hydration.json`;
}

/** `readArchiveCoins` against the real file. What the archiver actually calls. */
export function readArchiveCoinsFromDisk(): ReadonlyArray<string> {
  return readArchiveCoins((path) => NodeFS.readFileSync(path, "utf8"));
}
