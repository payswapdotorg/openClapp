import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import { BrowserService } from "../apps/server/src/browser.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { TaskWorker } from "../apps/server/src/engine/worker.ts";
import type { ClappStage, StageRecord } from "../packages/clapp-contracts/src/index.ts";
import {
  CLAPP_STAGE_STATE_KEY,
  type ClappAgentTaskLike,
  type ClappFallbackHandler,
  ClappRunStateError,
  type ClappTaskHandler,
  createOpenMuseRuntime,
  createStageChainHandler,
  type OpenMuseRuntime,
  readClappRunState,
  resumeAfterRestart,
  runArtifactLedger,
  type StageChainHandler,
  type StageExecutor,
} from "../packages/clapp-runtime-openmuse/src/index.ts";
import type { AgentTask } from "../packages/domain/src/agent.ts";

/**
 * CLAPP-W1-004 — run artifact/recovery semantics.
 *
 * Integration tests use real substrate adapters (the W1-001 worker-protocol
 * precedent): a real in-process store (createStore), a real AgentService built
 * by createApp, and real TaskWorker instances with short leases driving the
 * stage-chain handler. The AgentService's own worker is never started; the
 * chain handler replaces the execution seam exactly as a production wiring
 * would. The pure derivations (run state, restart planner, ledger) are proven
 * on hand-built task chains so their honesty rules (never throw, count what
 * cannot be attributed, determinism) are exercised directly.
 */
const owner = "local-user";
/** The two-stage chain every run in this file walks: capture then explore. */
const TWO_STAGE_CHAIN: readonly ClappStage[] = ["capture", "explore"];

let db: Store;
let server: Awaited<ReturnType<typeof createApp>>;
let directory: string;
let runtime: OpenMuseRuntime;
let browserSession: BrowserService;

const readTasks = async (reconstructionId: string) =>
  (await db.scan<AgentTask>("tasks"))
    .filter(
      (row) =>
        (row.value.input as Record<string, unknown> | undefined)?.reconstructionId ===
        reconstructionId,
    )
    .map((row) => ({ owner: row.owner, task: row.value as ClappAgentTaskLike }));

/** Every durable task of one reconstruction, as the chain readers see them. */
const chainTasksOf = async (reconstructionId: string): Promise<ClappAgentTaskLike[]> =>
  (await readTasks(reconstructionId)).map((snapshot) => snapshot.task);

/**
 * A stage executor with scripted per-stage behavior. Counts invocations per
 * stage, can hang on the first invocation of a stage until aborted (for
 * pause/cancel mid-stage), and can fail on the first invocation of a stage
 * (for the retry path).
 */
function chainExecutorFixture(
  script: Record<string, { artifacts?: string[]; failFirst?: boolean; hangFirst?: boolean }> = {},
) {
  const invocations = new Map<string, number>();
  const starts = new Map<string, { promise: Promise<void>; resolve: () => void }>();
  for (const stage of Object.keys(script)) {
    let resolve: () => void = () => {};
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    starts.set(stage, { promise, resolve });
  }
  const executor: StageExecutor = {
    async execute(input, _providers, context) {
      const count = (invocations.get(input.stage) ?? 0) + 1;
      invocations.set(input.stage, count);
      const behavior = script[input.stage] ?? {};
      if (behavior.hangFirst === true && count === 1) {
        starts.get(input.stage)?.resolve();
        await new Promise<never>((_done, reject) => {
          context.signal.addEventListener("abort", () => {
            reject(new Error("stage interrupted by abort"));
          });
        });
      }
      starts.get(input.stage)?.resolve();
      if (behavior.failFirst === true && count === 1)
        return {
          outputArtifactIds: [],
          error: `stage ${input.stage} failed on purpose on attempt 1`,
        };
      return { outputArtifactIds: behavior.artifacts ?? [] };
    },
  };
  return {
    executor,
    count: (stage: string): number => invocations.get(stage) ?? 0,
    started: (stage: string): Promise<void> => starts.get(stage)?.promise ?? Promise.resolve(),
  };
}

const mustNotDelegate: ClappFallbackHandler = async () => ({
  status: "failed",
  error: "the fallback handler must not receive CLAPP tasks",
});

const chainFor = (executor: StageExecutor): StageChainHandler =>
  createStageChainHandler({
    executor,
    fallback: mustNotDelegate,
    runtime,
    readTasks,
    stages: TWO_STAGE_CHAIN,
  });

const workerFor = (handler: ClappTaskHandler) =>
  new TaskWorker(db, handler, { leaseMs: 90, pollMs: 20 });

const clappTask = (reconstructionId: string, stage: ClappStage, prompt: string) =>
  server.agent.createTask(owner, {
    prompt,
    kind: "agent",
    input: { specVersion: "0.1", reconstructionId, stage },
  });

const savedTask = (id: string) => server.agent.getTask(owner, id);

// --- hand-built task chains for the pure derivations -------------------------

const taskLike = (
  stage: ClappStage,
  status: ClappAgentTaskLike["status"],
  overrides: {
    reconstructionId?: string;
    state?: Record<string, unknown>;
    leaseUntil?: string | null;
    attempts?: number;
  } = {},
): ClappAgentTaskLike => ({
  id: `task-${overrides.reconstructionId ?? "recon-derive"}-${stage}`,
  title: `Stage ${stage}`,
  prompt: `Run ${stage}`,
  kind: "agent",
  status,
  plan: [],
  evidence: [],
  input: {
    specVersion: "0.1",
    reconstructionId: overrides.reconstructionId ?? "recon-derive",
    stage,
  },
  state: overrides.state ?? {},
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  attempts: overrides.attempts ?? 1,
  leaseUntil: overrides.leaseUntil ?? null,
  artifactIds: [],
});

const succeededRecord = (
  reconstructionId: string,
  stage: ClappStage,
  artifacts: string[],
): StageRecord => ({
  id: `${reconstructionId}:${stage}`,
  reconstructionId,
  stage,
  status: "succeeded",
  startedAt: "2026-01-01T00:00:00.000Z",
  finishedAt: "2026-01-01T00:00:01.000Z",
  inputArtifactIds: [],
  outputArtifactIds: artifacts,
});

const withRecord = (record: StageRecord): Record<string, unknown> => ({
  [CLAPP_STAGE_STATE_KEY]: record,
});

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "openmuse-clapp-w1-004-"));
  db = await createStore({ dataDir: join(directory, "db") });
  const config: Config = {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "sample",
    intelligenceApiKey: "test-project-key-never-sent",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: ["http://localhost:8081"],
  };
  server = await createApp(db, config);
  browserSession = new BrowserService(db, config, server.auth, server.files);
  runtime = createOpenMuseRuntime({
    browserSession,
    computer: server.computer,
    files: server.files,
    agent: server.agent,
    db,
  });
});

after(async () => {
  await server?.agent?.stop();
  await db?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("multi-stage run state derives from the task chain", () => {
  const recon = "recon-derive";
  const capture = taskLike("capture", "succeeded", {
    reconstructionId: recon,
    state: withRecord(succeededRecord(recon, "capture", ["cap-1"])),
  });
  const explore = taskLike("explore", "succeeded", {
    reconstructionId: recon,
    state: withRecord(succeededRecord(recon, "explore", ["exp-1", "exp-2"])),
  });
  const model = taskLike("model", "running", {
    reconstructionId: recon,
    state: withRecord({
      id: `${recon}:model`,
      reconstructionId: recon,
      stage: "model",
      status: "running",
      startedAt: "2026-01-01T00:00:02.000Z",
      inputArtifactIds: [],
      outputArtifactIds: [],
    }),
  });
  // A malformed state entry: unparseable, but it must be counted, never thrown.
  const malformed = taskLike("plan", "running", {
    reconstructionId: recon,
    state: { [CLAPP_STAGE_STATE_KEY]: 42 },
  });
  const state = readClappRunState([capture, explore, model, malformed]);
  assert.equal(state.reconstructionId, recon);
  assert.equal(state.runStatus, "running");
  assert.equal(state.lastCompletedStage, "explore");
  assert.equal(state.malformed, 1);
  assert.equal(state.stages.length, 3);
  assert.deepEqual(
    state.stages.map((stage) => stage.stage),
    ["capture", "explore", "model"],
  );
  assert.deepEqual(
    state.stages.map((stage) => stage.status),
    ["succeeded", "succeeded", "running"],
  );
  assert.deepEqual(state.stages[1].outputArtifactIds, ["exp-1", "exp-2"]);
});

test("kill/restart resumes from the last durable stage", async () => {
  const recon = "recon-restart";
  const fixture = chainExecutorFixture({
    capture: { artifacts: ["cap-1", "cap-2"] },
    explore: { artifacts: ["exp-1"] },
  });
  const chain = chainFor(fixture.executor);
  const captureTask = await clappTask(recon, "capture", "Stage one of the restart check");
  const first = workerFor(chain);
  await first.tick();
  assert.equal(fixture.count("capture"), 1);
  assert.equal((await savedTask(captureTask.id)).status, "succeeded");
  // The crash: between the stage commit and the task commit, the durable task
  // goes back to a dead running lease while the stage record stays succeeded
  // (the W1-001 restart precedent).
  await db.compareAndSwap(
    owner,
    "tasks",
    captureTask.id,
    { status: "succeeded", leaseId: null },
    { status: "running", leaseId: "dead-worker", leaseUntil: "2020-01-01T00:00:00.000Z" },
  );
  // The control plane (a later wave) creates the successor task; the chain
  // never does (proven by the no-create test below).
  const exploreTask = await clappTask(recon, "explore", "Stage two of the restart check");
  // Before the restart, the planner points at the not-yet-run stage and the
  // run derives its mid-restart truth from the chain alone.
  const plan = resumeAfterRestart(await chainTasksOf(recon));
  assert.equal(plan.resumeFrom, "explore");
  assert.match(plan.rationale, /queued/);
  const midRun = readClappRunState(await chainTasksOf(recon));
  assert.equal(midRun.runStatus, "running");
  assert.equal(midRun.lastCompletedStage, "capture");
  // A NEW TaskWorker re-delivers BOTH tasks.
  const second = workerFor(chain);
  await second.tick();
  assert.equal(
    fixture.count("capture"),
    1,
    "a succeeded stage must never re-execute across a restart",
  );
  assert.equal(fixture.count("explore"), 1, "stage two executes exactly once");
  const savedCapture = await savedTask(captureTask.id);
  const savedExplore = await savedTask(exploreTask.id);
  assert.equal(savedCapture.status, "succeeded");
  assert.equal(savedExplore.status, "succeeded");
  assert.equal(savedCapture.attempts, 2, "re-delivery increments attempts and never resets them");
  assert.equal(savedExplore.attempts, 1);
  const reconciledRecord = savedCapture.state.clappStage as StageRecord;
  assert.equal(reconciledRecord.status, "succeeded");
  assert.deepEqual(reconciledRecord.outputArtifactIds, ["cap-1", "cap-2"]);
  const events = (await server.agent.detail(owner, captureTask.id)).events;
  assert.ok(events.some((event) => event.kind === "status" && /reconciled/.test(event.title)));
  // The run state shows the full lineage.
  const final = readClappRunState(await chainTasksOf(recon));
  assert.equal(final.runStatus, "succeeded");
  assert.equal(final.lastCompletedStage, "explore");
  assert.deepEqual(
    final.stages.map((stage) => stage.stage),
    ["capture", "explore"],
  );
  assert.deepEqual(
    final.stages.map((stage) => stage.status),
    ["succeeded", "succeeded"],
  );
  assert.deepEqual(
    final.stages.map((stage) => stage.attempts),
    [2, 1],
  );
  assert.equal(final.malformed, 0);
});

test("pause mid-stage leaves clean state and resumes", async () => {
  const recon = "recon-pause-resume";
  const fixture = chainExecutorFixture({
    capture: { artifacts: ["cap-art"] },
    explore: { artifacts: ["exp-art"], hangFirst: true },
  });
  const chain = chainFor(fixture.executor);
  const captureTask = await clappTask(recon, "capture", "Stage one of the pause check");
  const exploreTask = await clappTask(recon, "explore", "Stage two of the pause check");
  const worker = workerFor(chain);
  const tick = worker.tick();
  await fixture.started("explore");
  await server.agent.control(owner, exploreTask.id, "pause");
  await tick.catch(() => {});
  const paused = await savedTask(exploreTask.id);
  assert.equal(paused.status, "paused");
  assert.equal(paused.leaseId, null);
  const cancelledRecord = paused.state.clappStage as StageRecord;
  assert.equal(cancelledRecord.status, "cancelled");
  assert.deepEqual(cancelledRecord.outputArtifactIds, []);
  assert.ok(cancelledRecord.finishedAt);
  // Stage scoping: stage one's durable record is untouched by stage two's
  // abort write.
  const captureRecord = (await savedTask(captureTask.id)).state.clappStage as StageRecord;
  assert.equal(captureRecord.stage, "capture");
  assert.equal(captureRecord.status, "succeeded");
  // The run reports paused, resumable, with the last completed stage named.
  const pausedRun = readClappRunState(await chainTasksOf(recon));
  assert.equal(pausedRun.runStatus, "paused");
  assert.equal(pausedRun.lastCompletedStage, "capture");
  // Resume re-runs the paused stage and completes the run.
  await server.agent.control(owner, exploreTask.id, "resume");
  const resuming = workerFor(chain);
  await resuming.tick();
  assert.equal(fixture.count("capture"), 1);
  assert.equal(fixture.count("explore"), 2);
  const final = readClappRunState(await chainTasksOf(recon));
  assert.equal(final.runStatus, "succeeded");
  assert.equal(final.lastCompletedStage, "explore");
  assert.deepEqual(
    final.stages.map((stage) => stage.outputArtifactIds),
    [["cap-art"], ["exp-art"]],
  );
});

test("cancel mid-run is terminal and honest", async () => {
  const recon = "recon-cancel";
  const fixture = chainExecutorFixture({
    capture: { artifacts: ["cap-art"] },
    explore: { artifacts: ["never-claimed"], hangFirst: true },
  });
  const chain = chainFor(fixture.executor);
  const captureTask = await clappTask(recon, "capture", "Stage one of the cancel check");
  const exploreTask = await clappTask(recon, "explore", "Stage two of the cancel check");
  const worker = workerFor(chain);
  const tick = worker.tick();
  await fixture.started("explore");
  await server.agent.control(owner, exploreTask.id, "cancel");
  await tick.catch(() => {});
  const cancelled = await savedTask(exploreTask.id);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.leaseId, null);
  assert.equal(fixture.count("explore"), 1);
  const record = cancelled.state.clappStage as StageRecord;
  assert.equal(record.status, "cancelled");
  assert.deepEqual(record.outputArtifactIds, []);
  const captureRecord = (await savedTask(captureTask.id)).state.clappStage as StageRecord;
  assert.equal(captureRecord.stage, "capture");
  assert.equal(captureRecord.status, "succeeded");
  // The chain reports cancelled.
  const runState = readClappRunState(await chainTasksOf(recon));
  assert.equal(runState.runStatus, "cancelled");
  // The restart planner is honest: it names the cancelled stage and says a
  // cancelled run does not auto-resume.
  const plan = resumeAfterRestart(await chainTasksOf(recon));
  assert.equal(plan.resumeFrom, "explore");
  assert.match(plan.rationale, /cancelled/);
  assert.match(plan.rationale, /does not auto-resume/);
  // Terminal: nothing re-ran and nothing will without an owner decision.
  assert.equal((await savedTask(exploreTask.id)).status, "cancelled");
  assert.equal(fixture.count("capture"), 1);
});

test("retry after stage failure re-runs only the failed stage", async () => {
  const recon = "recon-retry";
  const fixture = chainExecutorFixture({
    capture: { artifacts: ["cap-art"] },
    explore: { artifacts: ["exp-art"], failFirst: true },
  });
  const chain = chainFor(fixture.executor);
  await clappTask(recon, "capture", "Stage one of the retry check");
  const exploreTask = await clappTask(recon, "explore", "Stage two of the retry check");
  const first = workerFor(chain);
  await first.tick();
  const failed = await savedTask(exploreTask.id);
  assert.equal(failed.status, "failed");
  assert.match(failed.error ?? "", /failed on purpose/);
  const failedRun = readClappRunState(await chainTasksOf(recon));
  assert.equal(failedRun.runStatus, "failed");
  assert.match(failedRun.stages[1].error ?? "", /failed on purpose/);
  await server.agent.control(owner, exploreTask.id, "retry");
  const second = workerFor(chain);
  await second.tick();
  assert.equal(fixture.count("capture"), 1, "stage one never re-runs on a stage-two retry");
  assert.equal(fixture.count("explore"), 2, "stage two re-runs after the retry");
  const final = readClappRunState(await chainTasksOf(recon));
  assert.equal(final.runStatus, "succeeded");
  assert.equal(final.lastCompletedStage, "explore");
});

test("restart planner is deterministic and honest", () => {
  const recon = "recon-planner";
  const succeeded = (stage: ClappStage): ClappAgentTaskLike =>
    taskLike(stage, "succeeded", {
      reconstructionId: recon,
      state: withRecord(succeededRecord(recon, stage, [])),
    });
  // Fully-succeeded chain: nothing to resume.
  const complete = resumeAfterRestart([succeeded("capture"), succeeded("explore")]);
  assert.equal(complete.resumeFrom, null);
  assert.match(complete.rationale, /complete/);
  // Running-dead: the dead stage with the re-run rationale.
  const dead = taskLike("explore", "running", {
    reconstructionId: recon,
    leaseUntil: "2020-01-01T00:00:00.000Z",
  });
  const deadPlan = resumeAfterRestart([succeeded("capture"), dead]);
  assert.equal(deadPlan.resumeFrom, "explore");
  assert.match(deadPlan.rationale, /dead lease/);
  assert.match(deadPlan.rationale, /re-runs/);
  // Determinism: the same chain plans the same answer, whatever the input order.
  const chain = [succeeded("capture"), dead];
  const first = resumeAfterRestart(chain);
  const again = resumeAfterRestart([...chain]);
  const reversed = resumeAfterRestart([dead, succeeded("capture")]);
  assert.deepEqual(first, again);
  assert.deepEqual(first, reversed);
  // A failed stage is honest: it needs an explicit owner retry, not a resume.
  const failed = taskLike("explore", "failed", { reconstructionId: recon });
  const failedPlan = resumeAfterRestart([succeeded("capture"), failed]);
  assert.equal(failedPlan.resumeFrom, "explore");
  assert.match(failedPlan.rationale, /explicit owner retry/);
  // Empty chain: honestly nothing to resume.
  const empty = resumeAfterRestart([]);
  assert.equal(empty.resumeFrom, null);
  assert.match(empty.rationale, /nothing to resume/);
});

test("artifact ledger attributes every stage's artifacts", async () => {
  const recon = "recon-ledger";
  const fixture = chainExecutorFixture({
    capture: { artifacts: ["shared-art", "cap-only"] },
    explore: { artifacts: ["shared-art", "exp-only"] },
  });
  const chain = chainFor(fixture.executor);
  await clappTask(recon, "capture", "Stage one of the ledger check");
  await clappTask(recon, "explore", "Stage two of the ledger check");
  const worker = workerFor(chain);
  await worker.tick();
  const ledger = runArtifactLedger(await chainTasksOf(recon));
  assert.deepEqual(ledger, [
    { stage: "capture", artifactIds: ["shared-art", "cap-only"] },
    { stage: "explore", artifactIds: ["shared-art", "exp-only"] },
  ]);
  // No silent dedup: the shared artifact stays attributed to BOTH stages.
  const flat = ledger.flatMap((entry) => entry.artifactIds);
  assert.equal(flat.filter((id) => id === "shared-art").length, 2);
});

test("chain never auto-creates tasks", async () => {
  const recon = "recon-no-create";
  const fixture = chainExecutorFixture({ capture: { artifacts: ["cap-art"] } });
  const chain = chainFor(fixture.executor);
  const captureTask = await clappTask(recon, "capture", "Stage one of the no-create check");
  assert.equal((await chainTasksOf(recon)).length, 1);
  const worker = workerFor(chain);
  await worker.tick();
  const saved = await savedTask(captureTask.id);
  assert.equal(saved.status, "succeeded");
  // The handler's result names the successor stage.
  assert.match(saved.result ?? "", /next stage: explore/);
  // The chain plans the successor task input deterministically...
  assert.deepEqual(chain.planNextTask(saved), {
    specVersion: "0.1",
    reconstructionId: recon,
    stage: "explore",
  });
  // ...but creates nothing: the store is unchanged until the control plane
  // creates the successor itself.
  const after = await chainTasksOf(recon);
  assert.equal(after.length, 1);
  assert.equal(after[0].id, captureTask.id);
  const storeCount = (await db.scan<AgentTask>("tasks")).filter(
    (row) => (row.value.input as Record<string, unknown> | undefined)?.reconstructionId === recon,
  ).length;
  assert.equal(storeCount, 1);
  // The last stage of the chain plans null, and so does a stage outside it.
  assert.equal(
    chain.planNextTask(taskLike("explore", "succeeded", { reconstructionId: recon })),
    null,
  );
  assert.equal(
    chain.planNextTask(taskLike("promote", "succeeded", { reconstructionId: recon })),
    null,
  );
  // Planning refuses to guess for a task that carries no CLAPP input.
  const nonClapp: ClappAgentTaskLike = {
    ...taskLike("capture", "queued", { reconstructionId: recon }),
    input: { csv: "date,amount\n2024-01-01,10.50" },
  };
  assert.throws(
    () => chain.planNextTask(nonClapp),
    (error: unknown) => error instanceof ClappRunStateError,
  );
});
