/**
 * Pinned ABI fragment and byte-level codec for the official Uniswap v4
 * V4Quoter's `quoteExactInputSingle` — the one quote entry point P5 uses.
 *
 * Pin source (the repo vendors v4-core only, NOT v4-periphery, so the lens
 * contract had to be pinned from the official repository and then verified
 * against the deployed contract):
 *
 *  - Uniswap/v4-periphery `src/interfaces/IV4Quoter.sol` at commit 2827167f8b
 *    (2024-12-10, "make natspec consistent (#414)") — the LAST commit
 *    touching that interface before the official v4 deployments recorded on
 *    developers.uniswap.org, the same page SepoliaTarget.ts pins the
 *    periphery addresses from. That revision declares, verbatim:
 *
 *      struct QuoteExactSingleParams {
 *          PoolKey poolKey;
 *          bool zeroForOne;
 *          uint128 exactAmount;
 *          bytes hookData;
 *      }
 *      function quoteExactInputSingle(QuoteExactSingleParams memory params)
 *          external returns (uint256 amountOut, uint256 gasEstimate);
 *
 *  - LIVE VERIFICATION (2026-09-12, read-only public-RPC probes of the
 *    deployed Sepolia V4Quoter 0x61b3f2011a92d183c7dbadbda940a7555ccf9227):
 *    the deployed runtime code contains the selector for exactly this shape
 *    (0xaa9d21cb) and NOT the older v3-QuoterV2-mirror shape
 *    ((address,uint256,address,bytes,uint160,(address,address,uint24,int24,
 *    address))); an eth_call with this fragment's encoding against a live
 *    pool returned the two-word `(amountOut, gasEstimate)` tuple. The bytes
 *    below match the deployment as of that date; re-verify only if the
 *    periphery is ever redeployed (the formal P8 live gate).
 *
 * The result decoder is deliberately defensive across the three return
 * layouts this quoter family has shipped: the deployment-era two-word
 * `(amountOut, gasEstimate)` tuple above, a bare single uint256 word (the
 * older draft/v1 style), and an offset-encoded
 * `{amountIn, amountOut, sqrtPriceX96After, initializedAfterHook}` struct
 * (the v3 QuoterV2 style). Anything else is a named refusal.
 *
 * @module QuoterAbi
 */
import { encodeFunctionData, parseAbi, type Abi, type Hex } from "viem";

// ---------------------------------------------------------------------------
// The ABI fragment (encode-side; decoding is hand-rolled below)
// ---------------------------------------------------------------------------

/**
 * The canonical signature whose keccak256 prefix selects
 * `quoteExactInputSingle` — note the poolKey tuple keeps its own parentheses
 * nested inside the params tuple. The derived selector is 0xaa9d21cb,
 * confirmed present in the deployed Sepolia runtime code (see the pin note).
 * Exported so tests recompute the selector from the ASCII bytes
 * independently of viem's own derivation.
 */
export const QUOTE_EXACT_INPUT_SINGLE_SIGNATURE =
  "quoteExactInputSingle(((address,address,uint24,int24,address),bool,uint128,bytes))";

/**
 * The deployed V4Quoter's exact-input-single entry point. Struct components
 * are named exactly as the pinned interface declares them; the returns are
 * declared for documentation — decoding goes through the defensive word-level
 * decoder below, never through viem's result decoder.
 */
export const v4QuoterAbi = parseAbi([
  "function quoteExactInputSingle(((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)",
]) as unknown as Abi;

/** The PoolKey tuple the quoter's params carry, in the v4 field order. */
export interface V4QuoterPoolKeyArgs {
  readonly currency0: `0x${string}`;
  readonly currency1: `0x${string}`;
  readonly fee: number;
  readonly tickSpacing: number;
  readonly hooks: `0x${string}`;
}

export interface QuoteExactInputSingleCall {
  readonly poolKey: V4QuoterPoolKeyArgs;
  /** Direction of the quoted swap: currency0 -> currency1 when true. */
  readonly zeroForOne: boolean;
  /**
   * Pre-validated by the caller: a positive decimal integer string within the
   * uint128 bound. This encoder is a pure codec over trusted input; it does
   * not re-validate, so a caller that skips validation owns the viem throw.
   */
  readonly exactAmountRaw: string;
}

/** The largest `exactAmount` the uint128 params field can carry. */
export const QUOTE_EXACT_AMOUNT_MAX = 2n ** 128n - 1n;

/**
 * Calldata for `quoteExactInputSingle` against the deployed V4Quoter:
 * selector + one offset word + the params struct body (5 PoolKey words,
 * zeroForOne, exactAmount, then the empty `hookData` offset and length).
 * Read-only call data — no value, no signature, no broadcast.
 */
export const encodeQuoteExactInputSingle = (call: QuoteExactInputSingleCall): Hex =>
  encodeFunctionData({
    abi: v4QuoterAbi,
    functionName: "quoteExactInputSingle",
    args: [
      {
        poolKey: {
          currency0: call.poolKey.currency0,
          currency1: call.poolKey.currency1,
          fee: call.poolKey.fee,
          tickSpacing: call.poolKey.tickSpacing,
          hooks: call.poolKey.hooks,
        },
        zeroForOne: call.zeroForOne,
        exactAmount: BigInt(call.exactAmountRaw),
        // No hook of ours consumes calldata on the quote path; empty is the
        // only honest value until a route spec says otherwise.
        hookData: "0x",
      },
    ],
  });

// ---------------------------------------------------------------------------
// Defensive result decoding — word-level, no decode dependency
// ---------------------------------------------------------------------------

const WORD_HEX_LENGTH = 64;

/** Every decode failure is this one named refusal; there is nothing to guess. */
export type V4QuoterResultDecode =
  | { readonly ok: true; readonly amountOut: string }
  | { readonly ok: false; readonly refusal: "unparseable quote response" };

const UNPARSEABLE: V4QuoterResultDecode = { ok: false, refusal: "unparseable quote response" };

/**
 * `0x`-prefixed hex split into 32-byte words as BigInts. Null — never a
 * throw — on anything that is not whole words of hex: the empty word list
 * ("0x"), a ragged tail, a missing prefix, or non-hex characters.
 */
const toWords = (data: string): ReadonlyArray<bigint> | null => {
  if (typeof data !== "string" || !data.startsWith("0x")) return null;
  const body = data.slice(2);
  if (body.length === 0 || body.length % WORD_HEX_LENGTH !== 0 || !/^[0-9a-fA-F]+$/.test(body)) {
    return null;
  }
  const words: Array<bigint> = [];
  for (let offset = 0; offset < body.length; offset += WORD_HEX_LENGTH) {
    words.push(BigInt(`0x${body.slice(offset, offset + WORD_HEX_LENGTH)}`));
  }
  return words;
};

/**
 * Decode an `eth_call` return from `quoteExactInputSingle` into the decimal
 * output amount, across the three layouts this quoter family has shipped
 * (see the module pin note for which one the deployed Sepolia contract uses):
 *
 *  1. two head-first uint256 words — the pinned deployment-era shape
 *     `(amountOut, gasEstimate)`;
 *  2. one word — the older bare-uint256 shape, where the word IS amountOut;
 *  3. an offset-encoded struct body
 *     `{amountIn, amountOut, sqrtPriceX96After, initializedAfterHook}` — the
 *     v3 QuoterV2 style; the bool word must be 0 or 1 or the shape is wrong.
 *
 * The word-count check keeps layouts 1 and 3 unambiguous: a struct decode
 * needs at least five words (offset + four body words), so a two-word return
 * can only be layout 1, and a two-word return whose first word happens to be
 * a small number is still amountOut — which is exactly what layout 1 says it
 * is.
 */
export const decodeQuoteExactInputSingleResult = (data: string): V4QuoterResultDecode => {
  const words = toWords(data);
  if (words === null) return UNPARSEABLE;
  if (words.length === 1) return { ok: true, amountOut: words[0]!.toString(10) };
  if (words.length === 2) return { ok: true, amountOut: words[0]!.toString(10) };
  const offset = words[0]!;
  if (offset < 32n || offset % 32n !== 0n) return UNPARSEABLE;
  const byteOffset = Number(offset);
  if (!Number.isSafeInteger(byteOffset)) return UNPARSEABLE;
  if (byteOffset + 128 > words.length * 32) return UNPARSEABLE;
  const bodyIndex = byteOffset / 32;
  const amountOut = words[bodyIndex + 1]!;
  const initializedAfterHook = words[bodyIndex + 3]!;
  if (initializedAfterHook !== 0n && initializedAfterHook !== 1n) return UNPARSEABLE;
  return { ok: true, amountOut: amountOut.toString(10) };
};
