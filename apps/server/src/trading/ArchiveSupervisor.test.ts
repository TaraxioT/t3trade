// @effect-diagnostics nodeBuiltinImport:off - resolving files the supervisor resolves.
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import type * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { exitSignal, makeArchiveSupervisor, resolveArchiverEntry } from "./ArchiveSupervisor.ts";
import { TradingAccountProjection } from "./TradingAccountProjection.ts";

const withDir = <A>(use: (dir: string) => A): A => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "archive-entry-"));
  try {
    return use(dir);
  } finally {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
};

const urlOf = (dir: string): string => NodeURL.pathToFileURL(NodePath.join(dir, "x.ts")).href;

describe("resolveArchiverEntry", () => {
  // The supervisor and the archiver ship together in two shapes — the source
  // tree, and the packed CLI. A resolver that only knew the first left every
  // packaged install recording nothing, silently, which is exactly what it did
  // until the packed candidate below matched the layout `vp pack` really emits.
  it("finds the archiver beside this module in the source tree", () => {
    const entry = resolveArchiverEntry(import.meta.url);
    assert.isNotNull(entry);
    assert.ok(entry !== null && entry.endsWith(NodePath.join("archive", "main.ts")));
    assert.isTrue(NodeFS.existsSync(entry as string));
  });

  // Packing keeps each entry's source-relative path, so the archiver lands at
  // `trading/archive/main.mjs` under the bundle root — not beside `bin.mjs`,
  // and not as `.js`.
  it("finds the bundled archiver below a packed supervisor", () => {
    withDir((dir) => {
      const packed = NodePath.join(dir, "trading", "archive", "main.mjs");
      NodeFS.mkdirSync(NodePath.dirname(packed), { recursive: true });
      NodeFS.writeFileSync(packed, "");
      assert.equal(resolveArchiverEntry(urlOf(dir)), packed);
    });
  });

  // Better to report "not running, entry not found" than to spawn a path that
  // does not exist and restart it forever.
  it("finds nothing when neither shape is present", () => {
    withDir((dir) => {
      assert.isNull(resolveArchiverEntry(urlOf(dir)));
    });
  });
});

describe("exitSignal", () => {
  // R1-2: the Node spawner reports a signal-terminated child as a failed
  // exit-code read whose message names the signal. The supervisor logs those
  // as information ("archiver exited (signal X)"), not as failures.
  it("finds the signal on the error message or a nested cause", () => {
    assert.strictEqual(
      exitSignal(new Error("Process interrupted due to receipt of signal: 'SIGKILL'")),
      "SIGKILL",
    );
    assert.strictEqual(
      exitSignal({
        message: "SystemError: ChildProcess.exitCode",
        cause: { message: "Process interrupted due to receipt of signal: 'SIGTERM'" },
      }),
      "SIGTERM",
    );
    assert.strictEqual(exitSignal("receipt of signal: 'SIGINT'"), "SIGINT");
  });

  it("returns null for anything that is not a signal death", () => {
    assert.strictEqual(exitSignal(new Error("spawn ENOENT")), null);
    assert.strictEqual(exitSignal(null), null);
    assert.strictEqual(exitSignal(undefined), null);
    assert.strictEqual(exitSignal({ message: 42 }), null);
  });
});

describe("supervisor transitions", () => {
  // A minimal handle: the child "runs" (empty stdout) and exits 0 at once.
  const fakeHandle = (): ChildProcessSpawner.ChildProcessHandle =>
    ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(4242),
      exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
      isRunning: Effect.succeed(true),
      kill: () => Effect.void,
      stdin: Sink.drain,
      stdout: Stream.empty,
      stderr: Stream.empty,
      all: Stream.empty,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
      unref: Effect.succeed(Effect.void),
    });

  // R1-1: the account view refreshes only on the account doorbell, so every
  // supervisor state transition must ring it — and R5-1: the spawned child is
  // told the network the app trades (the default endpoints are testnet).
  it.effect("started and restarting transitions ring the account doorbell", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "archive-supervisor-"));
    const previousHome = process.env["T3CODE_HOME"];
    process.env["T3CODE_HOME"] = dir;

    return Effect.gen(function* () {
      const reasons: Array<string> = [];
      const commands: Array<ChildProcess.Command> = [];
      const latch = yield* Deferred.make<void>();

      const projection = TradingAccountProjection.of({
        view: () => Effect.succeed({ accounts: [], updatedAt: "1970-01-01T00:00:00.000Z" }),
        invalidate: ({ reason }) =>
          Effect.suspend(() => {
            reasons.push(reason);
            return reasons.length >= 2 ? Deferred.succeed(latch, undefined) : Effect.void;
          }),
        changes: Stream.empty,
      });
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.sync(() => {
          commands.push(command);
          return fakeHandle();
        }),
      );

      const supervisor = yield* makeArchiveSupervisor.pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(TradingAccountProjection, projection),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* supervisor.start();
          yield* Deferred.await(latch);
        }),
      );

      assert.deepStrictEqual(reasons.slice(0, 2), ["archiver_started", "archiver_restarting"]);

      // The child is told which network to record — the same testnet the
      // default trading endpoints point at.
      const command = commands[0];
      assert.ok(command !== undefined && command._tag === "StandardCommand");
      if (command === undefined || command._tag !== "StandardCommand") return;
      assert.strictEqual(command.options.env?.["T3TRADE_ARCHIVE_NETWORK"], "testnet");
      assert.strictEqual(command.options.extendEnv, true);
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (previousHome === undefined) {
            delete process.env["T3CODE_HOME"];
          } else {
            process.env["T3CODE_HOME"] = previousHome;
          }
          NodeFS.rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });
});
