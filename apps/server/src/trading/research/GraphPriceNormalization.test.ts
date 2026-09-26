import { describe, expect, it } from "vite-plus/test";

import { normalizeGraphOhlc, normalizeGraphSwapPrice } from "./GraphPriceNormalization.ts";

const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const Q96 = 2n ** 96n;

describe("GraphPriceNormalization", () => {
  it("orients a 6/18-decimal swap as USDC per WETH when USDC is token0", () => {
    // sqrt(raw WETH / raw USDC) = 1_000_000, so human WETH/USDC is 1.
    const price = normalizeGraphSwapPrice({
      sqrtPriceX96: (Q96 * 1_000_000n).toString(),
      token0: { address: USDC, decimals: 6 },
      token1: { address: WETH, decimals: 18 },
      baseTokenAddress: WETH,
      quoteTokenAddress: USDC,
    });
    expect(price).toBeCloseTo(1, 12);
  });

  it("orients a swapped 18/6-decimal pool without assuming token order", () => {
    const price = normalizeGraphSwapPrice({
      sqrtPriceX96: (Q96 / 1_000_000n).toString(),
      token0: { address: WETH, decimals: 18 },
      token1: { address: USDC, decimals: 6 },
      baseTokenAddress: WETH,
      quoteTokenAddress: USDC,
    });
    expect(price).toBeCloseTo(1, 12);
  });

  it("inverts token0-denominated OHLC and exchanges high with low", () => {
    const candle = normalizeGraphOhlc(
      { open: "0.01", high: "0.02", low: "0.005", close: "0.01" },
      true,
    );
    expect(candle).toEqual({ open: 100, high: 200, low: 50, close: 100 });
  });

  it("rejects zero, nonfinite and invalid prices", () => {
    expect(() =>
      normalizeGraphOhlc({ open: "0", high: "2", low: "1", close: "1" }, false),
    ).toThrow();
    expect(() =>
      normalizeGraphOhlc({ open: "NaN", high: "2", low: "1", close: "1" }, false),
    ).toThrow();
    expect(() =>
      normalizeGraphSwapPrice({
        sqrtPriceX96: "0",
        token0: { address: USDC, decimals: 6 },
        token1: { address: WETH, decimals: 18 },
        baseTokenAddress: WETH,
        quoteTokenAddress: USDC,
      }),
    ).toThrow();
  });
});
