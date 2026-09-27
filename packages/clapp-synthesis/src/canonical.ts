/**
 * Canonical JSON form shared by the synthesis planner, serializer and validator.
 *
 * Canonicalization sorts object keys alphabetically at every level while
 * keeping arrays in their semantic order, so deep-equal values serialize to
 * identical bytes regardless of key-insertion order.
 */

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((element) => canonicalize(element));
  }
  if (isPlainObject(value)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const child = value[key];
      if (child === undefined) {
        continue; // JSON.stringify drops undefined-valued properties.
      }
      sorted[key] = canonicalize(child);
    }
    return sorted;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  const text = JSON.stringify(canonicalize(value));
  return text === undefined ? "null" : text;
}
