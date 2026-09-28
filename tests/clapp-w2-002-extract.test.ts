import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type {
  BehavioralIr,
  EvidenceBundle,
  EvidenceRef,
  Journey,
  ReconstructionSpec,
} from "../packages/clapp-contracts/src/index.ts";
import {
  createIntelligenceEngine,
  evidenceCoverage,
  extractBehavioralIr,
  serializeBehavioralIr,
  validateBehavioralIr,
} from "../packages/clapp-intelligence/src/index.ts";

/**
 * CLAPP-W2-002 — evidence-to-IR extraction.
 *
 * Bundles are constructed as typed literals mirroring the LANDED W1-002
 * observation output shape: content-addressed ref ids over
 * {entrypoint, kind, reconstructionId, targetId}, registry source notes,
 * unavailable marker payloads (reason in the payload, registry note as the
 * ref source), refs sorted by id, and the environment fingerprint with
 * per-entrypoint ref attribution (entrypointRefs). Channel kind strings and
 * source notes are copied as literals — no imports from the observation
 * package.
 *
 * Per entrypoint the real adapter emits seven kinds: dom-text, page-meta and
 * screenshot classified observed, and dom-structure, a11y, network, storage
 * classified unavailable (four unavailable kinds — the substrate fact; the
 * work item's "three unavailable" understates the landed registry).
 */
const TARGET = "target-example";
const RECON = "recon-w2-002";
const OWNER = "local-user";
const FIXED_ISO = "2025-01-01T00:00:00.000Z";
const EP1 = "https://app.example/";
const EP2 = "https://app.example/about";
const TEXT_LIMIT = 100_000;

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

const NOTE_BY_KIND: Record<string, string> = {
  "dom-text": SOURCE_NOTES.domText,
  "page-meta": SOURCE_NOTES.pageMeta,
  "dom-structure": SOURCE_NOTES.domStructure,
  a11y: SOURCE_NOTES.a11y,
  screenshot: SOURCE_NOTES.screenshot,
  network: SOURCE_NOTES.network,
  storage: SOURCE_NOTES.storage,
};

const UNAVAILABLE_KINDS = ["dom-structure", "a11y", "network", "storage"] as const;
const OBSERVED_KINDS = ["dom-text", "page-meta", "screenshot"] as const;
const SESSION_FAILURE =
  "the browser seam could not establish the browser session: scripted test failure";

const PAGE_TEXT: Record<string, string> = {
  [EP1]: "Home\n\nWelcome to the example application.",
  [EP2]: "About\n\nThis page describes the example application.",
};
const PAGE_TITLE: Record<string, string> = {
  [EP1]: "Example App",
  [EP2]: "About — Example App",
};
const SCREENSHOT_BYTES: Record<string, Uint8Array> = {
  [EP1]: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]),
  [EP2]: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x02]),
};

const sha256Hex = (input: Uint8Array | string) => createHash("sha256").update(input).digest("hex");
const utf8 = (text: string) => new TextEncoder().encode(text);
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

/** Content-addressed ref id, mirroring the W1-002 adapter's scheme. */
const refId = (entrypoint: string, kind: string) =>
  sha256Hex(utf8(canonicalJson({ entrypoint, kind, reconstructionId: RECON, targetId: TARGET })));

function ref(
  entrypoint: string,
  kind: string,
  payload: Uint8Array,
  classification: EvidenceRef["classification"],
  source: string,
): EvidenceRef {
  return {
    id: refId(entrypoint, kind),
    targetId: TARGET,
    reconstructionId: RECON,
    kind,
    sha256: sha256Hex(payload),
    source,
    capturedAt: FIXED_ISO,
    classification,
    redacted: false,
  };
}

/** The three normally-observed kinds, captured successfully. */
function observedRefs(entrypoint: string, text: string, truncated: boolean): EvidenceRef[] {
  const domTextSource = truncated
    ? `${SOURCE_NOTES.domText} (truncated at ${TEXT_LIMIT} characters)`
    : SOURCE_NOTES.domText;
  return [
    ref(entrypoint, "dom-text", utf8(text), "observed", domTextSource),
    ref(
      entrypoint,
      "page-meta",
      utf8(canonicalJson({ url: entrypoint, title: PAGE_TITLE[entrypoint] })),
      "observed",
      SOURCE_NOTES.pageMeta,
    ),
    ref(
      entrypoint,
      "screenshot",
      SCREENSHOT_BYTES[entrypoint],
      "observed",
      SOURCE_NOTES.screenshot,
    ),
  ];
}

/** The four registry-unavailable kinds: marker payloads, registry note as source. */
function unavailableRegistryRefs(entrypoint: string): EvidenceRef[] {
  return UNAVAILABLE_KINDS.map((kind) =>
    ref(
      entrypoint,
      kind,
      utf8(canonicalJson({ entrypoint, kind, reason: NOTE_BY_KIND[kind] })),
      "unavailable",
      NOTE_BY_KIND[kind],
    ),
  );
}

/** Session-failure style: the normally-observed kinds degrade to unavailable marker refs. */
function unavailablePageRefs(entrypoint: string): EvidenceRef[] {
  return OBSERVED_KINDS.map((kind) =>
    ref(
      entrypoint,
      kind,
      utf8(canonicalJson({ entrypoint, kind, reason: SESSION_FAILURE })),
      "unavailable",
      NOTE_BY_KIND[kind],
    ),
  );
}

interface CaptureScript {
  [EP1]: "observed" | "unavailable";
  [EP2]: "observed" | "unavailable";
  ep2Truncated?: boolean;
}

/** A realistic W1-002-shaped bundle for the two entrypoints. */
function buildBundle(script: CaptureScript, options: { ep2Text?: string } = {}): EvidenceBundle {
  const entrypointRefs: Record<string, string[]> = {};
  const captured: EvidenceRef[] = [];
  for (const entrypoint of [EP1, EP2] as const) {
    const refs =
      script[entrypoint] === "observed"
        ? [
            ...observedRefs(
              entrypoint,
              entrypoint === EP2 && options.ep2Text !== undefined
                ? options.ep2Text
                : PAGE_TEXT[entrypoint],
              entrypoint === EP2 && script.ep2Truncated === true,
            ),
            ...unavailableRegistryRefs(entrypoint),
          ]
        : [...unavailablePageRefs(entrypoint), ...unavailableRegistryRefs(entrypoint)];
    entrypointRefs[entrypoint] = refs.map((item) => item.id);
    captured.push(...refs);
  }
  const refs = captured.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const rootSha256 = sha256Hex(utf8(canonicalJson(refs)));
  return {
    id: `clapp-observation:${rootSha256}`,
    targetId: TARGET,
    reconstructionId: RECON,
    environment: {
      adapter: "@clapp/observation",
      adapterVersion: "0.1.0",
      channels: ["dom", "a11y", "screenshot", "network", "storage"],
      evidenceKinds: [
        "dom-text",
        "page-meta",
        "dom-structure",
        "a11y",
        "screenshot",
        "network",
        "storage",
      ],
      channelAvailability: {
        "dom-text": true,
        "page-meta": true,
        "dom-structure": false,
        a11y: false,
        screenshot: true,
        network: false,
        storage: false,
      },
      specVersion: "0.1",
      platform: "web",
      entrypoints: [EP1, EP2],
      entrypointRefs,
      sessionIds: ["sess-1"],
      startedAt: FIXED_ISO,
      finishedAt: FIXED_ISO,
      entrypointCount: 2,
      aborted: false,
      persisted: false,
      evidenceStorage: "adapter-memory-vault",
    },
    refs,
    rootSha256,
  };
}

function buildSpec(): ReconstructionSpec {
  return {
    specVersion: "0.1",
    reconstructionId: RECON,
    targetId: TARGET,
    name: "Example App",
    platform: "web",
    entrypoints: [EP1, EP2],
    authorization: {
      ownerId: OWNER,
      targetId: TARGET,
      scope: ["observe"],
      environments: ["web"],
      retention: "ephemeral",
      benchmarkOwned: false,
      createdAt: FIXED_ISO,
    },
    exploration: { maxStages: 4, maxActions: 40, maxDurationMs: 600_000, seed: 7 },
    synthesis: { targetStack: "web", allowNetwork: false, packagePolicy: "verified-only" },
    verification: {
      journeys: ["home"],
      visual: true,
      network: false,
      state: false,
      maxRepairIterations: 2,
    },
  };
}

const observedScript: CaptureScript = { [EP1]: "observed", [EP2]: "observed" };

function screenFor(ir: BehavioralIr, entrypoint: string): Record<string, unknown> {
  const screen = ir.screens.find((candidate) => candidate.entrypoint === entrypoint);
  assert.ok(screen !== undefined, `expected a screen for ${entrypoint}`);
  return screen;
}

/** Every evidence id cited by a journey step's assertion record. */
function citedEvidenceIds(journey: Journey): string[] {
  return journey.steps.flatMap((step) => {
    const assertions = step.assertions as { evidenceIds?: unknown } | undefined;
    return Array.isArray(assertions?.evidenceIds) ? (assertions.evidenceIds as string[]) : [];
  });
}

test("extracted IR validates under the W2-001 validator", () => {
  const bundle = buildBundle(observedScript);
  const ir = extractBehavioralIr({ bundle, spec: buildSpec() });
  assert.deepEqual(validateBehavioralIr(ir), { ok: true, errors: [] });
  assert.equal(ir.schemaVersion, "0.1");
  assert.equal(ir.screens.length, 2);
  assert.equal(ir.journeys.length, 2);
  assert.deepEqual(ir.components, []);
  assert.deepEqual(ir.state, {});
  assert.deepEqual(ir.data, {});
  assert.deepEqual(ir.api, {});
  assert.deepEqual(ir.integrations, []);
  assert.deepEqual(ir.constraints, []);
});

test("evidence refs carried verbatim", () => {
  const bundle = buildBundle(observedScript);
  const ir = extractBehavioralIr({ bundle, spec: buildSpec() });
  assert.deepEqual(ir.evidence, bundle.refs);
  assert.equal(ir.evidence.length, bundle.refs.length);
  for (let index = 0; index < bundle.refs.length; index += 1) {
    assert.equal(ir.evidence[index].id, bundle.refs[index].id);
    assert.equal(ir.evidence[index].sha256, bundle.refs[index].sha256);
    assert.equal(ir.evidence[index].classification, bundle.refs[index].classification);
    assert.equal(ir.evidence[index].source, bundle.refs[index].source);
  }
});

test("unavailable channels become assumptions, never observations", () => {
  const bundle = buildBundle(observedScript);
  const ir = extractBehavioralIr({ bundle, spec: buildSpec() });
  for (const kind of UNAVAILABLE_KINDS) {
    const matching = ir.assumptions.filter(
      (entry) => entry.kind === kind && entry.path === "evidence",
    );
    assert.ok(matching.length >= 1, `expected an evidence assumption for kind "${kind}"`);
    for (const entry of matching) {
      assert.equal(
        entry.reason,
        NOTE_BY_KIND[kind],
        "assumption reason must carry the source note verbatim",
      );
    }
  }
  const unavailableIds = new Set(
    bundle.refs.filter((ref) => ref.classification === "unavailable").map((ref) => ref.id),
  );
  const cited = [
    ...ir.screens.flatMap((screen) => screen.evidenceIds as string[]),
    ...ir.journeys.flatMap((journey) => citedEvidenceIds(journey)),
  ];
  assert.ok(cited.length > 0, "the realistic bundle must cite its observed evidence");
  for (const id of cited) {
    assert.ok(
      !unavailableIds.has(id),
      `derived element must not cite unavailable evidence "${id}"`,
    );
  }
  assert.deepEqual(ir.state, {});
  const coverage = evidenceCoverage(ir);
  for (const kind of OBSERVED_KINDS) {
    const row = coverage.find((entry) => entry.kind === kind);
    assert.ok(row !== undefined, `expected coverage for "${kind}"`);
    assert.equal(row.classification, "observed");
    assert.equal(row.count, 2);
  }
  for (const kind of UNAVAILABLE_KINDS) {
    const row = coverage.find((entry) => entry.kind === kind);
    assert.ok(row !== undefined, `expected coverage for "${kind}"`);
    assert.equal(row.classification, "unavailable");
    assert.equal(row.count, 2);
  }
});

test("extraction is deterministic", () => {
  const first = extractBehavioralIr({ bundle: buildBundle(observedScript), spec: buildSpec() });
  const second = extractBehavioralIr({ bundle: buildBundle(observedScript), spec: buildSpec() });
  assert.deepEqual(first, second);
  assert.equal(serializeBehavioralIr(first), serializeBehavioralIr(second));
  const variant = extractBehavioralIr({
    bundle: buildBundle(observedScript, { ep2Text: "About\n\nSomething entirely different." }),
    spec: buildSpec(),
  });
  assert.notEqual(serializeBehavioralIr(variant), serializeBehavioralIr(first));
  assert.notEqual(
    screenFor(variant, EP2).textDigest,
    screenFor(first, EP2).textDigest,
    "variant page text must change the text digest",
  );
  assert.notEqual(
    screenFor(variant, EP2).screenId,
    screenFor(first, EP2).screenId,
    "variant page content must change the screen identity",
  );
});

test("purity — inputs never mutated", () => {
  const bundle = buildBundle(observedScript);
  const spec = buildSpec();
  const bundleSnapshot = structuredClone(bundle);
  const specSnapshot = structuredClone(spec);
  extractBehavioralIr({ bundle, spec });
  assert.deepEqual(bundle, bundleSnapshot);
  assert.deepEqual(spec, specSnapshot);
});

test("truncation is recorded honestly", () => {
  const bundle = buildBundle({ [EP1]: "observed", [EP2]: "observed", ep2Truncated: true });
  const ir = extractBehavioralIr({ bundle, spec: buildSpec() });
  const truncation = ir.assumptions.find(
    (entry) =>
      entry.path === "screens" &&
      entry.entrypoint === EP2 &&
      String(entry.reason).includes("truncated"),
  );
  assert.ok(truncation !== undefined, "expected a truncation assumption naming the entrypoint");
  assert.ok(
    String(truncation.reason).includes(EP2),
    "the truncation reason must name the entrypoint",
  );
  assert.ok(String(truncation.reason).includes(`truncated at ${TEXT_LIMIT} characters`));
  const truncatedScreen = screenFor(ir, EP2);
  assert.equal(truncatedScreen.truncated, true);
  assert.equal(truncatedScreen.textChars, TEXT_LIMIT);
  const fullScreen = screenFor(ir, EP1);
  assert.equal(fullScreen.truncated, false);
  assert.equal(fullScreen.textChars, null);
});

test("empty and partial bundles handled honestly", () => {
  const emptyBundle = buildBundle({ [EP1]: "unavailable", [EP2]: "unavailable" });
  const emptyIr = extractBehavioralIr({ bundle: emptyBundle, spec: buildSpec() });
  assert.deepEqual(validateBehavioralIr(emptyIr), { ok: true, errors: [] });
  assert.deepEqual(emptyIr.screens, []);
  assert.deepEqual(emptyIr.journeys, []);
  for (const entrypoint of [EP1, EP2]) {
    const screenGap = emptyIr.assumptions.find(
      (entry) => entry.path === "screens" && entry.entrypoint === entrypoint,
    );
    const journeyGap = emptyIr.assumptions.find(
      (entry) => entry.path === "journeys" && entry.entrypoint === entrypoint,
    );
    assert.ok(
      screenGap !== undefined,
      `expected a per-entrypoint screens assumption for ${entrypoint}`,
    );
    assert.ok(
      journeyGap !== undefined,
      `expected a per-entrypoint journeys assumption for ${entrypoint}`,
    );
  }
  assert.deepEqual(emptyIr.evidence, emptyBundle.refs);
  assert.ok(evidenceCoverage(emptyIr).every((row) => row.classification === "unavailable"));

  const partialBundle = buildBundle({ [EP1]: "observed", [EP2]: "unavailable" });
  const partialIr = extractBehavioralIr({ bundle: partialBundle, spec: buildSpec() });
  assert.deepEqual(validateBehavioralIr(partialIr), { ok: true, errors: [] });
  assert.equal(partialIr.screens.length, 1);
  assert.equal(partialIr.screens[0].entrypoint, EP1);
  assert.equal(partialIr.journeys.length, 1);
  assert.equal(partialIr.journeys[0].steps[0].target, EP1);
  assert.equal(
    partialIr.screens.find((screen) => screen.entrypoint === EP2),
    undefined,
  );
  assert.ok(
    partialIr.assumptions.some((entry) => entry.path === "screens" && entry.entrypoint === EP2),
  );
  assert.ok(
    partialIr.assumptions.some((entry) => entry.path === "journeys" && entry.entrypoint === EP2),
  );
});

test("engine model() now extracts", async () => {
  const bundle = buildBundle(observedScript);
  const spec = buildSpec();
  const engine = createIntelligenceEngine();
  const ir = await engine.model(spec, bundle);
  assert.deepEqual(ir, extractBehavioralIr({ bundle, spec }));
});
