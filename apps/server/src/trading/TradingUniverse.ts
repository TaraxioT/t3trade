/**
 * TradingUniverse — what the venue lists, for the surfaces that let a user pick.
 *
 * A watchlist search and an asset picker both need the same thing: every asset
 * the venue trades, with enough alongside each one to tell a busy market from a
 * dead one. That list used to be two literals in a schema.
 *
 * The read is cached for a few seconds and served whole. Whole because a couple
 * of hundred rows is smaller than the round trips a server-side search would
 * cost per keystroke; cached because every open client asks for the same list,
 * and the resolver underneath is already re-fetching on its own freshness
 * window.
 *
 * A failed read yields the empty list rather than a stale one. An asset that
 * has been delisted since the last fetch is one a user could still pick.
 *
 * @module TradingUniverse
 */
import { Context, Effect } from "effect";
import * as Clock from "effect/Clock";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { HyperliquidGateway } from "@t3tools/hyperliquid";
import type { TradingUniverseEntry } from "@t3tools/trading-contracts/market";

export interface TradingUniverseShape {
  /** Every listed asset, or an empty list when the exchange read failed. */
  readonly list: Effect.Effect<ReadonlyArray<TradingUniverseEntry>>;
}

export class TradingUniverse extends Context.Service<TradingUniverse, TradingUniverseShape>()(
  "t3/trading/TradingUniverse",
) {}

/**
 * How long the list is served from memory. Long enough that several clients
 * opening a picker at once share one read, short enough that a mark shown
 * beside an asset name is one someone would recognise.
 */
const CACHE_WINDOW_MS = 5_000;

interface CachedUniverse {
  readonly assets: ReadonlyArray<TradingUniverseEntry>;
  readonly readAt: number;
}

export const makeTradingUniverse = Effect.gen(function* () {
  const gateway = yield* HyperliquidGateway;
  const cache = yield* Ref.make<CachedUniverse | null>(null);

  const list: TradingUniverseShape["list"] = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const cached = yield* Ref.get(cache);
    if (cached !== null && now - cached.readAt < CACHE_WINDOW_MS) return cached.assets;

    const assets = yield* gateway.listUniverse.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("TradingUniverse: could not read the venue's universe", {
          cause: String(cause),
        }).pipe(Effect.as([] as ReadonlyArray<TradingUniverseEntry>)),
      ),
    );
    // A failed read is not cached: the next caller should try again rather than
    // be told for five seconds that the venue lists nothing.
    if (assets.length > 0) yield* Ref.set(cache, { assets, readAt: now });
    return assets;
  });

  return { list } satisfies TradingUniverseShape;
});

export const TradingUniverseLive = Layer.effect(TradingUniverse, makeTradingUniverse);
