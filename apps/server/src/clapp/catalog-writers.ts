import type { ClappPackage } from "../../../../packages/clapp-contracts/src/index.ts";
import {
  buildLearningComparison,
  type CompoundingExperimentInput,
  type CompoundingExperimentReport,
  type GatedPromotionInput,
  type GatedPromotionOutcome,
  type LearningBuildRecord,
  type LearningComparisonReport,
  type PackageRegistry,
  type PromotionEvidence,
  type PromotionGateDecision,
  promoteGated,
  runCompoundingExperiment,
} from "../../../../packages/clapp-intelligence/src/index.ts";
import type { Store } from "../db.ts";

export type { ClappPackage } from "../../../../packages/clapp-contracts/src/index.ts";
// The composed surfaces' types this module's public signatures name, re-exported
// so consumers of the writers need no second import site (the types remain
// the frozen packages' own — nothing is mirrored or redeclared).
export type {
  CompoundingExperimentInput,
  CompoundingExperimentReport,
  GatedPromotionInput,
  GatedPromotionOutcome,
  LearningBuildRecord,
  LearningComparisonReport,
  PackageRegistry,
  PromotionEvidence,
} from "../../../../packages/clapp-intelligence/src/index.ts";

/**
 * CLAPP-W2-013 — catalog store writers.
 *
 * Small, honest adapters over the substrate `Store` (the same owner/kind/id
 * record surface the engine and the W1-007 repositories use) for the three
 * owner-scoped CLAPP catalog kinds:
 *
 * - `clapp-packages` — one row per promoted package document, written ONLY
 *   from a promoting {@link GatedPromotionOutcome} (the real W2-010
 *   `promoteGated` output): the promoted `ClappPackage` document verbatim,
 *   the promotion evidence verbatim, and the gate's own citations (the
 *   `clapp_eval_` decision id and the `clapp_learning_` benchmark report id
 *   it grounded itself on).
 * - `clapp-learning` — one row per learning report, written ONLY from what
 *   the real package functions produced: the verbatim W2-009
 *   `buildLearningComparison` report and the verbatim W2-011
 *   `runCompoundingExperiment` report, each keyed by its own
 *   content-addressed id.
 * - `clapp-export-evidence` — one row per promotion's export-justifying
 *   evidence, written ONLY from a promoting {@link GatedPromotionOutcome}:
 *   the verbatim `PromotionEvidence` (verifiedAt, verification run id,
 *   provenance notes) plus the gate citations — the evidence trail
 *   SECURITY.md demands before a verified package may enter automatic
 *   composition (the package set a later W3-010 export bundle draws on).
 *
 * Discipline (the module's contract):
 *
 * - NEVER FABRICATE — writers persist only what the real package functions
 *   produced. A withheld promotion writes nothing (the registry was left
 *   untouched by the gate itself); a malformed learning record or experiment
 *   input fails closed inside the real function BEFORE any store write, so
 *   the kind stays empty. Empty stores stay empty. No writer invents an id,
 *   a timestamp, a package document or a report: every row id is the
 *   artifact's own content-addressed id (or the package coordinate), and
 *   every row body is a verbatim carry.
 * - CLOCK-FREE ROW CONTENT — no wall-clock value ever enters a row: the
 *   substrate's own `updated_at` column orders lists; the one timestamp the
 *   frozen surfaces require (the promotion evidence's `verifiedAt`) comes
 *   from the real function's own discipline (caller-pinned or the
 *   experiment's injected clock), never from this module.
 * - COMPOSITION, NOT REIMPLEMENTATION — {@link writeGatedPromotion} composes
 *   the REAL W2-010 `promoteGated`; {@link writeLearningComparison} composes
 *   the REAL W2-009 `buildLearningComparison`; {@link writeCompoundingExperiment}
 *   composes the REAL W2-011 `runCompoundingExperiment`. No gate, comparison
 *   or experiment logic is duplicated here. The registry instance is the
 *   caller's (dependency-injected, like every server seam) — this module
 *   owns no hidden global state.
 * - FAIL-CLOSED, HONEST RESULTS — the typed errors of the composed surfaces
 *   (`LearningRecordError`, `CompoundingError`) propagate untouched with
 *   nothing written; a withheld promotion returns every verbatim reason and
 *   writes nothing; a structurally malformed outcome (a corrupted promote
 *   result) is refused with a precise `TypeError` before the store is
 *   touched. Reads return the stored rows or `null` — never guesses.
 *
 * Seam honesty (W2-013's work record carries the full table): no server flow
 * calls these writers today — the reconstruction chain (W3-008's honest
 * digest records this) plans and promotes no packages yet, so no existing
 * flow produces a `GatedPromotionOutcome`, a `LearningComparisonReport` or a
 * `CompoundingExperimentReport` to persist. The writers land as the adapter
 * layer between the frozen package functions and the substrate store; the
 * later wave that wires package learning into the reconstruction chain is
 * their first in-server consumer. Until then the module's only callers are
 * its tests, which drive it over the real substrate `Store`.
 */

// ---------------------------------------------------------------------------
// Kinds and row types
// ---------------------------------------------------------------------------

/** The three owner-scoped catalog kinds this module writes. */
export const CLAPP_CATALOG_KINDS = [
  "clapp-packages",
  "clapp-learning",
  "clapp-export-evidence",
] as const;

/** One of the three catalog kinds. */
export type ClappCatalogKind = (typeof CLAPP_CATALOG_KINDS)[number];

/**
 * One promoted-package row of the `clapp-packages` kind. The row id is the
 * package's identity coordinate (`<id>@<normalized version>` — the W2-005
 * registry's own key discipline); everything else is a verbatim carry of
 * what the real `promoteGated` produced.
 */
export interface ClappPackageCatalogRow {
  /** `<packageId>@<version>` — the registry's identity coordinate. */
  id: string;
  packageId: string;
  version: string;
  /** The promoted document as the registry stored it (verbatim). */
  document: ClappPackage;
  /** The promotion evidence that justified (or re-affirmed) the promotion. */
  evidence: PromotionEvidence;
  /** The gate decision id (`clapp_eval_…`) the promotion cites. */
  decisionId: string;
  /** The benchmark report id (`clapp_learning_…`) the decision grounded itself on. */
  reportId: string;
  /** True when the (id, version) was already promoted with identical evidence. */
  idempotent: boolean;
}

/** One learning report row of the `clapp-learning` kind: a W2-009 comparison report. */
export interface ClappComparisonReportRow {
  /** The report's own content-addressed id (`clapp_learning_…`). */
  id: string;
  reportKind: "comparison";
  /** The W2-009 report, verbatim. */
  report: LearningComparisonReport;
}

/** One learning report row of the `clapp-learning` kind: a W2-011 experiment report. */
export interface ClappExperimentReportRow {
  /** The report's own content-addressed id (`clapp_compound_…`). */
  id: string;
  reportKind: "compounding";
  /** The W2-011 report, verbatim. */
  report: CompoundingExperimentReport;
}

/** One row of the `clapp-learning` kind: comparison or compounding, never reshaped. */
export type ClappLearningCatalogRow = ClappComparisonReportRow | ClappExperimentReportRow;

/**
 * One export-evidence row of the `clapp-export-evidence` kind. The row id is
 * the gate decision's own content-addressed id (`clapp_eval_…`): one evidence
 * row per promotion decision, carrying exactly what the real `promoteGated`
 * produced — the verbatim promotion evidence plus the citations.
 */
export interface ClappExportEvidenceRow {
  /** The gate decision id (`clapp_eval_…`). */
  id: string;
  packageId: string;
  version: string;
  /** The benchmark report id (`clapp_learning_…`) the decision cites. */
  reportId: string;
  /** The promotion evidence, verbatim (verifiedAt, verification run, notes). */
  evidence: PromotionEvidence;
  /** True when the promotion was the registry's idempotent no-op. */
  idempotent: boolean;
}

/** The result of one catalog write attempt. */
export type CatalogWriteResult =
  | { written: true; id: string }
  | { written: false; reasons: string[] };

/**
 * The result of {@link writeGatedPromotion}: the real flow's outcome carried
 * verbatim, plus what each catalog kind wrote.
 */
export interface GatedPromotionWriteResult {
  /** The verbatim W2-010 `promoteGated` outcome (promoted or withheld). */
  outcome: GatedPromotionOutcome;
  /** What was written to `clapp-packages` (nothing when withheld). */
  packageRow: CatalogWriteResult;
  /** What was written to `clapp-export-evidence` (nothing when withheld). */
  evidenceRow: CatalogWriteResult;
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/** A non-empty owner string, or a fail-closed `TypeError`. */
function requireOwner(owner: string): string {
  if (typeof owner !== "string" || owner.trim().length === 0) {
    throw new TypeError("the catalog owner must be a non-empty string");
  }
  return owner;
}

/** True when the value is a non-null, non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A string field read off a record, or `null` when absent/non-string. */
function stringField(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * The withheld branch's verbatim reasons. The real `promoteGated` surface
 * guarantees every non-promoting outcome carries at least one reason, so a
 * record that carries neither a promoting result nor a reasons array is a
 * corrupted outcome: the honest fallback states exactly that (a fabricated
 * reason is never invented).
 */
function withheldReasons(outcome: Record<string, unknown>): string[] {
  const reasons = outcome.reasons;
  if (Array.isArray(reasons) && reasons.length > 0) {
    return reasons as string[];
  }
  return ["the gated promotion outcome carries neither a promoted result nor recorded reasons"];
}

/**
 * Structurally validates a promoting {@link GatedPromotionOutcome} and
 * returns its coordinate/citation fields, or throws a precise `TypeError`
 * before the store is touched: a corrupted outcome must never half-write a
 * catalog row. The structural bar mirrors the frozen W2-010 output shape;
 * nothing deeper is re-derived (the real gate already produced it).
 */
function promotingFields(outcome: GatedPromotionOutcome): {
  candidate: { id: string; version: string };
  decision: PromotionGateDecision;
  document: ClappPackage;
  evidence: PromotionEvidence;
  idempotent: boolean;
} {
  if (!isRecord(outcome)) {
    throw new TypeError("the gated promotion outcome must be an object");
  }
  if (outcome.promoted !== true) {
    throw new TypeError("the gated promotion outcome is not a promoting outcome");
  }
  const decision = outcome.decision;
  if (!isRecord(decision)) {
    throw new TypeError("the promoting outcome carries no gate decision");
  }
  const decisionId = stringField(decision, "id");
  const reportId = stringField(decision, "reportId");
  const candidate = decision.candidate;
  if (decisionId === null || reportId === null) {
    throw new TypeError("the gate decision's id and report citation are required");
  }
  if (!isRecord(candidate) || stringField(candidate, "id") === null) {
    throw new TypeError("the gate decision's candidate coordinate is required");
  }
  const document = outcome.document;
  if (!isRecord(document)) {
    throw new TypeError("the promoting outcome carries no package document");
  }
  const evidence = outcome.evidence;
  if (!isRecord(evidence)) {
    throw new TypeError("the promoting outcome carries no promotion evidence");
  }
  if (stringField(evidence, "verifiedAt") === null) {
    throw new TypeError("the promotion evidence carries no verifiedAt timestamp");
  }
  if (stringField(evidence, "verificationRunId") === null) {
    throw new TypeError("the promotion evidence cites no verification run");
  }
  return {
    candidate: { id: candidate.id, version: candidate.version },
    decision: outcome.decision,
    document: outcome.document,
    evidence: outcome.evidence,
    idempotent: outcome.idempotent === true,
  };
}

// ---------------------------------------------------------------------------
// Writers — the `clapp-packages` and `clapp-export-evidence` kinds
// ---------------------------------------------------------------------------

/**
 * Persists one promoted package row (`clapp-packages` kind) from a promoting
 * {@link GatedPromotionOutcome}: the document, the evidence and the gate's
 * citations, all verbatim. A withheld outcome writes NOTHING — the package
 * stays absent from the catalog exactly as the gate left the registry — and
 * the outcome's verbatim reasons are carried back.
 */
export async function writePromotedPackage(
  db: Store,
  owner: string,
  outcome: GatedPromotionOutcome,
): Promise<CatalogWriteResult> {
  requireOwner(owner);
  if (!isRecord(outcome) || outcome.promoted !== true) {
    return {
      written: false,
      reasons: isRecord(outcome)
        ? withheldReasons(outcome)
        : ["the gated promotion outcome is missing or malformed"],
    };
  }
  const fields = promotingFields(outcome);
  const row: ClappPackageCatalogRow = {
    id: `${fields.candidate.id}@${fields.candidate.version}`,
    packageId: fields.candidate.id,
    version: fields.candidate.version,
    document: fields.document,
    evidence: fields.evidence,
    decisionId: fields.decision.id,
    reportId: fields.decision.reportId,
    idempotent: fields.idempotent,
  };
  await db.put(owner, "clapp-packages", row);
  return { written: true, id: row.id };
}

/**
 * Persists one export-evidence row (`clapp-export-evidence` kind) from a
 * promoting {@link GatedPromotionOutcome}: the verbatim promotion evidence
 * plus the gate citations — the trail SECURITY.md requires before a
 * verified package may enter automatic composition. A withheld outcome
 * writes NOTHING (empty stores stay empty) and carries the reasons back.
 */
export async function writeExportEvidence(
  db: Store,
  owner: string,
  outcome: GatedPromotionOutcome,
): Promise<CatalogWriteResult> {
  requireOwner(owner);
  if (!isRecord(outcome) || outcome.promoted !== true) {
    return {
      written: false,
      reasons: isRecord(outcome)
        ? withheldReasons(outcome)
        : ["the gated promotion outcome is missing or malformed"],
    };
  }
  const fields = promotingFields(outcome);
  const row: ClappExportEvidenceRow = {
    id: fields.decision.id,
    packageId: fields.candidate.id,
    version: fields.candidate.version,
    reportId: fields.decision.reportId,
    evidence: fields.evidence,
    idempotent: fields.idempotent,
  };
  await db.put(owner, "clapp-export-evidence", row);
  return { written: true, id: row.id };
}

/**
 * The composing promotion flow: runs the REAL W2-010 `promoteGated` over the
 * caller's registry and persists exactly what it produced — the promoted
 * package row (`clapp-packages`) and the export-evidence row
 * (`clapp-export-evidence`) when (and only when) the promotion succeeded.
 * A withheld outcome writes nothing to either kind and returns the flow's
 * verbatim outcome with every reason.
 */
export async function writeGatedPromotion(
  db: Store,
  owner: string,
  registry: PackageRegistry,
  input: GatedPromotionInput,
): Promise<GatedPromotionWriteResult> {
  requireOwner(owner);
  const outcome = promoteGated(registry, input);
  const packageRow = await writePromotedPackage(db, owner, outcome);
  const evidenceRow = await writeExportEvidence(db, owner, outcome);
  return { outcome, packageRow, evidenceRow };
}

// ---------------------------------------------------------------------------
// Writers — the `clapp-learning` kind
// ---------------------------------------------------------------------------

/**
 * Composes the REAL W2-009 `buildLearningComparison` over the two build
 * records and persists the verbatim `LearningComparisonReport` as one
 * `clapp-learning` row keyed by the report's own content-addressed id.
 * The composer's typed `LearningRecordError` propagates with NOTHING
 * written (the fail-closed discipline of the composed surface itself).
 */
export async function writeLearningComparison(
  db: Store,
  owner: string,
  from: LearningBuildRecord,
  to: LearningBuildRecord,
): Promise<LearningComparisonReport> {
  requireOwner(owner);
  const report = buildLearningComparison(from, to);
  const row: ClappComparisonReportRow = {
    id: report.id,
    reportKind: "comparison",
    report,
  };
  await db.put(owner, "clapp-learning", row);
  return report;
}

/**
 * Composes the REAL W2-011 `runCompoundingExperiment` and persists the
 * verbatim `CompoundingExperimentReport` as one `clapp-learning` row keyed
 * by the report's own content-addressed id. The experiment's typed
 * `CompoundingError` propagates with NOTHING written. The input passes
 * through verbatim — including its optional injected clock and package
 * store, which this module never invents.
 */
export async function writeCompoundingExperiment(
  db: Store,
  owner: string,
  input: CompoundingExperimentInput,
): Promise<CompoundingExperimentReport> {
  requireOwner(owner);
  const report = runCompoundingExperiment(input);
  const row: ClappExperimentReportRow = {
    id: report.id,
    reportKind: "compounding",
    report,
  };
  await db.put(owner, "clapp-learning", row);
  return report;
}

// ---------------------------------------------------------------------------
// Readers — honest shapes, never guesses
// ---------------------------------------------------------------------------

/** One promoted-package row, or `null` when the owner has no such row. */
export async function getPromotedPackage(
  db: Store,
  owner: string,
  id: string,
): Promise<ClappPackageCatalogRow | null> {
  return db.get<ClappPackageCatalogRow>(owner, "clapp-packages", id);
}

/** The owner's promoted-package rows, most recently updated first. */
export async function listPromotedPackages(
  db: Store,
  owner: string,
): Promise<ClappPackageCatalogRow[]> {
  return db.list<ClappPackageCatalogRow>(owner, "clapp-packages");
}

/** One learning report row (comparison or compounding), or `null` when absent. */
export async function getLearningReport(
  db: Store,
  owner: string,
  id: string,
): Promise<ClappLearningCatalogRow | null> {
  return db.get<ClappLearningCatalogRow>(owner, "clapp-learning", id);
}

/** The owner's learning report rows, most recently updated first. */
export async function listLearningReports(
  db: Store,
  owner: string,
): Promise<ClappLearningCatalogRow[]> {
  return db.list<ClappLearningCatalogRow>(owner, "clapp-learning");
}

/** One export-evidence row, or `null` when the owner has no such row. */
export async function getExportEvidence(
  db: Store,
  owner: string,
  id: string,
): Promise<ClappExportEvidenceRow | null> {
  return db.get<ClappExportEvidenceRow>(owner, "clapp-export-evidence", id);
}

/** The owner's export-evidence rows, most recently updated first. */
export async function listExportEvidence(
  db: Store,
  owner: string,
): Promise<ClappExportEvidenceRow[]> {
  return db.list<ClappExportEvidenceRow>(owner, "clapp-export-evidence");
}
