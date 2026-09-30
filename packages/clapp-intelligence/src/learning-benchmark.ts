/**
 * Continuous-learning benchmarks (CLAPP-W2-009).
 *
 * The M6 steps 4-6 half of the learning loop (ACCEPTANCE.md): ONE structural
 * build record per build of the LEARNING.md repeated sequence
 *
 *   App A1 -> build from scratch -> extract packages
 *   App A2 -> retrieve -> compose -> verify
 *
 * is mapped onto the M6 comparison report — one row per learning signal of
 * the LEARNING.md vocabulary (exactly those eight, in that order, no
 * aggregate score), where each row is either available (both sides measured,
 * comparison derived) or unavailable with a recorded reason, plus an
 * accounting digest and the acceptance-integrity declaration. The reuse
 * evidence chain itself (extraction, registry, retrieval) is composed by the
 * CALLER — this module consumes the records and derives the comparison.
 *
 * Discipline (the module's contract):
 *
 * - CALLER-SUPPLIED MEASUREMENTS — a build record carries the structural
 *   counts the CALLER measured: new-code units, repair iterations (the
 *   bounded repair engine lives in the synthesis lane; this module never
 *   runs, derives or estimates one), test pass counts, a deterministic
 *   build-steps count, and the verification stage's parity outcome. The
 *   comparison derives from the supplied values and nothing else.
 * - CLOCK-FREE — no wall-clock value is an input to this module, ever. The
 *   build-time row abstains (status "unavailable" with the recorded reason)
 *   and still delivers the deterministic proxy: each record's build-steps
 *   count.
 * - HONEST ABSTENTION — unmeasured signals are unavailable with a recorded
 *   reason, never fabricated, never zero, never "equivalent". Failure
 *   recurrence is unavailable because the failure-memory module (W2-008) is
 *   not a declared dependency of this benchmark and is not composed into
 *   it. Parity that is blocked, or measured under weakened acceptance
 *   criteria, never compares as improvement: per LEARNING.md, measured
 *   improvement is reportable ONLY without weakened acceptance criteria, so
 *   when either build declared weakening, would-be improvement rows abstain
 *   with the recorded reason while measured worsening and no-change stay
 *   visible — honest worsening is never hidden.
 * - DETERMINISTIC AND PURE — the same records produce a byte-identical
 *   report: package id arrays are canonicalized (sorted) into the embedded
 *   records, the rows are derived in the fixed LEARNING.md vocabulary
 *   order, and the report id is content-addressed over the report's core.
 *   No wall-clock, no randomness, no external data, and no import outside
 *   this package.
 * - FAIL-CLOSED — malformed build records (missing app id or phase, unknown
 *   phase labels, negative or non-integer counts, partial or contradictory
 *   test/parity data, duplicate or contradictory package ids, non-boolean
 *   acceptance declarations) throw a typed LearningRecordError collecting
 *   EVERY issue from both records: nothing is silently dropped and a
 *   partially-derived report is never returned.
 */

import type { ParitySummary, ParityVerdict } from "./extract-package.ts";
import { canonicalJson, compareStrings, isPlainObject, sha256Hex } from "./json.ts";

// ---------------------------------------------------------------------------
// Public types — learning build records
// ---------------------------------------------------------------------------

/** The phase of one build in the LEARNING.md repeated sequence. */
export type LearningBuildPhase = "scratch" | "reuse";

/**
 * ONE build of the repeated learning sequence, as the CALLER measured it:
 * structural counts only — no wall-clock value is an input, ever. Repair
 * iterations are caller-supplied because the repair loop belongs to the
 * synthesis lane's bounded repair engine; this module never runs one.
 */
export interface LearningBuildRecord {
  /** App id of the build ("A1", "B2", ...). */
  appId: string;
  /** "scratch" for a from-scratch build (A1/B1), "reuse" for a reuse build (A2/B2). */
  phase: LearningBuildPhase;
  /** Package ids this build reused (empty for a from-scratch build). */
  reusedPackageIds: string[];
  /** Package ids this build rejected after retrieval/composition. */
  rejectedPackageIds: string[];
  /** Structural count of new-code units the build generated. */
  newCodeUnits: number;
  /** Structural count of repair iterations the CALLER measured. */
  repairIterations: number;
  /** Deterministic structural count of build steps (the build-time proxy). */
  buildSteps: number;
  /** Passed test count; supply together with testsTotal or not at all. */
  testsPassed?: number;
  /** Total test count; supply together with testsPassed or not at all. */
  testsTotal?: number;
  /** The verification stage's parity outcome; absent means unmeasured. */
  parity?: ParitySummary;
  /**
   * Honest declaration that this build's acceptance criteria were weakened
   * (a looser parity bar, dropped checks). Defaults to false. Any weakening
   * on either compared build makes measured improvements unclaimable.
   */
  acceptanceWeakened?: boolean;
}

/**
 * The canonical form of a build record embedded into reports: the validated
 * input with package id arrays sorted (input array order is not content)
 * and the acceptance declaration made explicit.
 */
export interface CanonicalLearningBuildRecord {
  appId: string;
  phase: LearningBuildPhase;
  /** Sorted; duplicates were rejected at validation. */
  reusedPackageIds: string[];
  /** Sorted; disjoint from reusedPackageIds (validated). */
  rejectedPackageIds: string[];
  newCodeUnits: number;
  repairIterations: number;
  buildSteps: number;
  testsPassed?: number;
  testsTotal?: number;
  parity?: ParitySummary;
  acceptanceWeakened: boolean;
}

// ---------------------------------------------------------------------------
// Public types — the M6 steps 4-6 comparison report
// ---------------------------------------------------------------------------

/** The learning-signal vocabulary of docs/clapp/LEARNING.md, in report order. */
export const LEARNING_SIGNAL_IDS = [
  "package-reuse-rate",
  "generated-new-code",
  "repair-iterations",
  "build-time",
  "test-pass-rate",
  "parity-improvement",
  "failure-recurrence",
  "package-rejection-rate",
] as const;

/** One learning signal of the LEARNING.md vocabulary. */
export type LearningSignalId = (typeof LEARNING_SIGNAL_IDS)[number];

/** The direction a derived comparison points to. */
export type LearningRowDirection = "improved" | "worsened" | "unchanged";

/** A parity measurement: verdict plus findings (a blocked verdict never reaches here). */
export interface ParityMeasurement {
  verdict: Exclude<ParityVerdict, "blocked">;
  majorFindings: number;
  minorFindings: number;
}

/** The derived comparison of one measured signal. */
export interface LearningSignalComparison {
  /** The deterministic structural measure the values carry. */
  measure: string;
  fromValue: number | ParityMeasurement;
  toValue: number | ParityMeasurement;
  /** toValue minus fromValue (finding-count deltas for the parity measure). */
  delta: number | { majorFindings: number; minorFindings: number };
}

/** A row whose both sides were measured: the derived comparison. */
export interface AvailableLearningSignalRow extends LearningSignalComparison {
  status: "available";
  signal: LearningSignalId;
  /** The verbatim LEARNING.md signal phrase. */
  label: string;
  direction: LearningRowDirection;
}

/** The deterministic proxy an abstaining row can still deliver (build time). */
export interface LearningBuildStepsProxy {
  measure: "build-steps";
  fromValue: number;
  toValue: number;
}

/** A row that is honestly not measured (or not claimable), with its reason. */
export interface UnavailableLearningSignalRow {
  status: "unavailable";
  signal: LearningSignalId;
  /** The verbatim LEARNING.md signal phrase. */
  label: string;
  /** The recorded reason the signal is not measured or not claimable. */
  reason: string;
  /** The deterministic proxy delivered alongside the abstention, when one exists. */
  proxy?: LearningBuildStepsProxy;
}

/** One row of the comparison table: available or unavailable, never fabricated. */
export type LearningSignalRow = AvailableLearningSignalRow | UnavailableLearningSignalRow;

/** The accounting digest over the report's rows. */
export interface LearningReportDigest {
  rowsTotal: number;
  available: number;
  unavailable: number;
  /** Every unavailable row's reason, in row order. */
  reasons: string[];
}

/** The honest declaration of the acceptance-criteria state of both builds. */
export interface LearningAcceptanceIntegrity {
  /** True when either compared build declared weakened acceptance criteria. */
  weakened: boolean;
  /** The app ids that declared weakening, in from-then-to order. */
  weakenedAppIds: string[];
}

/**
 * The M6 steps 4-6 comparison report. One row per LEARNING.md signal, an
 * accounting digest and the acceptance-integrity declaration — and nothing
 * else: no aggregate score anywhere (ACCEPTANCE.md: "Do not reduce results
 * to one score").
 */
export interface LearningComparisonReport {
  /** Content-addressed: LEARNING_REPORT_ID_PREFIX + a sha256 prefix of the core. */
  id: string;
  fromBuild: CanonicalLearningBuildRecord;
  toBuild: CanonicalLearningBuildRecord;
  /** Exactly one row per LEARNING.md signal, in vocabulary order. */
  rows: LearningSignalRow[];
  digest: LearningReportDigest;
  acceptanceIntegrity: LearningAcceptanceIntegrity;
}

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

/** Why a learning-benchmark call failed closed. */
export type LearningRecordErrorCode = "invalid-record" | "unrepresentable-comparison";

/**
 * The typed fail-closed error of the learning-benchmark surface. `issues`
 * carries every collected violation from both build records (never just the
 * first) so no malformation is ever silently ignored; the call returns a
 * fully-derived report or throws — never a partial one.
 */
export class LearningRecordError extends Error {
  readonly code: LearningRecordErrorCode;
  readonly issues: readonly string[];

  constructor(code: LearningRecordErrorCode, message: string, issues: readonly string[] = []) {
    super(message);
    this.name = "LearningRecordError";
    this.code = code;
    this.issues = [...issues];
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The learning-benchmark report id prefix. NOT yet in docs/clapp/CONTRACTS.md's
 * "Core identifiers" list: contracts are frozen and tech-lead-owned (a change
 * requires an ADR, a version bump when applicable, a migration/compatibility
 * test, and updated acceptance criteria), and the `clapp_learning_` revision
 * is proposed in the CLAPP-W2-009 completion report instead of being edited
 * in here. Consumers must treat the prefix as module-scoped until the
 * contract revision lands.
 */
export const LEARNING_REPORT_ID_PREFIX = "clapp_learning_";

/** Hex characters of content digest folded into the report id (the W2-006 discipline). */
const ID_DIGEST_LENGTH = 16;

/** The verbatim LEARNING.md signal phrase for each signal id. */
const LEARNING_SIGNAL_LABELS: Record<LearningSignalId, string> = {
  "package-reuse-rate": "package reuse rate",
  "generated-new-code": "generated new code",
  "repair-iterations": "repair iterations",
  "build-time": "build time",
  "test-pass-rate": "test pass rate",
  "parity-improvement": "parity improvement",
  "failure-recurrence": "failure recurrence",
  "package-rejection-rate": "package rejection rate",
};

/** The recorded reason the build-time row abstains (this package is clock-free). */
const BUILD_TIME_REASON =
  "build time is not measured: @clapp/intelligence is clock-free and no wall-clock value " +
  "is an input to this package; the deterministic build-steps count of each record is " +
  "recorded as the proxy";

/** The recorded reason the failure-recurrence row abstains (W2-008 not composed). */
const FAILURE_RECURRENCE_REASON =
  "failure recurrence is not measured: the failure-memory module (W2-008) is not a " +
  "declared dependency of this benchmark and is not composed into it; a recurrence " +
  "count is never fabricated";

// ---------------------------------------------------------------------------
// Validation (fail-closed, every issue collected)
// ---------------------------------------------------------------------------

/** Non-empty string, or null. */
function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Non-negative integer, or null. */
function readNonNegativeCount(value: unknown, field: string, issues: string[]): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    issues.push(`${field} must be a non-negative integer`);
    return null;
  }
  return value;
}

/**
 * Reads a package id list: an array of non-empty strings with no duplicates.
 * Returns the sorted canonical copy, or null when malformed.
 */
function readPackageIdList(value: unknown, field: string, issues: string[]): string[] | null {
  if (
    !Array.isArray(value) ||
    !value.every((entry) => typeof entry === "string" && entry.length > 0)
  ) {
    issues.push(`${field} must be an array of non-empty package id strings`);
    return null;
  }
  const ids = [...(value as string[])].sort(compareStrings);
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      issues.push(`${field} contains duplicate package id "${id}"`);
    }
    seen.add(id);
  }
  return ids;
}

/** Reads the optional parity summary; every violation is collected. */
function readParitySummary(value: unknown, side: string, issues: string[]): ParitySummary | null {
  if (!isPlainObject(value)) {
    issues.push(`${side}.parity must be a parity summary object`);
    return null;
  }
  const parityIssues: string[] = [];
  const verdict = value.verdict;
  if (verdict !== "equivalent" && verdict !== "divergent" && verdict !== "blocked") {
    parityIssues.push(`${side}.parity.verdict must be "equivalent", "divergent" or "blocked"`);
  }
  const verificationRunId = readNonEmptyString(value.verificationRunId);
  if (verificationRunId === null) {
    parityIssues.push(`${side}.parity.verificationRunId must be a non-empty string`);
  }
  const minorFindings = readNonNegativeCount(
    value.minorFindings,
    `${side}.parity.minorFindings`,
    parityIssues,
  );
  const majorFindings = readNonNegativeCount(
    value.majorFindings,
    `${side}.parity.majorFindings`,
    parityIssues,
  );
  if (
    verdict === "equivalent" &&
    minorFindings !== null &&
    majorFindings !== null &&
    (minorFindings > 0 || majorFindings > 0)
  ) {
    parityIssues.push(
      `${side}.parity claims "equivalent" with findings at or above minor severity: ` +
        "contradictory parity never compares",
    );
  }
  if (parityIssues.length > 0) {
    issues.push(...parityIssues);
    return null;
  }
  return {
    verdict: verdict as ParityVerdict,
    verificationRunId: verificationRunId as string,
    minorFindings: minorFindings as number,
    majorFindings: majorFindings as number,
  };
}

/**
 * Validates one build record structurally, collecting every violation into
 * `issues` (never just the first). Returns the canonical record — package id
 * arrays sorted, acceptance declaration explicit — or null when the record
 * is unusable.
 */
function readBuildRecord(
  side: "from" | "to",
  record: unknown,
  issues: string[],
): CanonicalLearningBuildRecord | null {
  if (!isPlainObject(record)) {
    issues.push(`the ${side} build record must be an object`);
    return null;
  }
  const recordIssues: string[] = [];

  const appId = readNonEmptyString(record.appId);
  if (appId === null) {
    recordIssues.push(`${side}.appId must be a non-empty string`);
  }
  const phase = record.phase;
  if (phase !== "scratch" && phase !== "reuse") {
    recordIssues.push(`${side}.phase must be "scratch" or "reuse"`);
  }

  const reused = readPackageIdList(
    record.reusedPackageIds,
    `${side}.reusedPackageIds`,
    recordIssues,
  );
  const rejected = readPackageIdList(
    record.rejectedPackageIds,
    `${side}.rejectedPackageIds`,
    recordIssues,
  );
  if (reused !== null && rejected !== null) {
    for (const id of reused) {
      if (rejected.includes(id)) {
        recordIssues.push(`${side} lists package id "${id}" as both reused and rejected`);
      }
    }
  }

  const newCodeUnits = readNonNegativeCount(
    record.newCodeUnits,
    `${side}.newCodeUnits`,
    recordIssues,
  );
  const repairIterations = readNonNegativeCount(
    record.repairIterations,
    `${side}.repairIterations`,
    recordIssues,
  );
  const buildSteps = readNonNegativeCount(record.buildSteps, `${side}.buildSteps`, recordIssues);

  const hasPassed = record.testsPassed !== undefined;
  const hasTotal = record.testsTotal !== undefined;
  let testsPassed: number | null = null;
  let testsTotal: number | null = null;
  if (hasPassed !== hasTotal) {
    recordIssues.push(`${side}.testsPassed and ${side}.testsTotal must be supplied together`);
  } else if (hasPassed) {
    testsPassed = readNonNegativeCount(record.testsPassed, `${side}.testsPassed`, recordIssues);
    const rawTotal = record.testsTotal;
    if (typeof rawTotal !== "number" || !Number.isInteger(rawTotal) || rawTotal < 1) {
      recordIssues.push(`${side}.testsTotal must be an integer >= 1`);
    } else {
      testsTotal = rawTotal;
    }
    if (testsPassed !== null && testsTotal !== null && testsPassed > testsTotal) {
      recordIssues.push(`${side}.testsPassed must be an integer between 0 and ${side}.testsTotal`);
    }
  }

  let parity: ParitySummary | null = null;
  if (record.parity !== undefined) {
    parity = readParitySummary(record.parity, side, recordIssues);
  }

  let acceptanceWeakened = false;
  if (record.acceptanceWeakened !== undefined) {
    if (typeof record.acceptanceWeakened !== "boolean") {
      recordIssues.push(`${side}.acceptanceWeakened must be a boolean when present`);
    } else {
      acceptanceWeakened = record.acceptanceWeakened;
    }
  }

  if (recordIssues.length > 0) {
    issues.push(...recordIssues);
    return null;
  }
  return {
    appId: appId as string,
    phase: phase as LearningBuildPhase,
    reusedPackageIds: reused as string[],
    rejectedPackageIds: rejected as string[],
    newCodeUnits: newCodeUnits as number,
    repairIterations: repairIterations as number,
    buildSteps: buildSteps as number,
    ...(testsPassed !== null && testsTotal !== null ? { testsPassed, testsTotal } : {}),
    ...(parity !== null ? { parity } : {}),
    acceptanceWeakened,
  };
}

// ---------------------------------------------------------------------------
// Row derivation
// ---------------------------------------------------------------------------

/** The optional test counts of a canonical record, or null when unmeasured. */
function readTests(record: CanonicalLearningBuildRecord): { passed: number; total: number } | null {
  return record.testsPassed !== undefined && record.testsTotal !== undefined
    ? { passed: record.testsPassed, total: record.testsTotal }
    : null;
}

/** The parity measurement of a summary, or null when verification was blocked. */
function measuredParity(parity: ParitySummary): ParityMeasurement | null {
  return parity.verdict === "blocked"
    ? null
    : {
        verdict: parity.verdict,
        majorFindings: parity.majorFindings,
        minorFindings: parity.minorFindings,
      };
}

/** Severity key of a parity measurement: verdict rank first, then major, then minor. */
function paritySeverityKey(measurement: ParityMeasurement): [number, number, number] {
  return [
    measurement.verdict === "equivalent" ? 0 : 1,
    measurement.majorFindings,
    measurement.minorFindings,
  ];
}

/** Lexicographic comparison of two severity keys (lower severity is better). */
function compareSeverityKeys(
  left: [number, number, number],
  right: [number, number, number],
): number {
  if (left[0] !== right[0]) {
    return left[0] - right[0];
  }
  if (left[1] !== right[1]) {
    return left[1] - right[1];
  }
  return left[2] - right[2];
}

/** Builds an unavailable row with its recorded reason. */
function unavailableRow(signal: LearningSignalId, reason: string): UnavailableLearningSignalRow {
  return { status: "unavailable", signal, label: LEARNING_SIGNAL_LABELS[signal], reason };
}

/** Builds an available row over a numeric measure (higher or lower is better). */
function numericRow(
  signal: LearningSignalId,
  measure: string,
  fromValue: number,
  toValue: number,
  better: "higher" | "lower",
): AvailableLearningSignalRow {
  const improved = better === "higher" ? toValue > fromValue : toValue < fromValue;
  const worsened = better === "higher" ? toValue < fromValue : toValue > fromValue;
  return {
    status: "available",
    signal,
    label: LEARNING_SIGNAL_LABELS[signal],
    measure,
    fromValue,
    toValue,
    delta: toValue - fromValue,
    direction: improved ? "improved" : worsened ? "worsened" : "unchanged",
  };
}

/** The build-time row: the honest abstention plus the deterministic proxy. */
function buildTimeRow(
  from: CanonicalLearningBuildRecord,
  to: CanonicalLearningBuildRecord,
): LearningSignalRow {
  return {
    status: "unavailable",
    signal: "build-time",
    label: LEARNING_SIGNAL_LABELS["build-time"],
    reason: BUILD_TIME_REASON,
    proxy: { measure: "build-steps", fromValue: from.buildSteps, toValue: to.buildSteps },
  };
}

/** The test-pass-rate row: measured ratios, or the honest abstention. */
function testPassRateRow(
  from: CanonicalLearningBuildRecord,
  to: CanonicalLearningBuildRecord,
): LearningSignalRow {
  const fromTests = readTests(from);
  const toTests = readTests(to);
  if (fromTests === null || toTests === null) {
    const unmeasured = [
      ...(fromTests === null ? [from.appId] : []),
      ...(toTests === null ? [to.appId] : []),
    ];
    return unavailableRow(
      "test-pass-rate",
      `test pass rate is not measured (app ${unmeasured.join(", ")}): no test counts were ` +
        "supplied, and an unmeasured rate is never fabricated",
    );
  }
  const fromRatio = fromTests.passed / fromTests.total;
  const toRatio = toTests.passed / toTests.total;
  // Exact integer cross-multiplication decides the direction; the emitted
  // values are the deterministic ratios.
  const improvedProduct = toTests.passed * fromTests.total;
  const worsenedProduct = fromTests.passed * toTests.total;
  return {
    status: "available",
    signal: "test-pass-rate",
    label: LEARNING_SIGNAL_LABELS["test-pass-rate"],
    measure: "test-pass-ratio",
    fromValue: fromRatio,
    toValue: toRatio,
    delta: toRatio - fromRatio,
    direction:
      improvedProduct > worsenedProduct
        ? "improved"
        : improvedProduct < worsenedProduct
          ? "worsened"
          : "unchanged",
  };
}

/** The parity-improvement row: measured severity, or the honest abstention. */
function parityRow(
  from: CanonicalLearningBuildRecord,
  to: CanonicalLearningBuildRecord,
): LearningSignalRow {
  const unmeasured = [
    ...(from.parity === undefined ? [from.appId] : []),
    ...(to.parity === undefined ? [to.appId] : []),
  ];
  if (unmeasured.length > 0) {
    return unavailableRow(
      "parity-improvement",
      `parity improvement is not measured (app ${unmeasured.join(", ")}): no parity summary ` +
        "was supplied, and an unmeasured parity never compares",
    );
  }
  const blocked = [
    ...(from.parity?.verdict === "blocked" ? [from.appId] : []),
    ...(to.parity?.verdict === "blocked" ? [to.appId] : []),
  ];
  if (blocked.length > 0) {
    return unavailableRow(
      "parity-improvement",
      `parity improvement is not measured (app ${blocked.join(", ")}): verification was ` +
        "blocked and produced no verdict, and a blocked parity never compares",
    );
  }
  const fromMeasurement = measuredParity(from.parity as ParitySummary) as ParityMeasurement;
  const toMeasurement = measuredParity(to.parity as ParitySummary) as ParityMeasurement;
  const order = compareSeverityKeys(
    paritySeverityKey(toMeasurement),
    paritySeverityKey(fromMeasurement),
  );
  return {
    status: "available",
    signal: "parity-improvement",
    label: LEARNING_SIGNAL_LABELS["parity-improvement"],
    measure: "parity-severity",
    fromValue: fromMeasurement,
    toValue: toMeasurement,
    delta: {
      majorFindings: toMeasurement.majorFindings - fromMeasurement.majorFindings,
      minorFindings: toMeasurement.minorFindings - fromMeasurement.minorFindings,
    },
    direction: order < 0 ? "improved" : order > 0 ? "worsened" : "unchanged",
  };
}

/**
 * LEARNING.md: measured improvement is accepted only without weakened
 * acceptance criteria. When either build declared weakening, an available
 * row whose derived direction is "improved" abstains with the recorded
 * reason instead of claiming the improvement; measured worsening and
 * no-change stay visible — honest worsening is never hidden.
 */
function guardImprovement(row: LearningSignalRow, weakenedAppIds: string[]): LearningSignalRow {
  if (weakenedAppIds.length === 0 || row.status !== "available" || row.direction !== "improved") {
    return row;
  }
  return {
    status: "unavailable",
    signal: row.signal,
    label: row.label,
    reason:
      `improvement is not claimable: acceptance criteria were weakened (app ` +
      `${weakenedAppIds.join(", ")}), and measured improvement under weakened acceptance ` +
      "criteria is never reported",
  };
}

// ---------------------------------------------------------------------------
// buildLearningComparison
// ---------------------------------------------------------------------------

/**
 * Builds the M6 steps 4-6 comparison report from a from-record (the scratch
 * build: A1/B1) and a to-record (the reuse build: A2/B2).
 *
 * Pure and deterministic: the same records — even with reordered package id
 * arrays — produce a byte-identical report with the same content-addressed
 * `clapp_learning_` id. Exactly one row per LEARNING.md learning signal is
 * derived (or honestly abstained); no aggregate score exists anywhere on
 * the report. Malformed records fail closed with a typed
 * LearningRecordError collecting every issue; a partially-derived report is
 * never returned.
 */
export function buildLearningComparison(
  from: LearningBuildRecord,
  to: LearningBuildRecord,
): LearningComparisonReport {
  const issues: string[] = [];
  const fromBuild = readBuildRecord("from", from, issues);
  const toBuild = readBuildRecord("to", to, issues);
  if (fromBuild === null || toBuild === null || issues.length > 0) {
    throw new LearningRecordError(
      "invalid-record",
      `the learning build records are structurally invalid (${issues.length} ${
        issues.length === 1 ? "issue" : "issues"
      }); failing closed`,
      issues,
    );
  }

  const weakenedAppIds = [fromBuild, toBuild]
    .filter((record) => record.acceptanceWeakened)
    .map((record) => record.appId);
  const acceptanceIntegrity: LearningAcceptanceIntegrity = {
    weakened: weakenedAppIds.length > 0,
    weakenedAppIds,
  };

  const rows: LearningSignalRow[] = [
    numericRow(
      "package-reuse-rate",
      "reused-package-count",
      fromBuild.reusedPackageIds.length,
      toBuild.reusedPackageIds.length,
      "higher",
    ),
    numericRow(
      "generated-new-code",
      "new-code-units",
      fromBuild.newCodeUnits,
      toBuild.newCodeUnits,
      "lower",
    ),
    numericRow(
      "repair-iterations",
      "repair-iterations",
      fromBuild.repairIterations,
      toBuild.repairIterations,
      "lower",
    ),
    buildTimeRow(fromBuild, toBuild),
    testPassRateRow(fromBuild, toBuild),
    parityRow(fromBuild, toBuild),
    unavailableRow("failure-recurrence", FAILURE_RECURRENCE_REASON),
    numericRow(
      "package-rejection-rate",
      "rejected-package-count",
      fromBuild.rejectedPackageIds.length,
      toBuild.rejectedPackageIds.length,
      "lower",
    ),
  ].map((row) => guardImprovement(row, weakenedAppIds));

  let available = 0;
  const reasons: string[] = [];
  for (const row of rows) {
    if (row.status === "available") {
      available += 1;
    } else {
      reasons.push(row.reason);
    }
  }
  const digest: LearningReportDigest = {
    rowsTotal: rows.length,
    available,
    unavailable: rows.length - available,
    reasons,
  };

  const core = { fromBuild, toBuild, rows, digest, acceptanceIntegrity };
  const canonical = canonicalJson(core);
  if (canonical === undefined) {
    throw new LearningRecordError(
      "unrepresentable-comparison",
      "the learning comparison is not JSON-representable: no content-addressed report id is derivable",
    );
  }
  return {
    id: `${LEARNING_REPORT_ID_PREFIX}${sha256Hex(canonical).slice(0, ID_DIGEST_LENGTH)}`,
    ...core,
  };
}
