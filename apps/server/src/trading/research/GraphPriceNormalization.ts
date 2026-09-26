import { GraphDataError } from "@t3tools/trading-contracts/researchData";

export interface GraphTokenMetadata {
  readonly address: string;
  readonly decimals: number;
}

function positiveFinite(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new GraphDataError({
      reason: "schema_mismatch",
      detail: "Graph returned a nonpositive or nonfinite price",
    });
  }
  return value;
}

/** Convert raw token1/token0 sqrt price to human quote/base units. */
export function normalizeGraphSwapPrice(input: {
  readonly sqrtPriceX96: string;
  readonly token0: GraphTokenMetadata;
  readonly token1: GraphTokenMetadata;
  readonly baseTokenAddress: string;
  readonly quoteTokenAddress: string;
}): number {
  if (
    !/^\d+$/.test(input.sqrtPriceX96) ||
    !Number.isInteger(input.token0.decimals) ||
    !Number.isInteger(input.token1.decimals) ||
    input.token0.decimals < 0 ||
    input.token1.decimals < 0
  ) {
    throw new GraphDataError({
      reason: "schema_mismatch",
      detail: "Graph returned invalid sqrt price or token decimals",
    });
  }
  const token1PerToken0 = positiveFinite(
    (Number(BigInt(input.sqrtPriceX96)) / 2 ** 96) ** 2 *
      10 ** (input.token0.decimals - input.token1.decimals),
  );
  const base = input.baseTokenAddress.toLowerCase();
  const quote = input.quoteTokenAddress.toLowerCase();
  if (base === input.token0.address.toLowerCase() && quote === input.token1.address.toLowerCase())
    return token1PerToken0;
  if (base === input.token1.address.toLowerCase() && quote === input.token0.address.toLowerCase())
    return positiveFinite(1 / token1PerToken0);
  throw new GraphDataError({
    reason: "schema_mismatch",
    detail: "Pool token addresses do not match requested price pair",
  });
}

/** Graph v3 OHLC stores token0Price: human token0 per human token1. */
export function normalizeGraphOhlc(
  raw: {
    readonly open: string;
    readonly high: string;
    readonly low: string;
    readonly close: string;
  },
  invert: boolean,
): { readonly open: number; readonly high: number; readonly low: number; readonly close: number } {
  const open = positiveFinite(Number(raw.open));
  const high = positiveFinite(Number(raw.high));
  const low = positiveFinite(Number(raw.low));
  const close = positiveFinite(Number(raw.close));
  if (low > Math.min(open, close) || high < Math.max(open, close) || low > high) {
    throw new GraphDataError({
      reason: "schema_mismatch",
      detail: "Graph OHLC ordering is inconsistent",
    });
  }
  return invert
    ? { open: 1 / open, high: 1 / low, low: 1 / high, close: 1 / close }
    : { open, high, low, close };
}
