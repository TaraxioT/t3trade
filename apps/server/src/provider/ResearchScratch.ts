/**
 * The projectless workspace directory.
 *
 * A thread with no project cwd still needs somewhere to be: a clearly-named
 * per-thread workspace under T3 Trade application state (`stateDir`), never
 * the source checkout and never the installed `userdata` directory that holds
 * archive databases and signer material, so a native coding session attached
 * to nothing never lands in the T3 Trade checkout by accident.
 *
 * The fenced research-scratch directory this module used to manage retired
 * with the market-research persona: a native agent session has its own cwd,
 * sandbox, and cleanup story, and none of them are ours to fence.
 *
 * @module ResearchScratch
 */
// @effect-diagnostics nodeBuiltinImport:off - sync fs by design: a bounded workspace directory, not an Effect service.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { Effect, Schema } from "effect";

/** Root directory name for projectless workspaces, under application state. */
export const PROJECTLESS_WORKSPACES_DIR_NAME = "projectless-workspaces";

/** One thread's projectless workspace: the root, one dir per thread. */
export function projectlessWorkspaceDir(input: {
  readonly stateDir: string;
  readonly threadId: string;
}): string {
  return NodePath.join(input.stateDir, PROJECTLESS_WORKSPACES_DIR_NAME, input.threadId);
}

/** The workspace could not be created, and the caller must refuse to start. */
export class ResearchScratchError extends Schema.TaggedErrorClass<ResearchScratchError>()(
  "ResearchScratchError",
  {
    /** What the caller should relay: the workspace could not be established. */
    detail: Schema.String,
  },
) {}

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
