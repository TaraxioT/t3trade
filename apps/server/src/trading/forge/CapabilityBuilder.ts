/**
 * CapabilityBuilder — the host's orchestration of a capability an in-app
 * agent authors.
 *
 * The flow is deliberately split so the AGENT does the writing and the HOST
 * does everything that grants anything:
 *
 *   prepare → the host inspects sources and hands back an authoring brief
 *             (the typed SDK contract, the data schema, the staging
 *             directory). No detector semantics ship in the brief.
 *   the agent writes the four artifacts with its own file tools, in its own
 *             workspace — there is no hidden finished detector here.
 *   check   → the host reads the staged files (exactly four, flat, regular,
 *             bounded), compiles and typechecks them, runs the generated
 *             tests, then runs host-owned acceptance cases and determinism
 *             checks — all inside the sealed sandbox — and computes the
 *             sealed report and every hash itself.
 *   install → a separate CAS step in the store (never part of check).
 *
 * A "pass" string from inside the container grants nothing: the host reads
 * structured results, compares readings itself, and hashes the exact bytes it
 * tested.
 *
 * @module CapabilityBuilder
 */
// @effect-diagnostics nodeBuiltinImport:off - reads the authoring workspace from the real filesystem: readdir/lstat are the validation being performed.
// @effect-diagnostics globalDate:off globalDateInEffect:off - version creation timestamps are wall-clock instants persisted as data.
// @effect-diagnostics preferSchemaOverJson:off - the four artifacts are foreign files; JSON.parse feeds schemas, it is not the validation itself.
// @effect-diagnostics tryCatchInEffectGen:off - workspace reads and staging refusals are host verdicts; try/catch states the refusal exactly.
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Schema } from "effect";
import * as Layer from "effect/Layer";
import * as NodeFs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import * as NodePath from "node:path";
import { randomUUID } from "node:crypto";

import {
  FORGE_CAPABILITY_ARTIFACT_PATHS,
  FORGE_MAX_BUNDLE_BYTES,
  FORGE_MAX_SEMANTICS_CHARS,
  FORGE_SDK_SCHEMA_VERSION,
  ForgeCapabilityManifest,
  ForgeSignalOutput,
  type ForgeAcceptanceCase,
  type ForgeBuildReceipt,
  type ForgeCapabilityVersion,
  type ForgeCheckOutcome,
  type ForgeSignalInput,
  type ForgeSignalReading,
} from "@t3tools/trading-contracts";

import {
  forgeSha256Hex,
  ForgeCapabilitySandbox,
  ForgeSandboxError,
  type ForgeCapabilitySandboxShape,
  type ForgeSandboxFile,
} from "./CapabilitySandbox.ts";
import { ForgeCapabilityStore, type ForgeCapabilityStoreShape } from "./CapabilityStore.ts";

// ---------------------------------------------------------------------------
// The typed SDK the artifacts import — host-owned, semantics-free
// ---------------------------------------------------------------------------

/**
 * The SDK source mounted beside the artifacts in containment as `sdk.ts`.
 *
 * Types, bounded decode helpers, and the entry signature ONLY. There is no
 * aggregation, no thresholds, no coordination branch — a detector is whatever
 * the authored `signal.ts` makes of these types. Changing this contract is a
 * schema-version bump, never an in-place edit.
 */
export const FORGE_SDK_SOURCE = `/**
 * T3 Forge capability SDK — schema version ${FORGE_SDK_SCHEMA_VERSION}.
 * Host-owned contract; a capability imports nothing else.
 */
export type SourceEvidence = {
  readonly mode: "live" | "historical";
  readonly provider: "the-graph";
  readonly deploymentId: string;
  readonly blockNumber: string;
  readonly blockHash: string;
  readonly fetchedAtMs: number;
  readonly windowEndMs: number;
  readonly querySha256: string;
  readonly responseSha256: string;
  readonly complete: boolean;
};

export type PoolAnchor = {
  readonly observationId: string;
  readonly priceQuotePerBaseMicros: number;
  readonly ageBeforeWindowSeconds: number;
};

export type SourceTrade = {
  readonly observationId: string;
  readonly transactionHash: string;
  readonly timestamp: number;
  readonly logIndex: number;
  readonly priceQuotePerBaseMicros: number;
  readonly quoteVolumeMicros: number;
  readonly quoteVolumeRaw: string;
  readonly amount0: string;
  readonly amount1: string;
};

export type PoolWindow = {
  readonly poolId: string;
  readonly moveBps: number | null;
  readonly observations?: ReadonlyArray<SourceTrade>;
  readonly anchorCandidates?: ReadonlyArray<SourceTrade>;
  readonly quoteVolumeMicros: string;
  readonly tradeCount: number;
  readonly observationIds: ReadonlyArray<string>;
  readonly anchor?: PoolAnchor;
};

export type SignalInput = {
  readonly evidence: SourceEvidence;
  readonly pools: ReadonlyArray<PoolWindow>;
};

export type Regime = "coordinated" | "isolated" | "quiet";

export type SignalReading =
  | { readonly kind: "ready"; readonly regime: Regime; readonly agreement: number; readonly eligiblePoolIds: ReadonlyArray<string> }
  | { readonly kind: "insufficient"; readonly reason: string };

export type PoolDiagnostics = {
  readonly poolId: string;
  readonly qualifyingCount: number;
  readonly excludedCount: number;
  readonly quoteVolumeMicros: string;
  readonly anchorObservationId?: string;
  readonly tradeIds: ReadonlyArray<string>;
};

export type SignalOutput = {
  readonly reading: SignalReading;
  readonly diagnostics: ReadonlyArray<PoolDiagnostics>;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Minimal structural check of one input window; exactness is the host's. */
export function assertSignalInput(value: unknown): asserts value is SignalInput {
  if (!isPlainObject(value) || !isPlainObject(value.evidence) || !Array.isArray(value.pools)) {
    throw new Error("SignalInput must be { evidence, pools[] }");
  }
}

const registeredTests: Array<() => void | Promise<void>> = [];
export function describe(_name: string, body: () => void): void { body(); }
export function test(_name: string, body: () => void | Promise<void>): void { registeredTests.push(body); }
export const it = test;
export function expect(actual: unknown) {
  return {
    toBe(expected: unknown): void { if (!Object.is(actual, expected)) throw new Error("values differ"); },
    toEqual(expected: unknown): void { if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("values differ"); },
    toBeDefined(): void { if (actual === undefined) throw new Error("value is undefined"); },
    toBeTruthy(): void { if (!actual) throw new Error("value is not truthy"); },
    toBeFalsy(): void { if (actual) throw new Error("value is not falsy"); },
  };
}
export async function runRegisteredTests(): Promise<number> {
  for (const body of registeredTests) await body();
  return registeredTests.length;
}

/** The entrypoint every capability exports. Pure: same input, same output. */
export type ReadSignal = (input: SignalInput) => SignalOutput;
`;

/** The data schema context handed to the authoring brief, rendered once. */
export const FORGE_DATA_SCHEMA_CONTEXT = [
  "Forge observation data schema (host-normalized, exact):",
  "- Every observation is one mainnet Uniswap v3 WETH/USDC swap: chain (ethereum-mainnet), poolId,",
  "  observationId ('txHash:logIndex'), transactionHash, logIndex, timestamp (unix seconds), sender,",
  "  recipient, amount0/amount1 (signed decimal integer strings, raw units), sqrtPriceX96 (decimal",
  "  integer string), tick, baseIsToken1, priceQuotePerBase (exact rational {numerator, denominator}),",
  "  priceQuotePerBaseMicros (integer, 1e6 scale), quoteVolumeRaw / quoteVolumeMicros (absolute USDC leg).",
  "- The host aggregates each pool window into PoolWindow: moveBps (integer basis points vs the anchor),",
  "  quoteVolumeMicros (summed absolute USDC leg, integer micro-units), tradeCount, observationIds",
  "  (every source trade id), observations, all anchorCandidates, and the resolved pre-window anchor. Missing anchor means moveBps=null; never treat it as zero movement.",
  "- Numbers with units ride strings when exactness matters (raw/micros) and numbers when display-grade.",
  "- Your capability receives SignalInput and must return SignalOutput; diagnostics must reference only",
  "  observationIds present in the input window.",
].join("\n");

/**
 * Entrypoints — the pinned runner image's contract. Distinct heads so a
 * scripted runner (and the image itself) can never confuse one step for
 * another.
 */
export const FORGE_RUNNER_TYPECHECK = ["forge-typecheck"] as const;
export const FORGE_RUNNER_TEST = ["forge-test"] as const;
export const FORGE_RUNNER_EVALUATE = ["forge-evaluate"] as const;

// ---------------------------------------------------------------------------
// Static artifact validation (host, before anything executes)
// ---------------------------------------------------------------------------

/** Import specifiers generated TypeScript may reference. Nothing else. */
const ALLOWED_IMPORT_SPECIFIERS = new Set(["./sdk", "./signal"]);

const IMPORT_PATTERN =
  /(?:import|export)\s[^;]*?from\s*["']([^"']+)["']|require\s*\(\s*["']([^"']+)["']\s*\)|import\s*\(\s*["']([^"']+)["']\s*\)/g;

/** Every import an artifact declares — used to refuse anything outside the SDK. */
export function declaredImports(source: string): ReadonlyArray<string> {
  const found: Array<string> = [];
  for (const match of source.matchAll(IMPORT_PATTERN)) {
    const specifier = match[1] ?? match[2] ?? match[3];
    if (specifier !== undefined) found.push(specifier);
  }
  return found;
}

export interface ForgeArtifactSet {
  readonly contents: Readonly<Record<string, string>>;
}

export type ForgeArtifactValidation =
  | { readonly status: "ok"; readonly artifacts: ForgeArtifactSet }
  | { readonly status: "refused"; readonly reason: string };

/**
 * The four-artifact contract, enforced before any code runs: exactly the four
 * names, no extras, bounded size, no imports outside the typed SDK, a
 * manifest that decodes and matches the requested identity.
 */
export function validateAuthoredArtifacts(input: {
  readonly contents: Readonly<Record<string, string>>;
  readonly expectedCapabilityId: string;
  readonly expectedVersion: number;
}): ForgeArtifactValidation {
  const names = Object.keys(input.contents).sort();
  const expected = [...FORGE_CAPABILITY_ARTIFACT_PATHS].sort();
  if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) {
    return {
      status: "refused",
      reason: `the bundle must be exactly ${expected.join(", ")} — found ${names.join(", ") || "nothing"}`,
    };
  }
  const totalBytes = expected.reduce(
    (sum, path) => sum + Buffer.byteLength(input.contents[path] ?? "", "utf8"),
    0,
  );
  if (totalBytes > FORGE_MAX_BUNDLE_BYTES) {
    return {
      status: "refused",
      reason: `the four artifacts total ${totalBytes} bytes, over the ${FORGE_MAX_BUNDLE_BYTES} byte cap`,
    };
  }
  for (const path of ["signal.ts", "signal.test.ts"]) {
    if ((input.contents[path] ?? "").trim() === "") {
      return { status: "refused", reason: `${path} is empty` };
    }
    for (const specifier of declaredImports(input.contents[path] ?? "")) {
      if (!ALLOWED_IMPORT_SPECIFIERS.has(specifier)) {
        return {
          status: "refused",
          reason: `${path} imports ${JSON.stringify(specifier)}; only the typed SDK (./sdk, ./signal) is allowed`,
        };
      }
    }
  }
  if (!/\bquery\b/.test(input.contents["query.graphql"] ?? "")) {
    return { status: "refused", reason: "query.graphql does not define a query" };
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(input.contents["manifest.json"] ?? "");
  } catch {
    return { status: "refused", reason: "manifest.json is not valid JSON" };
  }
  try {
    const parsed = Schema.decodeUnknownSync(ForgeCapabilityManifest)(manifest);
    if (parsed.capabilityId !== input.expectedCapabilityId) {
      return {
        status: "refused",
        reason: `manifest names capability ${parsed.capabilityId}, the build is for ${input.expectedCapabilityId}`,
      };
    }
    if (parsed.version !== input.expectedVersion) {
      return {
        status: "refused",
        reason: `manifest declares v${parsed.version}, the build is for v${input.expectedVersion}`,
      };
    }
  } catch (error) {
    return {
      status: "refused",
      reason: `manifest.json does not satisfy the contract: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return { status: "ok", artifacts: { contents: input.contents } };
}

/**
 * Read the authoring workspace: exactly the four flat files, all regular
 * files (a symlink is a refusal, not a shortcut), nothing else alongside.
 */
export const readAuthoringWorkspace = async (
  stagingDir: string,
): Promise<Record<string, string>> => {
  if ((await NodeFs.lstat(stagingDir)).isSymbolicLink())
    throw new Error("refusing a symlink authoring workspace");
  const entries = await NodeFs.readdir(stagingDir, { withFileTypes: true });
  let totalBytes = 0;
  const contents: Record<string, string> = {};
  for (const entry of entries) {
    if (
      !FORGE_CAPABILITY_ARTIFACT_PATHS.includes(
        entry.name as (typeof FORGE_CAPABILITY_ARTIFACT_PATHS)[number],
      )
    ) {
      throw new Error(`unexpected file in the authoring workspace: ${entry.name}`);
    }
    if (entry.isSymbolicLink()) {
      throw new Error(`refusing symlink in the authoring workspace: ${entry.name}`);
    }
    if (!entry.isFile()) {
      throw new Error(`refusing non-file entry in the authoring workspace: ${entry.name}`);
    }
    const resolved = NodePath.resolve(stagingDir, entry.name);
    if (!resolved.startsWith(NodePath.resolve(stagingDir) + NodePath.sep)) {
      throw new Error(`refusing path traversal in the authoring workspace: ${entry.name}`);
    }
    const handle = await NodeFs.open(resolved, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      totalBytes += stat.size;
      if (!stat.isFile() || totalBytes > FORGE_MAX_BUNDLE_BYTES)
        throw new Error("bundle exceeds its file or size bounds");
      const buffer = Buffer.alloc(stat.size + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead !== stat.size) throw new Error("artifact changed during read");
      contents[entry.name] = buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  }
  return contents;
};

// ---------------------------------------------------------------------------
// The sealed report the host computes
// ---------------------------------------------------------------------------

export interface ForgeSealedBundle {
  readonly version: ForgeCapabilityVersion;
  readonly contents: Record<string, string>;
}

/** Canonical bundle hash: the four artifacts, in contract order, joined. */
export function forgeBundleSha256(contents: Readonly<Record<string, string>>): string {
  return forgeSha256Hex(
    FORGE_CAPABILITY_ARTIFACT_PATHS.map((path) => contents[path] ?? "").join(
      "\n---forge-artifact---\n",
    ),
  );
}

/** Validate a capability's own diagnostics against its input window. */
export function validateDiagnosticsAgainstInput(
  output: {
    readonly reading: ForgeSignalReading;
    readonly diagnostics: ReadonlyArray<{
      readonly poolId: string;
      readonly tradeIds: ReadonlyArray<string>;
    }>;
  },
  input: ForgeSignalInput,
): string | null {
  const knownIds = new Set<string>();
  const knownPools = new Set<string>();
  for (const pool of input.pools) {
    knownPools.add(pool.poolId);
    for (const id of pool.observationIds) knownIds.add(id);
  }
  if (
    output.reading.kind === "ready" &&
    output.reading.eligiblePoolIds.some((id) => !knownPools.has(id))
  )
    return "reading names an unknown eligible pool";
  const seenPools = new Set<string>();
  for (const diagnostic of output.diagnostics) {
    if (seenPools.has(diagnostic.poolId)) return "duplicate pool diagnostics";
    seenPools.add(diagnostic.poolId);
    const pool = input.pools.find((candidate) => candidate.poolId === diagnostic.poolId);
    const poolIds = new Set(pool?.observationIds ?? []);
    if (!knownPools.has(diagnostic.poolId)) {
      return `diagnostics name pool ${diagnostic.poolId}, which the input window does not hold`;
    }
    for (const tradeId of diagnostic.tradeIds) {
      if (!poolIds.has(tradeId)) {
        return `diagnostics reference trade ${tradeId}, which the input window does not hold`;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// The builder service
// ---------------------------------------------------------------------------

export interface ForgeAuthoringBrief {
  readonly schemaVersion: number;
  readonly sdkSource: string;
  readonly dataSchema: string;
  readonly stagingDir: string;
  readonly artifactContract: string;
}

export type ForgeBuilderFailure =
  | { readonly kind: "invalid_request"; readonly reason: string }
  | { readonly kind: "sandbox"; readonly reason: string }
  | { readonly kind: "store"; readonly reason: string };

export class ForgeBuilderError extends Data.TaggedError("ForgeBuilderError")<{
  readonly failure: ForgeBuilderFailure;
}> {
  constructor(failure: ForgeBuilderFailure) {
    super({ failure });
  }

  override get message(): string {
    return `forge builder: ${this.failure.kind}: ${this.failure.reason}`;
  }
}

export interface ForgeCapabilityBuilderShape {
  /** Start a build and hand back the authoring brief (stages: requested → inspecting → authoring). */
  readonly prepare: (input: {
    readonly environmentId: string;
    readonly threadId?: string | undefined;
    readonly capabilityId: string;
    readonly requestedSemantics: string;
    /** The directory in the caller's workspace where the four artifacts must land. */
    readonly stagingDir: string;
  }) => Effect.Effect<
    { readonly build: ForgeBuildReceipt; readonly brief: ForgeAuthoringBrief },
    ForgeBuilderError
  >;
  /**
   * Read the authored workspace, validate, and run the full containment
   * pipeline. On success the version is staged READY — never installed.
   */
  readonly check: (input: {
    readonly buildId: string;
    readonly environmentId: string;
    readonly stagingDir: string;
    readonly acceptanceCases: ReadonlyArray<ForgeAcceptanceCase>;
  }) => Effect.Effect<
    { readonly build: ForgeBuildReceipt; readonly staged: ForgeSealedBundle | null },
    ForgeBuilderError
  >;
}

export class ForgeCapabilityBuilder extends Context.Service<
  ForgeCapabilityBuilder,
  ForgeCapabilityBuilderShape
>()("t3/trading/forge/CapabilityBuilder/ForgeCapabilityBuilder") {}

const toBuilderError = (error: unknown): ForgeBuilderError =>
  error instanceof ForgeBuilderError
    ? error
    : new ForgeBuilderError({
        kind: "store",
        reason: error instanceof Error ? error.message : String(error),
      });

/** The manifest decode, hoisted out of the generator: a refused manifest is
 * already handled by static validation; this read-back is a belt-and-braces
 * decode of bytes the host itself just validated. */
const decodeManifest = (raw: string): ForgeCapabilityManifest =>
  Schema.decodeUnknownSync(ForgeCapabilityManifest)(parseJsonOr(raw, {}));

/** The one decoder every contained evaluation runs: the SDK's output contract. */
const decodeForgeSignalOutput = (value: unknown): unknown =>
  Schema.decodeUnknownSync(ForgeSignalOutput)(value);

/** JSON.parse whose failure degrades to a value the manifest decode refuses. */
const parseJsonOr = (raw: string, fallback: unknown): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
};

export const makeForgeCapabilityBuilder = Effect.gen(function* () {
  const store: ForgeCapabilityStoreShape = yield* ForgeCapabilityStore;
  const sandbox: ForgeCapabilitySandboxShape = yield* ForgeCapabilitySandbox;

  const failStage = (buildId: string, reason: string): Effect.Effect<never, ForgeBuilderError> =>
    store
      .appendBuildStage({
        buildId,
        stage: "failed",
        detail: reason,
        patch: { failureReason: reason },
      })
      .pipe(
        Effect.mapError(toBuilderError),
        Effect.andThen(new ForgeBuilderError({ kind: "sandbox", reason })),
      );

  /** The reason line out of a failed contained run — never a pass string. */
  const sandboxFailureReason = (cause: Cause.Cause<ForgeSandboxError>): string => {
    const squashed = Cause.squash(cause);
    return squashed instanceof ForgeSandboxError
      ? squashed.failure.reason
      : String(squashed).slice(0, 200);
  };

  const prepare: ForgeCapabilityBuilderShape["prepare"] = ({
    environmentId,
    threadId,
    capabilityId,
    requestedSemantics,
    stagingDir,
  }) =>
    Effect.gen(function* () {
      if (
        requestedSemantics.trim() === "" ||
        requestedSemantics.length > FORGE_MAX_SEMANTICS_CHARS
      ) {
        return yield* new ForgeBuilderError({
          kind: "invalid_request",
          reason: `requestedSemantics must be 1..${FORGE_MAX_SEMANTICS_CHARS} characters`,
        });
      }
      const started = yield* store
        .startBuild({
          environmentId,
          ...(threadId === undefined ? {} : { threadId }),
          capabilityId,
          requestedSemantics,
        })
        .pipe(Effect.mapError(toBuilderError));
      yield* store
        .appendBuildStage({
          buildId: started.buildId,
          stage: "inspecting",
          detail: "host inspected the configured sources",
        })
        .pipe(Effect.mapError(toBuilderError));
      const authoring = yield* store
        .appendBuildStage({
          buildId: started.buildId,
          stage: "authoring",
          detail: "authoring brief handed to the calling agent's workspace",
        })
        .pipe(Effect.mapError(toBuilderError));
      const version = yield* store
        .nextVersion({ environmentId, capabilityId })
        .pipe(Effect.mapError(toBuilderError));
      const brief: ForgeAuthoringBrief = {
        schemaVersion: FORGE_SDK_SCHEMA_VERSION,
        sdkSource: FORGE_SDK_SOURCE,
        dataSchema: `${FORGE_DATA_SCHEMA_CONTEXT}\nAuthor manifest.version as ${version}; immutable retained versions are never reused.`,
        stagingDir,
        artifactContract: FORGE_CAPABILITY_ARTIFACT_PATHS.join(", "),
      };
      return { build: authoring, brief };
    });

  const check: ForgeCapabilityBuilderShape["check"] = ({
    buildId,
    environmentId,
    stagingDir,
    acceptanceCases,
  }) =>
    Effect.gen(function* () {
      const existing = yield* store.getBuild(buildId).pipe(Effect.mapError(toBuilderError));
      if (existing === null) {
        return yield* new ForgeBuilderError({
          kind: "invalid_request",
          reason: `no build ${buildId}`,
        });
      }
      if (existing.environmentId !== environmentId) {
        return yield* new ForgeBuilderError({
          kind: "invalid_request",
          reason: "build belongs to another environment",
        });
      }
      if (
        existing.stage === "cancelled" ||
        existing.stage === "installed" ||
        existing.stage === "failed"
      ) {
        return yield* new ForgeBuilderError({
          kind: "invalid_request",
          reason: `build ${buildId} is ${existing.stage}; a cancelled build can never install`,
        });
      }
      const capabilityId = existing.capabilityId;
      if (capabilityId === undefined) {
        return yield* failStage(buildId, "the build never named a capability");
      }
      const nextVersion = yield* store
        .nextVersion({ environmentId, capabilityId })
        .pipe(Effect.mapError(toBuilderError));

      // -- read and validate the authored workspace --------------------------
      const contents = yield* Effect.tryPromise({
        try: () => readAuthoringWorkspace(stagingDir),
        catch: (error) => (error instanceof Error ? error.message : String(error)),
      }).pipe(Effect.catch((reason) => failStage(buildId, `authoring workspace: ${reason}`)));
      const validated = validateAuthoredArtifacts({
        contents,
        expectedCapabilityId: capabilityId,
        expectedVersion: nextVersion,
      });
      if (validated.status === "refused") {
        return yield* failStage(buildId, validated.reason);
      }
      yield* store
        .appendBuildStage({
          buildId,
          stage: "checking",
          detail: "four artifacts accepted for containment",
        })
        .pipe(Effect.mapError(toBuilderError));

      // -- the host's hashes, over the exact bytes it is about to test -------
      const artifactSha256 = FORGE_CAPABILITY_ARTIFACT_PATHS.map((path) => ({
        path,
        sha256: forgeSha256Hex(contents[path] ?? ""),
      }));
      const bundleSha256 = forgeBundleSha256(contents);
      const files: Array<ForgeSandboxFile> = [
        ...FORGE_CAPABILITY_ARTIFACT_PATHS.map((path) => ({ path, content: contents[path] ?? "" })),
        { path: "sdk.ts", content: FORGE_SDK_SOURCE },
      ];

      const checks: Array<ForgeCheckOutcome> = [];

      // -- compile + typecheck (host-run, contained) --------------------------
      const typecheck = yield* sandbox
        .runBuildStep({ files, entrypoint: [...FORGE_RUNNER_TYPECHECK] })
        .pipe(Effect.exit);
      if (typecheck._tag === "Failure") {
        return yield* failStage(
          buildId,
          `typecheck failed closed: ${sandboxFailureReason(typecheck.cause)}`,
        );
      }
      checks.push({ name: "typecheck", passed: true, exitCode: typecheck.value.exitCode });

      // -- the generated tests (their own file, their own run) ---------------
      const tests = yield* sandbox
        .runBuildStep({ files, entrypoint: [...FORGE_RUNNER_TEST] })
        .pipe(Effect.exit);
      if (tests._tag === "Failure") {
        return yield* failStage(
          buildId,
          `generated tests failed closed: ${sandboxFailureReason(tests.cause)}`,
        );
      }
      checks.push({ name: "generated-tests", passed: true, exitCode: tests.value.exitCode });

      // -- host-owned acceptance cases ----------------------------------------
      const failedCases: Array<{ name: string; reason: string }> = [];
      for (const example of acceptanceCases) {
        const actual = yield* sandbox
          .runEvaluation({
            files,
            entrypoint: [...FORGE_RUNNER_EVALUATE],
            stdinJson: JSON.stringify(example.input),
            decodeResult: decodeForgeSignalOutput,
          })
          .pipe(Effect.exit);
        if (actual._tag === "Failure") {
          failedCases.push({
            name: example.name,
            reason: sandboxFailureReason(actual.cause),
          });
          continue;
        }
        const output = actual.value as {
          reading: ForgeSignalReading;
          diagnostics: ReadonlyArray<{ poolId: string; tradeIds: ReadonlyArray<string> }>;
        };
        const referenceError = validateDiagnosticsAgainstInput(
          { reading: output.reading, diagnostics: output.diagnostics },
          example.input,
        );
        if (referenceError !== null) {
          failedCases.push({ name: example.name, reason: referenceError });
          continue;
        }
        const expected = JSON.stringify(example.expected);
        const got = JSON.stringify(output.reading);
        if (expected !== got) {
          failedCases.push({ name: example.name, reason: `expected ${expected}, got ${got}` });
        }
      }
      const acceptancePassed = acceptanceCases.length - failedCases.length;
      checks.push({
        name: "acceptance",
        passed: failedCases.length === 0,
        ...(failedCases.length === 0
          ? {}
          : {
              detail: failedCases
                .map((failure) => `${failure.name}: ${failure.reason}`)
                .join("; ")
                .slice(0, 2_000),
            }),
      });

      // Empty caller cases cannot certify a module without exercising it.
      const determinismInput = acceptanceCases[0]?.input;
      if (determinismInput === undefined)
        return yield* failStage(
          buildId,
          "at least one independent host acceptance case is required",
        );
      const first = yield* sandbox
        .runEvaluation({
          files,
          entrypoint: [...FORGE_RUNNER_EVALUATE],
          stdinJson: JSON.stringify(determinismInput),
          decodeResult: decodeForgeSignalOutput,
        })
        .pipe(Effect.exit);
      const second = yield* sandbox
        .runEvaluation({
          files,
          entrypoint: [...FORGE_RUNNER_EVALUATE],
          stdinJson: JSON.stringify(determinismInput),
          decodeResult: decodeForgeSignalOutput,
        })
        .pipe(Effect.exit);
      const determinismPassed =
        first._tag === "Success" &&
        second._tag === "Success" &&
        JSON.stringify(first.value) === JSON.stringify(second.value);
      checks.push({ name: "determinism", passed: determinismPassed });

      const allPassed = failedCases.length === 0 && determinismPassed;
      if (!allPassed) {
        return yield* failStage(
          buildId,
          failedCases.length > 0
            ? `acceptance failed: ${failedCases.map((failure) => failure.name).join(", ")}`
            : "the capability was not deterministic on identical input",
        );
      }

      // -- stage the immutable version (READY — installation is separate) ----
      const manifest = decodeManifest(validated.artifacts.contents["manifest.json"] ?? "{}");
      const version: ForgeCapabilityVersion = {
        capabilityId,
        version: nextVersion,
        bundleSha256,
        artifacts: artifactSha256.map((artifact) => ({
          path: artifact.path,
          sha256: artifact.sha256,
          bytes: Buffer.byteLength(contents[artifact.path] ?? "", "utf8"),
        })),
        manifest,
        createdAtMs: Date.now(),
      };
      const stagedResult = yield* store
        .stageVersion(environmentId, version, contents)
        .pipe(Effect.mapError(toBuilderError));
      if (stagedResult.status === "refused") {
        return yield* failStage(buildId, `the store refused the version: ${stagedResult.detail}`);
      }
      const ready = yield* store
        .appendBuildStage({
          buildId,
          stage: "ready",
          detail: `v${nextVersion} sealed and staged; installation is a separate CAS step`,
          patch: {
            checks,
            acceptance: {
              total: acceptanceCases.length,
              passed: acceptancePassed,
              failed: failedCases,
            },
            artifactSha256,
            bundleSha256,
          },
        })
        .pipe(Effect.mapError(toBuilderError));
      return { build: ready, staged: { version, contents } };
    });

  return { prepare, check } satisfies ForgeCapabilityBuilderShape;
});

export const ForgeCapabilityBuilderLive = Layer.effect(
  ForgeCapabilityBuilder,
  makeForgeCapabilityBuilder,
);
