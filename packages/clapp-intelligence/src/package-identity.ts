/**
 * Deterministic package identity (CLAPP-W2-005).
 *
 * A package document's identity is (id, normalized version, digest) where
 * digest is the sha256 of the document's canonical JSON serialization:
 * object keys sorted by code-unit order at every level, no whitespace, and
 * the version spelled in its normalized MAJOR.MINOR.PATCH form. Two
 * documents with equal content therefore always produce equal identities
 * (independent of key insertion order or zero-padded version spelling),
 * and any content difference produces a different digest.
 */

import type { ClappPackage } from "@clapp/contracts";
import { compareStrings, isPlainObject, sha256Hex } from "./json.ts";
import { normalizePackageVersion } from "./package-version.ts";

/** Deterministic identity of a package document. */
export interface PackageIdentity {
  /** Package id, verbatim from the document. */
  id: string;
  /** Normalized MAJOR.MINOR.PATCH version ("1.02.0" -> "1.2.0"). */
  version: string;
  /** sha256 (lowercase hex) of the canonical JSON serialization of the document. */
  digest: string;
}

/**
 * Canonical JSON value of a document: a fresh value graph with every object
 * key sorted (code-unit order) and undefined-valued keys dropped (matching
 * JSON serialization semantics). Arrays keep their order — element order is
 * part of the document's content. The input is never mutated.
 */
function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalValue(entry));
  }
  if (isPlainObject(value)) {
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort(compareStrings)) {
      if (value[key] === undefined) {
        continue;
      }
      output[key] = canonicalValue(value[key]);
    }
    return output;
  }
  return value;
}

/**
 * Canonical JSON serialization of a package document: sorted keys, no
 * whitespace, version in normalized form. Returns undefined when the value
 * cannot be serialized as JSON (non-JSON content); never throws.
 */
export function canonicalPackageJson(doc: unknown): string | undefined {
  const normalized =
    isPlainObject(doc) && typeof doc.version === "string"
      ? { ...doc, version: normalizePackageVersion(doc.version) }
      : doc;
  try {
    const text = JSON.stringify(canonicalValue(normalized));
    return typeof text === "string" ? text : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Deterministic identity of a package document: id + normalized version +
 * sha256 of the canonical JSON serialization. Documents with equal content
 * produce equal identities; any content difference produces a different
 * digest. Throws only when the document is not JSON-serializable at all
 * (validation rejects such documents before they reach the registry).
 */
export function packageIdentity(doc: ClappPackage): PackageIdentity {
  const canonical = canonicalPackageJson(doc);
  if (canonical === undefined) {
    throw new Error("cannot compute package identity of a non-JSON-serializable document");
  }
  return {
    id: doc.id,
    version: normalizePackageVersion(doc.version),
    digest: sha256Hex(canonical),
  };
}
