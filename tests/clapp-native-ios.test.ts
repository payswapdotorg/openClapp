import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { EvidenceRef } from "../packages/clapp-contracts/src/index.ts";
import {
  bindIosObservationSeam,
  bindIosVerificationSeam,
  CLAPP_NATIVE_IOS_ENVIRONMENT_VERSION,
  CLAPP_NATIVE_IOS_TARGET_VERSION,
  ClappNativeIosError,
  canonicalJsonBytes,
  createIosObservationAdapter,
  createIosVerificationAdapter,
  IOS_EVIDENCE_ID_PREFIX,
  IOS_PACKAGING_FORMATS,
  IOS_UI_TEST_FRAMEWORKS,
  iosEvidenceId,
  iosEvidenceRef,
  isIosPackaging,
  isNoneIosEnvironment,
  sha256Hex,
  validateIosEnvironment,
  validateIosSynthesisTarget,
} from "../packages/clapp-native-ios/src/index.ts";

/**
 * CLAPP-NATIVE-IOS — the iOS native adapter (ADR-004, lane 5 of 5).
 *
 * Eight deterministic node:test cases pinning the five-component v0.1 contract:
 *   (a) the environment validator pins the frozen iOS vocabulary and refuses foreign values;
 *   (b) the observation law: a `none` framework refuses with a typed error and never calls the host;
 *   (c) the observation adapter measures a scripted host element tree and emits idev_ evidence refs;
 *   (d) the evidence discipline: ids are content-derived, deterministic, honestly classified as observed;
 *   (e) the synthesis-target validator pins the frozen packaging vocabulary and normalizes identifier lists;
 *   (f) the verification seam carries measured counts and verbatim failure reasons, never a parity verdict;
 *   (g) the bind-time seam validation refuses a malformed host before any call is made;
 *   (h) the import-discipline pin: the package consumes only @clapp/contracts and in-package modules.
 *
 * Every test pins a frozen fact about the adapter — no real device, no XCUITest
 * runner, no network, no wall-clock. The host is always a scripted fake that
 * implements the structural seam.
 */

const RECONSTRUCTION_ID = "rc-native-ios-0001";
const TARGET_ID = "clapp_target_ios_fixture";
const APPLICATION = "com.example.ios-app";
const CAPTURED_AT = "2026-10-14T12:00:00.000Z"; // pinned clock — the emitter never reads a wall-clock

/** A scripted iOS observation host implementing the structural seam. */
interface FakeObservationHost {
  snapshot(application: string): Promise<unknown>;
  calls: { capability: string; application: string }[];
}

function fakeObservationHost(tree: unknown, opts: { fail?: string } = {}): FakeObservationHost {
  const calls: FakeObservationHost["calls"] = [];
  const host: FakeObservationHost = {
    calls,
    async snapshot(application: string) {
      calls.push({ capability: "snapshot", application });
      if (opts.fail) throw new Error(opts.fail);
      return tree;
    },
  };
  return host;
}

/** A scripted iOS verification host implementing the structural seam. */
interface FakeVerificationHost {
  runJourney(input: { journeyId: string; application: string }): Promise<unknown>;
  calls: { capability: string; journeyId: string; application: string }[];
}

function fakeVerificationHost(payload: unknown): FakeVerificationHost {
  const calls: FakeVerificationHost["calls"] = [];
  const host: FakeVerificationHost = {
    calls,
    async runJourney(input) {
      calls.push({ capability: "runJourney", ...input });
      return payload;
    },
  };
  return host;
}

/** A small, stable element tree used across multiple tests. */
const TREE_A: unknown = {
  kind: "application",
  identifier: "com.example.ios-app",
  children: [
    {
      kind: "window",
      identifier: "main",
      children: [{ kind: "button", identifier: "submit", value: "Submit" }],
    },
    {
      kind: "window",
      identifier: "modal",
      children: [{ kind: "text", identifier: "title", value: "Hello" }],
    },
  ],
};

/** The same tree, with one button's label changed — produces a different digest. */
const TREE_B: unknown = {
  kind: "application",
  identifier: "com.example.ios-app",
  children: [
    {
      kind: "window",
      identifier: "main",
      children: [{ kind: "button", identifier: "submit", value: "Send" }],
    },
    {
      kind: "window",
      identifier: "modal",
      children: [{ kind: "text", identifier: "title", value: "Hello" }],
    },
  ],
};

// ---------------------------------------------------------------------------
// (a) environment validator
// ---------------------------------------------------------------------------

test("environment validator pins the frozen iOS v0.1 vocabulary and refuses foreign values", () => {
  // The frozen vocabulary is pinned — every worker, every consumer, every test.
  assert.deepStrictEqual([...IOS_UI_TEST_FRAMEWORKS], ["xcuitest", "none"]);
  assert.deepStrictEqual([...IOS_PACKAGING_FORMATS], ["ipa", "app", "xcarchive", "dSYM", "zip"]);
  assert.strictEqual(CLAPP_NATIVE_IOS_ENVIRONMENT_VERSION, "0.1");

  // A complete, valid descriptor is accepted.
  const valid = validateIosEnvironment({ uiTestFramework: "xcuitest", packaging: ["ipa", "app"] });
  assert.strictEqual(valid.uiTestFramework, "xcuitest");
  assert.deepStrictEqual([...valid.packaging], ["ipa", "app"]);

  // `none` is a VALID descriptor — the honest-absent state.
  const none = validateIosEnvironment({ uiTestFramework: "none", packaging: [] });
  assert.ok(isNoneIosEnvironment(none));

  // An empty packaging list is a valid descriptor (no deployable format declared).
  const emptyPackaging = validateIosEnvironment({ uiTestFramework: "xcuitest", packaging: [] });
  assert.strictEqual(emptyPackaging.packaging.length, 0);

  // A non-object input refuses with a typed named error.
  assert.throws(
    () => validateIosEnvironment(null),
    (error: unknown) =>
      error instanceof ClappNativeIosError &&
      error.component === "environment" &&
      error.field === "descriptor",
  );

  // A missing uiTestFramework refuses with a typed named error naming the field.
  assert.throws(
    () => validateIosEnvironment({ packaging: ["ipa"] }),
    (error: unknown) =>
      error instanceof ClappNativeIosError &&
      error.component === "environment" &&
      error.field === "uiTestFramework",
  );

  // A foreign uiTestFramework value refuses — the frozen vocabulary is pinned.
  assert.throws(
    () => validateIosEnvironment({ uiTestFramework: "espresso", packaging: ["ipa"] }),
    (error: unknown) =>
      error instanceof ClappNativeIosError &&
      error.component === "environment" &&
      error.field === "uiTestFramework",
  );

  // A foreign packaging value refuses.
  assert.throws(
    () => validateIosEnvironment({ uiTestFramework: "xcuitest", packaging: ["dex"] }),
    (error: unknown) =>
      error instanceof ClappNativeIosError &&
      error.component === "environment" &&
      error.field === "packaging",
  );

  // A non-array packaging refuses.
  assert.throws(
    () => validateIosEnvironment({ uiTestFramework: "xcuitest", packaging: "ipa" }),
    (error: unknown) =>
      error instanceof ClappNativeIosError &&
      error.component === "environment" &&
      error.field === "packaging",
  );

  // Duplicates are normalized — the validator never returns a partial descriptor.
  const deduped = validateIosEnvironment({
    uiTestFramework: "xcuitest",
    packaging: ["ipa", "ipa", "app", "app"],
  });
  assert.deepStrictEqual([...deduped.packaging], ["ipa", "app"]);
});

// ---------------------------------------------------------------------------
// (b) observation law: none refuses, host never called
// ---------------------------------------------------------------------------

test("observation law: a none framework refuses with a typed error and never calls the host seam", async () => {
  const host = fakeObservationHost(TREE_A);
  const adapter = createIosObservationAdapter({
    host,
    capturedAt: CAPTURED_AT,
    reconstructionId: RECONSTRUCTION_ID,
    targetId: TARGET_ID,
  });
  const noneEnv = validateIosEnvironment({ uiTestFramework: "none", packaging: [] });

  // The `none` framework refuses with a typed named error.
  await assert.rejects(
    () => adapter.observe(noneEnv, APPLICATION),
    (error: unknown) =>
      error instanceof ClappNativeIosError &&
      error.component === "observation" &&
      error.field === "uiTestFramework",
  );

  // The host seam was NEVER called — a missing observation is not permission
  // to invent a behavior. The spy proves zero calls.
  assert.strictEqual(host.calls.length, 0);
});

// ---------------------------------------------------------------------------
// (c) observation adapter measures a scripted host tree
// ---------------------------------------------------------------------------

test("observation adapter measures a scripted host element tree and emits idev_ evidence refs", async () => {
  const host = fakeObservationHost(TREE_A);
  const adapter = createIosObservationAdapter({
    host,
    capturedAt: CAPTURED_AT,
    reconstructionId: RECONSTRUCTION_ID,
    targetId: TARGET_ID,
  });
  const env = validateIosEnvironment({ uiTestFramework: "xcuitest", packaging: ["ipa"] });

  const result = await adapter.observe(env, APPLICATION);

  // The snapshot digest is MEASURED from the host's own canonical payload —
  // the adapter never derives, upgrades, or fabricates a node.
  const expectedCanonical = canonicalJsonBytes(TREE_A);
  const expectedDigest = sha256Hex(expectedCanonical);
  assert.strictEqual(result.snapshot.digest, expectedDigest);
  assert.strictEqual(result.snapshot.application, APPLICATION);
  assert.deepStrictEqual(Buffer.from(result.snapshot.canonical), Buffer.from(expectedCanonical));

  // The evidence ref is over the measured payload, with the idev_ prefix.
  assert.strictEqual(result.refs.length, 1);
  const ref = result.refs[0] as EvidenceRef;
  assert.ok(
    ref.id.startsWith(IOS_EVIDENCE_ID_PREFIX),
    `id must carry the iOS prefix; got ${ref.id}`,
  );
  assert.match(ref.id, /^idev_[0-9a-f]{16}$/);
  assert.strictEqual(ref.sha256, expectedDigest);
  assert.strictEqual(ref.kind, "element-tree");
  assert.strictEqual(ref.classification, "observed");
  assert.strictEqual(ref.reconstructionId, RECONSTRUCTION_ID);
  assert.strictEqual(ref.targetId, TARGET_ID);
  assert.strictEqual(ref.capturedAt, CAPTURED_AT);
  assert.strictEqual(ref.redacted, false);

  // The host was called exactly once with the application target.
  assert.strictEqual(host.calls.length, 1);
  assert.deepStrictEqual(host.calls[0], { capability: "snapshot", application: APPLICATION });
});

// ---------------------------------------------------------------------------
// (d) evidence discipline: content-derived, deterministic, honest
// ---------------------------------------------------------------------------

test("evidence ids are content-derived, deterministic, and honestly classified as observed", () => {
  const manifest = {
    application: APPLICATION,
    kind: "element-tree",
    reconstructionId: RECONSTRUCTION_ID,
    targetId: TARGET_ID,
  };

  // Same payload → same id (deterministic).
  const refA = iosEvidenceRef(manifest, canonicalJsonBytes(TREE_A), "source", CAPTURED_AT);
  const refA2 = iosEvidenceRef(manifest, canonicalJsonBytes(TREE_A), "source", CAPTURED_AT);
  assert.strictEqual(refA.id, refA2.id);

  // The id matches the manifest-only derivation (the digest is re-measured
  // from the payload, then participates in the id's sha256).
  assert.strictEqual(
    refA.id,
    iosEvidenceId({ ...manifest, digest: sha256Hex(canonicalJsonBytes(TREE_A)) }),
  );

  // A changed tree → a different id (distinguishing).
  const refB = iosEvidenceRef(manifest, canonicalJsonBytes(TREE_B), "source", CAPTURED_AT);
  assert.notStrictEqual(refB.id, refA.id);

  // A different target → a different id (the manifest participates in the digest).
  const refOtherTarget = iosEvidenceRef(
    { ...manifest, targetId: "clapp_target_ios_other" },
    canonicalJsonBytes(TREE_A),
    "source",
    CAPTURED_AT,
  );
  assert.notStrictEqual(refOtherTarget.id, refA.id);

  // Classification is honest: the emitter assigns `observed` only — never
  // `derived`, `inferred`, `assumed`, or `unavailable`. The emitter produces
  // only evidence the host seam actually produced; an honest absence is the
  // observation component's typed refusal, not a fabricated evidence ref.
  assert.strictEqual(refA.classification, "observed");
  assert.strictEqual(refB.classification, "observed");

  // The id is the prefix pinned by ADR-004 + 16 hex (the ADR-003 family discipline).
  assert.match(refA.id, /^idev_[0-9a-f]{16}$/);
  assert.match(refB.id, /^idev_[0-9a-f]{16}$/);

  // A malformed manifest refuses with a typed named error (fail-closed).
  assert.throws(
    () =>
      iosEvidenceRef(
        { ...manifest, application: "" },
        canonicalJsonBytes(TREE_A),
        "source",
        CAPTURED_AT,
      ),
    (error: unknown) =>
      error instanceof ClappNativeIosError &&
      error.component === "evidence" &&
      error.field === "application",
  );
  // A non-Uint8Array payload refuses — the emitter never accepts a string it
  // could mis-digest.
  assert.throws(
    () => iosEvidenceRef(manifest, "not-bytes" as unknown as Uint8Array, "source", CAPTURED_AT),
    (error: unknown) =>
      error instanceof ClappNativeIosError &&
      error.component === "evidence" &&
      error.field === "payload",
  );
});

// ---------------------------------------------------------------------------
// (e) synthesis-target validator
// ---------------------------------------------------------------------------

test("synthesis-target validator pins the frozen packaging vocabulary and normalizes identifier lists", () => {
  assert.strictEqual(CLAPP_NATIVE_IOS_TARGET_VERSION, "0.1");

  // isIosPackaging pins the frozen vocabulary.
  assert.ok(isIosPackaging("ipa"));
  assert.ok(isIosPackaging("dSYM"));
  assert.ok(!isIosPackaging("apk")); // foreign (android) — refuses
  assert.ok(!isIosPackaging("msi")); // foreign (windows) — refuses

  // A complete, valid target is accepted.
  const valid = validateIosSynthesisTarget({
    bundleIdentifier: "com.example.ios-app",
    packaging: "ipa",
    productIdentifiers: ["com.example.pro", "com.example.consumable"],
    signingIdentity: "Developer ID: Example Corp (TEAMID)",
    minimumOsVersion: "17.0",
  });
  assert.strictEqual(valid.bundleIdentifier, "com.example.ios-app");
  assert.strictEqual(valid.packaging, "ipa");
  assert.strictEqual(valid.signingIdentity, "Developer ID: Example Corp (TEAMID)");
  assert.strictEqual(valid.minimumOsVersion, "17.0");

  // Product identifiers are SORTED and DEDUPLICATED — two structurally equal
  // targets are byte-identical regardless of construction order.
  assert.deepStrictEqual(
    [...(valid.productIdentifiers ?? [])],
    ["com.example.consumable", "com.example.pro"],
  );

  const sortedAgain = validateIosSynthesisTarget({
    bundleIdentifier: "com.example.ios-app",
    packaging: "ipa",
    productIdentifiers: ["com.example.pro", "com.example.consumable", "com.example.pro"],
  });
  assert.deepStrictEqual(
    [...(sortedAgain.productIdentifiers ?? [])],
    [...(valid.productIdentifiers ?? [])],
  );

  // A foreign packaging value refuses.
  assert.throws(
    () => validateIosSynthesisTarget({ bundleIdentifier: "com.example", packaging: "apk" }),
    (error: unknown) =>
      error instanceof ClappNativeIosError &&
      error.component === "synthesis-target" &&
      error.field === "packaging",
  );

  // A missing bundleIdentifier refuses.
  assert.throws(
    () => validateIosSynthesisTarget({ packaging: "ipa" }),
    (error: unknown) =>
      error instanceof ClappNativeIosError &&
      error.component === "synthesis-target" &&
      error.field === "bundleIdentifier",
  );

  // A non-string product identifier entry refuses — the validator never
  // silently coerces a malformed entry.
  assert.throws(
    () =>
      validateIosSynthesisTarget({
        bundleIdentifier: "com.example",
        packaging: "ipa",
        productIdentifiers: ["ok", 42],
      }),
    (error: unknown) =>
      error instanceof ClappNativeIosError &&
      error.component === "synthesis-target" &&
      error.field === "productIdentifiers",
  );

  // A non-object input refuses.
  assert.throws(
    () => validateIosSynthesisTarget(null),
    (error: unknown) =>
      error instanceof ClappNativeIosError &&
      error.component === "synthesis-target" &&
      error.field === "descriptor",
  );
});

// ---------------------------------------------------------------------------
// (f) verification seam: measured counts, verbatim reasons, no parity verdict
// ---------------------------------------------------------------------------

test("verification seam carries measured counts and verbatim failure reasons, never a parity verdict", async () => {
  const host = fakeVerificationHost({
    stepsTotal: 4,
    stepsPassed: 3,
    stepsFailed: 1,
    failureReasons: ["login button not found", "network: timeout 30s"],
  });
  const adapter = createIosVerificationAdapter({ host });

  const result = await adapter.verify("journey-login", APPLICATION);

  // Counts are MEASURED and carried verbatim — never derived, never upgraded.
  assert.strictEqual(result.journeyId, "journey-login");
  assert.strictEqual(result.application, APPLICATION);
  assert.strictEqual(result.stepsTotal, 4);
  assert.strictEqual(result.stepsPassed, 3);
  assert.strictEqual(result.stepsFailed, 1);

  // Failure reasons are carried VERBATIM — never paraphrased, never summarized,
  // never invented. Order is preserved.
  assert.deepStrictEqual(
    [...result.failureReasons],
    ["login button not found", "network: timeout 30s"],
  );

  // The host was called exactly once with the journey + application.
  assert.strictEqual(host.calls.length, 1);
  assert.deepStrictEqual(host.calls[0], {
    capability: "runJourney",
    journeyId: "journey-login",
    application: APPLICATION,
  });

  // A host return that looks like a DiffReport (carries `verdict` or
  // `findings`) refuses with a typed named error — the verification adapter
  // NEVER constructs a parity/verdict record; that belongs to the diff
  // discipline, a later consumer.
  const diffHost = fakeVerificationHost({
    verdict: "equivalent",
    findings: [],
    stepsTotal: 1,
    stepsPassed: 1,
    stepsFailed: 0,
    failureReasons: [],
  });
  const diffAdapter = createIosVerificationAdapter({ host: diffHost });
  await assert.rejects(
    () => diffAdapter.verify("journey-diff", APPLICATION),
    (error: unknown) =>
      error instanceof ClappNativeIosError &&
      error.component === "verification" &&
      error.field === "host-return" &&
      /verdict\/findings/.test(error.message),
  );

  // Inconsistent counts (passed + failed !== total) refuse — the adapter
  // carries counts verbatim but cannot present an inconsistent host return
  // as a coherent result.
  const inconsistentHost = fakeVerificationHost({
    stepsTotal: 4,
    stepsPassed: 3,
    stepsFailed: 2,
    failureReasons: [],
  });
  const inconsistentAdapter = createIosVerificationAdapter({ host: inconsistentHost });
  await assert.rejects(
    () => inconsistentAdapter.verify("journey-inconsistent", APPLICATION),
    (error: unknown) =>
      error instanceof ClappNativeIosError &&
      error.component === "verification" &&
      error.field === "host-return",
  );
});

// ---------------------------------------------------------------------------
// (g) bind-time seam validation
// ---------------------------------------------------------------------------

test("bind-time seam validation refuses a malformed host before any call is made", () => {
  // An observation host missing `snapshot` refuses at BIND time, never at call time.
  assert.throws(
    () => bindIosObservationSeam({}),
    (error: unknown) =>
      error instanceof ClappNativeIosError &&
      error.component === "observation" &&
      error.field === "host-seam",
  );
  assert.throws(
    () => bindIosObservationSeam({ snapshot: "not-a-function" }),
    (error: unknown) =>
      error instanceof ClappNativeIosError &&
      error.component === "observation" &&
      error.field === "host-seam",
  );
  assert.throws(
    () => bindIosObservationSeam(null),
    (error: unknown) =>
      error instanceof ClappNativeIosError &&
      error.component === "observation" &&
      error.field === "host-seam",
  );

  // A verification host missing `runJourney` refuses at BIND time, never at call time.
  assert.throws(
    () => bindIosVerificationSeam({}),
    (error: unknown) =>
      error instanceof ClappNativeIosError &&
      error.component === "verification" &&
      error.field === "host-seam",
  );
  assert.throws(
    () => bindIosVerificationSeam({ runJourney: 42 }),
    (error: unknown) =>
      error instanceof ClappNativeIosError &&
      error.component === "verification" &&
      error.field === "host-seam",
  );

  // The factory surfaces the bind-time error too — the adapter cannot be
  // constructed over a malformed host. (createIosObservationAdapter calls
  // bindIosObservationSeam at construction.)
  assert.throws(
    () =>
      createIosObservationAdapter({
        host: {},
        capturedAt: CAPTURED_AT,
        reconstructionId: RECONSTRUCTION_ID,
        targetId: TARGET_ID,
      }),
    (error: unknown) => error instanceof ClappNativeIosError && error.component === "observation",
  );
  assert.throws(
    () => createIosVerificationAdapter({ host: {} }),
    (error: unknown) => error instanceof ClappNativeIosError && error.component === "verification",
  );

  // A missing capturedAt / reconstructionId / targetId refuses at construction
  // (the emitter needs them; the adapter never reads a wall-clock).
  assert.throws(
    () =>
      createIosObservationAdapter({
        host: fakeObservationHost(TREE_A),
        capturedAt: "",
        reconstructionId: RECONSTRUCTION_ID,
        targetId: TARGET_ID,
      }),
    (error: unknown) =>
      error instanceof ClappNativeIosError &&
      error.component === "observation" &&
      error.field === "capturedAt",
  );
});

// ---------------------------------------------------------------------------
// (h) import-discipline pin
// ---------------------------------------------------------------------------

test("import-discipline pin: the package consumes only @clapp/contracts and in-package modules", () => {
  const packageRoot = new URL("../packages/clapp-native-ios/src/", import.meta.url);
  const files = readdirSync(packageRoot).filter((name) => name.endsWith(".ts"));
  assert.ok(files.length >= 6, "the package has at least the six in-package modules");

  // Cross-lane packages the adapter must never import (ADR-002, ADR-004).
  const BANNED_PACKAGES = [
    "@clapp/intelligence",
    "@clapp/synthesis",
    "@clapp/runtime-openmuse",
    "@clapp/observation",
    "@clapp/benchmarks",
    "@clapp/backends",
    "@clapp/domain",
    "@clapp/integrations",
  ];
  // Wall-clock and randomness primitives that must never appear in the source
  // (determinism: pure functions over caller-supplied facts; no wall-clock,
  // no randomness, no network).
  const BANNED_PRIMITIVES = [
    "Date.now",
    "new Date",
    "performance.now",
    "Math.random",
    "setTimeout",
    "setInterval",
    "fetch(",
    "XMLHttpRequest",
  ];
  // Node builtins the package may use (path-neutral pure code only): the
  // same primitive the frozen @clapp/observation suite uses for hashing.
  const ALLOWED_NODE_BUILTINS = new Set(["node:crypto"]);

  for (const file of files) {
    const source = readFileSync(join(packageRoot.pathname, file), "utf8");

    // Extract every import specifier: from "..." (single) and from '...' (single quotes).
    const specifiers = [
      ...source.matchAll(/from\s+"([^"]+)"/g),
      ...source.matchAll(/from\s+'([^']+)'/g),
    ].map((match) => match[1]);

    assert.ok(
      specifiers.length > 0 || file === "index.ts" || source.includes("export"),
      `module ${file} is inspectable (has imports or is a re-export barrel)`,
    );

    for (const specifier of specifiers) {
      // The package consumes @clapp/contracts (type-only alignment is fine),
      // in-package relative modules, and node:crypto (path-neutral pure code).
      const isContracts = specifier === "@clapp/contracts";
      const isRelative = specifier.startsWith("./") || specifier.startsWith("../");
      const isAllowedNodeBuiltin = ALLOWED_NODE_BUILTINS.has(specifier);
      assert.ok(
        isContracts || isRelative || isAllowedNodeBuiltin,
        `module ${file} imports "${specifier}"; the package may consume only @clapp/contracts, in-package relative modules, or node:crypto (path-neutral pure code)`,
      );

      // No cross-lane package ever appears in an import specifier.
      for (const banned of BANNED_PACKAGES)
        assert.ok(
          !specifier.includes(banned),
          `module ${file} must not import ${banned} (ADR-002, ADR-004)`,
        );
    }

    // No wall-clock / randomness / network primitive ever enters the source.
    for (const banned of BANNED_PRIMITIVES)
      assert.ok(
        !source.includes(banned),
        `module ${file} source must not contain "${banned}" (determinism: no wall-clock, no randomness, no network)`,
      );
  }

  // The package version constants are pinned at v0.1 (ADR-004: frozen at landing).
  assert.strictEqual(CLAPP_NATIVE_IOS_ENVIRONMENT_VERSION, "0.1");
  assert.strictEqual(CLAPP_NATIVE_IOS_TARGET_VERSION, "0.1");
});
