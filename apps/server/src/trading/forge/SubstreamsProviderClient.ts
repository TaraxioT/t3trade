/**
 * SubstreamsProviderClient — the production `SubstreamsStreamClient` over the
 * INSTALLED official stack: @substreams/core 0.17.0, @connectrpc/connect-node
 * 1.7.0, @bufbuild/protobuf 1.10.1.
 *
 * Installed-API facts this adapter is written against (verified against
 * apps/server/node_modules, not docs):
 *
 * - `fetchPackage` does NOT exist in 0.17.0. Package loading is
 *   `createSubstream(bytes)` (local file, host-read) or `fetchSubstream(url)`
 *   (unbounded helper — bypassed here in favor of a byte-capped fetch).
 * - `createRequest` options carry BOTH `finalBlocksOnly?: boolean` AND
 *   `productionMode?: boolean` as SEPARATE fields. `finalBlocksOnly` is the
 *   final-blocks-only request flag (sf.substreams.rpc.v2.Request field 4);
 *   `productionMode` (field 5) is a different feature (server-side
 *   parallelization without debug info). This client ALWAYS requests
 *   `finalBlocksOnly: true` — that is the client contract — and passes
 *   `productionMode` through from the caller's request untouched. Under a
 *   final-blocks-only request every delivered `blockScopedData` message is
 *   final by construction, so the mapped block message carries `final: true`;
 *   the wire's `finalBlockHeight` field is advisory undo-GC metadata, not a
 *   per-block verdict, and is deliberately not used as one.
 * - `streamBlocks(transport, request, options)` yields the decoded
 *   `sf.substreams.rpc.v2.Response` DIRECTLY (no stateful wrapper); the
 *   `response.message.case` oneof carries `session` (ignored), `progress`
 *   (ignored), `blockScopedData`, `blockUndoSignal`, and `fatalError`.
 * - `createRegistry(pkg)` registers every message type in the .spkg's proto
 *   files, so the output `google.protobuf.Any` (typeUrl
 *   `type.googleapis.com/t3trade.pool.v1.PoolBlocks`) decodes through
 *   `any.unpack(registry)` into a dynamic message read here by strict
 *   narrowing. uint64/int64 fields decode as `bigint`; hashes arrive as
 *   strings that may or may not carry the `0x` prefix and are normalized.
 * - `applyParams(["module=value"], modules)` is how the package's params
 *   input is set before `createRequest` snapshots the module graph.
 *
 * Safety properties:
 *
 * - The provider token is read HERE from the env var named by the request
 *   (`tokenEnvName`, default `SUBSTREAMS_API_TOKEN`) and leaves this module
 *   exactly once: as the `Authorization: Bearer` header installed by
 *   `createAuthInterceptor` on the transport. It is never logged and never
 *   appears in a failure reason — every provider-facing error string passes
 *   a redaction that replaces the token value with `[redacted]`.
 * - ONE connection per `consume` call: the transport (and its HTTP/2
 *   session) is created per call and closed on every exit path — success,
 *   failure, or interruption (AbortController + iterator.return, awaited in
 *   an exit finalizer).
 * - Bounded payloads: the transport's `readMaxBytes` caps any single wire
 *   message (default 32 MiB, well under connect's ~4 GiB default and well
 *   over the ingestion layer's 8 MiB normalized single-message cap) and the
 *   .spkg load is byte-capped (64 MiB).
 * - Clock/envelope consistency is verified per block (number, hash,
 *   timestamp): the provider's clock is the block identity; a disagreement
 *   with the decoded package envelope refuses the message instead of
 *   committing an ambiguous block.
 *
 * Provider re-run command once a token exists (see worker-a-progress.md):
 *   SUBSTREAMS_API_TOKEN=<jwt> — endpoint https://mainnet.eth.streamingfast.io:443,
 *   package infra/substreams/pool-observations/t3trade-pool-observations-v0.1.0.spkg,
 *   output module map_pool_blocks, blocks 12369621..+3.
 *
 * @module SubstreamsProviderClient
 */
// @effect-diagnostics nodeBuiltinImport:off - the pinned .spkg is read from the operator's filesystem; the host file read IS the boundary being performed.
// @effect-diagnostics globalFetch:off - the one https .spkg fetch is host I/O inside tryPromise, not an Effect Http pipeline; failure is a named refusal.
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeFsPromises from "node:fs/promises";

import type { Interceptor, Transport } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import {
  applyParams,
  createAuthInterceptor,
  createRegistry,
  createRequest,
  createSubstream,
  streamBlocks,
} from "@substreams/core";
import type { BlockScopedData, Package, Request, Response } from "@substreams/core/proto";

import type { SubstreamsPoolEventInput } from "./SubstreamsSourceStore.ts";
import {
  SubstreamsStreamClient,
  type SubstreamsStreamClientShape,
  type SubstreamsStreamMessageBlock,
  type SubstreamsStreamRequest,
} from "./SubstreamsIngestion.ts";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** The default production endpoint (scheme required by connect transports). */
export const SUBSTREAMS_DEFAULT_ENDPOINT = "https://mainnet.eth.streamingfast.io:443";

/** The default env var name holding the provider token. */
export const SUBSTREAMS_DEFAULT_TOKEN_ENV_NAME = "SUBSTREAMS_API_TOKEN";

/** Byte cap for the loaded .spkg (local file or https fetch). */
export const SUBSTREAMS_MAX_PACKAGE_BYTES = 64 * 1024 * 1024;

/** connect wire cap for any single response message. */
export const SUBSTREAMS_READ_MAX_BYTES = 32 * 1024 * 1024;

/** The output type this client decodes (frozen PoolBlocks schema v1). */
const POOL_BLOCKS_TYPE_NAME = "t3trade.pool.v1.PoolBlocks";

export interface SubstreamsProviderClientSettings {
  readonly defaultEndpoint: string;
  readonly defaultTokenEnvName: string;
  readonly maxPackageBytes: number;
  readonly readMaxBytes: number;
}

export const defaultSubstreamsProviderClientSettings = (): SubstreamsProviderClientSettings => ({
  defaultEndpoint: SUBSTREAMS_DEFAULT_ENDPOINT,
  defaultTokenEnvName: SUBSTREAMS_DEFAULT_TOKEN_ENV_NAME,
  maxPackageBytes: SUBSTREAMS_MAX_PACKAGE_BYTES,
  readMaxBytes: SUBSTREAMS_READ_MAX_BYTES,
});

/** What the client asks a transport factory to build. The production factory
 *  is connect-node's `createConnectTransport`; tests substitute a fake. */
export interface SubstreamsTransportOptions {
  readonly baseUrl: string;
  readonly httpVersion: "2";
  readonly readMaxBytes: number;
  readonly interceptors: ReadonlyArray<Interceptor>;
}

export type SubstreamsTransportFactory = (options: SubstreamsTransportOptions) => Transport;

const connectNodeTransportFactory: SubstreamsTransportFactory = (options) =>
  createConnectTransport({
    baseUrl: options.baseUrl,
    httpVersion: options.httpVersion,
    readMaxBytes: options.readMaxBytes,
    interceptors: [...options.interceptors],
  });

// ---------------------------------------------------------------------------
// Pure mapping helpers (reason strings, never throws)
// ---------------------------------------------------------------------------

const HEX_64_PATTERN = /^[0-9a-fA-F]{64}$/;

/** Normalize a provider block id (0x-prefixed or bare) to 0x-prefixed lowercase. */
const normalizeBlockHash = (id: string): string | null => {
  const bare = id.startsWith("0x") ? id.slice(2) : id;
  return HEX_64_PATTERN.test(bare) ? `0x${bare.toLowerCase()}` : null;
};

/** Clock timestamp (seconds bigint + nanos) → ms, or null when out of range.
 *  Structural on purpose: the provider's Timestamp arrives through
 *  @substreams/core's declaration view, which differs from the local one. */
const clockTimestampMs = (
  timestamp: { readonly seconds: bigint; readonly nanos: number } | undefined,
): number | null => {
  if (timestamp === undefined) return null;
  const { seconds, nanos } = timestamp;
  if (nanos < 0 || nanos > 999_999_999) return null;
  const ms = Number(seconds) * 1000 + Math.floor(nanos / 1_000_000);
  return seconds >= 0n && Number.isSafeInteger(ms) && ms > 0 ? ms : null;
};

const readString = (container: Record<string, unknown>, key: string): string | null => {
  const value = container[key];
  return typeof value === "string" ? value : null;
};

/** Narrow one dynamically decoded SwapEvent into the normalized input. */
const decodePoolEvent = (value: unknown): SubstreamsPoolEventInput | string => {
  if (typeof value !== "object" || value === null) return "swap event is not an object";
  const record = value as Record<string, unknown>;
  const transactionHash = readString(record, "transactionHash");
  const pool = readString(record, "pool");
  const amount0Raw = readString(record, "amount0Raw");
  const amount1Raw = readString(record, "amount1Raw");
  const sqrtPriceX96 = readString(record, "sqrtPriceX96");
  const sender = readString(record, "sender");
  const recipient = readString(record, "recipient");
  if (
    transactionHash === null ||
    pool === null ||
    amount0Raw === null ||
    amount1Raw === null ||
    sqrtPriceX96 === null ||
    sender === null ||
    recipient === null
  ) {
    return "swap event carries a non-string field";
  }
  const logIndex = record["logIndex"];
  if (typeof logIndex !== "number" || !Number.isSafeInteger(logIndex) || logIndex < 0) {
    return "swap event logIndex is not a non-negative safe integer";
  }
  return {
    transactionHash,
    logIndex,
    pool,
    amount0Raw,
    amount1Raw,
    sqrtPriceX96,
    sender,
    recipient,
  };
};

interface DecodedPoolBlocks {
  readonly blockNumber: bigint;
  readonly blockHash: string;
  readonly blockTimestampSeconds: bigint;
  readonly events: ReadonlyArray<SubstreamsPoolEventInput>;
}

/** Narrow the dynamically decoded PoolBlocks envelope. Type checks only;
 *  field vocabularies (hex/decimal patterns) are validated by the store. */
const decodePoolBlocks = (message: unknown): DecodedPoolBlocks | string => {
  const record = message as Record<string, unknown>;
  const blockHash = readString(record, "blockHash");
  if (blockHash === null || normalizeBlockHash(blockHash) === null) {
    return "decoded pool envelope blockHash is not a 64-hex string";
  }
  const blockNumber = record["blockNumber"];
  if (typeof blockNumber !== "bigint") return "decoded pool envelope blockNumber is not a uint64";
  const blockTimestampSeconds = record["blockTimestampSeconds"];
  if (typeof blockTimestampSeconds !== "bigint") {
    return "decoded pool envelope blockTimestampSeconds is not a uint64";
  }
  const eventsValue = record["events"];
  if (!Array.isArray(eventsValue)) return "decoded pool envelope events is not an array";
  const events: Array<SubstreamsPoolEventInput> = [];
  for (const entry of eventsValue) {
    const decoded = decodePoolEvent(entry);
    if (typeof decoded === "string") return decoded;
    events.push(decoded);
  }
  return {
    blockNumber,
    blockHash: normalizeBlockHash(blockHash) as string,
    blockTimestampSeconds,
    events,
  };
};

/** Map one provider blockScopedData onto the ingestion block message.
 *  `final: true` is the finalBlocksOnly request semantics documented above. */
const mapBlockScopedData = (
  scoped: BlockScopedData,
  registry: ReturnType<typeof createRegistry>,
): SubstreamsStreamMessageBlock | string => {
  const clock = scoped.clock;
  if (clock === undefined) return "block scoped data arrived without a clock";
  if (scoped.cursor === "") return "block scoped data arrived without a cursor";
  const blockHash = normalizeBlockHash(clock.id);
  if (blockHash === null) return `block clock id is not a 64-hex hash`;
  const timestampMs = clockTimestampMs(clock.timestamp);
  if (timestampMs === null) return "block clock timestamp is missing or out of range";
  const mapOutput = scoped.output?.mapOutput;
  if (mapOutput === undefined) return "block scoped data arrived without module output";
  // The Any's typeUrl is the authoritative output type (dynamic registry
  // messages do not carry a readable $typeName).
  if (
    mapOutput.typeUrl !== POOL_BLOCKS_TYPE_NAME &&
    !mapOutput.typeUrl.endsWith(`/${POOL_BLOCKS_TYPE_NAME}`)
  ) {
    return `unexpected module output type ${mapOutput.typeUrl}, expected ${POOL_BLOCKS_TYPE_NAME}`;
  }
  const unpacked = mapOutput.unpack(registry);
  if (unpacked === undefined) {
    return `module output type ${mapOutput.typeUrl} is not registered by the package`;
  }
  const decoded = decodePoolBlocks(unpacked);
  if (typeof decoded === "string") return decoded;
  if (decoded.blockNumber !== clock.number) {
    return `decoded block number ${decoded.blockNumber} disagrees with the clock number ${clock.number}`;
  }
  if (decoded.blockHash !== blockHash) {
    return "decoded block hash disagrees with the clock id";
  }
  if (clock.timestamp !== undefined && decoded.blockTimestampSeconds !== clock.timestamp.seconds) {
    return `decoded block timestamp ${decoded.blockTimestampSeconds} disagrees with the clock timestamp ${clock.timestamp.seconds}`;
  }
  return {
    type: "block",
    cursor: scoped.cursor,
    final: true,
    blockNumber: String(clock.number),
    blockHash,
    timestampMs,
    events: decoded.events,
  };
};

// ---------------------------------------------------------------------------
// Package loading and provider-request preparation
// ---------------------------------------------------------------------------

const loadPackage = (packageRef: string, maxBytes: number): Effect.Effect<Package, string> =>
  Effect.tryPromise({
    try: async () => {
      const bytes = packageRef.startsWith("https://")
        ? await (async () => {
            const response = await fetch(packageRef);
            if (!response.ok) {
              throw new Error(`fetching the substreams package answered HTTP ${response.status}`);
            }
            return new Uint8Array(await response.arrayBuffer());
          })()
        : new Uint8Array(await NodeFsPromises.readFile(packageRef));
      if (bytes.byteLength > maxBytes) {
        throw new Error(
          `the substreams package is ${bytes.byteLength} bytes, over the ${maxBytes}-byte cap`,
        );
      }
      return createSubstream(bytes);
    },
    catch: (cause) =>
      `loading the substreams package failed: ${cause instanceof Error ? cause.message : String(cause)}`,
  });

const DECIMAL_PATTERN = /^(0|[1-9][0-9]{0,19})$/;

/** Resolve the endpoint: config default when empty, https only (the bearer
 *  token never rides plain http). Pure, total. */
const resolveEndpoint = (
  endpoint: string,
  fallback: string,
): { ok: true; url: URL } | { ok: false; reason: string } => {
  const value = endpoint.trim() === "" ? fallback : endpoint.trim();
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") {
      return { ok: false, reason: `refusing non-https substreams endpoint ${url.protocol}//` };
    }
    return { ok: true, url };
  } catch {
    return { ok: false, reason: `the substreams endpoint "${value}" does not parse` };
  }
};

/** Apply module params and build the provider Request. Returns a reason on
 *  any refusal (bad start block, unknown module, params shape). */
const prepareProviderRequest = (
  request: SubstreamsStreamRequest,
  pkg: Package,
): { ok: true; request: Request } | { ok: false; reason: string } => {
  try {
    if (request.params.trim() !== "") {
      const modules = pkg.modules?.modules;
      if (modules === undefined) {
        return { ok: false, reason: "the substreams package declares no modules to parameterize" };
      }
      applyParams([`${request.moduleName}=${request.params}`], modules);
    }
    if (
      request.startCursor === null &&
      request.startBlock !== null &&
      !DECIMAL_PATTERN.test(request.startBlock)
    ) {
      return { ok: false, reason: "startBlock is not a decimal uint64 string" };
    }
    // A committed cursor always wins; without one the start block seeds the
    // first run; with neither, the module's own initial block applies.
    const startBlockNum =
      request.startCursor !== null
        ? undefined
        : request.startBlock !== null
          ? BigInt(request.startBlock)
          : undefined;
    return {
      ok: true,
      request: createRequest({
        substreamPackage: pkg,
        outputModule: request.moduleName,
        productionMode: request.productionMode,
        finalBlocksOnly: true,
        startCursor: request.startCursor ?? undefined,
        startBlockNum,
      }),
    };
  } catch (cause) {
    return {
      ok: false,
      reason: `building the provider request failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
};

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

export const makeSubstreamsProviderClient = (
  settings: Partial<SubstreamsProviderClientSettings> = {},
  createTransport: SubstreamsTransportFactory = connectNodeTransportFactory,
): SubstreamsStreamClientShape => {
  const config = { ...defaultSubstreamsProviderClientSettings(), ...settings };

  const consume: SubstreamsStreamClientShape["consume"] = ({ request, sink }) => {
    const controller = new AbortController();
    let streamIterator: AsyncIterator<Response> | undefined;
    return Effect.gen(function* () {
      // --- endpoint: config default, https only (the bearer never rides http)
      const resolvedEndpoint = resolveEndpoint(request.endpoint, config.defaultEndpoint);
      if (!resolvedEndpoint.ok) {
        return yield* Effect.fail(resolvedEndpoint.reason);
      }
      const baseUrl = resolvedEndpoint.url;

      // --- token: read by name, used once, never surfaced
      const tokenEnvName = request.tokenEnvName ?? config.defaultTokenEnvName;
      const token = process.env[tokenEnvName]?.trim() ?? "";
      if (token === "") {
        return yield* Effect.fail(
          `the substreams provider token is not set (environment variable ${tokenEnvName} is empty or unset)`,
        );
      }
      const redact = (message: string): string => message.split(token).join("[redacted]");

      // --- package: local file or https, byte-capped
      const pkg = yield* loadPackage(request.packageRef, config.maxPackageBytes).pipe(
        Effect.mapError(redact),
      );

      // --- provider request: params applied, final blocks only, resume cursor
      const prepared = prepareProviderRequest(request, pkg);
      if (!prepared.ok) {
        return yield* Effect.fail(redact(prepared.reason));
      }

      const registry = createRegistry(pkg);
      // One documented dual-declaration bridge (see the streamBlocks note below).
      const authInterceptor = createAuthInterceptor(token) as unknown as Interceptor;
      const transport = createTransport({
        baseUrl: baseUrl.toString(),
        httpVersion: "2",
        readMaxBytes: config.readMaxBytes,
        interceptors: [authInterceptor],
      });

      // @bufbuild/protobuf ships dual package declarations; @substreams/core's
      // declarations resolve the CJS view while this module's imports resolve
      // the ESM view, so the identical runtime Transport needs one type-level
      // bridge at the seam. Types only — a single implementation exists.
      const iterator = streamBlocks(
        transport as unknown as Parameters<typeof streamBlocks>[0],
        prepared.request,
        { signal: controller.signal },
      )[Symbol.asyncIterator]();
      streamIterator = iterator;

      for (;;) {
        const step = yield* Effect.tryPromise({
          try: () => iterator.next(),
          catch: (cause) =>
            redact(
              `the substreams stream failed: ${cause instanceof Error ? cause.message : String(cause)}`,
            ),
        });
        if (step.done === true) return;
        const response = step.value;
        switch (response.message.case) {
          case "blockScopedData": {
            const mapped = mapBlockScopedData(response.message.value, registry);
            if (typeof mapped === "string") {
              return yield* Effect.fail(redact(mapped));
            }
            yield* sink.onBlock(mapped);
            break;
          }
          case "blockUndoSignal": {
            yield* sink.onUndo({ lastValidCursor: response.message.value.lastValidCursor });
            break;
          }
          case "fatalError": {
            const failure = response.message.value;
            const logs = failure.logs.join(" | ").slice(0, 2000);
            return yield* Effect.fail(
              redact(
                `the provider reported a fatal error (module ${failure.module}): ${failure.reason}${logs === "" ? "" : `; logs: ${logs}`}`,
              ),
            );
          }
          default:
            // session init and module progress are stream bookkeeping.
            break;
        }
      }
    }).pipe(
      // Clean cancellation and one-connection-per-consume: abort the wire
      // stream and await the iterator's close on EVERY exit path.
      Effect.onExit(() =>
        Effect.promise(async () => {
          controller.abort();
          const done = streamIterator?.return?.();
          if (done !== undefined) await Promise.resolve(done).catch(() => undefined);
        }),
      ),
    );
  };

  return { consume };
};

export const SubstreamsProviderClientLive = Layer.succeed(
  SubstreamsStreamClient,
  makeSubstreamsProviderClient(),
);
