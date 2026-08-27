/**
 * The WebSocket candle feed — the archive's primary candle collector.
 *
 * One socket to Hyperliquid's public stream, subscribed to every followed
 * coin at every archived interval. Each update is upserted through the same
 * conflict handling the poller uses, so the two collectors can never disagree
 * about a bar — the last writer's values win and the key is the bar's open.
 *
 * Polling `candleSnapshot` stays as the backstop: the archiver's tick asks
 * `shouldPoll` per series and only polls the ones the feed cannot vouch for —
 * the socket is down, the series has never delivered, its last update has
 * gone stale (an illiquid market with no trades emits no candle updates, and
 * silence is indistinguishable from a broken subscription), or an update
 * arrived whose open skipped a bar. Backfill and gap accounting are untouched;
 * this file only decides when the poller's work is already done.
 *
 * Uses Node's built-in WebSocket (the archiver runs under the server's own
 * Node, well past 22) — no dependency, no wrapper.
 *
 * @module trading/archive/ws
 */

// @effect-diagnostics globalTimers:off globalDate:off - a standalone always-on process.
import type { CandleRow } from "./candles.ts";
import {
  ARCHIVE_INTERVALS,
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  INTERVAL_MS,
  MAINNET_WS_URL,
  POLL_INTERVAL_MS,
  WS_PING_INTERVAL_MS,
  type ArchiveInterval,
} from "./config.ts";
import { describeError, logInfo, logWarn } from "./log.ts";
import { asInteger, asNumber, asRecord, asString } from "./wire.ts";

/** What the archiver's tick loop asks of the feed. */
export interface CandleFeed {
  /** Reconcile subscriptions with the coins recorded this tick. */
  readonly setCoins: (coins: ReadonlyArray<string>) => void;
  /** Whether the poller still needs to refresh this series. */
  readonly shouldPoll: (coin: string, interval: ArchiveInterval, now: number) => boolean;
  /** The poller refreshed this series; any detected gap is now healed. */
  readonly markPolled: (coin: string, interval: ArchiveInterval) => void;
  readonly close: () => void;
}

/**
 * Decode one stream message into a candle row, or `null` for anything that is
 * not a well-formed candle update. The shape is the Info API's candle with a
 * `channel` envelope: `{"channel":"candle","data":{t,T,s,i,o,h,l,c,v,n}}`.
 */
export function parseWsCandle(raw: unknown): CandleRow | null {
  const message = asRecord(raw);
  if (message === null || asString(message["channel"]) !== "candle") {
    return null;
  }
  const data = asRecord(message["data"]);
  if (data === null) {
    return null;
  }
  const coin = asString(data["s"]);
  const interval = asString(data["i"]);
  const t = asInteger(data["t"]);
  const tClose = asInteger(data["T"]);
  const o = asNumber(data["o"]);
  const h = asNumber(data["h"]);
  const l = asNumber(data["l"]);
  const c = asNumber(data["c"]);
  const v = asNumber(data["v"]);
  const n = asInteger(data["n"]);
  if (
    coin === null ||
    interval === null ||
    t === null ||
    tClose === null ||
    o === null ||
    h === null ||
    l === null ||
    c === null ||
    v === null ||
    n === null
  ) {
    return null;
  }
  return { coin, interval, t, tClose, o, h, l, c, v, n };
}

/**
 * A series may go this long without an update before the poller takes over.
 * Three poll ticks of slack absorbs a slow trade tape on the fast intervals;
 * one bar width covers the slow ones, whose updates can legitimately be far
 * apart when few trades print.
 */
export const feedStaleAfterMs = (intervalMs: number): number =>
  Math.max(3 * POLL_INTERVAL_MS, intervalMs);

/**
 * The poll-skip decision, pure so it can be tested without a socket. The
 * default is to poll: only a live subscription that has delivered recently and
 * has no unhealed gap earns the skip.
 */
export function shouldPollSeries(input: {
  readonly socketOpen: boolean;
  readonly lastUpdateAt: number | null;
  readonly gapPending: boolean;
  readonly intervalMs: number;
  readonly now: number;
}): boolean {
  if (input.gapPending || !input.socketOpen || input.lastUpdateAt === null) {
    return true;
  }
  return input.now - input.lastUpdateAt > feedStaleAfterMs(input.intervalMs);
}

/** What the feed remembers per (coin, interval). */
interface SeriesState {
  lastUpdateAt: number | null;
  /** Open time of the newest bar seen on the stream. */
  lastOpenT: number | null;
  /** An update skipped a bar; poll this series before trusting it again. */
  gapPending: boolean;
}

/**
 * Open the feed and keep it open: reconnect with exponential backoff on
 * socket loss, resubscribe on every (re)connect and follow-set change, ping
 * so the server keeps the connection. `onCandle` receives every well-formed
 * candle update, already in row shape.
 */
export function startCandleFeed(options: {
  readonly onCandle: (row: CandleRow) => void;
  readonly url?: string;
  readonly now?: () => number;
}): CandleFeed {
  const url = options.url ?? MAINNET_WS_URL;
  const now = options.now ?? Date.now;

  const series = new Map<string, SeriesState>();
  const seriesKey = (coin: string, interval: string) => `${coin}|${interval}`;
  const stateOf = (coin: string, interval: string): SeriesState => {
    const key = seriesKey(coin, interval);
    const existing = series.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const fresh: SeriesState = { lastUpdateAt: null, lastOpenT: null, gapPending: false };
    series.set(key, fresh);
    return fresh;
  };

  let coins: ReadonlyArray<string> = [];
  let socket: WebSocket | null = null;
  let socketOpen = false;
  let closed = false;
  let reconnectDelayMs = BACKOFF_BASE_MS;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;

  const send = (message: unknown): void => {
    if (socket !== null && socketOpen) {
      socket.send(JSON.stringify(message));
    }
  };

  const sendSubscription = (method: "subscribe" | "unsubscribe", coin: string): void => {
    for (const interval of ARCHIVE_INTERVALS) {
      send({ method, subscription: { type: "candle", coin, interval } });
    }
  };

  const stopPing = (): void => {
    if (pingTimer !== null) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
  };

  const handleMessage = (data: unknown): void => {
    if (typeof data !== "string") {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    const row = parseWsCandle(parsed);
    if (row === null) {
      return;
    }
    const intervalMs = INTERVAL_MS[row.interval as ArchiveInterval] as number | undefined;
    if (intervalMs === undefined) {
      return;
    }
    const state = stateOf(row.coin, row.interval);
    if (state.lastOpenT !== null && row.t > state.lastOpenT + intervalMs) {
      // The stream skipped at least one bar — mark the series so the poller
      // re-reads its tail rather than trusting a hole.
      state.gapPending = true;
      logWarn(`ws: ${row.coin} ${row.interval} skipped a bar, poll will repair`);
    }
    state.lastOpenT = Math.max(state.lastOpenT ?? row.t, row.t);
    state.lastUpdateAt = now();
    options.onCandle(row);
  };

  const handleDown = (reason: string): void => {
    if (socket === null) {
      return; // Already handled: close after error fires both handlers.
    }
    socket = null;
    socketOpen = false;
    stopPing();
    if (closed) {
      return;
    }
    logWarn(`ws: connection lost (${reason}); reconnecting in ${reconnectDelayMs}ms`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, reconnectDelayMs);
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, BACKOFF_MAX_MS);
  };

  const connect = (): void => {
    let next: WebSocket;
    try {
      next = new WebSocket(url);
    } catch (error) {
      handleDown(describeError(error));
      return;
    }
    socket = next;
    next.addEventListener("open", () => {
      if (next !== socket) {
        return;
      }
      socketOpen = true;
      reconnectDelayMs = BACKOFF_BASE_MS;
      logInfo(`ws: connected, subscribing ${coins.length} coins`);
      for (const coin of coins) {
        sendSubscription("subscribe", coin);
      }
      pingTimer = setInterval(() => send({ method: "ping" }), WS_PING_INTERVAL_MS);
    });
    next.addEventListener("message", (event) => {
      if (next === socket) {
        handleMessage((event as MessageEvent).data);
      }
    });
    next.addEventListener("error", () => {
      if (next === socket) {
        handleDown("socket error");
      }
    });
    next.addEventListener("close", () => {
      if (next === socket) {
        handleDown("socket closed");
      }
    });
  };

  connect();

  return {
    setCoins: (next) => {
      const before = new Set(coins);
      const after = new Set(next);
      if (socketOpen) {
        for (const coin of next) {
          if (!before.has(coin)) {
            sendSubscription("subscribe", coin);
          }
        }
        for (const coin of coins) {
          if (!after.has(coin)) {
            sendSubscription("unsubscribe", coin);
          }
        }
      }
      coins = [...next];
    },
    shouldPoll: (coin, interval, at) => {
      const state = series.get(seriesKey(coin, interval));
      return shouldPollSeries({
        socketOpen,
        lastUpdateAt: state?.lastUpdateAt ?? null,
        gapPending: state?.gapPending ?? false,
        intervalMs: INTERVAL_MS[interval],
        now: at,
      });
    },
    markPolled: (coin, interval) => {
      const state = series.get(seriesKey(coin, interval));
      if (state !== undefined) {
        state.gapPending = false;
      }
    },
    close: () => {
      closed = true;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      stopPing();
      const current = socket;
      socket = null;
      socketOpen = false;
      current?.close();
    },
  };
}
