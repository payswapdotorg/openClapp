import type {
  BehavioralIr,
  DiffReport,
  ReconstructionSpec,
  RepairDirective,
  SynthesisPlan,
} from "@clapp/contracts";
import { planSynthesisApp } from "./plan.ts";

export { validateGeneratedApp } from "./app-validate.ts";
export type {
  GeneratedApp,
  GeneratedAppManifest,
  GeneratedFile,
} from "./generator.ts";
export {
  CANDIDATE_BUILD_COMMAND,
  CANDIDATE_ENTRYPOINT,
  CANDIDATE_TEST_COMMAND,
  generateCandidateApp,
} from "./generator.ts";
export type {
  CandidateBuildOutcomeShape,
  CandidateBuildStepShape,
  CandidateNetworkMode,
  CandidateSeam,
  CandidateSeedResultShape,
  Materialization,
  MaterializeCandidateInput,
} from "./materialize.ts";
export {
  DEFAULT_CANDIDATE_TIMEOUT_MS,
  materializeCandidate,
  runGeneratedCandidateBuild,
} from "./materialize.ts";
export type {
  PairedApiCapture,
  PairedApiCheck,
  PairedArtifact,
  PairedDimensions,
  PairedJourney,
  PairedJourneySummary,
  PairedNetworkCapture,
  PairedNetworkHeader,
  PairedPageCapture,
  PairedRunEnvelope,
  PairedSide,
  PairedSideCapture,
  PairedSideLabel,
  PairedStateCapture,
  PairedSuiteResult,
  PairedTransport,
  PairedVerdict,
  PairedVisualCapture,
  PairedVisualControl,
  PairedVisualHeading,
  PairedVisualImage,
  PairedVisualLink,
  RunPairedJourneyInput,
  RunPairedSuiteInput,
  StartedPairedSide,
} from "./paired.ts";
export {
  bindPairedSide,
  PairedSideError,
  runPairedJourney,
  runPairedSuite,
  serializePairedReport,
  serializePairedRun,
  serializePairedSuite,
} from "./paired.ts";
export { compareSidesSemantically, sortFindings } from "./paired-compare.ts";
export {
  compareSides,
  compareSidesNetwork,
  compareSidesVisually,
  dimensionArtifactsOf,
  extractVisualInventory,
  NETWORK_HEADER_ALLOWLIST,
  networkArtifact,
  networkCaptureOf,
  normalizeDimensions,
  visualArtifact,
} from "./paired-diff.ts";
export type {
  DerivedAssumption,
  PlanComponent,
  PlanKeyedEntry,
  PlanRoute,
} from "./plan.ts";
export { planSynthesisApp } from "./plan.ts";
export type { DeserializeResult } from "./serialize.ts";
export { deserializeSynthesisPlan, serializeSynthesisPlan } from "./serialize.ts";
export type { ValidationResult } from "./validate.ts";
export { validateSynthesisPlan } from "./validate.ts";

/** Synthesizes a framework-neutral plan, then materializes a candidate workspace. */
export interface Synthesizer {
  plan(spec: ReconstructionSpec, model: BehavioralIr, packageIds: string[]): Promise<SynthesisPlan>;
  generate(plan: SynthesisPlan): Promise<{ workspaceId: string; artifactIds: string[] }>;
}

/** Compares reference and candidate runs into a DiffReport. */
export interface Verifier {
  compare(input: {
    spec: ReconstructionSpec;
    plan: SynthesisPlan;
    referenceWorkspaceId: string;
    candidateWorkspaceId: string;
  }): Promise<DiffReport>;
}

/** Applies bounded, evidence-driven repair directives to a candidate workspace. */
export interface Repairer {
  repair(input: {
    report: DiffReport;
    workspaceId: string;
    directives: RepairDirective[];
  }): Promise<{ converged: boolean; artifactIds: string[] }>;
}

/**
 * Composition entry point. `plan` performs the deterministic SynthesisPlan
 * derivation implemented by this package; generation, verification and repair
 * arrive with the later W3 work items.
 */
export function createSynthesisEngine() {
  return {
    plan: planSynthesisApp,
  };
}

// ---------------------------------------------------------------------------
// CLAPP-W3-006 additive block: bounded autonomous repair
// ---------------------------------------------------------------------------

export type {
  RepairAbstention,
  RepairAction,
  RepairIterationRecord,
  RepairMutation,
  RepairMutationClass,
  RepairMutationTarget,
  RepairReplacement,
  RepairReport,
  RepairStopReason,
  RepairSummary,
  RunRepairLoopInput,
} from "./repair.ts";
export {
  applyRepairActions,
  classifyRepairActions,
  runRepairLoop,
  serializeRepairReport,
  summarizeRepair,
} from "./repair.ts";

// ---------------------------------------------------------------------------
// CLAPP-W3-003 additive block: honest suite coverage digest
// ---------------------------------------------------------------------------

export type { JourneyCoverage, SuiteCoverageDigest } from "./coverage.ts";
export {
  ACCEPTANCE_JOURNEY_TEST_PREFIX,
  digestSuiteCoverage,
  INDEX_ROUTE_TEST_NAME,
  ROUTE_COVERAGE_TEST_PREFIX,
  SUITE_FILE_NAME,
} from "./coverage.ts";
