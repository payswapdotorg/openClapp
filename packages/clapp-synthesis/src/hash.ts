import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical.ts";

/**
 * Deterministic content hash: sha256 over the canonical JSON form. Values that
 * are deep-equal regardless of key-insertion order always hash identically,
 * which keeps derived ids stable across planning runs.
 */
export function contentHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
