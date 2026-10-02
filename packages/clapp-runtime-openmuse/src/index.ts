/**
 * @clapp/runtime-openmuse — durable OpenMuse runtime adapter for CLAPP.
 *
 * Binds the five inherited OpenMuse handles (browserSession, computer,
 * files, agent, db) onto the six frozen @clapp/contracts providers through
 * narrow structural interfaces declared in this package, and produces a
 * TaskHandler-compatible CLAPP task handler that makes a CLAPP
 * reconstruction stage a durable OpenMuse task with checkpointed
 * StageRecords, closed-union RunEvents, signal-honoring cancellation and
 * count-free idempotence across restarts.
 *
 * W1-003 extends the adapter with the candidate workspace execution seam:
 * passing the optional `CandidateExecutionOptions` to `createOpenMuseRuntime`
 * upgrades the execution and workspaces providers to the real ComputerService
 * candidate semantics (deterministic idempotency keys, honest truncation
 * surfacing, deterministic workspace scheme with tombstones and stage-state
 * registration) and wires the candidate-build orchestration methods —
 * chunked workspace seeding, bounded listing, restart-safe discovery,
 * build/test composition and produced-artifact harvesting.
 *
 * W1-004 adds the run artifact/recovery semantics: the run-level view is
 * derived from the task chain of one reconstruction (readClappRunState), the
 * restart planner (resumeAfterRestart), the run's artifact manifest
 * (runArtifactLedger) and the stage-chain orchestrator
 * (createStageChainHandler) that composes the W1-001 handler across the ten
 * stages with a successor hint — while standardizing the W1 vocabulary
 * (CLAPP_STAGE_STATE_KEY, CLAPP_EVENT_TITLES) as exported contracts.
 */

// CLAPP-W1-011 — audit/retention enforcement: the tamper-evident
// content-addressed audit chain for the four SECURITY.md event kinds
// (authorization, observation, repair, promotion), per-record retention
// derived structurally from the W1-008 authorization record, read-side
// expiry exclusion with provable prior inclusion, over the narrow AuditStore
// port (docs/clapp/SECURITY.md, Authorization).
export type {
  AuditAppendOptions,
  AuditAuthorizationRecord,
  AuditChainOptions,
  AuditEntry,
  AuditInclusionProof,
  AuditReadOptions,
  AuditRetention,
  AuditRetentionClass,
  AuditRetentionPolicy,
  AuditStore,
  AuditVerification,
  ClappAuditEvent,
  ClappAuditKind,
  ClappAuditReason,
} from "./audit.ts";
export {
  AUDIT_ENTRY_ID_PREFIX,
  appendAuditEvent,
  ClappAuditError,
  deriveAuditRetention,
  proveInclusion,
  readAuditLog,
  verifyAuditChain,
} from "./audit.ts";
export type {
  CandidateBuildHarvest,
  CandidateBuildInput,
  CandidateBuildOutcome,
  CandidateBuildStepResult,
  CandidateDiscoverInput,
  CandidateExecutionOptions,
  CandidateExecutionProvider,
  CandidateHarvestFailure,
  CandidateHarvestInput,
  CandidateHarvestOutcome,
  CandidateSeedFileInput,
  CandidateSeedResult,
  CandidateWorkspaceFile,
  CandidateWorkspaceFilesInput,
  CandidateWorkspaceProvider,
  CandidateWorkspaceSummary,
} from "./candidate.ts";
export {
  DEFAULT_CANDIDATE_CHUNK_BYTES,
  DEFAULT_CANDIDATE_LIST_ENTRIES,
  DEFAULT_CANDIDATE_SEED_BYTES,
  SUBSTRATE_COMMAND_LIMIT_CHARS,
  SUBSTRATE_FILE_LIMIT_BYTES,
} from "./candidate.ts";
// CLAPP-W1-010 — isolation/egress controls for candidate execution: the
// egress destination vocabulary, the authorization-record-derived allow-list,
// the egress policy and the egress-enforcing execution provider composed over
// the W1-003 execution seam (docs/clapp/SECURITY.md, Network).
export type {
  ClappEgressReason,
  EgressAuthorizationRecord,
  EgressCheckResult,
  EgressDerivationInput,
  EgressEnforcementLog,
  EgressEnforcementRecord,
  EgressEnforcingExecutionProvider,
  EgressEnforcingOptions,
  EgressExecutionInput,
  EgressExecutionResult,
  EgressPolicy,
} from "./egress.ts";
export {
  ClappEgressError,
  createEgressEnforcingExecutionProvider,
  createEgressPolicy,
  deriveEgressAllowList,
  normalizeEgressDestination,
} from "./egress.ts";
export {
  ClappHandleNotProvidedError,
  ClappNotConfiguredError,
  ClappRunStateError,
  ClappRuntimeError,
} from "./errors.ts";
export type {
  ClappAgentTaskLike,
  ClappEvidenceLike,
  ClappFallbackHandler,
  ClappRunEventKind,
  ClappTaskContext,
  ClappTaskHandler,
  ClappTaskHandlerOptions,
  ClappTaskSnapshot,
  ClappTaskStepLike,
  StageExecutor,
  StageExecutorResult,
} from "./handler.ts";
export {
  CLAPP_EVENT_TITLES,
  CLAPP_STAGE_STATE_KEY,
  CLAPP_STAGES,
  createClappTaskHandler,
  detectClappTaskInput,
} from "./handler.ts";
export type {
  BoundHandles,
  ClappAgentHandle,
  ClappBrowserPage,
  ClappBrowserSessionHandle,
  ClappComputerDirectory,
  ClappComputerHandle,
  ClappComputerReceipt,
  ClappDbHandle,
  ClappFilesHandle,
} from "./handles.ts";
export type {
  ClappRestartPlan,
  ClappRunStageState,
  ClappRunState,
  ClappRunStatus,
  ClappStageArtifacts,
  StageChainHandler,
  StageChainHandlerOptions,
} from "./run.ts";
export {
  createStageChainHandler,
  readClappRunState,
  resumeAfterRestart,
  runArtifactLedger,
} from "./run.ts";
export type { OpenMuseRuntime, OpenMuseRuntimeDependencies } from "./runtime.ts";
export { candidateSeamOf, createOpenMuseRuntime } from "./runtime.ts";
