import type { BehavioralIr, EvidenceBundle, ReconstructionSpec } from "@clapp/contracts";

export interface BehavioralModeler {
  build(spec: ReconstructionSpec, evidence: EvidenceBundle): Promise<BehavioralIr>;
}

export interface PackageRetriever {
  retrieve(input: { model: BehavioralIr; targetStack: string }): Promise<string[]>;
}

export function createIntelligenceEngine() {
  return {
    model(_spec: ReconstructionSpec, _evidence: EvidenceBundle): Promise<BehavioralIr> {
      throw new Error(
        "Behavioral modeler not implemented yet; see docs/clapp/IMPLEMENTATION_PLAN.md",
      );
    },
  };
}

export type { IrDiffFinding } from "./diff.ts";
export { diffBehavioralIr } from "./diff.ts";
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
