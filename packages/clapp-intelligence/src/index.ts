import type { BehavioralIr, EvidenceBundle, ReconstructionSpec } from "@clapp/contracts";
import type { ArchetypeClassificationInput, ArchetypeVerdict } from "./archetype.ts";
import { classifyFromIr } from "./archetype.ts";
import type { ExplorationInput, ExplorationResult } from "./explore.ts";
import { explore } from "./explore.ts";
import { extractBehavioralIr } from "./extract.ts";

export interface BehavioralModeler {
  build(spec: ReconstructionSpec, evidence: EvidenceBundle): Promise<BehavioralIr>;
}

export interface PackageRetriever {
  retrieve(input: { model: BehavioralIr; targetStack: string }): Promise<string[]>;
}

/**
 * The CLAPP intelligence engine. model() extracts the BehavioralIr from an
 * observation bundle (CLAPP-W2-002); explore() deepens an IR's journeys
 * deterministically from its screens/evidence (CLAPP-W2-003); classify()
 * maps the IR plus its exploration result onto the Phase 7 archetype
 * vocabulary with evidence-cited confidence (CLAPP-W2-004); the remaining
 * engine capabilities are filled in by later work items.
 */
export function createIntelligenceEngine() {
  return {
    model(spec: ReconstructionSpec, evidence: EvidenceBundle): Promise<BehavioralIr> {
      return Promise.resolve(extractBehavioralIr({ bundle: evidence, spec }));
    },
    explore(input: ExplorationInput): ExplorationResult {
      return explore(input);
    },
    classify(input: ArchetypeClassificationInput): ArchetypeVerdict {
      return classifyFromIr(input);
    },
  };
}

// CLAPP-W2-002 — evidence-to-IR extraction.

export type { IrDiffFinding } from "./diff.ts";
export { diffBehavioralIr } from "./diff.ts";
export type { EvidenceCoverageEntry, ExtractionInput } from "./extract.ts";
export { evidenceCoverage, extractBehavioralIr } from "./extract.ts";
export type { DeserializedBehavioralIr } from "./serialize.ts";
export { deserializeBehavioralIr, serializeBehavioralIr } from "./serialize.ts";
export type { BehavioralIrValidationResult } from "./validate.ts";
export { validateBehavioralIr } from "./validate.ts";

// CLAPP-W2-003 — deterministic exploration and journey model.

export type {
  DeferredLink,
  ExplorationAssumption,
  ExplorationBudget,
  ExplorationInput,
  ExplorationResult,
  ExplorationStats,
  JourneyCoverage,
} from "./explore.ts";
export { composeExploredIr, explore, journeyDiffCoverage } from "./explore.ts";

// CLAPP-W2-004 — archetype classifier.

export type {
  ArchetypeClassificationInput,
  ArchetypeDefinition,
  ArchetypeFeatures,
  ArchetypeLabel,
  ArchetypeScore,
  ArchetypeVerdict,
  EvidenceKindCount,
} from "./archetype.ts";
export {
  ARCHETYPES,
  classifyArchetype,
  classifyFromIr,
  extractArchetypeFeatures,
} from "./archetype.ts";

// CLAPP-W2-005 — package schema, registry and versioning.

export type {
  PackageConflictDetails,
  PackageConflictKind,
  PackageImmutabilityDetails,
  PackageImmutabilityReason,
  PackageNotFoundDetails,
} from "./package-error.ts";
export {
  PackageConflictError,
  PackageImmutabilityError,
  PackageNotFoundError,
  PackageValidationError,
} from "./package-error.ts";
export type { PackageIdentity } from "./package-identity.ts";
export { canonicalPackageJson, packageIdentity } from "./package-identity.ts";
export type { PackageRegistrationResult } from "./package-registry.ts";
export {
  createPackageRegistry,
  type PackageListFilter,
  type PackageRegistry,
  type PromotionEvidence,
} from "./package-registry.ts";
export type { PackageDocumentValidationResult } from "./package-schema.ts";
export { validatePackageDocument } from "./package-schema.ts";
export type {
  PackageStatus,
  PackageStore,
  PackageStoreKey,
  PackageStoreRecord,
} from "./package-store.ts";
export type { ParsedPackageVersion } from "./package-version.ts";
export {
  comparePackageVersions,
  isConformingVersion,
  normalizePackageVersion,
  parsePackageVersion,
} from "./package-version.ts";

// CLAPP-W2-006 — package extraction and promotion.

export type {
  ArchetypeHint,
  CandidateRegistration,
  ExtractionResult,
  ExtractionSummary,
  PackageCandidateBody,
  PackageCandidateDocument,
  ParityEvidence,
  ParitySummary,
  ParityVerdict,
  PlanApiEntry,
  PlanComponentEntry,
  PlanInventory,
  PromotionOutcome,
  ReconstructionArtifacts,
  RegistrationOutcome,
  SkippedExtraction,
} from "./extract-package.ts";
export {
  extractionSummary,
  extractPackageCandidates,
  GENERIC_PACKAGE_CATEGORY,
  promoteVerified,
  registerCandidates,
} from "./extract-package.ts";
