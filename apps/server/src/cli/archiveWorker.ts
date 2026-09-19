import * as Effect from "effect/Effect";
import { Command } from "effect/unstable/cli";
import { runArchiveWorker } from "../trading/archive/worker.ts";

// Executable installs host the archiver themselves because no Node or sibling script is available.
export const archiveWorkerCommand = Command.make("__archive-worker").pipe(
  Command.unlisted,
  Command.withHandler(() => Effect.promise(runArchiveWorker)),
);
