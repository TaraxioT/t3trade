/**
 * The projectless workspace as a real filesystem place: under application
 * state, one directory per thread, and a preparation effect that refuses
 * rather than falls back into the server's own checkout.
 */
// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off - the workspace is a real filesystem place; the tests exercise it as one.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import { Effect } from "effect";
import * as Exit from "effect/Exit";

import {
  prepareProjectlessWorkspace,
  PROJECTLESS_WORKSPACES_DIR_NAME,
  projectlessWorkspaceDir,
  ResearchScratchError,
} from "./ResearchScratch.ts";

describe("the projectless workspace", () => {
  it.effect("places one thread's workspace under application state, not the checkout", () =>
    Effect.gen(function* () {
      const stateDir = NodePath.join(NodeOS.tmpdir(), `t3trade-projectless-test-${Date.now()}`);
      const threadId = "thread-projectless-1";
      const dir = yield* prepareProjectlessWorkspace({ stateDir, threadId });
      assert.equal(dir, projectlessWorkspaceDir({ stateDir, threadId }));
      assert.equal(
        NodePath.relative(stateDir, dir),
        NodePath.join(PROJECTLESS_WORKSPACES_DIR_NAME, threadId),
      );
      assert.ok(NodeFS.statSync(dir).isDirectory());
      NodeFS.rmSync(stateDir, { recursive: true, force: true });
    }),
  );

  it("gives each thread its own directory", () => {
    const stateDir = "/state";
    expect(projectlessWorkspaceDir({ stateDir, threadId: "a" })).not.toBe(
      projectlessWorkspaceDir({ stateDir, threadId: "b" }),
    );
  });

  it.effect("fails closed when the directory cannot be created", () =>
    Effect.gen(function* () {
      // A file squatting on the state path: mkdir fails, and the effect must
      // refuse with the typed error the adapters relay, not fall back to the
      // server's own working directory.
      const rootFile = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-projectless-block."));
      const blocker = NodePath.join(rootFile, "blocker");
      NodeFS.writeFileSync(blocker, "a file, not a directory");
      try {
        const outcome = yield* prepareProjectlessWorkspace({
          stateDir: blocker,
          threadId: "thread_x",
        }).pipe(Effect.exit);
        assert(Exit.isFailure(outcome));
        const found = Exit.findError(outcome);
        assert.equal(found._tag, "Success");
        if (found._tag !== "Success") return;
        const failure = found.success;
        expect(failure).toBeInstanceOf(ResearchScratchError);
        expect((failure as ResearchScratchError).detail).toContain("refuses to start");
      } finally {
        NodeFS.rmSync(rootFile, { recursive: true, force: true });
      }
    }),
  );
});
