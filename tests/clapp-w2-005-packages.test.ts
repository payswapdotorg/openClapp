import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import type { ClappPackage } from "../packages/clapp-contracts/src/index.ts";
import {
  comparePackageVersions,
  createPackageRegistry,
  PackageConflictError,
  PackageImmutabilityError,
  PackageNotFoundError,
  type PackageStore,
  type PackageStoreKey,
  type PackageStoreRecord,
  type PackageValidationError,
  type PromotionEvidence,
  packageIdentity,
  validatePackageDocument,
} from "../packages/clapp-intelligence/src/index.ts";

/**
 * CLAPP-W2-005 — package schema, registry and versioning.
 *
 * Pure in-process tests over an in-memory PackageStore: no servers, no
 * browsers, no Docker, no network. The fixtures are complete, honest
 * package documents; "tests" entries are objects per the FROZEN JSON
 * schema (the ClappPackage TS contract declares string[] — the known
 * v0.1 contract mismatch, reported in the completion report).
 */

interface DocumentOverrides {
  id?: string;
  version?: string;
  category?: string;
  purpose?: string;
  capabilities?: string[];
  supportedTargets?: string[];
}

interface PackageDocumentFixture {
  schemaVersion: string;
  package: Record<string, unknown>;
}

function makeDocument(overrides: DocumentOverrides = {}): PackageDocumentFixture {
  return {
    schemaVersion: "0.1",
    package: {
      id: overrides.id ?? "pkg-auth-session",
      version: overrides.version ?? "1.2.0",
      category: overrides.category ?? "authentication/session",
      purpose: overrides.purpose ?? "Session sign-in/sign-out with cookie-backed session storage.",
      interface: {
        exports: ["createSessionStore", "signIn", "signOut"],
        config: { cookieName: "session", ttlMinutes: 60 },
      },
      capabilities: overrides.capabilities ?? [
        "session-signin",
        "session-signout",
        "csrf-protection",
      ],
      constraints: ["no third-party cookies", "httpOnly session cookie"],
      dependencies: ["cookie"],
      supportedTargets: overrides.supportedTargets ?? ["web"],
      tests: [
        { name: "sign-in persists session", journeyId: "j-login" },
        { name: "sign-out clears session", journeyId: "j-logout" },
      ],
      benchmark: { parityVerdict: "equivalent", repairIterations: 0 },
      failureModes: [{ mode: "expired-session", recovery: "redirect to sign-in" }],
      provenance: {
        reconstructionId: "rc-0001",
        evidenceRefs: ["ev-0001", "ev-0002"],
        extractedAt: "2025-06-01T00:00:00.000Z",
      },
    },
  };
}

/** In-memory PackageStore used by every test (the port's only test impl). */
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

/** Runs a block and returns the thrown value (undefined when nothing threw). */
function captureError(block: () => unknown): unknown {
  try {
    block();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** Asserts the validation result is ok and returns its value. */
function expectValid(document: unknown): ClappPackage {
  const result = validatePackageDocument(document);
  if (!result.ok) {
    assert.fail(
      `expected document to validate, got: ${result.errors.map((e) => e.message).join("; ")}`,
    );
  }
  return result.value;
}

/** Finds a collected validation error by path. */
function errorAt(
  errors: PackageValidationError[],
  path: string,
): PackageValidationError | undefined {
  return errors.find((error) => error.path === path);
}

function expectedEvidence(): PromotionEvidence {
  return {
    verifiedAt: "2025-07-01T10:00:00.000Z",
    verificationRunId: "run-001",
    provenanceNotes: ["parity: equivalent", "cross-project replay: ok"],
  };
}

function otherEvidence(): PromotionEvidence {
  return {
    verifiedAt: "2025-08-01T10:00:00.000Z",
    verificationRunId: "run-002",
  };
}

test("valid document round-trips through validation", () => {
  const document = makeDocument();
  const value = expectValid(document);
  assert.deepStrictEqual(value, { ...document.package, schemaVersion: "0.1" });

  // Identity is stable across two serializations (and key insertion order).
  const identity = packageIdentity(value);
  const reserialized = JSON.parse(JSON.stringify(value)) as ClappPackage;
  assert.deepStrictEqual(packageIdentity(reserialized), identity);
  const shuffled: Record<string, unknown> = {};
  for (const key of Object.keys(value).reverse()) {
    shuffled[key] = (value as unknown as Record<string, unknown>)[key];
  }
  assert.deepStrictEqual(packageIdentity(shuffled as unknown as ClappPackage), identity);

  // Any content difference produces a different digest.
  const different = expectValid(makeDocument({ purpose: "A different purpose." }));
  assert.notStrictEqual(packageIdentity(different).digest, identity.digest);

  // A minimal (required-fields-only) document validates with defaults.
  const minimal = expectValid({
    schemaVersion: "0.1",
    package: {
      id: "pkg-minimal",
      version: "0.1.0",
      category: "search",
      purpose: "Search over an indexed corpus.",
      interface: {},
      tests: [],
      provenance: {},
    },
  });
  assert.deepStrictEqual(minimal, {
    schemaVersion: "0.1",
    id: "pkg-minimal",
    version: "0.1.0",
    category: "search",
    purpose: "Search over an indexed corpus.",
    interface: {},
    capabilities: [],
    constraints: [],
    dependencies: [],
    supportedTargets: [],
    tests: [],
    benchmark: {},
    failureModes: [],
    provenance: {},
  });
});

test("validator collects every schema violation", () => {
  // Missing fields, wrong types, wrong item types, schemaVersion mismatch.
  const result = validatePackageDocument({
    schemaVersion: "0.9",
    package: {
      id: 123,
      category: "forms",
      interface: "not-an-object",
      capabilities: ["form-validation", 42],
      tests: [{ name: "ok" }, "not-an-object"],
      provenance: null,
    },
  });
  if (result.ok) {
    assert.fail("expected the document to be invalid");
  }
  const { errors } = result;
  assert.strictEqual(
    errors.length,
    8,
    `expected 8 violations, got: ${errors.map((e) => e.path).join(", ")}`,
  );

  const schemaVersion = errorAt(errors, "schemaVersion");
  assert.ok(schemaVersion);
  assert.strictEqual(schemaVersion.expected, '"0.1" (CLAPP_CONTRACT_VERSION)');
  assert.strictEqual(schemaVersion.actual, '"0.9"');

  const version = errorAt(errors, "package/version");
  assert.ok(version);
  assert.strictEqual(version.expected, "required");
  assert.strictEqual(version.actual, "missing");

  const purpose = errorAt(errors, "package/purpose");
  assert.ok(purpose);
  assert.strictEqual(purpose.expected, "required");
  assert.strictEqual(purpose.actual, "missing");

  const id = errorAt(errors, "package/id");
  assert.ok(id);
  assert.strictEqual(id.expected, "string");
  assert.strictEqual(id.actual, "number");

  const interfaceError = errorAt(errors, "package/interface");
  assert.ok(interfaceError);
  assert.strictEqual(interfaceError.expected, "object");
  assert.strictEqual(interfaceError.actual, "string");

  const provenance = errorAt(errors, "package/provenance");
  assert.ok(provenance);
  assert.strictEqual(provenance.expected, "object");
  assert.strictEqual(provenance.actual, "null");

  const capability = errorAt(errors, "package/capabilities/1");
  assert.ok(capability);
  assert.strictEqual(capability.expected, "string");
  assert.strictEqual(capability.actual, "number");

  const testEntry = errorAt(errors, "package/tests/1");
  assert.ok(testEntry);
  assert.strictEqual(testEntry.expected, "object");
  assert.strictEqual(testEntry.actual, "string");

  // Non-conforming versions are validation errors (no pre-release in v0.1).
  for (const badVersion of ["1.2", "1.2.3-beta", "v1.2.3", "1.2.x"]) {
    const versionResult = validatePackageDocument(makeDocument({ version: badVersion }));
    if (versionResult.ok) {
      assert.fail(`expected version "${badVersion}" to be rejected`);
    }
    const violation = errorAt(versionResult.errors, "package/version");
    assert.ok(violation, `expected a version violation for "${badVersion}"`);
    assert.strictEqual(violation.expected, "MAJOR.MINOR.PATCH numeric version");
    assert.strictEqual(violation.actual, `"${badVersion}"`);
  }

  // Root additionalProperties: false — unknown root keys are violations.
  const extraKeyResult = validatePackageDocument({ ...makeDocument(), extra: 1 });
  if (extraKeyResult.ok) {
    assert.fail("expected an unknown root key to be rejected");
  }
  const extra = errorAt(extraKeyResult.errors, "extra");
  assert.ok(extra);
  assert.strictEqual(extra.expected, "absent (additionalProperties: false at document root)");
  assert.strictEqual(extra.actual, "present");

  // A non-object document reports the root itself.
  const rootResult = validatePackageDocument([1, 2]);
  if (rootResult.ok) {
    assert.fail("expected a non-object document to be rejected");
  }
  assert.strictEqual(rootResult.errors.length, 1);
  assert.strictEqual(rootResult.errors[0].path, "");
  assert.strictEqual(rootResult.errors[0].expected, "object");
  assert.strictEqual(rootResult.errors[0].actual, "array");

  // A wrongly-typed schemaVersion is a type violation.
  const wrongTypeResult = validatePackageDocument({ ...makeDocument(), schemaVersion: 1 });
  if (wrongTypeResult.ok) {
    assert.fail("expected a non-string schemaVersion to be rejected");
  }
  const schemaVersionType = errorAt(wrongTypeResult.errors, "schemaVersion");
  assert.ok(schemaVersionType);
  assert.strictEqual(schemaVersionType.expected, "string");
  assert.strictEqual(schemaVersionType.actual, "number");
});

test("register is idempotent for identical content", () => {
  const store = new InMemoryPackageStore();
  const registry = createPackageRegistry(store);
  const document = makeDocument();

  const first = registry.register(document);
  if (!first.ok) {
    assert.fail("expected first registration to succeed");
  }

  const second = registry.register(JSON.parse(JSON.stringify(document)));
  if (!second.ok) {
    assert.fail("expected identical re-registration to succeed");
  }
  assert.deepStrictEqual(second.identity, first.identity);
  assert.strictEqual(store.rows.size, 1);

  // Key-insertion order is not content: still the same identity, one row.
  const shuffledPackage: Record<string, unknown> = {};
  for (const key of Object.keys(document.package).reverse()) {
    shuffledPackage[key] = document.package[key];
  }
  const third = registry.register({ schemaVersion: "0.1", package: shuffledPackage });
  if (!third.ok) {
    assert.fail("expected key-shuffled re-registration to succeed");
  }
  assert.deepStrictEqual(third.identity, first.identity);
  assert.strictEqual(store.rows.size, 1);

  // The stored row is a candidate keyed by (id, normalized version).
  const record = store.get({ id: "pkg-auth-session", version: "1.2.0" });
  assert.ok(record);
  assert.strictEqual(record.status, "candidate");
  assert.strictEqual(record.identity.digest, first.identity.digest);
});

test("register conflicts on mutated same id+version", () => {
  const store = new InMemoryPackageStore();
  const registry = createPackageRegistry(store);
  const document = makeDocument({ id: "pkg-forms", version: "1.0.0" });
  const first = registry.register(document);
  if (!first.ok) {
    assert.fail("expected first registration to succeed");
  }

  const mutated = JSON.parse(JSON.stringify(document));
  mutated.package.purpose = "A mutated purpose.";
  const error = captureError(() => registry.register(mutated));
  assert.ok(error instanceof PackageConflictError);
  assert.strictEqual(error.name, "PackageConflictError");
  assert.strictEqual(error.details.kind, "content-conflict");
  assert.strictEqual(error.details.id, "pkg-forms");
  assert.strictEqual(error.details.version, "1.0.0");
  assert.strictEqual(error.details.existingDigest, first.identity.digest);
  assert.ok(error.details.attemptedDigest);

  // The original is untouched: one row, original content.
  assert.strictEqual(store.rows.size, 1);
  const stored = registry.get("pkg-forms", "1.0.0");
  assert.ok(stored);
  assert.strictEqual(stored.purpose, document.package.purpose);
});

test("versions must increase", () => {
  const store = new InMemoryPackageStore();
  const registry = createPackageRegistry(store);
  assert.ok(registry.register(makeDocument({ id: "pkg-search", version: "1.2.0" })).ok);

  // A lower version is rejected with a typed version-regression conflict.
  const error = captureError(() =>
    registry.register(makeDocument({ id: "pkg-search", version: "1.1.0" })),
  );
  assert.ok(error instanceof PackageConflictError);
  assert.strictEqual(error.details.kind, "version-regression");
  assert.strictEqual(error.details.latestVersion, "1.2.0");

  // A higher version is accepted.
  const higher = registry.register(makeDocument({ id: "pkg-search", version: "1.2.1" }));
  assert.ok(higher.ok);
  assert.strictEqual(store.rows.size, 2);

  // comparePackageVersions is total, deterministic, numerically exact.
  assert.strictEqual(comparePackageVersions("1.2.0", "1.2.1"), -1);
  assert.strictEqual(comparePackageVersions("1.2.1", "1.2.0"), 1);
  assert.strictEqual(comparePackageVersions("1.0.0", "1.0.0"), 0);
  assert.strictEqual(comparePackageVersions("1.10.0", "1.9.0"), 1);
  assert.strictEqual(comparePackageVersions("2.0.0", "1.99.99"), 1);
  assert.strictEqual(comparePackageVersions("0.0.1", "0.1.0"), -1);
  assert.strictEqual(comparePackageVersions("10.0.0", "9.999.999"), 1);

  // Leading zeros normalize to the same version (no duplicate lineage).
  const zeroPadded = registry.register(makeDocument({ id: "pkg-zeros", version: "1.02.0" }));
  if (!zeroPadded.ok) {
    assert.fail("expected zero-padded version to register");
  }
  assert.strictEqual(zeroPadded.identity.version, "1.2.0");
});

test("promotion makes versions immutable", () => {
  const store = new InMemoryPackageStore();
  const registry = createPackageRegistry(store);
  const document = makeDocument({ id: "pkg-tables", version: "1.0.0" });
  assert.ok(registry.register(document).ok);

  const evidence = expectedEvidence();
  const promoted = registry.promote("pkg-tables", "1.0.0", evidence);
  assert.strictEqual(promoted.purpose, document.package.purpose);
  assert.deepStrictEqual(promoted.interface, document.package.interface);
  const promotion = promoted.provenance.promotion as Record<string, unknown>;
  assert.strictEqual(promotion.verifiedAt, evidence.verifiedAt);
  assert.strictEqual(promotion.verificationRunId, evidence.verificationRunId);
  assert.deepStrictEqual(promotion.provenanceNotes, evidence.provenanceNotes);

  const stored = registry.get("pkg-tables", "1.0.0");
  assert.deepStrictEqual(stored, promoted);
  assert.strictEqual(store.rows.size, 1);

  // Overwriting the promoted pair via register fails closed.
  const mutated = JSON.parse(JSON.stringify(document));
  mutated.package.constraints = ["totally different constraints"];
  const overwrite = captureError(() => registry.register(mutated));
  assert.ok(overwrite instanceof PackageImmutabilityError);
  assert.strictEqual(overwrite.name, "PackageImmutabilityError");
  assert.strictEqual(overwrite.details.reason, "register-overwrite");
  assert.strictEqual(overwrite.details.id, "pkg-tables");
  assert.strictEqual(overwrite.details.version, "1.0.0");

  // Re-promoting with different evidence fails closed.
  const rePromote = captureError(() => registry.promote("pkg-tables", "1.0.0", otherEvidence()));
  assert.ok(rePromote instanceof PackageImmutabilityError);
  assert.strictEqual(rePromote.details.reason, "re-promotion");

  // Re-promoting with identical evidence is the idempotent no-op.
  const again = registry.promote("pkg-tables", "1.0.0", evidence);
  assert.deepStrictEqual(again, promoted);

  // get still returns the ORIGINAL promoted document.
  const final = registry.get("pkg-tables", "1.0.0");
  assert.deepStrictEqual(final, promoted);
  const finalPromotion = (final?.provenance.promotion ?? {}) as Record<string, unknown>;
  assert.strictEqual(finalPromotion.verificationRunId, "run-001");
  assert.strictEqual(store.rows.size, 1);
  assert.strictEqual(registry.list({ status: "promoted" }).length, 1);
  assert.strictEqual(registry.list({ status: "candidate" }).length, 0);
});

test("list filters deterministically", () => {
  const store = new InMemoryPackageStore();
  const registry = createPackageRegistry(store);
  const alpha = (version: string) =>
    makeDocument({
      id: "pkg-alpha",
      version,
      category: "forms",
      capabilities: ["form-validation", "input-binding"],
      supportedTargets: ["web"],
    });
  const beta = (version: string) =>
    makeDocument({
      id: "pkg-beta",
      version,
      category: "tables",
      capabilities: ["table-pagination"],
      supportedTargets: ["web", "android"],
    });
  // Interleaved registration order differs from the (id, version) order.
  for (const document of [
    alpha("1.0.0"),
    beta("1.0.0"),
    alpha("1.1.0"),
    beta("1.9.0"),
    alpha("1.2.0"),
    beta("1.10.0"),
  ]) {
    const result = registry.register(document);
    if (!result.ok) {
      assert.fail(`expected registration of ${document.package.id} to succeed`);
    }
  }
  registry.promote("pkg-alpha", "1.1.0", expectedEvidence());
  assert.strictEqual(store.rows.size, 6);

  const coordinates = (documents: ClappPackage[]) =>
    documents.map((document) => `${document.id}@${document.version}`);

  // Ordering is (id, then version) — numeric version order, not string order.
  assert.deepStrictEqual(coordinates(registry.list()), [
    "pkg-alpha@1.0.0",
    "pkg-alpha@1.1.0",
    "pkg-alpha@1.2.0",
    "pkg-beta@1.0.0",
    "pkg-beta@1.9.0",
    "pkg-beta@1.10.0",
  ]);

  assert.deepStrictEqual(coordinates(registry.list({ category: "forms" })), [
    "pkg-alpha@1.0.0",
    "pkg-alpha@1.1.0",
    "pkg-alpha@1.2.0",
  ]);
  assert.deepStrictEqual(coordinates(registry.list({ capability: "table-pagination" })), [
    "pkg-beta@1.0.0",
    "pkg-beta@1.9.0",
    "pkg-beta@1.10.0",
  ]);
  assert.deepStrictEqual(coordinates(registry.list({ target: "android" })), [
    "pkg-beta@1.0.0",
    "pkg-beta@1.9.0",
    "pkg-beta@1.10.0",
  ]);
  assert.strictEqual(registry.list({ target: "web" }).length, 6);
  assert.deepStrictEqual(coordinates(registry.list({ category: "tables", target: "web" })), [
    "pkg-beta@1.0.0",
    "pkg-beta@1.9.0",
    "pkg-beta@1.10.0",
  ]);

  // Status filter separates the promoted row from the candidates.
  assert.deepStrictEqual(coordinates(registry.list({ status: "promoted" })), ["pkg-alpha@1.1.0"]);
  assert.deepStrictEqual(coordinates(registry.list({ status: "candidate" })), [
    "pkg-alpha@1.0.0",
    "pkg-alpha@1.2.0",
    "pkg-beta@1.0.0",
    "pkg-beta@1.9.0",
    "pkg-beta@1.10.0",
  ]);
  const promotedDoc = registry.list({ status: "promoted" })[0];
  assert.ok("promotion" in promotedDoc.provenance);

  // Unknown categories return empty, never an error.
  assert.deepStrictEqual(registry.list({ category: "nonexistent" }), []);
});

test("promotion of unregistered package fails closed", () => {
  const store = new InMemoryPackageStore();
  const registry = createPackageRegistry(store);
  assert.ok(registry.register(makeDocument({ id: "pkg-real", version: "1.0.0" })).ok);
  const before = registry.list();

  const error = captureError(() => registry.promote("pkg-ghost", "9.9.9", expectedEvidence()));
  assert.ok(error instanceof PackageNotFoundError);
  assert.strictEqual(error.name, "PackageNotFoundError");
  assert.strictEqual(error.details.id, "pkg-ghost");
  assert.strictEqual(error.details.version, "9.9.9");

  // Registry state is unchanged.
  assert.strictEqual(store.rows.size, 1);
  assert.deepStrictEqual(registry.list(), before);
  assert.strictEqual(registry.get("pkg-ghost", "9.9.9"), null);
});

test("history returns full version lineage", () => {
  const store = new InMemoryPackageStore();
  const registry = createPackageRegistry(store);
  for (const version of ["1.0.0", "1.1.0", "2.0.0"]) {
    assert.ok(registry.register(makeDocument({ id: "pkg-history", version })).ok);
  }
  registry.promote("pkg-history", "1.1.0", expectedEvidence());

  const lineage = registry.history("pkg-history");
  assert.deepStrictEqual(
    lineage.map((document) => document.version),
    ["1.0.0", "1.1.0", "2.0.0"],
  );
  // Candidates and promoted documents appear together, in version order.
  assert.ok(!("promotion" in lineage[0].provenance));
  assert.ok("promotion" in lineage[1].provenance);
  assert.ok(!("promotion" in lineage[2].provenance));

  // Unknown ids return an empty lineage (consistent with list/get).
  assert.deepStrictEqual(registry.history("pkg-unknown"), []);
});

test("store stays a dumb port", async () => {
  // 1. The package source never imports fs/net/db (or anything dynamic).
  const srcDir = new URL("../packages/clapp-intelligence/src/", import.meta.url);
  const entries = await readdir(srcDir);
  const files = entries.filter((entry) => entry.endsWith(".ts"));
  assert.ok(files.length >= 6, "expected to find the package sources");
  const forbidden: { name: string; pattern: RegExp }[] = [
    { name: "node:fs", pattern: /["']node:fs(?:\/promises)?["']/ },
    { name: "node network module", pattern: /["']node:(?:net|http|https|dns|tls|dgram)["']/ },
    { name: "node process module", pattern: /["']node:(?:child_process|worker_threads)["']/ },
    { name: "bare fs/net/http import", pattern: /from\s+["'](fs|net|http|https)["']/ },
    {
      name: "database client",
      pattern: /["'](?:pg|sqlite3|better-sqlite3|@electric-sql\/pglite)["']/,
    },
    { name: "browser/docker driver", pattern: /["'](?:playwright|puppeteer|dockerode)["']/ },
    { name: "dynamic import", pattern: /\bimport\s*\(/ },
    { name: "commonjs require", pattern: /\brequire\s*\(/ },
  ];
  for (const file of files) {
    const source = await readFile(new URL(file, srcDir), "utf8");
    for (const { name, pattern } of forbidden) {
      assert.ok(!pattern.test(source), `${file} must not import ${name}`);
    }
  }

  // 2. The registry only ever talks to the port: a store that exposes
  // exactly get/put/list serves a full workload without missing methods.
  class RecordingPackageStore implements PackageStore {
    readonly called: string[] = [];
    private readonly rows = new Map<string, PackageStoreRecord>();

    get(key: PackageStoreKey): PackageStoreRecord | null {
      this.called.push("get");
      return this.rows.get(`${key.id}@${key.version}`) ?? null;
    }

    put(record: PackageStoreRecord): void {
      this.called.push("put");
      this.rows.set(`${record.key.id}@${record.key.version}`, record);
    }

    list(): PackageStoreRecord[] {
      this.called.push("list");
      return [...this.rows.values()];
    }
  }
  const recordingStore = new RecordingPackageStore();
  const registry = createPackageRegistry(recordingStore);
  assert.ok(registry.register(makeDocument({ id: "pkg-port", version: "1.0.0" })).ok);
  assert.ok(registry.register(makeDocument({ id: "pkg-port", version: "1.0.0" })).ok);
  assert.ok(registry.register(makeDocument({ id: "pkg-port", version: "1.1.0" })).ok);
  registry.promote("pkg-port", "1.0.0", expectedEvidence());
  assert.ok(registry.get("pkg-port", "1.1.0"));
  registry.list({ category: "authentication/session", status: "candidate" });
  registry.history("pkg-port");
  const allowed = new Set(["get", "put", "list"]);
  for (const method of recordingStore.called) {
    assert.ok(allowed.has(method), `registry must only use the port, saw: ${method}`);
  }
  assert.ok(recordingStore.called.includes("get"));
  assert.ok(recordingStore.called.includes("put"));
  assert.ok(recordingStore.called.includes("list"));

  // 3. The port's own shape is exactly get/put/list — nothing else.
  const bareStore: PackageStore = {
    get: () => null,
    put: () => {},
    list: () => [],
  };
  assert.deepStrictEqual(Object.keys(bareStore).sort(), ["get", "list", "put"]);
});
