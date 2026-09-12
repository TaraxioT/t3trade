/**
 * What the quote service claims, held to its contract.
 *
 * Every RPC response in here is a fixture served by a fake transport —
 * fixtures belong to tests, and the production path has no fixture fallback.
 *
 * The calldata vector is HAND-DERIVED from the pinned ABI (QuoterAbi.ts's
 * commit-pinned IV4Quoter shape), not an echo of the encoder: the selector is
 * recomputed from the ASCII signature via keccak256 and frozen against the
 * value found in the DEPLOYED Sepolia quoter's runtime code, and every
 * argument word is composed from explicit padding arithmetic per the ABI
 * static-encoding rules — the same discipline UniswapTestnetAdapter.test.ts
 * applies to the periphery intents. The pinned shape was additionally
 * verified live (2026-09-12) with a read-only eth_call against the deployed
 * quoter, which returned the two-word (amountOut, gasEstimate) tuple.
 *
 * @module UniswapQuoteService.test
 */
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { keccak256, toBytes } from "viem";

import {
  ForgeSepoliaTransport,
  type ForgeSepoliaRpcTransportShape,
} from "./UniswapTestnetAdapter.ts";
import {
  QUOTE_EXACT_AMOUNT_MAX,
  QUOTE_EXACT_INPUT_SINGLE_SIGNATURE,
  decodeQuoteExactInputSingleResult,
  encodeQuoteExactInputSingle,
} from "./QuoterAbi.ts";
import {
  QUOTE_GAS_ESTIMATE_WEI_PLACEHOLDER,
  QUOTE_TTL_DEFAULT_MS,
  QUOTE_TTL_MIN_MS,
  SwapRouteConfig,
  UniswapQuoteService,
  UniswapQuoteServiceLive,
  resolveSwapRouteSettings,
  routeFor,
  validateQuoteFresh,
  type SwapQuoteOutcome,
  type SwapRouteSettings,
} from "./UniswapQuoteService.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const C0 = `0x${"11".repeat(20)}` as `0x${string}`;
const C1 = `0x${"22".repeat(20)}` as `0x${string}`;
const HOOKS = `0x${"33".repeat(20)}` as `0x${string}`;
const QUOTER = "0x61b3f2011a92d183c7dbadbda940a7555ccf9227";
const NOW = 1_780_000_000_000;
const ROUTE_ID = "weth-usdc-500";

const routeFixture = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  routeId: ROUTE_ID,
  chainId: "11155111",
  routeType: "v4-exact-input-single",
  tokenIn: C0,
  tokenOut: C1,
  quoterAddress: QUOTER,
  poolKey: { currency0: C0, currency1: C1, fee: 500, tickSpacing: 60, hooks: HOOKS },
  zeroForOne: true,
  ...overrides,
});

const routesEnv = (routes: unknown): Record<string, string | undefined> => ({
  T3_SWAP_ROUTES: JSON.stringify(routes),
});

/** One left-padded 32-byte word from a hex string (no 0x) or BigInt. */
const word = (value: string | bigint): string =>
  (typeof value === "bigint" ? value.toString(16) : value.replace(/^0x/, "")).padStart(64, "0");

/** The refusal reason of an outcome the test asserts is refused. */
const refusedReason = (outcome: SwapQuoteOutcome): string => {
  assert.equal(outcome.status, "refused");
  if (outcome.status !== "refused") throw new Error("unreachable");
  return outcome.reason;
};

// ---------------------------------------------------------------------------
// Fake transport — the only seam the service reads the chain through
// ---------------------------------------------------------------------------

interface RecordedCall {
  readonly method: string;
  readonly params: ReadonlyArray<unknown>;
}

/**
 * A fake Sepolia transport answering `eth_call` from a script. Values are
 * served verbatim (strings as hex results, numbers as a deliberately non-hex
 * result); `{ fail }` simulates an RPC-level failure with that reason.
 */
const makeFakeTransport = (
  script: () => string | number | { readonly fail: string },
): {
  readonly calls: ReadonlyArray<RecordedCall>;
  readonly shape: ForgeSepoliaRpcTransportShape;
} => {
  const calls: Array<RecordedCall> = [];
  const shape: ForgeSepoliaRpcTransportShape = {
    request: (method, params) =>
      Effect.gen(function* () {
        calls.push({ method, params });
        if (method !== "eth_call") {
          return yield* Effect.fail(`unexpected rpc method ${method}`);
        }
        const served = script();
        if (typeof served === "object" && served !== null) {
          return yield* Effect.fail(served.fail);
        }
        return served;
      }),
  };
  return { calls, shape };
};

const routeConfigLayer = (env: Record<string, string | undefined>) =>
  Layer.succeed(
    SwapRouteConfig,
    SwapRouteConfig.of({
      resolve: Effect.sync((): SwapRouteSettings => resolveSwapRouteSettings(env)),
    }),
  );

const quoteLayer = (
  transport: ForgeSepoliaRpcTransportShape,
  env: Record<string, string | undefined> = routesEnv([routeFixture()]),
) =>
  UniswapQuoteServiceLive.pipe(
    Layer.provide(routeConfigLayer(env)),
    Layer.provide(Layer.succeed(ForgeSepoliaTransport, ForgeSepoliaTransport.of(transport))),
  );

// ---------------------------------------------------------------------------
// QuoterAbi — encoder and decoder against the pinned shape
// ---------------------------------------------------------------------------

/** The calldata after `0x`+selector, split into 32-byte word strings. */
const calldataWords = (hex: string): ReadonlyArray<string> => {
  const body = hex.slice(2 + 8);
  const words: Array<string> = [];
  for (let offset = 0; offset < body.length; offset += 64)
    words.push(body.slice(offset, offset + 64));
  return words;
};

describe("QuoterAbi", () => {
  it("selects the live-verified deployment selector", () => {
    // Frozen literal from the 2026-09-12 bytecode probe of the deployed
    // Sepolia V4Quoter (0x61b3f201...ccf9227): the runtime code contains
    // exactly this selector for quoteExactInputSingle.
    const selector = keccak256(toBytes(QUOTE_EXACT_INPUT_SINGLE_SIGNATURE)).slice(0, 10);
    assert.equal(selector, "0xaa9d21cb");
  });

  it("encodes quoteExactInputSingle as selector + offset + struct words (hand-derived)", () => {
    const encoded = encodeQuoteExactInputSingle({
      poolKey: { currency0: C0, currency1: C1, fee: 500, tickSpacing: 60, hooks: HOOKS },
      zeroForOne: true,
      exactAmountRaw: "1000000000000000000",
    });
    // Words per the ABI (verified live against the deployed quoter):
    //  1      offset to the params struct (one dynamic argument)
    //  2-6    the poolKey tuple's five static members
    //  7      zeroForOne
    //  8      exactAmount
    //  9      hookData's offset, measured from the start of the arguments
    //         block: outer offset word (32) + 7 static words (224) = 0x100
    //  10     hookData length (empty)
    assert.deepEqual(calldataWords(encoded), [
      word(0x20n),
      word(C0.slice(2)),
      word(C1.slice(2)),
      word(500n),
      word(60n),
      word(HOOKS.slice(2)),
      word(1n),
      word(1_000_000_000_000_000_000n),
      word(0x100n),
      word(0n),
    ]);
  });

  it("encodes zeroForOne false as a zero direction word", () => {
    const encoded = encodeQuoteExactInputSingle({
      poolKey: { currency0: C0, currency1: C1, fee: 500, tickSpacing: 60, hooks: HOOKS },
      zeroForOne: false,
      exactAmountRaw: "1",
    });
    // Word 7 (after the offset word and the 5 poolKey members) is the flag.
    assert.equal(calldataWords(encoded)[6], word(0n));
  });
});

describe("decodeQuoteExactInputSingleResult", () => {
  it("decodes the deployment-era two-word (amountOut, gasEstimate) return", () => {
    const decoded = decodeQuoteExactInputSingleResult("0x" + word(12345n) + word(210000n));
    assert.deepEqual(decoded, { ok: true, amountOut: "12345" });
  });

  it("decodes a bare single-word v1 return as amountOut", () => {
    const decoded = decodeQuoteExactInputSingleResult("0x" + word(999n));
    assert.deepEqual(decoded, { ok: true, amountOut: "999" });
  });

  it("decodes an offset-encoded QuoterV2-style struct return", () => {
    const decoded = decodeQuoteExactInputSingleResult(
      "0x" + word(0x20n) + word(1000n) + word(4242n) + word(2n ** 80n) + word(1n),
    );
    assert.deepEqual(decoded, { ok: true, amountOut: "4242" });
  });

  it("refuses unparseable responses by name", () => {
    const bad = [
      "0x", // empty
      "0xdeadbeef", // ragged, not whole words
      "0x" + "ab".repeat(31), // 31 bytes
      "not-hex",
      "0x" + word(0x20n) + word(1n) + word(2n) + word(999n), // struct body too short
      "0x" + word(0x20n) + word(1n) + word(2n) + word(3n) + word(2n), // bool word not 0/1
      "0x" + word(0x21n) + word(1n) + word(2n) + word(3n) + word(1n), // misaligned offset
    ];
    for (const value of bad) {
      assert.deepEqual(decodeQuoteExactInputSingleResult(value), {
        ok: false,
        refusal: "unparseable quote response",
      });
    }
  });
});

// ---------------------------------------------------------------------------
// The approved-route registry
// ---------------------------------------------------------------------------

describe("resolveSwapRouteSettings", () => {
  it("is honestly unconfigured when T3_SWAP_ROUTES is absent or empty", () => {
    for (const env of [{}, { T3_SWAP_ROUTES: "" }, { T3_SWAP_ROUTES: "   " }]) {
      const settings = resolveSwapRouteSettings(env);
      assert.equal(settings.configured, false);
      assert.equal(settings.reason, "no swap routes are configured (T3_SWAP_ROUTES)");
      assert.equal(settings.routes, undefined);
    }
  });

  it("has no code-declared default routes to narrow — the empty registry IS the default", () => {
    // Unlike T3_FORGE_POOLS (three vetted mainnet pools the environment can
    // only narrow), no Sepolia pool identity is verifiable offline, so this
    // registry ships empty on purpose and the live setup declares every
    // route through T3_SWAP_ROUTES. There is no narrowing step here by
    // design: absence of configuration is an honest refusal, not a fallback
    // to a default someone would have to trust.
    const settings = resolveSwapRouteSettings({});
    assert.equal(settings.configured, false);
    assert.equal(settings.routes, undefined);
  });

  it("refuses malformed JSON naming the variable", () => {
    const settings = resolveSwapRouteSettings({ T3_SWAP_ROUTES: "{not json" });
    assert.equal(settings.configured, false);
    assert.include(settings.reason ?? "", "T3_SWAP_ROUTES is not valid JSON");
  });

  it("refuses a non-array payload", () => {
    const settings = resolveSwapRouteSettings(routesEnv({ routeId: "x" }));
    assert.equal(settings.configured, false);
    assert.include(settings.reason ?? "", "must be a JSON array");
  });

  it("refuses an unknown routeType by name and index", () => {
    const settings = resolveSwapRouteSettings(
      routesEnv([routeFixture(), routeFixture({ routeId: "other", routeType: "uniswap-x" })]),
    );
    assert.equal(settings.configured, false);
    assert.include(settings.reason ?? "", "entry 1");
    assert.include(settings.reason ?? "", "'uniswap-x'");
    assert.include(settings.reason ?? "", "v4-exact-input-single");
  });

  it("refuses a non-Sepolia chainId, duplicate ids, and self-swaps", () => {
    const wrongChain = resolveSwapRouteSettings(routesEnv([routeFixture({ chainId: "1" })]));
    assert.equal(wrongChain.configured, false);
    assert.include(wrongChain.reason ?? "", "11155111");

    const duplicate = resolveSwapRouteSettings(
      routesEnv([routeFixture(), routeFixture({ label: "again" })]),
    );
    assert.equal(duplicate.configured, false);
    assert.include(duplicate.reason ?? "", "duplicate routeId");

    const self = resolveSwapRouteSettings(routesEnv([routeFixture({ tokenOut: C0 })]));
    assert.equal(self.configured, false);
    assert.include(self.reason ?? "", "must differ");
  });

  it("refuses malformed addresses, fees, tick spacings, and field types", () => {
    const cases: ReadonlyArray<[string, unknown, string]> = [
      ["tokenIn", routeFixture({ tokenIn: "0x1234" }), "tokenIn is not a 20-byte address"],
      ["quoter", routeFixture({ quoterAddress: "nothex" }), "quoterAddress"],
      [
        "poolKey currency",
        routeFixture({
          poolKey: { currency0: "0x99", currency1: C1, fee: 500, tickSpacing: 60, hooks: HOOKS },
        }),
        "currency0",
      ],
      [
        "fee",
        routeFixture({
          poolKey: { currency0: C0, currency1: C1, fee: 1_000_001, tickSpacing: 60, hooks: HOOKS },
        }),
        "fee",
      ],
      [
        "tickSpacing",
        routeFixture({
          poolKey: { currency0: C0, currency1: C1, fee: 500, tickSpacing: 0, hooks: HOOKS },
        }),
        "tickSpacing",
      ],
      ["zeroForOne type", routeFixture({ zeroForOne: "yes" }), "zeroForOne must be a boolean"],
      ["label type", routeFixture({ label: 7 }), "label must be a string"],
      ["entry shape", "not-an-object", "is not an object"],
    ];
    for (const [name, route, expected] of cases) {
      const settings = resolveSwapRouteSettings(routesEnv([route]));
      assert.equal(settings.configured, false, name);
      assert.include(settings.reason ?? "", expected, name);
    }
  });

  it("refuses routes whose tokens are not the pool's pair, or whose direction disagrees", () => {
    const stranger = resolveSwapRouteSettings(
      routesEnv([routeFixture({ tokenIn: `0x${"44".repeat(20)}` })]),
    );
    assert.equal(stranger.configured, false);
    assert.include(stranger.reason ?? "", "pool's currency0/currency1");

    const reversedDirection = resolveSwapRouteSettings(
      routesEnv([routeFixture({ zeroForOne: false })]),
    );
    assert.equal(reversedDirection.configured, false);
    assert.include(reversedDirection.reason ?? "", "zeroForOne must be true exactly when");
  });

  it("accepts a valid registry with addresses lowercased as canonical identities", () => {
    const mixed = "0xAbCdEfAbCdEfAbCdEfAbCdEfAbCdEfAbCdEfAbCd";
    const settings = resolveSwapRouteSettings(
      routesEnv([
        routeFixture({
          tokenIn: mixed,
          poolKey: { currency0: mixed, currency1: C1, fee: 500, tickSpacing: 60, hooks: HOOKS },
        }),
        routeFixture({ routeId: "reverse", tokenIn: C1, tokenOut: C0, zeroForOne: false }),
      ]),
    );
    assert.equal(settings.configured, true);
    assert.equal(settings.routes?.length, 2);
    const first = settings.routes?.[0];
    assert.equal(first?.tokenIn, mixed.toLowerCase());
    assert.equal(first?.poolKey.currency0, mixed.toLowerCase());
    assert.equal(first?.routeType, "v4-exact-input-single");
    assert.equal(first?.chainId, "11155111");
    // routeFor finds by the trimmed registry identity and nothing else.
    assert.equal(routeFor(settings, "reverse")?.tokenIn, C1);
    assert.equal(routeFor(settings, "nope"), null);
  });
});

// ---------------------------------------------------------------------------
// quoteExactInput
// ---------------------------------------------------------------------------

describe("UniswapQuoteService.quoteExactInput", () => {
  it.effect("quotes through the deployment-era quoter return and mints an immutable record", () =>
    Effect.gen(function* () {
      const fake = makeFakeTransport(() => "0x" + word(123456789n) + word(210000n));
      const service = yield* UniswapQuoteService.pipe(Effect.provide(quoteLayer(fake.shape)));
      const outcome = yield* service.quoteExactInput({
        routeId: ROUTE_ID,
        amountInRaw: "1000000",
        now: NOW,
      });
      assert.equal(outcome.status, "quoted");
      if (outcome.status !== "quoted") return;
      const record = outcome.record;
      assert.equal(record.chainId, "11155111");
      assert.equal(record.routeId, ROUTE_ID);
      assert.equal(record.tokenIn, C0);
      assert.equal(record.tokenOut, C1);
      assert.equal(record.amountInRaw, "1000000");
      // 0 bps default: the exact quoted output, never rounded.
      assert.equal(record.minAmountOutRaw, "123456789");
      assert.equal(record.gasEstimateWei, QUOTE_GAS_ESTIMATE_WEI_PLACEHOLDER);
      assert.equal(record.quotedAtMs, NOW);
      assert.equal(record.expiresAtMs, NOW + QUOTE_TTL_DEFAULT_MS);
      assert.ok(record.expiresAtMs > record.quotedAtMs);
      assert.equal(record.basis, "eth_call");
      assert.ok(record.quoteId.startsWith("sq_"));

      // The one chain read: eth_call to the route's quoter at the head, with
      // the pinned entrypoint's selector and no value anywhere.
      assert.equal(fake.calls.length, 1);
      const call = fake.calls[0]!;
      assert.equal(call.method, "eth_call");
      const [payload, blockTag] = call.params as [
        { readonly to: string; readonly data: string },
        string,
      ];
      assert.equal(payload.to, QUOTER);
      const selector = keccak256(toBytes(QUOTE_EXACT_INPUT_SINGLE_SIGNATURE)).slice(0, 10);
      assert.equal(payload.data.slice(0, 10).toLowerCase(), selector.toLowerCase());
      assert.equal(blockTag, "latest");
    }),
  );

  it.effect("quotes through the bare-word and offset-struct decode paths too", () =>
    Effect.gen(function* () {
      const v1 = makeFakeTransport(() => "0x" + word(555n));
      const serviceV1 = yield* UniswapQuoteService.pipe(Effect.provide(quoteLayer(v1.shape)));
      const oneWord = yield* serviceV1.quoteExactInput({
        routeId: ROUTE_ID,
        amountInRaw: "1",
        now: NOW,
      });
      assert.equal(oneWord.status, "quoted");
      if (oneWord.status === "quoted") {
        assert.equal(oneWord.record.minAmountOutRaw, "555");
      }

      const v2 = makeFakeTransport(
        () => "0x" + word(0x20n) + word(1n) + word(777n) + word(2n ** 80n) + word(1n),
      );
      const serviceV2 = yield* UniswapQuoteService.pipe(Effect.provide(quoteLayer(v2.shape)));
      const struct = yield* serviceV2.quoteExactInput({
        routeId: ROUTE_ID,
        amountInRaw: "1",
        now: NOW,
      });
      assert.equal(struct.status, "quoted");
      if (struct.status === "quoted") {
        assert.equal(struct.record.minAmountOutRaw, "777");
      }
    }),
  );

  it.effect("refuses when the registry is unconfigured, naming the honest reason", () =>
    Effect.gen(function* () {
      const fake = makeFakeTransport(() => "0x" + word(1n));
      const service = yield* UniswapQuoteService.pipe(Effect.provide(quoteLayer(fake.shape, {})));
      const outcome = yield* service.quoteExactInput({
        routeId: ROUTE_ID,
        amountInRaw: "1",
        now: NOW,
      });
      assert.include(
        refusedReason(outcome),
        "unconfigured: no swap routes are configured (T3_SWAP_ROUTES)",
      );
      assert.equal(fake.calls.length, 0);
    }),
  );

  it.effect("refuses a route id that is not in the approved registry", () =>
    Effect.gen(function* () {
      const fake = makeFakeTransport(() => "0x" + word(1n));
      const service = yield* UniswapQuoteService.pipe(Effect.provide(quoteLayer(fake.shape)));
      const outcome = yield* service.quoteExactInput({
        routeId: "uniswap-x-dutch",
        amountInRaw: "1",
        now: NOW,
      });
      assert.equal(
        refusedReason(outcome),
        "route-unapproved: uniswap-x-dutch is not in the approved route registry",
      );
      assert.equal(fake.calls.length, 0);
    }),
  );

  it.effect("refuses malformed amounts instead of clamping them", () =>
    Effect.gen(function* () {
      const fake = makeFakeTransport(() => "0x" + word(1n));
      const service = yield* UniswapQuoteService.pipe(Effect.provide(quoteLayer(fake.shape)));
      for (const amount of ["0", "-5", "1.5", "abc", "01", ""]) {
        const outcome = yield* service.quoteExactInput({
          routeId: ROUTE_ID,
          amountInRaw: amount,
          now: NOW,
        });
        assert.include(refusedReason(outcome), "invalid-amount", amount);
      }
      // Above the quoter's uint128 bound: refused by the bound's own name.
      const over = yield* service.quoteExactInput({
        routeId: ROUTE_ID,
        amountInRaw: (QUOTE_EXACT_AMOUNT_MAX + 1n).toString(10),
        now: NOW,
      });
      assert.include(refusedReason(over), "uint128");
      // At the bound itself the codec still encodes — the refusal above is
      // the bound, not something below it.
      const atBound = yield* service.quoteExactInput({
        routeId: ROUTE_ID,
        amountInRaw: QUOTE_EXACT_AMOUNT_MAX.toString(10),
        now: NOW,
      });
      assert.equal(atBound.status, "quoted");
      assert.equal(fake.calls.length, 1);
    }),
  );

  it.effect("refuses malformed slippage and ttl instead of coercing them", () =>
    Effect.gen(function* () {
      const fake = makeFakeTransport(() => "0x" + word(10n));
      const service = yield* UniswapQuoteService.pipe(Effect.provide(quoteLayer(fake.shape)));
      for (const bps of [1.5, -1, 10_001, Number.NaN]) {
        const outcome = yield* service.quoteExactInput({
          routeId: ROUTE_ID,
          amountInRaw: "1",
          now: NOW,
          maxSlippageBps: bps,
        });
        assert.include(refusedReason(outcome), "invalid-slippage", String(bps));
      }
      const ttl = yield* service.quoteExactInput({
        routeId: ROUTE_ID,
        amountInRaw: "1",
        now: NOW,
        quoteTtlMs: Number.POSITIVE_INFINITY,
      });
      assert.include(refusedReason(ttl), "invalid-ttl");
    }),
  );

  it.effect("rejects invalid clocks and expiry arithmetic before RPC", () =>
    Effect.gen(function* () {
      const fake = makeFakeTransport(() => "0x" + word(10n));
      const service = yield* UniswapQuoteService.pipe(Effect.provide(quoteLayer(fake.shape)));
      for (const now of [-1, Number.NaN, Number.POSITIVE_INFINITY, NOW + 0.5]) {
        const outcome = yield* service.quoteExactInput({
          routeId: ROUTE_ID,
          amountInRaw: "1",
          now,
        });
        assert.include(refusedReason(outcome), "invalid-clock");
      }
      for (const quoteTtlMs of [-1, 0.5, Number.MAX_SAFE_INTEGER]) {
        const outcome = yield* service.quoteExactInput({
          routeId: ROUTE_ID,
          amountInRaw: "1",
          now: NOW,
          quoteTtlMs,
        });
        assert.include(refusedReason(outcome), "invalid-ttl");
      }
      assert.equal(fake.calls.length, 0);
    }),
  );

  it.effect("refuses a positive output whose slippage floor is zero", () =>
    Effect.gen(function* () {
      const fake = makeFakeTransport(() => "0x" + word(1n) + word(210000n));
      const service = yield* UniswapQuoteService.pipe(Effect.provide(quoteLayer(fake.shape)));
      const outcome = yield* service.quoteExactInput({
        routeId: ROUTE_ID,
        amountInRaw: "1",
        now: NOW,
        maxSlippageBps: 1,
      });
      assert.include(refusedReason(outcome), "slippage rounds minimum output to zero");
    }),
  );

  it.effect("enforces the ttl floor and honors an explicit ttl", () =>
    Effect.gen(function* () {
      const fake = makeFakeTransport(() => "0x" + word(10n));
      const service = yield* UniswapQuoteService.pipe(Effect.provide(quoteLayer(fake.shape)));
      const floored = yield* service.quoteExactInput({
        routeId: ROUTE_ID,
        amountInRaw: "1",
        now: NOW,
        quoteTtlMs: 5,
      });
      assert.equal(floored.status, "quoted");
      if (floored.status === "quoted") {
        assert.equal(floored.record.expiresAtMs, NOW + QUOTE_TTL_MIN_MS);
      }
      const explicit = yield* service.quoteExactInput({
        routeId: ROUTE_ID,
        amountInRaw: "1",
        now: NOW,
        quoteTtlMs: 5_000,
      });
      assert.equal(explicit.status, "quoted");
      if (explicit.status === "quoted") {
        assert.equal(explicit.record.expiresAtMs, NOW + 5_000);
      }
    }),
  );

  it.effect("reduces minAmountOutRaw by exact BigInt floor for a nonzero bps", () =>
    Effect.gen(function* () {
      // 1000005 * (10000 - 30) / 10000 = 997004.85 -> floor 997004.
      const fake = makeFakeTransport(() => "0x" + word(1_000_005n) + word(210000n));
      const service = yield* UniswapQuoteService.pipe(Effect.provide(quoteLayer(fake.shape)));
      const outcome = yield* service.quoteExactInput({
        routeId: ROUTE_ID,
        amountInRaw: "1",
        now: NOW,
        maxSlippageBps: 30,
      });
      assert.equal(outcome.status, "quoted");
      if (outcome.status === "quoted") {
        assert.equal(outcome.record.minAmountOutRaw, "997004");
      }
    }),
  );

  it.effect("makes every RPC failure a named quote-unavailable with the URL redacted", () =>
    Effect.gen(function* () {
      const fake = makeFakeTransport(() => ({
        fail: "sepolia rpc transport failed: fetch failed at https://secret-key@rpc.example/v3/abc123",
      }));
      const service = yield* UniswapQuoteService.pipe(Effect.provide(quoteLayer(fake.shape)));
      const outcome = yield* service.quoteExactInput({
        routeId: ROUTE_ID,
        amountInRaw: "1",
        now: NOW,
      });
      const reason = refusedReason(outcome);
      assert.include(reason, "quote-unavailable:");
      assert.include(reason, "[redacted-url]");
      assert.ok(!reason.includes("secret-key"), "credential must not survive into the reason");
      assert.ok(!reason.includes("https://"), "no URL survives into the reason");
    }),
  );

  it.effect("refuses a non-hex eth_call result by name", () =>
    Effect.gen(function* () {
      const fake = makeFakeTransport(() => 42);
      const service = yield* UniswapQuoteService.pipe(Effect.provide(quoteLayer(fake.shape)));
      const outcome = yield* service.quoteExactInput({
        routeId: ROUTE_ID,
        amountInRaw: "1",
        now: NOW,
      });
      const reason = refusedReason(outcome);
      assert.include(reason, "quote-unavailable:");
      assert.include(reason, "non-hex result");
    }),
  );

  it.effect("refuses an unparseable quote response by name", () =>
    Effect.gen(function* () {
      const fake = makeFakeTransport(() => "0xdeadbeef");
      const service = yield* UniswapQuoteService.pipe(Effect.provide(quoteLayer(fake.shape)));
      const outcome = yield* service.quoteExactInput({
        routeId: ROUTE_ID,
        amountInRaw: "1",
        now: NOW,
      });
      assert.equal(refusedReason(outcome), "unparseable quote response");
    }),
  );

  it.effect("refuses an honest zero output — never a usable zero quote", () =>
    Effect.gen(function* () {
      const fake = makeFakeTransport(() => "0x" + word(0n) + word(0n));
      const service = yield* UniswapQuoteService.pipe(Effect.provide(quoteLayer(fake.shape)));
      const outcome = yield* service.quoteExactInput({
        routeId: ROUTE_ID,
        amountInRaw: "1",
        now: NOW,
      });
      assert.equal(refusedReason(outcome), "quote-unavailable: zero output");
    }),
  );

  it.effect(
    "derives the quote id from content: identical inputs collapse, any change re-prices",
    () =>
      Effect.gen(function* () {
        const fake = makeFakeTransport(() => "0x" + word(500n) + word(210000n));
        const service = yield* UniswapQuoteService.pipe(Effect.provide(quoteLayer(fake.shape)));
        const input = { routeId: ROUTE_ID, amountInRaw: "1000", now: NOW } as const;
        const first = yield* service.quoteExactInput(input);
        const second = yield* service.quoteExactInput(input);
        assert.equal(first.status, "quoted");
        assert.equal(second.status, "quoted");
        if (first.status === "quoted" && second.status === "quoted") {
          assert.deepEqual(first.record, second.record);
        }
        const otherAmount = yield* service.quoteExactInput({ ...input, amountInRaw: "1001" });
        const otherTime = yield* service.quoteExactInput({ ...input, now: NOW + 1 });
        assert.equal(otherAmount.status, "quoted");
        assert.equal(otherTime.status, "quoted");
        if (
          first.status === "quoted" &&
          otherAmount.status === "quoted" &&
          otherTime.status === "quoted"
        ) {
          assert.notEqual(otherAmount.record.quoteId, first.record.quoteId);
          assert.notEqual(otherTime.record.quoteId, first.record.quoteId);
        }
      }),
  );
});

// ---------------------------------------------------------------------------
// Freshness
// ---------------------------------------------------------------------------

describe("validateQuoteFresh", () => {
  it.effect("is fresh strictly before expiry; the expiry instant itself is stale", () =>
    Effect.gen(function* () {
      const fake = makeFakeTransport(() => "0x" + word(10n));
      const service = yield* UniswapQuoteService.pipe(Effect.provide(quoteLayer(fake.shape)));
      const outcome = yield* service.quoteExactInput({
        routeId: ROUTE_ID,
        amountInRaw: "1",
        now: NOW,
        quoteTtlMs: 5_000,
      });
      assert.equal(outcome.status, "quoted");
      if (outcome.status !== "quoted") return;
      const record = outcome.record;
      assert.equal(validateQuoteFresh(record, NOW - 1), false);
      assert.equal(validateQuoteFresh(record, Number.NEGATIVE_INFINITY), false);
      assert.equal(validateQuoteFresh(record, Number.NaN), false);
      assert.equal(validateQuoteFresh(record, NOW), true);
      assert.equal(validateQuoteFresh(record, NOW + 4_999), true);
      assert.equal(validateQuoteFresh(record, NOW + 5_000), false);
      assert.equal(validateQuoteFresh(record, NOW + 6_000), false);
    }),
  );
});

// ---------------------------------------------------------------------------
// Layer wiring smoke
// ---------------------------------------------------------------------------

describe("layer wiring", () => {
  it.effect("resolves the service from the ForgeSepoliaTransport tag the adapter uses", () =>
    Effect.gen(function* () {
      // UniswapQuoteServiceLive's requirement set is EXACTLY SwapRouteConfig
      // + ForgeSepoliaTransport — the same transport tag the forge adapter
      // consumes. Production shares one memoized instance by layer reference
      // (the forgeSepoliaTransport const in runtimeLayer.ts); here a fake at
      // that tag proves the read flows through it and nowhere else.
      const fake = makeFakeTransport(() => "0x" + word(321n));
      const service = yield* UniswapQuoteService.pipe(Effect.provide(quoteLayer(fake.shape)));
      const outcome = yield* service.quoteExactInput({
        routeId: ROUTE_ID,
        amountInRaw: "1",
        now: NOW,
      });
      assert.equal(outcome.status, "quoted");
      assert.equal(fake.calls.length, 1);
      assert.equal(fake.calls[0]?.method, "eth_call");
    }),
  );
});
