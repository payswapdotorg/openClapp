/**
 * Measurable compounding improvement (CLAPP-W2-011).
 *
 * The orchestration that turns TWO measured builds of the same benchmark
 * into ONE end-to-end learning experiment — the chain
 *
 *   build (scratch) -> extract -> evaluate -> promote -> rebuild (reuse) -> compare
 *
 * composed entirely from the frozen intelligence surfaces: the REAL W2-006
 * extraction/registration, the REAL W2-005 registry over the caller's (or a
 * fresh in-memory) store, the REAL W2-010 promotion gate, and the REAL
 * W2-009 comparison. Nothing is re-derived: the LearningComparisonReport is
 * attached VERBATIM, and the per-signal compounding record is derived
 * ACROSS it — exactly one row per LEARNING.md signal, each either available
 * (improved/worsened/unchanged with the measured from/to values) or
 * unavailable (the recorded reason, verbatim from the comparison row). The
 * resulting CompoundingExperimentReport is the TL-005 archetype learning
 * experiment artifact (WORK_ITEMS.md: "the TL-005 archetype learning
 * experiment report exists with its comparison attached").
 *
 * Discipline (the module's contract):
 *
 * - STRUCTURAL PORT, NOT AN IMPORT — the W3-009 composition plan is consumed
 *   ONLY through the local CompoundingCompositionPlan port ({ status,
 *   packageIds, selections? }): the real plan's output satisfies the port
 *   structurally and is passed in as data. This module never imports
 *   @clapp/synthesis, @clapp/observation, @clapp/runtime-openmuse or any
 *   app — ADR-002; cross-lane composition happens at the caller's seam.
 * - LEARNING-ENABLED vs CONTROL — a PRESENT plan means learning was enabled
 *   for the rebuild: its packageIds are the reuse build's selected set, and
 *   every improved row records the attribution — the promoted package ids
 *   that plausibly produced the improvement (the plan's packageIds ∩ the
 *   promoted set) — honest attribution to the package SET, never a
 *   fabricated per-signal causal claim. An ABSENT plan is the
 *   learning-disabled control: stages 2-5 still run against the scratch
 *   artifacts (extraction may still find candidates — that is honest), the
 *   selected set is the empty set, and the verdict is "control" with the
 *   per-signal rows unchanged from the comparison — the control proves the
 *   machinery without fabricating improvement.
 * - HONEST VERDICT — "compounding" requires at least one improved signal
 *   WITH attribution; zero improved signals — or measured improvement none
 *   of which is attributable to a promoted package of the selected set — is
 *   "no-compounding" with the honest per-signal state recorded on every row;
 *   a missing plan is "control". No aggregate score exists anywhere on the
 *   report (ACCEPTANCE.md: "Do not reduce results to one score").
 * - DETERMINISTIC AND PURE — synchronous, no wall-clock read anywhere (the
 *   only temporal input is the injected `now` clock, read exactly once at
 *   validation; absent means the pinned epoch default), no randomness, no
 *   I/O outside the supplied PackageStore. The same inputs — including the
 *   same store state — produce a byte-identical report with the same
 *   content-addressed clapp_compound_ id, and reordered package-id arrays
 *   in the build records do not change it (the W2-009 composer
 *   canonicalizes them into the comparison the digests and rows derive
 *   from).
 * - FAIL-CLOSED — every input is structurally validated FIRST (benchmarkId,
 *   both build records through the W2-009 composer's own collected-issues
 *   discipline, the experiment's phase semantics, the artifacts, the plan
 *   when present, the store, the clock), EVERY issue is collected, and ONE
 *   typed CompoundingError is thrown before any stage runs: never a partial
 *   run, never a mutated store on invalid input.
 */

import {
  type CandidateRegistration,
  type ExtractionResult,
  type ExtractionSummary,
  extractionSummary,
  extractPackageCandidates,
  type PackageCandidateDocument,
  type ParityEvidence,
  type PromotionOutcome,
  type ReconstructionArtifacts,
  registerCandidates,
  type SkippedExtraction,
} from "./extract-package.ts";
import { canonicalJson, compareStrings, isPlainObject, sha256Hex } from "./json.ts";
import {
  buildLearningComparison,
  LEARNING_SIGNAL_IDS,
  type LearningBuildRecord,
  type LearningComparisonReport,
  LearningRecordError,
  type LearningRowDirection,
  type LearningSignalId,
  type LearningSignalRow,
  type ParityMeasurement,
} from "./learning-benchmark.ts";
import { createPackageRegistry } from "./package-registry.ts";
import type { PackageStore, PackageStoreRecord } from "./package-store.ts";
import { decidePromotionGate, type PromotionGateDecision, promoteGated } from "./promotion-gate.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The compounding experiment report id prefix. NOT yet in docs/clapp/CONTRACTS.md's
 * "Core identifiers" list: contracts are frozen and tech-lead-owned (a change
 * requires an ADR, a version bump when applicable, a migration/compatibility
 * test, and updated acceptance criteria — ADR-003), and the `clapp_compound_`
 * revision is proposed in the CLAPP-W2-011 completion report instead of being
 * edited in here. Consumers must treat the prefix as module-scoped until the
 * contract revision lands.
 */
export const COMPOUNDING_EXPERIMENT_ID_PREFIX = "clapp_compound_";

/** Hex characters of content digest folded into the report id (the family discipline). */
const ID_DIGEST_LENGTH = 16;

/**
 * The pinned experiment clock used when no `now` is injected: the Unix epoch.
 * The module never reads a wall clock, so the default keeps every
 * default-path report deterministic; callers wanting a real verification
 * timestamp inject `now`.
 */
const DEFAULT_EXPERIMENT_CLOCK_MS = 0;

/** Milliseconds in one UTC day (the ISO formatter's only unit constant). */
const MS_PER_DAY = 86_400_000;

// ---------------------------------------------------------------------------
// Public types — the structural port of the W3-009 composition plan
// ---------------------------------------------------------------------------

/**
 * Structural port of one W3-009 composition selection: the identity fields
 * this package reads. The real CompositionSelection satisfies this shape
 * structurally (extra fields are welcome; the port never imports the real
 * type).
 */
export interface CompoundingCompositionSelection {
  /** The slot a selected package fills ("archetype-anchor", ...). */
  role: string;
  /** The selected package id. */
  packageId: string;
}

/**
 * Structural port of the W3-009 CompositionPlan — the fields the compounding
 * orchestration reads. The real plan's output (composed, fallback or
 * abstained) satisfies this shape structurally and is passed in as data:
 * PRESENT means learning was enabled for the rebuild and the plan's
 * `packageIds` are the reuse build's selected set; ABSENT/undefined means
 * the learning-disabled control. This module never imports
 * @clapp/synthesis (ADR-002).
 */
export interface CompoundingCompositionPlan {
  status: "composed" | "fallback" | "abstained";
  /** The reuse build's selected package ids (the plan's own order is content). */
  packageIds: string[];
  /** The filled slots, when the real plan carries them. */
  selections?: CompoundingCompositionSelection[];
}

// ---------------------------------------------------------------------------
// Public types — the experiment input
// ---------------------------------------------------------------------------

/**
 * The compounding experiment's input: two measured builds of the same
 * benchmark (the W2-009 repeated sequence), the scratch build's structural
 * artifacts for the extraction stage, the optional composition plan
 * (present = learning enabled for the rebuild), and the injection seams
 * (store, clock). Every field is structurally validated before any stage
 * runs.
 */
export interface CompoundingExperimentInput {
  /** The experiment's identity anchor: non-empty, trimmed. */
  benchmarkId: string;
  /** The measured first build (the from-scratch A1/B1 record). */
  scratchBuild: LearningBuildRecord;
  /** The measured rebuild (the reuse A2/B2 record). */
  reuseBuild: LearningBuildRecord;
  /** The scratch build's structural artifacts the extraction stage consumes. */
  artifacts: ReconstructionArtifacts;
  /**
   * The W3-009 composition plan of the rebuild, passed in as data through
   * the structural port. PRESENT means learning was enabled; ABSENT means
   * the learning-disabled control.
   */
  compositionPlan?: CompoundingCompositionPlan;
  /** The package store the registry materializes through; defaults to a fresh in-memory store. */
  store?: PackageStore;
  /**
   * The experiment clock, read exactly once at validation to derive the
   * promotion evidence's verifiedAt (the one timestamp the frozen W2-006
   * parity discipline demands — the module never reads a wall clock and
   * never invents a timestamp the caller did not pin). Absent means the
   * pinned epoch default.
   */
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Public types — the per-signal compounding record
// ---------------------------------------------------------------------------

/**
 * A measured signal row of the compounding record: the comparison row's
 * measured values and derived direction, carried unchanged. When learning
 * was enabled, an improved row additionally records the attribution.
 */
export interface AvailableCompoundingSignalRow {
  status: "available";
  signal: LearningSignalId;
  /** The verbatim LEARNING.md signal phrase. */
  label: string;
  /** The deterministic structural measure the values carry (verbatim). */
  measure: string;
  direction: LearningRowDirection;
  fromValue: number | ParityMeasurement;
  toValue: number | ParityMeasurement;
  delta: number | { majorFindings: number; minorFindings: number };
  /**
   * Learning-enabled runs only (a plan was supplied): the promoted package
   * ids that plausibly produced the improvement — the plan's packageIds ∩
   * the promoted set. Honest attribution to the package SET, never a
   * fabricated per-signal causal claim; empty when nothing promoted from the
   * selected set could be credited.
   */
  attributedPackageIds?: string[];
}

/** An honestly unmeasured signal row: the comparison row's reason, verbatim. */
export interface UnavailableCompoundingSignalRow {
  status: "unavailable";
  signal: LearningSignalId;
  /** The verbatim LEARNING.md signal phrase. */
  label: string;
  /** The recorded reason the signal is not measured or not claimable (verbatim). */
  reason: string;
  /** The deterministic proxy delivered alongside the abstention, when one exists. */
  proxy?: { measure: "build-steps"; fromValue: number; toValue: number };
}

/** One row of the per-signal compounding record: available or unavailable, never fabricated. */
export type CompoundingSignalRow = AvailableCompoundingSignalRow | UnavailableCompoundingSignalRow;

// ---------------------------------------------------------------------------
// Public types — the experiment report
// ---------------------------------------------------------------------------

/** A package identity coordinate (id + version) as the report records it. */
export interface CompoundingCandidateCoordinate {
  id: string;
  version: string;
}

/** The extraction stage's record: candidates found, honest skips, accounting. */
export interface CompoundingExtractionRecord {
  /** The extracted candidate coordinates, in extraction order. */
  candidates: CompoundingCandidateCoordinate[];
  /** The honest skips, verbatim from the real W2-006 extraction. */
  skipped: SkippedExtraction[];
  /** The real W2-006 accounting digest over the extraction and its promotions. */
  summary: ExtractionSummary;
}

/**
 * One candidate's promotion record: the verbatim W2-010 gate decision
 * (content-addressed under clapp_eval_) plus the promotion attempt's
 * outcome. When the gate withheld, no promotion is attempted and the
 * decision's criterion reasons are the recorded reasons; when the attempt
 * ran and failed, the flow's collected reasons are recorded — every reason,
 * never just the first.
 */
export interface CompoundingPromotionRecord {
  candidate: CompoundingCandidateCoordinate;
  /** The gate decision over the benchmark-grounded comparison (verbatim W2-010 output). */
  decision: PromotionGateDecision;
  promoted: boolean;
  /** Registry idempotence of the promotion (a fresh promotion is false). */
  idempotent: boolean;
  /** Every reason the candidate was not promoted; empty when promoted. */
  reasons: string[];
}

/** The experiment's honest overall verdict. */
export type CompoundingVerdict = "compounding" | "no-compounding" | "control";

/**
 * The end-to-end learning experiment report (the TL-005 artifact): the two
 * build records' content digests (not the full records — the verbatim
 * comparison embeds the canonical forms), the extraction/registration/
 * evaluation/promotion chain's every recorded outcome, the attached
 * comparison report VERBATIM, the per-signal compounding record derived
 * across it, and the honest verdict. Content-addressed under
 * clapp_compound_ over the report's canonical core (the id never covers
 * itself); no aggregate score exists anywhere on it.
 */
export interface CompoundingExperimentReport {
  /** Content-addressed: COMPOUNDING_EXPERIMENT_ID_PREFIX + a sha256 prefix of the core. */
  id: string;
  /** The experiment's identity anchor (trimmed). */
  benchmarkId: string;
  /** True when a composition plan was supplied for the rebuild (learning enabled). */
  learningEnabled: boolean;
  /** The reuse build's selected package set: the plan's packageIds, or [] for the control. */
  selectedPackageIds: string[];
  /** sha256 (hex) of the canonical scratch build record the comparison embeds. */
  scratchBuildDigest: string;
  /** sha256 (hex) of the canonical reuse build record the comparison embeds. */
  reuseBuildDigest: string;
  /** Stage 2: the extraction record (candidates + honest skips + accounting). */
  extraction: CompoundingExtractionRecord;
  /** Stage 3: the registrations, verbatim W2-006 outcomes in candidate order. */
  registrations: CandidateRegistration[];
  /** Stages 4-5: one promotion record per extracted candidate, in candidate order. */
  promotions: CompoundingPromotionRecord[];
  /** The promoted package ids, sorted and unique. */
  promotedPackageIds: string[];
  /** Stage 6: the W2-009 comparison report, attached VERBATIM. */
  comparison: LearningComparisonReport;
  /** Stage 7: exactly one row per LEARNING.md signal, in vocabulary order. */
  signalRows: CompoundingSignalRow[];
  /** The honest overall verdict. */
  verdict: CompoundingVerdict;
  /** The one-sentence honest derivation of the verdict. */
  verdictReason: string;
}

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

/** Why a compounding experiment call failed closed. */
export type CompoundingErrorCode = "invalid-input" | "unrepresentable-report";

/**
 * The typed fail-closed error of the compounding orchestration. `issues`
 * carries every collected violation (never just the first) so no
 * malformation is ever silently ignored; the call returns a fully-derived
 * report or throws — never a partial run, never a mutated store on invalid
 * input.
 */
export class CompoundingError extends Error {
  readonly code: CompoundingErrorCode;
  readonly issues: readonly string[];

  constructor(code: CompoundingErrorCode, message: string, issues: readonly string[] = []) {
    super(message);
    this.name = "CompoundingError";
    this.code = code;
    this.issues = [...issues];
  }
}

// ---------------------------------------------------------------------------
// Validation helpers (fail-closed, every issue collected)
// ---------------------------------------------------------------------------

/** Non-empty string, or null. */
function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** True for a non-negative integer count (narrows to number). */
function isNonNegativeCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * Structurally validates the reconstruction artifacts to the bar the
 * composed W2-006 surface itself applies (object shape: attributable
 * reconstruction id, a type-valid parity summary, an inventory of arrays, a
 * digest string). Deeper honesty — verdict semantics, inventory emptiness,
 * entry-level malformation — is the extractor's own recorded abstention,
 * never re-derived here.
 */
function validateArtifacts(value: unknown, issues: string[]): void {
  if (!isPlainObject(value)) {
    issues.push("artifacts must be a reconstruction artifacts object");
    return;
  }
  if (nonEmptyString(value.reconstructionId) === null) {
    issues.push("artifacts.reconstructionId must be a non-empty string");
  }
  const parity = value.parity;
  if (!isPlainObject(parity)) {
    issues.push("artifacts.parity must be a parity summary object");
  } else {
    if (
      parity.verdict !== "equivalent" &&
      parity.verdict !== "divergent" &&
      parity.verdict !== "blocked"
    ) {
      issues.push('artifacts.parity.verdict must be "equivalent", "divergent" or "blocked"');
    }
    if (nonEmptyString(parity.verificationRunId) === null) {
      issues.push("artifacts.parity.verificationRunId must be a non-empty string");
    }
    if (!isNonNegativeCount(parity.minorFindings)) {
      issues.push("artifacts.parity.minorFindings must be a non-negative integer");
    }
    if (!isNonNegativeCount(parity.majorFindings)) {
      issues.push("artifacts.parity.majorFindings must be a non-negative integer");
    }
  }
  const inventory = value.planInventory;
  if (!isPlainObject(inventory)) {
    issues.push("artifacts.planInventory must be a plan inventory object");
  } else {
    if (!Array.isArray(inventory.components)) {
      issues.push("artifacts.planInventory.components must be an array");
    }
    if (!Array.isArray(inventory.apiEntries)) {
      issues.push("artifacts.planInventory.apiEntries must be an array");
    }
    if (!Array.isArray(inventory.persistenceKeys)) {
      issues.push("artifacts.planInventory.persistenceKeys must be an array");
    }
  }
  if (value.archetype !== undefined) {
    const archetype = value.archetype;
    if (!isPlainObject(archetype) || nonEmptyString(archetype.label) === null) {
      issues.push(
        "artifacts.archetype must be an object with a non-empty label string when present",
      );
    }
  }
  if (nonEmptyString(value.irDigest) === null) {
    issues.push("artifacts.irDigest must be a non-empty string");
  }
}

/**
 * Structurally validates the composition plan port when a plan is supplied:
 * a status of the W3-009 vocabulary, unique non-empty package ids, and —
 * when selections are carried — selection objects with non-empty package
 * ids. The module reads only `packageIds` (the selected set); validating
 * the whole port shape keeps the structural contract honest.
 */
function validatePlan(value: unknown, issues: string[]): void {
  if (!isPlainObject(value)) {
    issues.push("compositionPlan must be a composition plan object when present");
    return;
  }
  if (value.status !== "composed" && value.status !== "fallback" && value.status !== "abstained") {
    issues.push('compositionPlan.status must be "composed", "fallback" or "abstained"');
  }
  const packageIds = value.packageIds;
  if (
    !Array.isArray(packageIds) ||
    !packageIds.every((id) => typeof id === "string" && id.length > 0)
  ) {
    issues.push("compositionPlan.packageIds must be an array of non-empty package id strings");
  } else {
    const seen = new Set<string>();
    for (const id of packageIds) {
      if (seen.has(id)) {
        issues.push(`compositionPlan.packageIds contains duplicate package id "${id}"`);
      }
      seen.add(id);
    }
  }
  if (value.selections !== undefined) {
    const selections = value.selections;
    if (
      !Array.isArray(selections) ||
      !selections.every((entry) => isPlainObject(entry) && nonEmptyString(entry.packageId) !== null)
    ) {
      issues.push(
        "compositionPlan.selections must be an array of selection objects with non-empty " +
          "packageId strings when present",
      );
    }
  }
}

/** True when the value is shaped like the narrow PackageStore port. */
function isStoreLike(value: unknown): value is PackageStore {
  // Structural shape only: a real store may be a class instance (the
  // W2-007 in-memory pattern), so the check must not demand a plain object.
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.get === "function" &&
    typeof candidate.put === "function" &&
    typeof candidate.list === "function"
  );
}

/**
 * Reads the injected clock exactly once: the value must be a non-negative
 * integer epoch-millisecond number. A clock that throws is a collected
 * issue, never a propagated surprise.
 */
function readClock(now: unknown, issues: string[]): number | null {
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
  if (!isNonNegativeCount(clockValue)) {
    issues.push(
      "the injected now clock must return a non-negative integer epoch-millisecond value",
    );
    return null;
  }
  return clockValue;
}

// ---------------------------------------------------------------------------
// In-memory store default (the W2-007 test pattern's semantics)
// ---------------------------------------------------------------------------

/**
 * A fresh in-memory PackageStore (one Map row per id@version key) — the
 * default store the experiment's registry materializes through when the
 * caller supplies none. Private: callers wanting to inspect persistence
 * pass their own store (the report itself records the whole chain).
 */
function createFreshStore(): PackageStore {
  const rows = new Map<string, PackageStoreRecord>();
  return {
    get(key) {
      return rows.get(`${key.id}@${key.version}`) ?? null;
    },
    put(record) {
      rows.set(`${record.key.id}@${record.key.version}`, record);
    },
    list() {
      return [...rows.values()];
    },
  };
}

// ---------------------------------------------------------------------------
// ISO-8601 UTC formatting without the Date API
// ---------------------------------------------------------------------------

/** Left-pads a number with zeroes to the given width. */
function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/**
 * Formats a non-negative epoch-millisecond value as an ISO-8601 UTC
 * timestamp. Hand-rolled (civil-from-days with floor division) so the
 * module source contains no Date API at all — clock-free in source as well
 * as in behavior — while producing exactly what `toISOString()` would.
 */
function isoUtcFromEpochMs(epochMs: number): string {
  const days = Math.floor(epochMs / MS_PER_DAY);
  const msOfDay = epochMs % MS_PER_DAY;
  const z = days + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1_460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365,
  );
  const year = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const monthIndex = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * monthIndex + 2) / 5) + 1;
  const month = monthIndex < 10 ? monthIndex + 3 : monthIndex - 9;
  const fullYear = month <= 2 ? year + 1 : year;
  const hours = Math.floor(msOfDay / 3_600_000);
  const minutes = Math.floor((msOfDay % 3_600_000) / 60_000);
  const seconds = Math.floor((msOfDay % 60_000) / 1_000);
  const millis = msOfDay % 1_000;
  return (
    `${pad(fullYear, 4)}-${pad(month, 2)}-${pad(day, 2)}` +
    `T${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}.${pad(millis, 3)}Z`
  );
}

// ---------------------------------------------------------------------------
// Stage helpers
// ---------------------------------------------------------------------------

/** The candidate coordinate of one extracted document. */
function candidateCoordinate(document: PackageCandidateDocument): CompoundingCandidateCoordinate {
  return { id: document.package.id, version: document.package.version };
}

/** Projects one comparison row onto the compounding record's row shape. */
function compoundingRow(
  row: LearningSignalRow,
  attribution: readonly string[] | null,
): CompoundingSignalRow {
  if (row.status === "unavailable") {
    return {
      status: "unavailable",
      signal: row.signal,
      label: row.label,
      reason: row.reason,
      ...(row.proxy !== undefined
        ? {
            proxy: {
              measure: row.proxy.measure,
              fromValue: row.proxy.fromValue,
              toValue: row.proxy.toValue,
            },
          }
        : {}),
    };
  }
  return {
    status: "available",
    signal: row.signal,
    label: row.label,
    measure: row.measure,
    direction: row.direction,
    fromValue: row.fromValue,
    toValue: row.toValue,
    delta: row.delta,
    // Attribution is recorded ONLY on improved rows, and only when a plan
    // was supplied: the promoted package SET plausibly behind the improvement.
    ...(attribution !== null && row.direction === "improved"
      ? { attributedPackageIds: [...attribution] }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// runCompoundingExperiment
// ---------------------------------------------------------------------------

/**
 * Runs the end-to-end compounding experiment over the frozen intelligence
 * surfaces, in order: validate (fail-closed, every issue collected, one
 * typed CompoundingError before any stage runs) → extract (the real
 * W2-006 extraction over the scratch artifacts) → register (the real
 * registry over the supplied or fresh in-memory store) → evaluate (the
 * real W2-010 gate, grounded on the real W2-009 comparison) → promote (the
 * real gated flow, for every gate-approved candidate) → compare (the real
 * W2-009 report, attached verbatim) → compound (one row per LEARNING.md
 * signal, derived across the comparison) → the content-addressed report.
 *
 * Pure, synchronous and deterministic: the same inputs (including store
 * state) produce a byte-identical report with the same content-addressed
 * clapp_compound_ id. The learning-disabled control (no composition plan)
 * runs the whole chain against the scratch artifacts and records the
 * "control" verdict without fabricating improvement.
 */
export function runCompoundingExperiment(
  input: CompoundingExperimentInput,
): CompoundingExperimentReport {
  // ------------------------------------------------------------------
  // Stage 1 — validate fail-closed first. No stage runs, no store is
  // touched, until every input has passed structural validation.
  // ------------------------------------------------------------------
  if (!isPlainObject(input)) {
    throw new CompoundingError(
      "invalid-input",
      "the compounding experiment input must be an object; failing closed",
      ["the compounding experiment input must be an object"],
    );
  }
  const issues: string[] = [];

  const benchmarkId =
    typeof input.benchmarkId === "string" && input.benchmarkId.trim().length > 0
      ? input.benchmarkId.trim()
      : null;
  if (benchmarkId === null) {
    issues.push("benchmarkId must be a non-empty string (trimmed)");
  }

  // Both build records through the W2-009 composer's own discipline: the
  // comparison is the experiment's grounding artifact, so validating the
  // records and composing the report are one step. Its collected issues are
  // carried verbatim.
  let comparison: LearningComparisonReport | null = null;
  try {
    comparison = buildLearningComparison(input.scratchBuild, input.reuseBuild);
  } catch (error) {
    if (error instanceof LearningRecordError) {
      issues.push(...error.issues);
    } else {
      throw error;
    }
  }
  // The experiment's own phase semantics: the first build is the from-scratch
  // build, the rebuild is the reuse build (the W2-009 composer validates each
  // record's phase label; this is the cross-side meaning of the two fields).
  if (isPlainObject(input.scratchBuild) && input.scratchBuild.phase !== "scratch") {
    issues.push('scratchBuild.phase must be "scratch" (the experiment\'s first build)');
  }
  if (isPlainObject(input.reuseBuild) && input.reuseBuild.phase !== "reuse") {
    issues.push('reuseBuild.phase must be "reuse" (the experiment\'s rebuild)');
  }

  validateArtifacts(input.artifacts, issues);

  const planPresent = input.compositionPlan !== undefined;
  if (planPresent) {
    validatePlan(input.compositionPlan, issues);
  }

  let store: PackageStore | null = null;
  if (input.store !== undefined) {
    if (!isStoreLike(input.store)) {
      issues.push("store must be a PackageStore (get, put, list) when supplied");
    } else {
      store = input.store;
    }
  }

  const clockMs =
    input.now === undefined ? DEFAULT_EXPERIMENT_CLOCK_MS : readClock(input.now, issues);

  if (benchmarkId === null || issues.length > 0 || comparison === null || clockMs === null) {
    throw new CompoundingError(
      "invalid-input",
      `the compounding experiment input is invalid (${issues.length} ${
        issues.length === 1 ? "issue" : "issues"
      }); no stage ran, failing closed`,
      issues,
    );
  }

  // ------------------------------------------------------------------
  // Stages 2-3 — extract from the scratch artifacts and register through
  // the real registry over the real store.
  // ------------------------------------------------------------------
  const effectiveStore = store ?? createFreshStore();
  const registry = createPackageRegistry(effectiveStore);
  const extraction: ExtractionResult = extractPackageCandidates(input.artifacts);
  const registrations = registerCandidates(registry, extraction.candidates);
  const candidates = extraction.candidates.map(candidateCoordinate);

  // ------------------------------------------------------------------
  // Stage 4 — evaluate every extracted candidate through the real W2-010
  // gate, grounded on the comparison (the same report promoteGated derives
  // internally from the same records — byte-identical, so the decision ids
  // agree).
  // ------------------------------------------------------------------
  const decisions = candidates.map((candidate) => ({
    candidate,
    decision: decidePromotionGate({ candidate, report: comparison }),
  }));

  // ------------------------------------------------------------------
  // Stage 5 — promote every gate-approved candidate through the real gated
  // flow. The parity evidence carries the scratch artifacts' own parity
  // (extraction produced candidates only from verified-equivalent parity)
  // plus the experiment clock's ISO-8601 rendering as verifiedAt — the one
  // timestamp the frozen parity discipline demands, pinned by the caller.
  // ------------------------------------------------------------------
  const parityEvidence: ParityEvidence = {
    verdict: input.artifacts.parity.verdict,
    verificationRunId: input.artifacts.parity.verificationRunId,
    verifiedAt: isoUtcFromEpochMs(clockMs),
    minorFindings: input.artifacts.parity.minorFindings,
    majorFindings: input.artifacts.parity.majorFindings,
    reconstructionId: input.artifacts.reconstructionId,
    irDigest: input.artifacts.irDigest,
  };

  const promotions: CompoundingPromotionRecord[] = [];
  const promotionOutcomes: PromotionOutcome[] = [];
  for (const { candidate, decision } of decisions) {
    if (decision.outcome !== "promoted") {
      // The gate withheld: no promotion is attempted, and the decision's
      // criterion reasons are the recorded reasons.
      promotions.push({
        candidate,
        decision,
        promoted: false,
        idempotent: false,
        reasons: [...decision.reasons],
      });
      continue;
    }
    const outcome = promoteGated(registry, {
      candidate,
      parity: parityEvidence,
      evaluation: { from: input.scratchBuild, to: input.reuseBuild },
    });
    if (outcome.promoted) {
      promotions.push({
        candidate,
        decision,
        promoted: true,
        idempotent: outcome.idempotent,
        reasons: [],
      });
      promotionOutcomes.push({
        promoted: true,
        document: outcome.document,
        evidence: outcome.evidence,
        idempotent: outcome.idempotent,
      });
    } else {
      promotions.push({
        candidate,
        decision,
        promoted: false,
        idempotent: false,
        reasons: [...outcome.reasons],
      });
      promotionOutcomes.push({ promoted: false, reason: outcome.reasons.join("; ") });
    }
  }

  const promotedPackageIds = [
    ...new Set(promotions.filter((record) => record.promoted).map((record) => record.candidate.id)),
  ].sort(compareStrings);

  // ------------------------------------------------------------------
  // Stages 6-7 — the comparison is attached VERBATIM (composed once, at
  // validation); the per-signal compounding record is derived across it.
  // ------------------------------------------------------------------
  const plan = planPresent ? (input.compositionPlan as CompoundingCompositionPlan) : null;
  const selectedPackageIds = plan !== null ? [...plan.packageIds] : [];
  // Honest attribution: the plan's packageIds ∩ the promoted set — the
  // package SET plausibly behind an improvement, never a per-signal cause.
  const attribution =
    plan !== null ? promotedPackageIds.filter((id) => plan.packageIds.includes(id)) : [];

  // Exactly one row per LEARNING_SIGNAL_IDS signal, in vocabulary order:
  // each row is the comparison's own row for that signal, projected — never
  // re-derived, never fabricated.
  const signalRows: CompoundingSignalRow[] = LEARNING_SIGNAL_IDS.map((signal) => {
    const row = comparison.rows.find((entry) => entry.signal === signal);
    if (row === undefined) {
      // Unreachable by construction (the W2-009 composer derives exactly
      // one row per signal), but the record stays fail-closed.
      throw new CompoundingError(
        "unrepresentable-report",
        `the attached comparison is missing its "${signal}" row: no compounding record is derivable`,
      );
    }
    return compoundingRow(row, plan !== null ? attribution : null);
  });
  const improvedCount = signalRows.filter(
    (row) => row.status === "available" && row.direction === "improved",
  ).length;

  let verdict: CompoundingVerdict;
  let verdictReason: string;
  if (plan === null) {
    verdict = "control";
    verdictReason =
      "learning was disabled for the rebuild (no composition plan): the chain ran end-to-end " +
      "against the scratch artifacts and the control claims no improvement";
  } else if (improvedCount > 0 && attribution.length > 0) {
    verdict = "compounding";
    verdictReason =
      `${improvedCount} learning signal(s) improved with the improvement attributed to the ` +
      `promoted package set (${attribution.join(", ")}): attribution is to the package SET, ` +
      "never a per-signal causal claim";
  } else if (improvedCount > 0) {
    verdict = "no-compounding";
    verdictReason =
      `${improvedCount} learning signal(s) improved but none of the improvement is attributable ` +
      "to a promoted package of the selected set: no attribution is fabricated";
  } else {
    verdict = "no-compounding";
    verdictReason =
      "no learning signal improved between the two builds; every signal's honest state " +
      "(direction or recorded reason) is on its row";
  }

  // ------------------------------------------------------------------
  // Stage 8 — the report, content-addressed over its canonical core (the
  // id never covers itself).
  // ------------------------------------------------------------------
  const scratchBuildDigest = sha256Hex(canonicalJson(comparison.fromBuild) as string);
  const reuseBuildDigest = sha256Hex(canonicalJson(comparison.toBuild) as string);
  const core = {
    benchmarkId,
    learningEnabled: plan !== null,
    selectedPackageIds,
    scratchBuildDigest,
    reuseBuildDigest,
    extraction: {
      candidates,
      skipped: extraction.skipped.map((skip) => ({ reason: skip.reason })),
      summary: extractionSummary(extraction, promotionOutcomes),
    },
    registrations: registrations.results,
    promotions,
    promotedPackageIds,
    comparison,
    signalRows,
    verdict,
    verdictReason,
  };
  const canonical = canonicalJson(core);
  if (canonical === undefined) {
    throw new CompoundingError(
      "unrepresentable-report",
      "the compounding experiment report is not JSON-representable: no content-addressed id is derivable",
    );
  }
  return {
    id: `${COMPOUNDING_EXPERIMENT_ID_PREFIX}${sha256Hex(canonical).slice(0, ID_DIGEST_LENGTH)}`,
    ...core,
  };
}
