import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createApp } from "../apps/server/src/app.ts";
import { getLearningReport } from "../apps/server/src/clapp/catalog-writers.ts";
import {
  createClappAuthorizationStore,
  createInMemoryPackageStore,
} from "../apps/server/src/clapp/executor-stores.ts";
import {
  createRealStageExecutor,
  decodeStagePayload,
  type PlanStageCompositionRecord,
  type RealStageExecutorDeps,
  type StageArtifactPayload,
} from "../apps/server/src/clapp/executors.ts";
import {
  createServiceWalkDriver,
  runRepeatedBuildExperiment,
} from "../apps/server/src/clapp/experiment.ts";
import {
  type ClappRepositories,
  createClappRepositories,
} from "../apps/server/src/clapp/repositories.ts";
import { type ClappService, createClappService } from "../apps/server/src/clapp/service.ts";
import { createClappReadTasks, createClappWorkerHandler } from "../apps/server/src/clapp/worker.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import {
  CANONICAL_BENCHMARKS,
  createBenchmarkHarness,
} from "../packages/clapp-benchmarks/src/index.ts";
import type {
  ClappStage,
  EvidenceBundle,
  EvidenceRef,
  ReconstructionSpec,
  SynthesisPlan,
} from "../packages/clapp-contracts/src/index.ts";
import {
  buildCompatGraph,
  buildLearningComparison,
  classifyFromIr,
  createPackageRegistry,
  deserializeBehavioralIr,
  LEARNING_SIGNAL_IDS,
  type PackageStore,
} from "../packages/clapp-intelligence/src/index.ts";
import {
  type AuthorizationStore,
  createBrowserObservationAdapter,
} from "../packages/clapp-observation/src/index.ts";
import {
  CLAPP_STAGES,
  type OpenMuseRuntime,
  readClappRunState,
} from "../packages/clapp-runtime-openmuse/src/index.ts";
import {
  bindPairedSide,
  deserializeSynthesisPlan,
  type PairedSide,
  planComposition,
  planSynthesisApp,
} from "../packages/clapp-synthesis/src/index.ts";

/**
 * CLAPP-W3-016 — the repeated-build experiment route.
 *
 * 7 deterministic node:test cases (real-substrate style, the W3-013 precedent):
 *
 * (a) the retrieval: the plan stage's artifact carries the composition record
 *     and planSynthesisApp received the composed set (pinned against the frozen
 *     functions' outputs over the same registry snapshot).
 * (b) the empty-registry honesty: the composed set is empty, recorded verbatim,
 *     the plan proceeds with today's behavior.
 * (c) the scratch walk runs the chain without learning (pinned).
 * (d) the rebuild walk's plan stage carries the composed set.
 * (e) the comparison attaches VERBATIM (the report's comparison deep-equals
 *     buildLearningComparison's output over the two builds).
 * (f) the per-signal compounding record + the learning-disabled control (the
 *     report's own frozen semantics).
 * (g) durability: the report round-trips through the content-addressed store
 *     and a re-run produces a fresh report (no silent mutation).
 *
 * The walks use the REAL stage executor over the REAL B01 benchmark harness
 * (the W3-013 chain-walk pattern), with the self-reference paired-side binding
 * (the generated candidate as both sides — the W3-013 equivalent-reference
 * pattern, disclosed: a real "equivalent" verdict, never a claim of real target
 * parity). The candidate seam runs the REAL `node --check` + the repo's `tsx
 * --test` over the generated suite. No Docker, no network.
 */

const REPOSITORY_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OWNER = "local-user";
const B01 = CANONICAL_BENCHMARKS[0];
if (B01 === undefined) throw new Error("canonical benchmark B01 missing");
const FIXED_MS = 1735689600000; // 2025-01-01T00:00:00.000Z — the pinned clock
const FIXED_ISO = new Date(FIXED_MS).toISOString();
const fixedClock = () => FIXED_MS;

let db: Store;
let server: Awaited<ReturnType<typeof createApp>>;
let repositories: ClappRepositories;
let service: ClappService;
let authorizationStore: AuthorizationStore;
const temporaryDirectories: string[] = [];

// ---------------------------------------------------------------------------
// The scripted providers (the W3-013 precedent — real seams, no hidden state)
// ---------------------------------------------------------------------------

const sha256Of = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

function scriptedArtifactsProvider() {
  const stored = new Map<string, { bytes: Uint8Array; reference: EvidenceRef }>();
  return {
    stored,
    async put(input: {
      reconstructionId: string;
      kind: string;
      bytes: Uint8Array;
      metadata: Record<string, string>;
    }): Promise<EvidenceRef> {
      const { PDFDocument } = await import("pdf-lib");
      await PDFDocument.load(input.bytes);
      const sha256 = sha256Of(input.bytes);
      const existing = stored.get(sha256);
      if (existing) return existing.reference;
      const reference: EvidenceRef = {
        id: sha256,
        targetId: input.metadata.targetId,
        reconstructionId: input.reconstructionId,
        kind: input.kind,
        sha256,
        source: input.metadata.source ?? "scripted:artifacts",
        capturedAt: FIXED_ISO,
        classification: (input.metadata.classification ??
          "observed") as EvidenceRef["classification"],
        redacted: false,
      };
      stored.set(sha256, { bytes: input.bytes, reference });
      return reference;
    },
    async get(id: string): Promise<Uint8Array> {
      const entry = stored.get(id);
      if (!entry) throw new Error(`no scripted artifact stored under content id "${id}"`);
      return entry.bytes;
    },
  };
}

const artifacts = scriptedArtifactsProvider();

function pageTitle(html: string): string {
  const match = /<title>([\s\S]*?)<\/title>/i.exec(html);
  return match === null ? "" : match[1].trim();
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The W1-002 fake-handle shape bound to REAL served content (the W3-013 pattern). */
function realPageHandle(baseUrl: () => string) {
  const SESSION_ID = "00000000-w3-016-0000-000000000001";
  let currentRoute = "about:blank";
  return {
    async create(_owner: string, url: string) {
      currentRoute = url;
      return {
        id: SESSION_ID,
        title: "Benchmark session",
        url,
        status: "idle",
        updatedAt: FIXED_ISO,
      };
    },
    async navigate(_owner: string, id: string, url: string) {
      if (id !== SESSION_ID) throw new Error(`unknown session ${id}`);
      currentRoute = url;
      return { id, title: "Benchmark session", url, status: "idle", updatedAt: FIXED_ISO };
    },
    async read(_owner: string, id: string) {
      if (id !== SESSION_ID) throw new Error(`unknown session ${id}`);
      const response = await fetch(`${baseUrl()}${currentRoute}`);
      const html = await response.text();
      if (!response.ok)
        throw new Error(`benchmark route ${currentRoute} responded ${response.status}`);
      return {
        url: currentRoute,
        title: pageTitle(html),
        text: htmlToText(html),
        truncated: false,
      };
    },
  };
}

/** The REAL W1-002 browser observation adapter reading the REAL B01 harness over loopback. */
async function observeB01(spec: ReconstructionSpec, signal?: AbortSignal): Promise<EvidenceBundle> {
  const started = await createBenchmarkHarness(B01).start();
  try {
    const adapter = createBrowserObservationAdapter({
      ownerId: OWNER,
      browser: realPageHandle(() => started.baseUrl),
      now: fixedClock,
    });
    return await adapter.observe(spec, signal);
  } finally {
    await started.stop();
  }
}

function scriptedCandidateSeam() {
  const directoriesByPath = new Map<string, string>();
  let counter = 0;
  const workspaces = {
    async create(input: { reconstructionId: string; kind: "reference" | "candidate" }) {
      counter += 1;
      const id = `scripted-ws-${counter}`;
      const directory = await mkdtemp(join(tmpdir(), "clapp-w3-016-ws-"));
      temporaryDirectories.push(directory);
      const path = `/workspace/clapp/${input.kind}-w3-016-${id}`;
      directoriesByPath.set(path, directory);
      return { id, path };
    },
    async seedWorkspaceFile(input: {
      reconstructionId: string;
      workspaceId: string;
      path: string;
      content: string;
    }) {
      const directory = [...directoriesByPath.entries()].find(([workspacePath]) =>
        workspacePath.endsWith(input.workspaceId),
      )?.[1];
      if (directory === undefined)
        throw new Error(`unknown scripted workspace ${input.workspaceId}`);
      const target = join(directory, input.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, input.content, "utf8");
      return { path: input.path, bytes: input.content.length, chunks: 1 };
    },
    async destroy(id: string) {
      for (const [path] of [...directoriesByPath.entries()])
        if (path.endsWith(id)) directoriesByPath.delete(path);
    },
    async listWorkspaceFiles() {
      throw new Error("the scripted seam does not implement listWorkspaceFiles");
    },
    async discoverWorkspaces() {
      throw new Error("the scripted seam does not implement discoverWorkspaces");
    },
  };
  const execution = {
    async runCandidateBuild(input: {
      reconstructionId: string;
      cwd: string;
      build: string;
      test?: string;
      timeoutMs: number;
    }) {
      const directory = [...directoriesByPath.entries()].find(([workspacePath]) =>
        workspacePath.endsWith(input.cwd),
      )?.[1];
      if (directory === undefined) throw new Error(`no scripted workspace for cwd "${input.cwd}"`);
      const steps: {
        name: string;
        command: string;
        exitCode: number;
        stdout: string;
        stderr: string;
        artifacts: string[];
      }[] = [];
      const build = spawnSync(process.execPath, ["--check", "server.ts"], {
        cwd: directory,
        encoding: "utf8",
        timeout: input.timeoutMs,
      });
      steps.push({
        name: "build",
        command: input.build,
        exitCode: build.status ?? 1,
        stdout: "",
        stderr: (build.stderr ?? "").slice(0, 2000),
        artifacts: [],
      });
      let exitCode = steps[0].exitCode;
      if (exitCode === 0 && input.test !== undefined) {
        const suite = spawnSync(
          join(REPOSITORY_ROOT, "node_modules", ".bin", "tsx"),
          ["--test", "journeys.test.ts"],
          { cwd: directory, encoding: "utf8", timeout: 120_000 },
        );
        steps.push({
          name: "test",
          command: input.test,
          exitCode: suite.status ?? 1,
          stdout: (suite.stdout ?? "").slice(0, 2000),
          stderr: (suite.stderr ?? "").slice(0, 2000),
          artifacts: [],
        });
        exitCode = steps[steps.length - 1].exitCode;
      }
      return { steps, exitCode, succeeded: exitCode === 0, artifacts: [], harvestFailures: [] };
    },
    async run() {
      throw new Error("the scripted seam does not implement run");
    },
    async harvestWorkspaceArtifacts() {
      throw new Error("the scripted seam does not implement harvestWorkspaceArtifacts");
    },
  };
  return { workspaces, execution };
}

async function makeDirectory(files: { path: string; content: string }[]): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-clapp-w3-016-side-"));
  temporaryDirectories.push(directory);
  for (const file of files) {
    const target = join(directory, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content, "utf8");
  }
  return directory;
}

async function materializeSide(plan: SynthesisPlan): Promise<PairedSide> {
  const { generateCandidateApp } = await import("../packages/clapp-synthesis/src/index.ts");
  const generated = generateCandidateApp(plan);
  const directory = await makeDirectory(generated.files);
  const serverModule = (await import(pathToFileURL(join(directory, "server.ts")).href)) as {
    start: (port?: number) => Promise<{ port: number; close: () => Promise<void> }>;
  };
  return bindPairedSide(
    {
      start: async () => {
        const handle = await serverModule.start(0);
        return {
          port: handle.port,
          baseUrl: `http://127.0.0.1:${handle.port}`,
          stop: handle.close,
        };
      },
    },
    "candidate",
  );
}

const seam = scriptedCandidateSeam();
const scriptedRuntime: OpenMuseRuntime = {
  observation: { observe: (spec, signal) => observeB01(spec, signal) },
  artifacts,
  tasks: {
    async checkpoint() {
      throw new Error("the happy path never checkpoints through the scripted tasks provider");
    },
    async event() {
      throw new Error("the happy path never events through the scripted tasks provider");
    },
  },
  approvals: {
    async request() {
      throw new Error("the chain never requests approvals through the scripted provider");
    },
  },
  workspaces: seam.workspaces as unknown as OpenMuseRuntime["workspaces"],
  execution: seam.execution as unknown as OpenMuseRuntime["execution"],
};

const selfReferenceSides = {
  reference: (_spec: ReconstructionSpec, plan: SynthesisPlan) => materializeSide(plan),
  candidate: (_spec: ReconstructionSpec, plan: SynthesisPlan) => materializeSide(plan),
};

// ---------------------------------------------------------------------------
// The fixture spec, deps and chain walking
// ---------------------------------------------------------------------------

function specFor(name: string): ReconstructionSpec {
  return {
    specVersion: "0.1",
    reconstructionId: "client-requested-handle",
    targetId: "target-clapp-benchmark-b01",
    name,
    platform: "web",
    entrypoints: B01.routes.map((route) => route.path),
    authorization: {
      ownerId: OWNER,
      targetId: "target-clapp-benchmark-b01",
      scope: ["observe", "reconstruct:ui"],
      environments: ["web", "sandbox"],
      retention: "ephemeral",
      benchmarkOwned: true,
      createdAt: FIXED_ISO,
    },
    exploration: { maxStages: 4, maxActions: 64, maxDurationMs: 300_000, seed: 7 },
    synthesis: { targetStack: "static-web", allowNetwork: false, packagePolicy: "verified-only" },
    verification: {
      journeys: B01.routes.map((r) => `visit:${r.path}`),
      visual: false,
      network: true,
      state: true,
      maxRepairIterations: 2,
    },
  };
}

function chainDeps(options?: {
  packageStore?: PackageStore;
  pairedSides?: typeof selfReferenceSides;
}): RealStageExecutorDeps {
  return {
    readSpec: repositories.findSpec,
    readTasks: createClappReadTasks(db),
    authorizationStore,
    packageStore: options?.packageStore ?? createInMemoryPackageStore(),
    ...(options?.pairedSides !== undefined ? { pairedSides: options.pairedSides } : {}),
    now: fixedClock,
  };
}

/** Reads a stage's payload from the durable chain. */
async function stagePayloadOf(
  reconstructionId: string,
  stage: ClappStage,
): Promise<StageArtifactPayload> {
  const tasks = await repositories.stageTasks(OWNER, reconstructionId);
  const state = readClappRunState(tasks);
  const entry = state.stages.find((row) => row.stage === stage);
  assert.ok(entry, `the ${stage} stage has a record`);
  const id = entry.outputArtifactIds[0];
  assert.ok(id, `the ${stage} stage recorded an output artifact`);
  return decodeStagePayload(await artifacts.get(id));
}

/** Reads the plan stage's composition record (the SECOND artifact). */
async function compositionRecordOf(reconstructionId: string): Promise<PlanStageCompositionRecord> {
  const tasks = await repositories.stageTasks(OWNER, reconstructionId);
  const state = readClappRunState(tasks);
  const entry = state.stages.find((row) => row.stage === "plan");
  assert.ok(entry, "the plan stage has a record");
  const ids = entry.outputArtifactIds;
  assert.ok(ids[1], "the plan stage recorded a second (composition) artifact");
  const payload = await decodeStagePayload(await artifacts.get(ids[1]));
  return payload.output as PlanStageCompositionRecord;
}

/**
 * Drives one chain walk through the real service + worker (the W3-013
 * walkChain pattern). Returns the reconstruction id.
 */
async function walkChain(spec: ReconstructionSpec, packageStore: PackageStore): Promise<string> {
  const executor = createRealStageExecutor(
    chainDeps({ packageStore, pairedSides: selfReferenceSides }),
  );
  const handler = createClappWorkerHandler({
    db,
    runtime: scriptedRuntime,
    executor: executor.executor,
    fallback: async () => {
      throw new Error("the fallback handler must not receive CLAPP tasks");
    },
  });
  const { TaskWorker } = await import("../apps/server/src/engine/worker.ts");
  const worker = new TaskWorker(db, handler, { leaseMs: 5000, pollMs: 20 });
  const created = await service.createReconstruction(OWNER, spec);
  const reconstructionId = created.reconstruction.id;
  for (let iteration = 0; iteration < CLAPP_STAGES.length + 4; iteration += 1) {
    await worker.tick();
    const tasks = await repositories.stageTasks(OWNER, reconstructionId);
    const state = readClappRunState(tasks);
    const lastStage = state.stages[state.stages.length - 1];
    if (lastStage === undefined) continue;
    if (lastStage.status === "failed")
      throw new Error(
        `the walk's ${lastStage.stage} stage failed: ${lastStage.error ?? "no error"}`,
      );
    if (lastStage.status === "succeeded" && state.stages.length === CLAPP_STAGES.length) break;
    if (lastStage.status === "succeeded") await service.advance(OWNER, reconstructionId);
  }
  return reconstructionId;
}

/**
 * Creates a walk driver + tick function for the experiment runner: one
 * dedicated TaskWorker (created once, reused across all ticks) with the REAL
 * stage executor over the shared packageStore + self-reference paired sides.
 * The experiment runner calls `walk(spec)` twice (scratch + rebuild); each
 * walk drives the worker tick-by-tick through the service's advance loop.
 */
async function makeExperimentWalker(packageStore: PackageStore): Promise<{
  walk: (spec: ReconstructionSpec) => Promise<string>;
}> {
  const executor = createRealStageExecutor(
    chainDeps({ packageStore, pairedSides: selfReferenceSides }),
  );
  const handler = createClappWorkerHandler({
    db,
    runtime: scriptedRuntime,
    executor: executor.executor,
    fallback: async () => {
      throw new Error("the fallback handler must not receive CLAPP tasks");
    },
  });
  const { TaskWorker } = await import("../apps/server/src/engine/worker.ts");
  const worker = new TaskWorker(db, handler, { leaseMs: 5000, pollMs: 20 });
  const walk = createServiceWalkDriver({
    service,
    repositories,
    owner: OWNER,
    tick: () => worker.tick(),
  });
  return { walk };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

before(async () => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-clapp-w3-016-"));
  temporaryDirectories.push(directory);
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
  repositories = createClappRepositories(db);
  service = createClappService({
    db,
    agent: server.agent,
    runtime: {},
    repositories,
  });
  authorizationStore = createClappAuthorizationStore(db);
});

after(async () => {
  await server?.agent?.stop();
  await db?.close();
  for (const directory of temporaryDirectories)
    await rm(directory, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// (a) the retrieval: the plan stage's artifact carries the composition record
// ---------------------------------------------------------------------------

test("(a) the plan stage's artifact carries the composition record and planSynthesisApp received the composed set", async () => {
  const packageStore = createInMemoryPackageStore();
  const reconstructionId = await walkChain(specFor("Aurora (retrieval pin)"), packageStore);

  // Read the model IR and the plan stage's composition record.
  const modelPayload = await stagePayloadOf(reconstructionId, "model");
  assert.equal(typeof modelPayload.output, "string", "the model artifact carries the canonical IR");
  const model = deserializeBehavioralIr(modelPayload.output as string);
  assert.ok(model.ok && model.ir, "the model IR deserializes");

  const compositionRecord = await compositionRecordOf(reconstructionId);
  const spec = await repositories.findSpec(reconstructionId);
  assert.ok(spec, "the spec is readable");

  // Pin the composition record against the frozen planComposition over the same
  // registry snapshot (empty — the scratch walk's promote stage abstained).
  const registry = createPackageRegistry(packageStore);
  const snapshot = registry.list();
  const expectedGraph = buildCompatGraph(snapshot);
  const expectedVerdict = classifyFromIr({ ir: model.ir });
  const expectedComposition = planComposition({
    verdict: { label: expectedVerdict.label, confidence: expectedVerdict.confidence },
    packages: snapshot,
    graph: expectedGraph,
    packagePolicy: spec.synthesis.packagePolicy,
  });
  assert.deepEqual(compositionRecord.plan, expectedComposition);
  assert.equal(compositionRecord.archetypeLabel, expectedVerdict.label);
  assert.equal(compositionRecord.packagePolicy, spec.synthesis.packagePolicy);
  assert.equal(compositionRecord.registrySnapshotSize, snapshot.length);

  // Pin the plan against planSynthesisApp with the composed packageIds.
  const planPayload = await stagePayloadOf(reconstructionId, "plan");
  const plan = deserializeSynthesisPlan(planPayload.output as string);
  assert.ok(plan.ok && plan.plan, "the plan deserializes");
  const expectedPlan = await planSynthesisApp(spec, model.ir, compositionRecord.plan.packageIds);
  assert.deepEqual(plan.plan, expectedPlan);
});

// ---------------------------------------------------------------------------
// (b) the empty-registry honesty
// ---------------------------------------------------------------------------

test("(b) the empty-registry honesty: the composed set is empty, recorded verbatim, the plan proceeds with today's behavior", async () => {
  const packageStore = createInMemoryPackageStore();
  const reconstructionId = await walkChain(specFor("Aurora (empty registry)"), packageStore);

  const compositionRecord = await compositionRecordOf(reconstructionId);
  // The empty registry → the composed set is empty (abstained or fallback).
  assert.deepEqual(compositionRecord.plan.packageIds, []);
  assert.ok(
    compositionRecord.plan.status === "abstained" || compositionRecord.plan.status === "fallback",
    `the empty registry yields an honest abstained/fallback plan (got ${compositionRecord.plan.status})`,
  );
  assert.equal(compositionRecord.registrySnapshotSize, 0);

  // The plan proceeds exactly as today: planSynthesisApp with [] (no packages).
  const modelPayload = await stagePayloadOf(reconstructionId, "model");
  const model = deserializeBehavioralIr(modelPayload.output as string);
  assert.ok(model.ok && model.ir);
  const spec = await repositories.findSpec(reconstructionId);
  assert.ok(spec);
  const planPayload = await stagePayloadOf(reconstructionId, "plan");
  const plan = deserializeSynthesisPlan(planPayload.output as string);
  assert.ok(plan.ok && plan.plan);
  const expectedPlan = await planSynthesisApp(spec, model.ir, []);
  assert.deepEqual(
    plan.plan,
    expectedPlan,
    "the plan equals planSynthesisApp with [] (today's behavior)",
  );
});

// ---------------------------------------------------------------------------
// (c) the scratch walk runs the chain without learning (pinned)
// ---------------------------------------------------------------------------

test("(c) the scratch walk runs the chain without learning (pinned)", async () => {
  const packageStore = createInMemoryPackageStore();
  const scratchId = await walkChain(specFor("Aurora (scratch walk)"), packageStore);

  // The scratch walk completed all 10 stages.
  const tasks = await repositories.stageTasks(OWNER, scratchId);
  const state = readClappRunState(tasks);
  assert.equal(state.stages.length, CLAPP_STAGES.length, "all 10 stages ran");
  assert.equal(state.runStatus, "succeeded", "the scratch walk succeeded");
  for (const entry of state.stages)
    assert.equal(entry.status, "succeeded", `stage ${entry.stage} succeeded`);

  // The scratch walk's plan stage has empty packageIds (no learning — empty registry).
  const compositionRecord = await compositionRecordOf(scratchId);
  assert.deepEqual(
    compositionRecord.plan.packageIds,
    [],
    "the scratch walk composed no packages (empty registry)",
  );
});

// ---------------------------------------------------------------------------
// (d) the rebuild walk's plan stage carries the composed set
// ---------------------------------------------------------------------------

test("(d) the rebuild walk's plan stage carries the composed set", async () => {
  const packageStore = createInMemoryPackageStore();
  // The scratch walk populates the shared packageStore (the promote stage's
  // real extraction + promotion — possibly nothing, the honest v0.1 baseline).
  await walkChain(specFor("Aurora (rebuild scratch)"), packageStore);
  // The rebuild walk's plan stage composes over the same packageStore.
  const rebuildId = await walkChain(specFor("Aurora (rebuild walk)"), packageStore);

  const compositionRecord = await compositionRecordOf(rebuildId);
  // The composition record is present (the retrieval lane ran).
  assert.ok(compositionRecord.plan, "the rebuild walk's plan stage carries a composition plan");
  assert.ok(
    compositionRecord.plan.status === "composed" ||
      compositionRecord.plan.status === "fallback" ||
      compositionRecord.plan.status === "abstained",
    "the composition plan has a valid status",
  );
  // The plan stage's plan was fed the composed packageIds (pin against planSynthesisApp).
  const modelPayload = await stagePayloadOf(rebuildId, "model");
  const model = deserializeBehavioralIr(modelPayload.output as string);
  assert.ok(model.ok && model.ir);
  const spec = await repositories.findSpec(rebuildId);
  assert.ok(spec);
  const planPayload = await stagePayloadOf(rebuildId, "plan");
  const plan = deserializeSynthesisPlan(planPayload.output as string);
  assert.ok(plan.ok && plan.plan);
  const expectedPlan = await planSynthesisApp(spec, model.ir, compositionRecord.plan.packageIds);
  assert.deepEqual(plan.plan, expectedPlan, "the rebuild plan was fed the composed packageIds");
});

// ---------------------------------------------------------------------------
// (e) the comparison attaches VERBATIM
// ---------------------------------------------------------------------------

test("(e) the comparison attaches VERBATIM (the report's comparison deep-equals buildLearningComparison's output)", async () => {
  const packageStore = createInMemoryPackageStore();
  const readTasks = createClappReadTasks(db);
  const { walk } = await makeExperimentWalker(packageStore);
  const result = await runRepeatedBuildExperiment({
    db,
    owner: OWNER,
    runtime: scriptedRuntime,
    readTasks,
    packageStore,
    walk,
    spec: specFor("Aurora (comparison verbatim)"),
    benchmarkId: "benchmark-w3-016-comparison",
    learningEnabled: true,
    now: fixedClock,
  });

  // The report's comparison deep-equals buildLearningComparison over the two builds.
  const expectedComparison = buildLearningComparison(
    result.scratchBuildRecord,
    result.rebuildBuildRecord,
  );
  assert.deepEqual(result.report.comparison, expectedComparison);
  assert.equal(result.report.comparison.id, expectedComparison.id);
});

// ---------------------------------------------------------------------------
// (f) the per-signal compounding record + the learning-disabled control
// ---------------------------------------------------------------------------

test("(f) the per-signal compounding record + the learning-disabled control (the report's own frozen semantics)", async () => {
  const packageStore = createInMemoryPackageStore();
  const readTasks = createClappReadTasks(db);
  const { walk } = await makeExperimentWalker(packageStore);
  // The learning-disabled control: no composition plan is passed.
  const result = await runRepeatedBuildExperiment({
    db,
    owner: OWNER,
    runtime: scriptedRuntime,
    readTasks,
    packageStore,
    walk,
    spec: specFor("Aurora (control)"),
    benchmarkId: "benchmark-w3-016-control",
    learningEnabled: false,
    now: fixedClock,
  });

  // The control verdict (the W2-011 frozen semantics — no composition plan).
  assert.equal(result.report.verdict, "control");
  assert.equal(result.report.learningEnabled, false);
  assert.deepEqual(result.report.selectedPackageIds, []);

  // The per-signal compounding record: exactly one row per LEARNING signal.
  assert.equal(result.report.signalRows.length, LEARNING_SIGNAL_IDS.length);
  assert.deepEqual(
    result.report.signalRows.map((row) => row.signal),
    [...LEARNING_SIGNAL_IDS],
  );
  // Every row carries its signal's verbatim label.
  for (const row of result.report.signalRows)
    assert.ok(typeof row.label === "string" && row.label.length > 0, "each row carries a label");
});

// ---------------------------------------------------------------------------
// (g) durability: the report round-trips through the content-addressed store
// ---------------------------------------------------------------------------

test("(g) durability: the report round-trips through the content-addressed store and a re-run produces a fresh report (no silent mutation)", async () => {
  const packageStore = createInMemoryPackageStore();
  const readTasks = createClappReadTasks(db);
  const { walk } = await makeExperimentWalker(packageStore);
  const spec = specFor("Aurora (durability)");
  const first = await runRepeatedBuildExperiment({
    db,
    owner: OWNER,
    runtime: scriptedRuntime,
    readTasks,
    packageStore,
    walk,
    spec,
    benchmarkId: "benchmark-w3-016-durability",
    learningEnabled: false,
    now: fixedClock,
  });

  // The report round-trips through the content-addressed store.
  const stored = await getLearningReport(db, OWNER, first.report.id);
  assert.ok(stored, "the report persisted to the clapp-learning kind");
  assert.equal(stored.reportKind, "compounding");
  assert.deepEqual(
    stored.report,
    first.report,
    "the stored report deep-equals the returned report",
  );

  // A re-run produces a FRESH report (the experiment is a live measurement —
  // each run creates new reconstructions with new ids, so the
  // ReconstructionArtifacts.reconstructionId differs, the extraction differs,
  // and the content-addressed report id differs). The first report is NOT
  // mutated: it remains in the store byte-exact, and both reports coexist as
  // separate rows (no silent overwrite).
  const second = await runRepeatedBuildExperiment({
    db,
    owner: OWNER,
    runtime: scriptedRuntime,
    readTasks,
    packageStore,
    walk,
    spec,
    benchmarkId: "benchmark-w3-016-durability",
    learningEnabled: false,
    now: fixedClock,
  });
  assert.notEqual(
    second.report.id,
    first.report.id,
    "a re-run produces a fresh report id (the experiment is a live measurement)",
  );
  // The first report is still in the store, byte-exact (no silent mutation).
  const firstStillStored = await getLearningReport(db, OWNER, first.report.id);
  assert.deepEqual(
    firstStillStored?.report,
    first.report,
    "the first report remains in the store byte-exact (no silent mutation)",
  );
  // The second report is also in the store (both coexist as separate rows).
  const secondStored = await getLearningReport(db, OWNER, second.report.id);
  assert.deepEqual(
    secondStored?.report,
    second.report,
    "the second report is in the store (both reports coexist)",
  );
});
