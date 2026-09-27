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
 */
export { ClappHandleNotProvidedError, ClappRuntimeError } from "./errors.ts";
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
  ClappComputerHandle,
  ClappComputerReceipt,
  ClappDbHandle,
  ClappFilesHandle,
} from "./handles.ts";
export type { OpenMuseRuntime, OpenMuseRuntimeDependencies } from "./runtime.ts";
export { createOpenMuseRuntime } from "./runtime.ts";
