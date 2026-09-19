import { runArchiveWorker } from "./worker.ts";
import { describeError, logWarn } from "./log.ts";

await runArchiveWorker().catch((error: unknown) => {
  logWarn(`archiver: fatal — ${describeError(error)}`);
  process.exitCode = 1;
});
