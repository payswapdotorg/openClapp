import { createHash } from "node:crypto";

/**
 * Maximum number of characters kept when embedding a canonical value in a
 * human-facing detail string.
 */
const SNIPPET_LIMIT = 120;

/**
 * Depth guard for the recursive JSON-safety walk. Values nested deeper than
 * this are reported as errors instead of exhausting the call stack.
 */
const MAX_JSON_DEPTH = 2000;

/** True for plain objects (object literals, JSON.parse output, null prototype). */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Human-readable type name used in validation and diff messages. */
export function describeType(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  if (isPlainObject(value)) {
    return "object";
  }
  if (typeof value === "object") {
    const tag = Object.prototype.toString.call(value);
    const name = tag.slice(8, -1).toLowerCase();
    return name.length > 0 ? name : "object";
  }
  return typeof value;
}

/** Appends an object key to a JSON-style path ("journeys[0]" + "id" -> "journeys[0].id"). */
export function joinKey(path: string, key: string): string {
  return path === "" ? key : `${path}.${key}`;
}

/** Deterministic code-unit string comparison (locale independent). */
export function compareStrings(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

/** Deterministically truncates a canonical JSON string for embedding in details. */
export function snippet(text: string): string {
  return text.length > SNIPPET_LIMIT ? `${text.slice(0, SNIPPET_LIMIT - 3)}...` : text;
}

/** sha256 of a UTF-8 string as lowercase hex (content-defined identity). */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Collects every reason `value` cannot be represented as canonical JSON:
 * undefined, functions, symbols, bigints, non-finite numbers, non-plain
 * objects (Date, Map, class instances, ...), and cyclic references. Never
 * throws; never recurses deeper than MAX_JSON_DEPTH.
 */
export function checkJsonSafety(value: unknown, path: string, errors: string[]): void {
  const ancestors = new WeakSet<object>();
  visit(value, path, 0);

  function visit(current: unknown, currentPath: string, depth: number): void {
    if (depth > MAX_JSON_DEPTH) {
      errors.push(`${currentPath}: not JSON-serializable (nested deeper than ${MAX_JSON_DEPTH})`);
      return;
    }
    switch (typeof current) {
      case "string":
      case "boolean":
        return;
      case "number":
        if (!Number.isFinite(current)) {
          errors.push(`${currentPath}: not JSON-serializable (non-finite number)`);
        }
        return;
      case "undefined":
      case "function":
      case "symbol":
      case "bigint":
        errors.push(`${currentPath}: not JSON-serializable (${typeof current} value)`);
        return;
      case "object": {
        if (current === null) {
          return;
        }
        const node = current as object;
        if (ancestors.has(node)) {
          errors.push(`${currentPath}: not JSON-serializable (cyclic reference)`);
          return;
        }
        ancestors.add(node);
        if (Array.isArray(current)) {
          for (let index = 0; index < current.length; index += 1) {
            visit(current[index], `${currentPath}[${index}]`, depth + 1);
          }
        } else if (isPlainObject(current)) {
          for (const key of Object.keys(current).sort(compareStrings)) {
            visit(current[key], joinKey(currentPath, key), depth + 1);
          }
        } else {
          errors.push(`${currentPath}: not JSON-serializable (${describeType(current)})`);
        }
        ancestors.delete(node);
        return;
      }
    }
  }
}

/** True when every entry of the array is a plain object ("keyless maps"). */
export function arrayEntriesAreKeylessMaps(entries: readonly unknown[]): boolean {
  return entries.every((entry) => isPlainObject(entry));
}

/**
 * Canonical transform of an arbitrary JSON value:
 * - object keys are sorted alphabetically (code-unit order) at every level;
 * - arrays whose entries are all keyless maps are sorted by their canonical
 *   JSON form (their order carries no identity);
 * - all other arrays keep their order.
 * Returns a new value; the input is never mutated.
 */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return canonicalizeArray(
      value,
      arrayEntriesAreKeylessMaps(value) ? "content-sorted" : "ordered",
    );
  }
  if (isPlainObject(value)) {
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort(compareStrings)) {
      output[key] = canonicalize(value[key]);
    }
    return output;
  }
  return value;
}

/** Canonicalizes every entry, then optionally sorts the entries themselves. */
export function canonicalizeArray(
  entries: readonly unknown[],
  mode: "ordered" | "content-sorted",
): unknown[] {
  const canonicalEntries = entries.map((entry) => canonicalize(entry));
  if (mode === "ordered") {
    return canonicalEntries;
  }
  return canonicalEntries
    .map((entry) => ({ entry, key: JSON.stringify(entry) }))
    .sort((left, right) => compareStrings(left.key, right.key))
    .map((pair) => pair.entry);
}

/**
 * Compact canonical JSON of a value, or undefined when the value cannot be
 * canonicalized (non-JSON content). Never throws.
 */
export function canonicalJson(value: unknown): string | undefined {
  try {
    const text = JSON.stringify(canonicalize(value));
    return typeof text === "string" ? text : undefined;
  } catch {
    return undefined;
  }
}
