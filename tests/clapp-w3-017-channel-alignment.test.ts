import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  CANONICAL_BENCHMARKS,
  createBenchmarkHarness,
} from "../packages/clapp-benchmarks/src/index.ts";
import type { EvidenceRef, ReconstructionSpec } from "../packages/clapp-contracts/src/index.ts";
import { extractBehavioralIr } from "../packages/clapp-intelligence/src/index.ts";
import { createBrowserObservationAdapter } from "../packages/clapp-observation/src/index.ts";
import type { AlignedPageSnapshot } from "../packages/clapp-runtime-openmuse/src/index.ts";
import {
  ALIGNED_CHANNEL_KINDS,
  alignmentForKind,
  alignPageEvidence,
  alignUnavailablePageEvidence,
  buildChannelAlignment,
  createOpenMuseRuntime,
  hasBrowserSessionSeam,
  NO_RUNTIME_SOURCE_KINDS,
  PAGE_TEXT_LIMIT,
  SOURCE_NOTE_DOM_TEXT,
  SOURCE_NOTE_PAGE_META,
  sourceNoteForKind,
} from "../packages/clapp-runtime-openmuse/src/index.ts";

/**
 * CLAPP-W3-017 — the observation channel alignment (re-land).
 *
 * The runtime's W1-001-era observation provider emitted `page-text`/
 * `screenshot` channel names while the W2-002 extraction consumes the W1-002
 * `dom-text`/`page-meta` vocabulary — so a production capture yielded the
 * honest SPARSE model. The aligned emission derives the W1-002 vocabulary from
 * the same `handle.observe()` page snapshot wherever the bound handle also
 * provides the W1-002 browser-session seam (`create`/`navigate`/`read`), so a
 * production capture derives the full extraction model — screens and journeys
 * included. Five deterministic cases prove the contract:
 *
 * (a) mapping totality — the total legacy-to-aligned mapping, the capability
 *     gate, the unmapped scan, the no-runtime-source disclosure, and the
 *     aligned ref builders' W1-002-faithful discipline (id/digest/source,
 *     truncation suffix, unavailable pair);
 * (b) backward compatibility both ways — legacy digests inside the aligned
 *     bundle, and the exact W1-001-era bundle for observe-only handles;
 * (c) the end-to-end full-model proof — the REAL runtime provider over a
 *     production-shaped page handle reading the REAL B01 harness over
 *     loopback, fed to the REAL W2-002 extraction, derives 4 screens + 4
 *     journeys with pinned shapes, sparse markers gone and honest gaps still
 *     recorded; plus faithfulness against the REAL W1-002 adapter
 *     (id/digest/source/classification-identical page evidence; screens and
 *     journeys deep-equal);
 * (d) the honest sparse case — an observe-only handle yields 0 screens / 0
 *     journeys with precise no-attribution assumptions and no fabrication;
 * (e) byte-determinism — identical bundle identity across repeated captures
 *     (the root hash excludes the wall-clock capturedAt).
 */

const sha256Hex = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
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
const canonicalJsonBytes = (value: unknown): Uint8Array => utf8(canonicalJson(value));

const RECON = "recon-w3-017";
const TARGET = "target-clapp-w3-017";
const OWNER = "local-user";
const B01 = CANONICAL_BENCHMARKS[0];
if (B01 === undefined) throw new Error("canonical benchmark B01 missing");
const B01_ENTRYPOINTS = B01.routes.map((route) => route.path);

/** Capture-position ref id mirroring the W1-002 adapter's scheme. */
const refId = (entrypoint: string, kind: string) =>
  sha256Hex(canonicalJsonBytes({ entrypoint, kind, reconstructionId: RECON, targetId: TARGET }));

const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03,
]);

/** A minimal in-memory store satisfying the ClappDbHandle shape (for bind). */
function memoryDb() {
  const tables = new Map<string, Map<string, { owner: string; value: Record<string, unknown> }>>();
  const table = (kind: string) => {
    let t = tables.get(kind);
    if (!t) {
      t = new Map();
      tables.set(kind, t);
    }
    return t;
  };
  return {
    async get(_owner: string, kind: string, id: string) {
      return table(kind).get(id)?.value ?? null;
    },
    async scan(kind: string) {
      return [...table(kind).values()].map((row) => ({ owner: row.owner, value: row.value }));
    },
    async put(owner: string, kind: string, value: { id: string }) {
      table(kind).set(value.id, { owner, value: value as Record<string, unknown> });
      return value;
    },
    async compareAndSwap(
      owner: string,
      kind: string,
      id: string,
      _expected: Record<string, unknown>,
      patch: Record<string, unknown>,
    ) {
      table(kind).set(id, { owner, value: patch });
      return patch;
    },
    async remove(_owner: string, kind: string, id: string) {
      table(kind).delete(id);
    },
  };
}

/** The deterministic page title of a served HTML document (the W3-008 helper). */
function pageTitle(html: string): string {
  const match = /<title>([\s\S]*?)<\/title>/i.exec(html);
  return match === null ? "" : match[1].trim();
}

/** The deterministic innerText-style extraction (the W3-008 helper). */
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
 * A production-shaped page handle reading the REAL B01 harness over loopback.
 * Exposes the W1-001 `observe` seam AND the W1-002 browser-session seam
 * (`create`/`navigate`/`read`), so the runtime's aligned emission activates.
 * `observe()` and `read()` produce the same page content for the same route so
 * the runtime's aligned refs are id- and digest-identical to the W1-002
 * adapter's refs (which call read()).
 */
function productionPageHandle(baseUrl: () => string) {
  const SESSION_ID = "00000000-w3-017-0000-000000000001";
  let currentRoute = "about:blank";
  const readRoute = async (
    route: string,
  ): Promise<{ url: string; title: string; text: string; truncated: boolean }> => {
    const response = await fetch(`${baseUrl()}${route}`);
    const html = await response.text();
    if (!response.ok) throw new Error(`benchmark route ${route} responded ${response.status}`);
    return { url: route, title: pageTitle(html), text: htmlToText(html), truncated: false };
  };
  return {
    async observe(_owner: string, url: string) {
      const snapshot = await readRoute(url);
      return { sessionId: SESSION_ID, ...snapshot };
    },
    async create(_owner: string, url: string) {
      currentRoute = url;
      return { id: SESSION_ID, title: "Benchmark session", url, status: "idle" };
    },
    async navigate(_owner: string, id: string, url: string) {
      if (id !== SESSION_ID) throw new Error(`unknown session ${id}`);
      currentRoute = url;
      return { id, title: "Benchmark session", url, status: "idle" };
    },
    async read(_owner: string, id: string) {
      if (id !== SESSION_ID) throw new Error(`unknown session ${id}`);
      return readRoute(currentRoute);
    },
    async preview(_owner: string, id: string) {
      if (id !== SESSION_ID) throw new Error(`unknown session ${id}`);
      return {
        arrayBuffer: async () => {
          const buffer = new ArrayBuffer(PNG_BYTES.length);
          new Uint8Array(buffer).set(PNG_BYTES);
          return buffer;
        },
      };
    },
  };
}

/** An observe-only shim (the W1-001-era shape): `observe` and nothing else. */
function observeOnlyHandle(
  pages: Record<string, { url: string; title: string; text: string; truncated: boolean }>,
) {
  return {
    async observe(_owner: string, url: string) {
      const page = pages[url];
      if (page === undefined) throw new Error(`no scripted page for ${url}`);
      return { sessionId: "session-observe-only", ...page };
    },
  };
}

function buildSpec(entrypoints: string[]): ReconstructionSpec {
  return {
    specVersion: "0.1",
    reconstructionId: RECON,
    targetId: TARGET,
    name: "CLAPP W3-017 alignment spec",
    platform: "web",
    entrypoints,
    authorization: {
      ownerId: OWNER,
      targetId: TARGET,
      scope: ["observe"],
      environments: ["production"],
      retention: "project",
      benchmarkOwned: false,
      createdAt: "2025-01-01T00:00:00.000Z",
    },
    exploration: { maxStages: 4, maxActions: 40, maxDurationMs: 600_000, seed: 17 },
    synthesis: { targetStack: "web", allowNetwork: false, packagePolicy: "verified-only" },
    verification: {
      journeys: entrypoints.map((entrypoint) => `visit:${entrypoint}`),
      visual: true,
      network: false,
      state: true,
      maxRepairIterations: 1,
    },
  };
}

/** A runtime bound to a browserSession handle only (the minimal observation binding). */
function runtimeWith(handle: unknown) {
  return createOpenMuseRuntime({
    browserSession: handle,
    computer: undefined,
    files: undefined,
    agent: undefined,
    db: memoryDb(),
  });
}

/** Reads the entrypointRefs linkage as a typed record. */
const linkageOf = (bundle: { environment: Record<string, unknown> }): Record<string, string[]> =>
  bundle.environment.entrypointRefs as Record<string, string[]>;

// ---------------------------------------------------------------------------
// (a) mapping totality
// ---------------------------------------------------------------------------

test("(a) mapping totality: the total mapping, the capability gate, the unmapped scan, the no-runtime-source disclosure, and the W1-002-faithful aligned ref builders", () => {
  // The total legacy-to-aligned mapping: page-text -> dom-text + page-meta (not identity);
  // screenshot -> screenshot (identity); foreign -> unmapped (empty alignedKinds).
  const pageText = alignmentForKind("page-text");
  assert.deepEqual([...pageText.alignedKinds], ["dom-text", "page-meta"]);
  assert.equal(pageText.identity, false);
  const screenshot = alignmentForKind("screenshot");
  assert.deepEqual([...screenshot.alignedKinds], ["screenshot"]);
  assert.equal(screenshot.identity, true);
  for (const foreign of ["dom-structure", "network", "telemetry"]) {
    const row = alignmentForKind(foreign);
    assert.deepEqual([...row.alignedKinds], []);
    assert.equal(row.identity, false);
  }

  // The capability gate: a seam-capable handle activates; an observe-only shim does not.
  const seam = productionPageHandle(() => "http://127.0.0.1:0");
  assert.equal(hasBrowserSessionSeam(seam), true);
  assert.equal(hasBrowserSessionSeam(observeOnlyHandle({})), false);
  assert.equal(hasBrowserSessionSeam(undefined), false);
  assert.equal(hasBrowserSessionSeam({ observe() {} }), false);
  assert.equal(hasBrowserSessionSeam({ observe() {}, create() {}, navigate() {} }), false); // read missing

  // The channelAlignment record: a normal aligned bundle's refs are all in the aligned
  // vocabulary (unmapped empty); a foreign kind surfaces in the unmapped scan — never dropped.
  const normal: EvidenceRef[] = [
    {
      id: "a",
      targetId: TARGET,
      reconstructionId: RECON,
      kind: "page-text",
      sha256: "1",
      source: "/",
      capturedAt: "t",
      classification: "observed",
      redacted: false,
    },
    {
      id: "b",
      targetId: TARGET,
      reconstructionId: RECON,
      kind: "screenshot",
      sha256: "2",
      source: "/",
      capturedAt: "t",
      classification: "observed",
      redacted: false,
    },
    {
      id: "c",
      targetId: TARGET,
      reconstructionId: RECON,
      kind: "dom-text",
      sha256: "3",
      source: "/",
      capturedAt: "t",
      classification: "observed",
      redacted: false,
    },
    {
      id: "d",
      targetId: TARGET,
      reconstructionId: RECON,
      kind: "page-meta",
      sha256: "4",
      source: "/",
      capturedAt: "t",
      classification: "observed",
      redacted: false,
    },
  ];
  const cleanAlignment = buildChannelAlignment(normal, true);
  assert.equal(cleanAlignment.aligned, true);
  assert.deepEqual(cleanAlignment.unmapped, []);
  assert.deepEqual(
    cleanAlignment.mapping.map((row) => [row.sourceKind, [...row.alignedKinds], row.identity]),
    [
      ["page-text", ["dom-text", "page-meta"], false],
      ["screenshot", ["screenshot"], true],
    ],
  );
  const withForeign: EvidenceRef[] = [
    ...normal,
    {
      id: "f1",
      targetId: TARGET,
      reconstructionId: RECON,
      kind: "telemetry",
      sha256: "9",
      source: "/",
      capturedAt: "t",
      classification: "observed",
      redacted: false,
    },
    {
      id: "f2",
      targetId: TARGET,
      reconstructionId: RECON,
      kind: "telemetry",
      sha256: "10",
      source: "/",
      capturedAt: "t",
      classification: "observed",
      redacted: false,
    },
    {
      id: "f3",
      targetId: TARGET,
      reconstructionId: RECON,
      kind: "beacon",
      sha256: "11",
      source: "/",
      capturedAt: "t",
      classification: "observed",
      redacted: false,
    },
  ];
  assert.deepEqual(buildChannelAlignment(withForeign, true).unmapped, [
    { kind: "beacon", count: 1 },
    { kind: "telemetry", count: 2 },
  ]);

  // The four W1-002 kinds with no runtime source are disclosed, not fabricated as refs.
  assert.deepEqual([...NO_RUNTIME_SOURCE_KINDS], ["dom-structure", "a11y", "network", "storage"]);
  assert.equal(cleanAlignment.noRuntimeSourceKinds.length, 4);
  for (const disclosed of cleanAlignment.noRuntimeSourceKinds) {
    assert.equal(disclosed.sourceNote, sourceNoteForKind(disclosed.kind));
    assert.ok((NO_RUNTIME_SOURCE_KINDS as readonly string[]).includes(disclosed.kind));
  }
  assert.deepEqual(
    [...ALIGNED_CHANNEL_KINDS],
    ["page-text", "screenshot", "dom-text", "page-meta"],
  );

  // alignPageEvidence mirrors the W1-002 adapter's id/digest/source discipline.
  const page: AlignedPageSnapshot = {
    url: "https://app.example/",
    title: "Example App",
    text: "Home\n\nWelcome to the example application.",
    truncated: false,
  };
  const spec = buildSpec(["https://app.example/"]);
  const pair = alignPageEvidence(spec, "https://app.example/", page, "2025-01-01T00:00:00.000Z");
  assert.equal(pair.domText.kind, "dom-text");
  assert.equal(pair.domText.id, refId("https://app.example/", "dom-text"));
  assert.equal(pair.domText.sha256, sha256Hex(utf8(page.text)));
  assert.equal(pair.domText.source, SOURCE_NOTE_DOM_TEXT);
  assert.equal(pair.domText.classification, "observed");
  assert.equal(pair.domText.redacted, false);
  assert.notEqual(pair.domText.id, pair.domText.sha256); // capture-position id, stable under redaction
  assert.equal(pair.pageMeta.kind, "page-meta");
  assert.equal(pair.pageMeta.id, refId("https://app.example/", "page-meta"));
  assert.equal(
    pair.pageMeta.sha256,
    sha256Hex(canonicalJsonBytes({ url: page.url, title: page.title })),
  );
  assert.equal(pair.pageMeta.source, SOURCE_NOTE_PAGE_META);

  // The truncation suffix is recorded in the dom-text source (the only place the extraction parses it).
  const longPage: AlignedPageSnapshot = {
    url: "https://app.example/long",
    title: "Long Page",
    text: "x".repeat(PAGE_TEXT_LIMIT + 50),
    truncated: true,
  };
  const longPair = alignPageEvidence(
    spec,
    "https://app.example/long",
    longPage,
    "2025-01-01T00:00:00.000Z",
  );
  assert.equal(
    longPair.domText.source,
    `${SOURCE_NOTE_DOM_TEXT} (truncated at ${PAGE_TEXT_LIMIT} characters)`,
  );
  assert.ok(/\(truncated at (\d+) characters\)/.exec(longPair.domText.source));

  // alignUnavailablePageEvidence emits the honest unavailable pair (registry note as source, reason in the payload).
  const reason =
    "the browserSession handle could not observe the entrypoint: scripted test failure";
  const unavailablePair = alignUnavailablePageEvidence(
    spec,
    "https://app.example/",
    reason,
    "2025-01-01T00:00:00.000Z",
  );
  for (const ref of [unavailablePair.domText, unavailablePair.pageMeta]) {
    assert.equal(ref.classification, "unavailable");
    assert.equal(ref.id, refId("https://app.example/", ref.kind));
    assert.equal(ref.source, sourceNoteForKind(ref.kind));
    assert.equal(
      ref.sha256,
      sha256Hex(canonicalJsonBytes({ entrypoint: "https://app.example/", kind: ref.kind, reason })),
    );
  }
});

// ---------------------------------------------------------------------------
// (b) backward compatibility both ways
// ---------------------------------------------------------------------------

test("(b) backward compatibility both ways: legacy digests inside the aligned bundle, and the exact W1-001-era bundle for observe-only handles", async () => {
  // (b1) A seam-capable handle carries both vocabularies: legacy digests live inside the aligned bundle.
  const started = await createBenchmarkHarness(B01).start();
  try {
    const runtime = runtimeWith(productionPageHandle(() => started.baseUrl));
    const spec = buildSpec(["/"]);
    const bundle = await runtime.observation.observe(spec);
    assert.deepEqual(
      [...((bundle.environment.channels as string[]) ?? [])],
      [...ALIGNED_CHANNEL_KINDS],
    );
    assert.equal(bundle.environment.aligned, true);
    assert.ok(typeof bundle.environment.entrypointRefs === "object");
    // The legacy page-text ref (W1-001 content-addressed digest) is present.
    const pageText = bundle.refs.find((ref) => ref.kind === "page-text");
    assert.ok(pageText);
    assert.equal(pageText.classification, "observed");
    assert.equal(pageText.sha256, pageText.id); // W1-001: id == content digest
    assert.equal(pageText.source, "/");
    // The aligned dom-text + page-meta refs are present and capture-position-addressed.
    const domText = bundle.refs.find((ref) => ref.kind === "dom-text");
    const pageMeta = bundle.refs.find((ref) => ref.kind === "page-meta");
    assert.ok(domText);
    assert.ok(pageMeta);
    assert.equal(domText.id, refId("/", "dom-text"));
    assert.equal(pageMeta.id, refId("/", "page-meta"));
    assert.notEqual(domText.id, domText.sha256);
    assert.equal(domText.source, SOURCE_NOTE_DOM_TEXT);
    assert.equal(pageMeta.source, SOURCE_NOTE_PAGE_META);
    // The legacy screenshot ref is present (observed, identity mapping).
    const screenshot = bundle.refs.find((ref) => ref.kind === "screenshot");
    assert.ok(screenshot);
    assert.equal(screenshot.classification, "observed");
    // 4 refs for one entrypoint: page-text + screenshot + dom-text + page-meta.
    assert.equal(bundle.refs.length, 4);
    // entrypointRefs attributes all four (push order; compare as sets — order is
    // order-insensitive for the extraction, which builds a Set from the linkage).
    const epRefs = linkageOf(bundle)["/"].slice().sort();
    const allRefIds = bundle.refs
      .map((ref) => ref.id)
      .slice()
      .sort();
    assert.deepEqual(epRefs, allRefIds);
  } finally {
    await started.stop();
  }

  // (b2) An observe-only handle yields the exact W1-001-era bundle (byte-identical modulo capturedAt).
  const page = {
    url: "https://example.test/",
    title: "Observed page",
    text: "The genuinely captured page text",
    truncated: false,
  };
  const legacyBundle = await runtimeWith(
    observeOnlyHandle({ "https://example.test/": page }),
  ).observation.observe(buildSpec(["https://example.test/"]));
  // The frozen W1-001 pin holds: every observed ref from an observe-only handle is page-text.
  assert.ok(
    legacyBundle.refs.every((ref) => ref.classification !== "observed" || ref.kind === "page-text"),
  );
  // The aligned vocabulary is NOT carried: no dom-text/page-meta, no entrypointRefs, no channelAlignment.
  assert.equal(
    legacyBundle.refs.find((ref) => ref.kind === "dom-text"),
    undefined,
  );
  assert.equal(
    legacyBundle.refs.find((ref) => ref.kind === "page-meta"),
    undefined,
  );
  assert.equal(legacyBundle.environment.aligned, undefined);
  assert.equal(legacyBundle.environment.entrypointRefs, undefined);
  assert.equal(legacyBundle.environment.channelAlignment, undefined);
  assert.deepEqual(legacyBundle.environment.channels, ["page-text", "screenshot"]);
  // The exact W1-001-era refs (content-addressed id/sha256 for page-text; manifest digest for screenshot).
  const legacyPageText = legacyBundle.refs.find((ref) => ref.kind === "page-text");
  assert.ok(legacyPageText);
  assert.equal(legacyPageText.classification, "observed");
  assert.equal(legacyPageText.sha256, sha256Hex(utf8(`${page.title}\n${page.text}`)));
  assert.equal(legacyPageText.id, legacyPageText.sha256);
  const legacyScreenshot = legacyBundle.refs.find((ref) => ref.kind === "screenshot");
  assert.ok(legacyScreenshot);
  assert.equal(legacyScreenshot.classification, "unavailable"); // observe-only shim has no preview
  assert.equal(
    legacyScreenshot.sha256,
    sha256Hex(
      canonicalJsonBytes({
        channel: "screenshot",
        entrypoint: "https://example.test/",
        reason: "the browserSession handle does not provide the preview capability",
      }),
    ),
  );
  // The root hash excludes capturedAt (deterministic formula).
  const expectedRoot = sha256Hex(
    JSON.stringify(legacyBundle.refs.map((ref) => [ref.id, ref.sha256, ref.classification])),
  );
  assert.equal(legacyBundle.rootSha256, expectedRoot);
  assert.equal(legacyBundle.id, `clapp-bundle:${expectedRoot}`);
});

// ---------------------------------------------------------------------------
// (c) the end-to-end full-model proof (REAL runtime + REAL B01 + REAL extraction)
// ---------------------------------------------------------------------------

test("(c) the end-to-end full-model proof: the REAL runtime over B01 derives 4 screens + 4 journeys, sparse markers gone, honest gaps recorded — and is faithful to the REAL W1-002 adapter", async () => {
  const started = await createBenchmarkHarness(B01).start();
  try {
    const spec = buildSpec(B01_ENTRYPOINTS);
    const runtimeBundle = await runtimeWith(
      productionPageHandle(() => started.baseUrl),
    ).observation.observe(spec);

    // The aligned bundle carries both vocabularies over B01: 4 entrypoints x 4 refs = 16 refs
    // (vs the W1-002 adapter's 28 = 7 x 4, which includes the four unavailable kinds per entrypoint).
    assert.equal(runtimeBundle.refs.length, 16);
    assert.equal(runtimeBundle.environment.aligned, true);
    assert.deepEqual(
      [...((runtimeBundle.environment.channels as string[]) ?? [])],
      [...ALIGNED_CHANNEL_KINDS],
    );
    assert.equal(Object.keys(linkageOf(runtimeBundle)).length, B01_ENTRYPOINTS.length);

    // The REAL W2-002 extraction derives the full model: one screen + one journey per entrypoint.
    const ir = extractBehavioralIr({ bundle: runtimeBundle, spec });
    assert.equal(ir.screens.length, B01_ENTRYPOINTS.length);
    assert.equal(ir.journeys.length, B01_ENTRYPOINTS.length);

    // Each screen carries the pinned shape (capture-position evidence ids, null url/title/textChars).
    const linkage = linkageOf(runtimeBundle);
    for (const entrypoint of B01_ENTRYPOINTS) {
      const domText = runtimeBundle.refs.find(
        (ref) => ref.kind === "dom-text" && linkage[entrypoint].includes(ref.id),
      );
      const pageMeta = runtimeBundle.refs.find(
        (ref) => ref.kind === "page-meta" && linkage[entrypoint].includes(ref.id),
      );
      assert.ok(domText, `dom-text for ${entrypoint}`);
      assert.ok(pageMeta, `page-meta for ${entrypoint}`);
      const screen = ir.screens.find((candidate) => candidate.entrypoint === entrypoint);
      assert.ok(screen, `screen for ${entrypoint}`);
      assert.equal(
        screen.screenId,
        `screen-${sha256Hex(canonicalJsonBytes({ entrypoint, domText: domText.sha256, pageMeta: pageMeta.sha256 }))}`,
      );
      assert.equal(screen.url, null);
      assert.equal(screen.title, null);
      assert.equal(screen.textDigest, domText.sha256);
      assert.equal(screen.textChars, null); // B01 pages are not truncated
      assert.equal(screen.truncated, false);
      assert.deepEqual(screen.evidenceIds, [domText.id, pageMeta.id]);
      const journey = ir.journeys.find((candidate) => candidate.id === `visit:${entrypoint}`);
      assert.ok(journey, `journey for ${entrypoint}`);
      assert.equal(journey.steps[0].target, entrypoint);
      assert.deepEqual((journey.steps[0].assertions as { evidenceIds: string[] }).evidenceIds, [
        domText.id,
        pageMeta.id,
      ]);
    }

    // Sparse markers gone: no per-entrypoint no-screen / no-journey assumptions (every entrypoint has an observed pair).
    for (const entrypoint of B01_ENTRYPOINTS) {
      assert.equal(
        ir.assumptions.find((entry) => entry.path === "screens" && entry.entrypoint === entrypoint),
        undefined,
        `no sparse no-screen assumption for ${entrypoint}`,
      );
      assert.equal(
        ir.assumptions.find(
          (entry) => entry.path === "journeys" && entry.entrypoint === entrypoint,
        ),
        undefined,
        `no sparse no-journey assumption for ${entrypoint}`,
      );
    }

    // Honest gaps still recorded: components/state/data/api (no dom-structure/storage/network evidence)
    // and the content-access gap behind null url/title/textChars.
    for (const path of ["components", "state", "data", "api"]) {
      assert.ok(
        ir.assumptions.find((entry) => entry.path === path),
        `honest gap assumption for ${path}`,
      );
    }
    assert.ok(
      ir.assumptions.find(
        (entry) => entry.path === "screens" && (entry.evidenceIds as string[]).length === 0,
      ),
      "the content-access gap assumption (null url/title/textChars)",
    );
    assert.deepEqual(ir.evidence, runtimeBundle.refs); // no fabrication

    // Faithfulness against the REAL W1-002 adapter over the same B01 capture: the runtime's aligned
    // page evidence is id/digest/source/classification-identical (only capturedAt, the wall-clock, differs).
    const adapterBundle = await createBrowserObservationAdapter({
      ownerId: OWNER,
      browser: productionPageHandle(() => started.baseUrl),
    }).observe(spec);
    for (const entrypoint of B01_ENTRYPOINTS) {
      const runtimeDomText = runtimeBundle.refs.find(
        (ref) => ref.kind === "dom-text" && linkage[entrypoint].includes(ref.id),
      );
      const adapterDomText = adapterBundle.refs.find(
        (ref) => ref.kind === "dom-text" && ref.id === refId(entrypoint, "dom-text"),
      );
      assert.ok(runtimeDomText, `runtime dom-text for ${entrypoint}`);
      assert.ok(adapterDomText, `adapter dom-text for ${entrypoint}`);
      assert.equal(runtimeDomText.id, adapterDomText.id);
      assert.equal(runtimeDomText.sha256, adapterDomText.sha256);
      assert.equal(runtimeDomText.source, adapterDomText.source);
      assert.equal(runtimeDomText.classification, adapterDomText.classification);
      const runtimePageMeta = runtimeBundle.refs.find(
        (ref) => ref.kind === "page-meta" && linkage[entrypoint].includes(ref.id),
      );
      const adapterPageMeta = adapterBundle.refs.find(
        (ref) => ref.kind === "page-meta" && ref.id === refId(entrypoint, "page-meta"),
      );
      assert.ok(runtimePageMeta, `runtime page-meta for ${entrypoint}`);
      assert.ok(adapterPageMeta, `adapter page-meta for ${entrypoint}`);
      assert.equal(runtimePageMeta.id, adapterPageMeta.id);
      assert.equal(runtimePageMeta.sha256, adapterPageMeta.sha256);
      assert.equal(runtimePageMeta.source, adapterPageMeta.source);
      assert.equal(runtimePageMeta.classification, adapterPageMeta.classification);
    }
    // The aligned bundle carries 16 refs (both vocabularies) vs the adapter's 28.
    assert.equal(runtimeBundle.refs.length, 16);
    assert.equal(adapterBundle.refs.length, 28);
    // Both derive deep-equal screens and journeys when fed to the REAL extraction.
    const adapterIr = extractBehavioralIr({ bundle: adapterBundle, spec });
    assert.equal(ir.screens.length, adapterIr.screens.length);
    assert.equal(ir.journeys.length, adapterIr.journeys.length);
    for (const entrypoint of B01_ENTRYPOINTS) {
      assert.deepEqual(
        ir.screens.find((screen) => screen.entrypoint === entrypoint),
        adapterIr.screens.find((screen) => screen.entrypoint === entrypoint),
        `screen deep-equal for ${entrypoint}`,
      );
      assert.deepEqual(
        ir.journeys.find((journey) => journey.id === `visit:${entrypoint}`),
        adapterIr.journeys.find((journey) => journey.id === `visit:${entrypoint}`),
        `journey deep-equal for ${entrypoint}`,
      );
    }
  } finally {
    await started.stop();
  }
});

// ---------------------------------------------------------------------------
// (d) the honest sparse case (observe-only handle -> 0 screens / 0 journeys)
// ---------------------------------------------------------------------------

test("(d) the honest sparse case: an observe-only handle yields 0 screens / 0 journeys, precise no-attribution assumptions, no fabrication", async () => {
  const page = {
    url: "https://example.test/",
    title: "Observed page",
    text: "The genuinely captured page text",
    truncated: false,
  };
  const bundle = await runtimeWith(
    observeOnlyHandle({ "https://example.test/": page }),
  ).observation.observe(buildSpec(["https://example.test/"]));
  // The bundle carries only the W1-001 vocabulary (no aligned refs, no entrypointRefs linkage).
  assert.equal(
    bundle.refs.find((ref) => ref.kind === "dom-text"),
    undefined,
  );
  assert.equal(
    bundle.refs.find((ref) => ref.kind === "page-meta"),
    undefined,
  );
  assert.equal(bundle.environment.entrypointRefs, undefined);

  // The REAL extraction derives the honest sparse model: 0 screens, 0 journeys.
  const ir = extractBehavioralIr({ bundle, spec: buildSpec(["https://example.test/"]) });
  assert.deepEqual(ir.screens, []);
  assert.deepEqual(ir.journeys, []);

  // The per-entrypoint no-attribution assumption names the missing linkage precisely.
  const screenGap = ir.assumptions.find(
    (entry) => entry.path === "screens" && entry.entrypoint === "https://example.test/",
  );
  const journeyGap = ir.assumptions.find(
    (entry) => entry.path === "journeys" && entry.entrypoint === "https://example.test/",
  );
  assert.ok(screenGap, "a per-entrypoint no-screen assumption");
  assert.ok(journeyGap, "a per-entrypoint no-journey assumption");
  assert.ok(String(screenGap.reason).includes("entrypointRefs"));
  assert.ok(String(journeyGap.reason).includes("entrypointRefs"));
  // No fabricated evidence: the no-attribution assumptions cite empty evidenceIds.
  assert.deepEqual(screenGap.evidenceIds, []);
  assert.deepEqual(journeyGap.evidenceIds, []);

  // No observed evidence is fabricated beyond the legacy page-text/screenshot the bundle actually carries.
  assert.deepEqual(ir.evidence, bundle.refs);
  assert.ok(
    ir.evidence.every((ref) => ref.kind === "page-text" || ref.kind === "screenshot"),
    "the sparse bundle carries only legacy kinds",
  );
});

// ---------------------------------------------------------------------------
// (e) byte-determinism — identical bundle identity across repeated captures
// ---------------------------------------------------------------------------

test("(e) byte-determinism: repeated captures produce identical bundle identity (the root hash excludes the wall-clock capturedAt)", async () => {
  const started = await createBenchmarkHarness(B01).start();
  try {
    const spec = buildSpec(B01_ENTRYPOINTS);
    const first = await runtimeWith(
      productionPageHandle(() => started.baseUrl),
    ).observation.observe(spec);
    // A second capture over a fresh handle (same content) — the per-ref capturedAt is wall-clock
    // and may differ, but the bundle identity and every ref id/sha256 stay identical.
    const second = await runtimeWith(
      productionPageHandle(() => started.baseUrl),
    ).observation.observe(spec);

    assert.equal(second.id, first.id, "bundle id is identical across captures");
    assert.equal(second.rootSha256, first.rootSha256, "rootSha256 is identical across captures");
    assert.deepEqual(
      second.refs.map((ref) => ref.id),
      first.refs.map((ref) => ref.id),
      "ref ids are identical and in the same (id-sorted) order",
    );
    for (let index = 0; index < first.refs.length; index += 1) {
      assert.equal(second.refs[index].sha256, first.refs[index].sha256);
      assert.equal(second.refs[index].kind, first.refs[index].kind);
      assert.equal(second.refs[index].classification, first.refs[index].classification);
      assert.equal(second.refs[index].source, first.refs[index].source);
    }
    // The aligned environment is byte-stable across captures (the channelAlignment record is constant).
    assert.deepEqual(second.environment.channelAlignment, first.environment.channelAlignment);
    assert.deepEqual(second.environment.entrypointRefs, first.environment.entrypointRefs);
    assert.deepEqual(second.environment.channels, first.environment.channels);
  } finally {
    await started.stop();
  }
});
