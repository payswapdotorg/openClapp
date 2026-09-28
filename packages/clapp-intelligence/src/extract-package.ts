/**
 * Package extraction and promotion (CLAPP-W2-006).
 *
 * The learning half of the M6 loop: a successful reconstruction's STRUCTURAL
 * artifacts — a parity outcome summary, a plan component inventory, an
 * optional archetype hint and the behavioral IR digest — are distilled into
 * package candidate documents, and only parity-VERIFIED extractions are
 * promoted, with real evidence, through the W2-005 registry.
 *
 * The reconstruction artifacts arrive as duck-typed structural inputs
 * declared HERE (ReconstructionArtifacts): this module never imports
 * @clapp/synthesis, @clapp/benchmarks or any other clapp-* package (ADR-002
 * layering; the test file is the integration seam and may compose the real
 * benchmark harness).
 *
 * Discipline (the module's contract):
 *
 * - DETERMINISTIC — extraction is a pure function of the artifacts: same
 *   artifacts (even with reordered inventory arrays) produce byte-identical
 *   candidate documents. Package ids are content-addressed over the built
 *   candidate body (minus the id itself), versions are the constant first
 *   extraction version "0.1.0", and no timestamp, port or random value
 *   enters any document. Promotion evidence timestamps come from the CALLER's
 *   parity evidence — extraction and promotion never invent one.
 * - HONEST — artifacts that do not justify a package yield NO extraction
 *   with a recorded reason, never a fabricated package: unverified parity
 *   (divergent/blocked), an equivalence claim without a verification run id,
 *   contradictory parity (equivalent verdict with findings at or above minor
 *   severity — a real DiffReport verdict of "equivalent" means zero such
 *   findings), an empty plan inventory, a missing IR digest or an
 *   unattributable reconstruction id all abstain. The category is derived
 *   from the W2-004 archetype vocabulary when the classifier output is
 *   provided (verbatim label, "unknown" included); anything else gets the
 *   conservative generic category "application" — a label is never invented.
 *   Capabilities are derived from the plan inventory's own structure (the
 *   plan's component kinds, the presence of API entries and persistence
 *   keys) — nothing else is claimed.
 * - FAIL-CLOSED — every candidate passes the W2-005 validator
 *   (validatePackageDocument) before it is returned; a builder bug surfaces
 *   as a recorded skip reason, never as an invalid candidate.
 *   registerCandidates reports conflicts per package (typed registry errors
 *   are captured, never thrown). promoteVerified promotes ONLY on verdict
 *   "equivalent" with a non-empty verification run id and a real verifiedAt
 *   timestamp; anything else returns { promoted: false, reason } and never
 *   touches the registry.
 *
 * Candidate document shape: the FROZEN v0.1 envelope
 * ({ schemaVersion, package: {...} }) — exactly the shape
 * validatePackageDocument accepts and registry.register consumes. The flat
 * ClappPackage is what the registry stores and returns after registration
 * (W2-005 semantics).
 */

import { CLAPP_CONTRACT_VERSION, type ClappPackage } from "@clapp/contracts";
import { ARCHETYPES } from "./archetype.ts";
import { canonicalJson, compareStrings, isPlainObject, sha256Hex } from "./json.ts";
import {
  PackageConflictError,
  PackageImmutabilityError,
  PackageNotFoundError,
  type PackageValidationError,
} from "./package-error.ts";
import type { PackageRegistry, PromotionEvidence } from "./package-registry.ts";
import { validatePackageDocument } from "./package-schema.ts";
import { normalizePackageVersion } from "./package-version.ts";

// ---------------------------------------------------------------------------
// Public types — the structural reconstruction artifacts
// ---------------------------------------------------------------------------

/** The frozen parity verdict semantics (DiffReport["verdict"]). */
export type ParityVerdict = "equivalent" | "divergent" | "blocked";

/**
 * The parity outcome summary of a reconstruction: the structural digest of
 * the M4 DiffReport the verification stage produced. A verdict of
 * "equivalent" means ZERO findings at or above minor severity with a real
 * verification run id behind it.
 */
export interface ParitySummary {
  verdict: ParityVerdict;
  /** Id of the verification run that produced the verdict. */
  verificationRunId: string;
  /** Findings at minor severity (an equivalent verdict reports zero). */
  minorFindings: number;
  /** Findings at major severity and above (an equivalent verdict reports zero). */
  majorFindings: number;
}

/** One component of the synthesis plan's inventory. */
export interface PlanComponentEntry {
  /** Plan-relative path of the component. */
  path: string;
  /** The plan's own kind vocabulary for the component ("page", "form", ...). */
  kind: string;
  /** The plan's own name for the component. */
  name: string;
}

/** One API entry of the synthesis plan's inventory. */
export interface PlanApiEntry {
  /** The API route path, starting with "/". */
  path: string;
}

/** The structural inventory of what a synthesis plan actually built. */
export interface PlanInventory {
  components: PlanComponentEntry[];
  apiEntries: PlanApiEntry[];
  persistenceKeys: string[];
}

/** The optional W2-004 archetype classifier output feeding the category. */
export interface ArchetypeHint {
  /** A label of the frozen W2-004 vocabulary, or the classifier's "unknown". */
  label: string;
}

/**
 * The structural artifacts of one reconstruction that justify (or refuse) a
 * package extraction. Declared here; satisfied by the verification and
 * synthesis stages without any import of them.
 */
export interface ReconstructionArtifacts {
  reconstructionId: string;
  parity: ParitySummary;
  planInventory: PlanInventory;
  archetype?: ArchetypeHint;
  /** sha256 (lowercase hex) of the reconstruction's behavioral IR. */
  irDigest: string;
}

// ---------------------------------------------------------------------------
// Public types — extraction results
// ---------------------------------------------------------------------------

/** The package body: every ClappPackage field except the root schemaVersion. */
export type PackageCandidateBody = Omit<ClappPackage, "schemaVersion">;

/**
 * A package candidate document in the FROZEN v0.1 envelope shape — exactly
 * what validatePackageDocument accepts and registry.register consumes.
 */
export interface PackageCandidateDocument {
  schemaVersion: string;
  package: PackageCandidateBody;
}

/** One recorded abstention: why the artifacts justified no package. */
export interface SkippedExtraction {
  reason: string;
}

/** The result of extracting package candidates from reconstruction artifacts. */
export interface ExtractionResult {
  /** Schema-validated candidate documents (deterministic ids and versions). */
  candidates: PackageCandidateDocument[];
  /** Every reason extraction abstained, in gate order. */
  skipped: SkippedExtraction[];
}

// ---------------------------------------------------------------------------
// Public types — registration and promotion
// ---------------------------------------------------------------------------

/** One candidate's registration outcome (conflicts are reported, never thrown). */
export type CandidateRegistration =
  | { ok: true; id: string; version: string; idempotent: boolean }
  | { ok: false; id: string; version: string; reason: string };

/** The per-candidate results of registerCandidates, in input order. */
export interface RegistrationOutcome {
  results: CandidateRegistration[];
}

/**
 * The parity evidence promotion is gated on: the structural parity summary
 * plus the verification timestamp and the artifact citations preserved in
 * the promotion provenance notes. verifiedAt is supplied by the caller —
 * promotion never invents a timestamp.
 */
export interface ParityEvidence {
  verdict: ParityVerdict;
  verificationRunId: string;
  /** ISO-8601 timestamp of the verification run; required for promotion. */
  verifiedAt?: string;
  minorFindings?: number;
  majorFindings?: number;
  /** Optional artifact citations carried into the promotion provenance notes. */
  reconstructionId?: string;
  /** sha256 (lowercase hex) of the reconstruction's behavioral IR. */
  irDigest?: string;
}

/** The outcome of one fail-closed promotion attempt. */
export type PromotionOutcome =
  | {
      promoted: true;
      /** The promoted document as the registry stored (or already had) it. */
      document: ClappPackage;
      /** The evidence that justified (or re-affirmed) the promotion. */
      evidence: PromotionEvidence;
      /** True when the (id, version) was already promoted with identical evidence. */
      idempotent: boolean;
    }
  | { promoted: false; reason: string };

/** The M6 steps 1-3 accounting digest. */
export interface ExtractionSummary {
  /** Candidates extraction produced. */
  extracted: number;
  /** Promotions that succeeded (fresh or idempotent). */
  promoted: number;
  /** Extractions that abstained with a recorded reason. */
  abstained: number;
  /** The abstention reasons, in gate order. */
  reasons: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The conservative generic category when no trustworthy archetype feeds one. */
export const GENERIC_PACKAGE_CATEGORY = "application";

/** The first (and constant) version of a content-addressed extraction. */
const FIRST_EXTRACTION_VERSION = "0.1.0";

/** The contract-mandated identifier prefix (docs/clapp/CONTRACTS.md). */
const PACKAGE_ID_PREFIX = "clapp_package_";

/** Hex characters of content digest folded into the package id. */
const ID_DIGEST_LENGTH = 16;

/** Identifies the extractor inside every candidate's provenance. */
const EXTRACTED_BY = "clapp-intelligence/extract-package";

/** The W2-04 vocabulary plus the classifier's honest "unknown". */
const KNOWN_ARCHETYPE_LABELS: ReadonlySet<string> = new Set([
  ...ARCHETYPES.map((definition) => definition.label),
  "unknown",
]);

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

/** Non-empty string, or null. */
function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Finite non-negative integer, or null. */
function nonNegativeCount(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

/** Human-readable description of an unexpected value for reason strings. */
function describeValue(value: unknown): string {
  if (value === undefined) {
    return "missing";
  }
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return `"${value}"`;
  }
  return Array.isArray(value) ? "array" : typeof value;
}

/** Best-effort echo of a candidate's identity coordinate. */
function candidateCoordinate(candidate: unknown): { id: string; version: string } {
  const record = isPlainObject(candidate) ? candidate : null;
  const body =
    record !== null && isPlainObject(record.package)
      ? (record.package as Record<string, unknown>)
      : null;
  const id = nonEmptyString(body?.id) ?? "(unknown)";
  const rawVersion = nonEmptyString(body?.version);
  return { id, version: rawVersion === null ? "(unknown)" : normalizePackageVersion(rawVersion) };
}

/**
 * Normalizes the plan inventory: malformed entries are dropped (each entry
 * stands alone), well-formed entries are deduplicated and sorted
 * deterministically, and every returned entry is a fresh object detached
 * from the input.
 */
function normalizePlanInventory(raw: unknown): {
  components: PlanComponentEntry[];
  apiEntries: PlanApiEntry[];
  persistenceKeys: string[];
} {
  const source = isPlainObject(raw) ? raw : {};
  const components = normalizeEntries(source.components, (entry) => {
    if (!isPlainObject(entry)) {
      return null;
    }
    const path = nonEmptyString(entry.path);
    const kind = nonEmptyString(entry.kind);
    const name = nonEmptyString(entry.name);
    return path !== null && kind !== null && name !== null ? { path, kind, name } : null;
  });
  const apiEntries = normalizeEntries(source.apiEntries, (entry) => {
    if (!isPlainObject(entry)) {
      return null;
    }
    const path = nonEmptyString(entry.path);
    return path === null ? null : { path };
  });
  const persistenceKeys = normalizeEntries(source.persistenceKeys, nonEmptyString);
  return { components, apiEntries, persistenceKeys };
}

/** Keeps well-formed entries, deduplicates by canonical key, sorts by it. */
function normalizeEntries<T>(raw: unknown, read: (entry: unknown) => T | null): T[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const kept = new Map<string, T>();
  for (const entry of raw) {
    const value = read(entry);
    if (value === null) {
      continue;
    }
    kept.set(JSON.stringify(value), value);
  }
  return [...kept.entries()]
    .sort((left, right) => compareStrings(left[0], right[0]))
    .map((pair) => pair[1]);
}

/**
 * Derives the package category from the archetype hint: a label of the frozen
 * W2-004 vocabulary (or the classifier's honest "unknown") is used verbatim;
 * an absent, malformed or out-of-vocabulary label falls back to the
 * conservative generic — a label is never invented. Returns the label that
 * fed the category (null when the generic was used).
 */
function deriveCategory(archetype: unknown): { category: string; label: string | null } {
  const label = isPlainObject(archetype) ? nonEmptyString(archetype.label) : null;
  if (label !== null && KNOWN_ARCHETYPE_LABELS.has(label)) {
    return { category: label, label };
  }
  return { category: GENERIC_PACKAGE_CATEGORY, label: null };
}

// ---------------------------------------------------------------------------
// extractPackageCandidates
// ---------------------------------------------------------------------------

/**
 * Extracts package candidate documents from one reconstruction's structural
 * artifacts. Deterministic and fail-closed: the artifacts either justify
 * exactly one schema-valid candidate (accepted by validatePackageDocument,
 * with a content-addressed id and the constant first-extraction version
 * 0.1.0), or they justify nothing and every abstention is recorded with a
 * reason. Never throws, never fabricates.
 */
export function extractPackageCandidates(input: ReconstructionArtifacts): ExtractionResult {
  const skip = (reason: string): ExtractionResult => ({ candidates: [], skipped: [{ reason }] });

  if (!isPlainObject(input)) {
    return skip("reconstruction artifacts are missing or malformed: nothing to extract");
  }

  const reconstructionId = nonEmptyString(input.reconstructionId);
  if (reconstructionId === null) {
    return skip(
      `reconstruction id is ${describeValue(input.reconstructionId)}: artifacts are not attributable, extraction abstains`,
    );
  }

  const parity = isPlainObject(input.parity) ? input.parity : null;
  const verdict = parity === null ? undefined : parity.verdict;
  if (verdict !== "equivalent") {
    return skip(
      `parity verdict is ${describeValue(verdict)} (reconstruction ${reconstructionId}): only verified "equivalent" parity justifies a package, extraction abstains`,
    );
  }
  const verificationRunId = nonEmptyString(parity?.verificationRunId);
  if (verificationRunId === null) {
    return skip(
      `parity is equivalent but cites ${describeValue(parity?.verificationRunId)} as verification run id (reconstruction ${reconstructionId}): unverifiable parity never extracts a package`,
    );
  }
  const minorFindings = nonNegativeCount(parity?.minorFindings);
  const majorFindings = nonNegativeCount(parity?.majorFindings);
  if (minorFindings === null || majorFindings === null) {
    return skip(
      `parity findings counts are malformed (minor ${describeValue(parity?.minorFindings)}, major ${describeValue(parity?.majorFindings)}; reconstruction ${reconstructionId}): extraction cannot trust the parity summary`,
    );
  }
  if (minorFindings > 0 || majorFindings > 0) {
    const total = minorFindings + majorFindings;
    return skip(
      `parity claims equivalence but reports ${total} finding(s) at or above minor severity (reconstruction ${reconstructionId}): contradictory parity evidence never extracts a package`,
    );
  }

  const inventory = normalizePlanInventory(input.planInventory);
  if (
    inventory.components.length === 0 &&
    inventory.apiEntries.length === 0 &&
    inventory.persistenceKeys.length === 0
  ) {
    return skip(
      `plan inventory is empty (reconstruction ${reconstructionId}): nothing to package, an empty shell package is never extracted`,
    );
  }

  const irDigest = nonEmptyString(input.irDigest);
  if (irDigest === null) {
    return skip(
      `IR digest is ${describeValue(input.irDigest)} (reconstruction ${reconstructionId}): the candidate would cite no behavioral model, extraction abstains`,
    );
  }

  return buildCandidate({
    reconstructionId,
    verificationRunId,
    inventory,
    archetype: input.archetype,
    irDigest,
  });
}

/** The well-formed, gate-passing inputs of the candidate builder. */
interface CandidateInputs {
  reconstructionId: string;
  verificationRunId: string;
  inventory: ReturnType<typeof normalizePlanInventory>;
  archetype: unknown;
  irDigest: string;
}

/** Builds the one candidate document (or records why it cannot be built). */
function buildCandidate(inputs: CandidateInputs): ExtractionResult {
  const { reconstructionId, verificationRunId, irDigest } = inputs;
  const { components, apiEntries, persistenceKeys } = inputs.inventory;
  const { category, label } = deriveCategory(inputs.archetype);

  // The artifact digest: the fingerprint of everything extraction consumed.
  const artifactDigest = contentDigestOrNull({
    reconstructionId,
    parity: {
      verdict: "equivalent" as const,
      verificationRunId,
      minorFindings: 0,
      majorFindings: 0,
    },
    planInventory: { components, apiEntries, persistenceKeys },
    archetypeLabel: label,
    irDigest,
  });
  if (artifactDigest === null) {
    return {
      candidates: [],
      skipped: [
        {
          reason: `reconstruction artifacts are not JSON-representable (reconstruction ${reconstructionId}): no content-addressed identity is derivable, extraction abstains`,
        },
      ],
    };
  }

  // Capabilities: derived from the inventory's own structure only.
  const kinds = new Set(components.map((component) => component.kind));
  const capabilities = [
    ...[...kinds].map((kind) => `component:${kind}`),
    ...(apiEntries.length > 0 ? ["http-api"] : []),
    ...(persistenceKeys.length > 0 ? ["persistent-state"] : []),
  ].sort(compareStrings);

  const body: Omit<PackageCandidateBody, "id"> = {
    version: FIRST_EXTRACTION_VERSION,
    category,
    purpose:
      `Reconstructed ${category} package extracted from reconstruction ${reconstructionId}: ` +
      `${components.length} component(s), ${apiEntries.length} API entr${apiEntries.length === 1 ? "y" : "ies"}, ` +
      `${persistenceKeys.length} persistence key(s), parity equivalent under verification run ${verificationRunId}.`,
    interface: {
      components: components.map((component) => ({
        path: component.path,
        kind: component.kind,
        name: component.name,
      })),
      apiEntries: apiEntries.map((entry) => ({ path: entry.path })),
      persistenceKeys: [...persistenceKeys],
    },
    capabilities,
    constraints: [],
    dependencies: [],
    supportedTargets: [],
    tests: [],
    benchmark: {
      parity: {
        verdict: "equivalent",
        verificationRunId,
        minorFindings: 0,
        majorFindings: 0,
      },
      irDigest,
    },
    failureModes: [],
    provenance: {
      reconstructionId,
      verificationRunId,
      parityVerdict: "equivalent",
      irDigest,
      artifactDigest,
      extractedBy: EXTRACTED_BY,
      ...(label !== null ? { archetypeLabel: label } : {}),
    },
  };

  // Content-addressed id over the built body (minus the id itself):
  // same content -> same id, any content difference -> a different package.
  const bodyDigest = contentDigestOrNull(body);
  if (bodyDigest === null) {
    return {
      candidates: [],
      skipped: [
        {
          reason: `extracted candidate body is not JSON-representable (reconstruction ${reconstructionId}): no content-addressed identity is derivable, extraction abstains`,
        },
      ],
    };
  }
  const document: PackageCandidateDocument = {
    schemaVersion: CLAPP_CONTRACT_VERSION,
    package: { id: `${PACKAGE_ID_PREFIX}${bodyDigest.slice(0, ID_DIGEST_LENGTH)}`, ...body },
  };

  // The W2-005 validator is the gate: a builder bug is a recorded skip,
  // never an invalid candidate.
  const validated = validatePackageDocument(document);
  if (!validated.ok) {
    return {
      candidates: [],
      skipped: [
        {
          reason:
            `extracted candidate failed package schema validation (reconstruction ${reconstructionId}): ` +
            validated.errors.map((error) => error.message).join("; "),
        },
      ],
    };
  }
  return { candidates: [document], skipped: [] };
}

/** Canonical-JSON sha256 of a value, or null when it cannot be serialized. */
function contentDigestOrNull(value: unknown): string | null {
  const canonical = canonicalJson(value);
  return canonical === undefined ? null : sha256Hex(canonical);
}

// ---------------------------------------------------------------------------
// registerCandidates
// ---------------------------------------------------------------------------

/**
 * Registers every candidate through the W2-005 registry, idempotently:
 * byte-identical re-registration is a no-op success (reported with
 * idempotent: true), and every conflict — content conflict, version
 * regression, immutability, validation failure — is reported per package as
 * a failed result, never thrown.
 */
export function registerCandidates(
  registry: PackageRegistry,
  candidates: readonly PackageCandidateDocument[],
): RegistrationOutcome {
  const results: CandidateRegistration[] = [];
  for (const candidate of candidates) {
    results.push(registerOne(registry, candidate));
  }
  return { results };
}

/** Registers one candidate, capturing every typed failure as a reason. */
function registerOne(
  registry: PackageRegistry,
  candidate: PackageCandidateDocument,
): CandidateRegistration {
  const { id, version } = candidateCoordinate(candidate);
  const alreadyRegistered =
    id !== "(unknown)" && version !== "(unknown)" ? registry.get(id, version) !== null : false;
  try {
    const registration = registry.register(candidate);
    if (!registration.ok) {
      return { ok: false, id, version, reason: validationReason(registration.errors) };
    }
    return {
      ok: true,
      id: registration.identity.id,
      version: registration.identity.version,
      idempotent: alreadyRegistered,
    };
  } catch (error) {
    if (error instanceof PackageConflictError || error instanceof PackageImmutabilityError) {
      return { ok: false, id, version, reason: error.message };
    }
    throw error;
  }
}

/** Joins collected validation errors into one reason string. */
function validationReason(errors: PackageValidationError[]): string {
  return errors.length === 0
    ? "package document failed schema validation"
    : errors.map((error) => error.message).join("; ");
}

// ---------------------------------------------------------------------------
// promoteVerified
// ---------------------------------------------------------------------------

/**
 * Fail-closed promotion through the W2-005 registry: ONLY verdict
 * "equivalent" with a non-empty verification run id AND a real verifiedAt
 * timestamp promotes — the evidence records both plus provenance notes
 * citing the parity artifacts. Anything else returns { promoted: false,
 * reason } and never touches the registry. A contradictory equivalence
 * claim (non-zero findings at or above minor severity) is refused the same
 * way. Re-promotion with identical evidence is the registry's own idempotent
 * no-op (reported with idempotent: true); registry-level typed failures
 * (unknown package, immutable re-promotion) are returned as reasons.
 */
export function promoteVerified(
  registry: PackageRegistry,
  candidate: { id: string; version: string },
  parity: ParityEvidence,
): PromotionOutcome {
  const record: unknown = parity;
  if (!isPlainObject(record)) {
    return {
      promoted: false,
      reason: `parity evidence is ${describeValue(parity)}: promotion requires verified parity evidence`,
    };
  }
  if (record.verdict !== "equivalent") {
    return {
      promoted: false,
      reason:
        `parity verdict is ${describeValue(record.verdict)} (package ${candidate.id}@${candidate.version}): ` +
        'only verified "equivalent" parity promotes',
    };
  }
  const verificationRunId = nonEmptyString(record.verificationRunId);
  if (verificationRunId === null) {
    return {
      promoted: false,
      reason:
        `parity is equivalent but cites ${describeValue(record.verificationRunId)} as verification run id ` +
        `(package ${candidate.id}@${candidate.version}): unverifiable parity never promotes`,
    };
  }
  const verifiedAt = nonEmptyString(record.verifiedAt);
  if (verifiedAt === null) {
    return {
      promoted: false,
      reason:
        `parity is equivalent but carries ${describeValue(record.verifiedAt)} as verifiedAt ` +
        `(package ${candidate.id}@${candidate.version}): promotion evidence must cite when verification happened, ` +
        "and promotion never invents a timestamp",
    };
  }
  const minorFindings = record.minorFindings;
  const majorFindings = record.majorFindings;
  const minor = minorFindings === undefined ? null : nonNegativeCount(minorFindings);
  const major = majorFindings === undefined ? null : nonNegativeCount(majorFindings);
  if (minor === null && minorFindings !== undefined) {
    return {
      promoted: false,
      reason: `parity minorFindings is malformed (${describeValue(minorFindings)}; package ${candidate.id}@${candidate.version})`,
    };
  }
  if (major === null && majorFindings !== undefined) {
    return {
      promoted: false,
      reason: `parity majorFindings is malformed (${describeValue(majorFindings)}; package ${candidate.id}@${candidate.version})`,
    };
  }
  if ((minor ?? 0) > 0 || (major ?? 0) > 0) {
    const total = (minor ?? 0) + (major ?? 0);
    return {
      promoted: false,
      reason:
        `parity claims equivalence but reports ${total} finding(s) at or above minor severity ` +
        `(package ${candidate.id}@${candidate.version}): contradictory parity evidence never promotes`,
    };
  }

  const evidence = buildPromotionEvidence({
    verificationRunId,
    verifiedAt,
    minor,
    major,
    reconstructionId: nonEmptyString(record.reconstructionId),
    irDigest: nonEmptyString(record.irDigest),
  });

  const version = normalizePackageVersion(candidate.version);
  // The registry's own public status surface decides "already promoted".
  const alreadyPromoted = registry
    .list({ status: "promoted" })
    .some((document) => document.id === candidate.id && document.version === version);
  try {
    const document = registry.promote(candidate.id, version, evidence);
    return { promoted: true, document, evidence, idempotent: alreadyPromoted };
  } catch (error) {
    if (error instanceof PackageNotFoundError || error instanceof PackageImmutabilityError) {
      return { promoted: false, reason: error.message };
    }
    throw error;
  }
}

/** The well-formed inputs of the promotion evidence builder. */
interface PromotionEvidenceInputs {
  verificationRunId: string;
  verifiedAt: string;
  minor: number | null;
  major: number | null;
  reconstructionId: string | null;
  irDigest: string | null;
}

/** Builds the registry PromotionEvidence with notes citing the artifacts. */
function buildPromotionEvidence(inputs: PromotionEvidenceInputs): PromotionEvidence {
  const counts =
    inputs.minor === null && inputs.major === null
      ? "findings not reported"
      : `${inputs.major ?? 0} major, ${inputs.minor ?? 0} minor findings`;
  const notes = [
    `parity verdict: equivalent (${counts})`,
    `verification run: ${inputs.verificationRunId}`,
  ];
  if (inputs.reconstructionId !== null) {
    notes.push(`reconstruction: ${inputs.reconstructionId}`);
  }
  if (inputs.irDigest !== null) {
    notes.push(`ir digest: ${inputs.irDigest}`);
  }
  return {
    verifiedAt: inputs.verifiedAt,
    verificationRunId: inputs.verificationRunId,
    provenanceNotes: notes,
  };
}

// ---------------------------------------------------------------------------
// extractionSummary
// ---------------------------------------------------------------------------

/**
 * The M6 steps 1-3 accounting digest: how many candidates extraction
 * produced, how many of them were promoted (pass the promotion outcomes
 * gathered while promoting this extraction's candidates), how many
 * extractions abstained, and every abstention reason in gate order.
 */
export function extractionSummary(
  result: ExtractionResult,
  promotions: readonly PromotionOutcome[] = [],
): ExtractionSummary {
  return {
    extracted: result.candidates.length,
    promoted: promotions.filter((outcome) => outcome.promoted).length,
    abstained: result.skipped.length,
    reasons: result.skipped.map((skip) => skip.reason),
  };
}
