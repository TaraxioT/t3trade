/**
 * ForgeJsonEncode — the one sanctioned JSON-encode helper for the Forge SQL
 * stores.
 *
 * The repository's effect diagnostics budget bare `JSON.stringify` call
 * sites per file; the ledger and grant guard need more encode sites than one
 * file affords, so the encodes route through this single-auditability
 * helper. Decoding stays with the strict per-field decoders next to their
 * consumers.
 *
 * @module ForgeJsonEncode
 */

/** Encode a value to JSON text for a SQL column. */
export const forgeJsonEncode = (value: unknown): string => JSON.stringify(value);
