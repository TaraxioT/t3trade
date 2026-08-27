/**
 * The candle feed's pure parts: the message-to-row transform and the
 * poll-skip decision. No sockets are opened here — the feed's connection
 * handling is exercised against the live stream, not in unit tests.
 */
import { assert, describe, it } from "@effect/vitest";

import { POLL_INTERVAL_MS } from "./config.ts";
import { feedStaleAfterMs, parseWsCandle, shouldPollSeries } from "./ws.ts";

const CANDLE_MESSAGE = {
  channel: "candle",
  data: {
    t: 60_000,
    T: 119_999,
    s: "BTC",
    i: "1m",
    o: "100.0",
    h: "101.0",
    l: "99.0",
    c: "100.5",
    v: "1.25",
    n: 7,
  },
};

describe("parseWsCandle", () => {
  it("turns a candle update into the row the upsert writes", () => {
    assert.deepStrictEqual(parseWsCandle(CANDLE_MESSAGE), {
      coin: "BTC",
      interval: "1m",
      t: 60_000,
      tClose: 119_999,
      o: 100,
      h: 101,
      l: 99,
      c: 100.5,
      v: 1.25,
      n: 7,
    });
  });

  it("answers null for anything that is not a well-formed candle", () => {
    assert.isNull(parseWsCandle(null));
    assert.isNull(parseWsCandle("pong"));
    assert.isNull(parseWsCandle({ channel: "subscriptionResponse", data: {} }));
    assert.isNull(parseWsCandle({ channel: "candle", data: null }));
    // A candle missing one field is dropped whole, never written as a hole.
    const missingClose = { channel: "candle", data: { ...CANDLE_MESSAGE.data, c: "not a number" } };
    assert.isNull(parseWsCandle(missingClose));
  });
});

describe("shouldPollSeries", () => {
  const MINUTE = 60_000;
  const base = {
    socketOpen: true,
    lastUpdateAt: 1_000_000,
    gapPending: false,
    intervalMs: MINUTE,
    now: 1_000_000 + MINUTE,
  };

  it("skips the poll for a live series that delivered recently", () => {
    assert.isFalse(shouldPollSeries(base));
  });

  it("polls when the socket is down, whatever the series last saw", () => {
    assert.isTrue(shouldPollSeries({ ...base, socketOpen: false }));
  });

  it("polls a series that has never delivered on this connection", () => {
    assert.isTrue(shouldPollSeries({ ...base, lastUpdateAt: null }));
  });

  it("polls a series with an unhealed gap even when updates are flowing", () => {
    assert.isTrue(shouldPollSeries({ ...base, gapPending: true }));
  });

  it("polls a series whose updates have gone quiet", () => {
    const stale = feedStaleAfterMs(MINUTE) + 1;
    assert.isTrue(shouldPollSeries({ ...base, now: base.lastUpdateAt + stale }));
  });

  it("gives slow intervals a full bar of silence before falling back", () => {
    const fourHours = 4 * 60 * MINUTE;
    // Ten poll ticks of silence is nothing to a 4h series between trades.
    assert.isFalse(
      shouldPollSeries({
        ...base,
        intervalMs: fourHours,
        now: base.lastUpdateAt + 10 * POLL_INTERVAL_MS,
      }),
    );
    assert.isTrue(
      shouldPollSeries({
        ...base,
        intervalMs: fourHours,
        now: base.lastUpdateAt + fourHours + 1,
      }),
    );
  });
});
