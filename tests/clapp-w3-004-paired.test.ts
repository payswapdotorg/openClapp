import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
import {
  type BenchmarkApp,
  CANONICAL_BENCHMARKS,
  createBenchmarkHarness,
  renderTokens,
  routeFilePath,
} from "../packages/clapp-benchmarks/src/index.ts";
import type { BehavioralIr, ReconstructionSpec } from "../packages/clapp-contracts/src/index.ts";
import {
  bindPairedSide,
  compareSidesSemantically,
  generateCandidateApp,
  type PairedJourney,
  type PairedSide,
  type PairedSideCapture,
  PairedSideError,
  planSynthesisApp,
  runPairedJourney,
  runPairedSuite,
  serializePairedReport,
  serializePairedRun,
  serializePairedSuite,
} from "../packages/clapp-synthesis/src/index.ts";

/**
 * CLAPP-W3-004 — reference/candidate paired runner.
 *
 * Proves the M4 parity runner half end-to-end: the same journey runs against
 * a reference side and a candidate side and produces a deterministic,
 * content-addressed DiffReport with the semantic and state dimensions. The
 * reference side is a REAL benchmark harness from @clapp/benchmarks; the
 * candidate sides are a second harness, tiny structural literal sides
 * (node:http loopback), and the REAL W3-002 generated candidate started
 * in-process via its exported start(port) — all bound through the synthesis
 * package's structural PairedSide interface, imported here at the test seam
 * (the packages themselves stay decoupled). Every server interaction is
 * in-process loopback on ephemeral ports; no Chromium, no Docker, no network.
 *
 * CLAPP-W3-005 supersession note: the runner now compares the visual and
 * network dimensions on the same captures, so the two expectations that
 * pinned finding inventories at the W3-004 four-dimension boundary (the
 * anchor-divergence count and the real-candidate dimension restriction)
 * were updated to the new exact inventories — strengthened, never weakened:
 * every additional finding is named and asserted deterministically.
 */

const B01 = CANONICAL_BENCHMARKS[0];
const B02 = CANONICAL_BENCHMARKS[1];

/** A harness bound as one side of the pairing (the reference-side pattern). */
function harnessSide(label: "reference" | "candidate", app: BenchmarkApp): PairedSide {
  return bindPairedSide(createBenchmarkHarness(app), label);
}

/** The anchors of one fixture route (fail loudly if the fixture changes shape). */
function anchorsOf(app: BenchmarkApp, path: string): string[] {
  const route = app.routes.find((candidate) => candidate.path === path);
  if (route === undefined) throw new Error(`fixture route not found: ${path}`);
  return [...route.anchors];
}

type LiteralSideOptions = {
  label: "reference" | "candidate";
  pages: Record<string, string | (() => string)>;
  /** Runs at the top of every start() (e.g. re-seeding a fresh boot's state). */
  onStart?: () => void;
  /** Runs on every GET before the body resolves (e.g. mutating state on visit). */
  onGet?: (path: string) => void;
  snapshotState?: () => Record<string, unknown>;
};

/** A tiny structural literal side: fixed loopback pages, fresh server per start. */
function literalSide(options: LiteralSideOptions): PairedSide {
  const side: PairedSide = {
    label: options.label,
    start: async () => {
      options.onStart?.();
      const server = createServer((request, response) => {
        const path = new URL(request.url ?? "/", "http://paired-literal.invalid").pathname;
        options.onGet?.(path);
        const page = options.pages[path];
        const notFound = () => {
          const bytes = Buffer.from('{"error":"not_found"}', "utf8");
          response.writeHead(404, {
            "content-type": "application/json; charset=utf-8",
            "content-length": bytes.length,
          });
          response.end(bytes);
        };
        if (page === undefined) {
          notFound();
          return;
        }
        const body = typeof page === "function" ? page() : page;
        const bytes = Buffer.from(body, "utf8");
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-length": bytes.length,
        });
        response.end(bytes);
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
      });
      const port = (server.address() as AddressInfo).port;
      return {
        port,
        baseUrl: `http://127.0.0.1:${port}`,
        stop: () =>
          new Promise<void>((resolve, reject) => {
            server.closeAllConnections?.();
            server.close((error) => {
              if (error) reject(error);
              else resolve();
            });
          }),
      };
    },
  };
  if (options.snapshotState !== undefined) side.snapshotState = options.snapshotState;
  return side;
}

/** A B02-mirroring candidate whose "/" visit mutates state the reference never touches. */
function mutatingB02Candidate(): PairedSide {
  const indexFile = B02.files.find((file) => file.path === routeFilePath("/"));
  if (indexFile === undefined) throw new Error("B02 index file missing");
  const indexContent = indexFile.content;
  let store: Record<string, unknown> = {};
  return literalSide({
    label: "candidate",
    onStart: () => {
      store = structuredClone(B02.stateSeed ?? {}); // fresh boot from the same seed
    },
    onGet: (path) => {
      const previous = Array.isArray(store.visitLog) ? store.visitLog : [];
      store.visitLog = [...previous, path]; // the divergence: a visit the reference never logs
    },
    pages: {
      "/": () => renderTokens(indexContent, store),
    },
    snapshotState: () => structuredClone(store),
  });
}

const tempDirectories: string[] = [];

/** Writes a generated app into a fresh temp dir (the in-process workspace). */
async function makeWorkspace(app: { files: { path: string; content: string }[] }): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "clapp-w3-004-"));
  tempDirectories.push(directory);
  for (const file of app.files) {
    const target = join(directory, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content, "utf8");
  }
  return directory;
}

after(async () => {
  for (const directory of tempDirectories) {
    await rm(directory, { recursive: true, force: true });
  }
});

test("identical sides report equivalent", async () => {
  const journey: PairedJourney = {
    id: "j-b01-home-parity",
    name: "B01 home parity",
    routePath: "/",
    anchors: anchorsOf(B01, "/"),
  };
  const first = await runPairedJourney({
    journey,
    reference: harnessSide("reference", B01),
    candidate: harnessSide("candidate", B01),
  });
  assert.equal(first.report.verdict, "equivalent");
  // Identical sides produce no findings at all — not even informational ones.
  assert.deepEqual(first.report.findings, []);
  // Identical served content hashes to identical inventory digests.
  assert.equal(first.report.referenceRunId, first.report.candidateRunId);
  assert.ok(first.transport.referencePort > 0);
  assert.ok(first.transport.candidatePort > 0);

  // Determinism: a second full run (fresh harness incarnations, new ports)
  // yields a byte-identical canonical report.
  const second = await runPairedJourney({
    journey,
    reference: harnessSide("reference", B01),
    candidate: harnessSide("candidate", B01),
  });
  assert.equal(serializePairedReport(second.report), serializePairedReport(first.report));
  assert.equal(serializePairedRun(second), serializePairedRun(first));
});

test("anchor divergence is detected deterministically", async () => {
  const indexFile = B01.files.find((file) => file.path === routeFilePath("/"));
  if (indexFile === undefined) throw new Error("B01 index file missing");
  const missingAnchor = "Digital craft with a human touch";
  const modified = indexFile.content.replace(missingAnchor, "Digital craft with a gentle hand");
  assert.notEqual(modified, indexFile.content); // the anchor really was removed

  const journey: PairedJourney = {
    id: "j-b01-home-divergence",
    name: "B01 home divergence",
    routePath: "/",
    anchors: anchorsOf(B01, "/"),
  };
  const reference = harnessSide("reference", B01);
  const candidate = literalSide({ label: "candidate", pages: { "/": modified } });
  const run = await runPairedJourney({ journey, reference, candidate });

  assert.equal(run.report.verdict, "divergent");
  // W3-005: the mutated h1 now surfaces in FOUR findings — the semantic
  // anchor gap (W3-004), the two visual heading keys (the reference's
  // h1:Digital craft with a human touch vanished; the candidate's
  // h1:Digital craft with a gentle hand appeared), and the visual skeleton
  // digest catch-all (info). Exactly four, nothing else.
  assert.equal(run.report.findings.length, 4);
  const finding = run.report.findings[0];
  assert.equal(finding.dimension, "semantic");
  assert.equal(finding.severity, "major");
  assert.equal(finding.anchor, missingAnchor);
  assert.deepEqual(finding.expected, anchorsOf(B01, "/"));
  assert.deepEqual(
    finding.actual,
    anchorsOf(B01, "/").filter((anchor) => anchor !== missingAnchor),
  );

  // The visual heading findings: one per one-side-only heading key, each
  // carrying the full heading inventories as expected/actual.
  const headingAnchors = run.report.findings
    .filter((each) => each.anchor.startsWith("visual:heading:"))
    .map((each) => each.anchor);
  assert.deepEqual(headingAnchors, [
    "visual:heading:h1:Digital craft with a gentle hand",
    "visual:heading:h1:Digital craft with a human touch",
  ]);
  const referenceHeadings = [
    { level: 1, text: missingAnchor },
    { level: 2, text: "What we build" },
    { level: 2, text: "How we work" },
  ];
  const candidateHeadings = [
    { level: 1, text: "Digital craft with a gentle hand" },
    ...referenceHeadings.slice(1),
  ];
  assert.deepEqual(run.report.findings[1].expected, referenceHeadings);
  assert.deepEqual(run.report.findings[1].actual, candidateHeadings);
  assert.ok(
    run.report.findings
      .filter((each) => each.anchor.startsWith("visual:heading:"))
      .every((each) => each.dimension === "visual" && each.severity === "major"),
  );

  // The visible-text skeleton digest divergence is the informational
  // catch-all (no structured channel beyond the heading keys changed).
  const skeleton = run.report.findings.find((each) => each.anchor === "visual:skeleton");
  assert.ok(skeleton !== undefined);
  assert.equal(skeleton.severity, "info");

  // Deterministic: a fresh pairing of the same sides reproduces the report byte-for-byte.
  const again = await runPairedJourney({
    journey,
    reference: harnessSide("reference", B01),
    candidate: literalSide({ label: "candidate", pages: { "/": modified } }),
  });
  assert.equal(serializePairedReport(again.report), serializePairedReport(run.report));
});

test("state transition divergence is detected", async () => {
  const journey: PairedJourney = {
    id: "j-b02-dashboard-parity",
    name: "B02 dashboard parity",
    routePath: "/",
    anchors: anchorsOf(B02, "/"),
  };
  const run = await runPairedJourney({
    journey,
    reference: harnessSide("reference", B02),
    candidate: mutatingB02Candidate(),
  });

  assert.equal(run.report.verdict, "divergent");
  const stateFindings = run.report.findings.filter((finding) => finding.dimension === "state");
  assert.equal(stateFindings.length, 1);
  const finding = stateFindings[0];
  assert.equal(finding.severity, "major");
  assert.equal(finding.anchor, "state:post-journey"); // same seed, different transition
  assert.equal(finding.evidenceRefs.length, 2);

  // Both sides' post-journey snapshots are cited through the evidence inventory.
  const artifactById = new Map(run.artifacts.map((artifact) => [artifact.id, artifact]));
  const cited = finding.evidenceRefs
    .map((id) => artifactById.get(id))
    .filter((artifact) => artifact !== undefined);
  assert.equal(cited.length, 2);
  assert.ok(
    cited.every((artifact) => artifact.kind === "state" && artifact.routePath === "state://post"),
  );
  assert.deepEqual([...cited.map((artifact) => artifact.side)].sort(), ["candidate", "reference"]);

  // No pre-journey finding: both sides booted from the identical B02 seed.
  assert.ok(!run.report.findings.some((each) => each.anchor === "state:pre-journey"));
  // No semantic findings: the rendered page bodies are byte-identical.
  assert.ok(run.report.findings.every((each) => each.dimension === "state"));
});

test("blocked verdict on a dead side", async () => {
  const journeys: PairedJourney[] = [
    {
      id: "j-blocked-home",
      name: "B01 home",
      routePath: "/",
      anchors: anchorsOf(B01, "/"),
    },
    {
      id: "j-blocked-about",
      name: "B01 about",
      routePath: "/about",
      anchors: anchorsOf(B01, "/about"),
    },
  ];
  const harness = createBenchmarkHarness(B01);
  const reference = bindPairedSide(harness, "reference");
  const deadCandidate: PairedSide = {
    label: "candidate",
    start: () => Promise.reject(new Error("the candidate side cannot boot")),
  };

  const suite = await runPairedSuite({ journeys, reference, candidate: deadCandidate });
  assert.equal(suite.verdict, "blocked");
  assert.equal(suite.journeys.length, 2);
  for (const summary of suite.journeys) {
    assert.equal(summary.verdict, "blocked");
    assert.equal(summary.findingCount, 1); // one honest finding, never a fabricated diff
  }
  for (const envelope of suite.envelopes) {
    assert.equal(envelope.report.verdict, "blocked");
    assert.equal(envelope.report.findings.length, 1);
    const finding = envelope.report.findings[0];
    assert.equal(finding.severity, "critical");
    assert.equal(finding.dimension, "semantic");
    assert.equal(finding.repairability, "manual");
    assert.deepEqual(finding.expected, { phase: "start", side: "candidate", outcome: "started" });
    assert.deepEqual(finding.actual, {
      phase: "start",
      side: "candidate",
      outcome: "rejected",
      errorKind: "Error",
    });
    assert.deepEqual(finding.evidenceRefs, []);
    assert.deepEqual(envelope.artifacts, []);
  }

  // A single journey run is blocked the same honest way.
  const single = await runPairedJourney({
    journey: journeys[0],
    reference,
    candidate: deadCandidate,
  });
  assert.equal(single.report.verdict, "blocked");

  // The reference side was cleaned up after every blocked run: it starts again.
  const restarted = await harness.start();
  try {
    assert.ok(restarted.port > 0);
  } finally {
    await restarted.stop();
  }
});

test("suite aggregates deterministically", async () => {
  const paths = ["/", "/about", "/services"];
  const journeys: PairedJourney[] = paths.map((path) => ({
    id: `j-b01-suite-${path}`,
    name: `B01 suite ${path}`,
    routePath: path,
    anchors: anchorsOf(B01, path),
  }));

  const first = await runPairedSuite({
    journeys,
    reference: harnessSide("reference", B01),
    candidate: harnessSide("candidate", B01),
  });
  assert.equal(first.verdict, "equivalent");
  assert.deepEqual(
    first.journeys.map((summary) => summary.journeyId),
    journeys.map((journey) => journey.id),
  );
  assert.deepEqual(
    first.journeys.map((summary) => summary.verdict),
    ["equivalent", "equivalent", "equivalent"],
  );
  assert.deepEqual(first.findingsByDimension.semantic, []);
  assert.deepEqual(first.findingsByDimension.state, []);
  assert.equal(first.envelopes.length, 3);

  // Two full suite runs (fresh incarnations, new ports) serialize identically.
  const second = await runPairedSuite({
    journeys,
    reference: harnessSide("reference", B01),
    candidate: harnessSide("candidate", B01),
  });
  assert.equal(serializePairedSuite(second), serializePairedSuite(first));
});

test("paired journey against the REAL generated candidate", async () => {
  // A B01-mirroring spec + behavioral model, planned and generated for real.
  const spec: ReconstructionSpec = {
    specVersion: "0.1",
    reconstructionId: "rc-w3-0004-b01-mirror",
    targetId: "target-w3-0004",
    name: "B01 Mirror Fixture",
    platform: "web",
    entrypoints: ["/"],
    authorization: {
      ownerId: "owner-1",
      targetId: "target-w3-0004",
      scope: ["reconstruct:ui"],
      environments: ["sandbox"],
      retention: "project",
      benchmarkOwned: true,
      createdAt: "2025-01-01T00:00:00.000Z",
    },
    exploration: { maxStages: 4, maxActions: 64, maxDurationMs: 300000, seed: 7 },
    synthesis: { targetStack: "static-web", allowNetwork: false, packagePolicy: "verified-only" },
    verification: {
      journeys: ["home", "about", "services", "contact"],
      visual: true,
      network: false,
      state: true,
      maxRepairIterations: 2,
    },
  };
  const model: BehavioralIr = {
    schemaVersion: "0.1",
    application: {
      id: "app-w3-0004-mirror",
      name: "B01 Mirror Fixture",
      platform: "web",
      entrypoints: ["/"],
    },
    evidence: [],
    journeys: ["home", "about", "services", "contact"].map((id) => ({
      id,
      name: id[0].toUpperCase() + id.slice(1),
      preconditions: [],
      steps: [{ id: `s-${id}-1`, action: "visit", target: `/${id}` }],
    })),
    screens: [],
    components: [],
    state: {},
    data: {}, // B01 is a static site: no persisted data, no API surface
    api: {},
    integrations: [],
    assumptions: [],
    constraints: [],
  };
  const plan = await planSynthesisApp(spec, model, []);
  const generated = generateCandidateApp(plan);

  // Materialize the generated app in-process and bind its exported start(port).
  const directory = await makeWorkspace(generated);
  const serverModule = (await import(pathToFileURL(join(directory, "server.ts")).href)) as {
    start: (port?: number) => Promise<{ port: number; close: () => Promise<void> }>;
  };
  const candidate = bindPairedSide(
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

  const journey: PairedJourney = {
    id: "j-b01-about-parity",
    name: "B01 about parity against the generated candidate",
    routePath: "/about",
    anchors: anchorsOf(B01, "/about"),
    apiChecks: [{ path: "/api/" }],
  };
  const run = await runPairedJourney({
    journey,
    reference: harnessSide("reference", B01),
    candidate,
  });

  // The generated minimal page genuinely lacks B01's anchors: honest divergence.
  assert.equal(run.report.verdict, "divergent");
  const anchorFindings = run.report.findings.filter(
    (finding) => finding.severity === "major" && finding.dimension === "semantic",
  );
  assert.ok(anchorFindings.some((finding) => finding.anchor === "We are Aurora Studio"));
  assert.ok(anchorFindings.some((finding) => finding.anchor === "Home"));
  // W3-005: no state dimension findings (the generated candidate exposes no
  // snapshotState) and no network dimension findings (both sides serve
  // identical deterministic protocol headers with no redirects — including
  // the identical 404s on /api/); the visual dimension reports the honest
  // visual gaps (title, headings, links, skeleton) alongside the semantic
  // anchor gaps — and nothing else.
  assert.ok(!run.report.findings.some((finding) => finding.dimension === "state"));
  assert.ok(!run.report.findings.some((finding) => finding.dimension === "network"));
  assert.ok(
    run.report.findings.every(
      (finding) => finding.dimension === "semantic" || finding.dimension === "visual",
    ),
  );
  const visualFindings = run.report.findings.filter((finding) => finding.dimension === "visual");
  assert.ok(visualFindings.some((finding) => finding.anchor === "visual:title"));
  assert.ok(
    visualFindings.some((finding) => finding.anchor === "visual:heading:h1:We are Aurora Studio"),
  );
  assert.ok(visualFindings.some((finding) => finding.anchor === "visual:skeleton"));
  // Both sides 404 on /api/ (equal absence): no api finding despite the check running.
  assert.ok(!run.report.findings.some((finding) => finding.anchor === "/api/"));

  // The evidence inventory is content-addressed: digests are the sha256 of the
  // bytes each side actually served.
  const aboutFile = B01.files.find((file) => file.path === routeFilePath("/about"));
  if (aboutFile === undefined) throw new Error("B01 about file missing");
  const generatedAbout = generated.files.find((file) => file.path === "pages/about.html");
  if (generatedAbout === undefined) throw new Error("generated about page missing");
  const sha256 = (text: string) =>
    createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
  const pageArtifacts = run.artifacts.filter((artifact) => artifact.kind === "page");
  assert.equal(pageArtifacts.length, 2);
  const referencePageArtifact = pageArtifacts.find((artifact) => artifact.side === "reference");
  const candidatePageArtifact = pageArtifacts.find((artifact) => artifact.side === "candidate");
  assert.ok(referencePageArtifact !== undefined);
  assert.ok(candidatePageArtifact !== undefined);
  assert.equal(referencePageArtifact.digest, sha256(aboutFile.content));
  assert.equal(candidatePageArtifact.digest, sha256(generatedAbout.content));

  const apiArtifacts = run.artifacts.filter((artifact) => artifact.kind === "api");
  assert.equal(apiArtifacts.length, 2);
  assert.ok(
    apiArtifacts.every((artifact) => artifact.routePath === "/api/" && artifact.status === 404),
  );
  assert.ok(run.artifacts.every((artifact) => artifact.id.startsWith("pa-")));
  assert.notEqual(run.report.referenceRunId, run.report.candidateRunId);
});

test("purity and fail-closed binding", async () => {
  // bindPairedSide rejects a missing start() with a typed error naming the capability.
  assert.throws(
    () => bindPairedSide({}),
    (error: unknown) => {
      assert.ok(error instanceof PairedSideError);
      assert.deepEqual(error.missingCapabilities, ["start()"]);
      assert.ok(error.message.includes("start()"));
      return true;
    },
  );
  assert.throws(() => bindPairedSide({ start: "not a function" }), /start\(\)/);
  assert.throws(
    () =>
      bindPairedSide({
        start: async () => ({ port: 1, baseUrl: "http://127.0.0.1:1", stop: async () => {} }),
        snapshotState: 42,
      }),
    (error: unknown) => {
      assert.ok(error instanceof PairedSideError);
      assert.ok(error.missingCapabilities.includes("snapshotState()"));
      return true;
    },
  );

  // A real harness binds (default label "candidate", explicit label honored)
  // and the bound side actually runs.
  const harness = createBenchmarkHarness(B01);
  assert.equal(bindPairedSide(harness).label, "candidate");
  assert.equal(bindPairedSide(harness, "reference").label, "reference");
  const bound = bindPairedSide(harness);
  const handle = await bound.start();
  try {
    assert.ok(handle.port > 0);
    assert.ok(handle.baseUrl.startsWith("http://127.0.0.1:"));
  } finally {
    await handle.stop();
  }

  // compareSidesSemantically is a pure exported core: hand-built captures
  // compare without any I/O, deterministically.
  const referenceCapture: PairedSideCapture = {
    side: "reference",
    journeyId: "j-direct",
    routePath: "/",
    page: {
      status: 200,
      contentType: "text/html; charset=utf-8",
      bodyDigest: "a".repeat(64),
      bodyChars: 100,
      anchorsFound: ["Home"],
      anchorsMissing: [],
    },
    api: [],
  };
  const candidateCapture: PairedSideCapture = {
    side: "candidate",
    journeyId: "j-direct",
    routePath: "/",
    page: {
      status: 200,
      contentType: "text/html; charset=utf-8",
      bodyDigest: "b".repeat(64),
      bodyChars: 100,
      anchorsFound: [],
      anchorsMissing: ["Home"],
    },
    api: [],
  };
  const direct = compareSidesSemantically(referenceCapture, candidateCapture);
  assert.equal(direct.length, 1);
  assert.equal(direct[0].dimension, "semantic");
  assert.equal(direct[0].severity, "major");
  assert.equal(direct[0].anchor, "Home");
  assert.deepEqual(direct[0].expected, ["Home"]);
  assert.deepEqual(direct[0].actual, []);
  assert.deepEqual(
    compareSidesSemantically(structuredClone(referenceCapture), structuredClone(candidateCapture)),
    direct,
  );

  // Journey inputs are never mutated: structuredClone snapshots, deep-equal after runs.
  const journey: PairedJourney = {
    id: "j-purity",
    name: "Purity",
    routePath: "/",
    anchors: anchorsOf(B01, "/"),
    apiChecks: [{ path: "/api/" }],
  };
  const journeySnapshot = structuredClone(journey);
  const sides = {
    reference: harnessSide("reference", B01),
    candidate: harnessSide("candidate", B01),
  };
  const sideKeySnapshot = {
    reference: Object.keys(sides.reference),
    candidate: Object.keys(sides.candidate),
  };
  const single = await runPairedJourney({ journey, ...sides });
  assert.equal(single.report.verdict, "equivalent");
  assert.deepEqual(journey, journeySnapshot);
  assert.deepEqual(Object.keys(sides.reference), sideKeySnapshot.reference);
  assert.deepEqual(Object.keys(sides.candidate), sideKeySnapshot.candidate);

  const journeys: PairedJourney[] = [
    journey,
    { ...journey, id: "j-purity-about", routePath: "/about", anchors: anchorsOf(B01, "/about") },
  ];
  const journeysSnapshot = structuredClone(journeys);
  const suite = await runPairedSuite({ journeys, ...sides });
  assert.equal(suite.verdict, "equivalent");
  assert.deepEqual(journeys, journeysSnapshot);
  assert.deepEqual(journey, journeySnapshot);

  // Invalid journeys fail closed with a TypeError, before anything starts.
  await assert.rejects(
    () =>
      runPairedJourney({
        journey: { ...journey, routePath: "no-leading-slash" },
        ...sides,
      }),
    (error: unknown) => {
      assert.ok(error instanceof TypeError);
      assert.ok(error.message.includes("$.routePath"));
      return true;
    },
  );
});

test("transport facts stay out of the deterministic report", async () => {
  const journey: PairedJourney = {
    id: "j-b01-report-purity",
    name: "B01 report purity",
    routePath: "/",
    anchors: anchorsOf(B01, "/"),
  };
  const harness = createBenchmarkHarness(B01);
  const observedPorts: number[] = [];
  const reference: PairedSide = {
    label: "reference",
    start: async () => {
      const handle = await harness.start();
      observedPorts.push(handle.port);
      return handle;
    },
    snapshotState: harness.snapshotState,
  };
  const candidate = harnessSide("candidate", B01);

  const first = await runPairedJourney({ journey, reference, candidate });
  const second = await runPairedJourney({ journey, reference, candidate });

  // The deterministic cores are byte-identical across runs.
  assert.equal(serializePairedReport(second.report), serializePairedReport(first.report));
  assert.equal(serializePairedRun(second), serializePairedRun(first));

  // The report serialization is exactly the frozen DiffReport shape — no
  // ports, no durations, no transport anywhere.
  const serialized = serializePairedReport(first.report);
  for (const forbidden of [
    "referencePort",
    "candidatePort",
    "startedAtMs",
    "durationMs",
    "transport",
  ]) {
    assert.ok(!serialized.includes(forbidden), `the report must not contain "${forbidden}"`);
  }
  assert.deepEqual(Object.keys(JSON.parse(serialized)).sort(), [
    "candidateRunId",
    "findings",
    "id",
    "reconstructionId",
    "referenceRunId",
    "verdict",
  ]);

  // The envelope's transport field carries the honest nondeterministic facts.
  assert.equal(first.transport.referencePort, observedPorts[0]);
  assert.equal(second.transport.referencePort, observedPorts[1]);
  assert.ok(first.transport.candidatePort > 0);
  assert.ok(Number.isFinite(first.transport.startedAtMs) && first.transport.startedAtMs > 0);
  assert.ok(first.transport.durationMs >= 0);
  assert.ok(second.transport.durationMs >= 0);
});
