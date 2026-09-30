import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type {
  ReconstructionSpec,
  TargetAuthorization,
} from "../packages/clapp-contracts/src/index.ts";
import {
  AUTHORIZATION_RECORD_ID_PREFIX,
  type AuthorizationGateDependencies,
  type AuthorizationRecord,
  type AuthorizationStore,
  authorizationRecordKey,
  authorizeTarget,
  ClappObservationAbortError,
  ClappObservationError,
  canonicalJson,
  createGatedBrowserObservationAdapter,
  type PageSnapshot,
} from "../packages/clapp-observation/src/index.ts";

/**
 * CLAPP-W1-008 — target authorization persistence.
 *
 * Contract (docs/clapp/SECURITY.md, "Authorization"): before target
 * observation, persist an authorization record — target owner; authorized
 * scope; allowed environments; allowed artifact retention; expiry; operator
 * identity — and observation fails closed without a valid unexpired record.
 * Benchmarks owned by CLAPP may use implicit benchmark authorization, which
 * still persists a (marked) record before observation.
 *
 * Unit tests bind the gated adapter to a FAKE browser handle implementing
 * the structural seam (no network, no Chromium — the W1-002 fake-seam
 * pattern) and an in-memory store port; the clock is pinned (FIXED_MS, the
 * W1-002 FIXED_MS pattern) so expiry is deterministic. The battery-level
 * half of test 8 — the FROZEN tests/clapp-w1-002-observation.test.ts
 * passing unmodified — is confirmed in the delivery record.
 */

const OWNER = "local-user";
const OPERATOR = "operator-w1-008";
const ENVIRONMENT = "web";
const TARGET = "target-example";
const FIXED_MS = 1735689600000; // 2025-01-01T00:00:00.000Z — pinned clock for deterministic expiry
const FIXED_ISO = new Date(FIXED_MS).toISOString();
const fixedClock = () => FIXED_MS;

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

function fakeHandle(script: FakeScript, log: string[]) {
  const calls: { capability: string; owner: string; sessionId?: string; url?: string }[] = [];
  const asFailure = (message?: string) => {
    if (message) throw new Error(message);
  };
  const handle = {
    calls,
    currentUrl: "about:blank",
    async create(owner: string, url: string) {
      calls.push({ capability: "create", owner, url });
      log.push("seam:create");
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
      log.push("seam:navigate");
      asFailure(script.fail?.navigate);
      handle.currentUrl = url;
      return { id, title: "New browser session", url, status: "idle", updatedAt: FIXED_ISO };
    },
    async read(owner: string, id: string) {
      calls.push({ capability: "read", owner, sessionId: id });
      log.push("seam:read");
      asFailure(script.fail?.read);
      const page = script.pages[handle.currentUrl];
      if (!page) throw new Error(`fake handle has no scripted page for ${handle.currentUrl}`);
      return { ...page };
    },
    async preview(owner: string, id: string) {
      calls.push({ capability: "preview", owner, sessionId: id });
      log.push("seam:preview");
      asFailure(script.fail?.screenshot);
      return {
        arrayBuffer: async () => PNG_BYTES.slice().buffer as ArrayBuffer,
      };
    },
  };
  if (script.noPreview) delete (handle as { preview?: unknown }).preview;
  return handle;
}

const happyScript: FakeScript = {
  sessionId: "11111111-2222-3333-4444-555555555555",
  pages: { "https://app.example/": PAGE, "https://app.example/about": PAGE_2 },
};

/** An in-memory AuthorizationStore port: exactly get and put, recording activity. */
function createMemoryStore(log: string[] = []) {
  const records = new Map<string, AuthorizationRecord>();
  const puts: { key: string; record: AuthorizationRecord }[] = [];
  const store: AuthorizationStore = {
    async get(key) {
      log.push(`authz:get:${key}`);
      return records.get(key);
    },
    async put(key, record) {
      puts.push({ key, record });
      records.set(key, record);
      log.push(`authz:put:${key}`);
    },
  };
  return { store, puts, records };
}

const authorization = (overrides: Partial<TargetAuthorization> = {}): TargetAuthorization => ({
  ownerId: OWNER,
  targetId: TARGET,
  scope: ["observe"],
  environments: [ENVIRONMENT],
  retention: "ephemeral",
  benchmarkOwned: false,
  createdAt: FIXED_ISO,
  ...overrides,
});

/** Builds runtime-malformed authorizations the frozen type cannot express. */
const variant = (
  overrides: Partial<Record<keyof TargetAuthorization, unknown>>,
): TargetAuthorization => ({ ...authorization(), ...overrides }) as unknown as TargetAuthorization;

const spec = (
  entrypoints: string[] = ["https://app.example/"],
  auth: TargetAuthorization = authorization(),
  reconstructionId = "recon-w1-008",
): ReconstructionSpec => ({
  specVersion: "0.1",
  reconstructionId,
  targetId: auth.targetId,
  name: "Example App",
  platform: "web",
  entrypoints,
  authorization: auth,
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

/** A gated adapter bound to the fake seam, an empty in-memory store, the pinned clock. */
function createRig(overrides: Partial<AuthorizationGateDependencies> = {}) {
  const log: string[] = [];
  const handle = fakeHandle(happyScript, log);
  const memory = createMemoryStore(log);
  const gate = createGatedBrowserObservationAdapter({
    ownerId: OWNER,
    browser: handle,
    now: fixedClock,
    environment: ENVIRONMENT,
    operatorIdentity: OPERATOR,
    store: memory.store,
    ...overrides,
  });
  return { gate, handle, memory, log };
}

/** Asserts a fail-closed authorization refusal: typed error, capability, message. */
const refusal =
  (pattern: RegExp) =>
  (error: unknown): boolean => {
    assert.ok(error instanceof ClappObservationError, "refusal is a ClappObservationError");
    assert.equal(error.capability, "authorization", 'capability is "authorization"');
    assert.match(error.message, pattern);
    return true;
  };

// --- 1 -----------------------------------------------------------------------

test("observation fails closed without a persisted record", async () => {
  const { gate, handle, memory } = createRig();
  const target = spec();
  // No stored record: both observe and observePartial refuse BEFORE any
  // browser seam call.
  await assert.rejects(
    gate.observe(target),
    refusal(/no persisted authorization record for target "target-example"/),
  );
  await assert.rejects(
    gate.observePartial(target),
    refusal(/no persisted authorization record for target "target-example"/),
  );
  assert.equal(handle.calls.length, 0, "the gate refuses before any browser seam call");
  assert.equal(memory.puts.length, 0, "the refusal persisted nothing");
  // The in-memory spec object alone is not authorization — a record that was
  // never stored does not exist until the authorize path persists it.
  const record = await authorizeTarget(target, { operatorIdentity: OPERATOR, store: memory.store });
  assert.equal(memory.puts.length, 1, "the authorize path persisted the record");
  assert.ok(record.id.startsWith(AUTHORIZATION_RECORD_ID_PREFIX));
  // The same observe() run now captures evidence normally.
  const bundle = await gate.observe(target);
  assert.equal(bundle.targetId, "target-example");
  assert.equal(bundle.reconstructionId, "recon-w1-008");
  assert.equal(bundle.refs.length, 7, "the W1-002 happy path captures all seven evidence kinds");
  assert.ok(handle.calls.length > 0, "capture runs once the record is stored");
});

// --- 2 -----------------------------------------------------------------------

test("expired authorization fails closed", async () => {
  // Strictly before the pinned instant: refused, naming the expiry.
  const expiredAt = new Date(FIXED_MS - 1).toISOString();
  const expired = createRig();
  const expiredSpec = spec(
    undefined,
    authorization({ targetId: "target-expired", expiresAt: expiredAt }),
  );
  await authorizeTarget(expiredSpec, { operatorIdentity: OPERATOR, store: expired.memory.store });
  await assert.rejects(expired.gate.observe(expiredSpec), (error: unknown) => {
    assert.ok(error instanceof ClappObservationError);
    assert.equal(error.capability, "authorization");
    assert.match(error.message, /expired at/);
    assert.ok(error.message.includes(expiredAt), "the refusal names the expiry");
    return true;
  });
  assert.equal(expired.handle.calls.length, 0, "nothing is captured for an expired record");
  // Exactly at the evaluation instant: not strictly before, so it passes.
  const atInstant = createRig();
  const atSpec = spec(
    undefined,
    authorization({ targetId: "target-at-instant", expiresAt: new Date(FIXED_MS).toISOString() }),
  );
  await authorizeTarget(atSpec, { operatorIdentity: OPERATOR, store: atInstant.memory.store });
  assert.equal((await atInstant.gate.observe(atSpec)).refs.length, 7);
  // After the instant: passes.
  const after = createRig();
  const afterSpec = spec(
    undefined,
    authorization({ targetId: "target-after", expiresAt: new Date(FIXED_MS + 1).toISOString() }),
  );
  await authorizeTarget(afterSpec, { operatorIdentity: OPERATOR, store: after.memory.store });
  assert.equal((await after.gate.observe(afterSpec)).refs.length, 7);
  // A record with no expiresAt never expires.
  const noExpiry = createRig();
  const noExpirySpec = spec(undefined, authorization({ targetId: "target-no-expiry" }));
  await authorizeTarget(noExpirySpec, { operatorIdentity: OPERATOR, store: noExpiry.memory.store });
  assert.equal((await noExpiry.gate.observe(noExpirySpec)).refs.length, 7);
});

// --- 3 -----------------------------------------------------------------------

test("owner and environment mismatches fail closed", async () => {
  // A stored record whose target owner differs from the binding's owner.
  const ownerRig = createRig();
  const foreignSpec = spec(
    undefined,
    authorization({ targetId: "target-foreign-owner", ownerId: "someone-else" }),
  );
  await authorizeTarget(foreignSpec, { operatorIdentity: OPERATOR, store: ownerRig.memory.store });
  await assert.rejects(ownerRig.gate.observe(foreignSpec), (error: unknown) => {
    assert.ok(error instanceof ClappObservationError);
    assert.equal(error.capability, "authorization");
    assert.match(error.message, /authorizes owner "someone-else"/);
    assert.match(error.message, /observation binding's owner is "local-user"/);
    return true;
  });
  assert.equal(ownerRig.handle.calls.length, 0, "nothing is captured on an owner mismatch");
  // A stored record whose allowed environments exclude the requested one.
  const envRig = createRig({ environment: "staging" });
  const envSpec = spec(
    undefined,
    authorization({ targetId: "target-env", environments: ["production"] }),
  );
  await authorizeTarget(envSpec, { operatorIdentity: OPERATOR, store: envRig.memory.store });
  await assert.rejects(envRig.gate.observe(envSpec), (error: unknown) => {
    assert.ok(error instanceof ClappObservationError);
    assert.equal(error.capability, "authorization");
    assert.match(error.message, /allows environments \[production\]/);
    assert.match(error.message, /requested environment "staging"/);
    return true;
  });
  assert.equal(envRig.handle.calls.length, 0, "nothing is captured on an environment mismatch");
});

// --- 4 -----------------------------------------------------------------------

test("records persist before observation and are content-addressed", async () => {
  const { gate, memory } = createRig();
  const auth = authorization({ scope: ["beta", "alpha"], environments: ["web", "dev"] });
  const target = spec(undefined, auth);
  const authorizationSnapshot = canonicalJson(auth);
  // The authorize path puts the record through the port BEFORE any capture
  // can run: without a stored record the run refuses (test 1); with one it
  // captures — and the stored record is retrievable first.
  const record = await authorizeTarget(target, { operatorIdentity: OPERATOR, store: memory.store });
  assert.equal(memory.puts.length, 1, "the authorize path puts the record through the port");
  assert.equal(memory.puts[0]?.key, authorizationRecordKey("target-example"));
  assert.ok(record.id.startsWith(AUTHORIZATION_RECORD_ID_PREFIX));
  assert.match(record.id, /^clapp_authz_[0-9a-f]{16}$/);
  // SECURITY.md's six fields, the target linkage, and the derivation facts.
  assert.equal(record.targetId, "target-example");
  assert.equal(record.ownerId, OWNER);
  assert.equal(record.retention, "ephemeral");
  assert.equal(record.operatorIdentity, OPERATOR);
  assert.equal(record.authorizationKind, "explicit");
  assert.equal(record.benchmarkOwned, false);
  assert.equal(
    record.grantedAt,
    FIXED_ISO,
    "grantedAt is the caller-supplied createdAt, never clock-derived",
  );
  assert.deepEqual(record.scope, ["alpha", "beta"], "scope is stored canonically (sorted)");
  assert.deepEqual(record.environments, ["dev", "web"], "environments stored canonically (sorted)");
  assert.deepEqual(await memory.store.get(authorizationRecordKey("target-example")), record);
  assert.equal((await gate.observe(target)).refs.length, 7);
  // The spec's frozen authorization object is never mutated or rewritten.
  assert.equal(canonicalJson(auth), authorizationSnapshot);
  assert.deepEqual(auth.scope, ["beta", "alpha"]);
  // The same authorization re-run produces a byte-identical record, same id.
  const secondStore = createMemoryStore();
  const second = await authorizeTarget(target, {
    operatorIdentity: OPERATOR,
    store: secondStore.store,
  });
  assert.deepEqual(second, record);
  assert.equal(second.id, record.id);
  assert.equal(canonicalJson(second), canonicalJson(record), "byte-identical records");
  // Scope and environment array order never leaks into the id: the core is
  // canonical.
  const reordered = await authorizeTarget(
    spec(undefined, authorization({ scope: ["alpha", "beta"], environments: ["dev", "web"] })),
    { operatorIdentity: OPERATOR, store: createMemoryStore().store },
  );
  assert.equal(reordered.id, record.id);
  assert.deepEqual(reordered, record);
  // Different content produces a different id (content addressing is real).
  const different = await authorizeTarget(
    spec(
      undefined,
      authorization({ scope: ["alpha", "beta", "gamma"], environments: ["dev", "web"] }),
    ),
    { operatorIdentity: OPERATOR, store: createMemoryStore().store },
  );
  assert.notEqual(different.id, record.id);
});

// --- 5 -----------------------------------------------------------------------

test("implicit benchmark authorization still persists a record", async () => {
  // The authorize path persists the marked record through the same port.
  const authorized = createRig();
  const benchSpec = spec(
    undefined,
    authorization({ targetId: "target-benchmark", benchmarkOwned: true }),
  );
  const record = await authorizeTarget(benchSpec, {
    operatorIdentity: OPERATOR,
    store: authorized.memory.store,
  });
  assert.equal(record.authorizationKind, "implicit-benchmark", "the record is marked");
  assert.equal(record.benchmarkOwned, true);
  assert.equal(record.operatorIdentity, OPERATOR);
  assert.equal(
    (await authorized.gate.observe(benchSpec)).refs.length,
    7,
    "passes the same precondition and captures",
  );
  // No authorize call at all: the gate persists the implicit record itself
  // BEFORE observation — there is no bypass around the port.
  const implicit = createRig();
  const implicitSpec = spec(
    undefined,
    authorization({ targetId: "target-benchmark-implicit", benchmarkOwned: true }),
  );
  assert.equal((await implicit.gate.observe(implicitSpec)).refs.length, 7);
  assert.equal(implicit.memory.puts.length, 1, "the implicit path persisted through the same port");
  const persisted = await implicit.memory.store.get(
    authorizationRecordKey("target-benchmark-implicit"),
  );
  assert.ok(persisted, "the implicit record is stored");
  assert.equal(persisted.authorizationKind, "implicit-benchmark");
  assert.equal(persisted.operatorIdentity, OPERATOR, "the gate's operator identity is recorded");
  const firstPut = implicit.log.indexOf("authz:put:target-benchmark-implicit");
  const firstSeam = implicit.log.findIndex((entry) => entry.startsWith("seam:"));
  assert.ok(firstPut >= 0, "a put was recorded");
  assert.ok(firstSeam > firstPut, "the record is persisted before any browser seam call");
  // The same precondition applies to the implicit record — no bypass.
  const wrongEnvironment = createRig({ environment: "staging" });
  const narrowSpec = spec(
    undefined,
    authorization({
      targetId: "target-benchmark-narrow",
      benchmarkOwned: true,
      environments: ["production"],
    }),
  );
  await assert.rejects(
    wrongEnvironment.gate.observe(narrowSpec),
    refusal(/requested environment "staging"/),
  );
  assert.equal(wrongEnvironment.handle.calls.length, 0, "nothing is captured");
  assert.equal(wrongEnvironment.memory.puts.length, 1, "the implicit record was persisted first");
  // Non-benchmark targets are never silently minted: without a stored record
  // there is no code path that observes.
  const plain = createRig();
  await assert.rejects(plain.gate.observe(spec()), refusal(/no persisted authorization record/));
  assert.equal(plain.memory.puts.length, 0);
  assert.equal(plain.handle.calls.length, 0);
});

// --- 6 -----------------------------------------------------------------------

test("malformed authorizations fail closed with collected errors", async () => {
  const { gate, handle, memory } = createRig();
  // One authorization violating every rule at once: every violation is named.
  const everything = variant({
    ownerId: "",
    targetId: "",
    scope: [],
    environments: [],
    expiresAt: "not-a-timestamp",
    retention: "forever",
  });
  await assert.rejects(
    authorizeTarget(spec(undefined, everything), { operatorIdentity: "", store: memory.store }),
    (error: unknown) => {
      assert.ok(error instanceof ClappObservationError);
      assert.equal(error.capability, "authorization");
      for (const violation of [
        "target owner is missing",
        "target id is missing",
        "authorized scope is empty",
        "allowed environments is empty",
        'artifact retention "forever" is outside the frozen union',
        'expiresAt "not-a-timestamp" is not a parseable timestamp',
        "operator identity is empty",
      ])
        assert.ok(error.message.includes(violation), `the message names: ${violation}`);
      return true;
    },
  );
  assert.equal(memory.puts.length, 0, "nothing is persisted for a malformed authorization");
  // Individual violations each fail closed with a precise message.
  const absentOwner = authorization();
  delete (absentOwner as { ownerId?: string }).ownerId;
  const cases: { label: string; auth: TargetAuthorization; operator: string; pattern: RegExp }[] = [
    {
      label: "empty ownerId",
      auth: authorization({ ownerId: "" }),
      operator: OPERATOR,
      pattern: /target owner is missing/,
    },
    {
      label: "absent ownerId",
      auth: absentOwner,
      operator: OPERATOR,
      pattern: /target owner is missing/,
    },
    {
      label: "empty targetId",
      auth: authorization({ targetId: "" }),
      operator: OPERATOR,
      pattern: /target id is missing/,
    },
    {
      label: "empty scope",
      auth: authorization({ scope: [] }),
      operator: OPERATOR,
      pattern: /authorized scope is empty/,
    },
    {
      label: "empty environments",
      auth: authorization({ environments: [] }),
      operator: OPERATOR,
      pattern: /allowed environments is empty/,
    },
    {
      label: "retention outside the union",
      auth: variant({ retention: "annual" }),
      operator: OPERATOR,
      pattern: /artifact retention "annual" is outside the frozen union/,
    },
    {
      label: "unparseable expiresAt",
      auth: authorization({ expiresAt: "eventually" }),
      operator: OPERATOR,
      pattern: /expiresAt "eventually" is not a parseable timestamp/,
    },
    {
      label: "empty operator identity",
      auth: authorization(),
      operator: "",
      pattern: /operator identity is empty/,
    },
  ];
  for (const item of cases) {
    await assert.rejects(
      authorizeTarget(spec(undefined, item.auth), {
        operatorIdentity: item.operator,
        store: memory.store,
      }),
      refusal(item.pattern),
    );
  }
  // The gate's implicit path validates too: a malformed benchmark
  // authorization never persists and never captures.
  const malformedBenchmark = variant({
    targetId: "target-bad-benchmark",
    benchmarkOwned: true,
    scope: [],
  });
  await assert.rejects(
    gate.observe(spec(undefined, malformedBenchmark)),
    refusal(/authorized scope is empty/),
  );
  assert.equal(handle.calls.length, 0, "nothing is captured");
  assert.equal(memory.puts.length, 0, "the port stays empty");
  assert.equal(memory.records.size, 0, "the port holds no records at all");
});

// --- 7 -----------------------------------------------------------------------

test("the module performs no I/O and keeps the port narrow", () => {
  const source = readFileSync(
    new URL("../packages/clapp-observation/src/authorization.ts", import.meta.url),
    "utf8",
  );
  // No Node built-in imports at all — no filesystem, network or process
  // access can even be imported.
  assert.doesNotMatch(source, /from\s+"node:/, "imports no Node built-ins at all");
  assert.doesNotMatch(source, /\bfetch\s*\(/, "performs no network fetch");
  // The clock is the injected `now` only: the module never invokes the wall
  // clock directly (behavioral proof: the pinned clock of test 2 governs
  // expiry). Date.parse of the caller-supplied expiresAt is pure parsing,
  // not a clock read.
  assert.doesNotMatch(source, /Date\.now\s*\(/, "no direct wall-clock call");
  assert.doesNotMatch(source, /new\s+Date\s*\(/, "no direct wall-clock construction");
  // The store port interface exposes exactly get and put — nothing else.
  const declaration = /export\s+interface\s+AuthorizationStore\s*\{([\s\S]*?)\n\}/.exec(source);
  assert.ok(declaration, "AuthorizationStore is declared");
  const members = (declaration[1] as string)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  assert.equal(members.length, 2, "the port declares exactly two members");
  assert.match(members[0] as string, /^get\s*\(/, "the first member is get");
  assert.match(members[1] as string, /^put\s*\(/, "the second member is put");
});

// --- 8 -----------------------------------------------------------------------

test("the gate is additive over the W1-002 adapter", async () => {
  // With a valid stored record, the untouched W1-002 behaviors hold. An
  // aborted run still raises ClappObservationAbortError — the gate never
  // swallows it and never presents a partial bundle as complete.
  const abortRig = createRig();
  const abortTarget = spec(undefined, authorization({ targetId: "target-abort" }));
  await authorizeTarget(abortTarget, { operatorIdentity: OPERATOR, store: abortRig.memory.store });
  const controller = new AbortController();
  const originalCreate = abortRig.handle.create.bind(abortRig.handle);
  abortRig.handle.create = async (owner: string, url: string) => {
    controller.abort();
    return originalCreate(owner, url);
  };
  await assert.rejects(abortRig.gate.observe(abortTarget, controller.signal), (error: unknown) => {
    assert.ok(error instanceof ClappObservationAbortError, "typed abort error");
    assert.ok(error instanceof ClappObservationError);
    assert.equal(error.name, "ClappObservationAbortError");
    assert.match(error.where, /^create:/);
    return true;
  });
  // A pre-aborted signal with a valid record: the gate passes, the adapter
  // refuses before any capture.
  const dead = new AbortController();
  dead.abort();
  const deadRig = createRig();
  const deadTarget = spec(undefined, authorization({ targetId: "target-dead-signal" }));
  await authorizeTarget(deadTarget, { operatorIdentity: OPERATOR, store: deadRig.memory.store });
  await assert.rejects(deadRig.gate.observe(deadTarget, dead.signal), (error: unknown) => {
    assert.ok(error instanceof ClappObservationAbortError);
    return true;
  });
  assert.equal(deadRig.handle.calls.length, 0);
  // observePartial still returns the honest partial result.
  const partialRig = createRig();
  const partialTarget = spec(
    ["https://app.example/", "https://app.example/about"],
    authorization({ targetId: "target-partial" }),
  );
  await authorizeTarget(partialTarget, {
    operatorIdentity: OPERATOR,
    store: partialRig.memory.store,
  });
  const partialController = new AbortController();
  const originalNavigate = partialRig.handle.navigate.bind(partialRig.handle);
  partialRig.handle.navigate = async (owner: string, id: string, url: string) => {
    if (url === "https://app.example/about") partialController.abort();
    return originalNavigate(owner, id, url);
  };
  const partial = await partialRig.gate.observePartial(partialTarget, partialController.signal);
  assert.equal(partial.aborted, true);
  assert.deepEqual(partial.completedEntrypoints, ["https://app.example/"]);
  assert.deepEqual(partial.pendingEntrypoints, ["https://app.example/about"]);
  assert.equal(partial.bundle.environment.aborted, true);
  assert.equal(
    partial.bundle.refs.length,
    7,
    "only the completed entrypoint's refs are in the partial bundle",
  );
  // evidenceBytes still passes through to the wrapped adapter's vault.
  const domText = partial.bundle.refs.find((ref) => ref.kind === "dom-text");
  assert.ok(domText, "a dom-text ref exists");
  assert.equal(partialRig.gate.evidenceBytes(domText).length, PAGE.text.length);
  // The battery-level half of this acceptance — the FROZEN W1-002 suite
  // passing unmodified — is confirmed in the delivery record.
});
