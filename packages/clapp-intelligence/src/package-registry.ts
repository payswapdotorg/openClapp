/**
 * Package registry (CLAPP-W2-005).
 *
 * Deterministic, fail-closed package registry over a narrow PackageStore
 * port. All rules of the frozen W2-005 contract:
 *
 * - register validates first (unknown/mismatched schemaVersion and every
 *   other schema violation come back as collected errors, never stored);
 * - byte-identical re-registration is idempotent: same identity, no
 *   duplicate rows;
 * - the same (id, version) with different content is a typed
 *   PackageConflictError (the original stays untouched);
 * - a new version is accepted only when it is GREATER than every existing
 *   version of the id (no downgrades — also a PackageConflictError);
 * - promote turns a registered candidate into an immutable promoted
 *   document carrying a `promotion` record in provenance; once promoted,
 *   the (id, version) pair is immutable — overwriting via register or
 *   re-promoting with different evidence raises PackageImmutabilityError
 *   and the stored promoted document stays untouched; re-promoting with
 *   byte-identical evidence is the one idempotent no-op and returns the
 *   stored document;
 * - promotion of an unregistered (id, version) raises
 *   PackageNotFoundError and leaves the registry unchanged;
 * - get/list/history are deterministic: list orders by (id, version),
 *   history orders by version, unknown filters return empty results.
 */

import type { ClappPackage } from "@clapp/contracts";
import { compareStrings, isPlainObject } from "./json.ts";
import {
  PackageConflictError,
  PackageImmutabilityError,
  PackageNotFoundError,
  type PackageValidationError,
} from "./package-error.ts";
import { type PackageIdentity, packageIdentity } from "./package-identity.ts";
import { validatePackageDocument } from "./package-schema.ts";
import type { PackageStatus, PackageStore, PackageStoreRecord } from "./package-store.ts";
import { comparePackageVersions, normalizePackageVersion } from "./package-version.ts";

/** Evidence recorded into provenance when a candidate is promoted. */
export interface PromotionEvidence {
  /** ISO-8601 timestamp of the verification that justified promotion. */
  verifiedAt: string;
  /** Id of the verification run that justified promotion. */
  verificationRunId: string;
  /** Optional free-form notes preserved next to the promotion record. */
  provenanceNotes?: string[];
}

/** Deterministic filter for registry queries. */
export interface PackageListFilter {
  /** Exact category match (unknown categories return empty). */
  category?: string;
  /** Match when the package's capabilities array contains the value. */
  capability?: string;
  /** Match when the package's supportedTargets array contains the value. */
  target?: string;
  /** Candidate/promoted lifecycle filter. */
  status?: PackageStatus;
}

/** register() result: the identity on success, every violation otherwise. */
export type PackageRegistrationResult =
  | { ok: true; identity: PackageIdentity }
  | { ok: false; errors: PackageValidationError[] };

/** The W2-005 package registry surface (foundation for W2-006/007/008). */
export interface PackageRegistry {
  /**
   * Validates the document, then stores it as a candidate keyed by its
   * identity coordinate. Idempotent for identical content (same identity,
   * no duplicate rows); typed conflict for the same (id, version) with
   * different content (or a promoted pair — then immutable); typed
   * conflict when the version does not strictly increase the id's lineage.
   * Validation failures are returned, never thrown.
   */
  register(doc: unknown): PackageRegistrationResult;
  /**
   * Promotes a registered candidate to an immutable promoted version,
   * recording the evidence in provenance.promotion. Unregistered
   * (id, version) fails closed with PackageNotFoundError. Re-promotion
   * with identical evidence is an idempotent no-op; with different
   * evidence it raises PackageImmutabilityError.
   */
  promote(id: string, version: string, evidence: PromotionEvidence): ClappPackage;
  /** Returns the registered OR promoted document, or null. */
  get(id: string, version: string): ClappPackage | null;
  /**
   * Deterministically ordered (id, then version) documents matching the
   * filter. Unknown categories (or any non-matching filter) return empty,
   * never an error.
   */
  list(filter?: PackageListFilter): ClappPackage[];
  /** Every version of an id in version order, candidates and promoted together. */
  history(id: string): ClappPackage[];
}

/** Creates a package registry over the given (dumb) store port. */
export function createPackageRegistry(store: PackageStore): PackageRegistry {
  return {
    register(doc: unknown): PackageRegistrationResult {
      const validated = validatePackageDocument(doc);
      if (!validated.ok) {
        return { ok: false, errors: validated.errors };
      }
      const value = validated.value;
      const identity = packageIdentity(value);
      const key = { id: value.id, version: identity.version };

      const existing = readRecord(store, key.id, key.version);
      if (existing !== null) {
        if (existing.identity.digest === identity.digest) {
          // Byte-identical content: idempotent, no duplicate rows.
          return { ok: true, identity: { ...existing.identity } };
        }
        if (existing.status === "promoted") {
          throw new PackageImmutabilityError({
            id: key.id,
            version: key.version,
            reason: "register-overwrite",
            promotedDigest: existing.identity.digest,
          });
        }
        throw new PackageConflictError({
          id: key.id,
          version: key.version,
          kind: "content-conflict",
          existingDigest: existing.identity.digest,
          attemptedDigest: identity.digest,
        });
      }

      // A new version must be strictly greater than every existing version.
      const records = store.list().map((record) => checkRecordWellFormed(record, "register"));
      let latest: string | undefined;
      for (const record of records) {
        if (record.key.id !== key.id) {
          continue;
        }
        if (latest === undefined || comparePackageVersions(record.key.version, latest) > 0) {
          latest = record.key.version;
        }
      }
      if (latest !== undefined && comparePackageVersions(key.version, latest) <= 0) {
        throw new PackageConflictError({
          id: key.id,
          version: key.version,
          kind: "version-regression",
          latestVersion: latest,
        });
      }

      const record: PackageStoreRecord = { key, identity, document: value, status: "candidate" };
      store.put(record);
      return { ok: true, identity: { ...identity } };
    },

    promote(id: string, version: string, evidence: PromotionEvidence): ClappPackage {
      assertValidEvidence(evidence);
      const normalized = normalizePackageVersion(version);
      const record = readRecord(store, id, normalized);
      if (record === null) {
        throw new PackageNotFoundError({ id, version: normalized });
      }
      const promoted = buildPromotedDocument(record.document, evidence);
      const promotedIdentity = packageIdentity(promoted);
      if (record.status === "promoted") {
        // Identical evidence reproduces the stored document byte-for-byte:
        // idempotent no-op. Different evidence is an immutability violation.
        if (promotedIdentity.digest === record.identity.digest) {
          return deepCopyJson(record.document);
        }
        throw new PackageImmutabilityError({
          id: record.key.id,
          version: record.key.version,
          reason: "re-promotion",
          promotedDigest: record.identity.digest,
        });
      }
      store.put({
        key: record.key,
        identity: promotedIdentity,
        document: promoted,
        status: "promoted",
      });
      return deepCopyJson(promoted);
    },

    get(id: string, version: string): ClappPackage | null {
      const record = readRecord(store, id, normalizePackageVersion(version));
      return record === null ? null : deepCopyJson(record.document);
    },

    list(filter?: PackageListFilter): ClappPackage[] {
      const { category, capability, target, status } = filter ?? {};
      const records = store
        .list()
        .map((record) => checkRecordWellFormed(record, "list"))
        .filter(
          (record) =>
            (category === undefined || record.document.category === category) &&
            (capability === undefined || record.document.capabilities.includes(capability)) &&
            (target === undefined || record.document.supportedTargets.includes(target)) &&
            (status === undefined || record.status === status),
        )
        .sort(
          (left, right) =>
            compareStrings(left.key.id, right.key.id) ||
            comparePackageVersions(left.key.version, right.key.version),
        );
      return records.map((record) => deepCopyJson(record.document));
    },

    history(id: string): ClappPackage[] {
      const records = store
        .list()
        .map((record) => checkRecordWellFormed(record, "history"))
        .filter((record) => record.key.id === id)
        .sort((left, right) => comparePackageVersions(left.key.version, right.key.version));
      return records.map((record) => deepCopyJson(record.document));
    },
  };
}

/** Reads one record under its normalized key; null when absent. */
function readRecord(store: PackageStore, id: string, version: string): PackageStoreRecord | null {
  const record = store.get({ id, version });
  if (!record) {
    return null;
  }
  return checkRecordWellFormed(record, `get ${id}@${version}`);
}

/**
 * Verifies a store record is coherent (document (id, normalized version)
 * matches the key, valid status, identity aligned with the key) and
 * returns it; throws when the store returned malformed state — the
 * registry never silently builds on state it cannot trust.
 */
function checkRecordWellFormed(record: unknown, context: string): PackageStoreRecord {
  const raw = record as
    | { document?: unknown; key?: unknown; identity?: unknown; status?: unknown }
    | null
    | undefined;
  const document = raw?.document;
  const key = raw?.key;
  const identity = raw?.identity;
  const status = raw?.status;
  const documentRecord = isPlainObject(document) ? document : null;
  const keyRecord = isPlainObject(key) ? key : null;
  const identityRecord = isPlainObject(identity) ? identity : null;
  const coherent =
    documentRecord !== null &&
    typeof documentRecord.id === "string" &&
    typeof documentRecord.version === "string" &&
    keyRecord !== null &&
    keyRecord.id === documentRecord.id &&
    keyRecord.version === normalizePackageVersion(documentRecord.version) &&
    identityRecord !== null &&
    identityRecord.id === keyRecord.id &&
    identityRecord.version === keyRecord.version &&
    typeof identityRecord.digest === "string" &&
    (status === "candidate" || status === "promoted");
  if (!coherent) {
    const described =
      keyRecord !== null ? `${String(keyRecord.id)}@${String(keyRecord.version)}` : "unknown key";
    throw new Error(
      `package store returned a malformed record for ${described} (while: ${context}); failing closed instead of building registry state on it`,
    );
  }
  return record as PackageStoreRecord;
}

/** Builds the promoted document: content preserved, promotion evidence recorded. */
function buildPromotedDocument(document: ClappPackage, evidence: PromotionEvidence): ClappPackage {
  const copy = deepCopyJson(document);
  const promotion: Record<string, unknown> = {
    verifiedAt: evidence.verifiedAt,
    verificationRunId: evidence.verificationRunId,
  };
  if (evidence.provenanceNotes !== undefined) {
    // Copy the array so later caller mutations cannot reach registry state.
    promotion.provenanceNotes = [...evidence.provenanceNotes];
  }
  return { ...copy, provenance: { ...copy.provenance, promotion } };
}

/** Fails closed on malformed promotion evidence (caller bug, TypeError). */
function assertValidEvidence(evidence: PromotionEvidence): void {
  const record: unknown = evidence;
  if (!isPlainObject(record)) {
    throw new TypeError("promotion evidence must be an object");
  }
  if (typeof record.verifiedAt !== "string" || record.verifiedAt.length === 0) {
    throw new TypeError("promotion evidence.verifiedAt must be a non-empty string");
  }
  if (typeof record.verificationRunId !== "string" || record.verificationRunId.length === 0) {
    throw new TypeError("promotion evidence.verificationRunId must be a non-empty string");
  }
  const notes = record.provenanceNotes;
  if (notes !== undefined) {
    if (!Array.isArray(notes) || !notes.every((note) => typeof note === "string")) {
      throw new TypeError("promotion evidence.provenanceNotes must be an array of strings");
    }
  }
}

/** Detached deep copy of an already-validated JSON value. */
function deepCopyJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
