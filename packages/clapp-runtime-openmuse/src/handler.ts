import type { ClappStage, ClappTaskInput, StageRecord } from "@clapp/contracts";
import { ClappRuntimeError, describeError } from "./errors.ts";
import type { OpenMuseRuntime } from "./runtime.ts";

/** The ten CLAPP reconstruction stages, mirroring the frozen contract. */
export const CLAPP_STAGES: readonly ClappStage[] = [
  "authorization",
  "capture",
  "explore",
  "model",
  "plan",
  "synthesize",
  "verify",
  "repair",
  "review",
  "promote",
];

/**
 * The task.state key under which a CLAPP stage's StageRecord is checkpointed.
 * The W1-001 convention, standardized by W1-004 as the documented run-semantics
 * contract: the record is stage-scoped — it belongs to the task whose
 * ClappTaskInput.stage equals the record's own stage.
 */
export const CLAPP_STAGE_STATE_KEY = "clappStage";

/**
 * The closed CLAPP RunEvent title vocabulary. Every stage transition the
 * handler records uses exactly these templates, so consumers can match titles
 * without pattern-guessing. The strings are byte-identical to the W1-001
 * convention (W1-004 standardizes them as the exported contract).
 */
export const CLAPP_EVENT_TITLES = {
  started: (stage: ClappStage): string => `CLAPP stage ${stage} started`,
  succeeded: (stage: ClappStage): string => `CLAPP stage ${stage} succeeded`,
  failed: (stage: ClappStage): string => `CLAPP stage ${stage} failed`,
  cancelled: (stage: ClappStage): string => `CLAPP stage ${stage} cancelled`,
  reconciled: (stage: ClappStage): string => `CLAPP stage ${stage} reconciled`,
} as const;

/**
 * Structural mirror of the OpenMuse AgentTask shape. The literal unions match
 * the substrate exactly so a handler produced here is structurally assignable
 * to the substrate's TaskHandler without importing server modules.
 */
export interface ClappAgentTaskLike {
  id: string;
  title: string;
  prompt: string;
  kind: "agent" | "document" | "monitor" | "finance" | "plan";
  status:
    | "queued"
    | "running"
    | "waiting_approval"
    | "waiting_input"
    | "scheduled"
    | "paused"
    | "succeeded"
    | "failed"
    | "cancelled";
  goalId?: string;
  plan: ClappTaskStepLike[];
  evidence: ClappEvidenceLike[];
  input: Record<string, unknown>;
  state: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  nextRunAt?: string;
  leaseId?: string | null;
  leaseUntil?: string | null;
  attempts: number;
  actionId?: string | null;
  result?: string;
  error?: string | null;
  question?: string;
  artifactIds: string[];
}

export interface ClappTaskStepLike {
  id: string;
  title: string;
  status: "pending" | "running" | "succeeded" | "failed" | "waiting";
  detail?: string;
}

export interface ClappEvidenceLike {
  id: string;
  kind: "mail" | "file" | "web" | "user";
  title: string;
  excerpt: string;
  url?: string;
}

/** The closed RunEvent kind union of the substrate. */
export type ClappRunEventKind =
  | "plan"
  | "step"
  | "observation"
  | "approval"
  | "result"
  | "error"
  | "status";

/**
 * Structural mirror of the OpenMuse TaskContext the substrate hands a task
 * handler: an abort signal that fires on pause/cancel/lost-lease, a guard
 * that throws when the lease is lost, a lease-fenced checkpoint, and a
 * durable event sink.
 */
export interface ClappTaskContext {
  signal: AbortSignal;
  guard(): Promise<void>;
  checkpoint(patch: Partial<ClappAgentTaskLike>): Promise<ClappAgentTaskLike>;
  event(kind: ClappRunEventKind, title: string, detail?: string): Promise<void>;
}

/** Result of executing one CLAPP stage. */
export interface StageExecutorResult {
  outputArtifactIds: string[];
  error?: string;
}

/**
 * Executes a single CLAPP stage. Receives the validated ClappTaskInput, the
 * runtime providers (undefined when the handler was wired without a runtime),
 * and the substrate task context (signal, guard, checkpoint, event).
 */
export interface StageExecutor {
  execute(
    input: ClappTaskInput,
    providers: OpenMuseRuntime | undefined,
    context: ClappTaskContext,
  ): Promise<StageExecutorResult>;
}

/** A durable task snapshot used by the abort path to verify owner intent. */
export interface ClappTaskSnapshot {
  owner: string;
  task: ClappAgentTaskLike;
}

export type ClappFallbackHandler = (
  owner: string,
  task: ClappAgentTaskLike,
  context: ClappTaskContext,
) => Promise<Partial<ClappAgentTaskLike>>;

export type ClappTaskHandler = (
  owner: string,
  task: ClappAgentTaskLike,
  context: ClappTaskContext,
) => Promise<Partial<ClappAgentTaskLike>>;

export interface ClappTaskHandlerOptions {
  /** Executes the CLAPP stage for detected CLAPP tasks. */
  executor: StageExecutor;
  /** Receives every non-CLAPP task unchanged. */
  fallback: ClappFallbackHandler;
  /**
   * Runtime providers used for durable CLAPP-level writes when the
   * lease-fenced context paths are closed (the abort path) and handed to the
   * stage executor. Optional; without it the handler exits cleanly on abort
   * without recording the cancelled stage record.
   */
  runtime?: OpenMuseRuntime;
  /**
   * Reads the durable tasks carrying a reconstruction. Used by the abort path
   * to verify the owner-intent status (cancelled/paused) before writing the
   * cancelled stage record, so a stolen lease never corrupts the new
   * attempt. Optional; without it the abort path never writes.
   */
  readTasks?: (reconstructionId: string) => Promise<ClappTaskSnapshot[]>;
}

const STAGE_RECORD_KEY = CLAPP_STAGE_STATE_KEY;
const STAGE_STATUSES: readonly StageRecord["status"][] = [
  "pending",
  "running",
  "waiting_input",
  "waiting_approval",
  "succeeded",
  "failed",
  "cancelled",
  "skipped",
];

type Detection =
  | { type: "clapp"; input: ClappTaskInput }
  | { type: "non-clapp" }
  | { type: "invalid"; reasons: string[] };

/**
 * Detects a CLAPP task by input shape only — never by task kind. A task whose
 * input carries any of the three ClappTaskInput keys is a CLAPP candidate and
 * is validated strictly; half-shaped or mis-versioned input fails the task
 * instead of being guessed or silently delegated.
 */
export function detectClappTaskInput(input: Record<string, unknown>): Detection {
  const keys = ["specVersion", "reconstructionId", "stage"] as const;
  const present = keys.filter((key) => Object.hasOwn(input, key));
  if (present.length === 0) return { type: "non-clapp" };
  const reasons: string[] = [];
  if (input.specVersion !== "0.1")
    reasons.push(
      `specVersion must be "0.1" (the frozen CLAPP contract version); received ${JSON.stringify(input.specVersion)}`,
    );
  if (typeof input.reconstructionId !== "string" || input.reconstructionId.trim() === "")
    reasons.push("reconstructionId must be a non-empty string");
  if (typeof input.stage !== "string" || !CLAPP_STAGES.includes(input.stage as ClappStage))
    reasons.push(
      `stage must be one of ${CLAPP_STAGES.join(", ")}; received ${JSON.stringify(input.stage)}`,
    );
  if (reasons.length > 0) return { type: "invalid", reasons };
  return {
    type: "clapp",
    input: {
      specVersion: "0.1",
      reconstructionId: input.reconstructionId as string,
      stage: input.stage as ClappStage,
    },
  };
}

function readStageRecord(
  task: ClappAgentTaskLike,
  input: ClappTaskInput,
): { record?: StageRecord; error?: string } {
  const value = task.state[STAGE_RECORD_KEY];
  if (value === undefined || value === null) return {};
  if (typeof value !== "object")
    return {
      error: `task.state.${STAGE_RECORD_KEY} is not a stage record object; durable state is inconsistent`,
    };
  const record = value as Partial<StageRecord>;
  if (
    typeof record.reconstructionId !== "string" ||
    record.reconstructionId !== input.reconstructionId ||
    record.stage !== input.stage
  )
    return {
      error: `task.state.${STAGE_RECORD_KEY} belongs to reconstruction "${String(record.reconstructionId)}" stage "${String(record.stage)}" but the task input declares "${input.reconstructionId}" / "${input.stage}"; durable state is inconsistent`,
    };
  if (
    typeof record.status !== "string" ||
    !STAGE_STATUSES.includes(record.status as StageRecord["status"])
  )
    return {
      error: `task.state.${STAGE_RECORD_KEY}.status "${String(record.status)}" is not a ClappStageStatus; durable state is inconsistent`,
    };
  return {
    record: {
      id: typeof record.id === "string" ? record.id : `${input.reconstructionId}:${input.stage}`,
      reconstructionId: input.reconstructionId,
      stage: input.stage,
      status: record.status as StageRecord["status"],
      ...(record.startedAt !== undefined ? { startedAt: record.startedAt } : {}),
      ...(record.finishedAt !== undefined ? { finishedAt: record.finishedAt } : {}),
      inputArtifactIds: Array.isArray(record.inputArtifactIds) ? record.inputArtifactIds : [],
      outputArtifactIds: Array.isArray(record.outputArtifactIds) ? record.outputArtifactIds : [],
      ...(record.error !== undefined ? { error: record.error } : {}),
    },
  };
}

function isLostLease(error: unknown): boolean {
  return error instanceof Error && error.name === "LostLeaseError";
}

/**
 * Creates a TaskHandler-compatible CLAPP handler. CLAPP tasks (detected by
 * input shape) run their stage through the injected executor with a
 * StageRecord checkpointed into task.state before and after every attempt,
 * a closed-union RunEvent at every transition, signal-honoring cancellation,
 * and count-free idempotence: a re-delivered stage whose record is already
 * "succeeded" is skipped and answers with the recorded artifact ids, while a
 * record left "running" by a dead attempt is re-run and overwritten with the
 * fresh outcome (the worker's attempts counter only ever increments).
 * Non-CLAPP tasks delegate to the fallback handler unchanged.
 */
export function createClappTaskHandler(options: ClappTaskHandlerOptions): ClappTaskHandler {
  const { executor, fallback, runtime } = options;
  return async (owner, task, context) => {
    const detection = detectClappTaskInput(task.input ?? {});
    if (detection.type === "non-clapp") return fallback(owner, task, context);
    if (detection.type === "invalid")
      throw new ClappRuntimeError(
        "tasks",
        "clapp-input",
        `task.input carries CLAPP keys but is not a valid ClappTaskInput: ${detection.reasons.join("; ")}. Refusing to guess; failing the task`,
      );
    const input = detection.input;
    const existing = readStageRecord(task, input);
    if (existing.error) throw new ClappRuntimeError("tasks", "stage-record", existing.error);

    // Count-free idempotence: only a succeeded stage short-circuits delivery.
    if (existing.record?.status === "succeeded") {
      const recorded = existing.record.outputArtifactIds;
      await context.event(
        "status",
        CLAPP_EVENT_TITLES.reconciled(input.stage),
        `A succeeded stage record was found for reconstruction ${input.reconstructionId}; execution was skipped and ${recorded.length} recorded artifact(s) were returned`,
      );
      return {
        status: "succeeded",
        result: `CLAPP stage ${input.stage} already succeeded for reconstruction ${input.reconstructionId}: reconciled ${recorded.length} recorded artifact(s) without re-execution`,
        artifactIds: recorded,
        plan: task.plan.map((step) => ({ ...step, status: "succeeded" as const })),
      };
    }

    // Pre-attempt checkpoint: the attempt is durable before it begins.
    const attemptRecord: StageRecord = {
      id: `${input.reconstructionId}:${input.stage}`,
      reconstructionId: input.reconstructionId,
      stage: input.stage,
      status: "running",
      startedAt: new Date().toISOString(),
      inputArtifactIds: existing.record?.inputArtifactIds ?? [],
      outputArtifactIds: [],
    };
    const current = await context.checkpoint({
      state: { ...task.state, [STAGE_RECORD_KEY]: attemptRecord },
    });
    await context.event(
      "step",
      CLAPP_EVENT_TITLES.started(input.stage),
      `reconstruction ${input.reconstructionId}, attempt ${task.attempts}`,
    );

    let outcome: StageExecutorResult;
    try {
      outcome = await executor.execute(input, runtime, context);
    } catch (error) {
      if (isLostLease(error) || context.signal.aborted)
        return abortStage(options, task.id, input, attemptRecord, error);
      return failStage(context, current, input, attemptRecord, describeError(error));
    }
    if (context.signal.aborted)
      return abortStage(
        options,
        task.id,
        input,
        attemptRecord,
        new ClappRuntimeError(
          "tasks",
          "stage-aborted",
          "the stage executor resolved after the task was aborted; no partial success is claimed",
        ),
      );
    await context.guard();
    if (outcome.error) return failStage(context, current, input, attemptRecord, outcome.error);
    return succeedStage(context, current, input, attemptRecord, outcome.outputArtifactIds);
  };
}

async function succeedStage(
  context: ClappTaskContext,
  task: ClappAgentTaskLike,
  input: ClappTaskInput,
  attempt: StageRecord,
  outputArtifactIds: string[],
): Promise<Partial<ClappAgentTaskLike>> {
  const record: StageRecord = {
    ...attempt,
    status: "succeeded",
    finishedAt: new Date().toISOString(),
    outputArtifactIds,
  };
  const current = await context.checkpoint({
    state: { ...task.state, [STAGE_RECORD_KEY]: record },
  });
  await context.event(
    "step",
    CLAPP_EVENT_TITLES.succeeded(input.stage),
    `${outputArtifactIds.length} output artifact(s)`,
  );
  const result = `CLAPP stage ${input.stage} succeeded for reconstruction ${input.reconstructionId}: ${outputArtifactIds.length} output artifact(s)`;
  await context.event("result", "Work completed", result);
  return {
    status: "succeeded",
    result,
    artifactIds: outputArtifactIds,
    plan: current.plan.map((step) => ({ ...step, status: "succeeded" as const })),
  };
}

async function failStage(
  context: ClappTaskContext,
  task: ClappAgentTaskLike,
  input: ClappTaskInput,
  attempt: StageRecord,
  message: string,
): Promise<Partial<ClappAgentTaskLike>> {
  const record: StageRecord = {
    ...attempt,
    status: "failed",
    finishedAt: new Date().toISOString(),
    error: message,
  };
  const current = await context.checkpoint({
    state: { ...task.state, [STAGE_RECORD_KEY]: record },
  });
  await context.event("error", CLAPP_EVENT_TITLES.failed(input.stage), message);
  return {
    status: "failed",
    error: message,
    artifactIds: record.outputArtifactIds,
    plan: current.plan.map((step) => ({ ...step, status: "failed" as const })),
  };
}

/**
 * Abort path. The lease-fenced context paths are closed once the signal has
 * fired, so the cancelled stage record is written through the runtime's task
 * provider — and only after verifying the durable owner intent (cancelled or
 * paused) for this very task via `readTasks`, so a stolen lease never
 * corrupts a new attempt. Without a runtime or reader the handler exits
 * without writing. Either way it exits by throwing, letting the substrate
 * worker reconcile the task.
 */
async function abortStage(
  options: ClappTaskHandlerOptions,
  taskId: string,
  input: ClappTaskInput,
  attempt: StageRecord,
  cause: unknown,
): Promise<never> {
  const { runtime, readTasks } = options;
  if (runtime && readTasks) {
    try {
      const snapshots = await readTasks(input.reconstructionId);
      const myself = snapshots.find((snapshot) => snapshot.task.id === taskId);
      if (myself && (myself.task.status === "cancelled" || myself.task.status === "paused")) {
        const record: StageRecord = {
          ...attempt,
          status: "cancelled",
          finishedAt: new Date().toISOString(),
          outputArtifactIds: [],
        };
        await runtime.tasks
          .checkpoint(input.reconstructionId, { [STAGE_RECORD_KEY]: record })
          .catch(() => {
            // The task moved on between the read and the write; the new
            // attempt owns the stage record now. Exit without corrupting it.
          });
        await runtime.tasks
          .event(
            input.reconstructionId,
            input.stage,
            CLAPP_EVENT_TITLES.cancelled(input.stage),
            "Aborted with the task; no partial success was claimed",
          )
          .catch(() => {
            // Best effort: the durable task status already records the abort.
          });
      }
    } catch {
      // Reading failed; exit without writing rather than guessing intent.
    }
  }
  throw new ClappRuntimeError(
    "tasks",
    "stage-aborted",
    `CLAPP stage ${input.stage} for reconstruction ${input.reconstructionId} was aborted with the task (${describeError(cause)}); durable state remains clean`,
    { cause },
  );
}
