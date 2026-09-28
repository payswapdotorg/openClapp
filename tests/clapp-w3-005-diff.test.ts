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
  routeFilePath,
} from "../packages/clapp-benchmarks/src/index.ts";
import type { BehavioralIr, ReconstructionSpec } from "../packages/clapp-contracts/src/index.ts";
import {
  bindPairedSide,
  compareSides,
  compareSidesNetwork,
  compareSidesSemantically,
  compareSidesVisually,
  dimensionArtifactsOf,
  extractVisualInventory,
  generateCandidateApp,
  NETWORK_HEADER_ALLOWLIST,
  networkCaptureOf,
  normalizeDimensions,
  type PairedJourney,
  type PairedSide,
  type PairedSideCapture,
  planSynthesisApp,
  runPairedJourney,
  runPairedSuite,
  serializePairedReport,
  serializePairedRun,
  serializePairedSuite,
} from "../packages/clapp-synthesis/src/index.ts";

/**
 * CLAPP-W3-005 — semantic/visual/network/state diff.
 *
 * Proves the M4 parity report's four minimum dimensions end-to-end: the
 * W3-004 paired runner now compares every capture across semantic, state,
 * visual and network — the latter two through the pure paired-diff core (a
 * derived visual inventory of the served HTML; the deterministic protocol
 * facts of every response). The reference side is a REAL benchmark harness
 * from @clapp/benchmarks (and the REAL W3-002 generated candidate in the
 * four-dimension gate); the synthetic sides are tiny structural literal sides
 * (node:http loopback) carrying precisely seeded visual/network divergences.
 * Every server interaction is in-process loopback on ephemeral ports; no
 * Chromium, no Docker, no external network.
 */

const B01 = CANONICAL_BENCHMARKS[0];

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

// ---------------------------------------------------------------------------
// Literal sides with seeded visual/network divergences
// ---------------------------------------------------------------------------

/** One route of a literal side: body, extra headers, optional redirect. */
type LiteralRoute = {
  body: string | (() => string);
  status?: number;
  /** Extra deterministic response headers (beyond content-type/length). */
  headers?: Record<string, string>;
  /** When set, the route responds 302 with this Location target. */
  redirect?: string;
};

type LiteralSideOptions = {
  label: "reference" | "candidate";
  routes: Record<string, LiteralRoute>;
  onStart?: () => void;
};

/**
 * A tiny structural literal side: fixed loopback routes (bodies, headers,
 * redirects), fresh server per start — the W3-004 literalSide pattern grown
 * the channels W3-005 needs.
 */
function literalSide(options: LiteralSideOptions): PairedSide {
  const side: PairedSide = {
    label: options.label,
    start: async () => {
      options.onStart?.();
      const server = createServer((request, response) => {
        const path = new URL(request.url ?? "/", "http://paired-literal.invalid").pathname;
        const route = options.routes[path];
        if (route === undefined) {
          const bytes = Buffer.from('{"error":"not_found"}', "utf8");
          response.writeHead(404, {
            "content-type": "application/json; charset=utf-8",
            "content-length": bytes.length,
          });
          response.end(bytes);
          return;
        }
        if (route.redirect !== undefined) {
          response.writeHead(302, { location: route.redirect });
          response.end();
          return;
        }
        const body = typeof route.body === "function" ? route.body() : route.body;
        const bytes = Buffer.from(body, "utf8");
        response.writeHead(route.status ?? 200, {
          "content-type": "text/html; charset=utf-8",
          "content-length": bytes.length,
          ...(route.headers ?? {}),
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
  return side;
}

/** The shared visual-test page skeleton both sides render with divergences. */
const VISUAL_SHARED_PARAGRAPH =
  "A long shared paragraph keeps the two bodies within the documented body-length " +
  "tolerance so the semantic dimension stays quiet and every finding below is " +
  "attributable to exactly one seeded visual divergence, nothing else.";

/** The reference visual-test page. */
const VISUAL_REFERENCE_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Reference Title</title></head>
<body>
  <nav><a href="/x">X page</a></nav>
  <main>
    <h1>Shared headline</h1>
    <h2>Section one</h2>
    <p>${VISUAL_SHARED_PARAGRAPH}</p>
    <img src="/img/portrait.png" alt="A portrait">
    <form>
      <input type="text" name="query">
      <button type="submit">Go</button>
    </form>
  </main>
</body>
</html>`;

/** The candidate visual-test page: seeded visual divergences, same skeleton. */
const VISUAL_CANDIDATE_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Candidate Title</title></head>
<body>
  <nav><a href="/x">X page</a><a href="/z">Z page</a></nav>
  <main>
    <h1>Shared headline</h1>
    <h3>Section one</h3>
    <p>${VISUAL_SHARED_PARAGRAPH}</p>
    <form>
      <input type="search" name="query">
      <button type="submit">Go</button>
    </form>
  </main>
</body>
</html>`;

/** The visual-divergent side pair (identical protocol, divergent visuals). */
function visualDivergentSides(): { reference: PairedSide; candidate: PairedSide } {
  return {
    reference: literalSide({
      label: "reference",
      routes: { "/": { body: VISUAL_REFERENCE_HTML } },
    }),
    candidate: literalSide({
      label: "candidate",
      routes: { "/": { body: VISUAL_CANDIDATE_HTML } },
    }),
  };
}

/** The network-divergent side pair (identical content, divergent protocol). */
function networkDivergentSides(): { reference: PairedSide; candidate: PairedSide } {
  return {
    reference: literalSide({
      label: "reference",
      routes: {
        "/": {
          body: VISUAL_REFERENCE_HTML,
          headers: { "cache-control": "max-age=3600", allow: "GET, HEAD" },
        },
        // "/old" serves the same body the candidate's redirect finally
        // delivers (its "/landing" body), so the two /old bodies compare
        // equal and the ONLY /old divergence is the redirect itself.
        "/old": { body: VISUAL_REFERENCE_HTML },
      },
    }),
    candidate: literalSide({
      label: "candidate",
      routes: {
        "/": { body: VISUAL_REFERENCE_HTML, headers: { "cache-control": "no-store" } },
        // The redirect lands on a dedicated header-clean route, so the /old
        // comparison isolates exactly one divergence: the redirect itself.
        "/landing": { body: VISUAL_REFERENCE_HTML },
        "/old": { body: VISUAL_REFERENCE_HTML, redirect: "/landing" },
      },
    }),
  };
}

const tempDirectories: string[] = [];

/** Writes a generated app into a fresh temp dir (the in-process workspace). */
async function makeWorkspace(app: { files: { path: string; content: string }[] }): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "clapp-w3-005-"));
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

// ---------------------------------------------------------------------------

test("identical sides stay equivalent across all four dimensions", async () => {
  const journey: PairedJourney = {
    id: "j-b01-home-four-dimensions",
    name: "B01 home four-dimension parity",
    routePath: "/",
    anchors: anchorsOf(B01, "/"),
  };
  const first = await runPairedJourney({
    journey,
    reference: harnessSide("reference", B01),
    candidate: harnessSide("candidate", B01),
  });

  // Identical sides produce no findings at all across ALL FOUR dimensions —
  // the visual inventory and network protocol facts match too.
  assert.equal(first.report.verdict, "equivalent");
  assert.deepEqual(first.report.findings, []);
  assert.equal(first.report.referenceRunId, first.report.candidateRunId);

  // Both new channels captured evidence: visual and network artifacts exist
  // for each side, content-addressed like every other artifact.
  const visualArtifacts = first.artifacts.filter((artifact) => artifact.kind === "visual");
  const networkArtifacts = first.artifacts.filter((artifact) => artifact.kind === "network");
  assert.equal(visualArtifacts.length, 2);
  assert.equal(networkArtifacts.length, 2);
  assert.ok(first.artifacts.every((artifact) => artifact.id.startsWith("pa-")));
  assert.deepEqual(visualArtifacts.map((artifact) => artifact.side).sort(), [
    "candidate",
    "reference",
  ]);
  assert.deepEqual(networkArtifacts.map((artifact) => artifact.side).sort(), [
    "candidate",
    "reference",
  ]);

  // A second full run (fresh incarnations, new ports, new wall clock) yields
  // a byte-identical deterministic core.
  const second = await runPairedJourney({
    journey,
    reference: harnessSide("reference", B01),
    candidate: harnessSide("candidate", B01),
  });
  assert.equal(serializePairedReport(second.report), serializePairedReport(first.report));
  assert.equal(serializePairedRun(second), serializePairedRun(first));
});

test("visual divergence is detected deterministically", async () => {
  const journey: PairedJourney = {
    id: "j-visual-divergence",
    name: "Seeded visual divergence",
    routePath: "/",
    // Anchors chosen present on BOTH sides: the semantic dimension stays
    // quiet, so every finding is attributable to the seeded visual deltas.
    anchors: ["Shared headline", "Section one"],
  };
  const { reference, candidate } = visualDivergentSides();
  const run = await runPairedJourney({ journey, reference, candidate });

  assert.equal(run.report.verdict, "divergent");

  // Exactly eight visual findings — nothing semantic, nothing network:
  // title (minor), two heading keys (major — the h2 became an h3), the
  // missing image (major), two control keys (major — text became search),
  // the extra link (minor), and the skeleton digest (info).
  assert.ok(run.report.findings.every((finding) => finding.dimension === "visual"));
  assert.equal(run.report.findings.length, 8);

  const byAnchor = new Map(run.report.findings.map((finding) => [finding.anchor, finding]));
  const title = byAnchor.get("visual:title");
  assert.ok(title !== undefined);
  assert.equal(title.severity, "minor");
  assert.equal(title.expected, "Reference Title");
  assert.equal(title.actual, "Candidate Title");

  const demotedHeading = byAnchor.get("visual:heading:h2:Section one");
  assert.ok(demotedHeading !== undefined);
  assert.equal(demotedHeading.severity, "major");
  const promotedHeading = byAnchor.get("visual:heading:h3:Section one");
  assert.ok(promotedHeading !== undefined);
  assert.equal(promotedHeading.severity, "major");
  assert.deepEqual(demotedHeading.expected, [
    { level: 1, text: "Shared headline" },
    { level: 2, text: "Section one" },
  ]);
  assert.deepEqual(promotedHeading.actual, [
    { level: 1, text: "Shared headline" },
    { level: 3, text: "Section one" },
  ]);

  const image = byAnchor.get("visual:image:/img/portrait.png");
  assert.ok(image !== undefined);
  assert.equal(image.severity, "major");
  assert.deepEqual(image.expected, [{ src: "/img/portrait.png", alt: "A portrait" }]);
  assert.deepEqual(image.actual, []);

  assert.ok(byAnchor.get("visual:control:input:text:query") !== undefined);
  assert.ok(byAnchor.get("visual:control:input:search:query") !== undefined);

  const extraLink = byAnchor.get("visual:link:/z");
  assert.ok(extraLink !== undefined);
  assert.equal(extraLink.severity, "minor");
  assert.deepEqual(extraLink.expected, [{ href: "/x", text: "X page" }]);
  assert.deepEqual(extraLink.actual, [
    { href: "/x", text: "X page" },
    { href: "/z", text: "Z page" },
  ]);

  const skeleton = byAnchor.get("visual:skeleton");
  assert.ok(skeleton !== undefined);
  assert.equal(skeleton.severity, "info");
  assert.equal(skeleton.repairability, "manual");

  // Every visual finding cites both sides' visual artifacts.
  const artifactById = new Map(run.artifacts.map((artifact) => [artifact.id, artifact]));
  for (const finding of run.report.findings) {
    assert.equal(finding.evidenceRefs.length, 2);
    for (const id of finding.evidenceRefs) {
      const artifact = artifactById.get(id);
      assert.ok(artifact !== undefined);
      assert.equal(artifact.kind, "visual");
      assert.equal(artifact.routePath, "/");
    }
  }
  assert.deepEqual(
    run.artifacts
      .filter((artifact) => artifact.kind === "visual")
      .map((artifact) => artifact.side)
      .sort(),
    ["candidate", "reference"],
  );

  // Deterministic: a fresh pairing of the same sides reproduces the report
  // byte-for-byte.
  const again = await runPairedJourney({
    journey,
    ...visualDivergentSides(),
  });
  assert.equal(serializePairedReport(again.report), serializePairedReport(run.report));
});

test("network divergence is detected deterministically", async () => {
  const journey: PairedJourney = {
    id: "j-network-divergence",
    name: "Seeded network divergence",
    routePath: "/",
    anchors: ["Shared headline"],
    apiChecks: [{ path: "/old" }],
  };
  const { reference, candidate } = networkDivergentSides();
  const run = await runPairedJourney({ journey, reference, candidate });

  assert.equal(run.report.verdict, "divergent");

  // Exactly three network findings: two page-level header divergences (the
  // cache-control value changed; the allow header vanished) and one
  // redirect divergence on the /old API check. The page bodies are
  // byte-identical and the /old bodies compare equal after the redirect, so
  // nothing semantic or visual fires.
  assert.ok(run.report.findings.every((finding) => finding.dimension === "network"));
  assert.equal(run.report.findings.length, 3);

  const cacheControl = run.report.findings.find(
    (finding) => finding.anchor === "network:header:cache-control",
  );
  assert.ok(cacheControl !== undefined);
  assert.equal(cacheControl.severity, "minor");
  assert.equal(cacheControl.expected, "max-age=3600");
  assert.equal(cacheControl.actual, "no-store");

  const allow = run.report.findings.find((finding) => finding.anchor === "network:header:allow");
  assert.ok(allow !== undefined);
  assert.equal(allow.severity, "minor");
  assert.equal(allow.expected, "GET, HEAD");
  assert.equal(allow.actual, null);

  const redirect = run.report.findings.find(
    (finding) => finding.anchor === "network:redirect:/old",
  );
  assert.ok(redirect !== undefined);
  assert.equal(redirect.severity, "major");
  assert.equal(redirect.expected, false);
  assert.equal(redirect.actual, true);

  // The redirect finding cites both sides' /old network artifacts; the header
  // findings cite both sides' / network artifacts.
  const artifactById = new Map(run.artifacts.map((artifact) => [artifact.id, artifact]));
  for (const id of redirect.evidenceRefs) {
    const artifact = artifactById.get(id);
    assert.ok(artifact !== undefined);
    assert.equal(artifact.kind, "network");
    assert.equal(artifact.routePath, "/old");
  }
  for (const finding of [cacheControl, allow]) {
    for (const id of finding.evidenceRefs) {
      const artifact = artifactById.get(id);
      assert.ok(artifact !== undefined);
      assert.equal(artifact.kind, "network");
      assert.equal(artifact.routePath, "/");
    }
  }

  // Deterministic across fresh incarnations.
  const again = await runPairedJourney({ journey, ...networkDivergentSides() });
  assert.equal(serializePairedReport(again.report), serializePairedReport(run.report));
});

test("dimension gating is an honest absence", async () => {
  const journey: PairedJourney = {
    id: "j-dimension-gating",
    name: "Dimension gating",
    routePath: "/",
    anchors: ["Shared headline", "Section one"],
  };

  // Visual divergence with the visual dimension disabled: no findings, no
  // visual capture, no visual artifacts — the channel is absent, and the
  // absence is visible in the evidence inventory, never fabricated away.
  const visualOff = await runPairedJourney({
    journey,
    ...visualDivergentSides(),
    dimensions: { visual: false },
  });
  assert.deepEqual(visualOff.report.findings, []);
  assert.equal(visualOff.report.verdict, "equivalent");
  assert.ok(visualOff.artifacts.every((artifact) => artifact.kind !== "visual"));
  assert.ok(
    visualOff.artifacts.some((artifact) => artifact.kind === "network"),
    "the network dimension still runs and captures evidence",
  );

  // Network divergence with the network dimension disabled: the divergence
  // is invisible to the report and the artifacts show the channel absent.
  const networkJourney: PairedJourney = {
    id: "j-dimension-gating-network",
    name: "Dimension gating network",
    routePath: "/",
    anchors: ["Shared headline"],
    apiChecks: [{ path: "/old" }],
  };
  const networkOff = await runPairedJourney({
    journey: networkJourney,
    ...networkDivergentSides(),
    dimensions: { network: false },
  });
  assert.deepEqual(networkOff.report.findings, []);
  assert.equal(networkOff.report.verdict, "equivalent");
  assert.ok(networkOff.artifacts.every((artifact) => artifact.kind !== "network"));

  // Both dimensions disabled: only the W3-004 channels remain.
  const bothOff = await runPairedJourney({
    journey: networkJourney,
    ...networkDivergentSides(),
    dimensions: { visual: false, network: false },
  });
  assert.deepEqual(bothOff.report.findings, []);
  assert.ok(
    bothOff.artifacts.every((artifact) => artifact.kind === "page" || artifact.kind === "api"),
  );
});

test("four-dimension diff against the REAL generated candidate", async () => {
  // A B01-mirroring spec + behavioral model, planned and generated for real.
  const spec: ReconstructionSpec = {
    specVersion: "0.1",
    reconstructionId: "rc-w3-0005-b01-mirror",
    targetId: "target-w3-0005",
    name: "B01 Mirror Fixture",
    platform: "web",
    entrypoints: ["/"],
    authorization: {
      ownerId: "owner-1",
      targetId: "target-w3-0005",
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
      network: true,
      state: true,
      maxRepairIterations: 2,
    },
  };
  const model: BehavioralIr = {
    schemaVersion: "0.1",
    application: {
      id: "app-w3-0005-mirror",
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
  const candidate: PairedSide = {
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

  const journey: PairedJourney = {
    id: "j-b01-about-four-dimensions",
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

  // The generated minimal page genuinely diverges: semantic anchor gaps and
  // honest visual gaps (title, headings, links, skeleton). No state findings
  // (the generated candidate exposes no snapshotState) and no network
  // findings (both sides serve identical deterministic protocol headers with
  // no redirects — including the identical 404s on /api/).
  assert.equal(run.report.verdict, "divergent");
  assert.ok(
    run.report.findings.every(
      (finding) => finding.dimension === "semantic" || finding.dimension === "visual",
    ),
  );
  assert.ok(!run.report.findings.some((finding) => finding.dimension === "state"));
  assert.ok(!run.report.findings.some((finding) => finding.dimension === "network"));

  // Semantic: the anchor gaps W3-004 already proved, plus the body-length info.
  const anchorFindings = run.report.findings.filter(
    (finding) => finding.severity === "major" && finding.dimension === "semantic",
  );
  assert.ok(anchorFindings.some((finding) => finding.anchor === "We are Aurora Studio"));
  assert.ok(anchorFindings.some((finding) => finding.anchor === "Home"));
  assert.ok(
    run.report.findings.some(
      (finding) =>
        finding.dimension === "semantic" &&
        finding.severity === "info" &&
        finding.anchor === "/about",
    ),
  );
  assert.ok(!run.report.findings.some((finding) => finding.anchor === "/api/"));

  // Visual: the title gap, the full heading inventory gap (the reference's
  // six headings plus the candidate's lone h1), the four nav links, and the
  // skeleton digest — all citing both sides' visual artifacts.
  const visualFindings = run.report.findings.filter((finding) => finding.dimension === "visual");
  const titleFinding = visualFindings.find((finding) => finding.anchor === "visual:title");
  assert.ok(titleFinding !== undefined);
  assert.equal(titleFinding.severity, "minor");
  assert.equal(titleFinding.expected, "Aurora Studio — The Workshop");
  assert.equal(titleFinding.actual, "About");
  const headingFindings = visualFindings.filter((finding) =>
    finding.anchor.startsWith("visual:heading:"),
  );
  assert.equal(headingFindings.length, 7);
  assert.ok(
    headingFindings.some((finding) => finding.anchor === "visual:heading:h1:We are Aurora Studio"),
  );
  assert.ok(headingFindings.some((finding) => finding.anchor === "visual:heading:h1:About"));
  const linkFindings = visualFindings.filter((finding) =>
    finding.anchor.startsWith("visual:link:"),
  );
  assert.equal(linkFindings.length, 4);
  assert.ok(linkFindings.every((finding) => finding.severity === "minor"));
  assert.ok(visualFindings.some((finding) => finding.anchor === "visual:skeleton"));

  // Every finding cites artifacts that exist in the inventory.
  const artifactIds = new Set(run.artifacts.map((artifact) => artifact.id));
  for (const finding of run.report.findings) {
    for (const id of finding.evidenceRefs) {
      assert.ok(artifactIds.has(id), `finding cites a captured artifact: ${id}`);
    }
  }

  // The evidence inventory is content-addressed: page digests are the sha256
  // of the bytes each side actually served; the visual and network channels
  // captured one artifact per side (and one per side for the /api/ check).
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

  assert.equal(run.artifacts.filter((artifact) => artifact.kind === "visual").length, 2);
  assert.equal(run.artifacts.filter((artifact) => artifact.kind === "network").length, 4);
  assert.equal(run.artifacts.filter((artifact) => artifact.kind === "api").length, 2);
  assert.notEqual(run.report.referenceRunId, run.report.candidateRunId);
});

test("purity and fail-closed dimension normalization", async () => {
  // The four-dimension core over captures WITHOUT visual/network fields is
  // exactly the W3-004 semantic/state comparison — the new dimensions are an
  // honest absence, never a fabricated equivalence or divergence.
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
  const semanticOnly = compareSidesSemantically(referenceCapture, candidateCapture);
  assert.deepEqual(compareSides(referenceCapture, candidateCapture), semanticOnly);
  assert.deepEqual(compareSidesVisually(referenceCapture, candidateCapture), []);
  assert.deepEqual(compareSidesNetwork(referenceCapture, candidateCapture), []);

  // A visual inventory on ONE side only is still an honest absence.
  const oneSidedVisual = structuredClone(referenceCapture);
  oneSidedVisual.page.visual = extractVisualInventory("<h1>Only one side</h1>");
  assert.deepEqual(compareSidesVisually(oneSidedVisual, candidateCapture), []);

  // Pure: cloned inputs produce deep-equal findings; inputs are never mutated.
  const first = compareSides(referenceCapture, candidateCapture);
  const referenceSnapshot = structuredClone(referenceCapture);
  const candidateSnapshot = structuredClone(candidateCapture);
  const second = compareSides(structuredClone(referenceCapture), structuredClone(candidateCapture));
  assert.deepEqual(second, first);
  assert.deepEqual(referenceCapture, referenceSnapshot);
  assert.deepEqual(candidateCapture, candidateSnapshot);

  // The extraction itself is pure and exact: a hand-built page yields exactly
  // this inventory (script/style excluded, whitespace collapsed, entities
  // decoded, src-less images and href-less anchors skipped).
  const extracted = extractVisualInventory(
    [
      "<!doctype html><html><head><title>  T </title></head><body>",
      "<script>invisible();</script><style>.x{color:red}</style>",
      "<h1>Hello   World</h1><h2>Sub &amp; Section</h2>",
      '<a href="/a">A  link</a><a href="/b" title="no text"></a><a>plain</a>',
      '<img src="/i.png" alt="Alt text"><img alt="no src">',
      '<input type="text" name="q"><button>Go</button><select name="s"></select>',
      "<p>Visible &lt;text&gt; here.</p>",
      "</body></html>",
    ].join(""),
  );
  assert.equal(extracted.title, "T");
  assert.deepEqual(extracted.headings, [
    { level: 1, text: "Hello World" },
    { level: 2, text: "Sub & Section" },
  ]);
  assert.deepEqual(extracted.images, [{ src: "/i.png", alt: "Alt text" }]);
  assert.deepEqual(extracted.links, [
    { href: "/a", text: "A link" },
    { href: "/b", text: "" },
  ]);
  assert.deepEqual(extracted.controls, [
    { tag: "input", type: "text", name: "q" },
    { tag: "button", type: null, name: null },
    { tag: "select", type: null, name: "s" },
  ]);
  const expectedSkeleton = "T Hello World Sub & Section A link plain Go Visible <text> here.";
  assert.equal(
    extracted.skeletonDigest,
    createHash("sha256").update(Buffer.from(expectedSkeleton, "utf8")).digest("hex"),
  );
  assert.deepEqual(extractVisualInventory(extracted.title ?? ""), {
    title: null,
    headings: [],
    images: [],
    links: [],
    controls: [],
    skeletonDigest: createHash("sha256").update(Buffer.from("T", "utf8")).digest("hex"),
  });

  // The network capture is pure over its header source: only allowlisted
  // names survive, sorted by name, regardless of arrival order.
  const headerSource = (pairs: [string, string][]) => ({
    forEach(callback: (value: string, name: string) => void) {
      for (const [name, value] of pairs) callback(value, name);
    },
  });
  const noisy = networkCaptureOf(
    headerSource([
      ["Date", "Mon, 28 Sep 2026 00:00:00 GMT"],
      ["Content-Length", "42"],
      ["Connection", "keep-alive"],
      ["Cache-Control", "max-age=60"],
      ["cache-control", "no-cache"],
      ["X-Custom", "ignored"],
    ]),
    false,
  );
  assert.deepEqual(noisy.headers, [{ name: "cache-control", value: "max-age=60, no-cache" }]);
  assert.equal(noisy.redirected, false);
  for (const forbidden of ["date", "content-length", "connection", "keep-alive", "x-custom"]) {
    assert.ok(!noisy.headers.some((header) => header.name === forbidden));
  }
  assert.ok(NETWORK_HEADER_ALLOWLIST.every((name) => name === name.toLowerCase()));

  // normalizeDimensions is fail-closed: defaults, explicit flags, rejections.
  assert.deepEqual(normalizeDimensions(undefined), { visual: true, network: true });
  assert.deepEqual(normalizeDimensions({}), { visual: true, network: true });
  assert.deepEqual(normalizeDimensions({ visual: false }), { visual: false, network: true });
  assert.deepEqual(normalizeDimensions({ network: false }), { visual: true, network: false });
  assert.throws(() => normalizeDimensions("no"), TypeError);
  assert.throws(() => normalizeDimensions(null), TypeError);
  assert.throws(() => normalizeDimensions({ visual: "yes" }), /dimensions\.visual/);
  assert.throws(() => normalizeDimensions({ network: 1 }), /dimensions\.network/);

  // The runner validates dimensions BEFORE any side starts (fail-closed).
  // The deliberately-invalid value is cast across the typed seam: the public
  // input type is Partial<PairedDimensions>, and the runtime boundary
  // re-validates untrusted values exactly like every other input seam.
  const started: string[] = [];
  const neverStarted: PairedSide = {
    label: "candidate",
    start: async () => {
      started.push("candidate");
      throw new Error("must not be reached");
    },
  };
  await assert.rejects(
    () =>
      runPairedJourney({
        journey: {
          id: "j-dimensions-fail-closed",
          name: "Dimensions fail closed",
          routePath: "/",
          anchors: ["x"],
        },
        reference: {
          label: "reference",
          start: async () => {
            started.push("reference");
            throw new Error("must not be reached");
          },
        },
        candidate: neverStarted,
        dimensions: 42 as unknown as Partial<{ visual: boolean; network: boolean }>,
      }),
    (error: unknown) => {
      assert.ok(error instanceof TypeError);
      assert.ok(error.message.includes("dimensions"));
      return true;
    },
  );
  assert.deepEqual(started, []);

  // dimensionArtifactsOf addresses the new channels: visual per page, network
  // per page and per API check — and nothing when the channels are absent.
  const richCapture: PairedSideCapture = {
    side: "reference",
    journeyId: "j-artifacts",
    routePath: "/",
    page: {
      status: 200,
      contentType: "text/html; charset=utf-8",
      bodyDigest: "a".repeat(64),
      bodyChars: 10,
      anchorsFound: [],
      anchorsMissing: [],
      visual: extractVisualInventory("<h1>x</h1>"),
      network: networkCaptureOf(headerSource([["Allow", "GET"]]), false),
    },
    api: [
      {
        path: "/api/",
        status: 404,
        bodyDigest: "b".repeat(64),
        parsedKeyDigest: null,
        expectKey: null,
        network: networkCaptureOf(headerSource([]), false),
      },
    ],
  };
  const richArtifacts = dimensionArtifactsOf(richCapture);
  assert.deepEqual(
    richArtifacts.map((artifact) => [artifact.kind, artifact.routePath]),
    [
      ["visual", "/"],
      ["network", "/"],
      ["network", "/api/"],
    ],
  );
  assert.ok(richArtifacts.every((artifact) => artifact.id.startsWith("pa-")));
  assert.deepEqual(dimensionArtifactsOf(candidateCapture), []);
});

test("suite aggregates all four dimensions deterministically", async () => {
  const journeys: PairedJourney[] = [
    {
      id: "j-suite-visual",
      name: "Suite visual journey",
      routePath: "/",
      anchors: ["Shared headline", "Section one"],
    },
    {
      id: "j-suite-network",
      name: "Suite network journey",
      routePath: "/old",
      anchors: [],
      apiChecks: [{ path: "/old" }],
    },
  ];

  const first = await runPairedSuite({ journeys, ...mixedDivergentSides() });
  assert.equal(first.verdict, "divergent");
  assert.equal(first.journeys.length, 2);

  // The visual journey contributes exactly the eight seeded visual findings;
  // the network journey contributes exactly the redirect finding; semantic
  // and state stay empty — every dimension lands in its own bucket.
  assert.equal(first.findingsByDimension.visual.length, 8);
  assert.equal(first.findingsByDimension.network.length, 1);
  assert.deepEqual(first.findingsByDimension.semantic, []);
  assert.deepEqual(first.findingsByDimension.state, []);
  assert.equal(first.findingsByDimension.network[0].anchor, "network:redirect:/old");
  assert.deepEqual(
    first.journeys.map((summary) => summary.verdict),
    ["divergent", "divergent"],
  );

  // Two full suite runs (fresh incarnations, new ports) serialize identically.
  const second = await runPairedSuite({ journeys, ...mixedDivergentSides() });
  assert.equal(serializePairedSuite(second), serializePairedSuite(first));

  // Suite-level dimension gating propagates to every journey.
  const gated = await runPairedSuite({
    journeys,
    ...mixedDivergentSides(),
    dimensions: { visual: false, network: false },
  });
  assert.equal(gated.verdict, "equivalent");
  assert.deepEqual(gated.findingsByDimension.visual, []);
  assert.deepEqual(gated.findingsByDimension.network, []);
});

test("clock and transport noise stay out of the deterministic report", async () => {
  // Two sides whose ONLY divergence is one allowlisted header value — served
  // by real node:http servers whose responses carry real Date headers on the
  // wire. Two consecutive runs must serialize byte-identically: the wall
  // clock never reaches the report through the network channel.
  const journey: PairedJourney = {
    id: "j-clock-noise",
    name: "Clock noise exclusion",
    routePath: "/",
    anchors: ["Shared headline"],
  };
  const sides = () => ({
    reference: literalSide({
      label: "reference",
      routes: { "/": { body: VISUAL_REFERENCE_HTML, headers: { "cache-control": "max-age=60" } } },
    }),
    candidate: literalSide({
      label: "candidate",
      routes: { "/": { body: VISUAL_REFERENCE_HTML, headers: { "cache-control": "no-store" } } },
    }),
  });

  const first = await runPairedJourney({ journey, ...sides() });
  const second = await runPairedJourney({ journey, ...sides() });
  assert.equal(serializePairedReport(second.report), serializePairedReport(first.report));
  assert.equal(serializePairedRun(second), serializePairedRun(first));

  // The single finding is the deterministic cache-control divergence.
  assert.equal(first.report.verdict, "divergent");
  assert.equal(first.report.findings.length, 1);
  assert.equal(first.report.findings[0].dimension, "network");
  assert.equal(first.report.findings[0].severity, "minor");
  assert.equal(first.report.findings[0].anchor, "network:header:cache-control");

  // The report serialization is exactly the frozen DiffReport shape — no
  // ports, no durations, no transport, no dates.
  const serialized = serializePairedReport(first.report);
  for (const forbidden of [
    "referencePort",
    "candidatePort",
    "startedAtMs",
    "durationMs",
    "transport",
    "GMT",
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

  // The transport facts ride in the envelope's transport field, as designed.
  assert.ok(first.transport.referencePort > 0);
  assert.ok(first.transport.candidatePort > 0);
  assert.ok(first.transport.durationMs >= 0);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The mixed-divergence side pair for the suite test: journey "/" (routePath)
 * carries the seeded visual divergences; journey "/old" carries exactly one
 * network divergence (the redirect) with byte-equal bodies either way.
 */
function mixedDivergentSides(): { reference: PairedSide; candidate: PairedSide } {
  return {
    reference: literalSide({
      label: "reference",
      routes: {
        "/": { body: VISUAL_REFERENCE_HTML },
        "/old": { body: VISUAL_CANDIDATE_HTML },
      },
    }),
    candidate: literalSide({
      label: "candidate",
      routes: {
        "/": { body: VISUAL_CANDIDATE_HTML },
        "/old": { body: VISUAL_CANDIDATE_HTML, redirect: "/" },
      },
    }),
  };
}
