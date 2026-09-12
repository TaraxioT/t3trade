/**
 * CapabilitySandbox — what containment claims, held to its contract.
 *
 * The container engine is a fake in here: it records the run it was asked to
 * perform and answers scripted results. The Docker argv contract is tested as
 * pure data, so the containment flags are pinned without a daemon. Everything
 * that can go wrong — no image, no daemon, timeout, output overflow, unsafe
 * paths, oversized input, malformed result — must fail closed.
 */
// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off globalConsole:off preferSchemaOverJson:off - real files under temp roots are the fixture; receipts are wall-clock data; JSON is the storage codec under test.

import { assert, describe, it } from "@effect/vitest";
import { Schema } from "effect";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  FORGE_MAX_BUNDLE_BYTES,
  FORGE_SANDBOX_MAX_INPUT_BYTES,
  FORGE_SANDBOX_MAX_OUTPUT_BYTES,
  ForgeSignalOutput,
} from "@t3tools/trading-contracts";

import {
  dockerRunArgv,
  ForgeCapabilitySandbox,
  ForgeCapabilitySandboxLive,
  type ForgeCapabilitySandboxShape,
  ForgeSandboxConfig,
  ForgeSandboxError,
  ForgeContainerRunner,
  forgeSha256Hex,
  isDigestPinnedImageRef,
  isSafeSandboxPath,
  type ForgeContainerRunRequest,
  type ForgeContainerRunResult,
  type ForgeContainerRunnerShape,
  type ForgeSandboxFailure,
} from "./CapabilitySandbox.ts";

const DIGEST_IMAGE = "registry.local/forge-runner@sha256:" + "ab".repeat(32);

/** Records every run; answers from a script keyed by entrypoint head. */
const makeScriptedRunner = (
  script: Record<string, Effect.Effect<ForgeContainerRunResult>> = {},
  available = true,
): ForgeContainerRunnerShape & { readonly requests: Array<ForgeContainerRunRequest> } => {
  const requests: Array<ForgeContainerRunRequest> = [];
  const scriptMap = new Map(Object.entries(script));
  return {
    requests,
    available: Effect.succeed(available),
    run: (request) =>
      Effect.sync(() => {
        requests.push(request);
        return (
          scriptMap.get(request.entrypoint[0] ?? "") ??
          Effect.succeed({ exitCode: 0, stdout: "", stderr: "", killed: null })
        );
      }).pipe(Effect.flatten),
  };
};

const sandboxLayer = (runner: ForgeContainerRunnerShape, imageRef: string | null = DIGEST_IMAGE) =>
  ForgeCapabilitySandboxLive.pipe(
    Layer.provide(
      Layer.succeed(ForgeSandboxConfig, {
        imageRef,
        buildBudgetMs: 30_000,
        evaluationBudgetMs: 2_000,
      }),
    ),
    Layer.provide(Layer.succeed(ForgeContainerRunner, runner)),
  );

const sandboxWith = (
  runner: ForgeContainerRunnerShape,
  imageRef: string | null = DIGEST_IMAGE,
): Promise<ForgeCapabilitySandboxShape> =>
  Effect.runPromise(Effect.provide(sandboxLayer(runner, imageRef))(ForgeCapabilitySandbox));

const expectFailure = async (
  effect: Effect.Effect<unknown, ForgeSandboxError>,
): Promise<ForgeSandboxFailure> => {
  const result = await Effect.runPromise(Effect.exit(effect));
  assert.isTrue(result._tag === "Failure", "expected the contained run to fail closed");
  if (result._tag === "Failure") {
    const squashed = Cause.squash(result.cause);
    assert.instanceOf(squashed, ForgeSandboxError);
    return (squashed as ForgeSandboxError).failure;
  }
  throw new Error("unreachable");
};

describe("dockerRunArgv — the containment contract as data", () => {
  const argv = dockerRunArgv({
    imageRef: DIGEST_IMAGE,
    entrypoint: ["bun", "test", "signal.test.ts"],
    workDir: "/tmp/forge-sandbox-x",
  });

  it("has no network and a read-only root", () => {
    assert.includeMembers(argv as string[], ["--network", "none"]);
    assert.includeMembers(argv as string[], ["--read-only", "--interactive", "--pull", "never"]);
  });

  it("drops every capability and forbids privilege escalation", () => {
    assert.includeMembers(argv as string[], ["--cap-drop", "ALL"]);
    assert.includeMembers(argv as string[], ["--security-opt", "no-new-privileges"]);
  });

  it("runs as a non-root user with resource caps", () => {
    assert.includeMembers(argv as string[], ["--user", "65534:65534"]);
    assert.includeMembers(argv as string[], ["--pids-limit", "64"]);
    assert.includeMembers(argv as string[], ["--memory", "512m"]);
  });

  it("mounts exactly one directory, read-only — never home, checkout, or the docker socket", () => {
    const mounts = (argv as string[]).filter((_, index) => argv[index - 1] === "--mount");
    assert.equal(mounts.length, 1);
    assert.match(
      mounts[0] ?? "",
      /^type=bind,source=\/tmp\/forge-sandbox-x,target=\/work,readonly$/,
    );
    const joined = argv.join(" ");
    assert.notInclude(joined, "/var/run/docker.sock");
    assert.notInclude(joined, "--privileged");
    // No host environment passes through: the only -e is an explicit HOME.
    const envValues = (argv as string[]).filter((_, index) => argv[index - 1] === "--env");
    assert.deepEqual(envValues, ["HOME=/tmp"]);
  });

  it("pins the image by digest and keeps the entrypoint last", () => {
    assert.include(argv as string[], DIGEST_IMAGE);
    assert.equal(argv[argv.length - 3], "bun");
    assert.equal(argv[argv.length - 1], "signal.test.ts");
  });
});

describe("the sandbox's own validation", () => {
  it("accepts only digest-pinned image refs", () => {
    assert.isTrue(isDigestPinnedImageRef(DIGEST_IMAGE));
    assert.isFalse(isDigestPinnedImageRef("registry.local/forge-runner:latest"));
    assert.isFalse(isDigestPinnedImageRef("forge-runner"));
  });

  it("accepts only flat, safe mounted paths", () => {
    assert.isTrue(isSafeSandboxPath("signal.ts"));
    assert.isTrue(isSafeSandboxPath("sdk.ts"));
    assert.isFalse(isSafeSandboxPath("../escape"));
    assert.isFalse(isSafeSandboxPath("a/b.ts"));
    assert.isFalse(isSafeSandboxPath("/etc/passwd"));
    assert.isFalse(isSafeSandboxPath(".."));
    assert.isFalse(isSafeSandboxPath(".ssh"));
    assert.isFalse(isSafeSandboxPath(""));
  });

  it("hashes content deterministically", () => {
    assert.equal(forgeSha256Hex("abc"), forgeSha256Hex("abc"));
    assert.notEqual(forgeSha256Hex("abc"), forgeSha256Hex("abd"));
    assert.match(forgeSha256Hex("abc"), /^[0-9a-f]{64}$/);
  });
});

describe("fail-closed containment", () => {
  it("refuses every run when no digest-pinned image is configured", async () => {
    const runner = makeScriptedRunner();
    const sandbox = await sandboxWith(runner, null);
    const failure = await expectFailure(sandbox.runBuildStep({ files: [], entrypoint: ["bun"] }));
    assert.equal(failure.kind, "sandbox_unavailable");
    assert.include(failure.reason, "digest-pinned");
    assert.isEmpty(runner.requests);
  });

  it("refuses every run when the container runner is unavailable (Docker down)", async () => {
    const runner = makeScriptedRunner({}, false);
    const sandbox = await sandboxWith(runner);
    const failure = await expectFailure(sandbox.runBuildStep({ files: [], entrypoint: ["bun"] }));
    assert.equal(failure.kind, "sandbox_unavailable");
    assert.include(failure.reason, "unavailable");
    assert.isEmpty(runner.requests);
  });

  it("fails closed on a timed-out run", async () => {
    const runner = makeScriptedRunner({
      hang: Effect.succeed({ exitCode: null, stdout: "", stderr: "", killed: "timeout" }),
    });
    const sandbox = await sandboxWith(runner);
    const failure = await expectFailure(
      sandbox.runBuildStep({ files: [{ path: "signal.ts", content: "x" }], entrypoint: ["hang"] }),
    );
    assert.equal(failure.kind, "timeout");
    assert.include(failure.reason, "killed");
  });

  it("fails closed when output overflows the cap and kills the run", async () => {
    const runner = makeScriptedRunner({
      flood: Effect.succeed({
        exitCode: null,
        stdout: "x".repeat(FORGE_SANDBOX_MAX_OUTPUT_BYTES + 1),
        stderr: "",
        killed: "output_limit",
      }),
    });
    const sandbox = await sandboxWith(runner);
    const failure = await expectFailure(sandbox.runBuildStep({ files: [], entrypoint: ["flood"] }));
    assert.equal(failure.kind, "output_limit");
  });

  it("fails closed on a non-zero exit and carries bounded stderr", async () => {
    const runner = makeScriptedRunner({
      fail: Effect.succeed({ exitCode: 1, stdout: "", stderr: "boom", killed: null }),
    });
    const sandbox = await sandboxWith(runner);
    const failure = await expectFailure(sandbox.runBuildStep({ files: [], entrypoint: ["fail"] }));
    assert.equal(failure.kind, "nonzero_exit");
    if (failure.kind === "nonzero_exit") {
      assert.equal(failure.exitCode, 1);
      assert.include(failure.stderr, "boom");
    }
  });

  it("refuses unsafe mounted paths before any runner call", async () => {
    const runner = makeScriptedRunner();
    const sandbox = await sandboxWith(runner);
    for (const path of ["../escape", "a/b.ts", "/etc/passwd"]) {
      const failure = await expectFailure(
        sandbox.runBuildStep({ files: [{ path, content: "x" }], entrypoint: ["bun"] }),
      );
      assert.equal(failure.kind, "invalid_request", path);
    }
    assert.isEmpty(runner.requests);
  });

  it("refuses an oversized file set and an oversized stdin", async () => {
    const runner = makeScriptedRunner();
    const sandbox = await sandboxWith(runner);

    const oversizedFiles = ["query.graphql", "signal.ts", "signal.test.ts", "manifest.json"].map(
      (path) => ({ path, content: "x".repeat(FORGE_MAX_BUNDLE_BYTES / 2) }),
    );
    const fileFailure = await expectFailure(
      sandbox.runBuildStep({ files: oversizedFiles, entrypoint: ["bun"] }),
    );
    assert.equal(fileFailure.kind, "invalid_request");

    const stdinFailure = await expectFailure(
      sandbox.runBuildStep({
        files: [],
        entrypoint: ["bun"],
        stdin: "x".repeat(FORGE_SANDBOX_MAX_INPUT_BYTES + 1),
      }),
    );
    assert.equal(stdinFailure.kind, "invalid_request");
    assert.include(stdinFailure.reason, "input cap");
    assert.isEmpty(runner.requests);
  });
});

describe("evaluation runs", () => {
  const files = [{ path: "signal.ts", content: "export const x = 1" }];
  const decodeResult = Schema.decodeUnknownSync(ForgeSignalOutput);

  const quietOutput = JSON.stringify({
    reading: { kind: "ready", regime: "quiet", agreement: 0, eligiblePoolIds: [] },
    diagnostics: [],
  });

  it("decodes schema-valid stdout and fails closed on a pass string", async () => {
    const good = makeScriptedRunner({
      eval: Effect.succeed({ exitCode: 0, stdout: quietOutput, stderr: "", killed: null }),
    });
    const sandboxGood = await sandboxWith(good);
    const decoded = (await Effect.runPromise(
      sandboxGood.runEvaluation({
        files,
        entrypoint: ["eval"],
        stdinJson: JSON.stringify({ pools: [] }),
        decodeResult,
      }),
    )) as { readonly reading: { readonly kind: string } };
    assert.equal(decoded.reading.kind, "ready");

    // The container saying PASS — in prose — is not a result. Ever.
    const liar = makeScriptedRunner({
      eval: Effect.succeed({ exitCode: 0, stdout: "PASS", stderr: "", killed: null }),
    });
    const sandboxLiar = await sandboxWith(liar);
    const failure = await expectFailure(
      sandboxLiar.runEvaluation({
        files,
        entrypoint: ["eval"],
        stdinJson: JSON.stringify({ pools: [] }),
        decodeResult,
      }),
    );
    assert.equal(failure.kind, "invalid_result");
    assert.include(failure.reason, "never a result");
  });

  it("fails closed on malformed evaluation stdin", async () => {
    const runner = makeScriptedRunner();
    const sandbox = await sandboxWith(runner);
    const failure = await expectFailure(
      sandbox.runEvaluation({
        files,
        entrypoint: ["eval"],
        stdinJson: "{not json",
        decodeResult,
      }),
    );
    assert.equal(failure.kind, "invalid_result");
    assert.isEmpty(runner.requests);
  });

  it("passes the pinned image and the evaluation budget to the runner", async () => {
    const runner = makeScriptedRunner({
      eval: Effect.succeed({ exitCode: 0, stdout: quietOutput, stderr: "", killed: null }),
    });
    const sandbox = await sandboxWith(runner);
    await Effect.runPromise(
      sandbox.runEvaluation({
        files,
        entrypoint: ["eval"],
        stdinJson: "{}",
        decodeResult,
      }),
    );
    const request = runner.requests[0];
    assert.isDefined(request);
    assert.equal(request?.imageRef, DIGEST_IMAGE);
    assert.equal(request?.timeoutMs, 2_000);
    assert.equal(request?.outputLimitBytes, FORGE_SANDBOX_MAX_OUTPUT_BYTES);
    assert.deepEqual(
      request?.files.map((file) => file.path),
      ["signal.ts"],
    );
  });
});

it("returns a typed refusal when the host decoder rejects output", async () => {
  const sandbox = await sandboxWith(
    makeScriptedRunner({
      evaluate: Effect.succeed({ exitCode: 0, stdout: "{}", stderr: "", killed: null }),
    }),
  );
  const result = await expectFailure(
    sandbox.runEvaluation({
      files: [],
      entrypoint: ["evaluate"],
      stdinJson: "{}",
      decodeResult: () => {
        throw new Error("invalid shape");
      },
    }),
  );
  assert.equal(result.kind, "invalid_result");
});
