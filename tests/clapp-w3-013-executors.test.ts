import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createApp } from "../apps/server/src/app.ts";
import {
  createClappAuthorizationStore,
  createInMemoryPackageStore,
} from "../apps/server/src/clapp/executor-stores.ts";
import {
  CLAPP_STAGE_OUTPUT_KIND,
  type ClappPairedSideSource,
  type ClappPromotionEvaluationSource,
  createRealStageExecutor,
  decodeStagePayload,
  type RealStageExecutorDeps,
  type StageArtifactPayload,
} from "../apps/server/src/clapp/executors.ts";
import type { ClappRepositories } from "../apps/server/src/clapp/repositories.ts";
import { createClappRepositories } from "../apps/server/src/clapp/repositories.ts";
import type { ClappService } from "../apps/server/src/clapp/service.ts";
import { createClappService } from "../apps/server/src/clapp/service.ts";
import { createClappReadTasks, createClappWorkerHandler } from "../apps/server/src/clapp/worker.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { TaskWorker } from "../apps/server/src/engine/worker.ts";
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
  composeExploredIr,
  explore,
  extractBehavioralIr,
  serializeBehavioralIr,
} from "../packages/clapp-intelligence/src/index.ts";
import {
  type AuthorizationStore,
  authorizeTarget,
  createBrowserObservationAdapter,
} from "../packages/clapp-observation/src/index.ts";
import {
  CLAPP_STAGES,
  type ClappAgentTaskLike,
  type ClappTaskContext,
  type ClappTaskSnapshot,
  createOpenMuseRuntime,
  type OpenMuseRuntime,
  readClappRunState,
} from "../packages/clapp-runtime-openmuse/src/index.ts";
import {
  bindPairedSide,
  generateCandidateApp,
  type PairedSide,
  planSynthesisApp,
  type RepairReport,
} from "../packages/clapp-synthesis/src/index.ts";

/**
 * CLAPP-W3-013 — the real stage executors: the reconstruction chain goes live.
 *
 * Proves the executor chain composes the REAL frozen package algorithms at
 * every converted stage, exactly the way the production wiring binds them,
 * over the W1-004 integration precedent (a real in-process store, a real
 * AgentService/HTTP app built by createApp, and real TaskWorker instances
 * driving the stage-chain handler). Deterministic only: the clocks are
 * pinned, the chain is walked sequentially through the control plane's own
 * advance() (stages consume their predecessors' artifacts — the worker runs
 * up to three tasks in parallel, so the sequential control-plane walk is the
 * honest way a chain progresses), every server interaction is in-process
 * loopback on an ephemeral 127.0.0.1 port, and the candidate execution is a
 * REAL bounded run (node --check + the repo's tsx executing the REAL
 * generated node:test suite in a fresh temp workspace) — no Chromium, no
 * Docker, no external network, no randomness.
 *
 * The scripted providers are the sanctioned seams (the W1-004
 * scripted-provider precedent): the observation provider is the REAL W1-002
 * adapter bound to a real-content page handle reading the REAL benchmark
 * harness over loopback; the artifacts provider mirrors the substrate's
 * content-addressed PDF discipline in memory (loading every put as a PDF —
 * the substrate's files store accepts PDF documents only); the candidate
 * seam is a REAL bounded executor without a computer. The two unavailable
 * state classes the dispatch demands — no browser session (capture) and no
 * candidate workspace (synthesize) — are pinned against the REAL runtime
 * adapter's own typed refusals.
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

// ---------------------------------------------------------------------------
// The scripted providers (the W1-004 precedent — real seams, no hidden state)
// ---------------------------------------------------------------------------

/** sha256 of bytes, the content-addressing the real artifact provider uses. */
const sha256Of = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

interface RecordedPut {
  input: {
    reconstructionId: string;
    kind: string;
    bytes: Uint8Array;
    metadata: Record<string, string>;
  };
  reference: EvidenceRef;
}

/**
 * The in-memory artifact provider mirroring the real one's contract:
 * content-addressed (the sha256 of the bytes is the id), idempotent on
 * identical bytes, and — like the substrate's PDF files store — it loads
 * every put as a PDF document before accepting it, so every stage's outputs
 * are proven to be real PDF envelopes.
 */
function scriptedArtifactsProvider() {
  const stored = new Map<string, { bytes: Uint8Array; reference: EvidenceRef }>();
  const puts: RecordedPut[] = [];
  return {
    stored,
    puts,
    async put(input: {
      reconstructionId: string;
      kind: string;
      bytes: Uint8Array;
      metadata: Record<string, string>;
    }): Promise<EvidenceRef> {
      const { PDFDocument } = await import("pdf-lib");
      await PDFDocument.load(input.bytes); // the substrate's PDF-only discipline
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
      puts.push({ input, reference });
      return reference;
    },
    async get(id: string): Promise<Uint8Array> {
      const entry = stored.get(id);
      if (!entry) throw new Error(`no scripted artifact stored under content id "${id}"`);
      return entry.bytes;
    },
  };
}

/** The shared scripted artifacts provider every executor in this file uses. */
const artifacts = scriptedArtifactsProvider();

/** The deterministic page title of a served HTML document. */
function pageTitle(html: string): string {
  const match = /<title>([\s\S]*?)<\/title>/i.exec(html);
  return match === null ? "" : match[1].trim();
}

/** The deterministic innerText-style extraction (the W3-008 helper). */
function htmlToText(html: string): string {
  const withoutStyle = html.replace(/<style[\s\S]*?<\/style>/gi, " ");
  const withoutScript = withoutStyle.replace(/<script[\s\S]*?<\/script>/gi, " ");
  const withoutComments = withoutScript.replace(/<!--[\s\S]*?-->/g, " ");
  const withBreaks = withoutComments.replace(
    /<(?:\/|)(?:address|blockquote|body|br|caption|dd|div|dl|dt|fieldset|figure|footer|form|h[1-6]|head|hr|html|label|legend|li|main|nav|ol|p|pre|section|table|tbody|td|th|thead|title|tr|ul)\b[^>]*>/gi,
    "\n",
  );
  const stripped = withBreaks.replace(/<[^>]+>/g, " ");
  const decoded = stripped
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&nbsp;", " ");
  return decoded
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

/** The W1-002 fake-handle shape bound to REAL served content (the W3-008 pattern). */
function realPageHandle(baseUrl: () => string) {
  const SESSION_ID = "00000000-w3-0013-0000-000000000001";
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

/**
 * The REAL W1-002 browser observation adapter reading the REAL benchmark
 * harness over loopback (the W3-008 pattern), under the pinned clock: the
 * observation provider the scripted runtime binds.
 */
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

// ---------------------------------------------------------------------------
// The scripted candidate seam — REAL bounded execution without a computer
// ---------------------------------------------------------------------------

const temporaryDirectories: string[] = [];

/**
 * The scripted candidate workspace seam: fresh temp workspaces seeded with
 * the generated files, and a REAL bounded execution — the manifest's own
 * build command (`node --check server.ts`) runs as a real subprocess and
 * the manifest's own test command runs the REAL generated node:test suite
 * through the repository's tsx binary. No computer, no Docker, no network:
 * the same contract the W1-003 seam composes over the sandbox.
 */
function scriptedCandidateSeam() {
  const directoriesByPath = new Map<string, string>();
  let counter = 0;
  const workspaces = {
    async create(input: { reconstructionId: string; kind: "reference" | "candidate" }) {
      counter += 1;
      const id = `scripted-ws-${counter}`;
      const directory = await mkdtemp(join(tmpdir(), "clapp-w3-013-ws-"));
      temporaryDirectories.push(directory);
      const path = `/workspace/clapp/${input.kind}-w3-013-${id}`;
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
      const directory = directoriesByPath.get(input.cwd);
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

/** Writes a generated app into a fresh temp directory (the W3-008 pattern). */
async function makeDirectory(files: { path: string; content: string }[]): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "clapp-w3-013-side-"));
  temporaryDirectories.push(directory);
  for (const file of files) {
    const target = join(directory, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content, "utf8");
  }
  return directory;
}

/**
 * The candidate-side materializer (the W3-008 pattern): generate, write to a
 * fresh temp directory, dynamic-import the generated server.ts and bind its
 * exported start(port) as a PairedSide.
 */
async function materializeSide(plan: SynthesisPlan): Promise<PairedSide> {
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

/** The B01 harness bound as the reference side (the real benchmark). */
function benchmarkSide(): PairedSide {
  return bindPairedSide(createBenchmarkHarness(B01), "reference");
}

/** The scripted runtime the chain tests drive. */
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

/** The B01 paired-side binding: the real benchmark reference, the generated candidate. */
const b01Sides: ClappPairedSideSource = {
  reference: () => benchmarkSide(),
  candidate: (_spec, plan) => materializeSide(plan),
};

/**
 * The equivalent-reference binding (the equivalent chain test only,
 * disclosed): the reference side serves the CANDIDATE'S OWN generated
 * content — a fresh generated server bound as the reference. This proves the
 * composition end-to-end (a real equivalent verdict, a converged repair, a
 * ready review gate); it is NOT a claim of real target parity, which only a
 * real reference binding (a later wave) can produce.
 */
const selfReferenceSides: ClappPairedSideSource = {
  reference: (_spec, plan) => materializeSide(plan),
  candidate: (_spec, plan) => materializeSide(plan),
};

// ---------------------------------------------------------------------------
// The fixture spec, deps and chain walking
// ---------------------------------------------------------------------------

/** The B01 reconstruction spec (the W3-008 shape, pinned clock everywhere). */
function specFor(name: string, options?: { maxRepairIterations?: number }): ReconstructionSpec {
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
      journeys: B01.routes.map((route) => `visit:${route.path}`),
      visual: false,
      network: true,
      state: true,
      maxRepairIterations: options?.maxRepairIterations ?? 2,
    },
  };
}

/** A direct-execute context (the minimal honest ClappTaskContext). */
const directTaskLike: ClappAgentTaskLike = {
  id: "direct-execute-task",
  title: "Direct execute",
  prompt: "Direct execute",
  kind: "agent",
  status: "running",
  plan: [],
  evidence: [],
  input: {},
  state: {},
  createdAt: FIXED_ISO,
  updatedAt: FIXED_ISO,
  attempts: 1,
  artifactIds: [],
};
const directContext = (): ClappTaskContext => ({
  signal: new AbortController().signal,
  guard: async () => {},
  checkpoint: async (patch) => ({ ...directTaskLike, ...patch }) as ClappAgentTaskLike,
  event: async () => {},
});

/** The cross-owner task reader the worker derives (the real one). */
const readTasks = () => createClappReadTasks(db);

/** The run state of one reconstruction (the real derivation). */
const runStateOf = async (reconstructionId: string) =>
  readClappRunState((await readTasks()(reconstructionId)).map((snapshot) => snapshot.task));

/** Decodes one stage's recorded output payload from the artifacts provider. */
const stagePayloadOf = async (
  reconstructionId: string,
  stage: ClappStage,
): Promise<StageArtifactPayload> => {
  const state = await runStateOf(reconstructionId);
  const entry = state.stages.find((row) => row.stage === stage);
  assert.ok(entry, `the ${stage} stage has a record`);
  const id = entry.outputArtifactIds[0];
  assert.ok(id, `the ${stage} stage recorded an output artifact`);
  return decodeStagePayload(await artifacts.get(id));
};

/** The real executor deps the chain tests bind (pinned clock). */
const chainDeps = (options?: {
  pairedSides?: ClappPairedSideSource;
  evaluation?: ClappPromotionEvaluationSource;
}): RealStageExecutorDeps => ({
  readSpec: repositories.findSpec,
  readTasks: readTasks(),
  authorizationStore,
  packageStore: createInMemoryPackageStore(),
  ...(options?.pairedSides !== undefined ? { pairedSides: options.pairedSides } : {}),
  ...(options?.evaluation !== undefined ? { evaluation: options.evaluation } : {}),
  now: fixedClock,
});

/**
 * Walks one full reconstruction through the ten-stage chain: the control
 * plane's own advance() creates each successor task only after its
 * predecessor durably succeeded (the production discipline — the worker runs
 * up to three tasks in parallel, so a chain that pre-created every stage
 * task would race its own artifact dependencies).
 */
async function walkChain(options: {
  pairedSides: ClappPairedSideSource;
  evaluation?: ClappPromotionEvaluationSource;
}): Promise<{ reconstructionId: string; invocations: (stage: ClappStage) => number }> {
  const executor = createRealStageExecutor(chainDeps(options));
  const handler = createClappWorkerHandler({
    db,
    runtime: scriptedRuntime,
    executor: executor.executor,
    fallback: async () => {
      throw new Error("the fallback handler must not receive CLAPP tasks");
    },
  });
  const worker = new TaskWorker(db, handler, { leaseMs: 5000, pollMs: 20 });
  const created = await service.createReconstruction(OWNER, specFor("Aurora Studio (chain walk)"));
  const reconstructionId = created.reconstruction.id;
  for (let index = 0; index < CLAPP_STAGES.length + 2; index += 1) {
    await worker.tick();
    const state = await runStateOf(reconstructionId);
    for (const stage of state.stages) {
      assert.equal(
        stage.status,
        "succeeded",
        `stage ${stage.stage} of ${reconstructionId} must succeed (error: ${stage.error ?? "none"})`,
      );
    }
    if (state.stages.length === CLAPP_STAGES.length) break;
    await service.advance(OWNER, reconstructionId);
  }
  const final = await runStateOf(reconstructionId);
  assert.equal(final.stages.length, CLAPP_STAGES.length);
  assert.equal(final.runStatus, "succeeded");
  return { reconstructionId, invocations: executor.invocations };
}

before(async () => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-clapp-w3-013-"));
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
  service = createClappService({ db, agent: server.agent, runtime: {}, repositories });
  authorizationStore = createClappAuthorizationStore(db);
});

after(async () => {
  await server?.agent?.stop();
  await db?.close();
  for (const directory of temporaryDirectories) {
    await rm(directory, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The named deterministic tests
// ---------------------------------------------------------------------------

/** The two chain walks' reconstruction ids (the focused tests below reuse their durable state). */
let b01ReconstructionId = "";

test("the chain executes the real algorithms at every stage over scripted providers (the B01 walk)", async () => {
  // The real W1-008 authorize path persists the record BEFORE the chain runs
  // (the caller's burden of proof; the stage then verifies it).
  const { reconstructionId, invocations } = await walkChain({ pairedSides: b01Sides });
  b01ReconstructionId = reconstructionId;

  // Every stage executed exactly once, and the run is durably complete.
  for (const stage of CLAPP_STAGES) assert.equal(invocations(stage), 1, `stage ${stage} ran once`);

  // authorization: the verified record, cited by its content-addressed id.
  const authorization = (await stagePayloadOf(reconstructionId, "authorization")).output as {
    authorizationRecordId: string;
    authorizationKind: string;
  };
  const spec = (await repositories.get(OWNER, reconstructionId))?.spec;
  assert.ok(spec, "the reconstruction row exists");
  const storedRecord = await authorizationStore.get(spec.targetId);
  assert.ok(storedRecord, "the target's authorization record persisted");
  assert.equal(authorization.authorizationRecordId, storedRecord.id);
  assert.equal(authorization.authorizationKind, "implicit-benchmark");

  // capture: the REAL W1-002 bundle (28 refs over B01: the dom-text and
  // page-meta channels observed per entrypoint, plus the honest unavailable
  // channels — dom-structure, a11y, network, storage and screenshot, the
  // scripted handle carrying no preview capability).
  const capture = (await stagePayloadOf(reconstructionId, "capture")).output as EvidenceBundle;
  assert.equal(capture.refs.length, 28);
  assert.equal(capture.refs.filter((ref) => ref.classification === "observed").length, 8);
  assert.equal(capture.refs.filter((ref) => ref.classification === "unavailable").length, 20);

  // explore: the REAL W2-003 deepening under the spec's own seed and budget.
  const exploration = (await stagePayloadOf(reconstructionId, "explore")).output as {
    stats: { journeys: number; steps: number };
    featureDigest: string;
  };
  assert.equal(exploration.stats.journeys, 4);
  assert.match(exploration.featureDigest, /^[0-9a-f]{64}$/);

  // model: the REAL W2-002 extraction composed with the exploration result —
  // compared canonically (the canonical serialization sorts the keyless
  // assumption records, so the artifact's stored form and the fresh
  // recomputation are compared through serializeBehavioralIr).
  const modelPayload = await stagePayloadOf(reconstructionId, "model");
  const composed = await import("../packages/clapp-intelligence/src/index.ts").then((m) =>
    m.deserializeBehavioralIr(modelPayload.output as string),
  );
  assert.ok(composed.ok && composed.ir, "the composed IR deserializes");
  const baseline = extractBehavioralIr({ bundle: capture, spec });
  const expectedComposed = composeExploredIr(
    baseline,
    exploration as Parameters<typeof composeExploredIr>[1],
  );
  assert.equal(
    modelPayload.output,
    serializeBehavioralIr(expectedComposed),
    "the model artifact IS the canonical serialization of the composed real IR",
  );
  assert.equal(composed.ir.journeys.length, 4);
  assert.ok(composed.ir.assumptions.length >= baseline.assumptions.length);

  // plan: the REAL W3-001 plan over the composed model.
  const planPayload = await stagePayloadOf(reconstructionId, "plan");
  const plan = await import("../packages/clapp-synthesis/src/index.ts").then((m) =>
    m.deserializeSynthesisPlan(planPayload.output as string),
  );
  assert.ok(plan.ok && plan.plan, "the plan deserializes");
  assert.deepEqual(
    plan.plan?.acceptanceJourneyIds,
    B01.routes.map((route) => `visit:${route.path}`),
  );
  assert.equal(plan.plan?.routes.length, 4);

  // synthesize: the REAL W3-002 candidate, REALLY executed (build + test green).
  const synthesize = (await stagePayloadOf(reconstructionId, "synthesize")).output as {
    app: { files: { path: string }[] };
    execution: { succeeded: boolean; steps: { name: string; exitCode: number }[] };
  };
  assert.equal(synthesize.app.files.length, 12);
  assert.equal(synthesize.execution.succeeded, true);
  assert.deepEqual(
    synthesize.execution.steps.map((step) => `${step.name}:${step.exitCode}`),
    ["build:0", "test:0"],
    "the candidate's bounded execution ran the real build and the real generated suite",
  );

  // verify: the REAL paired differential against the real B01 reference —
  // the honest verdict is whatever the engine produced, never upgraded.
  const verify = (await stagePayloadOf(reconstructionId, "verify")).output as {
    journeys: unknown[];
    suite: { verdict: string; findingsByDimension: { semantic: unknown[] } };
  };
  assert.equal(verify.journeys.length, 4);
  assert.equal(verify.suite.verdict, "divergent");
  assert.ok(verify.suite.findingsByDimension.semantic.length >= 1);

  // repair: the REAL bounded loop under the spec's budget (2 iterations max).
  const repair = (await stagePayloadOf(reconstructionId, "repair")).output as RepairReport;
  assert.ok(["converged", "stagnation", "budget"].includes(repair.stoppedBy));
  assert.ok(repair.iterations.length <= 2);
  assert.match(repair.id, /^rr-[0-9a-f]{16}$/);

  // review: the REAL W3-008 digest over the run's actual artifacts.
  const review = (await stagePayloadOf(reconstructionId, "review")).output as {
    digest: {
      stages: { stage: string; outcome: string }[];
      finalParityVerdict: string;
    };
    gate: { promotionReady: boolean; parityVerdict: string };
  };
  assert.ok(review.digest.stages.every((entry) => entry.outcome === "succeeded"));
  assert.equal(review.digest.finalParityVerdict, "divergent");
  assert.equal(review.gate.parityVerdict, "divergent");
  assert.equal(review.gate.promotionReady, false);

  // promote: the REAL W2-006 gate abstains on non-equivalent parity.
  const promote = (await stagePayloadOf(reconstructionId, "promote")).output as {
    parity: { verdict: string; verificationRunId: string };
    extraction: { candidates: unknown[]; skipped: { reason: string }[] };
    outcomes: unknown[];
  };
  assert.equal(promote.parity.verdict, repair.finalVerdict);
  assert.equal(promote.parity.verificationRunId, repair.id);
  assert.equal(promote.extraction.candidates.length, 0);
  assert.match(promote.extraction.skipped[0].reason, /only verified "equivalent" parity/);
  assert.equal(promote.outcomes.length, 0);
});

test("the equivalent-reference chain reaches a real equivalent verdict, a converged repair and a ready review gate", async () => {
  const { reconstructionId } = await walkChain({
    pairedSides: selfReferenceSides,
    evaluation: async (candidate) => {
      assert.match(candidate.id, /^clapp_package_/);
      const repair = (await stagePayloadOf(reconstructionId, "repair")).output as RepairReport;
      return {
        from: {
          appId: "A1",
          phase: "scratch",
          reusedPackageIds: [],
          rejectedPackageIds: [],
          newCodeUnits: 24,
          repairIterations: 2,
          buildSteps: 40,
          testsPassed: 12,
          testsTotal: 12,
        },
        to: {
          appId: "A2",
          phase: "reuse",
          reusedPackageIds: [candidate.id],
          rejectedPackageIds: [],
          newCodeUnits: 9,
          repairIterations: 0,
          buildSteps: 18,
          testsPassed: 14,
          testsTotal: 14,
          parity: {
            verdict: "equivalent",
            verificationRunId: repair.id,
            minorFindings: 0,
            majorFindings: 0,
          },
        },
      };
    },
  });
  const verify = (await stagePayloadOf(reconstructionId, "verify")).output as {
    suite: {
      verdict: string;
      findingsByDimension: { semantic: unknown[]; visual: unknown[]; network: unknown[] };
    };
  };
  assert.equal(verify.suite.verdict, "equivalent");
  assert.equal(verify.suite.findingsByDimension.semantic.length, 0);

  const repair = (await stagePayloadOf(reconstructionId, "repair")).output as RepairReport;
  assert.equal(repair.converged, true);
  assert.equal(repair.stoppedBy, "converged");
  assert.equal(repair.iterations.length, 0);
  assert.equal(repair.finalVerdict, "equivalent");

  const review = (await stagePayloadOf(reconstructionId, "review")).output as {
    gate: { promotionReady: boolean };
  };
  assert.equal(review.gate.promotionReady, true);

  // The promote stage composed the real W2-006 gate over the equivalent
  // parity — and abstained honestly, because the v0.1 behavioral model
  // (the frozen W2-002 baseline) derives an EMPTY plan inventory: an empty
  // shell package is never extracted. The abstention reason is verbatim.
  const promote = (await stagePayloadOf(reconstructionId, "promote")).output as {
    extraction: { candidates: unknown[]; skipped: { reason: string }[] };
    outcomes: unknown[];
  };
  assert.equal(promote.extraction.candidates.length, 0);
  assert.match(promote.extraction.skipped[0].reason, /plan inventory is empty/);
  assert.equal(promote.outcomes.length, 0);
});

test("capture refuses honestly without a browser session (the real adapter's own typed refusal)", async () => {
  // The REAL runtime adapter with no browserSession handle: its observation
  // provider fails closed with the typed "not provided" error — the executor
  // surfaces it as the honest unavailable state and records no evidence.
  const runtime = createOpenMuseRuntime({
    browserSession: undefined,
    computer: undefined,
    files: undefined,
    agent: undefined,
    db,
  });
  const executor = createRealStageExecutor(chainDeps({}));
  const result = await executor.executor.execute(
    { specVersion: "0.1", reconstructionId: b01ReconstructionId, stage: "capture" },
    runtime,
    directContext(),
  );
  assert.ok(result.error, "capture must refuse");
  assert.match(result.error, /observation provider refused/);
  assert.match(result.error, /browserSession/);
  assert.deepEqual(result.outputArtifactIds, []);
});

test("authorization validates the stored record's shape and expiry, and refuses honestly", async () => {
  const executor = createRealStageExecutor(chainDeps({}));
  const specOf = async (reconstructionId: string) => {
    const spec = await repositories.findSpec(reconstructionId);
    assert.ok(spec, "the spec exists");
    return spec;
  };

  // (a) A fresh target: the REAL W1-008 authorize path persists the record
  // first; the stage verifies it and cites its content-addressed id.
  const authorized = await service.createReconstruction(
    OWNER,
    specFor("Authorization verified target"),
  );
  const authorizedSpec = await specOf(authorized.reconstruction.id);
  const record = await authorizeTarget(authorizedSpec, {
    operatorIdentity: OWNER,
    store: authorizationStore,
  });
  const verified = await executor.executor.execute(
    { specVersion: "0.1", reconstructionId: authorized.reconstruction.id, stage: "authorization" },
    scriptedRuntime,
    directContext(),
  );
  assert.ok(!verified.error, verified.error ?? "authorization succeeds");
  const output = await decodeStagePayload(await artifacts.get(verified.outputArtifactIds[0]));
  assert.equal(
    (output.output as { authorizationRecordId: string }).authorizationRecordId,
    record.id,
  );

  // (b) No stored record (non-benchmark target): a refusal, never a pass.
  const absent = await service.createReconstruction(
    OWNER,
    (() => {
      const base = specFor("Authorization absent target");
      return {
        ...base,
        targetId: "target-absent-authz",
        authorization: {
          ...base.authorization,
          targetId: "target-absent-authz",
          benchmarkOwned: false,
        },
      };
    })(),
  );
  const refused = await executor.executor.execute(
    { specVersion: "0.1", reconstructionId: absent.reconstruction.id, stage: "authorization" },
    scriptedRuntime,
    directContext(),
  );
  assert.match(refused.error ?? "", /no persisted authorization record/);
  assert.deepEqual(refused.outputArtifactIds, []);

  // (c) An expired record refuses with the expiry named.
  const expired = await service.createReconstruction(
    OWNER,
    (() => {
      const base = specFor("Authorization expired target");
      return {
        ...base,
        targetId: "target-expired-authz",
        authorization: {
          ...base.authorization,
          targetId: "target-expired-authz",
          benchmarkOwned: false,
          expiresAt: "2020-01-01T00:00:00.000Z",
        },
      };
    })(),
  );
  const expiredSpec = await specOf(expired.reconstruction.id);
  await authorizeTarget(expiredSpec, { operatorIdentity: OWNER, store: authorizationStore });
  const expiredRefusal = await executor.executor.execute(
    { specVersion: "0.1", reconstructionId: expired.reconstruction.id, stage: "authorization" },
    scriptedRuntime,
    directContext(),
  );
  assert.match(expiredRefusal.error ?? "", /expired at 2020-01-01T00:00:00.000Z/);

  // (d) A tampered record (its own fields re-derive a different id) refuses.
  const tampered = await service.createReconstruction(
    OWNER,
    (() => {
      const base = specFor("Authorization tampered target");
      return {
        ...base,
        targetId: "target-tampered-authz",
        authorization: {
          ...base.authorization,
          targetId: "target-tampered-authz",
          benchmarkOwned: false,
        },
      };
    })(),
  );
  const tamperedSpec = await specOf(tampered.reconstruction.id);
  const genuine = await authorizeTarget(tamperedSpec, {
    operatorIdentity: OWNER,
    store: authorizationStore,
  });
  await authorizationStore.put(tamperedSpec.targetId, {
    ...genuine,
    id: "clapp_authz_tampered0000",
  });
  const tamperedRefusal = await executor.executor.execute(
    { specVersion: "0.1", reconstructionId: tampered.reconstruction.id, stage: "authorization" },
    scriptedRuntime,
    directContext(),
  );
  assert.match(tamperedRefusal.error ?? "", /re-derive id/);
});

test("synthesize refuses honestly when the candidate-execution seam cannot run (no candidate workspace)", async () => {
  // The REAL runtime adapter without candidate options and without a
  // computer handle: its workspaces provider fails closed with the typed
  // error — the executor's generated candidate is not claimed as executed.
  const realRuntime = createOpenMuseRuntime({
    browserSession: undefined,
    computer: undefined,
    files: undefined,
    agent: undefined,
    db,
  });
  const hybrid: OpenMuseRuntime = {
    ...scriptedRuntime,
    workspaces: realRuntime.workspaces,
    execution: realRuntime.execution,
  };
  const executor = createRealStageExecutor(chainDeps({}));
  const result = await executor.executor.execute(
    { specVersion: "0.1", reconstructionId: b01ReconstructionId, stage: "synthesize" },
    hybrid,
    directContext(),
  );
  assert.ok(result.error, "synthesize must refuse without a candidate workspace");
  assert.match(result.error, /candidate-execution seam refused/);
  assert.match(result.error, /computer/);
  assert.deepEqual(result.outputArtifactIds, []);
});

test("verify refuses honestly without a paired-side binding (no fabricated differential verdict)", async () => {
  const executor = createRealStageExecutor(chainDeps({})); // no pairedSides
  const result = await executor.executor.execute(
    { specVersion: "0.1", reconstructionId: b01ReconstructionId, stage: "verify" },
    scriptedRuntime,
    directContext(),
  );
  assert.ok(result.error, "verify must refuse without paired sides");
  assert.match(result.error, /no paired-side binding/);
  assert.match(result.error, /never fabricated/);
  assert.deepEqual(result.outputArtifactIds, []);
});

test("the stage outputs are deterministic PDF envelopes under the frozen artifact metadata discipline", async () => {
  const { encodeStagePayload } = await import("../apps/server/src/clapp/executors.ts");
  const payload: StageArtifactPayload = {
    schemaVersion: "0.1",
    stage: "model",
    reconstructionId: "rc-envelope",
    output: { note: "héllo — “envelope” \\ / bytes" },
  };
  const first = await encodeStagePayload(payload);
  const second = await encodeStagePayload(payload);
  assert.deepEqual(first, second, "identical payloads encode to identical PDF bytes");
  assert.deepEqual(await decodeStagePayload(first), payload, "the round trip is exact");

  // A skeleton-style PDF carries no payload and fails closed on decode.
  const { PDFDocument } = await import("pdf-lib");
  const skeleton = await PDFDocument.create();
  skeleton.addPage();
  skeleton.setTitle("CLAPP skeleton stage output — rc — model");
  const skeletonBytes = new Uint8Array(await skeleton.save());
  await assert.rejects(() => decodeStagePayload(skeletonBytes), /no stage payload/);

  // Every put the chain made carries the frozen metadata discipline.
  assert.ok(artifacts.puts.length >= 20, "ten stages put at least their artifacts");
  for (const put of artifacts.puts) {
    assert.equal(put.input.kind, CLAPP_STAGE_OUTPUT_KIND);
    assert.ok(put.input.metadata.targetId);
    assert.ok(["observed", "derived"].includes(put.input.metadata.classification));
    assert.match(put.input.metadata.source, /^clapp:stage:[a-z]+$/);
  }
  const capturePut = artifacts.puts.find(
    (put) =>
      put.input.reconstructionId === b01ReconstructionId &&
      put.input.metadata.source === "clapp:stage:capture",
  );
  assert.ok(capturePut, "the capture put exists");
  assert.equal(capturePut.input.metadata.classification, "observed");
});

test("the pure stages are byte-deterministic and idempotent across re-execution", async () => {
  const executor = createRealStageExecutor(chainDeps({}));
  const input = (stage: ClappStage) => ({
    specVersion: "0.1",
    reconstructionId: b01ReconstructionId,
    stage,
  });
  const firstModel = await executor.executor.execute(
    input("model"),
    scriptedRuntime,
    directContext(),
  );
  const againModel = await executor.executor.execute(
    input("model"),
    scriptedRuntime,
    directContext(),
  );
  assert.ok(!firstModel.error && !againModel.error);
  assert.deepEqual(againModel.outputArtifactIds, firstModel.outputArtifactIds);
  assert.equal(againModel.outputArtifactIds[0], firstModel.outputArtifactIds[0]);

  const firstPlan = await executor.executor.execute(
    input("plan"),
    scriptedRuntime,
    directContext(),
  );
  const againPlan = await executor.executor.execute(
    input("plan"),
    scriptedRuntime,
    directContext(),
  );
  assert.ok(!firstPlan.error && !againPlan.error);
  assert.equal(againPlan.outputArtifactIds[0], firstPlan.outputArtifactIds[0]);

  // The recorded artifact ledger still attributes the chain's own outputs.
  const state = await runStateOf(b01ReconstructionId);
  assert.equal(
    state.stages.find((row) => row.stage === "model")?.outputArtifactIds[0],
    firstModel.outputArtifactIds[0],
  );
});

test("explore composes the real W2-003 deepening (the composition proof, not a re-implementation)", async () => {
  const executor = createRealStageExecutor(chainDeps({}));
  const result = await executor.executor.execute(
    { specVersion: "0.1", reconstructionId: b01ReconstructionId, stage: "explore" },
    scriptedRuntime,
    directContext(),
  );
  assert.ok(!result.error, result.error ?? "explore succeeds");
  const payload = await decodeStagePayload(await artifacts.get(result.outputArtifactIds[0]));
  const spec = await repositories.findSpec(b01ReconstructionId);
  assert.ok(spec, "the spec exists");
  const capture = (await stagePayloadOf(b01ReconstructionId, "capture")).output as EvidenceBundle;
  const expected = explore({
    ir: extractBehavioralIr({ bundle: capture, spec }),
    seed: spec.exploration.seed,
    budget: {
      maxJourneys: spec.exploration.maxStages,
      maxStepsPerJourney: spec.exploration.maxActions,
    },
  });
  assert.deepEqual(payload.output, expected, "the explore artifact IS the real explore() output");
});

test("promote composes the real W2-010 gate end-to-end when the plan inventory is non-empty (the fixture-unlocked path)", async () => {
  // The v0.1 W2-002 baseline derives an EMPTY plan inventory (components,
  // state, data and api stay empty with recorded assumptions), so no real
  // chain can reach a non-empty inventory yet. This fixture composes every
  // real function over a model whose api/data halves stand in for the future
  // extraction waves — disclosed as fixture state, never claimed as a real
  // extraction — to prove the promote stage's gate composition fires.
  const FIXTURE_ID = "rc-w3-0013-promote-fixture";
  const fixtureSpec: ReconstructionSpec = {
    ...specFor("Promotion fixture"),
    reconstructionId: FIXTURE_ID,
  };
  const bundle = await observeB01(fixtureSpec);
  const extracted = extractBehavioralIr({ bundle, spec: fixtureSpec });
  const fixtureIr = { ...extracted, api: { status: { ok: true } }, data: { messages: [] } };
  const fixturePlan = await planSynthesisApp(fixtureSpec, fixtureIr, []);
  const fixtureApp = generateCandidateApp(fixturePlan);
  const routes = JSON.parse(
    fixtureApp.files.find((file) => file.path === "routes.json")?.content ?? "[]",
  ) as { journeyId: string; name: string; path: string }[];
  const journeys = fixturePlan.acceptanceJourneyIds
    .map((id) => routes.find((route) => route.journeyId === id))
    .filter(
      (route): route is { journeyId: string; name: string; path: string } => route !== undefined,
    )
    .map((route) => ({
      id: route.journeyId,
      name: route.name,
      routePath: route.path,
      anchors: [route.name],
    }));
  const referenceSide = await materializeSide(fixturePlan);
  const { runRepairLoop } = await import("../packages/clapp-synthesis/src/index.ts");
  const repairReport = await runRepairLoop({
    reference: () => referenceSide,
    candidatePlan: fixturePlan,
    materialize: (repaired) => materializeSide(repaired),
    journeys,
    budget: 2,
    reconstructionId: FIXTURE_ID,
    dimensions: { visual: false, network: true },
  });
  assert.equal(repairReport.converged, true, "the self-reference repair converges");
  assert.equal(repairReport.finalVerdict, "equivalent");

  // Seed the fixture chain state: the real model, plan and repair artifacts.
  const { encodeStagePayload } = await import("../apps/server/src/clapp/executors.ts");
  const seed = async (stage: ClappStage, output: unknown) => {
    const reference = await artifacts.put({
      reconstructionId: FIXTURE_ID,
      kind: CLAPP_STAGE_OUTPUT_KIND,
      bytes: await encodeStagePayload({
        schemaVersion: "0.1",
        stage,
        reconstructionId: FIXTURE_ID,
        output,
      }),
      metadata: { targetId: fixtureSpec.targetId, classification: "derived", source: "fixture" },
    });
    return {
      owner: OWNER,
      task: {
        ...directTaskLike,
        id: `fixture-${stage}`,
        input: { specVersion: "0.1", reconstructionId: FIXTURE_ID, stage },
        state: {
          clappStage: {
            id: `${FIXTURE_ID}:${stage}`,
            reconstructionId: FIXTURE_ID,
            stage,
            status: "succeeded",
            startedAt: FIXED_ISO,
            finishedAt: FIXED_ISO,
            inputArtifactIds: [],
            outputArtifactIds: [reference.id],
          },
        },
      },
    } satisfies ClappTaskSnapshot;
  };
  const snapshots = [
    await seed("model", serializeBehavioralIr(fixtureIr)),
    await seed(
      "plan",
      await import("../packages/clapp-synthesis/src/index.ts").then((m) =>
        m.serializeSynthesisPlan(fixturePlan),
      ),
    ),
    await seed("repair", repairReport),
  ];
  const packageStore = createInMemoryPackageStore();
  const executor = createRealStageExecutor({
    readSpec: async (id) => (id === FIXTURE_ID ? fixtureSpec : null),
    readTasks: async (id) => (id === FIXTURE_ID ? snapshots : []),
    authorizationStore,
    packageStore,
    evaluation: async (candidate) => ({
      from: {
        appId: "A1",
        phase: "scratch",
        reusedPackageIds: [],
        rejectedPackageIds: [],
        newCodeUnits: 24,
        repairIterations: 2,
        buildSteps: 40,
        testsPassed: 12,
        testsTotal: 12,
      },
      to: {
        appId: "A2",
        phase: "reuse",
        reusedPackageIds: [candidate.id],
        rejectedPackageIds: [],
        newCodeUnits: 9,
        repairIterations: 0,
        buildSteps: 18,
        testsPassed: 14,
        testsTotal: 14,
        parity: {
          verdict: "equivalent",
          verificationRunId: repairReport.id,
          minorFindings: 0,
          majorFindings: 0,
        },
      },
    }),
    now: fixedClock,
  });
  const result = await executor.executor.execute(
    { specVersion: "0.1", reconstructionId: FIXTURE_ID, stage: "promote" },
    scriptedRuntime,
    directContext(),
  );
  assert.ok(!result.error, result.error ?? "the promote stage succeeds");
  const payload = await decodeStagePayload(await artifacts.get(result.outputArtifactIds[0]));
  const output = payload.output as {
    parity: { verifiedAt: string };
    extraction: { candidates: { package: { id: string; version: string } }[] };
    registration: { results: { ok: boolean }[] };
    outcomes: { candidate: { id: string; version: string }; outcome: { promoted: boolean } }[];
  };
  assert.equal(output.parity.verifiedAt, FIXED_ISO, "verifiedAt comes from the pinned clock");
  assert.equal(output.extraction.candidates.length, 1, "the extraction produced one candidate");
  assert.ok(output.registration.results[0].ok, "the candidate registered");
  assert.equal(output.outcomes.length, 1);
  assert.equal(output.outcomes[0].outcome.promoted, true, "the real W2-010 gate promoted");
  const candidate = output.extraction.candidates[0].package;
  assert.match(candidate.id, /^clapp_package_/);
  assert.equal(output.outcomes[0].candidate.id, candidate.id);
  // The registry (the W2-005 port) stored the promoted document.
  const promoted = packageStore.get({ id: candidate.id, version: candidate.version });
  assert.ok(promoted, "the registry stored the promoted package");
  assert.equal(promoted.document.id, candidate.id);
});

test("the dispatcher executes all ten stages for real and the executor module stays pure", async () => {
  // The chain walks above executed each stage exactly once (asserted in the
  // chain tests); here the source discipline is pinned: no wall clock reads
  // other than the documented default, no randomness, no timers, no
  // network, no process environment, and only the frozen packages + pdf-lib
  // are imported.
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(join(REPOSITORY_ROOT, "apps/server/src/clapp/executors.ts"), "utf8");
  for (const banned of [
    "Math.random",
    "performance.now",
    "setTimeout",
    "setInterval",
    "process.env",
    "fetch(",
    "spawnSync",
    "node:child_process",
    "node:net",
    "node:http",
  ]) {
    assert.ok(!source.includes(banned), `the executor module must not use ${banned}`);
  }
  const clockReads = [...source.matchAll(/Date\.now/g)].length;
  assert.ok(clockReads <= 2, "the only wall-clock reads are the documented injectable defaults");
  const importSpecifiers = [...source.matchAll(/from "([^"]+)"/g)].map((match) => match[1]);
  assert.ok(importSpecifiers.length > 0);
  for (const specifier of importSpecifiers) {
    assert.ok(
      specifier === "pdf-lib" ||
        /^(\.\.\/)+packages\/clapp-(contracts|observation|intelligence|synthesis|runtime-openmuse)\/src\/index\.ts$/.test(
          specifier,
        ),
      `unexpected import "${specifier}" in the executor module`,
    );
  }
  const storesSource = readFileSync(
    join(REPOSITORY_ROOT, "apps/server/src/clapp/executor-stores.ts"),
    "utf8",
  );
  for (const banned of ["Math.random", "performance.now", "process.env", "fetch("]) {
    assert.ok(!storesSource.includes(banned), `the stores module must not use ${banned}`);
  }
});
