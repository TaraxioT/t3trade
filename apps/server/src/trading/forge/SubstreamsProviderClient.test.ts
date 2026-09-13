/**
 * SubstreamsProviderClient — tested against a scripted fake transport (the
 * real provider credential is blocked; a The Graph Market key via
 * `substreams auth` is the known unblock — see worker-a-progress.md).
 *
 * The fake factory receives exactly what the client would hand connect-node
 * and composes the client's interceptors itself, so the tests observe the
 * true wire request: the Authorization bearer header, the
 * `final_blocks_only`/`production_mode` request fields, the resume cursor,
 * the applied module params, and the module output decode path — exercised
 * against the REAL pinned .spkg registry (dynamic t3trade.pool.v1
 * PoolBlocks decode), not a hand-rolled type.
 *
 * The .spkg binary is a hard fixture: these tests fail loudly when it is
 * absent (rebuild per infra/substreams/pool-observations/README.md; the
 * pinned SHA-256 2ce1aac8…ae3f is the identity either way).
 */
// @effect-diagnostics nodeBuiltinImport:off - the pinned .spkg binary is a read-once fixture; a sync fs read in a test is the fixture load, not host I/O under design rules.
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  Any,
  Timestamp,
  type MethodInfo,
  type MessageType,
  type Message,
  type PartialMessage,
  type ServiceType,
} from "@bufbuild/protobuf";
import { createRegistry, createSubstream } from "@substreams/core";
import {
  BlockScopedData,
  BlockUndoSignal,
  Clock,
  ModulesProgress,
  Request,
  Response,
  SessionInit,
} from "@substreams/core/proto";
import type { Interceptor, StreamRequest, StreamResponse, Transport } from "@connectrpc/connect";

import {
  SUBSTREAMS_DEFAULT_ENDPOINT,
  makeSubstreamsProviderClient,
  type SubstreamsTransportFactory,
} from "./SubstreamsProviderClient.ts";
import type {
  SubstreamsSinkFailure,
  SubstreamsStreamMessageBlock,
  SubstreamsStreamRequest,
  SubstreamsStreamSink,
} from "./SubstreamsIngestion.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SPKG_PATH = fileURLToPath(
  new URL(
    "../../../../../infra/substreams/pool-observations/t3trade-pool-observations-v0.1.0.spkg",
    import.meta.url,
  ),
);
const SPKG_SHA256 = "2ce1aac8fd8debb67ddbdb87b56ff15395605b9e0b192dd796cac874b721ae3f";

const TOKEN_ENV = "T3_TEST_SUBSTREAMS_TOKEN";
const TOKEN_VALUE = "test-provider-token-9f2c";
const MODULE_NAME = "map_pool_blocks";
const POOL = "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640";
const BLOCK_HASH = "0x" + "ab".repeat(32);
const BLOCK_NUMBER = 12_369_625n;
const TIMESTAMP_SECONDS = 1_730_000_000n;
const TIMESTAMP_MS = 1_730_000_000_250;

/** The loaded real package, its registry, and the dynamic PoolBlocks type. */
const loadSpkgFixtures = () => {
  if (!existsSync(SPKG_PATH)) {
    throw new Error(
      `the pinned substreams package is missing at ${SPKG_PATH}; rebuild it (cd infra/substreams/pool-observations && substreams build) or restore the binary pinned at sha256 ${SPKG_SHA256}`,
    );
  }
  const pkg = createSubstream(new Uint8Array(readFileSync(SPKG_PATH)));
  const registry = createRegistry(pkg);
  const poolBlocksType = registry.findMessage("t3trade.pool.v1.PoolBlocks");
  assert.isDefined(poolBlocksType);
  return { pkg, registry, poolBlocksType };
};

/** Build the packed PoolBlocks output Any through the spkg's own dynamic
 *  message type (dynamic types expose fromJson*, not create(); the one cast
 *  bridges @bufbuild/protobuf's dual esm/cjs declaration views). */
const envelopeAny = (
  poolBlocksType: NonNullable<ReturnType<typeof loadSpkgFixtures>["poolBlocksType"]>,
  overrides?: { blockNumber?: bigint },
) => {
  const envelope = (poolBlocksType as unknown as MessageType).fromJsonString(
    JSON.stringify({
      schemaVersion: 1,
      chainId: "1",
      blockNumber: String(overrides?.blockNumber ?? BLOCK_NUMBER),
      blockHash: BLOCK_HASH,
      blockTimestampSeconds: String(TIMESTAMP_SECONDS),
      events: [
        {
          transactionHash: "0x" + "cd".repeat(32),
          logIndex: 3,
          pool: POOL,
          amount0Raw: "9290",
          amount1Raw: "-3677177486975",
          sqrtPriceX96: "1".repeat(30),
          sender: "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45",
          recipient: "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45",
        },
      ],
    }),
  );
  return Any.pack(envelope);
};

const blockResponse = (packed: Any, options?: { clockId?: string; clockNumber?: bigint }) =>
  new Response({
    message: {
      case: "blockScopedData",
      value: new BlockScopedData({
        clock: new Clock({
          id: options?.clockId ?? BLOCK_HASH,
          number: options?.clockNumber ?? BLOCK_NUMBER,
          timestamp: new Timestamp({ seconds: TIMESTAMP_SECONDS, nanos: 250_000_000 }),
        }),
        cursor: "cursor-1",
        output: { name: MODULE_NAME, mapOutput: packed },
      }),
    },
  });

// ---------------------------------------------------------------------------
// The scripted fake transport factory
// ---------------------------------------------------------------------------

interface CapturedCall {
  readonly headers: Headers;
  readonly request: Request;
  readonly url: string;
}

type Script = (signal: AbortSignal | undefined) => AsyncIterable<Response>;

const fakeTransportFactory = (
  script: Script,
): { factory: SubstreamsTransportFactory; calls: CapturedCall[] } => {
  const calls: CapturedCall[] = [];
  const factory: SubstreamsTransportFactory = (options) => {
    const stream: Transport["stream"] = async <I extends Message<I>, O extends Message<O>>(
      service: ServiceType,
      method: MethodInfo<I, O>,
      signal: AbortSignal | undefined,
      _timeoutMs: number | undefined,
      headerInit: Headers | undefined,
      input: AsyncIterable<PartialMessage<I>>,
      _contextValues?: unknown,
    ): Promise<StreamResponse<I, O>> => {
      // Compose the client's interceptors exactly as a connect transport
      // does, so the recorded header is the header the wire would carry.
      const finalSend = async (req: StreamRequest): Promise<StreamResponse> => {
        for await (const message of req.message as AsyncIterable<Request>) {
          calls.push({ headers: req.header, request: message, url: req.url });
          break;
        }
        return {
          stream: true,
          service,
          method,
          header: new Headers(),
          trailer: new Headers(),
          message: script(signal),
        } as unknown as StreamResponse;
      };
      let send: (req: StreamRequest) => Promise<StreamResponse> = finalSend;
      for (let i = options.interceptors.length - 1; i >= 0; i -= 1) {
        // The Interceptor type is structural; one localized cast.
        const interceptor = options.interceptors[i] as unknown as (
          next: typeof send,
        ) => typeof send;
        send = interceptor(send);
      }
      const streamRequest = {
        stream: true,
        service,
        method,
        url: options.baseUrl,
        init: {},
        signal: signal ?? new AbortController().signal,
        header: headerInit ?? new Headers(),
        contextValues: undefined,
        message: input as unknown as AsyncIterable<Request>,
      } as unknown as StreamRequest;
      return (await send(streamRequest)) as unknown as StreamResponse<I, O>;
    };
    return {
      unary: () => Promise.reject(new Error("the substreams client never issues unary calls")),
      stream,
    };
  };
  return { factory, calls };
};

const recordingSink = () => {
  const blocks: Array<SubstreamsStreamMessageBlock> = [];
  const undos: Array<string> = [];
  const sink: SubstreamsStreamSink = {
    onBlock: (message) => Effect.sync(() => void blocks.push(message)),
    onUndo: ({ lastValidCursor }) => Effect.sync(() => void undos.push(lastValidCursor)),
  };
  return { sink, blocks, undos };
};

const baseRequest = (overrides?: Partial<SubstreamsStreamRequest>): SubstreamsStreamRequest => ({
  packageRef: SPKG_PATH,
  network: "mainnet",
  moduleName: MODULE_NAME,
  params: POOL,
  startCursor: null,
  startBlock: "12369625",
  endpoint: "https://mainnet.eth.streamingfast.io:443",
  tokenEnvName: TOKEN_ENV,
  productionMode: false,
  ...overrides,
});

const withTokenEnv = (value: string | undefined): (() => void) => {
  const had = Object.prototype.hasOwnProperty.call(process.env, TOKEN_ENV);
  const previous = process.env[TOKEN_ENV];
  if (value === undefined) delete process.env[TOKEN_ENV];
  else process.env[TOKEN_ENV] = value;
  return () => {
    if (!had) delete process.env[TOKEN_ENV];
    else process.env[TOKEN_ENV] = previous;
  };
};

/** Run a test body with the token env set; restored on every exit path. */
const withToken = <A, E>(value: string | undefined, body: () => Effect.Effect<A, E>) => {
  const restore = withTokenEnv(value);
  return body().pipe(Effect.onExit(() => Effect.sync(restore)));
};

// ---------------------------------------------------------------------------
// Request semantics and mapping
// ---------------------------------------------------------------------------

it.effect(
  "maps blockScopedData onto the sink, decoding the spkg output through its own registry",
  () =>
    withToken(TOKEN_VALUE, () =>
      Effect.gen(function* () {
        const { poolBlocksType } = loadSpkgFixtures();
        const script: Script = async function* () {
          // session and progress are bookkeeping and must be ignored.
          yield new Response({
            message: { case: "session", value: new SessionInit({ traceId: "t" }) },
          });
          yield new Response({ message: { case: "progress", value: new ModulesProgress() } });
          yield blockResponse(envelopeAny(poolBlocksType), { clockId: BLOCK_HASH.slice(2) });
        };
        const { factory } = fakeTransportFactory(script);
        const client = makeSubstreamsProviderClient({}, factory);
        const { sink, blocks, undos } = recordingSink();
        yield* client.consume({ request: baseRequest(), sink });
        assert.strictEqual(blocks.length, 1);
        assert.strictEqual(undos.length, 0);
        const block = blocks[0]!;
        assert.strictEqual(block.type, "block");
        assert.strictEqual(block.final, true);
        assert.strictEqual(block.blockNumber, "12369625");
        // The bare-hex clock id normalized to the 0x-prefixed lowercase form.
        assert.strictEqual(block.blockHash, BLOCK_HASH);
        assert.strictEqual(block.timestampMs, TIMESTAMP_MS);
        assert.strictEqual(block.cursor, "cursor-1");
        assert.deepStrictEqual(block.events, [
          {
            transactionHash: "0x" + "cd".repeat(32),
            logIndex: 3,
            pool: POOL,
            amount0Raw: "9290",
            amount1Raw: "-3677177486975",
            sqrtPriceX96: "1".repeat(30),
            sender: "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45",
            recipient: "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45",
          },
        ]);
      }),
    ),
);

it.effect(
  "requests final blocks only, passes productionMode through, applies params, and sends the bearer token",
  () =>
    withToken(TOKEN_VALUE, () =>
      Effect.gen(function* () {
        const { poolBlocksType } = loadSpkgFixtures();
        const script: Script = async function* () {
          yield blockResponse(envelopeAny(poolBlocksType));
        };
        const first = fakeTransportFactory(script);
        const client = makeSubstreamsProviderClient({}, first.factory);
        const { sink } = recordingSink();
        yield* client.consume({ request: baseRequest(), sink });
        assert.strictEqual(first.calls.length, 1);
        const call = first.calls[0]!;
        // URL normalizes the :443 default port away — same server.
        assert.strictEqual(call.url, "https://mainnet.eth.streamingfast.io/");
        assert.strictEqual(call.headers.get("Authorization"), `Bearer ${TOKEN_VALUE}`);
        assert.strictEqual(call.request.finalBlocksOnly, true);
        assert.strictEqual(call.request.productionMode, false);
        assert.strictEqual(call.request.outputModule, MODULE_NAME);
        assert.strictEqual(call.request.startCursor, "");
        assert.strictEqual(call.request.startBlockNum, BLOCK_NUMBER);
        const module = call.request.modules?.modules.find((entry) => entry.name === MODULE_NAME);
        assert.isDefined(module);
        const input = module!.inputs[0]?.input;
        assert.strictEqual(input?.case, "params");
        if (input?.case === "params") assert.strictEqual(input.value.value, POOL);

        // The same client with a resume cursor and production mode.
        const second = fakeTransportFactory(script);
        const client2 = makeSubstreamsProviderClient({}, second.factory);
        yield* client2.consume({
          request: baseRequest({ startCursor: "cursor-42", productionMode: true }),
          sink,
        });
        assert.strictEqual(second.calls[0]!.request.startCursor, "cursor-42");
        assert.strictEqual(second.calls[0]!.request.productionMode, true);
      }),
    ),
);

it.effect("falls back to the default endpoint when the request endpoint is empty", () =>
  withToken(TOKEN_VALUE, () =>
    Effect.gen(function* () {
      const { poolBlocksType } = loadSpkgFixtures();
      const script: Script = async function* () {
        yield blockResponse(envelopeAny(poolBlocksType));
      };
      const { factory, calls } = fakeTransportFactory(script);
      const client = makeSubstreamsProviderClient({}, factory);
      const { sink } = recordingSink();
      yield* client.consume({ request: baseRequest({ endpoint: "" }), sink });
      assert.strictEqual(calls[0]!.url, new URL(SUBSTREAMS_DEFAULT_ENDPOINT).toString());
    }),
  ),
);

it.effect("maps blockUndoSignal onto onUndo", () =>
  withToken(TOKEN_VALUE, () =>
    Effect.gen(function* () {
      const script: Script = async function* () {
        yield new Response({
          message: {
            case: "blockUndoSignal",
            value: new BlockUndoSignal({ lastValidCursor: "cursor-7" }),
          },
        });
      };
      const { factory } = fakeTransportFactory(script);
      const client = makeSubstreamsProviderClient({}, factory);
      const { sink, blocks, undos } = recordingSink();
      yield* client.consume({ request: baseRequest(), sink });
      assert.deepStrictEqual(undos, ["cursor-7"]);
      assert.strictEqual(blocks.length, 0);
    }),
  ),
);

it.effect("propagates sink refusals unchanged", () =>
  withToken(TOKEN_VALUE, () =>
    Effect.gen(function* () {
      const { poolBlocksType } = loadSpkgFixtures();
      const refusal: SubstreamsSinkFailure = { kind: "non_final_block", reason: "scripted" };
      const script: Script = async function* () {
        yield blockResponse(envelopeAny(poolBlocksType));
      };
      const { factory } = fakeTransportFactory(script);
      const client = makeSubstreamsProviderClient({}, factory);
      const failure = yield* Effect.flip(
        client.consume({
          request: baseRequest(),
          sink: { onBlock: () => Effect.fail(refusal), onUndo: () => Effect.fail(refusal) },
        }),
      );
      assert.strictEqual(failure, refusal);
    }),
  ),
);

it.effect("refuses a block whose decoded envelope disagrees with the provider clock", () =>
  withToken(TOKEN_VALUE, () =>
    Effect.gen(function* () {
      const { poolBlocksType } = loadSpkgFixtures();
      const script: Script = async function* () {
        yield blockResponse(envelopeAny(poolBlocksType, { blockNumber: BLOCK_NUMBER + 1n }));
      };
      const { factory } = fakeTransportFactory(script);
      const client = makeSubstreamsProviderClient({}, factory);
      const { sink, blocks } = recordingSink();
      const failure = yield* Effect.flip(client.consume({ request: baseRequest(), sink }));
      assert.include(String(failure), "disagrees with the clock number");
      assert.strictEqual(blocks.length, 0);
    }),
  ),
);

it.effect("maps a provider fatal error to a redacted failure reason", () =>
  withToken(TOKEN_VALUE, () =>
    Effect.gen(function* () {
      const script: Script = async function* () {
        yield new Response({
          message: {
            case: "fatalError",
            value: {
              module: MODULE_NAME,
              reason: `token ${TOKEN_VALUE} rejected`,
              logs: ["log-one"],
              logsTruncated: false,
            },
          },
        });
      };
      const { factory } = fakeTransportFactory(script);
      const client = makeSubstreamsProviderClient({}, factory);
      const { sink } = recordingSink();
      const failure = yield* Effect.flip(client.consume({ request: baseRequest(), sink }));
      const reason = String(failure);
      assert.include(reason, "fatal error");
      assert.include(reason, "[redacted]");
      assert.isFalse(reason.includes(TOKEN_VALUE));
    }),
  ),
);

// ---------------------------------------------------------------------------
// Fail-closed configuration paths
// ---------------------------------------------------------------------------

it.effect("refuses when the token env var is unset and names the variable, never a value", () =>
  withToken(undefined, () =>
    Effect.gen(function* () {
      const { factory } = fakeTransportFactory(async function* () {});
      const client = makeSubstreamsProviderClient({}, factory);
      const { sink } = recordingSink();
      const failure = yield* Effect.flip(
        client.consume({ request: baseRequest({ packageRef: "/nonexistent/spkg" }), sink }),
      );
      assert.include(String(failure), TOKEN_ENV);
    }),
  ),
);

it.effect("refuses a non-https endpoint", () =>
  withToken(TOKEN_VALUE, () =>
    Effect.gen(function* () {
      const { factory } = fakeTransportFactory(async function* () {});
      const client = makeSubstreamsProviderClient({}, factory);
      const { sink } = recordingSink();
      const failure = yield* Effect.flip(
        client.consume({
          request: baseRequest({ endpoint: "http://mainnet.eth.streamingfast.io:443" }),
          sink,
        }),
      );
      assert.include(String(failure), "non-https");
    }),
  ),
);

it.effect("refuses a packageRef that does not resolve", () =>
  withToken(TOKEN_VALUE, () =>
    Effect.gen(function* () {
      const { factory } = fakeTransportFactory(async function* () {});
      const client = makeSubstreamsProviderClient({}, factory);
      const { sink } = recordingSink();
      const failure = yield* Effect.flip(
        client.consume({ request: baseRequest({ packageRef: "/nonexistent/spkg.spkg" }), sink }),
      );
      assert.include(String(failure), "loading the substreams package failed");
    }),
  ),
);

it.effect("refuses a startBlock that is not a decimal uint64 string", () =>
  withToken(TOKEN_VALUE, () =>
    Effect.gen(function* () {
      const { factory } = fakeTransportFactory(async function* () {});
      const client = makeSubstreamsProviderClient({}, factory);
      const { sink } = recordingSink();
      const failure = yield* Effect.flip(
        client.consume({ request: baseRequest({ startBlock: "0x10" }), sink }),
      );
      assert.include(String(failure), "startBlock is not a decimal uint64 string");
    }),
  ),
);

// ---------------------------------------------------------------------------
// Clean cancellation
// ---------------------------------------------------------------------------

it.effect("closes the provider stream cleanly when interrupted", () =>
  withToken(TOKEN_VALUE, () =>
    Effect.gen(function* () {
      let generatorClosed = false;
      let started: () => void = () => undefined;
      const startedPromise = new Promise<void>((resolve) => {
        started = resolve;
      });
      const script: Script = async function* (signal) {
        try {
          yield new Response({
            message: { case: "session", value: new SessionInit({ traceId: "t" }) },
          });
          started();
          // Hang until the client's abort signal fires.
          await new Promise<never>((_, reject) => {
            if (signal?.aborted) reject(new Error("aborted"));
            else
              signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
        } finally {
          generatorClosed = true;
        }
      };
      const { factory } = fakeTransportFactory(script);
      const client = makeSubstreamsProviderClient({}, factory);
      const { sink } = recordingSink();
      const fiber = yield* Effect.forkChild(client.consume({ request: baseRequest(), sink }));
      yield* Effect.promise(() => startedPromise);
      yield* Fiber.interrupt(fiber);
      const exit = yield* Fiber.await(fiber);
      assert.isTrue(Exit.isFailure(exit) && Exit.hasInterrupts(exit));
      assert.strictEqual(generatorClosed, true);
    }),
  ),
);
