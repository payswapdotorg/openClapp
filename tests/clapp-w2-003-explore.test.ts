import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type {
  BehavioralIr,
  EvidenceRef,
  Journey,
  JourneyStep,
} from "../packages/clapp-contracts/src/index.ts";
import {
  composeExploredIr,
  createIntelligenceEngine,
  diffBehavioralIr,
  explore,
  journeyDiffCoverage,
  serializeBehavioralIr,
  validateBehavioralIr,
} from "../packages/clapp-intelligence/src/index.ts";

/**
 * CLAPP-W2-003 — deterministic exploration and journey model.
 *
 * IRs are constructed as typed literals mirroring the LANDED W2-002 extraction
 * output shape: screens carrying entrypoint/url/title/textDigest/textChars/
 * truncated/evidenceIds (plus the per-screen `links` anchor-target inventory
 * exploration reads — the convention a content-bearing extraction would emit),
 * one baseline "visit" journey per entrypoint citing the entrypoint's observed
 * page evidence, and the four registry-unavailable channel kinds in the
 * evidence with their source notes copied as literals (no imports from the
 * observation package). Fixtures mirror the benchmark shapes: a static-like IR
 * with 4 interlinked screens (B01) and a stateful-like IR with 3 screens plus
 * api assumptions (B02).
 */

const TARGET = "target-w2-003";
const RECON = "recon-w2-003";
const FIXED_ISO = "2025-01-01T00:00:00.000Z";

const SOURCE_NOTES = {
  domText: "browser-worker read() innerText snapshot",
  pageMeta: "browser-worker read() url+title",
  domStructure:
    "browser-worker lacks a DOM structure snapshot endpoint; read() returns innerText only",
  a11y: "browser-worker lacks an a11y snapshot endpoint",
  screenshot: "browser-worker screenshot() png",
  network:
    "browser-worker lacks a network capture endpoint; egress flows through its proxy without an observation surface",
  storage:
    "browser-worker lacks a storage state export endpoint; storageState is persisted internally per session",
} as const;

const UNAVAILABLE_KINDS = ["dom-structure", "a11y", "network", "storage"] as const;

const NOTE_BY_KIND: Record<(typeof UNAVAILABLE_KINDS)[number], string> = {
  "dom-structure": SOURCE_NOTES.domStructure,
  a11y: SOURCE_NOTES.a11y,
  network: SOURCE_NOTES.network,
  storage: SOURCE_NOTES.storage,
};

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

/** Deep-equal helper for results whose journey order may legitimately differ. */
const withJourneysSorted = (result: ReturnType<typeof explore>) => ({
  ...result,
  journeys: [...result.journeys].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  ),
});

interface ScreenSpec {
  key: string;
  url: string;
  title: string;
  text: string;
  links?: string[];
}

/**
 * Builds a W2-002-shaped IR: observed dom-text/page-meta refs per screen (the
 * first screen is the entrypoint screen its baseline visit cites), the four
 * unavailable channel refs, and one baseline "visit" journey per entrypoint.
 */
function buildFixture(input: {
  name: string;
  entrypoint: string;
  screens: ScreenSpec[];
  assumptions?: Record<string, unknown>[];
}): BehavioralIr {
  const evidence: EvidenceRef[] = [];
  const screens: Record<string, unknown>[] = [];
  for (const spec of input.screens) {
    const textDigest = sha256Hex(spec.text);
    const metaDigest = sha256Hex(canonicalJson({ url: spec.url, title: spec.title }));
    const textId = `ev-${spec.key}-dom-text`;
    const metaId = `ev-${spec.key}-page-meta`;
    const observed = (kind: "dom-text" | "page-meta", id: string, sha256: string): EvidenceRef => ({
      id,
      targetId: TARGET,
      reconstructionId: RECON,
      kind,
      sha256,
      source: kind === "dom-text" ? SOURCE_NOTES.domText : SOURCE_NOTES.pageMeta,
      capturedAt: FIXED_ISO,
      classification: "observed",
      redacted: false,
    });
    evidence.push(observed("dom-text", textId, textDigest));
    evidence.push(observed("page-meta", metaId, metaDigest));
    screens.push({
      screenId: `screen-${sha256Hex(
        canonicalJson({ entrypoint: input.entrypoint, domText: textDigest, pageMeta: metaDigest }),
      )}`,
      entrypoint: input.entrypoint,
      url: spec.url,
      title: spec.title,
      textDigest,
      textChars: null,
      truncated: false,
      evidenceIds: [textId, metaId],
      ...(spec.links === undefined ? {} : { links: [...spec.links] }),
    });
  }
  for (const kind of UNAVAILABLE_KINDS) {
    evidence.push({
      id: `ev-unavailable-${kind}`,
      targetId: TARGET,
      reconstructionId: RECON,
      kind,
      sha256: sha256Hex(canonicalJson({ reason: NOTE_BY_KIND[kind] })),
      source: NOTE_BY_KIND[kind],
      capturedAt: FIXED_ISO,
      classification: "unavailable",
      redacted: false,
    });
  }
  const landing = screens[0] as { evidenceIds: string[] };
  const journey: Journey = {
    id: `visit:${input.entrypoint}`,
    name: `visit ${input.entrypoint}`,
    preconditions: [],
    steps: [
      {
        id: `visit:${input.entrypoint}:step-1`,
        action: "visit",
        target: input.entrypoint,
        assertions: { evidenceIds: [...landing.evidenceIds] },
      },
    ],
  };
  return {
    schemaVersion: "0.1",
    application: {
      id: `app-${sha256Hex(TARGET)}`,
      name: input.name,
      platform: "web",
      entrypoints: [input.entrypoint],
    },
    evidence,
    journeys: [journey],
    screens,
    components: [],
    state: {},
    data: {},
    api: {},
    integrations: [],
    assumptions: input.assumptions ?? [],
    constraints: [],
  };
}

/** The static-site-like IR: four interlinked screens (B01-like), an unobserved gallery link. */
function staticIr(): BehavioralIr {
  return buildFixture({
    name: "Aurora Studio marketing site",
    entrypoint: A.home,
    screens: [
      {
        key: "home",
        url: A.home,
        title: "Aurora Studio — Welcome",
        text: "Home\n\nDigital craft with a human touch.",
        links: [A.home, A.about, A.services, A.contact, A.gallery],
      },
      {
        key: "about",
        url: A.about,
        title: "Aurora Studio — The Workshop",
        text: "About\n\nWe are Aurora Studio.",
        links: [A.home, A.about, A.services, A.contact],
      },
      {
        key: "services",
        url: A.services,
        title: "Aurora Studio — What We Do",
        text: "Services\n\nWhat we do, priced plainly.",
        links: [A.home, A.about, A.services, A.contact],
      },
      {
        key: "contact",
        url: A.contact,
        title: "Aurora Studio — Say Hello",
        text: "Contact\n\nGet in touch.",
        links: [A.home, A.about, A.services, A.contact],
      },
    ],
  });
}

/** The stateful-like IR: three screens plus api assumptions (B02-like). */
function statefulIr(options: { dashboardText?: string; homeLinks?: string[] } = {}): BehavioralIr {
  return buildFixture({
    name: "Field Notes operations board",
    entrypoint: B.home,
    assumptions: [
      {
        source: "extraction",
        path: "api",
        reason: `api left empty: API extraction requires network evidence; the "network" channel is unavailable in this bundle ("${SOURCE_NOTES.network}")`,
        evidenceIds: ["ev-unavailable-network"],
      },
      {
        source: "extraction",
        path: "state",
        reason: `state left empty: state extraction requires storage evidence; the "storage" channel is unavailable in this bundle ("${SOURCE_NOTES.storage}")`,
        evidenceIds: ["ev-unavailable-storage"],
      },
    ],
    screens: [
      {
        key: "dashboard",
        url: B.home,
        title: "Field Notes — Overview",
        text: options.dashboardText ?? "Dashboard\n\nSystem status: operational\n\nOpen tasks: 3",
        links: options.homeLinks ?? [B.home, B.tasks, B.settings],
      },
      {
        key: "tasks",
        url: B.tasks,
        title: "Field Notes — Worklist",
        text: "Tasks\n\nTask backlog\n\nRecord a new task",
        links: [B.home, B.tasks, B.settings],
      },
      {
        key: "settings",
        url: B.settings,
        title: "Field Notes — Preferences",
        text: "Settings\n\nBoard settings\n\nAdjust the board",
        links: [B.home, B.tasks, B.settings],
      },
    ],
  });
}

/** The tie fixture: two same-entrypoint baselines landing on one screen (equal sort keys). */
function tieIr(): BehavioralIr {
  const ir = buildFixture({
    name: "Tie fixture",
    entrypoint: "https://tie.example/",
    screens: [
      {
        key: "root",
        url: "https://tie.example/",
        title: "Tie — Root",
        text: "Root\n\nTwo journeys land here.",
        links: ["https://tie.example/next"],
      },
      {
        key: "next",
        url: "https://tie.example/next",
        title: "Tie — Next",
        text: "Next\n\nA single onward link back.",
        links: ["https://tie.example/"],
      },
    ],
  });
  const second: Journey = structuredClone(ir.journeys[0]);
  second.id = "visit-2:https://tie.example/";
  second.name = "visit again https://tie.example/";
  (second.steps[0] as JourneyStep).id = "visit-2:https://tie.example/:step-1";
  return { ...ir, journeys: [...ir.journeys, second] };
}

test("exploration is deterministic", () => {
  const ir = staticIr();
  const first = explore({ ir: structuredClone(ir), seed: 7, budget: { ...FULL_BUDGET } });
  const second = explore({
    ir: shuffleKeyOrder(structuredClone(ir)) as BehavioralIr,
    seed: 7,
    budget: { ...FULL_BUDGET },
  });
  assert.deepEqual(second, first);
  assert.equal(
    serializeBehavioralIr(composeExploredIr(ir, second)),
    serializeBehavioralIr(composeExploredIr(ir, first)),
    "canonical serializations of the composed IRs must be byte-identical",
  );
  assert.equal(canonicalJson(second), canonicalJson(first));

  // Different seeds: no equal sort keys exist for one-baseline-per-entrypoint
  // IRs, so the seed is inert — results are fully identical.
  for (const seed of [0, 1, 2, 8, 999]) {
    const other = explore({ ir: structuredClone(ir), seed, budget: { ...FULL_BUDGET } });
    assert.deepEqual(withJourneysSorted(other), withJourneysSorted(first));
    assert.deepEqual(other.assumptions, first.assumptions);
    assert.deepEqual(other.deferred, first.deferred);
    assert.deepEqual(other.stats, first.stats);
    assert.equal(other.featureDigest, first.featureDigest);
  }

  // Tie fixture (two same-entrypoint baselines): different seeds may reorder
  // EQUAL-keyed journeys only — never step/assertion content.
  const tieA = explore({ ir: structuredClone(tieIr()), seed: 1, budget: { ...FULL_BUDGET } });
  const tieB = explore({ ir: structuredClone(tieIr()), seed: 2, budget: { ...FULL_BUDGET } });
  assert.deepEqual(withJourneysSorted(tieB), withJourneysSorted(tieA));
  assert.deepEqual(tieB.assumptions, tieA.assumptions);
  assert.deepEqual(tieB.deferred, tieA.deferred);
  assert.deepEqual(tieB.stats, tieA.stats);
  assert.equal(tieB.featureDigest, tieA.featureDigest);

  // The engine wires the same function.
  const engine = createIntelligenceEngine();
  assert.deepEqual(
    engine.explore({ ir: structuredClone(ir), seed: 7, budget: { ...FULL_BUDGET } }),
    first,
  );
});

test("journeys follow only observed links", () => {
  const ir = staticIr();
  const result = explore({ ir, seed: 7, budget: { ...FULL_BUDGET } });
  const observedUrls = new Set(
    ir.screens.map((screen) => screen.url as string).filter((url) => url !== null),
  );
  const deepened = result.journeys.filter((journey) =>
    journey.steps.some((step) => step.action === "follow-link"),
  );
  assert.ok(deepened.length >= 1, "expected deepened multi-step journeys");
  assert.ok(deepened.every((journey) => journey.steps.length >= 2));
  for (const journey of result.journeys) {
    for (const step of journey.steps) {
      assert.ok(
        step.target === undefined || observedUrls.has(step.target),
        `step target "${step.target}" must be an observed screen URL`,
      );
      assert.notEqual(step.target, A.gallery, "the unobserved gallery URL is never a step target");
    }
  }
  const aboutVariant = deepened.find((journey) => journey.steps[1]?.target === A.about);
  assert.ok(aboutVariant !== undefined, "expected a journey whose first link target is /about");
  assert.ok(aboutVariant.steps.length >= 3, "the chain continues past the first hop");
  assert.equal(aboutVariant.steps[0].action, "visit");

  // The unobserved gallery link: assumption + deferred entry, never a step.
  const galleryAssumption = result.assumptions.find(
    (entry) => entry.targetUrl === A.gallery && entry.source === "exploration",
  );
  assert.ok(galleryAssumption !== undefined, "the unobserved target must be an assumption");
  assert.ok(String(galleryAssumption.reason).includes(A.gallery));
  const galleryDeferred = result.deferred.find((entry) => entry.targetUrl === A.gallery);
  assert.ok(galleryDeferred !== undefined, "the unobserved target must be deferred");
  assert.equal(galleryDeferred.fromUrl, A.home);
});

test("assertions cite evidence and prove only text/url/title", () => {
  for (const ir of [staticIr(), statefulIr()]) {
    const result = explore({ ir, seed: 3, budget: { ...FULL_BUDGET } });
    const evidenceIds = new Set(ir.evidence.map((ref) => ref.id));
    const allowedKeys = new Set(["textContains", "urlEquals", "titleEquals", "evidenceIds"]);
    for (const journey of result.journeys) {
      for (const step of journey.steps) {
        const assertions = step.assertions;
        assert.ok(assertions !== undefined, "every step must carry assertions");
        for (const key of Object.keys(assertions)) {
          assert.ok(
            allowedKeys.has(key),
            `assertion key "${key}" must stay within the provable DSL (text/url/title + citations)`,
          );
        }
        const cited = assertions.evidenceIds;
        assert.ok(Array.isArray(cited) && cited.length > 0, "every step must cite evidence");
        for (const id of cited as unknown[]) {
          assert.ok(
            typeof id === "string" && evidenceIds.has(id),
            `cited evidence "${String(id)}" must be present in the IR's evidence`,
          );
        }
        if (typeof assertions.urlEquals === "string") {
          assert.equal(
            assertions.urlEquals,
            step.target,
            "urlEquals must assert exactly the step's target",
          );
        }
      }
    }
    // Unavailable channels produce assumptions carrying the channel's source note.
    for (const kind of UNAVAILABLE_KINDS) {
      const refs = ir.evidence.filter(
        (ref) => ref.kind === kind && ref.classification === "unavailable",
      );
      assert.ok(refs.length >= 1, `expected an unavailable "${kind}" ref in the fixture`);
      const assumption = result.assumptions.find(
        (entry) => entry.kind === kind && entry.source === "exploration",
      );
      assert.ok(
        assumption !== undefined,
        `expected an exploration assumption for the unavailable "${kind}" channel`,
      );
      assert.ok(
        String(assumption.reason).includes(refs[0].source),
        "the assumption must carry the channel's source note verbatim",
      );
      for (const id of assumption.evidenceIds ?? []) {
        assert.ok(evidenceIds.has(id as string));
      }
    }
  }
});

test("budget truncation is honest", () => {
  const ir = staticIr();
  const result = explore({ ir, seed: 7, budget: { maxJourneys: 2, maxStepsPerJourney: 16 } });
  assert.equal(result.journeys.length, 2, "exactly maxJourneys journeys survive");
  assert.equal(result.stats.journeys, 2);
  const firstTargets = result.journeys.map((journey) => journey.steps[1]?.target);
  assert.deepEqual(firstTargets, [A.about, A.contact], "sorted candidates are selected in order");

  const truncation = result.assumptions.find(
    (entry) => entry.source === "exploration" && String(entry.reason).includes("maxJourneys"),
  );
  assert.ok(truncation !== undefined, "the truncation must be recorded as an assumption");
  assert.ok(String(truncation.reason).includes("maxJourneys=2"));
  assert.ok(String(truncation.reason).includes(A.services), "the dropped first target is named");

  const deferredCandidate = result.deferred.find(
    (entry) => entry.fromUrl === A.home && entry.targetUrl === A.services,
  );
  assert.ok(
    deferredCandidate !== undefined,
    "the unexplored candidate's first link edge must be listed in the deferred inventory",
  );
  assert.ok(result.stats.linksDeferred === result.deferred.length);
});

test("composed IR validates and stays diffable", () => {
  const ir = statefulIr();
  const result = explore({ ir, seed: 5, budget: { ...FULL_BUDGET } });
  const composed = composeExploredIr(ir, result);
  assert.deepEqual(validateBehavioralIr(composed), { ok: true, errors: [] });

  const findings = diffBehavioralIr(ir, composed);
  const addedJourneys = findings.filter(
    (finding) => finding.path.startsWith("journeys[") && finding.kind === "added",
  );
  const removedJourneys = findings.filter(
    (finding) => finding.path.startsWith("journeys[") && finding.kind === "removed",
  );
  const addedAssumptions = findings.filter(
    (finding) => finding.path.startsWith("assumptions[") && finding.kind === "added",
  );
  assert.ok(addedJourneys.length >= 2, "the deepened journeys appear as added");
  assert.equal(removedJourneys.length, 1, "the replaced baseline journey appears as removed");
  assert.ok(removedJourneys[0].path.includes(`journeys[visit:${B.home}]`));
  assert.ok(addedAssumptions.length >= 1, "the exploration assumptions appear as added");

  assert.ok(
    findings.every((finding) => !finding.path.startsWith("evidence")),
    "ZERO changes to evidence refs",
  );
  assert.ok(
    findings.every((finding) => !finding.path.startsWith("screens")),
    "screens are carried unchanged",
  );
  assert.deepEqual(composeExploredIr(ir, result), composed, "composition is repeatable");
});

test("purity — inputs never mutated", () => {
  for (const ir of [staticIr(), statefulIr()]) {
    const irSnapshot = structuredClone(ir);
    const budget = { ...FULL_BUDGET };
    const budgetSnapshot = { ...budget };
    const result = explore({ ir, seed: 11, budget });
    composeExploredIr(ir, result);
    assert.deepEqual(ir, irSnapshot, "the input IR must never be mutated");
    assert.deepEqual(budget, budgetSnapshot, "the budget must never be mutated");
  }
});

test("journey diff coverage is complete", () => {
  for (const ir of [staticIr(), statefulIr()]) {
    const result = explore({ ir, seed: 7, budget: { ...FULL_BUDGET } });
    const composed = composeExploredIr(ir, result);
    const coverage = journeyDiffCoverage(composed);
    assert.equal(coverage.length, composed.journeys.length);
    assert.ok(coverage.length >= 1);
    for (const row of coverage) {
      assert.equal(
        row.uncitedSteps,
        0,
        `journey ${row.journeyId} must cite at least one evidence id on every step`,
      );
      assert.ok(row.citedEvidence >= 1);
      assert.ok(row.steps >= 1);
    }
    const totalSteps = composed.journeys.reduce(
      (total, journey) => total + journey.steps.length,
      0,
    );
    assert.equal(
      coverage.reduce((total, row) => total + row.steps, 0),
      totalSteps,
    );
    assert.equal(result.stats.journeys, result.journeys.length);
    assert.equal(
      result.stats.steps,
      result.journeys.reduce((total, journey) => total + journey.steps.length, 0),
    );
    assert.equal(
      result.stats.linksFollowed,
      result.journeys.reduce(
        (total, journey) =>
          total + journey.steps.filter((step) => step.action === "follow-link").length,
        0,
      ),
    );
    assert.equal(result.stats.linksDeferred, result.deferred.length);
  }
});

test("feature digest is stable and sensitive", () => {
  const ir = statefulIr();
  const first = explore({ ir: structuredClone(ir), seed: 7, budget: { ...FULL_BUDGET } });
  const second = explore({ ir: structuredClone(ir), seed: 7, budget: { ...FULL_BUDGET } });
  assert.equal(first.featureDigest, second.featureDigest);
  assert.match(first.featureDigest, /^[0-9a-f]{64}$/);

  // A different seed never changes the content-defined digest.
  const otherSeed = explore({ ir: structuredClone(ir), seed: 42, budget: { ...FULL_BUDGET } });
  assert.equal(otherSeed.featureDigest, first.featureDigest);

  // A content variant (different page text -> different textDigest) changes it.
  const textVariant = statefulIr({
    dashboardText: "Dashboard\n\nSystem status: degraded\n\nSomething entirely different.",
  });
  const textVariantResult = explore({
    ir: textVariant,
    seed: 7,
    budget: { ...FULL_BUDGET },
  });
  assert.notEqual(textVariantResult.featureDigest, first.featureDigest);

  // A link variant (one nav target removed) changes the journey model and it.
  const linkVariant = statefulIr({ homeLinks: [B.home, B.tasks] });
  const linkVariantResult = explore({ ir: linkVariant, seed: 7, budget: { ...FULL_BUDGET } });
  assert.notEqual(linkVariantResult.featureDigest, first.featureDigest);
});
