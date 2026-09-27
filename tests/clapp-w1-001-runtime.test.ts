import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { PDFDocument } from "pdf-lib";
import { createApp } from "../apps/server/src/app.ts";
import { BrowserService } from "../apps/server/src/browser.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { TaskWorker } from "../apps/server/src/engine/worker.ts";
import type { ReconstructionSpec, StageRecord } from "../packages/clapp-contracts/src/index.ts";
import {
  type ClappAgentTaskLike,
  type ClappFallbackHandler,
  ClappHandleNotProvidedError,
  ClappRuntimeError,
  type ClappTaskHandler,
  createClappTaskHandler,
  createOpenMuseRuntime,
  type OpenMuseRuntime,
  type StageExecutor,
} from "../packages/clapp-runtime-openmuse/src/index.ts";
import type { AgentTask } from "../packages/domain/src/agent.ts";

/**
 * CLAPP-W1-001 — durable OpenMuse runtime adapter.
 *
 * Integration tests use real substrate adapters (worker-protocol rule): a real
 * in-process store (createStore), a real AgentService built by createApp, and
 * real TaskWorker instances with short leases driving the CLAPP handler. The
 * AgentService's own worker is never started; the CLAPP handler replaces the
 * execution seam exactly as a production wiring would.
 */
const owner = "local-user";
const RUN_EVENT_KINDS = new Set([
  "plan",
  "step",
  "observation",
  "approval",
  "result",
  "error",
  "status",
]);

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

/** An executor that records invocations and can hang on the first attempt until aborted. */
function executorFixture(options: { artifacts?: string[]; hangFirst?: boolean } = {}) {
  const artifacts = options.artifacts ?? ["art-1"];
  let invocations = 0;
  let signalStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  let captured: { record?: unknown; providers?: unknown } = {};
  const executor: StageExecutor = {
    async execute(input, providers, context) {
      invocations += 1;
      captured = {
        // Read the durable task mid-stage to prove the pre-attempt checkpoint landed.
        record: (await readTasks(input.reconstructionId))[0]?.task.state.clappStage,
        providers,
      };
      if (options.hangFirst && invocations === 1) {
        signalStarted?.();
        await new Promise<never>((_resolve, reject) =>
          context.signal.addEventListener("abort", () => {
            reject(new Error("stage interrupted by abort"));
          }),
        );
      }
      return { outputArtifactIds: artifacts };
    },
  };
  return {
    executor,
    started,
    get invocations() {
      return invocations;
    },
    get captured() {
      return captured;
    },
  };
}

const mustNotDelegate: ClappFallbackHandler = async () => ({
  status: "failed",
  error: "the fallback handler must not receive CLAPP tasks",
});

const handlerFor = (executor: StageExecutor, fallback: ClappFallbackHandler = mustNotDelegate) =>
  createClappTaskHandler({ executor, fallback, runtime, readTasks });

const workerFor = (handler: ClappTaskHandler) =>
  new TaskWorker(db, handler, { leaseMs: 90, pollMs: 20 });

const clappTask = (reconstructionId: string, stage: string, prompt: string) =>
  server.agent.createTask(owner, {
    prompt,
    kind: "agent",
    input: { specVersion: "0.1", reconstructionId, stage },
  });

const eventsOf = async (taskId: string) => (await server.agent.detail(owner, taskId)).events;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "openmuse-clapp-w1-001-"));
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

test("clapp task runs a stage durably", async () => {
  const fixture = executorFixture({ artifacts: ["art-a", "art-b"] });
  const task = await clappTask("recon-durable", "explore", "Run the explore stage durably");
  const worker = workerFor(handlerFor(fixture.executor));
  await worker.tick();
  assert.equal(fixture.invocations, 1);
  const saved = await server.agent.getTask(owner, task.id);
  assert.equal(saved.status, "succeeded");
  assert.match(saved.result ?? "", /explore/);
  assert.match(saved.result ?? "", /recon-durable/);
  const record = saved.state.clappStage as StageRecord;
  assert.equal(record.reconstructionId, "recon-durable");
  assert.equal(record.stage, "explore");
  assert.equal(record.status, "succeeded");
  assert.equal(record.id, "recon-durable:explore");
  assert.ok(record.startedAt);
  assert.ok(record.finishedAt);
  assert.deepEqual(record.outputArtifactIds, ["art-a", "art-b"]);
  assert.deepEqual(record.inputArtifactIds, []);
  // The pre-attempt "running" checkpoint was durable before the executor ran.
  const midStage = fixture.captured.record as StageRecord | undefined;
  assert.equal(midStage?.status, "running");
  assert.ok(midStage?.startedAt);
  assert.deepEqual(saved.artifactIds, ["art-a", "art-b"]);
  const events = await eventsOf(task.id);
  assert.ok(events.length >= 3);
  assert.ok(events.every((event) => RUN_EVENT_KINDS.has(event.kind)));
  assert.ok(events.some((event) => event.kind === "step" && /started/.test(event.title)));
  assert.ok(events.some((event) => event.kind === "step" && /succeeded/.test(event.title)));
  assert.ok(events.some((event) => event.kind === "result"));
});

test("restart reconciles without re-executing a succeeded stage", async () => {
  const fixture = executorFixture({ artifacts: ["art-x"] });
  const handler = handlerFor(fixture.executor);
  const task = await clappTask(
    "recon-restart",
    "capture",
    "Capture evidence for the restart check",
  );
  const first = workerFor(handler);
  await first.tick();
  assert.equal(fixture.invocations, 1);
  assert.equal((await server.agent.getTask(owner, task.id)).status, "succeeded");
  // Simulate a crash between the stage commit and the task commit: the durable
  // task goes back to a dead running lease while the stage record stays succeeded.
  await db.compareAndSwap(
    owner,
    "tasks",
    task.id,
    { status: "succeeded", leaseId: null },
    { status: "running", leaseId: "dead-worker", leaseUntil: "2020-01-01T00:00:00.000Z" },
  );
  const second = workerFor(handler);
  await second.tick();
  assert.equal(fixture.invocations, 1, "a succeeded stage must never re-execute");
  const saved = await server.agent.getTask(owner, task.id);
  assert.equal(saved.status, "succeeded");
  assert.equal(saved.attempts, 2, "attempts increment across re-deliveries and never reset");
  assert.deepEqual(saved.artifactIds, ["art-x"]);
  assert.equal((saved.state.clappStage as StageRecord).status, "succeeded");
  assert.deepEqual((saved.state.clappStage as StageRecord).outputArtifactIds, ["art-x"]);
  const events = await eventsOf(task.id);
  assert.ok(events.some((event) => event.kind === "status" && /reconciled/.test(event.title)));
  assert.ok(events.every((event) => RUN_EVENT_KINDS.has(event.kind)));
});

test("pause/cancel leaves durable state clean", async () => {
  // Pause mid-stage: the signal-honoring executor is interrupted, the stage
  // record becomes "cancelled" with no partial success, and resume re-runs.
  const pauseFixture = executorFixture({ artifacts: ["after-resume"], hangFirst: true });
  const pauseTask = await clappTask("recon-pause", "explore", "Pause this stage mid-flight");
  const pausingWorker = workerFor(handlerFor(pauseFixture.executor));
  const tick = pausingWorker.tick();
  await pauseFixture.started;
  await server.agent.control(owner, pauseTask.id, "pause");
  await tick.catch(() => {});
  const paused = await server.agent.getTask(owner, pauseTask.id);
  assert.equal(paused.status, "paused");
  assert.equal(paused.leaseId, null);
  const cancelledRecord = paused.state.clappStage as StageRecord;
  assert.equal(cancelledRecord.status, "cancelled");
  assert.deepEqual(cancelledRecord.outputArtifactIds, []);
  assert.ok(cancelledRecord.finishedAt);
  const pauseEvents = await eventsOf(pauseTask.id);
  assert.ok(pauseEvents.some((event) => /cancelled/.test(event.title)));
  assert.ok(pauseEvents.every((event) => RUN_EVENT_KINDS.has(event.kind)));
  // Retry (resume) re-runs the stage and completes.
  await server.agent.control(owner, pauseTask.id, "resume");
  const resumingWorker = workerFor(handlerFor(pauseFixture.executor));
  await resumingWorker.tick();
  assert.equal(pauseFixture.invocations, 2);
  const resumed = await server.agent.getTask(owner, pauseTask.id);
  assert.equal(resumed.status, "succeeded");
  assert.equal(resumed.attempts, 2);
  assert.deepEqual(resumed.artifactIds, ["after-resume"]);
  assert.equal((resumed.state.clappStage as StageRecord).status, "succeeded");

  // Cancel mid-stage: same clean durable shape, terminal.
  const cancelFixture = executorFixture({ artifacts: ["never-claimed"], hangFirst: true });
  const cancelTask = await clappTask("recon-cancel", "verify", "Cancel this stage mid-flight");
  const cancellingWorker = workerFor(handlerFor(cancelFixture.executor));
  const cancelTick = cancellingWorker.tick();
  await cancelFixture.started;
  await server.agent.control(owner, cancelTask.id, "cancel");
  await cancelTick.catch(() => {});
  const cancelled = await server.agent.getTask(owner, cancelTask.id);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.leaseId, null);
  assert.equal(cancelFixture.invocations, 1);
  const record = cancelled.state.clappStage as StageRecord;
  assert.equal(record.status, "cancelled");
  assert.deepEqual(record.outputArtifactIds, []);
  const cancelEvents = await eventsOf(cancelTask.id);
  assert.ok(cancelEvents.some((event) => /cancelled/.test(event.title)));
  assert.ok(cancelEvents.every((event) => RUN_EVENT_KINDS.has(event.kind)));
});

test("bind validation fails closed", async () => {
  const fullDeps = {
    browserSession,
    computer: server.computer,
    files: server.files,
    agent: server.agent,
    db,
  };
  // A present computer handle missing the required execute/mkdir capabilities.
  assert.throws(
    () => createOpenMuseRuntime({ ...fullDeps, computer: {} }),
    (error: unknown) => {
      assert.ok(error instanceof ClappRuntimeError);
      assert.match(error.provider, /computer/);
      assert.match(error.capability, /execute/);
      assert.match(error.message, /execute/);
      return true;
    },
  );
  // A present db handle missing the required scan capability.
  assert.throws(
    () =>
      createOpenMuseRuntime({
        ...fullDeps,
        db: { get: () => {}, put: () => {}, compareAndSwap: () => {}, remove: () => {} },
      }),
    (error: unknown) => {
      assert.ok(error instanceof ClappRuntimeError);
      assert.match(error.provider, /db/);
      assert.match(error.capability, /scan/);
      return true;
    },
  );
  // Absent handles are explicitly optional: bind succeeds and the provider
  // throws a typed "not provided" error at call time (never a silent no-op).
  const partial = createOpenMuseRuntime({ ...fullDeps, computer: undefined });
  await assert.rejects(
    partial.execution.run({
      reconstructionId: "recon-bind",
      cwd: "/workspace",
      command: "true",
      timeoutMs: 1000,
      network: "deny",
    }),
    (error: unknown) => {
      assert.ok(error instanceof ClappHandleNotProvidedError);
      assert.match(error.message, /not provided/);
      return true;
    },
  );
});

test("artifact roundtrip is content-addressed", async () => {
  const document = await PDFDocument.create();
  document.addPage();
  document.setTitle("CLAPP artifact roundtrip");
  const bytes = new Uint8Array(await document.save());
  // Artifacts resolve their owning workspace from the durable task that
  // carries the reconstruction.
  const helperTask = await clappTask(
    "recon-art",
    "capture",
    "Capture an artifact for the roundtrip",
  );
  const reference = await runtime.artifacts.put({
    reconstructionId: "recon-art",
    kind: "page-text",
    bytes,
    metadata: { targetId: "target-art", source: "https://example.test/page" },
  });
  const digest = createHash("sha256").update(bytes).digest("hex");
  assert.equal(reference.sha256, digest);
  assert.equal(reference.id, digest);
  assert.equal(reference.targetId, "target-art");
  assert.equal(reference.reconstructionId, "recon-art");
  assert.equal(reference.kind, "page-text");
  assert.equal(reference.classification, "observed");
  assert.equal(reference.redacted, false);
  assert.ok(reference.source);
  assert.ok(reference.capturedAt);
  const stored = await runtime.artifacts.get(reference.id);
  assert.equal(createHash("sha256").update(stored).digest("hex"), digest);
  assert.ok(Buffer.from(stored).equals(Buffer.from(bytes)));
  // Re-putting identical bytes is idempotent content addressing.
  const again = await runtime.artifacts.put({
    reconstructionId: "recon-art",
    kind: "page-text",
    bytes,
    metadata: { targetId: "target-art" },
  });
  assert.equal(again.id, reference.id);
  assert.equal(again.sha256, digest);
  // An explicit classification on genuinely different bytes is honored.
  const derivedDocument = await PDFDocument.create();
  derivedDocument.addPage();
  derivedDocument.addPage();
  derivedDocument.setTitle("CLAPP derived artifact");
  const derived = await runtime.artifacts.put({
    reconstructionId: "recon-art",
    kind: "page-text",
    bytes: new Uint8Array(await derivedDocument.save()),
    metadata: { targetId: "target-art", classification: "derived" },
  });
  assert.equal(derived.classification, "derived");
  await assert.rejects(runtime.artifacts.get("unknown-artifact-id"), (error: unknown) => {
    assert.ok(error instanceof ClappRuntimeError);
    assert.match(error.message, /unknown-artifact-id/);
    return true;
  });
  // The helper task stays out of later workers' queues.
  await server.agent.control(owner, helperTask.id, "cancel");
});

test("unavailable evidence stays unavailable", async () => {
  // A browserSession handle that can observe pages but lacks the screenshot
  // (preview) channel: that channel must stay "unavailable", never "observed".
  const lacking = createOpenMuseRuntime({
    browserSession: {
      observe: async (_owner: string, url: string) => ({
        sessionId: "session-1",
        url,
        title: "Observed page",
        text: "The genuinely captured page text",
        truncated: false,
      }),
    },
    computer: undefined,
    files: undefined,
    agent: undefined,
    db,
  });
  const spec: ReconstructionSpec = {
    specVersion: "0.1",
    reconstructionId: "recon-obs",
    targetId: "target-obs",
    name: "Observation honesty check",
    platform: "web",
    entrypoints: ["https://example.test/"],
    authorization: {
      ownerId: owner,
      targetId: "target-obs",
      scope: ["read"],
      environments: ["production"],
      retention: "project",
      benchmarkOwned: false,
      createdAt: new Date().toISOString(),
    },
    exploration: { maxStages: 1, maxActions: 10, maxDurationMs: 1000, seed: 1 },
    synthesis: { targetStack: "web", allowNetwork: false, packagePolicy: "verified-only" },
    verification: {
      journeys: [],
      visual: true,
      network: false,
      state: true,
      maxRepairIterations: 1,
    },
  };
  const bundle = await lacking.observation.observe(spec);
  assert.equal(bundle.reconstructionId, "recon-obs");
  assert.equal(bundle.targetId, "target-obs");
  assert.ok(bundle.id);
  assert.ok(bundle.rootSha256);
  const screenshot = bundle.refs.find((ref) => ref.kind === "screenshot");
  assert.ok(screenshot, "the unavailable channel must appear in the bundle");
  assert.equal(screenshot.classification, "unavailable");
  assert.ok(screenshot.sha256);
  const page = bundle.refs.find((ref) => ref.kind === "page-text");
  assert.ok(page);
  assert.equal(page.classification, "observed");
  assert.equal(
    page.sha256,
    createHash("sha256").update(`Observed page\nThe genuinely captured page text`).digest("hex"),
  );
  assert.ok(
    bundle.refs.every((ref) => ref.classification !== "observed" || ref.kind === "page-text"),
  );
});

test("non-clapp tasks delegate unchanged", async () => {
  let fallbackRuns = 0;
  let observedTask: AgentTask | undefined;
  const fallback: ClappFallbackHandler = async (_owner, task, context) => {
    fallbackRuns += 1;
    observedTask = task as AgentTask;
    await context.event("status", "Fallback ran");
    return { status: "succeeded", result: "fallback result" };
  };
  const fixture = executorFixture({ artifacts: ["must-not-run"] });
  const handler = createClappTaskHandler({
    executor: fixture.executor,
    fallback,
    runtime,
    readTasks,
  });
  const task = await server.agent.createTask(owner, {
    prompt: "Summarize the imported spending",
    kind: "finance",
    input: { csv: "date,amount\n2024-01-01,10.50\n2024-01-02,-3.25" },
  });
  const worker = workerFor(handler);
  await worker.tick();
  assert.equal(fallbackRuns, 1);
  assert.equal(fixture.invocations, 0);
  assert.equal(observedTask?.id, task.id);
  const saved = await server.agent.getTask(owner, task.id);
  assert.equal(saved.status, "succeeded");
  assert.equal(saved.result, "fallback result");
  assert.equal(saved.state.clappStage, undefined);
  assert.ok((await eventsOf(task.id)).some((event) => event.title === "Fallback ran"));
});

test("invalid clapp input fails the task instead of guessing", async () => {
  const fixture = executorFixture({ artifacts: ["must-not-run"] });
  const task = await server.agent.createTask(owner, {
    prompt: "An ambiguous clapp-shaped task",
    kind: "agent",
    input: { specVersion: "0.9", reconstructionId: "recon-invalid", stage: "explore" },
  });
  const worker = workerFor(handlerFor(fixture.executor));
  await worker.tick();
  assert.equal(fixture.invocations, 0);
  const saved = await server.agent.getTask(owner, task.id);
  assert.equal(saved.status, "failed");
  assert.match(saved.error ?? "", /ClappTaskInput/);
  assert.match(saved.error ?? "", /specVersion/);
  assert.equal(saved.state.clappStage, undefined);
  assert.ok((await eventsOf(task.id)).some((event) => event.kind === "error"));
});
