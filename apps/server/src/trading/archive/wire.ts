/**
 * Coercions from the Info API's JSON to the numbers the archive stores.
 *
 * Hyperliquid quotes every price, size, and rate as a decimal string. These
 * helpers turn one into a number or report that it could not be, so a caller
 * can skip a malformed row instead of writing a NaN into the archive and
 * discovering it months later.
 *
 * @module trading/archive/wire
 */

/** A JSON object, before anything is known about its fields. */
export type WireRecord = Record<string, unknown>;

export function asRecord(value: unknown): WireRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as WireRecord)
    : null;
}

export function asArray(value: unknown): ReadonlyArray<unknown> | null {
  return Array.isArray(value) ? value : null;
}

/** A finite number from a JSON number or decimal string; `null` otherwise. */
export function asNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** An integer from a JSON number or string; `null` when it is neither. */
export function asInteger(value: unknown): number | null {
  const parsed = asNumber(value);
  return parsed !== null && Number.isInteger(parsed) ? parsed : null;
}

export function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
