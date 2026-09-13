/**
 * The spot mainnet target — the dedicated Ethereum mainnet (chain 1)
 * configuration for the supervised spot-demo lane, deliberately separate
 * from SepoliaTarget: it never reuses the F0 fee-hook authority, the
 * Hyperliquid signers, or any Sepolia deployment, and the chain id is not
 * env-overridable.
 *
 * Every address below was verified from official Uniswap documentation and
 * probed over public mainnet RPC on 2026-09-13 (see
 * t3trade-plans/2026-09-13-substreams-mainnet/worker-c-progress.md for the
 * exact URLs, probes, and runtime-code keccak pins). No address in this file
 * comes from memory:
 *
 * - https://developers.uniswap.org/docs/protocols/v3/deployments/v3-ethereum-deployments
 *   (factory, QuoterV2, Permit2, WETH9, USDC — the page's own getPool example
 *   names the USDC address verbatim)
 * - https://raw.githubusercontent.com/Uniswap/universal-router-sdk/main/src/utils/constants.ts
 *   (the interface SDK's mainnet Universal Router 0x3fC9…, creation block
 *   17143817, source tag v1.4.0)
 * - https://developers.uniswap.org/deployments.json (newer Universal Router
 *   deployments exist; they are listed in the artifact and MAY be pinned via
 *   env override, but every override must supply its own code-hash pin and
 *   pass the same runtime verification before anything is funded)
 *
 * The runtime verifier below re-checks chain id, code hashes, the factory's
 * pool lookup, token decimals, and the pool's fee tier over RPC before the
 * funded gate may proceed — a redeployed proxy or a changed config refuses.
 *
 * Configuration only plus an HTTP transport and the fail-closed spot signer
 * config; no signing, no broadcasting.
 *
 * @module SpotMainnetTarget
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { Layer, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { t3tradeSecretsDir } from "@t3tools/hyperliquid/KeyLocation";

// ---------------------------------------------------------------------------
// Chain + verified addresses
// ---------------------------------------------------------------------------

/** Ethereum mainnet. The spot lane refuses any other chain. */
export const SPOT_MAINNET_CHAIN_ID = 1;

/** The same chain id as the route vocabulary carries it (decimal string). */
export const SPOT_MAINNET_CHAIN_ID_STRING = "1";

/**
 * Verified mainnet deployments (sources in the module comment). The Universal
 * Router default is the interface SDK's mainnet router; the alternates from
 * the unified deployments feed are recorded in the artifact for operators
 * pinning a newer deployment through env (with a code-hash pin).
 */
export const MAINNET_SPOT_ADDRESSES = {
  /** Universal Router v1.4.0 — supports execute(commands, inputs, deadline). */
  universalRouter: "0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD",
  /** QuoterV2 — current five-field quoteExactInputSingle (selector 0xc6a5026a). */
  quoterV2: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
  /** Permit2 — same deterministic deployment on every chain. */
  permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
  /** UniswapV3Factory. */
  v3Factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
  /** WETH9. */
  weth9: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  /** Native USDC (FiatToken proxy). */
  usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
} as const;

/**
 * Runtime-code keccak256 pins, measured over eth_getCode at a public mainnet
 * RPC on 2026-09-13 (the artifact records the exact probes). A runtime whose
 * code hash differs from its pin is a changed contract: the funded gate
 * refuses rather than execute against an unexpected proxy/version.
 */
export const MAINNET_SPOT_CODE_HASH_PINS = {
  universalRouter: "0xc4f0904cd0f741bb3ab2a16013d23b4d72eec59e3cb24879f0f0ba0c3fea24d9",
  quoterV2: "0x06148f47d0f41a68d3bc970030a7150e5d608cfbc28d372440a2e41ce543d92b",
  permit2: "0xc67d1657868aa5146eaf24fb879fb1fdec3d2d493b3683a61c9c2f4fb2851131",
  v3Factory: "0x4d7b8525cd5d14343fa67a732fba5b24cddba11620ca88392f4ec6c52f91fd69",
  weth9: "0xd0a06b12ac47863b5c7be4185c2deaad1c61557033f56c7d4ea74429cbb25e23",
  usdc: "0xd80d4b7c890cb9d6a4893e6b52bc34b56b25335cb13716e0d1d31383e6b41505",
  /** The one pool the demo routes trade: USDC/WETH 0.05%. */
  poolUsdcWeth500: "0xa981b66c747a3d9fa29d7e200d5faaa2826960523d0e5a0df8148e8868c480b4",
} as const;

/** The verified USDC/WETH v3 pool address (factory getPool(USDC, WETH, 500)). */
export const MAINNET_SPOT_USDC_WETH_500_POOL = "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640";

/** The pool's fee tier: 500 = 0.05%. */
export const MAINNET_SPOT_USDC_WETH_FEE_TIER = 500;

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX_64 = /^0x[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
// Target resolution
// ---------------------------------------------------------------------------

/** The resolved spot mainnet execution target. */
export interface SpotMainnetTarget {
  readonly chainId: typeof SPOT_MAINNET_CHAIN_ID;
  readonly rpcUrl: string;
  /**
   * The dedicated funded account (public information — the ADDRESS, never a
   * key). Null when unconfigured; estimates that need a funded `from`
   * (eth_estimateGas) refuse by name in that state.
   */
  readonly accountAddress: string | null;
  readonly universalRouter: string;
  readonly quoterV2: string;
  readonly permit2: string;
  readonly v3Factory: string;
  readonly weth9: string;
  readonly usdc: string;
  readonly pool: string;
  readonly feeTier: number;
  /** How far in the future the protected calldata's deadline lands, seconds. */
  readonly deadlineWindowSeconds: number;
  /** Code-hash pins actually in force (defaults, or env-supplied for overrides). */
  readonly codeHashPins: Readonly<Record<string, string>>;
}

/** The env names, one list so missing-target reasons can name them. */
export const SPOT_MAINNET_ENV_VARS = [
  "T3_SPOT_MAINNET_RPC_URL",
  "T3_SPOT_MAINNET_ACCOUNT_ADDRESS",
  "T3_SPOT_MAINNET_UNIVERSAL_ROUTER",
  "T3_SPOT_MAINNET_QUOTER_V2",
  "T3_SPOT_MAINNET_PERMIT2",
  "T3_SPOT_MAINNET_V3_FACTORY",
  "T3_SPOT_MAINNET_WETH",
  "T3_SPOT_MAINNET_USDC",
  "T3_SPOT_MAINNET_POOL",
  "T3_SPOT_MAINNET_FEE_TIER",
  "T3_SPOT_MAINNET_DEADLINE_SECONDS",
] as const;

interface RawEnv {
  readonly T3_SPOT_MAINNET_RPC_URL?: string;
  readonly T3_SPOT_MAINNET_ACCOUNT_ADDRESS?: string;
  readonly T3_SPOT_MAINNET_UNIVERSAL_ROUTER?: string;
  readonly T3_SPOT_MAINNET_UNIVERSAL_ROUTER_CODE_HASH?: string;
  readonly T3_SPOT_MAINNET_QUOTER_V2?: string;
  readonly T3_SPOT_MAINNET_QUOTER_V2_CODE_HASH?: string;
  readonly T3_SPOT_MAINNET_PERMIT2?: string;
  readonly T3_SPOT_MAINNET_PERMIT2_CODE_HASH?: string;
  readonly T3_SPOT_MAINNET_V3_FACTORY?: string;
  readonly T3_SPOT_MAINNET_V3_FACTORY_CODE_HASH?: string;
  readonly T3_SPOT_MAINNET_WETH?: string;
  readonly T3_SPOT_MAINNET_WETH_CODE_HASH?: string;
  readonly T3_SPOT_MAINNET_USDC?: string;
  readonly T3_SPOT_MAINNET_USDC_CODE_HASH?: string;
  readonly T3_SPOT_MAINNET_POOL?: string;
  readonly T3_SPOT_MAINNET_POOL_CODE_HASH?: string;
  readonly T3_SPOT_MAINNET_FEE_TIER?: string;
  readonly T3_SPOT_MAINNET_DEADLINE_SECONDS?: string;
}

const toPositiveIntOr = (raw: string | undefined, fallback: number): number => {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

/**
 * Read the spot mainnet target out of an env bag. Exposed for tests. The RPC
 * URL is required (an unconfigured target is the honest refused state, not an
 * error to paper over); every address override additionally requires its
 * matching `*_CODE_HASH` pin so an operator cannot silently point the funded
 * lane at an unverified contract. The CHAIN ID is not configurable.
 */
export const resolveSpotMainnetTarget = (
  env: RawEnv,
): SpotMainnetTarget | { readonly reason: string } => {
  const rpcUrl = env.T3_SPOT_MAINNET_RPC_URL?.trim();
  if (rpcUrl === undefined || rpcUrl === "") {
    return { reason: "spot mainnet target not configured (missing T3_SPOT_MAINNET_RPC_URL)" };
  }
  if (!rpcUrl.startsWith("https://")) {
    return { reason: "T3_SPOT_MAINNET_RPC_URL must be an https JSON-RPC endpoint" };
  }

  const accountRaw = env.T3_SPOT_MAINNET_ACCOUNT_ADDRESS?.trim();
  if (accountRaw !== undefined && accountRaw !== "" && !EVM_ADDRESS.test(accountRaw)) {
    return { reason: "T3_SPOT_MAINNET_ACCOUNT_ADDRESS is not a 20-byte address" };
  }
  const accountAddress =
    accountRaw === undefined || accountRaw === "" ? null : accountRaw.toLowerCase();

  // Address overrides: each must be a valid address AND carry its own
  // runtime-code-hash pin; overriding without a pin would point the funded
  // lane at an unverified contract.
  const pinned = (
    raw: string | undefined,
    pinRaw: string | undefined,
    fallbackAddress: string,
    fallbackPin: string,
    name: string,
  ): { readonly address: string; readonly pin: string } | { readonly reason: string } => {
    const value = raw?.trim();
    if (value === undefined || value === "") return { address: fallbackAddress, pin: fallbackPin };
    if (!EVM_ADDRESS.test(value)) return { reason: `${name} is not a 20-byte address` };
    const pin = pinRaw?.trim();
    if (pin === undefined || !HEX_64.test(pin)) {
      return {
        reason: `overriding ${name} requires T3_SPOT_MAINNET_${name}_CODE_HASH (0x + 64 hex) from a verified probe`,
      };
    }
    return { address: value.toLowerCase(), pin: pin.toLowerCase() };
  };

  const universalRouter = pinned(
    env.T3_SPOT_MAINNET_UNIVERSAL_ROUTER,
    env.T3_SPOT_MAINNET_UNIVERSAL_ROUTER_CODE_HASH,
    MAINNET_SPOT_ADDRESSES.universalRouter,
    MAINNET_SPOT_CODE_HASH_PINS.universalRouter,
    "UNIVERSAL_ROUTER",
  );
  if ("reason" in universalRouter) return universalRouter;
  const quoterV2 = pinned(
    env.T3_SPOT_MAINNET_QUOTER_V2,
    env.T3_SPOT_MAINNET_QUOTER_V2_CODE_HASH,
    MAINNET_SPOT_ADDRESSES.quoterV2,
    MAINNET_SPOT_CODE_HASH_PINS.quoterV2,
    "QUOTER_V2",
  );
  if ("reason" in quoterV2) return quoterV2;
  const permit2 = pinned(
    env.T3_SPOT_MAINNET_PERMIT2,
    env.T3_SPOT_MAINNET_PERMIT2_CODE_HASH,
    MAINNET_SPOT_ADDRESSES.permit2,
    MAINNET_SPOT_CODE_HASH_PINS.permit2,
    "PERMIT2",
  );
  if ("reason" in permit2) return permit2;
  const v3Factory = pinned(
    env.T3_SPOT_MAINNET_V3_FACTORY,
    env.T3_SPOT_MAINNET_V3_FACTORY_CODE_HASH,
    MAINNET_SPOT_ADDRESSES.v3Factory,
    MAINNET_SPOT_CODE_HASH_PINS.v3Factory,
    "V3_FACTORY",
  );
  if ("reason" in v3Factory) return v3Factory;
  const weth9 = pinned(
    env.T3_SPOT_MAINNET_WETH,
    env.T3_SPOT_MAINNET_WETH_CODE_HASH,
    MAINNET_SPOT_ADDRESSES.weth9,
    MAINNET_SPOT_CODE_HASH_PINS.weth9,
    "WETH",
  );
  if ("reason" in weth9) return weth9;
  const usdc = pinned(
    env.T3_SPOT_MAINNET_USDC,
    env.T3_SPOT_MAINNET_USDC_CODE_HASH,
    MAINNET_SPOT_ADDRESSES.usdc,
    MAINNET_SPOT_CODE_HASH_PINS.usdc,
    "USDC",
  );
  if ("reason" in usdc) return usdc;
  const pool = pinned(
    env.T3_SPOT_MAINNET_POOL,
    env.T3_SPOT_MAINNET_POOL_CODE_HASH,
    MAINNET_SPOT_USDC_WETH_500_POOL,
    MAINNET_SPOT_CODE_HASH_PINS.poolUsdcWeth500,
    "POOL",
  );
  if ("reason" in pool) return pool;

  const feeTier = Number(env.T3_SPOT_MAINNET_FEE_TIER?.trim() ?? MAINNET_SPOT_USDC_WETH_FEE_TIER);
  if (!Number.isInteger(feeTier) || feeTier < 0 || feeTier > 1_000_000) {
    return { reason: "T3_SPOT_MAINNET_FEE_TIER must be an integer in [0, 1000000]" };
  }

  return {
    chainId: SPOT_MAINNET_CHAIN_ID,
    rpcUrl,
    accountAddress,
    universalRouter: universalRouter.address,
    quoterV2: quoterV2.address,
    permit2: permit2.address,
    v3Factory: v3Factory.address,
    weth9: weth9.address,
    usdc: usdc.address,
    pool: pool.address,
    feeTier,
    deadlineWindowSeconds: toPositiveIntOr(env.T3_SPOT_MAINNET_DEADLINE_SECONDS, 120),
    codeHashPins: {
      universalRouter: universalRouter.pin,
      quoterV2: quoterV2.pin,
      permit2: permit2.pin,
      v3Factory: v3Factory.pin,
      weth9: weth9.pin,
      usdc: usdc.pin,
      pool: pool.pin,
    },
  };
};

// ---------------------------------------------------------------------------
// Runtime verification (the funded gate's identity re-check)
// ---------------------------------------------------------------------------

/** One JSON-RPC request against the spot mainnet endpoint. */
export type SpotMainnetRpcRequest = (
  method: string,
  params: ReadonlyArray<unknown>,
) => Effect.Effect<unknown, string>;

const toWords = (data: unknown): ReadonlyArray<bigint> | null => {
  if (typeof data !== "string" || !data.startsWith("0x")) return null;
  const body = data.slice(2);
  if (body.length === 0 || body.length % 64 !== 0 || !/^[0-9a-fA-F]+$/.test(body)) return null;
  const words: Array<bigint> = [];
  for (let offset = 0; offset < body.length; offset += 64) {
    words.push(BigInt(`0x${body.slice(offset, offset + 64)}`));
  }
  return words;
};

const codeHash = (code: unknown): string | null => {
  if (typeof code !== "string" || !code.startsWith("0x") || code.length <= 2) return null;
  try {
    return keccak256(toBytes(code as `0x${string}`));
  } catch {
    return null;
  }
};

/** The factory's getPool(address,address,uint24) calldata. */
const getPoolCalldata = (tokenA: string, tokenB: string, fee: number): string => {
  const padAddress = (value: string) => value.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  return (
    "0x1698ee82" +
    padAddress(tokenA) +
    padAddress(tokenB) +
    BigInt(fee).toString(16).padStart(64, "0")
  );
};

/** A contract's uint view (decimals(), fee()), or null. */
const uintView = (raw: unknown): bigint | null => {
  const words = toWords(raw);
  return words !== null && words.length === 1 ? words[0]! : null;
};

/**
 * Verify the target against the LIVE chain: chain id, every pinned code
 * hash, the factory's pool lookup, the pool's token pair and fee tier, and
 * both tokens' decimals. Every mismatch is a named refusal — the funded gate
 * never proceeds on a redeployed proxy, a changed pool, or a wrong chain.
 * Read-only: eth_chainId / eth_getCode / eth_call only.
 */
export const verifySpotMainnetTarget = (
  target: SpotMainnetTarget,
  request: SpotMainnetRpcRequest,
): Effect.Effect<
  { readonly verified: true } | { readonly refusals: ReadonlyArray<string> },
  never
> =>
  Effect.gen(function* () {
    const refusals: Array<string> = [];
    /** Run one boolean check; a false or failing outcome records a refusal. */
    const check = (name: string, effect: Effect.Effect<boolean, string>): Effect.Effect<void> =>
      effect.pipe(
        Effect.map((ok) => (ok ? null : `${name}: mismatch`)),
        Effect.catch((reason): Effect.Effect<string> => Effect.succeed(`${name}: ${reason}`)),
        Effect.map((problem) => {
          if (problem !== null) refusals.push(problem);
        }),
      );

    yield* check(
      "chain id",
      request("eth_chainId", []).pipe(
        Effect.map((value) => value === "0x1"),
        Effect.catch(() => Effect.succeed<boolean>(false)),
      ),
    );

    const pinChecks: ReadonlyArray<[string, string, string]> = [
      ["universalRouter", target.universalRouter, target.codeHashPins["universalRouter"]!],
      ["quoterV2", target.quoterV2, target.codeHashPins["quoterV2"]!],
      ["permit2", target.permit2, target.codeHashPins["permit2"]!],
      ["v3Factory", target.v3Factory, target.codeHashPins["v3Factory"]!],
      ["weth9", target.weth9, target.codeHashPins["weth9"]!],
      ["usdc", target.usdc, target.codeHashPins["usdc"]!],
      ["pool", target.pool, target.codeHashPins["pool"]!],
    ];
    for (const [name, address, pin] of pinChecks) {
      yield* check(
        `${name} code hash`,
        request("eth_getCode", [address, "latest"]).pipe(
          Effect.map((code) => codeHash(code) === pin),
          Effect.catch(() => Effect.succeed<boolean>(false)),
        ),
      );
    }

    // The factory must resolve the SAME pool the target pinned.
    yield* check(
      "factory getPool(usdc, weth, feeTier)",
      request("eth_call", [
        { to: target.v3Factory, data: getPoolCalldata(target.usdc, target.weth9, target.feeTier) },
        "latest",
      ]).pipe(
        Effect.map((raw) => {
          const words = toWords(raw);
          if (words === null || words.length !== 1) return false;
          const resolved = `0x${words[0]!.toString(16).padStart(40, "0")}`;
          return resolved === target.pool.toLowerCase();
        }),
        Effect.catch(() => Effect.succeed<boolean>(false)),
      ),
    );

    // Static views: pool token0/token1/fee and each token's decimals. A view
    // that cannot be read is a refusal, not a pass.
    const viewOf = (address: string, selector: string): Effect.Effect<bigint | null, never> =>
      request("eth_call", [{ to: address, data: selector }, "latest"]).pipe(
        Effect.map(uintView),
        Effect.catch(() => Effect.succeed<bigint | null>(null)),
      );
    const addressOfWord = (word: bigint): string => `0x${word.toString(16).padStart(40, "0")}`;

    const token0 = yield* viewOf(target.pool, "0x0dfe1681");
    const token1 = yield* viewOf(target.pool, "0xd21220a7");
    const expectedPair = [target.usdc.toLowerCase(), target.weth9.toLowerCase()].sort().join(",");
    const actualPair =
      token0 !== null && token1 !== null
        ? [addressOfWord(token0), addressOfWord(token1)].sort().join(",")
        : "unavailable";
    if (actualPair !== expectedPair) {
      refusals.push(`pool token pair: expected ${expectedPair}, got ${actualPair}`);
    }

    const poolFee = yield* viewOf(target.pool, "0xddca3f43");
    if (poolFee !== BigInt(target.feeTier)) {
      refusals.push(
        `pool fee tier: expected ${target.feeTier}, got ${poolFee?.toString(10) ?? "unavailable"}`,
      );
    }

    // Token decimals: USDC 6, WETH 18. A token whose decimals changed is a
    // different asset than the one the route denominated.
    const wethDec = yield* viewOf(target.weth9, "0x313ce567");
    const usdcDec = yield* viewOf(target.usdc, "0x313ce567");
    if (wethDec !== 18n) {
      refusals.push(`weth9 decimals: expected 18, got ${wethDec?.toString(10) ?? "unavailable"}`);
    }
    if (usdcDec !== 6n) {
      refusals.push(`usdc decimals: expected 6, got ${usdcDec?.toString(10) ?? "unavailable"}`);
    }

    const outcome: { readonly verified: true } | { readonly refusals: ReadonlyArray<string> } =
      refusals.length === 0 ? { verified: true } : { refusals };
    return outcome;
  }).pipe(
    Effect.catch((reason) =>
      Effect.succeed<{ readonly verified: true } | { readonly refusals: ReadonlyArray<string> }>({
        refusals: [`verification failed: ${String(reason)}`],
      }),
    ),
  );

// ---------------------------------------------------------------------------
// The transport (one JSON-RPC client over the configured endpoint)
// ---------------------------------------------------------------------------

/**
 * The spot mainnet RPC seam. `target()` re-resolves per call so an operator
 * fixing the env takes effect without a restart (the ForgeSepoliaTransport
 * discipline); it is null when the target is unconfigured, in which state
 * every mainnet path refuses by name.
 */
export interface SpotMainnetRpcShape {
  readonly request: (
    method: string,
    params: ReadonlyArray<unknown>,
  ) => Effect.Effect<unknown, string>;
  readonly target: () => SpotMainnetTarget | null;
}

export class SpotMainnetTransport extends Context.Service<
  SpotMainnetTransport,
  SpotMainnetRpcShape
>()("t3/trading/forge/SpotMainnetTarget/SpotMainnetTransport") {}

/**
 * HttpClient-backed JSON-RPC. The endpoint comes from configuration; the
 * request body carries method and params only, so no credential can ride the
 * URL. Tests inject a fake at this seam.
 */
export const SpotMainnetTransportLive = Layer.effect(
  SpotMainnetTransport,
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    let nextId = 0;
    return SpotMainnetTransport.of({
      target: () => {
        const resolved = resolveSpotMainnetTarget(process.env as RawEnv);
        return "reason" in resolved ? null : resolved;
      },
      request: (method, params) =>
        Effect.gen(function* () {
          const resolved = resolveSpotMainnetTarget(process.env as RawEnv);
          if ("reason" in resolved) {
            return yield* Effect.fail(resolved.reason);
          }
          const id = (nextId += 1);
          const response = yield* HttpClientRequest.post(resolved.rpcUrl).pipe(
            HttpClientRequest.bodyJson({ jsonrpc: "2.0", id, method, params: [...params] }),
            Effect.flatMap(client.execute),
            Effect.flatMap((res) => res.json),
            Effect.mapError(
              (cause): string => `spot mainnet rpc transport failed: ${String(cause)}`,
            ),
          );
          const body = response as { result?: unknown; error?: { message?: string } } | null;
          if (body !== null && typeof body === "object" && body.error !== undefined) {
            return yield* Effect.fail(
              `spot mainnet rpc error from ${method}: ${body.error.message ?? "unknown"}`,
            );
          }
          return body === null || body === undefined ? undefined : body.result;
        }),
    });
  }),
);

// ---------------------------------------------------------------------------
// The spot demo signer (fail-closed; NEVER Hyperliquid or F0 material)
// ---------------------------------------------------------------------------

/**
 * The spot demo signer's env names, following the InterimSignerConfig
 * pattern exactly:
 *
 * - `T3_SPOT_DEMO_SIGNER_KEY` — 0x-prefixed 32-byte hex secp256k1 key, when
 *   set directly in the environment.
 * - `T3_SPOT_MAINNET_SIGNER_KEY` — alias accepted for symmetry with the
 *   T3_SPOT_MAINNET_* target names; either env arms the gate.
 * - `T3_SPOT_DEMO_SIGNER_ADDRESS` — optional cross-check; a mismatch refuses.
 *
 * When no env key is set the key is read from the ONE canonical file shared
 * by every T3 Trade instance on the machine:
 *
 *   `<T3TRADE_HOME>/secrets/spot-demo-signer-key.bin` (default ~/.t3trade/secrets/…)
 *
 * The file must be mode 0600; any group/other permission bit refuses with
 * `insecure_key_permissions`. Under vitest the file source is disabled so no
 * test run ambiently arms live execution with a real key. When no source is
 * armed the signer resolves to none and every signable action refuses — the
 * broadcaster's funded lane is the only consumer, and it fails closed until
 * the operator explicitly arms it.
 */
export const SPOT_DEMO_SIGNER_ENV_KEYS = [
  "T3_SPOT_DEMO_SIGNER_KEY",
  "T3_SPOT_MAINNET_SIGNER_KEY",
] as const;
export const SPOT_DEMO_SIGNER_ADDRESS_ENV_KEY = "T3_SPOT_DEMO_SIGNER_ADDRESS";
export const SPOT_DEMO_SIGNER_SECRET_NAME = "spot-demo-signer-key";

/** The secret file could not be read — absent, unreadable, or wrong perms. */
export class SpotSecretFileReadError extends Schema.TaggedErrorClass<SpotSecretFileReadError>()(
  "SpotSecretFileReadError",
  { path: Schema.String, cause: Schema.Unknown },
) {}

/** A secret file's contents and the POSIX permission bits it was stored with. */
export interface SpotSecretFile {
  readonly text: string;
  /** The low 9 bits of the file mode, or null where they mean nothing. */
  readonly mode: number | null;
}

/** Read a secret file as UTF-8 with its permission bits; exported for tests. */
export const readSpotSecretFile = (
  path: string,
): Effect.Effect<SpotSecretFile, SpotSecretFileReadError> =>
  Effect.gen(function* () {
    const platform = yield* HostProcessPlatform;
    return yield* Effect.tryPromise({
      try: () =>
        import("node:fs/promises").then(async (fs) => {
          const [text, stat] = await Promise.all([fs.readFile(path, "utf8"), fs.stat(path)]);
          return { text, mode: platform === "win32" ? null : stat.mode & 0o777 };
        }),
      catch: (cause) => new SpotSecretFileReadError({ path, cause }),
    });
  });

/** The signer is invalid or the env shape was wrong. */
export class SpotDemoSignerError extends Schema.TaggedErrorClass<SpotDemoSignerError>()(
  "SpotDemoSignerError",
  {
    reason: Schema.Literals([
      "spot_signer_invalid_key",
      "spot_signer_address_mismatch",
      "spot_signer_insecure_key_permissions",
    ]),
  },
) {
  override get message(): string {
    return `SpotDemoSignerError(${this.reason})`;
  }
}

/** An armed spot demo signer: the funded account's address and raw key bytes. */
export interface SpotDemoSigner {
  readonly address: string;
  /** Raw 32-byte secp256k1 private key. Never logged, never persisted. */
  readonly privateKeyBytes: Uint8Array;
}

const SPOT_HEX_PRIV_RE = /^0x[0-9a-fA-F]{64}$/;
const SPOT_HEX_ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

const hexToBytes = (hex: string): Uint8Array => {
  const clean = hex.slice(2);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
};

const bytesToHex = (bytes: Uint8Array): `0x${string}` =>
  `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}` as `0x${string}`;

const deriveAddress = (keyBytes: Uint8Array): string =>
  privateKeyToAccount(bytesToHex(keyBytes)).address;

const buildSpotSigner = (
  keyRaw: string,
  explicitAddress: string | undefined,
): Effect.Effect<SpotDemoSigner, SpotDemoSignerError> =>
  Effect.gen(function* () {
    const trimmed = keyRaw.trim();
    const normalised = trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
    if (!SPOT_HEX_PRIV_RE.test(normalised)) {
      return yield* new SpotDemoSignerError({ reason: "spot_signer_invalid_key" });
    }
    const privateKeyBytes = hexToBytes(normalised);
    const derived = deriveAddress(privateKeyBytes);
    if (explicitAddress !== undefined) {
      const explicit = explicitAddress.trim();
      if (!SPOT_HEX_ADDR_RE.test(explicit)) {
        return yield* new SpotDemoSignerError({ reason: "spot_signer_invalid_key" });
      }
      if (explicit.toLowerCase() !== derived.toLowerCase()) {
        return yield* new SpotDemoSignerError({ reason: "spot_signer_address_mismatch" });
      }
    }
    return { address: derived.toLowerCase(), privateKeyBytes };
  });

export type SpotDemoSignerOption =
  | { readonly armed: false }
  | { readonly armed: true; readonly signer: SpotDemoSigner };

/** Resolve the spot signer from env; exposed for tests. */
export const resolveSpotDemoSignerFromEnv = (
  env: Record<string, string | undefined>,
): Effect.Effect<SpotDemoSignerOption, SpotDemoSignerError> =>
  Effect.gen(function* () {
    const keyRaw = SPOT_DEMO_SIGNER_ENV_KEYS.map((name) => env[name]?.trim()).find(
      (value) => value !== undefined && value !== "",
    );
    if (keyRaw === undefined) return { armed: false };
    const signer = yield* buildSpotSigner(keyRaw, env[SPOT_DEMO_SIGNER_ADDRESS_ENV_KEY]);
    return { armed: true, signer };
  });

/** Resolve the spot signer from the canonical secret file; exposed for tests. */
export const resolveSpotDemoSignerFromFile = (
  readFile: (path: string) => Effect.Effect<SpotSecretFile, SpotSecretFileReadError>,
  secretsDir: string,
  explicitAddress?: string,
): Effect.Effect<SpotDemoSignerOption, SpotDemoSignerError> =>
  Effect.gen(function* () {
    const path = `${secretsDir}/${SPOT_DEMO_SIGNER_SECRET_NAME}.bin`;
    const file = yield* readFile(path).pipe(
      Effect.map((read) => read),
      Effect.catch(() => Effect.succeed(null)),
    );
    if (file === null) return { armed: false };
    if (file.mode !== null && (file.mode & 0o077) !== 0) {
      return yield* new SpotDemoSignerError({ reason: "spot_signer_insecure_key_permissions" });
    }
    const signer = yield* buildSpotSigner(file.text, explicitAddress);
    return { armed: true, signer };
  });

/**
 * Env first, then the canonical secret file. Either source arms; both absent
 * leaves the spot lane fail-closed. Under vitest the file source is skipped.
 */
export const resolveSpotDemoSigner = (
  env: Record<string, string | undefined>,
  readFile: (path: string) => Effect.Effect<SpotSecretFile, SpotSecretFileReadError>,
  secretsDir: string,
): Effect.Effect<SpotDemoSignerOption, SpotDemoSignerError> =>
  Effect.gen(function* () {
    const fromEnv = yield* resolveSpotDemoSignerFromEnv(env);
    if (fromEnv.armed) return fromEnv;
    return yield* resolveSpotDemoSignerFromFile(
      readFile,
      secretsDir,
      env[SPOT_DEMO_SIGNER_ADDRESS_ENV_KEY],
    );
  });

/**
 * The live resolver: env, then the canonical file at `<T3TRADE_HOME>/secrets`
 * (disabled under vitest so no test ambiently arms live execution).
 */
export class SpotDemoSignerConfig extends Context.Service<
  SpotDemoSignerConfig,
  { readonly resolve: Effect.Effect<SpotDemoSignerOption, SpotDemoSignerError> }
>()("t3/trading/forge/SpotMainnetTarget/SpotDemoSignerConfig") {}

export const SpotDemoSignerConfigLive = Layer.sync(SpotDemoSignerConfig, () =>
  SpotDemoSignerConfig.of({
    resolve:
      process.env.VITEST !== undefined
        ? resolveSpotDemoSignerFromEnv(process.env)
        : resolveSpotDemoSigner(process.env, readSpotSecretFile, t3tradeSecretsDir()),
  }),
);
