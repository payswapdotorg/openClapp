import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
import type { BehavioralIr, ReconstructionSpec } from "../packages/clapp-contracts/src/index.ts";
import type {
  CandidateExecutionProvider,
  CandidateWorkspaceProvider,
} from "../packages/clapp-runtime-openmuse/src/index.ts";
import {
  type CandidateBuildOutcomeShape,
  type CandidateSeam,
  type GeneratedApp,
  generateCandidateApp,
  materializeCandidate,
  planSynthesisApp,
  runGeneratedCandidateBuild,
  serializeSynthesisPlan,
  validateGeneratedApp,
} from "../packages/clapp-synthesis/src/index.ts";

/**
 * CLAPP-W3-002 — web candidate generator.
 *
 * Proves the generator's contract end-to-end: deterministic files, every
 * route becoming a servable anchored page, the JSON API serving the seeded
 * persistence state, the generated acceptance suite passing against the
 * generated app, seam composition against a fake seam, input purity, the
 * structural validator, and honest degradation on an empty plan. All server
 * interaction is in-process over loopback (files are written to the test's
 * tmp and cleaned up after); no Docker, no network.
 */

function makeSpec(): ReconstructionSpec {
  return {
    specVersion: "0.1",
    reconstructionId: "rc-w3-0002",
    targetId: "target-w3-0002",
    name: "W3-002 Fixture Application",
    platform: "web",
    entrypoints: ["/"],
    authorization: {
      ownerId: "owner-1",
      targetId: "target-w3-0002",
      scope: ["reconstruct:ui"],
      environments: ["sandbox"],
      retention: "project",
      benchmarkOwned: true,
      createdAt: "2025-01-01T00:00:00.000Z",
    },
    exploration: { maxStages: 4, maxActions: 64, maxDurationMs: 300000, seed: 42 },
    synthesis: { targetStack: "static-web", allowNetwork: false, packagePolicy: "verified-only" },
    verification: {
      journeys: ["j-login", "j-search"],
      visual: true,
      network: false,
      state: true,
      maxRepairIterations: 2,
    },
  };
}

function makeModel(): BehavioralIr {
  return {
    schemaVersion: "0.1",
    application: {
      id: "app-w3-0002",
      name: "W3-002 Fixture Application",
      platform: "web",
      entrypoints: ["/"],
    },
    evidence: [
      {
        id: "ev-w3-0002",
        targetId: "target-w3-0002",
        reconstructionId: "rc-w3-0002",
        kind: "screenshot",
        sha256: "0000000000000000000000000000000000000000000000000000000000000000",
        source: "explorer",
        capturedAt: "2025-01-02T00:00:00.000Z",
        classification: "observed",
        redacted: false,
      },
    ],
    journeys: [
      {
        id: "j-login",
        name: "Sign in",
        preconditions: ["signed out"],
        steps: [
          { id: "s-login-1", action: "fill", target: "#username", input: { value: "alice" } },
          { id: "s-login-2", action: "click", target: "#submit" },
        ],
      },
      {
        id: "j-search",
        name: "Search",
        preconditions: ["signed in"],
        steps: [{ id: "s-search-1", action: "fill", target: "#query" }],
      },
      { id: "j-logout", name: "Sign out", preconditions: [], steps: [] },
    ],
    screens: [
      { id: "screen-home", title: "Home" },
      { id: "screen-login", title: "Sign in" },
    ],
    components: [
      { kind: "form", name: "login-form" },
      { kind: "input", name: "query" },
    ],
    state: { session: { signedIn: false, user: null }, ui: { theme: "light" } },
    data: {
      users: [{ id: "u-1", name: "alice" }],
      notes: [{ id: "n-1", ownerId: "u-1" }],
    },
    api: { endpoints: [{ method: "GET", path: "/api/users" }] },
    integrations: [{ kind: "oauth", provider: "example" }],
    assumptions: [{ source: "explore", note: "theme toggle unobserved" }],
    constraints: [{ kind: "platform", note: "no-webrtc" }],
  };
}

/** The seeded API store the generated app must serve (persistence + api gap-fill). */
const EXPECTED_API: Record<string, unknown> = {
  endpoints: [{ method: "GET", path: "/api/users" }],
  notes: [{ id: "n-1", ownerId: "u-1" }],
  users: [{ id: "u-1", name: "alice" }],
};

type GeneratedServer = {
  start: (port?: number) => Promise<{ port: number; close: () => Promise<void> }>;
};

const tempDirectories: string[] = [];

/** Writes a generated app into a fresh temp dir (the in-process workspace). */
async function makeWorkspace(app: GeneratedApp): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "clapp-w3-002-"));
  tempDirectories.push(directory);
  for (const file of app.files) {
    const target = join(directory, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content, "utf8");
  }
  return directory;
}

/** Imports the generated server module from a written workspace. */
async function loadServer(directory: string): Promise<GeneratedServer> {
  return (await import(pathToFileURL(join(directory, "server.ts")).href)) as GeneratedServer;
}

/** Mirrors the generated suite's API assertions: seeded GET + PUT round-trip. */
async function assertApiRoundTrip(baseUrl: string): Promise<void> {
  for (const key of Object.keys(EXPECTED_API)) {
    const response = await fetch(`${baseUrl}/api/${encodeURIComponent(key)}`);
    assert.equal(response.status, 200, `GET /api/${key}`);
    assert.ok((response.headers.get("content-type") ?? "").startsWith("application/json"));
    assert.deepStrictEqual(await response.json(), EXPECTED_API[key]);
  }
  const probe = { clappPutProbe: true };
  const put = await fetch(`${baseUrl}/api/users`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(probe),
  });
  assert.equal(put.status, 200);
  const after = await fetch(`${baseUrl}/api/users`);
  assert.deepStrictEqual(await after.json(), probe);
}

after(async () => {
  for (const directory of tempDirectories) {
    await rm(directory, { recursive: true, force: true });
  }
});

test("generation is deterministic", async () => {
  const plan = await planSynthesisApp(makeSpec(), makeModel(), ["pkg-a"]);
  const first = generateCandidateApp(structuredClone(plan));
  const second = generateCandidateApp(structuredClone(plan));

  assert.deepStrictEqual(first, second);
  // Byte-identical files, file for file.
  assert.deepEqual(
    first.files.map((file) => file.content),
    second.files.map((file) => file.content),
  );
  for (const [index, file] of first.files.entries()) {
    assert.equal(file.content, second.files[index]?.content, file.path);
  }
  // The digest is the sha256 of the plan's canonical serialization.
  const digest = createHash("sha256").update(serializeSynthesisPlan(plan), "utf8").digest("hex");
  assert.equal(first.manifest.planDigest, digest);
  // No timestamps anywhere in the manifest — determinism by construction.
  assert.ok(!("generatedAt" in first.manifest));
});

test("every route becomes a page and an anchor", async () => {
  const plan = await planSynthesisApp(makeSpec(), makeModel(), ["pkg-a"]);
  const app = generateCandidateApp(plan);
  assert.equal(validateGeneratedApp(app).ok, true);

  const paths = app.files.map((file) => file.path);
  for (const page of [
    "pages/index.html",
    "pages/j-login.html",
    "pages/j-search.html",
    "pages/j-logout.html",
  ]) {
    assert.ok(paths.includes(page), page);
  }
  assert.equal(app.manifest.routeCount, 3);
  assert.equal(app.manifest.componentCount, 2);

  const byPath = new Map(app.files.map((file) => [file.path, file.content]));
  const login = byPath.get("pages/j-login.html") ?? "";
  assert.ok(login.includes("<title>Sign in</title>"));
  assert.ok(login.includes('data-journey="j-login"'));
  assert.ok(login.includes('data-step-count="2"'));
  const logout = byPath.get("pages/j-logout.html") ?? "";
  assert.ok(logout.includes("Sign out"));
  assert.ok(logout.includes('data-step-count="0"'));

  // The server answers each route path over loopback.
  const directory = await makeWorkspace(app);
  const server = await loadServer(directory);
  const started = await server.start(0);
  try {
    const baseUrl = `http://127.0.0.1:${started.port}`;
    const expectations = [
      { path: "/", journeyId: "index", title: "Index" },
      { path: "/j-login", journeyId: "j-login", title: "Sign in" },
      { path: "/j-search", journeyId: "j-search", title: "Search" },
      { path: "/j-logout", journeyId: "j-logout", title: "Sign out" },
    ];
    for (const expectation of expectations) {
      const response = await fetch(`${baseUrl}${expectation.path}`);
      assert.equal(response.status, 200, expectation.path);
      assert.ok(
        (response.headers.get("content-type") ?? "").startsWith("text/html"),
        expectation.path,
      );
      const html = await response.text();
      assert.ok(html.includes(`data-journey="${expectation.journeyId}"`), expectation.path);
      assert.ok(html.includes(expectation.title), expectation.path);
    }
  } finally {
    await started.close();
  }
});

test("api endpoints serve the seeded persistence state", async () => {
  const plan = await planSynthesisApp(makeSpec(), makeModel(), ["pkg-a"]);
  const app = generateCandidateApp(plan);

  const directory = await makeWorkspace(app);
  const server = await loadServer(directory);
  const started = await server.start(0);
  try {
    const baseUrl = `http://127.0.0.1:${started.port}`;
    await assertApiRoundTrip(baseUrl);
    // Unknown keys are honest 404s, never inventions.
    const missing = await fetch(`${baseUrl}/api/unknown-key`);
    assert.equal(missing.status, 404);
  } finally {
    await started.close();
  }
});

test("acceptance journeys become passing tests", async () => {
  const plan = await planSynthesisApp(makeSpec(), makeModel(), ["pkg-a"]);
  const app = generateCandidateApp(plan);

  const byPath = new Map(app.files.map((file) => [file.path, file.content]));
  const suite = byPath.get("journeys.test.ts") ?? "";
  // tsx style, .ts import extensions, node:test.
  assert.ok(suite.includes('from "./server.ts"'));
  assert.ok(suite.includes('import { test } from "node:test"'));
  assert.ok(suite.includes('test("index route serves the generated app"'));
  // One named test per acceptance journey id.
  for (const journeyId of plan.acceptanceJourneyIds) {
    assert.ok(suite.includes(`acceptance journey: ${journeyId}`), journeyId);
  }

  // Replay the generated suite's logic in-process: every acceptance journey
  // passes against the generated app (server up, page anchors, api round-trip).
  const directory = await makeWorkspace(app);
  const server = await loadServer(directory);
  const routes = JSON.parse(byPath.get("routes.json") ?? "[]") as Array<{
    journeyId: string;
    name: string;
    steps: number;
    path: string;
  }>;
  const routeByJourney = new Map(routes.map((route) => [route.journeyId, route]));

  for (const journeyId of plan.acceptanceJourneyIds) {
    const route = routeByJourney.get(journeyId);
    assert.ok(route !== undefined, journeyId);
    const started = await server.start(0);
    try {
      const baseUrl = `http://127.0.0.1:${started.port}`;
      const response = await fetch(`${baseUrl}${route?.path}`);
      assert.equal(response.status, 200, journeyId);
      assert.ok((response.headers.get("content-type") ?? "").startsWith("text/html"));
      const html = await response.text();
      assert.ok(html.includes(route?.name ?? ""), "journey name anchor");
      assert.ok(html.includes(`data-journey="${journeyId}"`), "journey data-journey anchor");
      assert.ok(html.includes(`data-step-count="${route?.steps}"`), "journey step count anchor");
      const index = await fetch(`${baseUrl}/`);
      assert.equal(index.status, 200);
      await assertApiRoundTrip(baseUrl);
    } finally {
      await started.close();
    }
  }
});

test("materialization composes the seam", async () => {
  const plan = await planSynthesisApp(makeSpec(), makeModel(), ["pkg-a"]);
  const app = generateCandidateApp(plan);

  // Compile-time structural proof: the W1-003 runtime seam (what
  // candidateSeamOf returns) is assignable to the narrow CandidateSeam.
  type RuntimeCandidateSeam = {
    execution: CandidateExecutionProvider;
    workspaces: CandidateWorkspaceProvider;
  };
  const runtimeSeamIsCompatible = (seam: RuntimeCandidateSeam): CandidateSeam => seam;
  assert.equal(typeof runtimeSeamIsCompatible, "function");

  const created: Array<{ reconstructionId: string; kind: string }> = [];
  const seeded: Array<{
    reconstructionId: string;
    workspaceId: string;
    path: string;
    content: string;
  }> = [];
  const builds: Array<{ input: Record<string, unknown>; signal?: AbortSignal }> = [];
  const outcome: CandidateBuildOutcomeShape = {
    steps: [
      {
        name: "build",
        command: "node --check server.ts",
        exitCode: 0,
        stdout: "",
        stderr: "",
        artifacts: [],
      },
    ],
    exitCode: 0,
    succeeded: true,
    artifacts: [],
    harvestFailures: [],
  };
  const seam: CandidateSeam = {
    workspaces: {
      create: async (input) => {
        created.push(input);
        return { id: "ws-candidate-1", path: "/workspace/ws-candidate-1" };
      },
      seedWorkspaceFile: async (input) => {
        seeded.push(input);
        return { path: input.path, bytes: input.content.length, chunks: 1 };
      },
    },
    execution: {
      runCandidateBuild: async (input, signal) => {
        builds.push({ input: input as Record<string, unknown>, signal });
        return outcome;
      },
    },
  };

  const materialization = await materializeCandidate(app, seam, {
    reconstructionId: "rc-w3-0002",
  });
  assert.deepEqual(created, [{ reconstructionId: "rc-w3-0002", kind: "candidate" }]);
  assert.equal(seeded.length, app.files.length);
  assert.deepEqual(
    seeded.map((call) => call.path),
    app.files.map((file) => file.path),
  );
  assert.deepEqual(
    seeded,
    app.files.map((file) => ({
      reconstructionId: "rc-w3-0002",
      workspaceId: "ws-candidate-1",
      path: file.path,
      content: file.content,
    })),
  );
  assert.deepEqual(materialization, {
    reconstructionId: "rc-w3-0002",
    workspaceId: "ws-candidate-1",
    workspacePath: "/workspace/ws-candidate-1",
    buildCommand: "node --check server.ts",
    testCommand: "npx tsx --test journeys.test.ts",
    timeoutMs: 30000,
    network: "deny",
  });

  // The build runner composes runCandidateBuild with the manifest's commands.
  const result = await runGeneratedCandidateBuild(seam, materialization);
  assert.equal(result, outcome);
  assert.equal(builds.length, 1);
  assert.deepEqual(builds[0]?.input, {
    reconstructionId: "rc-w3-0002",
    cwd: "/workspace/ws-candidate-1",
    build: "node --check server.ts",
    test: "npx tsx --test journeys.test.ts",
    timeoutMs: 30000,
    network: "deny",
  });
  assert.equal(builds[0]?.signal, undefined);

  // Custom bounds flow through.
  const bounded = await materializeCandidate(app, seam, {
    reconstructionId: "rc-w3-0002",
    timeoutMs: 12345,
  });
  assert.equal(bounded.timeoutMs, 12345);

  // Invalid apps are refused before any seam call.
  const callsBefore = created.length + seeded.length;
  await assert.rejects(() =>
    materializeCandidate({ ...app, files: [] }, seam, { reconstructionId: "rc-w3-0002" }),
  );
  assert.equal(created.length + seeded.length, callsBefore);
});

test("purity — plan never mutated", async () => {
  const plan = await planSynthesisApp(makeSpec(), makeModel(), ["pkg-a"]);
  const snapshot = structuredClone(plan);

  const app = generateCandidateApp(plan);
  assert.deepStrictEqual(plan, snapshot);

  // The manifest's carried assumptions share no references with the plan.
  app.manifest.assumptions.push({ injected: true });
  assert.deepStrictEqual(plan, snapshot);
});

test("validator catches structural breaks", async () => {
  const plan = await planSynthesisApp(makeSpec(), makeModel(), ["pkg-a"]);
  const app = generateCandidateApp(plan);
  assert.equal(validateGeneratedApp(app).ok, true);

  type Mutation = { name: string; expected: string; apply: (candidate: GeneratedApp) => void };
  const mutations: Mutation[] = [
    {
      name: "missing server",
      expected: '"server.ts"',
      apply: (candidate) => {
        candidate.files = candidate.files.filter((file) => file.path !== "server.ts");
      },
    },
    {
      name: "missing journeys test",
      expected: '"journeys.test.ts"',
      apply: (candidate) => {
        candidate.files = candidate.files.filter((file) => file.path !== "journeys.test.ts");
      },
    },
    {
      name: "missing index page",
      expected: '"pages/index.html"',
      apply: (candidate) => {
        candidate.files = candidate.files.filter((file) => file.path !== "pages/index.html");
      },
    },
    {
      name: "unsorted files",
      expected: "sorted",
      apply: (candidate) => {
        candidate.files = [...candidate.files].reverse();
      },
    },
    {
      name: "duplicate paths",
      expected: "duplicate",
      apply: (candidate) => {
        const index = candidate.files.findIndex((file) => file.path === "package.json");
        assert.ok(index >= 0);
        candidate.files.splice(index, 0, { ...candidate.files[index] });
      },
    },
    {
      name: "journey id without a test",
      expected: "$.manifest.acceptanceJourneyIds[2]",
      apply: (candidate) => {
        candidate.manifest.acceptanceJourneyIds = [
          ...candidate.manifest.acceptanceJourneyIds,
          "j-ghost",
        ];
      },
    },
    {
      name: "external url in content",
      expected: "$.files",
      apply: (candidate) => {
        const file = candidate.files.find((entry) => entry.path === "pages/index.html");
        if (file) {
          file.content = `${file.content}<p>see https://cdn.example.com/app.js</p>`;
        }
      },
    },
    {
      name: "wrong appKind",
      expected: "$.manifest.appKind",
      apply: (candidate) => {
        (candidate.manifest as unknown as Record<string, unknown>).appKind = "mobile";
      },
    },
    {
      name: "timestamp in manifest",
      expected: "$.manifest.generatedAt",
      apply: (candidate) => {
        (candidate.manifest as unknown as Record<string, unknown>).generatedAt =
          "2025-01-01T00:00:00.000Z";
      },
    },
    {
      name: "bad planDigest",
      expected: "$.manifest.planDigest",
      apply: (candidate) => {
        candidate.manifest.planDigest = "not-a-digest";
      },
    },
    {
      name: "empty file set",
      expected: "$.files",
      apply: (candidate) => {
        candidate.files = [];
      },
    },
  ];
  for (const mutation of mutations) {
    const candidate = structuredClone(app);
    mutation.apply(candidate);
    const result = validateGeneratedApp(candidate);
    assert.equal(result.ok, false, mutation.name);
    assert.ok(
      result.errors.some((error) => error.includes(mutation.expected)),
      `${mutation.name}: expected an error mentioning ${mutation.expected}, got: ${result.errors.join("; ")}`,
    );
  }

  // Non-app inputs never throw and always report the root path.
  for (const badInput of [null, undefined, 42, "app", [], true]) {
    const result = validateGeneratedApp(badInput);
    assert.equal(result.ok, false);
    assert.ok(result.errors.length > 0);
    assert.ok(result.errors.every((error) => error.startsWith("$")));
  }
});

test("empty plan degrades honestly", async () => {
  const spec = makeSpec();
  spec.verification.journeys = [];
  const model = makeModel();
  model.journeys = [];
  model.api = {};
  model.data = {};
  const plan = await planSynthesisApp(spec, model, []);
  assert.deepEqual(plan.routes, []);

  const app = generateCandidateApp(plan);
  assert.equal(validateGeneratedApp(app).ok, true);

  // Empty page set for routes, but the index page (route "/") always exists.
  const pageFiles = app.files
    .filter((file) => file.path.startsWith("pages/"))
    .map((file) => file.path);
  assert.deepEqual(pageFiles, ["pages/index.html"]);
  assert.equal(app.manifest.routeCount, 0);
  assert.equal(app.manifest.componentCount, 2);
  assert.deepEqual(app.manifest.acceptanceJourneyIds, []);

  // The planner's honest assumptions are carried verbatim in the manifest.
  const derived = app.manifest.assumptions.filter(
    (entry) => (entry as Record<string, unknown>).source === "synthesis",
  );
  assert.ok(derived.length >= 1);
  assert.ok(
    derived.some((entry) =>
      String((entry as Record<string, unknown>).reason).includes("model.api"),
    ),
  );

  // The index route still serves over loopback.
  const directory = await makeWorkspace(app);
  const server = await loadServer(directory);
  const started = await server.start(0);
  try {
    const response = await fetch(`http://127.0.0.1:${started.port}/`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.ok(html.includes('data-journey="index"'));
    assert.ok(html.includes("No journeys declared."));
  } finally {
    await started.close();
  }
});
