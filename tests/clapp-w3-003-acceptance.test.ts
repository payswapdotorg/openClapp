import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { BehavioralIr, ReconstructionSpec } from "../packages/clapp-contracts/src/index.ts";
import {
  ACCEPTANCE_JOURNEY_TEST_PREFIX,
  CANDIDATE_BUILD_COMMAND,
  CANDIDATE_ENTRYPOINT,
  CANDIDATE_TEST_COMMAND,
  type CandidateBuildOutcomeShape,
  type CandidateSeam,
  digestSuiteCoverage,
  type GeneratedApp,
  generateCandidateApp,
  INDEX_ROUTE_TEST_NAME,
  materializeCandidate,
  type PlanRoute,
  planSynthesisApp,
  ROUTE_COVERAGE_TEST_PREFIX,
  SUITE_FILE_NAME,
  validateGeneratedApp,
} from "../packages/clapp-synthesis/src/index.ts";

/**
 * CLAPP-W3-003 — generated acceptance suite (deepening).
 *
 * Proves the deepened suite contract while every W3-002 pin keeps holding
 * byte-for-byte: step counts pinned from the plan's routes (the IR journeys'
 * observed counts — counts and anchors only, never invented step actions),
 * full-route coverage via additive "route coverage: <journeyId>" tests, an
 * honest coverage digest reporting covered / not-covered with recorded
 * reasons (acceptance selection stays the spec's), byte-determinism, the REAL
 * generated suite running green over in-process loopback, the materialization
 * and validator pins, and fail-closed purity. Deterministic only: no
 * wall-clock, no randomness, no external network — in-process loopback HTTP
 * against the generated server on an ephemeral 127.0.0.1 port is the
 * established pattern (tests/clapp-w3-002-generator.test.ts).
 */

const REPOSITORY_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function makeSpec(): ReconstructionSpec {
  return {
    specVersion: "0.1",
    reconstructionId: "rc-w3-0003",
    targetId: "target-w3-0003",
    name: "W3-003 Fixture Application",
    platform: "web",
    entrypoints: ["/"],
    authorization: {
      ownerId: "owner-1",
      targetId: "target-w3-0003",
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
      id: "app-w3-0003",
      name: "W3-003 Fixture Application",
      platform: "web",
      entrypoints: ["/"],
    },
    evidence: [
      {
        id: "ev-w3-0003",
        targetId: "target-w3-0003",
        reconstructionId: "rc-w3-0003",
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

type WebRoute = { journeyId: string; name: string; steps: number; path: string; page: string };

const tempDirectories: string[] = [];

/** Writes a generated app into a fresh temp dir (the in-process workspace). */
async function makeWorkspace(app: GeneratedApp): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "clapp-w3-003-"));
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

/** The generated suite's source, refusing its absence. */
function suiteOf(app: GeneratedApp): string {
  const file = app.files.find((entry) => entry.path === SUITE_FILE_NAME);
  assert.ok(file !== undefined, `${SUITE_FILE_NAME} is generated`);
  return file.content;
}

/** The generated suite's test names, in emission order. */
function testNamesOf(suite: string): string[] {
  return [...suite.matchAll(/\btest\("([^"]*)"/g)].map((match) => match[1]);
}

/** Parses an embedded JSON.parse(...) constant out of the suite source. */
function embeddedConstantOf(suite: string, name: string): Record<string, unknown> {
  const match = suite.match(new RegExp(`const ${name}[^\\n]*JSON\\.parse\\((".*")\\);`));
  if (match === null || match[1] === undefined) {
    assert.fail(`${name} constant is embedded at generation time`);
  }
  const inner = JSON.parse(match[1]) as string;
  return JSON.parse(inner) as Record<string, unknown>;
}

/** The generated route inventory, keyed by journeyId. */
function routeMapOf(app: GeneratedApp): Map<string, WebRoute> {
  const file = app.files.find((entry) => entry.path === "routes.json");
  assert.ok(file !== undefined, "routes.json is generated");
  const routes = JSON.parse(file.content) as WebRoute[];
  return new Map(routes.map((route) => [route.journeyId, route]));
}

/** Plan routes viewed through the package's PlanRoute shape. */
function planRoutesAsRoutes(plan: { routes: unknown[] }): PlanRoute[] {
  return plan.routes as unknown as PlanRoute[];
}

/**
 * A child-process env without the parent test runner's worker context
 * (NODE_TEST_* would flip a spawned `node --test` into worker mode and
 * swallow its report).
 */
function childProcessEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("NODE_TEST_") || value === undefined) {
      continue;
    }
    env[key] = value;
  }
  return env;
}

after(async () => {
  for (const directory of tempDirectories) {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the W3-002 pins hold unmodified (strict superset)", async () => {
  const plan = await planSynthesisApp(makeSpec(), makeModel(), ["pkg-a"]);
  const app = generateCandidateApp(plan);
  const suite = suiteOf(app);

  // The suite file name stays journeys.test.ts.
  assert.ok(app.files.some((file) => file.path === SUITE_FILE_NAME));
  // The command constants are unchanged.
  assert.equal(CANDIDATE_ENTRYPOINT, "server.ts");
  assert.equal(CANDIDATE_BUILD_COMMAND, "node --check server.ts");
  assert.equal(CANDIDATE_TEST_COMMAND, "npx tsx --test journeys.test.ts");
  assert.equal(app.manifest.entrypoint, CANDIDATE_ENTRYPOINT);
  assert.equal(app.manifest.buildCommand, CANDIDATE_BUILD_COMMAND);
  assert.equal(app.manifest.testCommand, CANDIDATE_TEST_COMMAND);

  // The frozen imports and test names are all present.
  assert.ok(suite.includes('from "./server.ts"'));
  assert.ok(suite.includes('import { test } from "node:test"'));
  assert.ok(suite.includes(`test("${INDEX_ROUTE_TEST_NAME}"`));
  for (const journeyId of plan.acceptanceJourneyIds) {
    assert.ok(
      suite.includes(`test("acceptance journey: ${journeyId}"`),
      `acceptance journey: ${journeyId}`,
    );
  }
  // The frozen acceptance-journey bodies keep their assertion semantics.
  assert.ok(suite.includes('"journey name anchor"'));
  assert.ok(suite.includes('"journey data-journey anchor"'));
  assert.ok(suite.includes('"journey step count anchor"'));
  assert.ok(suite.includes('"index data-journey anchor"'));
  assert.ok(suite.includes("await assertApiRoundTrip(baseUrl);"));

  // New tests were ADDED: full test-name list is a strict superset of W3-002's.
  assert.deepEqual(testNamesOf(suite), [
    INDEX_ROUTE_TEST_NAME,
    "acceptance journey: j-login",
    "acceptance journey: j-search",
    "route coverage: j-logout",
  ]);
  const acceptanceNamed = (suite.match(/test\("acceptance journey: /g) ?? []).length;
  const coverageNamed = (suite.match(/test\("route coverage: /g) ?? []).length;
  assert.equal(acceptanceNamed, 2);
  assert.equal(coverageNamed, 1);

  // The whole frozen W3-002 test file passes without modification.
  const frozen = spawnSync(
    process.execPath,
    ["--import", "tsx", "--test", "tests/clapp-w3-002-generator.test.ts"],
    { cwd: REPOSITORY_ROOT, encoding: "utf8", timeout: 120_000, env: childProcessEnv() },
  );
  assert.equal(
    frozen.status,
    0,
    `the W3-002 suite must pass unmodified\n${`${frozen.stdout ?? ""}\n${frozen.stderr ?? ""}`.slice(-2000)}`,
  );
  assert.match(frozen.stdout ?? "", /tests\s+8/);
  assert.match(frozen.stdout ?? "", /fail\s+0/);
});

test("step counts are plan-derived and never invented", async () => {
  const model = makeModel();
  const plan = await planSynthesisApp(makeSpec(), model, ["pkg-a"]);
  const app = generateCandidateApp(plan);
  const suite = suiteOf(app);

  // The plan's route steps are the IR journeys' observed step counts.
  const observedSteps = new Map(
    model.journeys.map((journey) => [journey.id, journey.steps.length]),
  );
  const routes = planRoutesAsRoutes(plan);
  for (const route of routes) {
    assert.equal(route.steps, observedSteps.get(route.journeyId), route.journeyId);
  }

  // Every step count the suite asserts comes from those plan routes: the
  // acceptance anchors and the route-coverage anchors carry exactly them.
  const htmlAnchors = embeddedConstantOf(suite, "HTML_ANCHORS") as Record<
    string,
    { name: string; steps: number }
  >;
  const routeAnchors = embeddedConstantOf(suite, "ROUTE_ANCHORS") as Record<
    string,
    { journeyId: string; name: string; steps: number }
  >;
  const acceptanceIds = new Set(plan.acceptanceJourneyIds);
  for (const route of routes) {
    if (acceptanceIds.has(route.journeyId)) {
      const anchor = htmlAnchors[route.journeyId];
      assert.ok(anchor !== undefined, route.journeyId);
      assert.equal(anchor.steps, route.steps, `HTML_ANCHORS steps for ${route.journeyId}`);
    } else {
      const anchor = Object.values(routeAnchors).find(
        (entry) => entry.journeyId === route.journeyId,
      );
      assert.ok(anchor !== undefined, route.journeyId);
      assert.equal(anchor.steps, route.steps, `ROUTE_ANCHORS steps for ${route.journeyId}`);
    }
  }

  // Mutating a plan route's steps changes the emitted suite deterministically.
  const mutatedPlan = structuredClone(plan);
  const loginRoute = mutatedPlan.routes[0] as unknown as { journeyId: string; steps: number };
  assert.equal(loginRoute.journeyId, "j-login");
  loginRoute.steps = 7;
  const mutatedApp = generateCandidateApp(structuredClone(mutatedPlan));
  const mutatedAppAgain = generateCandidateApp(structuredClone(mutatedPlan));
  assert.deepStrictEqual(mutatedApp, mutatedAppAgain);
  assert.notEqual(suiteOf(mutatedApp), suite);
  const mutatedAnchors = embeddedConstantOf(suiteOf(mutatedApp), "HTML_ANCHORS") as Record<
    string,
    { steps: number }
  >;
  assert.equal(mutatedAnchors["j-login"]?.steps, 7);
  const mutatedPage = mutatedApp.files
    .find((file) => file.path === "pages/j-login.html")
    ?.content.includes('data-step-count="7"');
  assert.equal(mutatedPage, true);

  // The suite contains NO step-action vocabulary: counts and anchors only.
  for (const file of app.files) {
    assert.ok(!file.content.includes("fill"), `${file.path} mentions fill`);
    assert.ok(!file.content.includes("click"), `${file.path} mentions click`);
    assert.ok(!file.content.includes("#username"), `${file.path} carries the IR fill target`);
    assert.ok(!file.content.includes("#submit"), `${file.path} carries the IR click target`);
    assert.ok(!file.content.includes("#query"), `${file.path} carries the IR fill target`);
    assert.ok(
      !/action\s*:\s*["'](fill|click|type|press|select|submit|goto)["']/.test(file.content),
    );
    assert.ok(!/\.(fill|click|type|press)\s*\(/.test(file.content));
  }
  const stripped = suite.replaceAll("content-type", "");
  assert.ok(!/\btype\b/.test(stripped), "the suite never invents step actions");
});

test("every plan route gains suite coverage", async () => {
  const plan = await planSynthesisApp(makeSpec(), makeModel(), ["pkg-a"]);
  const app = generateCandidateApp(plan);
  const suite = suiteOf(app);
  const acceptanceIds = new Set(plan.acceptanceJourneyIds);

  // Every plan route is pinned by a generated test (acceptance or coverage).
  for (const route of planRoutesAsRoutes(plan)) {
    const expectedTest = acceptanceIds.has(route.journeyId)
      ? `test("acceptance journey: ${route.journeyId}"`
      : `test("route coverage: ${route.journeyId}"`;
    assert.ok(suite.includes(expectedTest), route.journeyId);
  }
  // Non-acceptance routes get ADDITIVE names; acceptance names stay frozen.
  assert.deepEqual(testNamesOf(suite), [
    INDEX_ROUTE_TEST_NAME,
    "acceptance journey: j-login",
    "acceptance journey: j-search",
    "route coverage: j-logout",
  ]);
  const routeAnchors = embeddedConstantOf(suite, "ROUTE_ANCHORS") as Record<
    string,
    { journeyId: string; name: string; steps: number }
  >;
  assert.deepEqual(routeAnchors["/j-logout"], {
    journeyId: "j-logout",
    name: "Sign out",
    steps: 0,
  });

  // The pinned anchors hold over loopback for every plan route.
  const directory = await makeWorkspace(app);
  const server = await loadServer(directory);
  const routes = routeMapOf(app);
  const started = await server.start(0);
  try {
    const baseUrl = `http://127.0.0.1:${started.port}`;
    for (const route of planRoutesAsRoutes(plan)) {
      const emitted = routes.get(route.journeyId);
      assert.ok(emitted !== undefined, route.journeyId);
      const response = await fetch(`${baseUrl}${emitted?.path}`);
      assert.equal(response.status, 200, route.journeyId);
      assert.ok((response.headers.get("content-type") ?? "").startsWith("text/html"));
      const html = await response.text();
      assert.ok(html.includes(`data-journey="${route.journeyId}"`), route.journeyId);
      assert.ok(html.includes(route.name), route.journeyId);
      assert.ok(html.includes(`data-step-count="${route.steps}"`), route.journeyId);
    }
    const index = await fetch(`${baseUrl}/`);
    assert.equal(index.status, 200);
  } finally {
    await started.close();
  }
});

test("generation stays byte-deterministic", async () => {
  const plan = await planSynthesisApp(makeSpec(), makeModel(), ["pkg-a"]);

  const first = generateCandidateApp(structuredClone(plan));
  const second = generateCandidateApp(structuredClone(plan));
  assert.deepStrictEqual(first, second);
  for (const [index, file] of first.files.entries()) {
    assert.equal(file.content, second.files[index]?.content, file.path);
  }
  assert.equal(suiteOf(first), suiteOf(second));

  // A mutated plan regenerates deterministically (byte-identical on repeat).
  const mutatedPlan = structuredClone(plan);
  (mutatedPlan.routes[0] as unknown as { steps: number }).steps = 7;
  const mutatedFirst = generateCandidateApp(structuredClone(mutatedPlan));
  const mutatedSecond = generateCandidateApp(structuredClone(mutatedPlan));
  assert.deepStrictEqual(mutatedFirst, mutatedSecond);
  assert.notEqual(suiteOf(mutatedFirst), suiteOf(first));

  // No timestamp enters any file, and the manifest carries no generatedAt.
  assert.ok(!("generatedAt" in first.manifest));
  for (const file of first.files) {
    assert.ok(
      !/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(file.content),
      `${file.path} carries a timestamp`,
    );
  }
  // The suite reads no environment and no clock. (The frozen W3-002 server.ts
  // keeps its pinned CLAPP_CANDIDATE_PORT read; the deepening adds none.)
  const suite = suiteOf(first);
  assert.ok(!suite.includes("process.env"));
  assert.ok(!/\bDate\b/.test(suite));
  assert.ok(!/\bMath\.random\b/.test(suite));
});

test("acceptance coverage is honest", async () => {
  const plan = await planSynthesisApp(makeSpec(), makeModel(), ["pkg-a"]);
  const app = generateCandidateApp(plan);

  // Full coverage after the deepening, with per-journey reasons.
  const digest = digestSuiteCoverage({ plan, app });
  assert.equal(digest.indexCovered, true);
  assert.deepEqual(digest.totals, { planJourneys: 3, covered: 3, notCovered: 0 });
  assert.deepEqual(
    digest.journeys.map((journey) => [
      journey.journeyId,
      journey.acceptance,
      journey.covered,
      journey.pinningTest,
    ]),
    [
      ["j-login", true, true, "acceptance journey: j-login"],
      ["j-search", true, true, "acceptance journey: j-search"],
      ["j-logout", false, true, "route coverage: j-logout"],
    ],
  );
  for (const journey of digest.journeys) {
    assert.ok(journey.reason.length > 0, journey.journeyId);
    assert.ok(journey.steps >= 0, journey.journeyId);
  }

  // Acceptance selection stays the spec's, never the suite's: a narrower spec
  // selection re-shapes both the emitted tests and the digest's labels.
  const narrowerSpec = makeSpec();
  narrowerSpec.verification.journeys = ["j-login"];
  const narrowerPlan = await planSynthesisApp(narrowerSpec, makeModel(), ["pkg-a"]);
  const narrowerApp = generateCandidateApp(narrowerPlan);
  assert.deepEqual(narrowerPlan.acceptanceJourneyIds, ["j-login"]);
  assert.deepEqual(testNamesOf(suiteOf(narrowerApp)), [
    INDEX_ROUTE_TEST_NAME,
    "acceptance journey: j-login",
    "route coverage: j-search",
    "route coverage: j-logout",
  ]);
  const narrowerDigest = digestSuiteCoverage({ plan: narrowerPlan, app: narrowerApp });
  assert.deepEqual(
    narrowerDigest.journeys.map((journey) => [
      journey.journeyId,
      journey.acceptance,
      journey.covered,
    ]),
    [
      ["j-login", true, true],
      ["j-search", false, true],
      ["j-logout", false, true],
    ],
  );

  // An honest not-covered verdict: a W3-002-era suite (route coverage tests
  // stripped) is still structurally valid, and the digest reports the gap
  // with a recorded reason instead of degrading silently.
  const strippedApp = structuredClone(app);
  const strippedSuiteFile = strippedApp.files.find((file) => file.path === SUITE_FILE_NAME);
  assert.ok(strippedSuiteFile !== undefined);
  const cut = strippedSuiteFile.content.indexOf('\ntest("route coverage: ');
  assert.ok(cut > 0, "route coverage tests are emitted after the acceptance tests");
  strippedSuiteFile.content = `${strippedSuiteFile.content.slice(0, cut)}\n`;
  assert.equal(validateGeneratedApp(strippedApp).ok, true);
  const strippedDigest = digestSuiteCoverage({ plan, app: strippedApp });
  assert.deepEqual(strippedDigest.totals, { planJourneys: 3, covered: 2, notCovered: 1 });
  const uncovered = strippedDigest.journeys.find((journey) => !journey.covered);
  assert.ok(uncovered !== undefined);
  assert.equal(uncovered.journeyId, "j-logout");
  assert.equal(uncovered.pinningTest, null);
  assert.ok(uncovered.reason.includes("no test"), uncovered.reason);

  // Empty plans degrade to index-only coverage with no invented journeys.
  const emptySpec = makeSpec();
  emptySpec.verification.journeys = [];
  const emptyModel = makeModel();
  emptyModel.journeys = [];
  emptyModel.api = {};
  emptyModel.data = {};
  const emptyPlan = await planSynthesisApp(emptySpec, emptyModel, []);
  const emptyApp = generateCandidateApp(emptyPlan);
  const emptyDigest = digestSuiteCoverage({ plan: emptyPlan, app: emptyApp });
  assert.deepEqual(emptyDigest.journeys, []);
  assert.deepEqual(emptyDigest.totals, { planJourneys: 0, covered: 0, notCovered: 0 });
  assert.equal(emptyDigest.indexCovered, true);
  assert.deepEqual(testNamesOf(suiteOf(emptyApp)), [INDEX_ROUTE_TEST_NAME]);
});

test("the REAL generated suite runs green in-process", async () => {
  const plan = await planSynthesisApp(makeSpec(), makeModel(), ["pkg-a"]);
  const app = generateCandidateApp(plan);
  const suite = suiteOf(app);
  const routes = routeMapOf(app);

  // Networking never leaves 127.0.0.1: the suite references loopback only.
  assert.ok(!/https?:\/\/(?!127\.0\.0\.1)/.test(suite));

  // Replay every generated test's logic in-process against the real server.
  const names = testNamesOf(suite);
  assert.deepEqual(names, [
    INDEX_ROUTE_TEST_NAME,
    "acceptance journey: j-login",
    "acceptance journey: j-search",
    "route coverage: j-logout",
  ]);
  const directory = await makeWorkspace(app);
  const server = await loadServer(directory);
  for (const name of names) {
    const started = await server.start(0);
    try {
      const baseUrl = `http://127.0.0.1:${started.port}`;
      if (name === INDEX_ROUTE_TEST_NAME) {
        const response = await fetch(`${baseUrl}/`);
        assert.equal(response.status, 200);
        assert.ok((response.headers.get("content-type") ?? "").startsWith("text/html"));
        const html = await response.text();
        assert.ok(html.includes('data-journey="index"'), name);
        await assertApiRoundTrip(baseUrl);
      } else {
        const prefix = name.startsWith(ACCEPTANCE_JOURNEY_TEST_PREFIX)
          ? ACCEPTANCE_JOURNEY_TEST_PREFIX
          : ROUTE_COVERAGE_TEST_PREFIX;
        const journeyId = name.slice(prefix.length);
        const route = routes.get(journeyId);
        assert.ok(route !== undefined, journeyId);
        const response = await fetch(`${baseUrl}${route?.path}`);
        assert.equal(response.status, 200, name);
        assert.ok((response.headers.get("content-type") ?? "").startsWith("text/html"));
        const html = await response.text();
        assert.ok(html.includes(route?.name ?? ""), `${name} name anchor`);
        assert.ok(html.includes(`data-journey="${journeyId}"`), `${name} data-journey anchor`);
        assert.ok(html.includes(`data-step-count="${route?.steps}"`), `${name} step count anchor`);
        const index = await fetch(`${baseUrl}/`);
        assert.equal(index.status, 200);
        await assertApiRoundTrip(baseUrl);
      }
    } finally {
      await started.close();
    }
  }

  // The real suite file itself runs green (node:test, native type stripping,
  // loopback only — the same tests the frozen testCommand composes).
  const real = spawnSync(process.execPath, ["--test", SUITE_FILE_NAME], {
    cwd: directory,
    encoding: "utf8",
    timeout: 60_000,
    env: childProcessEnv(),
  });
  assert.equal(
    real.status,
    0,
    `the real generated suite must pass\n${`${real.stdout ?? ""}\n${real.stderr ?? ""}`.slice(-2000)}`,
  );
  assert.match(real.stdout ?? "", /tests\s+4/);
  assert.match(real.stdout ?? "", /pass\s+4/);
  assert.match(real.stdout ?? "", /fail\s+0/);
});

test("materialization and validator pins still hold", async () => {
  const plan = await planSynthesisApp(makeSpec(), makeModel(), ["pkg-a"]);
  const app = generateCandidateApp(plan);
  assert.equal(validateGeneratedApp(app).ok, true);

  const created: Array<{ reconstructionId: string; kind: string }> = [];
  const seeded: Array<{
    reconstructionId: string;
    workspaceId: string;
    path: string;
    content: string;
  }> = [];
  const outcome: CandidateBuildOutcomeShape = {
    steps: [],
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
      runCandidateBuild: async () => outcome,
    },
  };

  const materialization = await materializeCandidate(app, seam, {
    reconstructionId: "rc-w3-0002",
  });
  assert.equal(seeded.length, app.files.length);
  // The pinned Materialization shape, byte-for-byte.
  assert.deepEqual(materialization, {
    reconstructionId: "rc-w3-0002",
    workspaceId: "ws-candidate-1",
    workspacePath: "/workspace/ws-candidate-1",
    buildCommand: "node --check server.ts",
    testCommand: "npx tsx --test journeys.test.ts",
    timeoutMs: 30000,
    network: "deny",
  });

  // The validator still passes the deepened app and still catches the
  // W3-002 mutation set.
  type Mutation = { name: string; expected: string; apply: (candidate: GeneratedApp) => void };
  const mutations: Mutation[] = [
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
      name: "timestamp in manifest",
      expected: "$.manifest.generatedAt",
      apply: (candidate) => {
        (candidate.manifest as unknown as Record<string, unknown>).generatedAt =
          "2025-01-01T00:00:00.000Z";
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
});

test("purity and fail-closed deepening", async () => {
  const plan = await planSynthesisApp(makeSpec(), makeModel(), ["pkg-a"]);
  const app = generateCandidateApp(plan);

  // Generation never mutates the plan.
  const planSnapshot = structuredClone(plan);
  generateCandidateApp(plan);
  assert.deepStrictEqual(plan, planSnapshot);

  // The coverage digest never mutates the plan or the app.
  const appSnapshot = structuredClone(app);
  digestSuiteCoverage({ plan, app });
  assert.deepStrictEqual(plan, planSnapshot);
  assert.deepStrictEqual(app, appSnapshot);

  /** Malformed inputs must surface as a collected TypeError, never a digest. */
  function expectCollectedTypeError(run: () => unknown, ...markers: string[]): void {
    let caught: unknown;
    try {
      run();
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof TypeError, `expected a TypeError, got ${String(caught)}`);
    const message = (caught as TypeError).message;
    for (const marker of markers) {
      assert.ok(message.includes(marker), `expected the error to mention ${marker}: ${message}`);
    }
  }

  // Missing suite file fails closed.
  const noSuite = structuredClone(app);
  noSuite.files = noSuite.files.filter((file) => file.path !== SUITE_FILE_NAME);
  expectCollectedTypeError(
    () => digestSuiteCoverage({ plan, app: noSuite }),
    SUITE_FILE_NAME,
    "failed closed",
  );

  // App/plan disagreement fails closed with BOTH the digest mismatch and the
  // routes.json step disagreement collected in one error.
  const mutatedPlan = structuredClone(plan);
  (mutatedPlan.routes[0] as unknown as { steps: number }).steps = 9;
  expectCollectedTypeError(
    () => digestSuiteCoverage({ plan: mutatedPlan, app }),
    "planDigest",
    "routes.json[1]",
  );

  // Wrong manifest counts fail closed (routeCount pulls the page count with it).
  const wrongRouteCount = structuredClone(app);
  wrongRouteCount.manifest.routeCount = 99;
  expectCollectedTypeError(
    () => digestSuiteCoverage({ plan, app: wrongRouteCount }),
    "$.manifest.routeCount",
    "pages:",
  );
  const wrongComponentCount = structuredClone(app);
  wrongComponentCount.manifest.componentCount = 99;
  expectCollectedTypeError(
    () => digestSuiteCoverage({ plan, app: wrongComponentCount }),
    "$.manifest.componentCount",
  );

  // A tampered routes.json (app/plan disagreement at the route level).
  const tamperedRoutes = structuredClone(app);
  const routesFile = tamperedRoutes.files.find((file) => file.path === "routes.json");
  assert.ok(routesFile !== undefined);
  routesFile.content = routesFile.content.replaceAll('"steps":2', '"steps":9');
  expectCollectedTypeError(
    () => digestSuiteCoverage({ plan, app: tamperedRoutes }),
    "routes.json[1]",
    "app/plan disagreement",
  );

  // Multiple malformations are collected into the single fail-closed error.
  const collected = structuredClone(app);
  collected.manifest.routeCount = 99;
  collected.manifest.componentCount = 99;
  expectCollectedTypeError(
    () => digestSuiteCoverage({ plan, app: collected }),
    "$.manifest.routeCount",
    "$.manifest.componentCount",
  );

  // A manifest acceptance selection that disagrees with the plan fails closed.
  const wrongSelection = structuredClone(app);
  wrongSelection.manifest.acceptanceJourneyIds = ["j-logout", "j-login"];
  expectCollectedTypeError(
    () => digestSuiteCoverage({ plan, app: wrongSelection }),
    "$.manifest.acceptanceJourneyIds",
  );
});
