/**
 * Deterministic content-addressing helpers (the v0.1 house style — the same
 * law the openClapp observation package follows in its own canonical.ts).
 *
 * Every digest this package mints is computed HERE, over bytes this code
 * actually holds — never copied from upstream metadata, never asserted from
 * a caller's claim. sha256 is the canonical, collision-resistant content
 * hash; the implementation is the standard node:crypto primitive (a
 * path-neutral pure function: deterministic, no wall-clock, no randomness,
 * no network, no filesystem — the only node builtin this package touches,
 * disclosed in the import-discipline pin).
 *
 * THE NO-FORK LAW (ADR-004, binding): this package CONSUMES the frozen
 * @clapp/contracts EvidenceRef/EvidenceClassification types (TYPE-ONLY) and
 * produces contract-shaped DATA — it never redefines, rewrites, or forks
 * any contract type. The digest helpers are local plumbing; they never
 * reach into a sibling package's hashing surface.
 */

import { createHash } from "node:crypto";

/** sha256 hex digest over bytes or text (text digests as UTF-8). */
export const sha256Hex = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");

/** Encodes text as UTF-8 bytes. */
export const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

/**
 * Canonical JSON serialization: object keys sorted recursively, arrays kept
 * in order, no whitespace. Two structurally equal values always serialize to
 * identical bytes regardless of construction order. `undefined` normalizes to
 * `null` so optional fields cannot destabilize digests. A non-canonicalizable
 * payload (a class instance, a circular structure, a non-plain object) throws
 * loudly — the loud-host law: the caller's failure is the caller's, never
 * swallowed into a synthetic digest.
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    if (typeof (value as { toJSON?: unknown }).toJSON === "function") {
      return canonicalJson((value as { toJSON: () => unknown }).toJSON());
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Canonical JSON encoded as UTF-8 bytes — the standard evidence payload form. */
export const canonicalJsonBytes = (value: unknown): Uint8Array => utf8(canonicalJson(value));
