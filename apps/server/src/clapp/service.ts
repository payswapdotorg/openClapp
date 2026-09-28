import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  ClappStage,
  ReconstructionSpec,
} from "../../../../packages/clapp-contracts/src/index.ts";
import {
  type ClappFallbackHandler,
  type ClappRunState,
  type ClappStageArtifacts,
  createStageChainHandler,
  readClappRunState,
  runArtifactLedger,
  type StageExecutor,
} from "../../../../packages/clapp-runtime-openmuse/src/index.ts";
import type { AgentTask } from "../../../../packages/domain/src/agent.ts";
import type { Store } from "../db.ts";
import type { AgentService } from "../engine/service.ts";
import { AppError } from "../errors.ts";
import {
  type ClappArtifactRecord,
  type ClappReconstructionRow,
  type ClappRepositories,
  clappInputOf,
} from "./repositories.ts";
import { CLAPP_SERVER_STAGES } from "./worker.ts";

/**
 * CLAPP-W1-007 — the server-side CLAPP control plane.
 *
 * A CLAPP reconstruction is an ordinary owner-scoped OpenMuse artifact: the
 * row lives in the `clapp-reconstructions` store kind, each stage is a
 * durable substrate task whose input carries the frozen `ClappTaskInput`
 * payload (detection by input shape only — never a new task kind), and every
 * run-level view is derived from that task chain with W1-004's pure
 * derivations. There is no second hidden store and no domain algorithm here:
 * this module validates, persists, plans successors over W1-004's planner,
 * delegates control to the substrate's own `AgentService`, and maps errors
 * honestly.
 */

/** The control actions the substrate's task control accepts. */
export type ClappControlAction = "pause" | "resume" | "cancel" | "retry";

export interface ClappCreateResult {
  reconstruction: ClappReconstructionRow;
  /** The first stage's queued task (durable; the worker delivers it). */
  task: AgentTask;
}

export interface ClappAdvanceResult {
  /**
   * `true` when this call created the successor task; `false` when an
   * existing task was returned (the idempotent path). Duplication is
   * impossible regardless: successor tasks carry deterministic
   * idempotency keys.
   */
  advanced: boolean;
  stage: ClappStage;
  task: AgentTask;
  reason: string;
}

export interface ClappStatusResult {
  reconstruction: ClappReconstructionRow;
  run: ClappRunState;
  ledger: ClappStageArtifacts[];
  artifacts: ClappArtifactRecord[];
  /** Whether the deepest stage is the chain's final stage and succeeded. */
  complete: boolean;
}

export interface ClappControlResult {
  task: AgentTask;
  run: ClappRunState;
}

export interface ClappListEntry {
  reconstruction: ClappReconstructionRow;
  run: ClappRunState;
  complete: boolean;
}

/** The public service surface the routes (and tests) consume. */
export interface ClappService {
  createReconstruction(owner: string, spec: unknown): Promise<ClappCreateResult>;
  advance(owner: string, reconstructionId: string): Promise<ClappAdvanceResult>;
  status(owner: string, reconstructionId: string): Promise<ClappStatusResult>;
  control(
    owner: string,
    reconstructionId: string,
    action: ClappControlAction,
  ): Promise<ClappControlResult>;
  list(owner: string): Promise<ClappListEntry[]>;
}

export interface ClappServiceDeps {
  /**
   * The substrate store. Used directly for the create rollback (removing the
   * row when the first stage task cannot be created) and the owner-wide task
   * scan behind `list`.
   */
  db: Store;
  /** The substrate agent service: task creation and control delegation. */
  agent: AgentService;
  /**
   * The runtime with the real bound services. Held per the planned dependency
   * shape for the control plane; the M0 paths operate through the agent
   * service and the repositories (the artifact provider's store is read by
   * the repositories, and stage execution belongs to the worker wiring).
   */
  runtime: unknown;
  /** The owner-scoped CLAPP repositories. */
  repositories: ClappRepositories;
}

// ---------------------------------------------------------------------------
// Strict spec validation — fail closed, precise, never guessing
// ---------------------------------------------------------------------------

const nonEmpty = (field: string) => z.string({ error: `${field} is required` }).min(1);
const positiveInteger = (field: string) =>
  z
    .number({ error: `${field} must be a number` })
    .int({ error: `${field} must be an integer` })
    .positive({ error: `${field} must be a positive integer` });
const nonNegativeInteger = (field: string) =>
  z
    .number({ error: `${field} must be a number` })
    .int({ error: `${field} must be an integer` })
    .nonnegative({ error: `${field} must be a non-negative integer` });

const authorizationSchema = z.strictObject({
  ownerId: nonEmpty("authorization.ownerId"),
  targetId: nonEmpty("authorization.targetId"),
  scope: z
    .array(nonEmpty("authorization.scope entries"), {
      error: "authorization.scope must be a list of strings",
    })
    .min(1, { error: "authorization.scope must name at least one granted scope" }),
  environments: z
    .array(nonEmpty("authorization.environment entries"), {
      error: "authorization.environments must be a list of strings",
    })
    .min(1, { error: "authorization.environments must name at least one environment" }),
  expiresAt: nonEmpty("authorization.expiresAt").optional(),
  retention: z.enum(["ephemeral", "project", "library"]),
  benchmarkOwned: z.boolean(),
  createdAt: nonEmpty("authorization.createdAt"),
});

const explorationSchema = z.strictObject({
  maxStages: positiveInteger("exploration.maxStages"),
  maxActions: positiveInteger("exploration.maxActions"),
  maxDurationMs: positiveInteger("exploration.maxDurationMs"),
  seed: z
    .number({ error: "exploration.seed must be a number" })
    .finite({ error: "exploration.seed must be a finite number" }),
});

const synthesisSchema = z.strictObject({
  targetStack: nonEmpty("synthesis.targetStack"),
  allowNetwork: z.boolean(),
  packagePolicy: z.enum(["verified-only", "verified-and-candidates"]),
});

const verificationSchema = z.strictObject({
  journeys: z.array(nonEmpty("verification.journey entries"), {
    error: "verification.journeys must be a list of strings",
  }),
  visual: z.boolean(),
  network: z.boolean(),
  state: z.boolean(),
  maxRepairIterations: nonNegativeInteger("verification.maxRepairIterations"),
});

const reconstructionSpecSchema = z.strictObject({
  specVersion: z.literal("0.1", {
    error: 'specVersion must be exactly "0.1" (the frozen CLAPP contract version)',
  }),
  reconstructionId: nonEmpty("reconstructionId"),
  targetId: nonEmpty("targetId"),
  name: nonEmpty("name"),
  platform: z.enum(["web", "android", "linux", "windows", "macos", "ios"]),
  entrypoints: z
    .array(nonEmpty("entrypoint entries"), { error: "entrypoints must be a list of strings" })
    .min(1, { error: "entrypoints must name at least one entrypoint" }),
  authorization: authorizationSchema,
  exploration: explorationSchema,
  synthesis: synthesisSchema,
  verification: verificationSchema,
});

/**
 * Validates a raw spec against the frozen `ReconstructionSpec` shape.
 * Fails closed with precise, field-addressed errors — nothing is defaulted,
 * coerced, or guessed — and additionally enforces the two consistency rules
 * the server seam owns: the authorization must belong to the creating owner,
 * and the authorization's target must match the spec's target.
 */
function validateSpec(owner: string, raw: unknown): ReconstructionSpec {
  const parsed = reconstructionSpecSchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join(".") : "spec";
        return `${path}: ${issue.message}`;
      })
      .join("; ");
    throw new AppError(`Reconstruction spec rejected: ${details}`, 422);
  }
  const spec = parsed.data;
  if (spec.authorization.ownerId !== owner)
    throw new AppError(
      `Reconstruction spec rejected: authorization.ownerId must be the creating owner "${owner}" (received "${spec.authorization.ownerId}"); the server refuses to accept an authorization granted to someone else`,
      422,
    );
  if (spec.authorization.targetId !== spec.targetId)
    throw new AppError(
      `Reconstruction spec rejected: authorization.targetId ("${spec.authorization.targetId}") must match the spec's targetId ("${spec.targetId}")`,
      422,
    );
  return spec;
}

// ---------------------------------------------------------------------------
// Chain derivation helpers (pure, over the owner's task chain)
// ---------------------------------------------------------------------------

const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

const stageIndexOf = (task: AgentTask): number => {
  const input = clappInputOf(task);
  return input === null ? -1 : CLAPP_SERVER_STAGES.indexOf(input.stage);
};

/** The deepest stage task in chain order (deterministic tiebreak, W1-004-style). */
const deepestTask = (tasks: AgentTask[]): AgentTask | null => {
  const candidates = tasks.filter((task) => stageIndexOf(task) >= 0);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    const byStage = stageIndexOf(a) - stageIndexOf(b);
    if (byStage !== 0) return byStage;
    const byUpdated = String(a.updatedAt).localeCompare(String(b.updatedAt));
    if (byUpdated !== 0) return byUpdated;
    return a.id.localeCompare(b.id);
  });
  return candidates[candidates.length - 1] ?? null;
};

/** Whether the deepest stage is the chain's final stage and succeeded. */
const chainComplete = (tasks: AgentTask[]): boolean => {
  const deepest = deepestTask(tasks);
  if (!deepest) return false;
  const input = clappInputOf(deepest);
  return (
    input !== null &&
    input.stage === CLAPP_SERVER_STAGES[CLAPP_SERVER_STAGES.length - 1] &&
    deepest.status === "succeeded"
  );
};

/**
 * The planning-only stage chain: W1-004's `planNextTask` over the default
 * frozen chain. Planning is pure — the executor and fallback below can never
 * be invoked through it — so this reuses the package's single successor
 * planner instead of mirroring its logic here.
 */
const neverExecute: StageExecutor = {
  async execute() {
    throw new Error("the CLAPP service's planning-only stage chain never executes stages");
  },
};
const neverDelegate: ClappFallbackHandler = async () => {
  throw new Error("the CLAPP service's planning-only stage chain never delegates tasks");
};
const planSuccessor = createStageChainHandler({
  executor: neverExecute,
  fallback: neverDelegate,
}).planNextTask;

// ---------------------------------------------------------------------------
// Task payload helpers
// ---------------------------------------------------------------------------

const mintReconstructionId = () => `clapp_run_${randomUUID().replace(/-/g, "")}`;

const stageTaskPayload = (spec: ReconstructionSpec, stage: ClappStage) => ({
  prompt: `Reconstruct ${spec.name} (${spec.platform}) — CLAPP stage ${stage} of the ${CLAPP_SERVER_STAGES.length}-stage chain for reconstruction ${spec.reconstructionId}`,
  kind: "agent" as const,
  title: `${spec.name} — ${stage} stage`.slice(0, 160),
  input: {
    specVersion: "0.1",
    reconstructionId: spec.reconstructionId,
    stage,
  } satisfies Record<string, unknown>,
});

const stageTaskKey = (reconstructionId: string, stage: ClappStage) =>
  `clapp:${reconstructionId}:${stage}`;

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export function createClappService(deps: ClappServiceDeps): ClappService {
  const { agent, repositories, db } = deps;

  const mustFind = async (owner: string, reconstructionId: string) => {
    const row = await repositories.get(owner, reconstructionId);
    if (!row) throw new AppError(`Reconstruction ${reconstructionId} not found`, 404);
    return row;
  };

  const mustReadChain = async (owner: string, reconstructionId: string) => {
    const row = await mustFind(owner, reconstructionId);
    const tasks = await repositories.stageTasks(owner, reconstructionId);
    if (tasks.length === 0)
      throw new AppError(
        `Reconstruction ${reconstructionId} has no stage tasks; its chain cannot be read`,
        409,
      );
    return { row, tasks };
  };

  return {
    async createReconstruction(owner, spec) {
      const validated = validateSpec(owner, spec);
      const id = mintReconstructionId();
      const stamped: ReconstructionSpec = { ...validated, reconstructionId: id };
      const row: ClappReconstructionRow = {
        id,
        spec: stamped,
        createdAt: new Date().toISOString(),
        status: "active",
      };
      await repositories.create(owner, row);
      const stage = CLAPP_SERVER_STAGES[0];
      if (!stage) throw new AppError("The CLAPP stage chain is empty; no first stage exists", 500);
      try {
        const task = await agent.createTask(
          owner,
          stageTaskPayload(stamped, stage),
          stageTaskKey(id, stage),
        );
        return { reconstruction: row, task };
      } catch (error) {
        // The row must never persist without its first stage task.
        await db.remove(owner, "clapp-reconstructions", id);
        throw error;
      }
    },

    async advance(owner, reconstructionId) {
      const { row, tasks } = await mustReadChain(owner, reconstructionId);
      const current = deepestTask(tasks);
      if (!current)
        throw new AppError(
          `Reconstruction ${reconstructionId} has no attributable CLAPP stage task; its chain is malformed and refuses a guessed successor`,
          409,
        );
      const input = clappInputOf(current);
      if (!input)
        throw new AppError(
          `The deepest stage task of ${reconstructionId} does not carry a valid CLAPP payload; refusing to guess a successor`,
          409,
        );
      if (!TERMINAL.has(current.status)) {
        return {
          advanced: false,
          stage: input.stage,
          task: current,
          reason: `stage ${input.stage} is ${current.status}; the existing task is the chain's frontier and no successor was created`,
        };
      }
      if (current.status === "failed")
        throw new AppError(
          `Stage ${input.stage} of ${reconstructionId} failed; retry it (control action "retry") before advancing`,
          409,
        );
      if (current.status === "cancelled")
        throw new AppError(
          `The chain of ${reconstructionId} was cancelled; it no longer advances`,
          409,
        );
      const next = planSuccessor(current);
      if (next === null)
        throw new AppError(
          `Reconstruction ${reconstructionId} completed its final stage (${input.stage}); there is no successor`,
          409,
        );
      const preExisting = tasks.some((task) => clappInputOf(task)?.stage === next.stage);
      const task = await agent.createTask(
        owner,
        stageTaskPayload(row.spec, next.stage),
        stageTaskKey(reconstructionId, next.stage),
      );
      return {
        advanced: !preExisting,
        stage: next.stage,
        task,
        reason: preExisting
          ? `stage ${input.stage} succeeded and the ${next.stage} stage task already existed; the existing task was returned`
          : `stage ${input.stage} succeeded; created the ${next.stage} stage task`,
      };
    },

    async status(owner, reconstructionId) {
      const row = await mustFind(owner, reconstructionId);
      const tasks = await repositories.stageTasks(owner, reconstructionId);
      const run = readClappRunState(tasks);
      const ledger = runArtifactLedger(tasks);
      const artifacts = await repositories.artifacts(owner, reconstructionId);
      return { reconstruction: row, run, ledger, artifacts, complete: chainComplete(tasks) };
    },

    async control(owner, reconstructionId, action) {
      const { tasks } = await mustReadChain(owner, reconstructionId);
      const current = deepestTask(tasks);
      if (!current)
        throw new AppError(
          `Reconstruction ${reconstructionId} has no attributable CLAPP stage task; its chain is malformed and refuses a guessed control target`,
          409,
        );
      const input = clappInputOf(current);
      if (!input)
        throw new AppError(
          `The deepest stage task of ${reconstructionId} does not carry a valid CLAPP payload; refusing a guessed control target`,
          409,
        );
      const run = readClappRunState(tasks);
      if (run.runStatus === "cancelled")
        throw new AppError(
          `Reconstruction ${reconstructionId} was cancelled; its chain is terminal and no longer accepts control`,
          409,
        );
      if (chainComplete(tasks))
        throw new AppError(
          `Reconstruction ${reconstructionId} completed its final stage; its chain is terminal and no longer accepts control`,
          409,
        );
      const task = await agent.control(owner, current.id, action);
      if (action === "cancel") await repositories.markCancelled(owner, reconstructionId);
      const after = await repositories.stageTasks(owner, reconstructionId);
      return { task, run: readClappRunState(after) };
    },

    async list(owner) {
      const rows = await repositories.list(owner);
      const tasks = await db.list<AgentTask>(owner, "tasks");
      const byReconstruction = new Map<string, AgentTask[]>();
      for (const task of tasks) {
        const id = (task.input as Record<string, unknown> | undefined)?.reconstructionId;
        if (typeof id !== "string") continue;
        const group = byReconstruction.get(id);
        if (group) group.push(task);
        else byReconstruction.set(id, [task]);
      }
      return rows.map((row) => {
        const runTasks = byReconstruction.get(row.id) ?? [];
        return {
          reconstruction: row,
          run: readClappRunState(runTasks),
          complete: chainComplete(runTasks),
        };
      });
    },
  };
}
