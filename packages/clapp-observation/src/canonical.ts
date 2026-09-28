import { createHash } from "node:crypto";

/**
 * Deterministic content addressing helpers.
 *
 * Every EvidenceRef.sha256 and EvidenceBundle.rootSha256 produced by this
 * package is computed here, over bytes this code actually holds — never
 * copied from upstream metadata.
 */

/** sha256 hex digest over bytes or text (text digests as UTF-8). */
export const sha256Hex = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");

/** Encodes text as UTF-8 bytes. */
export const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

/**
 * Canonical JSON serialization: object keys sorted recursively, arrays kept
 * in order, no whitespace. Two structurally equal values always serialize to
 * identical bytes regardless of construction order. `undefined` normalizes to
 * `null` so optional fields cannot destabilize digests.
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Canonical JSON encoded as UTF-8 bytes — the standard evidence payload form. */
export const canonicalJsonBytes = (value: unknown): Uint8Array => utf8(canonicalJson(value));
