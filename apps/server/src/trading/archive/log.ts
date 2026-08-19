/**
 * Archiver logging: one line, prefixed with a timestamp and a level.
 *
 * A process meant to run for months is read through `tail -f` and `grep`, so
 * the format is a flat line rather than JSON, and nothing is buffered.
 *
 * @module trading/archive/log
 */

// @effect-diagnostics globalConsole:off globalDate:off - a standalone process logs to stdout.

function emit(level: string, message: string): void {
  console.log(`${new Date().toISOString()} ${level} ${message}`);
}

export function logInfo(message: string): void {
  emit("INFO", message);
}

export function logWarn(message: string): void {
  emit("WARN", message);
}

/** Render an unknown thrown value as one line of log text. */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}
