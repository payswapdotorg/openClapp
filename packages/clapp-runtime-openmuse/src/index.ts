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
 */

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
export {
  ClappHandleNotProvidedError,
  ClappNotConfiguredError,
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
export type { OpenMuseRuntime, OpenMuseRuntimeDependencies } from "./runtime.ts";
export { candidateSeamOf, createOpenMuseRuntime } from "./runtime.ts";
