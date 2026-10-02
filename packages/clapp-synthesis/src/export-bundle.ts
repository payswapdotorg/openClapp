import type { ClappPackage } from "@clapp/contracts";
import { CLAPP_CONTRACT_VERSION } from "@clapp/contracts";
import { canonicalJson, isPlainObject } from "./canonical.ts";
import type { CompositionPlan } from "./composition.ts";
import type { E2eAcceptanceDigest } from "./e2e-acceptance.ts";
import { contentHash } from "./hash.ts";

/**
 * CLAPP-W3-010 — export/deployment packaging (wave 10 lane 6).
 *
 * The deployment half of the reconstruction chain: everything before this
 * module ends at the paired-verification / end-to-end acceptance digest —
 * after verification the candidate exists only as in-process structures.
 * `buildExportBundle` assembles a RECONSTRUCTED, VERIFIED candidate into a
 * deployable artifact bundle: the payload file set plus a provenance
 * manifest (base SHA, composition plan, package set, verification report
 * ids, one per-file sha256 entry for every artifact file), and
 * `verifyExportBundle` is the documented reproducible-build check — it
 * re-hashes every artifact against the manifest, re-derives the
 * content-addressed bundle digest byte-exactly, validates every provenance
 * field, and fails closed collecting EVERY issue when manifest and artifact
 * disagree.
 *
 * Discipline:
 *
 * - PURE, SYNCHRONOUS, DETERMINISTIC — no wall clock (the only temporal
 *   input is the injected `now` clock, read exactly once, pinned to the
 *   Unix epoch when absent), no randomness, no I/O. The bundle is a
 *   serializable data structure; `serializeExportBundle` is its canonical
 *   JSON form (sorted keys, sorted file paths, no whitespace variance) so
 *   the same inputs always produce a byte-identical bundle and a
 *   byte-identical serialization, and a serialize → parse → verify
 *   round-trip reproduces byte-identical digests.
 * - FAIL-CLOSED — `buildExportBundle` validates the whole input first and
 *   throws ONE typed `ExportBundleError` carrying every collected issue
 *   (never a partial bundle, never just the first problem). An UNVERIFIED
 *   candidate refuses export: an e2e acceptance digest reporting any stage
 *   "failed", or an empty paired-report id list, is not verification
 *   evidence and throws honestly (errorCode "unverified-candidate").
 * - HONEST VERDICTS — `verifyExportBundle` never throws: a tampered bundle
 *   is a verdict (`{ verified: false, issues: [...] }`), not an exception.
 * - ADR-002 — this module imports only `./`-relative synthesis modules and
 *   `@clapp/contracts` (frozen, read-only). The candidate artifact and the
 *   W3-008 verification evidence arrive through structural ports as data;
 *   the real materialization/e2e surfaces satisfy them without any
 *   cross-lane dependency.
 */

/**
 * The export bundle manifest's format version (this module's own schema
 * stamp, the W3-008 digest-version discipline).
 */
export const EXPORT_BUNDLE_FORMAT_VERSION = "0.1";

/**
 * The content-addressed bundle digest prefix. NOT yet in docs/clapp/CONTRACTS.md's
 * "Core identifiers" list: contracts are frozen and tech-lead-owned (a change
 * requires an ADR, a version bump when applicable, a migration/compatibility
 * test, and updated acceptance criteria — ADR-003), and the `clapp_export_`
 * revision is proposed in the CLAPP-W3-010 completion report instead of being
 * edited in here. Consumers must treat the prefix as module-scoped until the
 * contract revision lands.
 */
export const EXPORT_BUNDLE_DIGEST_PREFIX = "clapp_export_";

/** Hex characters of the content digest folded into the bundle digest (the family discipline). */
const BUNDLE_DIGEST_HEX_LENGTH = 16;

/** A full lowercase sha256 hex digest (the per-file / per-package content digests). */
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

/** A full lowercase git commit SHA (the reconstruction base). */
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

/** A conforming frozen-schema package version (MAJOR.MINOR.PATCH, no pre-release). */
const PACKAGE_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

/**
 * The pinned export clock used when no `now` is injected: the Unix epoch.
 * The module never reads a wall clock, so every default-path bundle is
 * deterministic; callers wanting a real build timestamp inject `now`.
 */
const DEFAULT_EXPORT_CLOCK_MS = 0;

/** Depth guard for the JSON-representability walk (the W2-005 discipline). */
const MAX_JSON_DEPTH = 2000;

// ---------------------------------------------------------------------------
// Public types — the structural ports (ADR-002, declared locally)
// ---------------------------------------------------------------------------

/**
 * Structural port over the materialized candidate's deployable file set:
 * the read-only path → content map the candidate seam produced (for a
 * generated web candidate, the `GeneratedApp.files` projection). At least
 * one file is required; paths are relative, normalized POSIX-style paths.
 */
export interface ExportCandidateArtifact {
  /** The deployable file set: artifact-relative path → file content. */
  files: ReadonlyMap<string, string>;
}

/**
 * Structural port over the W3-008 verification evidence: the honest
 * end-to-end acceptance digest (per-stage outcomes, verbatim parity
 * verdict, journey coverage, recorded limitations) plus the ids of the
 * paired-verification reports that were produced for this candidate.
 */
export interface ExportVerification {
  /** The `digestE2eAcceptance(run)` output, carried verbatim. */
  e2eDigest: E2eAcceptanceDigest;
  /** The paired-verification report ids (at least one; non-empty each). */
  pairedReportIds: readonly string[];
}

/** The `buildExportBundle` input: the verified candidate plus its provenance. */
export interface ExportBundleInput {
  /** The candidate's identity anchor: non-empty, trimmed. */
  candidateId: string;
  /** The reconstruction base commit: a full 40-hex lowercase git SHA. */
  baseSha: string;
  /** The materialized candidate's deployable file set (structural port). */
  candidateArtifact: ExportCandidateArtifact;
  /** The W3-009 composition plan, carried verbatim into the manifest. */
  compositionPlan: CompositionPlan;
  /** The packages the composition selected (ids exactly the plan's packageIds). */
  packageSet: readonly ClappPackage[];
  /** The W3-008 verification evidence (structural port). */
  verification: ExportVerification;
  /**
   * Optional injected clock, read exactly once; the returned epoch-ms value
   * becomes the manifest's `builtAt`. Absent pins the build to the Unix
   * epoch so every default-path bundle is deterministic.
   */
  now?: () => number;
}

/** One package-set entry of the manifest: identity + content digest, never the full document. */
export interface ExportManifestPackageEntry {
  id: string;
  version: string;
  /** sha256 over the package document's canonical JSON form (the package's content identity). */
  contentDigest: string;
}

/** One per-file artifact entry of the manifest: path + the content's sha256. */
export interface ExportManifestFileEntry {
  path: string;
  /** sha256 over the file content's canonical JSON form (the package's contentHash discipline). */
  sha256: string;
}

/** The manifest's verification block: the e2e evidence verbatim + the paired report ids. */
export interface ExportManifestVerification {
  /** The W3-008 acceptance digest, carried verbatim (deep copy). */
  e2eDigest: E2eAcceptanceDigest;
  /** The paired-verification report ids, sorted ascending (a canonical set). */
  pairedReportIds: string[];
}

/**
 * The provenance manifest. Every field is covered by `bundleDigest` (the
 * digest is content-addressed over the canonical core — this whole object
 * minus `bundleDigest`; it never covers itself), so ANY tampered field
 * fails the reproducible-build check.
 */
export interface ExportManifest {
  /** This manifest schema's version (always "0.1"). */
  formatVersion: "0.1";
  /** The candidate's identity anchor (trimmed). */
  candidateId: string;
  /** The reconstruction base commit (full 40-hex). */
  baseSha: string;
  /** The build stamp from the injected clock (epoch ms; 0 when unpinned). */
  builtAt: number;
  /** The W3-009 composition plan, carried verbatim (status, selections, packageIds, notes, compositionDigest). */
  composition: CompositionPlan;
  /** The selected package set: id, version and contentDigest per package, sorted by id. */
  packageSet: readonly ExportManifestPackageEntry[];
  /** The verification evidence: the e2e digest verbatim + the paired report ids. */
  verification: ExportManifestVerification;
  /** One entry per artifact file, sorted by path. */
  files: readonly ExportManifestFileEntry[];
  /** `clapp_export_` + the first 16 hex of sha256 over the canonical core (ADR-003 family shape). */
  bundleDigest: string;
}

/** A deployable artifact bundle: the provenance manifest plus the payload file set. */
export interface ExportBundle {
  manifest: ExportManifest;
  /** The artifact payload itself — exactly the input candidate's file set (fresh map, same bindings). */
  files: ReadonlyMap<string, string>;
}

// ---------------------------------------------------------------------------
// Public types — the fail-closed error and the verification verdict
// ---------------------------------------------------------------------------

/** The typed fail-closed error codes of the export surface. */
export type ExportBundleErrorCode = "invalid-input" | "unverified-candidate";

/**
 * The typed fail-closed error of the export surface (the CompositionError
 * discipline). `issues` carries every collected violation — structural
 * problems carry code "invalid-input"; the verification refusal (failed
 * e2e stage or empty paired-report ids) carries "unverified-candidate".
 * When both kinds are present the structural code wins (a malformed input
 * is fixed before its verification can be honestly evaluated), and every
 * issue is still listed.
 */
export class ExportBundleError extends Error {
  readonly code: ExportBundleErrorCode;
  readonly issues: readonly string[];

  constructor(code: ExportBundleErrorCode, message: string, issues: readonly string[] = []) {
    super(message);
    this.name = "ExportBundleError";
    this.code = code;
    this.issues = [...issues];
  }
}

/** The reproducible-build check's honest verdict: pass, or every collected issue. */
export interface ExportVerificationResult {
  verified: boolean;
  /** Every issue found, in the documented deterministic check order; empty iff verified. */
  issues: string[];
}

// ---------------------------------------------------------------------------
// Local structural helpers (the frozen-lane discipline, no cross-lane imports)
// ---------------------------------------------------------------------------

/** Code-unit string order — the repo's identity-field comparison. */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function describe(value: unknown): string {
  if (value === undefined) {
    return "got undefined";
  }
  if (value === null) {
    return "got null";
  }
  if (Array.isArray(value)) {
    return "got an array";
  }
  if (typeof value === "object") {
    return "got an object";
  }
  if (typeof value === "string") {
    const snippet = value.length > 32 ? `${value.slice(0, 32)}…` : value;
    return `got ${JSON.stringify(snippet)}`;
  }
  return `got ${typeof value} (${String(value)})`;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** A plain non-array object (duck-typing guard). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepCopy(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((element) => deepCopy(element));
  }
  if (isPlainObject(value)) {
    const copy: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      copy[key] = deepCopy(value[key]);
    }
    return copy;
  }
  return value;
}

/**
 * JSON-representability walk (the W2-005 discipline): every value must be a
 * string, a finite number, a boolean, null, an array or a plain object, and
 * the tree must stay within the depth guard. Non-representable values
 * (NaN, Infinity, functions, symbols, class instances) would silently
 * change under canonical serialization, so they are collected issues — the
 * manifest's verbatim carries must survive a serialize → parse round-trip
 * byte-exactly.
 */
function checkJsonRepresentable(value: unknown, path: string, issues: string[], depth = 0): void {
  if (depth > MAX_JSON_DEPTH) {
    issues.push(`${path}: exceeds the maximum JSON depth of ${MAX_JSON_DEPTH}`);
    return;
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      issues.push(`${path}: numbers must be finite (JSON cannot carry ${String(value)})`);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, element] of value.entries()) {
      checkJsonRepresentable(element, `${path}[${index}]`, issues, depth + 1);
    }
    return;
  }
  if (isPlainObject(value)) {
    for (const key of Object.keys(value)) {
      checkJsonRepresentable(value[key], `${path}.${key}`, issues, depth + 1);
    }
    return;
  }
  issues.push(`${path}: values must be JSON-representable, ${describe(value)}`);
}

/**
 * Validates one artifact path: a non-empty, relative, normalized POSIX-style
 * path (no leading "/", no empty segments — which also rules out "//" and a
 * trailing "/" — and no "." or ".." segments). Collects every violation.
 * Returns the path when fully valid, else null.
 */
function validateArtifactPath(path: unknown, pathLabel: string, issues: string[]): string | null {
  if (typeof path !== "string" || path.length === 0) {
    issues.push(`${pathLabel} must be a non-empty string, ${describe(path)}`);
    return null;
  }
  let valid = true;
  if (path.startsWith("/")) {
    issues.push(
      `${pathLabel} must be a relative path, got an absolute one (${JSON.stringify(path)})`,
    );
    valid = false;
  }
  const segments = path.split("/");
  for (const [index, segment] of segments.entries()) {
    if (segment.length === 0) {
      issues.push(
        `${pathLabel} must be normalized: empty segment at index ${index} (${JSON.stringify(path)})`,
      );
      valid = false;
    } else if (segment === ".") {
      issues.push(
        `${pathLabel} must be normalized: "." segment at index ${index} (${JSON.stringify(path)})`,
      );
      valid = false;
    } else if (segment === "..") {
      issues.push(
        `${pathLabel} must stay inside the artifact root: ".." segment at index ${index} (${JSON.stringify(path)})`,
      );
      valid = false;
    }
  }
  return valid ? path : null;
}

/** Reads a required array-of-non-empty-strings field; collects issues and returns null when malformed. */
function readNonEmptyStringArray(value: unknown, path: string, issues: string[]): string[] | null {
  if (!Array.isArray(value) || !value.every(isNonEmptyString)) {
    issues.push(`${path} must be an array of non-empty strings, ${describe(value)}`);
    return null;
  }
  return value.map((entry) => entry as string);
}

/**
 * Structural validation of one frozen `ClappPackage` registry document to
 * the bar the composed surfaces themselves apply: the flat v0.1 field set
 * (schemaVersion equal to the frozen contract version; non-empty
 * id/version/category/purpose with a conforming MAJOR.MINOR.PATCH version;
 * objects for interface/benchmark/provenance; string arrays for
 * capabilities/constraints/dependencies/supportedTargets; arrays for
 * tests/failureModes — their element shapes are the registry's normalized
 * domain and are not re-litigated here, per the documented frozen
 * schema/TS-interface note in W2-005). Returns the manifest entry
 * projection (id, version, contentDigest) when valid, else null.
 */
function validatePackageDocument(
  doc: unknown,
  path: string,
  issues: string[],
): ExportManifestPackageEntry | null {
  if (!isRecord(doc)) {
    issues.push(`${path} must be a package document object, ${describe(doc)}`);
    return null;
  }
  let valid = true;
  if (doc.schemaVersion !== CLAPP_CONTRACT_VERSION) {
    issues.push(
      `${path}.schemaVersion must be "${CLAPP_CONTRACT_VERSION}" (the frozen contract version), ${describe(doc.schemaVersion)}`,
    );
    valid = false;
  }
  for (const field of ["id", "version", "category", "purpose"] as const) {
    if (!isNonEmptyString(doc[field])) {
      issues.push(`${path}.${field} must be a non-empty string, ${describe(doc[field])}`);
      valid = false;
    }
  }
  if (typeof doc.version === "string" && !PACKAGE_VERSION_PATTERN.test(doc.version)) {
    issues.push(
      `${path}.version must be a conforming MAJOR.MINOR.PATCH numeric version, got ${JSON.stringify(doc.version)}`,
    );
    valid = false;
  }
  for (const field of ["interface", "benchmark", "provenance"] as const) {
    if (!isPlainObject(doc[field])) {
      issues.push(`${path}.${field} must be an object, ${describe(doc[field])}`);
      valid = false;
    }
  }
  for (const field of [
    "capabilities",
    "constraints",
    "dependencies",
    "supportedTargets",
  ] as const) {
    const value = doc[field];
    if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
      issues.push(`${path}.${field} must be an array of strings, ${describe(value)}`);
      valid = false;
    }
  }
  for (const field of ["tests", "failureModes"] as const) {
    if (!Array.isArray(doc[field])) {
      issues.push(`${path}.${field} must be an array, ${describe(doc[field])}`);
      valid = false;
    }
  }
  checkJsonRepresentable(doc, path, issues);
  if (!valid || !isNonEmptyString(doc.id) || !isNonEmptyString(doc.version)) {
    return null;
  }
  return { id: doc.id, version: doc.version, contentDigest: contentHash(doc) };
}

/**
 * Structural validation of a W3-009 `CompositionPlan` (the exact shape
 * `planComposition` emits): status-discriminated, non-empty unique
 * `packageIds`, and per status — composed: selections (role, packageId,
 * version, provenance object), notes, a 64-hex compositionDigest;
 * fallback/abstained: a non-empty reason. Returns nothing; collects issues.
 */
function validateCompositionPlanShape(plan: unknown, path: string, issues: string[]): void {
  if (!isRecord(plan)) {
    issues.push(`${path} must be a CompositionPlan object, ${describe(plan)}`);
    return;
  }
  const status = plan.status;
  if (status !== "composed" && status !== "fallback" && status !== "abstained") {
    issues.push(
      `${path}.status must be "composed", "fallback" or "abstained", ${describe(status)}`,
    );
    return;
  }
  const packageIds = readNonEmptyStringArray(plan.packageIds, `${path}.packageIds`, issues);
  if (packageIds !== null) {
    const seen = new Set<string>();
    for (const [index, id] of packageIds.entries()) {
      if (seen.has(id)) {
        issues.push(`${path}.packageIds[${index}]: duplicate id ${JSON.stringify(id)}`);
      } else {
        seen.add(id);
      }
    }
  }
  if (status === "composed") {
    if (!Array.isArray(plan.selections)) {
      issues.push(
        `${path}.selections must be an array (the filled slots), ${describe(plan.selections)}`,
      );
    } else {
      for (const [index, selection] of plan.selections.entries()) {
        const selectionPath = `${path}.selections[${index}]`;
        if (!isRecord(selection)) {
          issues.push(`${selectionPath} must be an object, ${describe(selection)}`);
          continue;
        }
        if (selection.role !== "archetype-anchor" && selection.role !== "compatible-extension") {
          issues.push(
            `${selectionPath}.role must be "archetype-anchor" or "compatible-extension", ${describe(selection.role)}`,
          );
        }
        if (!isNonEmptyString(selection.packageId)) {
          issues.push(
            `${selectionPath}.packageId must be a non-empty string, ${describe(selection.packageId)}`,
          );
        }
        if (!isNonEmptyString(selection.version)) {
          issues.push(
            `${selectionPath}.version must be a non-empty string, ${describe(selection.version)}`,
          );
        }
        if (!isRecord(selection.provenance)) {
          issues.push(
            `${selectionPath}.provenance must be an object, ${describe(selection.provenance)}`,
          );
        }
      }
    }
    readNonEmptyStringArray(plan.notes, `${path}.notes`, issues);
    if (
      typeof plan.compositionDigest !== "string" ||
      !SHA256_HEX_PATTERN.test(plan.compositionDigest)
    ) {
      issues.push(
        `${path}.compositionDigest must be a 64-hex sha256 content digest, ${describe(plan.compositionDigest)}`,
      );
    }
  } else if (!isNonEmptyString(plan.reason)) {
    issues.push(`${path}.reason must be a non-empty string, ${describe(plan.reason)}`);
  }
  checkJsonRepresentable(plan, path, issues);
}

/**
 * Structural validation of a W3-008 `E2eAcceptanceDigest` (the exact shape
 * `digestE2eAcceptance` emits). Returns the list of failed stage records
 * (honest evidence of what was NOT verified), or null when malformed.
 */
function validateE2eDigestShape(
  digest: unknown,
  path: string,
  issues: string[],
): { stage: string; reason: string }[] | null {
  if (!isRecord(digest)) {
    issues.push(`${path} must be an E2eAcceptanceDigest object, ${describe(digest)}`);
    return null;
  }
  let valid = true;
  if (!isNonEmptyString(digest.schemaVersion)) {
    issues.push(
      `${path}.schemaVersion must be a non-empty string, ${describe(digest.schemaVersion)}`,
    );
    valid = false;
  }
  if (!isNonEmptyString(digest.reconstructionId)) {
    issues.push(
      `${path}.reconstructionId must be a non-empty string, ${describe(digest.reconstructionId)}`,
    );
    valid = false;
  }
  const failedStages: { stage: string; reason: string }[] = [];
  if (!Array.isArray(digest.stages) || digest.stages.length === 0) {
    issues.push(
      `${path}.stages must be a non-empty array of stage records, ${describe(digest.stages)}`,
    );
    valid = false;
  } else {
    for (const [index, stage] of digest.stages.entries()) {
      const stagePath = `${path}.stages[${index}]`;
      if (!isRecord(stage)) {
        issues.push(`${stagePath} must be an object, ${describe(stage)}`);
        valid = false;
        continue;
      }
      if (!isNonEmptyString(stage.stage)) {
        issues.push(`${stagePath}.stage must be a non-empty string, ${describe(stage.stage)}`);
        valid = false;
      }
      const outcome = stage.outcome;
      if (outcome !== "succeeded" && outcome !== "failed" && outcome !== "unavailable") {
        issues.push(
          `${stagePath}.outcome must be "succeeded", "failed" or "unavailable", ${describe(outcome)}`,
        );
        valid = false;
      }
      if (!isNonEmptyString(stage.reason)) {
        issues.push(`${stagePath}.reason must be a non-empty string, ${describe(stage.reason)}`);
        valid = false;
      }
      if (outcome === "failed" && isNonEmptyString(stage.stage) && isNonEmptyString(stage.reason)) {
        failedStages.push({ stage: stage.stage, reason: stage.reason });
      }
    }
  }
  if (!isNonEmptyString(digest.finalParityVerdict)) {
    issues.push(
      `${path}.finalParityVerdict must be a non-empty string, ${describe(digest.finalParityVerdict)}`,
    );
    valid = false;
  }
  const repair = digest.repair;
  if (repair !== null) {
    if (!isRecord(repair)) {
      issues.push(`${path}.repair must be an object or null, ${describe(repair)}`);
      valid = false;
    } else {
      if (typeof repair.converged !== "boolean") {
        issues.push(`${path}.repair.converged must be a boolean, ${describe(repair.converged)}`);
        valid = false;
      }
      if (!isNonEmptyString(repair.stoppedBy)) {
        issues.push(
          `${path}.repair.stoppedBy must be a non-empty string, ${describe(repair.stoppedBy)}`,
        );
        valid = false;
      }
      for (const field of ["iterations", "abstentions"] as const) {
        if (
          typeof repair[field] !== "number" ||
          !Number.isInteger(repair[field]) ||
          repair[field] < 0
        ) {
          issues.push(
            `${path}.repair.${field} must be a non-negative integer, ${describe(repair[field])}`,
          );
          valid = false;
        }
      }
      if (!isNonEmptyString(repair.finalVerdict)) {
        issues.push(
          `${path}.repair.finalVerdict must be a non-empty string, ${describe(repair.finalVerdict)}`,
        );
        valid = false;
      }
    }
  }
  if (!Array.isArray(digest.journeyCoverage)) {
    issues.push(`${path}.journeyCoverage must be an array, ${describe(digest.journeyCoverage)}`);
    valid = false;
  } else {
    for (const [index, entry] of digest.journeyCoverage.entries()) {
      const entryPath = `${path}.journeyCoverage[${index}]`;
      if (!isRecord(entry)) {
        issues.push(`${entryPath} must be an object, ${describe(entry)}`);
        valid = false;
        continue;
      }
      if (!isNonEmptyString(entry.journeyId) || !isNonEmptyString(entry.routePath)) {
        issues.push(
          `${entryPath} must carry non-empty journeyId and routePath strings, ${describe(entry)}`,
        );
        valid = false;
      }
      if (!isNonEmptyString(entry.verdict)) {
        issues.push(`${entryPath}.verdict must be a non-empty string, ${describe(entry.verdict)}`);
        valid = false;
      }
      if (
        typeof entry.findingCount !== "number" ||
        !Number.isInteger(entry.findingCount) ||
        entry.findingCount < 0
      ) {
        issues.push(
          `${entryPath}.findingCount must be a non-negative integer, ${describe(entry.findingCount)}`,
        );
        valid = false;
      }
    }
  }
  if (!Array.isArray(digest.limitations)) {
    issues.push(`${path}.limitations must be an array, ${describe(digest.limitations)}`);
    valid = false;
  } else {
    for (const [index, limitation] of digest.limitations.entries()) {
      const limitationPath = `${path}.limitations[${index}]`;
      if (!isRecord(limitation)) {
        issues.push(`${limitationPath} must be an object, ${describe(limitation)}`);
        valid = false;
        continue;
      }
      if (limitation.status !== "limitation") {
        issues.push(
          `${limitationPath}.status must be "limitation" (never a passing check), ${describe(limitation.status)}`,
        );
        valid = false;
      }
      if (!isNonEmptyString(limitation.id) || !isNonEmptyString(limitation.reason)) {
        issues.push(
          `${limitationPath} must carry non-empty id and reason strings, ${describe(limitation)}`,
        );
        valid = false;
      }
    }
  }
  checkJsonRepresentable(digest, path, issues);
  return valid ? failedStages : null;
}

/**
 * Reads the injected clock exactly once (the compounding discipline): the
 * value must be a non-negative integer epoch-millisecond number; a clock
 * that throws is a collected issue, never a propagated surprise.
 */
function readClock(now: unknown, issues: string[]): number | null {
  if (now === undefined) {
    return DEFAULT_EXPORT_CLOCK_MS;
  }
  if (typeof now !== "function") {
    issues.push("now must be a zero-argument clock function when supplied");
    return null;
  }
  let clockValue: unknown;
  try {
    clockValue = now();
  } catch {
    issues.push("the injected now clock threw when read; failing closed");
    return null;
  }
  if (typeof clockValue !== "number" || !Number.isInteger(clockValue) || clockValue < 0) {
    issues.push(
      "the injected now clock must return a non-negative integer epoch-millisecond value",
    );
    return null;
  }
  return clockValue;
}

// ---------------------------------------------------------------------------
// buildExportBundle
// ---------------------------------------------------------------------------

/**
 * Assembles a reconstructed, VERIFIED candidate into a deployable artifact
 * bundle: the payload file set plus the provenance manifest, sealed by the
 * content-addressed `bundleDigest` (`clapp_export_` + the first 16 hex of
 * sha256 over the canonical core — the manifest minus the digest itself,
 * the ADR-003 family discipline; the digest never covers itself).
 *
 * Fail-closed: the whole input is validated first and ONE typed
 * `ExportBundleError` carries every collected issue. An UNVERIFIED
 * candidate refuses export honestly — an e2e digest reporting any stage
 * "failed", or an empty paired-report id list, throws with errorCode
 * "unverified-candidate" (a failed-stage digest is not verification
 * evidence; "unavailable" stages are carried verbatim in the manifest but
 * do not by themselves refuse export — the enumerated refusal rule
 * governs).
 *
 * Deterministic: same inputs (same injected clock or none) always produce a
 * deep-equal bundle and a byte-identical canonical serialization. The input
 * is never mutated; every carried value is deep-copied.
 */
export function buildExportBundle(input: ExportBundleInput): ExportBundle {
  const issues: string[] = [];
  const refusalIssues: string[] = [];

  if (!isRecord(input)) {
    throw new ExportBundleError(
      "invalid-input",
      "the export input must be an object carrying candidateId, baseSha, candidateArtifact, compositionPlan, packageSet and verification",
      [
        "input must be an object carrying candidateId, baseSha, candidateArtifact, compositionPlan, packageSet and verification",
      ],
    );
  }

  // --- candidateId (non-empty, trimmed) ---
  let candidateId: string | null = null;
  if (typeof input.candidateId === "string" && input.candidateId.trim().length > 0) {
    candidateId = input.candidateId.trim();
  } else {
    issues.push("candidateId must be a non-empty string (trimmed)");
  }

  // --- baseSha (full 40-hex git SHA) ---
  if (typeof input.baseSha !== "string" || !COMMIT_SHA_PATTERN.test(input.baseSha)) {
    issues.push(
      `baseSha must be a full 40-character lowercase-hex git commit SHA, ${describe(input.baseSha)}`,
    );
  }
  const baseSha: string = typeof input.baseSha === "string" ? input.baseSha : "";

  // --- the injected clock, read exactly once ---
  const builtAt = readClock(input.now, issues);

  // --- candidateArtifact.files (the deployable file set) ---
  const payloadFiles = new Map<string, string>();
  if (!isRecord(input.candidateArtifact)) {
    issues.push(
      `candidateArtifact must be an object carrying the deployable file set, ${describe(input.candidateArtifact)}`,
    );
  } else {
    const files = input.candidateArtifact.files;
    if (!(files instanceof Map)) {
      issues.push(
        `candidateArtifact.files must be a ReadonlyMap of path to content, ${describe(files)}`,
      );
    } else if (files.size === 0) {
      issues.push(
        "candidateArtifact.files must carry at least one file (an empty artifact is not deployable)",
      );
    } else {
      for (const [path, content] of files.entries()) {
        const validPath = validateArtifactPath(path, "candidateArtifact.files key", issues);
        if (typeof content !== "string") {
          issues.push(
            `candidateArtifact.files[${JSON.stringify(path)}] content must be a string, ${describe(content)}`,
          );
        } else if (validPath !== null) {
          payloadFiles.set(validPath, content);
        }
      }
    }
  }

  // --- compositionPlan (the W3-009 plan, verbatim) ---
  validateCompositionPlanShape(input.compositionPlan, "compositionPlan", issues);

  // --- packageSet (the selected packages; ids exactly the plan's) ---
  const packageEntries: ExportManifestPackageEntry[] = [];
  const packageIdsInSet: string[] = [];
  if (!Array.isArray(input.packageSet)) {
    issues.push(
      `packageSet must be an array of registry package documents, ${describe(input.packageSet)}`,
    );
  } else {
    const firstIndexOfId = new Map<string, number>();
    for (const [index, doc] of input.packageSet.entries()) {
      const entry = validatePackageDocument(doc, `packageSet[${index}]`, issues);
      if (entry === null) {
        continue;
      }
      const firstAt = firstIndexOfId.get(entry.id);
      if (firstAt === undefined) {
        firstIndexOfId.set(entry.id, index);
        packageEntries.push(entry);
        packageIdsInSet.push(entry.id);
      } else {
        issues.push(
          `duplicate package id ${JSON.stringify(entry.id)} (packageSet[${firstAt}] and packageSet[${index}]); one version per package — the composition's own selection discipline`,
        );
      }
    }
  }

  // --- verification (the W3-008 evidence port) ---
  let e2eDigestCarried: E2eAcceptanceDigest | null = null;
  let pairedReportIdsCarried: string[] | null = null;
  if (!isRecord(input.verification)) {
    issues.push(
      `verification must be an object carrying e2eDigest and pairedReportIds, ${describe(input.verification)}`,
    );
  } else {
    const failedStages = validateE2eDigestShape(
      input.verification.e2eDigest,
      "verification.e2eDigest",
      issues,
    );
    if (failedStages !== null) {
      e2eDigestCarried = input.verification.e2eDigest as E2eAcceptanceDigest;
      for (const failed of failedStages) {
        refusalIssues.push(
          `refuses export: the e2e acceptance digest reports stage "${failed.stage}" as FAILED (${failed.reason}) — a failed-stage digest is not verification evidence`,
        );
      }
    }
    const ids = input.verification.pairedReportIds;
    if (!Array.isArray(ids)) {
      issues.push(
        `verification.pairedReportIds must be an array of report id strings, ${describe(ids)}`,
      );
    } else {
      const seen = new Set<string>();
      let idsValid = true;
      for (const [index, id] of ids.entries()) {
        if (!isNonEmptyString(id)) {
          issues.push(
            `verification.pairedReportIds[${index}] must be a non-empty string, ${describe(id)}`,
          );
          idsValid = false;
          continue;
        }
        if (seen.has(id)) {
          issues.push(
            `verification.pairedReportIds[${index}]: duplicate report id ${JSON.stringify(id)}`,
          );
          idsValid = false;
          continue;
        }
        seen.add(id);
      }
      if (ids.length === 0) {
        refusalIssues.push(
          "refuses export: the verification port carries no paired-verification report ids — without at least one report id there is no verification evidence",
        );
      }
      if (idsValid && ids.length > 0) {
        pairedReportIdsCarried = [...(ids as string[])];
      }
    }
  }

  // --- the plan / packageSet cross-check (set equality of ids) ---
  if (isRecord(input.compositionPlan) && Array.isArray(input.compositionPlan.packageIds)) {
    const planIds = input.compositionPlan.packageIds as unknown[];
    const planIdSet = new Set<string>();
    let planIdsReadable = true;
    for (const id of planIds) {
      if (typeof id !== "string") {
        planIdsReadable = false;
        break;
      }
      planIdSet.add(id);
    }
    if (planIdsReadable) {
      const setIdSet = new Set(packageIdsInSet);
      for (const id of planIdSet) {
        if (!setIdSet.has(id)) {
          issues.push(
            `compositionPlan.packageIds lists ${JSON.stringify(id)} but the package set does not carry it`,
          );
        }
      }
      for (const id of setIdSet) {
        if (!planIdSet.has(id)) {
          issues.push(
            `packageSet carries ${JSON.stringify(id)} but compositionPlan.packageIds does not list it`,
          );
        }
      }
      if (
        input.compositionPlan.status === "composed" &&
        Array.isArray(input.packageSet) &&
        input.packageSet.length === 0
      ) {
        issues.push(
          "packageSet must be non-empty when the composition plan is composed (the selected set is the provenance)",
        );
      }
    }
  }

  // --- fail closed: one typed error, every issue ---
  if (issues.length > 0 || refusalIssues.length > 0) {
    const structural = issues.length > 0;
    const allIssues = [...issues, ...refusalIssues];
    throw new ExportBundleError(
      structural ? "invalid-input" : "unverified-candidate",
      structural
        ? `refusing to export: the input is malformed (${allIssues.length} collected issue${allIssues.length === 1 ? "" : "s"})`
        : `refuses export: the candidate is not verified (${allIssues.length} collected issue${allIssues.length === 1 ? "" : "s"})`,
      allIssues,
    );
  }

  // --- the manifest core (every field; the digest never covers itself) ---
  const sortedPaths = [...payloadFiles.keys()].sort(compareStrings);
  const fileEntries: ExportManifestFileEntry[] = sortedPaths.map((path) => ({
    path,
    sha256: contentHash(payloadFiles.get(path)),
  }));
  const sortedPackageEntries = [...packageEntries].sort(
    (a, b) => compareStrings(a.id, b.id) || compareStrings(a.version, b.version),
  );
  const sortedReportIds = [...(pairedReportIdsCarried ?? [])].sort(compareStrings);
  const core = {
    formatVersion: EXPORT_BUNDLE_FORMAT_VERSION as "0.1",
    candidateId: candidateId ?? "",
    baseSha,
    builtAt: builtAt ?? DEFAULT_EXPORT_CLOCK_MS,
    composition: deepCopy(input.compositionPlan) as CompositionPlan,
    packageSet: sortedPackageEntries,
    verification: {
      e2eDigest: deepCopy(e2eDigestCarried) as E2eAcceptanceDigest,
      pairedReportIds: sortedReportIds,
    } satisfies ExportManifestVerification,
    files: fileEntries,
  };
  const bundleDigest = `${EXPORT_BUNDLE_DIGEST_PREFIX}${contentHash(core).slice(0, BUNDLE_DIGEST_HEX_LENGTH)}`;

  return {
    manifest: { ...core, bundleDigest },
    files: new Map(sortedPaths.map((path) => [path, payloadFiles.get(path) ?? ""])),
  };
}

// ---------------------------------------------------------------------------
// serializeExportBundle
// ---------------------------------------------------------------------------

/**
 * The bundle's canonical JSON form: object keys sorted alphabetically at
 * every level, the file payload as a path-keyed object (paths sorted),
 * arrays in their semantic (already-canonical) order, no whitespace
 * variance. Re-parsing the output and handing it to `verifyExportBundle`
 * reproduces byte-identical digests; serializing a rebuilt bundle
 * reproduces byte-identical text.
 */
export function serializeExportBundle(bundle: ExportBundle): string {
  if (!isRecord(bundle) || !isRecord(bundle.manifest)) {
    throw new TypeError(
      "serializeExportBundle requires an ExportBundle carrying a manifest object",
    );
  }
  if (!(bundle.files instanceof Map)) {
    throw new TypeError("serializeExportBundle requires an ExportBundle whose files is a Map");
  }
  const files: Record<string, string> = {};
  for (const [path, content] of bundle.files.entries()) {
    files[path] = content;
  }
  return canonicalJson({ manifest: bundle.manifest, files });
}

// ---------------------------------------------------------------------------
// verifyExportBundle — the documented reproducible-build check
// ---------------------------------------------------------------------------

/**
 * The reproducible-build check. Given a parsed bundle (or anything — this
 * type-guards first and never throws: a tampered bundle is a verdict, not
 * an exception), it, in this documented deterministic order:
 *
 * 1. re-hashes EVERY manifest artifact entry against the payload files
 *    (missing file, extra file, hash mismatch — each an issue), and checks
 *    the entry list's canonical order;
 * 2. re-derives the bundle digest from the canonical core (the manifest
 *    minus `bundleDigest`, whatever fields it carries — so ANY tampered or
 *    added manifest field breaks the digest) and compares it byte-exact;
 * 3. validates every provenance field (formatVersion, candidateId, baseSha
 *    40-hex, builtAt, composition plan shape, package entries, the e2e
 *    digest shape including its honest no-failed-stage evidence, the
 *    verification ids) and the plan/packageSet id agreement;
 * 4. returns `{ verified: true, issues: [] }` or
 *    `{ verified: false, issues: [every issue, in the order collected] }`.
 */
export function verifyExportBundle(bundle: unknown): ExportVerificationResult {
  const issues: string[] = [];

  // --- structural guard ---
  if (!isRecord(bundle)) {
    return {
      verified: false,
      issues: [`the bundle must be an object carrying manifest and files, ${describe(bundle)}`],
    };
  }
  const manifest = bundle.manifest;
  if (!isRecord(manifest)) {
    issues.push(`bundle.manifest must be an object, ${describe(manifest)}`);
  }
  const filesValue = bundle.files;
  const payload = new Map<string, string>();
  if (filesValue instanceof Map) {
    for (const [path, content] of filesValue.entries()) {
      const validPath = validateArtifactPath(path, "files key", issues);
      if (typeof content !== "string") {
        issues.push(
          `files[${JSON.stringify(path)}] content must be a string, ${describe(content)}`,
        );
      } else if (validPath !== null) {
        payload.set(validPath, content);
      }
    }
  } else if (isRecord(filesValue)) {
    for (const path of Object.keys(filesValue)) {
      const validPath = validateArtifactPath(path, "files key", issues);
      const content = filesValue[path];
      if (typeof content !== "string") {
        issues.push(
          `files[${JSON.stringify(path)}] content must be a string, ${describe(content)}`,
        );
      } else if (validPath !== null) {
        payload.set(validPath, content);
      }
    }
  } else {
    issues.push(
      `bundle.files must be the artifact payload (a Map, or the parsed path-keyed object form), ${describe(filesValue)}`,
    );
  }
  if (!isRecord(manifest)) {
    return { verified: false, issues };
  }

  // --- 1. re-hash every manifest artifact entry against the payload ---
  const manifestPaths = new Set<string>();
  if (!Array.isArray(manifest.files)) {
    issues.push(
      `manifest.files must be an array of per-file artifact entries, ${describe(manifest.files)}`,
    );
  } else {
    let sortedSoFar = true;
    let previousPath: string | null = null;
    for (const [index, entry] of manifest.files.entries()) {
      const entryPath = `manifest.files[${index}]`;
      if (!isRecord(entry)) {
        issues.push(`${entryPath} must be an object carrying path and sha256, ${describe(entry)}`);
        continue;
      }
      const path = validateArtifactPath(entry.path, `${entryPath}.path`, issues);
      if (typeof entry.sha256 !== "string" || !SHA256_HEX_PATTERN.test(entry.sha256)) {
        issues.push(
          `${entryPath}.sha256 must be a 64-hex sha256 digest, ${describe(entry.sha256)}`,
        );
        continue;
      }
      if (path === null) {
        continue;
      }
      if (manifestPaths.has(path)) {
        issues.push(`${entryPath}: duplicate artifact entry for path ${JSON.stringify(path)}`);
        continue;
      }
      manifestPaths.add(path);
      if (previousPath !== null && compareStrings(path, previousPath) <= 0) {
        sortedSoFar = false;
      }
      previousPath = path;
      const content = payload.get(path);
      if (content === undefined) {
        issues.push(
          `the manifest lists file ${JSON.stringify(path)} but the payload does not carry it`,
        );
        continue;
      }
      const actual = contentHash(content);
      if (actual !== entry.sha256) {
        issues.push(
          `file ${JSON.stringify(path)} hash mismatch: the manifest declares sha256 ${entry.sha256} but the payload content hashes to ${actual}`,
        );
      }
    }
    if (!sortedSoFar) {
      issues.push("manifest.files must be sorted ascending by path (the canonical form)");
    }
    for (const path of [...payload.keys()].sort(compareStrings)) {
      if (!manifestPaths.has(path)) {
        issues.push(
          `the payload carries file ${JSON.stringify(path)} but the manifest does not list it`,
        );
      }
    }
  }

  // --- 2. re-derive the bundle digest and compare byte-exact ---
  if (
    typeof manifest.bundleDigest !== "string" ||
    !manifest.bundleDigest.startsWith(EXPORT_BUNDLE_DIGEST_PREFIX)
  ) {
    issues.push(
      `manifest.bundleDigest must be a "${EXPORT_BUNDLE_DIGEST_PREFIX}"-prefixed digest, ${describe(manifest.bundleDigest)}`,
    );
  } else {
    const tail = manifest.bundleDigest.slice(EXPORT_BUNDLE_DIGEST_PREFIX.length);
    if (!/^[0-9a-f]{16}$/.test(tail)) {
      issues.push(
        `manifest.bundleDigest must carry 16 hex characters after the prefix, got ${JSON.stringify(tail)}`,
      );
    } else {
      const core: Record<string, unknown> = {};
      for (const key of Object.keys(manifest)) {
        if (key !== "bundleDigest") {
          core[key] = manifest[key];
        }
      }
      const derived = `${EXPORT_BUNDLE_DIGEST_PREFIX}${contentHash(core).slice(0, BUNDLE_DIGEST_HEX_LENGTH)}`;
      if (derived !== manifest.bundleDigest) {
        issues.push(
          `bundle digest mismatch: the manifest declares ${JSON.stringify(manifest.bundleDigest)} but the canonical core re-derives ${JSON.stringify(derived)} (a tampered manifest field)`,
        );
      }
    }
  }

  // --- 3. validate every provenance field ---
  if (manifest.formatVersion !== EXPORT_BUNDLE_FORMAT_VERSION) {
    issues.push(
      `manifest.formatVersion must be "${EXPORT_BUNDLE_FORMAT_VERSION}", ${describe(manifest.formatVersion)}`,
    );
  }
  if (!isNonEmptyString(manifest.candidateId)) {
    issues.push(
      `manifest.candidateId must be a non-empty string, ${describe(manifest.candidateId)}`,
    );
  }
  if (typeof manifest.baseSha !== "string" || !COMMIT_SHA_PATTERN.test(manifest.baseSha)) {
    issues.push(
      `manifest.baseSha must be a full 40-character lowercase-hex git commit SHA, ${describe(manifest.baseSha)}`,
    );
  }
  if (
    typeof manifest.builtAt !== "number" ||
    !Number.isInteger(manifest.builtAt) ||
    manifest.builtAt < 0
  ) {
    issues.push(
      `manifest.builtAt must be a non-negative integer epoch-millisecond value, ${describe(manifest.builtAt)}`,
    );
  }
  validateCompositionPlanShape(manifest.composition, "manifest.composition", issues);

  const packageIdsInSet: string[] = [];
  if (!Array.isArray(manifest.packageSet)) {
    issues.push(
      `manifest.packageSet must be an array of package entries, ${describe(manifest.packageSet)}`,
    );
  } else {
    const seen = new Set<string>();
    for (const [index, entry] of manifest.packageSet.entries()) {
      const entryPath = `manifest.packageSet[${index}]`;
      if (!isRecord(entry)) {
        issues.push(
          `${entryPath} must be an object carrying id, version and contentDigest, ${describe(entry)}`,
        );
        continue;
      }
      if (!isNonEmptyString(entry.id)) {
        issues.push(`${entryPath}.id must be a non-empty string, ${describe(entry.id)}`);
      } else {
        if (seen.has(entry.id)) {
          issues.push(`${entryPath}: duplicate package id ${JSON.stringify(entry.id)}`);
        } else {
          seen.add(entry.id);
          packageIdsInSet.push(entry.id);
        }
      }
      if (!isNonEmptyString(entry.version)) {
        issues.push(`${entryPath}.version must be a non-empty string, ${describe(entry.version)}`);
      } else if (!PACKAGE_VERSION_PATTERN.test(entry.version)) {
        issues.push(
          `${entryPath}.version must be a conforming MAJOR.MINOR.PATCH numeric version, got ${JSON.stringify(entry.version)}`,
        );
      }
      if (
        typeof entry.contentDigest !== "string" ||
        !SHA256_HEX_PATTERN.test(entry.contentDigest)
      ) {
        issues.push(
          `${entryPath}.contentDigest must be a 64-hex sha256 digest, ${describe(entry.contentDigest)}`,
        );
      }
    }
  }

  if (!isRecord(manifest.verification)) {
    issues.push(
      `manifest.verification must be an object carrying e2eDigest and pairedReportIds, ${describe(manifest.verification)}`,
    );
  } else {
    const failedStages = validateE2eDigestShape(
      manifest.verification.e2eDigest,
      "manifest.verification.e2eDigest",
      issues,
    );
    if (failedStages !== null) {
      for (const failed of failedStages) {
        issues.push(
          `the manifest's e2e evidence reports stage "${failed.stage}" as FAILED (${failed.reason}) — this bundle does not carry honest verification evidence`,
        );
      }
    }
    const ids = manifest.verification.pairedReportIds;
    if (!Array.isArray(ids) || ids.length === 0) {
      issues.push(
        `manifest.verification.pairedReportIds must be a non-empty array of report id strings, ${describe(ids)}`,
      );
    } else {
      const seen = new Set<string>();
      for (const [index, id] of ids.entries()) {
        if (!isNonEmptyString(id)) {
          issues.push(
            `manifest.verification.pairedReportIds[${index}] must be a non-empty string, ${describe(id)}`,
          );
          continue;
        }
        if (seen.has(id)) {
          issues.push(
            `manifest.verification.pairedReportIds[${index}]: duplicate report id ${JSON.stringify(id)}`,
          );
          continue;
        }
        seen.add(id);
      }
    }
  }

  // --- 3b. the plan / packageSet id agreement (provenance consistency) ---
  if (isRecord(manifest.composition) && Array.isArray(manifest.composition.packageIds)) {
    const planIds = manifest.composition.packageIds as unknown[];
    const planIdSet = new Set<string>();
    let readable = true;
    for (const id of planIds) {
      if (typeof id !== "string") {
        readable = false;
        break;
      }
      planIdSet.add(id);
    }
    if (readable) {
      const setIdSet = new Set(packageIdsInSet);
      for (const id of planIdSet) {
        if (!setIdSet.has(id)) {
          issues.push(
            `manifest.composition.packageIds lists ${JSON.stringify(id)} but manifest.packageSet does not carry it`,
          );
        }
      }
      for (const id of setIdSet) {
        if (!planIdSet.has(id)) {
          issues.push(
            `manifest.packageSet carries ${JSON.stringify(id)} but manifest.composition.packageIds does not list it`,
          );
        }
      }
    }
  }

  return { verified: issues.length === 0, issues };
}
