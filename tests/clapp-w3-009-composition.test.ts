import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type {
  BehavioralIr,
  ClappPackage,
  EvidenceRef,
  Journey,
  ReconstructionSpec,
} from "../packages/clapp-contracts/src/index.ts";
import {
  buildCompatGraph,
  classifyFromIr,
  createPackageRegistry,
  explore,
  type PackageRegistry,
  type PackageStore,
  type PackageStoreKey,
  type PackageStoreRecord,
} from "../packages/clapp-intelligence/src/index.ts";
import { canonicalJson } from "../packages/clapp-synthesis/src/canonical.ts";
import {
  CompositionError,
  type CompositionGraph,
  type CompositionGraphEdge,
  type CompositionGraphNode,
  type CompositionInput,
  generateCandidateApp,
  planComposition,
  planSynthesisApp,
  validateSynthesisPlan,
} from "../packages/clapp-synthesis/src/index.ts";

/**
 * CLAPP-W3-009 — the archetype composition planner.
 *
 * Proves the composition half of the "App archetype factory" (M6 steps 4-5:
 * build a second app that matches a prior archetype, reuse packages): a
 * detected archetype plus registry-selected compatible packages derive a
 * composition plan (which package slots to fill, with which versions, from
 * the compatibility graph) that the candidate generator chain consumes, with
 * an explicit no-compatible-set fallback path (vanilla synthesis) and
 * recorded provenance for every selected package.
 *
 * The seam composes the REAL W2-004 classifier, the REAL W2-005 registry and
 * the REAL W2-007 compatibility graph: their actual outputs feed
 * planComposition, whose packageIds feed the REAL W3-001 planner into a
 * SynthesisPlan that passes validateSynthesisPlan and the REAL W3-002
 * generator — while composition.ts itself imports nothing outside
 * @clapp/synthesis + @clapp/contracts (the structural ports meet the real
 * types at this seam, never inside the module). Everything is pure
 * in-process: no network, no wall-clock, no randomness.
 */

// ---------------------------------------------------------------------------
// Fixture constants (the W2-004 calibration conventions, verbatim)
// ---------------------------------------------------------------------------

const TARGET = "target-w3-009";
const RECON = "recon-w3-009";
const FIXED_ISO = "2025-01-01T00:00:00.000Z";
const VERIFIED_AT = "2025-07-01T10:00:00.000Z";

const SOURCE_NOTES = {
  domText: "browser-worker read() innerText snapshot",
  pageMeta: "browser-worker read() url+title",
  domStructure:
    "browser-worker lacks a DOM structure snapshot endpoint; read() returns innerText only",
  a11y: "browser-worker lacks an a11y snapshot endpoint",
  network: "browser-worker network capture: request/response records",
  storage: "browser-worker storage state export",
} as const;

const B = {
  home: "https://field.example/",
  tasks: "https://field.example/tasks",
  settings: "https://field.example/settings",
  api: "https://field.example/api/",
} as const;

const sha256Hex = (input: string) => createHash("sha256").update(input).digest("hex");

/** An observed evidence ref literal (page or channel evidence). */
const observed = (kind: string, id: string, sha256: string, source: string): EvidenceRef => ({
  id,
  targetId: TARGET,
  reconstructionId: RECON,
  kind,
  sha256,
  source,
  capturedAt: FIXED_ISO,
  classification: "observed",
  redacted: false,
});

/** An unavailable channel ref literal. */
const unavailable = (kind: string, id: string, source: string): EvidenceRef => ({
  id,
  targetId: TARGET,
  reconstructionId: RECON,
  kind,
  sha256: sha256Hex(source),
  source,
  capturedAt: FIXED_ISO,
  classification: "unavailable",
  redacted: false,
});

/**
 * The B02-like IR (CRUD SaaS) — the W2-004 calibration fixture: three
 * screens, a baseline visit journey plus two form journeys (fill/submit
 * steps whose submit steps carry POST-family method assertions citing
 * observed network evidence), and populated api/state/data records carrying
 * evidenceIds. Only components (and integrations) stay honestly empty.
 */
function b02LikeIr(): BehavioralIr {
  const screens = [
    {
      screenId: "screen-b02-dashboard",
      entrypoint: B.home,
      url: B.home,
      title: "Field Notes — Overview",
      textDigest: sha256Hex("dashboard page text"),
      textChars: 600,
      truncated: false,
      evidenceIds: ["ev-dashboard-dom-text", "ev-dashboard-page-meta"],
      links: [B.home, B.tasks, B.settings],
    },
    {
      screenId: "screen-b02-tasks",
      entrypoint: B.home,
      url: B.tasks,
      title: "Field Notes — Worklist",
      textDigest: sha256Hex("tasks page text"),
      textChars: 540,
      truncated: false,
      evidenceIds: ["ev-tasks-dom-text", "ev-tasks-page-meta"],
      links: [B.home, B.tasks, B.settings],
    },
    {
      screenId: "screen-b02-settings",
      entrypoint: B.home,
      url: B.settings,
      title: "Field Notes — Preferences",
      textDigest: sha256Hex("settings page text"),
      textChars: 480,
      truncated: false,
      evidenceIds: ["ev-settings-dom-text", "ev-settings-page-meta"],
      links: [B.home, B.tasks, B.settings],
    },
  ];
  const evidence: EvidenceRef[] = [
    observed(
      "dom-text",
      "ev-dashboard-dom-text",
      sha256Hex("dashboard page text"),
      SOURCE_NOTES.domText,
    ),
    observed("page-meta", "ev-dashboard-page-meta", sha256Hex(B.home), SOURCE_NOTES.pageMeta),
    observed("dom-text", "ev-tasks-dom-text", sha256Hex("tasks page text"), SOURCE_NOTES.domText),
    observed("page-meta", "ev-tasks-page-meta", sha256Hex(B.tasks), SOURCE_NOTES.pageMeta),
    observed(
      "dom-text",
      "ev-settings-dom-text",
      sha256Hex("settings page text"),
      SOURCE_NOTES.domText,
    ),
    observed("page-meta", "ev-settings-page-meta", sha256Hex(B.settings), SOURCE_NOTES.pageMeta),
    observed("network", "ev-api-network-1", sha256Hex("POST /api/ record"), SOURCE_NOTES.network),
    observed("network", "ev-api-network-2", sha256Hex("GET /api/ record"), SOURCE_NOTES.network),
    observed(
      "storage",
      "ev-state-storage-1",
      sha256Hex("store state snapshot"),
      SOURCE_NOTES.storage,
    ),
    unavailable("dom-structure", "ev-unavailable-dom-structure", SOURCE_NOTES.domStructure),
    unavailable("a11y", "ev-unavailable-a11y", SOURCE_NOTES.a11y),
  ];
  const visit: Journey = {
    id: `visit:${B.home}`,
    name: `visit ${B.home}`,
    preconditions: [],
    steps: [
      {
        id: `visit:${B.home}:step-1`,
        action: "visit",
        target: B.home,
        assertions: { evidenceIds: ["ev-dashboard-dom-text", "ev-dashboard-page-meta"] },
      },
    ],
  };
  const recordTask: Journey = {
    id: "record-task:tasks",
    name: "record a new task",
    preconditions: [],
    steps: [
      {
        id: "record-task:tasks:step-1",
        action: "visit",
        target: B.tasks,
        assertions: { evidenceIds: ["ev-tasks-dom-text", "ev-tasks-page-meta"] },
      },
      {
        id: "record-task:tasks:step-2",
        action: "fill",
        target: "title",
        input: { value: "Inspect the intake pump" },
        assertions: { field: "title" },
      },
      {
        id: "record-task:tasks:step-3",
        action: "fill",
        target: "assignee",
        input: { value: "Dana" },
        assertions: { field: "assignee" },
      },
      {
        id: "record-task:tasks:step-4",
        action: "submit",
        target: B.api,
        input: { formAction: B.api },
        assertions: { method: "POST", path: "/api/", evidenceIds: ["ev-api-network-1"] },
      },
    ],
  };
  const saveStatus: Journey = {
    id: "save-status:dashboard",
    name: "save the board status",
    preconditions: [],
    steps: [
      {
        id: "save-status:dashboard:step-1",
        action: "visit",
        target: B.home,
        assertions: { evidenceIds: ["ev-dashboard-dom-text", "ev-dashboard-page-meta"] },
      },
      {
        id: "save-status:dashboard:step-2",
        action: "fill",
        target: "status",
        input: { value: "operational" },
        assertions: { field: "status" },
      },
      {
        id: "save-status:dashboard:step-3",
        action: "submit",
        target: B.api,
        input: { formAction: B.api },
        assertions: { method: "POST", path: "/api/", evidenceIds: ["ev-api-network-1"] },
      },
    ],
  };
  return {
    schemaVersion: "0.1",
    application: {
      id: `app-${sha256Hex(TARGET)}`,
      name: "Field Notes operations board",
      platform: "web",
      entrypoints: [B.home],
    },
    evidence,
    journeys: [visit, recordTask, saveStatus],
    screens,
    components: [],
    state: {
      store: { boardName: "Field Operations Board", openTasks: 3, status: "operational" },
      evidenceIds: ["ev-state-storage-1"],
    },
    data: {
      collections: ["tasks"],
      evidenceIds: ["ev-state-storage-1"],
    },
    api: {
      endpoints: [
        { method: "GET", path: "/api/" },
        { method: "POST", path: "/api/" },
      ],
      evidenceIds: ["ev-api-network-1", "ev-api-network-2"],
    },
    integrations: [],
    assumptions: [
      {
        source: "extraction",
        path: "components",
        reason: `components left empty: component extraction requires DOM structure evidence; the "dom-structure" channel is unavailable in this bundle ("${SOURCE_NOTES.domStructure}")`,
        evidenceIds: ["ev-unavailable-dom-structure"],
      },
    ],
    constraints: [],
  };
}

/**
 * A minimal IR (the W2-004 "unknown" calibration shape): one screen with an
 * unknown textChars count, one visit journey, only the two page evidence
 * refs, no assumptions — the real classifier honestly emits "unknown".
 */
function unknownVerdictIr(): BehavioralIr {
  const screen = {
    screenId: "screen-minimal",
    entrypoint: B.home,
    url: B.home,
    title: "Field Notes — Overview",
    textDigest: sha256Hex("dashboard page text"),
    textChars: null,
    truncated: false,
    evidenceIds: ["ev-dashboard-dom-text", "ev-dashboard-page-meta"],
  };
  const visit: Journey = {
    id: `visit:${B.home}`,
    name: `visit ${B.home}`,
    preconditions: [],
    steps: [
      {
        id: `visit:${B.home}:step-1`,
        action: "visit",
        target: B.home,
        assertions: { evidenceIds: ["ev-dashboard-dom-text", "ev-dashboard-page-meta"] },
      },
    ],
  };
  return {
    schemaVersion: "0.1",
    application: {
      id: `app-${sha256Hex(TARGET)}`,
      name: "Unknown single page",
      platform: "web",
      entrypoints: [B.home],
    },
    evidence: [
      observed(
        "dom-text",
        "ev-dashboard-dom-text",
        sha256Hex("dashboard page text"),
        SOURCE_NOTES.domText,
      ),
      observed("page-meta", "ev-dashboard-page-meta", sha256Hex(B.home), SOURCE_NOTES.pageMeta),
    ],
    journeys: [visit],
    screens: [screen],
    components: [],
    state: {},
    data: {},
    api: {},
    integrations: [],
    assumptions: [],
    constraints: [],
  };
}

// ---------------------------------------------------------------------------
// Registry fixtures (the W2-007 in-process pattern)
// ---------------------------------------------------------------------------

/** In-memory PackageStore (the W2-005 port's only test implementation). */
class InMemoryPackageStore implements PackageStore {
  readonly rows = new Map<string, PackageStoreRecord>();

  get(key: PackageStoreKey): PackageStoreRecord | null {
    return this.rows.get(`${key.id}@${key.version}`) ?? null;
  }

  put(record: PackageStoreRecord): void {
    this.rows.set(`${record.key.id}@${record.key.version}`, record);
  }

  list(): PackageStoreRecord[] {
    return [...this.rows.values()];
  }
}

interface PackageDocOverrides {
  id?: string;
  version?: string;
  category?: string;
  purpose?: string;
  capabilities?: string[];
  supportedTargets?: string[];
}

/** A flat, registry-normalized ClappPackage fixture document. */
function makePackageDoc(overrides: PackageDocOverrides = {}): ClappPackage {
  return {
    schemaVersion: "0.1",
    id: overrides.id ?? "clapp_pkg_fixture",
    version: overrides.version ?? "0.1.0",
    category: overrides.category ?? "CRUD SaaS",
    purpose: overrides.purpose ?? "W3-009 composition fixture",
    interface: {},
    capabilities: overrides.capabilities ?? [],
    constraints: [],
    dependencies: [],
    supportedTargets: overrides.supportedTargets ?? [],
    tests: [],
    benchmark: {},
    failureModes: [],
    provenance: {},
  };
}

/** Registers a fixture through the registry in the W2-006 envelope shape. */
function registerFixture(registry: PackageRegistry, overrides: PackageDocOverrides): void {
  const doc = makePackageDoc(overrides);
  const { schemaVersion, ...packageBody } = doc;
  const result = registry.register({ schemaVersion, package: packageBody });
  if (!result.ok) {
    assert.fail(
      `fixture registration failed: ${result.errors.map((error) => error.message).join("; ")}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Plan/generator fixtures (the W3-001 pattern)
// ---------------------------------------------------------------------------

function makeSpec(
  packagePolicy: "verified-only" | "verified-and-candidates" = "verified-only",
): ReconstructionSpec {
  return {
    specVersion: "0.1",
    reconstructionId: "rc-w3-0009",
    targetId: "target-w3-0009",
    name: "W3-009 Fixture Application",
    platform: "web",
    entrypoints: ["/"],
    authorization: {
      ownerId: "owner-1",
      targetId: "target-w3-0009",
      scope: ["reconstruct:ui"],
      environments: ["sandbox"],
      retention: "project",
      benchmarkOwned: true,
      createdAt: "2025-01-01T00:00:00.000Z",
    },
    exploration: { maxStages: 4, maxActions: 64, maxDurationMs: 300000, seed: 42 },
    synthesis: { targetStack: "static-web", allowNetwork: false, packagePolicy },
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
      id: "app-w3-0009",
      name: "W3-009 Fixture Application",
      platform: "web",
      entrypoints: ["/"],
    },
    evidence: [],
    journeys: [
      {
        id: "j-login",
        name: "Sign in",
        preconditions: [],
        steps: [
          { id: "s-login-1", action: "fill", target: "#username", input: { value: "alice" } },
        ],
      },
      {
        id: "j-search",
        name: "Search",
        preconditions: [],
        steps: [{ id: "s-search-1", action: "fill", target: "#query" }],
      },
    ],
    screens: [],
    components: [],
    state: {},
    data: {},
    api: {},
    integrations: [],
    assumptions: [],
    constraints: [],
  };
}

// ---------------------------------------------------------------------------
// Composition fixtures and helpers
// ---------------------------------------------------------------------------

const gnode = (id: string, version: string, promoted: boolean): CompositionGraphNode => ({
  id,
  version,
  promoted,
});

const gedge = (
  fromId: string,
  fromVersion: string,
  toId: string,
  toVersion: string,
  kind: string,
  reason: string,
): CompositionGraphEdge => ({
  from: { id: fromId, version: fromVersion },
  to: { id: toId, version: toVersion },
  kind,
  reason,
});

/** A well-formed composed-plan input (three same-archetype survivors + one gated-out). */
function composedInput(): CompositionInput {
  const packages: ClappPackage[] = [
    makePackageDoc({
      id: "clapp_pkg_anchor",
      version: "1.0.0",
      category: "CRUD SaaS",
      capabilities: ["http-api", "persistent-state"],
      supportedTargets: ["web"],
    }),
    makePackageDoc({
      id: "clapp_pkg_ext",
      version: "0.2.0",
      category: "CRUD SaaS",
      capabilities: ["auth-sessions"],
      supportedTargets: ["web", "android"],
    }),
    makePackageDoc({
      id: "clapp_pkg_cand",
      version: "0.1.0",
      category: "CRUD SaaS",
      capabilities: ["http-api", "realtime-channel"],
      supportedTargets: ["web"],
    }),
    makePackageDoc({
      id: "clapp_pkg_other",
      version: "0.1.0",
      category: "marketing/content site",
      capabilities: ["seo"],
      supportedTargets: ["web"],
    }),
  ];
  const graph: CompositionGraph = {
    nodes: [
      gnode("clapp_pkg_anchor", "1.0.0", true),
      gnode("clapp_pkg_ext", "0.2.0", true),
      gnode("clapp_pkg_cand", "0.1.0", false),
      gnode("clapp_pkg_other", "0.1.0", true),
    ],
    edges: [
      gedge(
        "clapp_pkg_anchor",
        "1.0.0",
        "clapp_pkg_ext",
        "0.2.0",
        "category-shared",
        "category-shared",
      ),
      gedge(
        "clapp_pkg_anchor",
        "1.0.0",
        "clapp_pkg_cand",
        "0.1.0",
        "category-shared",
        "category-shared",
      ),
      gedge(
        "clapp_pkg_anchor",
        "1.0.0",
        "clapp_pkg_cand",
        "0.1.0",
        "capability-overlap",
        "capability-overlap:http-api",
      ),
      gedge(
        "clapp_pkg_ext",
        "0.2.0",
        "clapp_pkg_cand",
        "0.1.0",
        "category-shared",
        "category-shared",
      ),
      gedge(
        "clapp_pkg_anchor",
        "1.0.0",
        "clapp_pkg_other",
        "0.1.0",
        "target-overlap",
        "target-overlap:web",
      ),
    ],
  };
  return {
    verdict: { label: "CRUD SaaS", confidence: 0.82 },
    packages,
    graph,
    packagePolicy: "verified-and-candidates",
  };
}

/** A minimal well-formed baseline input for mutation-based fail-closed cases. */
function baseInput(): CompositionInput {
  return {
    verdict: { label: "CRUD SaaS", confidence: 0.8 },
    packages: [
      makePackageDoc({
        id: "clapp_pkg_fixture",
        version: "0.1.0",
        category: "CRUD SaaS",
        capabilities: ["http-api"],
        supportedTargets: ["web"],
      }),
    ],
    graph: { nodes: [gnode("clapp_pkg_fixture", "0.1.0", true)], edges: [] },
    packagePolicy: "verified-only",
  };
}

/** Casts an unknown value to the planComposition input shape (TS bypass). */
function asInput(value: unknown): CompositionInput {
  return value as CompositionInput;
}

/** A fixture document with one field removed (for the missing-field cases). */
function docWithout(field: string): Record<string, unknown> {
  const doc: Record<string, unknown> = { ...makePackageDoc() };
  delete doc[field];
  return doc;
}

/** Asserts that a call fails closed with a typed CompositionError. */
function expectCompositionError(
  call: () => unknown,
  issueFragments: string[],
  minIssues?: number,
): void {
  let thrown: unknown = null;
  let threw = false;
  try {
    call();
  } catch (error) {
    threw = true;
    thrown = error;
  }
  assert.ok(threw, "expected the call to fail closed");
  assert.ok(
    thrown instanceof CompositionError,
    `expected a CompositionError, got: ${String(thrown)}`,
  );
  assert.equal(thrown.name, "CompositionError");
  assert.equal(thrown.code, "invalid-input");
  assert.ok(thrown.message.length > 0, "the error explains itself");
  assert.ok(Array.isArray(thrown.issues), "the error collects its issues");
  if (minIssues !== undefined) {
    assert.ok(
      thrown.issues.length >= minIssues,
      `expected at least ${minIssues} collected issues, got ${thrown.issues.length}: ${thrown.issues.join("; ")}`,
    );
  }
  for (const fragment of issueFragments) {
    assert.ok(
      thrown.issues.some((issue) => issue.includes(fragment)),
      `expected an issue containing "${fragment}", got: ${thrown.issues.join("; ")}`,
    );
  }
}

/** Recursively rebuilds every object with its keys reversed (key-order shuffle). */
const shuffleKeyOrder = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(shuffleKeyOrder);
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const shuffled: Record<string, unknown> = {};
    for (const key of Object.keys(record).reverse()) {
      shuffled[key] = shuffleKeyOrder(record[key]);
    }
    return shuffled;
  }
  return value;
};

/** Collects every object/array reference in a value tree (shared-reference check). */
function collectObjects(value: unknown, into: Set<unknown>): void {
  if (Array.isArray(value)) {
    into.add(value);
    for (const entry of value) collectObjects(entry, into);
    return;
  }
  if (typeof value === "object" && value !== null) {
    into.add(value);
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) collectObjects(record[key], into);
  }
}

/** The module specifiers of every import/export-from statement in a source. */
function importSpecifiersOf(source: string): string[] {
  const specifiers: string[] = [];
  const pattern = /\bfrom\s+(["'])([^"'\n]+)\1/g;
  let match = pattern.exec(source);
  while (match !== null) {
    specifiers.push(match[2]);
    match = pattern.exec(source);
  }
  return specifiers;
}

const COMPOSITION_SOURCE = "../packages/clapp-synthesis/src/composition.ts";

// ---------------------------------------------------------------------------
// Required test 1 — determinism
// ---------------------------------------------------------------------------

test("the composition plan is deterministic and byte-identical", () => {
  const input = composedInput();

  const first = planComposition(structuredClone(input));
  const second = planComposition(structuredClone(input));
  if (first.status !== "composed" || second.status !== "composed") {
    assert.fail(`expected composed plans, got ${first.status}/${second.status}`);
  }

  // The same input always yields a deep-equal plan...
  assert.deepEqual(second, first);

  // ...a byte-identical canonical serialization...
  assert.equal(canonicalJson(second), canonicalJson(first));

  // ...and a stable, well-formed content digest.
  assert.match(first.compositionDigest, /^[0-9a-f]{64}$/);
  assert.equal(second.compositionDigest, first.compositionDigest);

  // Shuffled snapshot/graph array order and reversed key-insertion order
  // never change the output: ranking is identity-stable, notes walk the rank
  // order and edge reasons are sorted.
  const shuffled = shuffleKeyOrder({
    ...input,
    packages: [input.packages[2], input.packages[0], input.packages[3], input.packages[1]],
    graph: {
      nodes: [...input.graph.nodes].reverse(),
      edges: [...input.graph.edges].reverse(),
    },
  }) as CompositionInput;
  const shuffledPlan = planComposition(shuffled);
  if (shuffledPlan.status !== "composed") {
    assert.fail(`expected a composed plan, got ${shuffledPlan.status}`);
  }
  assert.deepEqual(shuffledPlan, first, "input array order never leaks into the output");
  assert.equal(canonicalJson(shuffledPlan), canonicalJson(first));
  assert.equal(shuffledPlan.compositionDigest, first.compositionDigest);

  // The identity-stable rank order is pinned: promoted anchor first (most
  // survivor-incident edges among the promoted), then the second promoted
  // survivor, then the candidate.
  assert.deepEqual(first.packageIds, ["clapp_pkg_anchor", "clapp_pkg_ext", "clapp_pkg_cand"]);
  assert.equal(first.selections[0].role, "archetype-anchor");
  assert.equal(first.selections[1].role, "compatible-extension");
  assert.equal(first.selections[2].role, "compatible-extension");
});

// ---------------------------------------------------------------------------
// Required test 2 — the honest no-compatible-set fallback
// ---------------------------------------------------------------------------

test("a known archetype with no compatible set falls back to vanilla synthesis honestly", async () => {
  const spec = makeSpec("verified-only");
  const model = makeModel();

  // Case A: no category-matching package at all — the generic "application"
  // documents are never coerced into matches.
  const snapshotA: ClappPackage[] = [
    makePackageDoc({
      id: "clapp_pkg_marketing",
      version: "0.1.0",
      category: "marketing/content site",
      capabilities: ["seo"],
    }),
    makePackageDoc({ id: "clapp_pkg_generic", version: "0.1.0", category: "application" }),
  ];
  const graphA = buildCompatGraph(snapshotA);
  const planA = planComposition({
    verdict: { label: "CRUD SaaS", confidence: 0.9 },
    packages: snapshotA,
    graph: graphA,
    packagePolicy: "verified-only",
  });
  if (planA.status !== "fallback") {
    assert.fail(`expected a fallback plan, got ${planA.status}`);
  }
  assert.deepEqual(planA.packageIds, []);
  assert.ok(planA.reason.includes('category "CRUD SaaS"'), planA.reason);
  assert.ok(planA.reason.includes("no package"), planA.reason);
  assert.ok(!("selections" in planA), "a fallback plan never carries fabricated slots");

  // Case B: same-archetype packages exist but none survives the policy gate.
  const snapshotB: ClappPackage[] = [
    makePackageDoc({
      id: "clapp_pkg_crud_a",
      version: "0.1.0",
      category: "CRUD SaaS",
      capabilities: ["http-api"],
    }),
    makePackageDoc({
      id: "clapp_pkg_crud_b",
      version: "0.1.0",
      category: "CRUD SaaS",
      capabilities: ["persistent-state"],
    }),
  ];
  const graphB = buildCompatGraph(snapshotB);
  assert.ok(graphB.nodes.length === 2 && graphB.nodes.every((node) => !node.promoted));
  const planB = planComposition({
    verdict: { label: "CRUD SaaS", confidence: 0.9 },
    packages: snapshotB,
    graph: graphB,
    packagePolicy: "verified-only",
  });
  if (planB.status !== "fallback") {
    assert.fail(`expected a fallback plan, got ${planB.status}`);
  }
  assert.deepEqual(planB.packageIds, []);
  assert.ok(planB.reason.includes("none is promoted"), planB.reason);
  assert.ok(planB.reason.includes("verified-only"), planB.reason);
  assert.ok(!("selections" in planB), "a fallback plan never carries fabricated slots");

  // The empty list through the REAL W3-001 planner is the vanilla path —
  // carrying W3-001's own no-packages assumption, never a fabricated slot.
  const vanilla = await planSynthesisApp(spec, model, planB.packageIds);
  assert.deepEqual(vanilla.packageIds, []);
  const noPackagesAssumption = vanilla.assumptions.find(
    (entry) =>
      (entry as Record<string, unknown>).reason ===
      "No well-formed package ids were supplied; the plan references no packages.",
  );
  assert.ok(noPackagesAssumption, "the vanilla plan carries W3-001's own no-packages assumption");
  assert.ok(validateSynthesisPlan(vanilla).ok, "the vanilla path stays consumable");
});

// ---------------------------------------------------------------------------
// Required test 3 — verbatim provenance
// ---------------------------------------------------------------------------

test("every selected package records verbatim provenance", () => {
  // Scenario A: a connected selection — the provenance carries the registry
  // fields it read and the VERBATIM edge reasons of every connecting edge.
  const packagesA: ClappPackage[] = [
    makePackageDoc({
      id: "clapp_pkg_core",
      version: "0.1.0",
      category: "CRUD SaaS",
      capabilities: ["http-api", "persistent-state"],
      supportedTargets: ["web"],
    }),
    makePackageDoc({
      id: "clapp_pkg_more",
      version: "0.1.0",
      category: "CRUD SaaS",
      capabilities: ["http-api", "auth-sessions"],
      supportedTargets: ["web"],
    }),
  ];
  const graphA: CompositionGraph = {
    nodes: [gnode("clapp_pkg_core", "0.1.0", true), gnode("clapp_pkg_more", "0.1.0", false)],
    edges: [
      gedge(
        "clapp_pkg_core",
        "0.1.0",
        "clapp_pkg_more",
        "0.1.0",
        "category-shared",
        "category-shared",
      ),
      gedge(
        "clapp_pkg_core",
        "0.1.0",
        "clapp_pkg_more",
        "0.1.0",
        "capability-overlap",
        "capability-overlap:http-api",
      ),
      gedge(
        "clapp_pkg_core",
        "0.1.0",
        "clapp_pkg_more",
        "0.1.0",
        "target-overlap",
        "target-overlap:web",
      ),
    ],
  };
  const planA = planComposition({
    verdict: { label: "CRUD SaaS", confidence: 0.8 },
    packages: packagesA,
    graph: graphA,
    packagePolicy: "verified-and-candidates",
  });
  if (planA.status !== "composed") {
    assert.fail(`expected a composed plan, got ${planA.status}`);
  }
  assert.equal(planA.selections.length, 2);
  const [anchorA, extensionA] = planA.selections;
  assert.equal(anchorA.role, "archetype-anchor");
  assert.equal(anchorA.packageId, "clapp_pkg_core");
  assert.equal(anchorA.version, "0.1.0");
  assert.equal(anchorA.provenance.category, "CRUD SaaS");
  assert.deepEqual(anchorA.provenance.capabilities, ["http-api", "persistent-state"]);
  assert.deepEqual(anchorA.provenance.supportedTargets, ["web"]);
  assert.equal(anchorA.provenance.lifecycle, "promoted");
  assert.deepEqual(anchorA.provenance.edgeReasons, [
    "capability-overlap:http-api",
    "category-shared",
    "target-overlap:web",
  ]);
  assert.equal(extensionA.role, "compatible-extension");
  assert.equal(extensionA.packageId, "clapp_pkg_more");
  assert.equal(extensionA.provenance.lifecycle, "candidate");
  assert.deepEqual(extensionA.provenance.edgeReasons, [
    "capability-overlap:http-api",
    "category-shared",
    "target-overlap:web",
  ]);

  // Scenario B: an isolated anchor — honest empty reasons, never an invented edge.
  const packagesB: ClappPackage[] = [
    makePackageDoc({
      id: "clapp_pkg_core",
      version: "0.1.0",
      category: "CRUD SaaS",
      capabilities: ["http-api"],
      supportedTargets: ["web"],
    }),
    makePackageDoc({
      id: "clapp_pkg_lone",
      version: "0.1.0",
      category: "CRUD SaaS",
      capabilities: ["auth-sessions"],
      supportedTargets: ["web"],
    }),
  ];
  const graphB: CompositionGraph = {
    nodes: [gnode("clapp_pkg_core", "0.1.0", true), gnode("clapp_pkg_lone", "0.1.0", false)],
    edges: [],
  };
  const planB = planComposition({
    verdict: { label: "CRUD SaaS", confidence: 0.8 },
    packages: packagesB,
    graph: graphB,
    packagePolicy: "verified-and-candidates",
  });
  if (planB.status !== "composed") {
    assert.fail(`expected a composed plan, got ${planB.status}`);
  }
  assert.equal(planB.selections.length, 1, "a single anchor alone is a compatible set");
  assert.deepEqual(planB.selections[0].provenance.edgeReasons, []);
  assert.ok(
    planB.selections[0].provenance.note.includes("isolated"),
    planB.selections[0].provenance.note,
  );
  assert.ok(
    planB.notes.some((note) => note.includes("clapp_pkg_lone") && note.includes("isolated")),
    `the isolated survivor is recorded honestly: ${JSON.stringify(planB.notes)}`,
  );
  assert.ok(
    planB.notes.some((note) => note.includes("clapp_pkg_core") && note.includes("isolated")),
    `the isolated anchor is recorded honestly: ${JSON.stringify(planB.notes)}`,
  );

  // Scenario C: a redundant survivor is skipped with an honest note.
  const packagesC: ClappPackage[] = [
    makePackageDoc({
      id: "clapp_pkg_core",
      version: "0.1.0",
      category: "CRUD SaaS",
      capabilities: ["http-api"],
      supportedTargets: ["web"],
    }),
    makePackageDoc({
      id: "clapp_pkg_echo",
      version: "0.1.0",
      category: "CRUD SaaS",
      capabilities: ["http-api"],
      supportedTargets: ["web"],
    }),
  ];
  const graphC: CompositionGraph = {
    nodes: [gnode("clapp_pkg_core", "0.1.0", true), gnode("clapp_pkg_echo", "0.1.0", true)],
    edges: [
      gedge(
        "clapp_pkg_core",
        "0.1.0",
        "clapp_pkg_echo",
        "0.1.0",
        "category-shared",
        "category-shared",
      ),
    ],
  };
  const planC = planComposition({
    verdict: { label: "CRUD SaaS", confidence: 0.8 },
    packages: packagesC,
    graph: graphC,
    packagePolicy: "verified-and-candidates",
  });
  if (planC.status !== "composed") {
    assert.fail(`expected a composed plan, got ${planC.status}`);
  }
  assert.equal(planC.selections.length, 1);
  assert.deepEqual(planC.packageIds, ["clapp_pkg_core"]);
  assert.ok(
    planC.notes.some((note) => note.includes("clapp_pkg_echo") && note.includes("redundant")),
    `the redundant skip is recorded honestly: ${JSON.stringify(planC.notes)}`,
  );
});

// ---------------------------------------------------------------------------
// Required test 4 — the honest abstention
// ---------------------------------------------------------------------------

test("an unknown archetype abstains honestly", () => {
  // A REAL classifyFromIr-shaped verdict with label "unknown".
  const verdict = classifyFromIr({ ir: unknownVerdictIr() });
  assert.equal(verdict.label, "unknown");

  // Even a snapshot carrying a category-matching document never composes
  // over an unknown label — never a guessed category.
  const packages: ClappPackage[] = [
    makePackageDoc({
      id: "clapp_pkg_unknown_cat",
      version: "0.1.0",
      category: "unknown",
      capabilities: ["http-api"],
    }),
  ];
  const graph = buildCompatGraph(packages);
  const plan = planComposition({
    verdict,
    packages,
    graph,
    packagePolicy: "verified-and-candidates",
  });
  if (plan.status !== "abstained") {
    assert.fail(`expected an abstained plan, got ${plan.status}`);
  }
  assert.deepEqual(plan.packageIds, []);
  assert.ok(plan.reason.includes("unknown"), plan.reason);
  assert.ok(plan.reason.length > 0, "the abstention records its reason");
  assert.ok(!("selections" in plan), "an abstained plan never carries fabricated slots");
});

// ---------------------------------------------------------------------------
// Required test 5 — fail-closed validation
// ---------------------------------------------------------------------------

test("malformed registry snapshots and graphs fail closed", () => {
  // A non-array snapshot.
  expectCompositionError(
    () => planComposition(asInput({ ...baseInput(), packages: {} })),
    ["packages must be an array"],
  );

  // Entries missing id/version/category — every issue collected, never just the first.
  expectCompositionError(
    () =>
      planComposition(
        asInput({
          ...baseInput(),
          packages: [docWithout("id"), docWithout("version"), docWithout("category")],
        }),
      ),
    ["packages[0].id", "packages[1].version", "packages[2].category"],
    3,
  );

  // Non-string / non-array fields.
  expectCompositionError(
    () =>
      planComposition(
        asInput({
          ...baseInput(),
          packages: [
            { ...makePackageDoc(), capabilities: "http-api" },
            { ...makePackageDoc(), supportedTargets: [42] },
          ],
        }),
      ),
    ["packages[0].capabilities", "packages[1].supportedTargets"],
    2,
  );

  // A duplicate (id, version) identity.
  expectCompositionError(
    () =>
      planComposition(
        asInput({
          ...baseInput(),
          packages: [makePackageDoc(), makePackageDoc()],
        }),
      ),
    ["duplicate package identity clapp_pkg_fixture@0.1.0"],
  );

  // A graph whose nodes/edges are not arrays.
  expectCompositionError(
    () =>
      planComposition(
        asInput({
          ...baseInput(),
          graph: { nodes: "nope", edges: 7 },
        }),
      ),
    ["graph.nodes must be an array", "graph.edges must be an array"],
    2,
  );

  // An edge missing from/to/kind/reason.
  expectCompositionError(
    () =>
      planComposition(
        asInput({
          ...baseInput(),
          graph: { nodes: [gnode("clapp_pkg_fixture", "0.1.0", true)], edges: [{}] },
        }),
      ),
    ["graph.edges[0].from", "graph.edges[0].to", "graph.edges[0].kind", "graph.edges[0].reason"],
    4,
  );

  // A missing verdict, then a malformed one.
  expectCompositionError(
    () => planComposition(asInput({ ...baseInput(), verdict: undefined })),
    ["verdict must be an object"],
  );
  expectCompositionError(
    () => planComposition(asInput({ ...baseInput(), verdict: { label: 42, confidence: "high" } })),
    ["verdict.label", "verdict.confidence"],
    2,
  );

  // A missing or unknown packagePolicy — never a silent default.
  expectCompositionError(
    () => planComposition(asInput({ ...baseInput(), packagePolicy: undefined })),
    ["packagePolicy"],
  );
  expectCompositionError(
    () => planComposition(asInput({ ...baseInput(), packagePolicy: "sometimes" })),
    ["packagePolicy"],
  );

  // A graph that does not cover the snapshot is inconsistent state.
  expectCompositionError(
    () =>
      planComposition(
        asInput({
          ...baseInput(),
          graph: { nodes: [], edges: [] },
        }),
      ),
    ["graph.nodes has no node for clapp_pkg_fixture@0.1.0"],
  );

  // The kitchen sink: every section's issues are collected together.
  expectCompositionError(
    () =>
      planComposition(
        asInput({
          verdict: undefined,
          packages: "nope",
          graph: null,
          packagePolicy: undefined,
        }),
      ),
    [
      "verdict must be an object",
      "packages must be an array",
      "graph must be an object",
      "packagePolicy",
    ],
    4,
  );
});

// ---------------------------------------------------------------------------
// Required test 6 — purity
// ---------------------------------------------------------------------------

test("planComposition is pure — no side effects, no clock, no randomness", () => {
  const input = composedInput();
  const before = structuredClone(input);

  const plan = planComposition(input);

  // Inputs are never mutated.
  assert.deepEqual(input, before, "inputs are deep-equal before and after the call");

  // The returned plan shares no references with its inputs.
  const inputObjects = new Set<unknown>();
  collectObjects(input, inputObjects);
  const planObjects = new Set<unknown>();
  collectObjects(plan, planObjects);
  for (const planObject of planObjects) {
    assert.ok(
      !inputObjects.has(planObject),
      "the returned plan shares no object reference with its inputs",
    );
  }

  // Deterministic across calls; synchronous (never a Promise).
  const again = planComposition(input);
  assert.deepEqual(again, plan);
  assert.ok(!(plan instanceof Promise), "the plan is derived synchronously");

  // Source scan: no clock, no randomness, no timers, no network, no I/O.
  const source = readFileSync(new URL(COMPOSITION_SOURCE, import.meta.url), "utf8");
  for (const forbidden of [
    "Date.now",
    "new Date",
    "performance.now",
    "Math.random",
    "setTimeout",
    "setInterval",
    "fetch",
  ]) {
    assert.ok(!source.includes(forbidden), `composition.ts must not contain "${forbidden}"`);
  }
  for (const specifier of importSpecifiersOf(source)) {
    assert.ok(
      !specifier.startsWith("node:"),
      `composition.ts performs no system imports (found "${specifier}")`,
    );
  }
});

// ---------------------------------------------------------------------------
// Required test 7 — the real-surface seam
// ---------------------------------------------------------------------------

test("the composition seam composes the real W2-004, W2-005 and W2-007 surfaces", async () => {
  // Real W2-004: a B02-like IR classifies as CRUD SaaS through the real classifier.
  const ir = b02LikeIr();
  const exploration = explore({
    ir: structuredClone(ir),
    seed: 7,
    budget: { maxJourneys: 16, maxStepsPerJourney: 16 },
  });
  const verdict = classifyFromIr({ ir, exploration });
  assert.equal(verdict.label, "CRUD SaaS");

  // Real W2-005: register and promote real documents through the real registry.
  const registry = createPackageRegistry(new InMemoryPackageStore());
  registerFixture(registry, {
    id: "clapp_pkg_seam_api",
    version: "0.1.0",
    category: "CRUD SaaS",
    capabilities: ["http-api"],
    supportedTargets: ["web"],
  });
  registerFixture(registry, {
    id: "clapp_pkg_seam_state",
    version: "0.1.0",
    category: "CRUD SaaS",
    capabilities: ["persistent-state"],
    supportedTargets: ["web"],
  });
  registerFixture(registry, {
    id: "clapp_pkg_seam_auth",
    version: "0.1.0",
    category: "CRUD SaaS",
    capabilities: ["auth-sessions"],
    supportedTargets: ["web"],
  });
  registry.promote("clapp_pkg_seam_api", "0.1.0", {
    verifiedAt: VERIFIED_AT,
    verificationRunId: "clapp_run_w3_009_0001",
  });
  registry.promote("clapp_pkg_seam_state", "0.1.0", {
    verifiedAt: VERIFIED_AT,
    verificationRunId: "clapp_run_w3_009_0002",
  });

  // Real W2-005/W2-007: the snapshot from registry.list(), the graph from
  // buildCompatGraph — and their real types meet the structural ports.
  const snapshot = registry.list();
  assert.equal(snapshot.length, 3);
  const graph = buildCompatGraph(snapshot);
  assert.ok(graph.nodes.some((node) => node.id === "clapp_pkg_seam_api" && node.promoted));
  assert.ok(graph.nodes.some((node) => node.id === "clapp_pkg_seam_state" && node.promoted));
  assert.ok(graph.nodes.some((node) => node.id === "clapp_pkg_seam_auth" && !node.promoted));

  const plan = planComposition({
    verdict,
    packages: snapshot,
    graph,
    packagePolicy: "verified-and-candidates",
  });
  if (plan.status !== "composed") {
    assert.fail(`expected a composed plan, got ${plan.status}`);
  }
  assert.deepEqual(plan.packageIds, [
    "clapp_pkg_seam_api",
    "clapp_pkg_seam_state",
    "clapp_pkg_seam_auth",
  ]);
  const [anchor, extensionState, extensionAuth] = plan.selections;
  assert.equal(anchor.role, "archetype-anchor");
  assert.equal(anchor.packageId, "clapp_pkg_seam_api");
  assert.equal(extensionState.role, "compatible-extension");
  assert.equal(extensionState.packageId, "clapp_pkg_seam_state");
  assert.equal(extensionAuth.role, "compatible-extension");
  assert.equal(extensionAuth.packageId, "clapp_pkg_seam_auth");
  assert.equal(anchor.provenance.lifecycle, "promoted");
  assert.equal(extensionState.provenance.lifecycle, "promoted");
  assert.equal(extensionAuth.provenance.lifecycle, "candidate");
  for (const selection of plan.selections) {
    assert.ok(
      selection.provenance.edgeReasons.includes("category-shared"),
      "the verbatim graph reasons are carried",
    );
    assert.ok(selection.provenance.edgeReasons.includes("target-overlap:web"));
    assert.equal(selection.provenance.category, "CRUD SaaS");
  }

  // The seam: packageIds through the REAL W3-001 planner into a SynthesisPlan
  // that passes validateSynthesisPlan...
  const spec = makeSpec("verified-and-candidates");
  const synthesisPlan = await planSynthesisApp(spec, ir, plan.packageIds);
  assert.deepEqual(synthesisPlan.packageIds, plan.packageIds, "the ids feed the planner unchanged");
  const validation = validateSynthesisPlan(synthesisPlan);
  assert.equal(
    validation.ok,
    true,
    `the SynthesisPlan must validate: ${validation.errors.join("; ")}`,
  );

  // ...and then through the REAL W3-002 generator, unchanged.
  const generated = generateCandidateApp(synthesisPlan);
  assert.ok(generated.files.length > 0, "the real generator produces the candidate file set");

  // Source discipline: composition.ts imports nothing outside
  // @clapp/synthesis + @clapp/contracts.
  const source = readFileSync(new URL(COMPOSITION_SOURCE, import.meta.url), "utf8");
  const specifiers = importSpecifiersOf(source);
  assert.ok(specifiers.length > 0, "the source scan found the module's imports");
  for (const specifier of specifiers) {
    assert.ok(
      specifier.startsWith("./") ||
        specifier === "@clapp/contracts" ||
        specifier === "@clapp/synthesis",
      `composition.ts imports only within @clapp/synthesis + @clapp/contracts (found "${specifier}")`,
    );
  }
});

// ---------------------------------------------------------------------------
// Required test 8 — empty but well-formed inputs
// ---------------------------------------------------------------------------

test("empty but well-formed inputs degrade to the honest fallback", () => {
  const verdict = { label: "CRUD SaaS", confidence: 0.75 };
  const graph = { nodes: [], edges: [] };
  for (const packagePolicy of ["verified-only", "verified-and-candidates"] as const) {
    const plan = planComposition({ verdict, packages: [], graph, packagePolicy });
    if (plan.status !== "fallback") {
      assert.fail(`expected a fallback plan under ${packagePolicy}, got ${plan.status}`);
    }
    assert.deepEqual(plan.packageIds, []);
    assert.ok(plan.reason.includes('category "CRUD SaaS"'), plan.reason);
    assert.ok(plan.reason.includes("no package"), plan.reason);
    assert.ok(!("selections" in plan), "no fabricated slots over empty inputs");
  }
});
