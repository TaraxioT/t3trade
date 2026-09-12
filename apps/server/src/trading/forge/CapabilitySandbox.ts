/**
 * CapabilitySandbox — the sealed containment every Forge capability runs in.
 *
 * Generated code never executes on the host. Compile, typecheck, generated
 * tests, host-owned acceptance and evaluation all run inside one container
 * image the HOST pinned by digest (host configuration; a model never authors
 * the ref), with no network, a read-only root, a cleared environment, no
 * mounts but the bundle's own directory (read-only), bounded input and output,
 * and a wall-clock budget. Every failure mode — timeout, output overflow,
 * Docker unavailable, malformed result — fails closed: nothing installs and
 * nothing reads as a pass.
 *
 * The container engine itself is behind an injected interface
 * (`ForgeContainerRunner`). Tests drive a fake runner; the Docker
 * implementation is env-gated and refuses everything when Docker is not
 * usable, which is the default on machines without the daemon.
 *
 * @module CapabilitySandbox
 */
// @effect-diagnostics globalTimers:off - the child-process callback owns its deadline and clears it on process exit.
// @effect-diagnostics nodeBuiltinImport:off - the container engine IS node's child_process/fs/path; wrapping the security boundary in Effect abstractions would add indirection, not containment.
// @effect-diagnostics globalDate:off globalDateInEffect:off - run receipts are wall-clock instants persisted as data; the Clock abstraction adds no determinism to a log line.
// @effect-diagnostics preferSchemaOverJson:off - JSON.parse here validates hostile container output before any schema sees it; the parse failure IS the error being reported.
// @effect-diagnostics tryCatchInEffectGen:off - the parse/decode refusals are host verdicts (invalid_result), not exceptions to recover; try/catch states that exactly.
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Schema } from "effect";
import * as Layer from "effect/Layer";
import { execFile, spawn } from "node:child_process";
import * as NodeCrypto from "node:crypto";

import {
  FORGE_CAPABILITY_ARTIFACT_PATHS,
  FORGE_MAX_BUNDLE_BYTES,
  FORGE_SANDBOX_BUILD_BUDGET_MS,
  FORGE_SANDBOX_EVALUATION_BUDGET_MS,
  FORGE_SANDBOX_MAX_INPUT_BYTES,
  FORGE_SANDBOX_MAX_OUTPUT_BYTES,
} from "@t3tools/trading-contracts";

// ---------------------------------------------------------------------------
// Host hashing — the host computes every seal itself
// ---------------------------------------------------------------------------

/** SHA-256 over the exact bytes, hex. The host's own identity computation. */
export function forgeSha256Hex(content: string): string {
  return NodeCrypto.createHash("sha256").update(content, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface ForgeSandboxSettings {
  /**
   * The digest-pinned prebuilt runner image, or null when the host has not
   * configured one. Null means every contained run refuses — fail closed,
   * never a host fallback.
   */
  readonly imageRef: string | null;
  readonly buildBudgetMs: number;
  readonly evaluationBudgetMs: number;
}

export class ForgeSandboxConfig extends Context.Service<ForgeSandboxConfig, ForgeSandboxSettings>()(
  "t3/trading/forge/CapabilitySandbox/ForgeSandboxConfig",
) {}

/** A ref is acceptable only pinned to an immutable digest. */
export const FORGE_IMAGE_DIGEST_PATTERN = /^[a-z0-9._/-]+@sha256:[0-9a-f]{64}$/;

export const isDigestPinnedImageRef = (ref: string): boolean =>
  FORGE_IMAGE_DIGEST_PATTERN.test(ref);

const envOrNull = (name: string): string | null => {
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? null : value.trim();
};

const positiveInt = (raw: string | null, fallback: number): number => {
  if (raw === null) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

/**
 * Configuration from the environment. Total by construction: an unset or
 * non-digest image leaves `imageRef` null, which every run refuses by name.
 */
export const ForgeSandboxConfigFromEnv = Layer.effect(
  ForgeSandboxConfig,
  Effect.sync((): ForgeSandboxSettings => {
    const raw = envOrNull("T3_FORGE_SANDBOX_IMAGE");
    const imageRef = raw !== null && isDigestPinnedImageRef(raw) ? raw : null;
    return {
      imageRef,
      buildBudgetMs: positiveInt(
        envOrNull("T3_FORGE_SANDBOX_BUILD_BUDGET_MS"),
        FORGE_SANDBOX_BUILD_BUDGET_MS,
      ),
      evaluationBudgetMs: positiveInt(
        envOrNull("T3_FORGE_SANDBOX_EVALUATION_BUDGET_MS"),
        FORGE_SANDBOX_EVALUATION_BUDGET_MS,
      ),
    };
  }),
);

// ---------------------------------------------------------------------------
// Failures — one typed, fail-closed vocabulary
// ---------------------------------------------------------------------------

export type ForgeSandboxFailure =
  | { readonly kind: "sandbox_unavailable"; readonly reason: string }
  | { readonly kind: "invalid_request"; readonly reason: string }
  | { readonly kind: "timeout"; readonly reason: string }
  | { readonly kind: "output_limit"; readonly reason: string }
  | {
      readonly kind: "nonzero_exit";
      readonly reason: string;
      readonly exitCode: number;
      readonly stderr: string;
    }
  | { readonly kind: "invalid_result"; readonly reason: string };

export class ForgeSandboxError extends Data.TaggedError("ForgeSandboxError")<{
  readonly failure: ForgeSandboxFailure;
}> {
  constructor(failure: ForgeSandboxFailure) {
    super({ failure });
  }

  override get message(): string {
    return `forge sandbox: ${this.failure.kind}: ${this.failure.reason}`;
  }
}

const fail = (failure: ForgeSandboxFailure): Effect.Effect<never, ForgeSandboxError> =>
  Effect.fail(new ForgeSandboxError(failure));

// ---------------------------------------------------------------------------
// The container runner interface
// ---------------------------------------------------------------------------

/** One file mounted into the container at `/work/<path>`. Flat paths only. */
export interface ForgeSandboxFile {
  readonly path: string;
  readonly content: string;
}

export interface ForgeContainerRunRequest {
  readonly imageRef: string;
  readonly files: ReadonlyArray<ForgeSandboxFile>;
  readonly entrypoint: ReadonlyArray<string>;
  readonly stdin?: string;
  readonly timeoutMs: number;
  readonly outputLimitBytes: number;
}

export interface ForgeContainerRunResult {
  /** The container's exit code, or null when the run was killed. */
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly killed: "timeout" | "output_limit" | null;
}

/**
 * The container engine, behind an interface. `available` is false whenever
 * the engine cannot guarantee containment — absent daemon, unconfigured
 * image, unsupported runtime — and every run then refuses.
 */
export interface ForgeContainerRunnerShape {
  readonly available: Effect.Effect<boolean>;
  readonly run: (
    request: ForgeContainerRunRequest,
  ) => Effect.Effect<ForgeContainerRunResult, ForgeSandboxError>;
}

export class ForgeContainerRunner extends Context.Service<
  ForgeContainerRunner,
  ForgeContainerRunnerShape
>()("t3/trading/forge/CapabilitySandbox/ForgeContainerRunner") {}

/** The default runner: nothing is configured, everything refuses. */
export const ForgeUnavailableContainerRunnerLive = Layer.succeed(ForgeContainerRunner, {
  available: Effect.succeed(false),
  run: () =>
    fail({
      kind: "sandbox_unavailable",
      reason:
        "no container runner is configured; set T3_FORGE_SANDBOX_RUNNER=docker with a digest-pinned T3_FORGE_SANDBOX_IMAGE",
    }),
} satisfies ForgeContainerRunnerShape);

// ---------------------------------------------------------------------------
// Docker argv — the containment contract, as inspectable data
// ---------------------------------------------------------------------------

/**
 * The `docker run` argv one contained run uses. Pure, so the containment
 * contract is testable without a daemon:
 *
 * - `--network none` — no network, not even DNS.
 * - `--read-only` root filesystem; `/tmp` a noexec tmpfs.
 * - `--cap-drop ALL`, `no-new-privileges`, non-root uid, pid/cpu/memory caps.
 * - Exactly ONE mount: the run's own flat file directory, read-only. Never
 *   the checkout, `$HOME`, env files, SSH keys, the signer base, or the
 *   docker socket.
 * - No `-e` from the host environment except an explicit `HOME=/tmp`; docker
 *   passes no host env by default and this keeps it that way.
 */
export function dockerRunArgv(input: {
  readonly imageRef: string;
  readonly entrypoint: ReadonlyArray<string>;
  readonly workDir: string;
}): ReadonlyArray<string> {
  return [
    "run",
    "--rm",
    "--interactive",
    "--pull",
    "never",
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--user",
    "65534:65534",
    "--memory",
    "512m",
    "--cpus",
    "1",
    "--pids-limit",
    "64",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=64m",
    "--mount",
    `type=bind,source=${input.workDir},target=/work,readonly`,
    "--workdir",
    "/work",
    "--env",
    "HOME=/tmp",
    input.imageRef,
    ...input.entrypoint,
  ];
}

// ---------------------------------------------------------------------------
// The Docker runner (env-gated; refuses when the daemon is unusable)
// ---------------------------------------------------------------------------

const execFileOnce = (
  command: string,
  args: ReadonlyArray<string>,
  options: {
    readonly timeoutMs: number;
    readonly maxBufferBytes: number;
  },
): Promise<{ readonly stdout: string; readonly stderr: string }> =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      {
        timeout: options.timeoutMs,
        maxBuffer: options.maxBufferBytes,
        killSignal: "SIGKILL",
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      },
      (error, stdout, stderr) => {
        if (error !== null) reject(error);
        else resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });

/** `true` only when the Docker daemon answers a version probe in time. */
export const probeDockerDaemon = (timeoutMs = 2_500): Promise<boolean> =>
  execFileOnce("docker", ["version", "--format", "{{.Server.Version}}"], {
    timeoutMs,
    maxBufferBytes: 4_096,
  })
    .then(() => true)
    .catch(() => false);

/**
 * The Docker-backed runner. Docker is NOT started by this process; the probe
 * only asks whether a daemon is already usable. Unusable means `available` is
 * false and every run fails closed.
 */
export const makeDockerContainerRunner = (
  probe: () => Promise<boolean> = probeDockerDaemon,
): ForgeContainerRunnerShape => {
  const run: ForgeContainerRunnerShape["run"] = (request) =>
    Effect.tryPromise({
      try: async (signal): Promise<ForgeContainerRunResult> => {
        const os = await import("node:os");
        const fs = await import("node:fs/promises");
        const path = await import("node:path");
        const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "forge-sandbox-"));
        const containerName = `forge-run-${NodeCrypto.randomUUID()}`;
        try {
          // Docker runs as nobody and must be able to traverse this directory.
          await fs.chmod(workDir, 0o755);
          for (const file of request.files) {
            if (!isSafeSandboxPath(file.path))
              throw new ForgeSandboxError({
                kind: "invalid_request",
                reason: "unsafe sandbox path",
              });
            await fs.writeFile(path.join(workDir, file.path), file.content, {
              mode: 0o444,
              flag: "wx",
            });
          }
          const argv = [
            ...dockerRunArgv({
              imageRef: request.imageRef,
              entrypoint: request.entrypoint,
              workDir,
            }),
          ];
          argv.splice(1, 0, "--name", containerName);
          if (signal.aborted)
            throw new ForgeSandboxError({
              kind: "timeout",
              reason: "sandbox run was interrupted before launch",
            });
          return await new Promise<ForgeContainerRunResult>((resolve, reject) => {
            const child = spawn("docker", argv, {
              env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
              stdio: ["pipe", "pipe", "pipe"],
            });
            let killed: ForgeContainerRunResult["killed"] = null;
            let size = 0;
            const stdout: Buffer[] = [];
            const stderr: Buffer[] = [];
            const stop = (reason: "timeout" | "output_limit") => {
              if (killed !== null) return;
              killed = reason;
              child.kill("SIGKILL");
            };
            const onAbort = () => stop("timeout");
            signal.addEventListener("abort", onAbort, { once: true });
            if (signal.aborted) onAbort();
            const timer = setTimeout(() => stop("timeout"), request.timeoutMs);
            const capture = (destination: Buffer[], chunk: Buffer) => {
              size += chunk.length;
              if (size > request.outputLimitBytes) stop("output_limit");
              else destination.push(chunk);
            };
            child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
            child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
            child.stdin.on("error", () => {}); // A failed container may close stdin early.
            child.once("error", (error) => {
              clearTimeout(timer);
              signal.removeEventListener("abort", onAbort);
              reject(error);
            });
            child.once("close", (code) => {
              clearTimeout(timer);
              signal.removeEventListener("abort", onAbort);
              resolve({
                exitCode: code,
                stdout: Buffer.concat(stdout).toString("utf8"),
                stderr: Buffer.concat(stderr).toString("utf8"),
                killed,
              });
            });
            child.stdin.end(request.stdin ?? "");
          });
        } finally {
          // Killing the Docker CLI does not kill its container. Remove only this run's exact name.
          await execFileOnce("docker", ["rm", "--force", containerName], {
            timeoutMs: 5_000,
            maxBufferBytes: 4_096,
          }).catch(() => {});
          await fs.rm(workDir, { recursive: true, force: true });
        }
      },
      catch: (error) =>
        error instanceof ForgeSandboxError
          ? error
          : new ForgeSandboxError({
              kind: "sandbox_unavailable",
              reason: error instanceof Error ? error.message : String(error),
            }),
    });

  return {
    available: Effect.promise(() => probe()),
    run,
  };
};

/** `T3_FORGE_SANDBOX_RUNNER=docker` selects the Docker runner; anything else refuses. */
export const ForgeContainerRunnerFromEnv = Layer.effect(
  ForgeContainerRunner,
  Effect.sync(() => {
    const selector = envOrNull("T3_FORGE_SANDBOX_RUNNER");
    return selector === "docker"
      ? makeDockerContainerRunner()
      : ({
          available: Effect.succeed(false),
          run: () =>
            fail({
              kind: "sandbox_unavailable",
              reason: `T3_FORGE_SANDBOX_RUNNER is ${JSON.stringify(selector ?? "unset")}; contained runs refuse without a runner`,
            }),
        } satisfies ForgeContainerRunnerShape);
  }),
);

// ---------------------------------------------------------------------------
// The sandbox service — validation and budgets around any runner
// ---------------------------------------------------------------------------

/**
 * A safe mounted filename: one flat path segment, no directories, no
 * traversal, no absolute paths, no dotfiles that could surprise a shell.
 */
export function isSafeSandboxPath(path: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(path) && !path.includes("..");
}

export interface ForgeSandboxRunOutcome {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ForgeCapabilitySandboxShape {
  /** Whether contained runs are possible right now. False refuses everything. */
  readonly available: Effect.Effect<boolean>;
  /** One contained build/check step (~30s budget, bundle-sized file set). */
  readonly runBuildStep: (input: {
    readonly files: ReadonlyArray<ForgeSandboxFile>;
    readonly entrypoint: ReadonlyArray<string>;
    readonly stdin?: string;
  }) => Effect.Effect<ForgeSandboxRunOutcome, ForgeSandboxError>;
  /** One contained evaluation (~2s budget) whose stdout must parse as JSON. */
  readonly runEvaluation: (input: {
    readonly files: ReadonlyArray<ForgeSandboxFile>;
    readonly entrypoint: ReadonlyArray<string>;
    readonly stdinJson: string;
    /** Host-owned decoder for the container's structured stdout. */
    readonly decodeResult: (value: unknown) => unknown;
  }) => Effect.Effect<unknown, ForgeSandboxError>;
}

export class ForgeCapabilitySandbox extends Context.Service<
  ForgeCapabilitySandbox,
  ForgeCapabilitySandboxShape
>()("t3/trading/forge/CapabilitySandbox/ForgeCapabilitySandbox") {}

/** Decode outside the generator: the throw is caught here, not carried as a
 * defect out of the Effect. */
const decodeOrThrow = (decode: (value: unknown) => unknown, value: unknown): unknown =>
  decode(value);

export const makeForgeCapabilitySandbox = Effect.gen(function* () {
  const settings = yield* ForgeSandboxConfig;
  const runner = yield* ForgeContainerRunner;

  const contained = (
    phase: "build" | "evaluation",
    input: {
      readonly files: ReadonlyArray<ForgeSandboxFile>;
      readonly entrypoint: ReadonlyArray<string>;
      readonly stdin?: string;
    },
  ): Effect.Effect<ForgeContainerRunResult, ForgeSandboxError> =>
    Effect.gen(function* () {
      // Fail closed before any runner call: no configured image, no run.
      if (settings.imageRef === null || !isDigestPinnedImageRef(settings.imageRef)) {
        return yield* fail({
          kind: "sandbox_unavailable",
          reason: "no digest-pinned runner image is configured (T3_FORGE_SANDBOX_IMAGE)",
        });
      }
      for (const file of input.files) {
        if (!isSafeSandboxPath(file.path)) {
          return yield* fail({
            kind: "invalid_request",
            reason: `file path ${JSON.stringify(file.path)} is not a flat, safe workdir name`,
          });
        }
      }
      const artifactBytes = input.files
        .filter((file) =>
          (FORGE_CAPABILITY_ARTIFACT_PATHS as readonly string[]).includes(file.path),
        )
        .reduce((sum, file) => sum + Buffer.byteLength(file.content, "utf8"), 0);
      if (artifactBytes > FORGE_MAX_BUNDLE_BYTES) {
        return yield* fail({
          kind: "invalid_request",
          reason: `the four artifacts total ${artifactBytes} bytes, over the ${FORGE_MAX_BUNDLE_BYTES} byte bundle cap`,
        });
      }
      const totalBytes = input.files.reduce(
        (sum, file) => sum + Buffer.byteLength(file.content, "utf8"),
        0,
      );
      const bundleCap = FORGE_MAX_BUNDLE_BYTES + 256 * 1024; // artifacts + host SDK/harness files
      if (totalBytes > bundleCap) {
        return yield* fail({
          kind: "invalid_request",
          reason: `file set is ${totalBytes} bytes, over the ${bundleCap} byte containment cap`,
        });
      }
      const stdin = input.stdin ?? "";
      if (Buffer.byteLength(stdin, "utf8") > FORGE_SANDBOX_MAX_INPUT_BYTES) {
        return yield* fail({
          kind: "invalid_request",
          reason: `stdin is over the ${FORGE_SANDBOX_MAX_INPUT_BYTES} byte input cap`,
        });
      }
      if (input.entrypoint.length === 0 || input.entrypoint.some((part) => part === "")) {
        return yield* fail({ kind: "invalid_request", reason: "entrypoint is empty" });
      }
      const usable = yield* runner.available;
      if (!usable) {
        return yield* fail({
          kind: "sandbox_unavailable",
          reason:
            "the container runner is unavailable (Docker down or not configured); contained runs refuse",
        });
      }
      const timeoutMs = phase === "build" ? settings.buildBudgetMs : settings.evaluationBudgetMs;
      const result = yield* runner.run({
        imageRef: settings.imageRef,
        files: input.files,
        entrypoint: input.entrypoint,
        ...(stdin === "" ? {} : { stdin }),
        timeoutMs,
        outputLimitBytes: FORGE_SANDBOX_MAX_OUTPUT_BYTES,
      });
      if (result.killed === "timeout") {
        return yield* fail({
          kind: "timeout",
          reason: `the ${phase} step exceeded its ${timeoutMs}ms budget and was killed`,
        });
      }
      if (result.killed === "output_limit") {
        return yield* fail({
          kind: "output_limit",
          reason: `the ${phase} step exceeded the ${FORGE_SANDBOX_MAX_OUTPUT_BYTES} byte output cap and was killed`,
        });
      }
      if (result.exitCode === null) {
        return yield* fail({
          kind: "timeout",
          reason: `the ${phase} step was killed before exiting`,
        });
      }
      if (result.exitCode !== 0) {
        return yield* fail({
          kind: "nonzero_exit",
          reason: `the ${phase} step exited ${result.exitCode}`,
          exitCode: result.exitCode,
          stderr: result.stderr.slice(0, 2_000),
        } satisfies Extract<ForgeSandboxFailure, { kind: "nonzero_exit" }>);
      }
      return result;
    });

  const runBuildStep: ForgeCapabilitySandboxShape["runBuildStep"] = (input) =>
    contained("build", input).pipe(
      Effect.map((result) => ({
        exitCode: result.exitCode as number,
        stdout: result.stdout,
        stderr: result.stderr,
      })),
    );

  const runEvaluation: ForgeCapabilitySandboxShape["runEvaluation"] = (input) =>
    Effect.gen(function* () {
      const decodeResult = input.decodeResult;
      // Input already-JSON is re-serialized: the cap applies to what crosses
      // the boundary, and malformed JSON refuses before a container runs.
      let parsedInput: unknown;
      try {
        parsedInput = JSON.parse(input.stdinJson);
      } catch {
        return yield* fail({
          kind: "invalid_result",
          reason: "evaluation input was not valid JSON",
        });
      }
      const result = yield* contained("evaluation", {
        files: input.files,
        entrypoint: input.entrypoint,
        stdin: JSON.stringify(parsedInput),
      });
      let parsed: unknown;
      try {
        parsed = JSON.parse(result.stdout);
      } catch {
        return yield* fail({
          kind: "invalid_result",
          reason: "evaluation stdout was not JSON; a pass string is never a result",
        });
      }
      return yield* Effect.try({
        try: () => decodeOrThrow(decodeResult, parsed),
        catch: () =>
          new ForgeSandboxError({
            kind: "invalid_result",
            reason: "evaluation output failed host schema validation",
          }),
      });
    });

  return {
    available: runner.available,
    runBuildStep,
    runEvaluation,
  } satisfies ForgeCapabilitySandboxShape;
});

export const ForgeCapabilitySandboxLive = Layer.effect(
  ForgeCapabilitySandbox,
  makeForgeCapabilitySandbox,
);
