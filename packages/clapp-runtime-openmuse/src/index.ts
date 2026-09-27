import type {
  ApprovalProvider,
  ArtifactProvider,
  ExecutionProvider,
  ObservationProvider,
  TaskProvider,
  WorkspaceProvider,
} from "@clapp/contracts";

export interface OpenMuseRuntime {
  observation: ObservationProvider;
  execution: ExecutionProvider;
  artifacts: ArtifactProvider;
  tasks: TaskProvider;
  approvals: ApprovalProvider;
  workspaces: WorkspaceProvider;
}

/**
 * Adapter factory implemented in the OpenMuse integration layer.
 * Kept framework-free so CLAPP core never imports OpenMuse server classes.
 */
export interface OpenMuseRuntimeDependencies {
  browserSession: unknown;
  computer: unknown;
  files: unknown;
  agent: unknown;
  db: unknown;
}

export function createOpenMuseRuntime(_deps: OpenMuseRuntimeDependencies): OpenMuseRuntime {
  throw new Error("CLAPP runtime adapter not implemented yet; see docs/clapp/IMPLEMENTATION_PLAN.md");
}
