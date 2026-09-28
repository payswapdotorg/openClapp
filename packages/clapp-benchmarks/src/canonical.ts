/**
 * Deterministic serialization and cloning helpers.
 *
 * Determinism is a gate (docs/clapp/ARCHITECTURE.md): the same benchmark
 * definition must host byte-identical content every time. Every byte a
 * benchmark serves — page bodies, API responses, error payloads — is produced
 * by these canonicalizers, so two structurally equal stores always serialize
 * to identical bytes regardless of key insertion order.
 */

import { createHash } from "node:crypto";

/** sha256 hex digest over bytes or text (text digests as UTF-8). */
export const sha256Hex = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");

/**
 * Canonical JSON serialization: object keys sorted recursively, arrays kept
 * in order, no whitespace. Two structurally equal values always serialize to
 * identical bytes regardless of construction order. `undefined` normalizes
 * to `null` so optional fields cannot destabilize bytes.
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

/**
 * Deep clone of a JSON-safe value. Benchmark definitions, seeds and stores
 * are validated JSON-safe before they reach this function, so the round-trip
 * is lossless and the clone shares nothing with the original.
 */
export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Deeply freezes a JSON-safe value (arrays and plain objects included).
 * Frozen definitions make canonical inventories and hosting snapshots
 * immutable: in-place mutation throws in strict mode instead of drifting
 * what a later reset reproduces.
 */
export function deepFreezeJson<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const entry of value) deepFreezeJson(entry);
    return Object.freeze(value);
  }
  if (typeof value === "object" && value !== null) {
    for (const entry of Object.values(value as Record<string, unknown>)) deepFreezeJson(entry);
    return Object.freeze(value);
  }
  return value;
}

/**
 * Structural JSON-safety check (recursive, bounded by the value itself).
 * Rejects `undefined`, functions, symbols, bigints, NaN, Infinity, class
 * instances and anything else JSON.stringify would silently mangle or drop —
 * a seed that cannot round-trip byte-stably must never enter a benchmark.
 */
export function isJsonSafeValue(value: unknown, path: string): string | null {
  if (value === null) return null;
  switch (typeof value) {
    case "string":
    case "boolean":
      return null;
    case "number":
      return Number.isFinite(value)
        ? null
        : `${path}: numbers must be finite (received ${String(value)})`;
    case "object": {
      if (Array.isArray(value)) {
        for (const [index, entry] of value.entries())
          if (entry === undefined) return `${path}[${index}]: undefined is not JSON-safe`;
        for (const [index, entry] of value.entries()) {
          const problem = isJsonSafeValue(entry, `${path}[${index}]`);
          if (problem !== null) return problem;
        }
        return null;
      }
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null)
        return `${path}: only plain objects are JSON-safe (received a class instance)`;
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        if (entry === undefined) return `${path}.${key}: undefined is not JSON-safe`;
        const problem = isJsonSafeValue(entry, `${path}.${key}`);
        if (problem !== null) return problem;
      }
      return null;
    }
    default:
      return `${path}: ${typeof value} is not JSON-safe`;
  }
}
