# t3trade-pool-observations

Parameterized Uniswap v3 Swap observations for Ethereum mainnet
(chainId 1), SPEC-GENERATED — every file here except this tree's
build artifacts is emitted by `infra/substreams/codegen/generate.ts` from
`spec.json`. Do not edit generated files; change the spec and regenerate.

## Shape

One `map_pool_blocks` map module over `sf.ethereum.type.v2.Block`, emitting one
`t3trade.pool.v1.PoolBlocks` envelope per block (zero-swap blocks included)
with exact signed decimal `amount0_raw`/`amount1_raw`, `sqrt_price_x96`,
`sender`, `recipient` and transaction/log identity per decoded Swap log.

- Params: comma-separated 0x-prefixed pool addresses; empty params selects the
  spec-embedded default filter (0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640).
- Default filter provenance: Primary demo pool from apps/server/src/trading/forge/GraphSource.ts DEFAULT_FORGE_POOLS (USDC/WETH 0.05%, token0 USDC 6 decimals, token1 WETH 18 decimals, baseIsToken1)
- initialBlock 12369621: Uniswap v3 factory deployment block on Ethereum mainnet (matches the v3 pool universe start; pool 0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640 was created shortly after)
- Event ABI provenance: https://github.com/Uniswap/v3-core/blob/main/contracts/interfaces/pool/IUniswapV3PoolEvents.sol (event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick))
- topic0: 0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67

## Regenerate

```sh
bun infra/substreams/codegen/generate.ts \
  --spec infra/substreams/pool-observations/spec.json \
  --out infra/substreams/pool-observations \
  --manifest infra/substreams/pool-observations/evidence/generation-manifest.json
```

## Build

```sh
cd infra/substreams/pool-observations && substreams build
```

Requires the substreams CLI on PATH and the rust wasm32-unknown-unknown
target. The built .spkg is pinned by SHA-256 under `evidence/`.

## Determinism

Generated files contain no timestamps and no randomness; `--check` regenerates
in-memory and diffs against this tree. `evidence/generation-manifest.json`
records the spec hash and every generated file's SHA-256.
