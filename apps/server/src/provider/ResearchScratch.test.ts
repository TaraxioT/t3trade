/**
 * The scratch directory as a bounded place: outside the product tree, under
 * the OS temp root, pruned by age and size. The pruning decision is pure and
 * pinned here; the preparation effect is exercised against the real
 * filesystem in a temporary root, including the refusal path that has to
 * fail the session rather than fall back.
 */
// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off - the scratch directory is a real filesystem place; the tests exercise it as one.
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
  prepareResearchScratch,
  ResearchScratchError,
  RESEARCH_SCRATCH_MAX_BYTES,
  RESEARCH_SCRATCH_RETENTION_MS,
  RESEARCH_SCRATCH_ROOT_DIR_NAME,
  researchScratchDir,
  researchScratchRoot,
  selectScratchDirsToPrune,
  type ScratchEntry,
} from "./ResearchScratch.ts";

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1_000;

const entry = (overrides?: Partial<ScratchEntry>): ScratchEntry => ({
  dir: "/tmp/root/thread_a",
  mtimeMs: NOW - DAY,
  sizeBytes: 1_000,
  ...overrides,
});

describe("where the scratch root lives", () => {
  it("is under the OS temp directory, never the repository or live state", () => {
    const root = researchScratchRoot("/var/folders/xyz/T");
    expect(root).toBe(NodePath.join("/var/folders/xyz/T", RESEARCH_SCRATCH_ROOT_DIR_NAME));
    // The DEFAULT root sits under the OS temp dir; an explicit tmpDir is
    // honoured exactly, and neither ever names application state.
    expect(researchScratchRoot().startsWith(NodeOS.tmpdir())).toBe(true);
    expect(root).not.toContain(".t3trade");
    expect(researchScratchDir({ tmpDir: "/var/folders/xyz/T", threadId: "t1" })).toBe(
      NodePath.join("/var/folders/xyz/T", RESEARCH_SCRATCH_ROOT_DIR_NAME, "t1"),
    );
  });
});

describe("the pruning decision", () => {
  it("keeps fresh, small directories", () => {
    expect(selectScratchDirsToPrune([entry()], NOW)).toEqual([]);
  });

  it("prunes directories older than the retention window", () => {
    const old = entry({
      dir: "/tmp/root/thread_old",
      mtimeMs: NOW - RESEARCH_SCRATCH_RETENTION_MS - 1,
    });
    expect(selectScratchDirsToPrune([old], NOW)).toEqual([old]);
    // Exactly at the window is not yet expired.
    const edge = entry({
      dir: "/tmp/root/thread_edge",
      mtimeMs: NOW - RESEARCH_SCRATCH_RETENTION_MS,
    });
    expect(selectScratchDirsToPrune([edge], NOW)).toEqual([]);
  });

  it("prunes directories over the size cap however fresh they are", () => {
    const huge = entry({ dir: "/tmp/root/thread_huge", sizeBytes: RESEARCH_SCRATCH_MAX_BYTES + 1 });
    expect(selectScratchDirsToPrune([huge], NOW)).toEqual([huge]);
  });
});

describe("prepareResearchScratch", () => {
  it.effect("creates the thread's directory and prunes expired siblings", () =>
    Effect.gen(function* () {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-scratch-test."));
      try {
        // An expired sibling and a live one.
        const expiredAt = new Date(Date.now() - RESEARCH_SCRATCH_RETENTION_MS - 60_000);
        NodeFS.mkdirSync(NodePath.join(root, RESEARCH_SCRATCH_ROOT_DIR_NAME, "thread_gone"), {
          recursive: true,
        });
        NodeFS.writeFileSync(
          NodePath.join(root, RESEARCH_SCRATCH_ROOT_DIR_NAME, "thread_gone", "data.json"),
          "old",
        );
        NodeFS.utimesSync(
          NodePath.join(root, RESEARCH_SCRATCH_ROOT_DIR_NAME, "thread_gone"),
          expiredAt,
          expiredAt,
        );

        const dir = yield* prepareResearchScratch({
          threadId: "thread_new",
          tmpDir: root,
        });
        expect(dir).toBe(NodePath.join(root, RESEARCH_SCRATCH_ROOT_DIR_NAME, "thread_new"));
        expect(NodeFS.existsSync(dir)).toBe(true);
        // The expired sibling is gone; the new one is untouched.
        expect(
          NodeFS.existsSync(NodePath.join(root, RESEARCH_SCRATCH_ROOT_DIR_NAME, "thread_gone")),
        ).toBe(false);
      } finally {
        NodeFS.rmSync(root, { recursive: true, force: true });
      }
    }),
  );

  it.effect("fails closed when the directory cannot be created", () =>
    Effect.gen(function* () {
      // A file squatting on the root path: mkdir fails, and the effect must
      // refuse with the capability error the adapters relay, not fall back.
      const rootFile = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-scratch-block."));
      const blocker = NodePath.join(rootFile, "blocker");
      NodeFS.writeFileSync(blocker, "a file, not a directory");
      try {
        const outcome = yield* prepareResearchScratch({
          threadId: "thread_x",
          tmpDir: blocker,
        }).pipe(Effect.exit);
        assert(Exit.isFailure(outcome));
        // The typed error every adapter converts into a session refusal.
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
});
