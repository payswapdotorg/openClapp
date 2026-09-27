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
