import { createHash } from "node:crypto";

/**
 * @clapp/native-linux — deterministic content-addressing helpers (in-package).
 *
 * Every LinuxEnvironment fingerprint, LinuxObservation.screenDigest, and
 * EvidenceRef.sha256 produced by this package is computed here, over bytes
 * this code actually holds — never copied from upstream metadata, never
 * derived from a wall clock. The module is a pure in-package copy of the
 * canonical serialization used by `@clapp/observation` (the house seam style
 * the ADR-004 seam pattern follows); it stays in-package so the
 * import-discipline pin (TYPE-ONLY `@clapp/contracts` + in-package modules)
 * holds without exception.
 *
 * Discipline (binding — ADR-004 hard rules): no clock, no randomness, no
 * network, no filesystem, no global state. `node:crypto` is the only node
 * builtin the package touches — a pure, deterministic hash primitive, not an
 * I/O surface; the import-discipline test pins this in `tests/`.
 */

/** sha256 hex digest over bytes or text (text digests as UTF-8). */
export const sha256Hex = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");

/** Encodes text as UTF-8 bytes. */
export const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

/**
 * Canonical JSON serialization: object keys sorted recursively, arrays kept
 * in order, no whitespace. Two structurally equal values always serialize to
 * identical bytes regardless of construction order. `undefined` normalizes
 * to `null` so optional fields cannot destabilize digests. Throws on
 * non-plain payloads (class instances, circular refs) — the loud-host law:
 * the caller's failure is the caller's, never swallowed into a synthetic
 * digest.
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
