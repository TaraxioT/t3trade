/**
 * The coin list the archiver records each tick: the follow set verbatim when
 * the server has written one, the seed coins only before it ever has. Moved
 * here from `FollowSetRegistry.test.ts` when the follow file stopped being a
 * union with the old `ARCHIVE_COINS` floor and became the sole source.
 */
import { assert, describe, it } from "@effect/vitest";

import { DEFAULT_SEED_COINS, MAX_ARCHIVE_COINS, readArchiveCoins } from "./config.ts";

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
