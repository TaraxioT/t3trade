/**
 * Deterministic code generator for the T3 Trade pool-observations Substreams
 * package.
 *
 * Spec-driven generation, not a prewritten scenario connector: every emitted
 * byte is a pure function of the validated spec document. The generator
 * validates the spec against a closed vocabulary (single Ethereum mainnet
 * chain, the Uniswap v3 Swap event ABI verified against its canonical
 * signature, the frozen PoolBlock output fields) and refuses anything the
 * output contract cannot express honestly. Re-running the generator over an
 * unchanged spec must produce byte-identical files; `--check` proves that
 * against the existing tree and exits nonzero on drift.
 *
 * Usage:
 *   bun infra/substreams/codegen/generate.ts --spec <spec.json> --out <dir> \
 *     [--manifest <evidence-manifest.json>] [--check]
 *
 * No network access, no secrets, no timestamps in generated output.
 */

// ---------------------------------------------------------------------------
// Spec contract (validated before any file is emitted)
// ---------------------------------------------------------------------------

interface SpecEventInput {
  readonly indexed: boolean;
  readonly internalType: string;
  readonly name: string;
  readonly type: string;
}

interface SpecEvent {
  readonly name: string;
  readonly canonicalSignature: string;
  readonly topic0: string;
  readonly abiProvenance: string;
  readonly abiJson: ReadonlyArray<{
    readonly anonymous: boolean;
    readonly inputs: ReadonlyArray<SpecEventInput>;
    readonly name: string;
    readonly type: string;
  }>;
}

interface PoolObservationsSpec {
  readonly specVersion: number;
  readonly chainId: number;
  readonly network: string;
  readonly sourceBlockType: string;
  readonly packageName: string;
  readonly crateName: string;
  readonly packageVersion: string;
  readonly packageUrl: string;
  readonly initialBlock: number;
  readonly initialBlockProvenance: string;
  readonly poolFilter: ReadonlyArray<string>;
  readonly poolProvenance: string;
  readonly event: SpecEvent;
  readonly outputFields: ReadonlyArray<string>;
  readonly blockEnvelope: {
    readonly emitOnZeroSwapBlocks: boolean;
    readonly fields: ReadonlyArray<string>;
  };
}

/** The frozen PoolBlock output vocabulary this generator can emit. */
const FROZEN_OUTPUT_FIELDS = [
  "transactionHash",
  "logIndex",
  "pool",
  "amount0Raw",
  "amount1Raw",
  "sqrtPriceX96",
  "sender",
  "recipient",
] as const;

const FROZEN_ENVELOPE_FIELDS = [
  "schemaVersion",
  "chainId",
  "blockNumber",
  "blockHash",
  "blockTimestampSeconds",
] as const;

/** The one event ABI the output contract can express: Uniswap v3 Swap. */
const EXPECTED_SWAP_SIGNATURE = "Swap(address,address,int256,int256,uint160,uint128,int24)";

/** The chain table this generator accepts — single-chain by design. */
const ACCEPTED_CHAINS: Readonly<Record<string, number>> = { mainnet: 1 };

const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;
const TOPIC0_PATTERN = /^0x[0-9a-f]{64}$/;
const PACKAGE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const CRATE_NAME_PATTERN = /^[a-z0-9_]+$/;

class SpecError extends Error {}

const refuse = (reason: string): never => {
  throw new SpecError(reason);
};

const sha256Hex = async (content: string): Promise<string> => {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(content, "utf8").digest("hex");
};

function validateSpec(spec: PoolObservationsSpec): void {
  if (spec.specVersion !== 1) refuse(`specVersion must be 1, found ${spec.specVersion}`);
  const expectedChain = ACCEPTED_CHAINS[spec.network];
  if (expectedChain === undefined) {
    refuse(
      `network ${JSON.stringify(spec.network)} is not in the accepted chain table (${Object.keys(ACCEPTED_CHAINS).join(", ")})`,
    );
  }
  if (spec.chainId !== expectedChain) {
    refuse(
      `network ${spec.network} and chainId ${spec.chainId} disagree (expected ${expectedChain})`,
    );
  }
  if (spec.sourceBlockType !== "sf.ethereum.type.v2.Block") {
    refuse(
      `sourceBlockType must be sf.ethereum.type.v2.Block, found ${JSON.stringify(spec.sourceBlockType)}`,
    );
  }
  if (!PACKAGE_NAME_PATTERN.test(spec.packageName))
    refuse("packageName must be lowercase alphanumeric/hyphen");
  if (!CRATE_NAME_PATTERN.test(spec.crateName))
    refuse("crateName must be lowercase alphanumeric/underscore");
  if (!/^v\d+\.\d+\.\d+$/.test(spec.packageVersion))
    refuse("packageVersion must be v-prefixed semver");
  if (!/^https:\/\//.test(spec.packageUrl)) refuse("packageUrl must be an https URL");
  if (!Number.isSafeInteger(spec.initialBlock) || spec.initialBlock <= 0) {
    refuse("initialBlock must be a positive safe integer");
  }
  if (spec.initialBlockProvenance.trim() === "") refuse("initialBlockProvenance must be non-empty");
  if (spec.poolProvenance.trim() === "") refuse("poolProvenance must be non-empty");

  if (spec.poolFilter.length === 0 || spec.poolFilter.length > 4) {
    refuse("poolFilter must hold 1..4 pools (bounded by the source specification policy)");
  }
  const seenPools = new Set<string>();
  for (const pool of spec.poolFilter) {
    if (!ADDRESS_PATTERN.test(pool))
      refuse(`pool filter entry ${JSON.stringify(pool)} is not 0x + 40 lowercase hex`);
    if (seenPools.has(pool)) refuse(`duplicate pool filter entry ${pool}`);
    seenPools.add(pool);
  }

  const event = spec.event;
  if (event.name !== "Swap") refuse(`event.name must be "Swap" for the frozen output contract`);
  if (event.canonicalSignature !== EXPECTED_SWAP_SIGNATURE) {
    refuse(
      `canonicalSignature must be ${JSON.stringify(EXPECTED_SWAP_SIGNATURE)} (the verified Uniswap v3 Swap signature), found ${JSON.stringify(event.canonicalSignature)}`,
    );
  }
  if (!TOPIC0_PATTERN.test(event.topic0)) refuse("topic0 must be 0x + 64 lowercase hex");
  if (event.abiProvenance.trim() === "") refuse("event.abiProvenance must be non-empty");
  if (event.abiJson.length !== 1) refuse("abiJson must hold exactly the one selected event");
  const entry = event.abiJson[0];
  if (
    entry === undefined ||
    entry.type !== "event" ||
    entry.name !== "Swap" ||
    entry.anonymous !== false
  ) {
    refuse("abiJson[0] must be the non-anonymous Swap event entry");
  }
  // The declared ABI and the canonical signature must agree param-for-param:
  // the signature is reconstructed from the ABI in declaration order and
  // compared, so a reordered or edited ABI refuses before any code exists.
  const reconstructed = `${entry.name}(${entry.inputs.map((input) => input.type).join(",")})`;
  if (reconstructed !== event.canonicalSignature) {
    refuse(
      `abiJson param types reconstruct ${JSON.stringify(reconstructed)}, which is not the declared canonical signature`,
    );
  }
  const byName = new Map(entry.inputs.map((input) => [input.name, input]));
  for (const [name, indexed] of [
    ["sender", true],
    ["recipient", true],
    ["amount0", false],
    ["amount1", false],
    ["sqrtPriceX96", false],
    ["liquidity", false],
    ["tick", false],
  ] as const) {
    const input = byName.get(name);
    if (input === undefined) refuse(`abiJson is missing the ${name} parameter`);
    if (input.indexed !== indexed)
      refuse(`abiJson parameter ${name} must${indexed ? "" : " not"} be indexed`);
  }

  const frozenOutputs = FROZEN_OUTPUT_FIELDS.join(",");
  if (spec.outputFields.join(",") !== frozenOutputs) {
    refuse(`outputFields must be exactly the frozen PoolBlock event fields [${frozenOutputs}]`);
  }
  if (!spec.blockEnvelope.emitOnZeroSwapBlocks) {
    refuse(
      "blockEnvelope.emitOnZeroSwapBlocks must be true: zero-swap block envelopes are the completeness proof; a package that may skip them cannot prove empty intervals",
    );
  }
  if (spec.blockEnvelope.fields.join(",") !== FROZEN_ENVELOPE_FIELDS.join(",")) {
    refuse(`blockEnvelope.fields must be exactly [${FROZEN_ENVELOPE_FIELDS.join(",")}]`);
  }
}

// ---------------------------------------------------------------------------
// Templates — every emitted byte a pure function of the validated spec
// ---------------------------------------------------------------------------

const manifestYaml = (spec: PoolObservationsSpec): string => `specVersion: v0.1.0
package:
  name: ${spec.packageName}
  version: ${spec.packageVersion}
  url: ${spec.packageUrl}
  description: Parameterized Uniswap v3 Swap observations with one block envelope per block, including zero-swap blocks. Generated from spec by infra/substreams/codegen — do not edit by hand.
network: ${spec.network}
protobuf:
  files:
    - pool.proto
  importPaths:
    - ./proto
binaries:
  default:
    type: wasm/rust-v1
    file: ./target/wasm32-unknown-unknown/release/${spec.crateName}.wasm
modules:
  - name: map_pool_blocks
    kind: map
    initialBlock: ${spec.initialBlock}
    inputs:
      - params: string
      - source: ${spec.sourceBlockType}
    output:
      type: proto:t3trade.pool.v1.PoolBlocks
    doc: >
      One PoolBlocks envelope per block (zero-swap blocks included, so empty
      intervals are provable). The params string is a comma-separated list of
      0x-prefixed pool addresses; an empty params string falls back to the
      spec-embedded default pool filter. Each Swap log is ABI-decoded into
      exact signed decimal amount0/amount1 strings, sqrtPriceX96, sender,
      recipient and transaction/log identity. No network calls, no stores.
`;

const poolProto = (spec: PoolObservationsSpec): string => `syntax = "proto3";

package t3trade.pool.v1;

// Generated from spec by infra/substreams/codegen — do not edit by hand.
// Output contract: the frozen PoolBlock shape from the Substreams extraction
// plan. Exact quantities ride decimal strings so no consumer ever coerces a
// uint64/int256 through a double.

message SwapEvent {
  // 0x-prefixed lowercase hex; the transaction that emitted the log.
  string transaction_hash = 1;
  // The log's index within its block (as the block model reports it).
  uint32 log_index = 2;
  // 0x-prefixed lowercase hex; the pool that emitted the event.
  string pool = 3;
  // Exact signed decimal integer (int256), raw token units of token0.
  string amount0_raw = 4;
  // Exact signed decimal integer (int256), raw token units of token1.
  string amount1_raw = 5;
  // Exact decimal integer (uint160).
  string sqrt_price_x96 = 6;
  // 0x-prefixed lowercase hex; the address that initiated the swap call.
  // Routers and contracts appear here — never call senders distinct people.
  string sender = 7;
  // 0x-prefixed lowercase hex; the address that received the swap output.
  string recipient = 8;
}

message PoolBlocks {
  // Output schema version of this package's normalized shape.
  uint32 schema_version = 1;
  // The chain this package was generated for (spec chainId, e.g. 1 mainnet).
  uint64 chain_id = 2;
  // Block number (uint64; JSON consumers read it as a decimal string).
  uint64 block_number = 3;
  // 0x-prefixed lowercase hex block hash.
  string block_hash = 4;
  // Block timestamp in seconds since epoch (uint64; decimal string in JSON).
  uint64 block_timestamp_seconds = 5;
  // Decoded Swap events from this block; may be empty (the envelope still
  // proves the block was observed complete).
  repeated SwapEvent events = 6;
}
`;

const abiJson = (spec: PoolObservationsSpec): string =>
  `${JSON.stringify(spec.event.abiJson, null, 2)}\n`;

const buildRs = (): string => `fn main() {
    substreams_ethereum::Abigen::new("PoolEvents", "abi/pool-events.json")
        .expect("failed to load the pool events ABI")
        .generate()
        .expect("failed to generate ABI bindings")
        .write_to_file("src/abi/pool_events.rs")
        .expect("failed to write ABI bindings");

    prost_build::compile_protos(&["proto/pool.proto"], &["proto/"]).unwrap();
}
`;

const cargoToml = (spec: PoolObservationsSpec): string => `[package]
name = "${spec.crateName}"
version = "0.1.0"
edition = "2021"

[dependencies]
substreams = "0.7"
substreams-ethereum = "0.11"
prost = "0.13"
prost-types = "0.13"
hex = "0.4"
hex-literal = "0.4"
ethabi = "17"
anyhow = "1"

[build-dependencies]
substreams-ethereum = "0.11"
prost-build = "0.13"

[lib]
crate-type = ["cdylib"]

[profile.release]
lto = true
opt-level = "s"
strip = "debuginfo"
`;

const abiModRs = (): string => `// Generated module root for the build-time Abigen output.
pub mod pool_events;
`;

const libRs = (
  spec: PoolObservationsSpec,
): string => `//! Generated from spec by infra/substreams/codegen — do not edit by hand.
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
const DEFAULT_POOLS: [&[u8; 20]; ${spec.poolFilter.length}] = [
${spec.poolFilter.map((pool) => `    &hex_literal::hex!("${pool.slice(2)}"),`).join("\n")}
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
        chain_id: ${spec.chainId},
        block_number: block.number,
        block_hash: hex0x(&block.hash),
        block_timestamp_seconds,
        events,
    })
}
`;

const readme = (spec: PoolObservationsSpec): string => `# ${spec.packageName}

Parameterized Uniswap v3 Swap observations for Ethereum ${spec.network}
(chainId ${spec.chainId}), SPEC-GENERATED — every file here except this tree's
build artifacts is emitted by \`infra/substreams/codegen/generate.ts\` from
\`spec.json\`. Do not edit generated files; change the spec and regenerate.

## Shape

One \`map_pool_blocks\` map module over \`${spec.sourceBlockType}\`, emitting one
\`t3trade.pool.v1.PoolBlocks\` envelope per block (zero-swap blocks included)
with exact signed decimal \`amount0_raw\`/\`amount1_raw\`, \`sqrt_price_x96\`,
\`sender\`, \`recipient\` and transaction/log identity per decoded Swap log.

- Params: comma-separated 0x-prefixed pool addresses; empty params selects the
  spec-embedded default filter (${spec.poolFilter.join(", ")}).
- Default filter provenance: ${spec.poolProvenance}
- initialBlock ${spec.initialBlock}: ${spec.initialBlockProvenance}
- Event ABI provenance: ${spec.event.abiProvenance}
- topic0: ${spec.event.topic0}

## Regenerate

\`\`\`sh
bun infra/substreams/codegen/generate.ts \\
  --spec infra/substreams/pool-observations/spec.json \\
  --out infra/substreams/pool-observations \\
  --manifest infra/substreams/pool-observations/evidence/generation-manifest.json
\`\`\`

## Build

\`\`\`sh
cd infra/substreams/pool-observations && substreams build
\`\`\`

Requires the substreams CLI on PATH and the rust wasm32-unknown-unknown
target. The built .spkg is pinned by SHA-256 under \`evidence/\`.

## Determinism

Generated files contain no timestamps and no randomness; \`--check\` regenerates
in-memory and diffs against this tree. \`evidence/generation-manifest.json\`
records the spec hash and every generated file's SHA-256.
`;

const gitignore = (): string => `/target
src/abi/pool_events.rs
buf.gen.yaml
`;

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

interface GenerateOutcome {
  readonly written: ReadonlyArray<{ readonly path: string; readonly sha256: string }>;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const readArg = (name: string): string | undefined => {
    const index = args.indexOf(`--${name}`);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const specPath = readArg("spec");
  const outDir = readArg("out");
  const manifestPath = readArg("manifest");
  const check = args.includes("--check");
  if (specPath === undefined || outDir === undefined) {
    process.stderr.write(
      "usage: generate.ts --spec <spec.json> --out <dir> [--manifest <file>] [--check]\n",
    );
    process.exit(2);
  }

  const { readFile, writeFile, mkdir } = await import("node:fs/promises");
  const path = await import("node:path");

  let specRaw: string;
  try {
    specRaw = await readFile(specPath, "utf8");
  } catch (cause) {
    process.stderr.write(`cannot read spec ${specPath}: ${String(cause)}\n`);
    process.exit(2);
  }
  let spec: PoolObservationsSpec;
  try {
    spec = JSON.parse(specRaw) as PoolObservationsSpec;
  } catch (cause) {
    process.stderr.write(`spec is not valid JSON: ${String(cause)}\n`);
    process.exit(2);
  }
  try {
    validateSpec(spec);
  } catch (cause) {
    process.stderr.write(
      `spec refused: ${cause instanceof Error ? cause.message : String(cause)}\n`,
    );
    process.exit(1);
  }

  const files: ReadonlyArray<{ readonly path: string; readonly content: string }> = [
    { path: "substreams.yaml", content: manifestYaml(spec) },
    { path: "proto/pool.proto", content: poolProto(spec) },
    { path: "abi/pool-events.json", content: abiJson(spec) },
    { path: "build.rs", content: buildRs() },
    { path: "Cargo.toml", content: cargoToml(spec) },
    { path: "src/lib.rs", content: libRs(spec) },
    { path: "src/abi/mod.rs", content: abiModRs() },
    { path: "README.md", content: readme(spec) },
    { path: ".gitignore", content: gitignore() },
  ];

  const written: Array<{ readonly path: string; readonly sha256: string }> = [];
  const drift: Array<string> = [];
  for (const file of files) {
    const sha = await sha256Hex(file.content);
    const target = path.join(outDir, file.path);
    if (check) {
      let existing: string;
      try {
        existing = await readFile(target, "utf8");
      } catch {
        drift.push(`${file.path}: missing`);
        continue;
      }
      if (existing !== file.content) drift.push(`${file.path}: differs from regenerated content`);
      continue;
    }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.content, "utf8");
    written.push({ path: file.path, sha256: sha });
  }

  if (check) {
    if (drift.length > 0) {
      process.stderr.write(`generated tree drifted from the spec:\n${drift.join("\n")}\n`);
      process.exit(1);
    }
    process.stdout.write("generated tree matches the spec (byte-identical regeneration)\n");
    return;
  }

  const manifest = {
    generator: "infra/substreams/codegen/generate.ts",
    generatorVersion: 1,
    specPath: path.relative(process.cwd(), path.resolve(specPath)) || specPath,
    specSha256: await sha256Hex(specRaw),
    generatedAtNote:
      "file hashes are a pure function of the spec; no timestamps inside generated files",
    files: written,
  };
  const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
  if (manifestPath !== undefined) {
    await mkdir(path.dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, manifestJson, "utf8");
  }
  process.stdout.write(manifestJson);
}

main().catch((cause: unknown) => {
  process.stderr.write(
    `generator failed: ${cause instanceof Error ? cause.message : String(cause)}\n`,
  );
  process.exit(1);
});
