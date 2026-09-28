import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
import {
  BENCHMARK_SERVE_JS,
  type BenchmarkApp,
  CANONICAL_BENCHMARKS,
  canonicalJson,
  createBenchmarkHarness,
} from "../packages/clapp-benchmarks/src/index.ts";
import type {
  BehavioralIr,
  DiffFinding,
  ReconstructionSpec,
  SynthesisPlan,
} from "../packages/clapp-contracts/src/index.ts";
import {
  applyRepairActions,
  bindPairedSide,
  classifyRepairActions,
  generateCandidateApp,
  type PairedJourney,
  type PairedSide,
  planSynthesisApp,
  runRepairLoop,
  serializeRepairReport,
  summarizeRepair,
} from "../packages/clapp-synthesis/src/index.ts";

/**
 * CLAPP-W3-006 — bounded autonomous repair.
 *
 * Proves the M5 repair loop end-to-end: the reference side is a REAL
 * benchmark harness (B01, B02, and a minimal one-heading fixture through the
 * same real factory); the candidate is a REAL plan -> generateCandidateApp ->
 * workspace -> server.ts pipeline whose plan inputs are mutated to seed the
 * M5 defect classes. The loop consumes the paired parity engine's DiffReport
 * (W3-004/W3-005), applies deterministic plan-input mutations, re-materializes
 * and re-verifies through the paired runner, and stops on convergence,
 * stagnation or budget — whichever first. Non-derivable defects are honestly
 * abstained, never guessed. Every server interaction is in-process loopback
 * on ephemeral ports; no external network.
 *
 * Dimension policy honesty: where a convergence test runs against a rich
 * benchmark page whose visual inventory (nav links, multi-level headings,
 * footer) is not expressible in the plan's minimal single-h1 page model, the
 * journey runs with the visual dimension disabled — the same honest absence
 * ReconstructionSpec.verification.visual = false expresses, never a fabricated
 * equivalence.
 */

const B01 = CANONICAL_BENCHMARKS[0];
const B02 = CANONICAL_BENCHMARKS[1];

const tempDirectories: string[] = [];

/** A harness bound as one side of the pairing (the reference-side pattern). */
function harnessSide(label: "reference" | "candidate", app: BenchmarkApp): PairedSide {
  return bindPairedSide(createBenchmarkHarness(app), label);
}

/** Writes a generated app into a fresh temp workspace and returns its path. */
async function makeWorkspace(app: { files: { path: string; content: string }[] }): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "clapp-w3-0006-"));
  tempDirectories.push(directory);
  for (const file of app.files) {
    const target = join(directory, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content, "utf8");
  }
  return directory;
}

/**
 * The REAL candidate materialization pipeline: plan -> generateCandidateApp ->
 * fresh workspace -> dynamic import of the generated server.ts -> a PairedSide
 * adapter over its exported start(port). When withSnapshotState is set, the
 * adapter also exposes the materialized candidate's OWN state artifact
 * (state.json — a pure function of plan.state) as its state snapshot, so the
 * state dimension can compare both sides.
 */
function materializer(options?: { withSnapshotState?: boolean }) {
  return async (plan: SynthesisPlan): Promise<PairedSide> => {
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
    return side;
  };
}

/** A minimal reconstruction spec for the given acceptance journeys. */
function specOf(reconstructionId: string, journeyIds: string[]): ReconstructionSpec {
  return {
    specVersion: "0.1",
    reconstructionId,
    targetId: "target-w3-0006",
    name: "W3-006 Repair Fixture",
    platform: "web",
    entrypoints: ["/"],
    authorization: {
      ownerId: "owner-1",
      targetId: "target-w3-0006",
      scope: ["reconstruct:ui"],
      environments: ["sandbox"],
      retention: "project",
      benchmarkOwned: true,
      createdAt: "2025-01-01T00:00:00.000Z",
    },
    exploration: { maxStages: 4, maxActions: 64, maxDurationMs: 300000, seed: 11 },
    synthesis: { targetStack: "static-web", allowNetwork: false, packagePolicy: "verified-only" },
    verification: {
      journeys: journeyIds,
      visual: true,
      network: true,
      state: true,
      maxRepairIterations: 0,
    },
  };
}

/** A behavioral model with the given journeys plus optional state/api seeds. */
function modelOf(
  journeys: { id: string; name: string; steps: number }[],
  extra?: { state?: Record<string, unknown>; api?: Record<string, unknown> },
): BehavioralIr {
  return {
    schemaVersion: "0.1",
    application: {
      id: "app-w3-0006",
      name: "W3-006 Repair Fixture",
      platform: "web",
      entrypoints: ["/"],
    },
    evidence: [],
    journeys: journeys.map((journey) => ({
      id: journey.id,
      name: journey.name,
      preconditions: [],
      steps: Array.from({ length: journey.steps }, (_, index) => ({
        id: `s-${journey.id}-${index + 1}`,
        action: "visit",
        target: `/${journey.id}`,
      })),
    })),
    screens: [],
    components: [],
    state: extra?.state ?? {},
    data: {},
    api: extra?.api ?? {},
    integrations: [],
    assumptions: [],
    constraints: [],
  };
}

/** sha256 of a file's bytes. */
function hashFile(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Every file of a directory (recursive, sorted) mapped to its sha256. */
async function hashTree(directory: string): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  const walk = async (relative: string): Promise<void> => {
    const entries = await readdir(join(directory, relative), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(child);
      } else {
        hashes[child] = hashFile(await readFile(join(directory, child), "utf8"));
      }
    }
  };
  await walk("");
  return hashes;
}

after(async () => {
  for (const directory of tempDirectories) {
    await rm(directory, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 1. visible-text defect repairs to convergence
// ---------------------------------------------------------------------------

test("visible-text defect repairs to convergence", async () => {
  // B01's /contact page carries the heading "Get in touch"; the candidate
  // plan's route was seeded with the WRONG heading text (the M5 visible-text
  // defect class).
  const basePlan = await planSynthesisApp(
    specOf("rc-w3-0006-visible-text", ["contact"]),
    modelOf([{ id: "contact", name: "Get in touch", steps: 3 }]),
    [],
  );
  const candidatePlan = structuredClone(basePlan);
  (candidatePlan.routes[0] as { name: string }).name = "Say hello";

  const journey: PairedJourney = {
    id: "j-contact-visible-text",
    name: "B01 contact visible-text parity",
    routePath: "/contact",
    anchors: ["Get in touch"],
  };
  const loopInput = {
    reference: () => harnessSide("reference", B01),
    candidatePlan,
    materialize: materializer(),
    journeys: [journey],
    budget: 4,
    dimensions: { visual: false } as const,
  };

  const report = await runRepairLoop(loopInput);

  // The loop repaired the heading through the visible-text class and
  // converged: zero >= minor findings, verdict equivalent.
  assert.equal(report.converged, true);
  assert.equal(report.stoppedBy, "converged");
  assert.equal(report.finalVerdict, "equivalent");
  assert.ok(report.iterations.length >= 1, "at least one repair iteration ran");
  assert.ok(report.iterations.length <= 4, "iterations bounded by the budget");
  assert.ok(report.actionsTotal >= 1, "at least one mutation was applied");
  assert.ok(
    report.iterations.every((iteration) =>
      iteration.mutationClasses.every((mutationClass) => mutationClass === "visible-text"),
    ),
    "only visible-text mutations were applied",
  );
  const lastIteration = report.iterations[report.iterations.length - 1];
  assert.ok(lastIteration !== undefined);
  assert.equal(lastIteration.findingsAfter, 0);
  // The repaired plan carries the reference heading text.
  assert.equal((report.finalPlan.routes[0] as { name: string }).name, "Get in touch");

  // The human-reviewable digest.
  const summary = summarizeRepair(report);
  assert.equal(summary.converged, true);
  assert.equal(summary.stoppedBy, "converged");
  assert.equal(summary.iterations, report.iterations.length);
  assert.deepEqual(summary.verdictTrajectory, ["equivalent"]);
  assert.deepEqual(summary.mutationClassesUsed, ["visible-text"]);
  assert.equal(summary.actionsTotal, report.actionsTotal);
  assert.ok(summary.abstentionCount >= 0);

  // Deterministic across two runs: byte-identical reports.
  const second = await runRepairLoop({
    ...loopInput,
    candidatePlan: structuredClone(candidatePlan),
  });
  assert.equal(JSON.stringify(second), JSON.stringify(report));
  assert.equal(second.id, report.id);
  assert.equal(serializeRepairReport(second), serializeRepairReport(report));
});

// ---------------------------------------------------------------------------
// 2. network mock defect repairs
// ---------------------------------------------------------------------------

test("network mock defect repairs", async () => {
  // Phase A — B02 reference: the candidate plan carries a WRONG api JSON
  // entry (a mock endpoint the reference's network surface does not expose).
  // The repair aligns the candidate's api surface with the reference's.
  const basePlan = await planSynthesisApp(
    specOf("rc-w3-0006-network-mock", ["tasks"]),
    modelOf([{ id: "tasks", name: "Task queue", steps: 2 }]),
    [],
  );
  const candidatePlan = structuredClone(basePlan);
  candidatePlan.api = [{ key: "tasks", value: ["Scrub the wrong entry"] }];

  const journey: PairedJourney = {
    id: "j-tasks-network-mock",
    name: "B02 tasks network-mock parity",
    routePath: "/tasks",
    anchors: ["Task queue"],
    apiChecks: [{ path: "/api/tasks" }],
  };
  const report = await runRepairLoop({
    reference: () => harnessSide("reference", B02),
    candidatePlan,
    materialize: materializer(),
    journeys: [journey],
    budget: 4,
    dimensions: { visual: false },
  });

  assert.equal(report.converged, true);
  assert.equal(report.stoppedBy, "converged");
  assert.equal(report.finalVerdict, "equivalent");
  assert.ok(report.actionsTotal >= 1);
  assert.ok(
    report.iterations.some((iteration) => iteration.mutationClasses.includes("network-mock")),
    "the network-mock class was applied",
  );
  const lastIteration = report.iterations[report.iterations.length - 1];
  assert.ok(lastIteration !== undefined);
  assert.equal(lastIteration.findingsAfter, 0);
  // The spurious mock entry is gone from the repaired plan.
  assert.deepEqual(report.finalPlan.api, []);
  assert.deepEqual(report.finalPlan.persistence, []);

  // Phase B — value alignment: a reference that SERVES the endpoint (a
  // minimal loopback side) against a candidate whose api entry carries the
  // wrong VALUE. The digest finding is repaired from the live reference's
  // served value.
  const referencePage = [
    "<!doctype html>",
    '<html lang="en">',
    "  <head>",
    '    <meta charset="utf-8" />',
    "    <title>Board list</title>",
    "  </head>",
    "  <body>",
    "    <main>",
    "      <h1>Board list</h1>",
    "    </main>",
    "  </body>",
    "</html>",
    "",
  ].join("\n");
  const referenceApi = { board: { board: "Field Notes", open: 3 } };
  const literalReference: PairedSide = {
    label: "reference",
    start: async () => {
      const server = createServer((request, response) => {
        const pathname = new URL(request.url ?? "/", "http://literal.invalid").pathname;
        if (pathname === "/hello") {
          response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          response.end(referencePage);
          return;
        }
        if (pathname.startsWith("/api/")) {
          const key = pathname.slice("/api/".length);
          if (Object.hasOwn(referenceApi, key)) {
            response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
            response.end(`${canonicalJson(referenceApi[key as keyof typeof referenceApi])}\n`);
            return;
          }
        }
        response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
        response.end('{"error":"not_found"}\n');
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      const address = server.address() as AddressInfo;
      return {
        port: address.port,
        baseUrl: `http://127.0.0.1:${address.port}`,
        stop: () =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
          }),
      };
    },
  };

  const valueBasePlan = await planSynthesisApp(
    specOf("rc-w3-0006-network-mock-value", ["hello"]),
    modelOf([{ id: "hello", name: "Board list", steps: 2 }], {
      api: { board: referenceApi.board },
    }),
    [],
  );
  const wrongValuePlan = structuredClone(valueBasePlan);
  (wrongValuePlan.api[0] as { value: unknown }).value = { board: "Wrong Notes", open: 3 };

  const valueReport = await runRepairLoop({
    reference: () => literalReference,
    candidatePlan: wrongValuePlan,
    materialize: materializer(),
    journeys: [
      {
        id: "j-hello-network-mock-value",
        name: "api value parity",
        routePath: "/hello",
        anchors: ["Board list"],
        apiChecks: [{ path: "/api/board" }],
      },
    ],
    budget: 4,
    dimensions: { visual: false },
  });

  assert.equal(valueReport.converged, true);
  assert.equal(valueReport.stoppedBy, "converged");
  assert.equal(valueReport.finalVerdict, "equivalent");
  assert.ok(
    valueReport.iterations.some((iteration) => iteration.mutationClasses.includes("network-mock")),
    "the network-mock class was applied for the value alignment",
  );
  const repairedEntry = valueReport.finalPlan.api[0] as { key: string; value: unknown } | undefined;
  assert.ok(repairedEntry !== undefined);
  assert.equal(repairedEntry.key, "board");
  assert.deepEqual(repairedEntry.value, { board: "Field Notes", open: 3 });
});

// ---------------------------------------------------------------------------
// 3. state storage mutation repairs
// ---------------------------------------------------------------------------

test("state storage mutation repairs", async () => {
  // B02 reference (its harness exposes the store as its state snapshot)
  // against a candidate whose plan.state diverges. The candidate side
  // exposes its OWN materialized state artifact (state.json, a pure function
  // of plan.state) as its snapshot, so the state dimension compares them.
  const b02Seed = {
    boardName: "Field Operations Board",
    openTasks: 3,
    status: "operational",
    tasks: ["Inspect the intake pump", "Replace the filter cartridge", "Log the evening reading"],
  };
  const basePlan = await planSynthesisApp(
    specOf("rc-w3-0006-state-storage", ["settings"]),
    modelOf([{ id: "settings", name: "Board settings", steps: 2 }], { state: b02Seed }),
    [],
  );
  const candidatePlan = structuredClone(basePlan);
  (candidatePlan.state as Record<string, unknown>).boardName = "Wrong Operations Board";

  const report = await runRepairLoop({
    reference: () => harnessSide("reference", B02),
    candidatePlan,
    materialize: materializer({ withSnapshotState: true }),
    journeys: [
      {
        id: "j-settings-state-storage",
        name: "B02 settings state parity",
        routePath: "/settings",
        anchors: ["Board settings"],
      },
    ],
    budget: 4,
    dimensions: { visual: false },
  });

  assert.equal(report.converged, true);
  assert.equal(report.stoppedBy, "converged");
  assert.equal(report.finalVerdict, "equivalent");
  assert.ok(
    report.iterations.some((iteration) => iteration.mutationClasses.includes("state-storage")),
    "the state-storage class was applied",
  );
  const lastIteration = report.iterations[report.iterations.length - 1];
  assert.ok(lastIteration !== undefined);
  // State findings are zero after the repair: no >= minor findings remain.
  assert.equal(lastIteration.findingsAfter, 0);
  // The repaired state shape is the reference's snapshot.
  assert.deepEqual(report.finalPlan.state, b02Seed);
});

// ---------------------------------------------------------------------------
// 4. budget is respected absolutely
// ---------------------------------------------------------------------------

test("budget is respected absolutely", async () => {
  // An unrepairable-by-convergence defect: the reference page's title and
  // heading carry DIFFERENT texts ("Aurora Studio — Say Hello" vs "Get in
  // touch"), but the plan's page model expresses title and heading through
  // ONE channel (the route name). Every repair iteration fixes one finding
  // and re-breaks the other — a perpetual oscillation that only the absolute
  // iteration bound can stop.
  const oscillationApp: BenchmarkApp = {
    id: "clapp_benchmark_w3-0006-osc",
    name: "Oscillation fixture",
    version: "1.0.0",
    kind: "static",
    files: [
      {
        path: "hello.html",
        content: [
          "<!doctype html>",
          '<html lang="en">',
          "  <head>",
          '    <meta charset="utf-8" />',
          "    <title>Aurora Studio — Say Hello</title>",
          "  </head>",
          "  <body>",
          "    <main>",
          "      <h1>Get in touch</h1>",
          "    </main>",
          "  </body>",
          "</html>",
          "",
        ].join("\n"),
      },
      {
        path: "index.html",
        content: [
          "<!doctype html>",
          '<html lang="en">',
          "  <head>",
          '    <meta charset="utf-8" />',
          "    <title>Oscillation fixture</title>",
          "  </head>",
          "  <body>",
          "    <main>",
          "      <h1>Oscillation fixture</h1>",
          "    </main>",
          "  </body>",
          "</html>",
          "",
        ].join("\n"),
      },
      { path: "serve.js", content: BENCHMARK_SERVE_JS },
    ],
    routes: [
      { path: "/", anchors: ["Oscillation fixture"] },
      { path: "/hello", anchors: ["Get in touch"] },
    ],
    startCommand: "node serve.js",
    assumptions: [
      "A one-heading page whose title differs from its heading — the oscillation seed.",
    ],
  };

  const basePlan = await planSynthesisApp(
    specOf("rc-w3-0006-budget", ["hello"]),
    modelOf([{ id: "hello", name: "Get in touch", steps: 1 }]),
    [],
  );
  const candidatePlan = structuredClone(basePlan);
  (candidatePlan.routes[0] as { name: string }).name = "Say hello";

  const report = await runRepairLoop({
    reference: () => harnessSide("reference", oscillationApp),
    candidatePlan,
    materialize: materializer(),
    journeys: [
      {
        id: "j-hello-budget",
        name: "oscillating title/heading parity",
        routePath: "/hello",
        anchors: ["Get in touch"],
      },
    ],
    budget: 3,
  });

  // The loop ran EXACTLY the budget — never more — and honestly reports that
  // it did not converge.
  assert.equal(report.stoppedBy, "budget");
  assert.equal(report.converged, false);
  assert.equal(report.iterations.length, 3);
  assert.equal(report.finalVerdict, "divergent");
  assert.ok(
    report.iterations.every((iteration) => iteration.actionsApplied >= 1),
    "every iteration applied its bounded mutations",
  );
  assert.ok(
    report.iterations.every((iteration) => iteration.findingsAfter >= 1),
    "the oscillation never converges within the budget",
  );
});

// ---------------------------------------------------------------------------
// 5. stagnation stops early
// ---------------------------------------------------------------------------

test("stagnation stops early", async () => {
  // The journey drives the candidate's GENERATED INDEX page ("/" — always
  // synthesized by the generator, targeted by no plan route). The anchor gap
  // can never be repaired through plan inputs, so the first iteration fixes
  // nothing and the loop stops early instead of grinding the budget.
  const candidatePlan = await planSynthesisApp(
    specOf("rc-w3-0006-stagnation", ["home"]),
    modelOf([{ id: "home", name: "Home", steps: 1 }]),
    [],
  );

  const report = await runRepairLoop({
    reference: () => harnessSide("reference", B01),
    candidatePlan,
    materialize: materializer(),
    journeys: [
      {
        id: "j-index-stagnation",
        name: "B01 index parity",
        routePath: "/",
        anchors: ["Digital craft with a human touch"],
      },
    ],
    budget: 5,
    dimensions: { visual: false },
  });

  assert.equal(report.stoppedBy, "stagnation");
  assert.equal(report.converged, false);
  assert.equal(
    report.iterations.length,
    1,
    "the loop stops after the first non-improving iteration",
  );
  const onlyIteration = report.iterations[0];
  assert.ok(onlyIteration !== undefined);
  assert.equal(onlyIteration.actionsApplied, 0);
  assert.equal(onlyIteration.findingsBefore, onlyIteration.findingsAfter);
  assert.ok(onlyIteration.findingsBefore >= 1);
  // The unresolvable target is honestly abstained, never guessed.
  const abstained = report.abstained.find(
    (entry) => entry.anchor === "Digital craft with a human touch",
  );
  assert.ok(abstained !== undefined);
  assert.match(abstained.reason, /index/);
});

// ---------------------------------------------------------------------------
// 6. non-derivable defects are abstained
// ---------------------------------------------------------------------------

test("non-derivable defects are abstained", async () => {
  // Unit seam: literal findings whose anchors carry no structured plan
  // channel are abstained with reasons — never a guessed mutation.
  const skeleton: DiffFinding = {
    id: "df-skeleton",
    dimension: "visual",
    severity: "info",
    anchor: "visual:skeleton",
    expected: "aaa",
    actual: "bbb",
    evidenceRefs: [],
    repairability: "manual",
  };
  const manualCritical: DiffFinding = {
    id: "df-manual",
    dimension: "semantic",
    severity: "critical",
    anchor: "start:candidate",
    expected: null,
    actual: null,
    evidenceRefs: [],
    repairability: "manual",
  };
  const performance: DiffFinding = {
    id: "df-performance",
    dimension: "performance",
    severity: "major",
    anchor: "p95",
    expected: 1,
    actual: 2,
    evidenceRefs: [],
    repairability: "automatic",
  };
  const inventory: DiffFinding = {
    id: "df-inventory",
    dimension: "semantic",
    severity: "major",
    anchor: "api-check-inventory",
    expected: ["/api/a"],
    actual: ["/api/b"],
    evidenceRefs: [],
    repairability: "manual",
  };
  const actions = classifyRepairActions([skeleton, manualCritical, performance, inventory]);
  assert.equal(actions.length, 4);
  assert.ok(actions.every((action) => action.kind === "abstention"));
  const skeletonAction = actions.find((action) => action.anchor === "visual:skeleton");
  assert.ok(skeletonAction !== undefined && skeletonAction.kind === "abstention");
  assert.match(skeletonAction.reason, /skeleton digest/);
  const manualAction = actions.find((action) => action.anchor === "start:candidate");
  assert.ok(manualAction !== undefined && manualAction.kind === "abstention");
  assert.match(manualAction.reason, /manual/);
  const performanceAction = actions.find((action) => action.anchor === "p95");
  assert.ok(performanceAction !== undefined && performanceAction.kind === "abstention");
  assert.match(performanceAction.reason, /performance/);

  // Loop level: a real run whose divergence set includes skeleton-digest,
  // link and multi-heading visual findings — none of which are expressible
  // in the plan's page model. The loop abstains each with a reason and
  // invents no mutation for them.
  const candidatePlan = await planSynthesisApp(
    specOf("rc-w3-0006-abstain", ["about"]),
    modelOf([{ id: "about", name: "About", steps: 1 }]),
    [],
  );
  const report = await runRepairLoop({
    reference: () => harnessSide("reference", B01),
    candidatePlan,
    materialize: materializer(),
    journeys: [
      {
        id: "j-about-abstain",
        name: "B01 about parity",
        routePath: "/about",
        anchors: ["We are Aurora Studio"],
      },
    ],
    budget: 1,
  });

  assert.equal(report.converged, false);
  const skeletonAbstention = report.abstained.find((entry) => entry.anchor === "visual:skeleton");
  assert.ok(skeletonAbstention !== undefined);
  assert.match(skeletonAbstention.reason, /skeleton digest/);
  assert.ok(
    report.abstained.some((entry) => entry.anchor.startsWith("visual:link:")),
    "the unexpressible link divergence is abstained",
  );
  assert.ok(
    report.abstained.some((entry) => entry.anchor.startsWith("visual:heading:")),
    "the unexpressible multi-heading structure is abstained",
  );
  assert.ok(report.abstained.every((entry) => entry.reason.length > 0));
  // No mutation was ever invented for the abstained anchors: the applied
  // actions target only the derivable channels.
  assert.ok(report.actionsTotal >= 1);
});

// ---------------------------------------------------------------------------
// 7. repair never edits generated code directly
// ---------------------------------------------------------------------------

test("repair never edits generated code directly", async () => {
  // The mutations are plan-input transformations: the input plan is never
  // mutated, the generated files are a pure function of the plan, two
  // materializations of the same plan are byte-identical, and a repair never
  // touches an already-materialized workspace.
  const basePlan = await planSynthesisApp(
    specOf("rc-w3-0006-purity", ["contact"]),
    modelOf([{ id: "contact", name: "Get in touch", steps: 3 }]),
    [],
  );
  const candidatePlan = structuredClone(basePlan);
  (candidatePlan.routes[0] as { name: string }).name = "Say hello";
  const planSnapshot = structuredClone(candidatePlan);

  // A page-resolved anchor-gap action (the loop resolves the page from the
  // journey context; here it is resolved explicitly to prove the apply path).
  const [action] = classifyRepairActions([
    {
      id: "df-anchor-gap",
      dimension: "semantic",
      severity: "major",
      anchor: "Get in touch",
      expected: ["Get in touch"],
      actual: [],
      evidenceRefs: [],
      repairability: "assisted",
    },
  ]);
  assert.ok(action !== undefined && action.kind === "mutation");
  const resolved =
    action.mutation.target.field === "route.name"
      ? {
          ...action,
          mutation: { ...action.mutation, target: { ...action.mutation.target, page: "/contact" } },
        }
      : action;
  const applied = applyRepairActions(candidatePlan, [resolved]);
  assert.equal(applied.applied.length, 1);
  assert.equal(applied.skipped.length, 0);

  // The input plan is un-mutated.
  assert.deepEqual(candidatePlan, planSnapshot);
  // The repaired plan differs exactly in the mutated input channel.
  assert.equal((applied.plan.routes[0] as { name: string }).name, "Get in touch");

  // Two generations/materializations of the SAME plan are byte-identical.
  const firstMaterialization = await makeWorkspace(generateCandidateApp(candidatePlan));
  const secondMaterialization = await makeWorkspace(generateCandidateApp(candidatePlan));
  assert.deepEqual(
    await hashTree(firstMaterialization),
    await hashTree(secondMaterialization),
    "two materializations of the same plan are byte-identical",
  );

  // The repair never edits generated code directly: the previously
  // materialized workspace is untouched, and the repaired plan regenerates
  // into a NEW workspace whose page carries the repaired heading text.
  const beforeHashes = await hashTree(firstMaterialization);
  const repairedWorkspace = await makeWorkspace(generateCandidateApp(applied.plan));
  assert.deepEqual(
    await hashTree(firstMaterialization),
    beforeHashes,
    "an already-materialized workspace is never edited",
  );
  const repairedPage = await readFile(join(repairedWorkspace, "pages", "contact.html"), "utf8");
  assert.match(repairedPage, /Get in touch/);
});

// ---------------------------------------------------------------------------
// 8. repair report is a pure function of inputs
// ---------------------------------------------------------------------------

test("repair report is a pure function of inputs", async () => {
  // The state-storage scenario (reference-probe included) run twice with
  // identical inputs produces byte-identical, content-addressed reports —
  // no clocks, no ports, no durations.
  const b02Seed = {
    boardName: "Field Operations Board",
    openTasks: 3,
    status: "operational",
    tasks: ["Inspect the intake pump", "Replace the filter cartridge", "Log the evening reading"],
  };
  const buildCandidatePlan = async (): Promise<SynthesisPlan> => {
    const basePlan = await planSynthesisApp(
      specOf("rc-w3-0006-pure", ["settings"]),
      modelOf([{ id: "settings", name: "Board settings", steps: 2 }], { state: b02Seed }),
      [],
    );
    const candidatePlan = structuredClone(basePlan);
    (candidatePlan.state as Record<string, unknown>).boardName = "Wrong Operations Board";
    return candidatePlan;
  };
  const loopInputFor = () => ({
    reference: () => harnessSide("reference", B02),
    candidatePlan: undefined as unknown as SynthesisPlan,
    materialize: materializer({ withSnapshotState: true }),
    journeys: [
      {
        id: "j-settings-pure",
        name: "B02 settings state parity",
        routePath: "/settings",
        anchors: ["Board settings"],
      },
    ] satisfies PairedJourney[],
    budget: 3,
    dimensions: { visual: false } as const,
  });

  const firstInput = loopInputFor();
  firstInput.candidatePlan = await buildCandidatePlan();
  const first = await runRepairLoop(firstInput);

  const secondInput = loopInputFor();
  secondInput.candidatePlan = await buildCandidatePlan();
  const second = await runRepairLoop(secondInput);

  assert.equal(first.converged, true);
  assert.equal(second.converged, true);
  assert.equal(JSON.stringify(second), JSON.stringify(first), "byte-identical reports");
  assert.equal(second.id, first.id, "content-addressed report ids agree");
  assert.equal(serializeRepairReport(second), serializeRepairReport(first));
});
