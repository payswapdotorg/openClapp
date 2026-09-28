import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Auth } from "../apps/server/src/auth.ts";
import { BrowserService } from "../apps/server/src/browser.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { Files } from "../apps/server/src/files.ts";
import type { EvidenceBundle, ReconstructionSpec } from "../packages/clapp-contracts/src/index.ts";
import {
  ClappObservationAbortError,
  ClappObservationError,
  canonicalJson,
  canonicalJsonBytes,
  channelOfKind,
  createBrowserObservationAdapter,
  OBSERVATION_CHANNEL_NAMES,
  OBSERVATION_CHANNELS,
  type PageSnapshot,
  redact,
  redactionMarkerPayload,
  sha256Hex,
  utf8,
} from "../packages/clapp-observation/src/index.ts";

/**
 * CLAPP-W1-002 — browser observation adapter.
 *
 * Unit tests bind the adapter to a FAKE browser handle implementing the
 * structural seam (no network, no Chromium). The integration test binds the
 * REAL BrowserService against a stub worker HTTP server on an ephemeral
 * loopback port — the substrate's exact structural shape, without launching
 * a browser.
 */
const OWNER = "local-user";
const FIXED_MS = 1735689600000; // 2025-01-01T00:00:00.000Z — pinned clock for deterministic capture
const FIXED_ISO = new Date(FIXED_MS).toISOString();
const fixedClock = () => FIXED_MS;
const textDigest = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const digestOf = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

const PAGE: PageSnapshot = {
  url: "https://app.example/",
  title: "Example App",
  text: "Home\n\nWelcome to the example application.",
  truncated: false,
};
const PAGE_2: PageSnapshot = {
  url: "https://app.example/about",
  title: "About — Example App",
  text: "About\n\nThis page describes the example application.",
  truncated: false,
};

/** A fake browser handle implementing the structural seam with scripted outputs. */
interface FakeScript {
  pages: Record<string, PageSnapshot>;
  sessionId: string;
  fail?: { create?: string; navigate?: string; read?: string; screenshot?: string };
  noPreview?: boolean;
}

function fakeHandle(script: FakeScript) {
  const calls: { capability: string; owner: string; sessionId?: string; url?: string }[] = [];
  const asFailure = (message?: string) => {
    if (message) throw new Error(message);
  };
  const handle = {
    calls,
    currentUrl: "about:blank",
    async create(owner: string, url: string) {
      calls.push({ capability: "create", owner, url });
      asFailure(script.fail?.create);
      handle.currentUrl = url;
      return {
        id: script.sessionId,
        title: "New browser session",
        url,
        status: "idle",
        updatedAt: FIXED_ISO,
      };
    },
    async navigate(owner: string, id: string, url: string) {
      calls.push({ capability: "navigate", owner, sessionId: id, url });
      asFailure(script.fail?.navigate);
      handle.currentUrl = url;
      return { id, title: "New browser session", url, status: "idle", updatedAt: FIXED_ISO };
    },
    async read(owner: string, id: string) {
      calls.push({ capability: "read", owner, sessionId: id });
      asFailure(script.fail?.read);
      const page = script.pages[handle.currentUrl];
      if (!page) throw new Error(`fake handle has no scripted page for ${handle.currentUrl}`);
      return { ...page };
    },
    async preview(owner: string, id: string) {
      calls.push({ capability: "preview", owner, sessionId: id });
      asFailure(script.fail?.screenshot);
      return {
        arrayBuffer: async () => PNG_BYTES.slice().buffer as ArrayBuffer,
      };
    },
  };
  if (script.noPreview) delete (handle as { preview?: unknown }).preview;
  return handle;
}

const adapterOver = (script: FakeScript) =>
  createBrowserObservationAdapter({ ownerId: OWNER, browser: fakeHandle(script), now: fixedClock });

const spec = (entrypoints: string[], reconstructionId = "recon-w1-002"): ReconstructionSpec => ({
  specVersion: "0.1",
  reconstructionId,
  targetId: "target-example",
  name: "Example App",
  platform: "web",
  entrypoints,
  authorization: {
    ownerId: OWNER,
    targetId: "target-example",
    scope: ["observe"],
    environments: ["web"],
    retention: "ephemeral",
    benchmarkOwned: false,
    createdAt: FIXED_ISO,
  },
  exploration: { maxStages: 4, maxActions: 40, maxDurationMs: 600_000, seed: 7 },
  synthesis: {
    targetStack: "web",
    allowNetwork: false,
    packagePolicy: "verified-only",
  },
  verification: {
    journeys: ["home"],
    visual: true,
    network: false,
    state: false,
    maxRepairIterations: 2,
  },
});

const happyScript: FakeScript = {
  sessionId: "11111111-2222-3333-4444-555555555555",
  pages: { "https://app.example/": PAGE, "https://app.example/about": PAGE_2 },
};

const refKinds = (bundle: EvidenceBundle) => bundle.refs.map((ref) => ref.kind);
const byKind = (bundle: EvidenceBundle, kind: string) =>
  bundle.refs.filter((ref) => ref.kind === kind);

// --- 1 -----------------------------------------------------------------------

test("observe collects available channels and marks the rest unavailable", async () => {
  const adapter = adapterOver(happyScript);
  const bundle = await adapter.observe(spec(["https://app.example/"]));
  assert.equal(bundle.targetId, "target-example");
  assert.equal(bundle.reconstructionId, "recon-w1-002");
  // All five channels are represented — as seven evidence kinds.
  assert.deepEqual(
    new Set(refKinds(bundle)),
    new Set(["dom-text", "page-meta", "screenshot", "dom-structure", "a11y", "network", "storage"]),
  );
  assert.deepEqual(OBSERVATION_CHANNEL_NAMES, ["dom", "a11y", "screenshot", "network", "storage"]);
  for (const name of OBSERVATION_CHANNEL_NAMES)
    assert.ok(
      bundle.refs.some((ref) => channelOfKind(ref.kind) === name),
      `channel ${name} is represented`,
    );
  // Exactly dom-text/page-meta/screenshot are observed.
  for (const ref of bundle.refs)
    assert.equal(
      ref.classification,
      ref.kind === "dom-text" || ref.kind === "page-meta" || ref.kind === "screenshot"
        ? "observed"
        : "unavailable",
      `kind ${ref.kind} must classify ${ref.kind === "dom-text" || ref.kind === "page-meta" || ref.kind === "screenshot" ? "observed" : "unavailable"}`,
    );
  // Unavailable refs carry precise source notes naming the missing worker capability.
  assert.match(
    byKind(bundle, "dom-structure")[0].source,
    /lacks a DOM structure snapshot endpoint/,
  );
  assert.match(byKind(bundle, "a11y")[0].source, /lacks an a11y snapshot endpoint/);
  assert.match(byKind(bundle, "network")[0].source, /lacks a network capture endpoint/);
  assert.match(byKind(bundle, "storage")[0].source, /lacks a storage state export endpoint/);
  // dom-text is stored as-is with the truncation fact in the source.
  assert.equal(adapter.evidenceBytes(byKind(bundle, "dom-text")[0]).length, PAGE.text.length);
  assert.doesNotMatch(byKind(bundle, "dom-text")[0].source, /truncated/);
  // Environment fingerprint asserts the observation environment honestly.
  assert.equal(bundle.environment.adapter, "@clapp/observation");
  assert.equal(bundle.environment.adapterVersion, "0.1.0");
  assert.deepEqual(bundle.environment.channels, [...OBSERVATION_CHANNEL_NAMES]);
  assert.deepEqual(bundle.environment.sessionIds, [happyScript.sessionId]);
  assert.equal(bundle.environment.startedAt, FIXED_ISO);
  assert.equal(bundle.environment.finishedAt, FIXED_ISO);
  assert.equal(bundle.environment.persisted, false);
});

// --- 2 -----------------------------------------------------------------------

test("evidence is content-addressed and complete", async () => {
  const adapter = adapterOver(happyScript);
  const bundle = await adapter.observe(spec(["https://app.example/"]));
  const refFields = [
    "id",
    "targetId",
    "reconstructionId",
    "kind",
    "sha256",
    "source",
    "capturedAt",
    "classification",
    "redacted",
  ];
  for (const ref of bundle.refs) {
    for (const field of refFields) assert.ok(field in ref, `ref field ${field} present`);
    assert.equal(typeof ref.id, "string");
    assert.equal(typeof ref.sha256, "string");
    assert.equal(ref.targetId, "target-example");
    assert.equal(ref.reconstructionId, "recon-w1-002");
    assert.equal(ref.capturedAt, FIXED_ISO);
    assert.equal(ref.redacted, false);
    // sha256 is the REAL digest of the stored bytes, computed independently here.
    assert.equal(ref.sha256, digestOf(adapter.evidenceBytes(ref)));
  }
  // Specific payloads: dom-text is the raw page text; page-meta is canonical {url,title}.
  assert.equal(byKind(bundle, "dom-text")[0].sha256, textDigest(PAGE.text));
  assert.equal(
    byKind(bundle, "page-meta")[0].sha256,
    sha256Hex(canonicalJsonBytes({ url: PAGE.url, title: PAGE.title })),
  );
  assert.equal(byKind(bundle, "screenshot")[0].sha256, digestOf(PNG_BYTES));
  // Unavailable refs are content-addressed manifests recording the precise reason.
  for (const ref of byKind(bundle, "a11y")) {
    const bytes = adapter.evidenceBytes(ref);
    assert.equal(ref.sha256, digestOf(bytes));
    const manifest = JSON.parse(new TextDecoder().decode(bytes)) as {
      kind: string;
      reason: string;
    };
    assert.equal(manifest.kind, "a11y");
    assert.match(manifest.reason, /a11y snapshot endpoint/);
  }
  // rootSha256 matches a stable recomputation over the id-sorted refs.
  const sorted = [...bundle.refs].sort((a, b) => a.id.localeCompare(b.id));
  assert.equal(bundle.rootSha256, sha256Hex(canonicalJsonBytes(sorted)));
  assert.equal(bundle.id, `clapp-observation:${bundle.rootSha256}`);
});

// --- 3 -----------------------------------------------------------------------

test("deterministic capture with fixed inputs", async () => {
  const first = await adapterOver(happyScript).observe(
    spec(["https://app.example/", "https://app.example/about"]),
  );
  const second = await adapterOver(happyScript).observe(
    spec(["https://app.example/", "https://app.example/about"]),
  );
  // Byte-identical under canonical serialization (which sorts keys recursively).
  assert.equal(canonicalJson(first), canonicalJson(second));
  assert.deepEqual(first, second);
  assert.equal(first.rootSha256, second.rootSha256);
  assert.equal(first.id, second.id);
  // capturedAt is derived from the injected clock, not wall time.
  assert.ok(first.refs.every((ref) => ref.capturedAt === FIXED_ISO));
  // A different page script changes the content digests (content addressing is real).
  const variant = await adapterOver({
    ...happyScript,
    pages: { ...happyScript.pages, "https://app.example/": { ...PAGE, text: "Different text" } },
  }).observe(spec(["https://app.example/"]));
  assert.notEqual(
    variant.rootSha256,
    (await adapterOver(happyScript).observe(spec(["https://app.example/"]))).rootSha256,
  );
});

// --- 4 -----------------------------------------------------------------------

test("multi-entrypoint observation", async () => {
  const adapter = adapterOver(happyScript);
  const bundle = await adapter.observe(spec(["https://app.example/", "https://app.example/about"]));
  // 7 evidence kinds per entrypoint, both entrypoints represented.
  assert.equal(bundle.refs.length, 14);
  assert.deepEqual(bundle.environment.entrypoints, [
    "https://app.example/",
    "https://app.example/about",
  ]);
  const perEntrypoint = bundle.environment.entrypointRefs as Record<string, string[]>;
  assert.deepEqual(Object.keys(perEntrypoint), [
    "https://app.example/",
    "https://app.example/about",
  ]);
  for (const entrypoint of spec(["https://app.example/", "https://app.example/about"])
    .entrypoints) {
    const ids = perEntrypoint[entrypoint];
    assert.equal(ids.length, 7, `entrypoint ${entrypoint} captures all channels`);
    for (const id of ids) assert.ok(bundle.refs.some((ref) => ref.id === id));
  }
  // One shared session, navigated per entrypoint, ordered deterministically.
  assert.deepEqual(bundle.environment.sessionIds, [happyScript.sessionId]);
  assert.equal(bundle.environment.entrypointCount, 2);
  // Refs are deterministically ordered by id.
  const ids = bundle.refs.map((ref) => ref.id);
  assert.deepEqual(
    ids,
    [...ids].sort((a, b) => a.localeCompare(b)),
  );
  // Deterministic across runs.
  const again = await adapterOver(happyScript).observe(
    spec(["https://app.example/", "https://app.example/about"]),
  );
  assert.equal(bundle.rootSha256, again.rootSha256);
});

// --- 5 -----------------------------------------------------------------------

test("abort produces typed error not partial success", async () => {
  const controller = new AbortController();
  const handle = fakeHandle(happyScript);
  // Abort mid-script: the signal fires while the create call is in flight.
  const originalCreate = handle.create.bind(handle);
  handle.create = async (owner: string, url: string) => {
    controller.abort();
    return originalCreate(owner, url);
  };
  const adapter = createBrowserObservationAdapter({
    ownerId: OWNER,
    browser: handle,
    now: fixedClock,
  });
  await assert.rejects(
    adapter.observe(spec(["https://app.example/"]), controller.signal),
    (error: unknown) => {
      assert.ok(error instanceof ClappObservationAbortError, "typed abort error");
      assert.ok(error instanceof ClappObservationError);
      assert.equal(error.name, "ClappObservationAbortError");
      assert.match(error.where, /^create:/);
      assert.match(error.message, /aborted/);
      return true;
    },
  );
  // Pre-aborted signals fail before any seam call.
  const dead = new AbortController();
  dead.abort();
  assert.equal(handle.calls.filter((call) => call.capability === "create").length, 1);
  await assert.rejects(
    adapterOver(happyScript).observe(spec(["https://app.example/"]), dead.signal),
    (error: unknown) => {
      assert.ok(error instanceof ClappObservationAbortError);
      return true;
    },
  );
  // The opt-in partial result is the ONLY way an aborted run yields a bundle.
  const partialController = new AbortController();
  const multi = fakeHandle(happyScript);
  const originalNavigate = multi.navigate.bind(multi);
  multi.navigate = async (owner: string, id: string, url: string) => {
    if (url === "https://app.example/about") partialController.abort();
    return originalNavigate(owner, id, url);
  };
  const partialAdapter = createBrowserObservationAdapter({
    ownerId: OWNER,
    browser: multi,
    now: fixedClock,
  });
  const partial = await partialAdapter.observePartial(
    spec(["https://app.example/", "https://app.example/about"]),
    partialController.signal,
  );
  assert.equal(partial.aborted, true);
  assert.deepEqual(partial.completedEntrypoints, ["https://app.example/"]);
  assert.deepEqual(partial.pendingEntrypoints, ["https://app.example/about"]);
  assert.equal(partial.bundle.environment.aborted, true);
  assert.deepEqual(partial.bundle.environment.pendingEntrypoints, ["https://app.example/about"]);
  assert.equal(
    partial.bundle.refs.length,
    7,
    "only the completed entrypoint's refs are in the partial bundle",
  );
});

// --- 6 -----------------------------------------------------------------------

test("redaction copies and marks without mutating the original", async () => {
  const adapter = adapterOver(happyScript);
  const original = await adapter.observe(spec(["https://app.example/"]));
  const originalSnapshot = canonicalJson(original);
  const domTextRef = byKind(original, "dom-text")[0];
  const screenshotRef = byKind(original, "screenshot")[0];
  const { bundle: redactedBundle, record } = redact(original, {
    kinds: ["dom-text"],
    idPrefixes: [screenshotRef.id],
  });
  // The original is untouched.
  assert.equal(canonicalJson(original), originalSnapshot);
  assert.equal(original.refs.filter((ref) => ref.redacted).length, 0);
  assert.equal(domTextRef.redacted, false);
  // The redacted bundle is a new object with both rules applied.
  assert.notEqual(redactedBundle, original);
  assert.equal(record.redactedRefCount, 2);
  assert.deepEqual(record.redactedRefIds.sort(), [domTextRef.id, screenshotRef.id].sort());
  const redactedDomText = byKind(redactedBundle, "dom-text")[0];
  const redactedScreenshot = byKind(redactedBundle, "screenshot")[0];
  const untouchedMeta = byKind(redactedBundle, "page-meta")[0];
  assert.equal(redactedDomText.redacted, true);
  assert.equal(redactedScreenshot.redacted, true);
  assert.equal(untouchedMeta.redacted, false);
  assert.equal(untouchedMeta.sha256, byKind(original, "page-meta")[0].sha256);
  // Identity fields survive redaction; source records it honestly.
  assert.equal(redactedDomText.id, domTextRef.id);
  assert.equal(redactedDomText.kind, "dom-text");
  assert.equal(redactedDomText.capturedAt, domTextRef.capturedAt);
  assert.equal(redactedDomText.classification, "observed");
  assert.match(redactedDomText.source, /^redacted:/);
  // Marker payloads: identical shape (text stays text, screenshot stays PNG) and truly content-addressed.
  assert.equal(redactedDomText.sha256, digestOf(redactionMarkerPayload(domTextRef)));
  assert.equal(redactedScreenshot.sha256, digestOf(redactionMarkerPayload(screenshotRef)));
  const domTextMarker = new TextDecoder().decode(redactionMarkerPayload(domTextRef));
  const markerDoc = JSON.parse(domTextMarker) as {
    clapp: string;
    originalSha256: string;
    kind: string;
  };
  assert.equal(markerDoc.clapp, "redaction-marker");
  assert.equal(markerDoc.originalSha256, domTextRef.sha256);
  assert.equal(markerDoc.kind, "dom-text");
  const screenshotMarker = redactionMarkerPayload(screenshotRef);
  assert.equal(screenshotMarker[0], 0x89, "screenshot marker is still a PNG payload");
  assert.equal(screenshotMarker[1], 0x50);
  // rootSha256 is recomputed over the redacted refs.
  assert.notEqual(redactedBundle.rootSha256, original.rootSha256);
  const sorted = [...redactedBundle.refs].sort((a, b) => a.id.localeCompare(b.id));
  assert.equal(redactedBundle.rootSha256, sha256Hex(canonicalJsonBytes(sorted)));
  // The environment carries an honest, deterministic redaction record.
  const environmentRecord = redactedBundle.environment.redaction as {
    clapp: string;
    redactedRefCount: number;
    redactedRefIds: string[];
  };
  assert.equal(environmentRecord.clapp, "redaction");
  assert.equal(environmentRecord.redactedRefCount, 2);
  assert.deepEqual(
    environmentRecord.redactedRefIds.sort(),
    [domTextRef.id, screenshotRef.id].sort(),
  );
  // Redacting again with the same rules is deterministic.
  const second = redact(original, { kinds: ["dom-text"], idPrefixes: [screenshotRef.id] });
  assert.equal(second.bundle.rootSha256, redactedBundle.rootSha256);
  // Rules that match nothing fail closed instead of silently returning the original.
  assert.throws(() => redact(original, { kinds: ["no-such-kind"] }), ClappObservationError);
});

// --- 7 -----------------------------------------------------------------------

test("bind validation fails closed", async () => {
  // Missing read() → typed error naming the capability.
  const withoutRead = {
    create: async () => ({ id: "s" }),
    navigate: async () => ({ id: "s" }),
  };
  assert.throws(
    () => createBrowserObservationAdapter({ ownerId: OWNER, browser: withoutRead }),
    (error: unknown) => {
      assert.ok(error instanceof ClappObservationError);
      assert.equal(error.capability, "read");
      assert.match(error.message, /missing the required capability "read"/);
      assert.match(error.message, /fails closed/);
      return true;
    },
  );
  // Not an object at all → seam-level typed error.
  assert.throws(
    () => createBrowserObservationAdapter({ ownerId: OWNER, browser: null }),
    (error: unknown) => {
      assert.ok(error instanceof ClappObservationError);
      assert.equal(error.capability, "browser-seam");
      return true;
    },
  );
  // Malformed optional capability (preview not a function) still fails the bind.
  assert.throws(
    () =>
      createBrowserObservationAdapter({
        ownerId: OWNER,
        browser: {
          create: async () => ({ id: "s" }),
          navigate: async () => ({ id: "s" }),
          read: async () => PAGE,
          preview: "nope",
        },
      }),
    (error: unknown) => {
      assert.ok(error instanceof ClappObservationError);
      assert.equal(error.capability, "preview");
      return true;
    },
  );
  // Absent ownerId fails closed before the handle is even consulted.
  assert.throws(
    () => createBrowserObservationAdapter({ ownerId: "", browser: fakeHandle(happyScript) }),
    (error: unknown) => {
      assert.ok(error instanceof ClappObservationError);
      assert.equal(error.capability, "ownerId");
      return true;
    },
  );
  // A seam without preview binds and degrades the screenshot channel honestly.
  const noPreview = adapterOver({ ...happyScript, noPreview: true });
  const bundle = await noPreview.observe(spec(["https://app.example/"]));
  const screenshotRef = byKind(bundle, "screenshot")[0];
  assert.equal(screenshotRef.classification, "unavailable");
  assert.equal(screenshotRef.source, "browser-worker screenshot() png");
  const screenshotManifest = JSON.parse(
    new TextDecoder().decode(noPreview.evidenceBytes(screenshotRef)),
  ) as { reason: string };
  assert.match(screenshotManifest.reason, /no preview method/);
  // Owner mismatch and non-web platform fail closed at observe time.
  const foreign = spec(["https://app.example/"]);
  foreign.authorization = { ...foreign.authorization, ownerId: "someone-else" };
  await assert.rejects(noPreview.observe(foreign), (error: unknown) => {
    assert.ok(error instanceof ClappObservationError);
    assert.equal(error.capability, "authorization");
    return true;
  });
  const android = spec(["https://app.example/"], "recon-android");
  android.platform = "android";
  await assert.rejects(noPreview.observe(android), (error: unknown) => {
    assert.ok(error instanceof ClappObservationError);
    assert.equal(error.capability, "platform");
    return true;
  });
});

// --- 8 -----------------------------------------------------------------------

test("unavailable channels are explicit in the channel registry", async () => {
  assert.ok(Object.isFrozen(OBSERVATION_CHANNELS));
  assert.ok(Object.isFrozen(OBSERVATION_CHANNEL_NAMES));
  assert.deepEqual(OBSERVATION_CHANNEL_NAMES, ["dom", "a11y", "screenshot", "network", "storage"]);
  const availableKinds = OBSERVATION_CHANNELS.filter((item) => item.available).map(
    (item) => item.kind,
  );
  const unavailableKinds = OBSERVATION_CHANNELS.filter((item) => !item.available).map(
    (item) => item.kind,
  );
  assert.deepEqual(availableKinds, ["dom-text", "page-meta", "screenshot"]);
  assert.deepEqual(unavailableKinds, ["dom-structure", "a11y", "network", "storage"]);
  // Every descriptor carries a precise source note.
  for (const item of OBSERVATION_CHANNELS) assert.ok(item.sourceNote.length > 0);
  // Registry availability matches the bundle classifications from test 1's happy path.
  const bundle = await adapterOver(happyScript).observe(spec(["https://app.example/"]));
  for (const ref of bundle.refs) {
    const descriptor = OBSERVATION_CHANNELS.find((item) => item.kind === ref.kind);
    assert.ok(descriptor, `kind ${ref.kind} is registered`);
    assert.equal(
      ref.classification === "observed",
      descriptor.available,
      `registry availability for ${ref.kind} matches classification ${ref.classification}`,
    );
    if (!descriptor.available) assert.equal(ref.source, descriptor.sourceNote);
  }
});

// --- 9 (integration: real BrowserService against a stub worker) --------------

let store: Store;
let directory: string;
let worker: Server;
let workerPort = 0;
const WORKER_TOKEN = "stub-worker-token-0123456789abcdef0123456789";

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "openmuse-clapp-w1-002-"));
  store = await createStore({ dataDir: join(directory, "db") });
  // A stub browser worker implementing the substrate's HTTP contract:
  // POST /sessions, GET /sessions/:id/read, GET /sessions/:id/screenshot.
  const sessions = new Map<string, { url: string }>();
  worker = createServer((request, response) => {
    const sendJson = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(body));
    };
    const url = new URL(request.url ?? "/", "http://stub-worker");
    if (request.headers.authorization !== `Bearer ${WORKER_TOKEN}`) {
      sendJson(401, {
        error: { code: "UNAUTHORIZED", message: "Worker authentication is required." },
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/sessions") {
      let body = "";
      request.on("data", (chunk) => {
        body += String(chunk);
      });
      request.on("end", () => {
        const payload = JSON.parse(body) as { id: string; url: string };
        sessions.set(payload.id, { url: payload.url });
        sendJson(201, {
          id: payload.id,
          title: "Stub page",
          url: payload.url,
          status: "active",
          updatedAt: FIXED_ISO,
        });
      });
      return;
    }
    const match = /^\/sessions\/([^/]+)\/(read|screenshot)$/.exec(url.pathname);
    const id = match?.[1];
    if (!id || !sessions.has(id)) {
      sendJson(404, {
        error: { code: "SESSION_NOT_FOUND", message: "Browser session not found." },
      });
      return;
    }
    if (match?.[2] === "read" && request.method === "GET") {
      sendJson(200, {
        url: "https://app.example/",
        title: PAGE.title,
        text: PAGE.text,
        truncated: false,
      });
      return;
    }
    if (match?.[2] === "screenshot" && request.method === "GET") {
      response.writeHead(200, { "content-type": "image/png", "content-length": PNG_BYTES.length });
      response.end(PNG_BYTES);
      return;
    }
    sendJson(404, { error: { code: "NOT_FOUND", message: "Worker endpoint not found." } });
  });
  await new Promise<void>((resolve) => worker.listen(0, "127.0.0.1", resolve));
  workerPort = (worker.address() as { port: number }).port;
});

after(async () => {
  await new Promise<void>((resolve) => {
    worker.closeAllConnections?.();
    worker.close(() => resolve());
  });
  await store?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("integration: real BrowserService against stub worker", async () => {
  const config: Config = {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "sample",
    intelligenceApiKey: "test-project-key-never-sent",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: ["http://localhost:8081"],
    workerUrl: `http://127.0.0.1:${workerPort}`,
    workerToken: WORKER_TOKEN,
  };
  const auth = new Auth(store, config, "w1-002-integration-signing-key");
  const files = new Files(store, config, auth);
  const browserService = new BrowserService(store, config, auth, files);
  // The adapter binds the REAL BrowserService through the structural seam.
  const adapter = createBrowserObservationAdapter({
    ownerId: OWNER,
    browser: browserService,
    now: fixedClock,
  });
  const bundle = await adapter.observe(spec(["https://app.example/"], "recon-w1-002-integration"));
  // Same assertions as tests 1-2: all five channels, honest classifications.
  assert.deepEqual(
    new Set(refKinds(bundle)),
    new Set(["dom-text", "page-meta", "screenshot", "dom-structure", "a11y", "network", "storage"]),
  );
  for (const ref of bundle.refs)
    assert.equal(
      ref.classification,
      ref.kind === "dom-text" || ref.kind === "page-meta" || ref.kind === "screenshot"
        ? "observed"
        : "unavailable",
    );
  assert.match(byKind(bundle, "a11y")[0].source, /lacks an a11y snapshot endpoint/);
  assert.match(byKind(bundle, "storage")[0].source, /lacks a storage state export endpoint/);
  // Content addressing over the bytes that traveled the real HTTP seam.
  for (const ref of bundle.refs) assert.equal(ref.sha256, digestOf(adapter.evidenceBytes(ref)));
  assert.equal(byKind(bundle, "dom-text")[0].sha256, textDigest(PAGE.text));
  assert.equal(byKind(bundle, "screenshot")[0].sha256, digestOf(PNG_BYTES));
  assert.equal(
    byKind(bundle, "page-meta")[0].sha256,
    sha256Hex(utf8(canonicalJson({ url: PAGE.url, title: PAGE.title }))),
  );
  // rootSha256 recomputes stably.
  const sorted = [...bundle.refs].sort((a, b) => a.id.localeCompare(b.id));
  assert.equal(bundle.rootSha256, sha256Hex(canonicalJsonBytes(sorted)));
  // The environment records the real session established through BrowserService.create.
  assert.equal((bundle.environment.sessionIds as string[]).length, 1);
  assert.equal(bundle.environment.adapter, "@clapp/observation");
  assert.equal(bundle.environment.platform, "web");
  // Ref completeness.
  for (const ref of bundle.refs) {
    assert.equal(ref.targetId, "target-example");
    assert.equal(ref.reconstructionId, "recon-w1-002-integration");
    assert.equal(typeof ref.source, "string");
    assert.equal(typeof ref.capturedAt, "string");
    assert.equal(ref.redacted, false);
  }
});
