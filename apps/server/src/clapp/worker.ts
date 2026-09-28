import { PDFDocument } from "pdf-lib";
import type {
  ClappStage,
  ReconstructionSpec,
} from "../../../../packages/clapp-contracts/src/index.ts";
import {
  CLAPP_STAGES,
  type ClappTaskSnapshot,
  createStageChainHandler,
  type OpenMuseRuntime,
  type StageChainHandler,
  type StageExecutor,
} from "../../../../packages/clapp-runtime-openmuse/src/index.ts";
import type { AgentTask } from "../../../../packages/domain/src/agent.ts";
import type { Store } from "../db.ts";
import type { TaskHandler, TaskWorker } from "../engine/worker.ts";

/**
 * CLAPP-W1-007 — the server's CLAPP task-handler wiring.
 *
 * The wrapped handler is the substrate worker's single execution seam: tasks
 * whose input carries a CLAPP payload (detected by input shape only — never a
 * new task kind) execute their stage through the W1-001 handler composed by
 * W1-004's stage chain; every other task flows to the substrate's existing
 * handler unchanged, so non-CLAPP behavior is preserved byte-for-byte.
 *
 * The wrapper is installed over the substrate `TaskWorker`'s handler slot via a
 * narrow structural seam: the worker's constructor takes the handler as a
 * private parameter property, and the substrate (frozen at this base) exposes
 * no public setter. The seam is validated at install time and fails closed if
 * the engine's shape ever changes — the same duck-typing idiom the runtime
 * adapter uses for the five service handles.
 */

/** Dependencies for building the wrapped CLAPP task handler. */
export interface ClappWorkerHandlerDeps {
  /** The substrate store; `readTasks` is derived from its cross-owner scan. */
  db: Store;
  /** The runtime with the real bound services (browser, computer, files, agent, db). */
  runtime: OpenMuseRuntime;
  /**
   * The stage executor the tech lead wires to real stage implementations in
   * later waves; this wave uses {@link createSkeletonStageExecutor}.
   */
  executor: StageExecutor;
  /**
   * The substrate's existing task handler — the wrapper's fallback, so
   * non-CLAPP tasks run through the exact substrate semantics.
   */
  fallback: TaskHandler;
  /**
   * The ordered stage chain this run walks. Defaults to the ten frozen
   * CLAPP stages in order; the CLAPP service plans successors over the same
   * default, so a custom chain here must be mirrored there.
   */
  stages?: readonly ClappStage[];
}

/**
 * The wiring type app.ts composes: the wrapped task handler. It is a full
 * `StageChainHandler` — structurally a substrate `TaskHandler`, plus the
 * deterministic successor planner (`planNextTask`) the control plane can use.
 */
export type ClappWorkerHandler = StageChainHandler;

/**
 * The cross-owner task-chain reader for one reconstruction, exactly the
 * W1-001 shape: the abort path uses it to verify durable owner intent
 * (paused/cancelled) before writing a cancelled stage record, and the runtime
 * providers use the same scan for owner discovery.
 */
export function createClappReadTasks(db: Store) {
  return async (reconstructionId: string): Promise<ClappTaskSnapshot[]> =>
    (await db.scan<AgentTask>("tasks"))
      .filter(
        ({ value }) =>
          (value.input as Record<string, unknown> | undefined)?.reconstructionId ===
          reconstructionId,
      )
      .map(({ owner, value }) => ({ owner, task: value as ClappTaskSnapshot["task"] }));
}

/**
 * Creates the wrapped task handler: the W1-004 stage chain (which composes the
 * W1-001 `createClappTaskHandler` — checkpointed stage records, closed-union
 * events, signal-honoring cancellation, count-free idempotence) with the real
 * runtime, the injected stage executor, `readTasks` derived from the store
 * scan, and the substrate's existing handler as the fallback for non-CLAPP
 * tasks.
 */
export function createClappWorkerHandler(deps: ClappWorkerHandlerDeps): ClappWorkerHandler {
  return createStageChainHandler({
    executor: deps.executor,
    fallback: deps.fallback,
    runtime: deps.runtime,
    readTasks: createClappReadTasks(deps.db),
    ...(deps.stages !== undefined ? { stages: deps.stages } : {}),
  });
}

// ---------------------------------------------------------------------------
// The substrate worker seam
// ---------------------------------------------------------------------------

/**
 * The structural view of the substrate `TaskWorker`'s handler slot. The field
 * is private in the engine's type (the substrate is frozen and exposes no
 * setter), but it is an own instance property at runtime; the CLAPP wiring
 * reaches it through this narrow, install-time-validated view — the same
 * duck-typed idiom the runtime adapter sanctions for the five service handles.
 */
interface TaskWorkerHandlerSlot {
  execute: TaskHandler;
}

const handlerSlotOf = (worker: TaskWorker): TaskWorkerHandlerSlot => {
  const slot = worker as unknown as Partial<TaskWorkerHandlerSlot>;
  if (typeof slot.execute !== "function")
    throw new Error(
      "the substrate TaskWorker exposes no callable task handler; the CLAPP wrapper cannot wrap the execution seam (the wiring expects the engine shape at base c2358ac)",
    );
  return slot as TaskWorkerHandlerSlot;
};

/**
 * Reads the substrate worker's current task handler — the exact closure the
 * engine installed at construction. The wrapped handler's fallback receives
 * it, so non-CLAPP tasks keep the substrate's behavior unchanged.
 */
export function extractSubstrateWorkerHandler(worker: TaskWorker): TaskHandler {
  return handlerSlotOf(worker).execute;
}

/**
 * Installs the wrapped handler over the substrate worker's execution seam.
 * The substrate's lease, heartbeat, abort and settled-callback machinery are
 * untouched — only the handler the worker invokes changes, and its fallback
 * is the handler that was there before.
 */
export function installClappWorkerHandler(worker: TaskWorker, wrapped: TaskHandler): void {
  handlerSlotOf(worker).execute = wrapped;
}

// ---------------------------------------------------------------------------
// The durable skeleton stage executor
// ---------------------------------------------------------------------------

/** Dependencies for the skeleton stage executor. */
export interface SkeletonStageExecutorDeps {
  /**
   * Reads the frozen spec of a reconstruction (cross-owner discovery by id).
   * The skeleton records its output artifact against the spec's honest
   * `targetId` — it refuses to guess one.
   */
  readSpec: (reconstructionId: string) => Promise<ReconstructionSpec | null>;
}

/**
 * The durable skeleton driver this wave ships: one invocation records exactly
 * one stage output artifact through the runtime's artifact provider (real,
 * content-addressed, PDF bytes naming the reconstruction and stage — the
 * substrate files store is a PDF store in v0.1) and succeeds. Real
 * capture/model/synthesize executors arrive in later waves; this one proves
 * the durable path end-to-end exactly as W1-001 proved the skeleton.
 *
 * The recorded artifact is deterministic per (reconstructionId, stage), so a
 * re-execution after a lost lease re-puts identical bytes and the
 * content-addressed id stays stable. The returned bundle exposes the
 * invocation count for exact no-duplicate verification.
 */
export function createSkeletonStageExecutor(deps: SkeletonStageExecutorDeps): {
  executor: StageExecutor;
  invocations: () => number;
} {
  let count = 0;
  const executor: StageExecutor = {
    async execute(input, providers) {
      count += 1;
      const spec = await deps.readSpec(input.reconstructionId);
      if (!spec)
        return {
          outputArtifactIds: [],
          error: `the skeleton executor found no reconstruction record for "${input.reconstructionId}"; refusing to guess the artifact target`,
        };
      if (!providers)
        return {
          outputArtifactIds: [],
          error:
            "the skeleton executor was invoked without the runtime's providers; the artifact cannot be recorded",
        };
      const document = await PDFDocument.create();
      document.addPage();
      document.setTitle(`CLAPP skeleton stage output — ${input.reconstructionId} — ${input.stage}`);
      const bytes = new Uint8Array(await document.save());
      const reference = await providers.artifacts.put({
        reconstructionId: input.reconstructionId,
        kind: "stage-output",
        bytes,
        metadata: {
          targetId: spec.targetId,
          classification: "derived",
          source: "clapp:skeleton",
        },
      });
      return { outputArtifactIds: [reference.id] };
    },
  };
  return { executor, invocations: () => count };
}

/** The frozen stage chain this server plans and walks (the W1-004 default). */
export const CLAPP_SERVER_STAGES: readonly ClappStage[] = CLAPP_STAGES;
