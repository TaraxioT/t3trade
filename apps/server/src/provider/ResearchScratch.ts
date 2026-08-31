/**
 * The research scratch directory: bounded data collection outside the product
 * tree.
 *
 * A market_research conversation sometimes genuinely wants code: normalizing
 * a table of conference dates, inspecting a fetched page's structure,
 * reconciling two sources. That work is allowed, but only inside a fresh
 * scratch directory that is outside the repository, outside the live
 * application state (`~/.t3trade` userdata holds the archive SQLite files
 * and signer material, and a scratch script has no business beside either),
 * and bounded by explicit limits rather than good intentions.
 *
 * The limits here are typed constants with a pruning decision that is pure
 * and tested: a scratch directory lives at most {@link RESEARCH_SCRATCH_RETENTION_MS},
 * holds at most {@link RESEARCH_SCRATCH_MAX_BYTES}, and the whole root sits
 * under the OS temporary directory, which the operating system sweeps on its
 * own schedule as a final backstop. Runtime and network are bounded where
 * they are enforced at all: the fenced runtimes that can execute code do so
 * inside their own sandbox with no network by default, and the ones that
 * cannot express that safely get no code execution at all.
 *
 * Scratch output may become a cited attachment or a proposed import through
 * the typed tools; it may never become an undeclared price provider, a
 * migration, a manifest edit, or a write into the archive. Nothing in this
 * module knows how to do any of that: it only makes a bounded place.
 *
 * @module ResearchScratch
 */
// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off - sync fs and wall-clock by design: a bounded scratch directory, not an Effect service.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { Effect, Schema } from "effect";

/** Root directory name under the OS temp dir; per-session dirs live inside. */
export const RESEARCH_SCRATCH_ROOT_DIR_NAME = "t3trade-research-scratch";

/** How long an unused scratch directory survives before pruning. */
export const RESEARCH_SCRATCH_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

/** How much one scratch directory may hold before pruning takes it. */
export const RESEARCH_SCRATCH_MAX_BYTES = 200 * 1_024 * 1_024;

/** Where the whole scratch root lives: the OS temp dir, never the repo or state. */
export function researchScratchRoot(tmpDir: string = NodeOS.tmpdir()): string {
  return NodePath.join(tmpDir, RESEARCH_SCRATCH_ROOT_DIR_NAME);
}

/** One session's scratch directory: the root, one dir per thread. */
export function researchScratchDir(input: {
  readonly tmpDir?: string | undefined;
  readonly threadId: string;
}): string {
  return NodePath.join(researchScratchRoot(input.tmpDir ?? NodeOS.tmpdir()), input.threadId);
}

/** What pruning decided about one scratch directory. */
export interface ScratchEntry {
  readonly dir: string;
  readonly mtimeMs: number;
  readonly sizeBytes: number;
}

/**
 * Which scratch directories to remove. Pure: the walk and the removal are
 * filesystem work, but the policy is a decision over three numbers, and a
 * decision over numbers is exactly the thing to pin in a test.
 *
 * A directory is removed when it is older than the retention window OR
 * larger than the size cap. Age uses the directory's own mtime, which every
 * write into it refreshes on most platforms, so an active directory never
 * ages out from under the session using it.
 */
export function selectScratchDirsToPrune(
  entries: ReadonlyArray<ScratchEntry>,
  now: number,
): ReadonlyArray<ScratchEntry> {
  return entries.filter(
    (entry) =>
      now - entry.mtimeMs > RESEARCH_SCRATCH_RETENTION_MS ||
      entry.sizeBytes > RESEARCH_SCRATCH_MAX_BYTES,
  );
}

/** Best-effort directory size, zero when the walk fails. */
const dirSizeBytes = (dir: string): number => {
  let total = 0;
  const walk = (current: string): void => {
    let names: ReadonlyArray<string>;
    try {
      names = NodeFS.readdirSync(current);
    } catch {
      return;
    }
    for (const name of names) {
      const full = NodePath.join(current, name);
      try {
        const stats = NodeFS.statSync(full);
        if (stats.isDirectory()) walk(full);
        else total += stats.size;
      } catch {
        // A file that vanished mid-walk contributes nothing.
      }
    }
  };
  walk(dir);
  return total;
};

export class ResearchScratchError extends Schema.TaggedErrorClass<ResearchScratchError>()(
  "ResearchScratchError",
  {
    /** What the caller should relay: the fence could not be established. */
    detail: Schema.String,
  },
) {}

/**
 * Create this thread's scratch directory and prune expired or oversized
 * siblings. Fails — rather than falling back — when the directory cannot be
 * created: a fenced session without its scratch cwd is a session running
 * somewhere the fence does not reach, and the caller must refuse it.
 *
 * Pruning is best-effort on purpose: an old directory that will not die is
 * hygiene, not a boundary.
 */
export const prepareResearchScratch: (input: {
  readonly threadId: string;
  readonly tmpDir?: string | undefined;
  readonly now?: number | undefined;
}) => Effect.Effect<string, ResearchScratchError> = (input) =>
  Effect.gen(function* () {
    const root = researchScratchRoot(input.tmpDir ?? NodeOS.tmpdir());
    const dir = NodePath.join(root, input.threadId);
    yield* Effect.try({
      try: () => NodeFS.mkdirSync(dir, { recursive: true }),
      catch: (cause) =>
        new ResearchScratchError({
          detail:
            `the research scratch directory could not be created at ${dir}: ${String(cause)}. ` +
            "A market_research session refuses to start rather than run with a writable checkout.",
        }),
    });
    // Prune siblings: age and size, best effort, never fatal. A pruning
    // defect is a defect, not a scratch error: the caller still gets the
    // directory it asked for.
    yield* Effect.sync(() => {
      const now = input.now ?? Date.now();
      const entries: Array<ScratchEntry> = [];
      try {
        for (const name of NodeFS.readdirSync(root)) {
          const candidate = NodePath.join(root, name);
          try {
            const stats = NodeFS.statSync(candidate);
            if (!stats.isDirectory()) continue;
            entries.push({
              dir: candidate,
              mtimeMs: stats.mtimeMs,
              sizeBytes: dirSizeBytes(candidate),
            });
          } catch {
            // Unreadable entries are left for the OS temp sweeper.
          }
        }
      } catch {
        // An unreadable root is the OS temp sweeper's problem, not this
        // session's: the scratch directory itself already exists.
        return;
      }
      for (const doomed of selectScratchDirsToPrune(entries, now)) {
        NodeFS.rmSync(doomed.dir, { recursive: true, force: true });
      }
    }).pipe(Effect.catchDefect(() => Effect.void));
    return dir;
  });

/**
 * Root directory name for projectless workspaces, under T3 Trade application
 * state (`stateDir`), never the source checkout and never the installed
 * `userdata` directory that holds archive databases and signer material.
 */
export const PROJECTLESS_WORKSPACES_DIR_NAME = "projectless-workspaces";

/**
 * A thread with no project cwd still needs somewhere to be: a clearly-named
 * per-thread workspace under application state, so a native coding session
 * attached to nothing never lands in the T3 Trade source checkout by
 * accident.
 */
export function projectlessWorkspaceDir(input: {
  readonly stateDir: string;
  readonly threadId: string;
}): string {
  return NodePath.join(input.stateDir, PROJECTLESS_WORKSPACES_DIR_NAME, input.threadId);
}

/**
 * Create this thread's projectless workspace. Fails rather than falling back
 * when the directory cannot be created: the only fallback a provider offers
 * is its own process cwd, which is the T3 Trade checkout, and a session must
 * never run there just because it has no project.
 */
export const prepareProjectlessWorkspace: (input: {
  readonly stateDir: string;
  readonly threadId: string;
}) => Effect.Effect<string, ResearchScratchError> = (input) =>
  Effect.gen(function* () {
    const dir = projectlessWorkspaceDir(input);
    yield* Effect.try({
      try: () => NodeFS.mkdirSync(dir, { recursive: true }),
      catch: (cause) =>
        new ResearchScratchError({
          detail:
            `the projectless workspace could not be created at ${dir}: ${String(cause)}. ` +
            "A thread without a project refuses to start rather than run in the server's own checkout.",
        }),
    });
    return dir;
  });
