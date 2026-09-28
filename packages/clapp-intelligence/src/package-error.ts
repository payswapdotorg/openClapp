/**
 * Typed errors for the CLAPP package registry (CLAPP-W2-005).
 *
 * The registry fails closed: every failure is raised (or returned) as one of
 * these typed errors carrying `name`, `message` and structured `details`.
 * It never silently returns malformed state.
 *
 * `PackageValidationError` is the per-violation record: validation collects
 * ALL violations of a document (the aggregate is the returned array), each
 * one pinpointing a JSON-pointer-style path, the constraint that was not
 * met, and the offending value (truncated).
 */

/**
 * One schema violation in a package document.
 *
 * - `path`: JSON-pointer-style path relative to the document root, using "/"
 *   as the separator without a leading slash ("package/id",
 *   "package/capabilities/1", "" for the root itself).
 * - `expected`: names the constraint that was not met ("string", "object",
 *   "array", "required", "\"0.1\"", "MAJOR.MINOR.PATCH numeric version", ...).
 * - `actual`: describes the offending value, truncated to 120 characters.
 */
export class PackageValidationError extends Error {
  /** JSON-pointer-style path of the offending value ("package/id"). */
  readonly path: string;
  /** Names the constraint that was not met. */
  readonly expected: string;
  /** Describes the offending value (truncated to 120 characters). */
  readonly actual: string;
  /** Structured details of this violation. */
  readonly details: { path: string; expected: string; actual: string };

  constructor(path: string, expected: string, actual: string) {
    super(`package document: at "${path}" expected ${expected}, got ${actual}`);
    this.name = "PackageValidationError";
    this.path = path;
    this.expected = expected;
    this.actual = actual;
    this.details = { path, expected, actual };
  }
}

/** Why a registration conflicted with the registry's existing state. */
export type PackageConflictKind =
  /** Same (id, version) already registered with different content. */
  | "content-conflict"
  /** The version is not strictly greater than every existing version of the id. */
  | "version-regression";

/** Structured details for {@link PackageConflictError}. */
export interface PackageConflictDetails {
  id: string;
  version: string;
  kind: PackageConflictKind;
  /** Highest version already registered for the id (version-regression only). */
  latestVersion?: string;
  /** Content digest of the stored document (content-conflict only). */
  existingDigest?: string;
  /** Content digest of the rejected document (content-conflict only). */
  attemptedDigest?: string;
}

/**
 * A registration attempt conflicts with the registry's existing state:
 * either the same (id, version) is already registered with different
 * content, or the version does not strictly increase the id's lineage.
 */
export class PackageConflictError extends Error {
  /** Structured details of the conflict. */
  readonly details: PackageConflictDetails;

  constructor(details: PackageConflictDetails) {
    const message =
      details.kind === "content-conflict"
        ? `package ${details.id}@${details.version} is already registered with different content`
        : `package ${details.id}@${details.version} does not increase the version lineage (latest registered version is ${details.latestVersion ?? "unknown"})`;
    super(message);
    this.name = "PackageConflictError";
    this.details = details;
  }
}

/** Why an immutable (promoted) (id, version) pair was touched. */
export type PackageImmutabilityReason =
  /** register() attempted to overwrite a promoted (id, version) with different content. */
  | "register-overwrite"
  /** promote() was called again on an already-promoted (id, version) with different evidence. */
  | "re-promotion";

/** Structured details for {@link PackageImmutabilityError}. */
export interface PackageImmutabilityDetails {
  id: string;
  version: string;
  reason: PackageImmutabilityReason;
  /** Content digest of the promoted document, when known. */
  promotedDigest?: string;
}

/**
 * A promoted (id, version) pair is immutable: any attempt to overwrite it
 * (via register with different content) or to re-promote it (with different
 * evidence) raises this error. The stored promoted document is untouched.
 */
export class PackageImmutabilityError extends Error {
  /** Structured details of the immutability violation. */
  readonly details: PackageImmutabilityDetails;

  constructor(details: PackageImmutabilityDetails) {
    const action = details.reason === "register-overwrite" ? "overwriting" : "re-promoting";
    super(
      `package ${details.id}@${details.version} is promoted and immutable; ${action} it with different content is not allowed`,
    );
    this.name = "PackageImmutabilityError";
    this.details = details;
  }
}

/** Structured details for {@link PackageNotFoundError}. */
export interface PackageNotFoundDetails {
  id: string;
  version: string;
}

/**
 * The referenced (id, version) is not registered (or promoted) at all.
 * Mutation of an unknown package fails closed instead of creating state.
 */
export class PackageNotFoundError extends Error {
  /** Structured details of the miss. */
  readonly details: PackageNotFoundDetails;

  constructor(details: PackageNotFoundDetails) {
    super(`package ${details.id}@${details.version} is not registered`);
    this.name = "PackageNotFoundError";
    this.details = details;
  }
}
