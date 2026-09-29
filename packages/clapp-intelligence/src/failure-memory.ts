/**
 * Failure memory and repair-pattern learning (CLAPP-W2-008).
 *
 * Memory layer 5 of docs/clapp/LEARNING.md — "what broke and how it was
 * fixed" — plus the "failure recurrence" learning signal. The STRUCTURAL
 * outcome of a finished W3-006 bounded repair loop (the RepairReport shape)
 * together with the W3-005 parity findings that fed it is distilled into a
 * content-addressed memory record; corroborated records aggregate into
 * repair patterns; patterns suggest honest hints for NEW findings.
 *
 * The repair outcome and findings arrive as duck-typed structural inputs
 * declared HERE: this module never imports @clapp/synthesis,
 * @clapp/benchmarks or any other clapp-* package (ADR-002 layering; the test
 * file is the integration seam and may compose the real W3-006 shapes).
 *
 * Discipline (the module's contract):
 *
 * - DETERMINISTIC — every function is pure over in-memory inputs: same
 *   inputs, byte-identical outputs, with no clock, port, randomness or
 *   environment anywhere. Record ids are content-addressed over the record's
 *   canonical core (sorted keys, content-sorted keyless-map arrays), so the
 *   same outcome produces the same id regardless of how the findings,
 *   iterations or abstention arrays were ordered, and aggregation output is
 *   sorted independently of the input array order. The module performs no
 *   I/O; a later integration wave persists records through a narrow store
 *   port (the W2-005 discipline) supplied by the caller.
 * - HONEST — outcomes that teach nothing abstain with a recorded reason,
 *   never a partial or invented record: no blocking findings, an
 *   unattributable reconstruction, a report without provenance or a
 *   malformed shape all abstain. Records remember only the failure identity
 *   (finding id, dimension, anchor, severity, repairability) and the repair
 *   shape (mutation classes, iterations, actions, stop reason, verdict) —
 *   never plan bodies (an optional plan DIGEST may be carried). A signature
 *   becomes a repair pattern ONLY when the exported evidence minimum is met;
 *   below it the signature is reported as insufficient evidence. A repair
 *   hint appears ONLY for a finding whose signature matches a corroborated
 *   pattern; a missing hint is honest, a guessed one is a fabrication.
 * - FAIL-CLOSED — stored records are re-validated on every read: the shape
 *   must be exactly what the builder produces, the `successful` flag must
 *   match the recorded repair shape, and the id must equal the sha256 of the
 *   record's canonical core. Malformed records are collected as typed errors
 *   and never silently dropped; they simply corroborate nothing.
 *
 * Attribution honesty (the pattern rule): the W3-006 RepairReport records
 * per-iteration aggregate mutation classes, NOT which mutation fixed which
 * finding. A record therefore corroborates "signature S was fixed by
 * mutation class M" ONLY when the loop applied exactly ONE mutation class in
 * total — the single unambiguous lever — AND the loop succeeded (converged,
 * final verdict "equivalent", stopped by "converged"). Multi-class loops and
 * failed loops are still remembered (and still count toward failure
 * recurrence), but they corroborate no pattern: attributing a specific class
 * to a specific finding from them would be a guess.
 *
 * Identifier prefix note: record ids carry the `clapp_learning_` prefix,
 * declared here as FAILURE_MEMORY_ID_PREFIX. The prefix is NOT yet in
 * docs/clapp/CONTRACTS.md's "Core identifiers" list (frozen v0.1,
 * tech-lead-owned); the addition is proposed as a contract revision in the
 * CLAPP-W2-008 completion report and must land as an ADR plus a contracts
 * update at integration. This module never edits @clapp/contracts.
 */

import type { DiffDimension, DiffFinding, DiffSeverity } from "@clapp/contracts";
import {
  canonicalJson,
  checkJsonSafety,
  compareStrings,
  isPlainObject,
  sha256Hex,
  snippet,
} from "./json.ts";

// ---------------------------------------------------------------------------
// Public types — structural mirrors of the W3-006/W3-005 surfaces
// ---------------------------------------------------------------------------

/**
 * The paired engine's verdict semantics — mirrors W3-006's PairedVerdict
 * (the same union as the frozen DiffReport["verdict"]).
 */
export type FailureVerdict = "equivalent" | "divergent" | "blocked";

/** The four M5 mutation classes — mirrors W3-006's RepairMutationClass. */
export type FailureMutationClass =
  | "visible-text"
  | "interaction-id"
  | "network-mock"
  | "state-storage";

/** Why the repair loop stopped — mirrors W3-006's RepairStopReason. */
export type FailureStopReason = "converged" | "stagnation" | "budget";

/** One repair iteration's honest record — mirrors W3-006's RepairIterationRecord. */
export interface FailureIterationRecord {
  findingsBefore: number;
  actionsApplied: number;
  findingsAfter: number;
  verdict: FailureVerdict;
  /** The mutation classes actually applied this iteration (sorted, unique). */
  mutationClasses: FailureMutationClass[];
}

/** One honest abstention entry — mirrors W3-006's RepairAbstention. */
export interface FailureAbstentionRecord {
  anchor: string;
  reason: string;
}

/**
 * The structural outcome of one finished repair loop — mirrors W3-006's
 * RepairReport minus the plan body: memory records the repair SHAPE (ids,
 * iterations, verdicts, abstentions, stop reason), never the plan itself.
 * The W3-006 report's `finalPlan` field is intentionally not carried; an
 * optional sha256 `finalPlanDigest` may be cited instead.
 */
export interface FailureRepairOutcome {
  /** The repair report's content-addressed id (`rr-` + sha256 prefix). */
  id: string;
  reconstructionId: string;
  iterations: FailureIterationRecord[];
  finalVerdict: FailureVerdict;
  abstained: FailureAbstentionRecord[];
  actionsTotal: number;
  converged: boolean;
  stoppedBy: FailureStopReason;
  /** Optional sha256 (lowercase hex) of the repaired plan — shape, not body. */
  finalPlanDigest?: string;
}

/**
 * The input of {@link buildFailureMemoryRecord}: the parity findings that
 * fed the repair loop (the frozen v0.1 DiffFinding shape the W3-005 diff
 * dimensions produce) plus the structural outcome of the finished loop.
 */
export interface FailureMemoryInput {
  findings: readonly DiffFinding[];
  outcome: FailureRepairOutcome;
}

// ---------------------------------------------------------------------------
// Public types — the failure-memory record
// ---------------------------------------------------------------------------

/** What broke: the identity of one blocking parity finding. */
export interface FailureMemoryFailure {
  /** The source finding's own id, cited verbatim. */
  findingId: string;
  dimension: DiffDimension;
  anchor: string;
  severity: DiffSeverity;
  repairability: DiffFinding["repairability"];
}

/** How it was (or was not) fixed: the repair loop's structural shape. */
export interface FailureMemoryRepair {
  /** Every mutation class applied anywhere in the loop (sorted, unique). */
  mutationClassesUsed: FailureMutationClass[];
  /** Well-formed iterations the loop ran (their order carries no identity). */
  iterations: number;
  actionsTotal: number;
  converged: boolean;
  stoppedBy: FailureStopReason;
  finalVerdict: FailureVerdict;
  abstentionCount: number;
  /** sha256 of the repaired plan when the outcome cited one, else null. */
  finalPlanDigest: string | null;
}

/**
 * One content-addressed failure-memory record: what broke, how it was fixed,
 * with full citation of the source reconstruction, repair report and finding
 * ids. Canonical core (the id's preimage): the record minus `id`, plus the
 * domain tag `kind: "failure-memory/1"`.
 */
export interface FailureMemoryRecord {
  /** Content-addressed: `clapp_learning_` + sha256 prefix of the core. */
  id: string;
  reconstructionId: string;
  /** The source repair report's id. */
  reportId: string;
  /** True only for converged, equivalent, stop-by-convergence loops. */
  successful: boolean;
  /** What broke (sorted, unique by canonical form; >= 1 blocking finding). */
  failures: FailureMemoryFailure[];
  repair: FailureMemoryRepair;
}

/** One build outcome: a record, or an honest abstention with a reason. */
export type FailureMemoryResult =
  | { ok: true; record: FailureMemoryRecord }
  | { ok: false; reason: string };

// ---------------------------------------------------------------------------
// Public types — aggregation, recurrence, hints, digest
// ---------------------------------------------------------------------------

/** One malformed record rejected on the read path (collected, never thrown). */
export interface InvalidRecordError {
  /** Best-effort echo of the record's own id; "(unknown)" when absent. */
  recordId: string;
  reason: string;
}

/** A corroborated repair pattern: signature + historically-successful class. */
export interface RepairPattern {
  dimension: DiffDimension;
  anchor: string;
  /** The single mutation class every citing record's loop applied. */
  mutationClass: FailureMutationClass;
  /** The citing record ids (sorted, unique). */
  recordIds: string[];
  /** The number of citing records. */
  supportCount: number;
}

/** A signature corroborated below the evidence minimum — never a pattern. */
export interface InsufficientEvidenceSignature {
  dimension: DiffDimension;
  anchor: string;
  mutationClass: FailureMutationClass;
  recordIds: string[];
  supportCount: number;
  reason: string;
}

/** The deterministic result of aggregating stored records into patterns. */
export interface RepairPatternSummary {
  /** Corroborated patterns (evidence minimum met), sorted by signature. */
  patterns: RepairPattern[];
  /** Corroborated signatures below the minimum, sorted by signature. */
  insufficientEvidence: InsufficientEvidenceSignature[];
  /** Malformed records rejected while reading memory (sorted, deduplicated). */
  invalidRecords: InvalidRecordError[];
}

/** Failure recurrence for one signature, counted from stored records only. */
export interface FailureRecurrence {
  dimension: DiffDimension;
  anchor: string;
  /** Distinct reconstructions that hit this signature (each counts once). */
  recurrenceCount: number;
  /** The distinct reconstructions (sorted, unique). */
  reconstructionIds: string[];
  /** Every witnessing record id (sorted, unique). */
  recordIds: string[];
}

/** The deterministic recurrence accounting over stored records. */
export interface FailureRecurrenceSummary {
  /** Signatures with at least one witnessing record, sorted by signature. */
  recurrences: FailureRecurrence[];
  /** Valid records the recurrence was counted from (deduplicated by id). */
  recordCount: number;
  /** Malformed records rejected while reading memory (sorted, deduplicated). */
  invalidRecords: InvalidRecordError[];
}

/** An honest repair hint for one NEW finding, citing its supporting records. */
export interface RepairHint {
  /** The finding the hint is for (its own id, cited verbatim). */
  findingId: string;
  dimension: DiffDimension;
  anchor: string;
  /** The historically-successful mutation class (from the corroborated pattern). */
  mutationClass: FailureMutationClass;
  /** The pattern's citing record ids (sorted, unique). */
  supportingRecordIds: string[];
  /** The pattern's support count. */
  supportCount: number;
}

/** One finding that produced no hint, with the honest reason why not. */
export interface UnmatchedFinding {
  /** The finding's own id; "(unknown)" when the finding was malformed. */
  findingId: string;
  dimension: DiffDimension | null;
  anchor: string | null;
  reason: string;
}

/** The deterministic hint result for a list of new findings. */
export interface RepairHintResult {
  /** Hints for findings whose signature matches a corroborated pattern. */
  hints: RepairHint[];
  /** Every finding (or malformed input) that honestly produced no hint. */
  unmatched: UnmatchedFinding[];
  /** Malformed records rejected while reading memory (sorted, deduplicated). */
  invalidRecords: InvalidRecordError[];
}

/** The accounting digest: the whole memory surface in one auditable summary. */
export interface FailureMemoryDigest {
  /** Valid records accounted (deduplicated by id). */
  recordCount: number;
  /** Distinct reconstructions among the valid records. */
  reconstructionCount: number;
  /** Corroborated patterns (evidence minimum met). */
  patternCount: number;
  /** Corroborated signatures below the evidence minimum. */
  insufficientEvidenceCount: number;
  /** Malformed records rejected while reading memory. */
  invalidRecordCount: number;
  /** Build-time abstentions supplied by the caller. */
  abstentionCount: number;
  /** The abstention reasons, in the order the caller collected them. */
  abstentionReasons: string[];
}

/** The input of {@link failureMemoryDigest}. */
export interface FailureMemoryDigestInput {
  /** The stored records (validated here; malformed ones are counted). */
  records?: readonly unknown[];
  /**
   * The collected results of buildFailureMemoryRecord calls; entries with
   * ok: false are the abstentions (entries with ok: true are ignored —
   * their records belong in `records`).
   */
  abstentions?: readonly FailureMemoryResult[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The failure-memory record id prefix.
 *
 * PENDING CONTRACT REVISION (tech-lead-owned): this prefix is NOT yet in
 * docs/clapp/CONTRACTS.md's "Core identifiers" list — the frozen v0.1
 * contracts cannot be edited from this work item. The addition is proposed
 * in the CLAPP-W2-008 completion report and must land as an ADR plus a
 * contracts version bump at integration, with a compatibility test.
 */
export const FAILURE_MEMORY_ID_PREFIX = "clapp_learning_";

/**
 * The minimum number of corroborating records a failure signature needs
 * before it is reported as a repair pattern. Below the minimum the signature
 * is reported as insufficient evidence — never as a pattern. Documented
 * default: 2 (one corroborating record is an anecdote, not a pattern).
 */
export const REPAIR_PATTERN_EVIDENCE_MINIMUM = 2;

/** Hex characters of the content digest folded into every record id. */
const ID_DIGEST_LENGTH = 16;

/** Domain tag inside every record's canonical core (guards digest collisions). */
const RECORD_KIND = "failure-memory/1";

/** The frozen v0.1 diff vocabulary (runtime mirrors of the contract unions). */
const DIFF_DIMENSIONS: ReadonlySet<string> = new Set([
  "semantic",
  "visual",
  "network",
  "state",
  "storage",
  "performance",
  "integration",
]);
const DIFF_SEVERITIES: ReadonlySet<string> = new Set(["info", "minor", "major", "critical"]);
const DIFF_REPAIRABILITIES: ReadonlySet<string> = new Set([
  "automatic",
  "assisted",
  "manual",
  "unrepairable",
]);

/** The M5 mutation-class vocabulary (runtime mirror of the W3-006 union). */
const MUTATION_CLASSES: ReadonlySet<string> = new Set([
  "visible-text",
  "interaction-id",
  "network-mock",
  "state-storage",
]);

/** The paired verdict vocabulary (runtime mirror of the W3-006 union). */
const VERDICTS: ReadonlySet<string> = new Set(["equivalent", "divergent", "blocked"]);

/** The repair stop-reason vocabulary (runtime mirror of the W3-006 union). */
const STOP_REASONS: ReadonlySet<string> = new Set(["converged", "stagnation", "budget"]);

// ---------------------------------------------------------------------------
// Small pure helpers
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
    return `"${snippet(value)}"`;
  }
  return Array.isArray(value) ? "array" : typeof value;
}

/**
 * Deduplicates entries by their canonical JSON form and sorts them by it:
 * the identity of an entry set is its content, never its input order.
 */
function sortedUniqueByCanonical<T>(entries: readonly T[]): T[] {
  const kept = new Map<string, T>();
  for (const entry of entries) {
    const key = canonicalJson(entry) ?? JSON.stringify(entry);
    kept.set(key, entry);
  }
  return [...kept.entries()]
    .sort((left, right) => compareStrings(left[0], right[0]))
    .map((pair) => pair[1]);
}

/** Canonical-JSON sha256 of a value, or null when it cannot be serialized. */
function recordDigestOrNull(core: unknown): string | null {
  const errors: string[] = [];
  checkJsonSafety(core, "record", errors);
  if (errors.length > 0) {
    return null;
  }
  const canonical = canonicalJson(core);
  return canonical === undefined ? null : sha256Hex(canonical);
}

/** The record's canonical core: every field except the id, plus the domain tag. */
function recordCore(record: Omit<FailureMemoryRecord, "id">): Record<string, unknown> {
  return {
    kind: RECORD_KIND,
    reconstructionId: record.reconstructionId,
    reportId: record.reportId,
    successful: record.successful,
    failures: record.failures,
    repair: record.repair,
  };
}

/** Deterministic (dimension, anchor, mutationClass) ordering. */
function compareSignatureKeys(
  left: { dimension: string; anchor: string; mutationClass: string },
  right: { dimension: string; anchor: string; mutationClass: string },
): number {
  const byDimension = compareStrings(left.dimension, right.dimension);
  if (byDimension !== 0) {
    return byDimension;
  }
  const byAnchor = compareStrings(left.anchor, right.anchor);
  if (byAnchor !== 0) {
    return byAnchor;
  }
  return compareStrings(left.mutationClass, right.mutationClass);
}

/** The blocking threshold of the repair loop (>= minor severity). */
function isBlockingSeverity(severity: string): boolean {
  return severity !== "info";
}

// ---------------------------------------------------------------------------
// 1. buildFailureMemoryRecord — outcome + findings -> a memory record
// ---------------------------------------------------------------------------

/**
 * Builds the failure-memory record of one finished repair loop. Deterministic
 * and fail-closed: the structural outcome plus the parity findings either
 * justify exactly one content-addressed record (what broke, how it was fixed,
 * with full citation of the source reconstruction, report and finding ids),
 * or they justify nothing and the abstention is recorded with a reason.
 *
 * Gate order (the first failing gate wins): input shape -> findings feed
 * shape -> outcome shape -> reconstruction attribution -> report provenance
 * -> outcome field shapes (iterations, verdict, stop reason, converged,
 * actions total, abstained) -> the blocking-findings substance gate. Input
 * findings, iterations and abstention entries stand alone: a malformed entry
 * is dropped, never fabricated around. The same outcome with reordered
 * findings/iterations/abstentions produces a byte-identical record.
 */
export function buildFailureMemoryRecord(input: FailureMemoryInput): FailureMemoryResult {
  if (!isPlainObject(input)) {
    return {
      ok: false,
      reason: `failure memory input is ${describeValue(input)}: nothing to remember, memory abstains`,
    };
  }
  const rawFindings = (input as Record<string, unknown>).findings;
  if (!Array.isArray(rawFindings)) {
    return {
      ok: false,
      reason: `findings feed is ${describeValue(rawFindings)}: the parity findings cannot be read, memory abstains`,
    };
  }
  const rawOutcome = (input as Record<string, unknown>).outcome;
  if (!isPlainObject(rawOutcome)) {
    return {
      ok: false,
      reason: `repair outcome is ${describeValue(rawOutcome)}: the loop's outcome cannot be read, memory abstains`,
    };
  }

  const reconstructionId = nonEmptyString(rawOutcome.reconstructionId);
  if (reconstructionId === null) {
    return {
      ok: false,
      reason: `reconstruction id is ${describeValue(rawOutcome.reconstructionId)}: the outcome is not attributable to a reconstruction, memory abstains`,
    };
  }
  const reportId = nonEmptyString(rawOutcome.id);
  if (reportId === null) {
    return {
      ok: false,
      reason: `repair report id is ${describeValue(rawOutcome.id)} (reconstruction ${reconstructionId}): the outcome cites no source report, memory abstains`,
    };
  }

  if (!Array.isArray(rawOutcome.iterations)) {
    return {
      ok: false,
      reason: `repair iterations are ${describeValue(rawOutcome.iterations)} (reconstruction ${reconstructionId}): the loop shape cannot be read, memory abstains`,
    };
  }
  const finalVerdict =
    typeof rawOutcome.finalVerdict === "string" && VERDICTS.has(rawOutcome.finalVerdict)
      ? (rawOutcome.finalVerdict as FailureVerdict)
      : null;
  if (finalVerdict === null) {
    return {
      ok: false,
      reason: `final verdict is ${describeValue(rawOutcome.finalVerdict)} (reconstruction ${reconstructionId}): not a paired verdict, memory abstains`,
    };
  }
  const stoppedBy =
    typeof rawOutcome.stoppedBy === "string" && STOP_REASONS.has(rawOutcome.stoppedBy)
      ? (rawOutcome.stoppedBy as FailureStopReason)
      : null;
  if (stoppedBy === null) {
    return {
      ok: false,
      reason: `stop reason is ${describeValue(rawOutcome.stoppedBy)} (reconstruction ${reconstructionId}): not a repair stop reason, memory abstains`,
    };
  }
  if (typeof rawOutcome.converged !== "boolean") {
    return {
      ok: false,
      reason: `converged flag is ${describeValue(rawOutcome.converged)} (reconstruction ${reconstructionId}): not a boolean, memory abstains`,
    };
  }
  const actionsTotal = nonNegativeCount(rawOutcome.actionsTotal);
  if (actionsTotal === null) {
    return {
      ok: false,
      reason: `actions total is ${describeValue(rawOutcome.actionsTotal)} (reconstruction ${reconstructionId}): not a non-negative count, memory abstains`,
    };
  }
  if (!Array.isArray(rawOutcome.abstained)) {
    return {
      ok: false,
      reason: `abstained list is ${describeValue(rawOutcome.abstained)} (reconstruction ${reconstructionId}): the loop's abstentions cannot be read, memory abstains`,
    };
  }

  // What broke: well-formed blocking findings, each standing alone.
  const failures: FailureMemoryFailure[] = [];
  let malformedFindings = 0;
  let infoFindings = 0;
  for (const raw of rawFindings) {
    const failure = normalizeFinding(raw);
    if (failure === null) {
      malformedFindings += 1;
      continue;
    }
    if (!isBlockingSeverity(failure.severity)) {
      infoFindings += 1;
      continue;
    }
    failures.push(failure);
  }
  if (failures.length === 0) {
    return {
      ok: false,
      reason: `outcome of reconstruction ${reconstructionId} reports no blocking findings (${infoFindings} info, ${malformedFindings} malformed dropped): nothing broke at parity-blocking severity, memory abstains`,
    };
  }
  const sortedFailures = sortedUniqueByCanonical(failures);

  // How it was fixed: the loop's shape, invariant to iteration order.
  const iterations: FailureIterationRecord[] = [];
  for (const raw of rawOutcome.iterations) {
    const iteration = normalizeIteration(raw);
    if (iteration !== null) {
      iterations.push(iteration);
    }
  }
  const mutationClassesUsed = sortedUniqueByCanonical(
    iterations.flatMap((iteration) => iteration.mutationClasses),
  );
  const abstentionCount = rawOutcome.abstained.filter((raw) => {
    if (!isPlainObject(raw)) {
      return false;
    }
    return nonEmptyString(raw.anchor) !== null && nonEmptyString(raw.reason) !== null;
  }).length;
  const finalPlanDigest = nonEmptyString(rawOutcome.finalPlanDigest);

  const successful =
    rawOutcome.converged && finalVerdict === "equivalent" && stoppedBy === "converged";
  const repair: FailureMemoryRepair = {
    mutationClassesUsed,
    iterations: iterations.length,
    actionsTotal,
    converged: rawOutcome.converged,
    stoppedBy,
    finalVerdict,
    abstentionCount,
    finalPlanDigest,
  };

  const core = recordCore({
    reconstructionId,
    reportId,
    successful,
    failures: sortedFailures,
    repair,
  });
  const digest = recordDigestOrNull(core);
  if (digest === null) {
    return {
      ok: false,
      reason: `record core is not JSON-representable (reconstruction ${reconstructionId}): no content-addressed identity is derivable, memory abstains`,
    };
  }
  return {
    ok: true,
    record: {
      id: `${FAILURE_MEMORY_ID_PREFIX}${digest.slice(0, ID_DIGEST_LENGTH)}`,
      reconstructionId,
      reportId,
      successful,
      failures: sortedFailures,
      repair,
    },
  };
}

/** One well-formed input finding (identity only), or null when malformed. */
function normalizeFinding(raw: unknown): FailureMemoryFailure | null {
  if (!isPlainObject(raw)) {
    return null;
  }
  const findingId = nonEmptyString(raw.id);
  const dimension = typeof raw.dimension === "string" ? raw.dimension : "";
  const anchor = nonEmptyString(raw.anchor);
  const severity = typeof raw.severity === "string" ? raw.severity : "";
  const repairability = typeof raw.repairability === "string" ? raw.repairability : "";
  if (
    findingId === null ||
    anchor === null ||
    !DIFF_DIMENSIONS.has(dimension) ||
    !DIFF_SEVERITIES.has(severity) ||
    !DIFF_REPAIRABILITIES.has(repairability)
  ) {
    return null;
  }
  return {
    findingId,
    dimension: dimension as DiffDimension,
    anchor,
    severity: severity as DiffSeverity,
    repairability: repairability as DiffFinding["repairability"],
  };
}

/** One well-formed iteration record, or null when malformed (each stands alone). */
function normalizeIteration(raw: unknown): FailureIterationRecord | null {
  if (!isPlainObject(raw)) {
    return null;
  }
  const findingsBefore = nonNegativeCount(raw.findingsBefore);
  const actionsApplied = nonNegativeCount(raw.actionsApplied);
  const findingsAfter = nonNegativeCount(raw.findingsAfter);
  const verdict = typeof raw.verdict === "string" && VERDICTS.has(raw.verdict) ? raw.verdict : null;
  if (
    findingsBefore === null ||
    actionsApplied === null ||
    findingsAfter === null ||
    verdict === null ||
    !Array.isArray(raw.mutationClasses) ||
    !raw.mutationClasses.every(
      (mutationClass) => typeof mutationClass === "string" && MUTATION_CLASSES.has(mutationClass),
    )
  ) {
    return null;
  }
  const unique = sortedUniqueByCanonical(raw.mutationClasses as string[]) as FailureMutationClass[];
  return {
    findingsBefore,
    actionsApplied,
    findingsAfter,
    verdict: verdict as FailureVerdict,
    mutationClasses: unique,
  };
}

// ---------------------------------------------------------------------------
// Record validation — the read path (fail-closed)
// ---------------------------------------------------------------------------

/**
 * Validates one stored record: the shape must be exactly what the builder
 * produces, the `successful` flag must match the recorded repair shape, and
 * the id must equal `clapp_learning_` + the sha256 prefix of the record's
 * canonical core (re-derived here). Records that canonicalize to the same
 * core as their id claims are the same record; anything else is rejected
 * with a collected reason — never thrown, never silently dropped.
 */
function validateMemoryRecord(
  raw: unknown,
): { ok: true; record: FailureMemoryRecord } | { ok: false; error: InvalidRecordError } {
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      error: {
        recordId: "(unknown)",
        reason: `record is ${describeValue(raw)}: not a plain object, memory cannot read it`,
      },
    };
  }
  const id = nonEmptyString(raw.id);
  if (id === null) {
    return {
      ok: false,
      error: {
        recordId: "(unknown)",
        reason: `record id is ${describeValue(raw.id)}: the record cannot be cited`,
      },
    };
  }
  if (!id.startsWith(FAILURE_MEMORY_ID_PREFIX)) {
    return {
      ok: false,
      error: {
        recordId: id,
        reason: `record id does not carry the ${FAILURE_MEMORY_ID_PREFIX} prefix: not a failure-memory record`,
      },
    };
  }
  const reconstructionId = nonEmptyString(raw.reconstructionId);
  if (reconstructionId === null) {
    return {
      ok: false,
      error: {
        recordId: id,
        reason: `reconstruction id is ${describeValue(raw.reconstructionId)} (record ${id}): the record is not attributable`,
      },
    };
  }
  const reportId = nonEmptyString(raw.reportId);
  if (reportId === null) {
    return {
      ok: false,
      error: {
        recordId: id,
        reason: `report id is ${describeValue(raw.reportId)} (record ${id}): the record cites no source repair report`,
      },
    };
  }
  if (typeof raw.successful !== "boolean") {
    return {
      ok: false,
      error: {
        recordId: id,
        reason: `successful flag is ${describeValue(raw.successful)} (record ${id}): not a boolean`,
      },
    };
  }
  const failures = normalizeStoredFailures(raw.failures);
  if (failures === null) {
    return {
      ok: false,
      error: {
        recordId: id,
        reason: `failures list is ${describeValue(raw.failures)} (record ${id}): not an array of well-formed failures`,
      },
    };
  }
  if (failures.length === 0) {
    return {
      ok: false,
      error: {
        recordId: id,
        reason: `failures list is empty (record ${id}): a failure-memory record remembers at least one failure`,
      },
    };
  }
  const repair = normalizeStoredRepair(raw.repair);
  if (repair === null) {
    return {
      ok: false,
      error: {
        recordId: id,
        reason: `repair shape is ${describeValue(raw.repair)} (record ${id}): not a well-formed repair record`,
      },
    };
  }
  const derivedSuccessful =
    repair.converged && repair.finalVerdict === "equivalent" && repair.stoppedBy === "converged";
  if (raw.successful !== derivedSuccessful) {
    return {
      ok: false,
      error: {
        recordId: id,
        reason: `successful flag contradicts the recorded repair shape (record ${id}): the flag is ${String(raw.successful)}, the shape derives ${String(derivedSuccessful)}`,
      },
    };
  }

  const core = recordCore({
    reconstructionId,
    reportId,
    successful: raw.successful,
    failures,
    repair,
  });
  const digest = recordDigestOrNull(core);
  if (digest === null) {
    return {
      ok: false,
      error: {
        recordId: id,
        reason: `record core is not JSON-representable (record ${id}): no content-addressed identity is derivable`,
      },
    };
  }
  const expectedId = `${FAILURE_MEMORY_ID_PREFIX}${digest.slice(0, ID_DIGEST_LENGTH)}`;
  if (id !== expectedId) {
    return {
      ok: false,
      error: {
        recordId: id,
        reason: `content-address mismatch (record ${id}): the id does not match the sha256 prefix of the record's canonical core (${expectedId})`,
      },
    };
  }
  return {
    ok: true,
    record: { id, reconstructionId, reportId, successful: raw.successful, failures, repair },
  };
}

/** Stored failures: every entry must be well-formed (builder output never has junk). */
function normalizeStoredFailures(raw: unknown): FailureMemoryFailure[] | null {
  if (!Array.isArray(raw)) {
    return null;
  }
  const failures: FailureMemoryFailure[] = [];
  for (const entry of raw) {
    const failure = normalizeStoredFailure(entry);
    if (failure === null) {
      return null;
    }
    failures.push(failure);
  }
  return sortedUniqueByCanonical(failures);
}

/** One well-formed stored failure (the record's own findingId shape), or null. */
function normalizeStoredFailure(raw: unknown): FailureMemoryFailure | null {
  if (!isPlainObject(raw)) {
    return null;
  }
  const findingId = nonEmptyString(raw.findingId);
  const dimension = typeof raw.dimension === "string" ? raw.dimension : "";
  const anchor = nonEmptyString(raw.anchor);
  const severity = typeof raw.severity === "string" ? raw.severity : "";
  const repairability = typeof raw.repairability === "string" ? raw.repairability : "";
  if (
    findingId === null ||
    anchor === null ||
    !DIFF_DIMENSIONS.has(dimension) ||
    !DIFF_SEVERITIES.has(severity) ||
    !DIFF_REPAIRABILITIES.has(repairability)
  ) {
    return null;
  }
  return {
    findingId,
    dimension: dimension as DiffDimension,
    anchor,
    severity: severity as DiffSeverity,
    repairability: repairability as DiffFinding["repairability"],
  };
}

/** Stored repair shape: every field must be exactly what the builder emits. */
function normalizeStoredRepair(raw: unknown): FailureMemoryRepair | null {
  if (!isPlainObject(raw)) {
    return null;
  }
  if (
    !Array.isArray(raw.mutationClassesUsed) ||
    !raw.mutationClassesUsed.every(
      (mutationClass) => typeof mutationClass === "string" && MUTATION_CLASSES.has(mutationClass),
    )
  ) {
    return null;
  }
  const iterations = nonNegativeCount(raw.iterations);
  const actionsTotal = nonNegativeCount(raw.actionsTotal);
  const abstentionCount = nonNegativeCount(raw.abstentionCount);
  const stoppedBy =
    typeof raw.stoppedBy === "string" && STOP_REASONS.has(raw.stoppedBy) ? raw.stoppedBy : null;
  const finalVerdict =
    typeof raw.finalVerdict === "string" && VERDICTS.has(raw.finalVerdict)
      ? raw.finalVerdict
      : null;
  const hasPlanDigest = raw.finalPlanDigest !== null && raw.finalPlanDigest !== undefined;
  const finalPlanDigest = hasPlanDigest ? nonEmptyString(raw.finalPlanDigest) : null;
  if (
    iterations === null ||
    actionsTotal === null ||
    abstentionCount === null ||
    stoppedBy === null ||
    finalVerdict === null ||
    (hasPlanDigest && finalPlanDigest === null) ||
    typeof raw.converged !== "boolean"
  ) {
    return null;
  }
  return {
    mutationClassesUsed: sortedUniqueByCanonical(
      raw.mutationClassesUsed as string[],
    ) as FailureMutationClass[],
    iterations,
    actionsTotal,
    converged: raw.converged,
    stoppedBy: stoppedBy as FailureStopReason,
    finalVerdict: finalVerdict as FailureVerdict,
    abstentionCount,
    finalPlanDigest,
  };
}

/** Validates a record batch: deduplicated valid records + collected errors. */
function validateRecords(rawRecords: unknown): {
  records: FailureMemoryRecord[];
  invalid: InvalidRecordError[];
} {
  if (!Array.isArray(rawRecords)) {
    return {
      records: [],
      invalid: [
        {
          recordId: "(unknown)",
          reason: `records input is ${describeValue(rawRecords)}: not an array, nothing can be read from memory`,
        },
      ],
    };
  }
  const byId = new Map<string, FailureMemoryRecord>();
  const invalidByKey = new Map<string, InvalidRecordError>();
  for (const raw of rawRecords) {
    const validated = validateMemoryRecord(raw);
    if (validated.ok) {
      byId.set(validated.record.id, validated.record);
    } else {
      invalidByKey.set(
        `${validated.error.recordId}\u0000${validated.error.reason}`,
        validated.error,
      );
    }
  }
  const records = [...byId.values()].sort((left, right) => compareStrings(left.id, right.id));
  const invalid = [...invalidByKey.values()].sort((left, right) =>
    compareStrings(
      `${left.recordId}\u0000${left.reason}`,
      `${right.recordId}\u0000${right.reason}`,
    ),
  );
  return { records, invalid };
}

// ---------------------------------------------------------------------------
// Corroborated signatures — the shared pattern derivation
// ---------------------------------------------------------------------------

/** One (dimension, anchor) with its per-mutation-class corroborating record ids. */
interface SignatureNode {
  dimension: DiffDimension;
  anchor: string;
  byClass: Map<FailureMutationClass, Set<string>>;
}

/**
 * Derives every corroborated signature from valid records. A record
 * corroborates (signature, mutation class) only when its loop succeeded AND
 * applied exactly one mutation class in total (the attribution-honesty rule
 * in the module header). The same record witnessing the same signature twice
 * (two findings) corroborates once.
 */
function corroboratedSignatures(records: readonly FailureMemoryRecord[]): SignatureNode[] {
  const nodes = new Map<string, SignatureNode>();
  for (const record of records) {
    if (!record.successful) {
      continue;
    }
    if (record.repair.mutationClassesUsed.length !== 1) {
      continue;
    }
    const mutationClass = record.repair.mutationClassesUsed[0];
    const seenSignatures = new Set<string>();
    for (const failure of record.failures) {
      const key = `${failure.dimension}\u0000${failure.anchor}`;
      if (seenSignatures.has(key)) {
        continue;
      }
      seenSignatures.add(key);
      let node = nodes.get(key);
      if (node === undefined) {
        node = { dimension: failure.dimension, anchor: failure.anchor, byClass: new Map() };
        nodes.set(key, node);
      }
      let recordIds = node.byClass.get(mutationClass);
      if (recordIds === undefined) {
        recordIds = new Set();
        node.byClass.set(mutationClass, recordIds);
      }
      recordIds.add(record.id);
    }
  }
  return [...nodes.values()].sort((left, right) =>
    compareSignatureKeys(
      { dimension: left.dimension, anchor: left.anchor, mutationClass: "" },
      { dimension: right.dimension, anchor: right.anchor, mutationClass: "" },
    ),
  );
}

// ---------------------------------------------------------------------------
// 2. aggregateRepairPatterns — records -> patterns (evidence-gated)
// ---------------------------------------------------------------------------

/**
 * Aggregates stored records into repair patterns. Pure and order-independent:
 * the same records in any input order produce a byte-identical summary. A
 * signature becomes a pattern ONLY when at least
 * REPAIR_PATTERN_EVIDENCE_MINIMUM records corroborate it; below the minimum
 * the signature is reported as insufficient evidence with a recorded reason —
 * never as a pattern. Malformed records are collected as typed errors,
 * corroborate nothing, and are never silently dropped.
 */
export function aggregateRepairPatterns(records: readonly unknown[]): RepairPatternSummary {
  const { records: valid, invalid } = validateRecords(records);
  const patterns: RepairPattern[] = [];
  const insufficientEvidence: InsufficientEvidenceSignature[] = [];
  for (const node of corroboratedSignatures(valid)) {
    for (const [mutationClass, recordIdSet] of node.byClass) {
      const recordIds = [...recordIdSet].sort(compareStrings);
      const supportCount = recordIds.length;
      if (supportCount >= REPAIR_PATTERN_EVIDENCE_MINIMUM) {
        patterns.push({
          dimension: node.dimension,
          anchor: node.anchor,
          mutationClass,
          recordIds,
          supportCount,
        });
      } else {
        insufficientEvidence.push({
          dimension: node.dimension,
          anchor: node.anchor,
          mutationClass,
          recordIds,
          supportCount,
          reason: `signature (${node.dimension}, ${node.anchor}) with mutation class ${mutationClass} is corroborated by ${supportCount} record(s), below the evidence minimum of ${REPAIR_PATTERN_EVIDENCE_MINIMUM}: reported as insufficient evidence, never as a pattern`,
        });
      }
    }
  }
  patterns.sort((left, right) =>
    compareSignatureKeys(
      { dimension: left.dimension, anchor: left.anchor, mutationClass: left.mutationClass },
      { dimension: right.dimension, anchor: right.anchor, mutationClass: right.mutationClass },
    ),
  );
  insufficientEvidence.sort((left, right) =>
    compareSignatureKeys(
      { dimension: left.dimension, anchor: left.anchor, mutationClass: left.mutationClass },
      { dimension: right.dimension, anchor: right.anchor, mutationClass: right.mutationClass },
    ),
  );
  return { patterns, insufficientEvidence, invalidRecords: invalid };
}

// ---------------------------------------------------------------------------
// 3. countFailureRecurrence — the failure-recurrence learning signal
// ---------------------------------------------------------------------------

/**
 * Counts failure recurrence strictly from the stored records: for every
 * signature, the DISTINCT reconstructions that hit it (each reconstruction
 * counts once, however many of its records witness the signature) plus every
 * witnessing record id. Recurrence counts failures, not fixes — records of
 * loops that never converged count exactly like successful ones. An empty
 * memory yields an honest zero accounting (no records, no signatures, no
 * invented numbers); malformed records are collected, never dropped.
 */
export function countFailureRecurrence(records: readonly unknown[]): FailureRecurrenceSummary {
  const { records: valid, invalid } = validateRecords(records);
  const nodes = new Map<
    string,
    {
      dimension: DiffDimension;
      anchor: string;
      reconstructions: Set<string>;
      recordIds: Set<string>;
    }
  >();
  for (const record of valid) {
    const seenSignatures = new Set<string>();
    for (const failure of record.failures) {
      const key = `${failure.dimension}\u0000${failure.anchor}`;
      if (seenSignatures.has(key)) {
        continue;
      }
      seenSignatures.add(key);
      let node = nodes.get(key);
      if (node === undefined) {
        node = {
          dimension: failure.dimension,
          anchor: failure.anchor,
          reconstructions: new Set(),
          recordIds: new Set(),
        };
        nodes.set(key, node);
      }
      node.reconstructions.add(record.reconstructionId);
      node.recordIds.add(record.id);
    }
  }
  const recurrences = [...nodes.values()]
    .map((node) => ({
      dimension: node.dimension,
      anchor: node.anchor,
      recurrenceCount: node.reconstructions.size,
      reconstructionIds: [...node.reconstructions].sort(compareStrings),
      recordIds: [...node.recordIds].sort(compareStrings),
    }))
    .sort((left, right) =>
      compareSignatureKeys(
        { dimension: left.dimension, anchor: left.anchor, mutationClass: "" },
        { dimension: right.dimension, anchor: right.anchor, mutationClass: "" },
      ),
    );
  return { recurrences, recordCount: valid.length, invalidRecords: invalid };
}

// ---------------------------------------------------------------------------
// 4. suggestRepairHints — new findings + memory -> honest hints
// ---------------------------------------------------------------------------

/**
 * Suggests repair hints for NEW parity findings against the stored memory.
 * A hint appears ONLY when the finding's (dimension, anchor) signature
 * matches exactly one corroborated pattern that meets the evidence minimum;
 * every hint cites the supporting record ids and the historically-successful
 * mutation class. Unmatched findings — no corroborated pattern, a signature
 * below the evidence minimum, an ambiguous history (several classes
 * corroborated at the minimum), info-severity findings, malformed findings —
 * produce NO hint and are reported as unmatched with the honest reason. A
 * missing hint is honest; a guessed one is a fabrication.
 */
export function suggestRepairHints(
  findings: readonly DiffFinding[],
  records: readonly unknown[],
): RepairHintResult {
  const { records: valid, invalid } = validateRecords(records);
  const signaturesBySignature = new Map<
    string,
    {
      meetingMinimum: Array<{
        mutationClass: FailureMutationClass;
        recordIds: string[];
        supportCount: number;
      }>;
      bestSupport: number;
    }
  >();
  for (const node of corroboratedSignatures(valid)) {
    const corroborations = [...node.byClass.entries()].map(([mutationClass, recordIds]) => ({
      mutationClass,
      recordIds: [...recordIds].sort(compareStrings),
      supportCount: recordIds.size,
    }));
    signaturesBySignature.set(`${node.dimension}\u0000${node.anchor}`, {
      meetingMinimum: corroborations.filter(
        (corroboration) => corroboration.supportCount >= REPAIR_PATTERN_EVIDENCE_MINIMUM,
      ),
      bestSupport: corroborations.reduce(
        (maximum, corroboration) => Math.max(maximum, corroboration.supportCount),
        0,
      ),
    });
  }

  if (!Array.isArray(findings)) {
    return {
      hints: [],
      unmatched: [
        {
          findingId: "(unknown)",
          dimension: null,
          anchor: null,
          reason: `findings input is ${describeValue(findings)}: not an array, no finding can be matched`,
        },
      ],
      invalidRecords: invalid,
    };
  }

  const hints: RepairHint[] = [];
  const unmatched: UnmatchedFinding[] = [];
  const seenFindings = new Set<string>();
  for (const raw of findings) {
    const failure = normalizeFinding(raw);
    if (failure === null) {
      unmatched.push({
        findingId: "(unknown)",
        dimension: null,
        anchor: null,
        reason: `finding is ${describeValue(raw)}: no well-formed failure signature, no hint`,
      });
      continue;
    }
    const canonicalKey = canonicalJson(failure) ?? JSON.stringify(failure);
    if (seenFindings.has(canonicalKey)) {
      continue;
    }
    seenFindings.add(canonicalKey);
    if (!isBlockingSeverity(failure.severity)) {
      unmatched.push({
        findingId: failure.findingId,
        dimension: failure.dimension,
        anchor: failure.anchor,
        reason: `finding ${failure.findingId} is info severity (below the repair loop's blocking threshold): no repair hint applies`,
      });
      continue;
    }
    const signatureKey = `${failure.dimension}\u0000${failure.anchor}`;
    const node = signaturesBySignature.get(signatureKey);
    if (node === undefined) {
      unmatched.push({
        findingId: failure.findingId,
        dimension: failure.dimension,
        anchor: failure.anchor,
        reason: `signature (${failure.dimension}, ${failure.anchor}) of finding ${failure.findingId} has no corroborated repair pattern: no hint (a missing hint is honest, a guessed one is a fabrication)`,
      });
      continue;
    }
    if (node.meetingMinimum.length === 0) {
      unmatched.push({
        findingId: failure.findingId,
        dimension: failure.dimension,
        anchor: failure.anchor,
        reason: `signature (${failure.dimension}, ${failure.anchor}) of finding ${failure.findingId} is corroborated by at most ${node.bestSupport} record(s), below the repair-pattern evidence minimum of ${REPAIR_PATTERN_EVIDENCE_MINIMUM}: no hint`,
      });
      continue;
    }
    if (node.meetingMinimum.length > 1) {
      const classes = node.meetingMinimum
        .map((pattern) => pattern.mutationClass)
        .sort(compareStrings)
        .join(", ");
      unmatched.push({
        findingId: failure.findingId,
        dimension: failure.dimension,
        anchor: failure.anchor,
        reason: `signature (${failure.dimension}, ${failure.anchor}) of finding ${failure.findingId} has ${node.meetingMinimum.length} corroborated mutation classes (${classes}): hinting one would be a guess, no hint`,
      });
      continue;
    }
    const pattern = node.meetingMinimum[0];
    hints.push({
      findingId: failure.findingId,
      dimension: failure.dimension,
      anchor: failure.anchor,
      mutationClass: pattern.mutationClass,
      supportingRecordIds: pattern.recordIds,
      supportCount: pattern.supportCount,
    });
  }
  return { hints, unmatched, invalidRecords: invalid };
}

// ---------------------------------------------------------------------------
// 5. failureMemoryDigest — the accounting digest
// ---------------------------------------------------------------------------

/**
 * The auditable digest of the whole failure-memory surface: record and
 * reconstruction counts, pattern and insufficient-evidence counts, malformed
 * record count, and the build-time abstention count with its reasons (the
 * caller's collected buildFailureMemoryRecord results). Reading the digest
 * never requires reading a single record. Empty inputs yield an all-zero
 * digest — an honest empty, never an error.
 */
export function failureMemoryDigest(input: FailureMemoryDigestInput): FailureMemoryDigest {
  const rawInput: unknown = input;
  if (!isPlainObject(rawInput)) {
    return {
      recordCount: 0,
      reconstructionCount: 0,
      patternCount: 0,
      insufficientEvidenceCount: 0,
      invalidRecordCount: 0,
      abstentionCount: 0,
      abstentionReasons: [],
    };
  }
  const rawRecords = (rawInput as Record<string, unknown>).records;
  const { records: valid, invalid } = validateRecords(
    rawRecords === undefined || rawRecords === null ? [] : rawRecords,
  );
  const reconstructions = new Set(valid.map((record) => record.reconstructionId));
  const summary = aggregateRepairPatterns(valid);
  const rawAbstentions = (rawInput as Record<string, unknown>).abstentions;
  const abstentionReasons: string[] = [];
  if (Array.isArray(rawAbstentions)) {
    for (const entry of rawAbstentions) {
      if (isPlainObject(entry) && entry.ok === false) {
        const reason = nonEmptyString(entry.reason);
        if (reason !== null) {
          abstentionReasons.push(reason);
        }
      }
    }
  }
  return {
    recordCount: valid.length,
    reconstructionCount: reconstructions.size,
    patternCount: summary.patterns.length,
    insufficientEvidenceCount: summary.insufficientEvidence.length,
    invalidRecordCount: invalid.length,
    abstentionCount: abstentionReasons.length,
    abstentionReasons,
  };
}
