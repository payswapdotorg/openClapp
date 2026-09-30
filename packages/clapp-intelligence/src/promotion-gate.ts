/**
 * Package promotion/evaluation gate (CLAPP-W2-010).
 *
 * The last open item of the learning system (ROADMAP M6): the gate that
 * decides whether a package candidate's benchmark evaluation justifies
 * promotion. SECURITY.md ("Only verified packages may enter automatic
 * composition") and LEARNING.md ("The claim "CLAPP learns" is accepted only
 * when the repeated benchmark shows measurable improvement without weakening
 * acceptance criteria") are the two authorities, and the gate enforces both
 * fail-closed.
 *
 * Discipline (the module's contract):
 *
 * - BENCHMARK-GROUNDED — the evaluation input is the W2-009 repeated-sequence
 *   pair: a from-record (the scratch build, A1/B1) and a to-record (the reuse
 *   build, A2/B2, as the CALLER measured it). The gate composes the real
 *   buildLearningComparison to derive the LearningComparisonReport — the
 *   grounding artifact — and applies its criteria over the report and its
 *   embedded canonical build records. The gate never invents a measurement:
 *   everything it reads was caller-supplied and is already embedded,
 *   canonicalized, in the report. The report's honestly-unavailable rows
 *   (build time, failure recurrence) are NOT gate inputs: the gate demands
 *   exactly what its criteria name and nothing more, and never demands an
 *   unavailable dimension become available.
 * - EXPLICIT FROZEN CRITERIA — PROMOTION_GATE_CRITERIA is the gate's
 *   contract. Every criterion is evaluated fail-closed: unknown, absent or
 *   contradictory input withholds, never passes. The public surface accepts
 *   NO per-call criteria override: the exported constant is the gate, and a
 *   future revision goes through the tech lead (an ADR, not an argument).
 * - THE W2-006 PARITY DISCIPLINE FIRST — the gated promotion flow applies the
 *   promoteVerified semantics (ONLY verdict "equivalent" with a non-empty
 *   verification run id AND a real verifiedAt timestamp; contradictory
 *   equivalence — non-zero findings at or above minor severity — refused)
 *   before the evaluation gate, and only when BOTH pass does it call the
 *   frozen W2-005 registry's promote, recording promotion evidence whose
 *   provenance notes cite the benchmark report id and the gate decision id
 *   (the benchmark grounding SECURITY.md demands). A withheld or failed
 *   candidate is NEVER promoted: the registry is left untouched (the package
 *   stays a candidate) and the outcome carries every reason, never just the
 *   first. Re-promotion with byte-identical evidence remains the registry's
 *   own idempotent no-op; registry-level typed failures (unknown package,
 *   immutable re-promotion) are returned as reasons.
 * - DETERMINISTIC, CLOCK-FREE, PURE — the decision is a pure function of the
 *   candidate coordinate plus the report: the same inputs produce a
 *   byte-identical decision with the same content-addressed clapp_eval_ id,
 *   and reordered package-id arrays in the build records do not change it
 *   (the W2-009 composer canonicalizes them). No wall-clock, no randomness,
 *   no external data, and no aggregate score anywhere on the decision: it is
 *   promoted with its citations or withheld with every recorded reason.
 * - FAIL-CLOSED — an unevaluated package (no benchmark records) is withheld
 *   with a recorded unevaluated reason, never silently promoted; a package
 *   whose evaluation could not measure parity is withheld; a package the
 *   evaluation did not exercise is withheld. Malformed inputs (a missing
 *   candidate coordinate, build records the W2-009 composer rejects, a
 *   malformed grounding report) fail closed with collected typed errors —
 *   never a partially-derived decision.
 */

import type { ClappPackage } from "@clapp/contracts";
import type { ParityEvidence, ParitySummary } from "./extract-package.ts";
import { canonicalJson, isPlainObject, sha256Hex } from "./json.ts";
import {
  buildLearningComparison,
  type LearningBuildRecord,
  type LearningComparisonReport,
  LearningRecordError,
} from "./learning-benchmark.ts";
import { PackageImmutabilityError, PackageNotFoundError } from "./package-error.ts";
import type { PackageRegistry, PromotionEvidence } from "./package-registry.ts";
import { normalizePackageVersion } from "./package-version.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The gate-decision id prefix. NOT yet in docs/clapp/CONTRACTS.md's "Core
 * identifiers" list: contracts are frozen and tech-lead-owned (a change
 * requires an ADR, a version bump when applicable, a migration/compatibility
 * test, and updated acceptance criteria), and the `clapp_eval_` revision is
 * proposed in the CLAPP-W2-010 completion report instead of being edited in
 * here. Consumers must treat the prefix as module-scoped until the contract
 * revision lands.
 */
export const EVALUATION_DECISION_ID_PREFIX = "clapp_eval_";

/** Hex characters of content digest folded into the decision id (the W2-006/W2-009 discipline). */
const ID_DIGEST_LENGTH = 16;

/** The gate criterion ids (private: the ids exist to type the criteria contract). */
const CRITERION_IDS = [
  "reuse-build-parity-verified-equivalent",
  "evaluation-acceptance-integrity-unweakened",
  "evaluation-exercised-the-package",
  "parity-evidence-cites-verification-run",
] as const;

/** One id of the frozen criteria contract. */
export type PromotionGateCriterionId = (typeof CRITERION_IDS)[number];

/** One criterion of the frozen gate contract: a stable id plus its sentence. */
export interface PromotionGateCriterion {
  readonly id: PromotionGateCriterionId;
  readonly description: string;
}

/**
 * The promotion gate's criteria contract — THE gate, frozen. There is no
 * per-call override anywhere on the public surface: every decision embeds
 * (deep-equals) this constant, and a future revision goes through the tech
 * lead as an ADR. The four criteria, in evaluation order:
 *
 * 1. reuse-build-parity-verified-equivalent — the evaluated (reuse) build's
 *    parity verdict must be a real verified "equivalent": the ParitySummary
 *    semantics of zero findings at or above minor severity, with a real
 *    verification run behind it;
 * 2. evaluation-acceptance-integrity-unweakened — the evaluation's acceptance
 *    integrity must NOT be weakened: LEARNING.md's bar, because a weakened
 *    evaluation can never justify promotion;
 * 3. evaluation-exercised-the-package — the evaluated build must have REUSED
 *    the candidate: the candidate's id appears among the reuse build's
 *    reused package ids, so the benchmark exercised the package;
 * 4. parity-evidence-cites-verification-run — the parity evidence must cite a
 *    non-empty verification run id.
 */
export const PROMOTION_GATE_CRITERIA = [
  {
    id: "reuse-build-parity-verified-equivalent",
    description:
      'the evaluated (reuse) build\'s parity verdict is a real verified "equivalent": zero findings ' +
      "at or above minor severity, with a real verification run behind it",
  },
  {
    id: "evaluation-acceptance-integrity-unweakened",
    description:
      "the evaluation's acceptance integrity is NOT weakened: a weakened evaluation can never justify " +
      "promotion (LEARNING.md)",
  },
  {
    id: "evaluation-exercised-the-package",
    description:
      "the evaluated (reuse) build REUSED the candidate: the candidate's id appears among the reuse " +
      "build's reused package ids, so the benchmark exercised the package",
  },
  {
    id: "parity-evidence-cites-verification-run",
    description: "the parity evidence cites a non-empty verification run id",
  },
] as const satisfies readonly PromotionGateCriterion[];

// ---------------------------------------------------------------------------
// Public types — the gate decision
// ---------------------------------------------------------------------------

/** The gate's decision over one candidate's benchmark evaluation. */
export interface PromotionGateDecision {
  /** Content-addressed: EVALUATION_DECISION_ID_PREFIX + a sha256 prefix of the core. */
  id: string;
  /** "promoted" when every criterion passed; "withheld" with reasons otherwise. */
  outcome: "promoted" | "withheld";
  /** The candidate coordinate the decision cites (version in canonical form). */
  candidate: { id: string; version: string };
  /** The grounding report, cited by its own content-addressed id. */
  reportId: string;
  /** The frozen criteria the decision applied (deep-equals PROMOTION_GATE_CRITERIA). */
  criteria: PromotionGateCriterion[];
  /** EVERY recorded reason the decision was withheld, in criteria order; empty when promoted. */
  reasons: string[];
}

// ---------------------------------------------------------------------------
// Public types — the gated promotion flow
// ---------------------------------------------------------------------------

/**
 * The benchmark evaluation of one candidate: the W2-009 repeated-sequence
 * pair, as the caller measured it. The gate composes the real
 * buildLearningComparison over these records to derive the grounding report.
 */
export interface GatedPromotionEvaluation {
  /** The from-record: the scratch build (A1/B1). */
  from: LearningBuildRecord;
  /** The to-record: the reuse build (A2/B2). */
  to: LearningBuildRecord;
}

/** The gated promotion flow's input. */
export interface GatedPromotionInput {
  /** The candidate coordinate the gate decides about. */
  candidate: { id: string; version: string };
  /** The caller's parity evidence (the W2-006 ParityEvidence discipline input). */
  parity: ParityEvidence;
  /**
   * The benchmark evaluation. Absent means the package is unevaluated: it is
   * withheld with a recorded unevaluated reason, never silently promoted.
   */
  evaluation?: GatedPromotionEvaluation;
}

/** The outcome of one fail-closed gated promotion attempt. */
export type GatedPromotionOutcome =
  | {
      promoted: true;
      /** The promoting decision (every criterion met, the report cited by id). */
      decision: PromotionGateDecision;
      /** The promoted document as the registry stored (or already had) it. */
      document: ClappPackage;
      /** The evidence that justified (or re-affirmed) the promotion. */
      evidence: PromotionEvidence;
      /** True when the (id, version) was already promoted with identical evidence. */
      idempotent: boolean;
    }
  | {
      promoted: false;
      /** Every reason, the W2-006 parity-discipline reasons first; never just the first. */
      reasons: string[];
      /**
       * The derived decision, or null when no decision could be derived at
       * all (no report, malformed records, a missing candidate coordinate) —
       * never a partially-derived decision.
       */
      decision: PromotionGateDecision | null;
    };

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

/** Why a promotion-gate call failed closed. */
export type PromotionGateErrorCode =
  | "invalid-input"
  | "invalid-report"
  | "unrepresentable-decision";

/**
 * The typed fail-closed error of the promotion-gate surface. `issues` carries
 * every collected violation (never just the first) so no malformation is ever
 * silently ignored; the call returns a fully-derived decision or throws —
 * never a partial one.
 */
export class PromotionGateError extends Error {
  readonly code: PromotionGateErrorCode;
  readonly issues: readonly string[];

  constructor(code: PromotionGateErrorCode, message: string, issues: readonly string[] = []) {
    super(message);
    this.name = "PromotionGateError";
    this.code = code;
    this.issues = [...issues];
  }
}

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

/** Non-empty string, or null. */
function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
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

/**
 * Best-effort echo of the candidate's identity coordinate for reason strings
 * (the W2-006 candidateCoordinate discipline: "(unknown)" until validated).
 */
function candidateEcho(candidate: unknown): { id: string; version: string } {
  const record = isPlainObject(candidate) ? candidate : {};
  const id = nonEmptyString(record.id);
  const rawVersion = nonEmptyString(record.version);
  return {
    id: id === null ? "(unknown)" : id,
    version: rawVersion === null ? "(unknown)" : normalizePackageVersion(rawVersion),
  };
}

/** Reads an array of non-empty strings, or null when malformed. */
function readStringArray(value: unknown, field: string, issues: string[]): string[] | null {
  if (
    !Array.isArray(value) ||
    !value.every((entry) => typeof entry === "string" && entry.length > 0)
  ) {
    issues.push(`${field} must be an array of non-empty strings`);
    return null;
  }
  return [...(value as string[])];
}

/** Reads the report's parity summary for the criteria: type-valid or issues. */
function readParityForGate(value: unknown, issues: string[]): ParitySummary | null {
  if (!isPlainObject(value)) {
    issues.push("report.toBuild.parity must be a parity summary object");
    return null;
  }
  const parityIssues: string[] = [];
  const verdict = value.verdict;
  if (verdict !== "equivalent" && verdict !== "divergent" && verdict !== "blocked") {
    parityIssues.push(
      'report.toBuild.parity.verdict must be "equivalent", "divergent" or "blocked"',
    );
  }
  const verificationRunId = nonEmptyString(value.verificationRunId);
  if (verificationRunId === null) {
    parityIssues.push("report.toBuild.parity.verificationRunId must be a non-empty string");
  }
  const minorFindings =
    value.minorFindings === undefined ? undefined : readNonNegativeCount(value.minorFindings);
  if (minorFindings === undefined) {
    parityIssues.push("report.toBuild.parity.minorFindings must be a non-negative integer");
  }
  const majorFindings =
    value.majorFindings === undefined ? undefined : readNonNegativeCount(value.majorFindings);
  if (majorFindings === undefined) {
    parityIssues.push("report.toBuild.parity.majorFindings must be a non-negative integer");
  }
  if (parityIssues.length > 0) {
    issues.push(...parityIssues);
    return null;
  }
  return {
    verdict: verdict as ParitySummary["verdict"],
    verificationRunId: verificationRunId as string,
    minorFindings: minorFindings as number,
    majorFindings: majorFindings as number,
  };
}

/** Non-negative integer, or undefined when malformed. */
function readNonNegativeCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** The report fields the gate's criteria read, structurally validated. */
interface GateReportView {
  id: string;
  toBuild: {
    appId: string;
    reusedPackageIds: string[];
    parity?: ParitySummary;
  };
  acceptanceIntegrity: {
    weakened: boolean;
    weakenedAppIds: string[];
  };
}

/**
 * Structurally validates exactly the report fields the criteria read (the
 * report's id citation, the reuse build's identity/reuse/parity, and the
 * acceptance-integrity declaration) and nothing more: the gate never demands
 * a dimension its criteria do not name. Type-level malformation is collected
 * as typed issues; value-level failures (unmeasured parity, a weakened
 * evaluation, a not-reused candidate) are criterion outcomes, not issues.
 */
function readGateReport(value: unknown, issues: string[]): GateReportView | null {
  if (!isPlainObject(value)) {
    issues.push("the grounding report must be an object");
    return null;
  }
  const reportIssues: string[] = [];

  const id = nonEmptyString(value.id);
  if (id === null) {
    reportIssues.push("report.id must be a non-empty string");
  }

  const toBuild = isPlainObject(value.toBuild) ? value.toBuild : null;
  let appId: string | null = null;
  let reusedPackageIds: string[] | null = null;
  let parity: ParitySummary | null = null;
  let parityPresent = false;
  if (toBuild === null) {
    reportIssues.push("report.toBuild must be an object");
  } else {
    appId = nonEmptyString(toBuild.appId);
    if (appId === null) {
      reportIssues.push("report.toBuild.appId must be a non-empty string");
    }
    if (toBuild.phase !== "scratch" && toBuild.phase !== "reuse") {
      reportIssues.push('report.toBuild.phase must be "scratch" or "reuse"');
    }
    reusedPackageIds = readStringArray(
      toBuild.reusedPackageIds,
      "report.toBuild.reusedPackageIds",
      reportIssues,
    );
    if (toBuild.parity !== undefined) {
      parityPresent = true;
      parity = readParityForGate(toBuild.parity, reportIssues);
    }
  }

  const integrity = isPlainObject(value.acceptanceIntegrity) ? value.acceptanceIntegrity : null;
  let acceptanceIntegrity: { weakened: boolean; weakenedAppIds: string[] } | null = null;
  if (integrity === null) {
    reportIssues.push("report.acceptanceIntegrity must be an object");
  } else {
    const weakened = integrity.weakened;
    const weakenedAppIds = readStringArray(
      integrity.weakenedAppIds,
      "report.acceptanceIntegrity.weakenedAppIds",
      reportIssues,
    );
    if (typeof weakened !== "boolean") {
      reportIssues.push("report.acceptanceIntegrity.weakened must be a boolean");
    } else if (weakenedAppIds !== null) {
      acceptanceIntegrity = { weakened, weakenedAppIds };
    }
  }

  if (
    reportIssues.length > 0 ||
    id === null ||
    appId === null ||
    reusedPackageIds === null ||
    acceptanceIntegrity === null ||
    (parityPresent && parity === null)
  ) {
    issues.push(...reportIssues);
    return null;
  }
  return {
    id,
    toBuild: {
      appId,
      reusedPackageIds,
      ...(parity !== null ? { parity } : {}),
    },
    acceptanceIntegrity,
  };
}

// ---------------------------------------------------------------------------
// decidePromotionGate
// ---------------------------------------------------------------------------

/**
 * The gate decision: a pure, deterministic function mapping the candidate
 * coordinate plus the benchmark-grounding report onto ONE decision. Every
 * criterion of the frozen PROMOTION_GATE_CRITERIA contract is evaluated
 * fail-closed; the decision is content-addressed under the clapp_eval_
 * prefix, embeds the criteria it applied, cites the candidate coordinate and
 * the report id, and carries EVERY recorded reason when withheld (never just
 * the first). No aggregate score exists anywhere on it. Malformed input (a
 * missing candidate coordinate) or a structurally malformed report fails
 * closed with a typed PromotionGateError collecting every issue — never a
 * partially-derived decision.
 */
export function decidePromotionGate(input: {
  candidate: { id: string; version: string };
  report: LearningComparisonReport;
}): PromotionGateDecision {
  if (!isPlainObject(input)) {
    throw new PromotionGateError(
      "invalid-input",
      "the gate input must be an object with candidate and report; failing closed",
      ["the gate input must be an object with candidate and report"],
    );
  }

  const inputIssues: string[] = [];
  const candidate = readCandidateCoordinate(input.candidate, inputIssues);
  if (inputIssues.length > 0 || candidate === null) {
    throw new PromotionGateError(
      "invalid-input",
      `the gate input is malformed (${inputIssues.length} ${
        inputIssues.length === 1 ? "issue" : "issues"
      }); failing closed`,
      inputIssues,
    );
  }

  const reportIssues: string[] = [];
  const report = readGateReport(input.report, reportIssues);
  if (reportIssues.length > 0 || report === null) {
    throw new PromotionGateError(
      "invalid-report",
      `the grounding report is structurally invalid (${reportIssues.length} ${
        reportIssues.length === 1 ? "issue" : "issues"
      }); failing closed`,
      reportIssues,
    );
  }

  const reasons: string[] = [];
  const appId = report.toBuild.appId;
  const parity = report.toBuild.parity;

  // Criterion 1 — the evaluated (reuse) build's parity verdict is a real
  // verified "equivalent": zero findings at or above minor severity.
  if (parity === undefined) {
    reasons.push(
      `criterion "reuse-build-parity-verified-equivalent" fails: the evaluated (reuse) build (app ` +
        `${appId}) did not measure parity: an unmeasured parity verdict never promotes`,
    );
  } else if (parity.verdict !== "equivalent") {
    reasons.push(
      `criterion "reuse-build-parity-verified-equivalent" fails: the evaluated (reuse) build's parity ` +
        `verdict is "${parity.verdict}" (app ${appId}): only a verified "equivalent" verdict promotes`,
    );
  } else if (parity.minorFindings > 0 || parity.majorFindings > 0) {
    const total = parity.minorFindings + parity.majorFindings;
    reasons.push(
      `criterion "reuse-build-parity-verified-equivalent" fails: the evaluated (reuse) build claims ` +
        `"equivalent" with ${total} finding(s) at or above minor severity (app ${appId}): ` +
        "contradictory parity evidence never promotes",
    );
  }

  // Criterion 2 — the evaluation's acceptance integrity is NOT weakened.
  if (report.acceptanceIntegrity.weakened) {
    reasons.push(
      `criterion "evaluation-acceptance-integrity-unweakened" fails: the evaluation declared weakened ` +
        `acceptance criteria (app ${report.acceptanceIntegrity.weakenedAppIds.join(", ")}): a weakened ` +
        "evaluation can never justify promotion",
    );
  }

  // Criterion 3 — the evaluation exercised the package.
  if (!report.toBuild.reusedPackageIds.includes(candidate.id)) {
    reasons.push(
      `criterion "evaluation-exercised-the-package" fails: the evaluated (reuse) build (app ${appId}) ` +
        `did not reuse ${candidate.id}@${candidate.version}: the benchmark must have exercised the package`,
    );
  }

  // Criterion 4 — the parity evidence cites a non-empty verification run id.
  if (parity === undefined) {
    reasons.push(
      `criterion "parity-evidence-cites-verification-run" fails: the parity evidence cites no ` +
        `verification run id (app ${appId}): parity evidence without a real verification run never promotes`,
    );
  }

  const outcome: "promoted" | "withheld" = reasons.length === 0 ? "promoted" : "withheld";
  const core = {
    outcome,
    candidate,
    reportId: report.id,
    criteria: PROMOTION_GATE_CRITERIA,
    reasons,
  };
  const canonical = canonicalJson(core);
  if (canonical === undefined) {
    throw new PromotionGateError(
      "unrepresentable-decision",
      "the gate decision is not JSON-representable: no content-addressed decision id is derivable",
    );
  }
  return {
    id: `${EVALUATION_DECISION_ID_PREFIX}${sha256Hex(canonical).slice(0, ID_DIGEST_LENGTH)}`,
    outcome,
    candidate: { id: candidate.id, version: candidate.version },
    reportId: report.id,
    criteria: PROMOTION_GATE_CRITERIA.map((criterion) => ({
      id: criterion.id,
      description: criterion.description,
    })),
    reasons: [...reasons],
  };
}

/** Validates the candidate coordinate: non-empty id and version (canonical form). */
function readCandidateCoordinate(
  value: unknown,
  issues: string[],
): { id: string; version: string } | null {
  if (!isPlainObject(value)) {
    issues.push("candidate must be an object with id and version");
    return null;
  }
  const id = nonEmptyString(value.id);
  if (id === null) {
    issues.push("candidate.id must be a non-empty string");
  }
  const rawVersion = nonEmptyString(value.version);
  if (rawVersion === null) {
    issues.push("candidate.version must be a non-empty string");
  }
  if (id === null || rawVersion === null) {
    return null;
  }
  return { id, version: normalizePackageVersion(rawVersion) };
}

// ---------------------------------------------------------------------------
// The W2-006 parity discipline (the promoteVerified semantics), applied first
// ---------------------------------------------------------------------------

/** The validated parity evidence the promotion would record. */
interface ParityDisciplineEvidence {
  verificationRunId: string;
  verifiedAt: string;
  minor: number | null;
  major: number | null;
}

/** The parity discipline's verdict: every reason, plus the evidence when clean. */
interface ParityDisciplineVerdict {
  reasons: string[];
  evidence: ParityDisciplineEvidence | null;
}

/**
 * The W2-006 parity discipline (the promoteVerified semantics) applied as the
 * FIRST gate of the flow: ONLY a verdict "equivalent" with a non-empty
 * verification run id AND a real verifiedAt timestamp may promote, and a
 * contradictory equivalence claim (non-zero findings at or above minor
 * severity) is refused the same way. Every violation is collected — never
 * just the first. This is the check half; the mutation half goes through the
 * frozen W2-005 registry surface (registry.promote), which independently
 * validates the evidence it records.
 */
function parityDiscipline(
  candidate: { id: string; version: string },
  parity: ParityEvidence,
): ParityDisciplineVerdict {
  const reasons: string[] = [];
  if (!isPlainObject(parity)) {
    return {
      reasons: [
        `W2-006 parity gate: parity evidence is ${describeValue(parity)} (package ` +
          `${candidate.id}@${candidate.version}): gated promotion requires verified parity evidence`,
      ],
      evidence: null,
    };
  }
  if (parity.verdict !== "equivalent") {
    reasons.push(
      `W2-006 parity gate: parity verdict is ${describeValue(parity.verdict)} (package ` +
        `${candidate.id}@${candidate.version}): only verified "equivalent" parity promotes`,
    );
  }
  const verificationRunId = nonEmptyString(parity.verificationRunId);
  if (verificationRunId === null) {
    reasons.push(
      `W2-006 parity gate: parity is equivalent but cites ${describeValue(parity.verificationRunId)} ` +
        `as verification run id (package ${candidate.id}@${candidate.version}): unverifiable parity ` +
        "never promotes",
    );
  }
  const verifiedAt = nonEmptyString(parity.verifiedAt);
  if (verifiedAt === null) {
    reasons.push(
      `W2-006 parity gate: parity is equivalent but carries ${describeValue(parity.verifiedAt)} as ` +
        `verifiedAt (package ${candidate.id}@${candidate.version}): promotion evidence must cite when ` +
        "verification happened, and promotion never invents a timestamp",
    );
  }
  const minor = readOptionalCount(parity.minorFindings, "minorFindings", candidate, reasons);
  const major = readOptionalCount(parity.majorFindings, "majorFindings", candidate, reasons);
  if ((minor ?? 0) > 0 || (major ?? 0) > 0) {
    const total = (minor ?? 0) + (major ?? 0);
    reasons.push(
      `W2-006 parity gate: parity claims equivalence but reports ${total} finding(s) at or above minor ` +
        `severity (package ${candidate.id}@${candidate.version}): contradictory parity evidence never promotes`,
    );
  }
  return {
    reasons,
    evidence:
      reasons.length === 0 && verificationRunId !== null && verifiedAt !== null
        ? { verificationRunId, verifiedAt, minor, major }
        : null,
  };
}

/** An optional findings count: undefined means not reported (allowed). */
function readOptionalCount(
  value: unknown,
  field: string,
  candidate: { id: string; version: string },
  reasons: string[],
): number | null {
  if (value === undefined) {
    return null;
  }
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value;
  }
  reasons.push(
    `W2-006 parity gate: parity ${field} is malformed (${describeValue(value)}; package ` +
      `${candidate.id}@${candidate.version})`,
  );
  return null;
}

// ---------------------------------------------------------------------------
// promoteGated — the gated promotion flow
// ---------------------------------------------------------------------------

/**
 * The gated promotion flow: fail-closed promotion of one package candidate
 * through the frozen W2-005 registry, gated on BOTH the W2-006 parity
 * discipline (applied FIRST) and the benchmark-grounded evaluation gate.
 *
 * Only when BOTH gates pass does the flow call the registry's promote,
 * recording promotion evidence whose provenance notes cite the benchmark
 * report id and the gate decision id. Otherwise the registry is left
 * untouched (the package stays a candidate) and the outcome carries every
 * reason — the parity-discipline reasons first, then the evaluation reasons —
 * never just the first. Re-promotion with byte-identical evidence is the
 * registry's own idempotent no-op (reported with idempotent: true);
 * registry-level typed failures (unknown package, immutable re-promotion)
 * are returned as reasons. There is no per-call criteria override: the
 * exported PROMOTION_GATE_CRITERIA constant is the gate.
 */
export function promoteGated(
  registry: PackageRegistry,
  input: GatedPromotionInput,
): GatedPromotionOutcome {
  if (!isPlainObject(input)) {
    return {
      promoted: false,
      reasons: [
        "the gated promotion input is missing or malformed: promotion requires an object with " +
          "candidate, parity and evaluation",
      ],
      decision: null,
    };
  }

  const echo = candidateEcho(input.candidate);

  // 1. The W2-006 parity discipline FIRST (the promoteVerified semantics).
  const parity = parityDiscipline(echo, input.parity);
  const parityReasons = parity.reasons;

  // 2. The evaluation gate: compose the grounding report and decide.
  const evaluationReasons: string[] = [];
  let decision: PromotionGateDecision | null = null;
  const evaluation = input.evaluation;
  if (evaluation === undefined) {
    evaluationReasons.push(
      `the package ${echo.id}@${echo.version} is unevaluated: no benchmark evaluation (the W2-009 ` +
        "repeated-sequence build records) was supplied, and an unevaluated package is never silently " +
        "promoted",
    );
  } else if (!isPlainObject(evaluation)) {
    evaluationReasons.push(
      "the benchmark evaluation is malformed: an object with from and to build records is required",
    );
  } else {
    const report = composeGroundingReport(evaluation, evaluationReasons);
    if (report !== null) {
      try {
        decision = decidePromotionGate({ candidate: input.candidate, report });
      } catch (error) {
        if (error instanceof PromotionGateError) {
          evaluationReasons.push(...error.issues);
        } else {
          throw error;
        }
      }
      if (decision !== null && decision.outcome === "withheld") {
        evaluationReasons.push(...decision.reasons);
      }
    }
  }

  const reasons = [...parityReasons, ...evaluationReasons];
  if (reasons.length === 0 && (decision === null || decision.outcome !== "promoted")) {
    // Unreachable by construction (every no-decision path records a reason),
    // but the gate stays fail-closed: no promoting decision, no promotion.
    reasons.push("the gate derived no promoting decision: promotion is withheld");
  }
  if (reasons.length > 0) {
    return { promoted: false, reasons, decision };
  }

  // 3. Both gates passed: promote through the frozen registry surface with
  //    evidence whose provenance notes cite the benchmark grounding.
  if (decision === null || parity.evidence === null) {
    return {
      promoted: false,
      reasons: ["the gate derived no promoting decision: promotion is withheld"],
      decision,
    };
  }
  const parityRecord = (isPlainObject(input.parity) ? input.parity : {}) as Record<string, unknown>;
  const evidence = buildGatedPromotionEvidence({
    discipline: parity.evidence,
    reconstructionId: nonEmptyString(parityRecord.reconstructionId),
    irDigest: nonEmptyString(parityRecord.irDigest),
    reportId: decision.reportId,
    decisionId: decision.id,
  });
  const coordinate = decision.candidate;
  const alreadyPromoted = registry
    .list({ status: "promoted" })
    .some((document) => document.id === coordinate.id && document.version === coordinate.version);
  try {
    const document = registry.promote(coordinate.id, coordinate.version, evidence);
    return { promoted: true, decision, document, evidence, idempotent: alreadyPromoted };
  } catch (error) {
    if (error instanceof PackageNotFoundError || error instanceof PackageImmutabilityError) {
      return { promoted: false, reasons: [error.message], decision };
    }
    throw error;
  }
}

/** Composes the grounding report, flattening the composer's typed issues. */
function composeGroundingReport(
  evaluation: Record<string, unknown>,
  reasons: string[],
): LearningComparisonReport | null {
  try {
    return buildLearningComparison(
      evaluation.from as LearningBuildRecord,
      evaluation.to as LearningBuildRecord,
    );
  } catch (error) {
    if (error instanceof LearningRecordError) {
      reasons.push(...error.issues.map((issue) => `benchmark evaluation: ${issue}`));
      return null;
    }
    throw error;
  }
}

/**
 * Builds the promotion evidence: the W2-006 note discipline (parity verdict,
 * verification run, reconstruction and IR-digest citations) plus the gate's
 * benchmark grounding citations — the report id and the decision id —
 * recorded as provenance-notes strings because the frozen PromotionEvidence
 * type carries no dedicated fields for them.
 */
function buildGatedPromotionEvidence(inputs: {
  discipline: ParityDisciplineEvidence;
  reconstructionId: string | null;
  irDigest: string | null;
  reportId: string;
  decisionId: string;
}): PromotionEvidence {
  const counts =
    inputs.discipline.minor === null && inputs.discipline.major === null
      ? "findings not reported"
      : `${inputs.discipline.major ?? 0} major, ${inputs.discipline.minor ?? 0} minor findings`;
  const notes = [
    `parity verdict: equivalent (${counts})`,
    `verification run: ${inputs.discipline.verificationRunId}`,
  ];
  if (inputs.reconstructionId !== null) {
    notes.push(`reconstruction: ${inputs.reconstructionId}`);
  }
  if (inputs.irDigest !== null) {
    notes.push(`ir digest: ${inputs.irDigest}`);
  }
  notes.push(`benchmark report: ${inputs.reportId}`);
  notes.push(`gate decision: ${inputs.decisionId}`);
  return {
    verifiedAt: inputs.discipline.verifiedAt,
    verificationRunId: inputs.discipline.verificationRunId,
    provenanceNotes: notes,
  };
}
