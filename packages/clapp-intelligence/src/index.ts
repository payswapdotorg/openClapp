import type { BehavioralIr, EvidenceBundle, ReconstructionSpec } from "@clapp/contracts";
import { extractBehavioralIr } from "./extract.ts";

export interface BehavioralModeler {
  build(spec: ReconstructionSpec, evidence: EvidenceBundle): Promise<BehavioralIr>;
}

export interface PackageRetriever {
  retrieve(input: { model: BehavioralIr; targetStack: string }): Promise<string[]>;
}

/**
 * The CLAPP intelligence engine. model() extracts the BehavioralIr from an
 * observation bundle (CLAPP-W2-002); the remaining engine capabilities are
 * filled in by later work items.
 */
export function createIntelligenceEngine() {
  return {
    model(spec: ReconstructionSpec, evidence: EvidenceBundle): Promise<BehavioralIr> {
      return Promise.resolve(extractBehavioralIr({ bundle: evidence, spec }));
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
