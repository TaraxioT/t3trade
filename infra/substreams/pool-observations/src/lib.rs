//! Generated from spec by infra/substreams/codegen — do not edit by hand.
//!
//! One map module over full blocks: filter logs to the parameterized pool
//! addresses, ABI-decode Uniswap v3 Swap logs into exact decimal strings, and
//! ALWAYS emit a block envelope — a block with zero matching swaps still
//! produces a PoolBlocks message, which is the completeness proof for empty
//! intervals downstream. No network calls, no stores, no clock beyond the
//! block's own timestamp.

mod abi;
mod pb;

use substreams::errors::Error;
use substreams::Hex;
use substreams_ethereum::pb::eth::v2 as eth;
use substreams_ethereum::Event; // required for match_and_decode

fn hex0x(bytes: &[u8]) -> String {
    format!("0x{}", Hex::encode(bytes))
}

// The spec-embedded default pool filter (hex, no 0x, 20 bytes each). The
// runtime params string overrides it; an empty params string uses it.
const DEFAULT_POOLS: [&[u8; 20]; 1] = [
    &hex_literal::hex!("88e6a0c2ddd26feeb64f039a2c41296fcb3f5640"),
];

fn default_pools() -> Vec<[u8; 20]> {
    DEFAULT_POOLS.iter().map(|pool| **pool).collect()
}

/// Parse the comma-separated 0x-prefixed pool filter param. An empty string
/// selects the spec-embedded defaults. Malformed input is an error, never a
/// silent unfiltered stream: an unparseable filter must not widen extraction.
fn parse_pool_params(params: &str) -> Result<Vec<[u8; 20]>, Error> {
    let trimmed = params.trim();
    if trimmed.is_empty() {
        return Ok(default_pools());
    }
    let mut pools = Vec::new();
    for part in trimmed.split(',') {
        let raw = part.trim();
        let stripped = raw
            .strip_prefix("0x")
            .ok_or_else(|| anyhow::anyhow!("pool filter entry {raw} must be 0x-prefixed"))?;
        if stripped.len() != 40 {
            return Err(anyhow::anyhow!(
                "pool filter entry {raw} must be 0x + 40 hex characters"
            ));
        }
        let mut bytes = [0u8; 20];
        hex::decode_to_slice(stripped, &mut bytes)
            .map_err(|cause| anyhow::anyhow!("pool filter entry {raw} is not valid hex: {cause}"))?;
        pools.push(bytes);
    }
    if pools.is_empty() {
        return Err(anyhow::anyhow!("pool filter param resolved to no pools"));
    }
    Ok(pools)
}

#[substreams::handlers::map]
fn map_pool_blocks(
    params: String,
    block: eth::Block,
) -> Result<pb::t3trade::pool::v1::PoolBlocks, Error> {
    let pools = parse_pool_params(&params)?;
    let mut events = Vec::new();

    // block.transactions() yields successful transactions only;
    // logs_with_calls() excludes logs of reverted sub-calls and orders by
    // ordinal — the canonical extraction loop.
    for trx in block.transactions() {
        let tx_hash = hex0x(&trx.hash);
        for (log, _call) in trx.logs_with_calls() {
            if !pools.iter().any(|pool| log.address == *pool) {
                continue;
            }
            if let Some(swap) = abi::pool_events::events::Swap::match_and_decode(log) {
                events.push(pb::t3trade::pool::v1::SwapEvent {
                    transaction_hash: tx_hash.clone(),
                    log_index: log.index,
                    pool: hex0x(&log.address),
                    // int256 -> exact signed decimal string; never through f64.
                    amount0_raw: swap.amount0.to_string(),
                    amount1_raw: swap.amount1.to_string(),
                    // uint160 -> exact decimal string.
                    sqrt_price_x96: swap.sqrt_price_x96.to_string(),
                    sender: hex0x(&swap.sender),
                    recipient: hex0x(&swap.recipient),
                });
            }
        }
    }

    // The envelope is ALWAYS emitted, zero-swap blocks included: its
    // block/timestamp fields are non-default for every real block, so an
    // empty interval is carried by a real message, never inferred from
    // silence.
    let block_timestamp_seconds = u64::try_from(block.timestamp().seconds)
        .map_err(|_| anyhow::anyhow!("block {} has a negative timestamp", block.number))?;
    Ok(pb::t3trade::pool::v1::PoolBlocks {
        schema_version: 1,
        chain_id: 1,
        block_number: block.number,
        block_hash: hex0x(&block.hash),
        block_timestamp_seconds,
        events,
    })
}
