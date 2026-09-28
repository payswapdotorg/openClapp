import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import { BrowserService } from "../apps/server/src/browser.ts";
import type { ClappReconstructionRow } from "../apps/server/src/clapp/repositories.ts";
import { createClappRepositories } from "../apps/server/src/clapp/repositories.ts";
import type { ClappCreateResult } from "../apps/server/src/clapp/service.ts";
import { createClappService } from "../apps/server/src/clapp/service.ts";
import {
  createClappWorkerHandler,
  createSkeletonStageExecutor,
} from "../apps/server/src/clapp/worker.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { TaskWorker } from "../apps/server/src/engine/worker.ts";
import type { StageExecutor } from "../packages/clapp-runtime-openmuse/src/index.ts";
import {
  createOpenMuseRuntime,
  type OpenMuseRuntime,
} from "../packages/clapp-runtime-openmuse/src/index.ts";
import type { AgentArtifact, AgentTask } from "../packages/domain/src/agent.ts";

/**
 * CLAPP-W1-007 — server-side CLAPP orchestration.
 *
 * Integration tests use the real substrate (the W1-001 worker-protocol
 * precedent): a real in-process store (createStore), a real AgentService and
 * HTTP app built by createApp — which now carries the production CLAPP wiring
 * (runtime, repositories, service, wrapped worker handler, mounted routes) —
 * and real TaskWorker instances with short leases. Executor-precision tests
 * drive their own wrapped handler over the same substrate exactly as the
 * production wiring composes it; route tests drive the mounted `/api/clapp`
 * surface through the real session middleware.
 */
const owner = "local-user";

let db: Store;
let server: Awaited<ReturnType<typeof createApp>>;
let directory: string;
let runtime: OpenMuseRuntime;
let browserSession: BrowserService;

/** The fixture control plane: the same wiring app.ts composes, fixture-driven. */
let service: ReturnType<typeof createClappService>;
let repositories: ReturnType<typeof createClappRepositories>;

/** A stage executor with scripted behavior and exact invocation counts. */
function executorFixture(options: { artifacts?: string[]; hangFirst?: boolean } = {}) {
  const artifacts = options.artifacts ?? ["skeleton-art"];
  let invocations = 0;
  let signalStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  const executor: StageExecutor = {
    async execute(_input, _providers, context) {
      invocations += 1;
      if (options.hangFirst && invocations === 1) {
        signalStarted?.();
        await new Promise<never>((_resolve, reject) => {
          context.signal.addEventListener("abort", () => {
            reject(new Error("stage interrupted by abort"));
          });
        });
      }
      signalStarted?.();
      return { outputArtifactIds: artifacts };
    },
  };
  return {
    executor,
    started,
    get invocations() {
      return invocations;
    },
  };
}

const mustNotDelegate = async () => ({
  status: "failed" as const,
  error: "the fallback handler must not receive CLAPP tasks",
});

/** The fixture wrapped handler over the real runtime and store scan. */
const chainFor = (executor: StageExecutor) =>
  createClappWorkerHandler({
    db,
    runtime,
    executor,
    fallback: mustNotDelegate,
  });

const workerFor = (handler: ReturnType<typeof chainFor>) =>
  new TaskWorker(db, handler, { leaseMs: 90, pollMs: 20 });

/** A valid frozen-shaped spec; the server stamps the canonical reconstruction id. */
const validSpec = (overrides: Record<string, unknown> = {}) => ({
  specVersion: "0.1",
  reconstructionId: "client-requested-handle",
  targetId: "target-checks",
  name: "OpenMuse demo target",
  platform: "web",
  entrypoints: ["https://example.test/"],
  authorization: {
    ownerId: owner,
    targetId: "target-checks",
    scope: ["read"],
    environments: ["production"],
    retention: "project",
    benchmarkOwned: false,
    createdAt: "2026-01-01T00:00:00.000Z",
  },
  exploration: { maxStages: 4, maxActions: 200, maxDurationMs: 60000, seed: 7 },
  synthesis: { targetStack: "web", allowNetwork: false, packagePolicy: "verified-only" },
  verification: { journeys: [], visual: true, network: false, state: true, maxRepairIterations: 2 },
  ...overrides,
});

const rowsCount = async () =>
  (await db.list<ClappReconstructionRow>(owner, "clapp-reconstructions")).length;
const tasksCount = async () => (await db.list<AgentTask>(owner, "tasks")).length;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "openmuse-clapp-w1-007-"));
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
  repositories = createClappRepositories(db);
  service = createClappService({
    db,
    agent: server.agent,
    runtime,
    repositories,
  });
});

after(async () => {
  await server?.agent?.stop();
  await db?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. Spec validation fails closed
// ---------------------------------------------------------------------------

test("reconstruction spec validation fails closed", async () => {
  const rows = await rowsCount();
  const tasks = await tasksCount();
  const rejects = (spec: unknown, pattern: RegExp) =>
    assert.rejects(
      () => service.createReconstruction(owner, spec),
      (error: unknown) => {
        assert.ok(error instanceof Error, `expected an error for ${JSON.stringify(spec)}`);
        assert.match(error.message, pattern);
        if (error instanceof Error && "status" in error)
          assert.equal((error as { status: number }).status, 422);
        return true;
      },
    );
  await rejects(validSpec({ specVersion: "0.9" }), /specVersion.*"0\.1"/);
  await rejects(
    (() => {
      const spec = validSpec() as Record<string, unknown>;
      delete spec.authorization;
      return spec;
    })(),
    /authorization/,
  );
  await rejects(
    validSpec({ exploration: { maxStages: 4, maxActions: 0, maxDurationMs: 60000, seed: 7 } }),
    /exploration\.maxActions must be a positive integer/,
  );
  await rejects(
    validSpec({ exploration: { maxStages: -1, maxActions: 200, maxDurationMs: 60000, seed: 7 } }),
    /exploration\.maxStages must be a positive integer/,
  );
  await rejects(
    validSpec({ authorization: { ...validSpec().authorization, ownerId: "someone-else" } }),
    new RegExp(`ownerId.*${owner}`),
  );
  await rejects(null, /Reconstruction spec rejected/);
  // Nothing was persisted and no task was created by any rejected spec.
  assert.equal(await rowsCount(), rows);
  assert.equal(await tasksCount(), tasks);
});

// ---------------------------------------------------------------------------
// 2. Create persists and starts the first stage task
// ---------------------------------------------------------------------------

test("create persists and starts the first stage task", async () => {
  const created: ClappCreateResult = await service.createReconstruction(owner, validSpec());
  const { reconstruction, task } = created;
  assert.match(reconstruction.id, /^clapp_run_[0-9a-f]{32}$/);
  assert.equal(reconstruction.spec.reconstructionId, reconstruction.id);
  assert.notEqual(reconstruction.spec.reconstructionId, "client-requested-handle");
  assert.equal(reconstruction.status, "active");
  assert.ok(reconstruction.createdAt);
  // The row is durable under the owner-scoped repository kind.
  const row = await db.get<ClappReconstructionRow>(
    owner,
    "clapp-reconstructions",
    reconstruction.id,
  );
  assert.deepEqual(row, reconstruction);
  // The first stage task is queued with the exact CLAPP payload.
  const saved = await server.agent.getTask(owner, task.id);
  assert.equal(saved.status, "queued");
  assert.deepEqual(saved.input, {
    specVersion: "0.1",
    reconstructionId: reconstruction.id,
    stage: "authorization",
  });
  assert.match(saved.title, /OpenMuse demo target/);
  assert.match(saved.title, /authorization/);
  // The chain reader sees exactly this reconstruction's task.
  const chain = await repositories.stageTasks(owner, reconstruction.id);
  assert.equal(chain.length, 1);
  // Keep later worker ticks free of this task.
  await server.agent.control(owner, task.id, "cancel");
});

// ---------------------------------------------------------------------------
// 3. A stage runs durably and advances
// ---------------------------------------------------------------------------

test("stage runs durably and advances", async () => {
  const fixture = executorFixture({ artifacts: ["stage-one-art"] });
  const worker = workerFor(chainFor(fixture.executor));
  const { reconstruction, task } = await service.createReconstruction(owner, validSpec());
  await worker.tick();
  assert.equal(fixture.invocations, 1);
  const first = await server.agent.getTask(owner, task.id);
  assert.equal(first.status, "succeeded");
  assert.equal((first.state.clappStage as { status: string }).status, "succeeded");
  assert.deepEqual(first.artifactIds, ["stage-one-art"]);
  // advance creates exactly one successor task for the next stage.
  const advanced = await service.advance(owner, reconstruction.id);
  assert.equal(advanced.advanced, true);
  assert.equal(advanced.stage, "capture");
  assert.equal(advanced.task.status, "queued");
  assert.deepEqual(advanced.task.input, {
    specVersion: "0.1",
    reconstructionId: reconstruction.id,
    stage: "capture",
  });
  assert.match(advanced.task.title, /OpenMuse demo target/);
  // advance twice is idempotent: the existing successor is returned, no duplicate.
  const again = await service.advance(owner, reconstruction.id);
  assert.equal(again.advanced, false);
  assert.equal(again.task.id, advanced.task.id);
  const chain = await repositories.stageTasks(owner, reconstruction.id);
  assert.equal(chain.length, 2);
  assert.equal(fixture.invocations, 1, "no stage re-executed by advancing");
  // Keep later worker ticks free of this task.
  await server.agent.control(owner, advanced.task.id, "cancel");
});

// ---------------------------------------------------------------------------
// 4. Run status aggregates the chain
// ---------------------------------------------------------------------------

test("run status aggregates the chain", async () => {
  const fixture = executorFixture({ artifacts: ["chain-art"] });
  const worker = workerFor(chainFor(fixture.executor));
  const { reconstruction } = await service.createReconstruction(owner, validSpec());
  await worker.tick();
  await service.advance(owner, reconstruction.id);
  await worker.tick();
  const status = await service.status(owner, reconstruction.id);
  assert.equal(status.run.reconstructionId, reconstruction.id);
  assert.equal(status.run.stages.length, 2);
  assert.deepEqual(
    status.run.stages.map((stage) => stage.stage),
    ["authorization", "capture"],
  );
  assert.ok(status.run.stages.every((stage) => stage.status === "succeeded"));
  assert.equal(status.run.runStatus, "succeeded");
  assert.equal(status.run.lastCompletedStage, "capture");
  assert.equal(status.run.malformed, 0);
  assert.deepEqual(status.ledger, [
    { stage: "authorization", artifactIds: ["chain-art"] },
    { stage: "capture", artifactIds: ["chain-art"] },
  ]);
  assert.equal(status.complete, false);
  assert.deepEqual(status.reconstruction, await repositories.get(owner, reconstruction.id));
});

// ---------------------------------------------------------------------------
// 5. Control delegates to the current stage
// ---------------------------------------------------------------------------

test("control delegates to the current stage", async () => {
  // Pause mid-stage: the hanging executor is interrupted, the stage record
  // becomes cancelled with no partial success, and resume completes the stage.
  const pauseFixture = executorFixture({ artifacts: ["after-resume"], hangFirst: true });
  const pausingWorker = workerFor(chainFor(pauseFixture.executor));
  const pausedRun = await service.createReconstruction(owner, validSpec());
  const tick = pausingWorker.tick();
  await pauseFixture.started;
  await service.control(owner, pausedRun.reconstruction.id, "pause");
  await tick.catch(() => {});
  const paused = await server.agent.getTask(owner, pausedRun.task.id);
  assert.equal(paused.status, "paused");
  assert.equal((paused.state.clappStage as { status: string }).status, "cancelled");
  assert.equal(paused.leaseId, null);
  const pausedStatus = await service.status(owner, pausedRun.reconstruction.id);
  assert.equal(pausedStatus.run.runStatus, "paused");
  // Resume completes the stage through the same worker seam.
  await service.control(owner, pausedRun.reconstruction.id, "resume");
  await pausingWorker.tick();
  assert.equal(pauseFixture.invocations, 2);
  const resumed = await server.agent.getTask(owner, pausedRun.task.id);
  assert.equal(resumed.status, "succeeded");
  assert.equal((resumed.state.clappStage as { status: string }).status, "succeeded");
  assert.deepEqual(resumed.artifactIds, ["after-resume"]);

  // Cancel mid-stage: the terminal mapping is honest and further control is rejected.
  const cancelFixture = executorFixture({ artifacts: ["never-claimed"], hangFirst: true });
  const cancellingWorker = workerFor(chainFor(cancelFixture.executor));
  const cancelledRun = await service.createReconstruction(owner, validSpec());
  const cancelTick = cancellingWorker.tick();
  await cancelFixture.started;
  await service.control(owner, cancelledRun.reconstruction.id, "cancel");
  await cancelTick.catch(() => {});
  const cancelledStatus = await service.status(owner, cancelledRun.reconstruction.id);
  assert.equal(cancelledStatus.run.runStatus, "cancelled");
  assert.equal(cancelledStatus.reconstruction.status, "cancelled");
  await assert.rejects(
    () => service.control(owner, cancelledRun.reconstruction.id, "pause"),
    /terminal.*no longer accepts control|no longer accepts control/,
  );
  await assert.rejects(
    () => service.advance(owner, cancelledRun.reconstruction.id),
    /cancelled.*no longer advances/,
  );
  // The completed (but not finished) chain still accepts no guess: pausing a
  // succeeded frontier returns the substrate's own honest mapping.
  const completeRun = pausedRun;
  const pausedAgain = await service.control(owner, completeRun.reconstruction.id, "pause");
  assert.equal(pausedAgain.task.status, "succeeded");
});

// ---------------------------------------------------------------------------
// 6. Non-CLAPP tasks flow through unchanged
// ---------------------------------------------------------------------------

test("non-clapp tasks flow through unchanged", async () => {
  // The wrapped handler installed on the substrate worker (the production
  // app.ts wiring) routes this plain finance task to the substrate's own
  // handler: the substrate behavior is preserved byte-for-byte.
  const csv =
    'date,description,amount,category\n2026-09-01,Salary,-1000,Income\n2026-09-02,"Coffee, local",10.10,Food\n2026-09-03,Lunch,20.20,Food';
  const task = await server.agent.createTask(owner, {
    prompt: "Summarize the imported spending",
    kind: "finance",
    input: { csv },
  });
  await server.agent.worker.tick();
  const saved = await server.agent.getTask(owner, task.id);
  assert.equal(saved.status, "succeeded");
  assert.match(saved.result ?? "", /3 transactions · 30\.30 spent/);
  assert.equal(saved.state.clappStage, undefined);
  assert.equal(saved.artifactIds.length, 1);
  const artifacts = await db.list<AgentArtifact>(owner, "agent-artifacts");
  const artifact = artifacts.find((candidate) => candidate.taskId === task.id);
  assert.ok(artifact, "the substrate finance artifact was recorded");
  assert.equal(artifact.kind, "finance");
  assert.equal(artifact.title, "Spending tracker");
  assert.match(artifact.summary, /3 transactions · 30\.30 spent/);
});

// ---------------------------------------------------------------------------
// 7. Routes are thin and owner-scoped
// ---------------------------------------------------------------------------

test("routes are thin and owner-scoped", async () => {
  const session = await server.app.request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(session.status, 200);
  const token = ((await session.json()) as { token: string }).token;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  // No session: the substrate auth boundary rejects before any CLAPP route runs.
  assert.equal((await server.app.request("/api/clapp/reconstructions")).status, 401);
  // Create via the route: the same repository row the service path persists.
  const created = await server.app.request("/api/clapp/reconstructions", {
    method: "POST",
    headers,
    body: JSON.stringify(validSpec()),
  });
  assert.equal(created.status, 201);
  const createdBody = (await created.json()) as ClappCreateResult;
  assert.match(createdBody.reconstruction.id, /^clapp_run_/);
  const row = await repositories.get(owner, createdBody.reconstruction.id);
  assert.deepEqual(row, createdBody.reconstruction);
  // The production wiring runs the first stage through the substrate worker.
  await server.agent.worker.tick();
  const statusResponse = await server.app.request(
    `/api/clapp/reconstructions/${createdBody.reconstruction.id}`,
    { headers },
  );
  assert.equal(statusResponse.status, 200);
  const status = (await statusResponse.json()) as {
    run: { stages: { status: string; outputArtifactIds: string[] }[] };
    ledger: { artifactIds: string[] }[];
    artifacts: {
      id: string;
      reconstructionId: string;
      classification: string;
      contentUrl: string;
    }[];
    complete: boolean;
  };
  assert.equal(status.run.stages.length, 1);
  assert.equal(status.run.stages[0].status, "succeeded");
  assert.equal(status.ledger.length, 1);
  assert.equal(status.ledger[0].artifactIds.length, 1);
  assert.equal(status.artifacts.length, 1);
  assert.equal(status.artifacts[0].classification, "derived");
  assert.equal(status.artifacts[0].reconstructionId, createdBody.reconstruction.id);
  // The signed content URL serves the artifact's exact content-addressed bytes.
  const url = new URL(status.artifacts[0].contentUrl);
  const content = await server.app.request(`${url.pathname}${url.search}`);
  assert.equal(content.status, 200);
  const bytes = new Uint8Array(await content.arrayBuffer());
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    status.artifacts[0].id,
    "the served bytes hash to the artifact's content id",
  );
  assert.equal(Buffer.from(bytes.slice(0, 5)).toString(), "%PDF-");
  // Advance through the route creates the successor; the frontier task it
  // returns is queued, so it is cancelled to keep later worker ticks clean
  // (the succeeded authorization task is already terminal).
  const advance = await server.app.request(
    `/api/clapp/reconstructions/${createdBody.reconstruction.id}/advance`,
    { method: "POST", headers },
  );
  assert.equal(advance.status, 200);
  const advanceBody = (await advance.json()) as { stage: string; task: AgentTask };
  assert.equal(advanceBody.stage, "capture");
  await server.agent.control(owner, advanceBody.task.id, "cancel");
  // A foreign owner discovers nothing: no cross-owner leak.
  const foreignToken = randomBytes(32).toString("base64url");
  await db.put("system", "sessions", {
    id: createHash("sha256").update(foreignToken).digest("hex"),
    owner: "other-user",
    expiresAt: Date.now() + 3600000,
  });
  const foreignHeaders = {
    Authorization: `Bearer ${foreignToken}`,
    "Content-Type": "application/json",
  };
  const foreignStatus = await server.app.request(
    `/api/clapp/reconstructions/${createdBody.reconstruction.id}`,
    { headers: foreignHeaders },
  );
  assert.equal(foreignStatus.status, 404);
  const foreignList = await server.app.request("/api/clapp/reconstructions", {
    headers: foreignHeaders,
  });
  assert.equal(foreignList.status, 200);
  assert.deepEqual((await foreignList.json()) as unknown[], []);
  const foreignAdvance = await server.app.request(
    `/api/clapp/reconstructions/${createdBody.reconstruction.id}/advance`,
    { method: "POST", headers: foreignHeaders },
  );
  assert.equal(foreignAdvance.status, 404);
});

// ---------------------------------------------------------------------------
// 8. The full M0 loop
// ---------------------------------------------------------------------------

test("full M0 loop", async () => {
  const skeleton = createSkeletonStageExecutor({ readSpec: repositories.findSpec });
  const worker = workerFor(chainFor(skeleton.executor));
  const { reconstruction } = await service.createReconstruction(owner, validSpec());
  await worker.tick();
  const first = await service.advance(owner, reconstruction.id);
  const again = await service.advance(owner, reconstruction.id);
  assert.equal(again.task.id, first.task.id);
  for (let stage = 0; stage < 8; stage++) {
    await worker.tick();
    await service.advance(owner, reconstruction.id);
    // Durable artifacts at every step: every completed stage has recorded its
    // artifact, and the chain grows exactly one row per advance.
    const mid = await service.status(owner, reconstruction.id);
    assert.equal(mid.ledger.length, stage + 3);
    for (let completed = 0; completed <= stage + 1; completed++)
      assert.equal(mid.ledger[completed]?.artifactIds.length, 1);
  }
  await worker.tick();
  const final = await service.status(owner, reconstruction.id);
  assert.equal(final.run.runStatus, "succeeded");
  assert.equal(final.complete, true);
  assert.equal(final.run.malformed, 0);
  assert.equal(final.run.stages.length, 10);
  assert.ok(final.run.stages.every((stage) => stage.status === "succeeded"));
  assert.equal(final.run.lastCompletedStage, "promote");
  // Exactly one execution per stage — no duplicates anywhere in the loop.
  assert.equal(skeleton.invocations(), 10);
  const chain = await repositories.stageTasks(owner, reconstruction.id);
  assert.equal(chain.length, 10);
  assert.ok(chain.every((task) => task.status === "succeeded" && task.attempts === 1));
  // Ten distinct, content-addressed, durable artifacts.
  assert.equal(final.ledger.length, 10);
  const artifactIds = final.artifacts.map((artifact) => artifact.id);
  assert.equal(new Set(artifactIds).size, 10);
  assert.ok(final.artifacts.every((artifact) => artifact.reconstructionId === reconstruction.id));
  // The finished chain is terminal: advancing and controlling are rejected.
  await assert.rejects(() => service.advance(owner, reconstruction.id), /final stage/);
  await assert.rejects(
    () => service.control(owner, reconstruction.id, "pause"),
    /terminal.*no longer accepts control|no longer accepts control/,
  );
});
