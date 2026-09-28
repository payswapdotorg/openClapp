import type { ClappStage, ClappStageStatus, ClappTaskInput, StageRecord } from "@clapp/contracts";
import { ClappRunStateError } from "./errors.ts";
import {
  CLAPP_STAGE_STATE_KEY,
  CLAPP_STAGES,
  type ClappAgentTaskLike,
  type ClappFallbackHandler,
  type ClappTaskHandler,
  type ClappTaskSnapshot,
  createClappTaskHandler,
  detectClappTaskInput,
  type StageExecutor,
} from "./handler.ts";
import type { OpenMuseRuntime } from "./runtime.ts";

/**
 * CLAPP-W1-004 — run artifact/recovery semantics.
 *
 * A multi-stage CLAPP run is a chain of substrate tasks (one per ClappStage)
 * sharing a reconstructionId; the durable unit is the task and the stage
 * record lives under task.state.clappStage. Everything in this module derives
 * the run-level view from that task chain alone — there is no second hidden
 * store — and every derivation is pure and deterministic over its input.
 */

/** One stage's contribution to the run-level view. */
export interface ClappRunStageState {
  stage: ClappStage;
  status: ClappStageStatus;
  attempts: number;
  outputArtifactIds: string[];
  error?: string;
}

/** The run-level status derived from the whole task chain. */
export type ClappRunStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "paused"
  | "mixed";

/** The derived run-level view of one reconstruction's task chain. */
export interface ClappRunState {
  reconstructionId: string;
  stages: ClappRunStageState[];
  runStatus: ClappRunStatus;
  lastCompletedStage?: ClappStage;
  /**
   * Entries that could not be attributed to the chain: tasks that carry no
   * CLAPP input, CLAPP-shaped inputs that fail validation, tasks of a foreign
   * reconstruction, duplicate tasks for one stage, and stage records whose
   * durable shape is unparseable. Never thrown — counted.
   */
  malformed: number;
}

/** The restart planner's answer for one reconstruction's task chain. */
export interface ClappRestartPlan {
  resumeFrom: ClappStage | null;
  rationale: string;
}

/** One stage's artifact attribution in the run's manifest. */
export interface ClappStageArtifacts {
  stage: ClappStage;
  artifactIds: string[];
}

/** Options for {@link createStageChainHandler}. */
export interface StageChainHandlerOptions {
  /** Executes each CLAPP stage (the W1-001 executor contract). */
  executor: StageExecutor;
  /** Receives every non-CLAPP task unchanged. */
  fallback: ClappFallbackHandler;
  /**
   * Runtime providers for durable CLAPP-level writes (the abort path) and for
   * the stage executor. Optional; without it the abort path exits cleanly
   * without recording the cancelled stage record.
   */
  runtime?: OpenMuseRuntime;
  /**
   * Reads the durable tasks carrying a reconstruction; used by the abort path
   * to verify owner intent before writing the cancelled stage record.
   */
  readTasks?: (reconstructionId: string) => Promise<ClappTaskSnapshot[]>;
  /**
   * The ordered stage chain this run walks. Defaults to the ten frozen
   * ClappStages in order. A task for a stage outside the configured chain is
   * still executed with full W1-001 semantics — it simply has no successor in
   * this chain, so no next-stage hint is produced for it.
   */
  stages?: readonly ClappStage[];
}

/** A CLAPP task handler that also exposes the chain's successor planning. */
export interface StageChainHandler extends ClappTaskHandler {
  /**
   * The deterministic successor task input for the control plane: the next
   * stage's ClappTaskInput, or null when the current stage is the last in the
   * configured chain. Planning never creates a task — creation is the control
   * plane's job (fail-closed separation).
   */
  planNextTask(current: ClappAgentTaskLike): ClappTaskInput | null;
}

// ---------------------------------------------------------------------------
// Shared attribution core
// ---------------------------------------------------------------------------

/** A stage attributed from the task chain, with its owned record when present. */
interface AttributedStage {
  stage: ClappStage;
  task: ClappAgentTaskLike;
  /** The owned, valid StageRecord for the stage; absent when none is readable. */
  record?: StageRecord;
}

interface Attribution {
  /** "" when nothing in the input could be attributed to a chain. */
  reconstructionId: string;
  /** In CLAPP_STAGES order; only stages that have a task in the chain. */
  stages: AttributedStage[];
  malformed: number;
}

const STAGE_STATUSES: readonly ClappStageStatus[] = [
  "pending",
  "running",
  "waiting_input",
  "waiting_approval",
  "succeeded",
  "failed",
  "cancelled",
  "skipped",
];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function attemptsOf(task: ClappAgentTaskLike): number {
  return Number.isFinite(task.attempts) ? task.attempts : 0;
}

function artifactIdsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((id): id is string => typeof id === "string");
}

/**
 * Parses the stage record a task carries. Returns the owned record when it
 * belongs to the task's own (reconstructionId, stage); a same-reconstruction
 * record for a different stage is a sibling copy (the run-level abort write
 * pattern) and is reported as such; anything else is malformed.
 */
function readOwnedRecord(
  task: ClappAgentTaskLike,
  reconstructionId: string,
  stage: ClappStage,
): { record?: StageRecord; copy?: boolean; malformed?: boolean } {
  const state = isObject(task.state) ? task.state : {};
  const value = state[CLAPP_STAGE_STATE_KEY];
  if (value === undefined || value === null) return {};
  if (!isObject(value)) return { malformed: true };
  if (typeof value.reconstructionId !== "string" || value.reconstructionId !== reconstructionId)
    return { malformed: true };
  if (typeof value.stage !== "string" || !CLAPP_STAGES.includes(value.stage as ClappStage))
    return { malformed: true };
  if (value.stage !== stage) return { copy: true };
  if (
    typeof value.status !== "string" ||
    !STAGE_STATUSES.includes(value.status as ClappStageStatus)
  )
    return { malformed: true };
  return {
    record: {
      id: typeof value.id === "string" ? value.id : `${reconstructionId}:${stage}`,
      reconstructionId,
      stage,
      status: value.status as ClappStageStatus,
      ...(typeof value.startedAt === "string" ? { startedAt: value.startedAt } : {}),
      ...(typeof value.finishedAt === "string" ? { finishedAt: value.finishedAt } : {}),
      inputArtifactIds: artifactIdsOf(value.inputArtifactIds),
      outputArtifactIds: artifactIdsOf(value.outputArtifactIds),
      ...(typeof value.error === "string" ? { error: value.error } : {}),
    },
  };
}

/** Orders two tasks competing for one stage: latest activity wins, deterministically. */
function outranks(a: ClappAgentTaskLike, b: ClappAgentTaskLike): boolean {
  return (
    attemptsOf(a) > attemptsOf(b) ||
    (attemptsOf(a) === attemptsOf(b) && String(a.updatedAt ?? "") > String(b.updatedAt ?? "")) ||
    (attemptsOf(a) === attemptsOf(b) &&
      String(a.updatedAt ?? "") === String(b.updatedAt ?? "") &&
      String(a.id) > String(b.id))
  );
}

/**
 * Attributes the tasks of one reconstruction onto its stage chain. Pure and
 * deterministic: stages are emitted in CLAPP_STAGES order, duplicates for one
 * stage resolve to the most-active task (attempts, then updatedAt, then id),
 * and everything that cannot be attributed is counted in `malformed` rather
 * than thrown. A task carrying a sibling stage's record (the run-level abort
 * write pattern) attributes by its own input; the copy is skipped because the
 * owning task is the authoritative record for that stage.
 */
function attributeRunTasks(runTasks: ClappAgentTaskLike[]): Attribution {
  let reconstructionId = "";
  let malformed = 0;
  const byStage = new Map<ClappStage, AttributedStage>();
  for (const task of runTasks) {
    const detection = detectClappTaskInput(isObject(task.input) ? task.input : {});
    if (detection.type === "non-clapp") {
      malformed += 1; // an entry in a chain read that carries no CLAPP input
      continue;
    }
    if (detection.type === "invalid") {
      malformed += 1; // CLAPP-shaped but not honestly parseable
      continue;
    }
    const input = detection.input;
    if (reconstructionId === "") reconstructionId = input.reconstructionId;
    else if (input.reconstructionId !== reconstructionId) {
      malformed += 1; // belongs to a different run's chain
      continue;
    }
    const read = readOwnedRecord(task, input.reconstructionId, input.stage);
    if (read.malformed) {
      malformed += 1; // the durable state entry is unparseable
      continue;
    }
    const attributed: AttributedStage = { stage: input.stage, task, ...read };
    const existing = byStage.get(input.stage);
    if (existing === undefined) {
      byStage.set(input.stage, attributed);
      continue;
    }
    malformed += 1; // one stage, one task: a duplicate cannot be attributed
    if (outranks(task, existing.task)) byStage.set(input.stage, attributed);
  }
  const stages = CLAPP_STAGES.filter((stage) => byStage.has(stage)).map((stage) => {
    // The non-null assertion is safe: the filter kept only present keys.
    return byStage.get(stage) as AttributedStage;
  });
  return { reconstructionId, stages, malformed };
}

/** The stage-level status: the owned record's status, or the task-mapped truth. */
function stageStatusOf(attributed: AttributedStage): ClappStageStatus {
  if (attributed.record) return attributed.record.status;
  // No durable record: map the substrate task status honestly. A task that
  // ended terminally without ever checkpointing a record reports that ending;
  // anything not yet delivered reports pending.
  if (attributed.task.status === "failed") return "failed";
  if (attributed.task.status === "cancelled") return "cancelled";
  if (attributed.task.status === "succeeded") return "succeeded";
  return "pending";
}

const TASK_IN_FLIGHT = new Set([
  "queued",
  "scheduled",
  "running",
  "waiting_approval",
  "waiting_input",
]);

function isDeadLease(task: ClappAgentTaskLike): boolean {
  if (task.status !== "running") return false;
  const until = Date.parse(task.leaseUntil ?? "");
  return Number.isNaN(until) || until <= Date.now();
}

// ---------------------------------------------------------------------------
// readClappRunState
// ---------------------------------------------------------------------------

/**
 * Derives the run-level view of one reconstruction's task chain. Pure,
 * deterministic, and total: partial chains derive partial views, and unknown
 * shapes are counted in `malformed` — never thrown. The StageRecord under the
 * CLAPP state key is the stage-level truth (its absence maps the task status:
 * failed/cancelled/succeeded endings, otherwise pending); the task statuses
 * drive the run-level distinction between paused and cancelled.
 */
export function readClappRunState(runTasks: ClappAgentTaskLike[]): ClappRunState {
  const { reconstructionId, stages, malformed } = attributeRunTasks(runTasks);
  let lastCompletedStage: ClappStage | undefined;
  for (const attributed of stages) {
    if (stageStatusOf(attributed) === "succeeded") lastCompletedStage = attributed.stage;
  }
  let runStatus: ClappRunStatus;
  if (stages.length === 0) runStatus = "pending";
  else if (stages.every((stage) => stageStatusOf(stage) === "succeeded")) runStatus = "succeeded";
  else if (stages.some((stage) => stage.task.status === "cancelled")) runStatus = "cancelled";
  else if (stages.some((stage) => stage.task.status === "paused")) runStatus = "paused";
  else if (
    stages.some((stage) => stageStatusOf(stage) === "failed" || stage.task.status === "failed")
  )
    runStatus = "failed";
  else if (
    stages.some(
      (stage) =>
        TASK_IN_FLIGHT.has(stage.task.status) ||
        ["running", "waiting_input", "waiting_approval"].includes(stageStatusOf(stage)),
    )
  )
    runStatus = "running";
  else runStatus = "mixed";
  return {
    reconstructionId,
    stages: stages.map((attributed) => ({
      stage: attributed.stage,
      status: stageStatusOf(attributed),
      attempts: attemptsOf(attributed.task),
      outputArtifactIds: attributed.record ? [...attributed.record.outputArtifactIds] : [],
      ...(attributed.record?.error !== undefined
        ? { error: attributed.record.error }
        : attributed.task.status === "failed" && attributed.task.error
          ? { error: attributed.task.error }
          : {}),
    })),
    runStatus,
    ...(lastCompletedStage !== undefined ? { lastCompletedStage } : {}),
    malformed,
  };
}

// ---------------------------------------------------------------------------
// resumeAfterRestart
// ---------------------------------------------------------------------------

/**
 * The restart planner: where does this run resume after a worker/server
 * restart? Walks the chain in stage order, honoring the W1 idempotence rule —
 * stages with succeeded records never re-run — and classifies the first stage
 * that is not durably complete by its substrate truth, with an honest,
 * deterministic rationale for the audit trail. A fully-succeeded chain (and an
 * empty one) plans null; a cancelled or paused run names its stage but says so:
 * neither auto-resumes without explicit owner action.
 */
export function resumeAfterRestart(runTasks: ClappAgentTaskLike[]): ClappRestartPlan {
  const { stages, malformed } = attributeRunTasks(runTasks);
  const note = malformed > 0 ? ` ${malformed} malformed chain entries were skipped.` : "";
  for (const attributed of stages) {
    if (stageStatusOf(attributed) === "succeeded") continue; // never re-run
    const stage = attributed.stage;
    const status = attributed.task.status;
    if (status === "cancelled")
      return {
        resumeFrom: stage,
        rationale: `stage ${stage} is cancelled by owner intent; a cancelled run does not auto-resume — continuing requires an explicit owner decision to start it again.${note}`,
      };
    if (status === "paused")
      return {
        resumeFrom: stage,
        rationale: `stage ${stage} is paused by owner intent; it resumes only after an explicit owner resume, never on restart alone.${note}`,
      };
    if (status === "failed")
      return {
        resumeFrom: stage,
        rationale: `stage ${stage} failed and is terminally stopped; it re-runs only after an explicit owner retry clears the failure.${note}`,
      };
    if (status === "running")
      return isDeadLease(attributed.task)
        ? {
            resumeFrom: stage,
            rationale: `stage ${stage} is running under a dead lease (the worker died mid-stage); a new worker re-delivers the task and the stage re-runs from its durable checkpoint without re-executing earlier stages.${note}`,
          }
        : {
            resumeFrom: stage,
            rationale: `stage ${stage} is running under a live lease; if its worker is gone the task is re-delivered once the lease expires and the stage re-runs from its durable checkpoint.${note}`,
          };
    if (status === "succeeded")
      return {
        resumeFrom: stage,
        rationale: `stage ${stage}'s task is succeeded but its durable stage record is not; the stage state is inconsistent and needs operator attention before anything re-runs.${note}`,
      };
    if (status === "queued")
      return {
        resumeFrom: stage,
        rationale: `stage ${stage} is queued; a worker delivers the task and the stage runs.${note}`,
      };
    if (status === "scheduled")
      return {
        resumeFrom: stage,
        rationale: `stage ${stage} is scheduled; it is delivered when its next run is due.${note}`,
      };
    if (status === "waiting_approval")
      return {
        resumeFrom: stage,
        rationale: `stage ${stage} is waiting for approval; the task is re-delivered once the approval resolves.${note}`,
      };
    return {
      resumeFrom: stage,
      rationale: `stage ${stage} is waiting for input; the stage runs after the owner answers the task's question.${note}`,
    };
  }
  return {
    resumeFrom: null,
    rationale:
      stages.length === 0
        ? `no CLAPP stage tasks exist for the run; there is nothing to resume.${note}`
        : `all ${stages.length} stage(s) in the chain are durably succeeded; the run is complete.${note}`,
  };
}

// ---------------------------------------------------------------------------
// runArtifactLedger
// ---------------------------------------------------------------------------

/**
 * The run's artifact manifest: every stage's StageRecord outputArtifactIds in
 * stage order. Duplicates are preserved and attributed — the same artifact id
 * produced by two stages appears in both entries — because parity evidence
 * needs attribution, never silent deduplication. Stages without a readable
 * record contribute an honest empty entry.
 */
export function runArtifactLedger(runTasks: ClappAgentTaskLike[]): ClappStageArtifacts[] {
  const { stages } = attributeRunTasks(runTasks);
  return stages.map((attributed) => ({
    stage: attributed.stage,
    artifactIds: attributed.record ? [...attributed.record.outputArtifactIds] : [],
  }));
}

// ---------------------------------------------------------------------------
// createStageChainHandler
// ---------------------------------------------------------------------------

function validateStageChain(stages: readonly ClappStage[]): readonly ClappStage[] {
  if (!Array.isArray(stages) || stages.length === 0)
    throw new ClappRunStateError(
      "stages",
      "the stage chain must be a non-empty ordered list of CLAPP stages; refusing to build a chain over nothing",
    );
  const seen = new Set<string>();
  for (const stage of stages) {
    if (typeof stage !== "string" || !CLAPP_STAGES.includes(stage as ClappStage))
      throw new ClappRunStateError(
        "stages",
        `"${String(stage)}" is not one of ${CLAPP_STAGES.join(", ")}; refusing to build a chain over an unknown stage`,
      );
    if (seen.has(stage))
      throw new ClappRunStateError(
        "stages",
        `stage "${stage}" appears more than once in the chain; a run visits each stage at most once`,
      );
    seen.add(stage);
  }
  return stages;
}

function nextStageOf(stage: ClappStage, stages: readonly ClappStage[]): ClappStage | null {
  const index = stages.indexOf(stage);
  if (index === -1 || index === stages.length - 1) return null;
  return stages[index + 1] as ClappStage;
}

/**
 * Creates a run orchestrator around the W1-001 CLAPP task handler: a CLAPP
 * task executes exactly one stage with every W1-001 semantic preserved (this
 * composes {@link createClappTaskHandler}; it does not replace it), and when
 * that stage succeeds and a successor exists in the configured chain, the
 * returned Partial&lt;AgentTask&gt; carries the successor hint in its result
 * string ("; next stage: X") so the durable record names where the run goes
 * next. The chain also exposes `planNextTask` — the deterministic successor
 * task input for the control plane — and never creates a task itself: creation
 * is the control plane's job, enforced by the fact that the chain holds no
 * creation capability at all (fail-closed separation).
 */
export function createStageChainHandler(options: StageChainHandlerOptions): StageChainHandler {
  const stages = validateStageChain(options.stages ?? CLAPP_STAGES);
  const executeStage = createClappTaskHandler({
    executor: options.executor,
    fallback: options.fallback,
    ...(options.runtime !== undefined ? { runtime: options.runtime } : {}),
    ...(options.readTasks !== undefined ? { readTasks: options.readTasks } : {}),
  });
  const runStage: ClappTaskHandler = async (owner, task, context) => {
    const detection = detectClappTaskInput(isObject(task.input) ? task.input : {});
    const result = await executeStage(owner, task, context);
    if (detection.type !== "clapp" || result.status !== "succeeded") return result;
    const next = nextStageOf(detection.input.stage, stages);
    if (next === null) return result;
    const base = typeof result.result === "string" ? result.result : "";
    return { ...result, result: `${base}; next stage: ${next}` };
  };
  const chain: StageChainHandler = Object.assign(runStage, {
    planNextTask: (current: ClappAgentTaskLike): ClappTaskInput | null => {
      const detection = detectClappTaskInput(isObject(current.input) ? current.input : {});
      if (detection.type === "non-clapp")
        throw new ClappRunStateError(
          "plan-next",
          "the task carries no CLAPP input, so it is not a stage in any chain; there is no successor to plan — refusing to guess",
        );
      if (detection.type === "invalid")
        throw new ClappRunStateError(
          "plan-next",
          `the task input carries CLAPP keys but is not a valid ClappTaskInput: ${detection.reasons.join("; ")}; there is no successor to plan`,
        );
      const next = nextStageOf(detection.input.stage, stages);
      return next === null
        ? null
        : {
            specVersion: "0.1",
            reconstructionId: detection.input.reconstructionId,
            stage: next,
          };
    },
  });
  return chain;
}
