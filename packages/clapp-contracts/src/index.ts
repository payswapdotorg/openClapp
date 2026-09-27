export type ClappStage =
  | "authorization"
  | "capture"
  | "explore"
  | "model"
  | "plan"
  | "synthesize"
  | "verify"
  | "repair"
  | "review"
  | "promote";

export type ClappStageStatus =
  | "pending"
  | "running"
  | "waiting_input"
  | "waiting_approval"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "skipped";

export type EvidenceClassification =
  | "observed"
  | "derived"
  | "inferred"
  | "assumed"
  | "unavailable";

export type ClappPlatform = "web" | "android" | "linux" | "windows" | "macos" | "ios";

export interface TargetAuthorization {
  ownerId: string;
  targetId: string;
  scope: string[];
  environments: string[];
  expiresAt?: string;
  retention: "ephemeral" | "project" | "library";
  benchmarkOwned: boolean;
  createdAt: string;
}

export interface ReconstructionSpec {
  specVersion: string;
  reconstructionId: string;
  targetId: string;
  name: string;
  platform: ClappPlatform;
  entrypoints: string[];
  authorization: TargetAuthorization;
  exploration: { maxStages: number; maxActions: number; maxDurationMs: number; seed: number };
  synthesis: {
    targetStack: string;
    allowNetwork: boolean;
    packagePolicy: "verified-only" | "verified-and-candidates";
  };
  verification: {
    journeys: string[];
    visual: boolean;
    network: boolean;
    state: boolean;
    maxRepairIterations: number;
  };
}

export interface ClappTaskInput {
  specVersion: string;
  reconstructionId: string;
  stage: ClappStage;
}

export interface StageRecord {
  id: string;
  reconstructionId: string;
  stage: ClappStage;
  status: ClappStageStatus;
  startedAt?: string;
  finishedAt?: string;
  inputArtifactIds: string[];
  outputArtifactIds: string[];
  error?: string;
}

export interface EvidenceRef {
  id: string;
  targetId: string;
  reconstructionId: string;
  kind: string;
  sha256: string;
  source: string;
  capturedAt: string;
  classification: EvidenceClassification;
  redacted: boolean;
}

export interface EvidenceBundle {
  id: string;
  targetId: string;
  reconstructionId: string;
  environment: Record<string, unknown>;
  refs: EvidenceRef[];
  rootSha256: string;
}

export interface JourneyStep {
  id: string;
  action: string;
  target?: string;
  input?: Record<string, unknown>;
  assertions?: Record<string, unknown>;
}

export interface Journey {
  id: string;
  name: string;
  preconditions: string[];
  steps: JourneyStep[];
}

export interface BehavioralIr {
  schemaVersion: string;
  application: { id: string; name: string; platform: ClappPlatform; entrypoints: string[] };
  evidence: EvidenceRef[];
  journeys: Journey[];
  screens: Record<string, unknown>[];
  components: Record<string, unknown>[];
  state: Record<string, unknown>;
  data: Record<string, unknown>;
  api: Record<string, unknown>;
  integrations: Record<string, unknown>[];
  assumptions: Record<string, unknown>[];
  constraints: Record<string, unknown>[];
}

export interface SynthesisPlan {
  schemaVersion: string;
  architecture: Record<string, unknown>;
  routes: Record<string, unknown>[];
  components: Record<string, unknown>[];
  state: Record<string, unknown>;
  persistence: Record<string, unknown>[];
  integrations: Record<string, unknown>[];
  api: Record<string, unknown>[];
  packageIds: string[];
  acceptanceJourneyIds: string[];
  assumptions: Record<string, unknown>[];
}

export type DiffDimension =
  | "semantic"
  | "visual"
  | "network"
  | "state"
  | "storage"
  | "performance"
  | "integration";

export type DiffSeverity = "info" | "minor" | "major" | "critical";

export interface DiffFinding {
  id: string;
  dimension: DiffDimension;
  severity: DiffSeverity;
  anchor: string;
  expected?: unknown;
  actual?: unknown;
  evidenceRefs: string[];
  repairability: "automatic" | "assisted" | "manual" | "unrepairable";
}

export interface DiffReport {
  id: string;
  reconstructionId: string;
  referenceRunId: string;
  candidateRunId: string;
  findings: DiffFinding[];
  verdict: "equivalent" | "divergent" | "blocked";
}

export interface RepairDirective {
  id: string;
  findingIds: string[];
  candidateScope: string[];
  strategy: string;
  maxIterations: number;
  preconditions: string[];
}

export interface ClappPackage {
  schemaVersion: string;
  id: string;
  version: string;
  category: string;
  purpose: string;
  interface: Record<string, unknown>;
  capabilities: string[];
  constraints: string[];
  dependencies: string[];
  supportedTargets: string[];
  tests: string[];
  benchmark: Record<string, unknown>;
  failureModes: Record<string, unknown>[];
  provenance: Record<string, unknown>;
}

export interface ObservationProvider {
  observe(spec: ReconstructionSpec, signal?: AbortSignal): Promise<EvidenceBundle>;
}

export interface ExecutionProvider {
  run(
    input: {
      reconstructionId: string;
      cwd: string;
      command: string;
      timeoutMs: number;
      network: "deny" | "allowlist" | "full";
    },
    signal?: AbortSignal,
  ): Promise<{ exitCode: number; stdout: string; stderr: string; artifacts: string[] }>;
}

export interface ArtifactProvider {
  put(input: {
    reconstructionId: string;
    kind: string;
    bytes: Uint8Array;
    metadata: Record<string, string>;
  }): Promise<EvidenceRef>;
  get(id: string): Promise<Uint8Array>;
}

export interface TaskProvider {
  checkpoint(reconstructionId: string, patch: Record<string, unknown>): Promise<void>;
  event(reconstructionId: string, stage: ClappStage, title: string, detail?: string): Promise<void>;
}

export interface ApprovalProvider {
  request(input: {
    reconstructionId: string;
    kind: string;
    summary: string;
    expiresAt?: string;
  }): Promise<{ id: string }>;
}

export interface WorkspaceProvider {
  create(input: {
    reconstructionId: string;
    kind: "reference" | "candidate";
  }): Promise<{ id: string; path: string }>;
  destroy(id: string): Promise<void>;
}

export const CLAPP_CONTRACT_VERSION = "0.1";
