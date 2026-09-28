import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BENCHMARK_SERVE_JS,
  type BenchmarkApp,
  type BenchmarkWorkspaceSeam,
  CANONICAL_BENCHMARKS,
  ClappBenchmarkError,
  canonicalJson,
  createBenchmarkHarness,
  hostBenchmarkInWorkspace,
  hostingContentDigest,
  listBenchmarks,
  resetBenchmarkInWorkspace,
  validateBenchmarkApp,
} from "../packages/clapp-benchmarks/src/index.ts";
import { fileRoutePath, routeFilePath } from "../packages/clapp-benchmarks/src/validate.ts";

/**
 * CLAPP-W1-005 — disposable benchmark hosting and reset.
 *
 * All hosting runs against in-process node:http loopback servers on
 * ephemeral ports (the tests/clapp-w1-002-observation.test.ts precedent):
 * no Chromium, no Docker, no network beyond loopback. The workspace
 * composition tests drive a FAKE seam — a structural literal satisfying
 * the package's declared BenchmarkWorkspaceSeam interface — that records
 * every call and models the W1-003 tombstone semantics (destroyed ids are
 * never reused; new instances get fresh ids).
 */

const URL_PATTERN = /https?:\/\//i;

const B01 = CANONICAL_BENCHMARKS[0];
const B02 = CANONICAL_BENCHMARKS[1];

/** Fetches a route body as text. */
const fetchText = async (url: string): Promise<string> => (await fetch(url)).text();
/** Fetches a route body as raw bytes (byte-identity comparisons). */
const fetchBytes = async (url: string): Promise<Buffer> =>
  Buffer.from(await (await fetch(url)).arrayBuffer());

/** A mutable mirror of BenchmarkApp for corruption cases (kind widened). */
type MutableApp = {
  id: string;
  name: string;
  version: string;
  kind: string;
  files: { path: string; content: string }[];
  routes: { path: string; anchors: string[] }[];
  stateSeed?: Record<string, unknown>;
  startCommand: string;
  assumptions: string[];
};

/** A mutable, unfrozen clone of a canonical benchmark for corruption. */
const mutableClone = (app: BenchmarkApp): MutableApp => structuredClone(app) as MutableApp;

/** One recorded seam call. */
interface SeamCall {
  method: "create" | "destroy" | "seedWorkspaceFile" | "discoverWorkspaces";
  input: unknown;
}

/**
 * The FAKE workspace seam: a structural literal implementing the package's
 * declared interface, recording every call, and modeling the W1-003
 * lifecycle — create allocates a fresh instance id (never reusing a
 * destroyed one), destroy removes the id from the live set, seed writes
 * file bytes into the workspace, discover lists live workspaces. There is
 * deliberately NO execution capability: the seam cannot run builds.
 */
function fakeSeam() {
  const calls: SeamCall[] = [];
  const workspaces = new Map<
    string,
    { path: string; kind: string; instance: number; files: Map<string, string> }
  >();
  const destroyed = new Set<string>();
  let counter = 0;
  const seam: BenchmarkWorkspaceSeam = {
    async create(input) {
      calls.push({ method: "create", input: { ...input } });
      counter += 1;
      const id = `ws-${String(counter).padStart(4, "0")}`;
      const path = `/workspace/clapp/fake/${input.kind}-${counter}`;
      workspaces.set(id, { path, kind: input.kind, instance: counter, files: new Map() });
      return { id, path };
    },
    async destroy(id) {
      calls.push({ method: "destroy", input: id });
      if (!workspaces.has(id))
        throw new Error(`fake seam: no workspace is registered under id "${id}"`);
      workspaces.delete(id);
      destroyed.add(id);
    },
    async seedWorkspaceFile(input) {
      calls.push({ method: "seedWorkspaceFile", input: { ...input } });
      const workspace = workspaces.get(input.workspaceId);
      if (workspace === undefined)
        throw new Error(`fake seam: no workspace is registered under id "${input.workspaceId}"`);
      workspace.files.set(input.path, input.content);
      return {
        path: `${workspace.path}/${input.path}`,
        bytes: Buffer.byteLength(input.content, "utf8"),
        chunks: 1,
      };
    },
    async discoverWorkspaces(input) {
      calls.push({ method: "discoverWorkspaces", input: { ...input } });
      return [...workspaces.entries()].map(([id, workspace]) => ({
        id,
        path: workspace.path,
        kind: workspace.kind as "reference" | "candidate",
        instance: workspace.instance,
        registered: true,
        tombstoned: false,
      }));
    },
  };
  return { seam, calls, workspaces, destroyed };
}

test("canonical benchmarks validate", () => {
  assert.ok(CANONICAL_BENCHMARKS.length >= 2, "at least two canonical benchmarks");
  for (const app of CANONICAL_BENCHMARKS) {
    const check = validateBenchmarkApp(app);
    assert.equal(check.ok, true, `${app.id}: ${check.errors.join("; ")}`);
    assert.deepEqual(check.errors, []);
  }

  // B01 — static marketing site with >= 4 routes.
  assert.equal(B01.kind, "static");
  assert.ok(B01.routes.length >= 4, `B01 routes: ${B01.routes.length}`);
  assert.equal(B01.stateSeed, undefined);
  // B02 — stateful CRUD-ish app with a seed and >= 3 routes.
  assert.equal(B02.kind, "stateful");
  assert.ok(B02.stateSeed !== undefined && B02.stateSeed !== null);
  assert.ok(B02.routes.length >= 3, `B02 routes: ${B02.routes.length}`);

  // Inventory: stable order by id, fresh array, frozen definitions.
  assert.deepEqual(
    listBenchmarks().map((app) => app.id),
    ["clapp_benchmark_b01", "clapp_benchmark_b02"],
  );
  assert.deepEqual(
    listBenchmarks().map((app) => app.id),
    [...CANONICAL_BENCHMARKS].map((app) => app.id),
  );
  assert.ok(Object.isFrozen(CANONICAL_BENCHMARKS[0]));
  assert.ok(Object.isFrozen(CANONICAL_BENCHMARKS[0].files));

  for (const app of CANONICAL_BENCHMARKS) {
    // Files sorted, unique, and every .html file is routed and vice versa.
    const paths = app.files.map((file) => file.path);
    assert.deepEqual([...paths], [...paths].sort(), `${app.id}: files sorted`);
    assert.equal(new Set(paths).size, paths.length, `${app.id}: file paths unique`);
    const routePaths = app.routes.map((route) => route.path);
    assert.deepEqual([...routePaths], [...routePaths].sort(), `${app.id}: routes sorted`);
    assert.equal(new Set(routePaths).size, routePaths.length, `${app.id}: route paths unique`);
    const htmlFiles = paths.filter((path) => path.endsWith(".html"));
    assert.deepEqual(
      htmlFiles.map((path) => fileRoutePath(path)).sort(),
      routePaths.slice().sort(),
      `${app.id}: .html files and routes cover each other exactly`,
    );
    for (const route of app.routes) {
      assert.ok(routeFilePath(route.path) !== undefined);
      assert.equal(
        new Set(route.anchors).size,
        route.anchors.length,
        `${app.id} ${route.path}: unique anchors`,
      );
      // Every anchor is a raw substring of the mapped file (stable inventory).
      const file = app.files.find((candidate) => candidate.path === routeFilePath(route.path));
      assert.ok(file !== undefined);
      for (const anchor of route.anchors)
        assert.ok(
          file.content.includes(anchor),
          `${app.id} ${route.path}: anchor "${anchor}" missing from raw file`,
        );
    }
    // Every benchmark ships the node:http sandbox host, bounded and shared.
    const serve = app.files.find((file) => file.path === "serve.js");
    assert.ok(serve !== undefined, `${app.id}: serve.js present`);
    assert.equal(serve.content, BENCHMARK_SERVE_JS, `${app.id}: canonical serve.js content`);
  }
  // state.json deep-equals the stateSeed (single source of truth).
  const stateFile = B02.files.find((file) => file.path === "state.json");
  assert.ok(stateFile !== undefined);
  assert.equal(canonicalJson(JSON.parse(stateFile.content)), canonicalJson(B02.stateSeed));
});

test("hosting serves routes and anchors deterministically", async () => {
  const first = createBenchmarkHarness(B01);
  const second = createBenchmarkHarness(B01);
  const handle1 = await first.start();
  const handle2 = await second.start();
  assert.notEqual(handle1.port, handle2.port);

  try {
    for (const route of B01.routes) {
      const response = await fetch(`${handle1.baseUrl}${route.path}`);
      assert.equal(response.status, 200, `${route.path} status`);
      assert.match(response.headers.get("content-type") ?? "", /text\/html/);
      const body = await response.text();
      for (const anchor of route.anchors)
        assert.ok(body.includes(anchor), `${route.path}: anchor "${anchor}" not served`);
      // Byte-identical bodies across two independent harness instances.
      const bytes1 = await fetchBytes(`${handle1.baseUrl}${route.path}`);
      const bytes2 = await fetchBytes(`${handle2.baseUrl}${route.path}`);
      assert.ok(bytes1.equals(bytes2), `${route.path}: two instances differ byte-wise`);
    }

    // Anchor occurrence discipline: every anchor occurs exactly once on its
    // page except the deliberate parity-diff stress anchor on /services.
    for (const route of B01.routes) {
      const body = await fetchText(`${handle1.baseUrl}${route.path}`);
      for (const anchor of route.anchors) {
        const occurrences = body.split(anchor).length - 1;
        if (route.path === "/services" && anchor === "Reliability")
          assert.equal(occurrences, 2, "the parity-diff stress anchor repeats exactly twice");
        else
          assert.equal(
            occurrences,
            1,
            `${route.path}: anchor "${anchor}" occurs ${occurrences} times`,
          );
      }
    }

    // Honest failures: unknown routes 404, non-GET methods on pages 405.
    const missing = await fetch(`${handle1.baseUrl}/nowhere`);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error, "not_found");
    const wrongMethod = await fetch(`${handle1.baseUrl}/about`, { method: "PUT" });
    assert.equal(wrongMethod.status, 405);
  } finally {
    await handle1.stop();
    await handle2.stop();
  }
});

test("stateful benchmark round-trips and resets", async () => {
  const harness = createBenchmarkHarness(B02);
  const handle = await harness.start();
  const seedCanonical = canonicalJson(B02.stateSeed);

  // GET /api/ returns the seed, canonically and byte-stably.
  const seedBody = await fetchBytes(`${handle.baseUrl}/api/`);
  const originalDashboard = await fetchBytes(`${handle.baseUrl}/`);
  assert.equal(seedBody.toString("utf8"), seedCanonical);
  assert.equal(
    seedBody.toString("utf8"),
    '{"boardName":"Field Operations Board","openTasks":3,"status":"operational","tasks":["Inspect the intake pump","Replace the filter cartridge","Log the evening reading"]}',
  );
  assert.deepEqual(harness.snapshotState(), B02.stateSeed);

  try {
    // GET / resets nothing (honest reads: snapshot unchanged after GETs).
    await fetchText(`${handle.baseUrl}/`);
    await fetchText(`${handle.baseUrl}/api/`);
    assert.deepEqual(harness.snapshotState(), B02.stateSeed);

    // mutateState changes the served state — visible counter/status lines.
    harness.mutateState({ openTasks: 0, status: "maintenance" });
    const mutated = await fetchText(`${handle.baseUrl}/api/`);
    assert.ok(mutated.includes('"openTasks":0'));
    assert.ok(mutated.includes('"status":"maintenance"'));
    const dashboard = await fetchText(`${handle.baseUrl}/`);
    assert.ok(dashboard.includes("Open tasks: 0"), "visible counter line reflects the mutation");
    assert.ok(dashboard.includes("System status: maintenance"));
    assert.deepEqual(harness.snapshotState(), {
      ...B02.stateSeed,
      openTasks: 0,
      status: "maintenance",
    });

    // PUT /api/ merges a JSON object; POST is the form-compatible alias.
    const put = await fetch(`${handle.baseUrl}/api/`, {
      method: "PUT",
      body: JSON.stringify({ tasks: ["Calibrate the sensor"] }),
    });
    assert.equal(put.status, 200);
    assert.ok((await put.text()).includes("Calibrate the sensor"));
    const post = await fetch(`${handle.baseUrl}/api/`, {
      method: "POST",
      body: JSON.stringify({ openTasks: 1 }),
    });
    assert.equal(post.status, 200);
    const tasksPage = await fetchText(`${handle.baseUrl}/tasks`);
    assert.ok(tasksPage.includes("Calibrate the sensor"), "the backlog renders the mutated list");

    // Malformed updates fail closed.
    const badJson = await fetch(`${handle.baseUrl}/api/`, { method: "PUT", body: "not json {" });
    assert.equal(badJson.status, 400);
    const badShape = await fetch(`${handle.baseUrl}/api/`, { method: "PUT", body: "[1,2]" });
    assert.equal(badShape.status, 400);

    // reset() while running: stops the server, discards the mutated store,
    // re-seeds from stateSeed and restarts on a NEW ephemeral port.
    const portBeforeReset = handle.port;
    await harness.reset();
    const fresh = await harness.start();
    try {
      assert.notEqual(fresh.port, portBeforeReset, "reset() restarts on a new ephemeral port");
      const resetSeed = await fetchBytes(`${fresh.baseUrl}/api/`);
      assert.ok(resetSeed.equals(seedBody), "reset() restores the byte-identical seed");
      const resetDashboard = await fetchBytes(`${fresh.baseUrl}/`);
      assert.ok(
        resetDashboard.equals(originalDashboard),
        "reset() restores byte-identical page content",
      );
      assert.ok(resetDashboard.toString("utf8").includes("Open tasks: 3"));
      assert.deepEqual(harness.snapshotState(), B02.stateSeed);
    } finally {
      await fresh.stop();
    }
    // The stale pre-reset handle stops nothing and never throws.
    await handle.stop();
  } catch (error) {
    await handle.stop();
    throw error;
  }
});

test("static benchmark reset is idempotent", async () => {
  const harness = createBenchmarkHarness(B01);
  const handle = await harness.start();
  const before = await fetchBytes(`${handle.baseUrl}/`);
  const anchorBody = await fetchText(`${handle.baseUrl}/services`);
  assert.equal(anchorBody.split("Reliability").length - 1, 2);
  assert.deepEqual(harness.snapshotState(), {});

  // mutateState fails closed with a typed error on static benchmarks.
  assert.throws(
    () => harness.mutateState({ anything: 1 }),
    (error: unknown) => error instanceof ClappBenchmarkError && error.capability === "harness",
  );

  await harness.reset();
  assert.deepEqual(harness.snapshotState(), {});
  await harness.reset();
  assert.deepEqual(harness.snapshotState(), {});

  const after = await harness.start();
  try {
    const body = await fetchBytes(`${after.baseUrl}/`);
    assert.ok(body.equals(before), "content is byte-identical after two resets");
    assert.deepEqual(harness.snapshotState(), {});
  } finally {
    await after.stop();
  }
});

test("workspace hosting composes the seam", async () => {
  for (const app of [B01, B02]) {
    const fake = fakeSeam();
    const hosting = await hostBenchmarkInWorkspace(app, fake.seam);

    // The workspace is created first, as the reference kind, keyed by the
    // benchmark's stable id (the benchmark is its own reconstruction).
    const createCalls = fake.calls.filter((call) => call.method === "create");
    assert.equal(createCalls.length, 1);
    assert.deepEqual(createCalls[0].input, { reconstructionId: app.id, kind: "reference" });
    assert.equal(hosting.workspaceId, `ws-0001`);
    assert.equal(hosting.workspacePath, `/workspace/clapp/fake/reference-1`);
    assert.equal(hosting.benchmarkId, app.id);

    // Every file is seeded, in path order, none dropped, contents intact.
    const seedCalls = fake.calls.filter((call) => call.method === "seedWorkspaceFile");
    assert.deepEqual(
      seedCalls.map((call) => (call.input as { path: string }).path),
      app.files.map((file) => file.path),
      `${app.id}: seed order follows the files' path order`,
    );
    for (const [index, call] of seedCalls.entries()) {
      const input = call.input as { path: string; content: string };
      assert.equal(input.content, app.files[index].content);
    }
    const workspaceFiles = fake.workspaces.get(hosting.workspaceId)?.files;
    assert.ok(workspaceFiles !== undefined);
    assert.equal(workspaceFiles.size, app.files.length);

    // The hosting returns the start command and route inventory, unexecuted.
    assert.equal(hosting.startCommand, app.startCommand);
    assert.equal(hosting.startCommand, "node serve.js");
    assert.deepEqual(hosting.routes, app.routes);

    // No build executed: the seam has no execution capability at all and
    // only create/seed/discover methods were ever called.
    assert.ok(!("execute" in (fake.seam as object)));
    const methods = new Set(fake.calls.map((call) => call.method));
    assert.deepEqual([...methods].sort(), ["create", "discoverWorkspaces", "seedWorkspaceFile"]);

    // Discovery verified the fresh workspace before success was reported.
    const discoverCalls = fake.calls.filter((call) => call.method === "discoverWorkspaces");
    assert.equal(discoverCalls.length, 1);
    assert.deepEqual(discoverCalls[0].input, { reconstructionId: app.id });

    // The hosting snapshot is immutable: caller mutations cannot drift a reset.
    assert.ok(Object.isFrozen(hosting.app));
    assert.ok(Object.isFrozen(hosting.app.files));
    assert.ok(Object.isFrozen(hosting.routes));
  }
});

test("workspace reset never reuses ids", async () => {
  const fake = fakeSeam();
  const hosting = await hostBenchmarkInWorkspace(B02, fake.seam);
  const originalFiles = new Map(fake.workspaces.get(hosting.workspaceId)?.files);

  const renewed = await resetBenchmarkInWorkspace(fake.seam, hosting);

  // The old id was destroyed and the new hosting uses a DIFFERENT id.
  assert.ok(fake.destroyed.has(hosting.workspaceId));
  const destroyCalls = fake.calls.filter((call) => call.method === "destroy");
  assert.deepEqual(
    destroyCalls.map((call) => call.input),
    [hosting.workspaceId],
  );
  assert.notEqual(renewed.workspaceId, hosting.workspaceId);
  assert.notEqual(renewed.workspacePath, hosting.workspacePath);

  // The new instance's content is byte-identical to the original.
  const renewedFiles = fake.workspaces.get(renewed.workspaceId)?.files;
  assert.ok(renewedFiles !== undefined);
  assert.deepEqual([...renewedFiles.keys()], [...originalFiles.keys()]);
  for (const [path, content] of originalFiles)
    assert.equal(renewedFiles.get(path), content, `${path}: re-seeded content differs`);
  assert.equal(hostingContentDigest(renewed.app), hostingContentDigest(hosting.app));
  assert.deepEqual(renewed.routes, hosting.routes);
  assert.equal(renewed.startCommand, hosting.startCommand);

  // A second reset moves to yet another fresh id — ids are never reused.
  const renewedAgain = await resetBenchmarkInWorkspace(fake.seam, renewed);
  assert.notEqual(renewedAgain.workspaceId, hosting.workspaceId);
  assert.notEqual(renewedAgain.workspaceId, renewed.workspaceId);
  assert.ok(fake.destroyed.has(renewed.workspaceId));
});

test("validator fails closed", () => {
  const expectError = (app: unknown, pattern: RegExp, label: string): void => {
    const result = validateBenchmarkApp(app);
    assert.equal(result.ok, false, `${label}: expected failure`);
    assert.ok(
      result.errors.some((error) => pattern.test(error)),
      `${label}: no path-addressed error matching ${pattern} in ${JSON.stringify(result.errors)}`,
    );
  };

  // Unsorted files.
  {
    const app = mutableClone(B01);
    const swap = app.files[0];
    app.files[0] = app.files[1];
    app.files[1] = swap;
    expectError(app, /files\[1\]\.path: file paths must be sorted and unique/, "unsorted files");
  }
  // Duplicate file path.
  {
    const app = mutableClone(B01);
    app.files.push({ ...app.files[app.files.length - 1] });
    expectError(
      app,
      /files\[\d+\]\.path: file paths must be sorted and unique/,
      "duplicate file path",
    );
  }
  // Route without a file.
  {
    const app = mutableClone(B01);
    app.routes[1].path = "/missing";
    expectError(
      app,
      /routes: no file maps to route "\/missing" \(expected file "missing\.html"\)/,
      "route without a file",
    );
  }
  // Stateful without a seed.
  {
    const app = mutableClone(B02);
    delete app.stateSeed;
    expectError(app, /stateSeed: stateful benchmarks require a stateSeed/, "stateful without seed");
  }
  // Empty anchors.
  {
    const app = mutableClone(B01);
    app.routes[0].anchors = [];
    expectError(app, /routes\[0\]\.anchors: must be a non-empty array/, "empty anchors");
  }
  // Blank and duplicate anchor entries.
  {
    const app = mutableClone(B01);
    app.routes[0].anchors = ["Home", "Home"];
    expectError(app, /routes\[0\]\.anchors\[1\]: duplicate anchor/, "duplicate anchors");
  }
  {
    const app = mutableClone(B01);
    app.routes[0].anchors = ["Home", "  "];
    expectError(app, /routes\[0\]\.anchors\[1\]: must be a non-empty string/, "blank anchor");
  }
  // Unknown kind.
  {
    const app = mutableClone(B01);
    app.kind = "hybrid";
    expectError(app, /kind: must be "static" or "stateful"/, "unknown kind");
  }
  // Static app declaring a stateSeed.
  {
    const app = mutableClone(B01);
    app.stateSeed = { anything: 1 };
    expectError(
      app,
      /stateSeed: only stateful benchmarks may declare a stateSeed/,
      "static with seed",
    );
  }
  // state.json drifting from the seed.
  {
    const app = mutableClone(B02);
    app.stateSeed = { ...app.stateSeed, openTasks: 7 };
    expectError(app, /"state\.json" must deep-equal \$\.stateSeed/, "state.json mismatch");
  }
  // Reserved API prefix on a route.
  {
    const app = mutableClone(B01);
    app.routes[2].path = "/api/tasks";
    expectError(app, /routes\[2\]\.path: the "\/api\/" prefix is reserved/, "api route");
  }
  // Bad id.
  {
    const app = mutableClone(B01);
    app.id = "bench01";
    expectError(app, /id: must be a non-empty string matching/, "bad id");
  }
  // startCommand referencing an external URL.
  {
    const app = mutableClone(B01);
    app.startCommand = "node serve.js && curl http://example.invalid/health";
    expectError(
      app,
      /startCommand: must not reference an external http\(s\) URL/,
      "networky start command",
    );
  }
  // Non-object root fails closed without throwing.
  {
    const result = validateBenchmarkApp(null);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.startsWith("$:")));
  }

  // A valid one passes: fresh clones of both canonical benchmarks.
  assert.equal(validateBenchmarkApp(mutableClone(B01)).ok, true);
  assert.equal(validateBenchmarkApp(mutableClone(B02)).ok, true);
});

test("benchmark content is network-free", async () => {
  for (const app of CANONICAL_BENCHMARKS) {
    // Every file content and the start command are free of external URLs.
    for (const file of app.files)
      assert.ok(
        !URL_PATTERN.test(file.content),
        `${app.id}:${file.path} references an external http(s) URL`,
      );
    assert.ok(!URL_PATTERN.test(app.startCommand), `${app.id}: startCommand references a URL`);

    // Every served page and API body is network-free too (the in-process
    // loopback itself is the only network surface).
    const harness = createBenchmarkHarness(app);
    const handle = await harness.start();
    try {
      for (const route of app.routes) {
        const body = await fetchText(`${handle.baseUrl}${route.path}`);
        assert.ok(!URL_PATTERN.test(body), `${app.id} ${route.path}: served body references a URL`);
      }
      if (app.kind === "stateful") {
        const apiBody = await fetchText(`${handle.baseUrl}/api/`);
        assert.ok(!URL_PATTERN.test(apiBody), `${app.id} /api/: served store references a URL`);
        harness.mutateState({ probe: "marker" });
        const mutatedBody = await fetchText(`${handle.baseUrl}/api/`);
        assert.ok(
          !URL_PATTERN.test(mutatedBody),
          `${app.id} /api/: mutated store references a URL`,
        );
      }
    } finally {
      await handle.stop();
    }
  }
});
