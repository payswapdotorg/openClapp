import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { BehavioralIr, EvidenceRef, Journey } from "../packages/clapp-contracts/src/index.ts";
import type {
  ArchetypeFeatures,
  ExplorationResult,
} from "../packages/clapp-intelligence/src/index.ts";
import {
  ARCHETYPES,
  classifyArchetype,
  classifyFromIr,
  createIntelligenceEngine,
  explore,
  extractArchetypeFeatures,
} from "../packages/clapp-intelligence/src/index.ts";

/**
 * CLAPP-W2-004 — deterministic archetype classifier.
 *
 * IRs are constructed as typed literals mirroring the LANDED extraction and
 * exploration output shapes: screens carrying entrypoint/url/title/textDigest/
 * textChars/truncated/evidenceIds plus the W2-003 `links` inventory convention,
 * baseline "visit" journeys citing observed page evidence, and the W1-002
 * evidence kinds copied as literals (observed dom-text/page-meta pairs; the
 * unavailable channel kinds with their source notes). The B01-like fixture
 * (4 text-heavy interlinked screens, empty api/state/data with the W2-002
 * honest-emptiness assumptions) and the B02-like fixture (3 screens, form
 * journeys with fill/submit steps, populated api/state/data records carrying
 * evidenceIds — the network/storage-bearing capture convention) are the two
 * calibration targets; exploration results are produced by the landed explore()
 * (W2-003) wherever possible, and the classifier composes them per its contract.
 */

const TARGET = "target-w2-004";
const RECON = "recon-w2-004";
const FIXED_ISO = "2025-01-01T00:00:00.000Z";

const SOURCE_NOTES = {
  domText: "browser-worker read() innerText snapshot",
  pageMeta: "browser-worker read() url+title",
  domStructure:
    "browser-worker lacks a DOM structure snapshot endpoint; read() returns innerText only",
  a11y: "browser-worker lacks an a11y snapshot endpoint",
  network: "browser-worker network capture: request/response records",
  networkUnavailable:
    "browser-worker lacks a network capture endpoint; egress flows through its proxy without an observation surface",
  storage: "browser-worker storage state export",
  storageUnavailable:
    "browser-worker lacks a storage state export endpoint; storageState is persisted internally per session",
} as const;

const A = {
  home: "https://aurora.example/",
  about: "https://aurora.example/about",
  services: "https://aurora.example/services",
  contact: "https://aurora.example/contact",
  gallery: "https://aurora.example/gallery",
} as const;

const B = {
  home: "https://field.example/",
  tasks: "https://field.example/tasks",
  settings: "https://field.example/settings",
  api: "https://field.example/api/",
} as const;

const FULL_BUDGET = { maxJourneys: 16, maxStepsPerJourney: 16 };

const sha256Hex = (input: string) => createHash("sha256").update(input).digest("hex");

const canonicalJson = (value: unknown): string => {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

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

/** The W2-002 honest-emptiness assumptions for an empty api/state/data world. */
const unavailableChannelAssumptions = (): Record<string, unknown>[] => [
  {
    source: "extraction",
    path: "components",
    reason: `components left empty: component extraction requires DOM structure evidence; the "dom-structure" channel is unavailable in this bundle ("${SOURCE_NOTES.domStructure}")`,
    evidenceIds: ["ev-unavailable-dom-structure"],
  },
  {
    source: "extraction",
    path: "state",
    reason: `state left empty: state extraction requires storage evidence; the "storage" channel is unavailable in this bundle ("${SOURCE_NOTES.storageUnavailable}")`,
    evidenceIds: ["ev-unavailable-storage"],
  },
  {
    source: "extraction",
    path: "data",
    reason: `data left empty: data extraction requires network and storage evidence; the "network" channel is unavailable in this bundle ("${SOURCE_NOTES.networkUnavailable}"); the "storage" channel is unavailable in this bundle ("${SOURCE_NOTES.storageUnavailable}")`,
    evidenceIds: ["ev-unavailable-network", "ev-unavailable-storage"],
  },
  {
    source: "extraction",
    path: "api",
    reason: `api left empty: API extraction requires network evidence; the "network" channel is unavailable in this bundle ("${SOURCE_NOTES.networkUnavailable}")`,
    evidenceIds: ["ev-unavailable-network"],
  },
];

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
 * The B01-like IR (marketing/content): four text-heavy interlinked screens
 * (plus an unobserved gallery link), one baseline visit journey, and the
 * honest-empty api/state/data/components dimensions with the W2-002
 * assumption records. textChars carries the observed character counts (the
 * content-bearing extraction convention).
 */
export function b01LikeIr(): BehavioralIr {
  const screens = [
    {
      screenId: "screen-b01-home",
      entrypoint: A.home,
      url: A.home,
      title: "Aurora Studio — Welcome",
      textDigest: sha256Hex("home page text"),
      textChars: 1300,
      truncated: false,
      evidenceIds: ["ev-home-dom-text", "ev-home-page-meta"],
      links: [A.home, A.about, A.services, A.contact, A.gallery],
    },
    {
      screenId: "screen-b01-about",
      entrypoint: A.home,
      url: A.about,
      title: "Aurora Studio — The Workshop",
      textDigest: sha256Hex("about page text"),
      textChars: 1100,
      truncated: false,
      evidenceIds: ["ev-about-dom-text", "ev-about-page-meta"],
      links: [A.home, A.about, A.services, A.contact],
    },
    {
      screenId: "screen-b01-services",
      entrypoint: A.home,
      url: A.services,
      title: "Aurora Studio — What We Do",
      textDigest: sha256Hex("services page text"),
      textChars: 1500,
      truncated: false,
      evidenceIds: ["ev-services-dom-text", "ev-services-page-meta"],
      links: [A.home, A.about, A.services, A.contact],
    },
    {
      screenId: "screen-b01-contact",
      entrypoint: A.home,
      url: A.contact,
      title: "Aurora Studio — Say Hello",
      textDigest: sha256Hex("contact page text"),
      textChars: 900,
      truncated: false,
      evidenceIds: ["ev-contact-dom-text", "ev-contact-page-meta"],
      links: [A.home, A.about, A.services, A.contact],
    },
  ];
  const evidence: EvidenceRef[] = [
    observed("dom-text", "ev-home-dom-text", sha256Hex("home page text"), SOURCE_NOTES.domText),
    observed("page-meta", "ev-home-page-meta", sha256Hex(A.home), SOURCE_NOTES.pageMeta),
    observed("dom-text", "ev-about-dom-text", sha256Hex("about page text"), SOURCE_NOTES.domText),
    observed("page-meta", "ev-about-page-meta", sha256Hex(A.about), SOURCE_NOTES.pageMeta),
    observed(
      "dom-text",
      "ev-services-dom-text",
      sha256Hex("services page text"),
      SOURCE_NOTES.domText,
    ),
    observed("page-meta", "ev-services-page-meta", sha256Hex(A.services), SOURCE_NOTES.pageMeta),
    observed(
      "dom-text",
      "ev-contact-dom-text",
      sha256Hex("contact page text"),
      SOURCE_NOTES.domText,
    ),
    observed("page-meta", "ev-contact-page-meta", sha256Hex(A.contact), SOURCE_NOTES.pageMeta),
    unavailable("dom-structure", "ev-unavailable-dom-structure", SOURCE_NOTES.domStructure),
    unavailable("a11y", "ev-unavailable-a11y", SOURCE_NOTES.a11y),
    unavailable("network", "ev-unavailable-network", SOURCE_NOTES.networkUnavailable),
    unavailable("storage", "ev-unavailable-storage", SOURCE_NOTES.storageUnavailable),
  ];
  const visit: Journey = {
    id: `visit:${A.home}`,
    name: `visit ${A.home}`,
    preconditions: [],
    steps: [
      {
        id: `visit:${A.home}:step-1`,
        action: "visit",
        target: A.home,
        assertions: { evidenceIds: ["ev-home-dom-text", "ev-home-page-meta"] },
      },
    ],
  };
  return {
    schemaVersion: "0.1",
    application: {
      id: `app-${sha256Hex(TARGET)}`,
      name: "Aurora Studio marketing site",
      platform: "web",
      entrypoints: [A.home],
    },
    evidence,
    journeys: [visit],
    screens,
    components: [],
    state: {},
    data: {},
    api: {},
    integrations: [],
    assumptions: unavailableChannelAssumptions(),
    constraints: [],
  };
}

/**
 * The B02-like IR (CRUD SaaS): three screens, a baseline visit journey plus
 * two form journeys (fill/submit steps whose submit steps carry POST-family
 * method assertions citing observed network evidence), and populated
 * api/state/data records carrying evidenceIds — the network/storage-bearing
 * capture convention a richer extraction would emit. Only components (and
 * integrations) stay honestly empty.
 */
export function b02LikeIr(): BehavioralIr {
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

/** A two-screen, text-bearing IR with empty api/state/data (explicit assumptions). */
export function sparseIr(): BehavioralIr {
  const ir = b01LikeIr();
  return {
    ...ir,
    application: { ...ir.application, name: "Aurora Studio site" },
    screens: ir.screens.slice(0, 2),
    journeys: [ir.journeys[0]],
    evidence: ir.evidence.slice(0, 4).concat(ir.evidence.slice(8)),
  };
}

/** A minimal IR: one screen (unknown textChars), one visit journey, no signals. */
export function minimalIr(): BehavioralIr {
  const ir = b01LikeIr();
  return {
    ...ir,
    application: { ...ir.application, name: "Unknown single page" },
    screens: [
      {
        screenId: "screen-minimal",
        entrypoint: A.home,
        url: A.home,
        title: "Aurora Studio — Welcome",
        textDigest: sha256Hex("home page text"),
        textChars: null,
        truncated: false,
        evidenceIds: ["ev-home-dom-text", "ev-home-page-meta"],
      },
    ],
    journeys: [ir.journeys[0]],
    evidence: ir.evidence.slice(0, 2),
    assumptions: [],
  };
}

/** The exploration result of an IR via the landed W2-003 explore(). */
const explorationOf = (ir: BehavioralIr): ExplorationResult =>
  explore({ ir: structuredClone(ir), seed: 7, budget: { ...FULL_BUDGET } });

/** The dimension names of a sparseDimensions inventory. */
const dimensionsOf = (features: ArchetypeFeatures): string[] =>
  features.sparseDimensions.map((entry) => entry.slice(0, entry.indexOf(" (")));

test("B01-like profile classifies as marketing/content", () => {
  const ir = b01LikeIr();
  const exploration = explorationOf(ir);
  const verdict = classifyFromIr({ ir, exploration });

  assert.equal(verdict.label, "marketing/content site");
  assert.equal(verdict.scores[0]?.label, "marketing/content site");
  // Sparse-honest inputs (empty api/state/data with explicit assumptions) cap confidence below 0.6.
  assert.ok(
    verdict.confidence < 0.6,
    `confidence ${verdict.confidence} must be capped below 0.6 for the sparse B01-like IR`,
  );
  assert.ok(verdict.confidence >= 0.4, "a classifiable label keeps a honest non-zero confidence");
  // The rationale cites the feature evidence: the counts that drove the label.
  assert.ok(verdict.rationale.includes("screens=4"), verdict.rationale);
  assert.ok(verdict.rationale.includes("formSignals=0"), verdict.rationale);
  assert.ok(verdict.rationale.includes("apiSignals=0"), verdict.rationale);
  assert.ok(verdict.rationale.includes("sparse"), verdict.rationale);
});

test("B02-like profile classifies as CRUD SaaS", () => {
  const ir = b02LikeIr();
  const exploration = explorationOf(ir);
  const verdict = classifyFromIr({ ir, exploration });

  assert.equal(verdict.label, "CRUD SaaS");
  assert.equal(verdict.scores[0]?.label, "CRUD SaaS");
  // Rich inputs (populated api/state/data records) reach high confidence.
  assert.ok(
    verdict.confidence >= 0.6,
    `confidence ${verdict.confidence} must be high for the rich B02-like IR`,
  );
  // The state/api citations are present: the api and state records' evidence ids.
  assert.ok(verdict.evidenceCitations.includes("ev-api-network-1"));
  assert.ok(verdict.evidenceCitations.includes("ev-api-network-2"));
  assert.ok(verdict.evidenceCitations.includes("ev-state-storage-1"));
  // Screens the top score leaned on are cited too.
  assert.ok(verdict.evidenceCitations.includes("ev-dashboard-dom-text"));
  // The rationale names the features that drove the label.
  assert.ok(verdict.rationale.includes("formSignals="), verdict.rationale);
  assert.ok(verdict.rationale.includes("apiSignals=2"), verdict.rationale);
  assert.ok(verdict.rationale.includes("stateSignals=3"), verdict.rationale);
});

test("classification is deterministic", () => {
  const ir = b01LikeIr();
  const richIr = b02LikeIr();
  const exploration = explorationOf(ir);
  const richExploration = explorationOf(richIr);

  const first = classifyFromIr({
    ir: structuredClone(ir),
    exploration: structuredClone(exploration),
  });
  const second = classifyFromIr({
    ir: shuffleKeyOrder(structuredClone(ir)) as BehavioralIr,
    exploration: shuffleKeyOrder(structuredClone(exploration)) as ExplorationResult,
  });
  const third = classifyFromIr({
    ir: structuredClone(ir),
    exploration: structuredClone(exploration),
  });

  assert.deepEqual(second, first, "key-order-shuffled inputs produce the identical verdict");
  assert.deepEqual(third, first, "deep-copied inputs produce the identical verdict");
  assert.equal(
    canonicalJson(second),
    canonicalJson(first),
    "canonical serializations of the verdicts must be byte-identical",
  );

  const featuresFirst = extractArchetypeFeatures({
    ir: structuredClone(ir),
    exploration: structuredClone(exploration),
  });
  const featuresSecond = extractArchetypeFeatures({
    ir: shuffleKeyOrder(structuredClone(ir)) as BehavioralIr,
    exploration: shuffleKeyOrder(structuredClone(exploration)) as ExplorationResult,
  });
  assert.deepEqual(featuresSecond, featuresFirst);

  // ALL 11 scores present, over the closed vocabulary, sorted by score then label.
  assert.equal(first.scores.length, 11);
  const expectedLabels = ARCHETYPES.map((entry) => entry.label).sort();
  assert.deepEqual(
    first.scores.map((row) => row.label).sort(),
    expectedLabels,
    "every archetype is scored exactly once",
  );
  for (let index = 1; index < first.scores.length; index += 1) {
    const previous = first.scores[index - 1];
    const current = first.scores[index];
    assert.ok(
      previous.score > current.score ||
        (previous.score === current.score && previous.label < current.label),
      `scores must sort by score descending then label ascending (${previous.label} before ${current.label})`,
    );
  }

  // The rich fixture is deterministic too (multi-run, key-order shuffled).
  const richFirst = classifyFromIr({
    ir: structuredClone(richIr),
    exploration: structuredClone(richExploration),
  });
  const richSecond = classifyFromIr({
    ir: shuffleKeyOrder(structuredClone(richIr)) as BehavioralIr,
    exploration: shuffleKeyOrder(structuredClone(richExploration)) as ExplorationResult,
  });
  assert.deepEqual(richSecond, richFirst);
  assert.equal(canonicalJson(richSecond), canonicalJson(richFirst));
  assert.equal(richFirst.label, "CRUD SaaS");
});

test("sparse evidence caps confidence honestly", () => {
  const ir = sparseIr(); // empty api/state/data with explicit assumptions
  const verdict = classifyFromIr({ ir });
  const features = extractArchetypeFeatures({ ir });

  // The honestly-empty dimensions are inventoried with their citations.
  assert.ok(features.sparseDimensions.some((entry) => entry.startsWith("api (empty")));
  assert.ok(features.sparseDimensions.some((entry) => entry.startsWith("state (empty")));
  assert.ok(features.sparseDimensions.some((entry) => entry.startsWith("data (empty")));

  assert.ok(
    verdict.confidence < 0.6,
    `confidence ${verdict.confidence} must be below 0.6 for empty api/state/data`,
  );
  // The rationale names the sparse dimensions that lowered confidence.
  assert.ok(verdict.rationale.includes("capped"), verdict.rationale);
  assert.ok(verdict.rationale.includes("api, data, state"), verdict.rationale);
});

test("unknown is honest", () => {
  const ir = minimalIr(); // one screen (unknown textChars), one journey, no signals
  const verdict = classifyFromIr({ ir });

  assert.equal(verdict.label, "unknown");
  assert.ok(verdict.confidence < 0.4, "an unknown label carries a below-threshold confidence");
  assert.ok(verdict.rationale.includes("insufficient"), verdict.rationale);
  assert.ok(verdict.rationale.includes("screens=1"), verdict.rationale);
  assert.equal(verdict.scores.length, 11);
});

test("feature extraction is pure and cited", () => {
  const ir = b02LikeIr();
  const exploration = explorationOf(ir);
  const irSnapshot = structuredClone(ir);
  const explorationSnapshot = structuredClone(exploration);

  const features = extractArchetypeFeatures({ ir, exploration });

  // Pure: the inputs are never mutated.
  assert.deepEqual(ir, irSnapshot);
  assert.deepEqual(exploration, explorationSnapshot);

  // Cited: the counts match the input IR's actual contents.
  assert.equal(features.screenCount, ir.screens.length);
  assert.equal(features.journeyCount, exploration.stats.journeys);
  assert.equal(features.stepCount, exploration.stats.steps);
  const expectedKinds = new Map<string, number>();
  for (const ref of ir.evidence) {
    expectedKinds.set(ref.kind, (expectedKinds.get(ref.kind) ?? 0) + 1);
  }
  assert.deepEqual(
    features.evidenceKinds,
    [...expectedKinds.entries()]
      .map(([kind, count]) => ({ kind, count }))
      .sort((left, right) => (left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0)),
  );
  // formSignals: 3 fill steps + 2 submit steps + 2 POST-shaped step assertions + 1 POST-shaped api hint.
  assert.equal(features.formSignals, 8);
  assert.equal(features.apiSignals, 2); // api + data records non-empty
  assert.equal(features.stateSignals, 3); // non-empty state record + 2 stateful form journeys
  assert.equal(features.textHeavy, 540); // (600 + 540 + 480) / 3
  assert.equal(features.entrypointCount, 1);
  // Only components/integrations are sparse here (api/state/data are populated).
  assert.deepEqual(dimensionsOf(features), ["components", "integrations"]);

  // The B01-like inventory carries the honest-empty critical dimensions.
  const b01Features = extractArchetypeFeatures({ ir: b01LikeIr() });
  assert.deepEqual(dimensionsOf(b01Features), [
    "api",
    "components",
    "data",
    "integrations",
    "state",
  ]);
});

test("engine classify() composes", () => {
  const engine = createIntelligenceEngine();
  const ir = b02LikeIr();
  const exploration = explorationOf(ir);
  const fromEngine = engine.classify({ ir, exploration });
  const direct = classifyFromIr({
    ir: structuredClone(ir),
    exploration: structuredClone(exploration),
  });

  assert.deepEqual(fromEngine, direct);
  assert.equal(canonicalJson(fromEngine), canonicalJson(direct));
  assert.equal(fromEngine.label, "CRUD SaaS");

  // model() and explore() stay as landed: the engine still composes the same extraction/exploration.
  const explored = engine.explore({
    ir: structuredClone(ir),
    seed: 7,
    budget: { ...FULL_BUDGET },
  });
  assert.deepEqual(explored, exploration);
});

test("vocabulary is closed and documented", () => {
  // ARCHETYPES has exactly the 11 Phase 7 labels, each with a non-empty description.
  assert.equal(ARCHETYPES.length, 11);
  const labels: string[] = ARCHETYPES.map((entry) => entry.label);
  assert.deepEqual(
    [...labels],
    [
      "marketing/content site",
      "CRUD SaaS",
      "dashboard/admin",
      "realtime collaboration",
      "editor",
      "file/document app",
      "PWA/offline",
      "API-heavy app",
      "auth/roles",
      "marketplace/catalog",
      "workflow/operations system",
    ],
  );
  assert.equal(new Set(labels).size, 11);
  for (const entry of ARCHETYPES) {
    assert.equal(typeof entry.description, "string");
    assert.ok(entry.description.length > 0, `archetype ${entry.label} needs a description`);
  }

  // The classifier never emits a label outside the set union {"unknown"}.
  const closed = new Set<string>([...labels, "unknown"]);
  const verdicts = [
    classifyFromIr({ ir: b01LikeIr(), exploration: explorationOf(b01LikeIr()) }),
    classifyFromIr({ ir: b02LikeIr(), exploration: explorationOf(b02LikeIr()) }),
    classifyFromIr({ ir: sparseIr() }),
    classifyFromIr({ ir: minimalIr() }),
    classifyArchetype({
      screenCount: 0,
      journeyCount: 0,
      stepCount: 0,
      avgStepsPerJourney: 0,
      linkDensity: 0,
      formSignals: 0,
      apiSignals: 0,
      stateSignals: 0,
      textHeavy: 0,
      entrypointCount: 0,
      evidenceKinds: [],
      sparseDimensions: [],
    }),
    classifyArchetype({
      screenCount: 50,
      journeyCount: 40,
      stepCount: 400,
      avgStepsPerJourney: 10,
      linkDensity: 12,
      formSignals: 30,
      apiSignals: 2,
      stateSignals: 9,
      textHeavy: 3000,
      entrypointCount: 8,
      evidenceKinds: [{ kind: "network", count: 9 }],
      sparseDimensions: [],
    }),
  ];
  for (const verdict of verdicts) {
    assert.ok(closed.has(verdict.label), `label "${verdict.label}" must be in the closed set`);
    assert.equal(verdict.scores.length, 11);
    for (const row of verdict.scores) {
      assert.ok(labels.includes(row.label), `score label "${row.label}" must be in the vocabulary`);
    }
  }
});
