import type {
  BehavioralIr,
  DiffReport,
  ReconstructionSpec,
  RepairDirective,
  SynthesisPlan,
} from "@clapp/contracts";

export interface Synthesizer {
  plan(spec:ReconstructionSpec, model:BehavioralIr, packageIds:string[]):Promise<SynthesisPlan>;
  generate(plan:SynthesisPlan):Promise<{workspaceId:string;artifactIds:string[]}>;
}

export interface Verifier {
  compare(input:{spec:ReconstructionSpec;plan:SynthesisPlan;referenceWorkspaceId:string;candidateWorkspaceId:string}):Promise<DiffReport>;
}

export interface Repairer {
  repair(input:{report:DiffReport;workspaceId:string;directives:RepairDirective[]}):Promise<{converged:boolean;artifactIds:string[]}>;
}

export function createSynthesisEngine() {
  return {
    plan(_spec:ReconstructionSpec, _model:BehavioralIr, _packageIds:string[]):Promise<SynthesisPlan> {
      throw new Error("Synthesis planner not implemented yet; see docs/clapp/IMPLEMENTATION_PLAN.md");
    },
  };
}
