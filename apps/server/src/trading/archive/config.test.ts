/**
 * The coin list the archiver records each tick: the follow set verbatim when
 * the server has written one, the seed coins only before it ever has. Moved
 * here from `FollowSetRegistry.test.ts` when the follow file stopped being a
 * union with the old `ARCHIVE_COINS` floor and became the sole source.
 */
import { assert, describe, it } from "@effect/vitest";

import {
  DEFAULT_SEED_COINS,
  MAINNET_ARCHIVE_VENUE,
  MAINNET_INFO_URL,
  MAINNET_WS_URL,
  MAX_ARCHIVE_COINS,
  TESTNET_ARCHIVE_VENUE,
  TESTNET_INFO_URL,
  TESTNET_WS_URL,
  archiveInfoUrl,
  archiveNetworkFromEnv,
  archiveVenue,
  archiveWsUrl,
  readArchiveCoins,
} from "./config.ts";

describe("archive network selection", () => {
  // The supervised child records the network the app trades; a hand-run
  // archiver with nothing set must keep recording mainnet, so only the exact
  // value "testnet" flips the switch.
  it("reads testnet from the env var and mainnet from everything else", () => {
    assert.strictEqual(archiveNetworkFromEnv("testnet"), "testnet");
    assert.strictEqual(archiveNetworkFromEnv("mainnet"), "mainnet");
    assert.strictEqual(archiveNetworkFromEnv(undefined), "mainnet");
    assert.strictEqual(archiveNetworkFromEnv(""), "mainnet");
    assert.strictEqual(archiveNetworkFromEnv("TESTNET"), "mainnet");
  });

  // Venue and endpoints are a matched triple per network: rows recorded from
  // the testnet feed must never carry the mainnet venue, and vice versa.
  it("maps each network onto its matched venue and endpoint pair", () => {
    assert.strictEqual(archiveVenue("mainnet"), MAINNET_ARCHIVE_VENUE);
    assert.strictEqual(archiveInfoUrl("mainnet"), MAINNET_INFO_URL);
    assert.strictEqual(archiveWsUrl("mainnet"), MAINNET_WS_URL);
    assert.strictEqual(archiveVenue("testnet"), TESTNET_ARCHIVE_VENUE);
    assert.strictEqual(archiveInfoUrl("testnet"), TESTNET_INFO_URL);
    assert.strictEqual(archiveWsUrl("testnet"), TESTNET_WS_URL);
    assert.ok(TESTNET_INFO_URL.includes("hyperliquid-testnet"));
    assert.ok(TESTNET_WS_URL.includes("hyperliquid-testnet"));
  });
});

describe("readArchiveCoins", () => {
  const read = (contents: string) => () => contents;

  it("records the follow set verbatim, not a union with the seeds", () => {
    const coins = readArchiveCoins(
      read(
        '{"followed":[{"venue":"hyperliquid","asset":"SOL"},{"venue":"hyperliquid","asset":"HYPE"}]}',
      ),
    );
    assert.deepEqual([...coins], ["SOL", "HYPE"]);
  });

  // The archiver is the process that must not stop, and a fresh install has no
  // control file at all — that is the ordinary state, not an error.
  it("falls back to the seed coins for a missing, broken, or empty file", () => {
    const missing = () => {
      throw new Error("ENOENT");
    };
    assert.deepEqual([...readArchiveCoins(missing)], [...DEFAULT_SEED_COINS]);
    assert.deepEqual([...readArchiveCoins(read("{"))], [...DEFAULT_SEED_COINS]);
    assert.deepEqual(
      [...readArchiveCoins(read('{"followed":"everything"}'))],
      [...DEFAULT_SEED_COINS],
    );
    // An empty follow set is a server that has nothing to say yet, not an
    // instruction to record nothing — an archive recording nothing is dead.
    assert.deepEqual([...readArchiveCoins(read('{"followed":[]}'))], [...DEFAULT_SEED_COINS]);
  });

  it("does not deep-record more than the archiver's own ceiling", () => {
    const followed = Array.from({ length: 100 }, (_, index) => ({
      venue: "hyperliquid",
      asset: `ALT${index}`,
    }));
    const coins = readArchiveCoins(read(JSON.stringify({ followed })));
    assert.strictEqual(coins.length, MAX_ARCHIVE_COINS);
  });
});
