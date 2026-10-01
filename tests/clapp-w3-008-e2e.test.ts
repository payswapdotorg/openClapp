import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  type BenchmarkApp,
  CANONICAL_BENCHMARKS,
  createBenchmarkHarness,
  routeFilePath,
} from "../packages/clapp-benchmarks/src/index.ts";
import type {
  BehavioralIr,
  EvidenceRef,
  ReconstructionSpec,
  SynthesisPlan,
} from "../packages/clapp-contracts/src/index.ts";
import { extractBehavioralIr } from "../packages/clapp-intelligence/src/index.ts";
import {
  canonicalJson,
  canonicalJsonBytes,
  createBrowserObservationAdapter,
  sha256Hex,
} from "../packages/clapp-observation/src/index.ts";
import {
  bindPairedSide,
  CANDIDATE_BUILD_COMMAND,
  CANDIDATE_ENTRYPOINT,
  CANDIDATE_TEST_COMMAND,
  digestE2eAcceptance,
  E2E_BASE_STATE_LIMITATIONS,
  type GeneratedApp,
  generateCandidateApp,
  type PairedJourney,
  type PairedSide,
  planSynthesisApp,
  runPairedSuite,
  runRepairLoop,
  serializePairedReport,
  serializePairedSuite,
  serializeRepairReport,
  serializeSynthesisPlan,
  summarizeRepair,
  validateGeneratedApp,
} from "../packages/clapp-synthesis/src/index.ts";

/**
 * CLAPP-W3-008 — end-to-end app reconstruction acceptance.
 *
 * Proves the integrated wave-1..8 pipeline end-to-end, composed for real at
 * the test seam (the only legal cross-package seam — the packages themselves
 * stay decoupled, and the one synthesis-source addition, the acceptance
 * digest, imports nothing at all):
 *
 *   the REAL canonical benchmark target (B01, B02) served by the REAL
 *   in-process harness on ephemeral loopback ports (W1-005/W3-004 pattern)
 *     -> observation through the REAL W1-002 adapter, whose browser handle is
 *        the W1-002 fake-handle shape BOUND TO REAL CONTENT: every read()
 *        fetches the benchmark's real served page over loopback and returns
 *        its real title and text (pinned clock, the FIXED_MS pattern)
 *     -> the REAL W2-002 extractBehavioralIr (unavailable refs become
 *        assumptions, never observations — ARCHITECTURE.md section 6)
 *     -> the REAL W3-001 planSynthesisApp
 *     -> the REAL W3-002/W3-003 generateCandidateApp, written to a fresh
 *        temp workspace and started in-process (the W3-006 materializer
 *        pattern)
 *     -> the REAL W3-004/W3-005 runPairedSuite (reference side = the real
 *        benchmark harness; candidate side = the generated server)
 *     -> the REAL W3-006 runRepairLoop over the pipeline's own plan, with a
 *        seeded M5 defect class via plan-input mutation (the W3-006
 *        precedent) plus the honest zero-defect path
 *     -> the W3-008 acceptance digest mapping one run onto an honest summary.
 *
 * Honest verdicts only: the final parity verdict is whatever the paired
 * engine actually produced — through the honest channel set the pipeline's
 * minimal candidate genuinely diverges from the rich reference, and every
 * divergence is reported verbatim, never upgraded. Where the reference pages'
 * visual inventory is not expressible in the plan's minimal page model, the
 * visual dimension is DECLARED OFF (the spec's verification.visual = false
 * semantics, the W3-006 honesty note) — never silently dropped, never a
 * fabricated pass. The base-state limitations — target authorization not
 * persisted before observation by this composed chain, package promotion not
 * evaluation-gated by this composed chain — are recorded as limitations,
 * never as passing checks, never fabricated.
 *
 * Deterministic only: the observation clock is pinned, nothing is seeded
 * randomly, and every server interaction is in-process loopback on an
 * ephemeral 127.0.0.1 port — no Chromium, no Docker, no external network.
 */

const REPOSITORY_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const B01 = CANONICAL_BENCHMARKS[0];
const B02 = CANONICAL_BENCHMARKS[1];
if (B01 === undefined || B02 === undefined) throw new Error("canonical benchmarks missing");

const OWNER = "owner-w3-0008";
const FIXED_MS = 1735689600000; // 2025-01-01T00:00:00.000Z — the pinned observation clock
const FIXED_ISO = new Date(FIXED_MS).toISOString();
const fixedClock = () => FIXED_MS;

/** The declared diff-dimension policy of every paired run in this harness. */
const DECLARED_DIMENSIONS = { visual: false } as const;

const tempDirectories: string[] = [];

after(async () => {
  for (const directory of tempDirectories) {
    await rm(directory, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The real-content observation handle (the W1-002 fake-handle shape)
// ---------------------------------------------------------------------------

/** sha256 of a UTF-8 string's bytes. */
function sha256Text(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

/** The deterministic page title of a served HTML document. */
function pageTitle(html: string): string {
  const match = /<title>([\s\S]*?)<\/title>/i.exec(html);
  return match === null ? "" : match[1].trim();
}

/**
 * A deterministic innerText-style extraction of a served HTML document:
 * style/script bodies and comments are dropped, block boundaries become line
 * breaks, tags are stripped, the basic entities are decoded and blank lines
 * collapse. A pure function of the served bytes — the real page text.
 */
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

/**
 * The browser handle: exactly the W1-002 structural seam shape (create /
 * navigate / read; no preview — this binding reads pages, it does not render
 * pixels), bound to REAL content: every read() GETs the benchmark's real
 * served page over loopback and returns its real title and text. The
 * PageSnapshot url records the stable route identity — the ephemeral loopback
 * origin is transport detail, deliberately kept out of the deterministic
 * evidence (the same discipline that keeps ports out of the DiffReport).
 */
function realPageHandle(baseUrl: () => string) {
  const SESSION_ID = "00000000-w3-0008-0000-000000000001";
  let currentRoute = "about:blank";
  const calls: { capability: string; owner: string; target?: string }[] = [];
  return {
    calls,
    async create(owner: string, url: string) {
      calls.push({ capability: "create", owner, target: url });
      currentRoute = url;
      return {
        id: SESSION_ID,
        title: "Benchmark session",
        url,
        status: "idle",
        updatedAt: FIXED_ISO,
      };
    },
    async navigate(owner: string, id: string, url: string) {
      calls.push({ capability: "navigate", owner, target: url });
      if (id !== SESSION_ID) throw new Error(`unknown session ${id}`);
      currentRoute = url;
      return {
        id,
        title: "Benchmark session",
        url,
        status: "idle",
        updatedAt: FIXED_ISO,
      };
    },
    async read(owner: string, id: string) {
      calls.push({ capability: "read", owner });
      if (id !== SESSION_ID) throw new Error(`unknown session ${id}`);
      const response = await fetch(`${baseUrl()}${currentRoute}`);
      const html = await response.text();
      if (!response.ok) {
        throw new Error(`benchmark route ${currentRoute} responded ${response.status}`);
      }
      return {
        url: currentRoute,
        title: pageTitle(html),
        text: htmlToText(html),
        truncated: false,
      };
    },
  };
}

/** Observes a benchmark's real served pages through the REAL W1-002 adapter. */
async function observeBenchmark(app: BenchmarkApp, spec: ReconstructionSpec) {
  const harness = createBenchmarkHarness(app);
  const started = await harness.start();
  try {
    const handle = realPageHandle(() => started.baseUrl);
    const adapter = createBrowserObservationAdapter({
      ownerId: OWNER,
      browser: handle,
      now: fixedClock,
    });
    const bundle = await adapter.observe(spec);
    return { adapter, bundle, handle };
  } finally {
    await started.stop();
  }
}

// ---------------------------------------------------------------------------
// The composed chain
// ---------------------------------------------------------------------------

/**
 * The reconstruction spec of one end-to-end run. The entrypoints are the
 * benchmark's real route paths; the acceptance journeys are the ids the real
 * extraction derives for them (visit:<route>).
 *
 * verification.visual is DECLARED false: the reference pages' visual
 * inventory (nav links, multi-level headings, footers) is not expressible in
 * the plan's minimal single-h1 page model — the spec's own honest semantics,
 * mirrored by the dimensions policy every paired run passes explicitly.
 */
function specFor(
  app: BenchmarkApp,
  reconstructionId: string,
  options?: { journeyIds?: string[] },
): ReconstructionSpec {
  return {
    specVersion: "0.1",
    reconstructionId,
    targetId: `target-${app.id}`,
    name: app.name,
    platform: "web",
    entrypoints: app.routes.map((route) => route.path),
    authorization: {
      ownerId: OWNER,
      targetId: `target-${app.id}`,
      scope: ["observe", "reconstruct:ui"],
      environments: ["web", "sandbox"],
      retention: "ephemeral",
      benchmarkOwned: true,
      createdAt: FIXED_ISO,
    },
    exploration: { maxStages: 4, maxActions: 64, maxDurationMs: 300_000, seed: 7 },
    synthesis: { targetStack: "static-web", allowNetwork: false, packagePolicy: "verified-only" },
    verification: {
      journeys: options?.journeyIds ?? app.routes.map((route) => `visit:${route.path}`),
      visual: false,
      network: true,
      state: true,
      maxRepairIterations: 4,
    },
  };
}

/** The acceptance journeys driven against BOTH sides: the benchmark's real routes. */
function pairedJourneysFor(app: BenchmarkApp, options?: { apiChecks?: boolean }): PairedJourney[] {
  return app.routes.map((route) => ({
    id: `j-w3-0008-${app.id.slice("clapp_benchmark_".length)}${
      route.path === "/" ? "-index" : route.path.replaceAll("/", "-")
    }`,
    name: `${app.name} ${route.path} parity`,
    routePath: route.path,
    anchors: [...route.anchors],
    ...(options?.apiChecks ? { apiChecks: [{ path: "/api/" }] } : {}),
  }));
}

/** Writes a generated app into a fresh temp workspace (the W3-006 pattern). */
async function makeWorkspace(app: { files: { path: string; content: string }[] }): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "clapp-w3-0008-"));
  tempDirectories.push(directory);
  for (const file of app.files) {
    const target = join(directory, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content, "utf8");
  }
  return directory;
}

/** A harness bound as one side of the pairing (the reference-side pattern). */
function harnessSide(app: BenchmarkApp): PairedSide {
  return bindPairedSide(createBenchmarkHarness(app), "reference");
}

/**
 * The REAL candidate materialization (the W3-006 materializer pattern): plan
 * -> generateCandidateApp -> fresh workspace -> dynamic import of the
 * generated server.ts -> a PairedSide over its exported start(port). With
 * withSnapshotState the side also exposes the materialized candidate's OWN
 * state artifact (state.json, a pure function of plan.state).
 */
async function materializeSide(plan: SynthesisPlan, options?: { withSnapshotState?: boolean }) {
  const generated = generateCandidateApp(plan);
  const directory = await makeWorkspace(generated);
  const serverModule = (await import(pathToFileURL(join(directory, "server.ts")).href)) as {
    start: (port?: number) => Promise<{ port: number; close: () => Promise<void> }>;
  };
  const side: PairedSide = {
    label: "candidate",
    start: async () => {
      const handle = await serverModule.start(0);
      return {
        port: handle.port,
        baseUrl: `http://127.0.0.1:${handle.port}`,
        stop: handle.close,
      };
    },
  };
  if (options?.withSnapshotState) {
    side.snapshotState = () =>
      JSON.parse(readFileSync(join(directory, "state.json"), "utf8")) as Record<string, unknown>;
  }
  return { generated, directory, side };
}

/** One full end-to-end run over a real benchmark target. */
async function runE2EChain(
  app: BenchmarkApp,
  reconstructionId: string,
  options?: { withSnapshotState?: boolean; apiChecks?: boolean },
) {
  const spec = specFor(app, reconstructionId);
  const observation = await observeBenchmark(app, spec);
  const ir = extractBehavioralIr({ bundle: observation.bundle, spec });
  const plan = await planSynthesisApp(spec, ir, []);
  const materialized = await materializeSide(plan, options);
  const journeys = pairedJourneysFor(app, options);
  const suite = await runPairedSuite({
    journeys,
    reference: harnessSide(app),
    candidate: materialized.side,
    reconstructionId,
    dimensions: DECLARED_DIMENSIONS,
  });
  return {
    spec,
    ...observation,
    ir,
    plan,
    generated: materialized.generated,
    directory: materialized.directory,
    candidate: materialized.side,
    journeys,
    suite,
  };
}

/** A loopback reference side serving the REAL B01 contact page at the pipeline plan's generated route path (the W3-006 literal-reference precedent, bound to real benchmark content). */
function b01ContactReferenceAtGeneratedPath(): PairedSide {
  const contactFile = B01.files.find((file) => file.path === routeFilePath("/contact"));
  if (contactFile === undefined) throw new Error("B01 contact file missing");
  return {
    label: "reference",
    start: async () => {
      const server = createServer((request, response) => {
        const pathname = new URL(request.url ?? "/", "http://w3-0008.invalid").pathname;
        if (pathname === "/visit-contact") {
          const bytes = Buffer.from(contactFile.content, "utf8");
          response.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "content-length": bytes.length,
          });
          response.end(bytes);
          return;
        }
        const notFound = Buffer.from('{"error":"not_found"}', "utf8");
        response.writeHead(404, {
          "content-type": "application/json; charset=utf-8",
          "content-length": notFound.length,
        });
        response.end(notFound);
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      const address = server.address() as AddressInfo;
      return {
        port: address.port,
        baseUrl: `http://127.0.0.1:${address.port}`,
        stop: () =>
          new Promise<void>((resolve) => {
            server.closeAllConnections?.();
            server.close(() => resolve());
          }),
      };
    },
  };
}

/**
 * The seeded M5 visible-text defect over the pipeline's own plan (the W3-006
 * precedent): the /contact route's name is mutated on a clone, and the repair
 * loop re-aligns it against a reference serving the REAL B01 contact content
 * at the plan's generated route path.
 */
async function runSeededDefectRepair(plan: SynthesisPlan) {
  const candidatePlan = structuredClone(plan);
  const contactRoute = candidatePlan.routes.find(
    (route) => (route as { journeyId?: unknown }).journeyId === "visit:/contact",
  );
  if (contactRoute === undefined) throw new Error("pipeline plan carries no visit:/contact route");
  (contactRoute as { name: string }).name = "Say hello"; // the seeded defect
  return runRepairLoop({
    reference: () => b01ContactReferenceAtGeneratedPath(),
    candidatePlan,
    materialize: async (repairPlan: SynthesisPlan) => (await materializeSide(repairPlan)).side,
    journeys: [
      {
        id: "j-w3-0008-repair-seeded",
        name: "pipeline contact visible-text repair",
        routePath: "/visit-contact",
        anchors: ["Get in touch"],
      },
    ],
    budget: 4,
    reconstructionId: "rc-w3-0008-b01",
    dimensions: DECLARED_DIMENSIONS,
  });
}

/** The env for a spawned node:test child (NODE_TEST_* would flip it into worker mode). */
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

/** Recursively collects every key of a JSON-able value. */
function allKeysOf(value: unknown, into: Set<string> = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) allKeysOf(entry, into);
  } else if (typeof value === "object" && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      into.add(key);
      allKeysOf(entry, into);
    }
  }
  return into;
}

// ---------------------------------------------------------------------------
// 1. the full pipeline runs end-to-end on a real benchmark target
// ---------------------------------------------------------------------------

test("the full pipeline runs end-to-end on a real benchmark target", async () => {
  const chain = await runE2EChain(B01, "rc-w3-0008-b01");

  // Observation: the real adapter over the real served pages, pinned clock.
  const { bundle } = chain;
  assert.equal(bundle.targetId, "target-clapp_benchmark_b01");
  assert.equal(bundle.reconstructionId, "rc-w3-0008-b01");
  assert.equal(bundle.refs.length, B01.routes.length * 7); // 7 evidence kinds per entrypoint
  assert.ok(bundle.refs.every((ref) => ref.capturedAt === FIXED_ISO));
  assert.equal(bundle.environment.startedAt, FIXED_ISO);
  assert.equal(bundle.environment.finishedAt, FIXED_ISO);
  assert.equal((bundle.environment.sessionIds as string[]).length, 1);

  // The bundle's refs carry the REAL page evidence: independently re-fetch
  // the benchmark's pages and compare the content digests.
  const evidenceHarness = createBenchmarkHarness(B01);
  const evidenceStarted = await evidenceHarness.start();
  const expectedPages = new Map<string, { title: string; text: string }>();
  try {
    for (const route of B01.routes) {
      const response = await fetch(`${evidenceStarted.baseUrl}${route.path}`);
      const html = await response.text();
      expectedPages.set(route.path, { title: pageTitle(html), text: htmlToText(html) });
    }
  } finally {
    await evidenceStarted.stop();
  }
  const entrypointRefs = bundle.environment.entrypointRefs as Record<string, string[]>;
  for (const route of B01.routes) {
    const expected = expectedPages.get(route.path);
    if (expected === undefined) throw new Error(`no direct fetch for ${route.path}`);
    const ids = entrypointRefs[route.path] ?? [];
    const domText = bundle.refs.find((ref) => ids.includes(ref.id) && ref.kind === "dom-text");
    const pageMeta = bundle.refs.find((ref) => ids.includes(ref.id) && ref.kind === "page-meta");
    if (domText === undefined || pageMeta === undefined) {
      throw new Error(`page evidence missing for ${route.path}`);
    }
    assert.equal(domText.classification, "observed");
    assert.equal(pageMeta.classification, "observed");
    assert.equal(domText.sha256, sha256Text(expected.text)); // the real served text
    assert.equal(
      pageMeta.sha256,
      sha256Hex(canonicalJsonBytes({ url: route.path, title: expected.title })),
    );
  }

  // Extraction: the IR derives its journeys from the observed evidence.
  const { ir } = chain;
  assert.deepEqual(
    ir.journeys.map((journey) => journey.id),
    B01.routes.map((route) => `visit:${route.path}`),
  );
  for (const journey of ir.journeys) {
    assert.equal(journey.steps.length, 1);
    assert.equal(journey.steps[0]?.action, "visit");
    const routePath = journey.steps[0]?.target;
    assert.ok(typeof routePath === "string");
    const evidenceIds = (journey.steps[0]?.assertions?.evidenceIds ?? []) as string[];
    const expectedIds = (entrypointRefs[routePath] ?? []).filter((id) =>
      bundle.refs.some((ref) => ref.id === id && ref.classification === "observed"),
    );
    assert.deepEqual(evidenceIds, expectedIds); // cites exactly the observed page evidence
  }

  // Plan: the routes come from the IR journeys.
  const { plan } = chain;
  assert.deepEqual(
    plan.routes,
    ir.journeys.map((journey) => ({
      journeyId: journey.id,
      name: journey.name,
      steps: journey.steps.length,
    })),
  );
  assert.deepEqual(
    plan.acceptanceJourneyIds,
    B01.routes.map((route) => `visit:${route.path}`),
  );
  assert.deepEqual(plan.packageIds, []);

  // Generation: the file set matches the plan.
  const { generated, suite } = chain;
  assert.equal(validateGeneratedApp(generated).ok, true);
  assert.equal(generated.manifest.routeCount, plan.routes.length);
  assert.equal(generated.files.length, 12); // 6 root files + index + 4 route pages + suite
  assert.deepEqual(
    generated.files.map((file) => file.path),
    [
      "api.json",
      "journeys.test.ts",
      "package.json",
      "pages/index.html",
      "pages/visit-about.html",
      "pages/visit-contact.html",
      "pages/visit-services.html",
      "pages/visit.html",
      "persistence.json",
      "routes.json",
      "server.ts",
      "state.json",
    ],
  );

  // Paired verification: the DiffReport exists with deterministic findings.
  assert.equal(suite.envelopes.length, B01.routes.length);
  assert.equal(suite.verdict, "divergent"); // the honest verdict, reported verbatim
  for (const envelope of suite.envelopes) {
    assert.equal(envelope.report.verdict, "divergent");
    assert.ok(envelope.report.findings.length >= 1);
    assert.ok(envelope.report.findings.every((finding) => finding.dimension === "semantic"));
    assert.notEqual(envelope.report.referenceRunId, envelope.report.candidateRunId);
  }
  assert.ok(suite.findingsByDimension.semantic.length >= 1);
});

// ---------------------------------------------------------------------------
// 2. observation evidence is real and honest about unavailable channels
// ---------------------------------------------------------------------------

test("observation evidence is real and honest about unavailable channels", async () => {
  const chain = await runE2EChain(B01, "rc-w3-0008-b01");
  const { bundle, adapter, ir } = chain;
  const byKind = (kind: string) => bundle.refs.filter((ref) => ref.kind === kind);

  // dom-text and page-meta are OBSERVED from the real benchmark pages.
  for (const kind of ["dom-text", "page-meta"]) {
    for (const ref of byKind(kind)) {
      assert.equal(ref.classification, "observed", `${kind} ref ${ref.id}`);
      // Content addressing is real: the digest matches the stored bytes.
      assert.equal(
        ref.sha256,
        createHash("sha256").update(adapter.evidenceBytes(ref)).digest("hex"),
      );
      assert.equal(ref.redacted, false);
    }
  }
  assert.equal(byKind("dom-text").length, B01.routes.length);
  assert.equal(byKind("page-meta").length, B01.routes.length);
  // The observed dom-text is the real page text (no truncation note).
  for (const ref of byKind("dom-text")) {
    assert.equal(ref.source, "browser-worker read() innerText snapshot");
  }

  // a11y/network/storage (and dom-structure, and screenshot for this
  // read-only binding) are explicit unavailable refs with precise notes.
  const unavailableKinds = ["dom-structure", "a11y", "network", "storage", "screenshot"];
  for (const kind of unavailableKinds) {
    const refs = byKind(kind);
    assert.equal(refs.length, B01.routes.length);
    for (const ref of refs) {
      assert.equal(ref.classification, "unavailable", `${kind} ref ${ref.id}`);
      assert.ok(ref.source.length > 0);
    }
  }
  assert.match(byKind("a11y")[0].source, /lacks an a11y snapshot endpoint/);
  assert.match(byKind("network")[0].source, /lacks a network capture endpoint/);
  assert.match(byKind("storage")[0].source, /lacks a storage state export endpoint/);
  assert.match(byKind("dom-structure")[0].source, /lacks a DOM structure snapshot endpoint/);
  // The unavailable ref's source carries the registry note; the precise
  // binding-level reason lives in the content-addressed manifest payload.
  assert.match(byKind("screenshot")[0].source, /screenshot\(\) png/);
  // The unavailable manifests record the precise reasons.
  for (const kind of ["a11y", "network", "storage"]) {
    const ref = byKind(kind)[0];
    const manifest = JSON.parse(new TextDecoder().decode(adapter.evidenceBytes(ref))) as {
      kind: string;
      reason: string;
    };
    assert.equal(manifest.kind, kind);
    assert.ok(manifest.reason.length > 0);
  }
  const screenshotManifest = JSON.parse(
    new TextDecoder().decode(adapter.evidenceBytes(byKind("screenshot")[0])),
  ) as { kind: string; reason: string };
  assert.equal(screenshotManifest.kind, "screenshot");
  assert.match(screenshotManifest.reason, /no preview method/);

  // The IR records every unavailable ref as an assumption, never an
  // observation (ARCHITECTURE.md section 6).
  const observedIds = new Set(
    bundle.refs.filter((ref) => ref.classification === "observed").map((ref) => ref.id),
  );
  for (const ref of bundle.refs) {
    if (ref.classification !== "unavailable") continue;
    const assumption = ir.assumptions.find(
      (entry) =>
        Array.isArray(entry.evidenceIds) && (entry.evidenceIds as string[]).includes(ref.id),
    );
    if (assumption === undefined) {
      throw new Error(`unavailable ref ${ref.id} (${ref.kind}) is not recorded as an assumption`);
    }
    assert.equal(assumption.reason, ref.source);
  }
  // The evidence carries no promoted classifications.
  for (const ref of ir.evidence as EvidenceRef[]) {
    assert.equal(
      ref.classification,
      ref.kind === "dom-text" || ref.kind === "page-meta" ? "observed" : "unavailable",
    );
  }
  // Journeys and screens cite ONLY observed evidence.
  for (const journey of ir.journeys) {
    for (const step of journey.steps) {
      for (const id of (step.assertions?.evidenceIds ?? []) as string[]) {
        assert.ok(observedIds.has(id), `journey ${journey.id} cites observed evidence only`);
      }
    }
  }
  for (const screen of ir.screens) {
    for (const id of screen.evidenceIds as string[]) {
      assert.ok(observedIds.has(id), `screen cites observed evidence only`);
    }
  }
  // The honest emptiness of the unobservable regions is recorded, not silent.
  assert.ok(
    ir.assumptions.some(
      (entry) => entry.path === "state" && /state left empty/.test(String(entry.reason)),
    ),
  );
  assert.ok(
    ir.assumptions.some(
      (entry) => entry.path === "api" && /api left empty/.test(String(entry.reason)),
    ),
  );
});

// ---------------------------------------------------------------------------
// 3. the generated candidate is the real W3-002/W3-003 output and runs in-process
// ---------------------------------------------------------------------------

test("the generated candidate is the real W3-002/W3-003 output and runs in-process", async () => {
  const chain = await runE2EChain(B01, "rc-w3-0008-b01");
  const { plan, generated, directory } = chain;

  // The pinned surfaces and command constants are unchanged.
  assert.equal(CANDIDATE_ENTRYPOINT, "server.ts");
  assert.equal(CANDIDATE_BUILD_COMMAND, "node --check server.ts");
  assert.equal(CANDIDATE_TEST_COMMAND, "npx tsx --test journeys.test.ts");
  assert.equal(generated.manifest.entrypoint, "server.ts");
  assert.equal(generated.manifest.buildCommand, "node --check server.ts");
  assert.equal(generated.manifest.testCommand, "npx tsx --test journeys.test.ts");
  const packageJson = JSON.parse(
    generated.files.find((file) => file.path === "package.json")?.content ?? "{}",
  ) as { scripts: Record<string, string> };
  assert.deepEqual(packageJson.scripts, {
    build: "node --check server.ts",
    test: "npx tsx --test journeys.test.ts",
  });

  // The JSON inventories carry the plan.
  const routesJson = JSON.parse(readFileSync(join(directory, "routes.json"), "utf8")) as {
    path: string;
    journeyId: string;
    name: string;
    steps: number;
  }[];
  assert.deepEqual(
    routesJson.map((route) => route.path),
    ["/", "/visit", "/visit-about", "/visit-contact", "/visit-services"],
  );
  assert.deepEqual(
    routesJson.slice(1).map((route) => route.journeyId),
    plan.routes.map((route) => (route as { journeyId: string }).journeyId),
  );
  assert.deepEqual(JSON.parse(readFileSync(join(directory, "state.json"), "utf8")), plan.state);
  assert.deepEqual(JSON.parse(readFileSync(join(directory, "api.json"), "utf8")), plan.api);

  // Generation is byte-deterministic: a second generation of the same plan.
  const regenerated = generateCandidateApp(plan);
  assert.deepEqual(regenerated.manifest, generated.manifest);
  assert.deepEqual(
    new Map(regenerated.files.map((file) => [file.path, file.content])),
    new Map(generated.files.map((file) => [file.path, file.content])),
  );

  // The generated server starts on an ephemeral loopback port and serves
  // the plan's routes.
  const serverModule = (await import(pathToFileURL(join(directory, "server.ts")).href)) as {
    start: (port?: number) => Promise<{ port: number; close: () => Promise<void> }>;
  };
  const handle = await serverModule.start(0);
  try {
    assert.ok(handle.port > 0);
    const baseUrl = `http://127.0.0.1:${handle.port}`;
    const indexResponse = await fetch(`${baseUrl}/`);
    assert.equal(indexResponse.status, 200);
    assert.ok((indexResponse.headers.get("content-type") ?? "").startsWith("text/html"));
    const indexHtml = await indexResponse.text();
    assert.ok(indexHtml.includes('data-journey="index"'));
    for (const route of routesJson.slice(1)) {
      const response = await fetch(`${baseUrl}${route.path}`);
      assert.equal(response.status, 200, route.path);
      const html = await response.text();
      assert.ok(html.includes(`data-journey="${route.journeyId}"`), route.path);
      assert.ok(html.includes(`<h1>${route.name}</h1>`), route.path);
      assert.ok(html.includes(`data-step-count="${route.steps}"`), route.path);
    }
    const notFound = await fetch(`${baseUrl}/nope`);
    assert.equal(notFound.status, 404);
  } finally {
    await handle.close();
  }

  // The generated suite pins the anchors and step counts from the plan.
  const suiteSource = readFileSync(join(directory, "journeys.test.ts"), "utf8");
  assert.ok(suiteSource.includes("anchor.steps"), "the suite pins the plan's step counts");
  assert.ok(suiteSource.includes("data-step-count="));
  assert.ok(suiteSource.includes("HTML_ANCHORS"), "the suite embeds the plan-derived anchors");
  for (const journeyId of plan.acceptanceJourneyIds as string[]) {
    assert.ok(
      suiteSource.includes(`acceptance journey: ${journeyId}`),
      `acceptance test for ${journeyId}`,
    );
  }

  // The real suite file replays green (node:test, native type stripping,
  // loopback only — the W3-003 pattern).
  const real = spawnSync(process.execPath, ["--test", "journeys.test.ts"], {
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
  assert.match(real.stdout ?? "", /tests\s+5/);
  assert.match(real.stdout ?? "", /pass\s+5/);
  assert.match(real.stdout ?? "", /fail\s+0/);
});

// ---------------------------------------------------------------------------
// 4. paired verification replays the same journeys on both sides
// ---------------------------------------------------------------------------

test("paired verification replays the same journeys on both sides", async () => {
  const chain = await runE2EChain(B01, "rc-w3-0008-b01");
  const { journeys, candidate, suite } = chain;

  // The same PairedJourney list runs against the reference harness and the
  // generated candidate, in order.
  assert.deepEqual(
    suite.journeys.map((summary) => summary.journeyId),
    journeys.map((journey) => journey.id),
  );
  for (const envelope of suite.envelopes) {
    assert.equal(envelope.report.reconstructionId, "rc-w3-0008-b01");
    // Both sides really started and really served: two page artifacts per journey.
    const pageSides = envelope.artifacts
      .filter((artifact) => artifact.kind === "page")
      .map((artifact) => artifact.side)
      .sort();
    assert.deepEqual(pageSides, ["candidate", "reference"]);
    assert.ok(envelope.transport.referencePort > 0);
    assert.ok(envelope.transport.candidatePort > 0);
  }

  // The serialized DiffReport is deterministic: a second full suite run
  // (fresh reference harness incarnation, fresh candidate servers) is
  // byte-identical.
  const second = await runPairedSuite({
    journeys,
    reference: harnessSide(B01),
    candidate,
    reconstructionId: "rc-w3-0008-b01",
    dimensions: DECLARED_DIMENSIONS,
  });
  assert.equal(serializePairedSuite(second), serializePairedSuite(suite));
  for (const [first, repeat] of zip(suite.envelopes, second.envelopes)) {
    assert.equal(serializePairedReport(repeat.report), serializePairedReport(first.report));
  }

  // The dimension policy is declared and honest: visual is OFF because the
  // plan's minimal page model cannot express the reference inventory (the
  // spec's verification.visual = false semantics) — declared in the spec,
  // passed to every run, never silently dropped, never a fabricated pass.
  assert.equal(chain.spec.verification.visual, false);
  assert.deepEqual(DECLARED_DIMENSIONS, { visual: false });
  assert.deepEqual(suite.findingsByDimension.visual, []);
  // The state dimension does not run: the default-materialized candidate
  // exposes no snapshotState (the honest absence, not an equivalence claim).
  assert.deepEqual(suite.findingsByDimension.state, []);
  // Both sides serve no redirects and no allowlisted protocol headers —
  // the network dimension ran and found equal absence.
  assert.deepEqual(suite.findingsByDimension.network, []);
  // The semantic dimension carries the honest divergences: major anchor,
  // status and content-type gaps plus informational body-length facts.
  assert.ok(suite.findingsByDimension.semantic.length >= 1);
  assert.ok(
    suite.findingsByDimension.semantic.every(
      (finding) => finding.severity === "major" || finding.severity === "info",
    ),
  );
  assert.ok(suite.findingsByDimension.semantic.some((finding) => finding.severity === "major"));
  assert.equal(suite.verdict, "divergent"); // verbatim, never upgraded
});

/** zip for two arrays of equal length. */
function zip<T>(left: T[], right: T[]): [T, T][] {
  if (left.length !== right.length) throw new Error("zip length mismatch");
  return left.map((entry, index) => [entry, right[index] ?? entry] as [T, T]);
}

// ---------------------------------------------------------------------------
// 5. the stateful benchmark exercises the state dimension honestly
// ---------------------------------------------------------------------------

test("the stateful benchmark exercises the state dimension honestly", async () => {
  // The honest full chain on B02: the observation channel set cannot observe
  // storage, so the IR's state stays empty with a recorded assumption, the
  // plan's state stays empty, and the generated state artifact is empty.
  const chain = await runE2EChain(B02, "rc-w3-0008-b02", {
    withSnapshotState: true,
    apiChecks: true,
  });
  const { ir, plan, suite } = chain;
  assert.deepEqual(ir.state, {});
  assert.ok(
    ir.assumptions.some(
      (entry) => entry.path === "state" && /state left empty/.test(String(entry.reason)),
    ),
  );
  assert.deepEqual(plan.state, {});

  // The reference's real API round-trip: GET /api/ serves the seeded store.
  const apiHarness = createBenchmarkHarness(B02);
  const apiStarted = await apiHarness.start();
  try {
    const apiResponse = await fetch(`${apiStarted.baseUrl}/api/`);
    assert.equal(apiResponse.status, 200);
    assert.deepEqual(await apiResponse.json(), B02.stateSeed);
  } finally {
    await apiStarted.stop();
  }

  // The API round-trip through the paired runner: the reference serves the
  // whole-store endpoint, the generated candidate's per-key API surface has
  // no such endpoint (and no derivable keys) — an honest finding.
  const apiFinding = suite.findingsByDimension.semantic.find(
    (finding) => finding.anchor === "/api/",
  );
  if (apiFinding === undefined) throw new Error("the /api/ finding is missing");
  assert.equal(apiFinding.severity, "major");
  assert.equal(apiFinding.expected, 200);
  assert.equal(apiFinding.actual, 404);

  // The state/storage dimension through the snapshotState composition on
  // both sides: the reference exposes the seeded store, the candidate
  // exposes its OWN state artifact (state.json, empty because storage was
  // never observed) — the digests honestly diverge, pre and post, on every
  // driven journey.
  const stateFindings = suite.findingsByDimension.state;
  assert.equal(stateFindings.length, B02.routes.length * 2); // pre + post per journey
  assert.deepEqual([...new Set(stateFindings.map((finding) => finding.anchor))].sort(), [
    "state:post-journey",
    "state:pre-journey",
  ]);
  assert.ok(stateFindings.every((finding) => finding.severity === "major"));
  assert.equal(suite.verdict, "divergent"); // honest, verbatim

  // Where a side does NOT expose state, the state dimension honestly does
  // not participate: the default-materialized candidate (no snapshotState)
  // produces zero state findings — an absence, never an equivalence claim.
  const noStateCandidate = await materializeSide(chain.plan);
  const noStateSuite = await runPairedSuite({
    journeys: [chain.journeys[0] ?? fail("journey missing")],
    reference: harnessSide(B02),
    candidate: noStateCandidate.side,
    reconstructionId: "rc-w3-0008-b02",
    dimensions: DECLARED_DIMENSIONS,
  });
  assert.deepEqual(noStateSuite.findingsByDimension.state, []);

  // The W3-006 authoring precedent: a model SEEDED with the benchmark's
  // state (an authoring input to planning — never claimed as observed)
  // plans the seed into the generated state artifact, which then compares
  // exactly with the reference's seeded store on both exposed sides.
  const seededSpec = specFor(B02, "rc-w3-0008-b02-seeded", { journeyIds: ["settings"] });
  const seededModel: BehavioralIr = {
    schemaVersion: "0.1",
    application: {
      id: "app-w3-0008-b02-seeded",
      name: "Field Notes operations board",
      platform: "web",
      entrypoints: ["/settings"],
    },
    evidence: [],
    journeys: [
      {
        id: "settings",
        name: "Board settings",
        preconditions: [],
        steps: [
          { id: "s-settings-1", action: "visit", target: "/settings" },
          { id: "s-settings-2", action: "visit", target: "/settings" },
        ],
      },
    ],
    screens: [],
    components: [],
    state: structuredClone(B02.stateSeed ?? {}),
    data: {},
    api: {},
    integrations: [],
    assumptions: [],
    constraints: [],
  };
  const seededPlan = await planSynthesisApp(seededSpec, seededModel, []);
  const seededMaterialized = await materializeSide(seededPlan, { withSnapshotState: true });
  // The generated app's state artifact is the seeded state, exactly.
  assert.deepEqual(
    JSON.parse(readFileSync(join(seededMaterialized.directory, "state.json"), "utf8")),
    B02.stateSeed,
  );
  // Both sides expose state and it compares exactly: no state findings.
  const seededSuite = await runPairedSuite({
    journeys: [
      {
        id: "j-w3-0008-b02-seeded-settings",
        name: "B02 seeded settings state parity",
        routePath: "/settings",
        anchors: ["Board settings"],
      },
    ],
    reference: harnessSide(B02),
    candidate: seededMaterialized.side,
    reconstructionId: "rc-w3-0008-b02-seeded",
    dimensions: DECLARED_DIMENSIONS,
  });
  assert.deepEqual(seededSuite.findingsByDimension.state, []);
  assert.equal(seededSuite.verdict, "equivalent");
});

/** A failing stand-in that throws (keeps the journey lookup honest). */
function fail(message: string): never {
  throw new Error(message);
}

// ---------------------------------------------------------------------------
// 6. bounded repair runs and stops honestly
// ---------------------------------------------------------------------------

test("bounded repair runs and stops honestly", async () => {
  const chain = await runE2EChain(B01, "rc-w3-0008-b01");

  // Phase A — the seeded M5 visible-text defect (the W3-006 precedent):
  // real mutations, re-verification through the paired runner, convergence.
  const repaired = await runSeededDefectRepair(chain.plan);
  assert.equal(repaired.converged, true);
  assert.equal(repaired.stoppedBy, "converged");
  assert.equal(repaired.finalVerdict, "equivalent"); // verbatim
  assert.ok(repaired.iterations.length >= 1);
  assert.ok(repaired.iterations.length <= 4, "iterations bounded by the budget");
  assert.ok(repaired.actionsTotal >= 1, "a real mutation was applied");
  assert.ok(
    repaired.iterations.every((iteration) =>
      iteration.mutationClasses.every((mutationClass) => mutationClass === "visible-text"),
    ),
    "only visible-text mutations were applied",
  );
  const lastIteration = repaired.iterations[repaired.iterations.length - 1];
  if (lastIteration === undefined) throw new Error("no repair iteration recorded");
  assert.equal(lastIteration.findingsAfter, 0);
  // The repaired plan carries the reference heading text.
  const repairedRoute = repaired.finalPlan.routes.find(
    (route) => (route as { journeyId?: unknown }).journeyId === "visit:/contact",
  );
  if (repairedRoute === undefined) throw new Error("repaired plan lost the contact route");
  assert.equal((repairedRoute as { name: string }).name, "Get in touch");
  // Abstentions are recorded with reasons (the informational body-length gap).
  assert.ok(repaired.abstained.length >= 1);
  assert.ok(repaired.abstained.every((entry) => entry.reason.length > 0));
  // The human-reviewable digest agrees.
  const summary = summarizeRepair(repaired);
  assert.equal(summary.converged, true);
  assert.equal(summary.stoppedBy, "converged");
  assert.deepEqual(summary.verdictTrajectory, ["equivalent"]);
  assert.deepEqual(summary.mutationClassesUsed, ["visible-text"]);

  // Phase B — the honest zero-defect path against the REAL B01 harness: the
  // pipeline's plan generates /visit-contact, not the reference's /contact,
  // so no plan route generates the journey's page — the mutation is honestly
  // skipped and abstained, and the loop stops by stagnation with the verdict
  // reported verbatim, never upgraded.
  const honest = await runRepairLoop({
    reference: () => harnessSide(B01),
    candidatePlan: structuredClone(chain.plan),
    materialize: async (repairPlan: SynthesisPlan) => (await materializeSide(repairPlan)).side,
    journeys: [
      {
        id: "j-w3-0008-repair-honest",
        name: "pipeline contact honest parity",
        routePath: "/contact",
        anchors: ["Get in touch"],
      },
    ],
    budget: 3,
    reconstructionId: "rc-w3-0008-b01",
    dimensions: DECLARED_DIMENSIONS,
  });
  assert.equal(honest.converged, false);
  assert.equal(honest.stoppedBy, "stagnation");
  assert.equal(honest.iterations.length, 1);
  assert.equal(honest.iterations[0]?.actionsApplied, 0);
  assert.equal(honest.finalVerdict, "divergent"); // verbatim, never upgraded
  const unlocatable = honest.abstained.find((entry) => entry.anchor === "Get in touch");
  if (unlocatable === undefined) throw new Error("the unlocatable mutation is not abstained");
  assert.match(unlocatable.reason, /no plan route generates the page path/);
  assert.ok(honest.abstained.every((entry) => entry.reason.length > 0));

  // Phase C — the absolute budget bound: the same seeded defect with budget 0
  // stops by budget after the initial honest verification, never iterating.
  const budgeted = await runRepairLoop({
    reference: () => b01ContactReferenceAtGeneratedPath(),
    candidatePlan: (() => {
      const candidatePlan = structuredClone(chain.plan);
      const contactRoute = candidatePlan.routes.find(
        (route) => (route as { journeyId?: unknown }).journeyId === "visit:/contact",
      );
      if (contactRoute === undefined) throw new Error("pipeline plan carries no contact route");
      (contactRoute as { name: string }).name = "Say hello";
      return candidatePlan;
    })(),
    materialize: async (repairPlan: SynthesisPlan) => (await materializeSide(repairPlan)).side,
    journeys: [
      {
        id: "j-w3-0008-repair-budget",
        name: "pipeline contact budget-bound repair",
        routePath: "/visit-contact",
        anchors: ["Get in touch"],
      },
    ],
    budget: 0,
    reconstructionId: "rc-w3-0008-b01",
    dimensions: DECLARED_DIMENSIONS,
  });
  assert.equal(budgeted.stoppedBy, "budget");
  assert.equal(budgeted.converged, false);
  assert.equal(budgeted.iterations.length, 0);
  assert.equal(budgeted.finalVerdict, "divergent"); // the initial honest verdict

  // Determinism: the seeded-defect repair is byte-identical across runs.
  const repeat = await runSeededDefectRepair(chain.plan);
  assert.equal(JSON.stringify(repeat), JSON.stringify(repaired));
  assert.equal(serializeRepairReport(repeat), serializeRepairReport(repaired));
});

// ---------------------------------------------------------------------------
// 7. the acceptance digest reports the base state honestly
// ---------------------------------------------------------------------------

test("the acceptance digest reports the base state honestly", async () => {
  const chain = await runE2EChain(B01, "rc-w3-0008-b01");
  const repair = await runSeededDefectRepair(chain.plan);

  const run = {
    reconstructionId: "rc-w3-0008-b01",
    observation: chain.bundle,
    extraction: chain.ir,
    plan: chain.plan,
    candidate: chain.generated,
    verification: chain.suite,
    repair,
    journeys: chain.journeys,
  };
  const runSnapshot = structuredClone(run);
  const digest = digestE2eAcceptance(run);
  // Purity: the run object is never mutated.
  assert.deepEqual(run, runSnapshot);

  // Per-stage outcomes match the actual stage artifacts.
  assert.deepEqual(
    digest.stages.map((stage) => stage.stage),
    ["observation", "extraction", "plan", "generate", "verify", "repair"],
  );
  assert.ok(digest.stages.every((stage) => stage.outcome === "succeeded"));
  assert.match(digest.stages[0]?.reason ?? "", /28 evidence refs \(8 observed, 20 unavailable\)/);
  assert.match(digest.stages[1]?.reason ?? "", /derived 4 journeys and 4 screens/);
  assert.match(digest.stages[2]?.reason ?? "", /planned 4 routes covering 4 acceptance journeys/);
  assert.match(digest.stages[3]?.reason ?? "", /generated 12 files/);
  assert.match(digest.stages[4]?.reason ?? "", /ran 4 journeys on both sides; verdict "divergent"/);
  assert.match(digest.stages[5]?.reason ?? "", /stopped by converged after 1 iterations/);

  // The final parity verdict is verbatim — never upgraded.
  assert.equal(digest.finalParityVerdict, chain.suite.verdict);
  assert.equal(digest.finalParityVerdict, "divergent");

  // The repair outcome is verbatim.
  assert.deepEqual(digest.repair, {
    converged: repair.converged,
    stoppedBy: repair.stoppedBy,
    iterations: repair.iterations.length,
    abstentions: repair.abstained.length,
    finalVerdict: repair.finalVerdict,
  });

  // Journey coverage matches the driven journeys and their verdicts.
  assert.deepEqual(
    digest.journeyCoverage.map((entry) => [entry.journeyId, entry.routePath]),
    chain.journeys.map((journey) => [journey.id, journey.routePath]),
  );
  assert.deepEqual(
    digest.journeyCoverage.map((entry) => entry.verdict),
    chain.suite.journeys.map((summary) => summary.verdict),
  );
  assert.deepEqual(
    digest.journeyCoverage.map((entry) => entry.findingCount),
    chain.suite.journeys.map((summary) => summary.findingCount),
  );

  // The base-state limitations: explicit, never passing checks.
  assert.deepEqual(digest.limitations, E2E_BASE_STATE_LIMITATIONS);
  assert.deepEqual(
    digest.limitations.map((limitation) => limitation.id),
    ["target-authorization-persistence", "package-promotion-gate"],
  );
  for (const limitation of digest.limitations) {
    assert.equal(limitation.status, "limitation");
    assert.ok(limitation.reason.length > 0);
  }
  assert.match(digest.limitations[0]?.reason ?? "", /not persisted before observation/);
  assert.match(digest.limitations[1]?.reason ?? "", /not evaluation-gated/);
  // They are never presented as stages or checks: no stage carries an
  // authorization or promotion outcome.
  assert.ok(
    digest.stages.every(
      (stage) => !/authorization|promot/i.test(stage.stage) && stage.outcome !== "failed",
    ),
  );

  // No aggregate score exists anywhere in the digest.
  const keys = allKeysOf(digest);
  assert.ok(
    [...keys].every((key) => !/score/i.test(key)),
    `no aggregate score key may exist, found: ${[...keys].filter((key) => /score/i.test(key))}`,
  );

  // Deterministic: the same run digests deep-equal.
  assert.deepEqual(digestE2eAcceptance(structuredClone(run)), digest);

  // The empty run is recorded honestly: every stage unavailable (with
  // reasons), no verdict fabricated, the limitations still present.
  const empty = digestE2eAcceptance({});
  assert.deepEqual(
    empty.stages.map((stage) => [stage.stage, stage.outcome]),
    [
      ["observation", "unavailable"],
      ["extraction", "unavailable"],
      ["plan", "unavailable"],
      ["generate", "unavailable"],
      ["verify", "unavailable"],
      ["repair", "unavailable"],
    ],
  );
  assert.ok(empty.stages.every((stage) => stage.reason.length > 0));
  assert.equal(empty.finalParityVerdict, "unavailable");
  assert.equal(empty.repair, null);
  assert.deepEqual(empty.journeyCoverage, []);
  assert.deepEqual(empty.limitations, E2E_BASE_STATE_LIMITATIONS);
});

// ---------------------------------------------------------------------------
// 8. the pipeline is deterministic and the support seam stays in-lane
// ---------------------------------------------------------------------------

test("the pipeline is deterministic and the support seam stays in-lane", async () => {
  // The whole chain re-runs byte-identically: fresh harness incarnations,
  // fresh ephemeral ports, pinned observation clock — identical artifacts.
  const first = await runE2EChain(B01, "rc-w3-0008-b01");
  const second = await runE2EChain(B01, "rc-w3-0008-b01");

  // The bundle: byte-identical under canonical serialization.
  assert.equal(first.bundle.rootSha256, second.bundle.rootSha256);
  assert.equal(canonicalJson(first.bundle), canonicalJson(second.bundle));

  // The IR.
  assert.deepEqual(first.ir, second.ir);

  // The plan.
  assert.equal(serializeSynthesisPlan(first.plan), serializeSynthesisPlan(second.plan));

  // The generated file set.
  const filesOf = (app: GeneratedApp) =>
    new Map(app.files.map((file) => [file.path, file.content]));
  assert.deepEqual(filesOf(first.generated), filesOf(second.generated));
  assert.deepEqual(first.generated.manifest, second.generated.manifest);

  // The serialized DiffReport (the whole suite's deterministic core).
  assert.equal(serializePairedSuite(first.suite), serializePairedSuite(second.suite));

  // The repair report.
  const firstRepair = await runSeededDefectRepair(first.plan);
  const secondRepair = await runSeededDefectRepair(second.plan);
  assert.equal(JSON.stringify(firstRepair), JSON.stringify(secondRepair));
  assert.equal(serializeRepairReport(firstRepair), serializeRepairReport(secondRepair));

  // The support seam stays in-lane: the new synthesis module imports
  // NOTHING at all — no @clapp/observation, @clapp/intelligence or
  // @clapp/benchmarks import exists anywhere in it (the composition lives
  // in this test file, the only legal cross-package seam).
  const moduleSource = await readFile(
    join(REPOSITORY_ROOT, "packages", "clapp-synthesis", "src", "e2e-acceptance.ts"),
    "utf8",
  );
  assert.ok(
    !/@clapp\/(observation|intelligence|benchmarks)/.test(moduleSource),
    "the digest module must not reference the other lanes' packages",
  );
  assert.ok(
    !/\bfrom\s+["']/.test(moduleSource),
    "the digest module must contain no module specifier at all (zero imports)",
  );
  // The synthesis index block is strictly additive: the frozen W3-006 and
  // W3-003 export blocks are intact and the W3-008 block only adds.
  const indexSource = await readFile(
    join(REPOSITORY_ROOT, "packages", "clapp-synthesis", "src", "index.ts"),
    "utf8",
  );
  assert.ok(indexSource.includes("CLAPP-W3-006 additive block"));
  assert.ok(indexSource.includes("CLAPP-W3-003 additive block"));
  assert.ok(indexSource.includes("CLAPP-W3-008 additive block"));
});
