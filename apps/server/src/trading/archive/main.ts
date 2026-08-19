/**
 * Entry point for the market archiver: `bun run archive` from `apps/server`.
 *
 * Opens (or creates) the archive, applies its schema, and hands control to
 * the loop. The only other job here is a clean shutdown — on SIGINT or
 * SIGTERM the loop is asked to stop after the tick it is in, and the database
 * handle is closed so WAL is checkpointed rather than left for recovery.
 *
 * The archive's value compounds with uptime. Nothing in here is a one-shot
 * job; the intended state of this process is "running".
 *
 * @module trading/archive/main
 */

// @effect-diagnostics globalTimers:off - a standalone always-on process.
import { runArchiver } from "./archiver.ts";
import { archiveDatabasePath } from "./config.ts";
import { openArchiveDatabase } from "./db.ts";
import { makeInfoClient } from "./info.ts";
import { describeError, logInfo, logWarn } from "./log.ts";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const path = archiveDatabasePath();
  const db = openArchiveDatabase(path);
  logInfo(`archiver: mainnet public data -> ${path}`);

  // The first signal asks the loop to stop at its next checkpoint; a second
  // one leaves immediately. Leaving immediately is safe — every write is an
  // idempotent upsert and startup re-fetches its window — so an operator in a
  // hurry never has to reach for `kill -9`.
  let running = true;
  const stop = (signal: string) => {
    if (!running) {
      logInfo(`archiver: second ${signal}, exiting now`);
      process.exit(0);
    }
    logInfo(`archiver: ${signal} received, stopping at the next checkpoint`);
    running = false;
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  try {
    await runArchiver({
      db,
      info: makeInfoClient(),
      shouldContinue: () => running,
      sleep,
    });
  } finally {
    db.close();
    logInfo("archiver: stopped");
  }
}

await main().catch((error: unknown) => {
  logWarn(`archiver: fatal — ${describeError(error)}`);
  process.exitCode = 1;
});
