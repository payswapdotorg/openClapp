import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  ANDROID_EVIDENCE_ID_PREFIX,
  type AndroidElementNode,
  type AndroidEnvironment,
  type AndroidObservation,
  type AndroidObservationResult,
  type AndroidSynthesisTarget,
  type AndroidVerificationResult,
  type AndroidVerificationRun,
  bindAndroidObservationHost,
  bindAndroidVerificationHost,
  ClappNativeAndroidError,
  emitObservationEvidence,
  type ObservationEvidenceResult,
  observeAndroidScreen,
  validateAndroidEnvironment,
  validateAndroidSynthesisTarget,
  verifyAndroidJourneys,
} from "../packages/clapp-native-android/src/index.ts";

/**
 * CLAPP-NATIVE-ANDROID — the Android native adapter tests (ADR-004, the
 * frozen five-component v0.1 contract).
 *
 * Eight named tests over the five v0.1 components: the fail-closed
 * environment validator (every malformation named with its observed value,
 * the frozen vocabulary pinned — a foreign value refuses); the observation
 * honest-absent law (`none` framework → the typed refusal, the host seam
 * NEVER called — a spy host proves zero calls); the observation measurement
 * (a scripted host element-tree → the MEASURED snapshot + the evidence
 * refs, id/digest determinism, the `ndev_` prefix pinned, the digest
 * RECOMPUTED independently from node:crypto + a hand-rolled canonical
 * serializer — never trusted from the adapter); the evidence discipline
 * (classification honest, ids content-derived — same tree → same id, a
 * changed tree → a different id); the synthesis-target validator (the
 * frozen packaging vocabulary, sorted/deduped identifier lists, named
 * errors); the verification seam (the duck-typed runner, counts MEASURED,
 * reasons VERBATIM, no parity/verdict construction — a fake DiffReport-shaped
 * return is a named error); the bind-time seam validation (a malformed host
 * → a typed error at bind, never at call); and the import-discipline pin
 * (the no-fork law: the package imports ONLY `@clapp/contracts` TYPE-ONLY
 * plus in-package modules, no sibling `@clapp/*`, no `apps/**`, only the
 * path-neutral `node:crypto` builtin, and no wall-clock/randomness
 * primitives — the readdirSync/src-list pin style).
 *
 * Deterministic only: no wall-clock, no randomness, no network, no
 * filesystem beyond the package's own src directory scan in the
 * import-discipline pin.
 */

// ---- the fixtures (deterministic, in-file — no fixture-import complications) --------

const VALID_ENVIRONMENT: AndroidEnvironment = {
  environmentVersion: "0.1",
  platform: "android",
  apiLevel: 34,
  uiTestFramework: "uiautomator",
  packaging: "apk",
};

const NONE_ENVIRONMENT: AndroidEnvironment = {
  environmentVersion: "0.1",
  platform: "android",
  apiLevel: 0,
  uiTestFramework: "none",
  packaging: "apk",
};

/** A leaf element node (text/contentDescription may be empty). */
function leaf(
  resourceId: string,
  className: string,
  text = "",
  contentDescription = "",
): AndroidElementNode {
  return { resourceId, className, text, contentDescription, children: [] };
}

/**
 * A seven-node tree of depth three (root + two children + four
 * grandchildren) — the fixture the digest/count/depth assertions recompute
 * against independently.
 */
const SEVEN_NODE_TREE: AndroidElementNode = {
  resourceId: "com.example:id/root",
  className: "android.view.ViewGroup",
  text: "",
  contentDescription: "root group",
  children: [
    {
      resourceId: "com.example:id/group_a",
      className: "android.view.ViewGroup",
      text: "",
      contentDescription: "",
      children: [
        leaf("com.example:id/btn_save", "android.widget.Button", "Save", "save button"),
        leaf("com.example:id/btn_cancel", "android.widget.Button", "Cancel", "cancel button"),
      ],
    },
    {
      resourceId: "com.example:id/group_b",
      className: "android.view.ViewGroup",
      text: "",
      contentDescription: "",
      children: [
        leaf("com.example:id/edit_email", "android.widget.EditText", "", "email field"),
        leaf("com.example:id/edit_pass", "android.widget.EditText", "", "password field"),
      ],
    },
  ],
};

/** A CHANGED tree (one text mutated) — mints a different screenDigest and a different evidence id. */
const CHANGED_TREE: AndroidElementNode = {
  ...SEVEN_NODE_TREE,
  children: [
    SEVEN_NODE_TREE.children[0],
    {
      ...SEVEN_NODE_TREE.children[1],
      children: [
        leaf(
          "com.example:id/edit_email",
          "android.widget.EditText",
          "user@example.com",
          "email field",
        ),
        leaf("com.example:id/edit_pass", "android.widget.EditText", "", "password field"),
      ],
    },
  ],
};

const VALID_TARGET: AndroidSynthesisTarget = {
  targetVersion: "0.1",
  platform: "android",
  applicationId: "org.clapp.example",
  packaging: ["aab", "apk"],
  activities: ["MainActivity", "SettingsActivity"],
};

/** A spy observation host recording every captureScreen() call. */
function spyObservationHost(tree: AndroidElementNode): {
  host: { captureScreen(): Promise<AndroidElementNode> };
  calls: number;
} {
  let calls = 0;
  const host = {
    captureScreen(): Promise<AndroidElementNode> {
      calls += 1;
      return Promise.resolve(tree);
    },
  };
  return {
    host,
    get calls() {
      return calls;
    },
  };
}

/** A fake verification host with a scripted per-journey outcome map. */
function fakeVerificationHost(
  outcomes: Record<string, { completed: boolean; failureReason?: string }>,
): { host: object; calls: string[] } {
  const calls: string[] = [];
  const host = {
    runJourney(journeyId: string): Promise<{ completed: boolean; failureReason?: string }> {
      calls.push(journeyId);
      const outcome = outcomes[journeyId];
      if (outcome === undefined) {
        return Promise.reject(new Error(`no scripted outcome for journey ${journeyId}`));
      }
      return Promise.resolve(outcome);
    },
  };
  return { host, calls };
}

// ---- independent recompute (never trusts the adapter's own digest) -----------------

/** sha256 hex, recomputed independently from node:crypto (never the package's helper). */
function independentSha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Encodes text as UTF-8 bytes. */
function independentUtf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/**
 * Canonical JSON, recomputed independently here (object keys sorted
 * recursively, arrays in order, no whitespace, undefined → null) — never the
 * package's own serializer. The recompute must equal the adapter's measured
 * digest over the same tree.
 */
function independentCanonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(independentCanonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${independentCanonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Unwraps an ok observation (a refusal fails the test loudly, never silently). */
function observationOf(result: AndroidObservationResult): AndroidObservation {
  if (!result.ok) {
    throw new Error(`expected an ok observation, got errors: ${result.errors.join("; ")}`);
  }
  return result.observation;
}

/** Unwraps an ok verification run (a refusal fails the test loudly, never silently). */
function runOf(result: AndroidVerificationResult): AndroidVerificationRun {
  if (!result.ok) {
    throw new Error(`expected an ok verification run, got errors: ${result.errors.join("; ")}`);
  }
  return result.run;
}

/** Unwraps an ok evidence (a refusal fails the test loudly, never silently). */
function evidenceOf(result: ObservationEvidenceResult) {
  if (!result.ok) {
    throw new Error(`expected ok evidence, got errors: ${result.errors.join("; ")}`);
  }
  return result.evidence;
}

/** The node count, recomputed independently here (measured by traversal, never trusted). */
function countNodes(node: AndroidElementNode): number {
  return 1 + node.children.reduce((total, child) => total + countNodes(child), 0);
}

/** The tree depth, recomputed independently here (the root is depth 1). */
function depthOf(node: AndroidElementNode): number {
  if (node.children.length === 0) {
    return 1;
  }
  return 1 + Math.max(...node.children.map((child) => depthOf(child)));
}

// ---- the import-discipline pin helpers (the readdirSync/src-list style) ------------

/** Recursively lists every .ts file under dir. */
function listTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listTsFiles(full));
    } else if (entry.name.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

/** Named import/export-from statements: (clause, specifier) pairs. */
const FROM_RE = /^[ \t]*(?:import|export)\s+([^'";]*?)\s*from\s*['"]([^'"]+)['"]/gm;

/** Bare side-effect imports: `import '…'`. */
const BARE_RE = /^[ \t]*import\s*['"]([^'"]+)['"]/gm;

/** Dynamic imports: `import('…')`. */
const DYNAMIC_RE = /import\(\s*['"]([^'"]+)['"]\s*\)/g;

function sourceImports(source: string): Array<{ clause: string; specifier: string }> {
  const found: Array<{ clause: string; specifier: string }> = [];
  for (const match of source.matchAll(FROM_RE)) {
    found.push({ clause: (match[1] ?? "").trim(), specifier: match[2] ?? "" });
  }
  return found;
}

/** Wall-clock and randomness primitives that must never appear in the package src. */
const BANNED_PRIMITIVES = [
  "Date.now",
  "new Date",
  "performance.now",
  "Math.random",
  "setTimeout",
  "setInterval",
];

// ---- the eight named tests ----------------------------------------------------------

test("CLAPP-NATIVE-ANDROID (a): the environment validator is fail-closed with named errors for every malformation and a foreign-value refusal", () => {
  // The valid environment passes.
  assert.deepEqual(validateAndroidEnvironment(VALID_ENVIRONMENT), { ok: true });

  // Every malformation refuses, naming its field AND the observed value.
  const cases: Array<{ patch: Record<string, unknown>; names: string[] }> = [
    { patch: { platform: "ios" }, names: ["platform", "ios"] },
    { patch: { environmentVersion: "0.2" }, names: ["environmentVersion", "0.2"] },
    { patch: { apiLevel: -1 }, names: ["apiLevel"] },
    { patch: { apiLevel: 1.5 }, names: ["apiLevel"] },
    { patch: { uiTestFramework: "robotium" }, names: ["uiTestFramework", "robotium"] },
    { patch: { packaging: "ipa" }, names: ["packaging", "ipa"] },
  ];

  for (const { patch, names } of cases) {
    const malformed: Record<string, unknown> = { ...VALID_ENVIRONMENT, ...patch };
    const result = validateAndroidEnvironment(malformed);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.errors.length > 0, `expected named errors for ${JSON.stringify(patch)}`);
      for (const name of names) {
        assert.ok(
          result.errors.some((error) => error.includes(name)),
          `expected an error naming "${name}" for ${JSON.stringify(patch)}; got: ${result.errors.join("; ")}`,
        );
      }
    }
  }

  // apiLevel zero is a VALID honest-absent value (the ADR's non-negative law).
  assert.deepEqual(validateAndroidEnvironment({ ...VALID_ENVIRONMENT, apiLevel: 0 }), { ok: true });

  // A non-object environment refuses wholesale, naming the observed shape.
  const nonObject = validateAndroidEnvironment(null);
  assert.equal(nonObject.ok, false);
  if (!nonObject.ok) {
    assert.ok(
      nonObject.errors.some((e) => e.includes("object")),
      "non-object environment names its shape",
    );
  }
});

test("CLAPP-NATIVE-ANDROID (b): a `none` framework refuses observation with a typed named error and never calls the host seam", async () => {
  const { host, calls } = spyObservationHost(SEVEN_NODE_TREE);
  const result = await observeAndroidScreen(host, NONE_ENVIRONMENT);

  // The honest-absent refusal: a typed named-error result.
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.errors.length > 0);
    assert.ok(
      result.errors.some((e) => e.includes("none")),
      `the refusal names the "none" framework; got: ${result.errors.join("; ")}`,
    );
  }

  // THE HOST-SEAM LAW: the host was NEVER called (no framework bound to call).
  assert.equal(
    calls,
    0,
    "the spy host must record zero captureScreen() calls under a `none` framework",
  );
});

test("CLAPP-NATIVE-ANDROID (c): the observation adapter measures the capture honestly — digest, node count, observed depth, and the evidence refs (id/digest determinism, prefix pinned)", async () => {
  const { host } = spyObservationHost(SEVEN_NODE_TREE);
  const observation = observationOf(await observeAndroidScreen(host, VALID_ENVIRONMENT));

  // The digest is RECOMPUTED independently here — node:crypto + a hand-rolled
  // canonical serializer — and must equal the measured one.
  const expectedDigest = independentSha256Hex(
    independentUtf8(independentCanonicalJson(SEVEN_NODE_TREE)),
  );
  assert.equal(observation.screenDigest, expectedDigest);

  // The counts: the fixture's shape (7 nodes, depth 3), measured by traversal
  // AND recomputed independently here.
  assert.equal(observation.nodeCount, 7);
  assert.equal(observation.observedDepth, 3);
  assert.equal(observation.nodeCount, countNodes(SEVEN_NODE_TREE));
  assert.equal(observation.observedDepth, depthOf(SEVEN_NODE_TREE));

  // The observation runs under the validated environment's version.
  assert.equal(observation.environmentVersion, VALID_ENVIRONMENT.environmentVersion);

  // The evidence refs: the measured snapshot → the evidence emitter → the
  // `ndev_`-prefixed, content-derived id; the digest carried verbatim.
  const ctx = {
    targetId: "target-001",
    reconstructionId: "recon-001",
    capturedAt: "2026-10-14T00:00:00.000Z",
  };
  const evidence = evidenceOf(emitObservationEvidence(observation, "screen-tree", ctx));

  assert.ok(
    evidence.id.startsWith(ANDROID_EVIDENCE_ID_PREFIX),
    `evidence id starts with the frozen prefix; got ${evidence.id}`,
  );
  assert.equal(evidence.id.startsWith("ndev_"), true);
  // id/digest determinism: the prefix + a sha256 hex tail.
  assert.ok(
    /^ndev_[0-9a-f]{64}$/.test(evidence.id),
    `evidence id is ndev_ + 64 hex; got ${evidence.id}`,
  );
  assert.equal(evidence.sha256, observation.screenDigest); // verbatim, never re-asserted
  assert.equal(evidence.classification, "observed"); // the honest one
  assert.equal(evidence.targetId, ctx.targetId);
  assert.equal(evidence.reconstructionId, ctx.reconstructionId);
});

test("CLAPP-NATIVE-ANDROID (d): the evidence emitter mints content-derived ids — same tree → same id, a changed tree → a different id, classification honest", async () => {
  const ctx = {
    targetId: "target-001",
    reconstructionId: "recon-001",
    capturedAt: "2026-10-14T00:00:00.000Z",
  };
  const observation = observationOf(
    await observeAndroidScreen(spyObservationHost(SEVEN_NODE_TREE).host, VALID_ENVIRONMENT),
  );
  const changedObservation = observationOf(
    await observeAndroidScreen(spyObservationHost(CHANGED_TREE).host, VALID_ENVIRONMENT),
  );

  // The two trees mint different screenDigests (a changed tree → a different digest).
  assert.notEqual(observation.screenDigest, changedObservation.screenDigest);

  const first = emitObservationEvidence(observation, "screen-tree", ctx);
  const second = emitObservationEvidence(observation, "screen-tree", ctx);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);

  // Determinism: the same capture + kind + context mints deep-equal evidence.
  if (first.ok && second.ok) {
    assert.deepEqual(first.evidence, second.evidence);
    // A changed tree mints a DIFFERENT evidence id.
    const changed = evidenceOf(emitObservationEvidence(changedObservation, "screen-tree", ctx));
    assert.notEqual(first.evidence.id, changed.id);
  }

  // Classification is the honest one — `observed` only, never fabricated.
  if (first.ok) {
    assert.equal(first.evidence.classification, "observed");
    assert.equal(first.evidence.redacted, false);
  }

  // A malformed observation (missing/non-string screenDigest) is a NAMED error.
  const bad = emitObservationEvidence({}, "screen-tree", ctx);
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.ok(
      bad.errors.some((e) => e.includes("screenDigest")) ||
        bad.errors.some((e) => e.includes("observation")),
    );
  }

  // A non-empty-string kind is a NAMED error.
  const badKind = emitObservationEvidence(observation, "", ctx);
  assert.equal(badKind.ok, false);
});

test("CLAPP-NATIVE-ANDROID (e): the synthesis-target validator enforces the frozen packaging vocabulary and sorted/deduped identifier lists", () => {
  // The valid target passes.
  assert.deepEqual(validateAndroidSynthesisTarget(VALID_TARGET), { ok: true });

  // A foreign packaging value refuses, naming the observed value.
  const unknownPackaging = validateAndroidSynthesisTarget({
    ...VALID_TARGET,
    packaging: ["apk", "ipa"],
  });
  assert.equal(unknownPackaging.ok, false);
  if (!unknownPackaging.ok) {
    assert.ok(unknownPackaging.errors.some((e) => e.includes("ipa")));
  }

  // Unsorted packaging refuses, named.
  const unsortedPackaging = validateAndroidSynthesisTarget({
    ...VALID_TARGET,
    packaging: ["apk", "aab"],
  });
  assert.equal(unsortedPackaging.ok, false);
  if (!unsortedPackaging.ok) {
    assert.ok(unsortedPackaging.errors.some((e) => e.includes("sorted")));
  }

  // Duplicate packaging refuses, named.
  const dupPackaging = validateAndroidSynthesisTarget({
    ...VALID_TARGET,
    packaging: ["apk", "apk"],
  });
  assert.equal(dupPackaging.ok, false);
  if (!dupPackaging.ok) {
    assert.ok(dupPackaging.errors.some((e) => e.includes("duplicate")));
  }

  // Empty packaging refuses (at least one entry required), named.
  const emptyPackaging = validateAndroidSynthesisTarget({
    ...VALID_TARGET,
    packaging: [],
  });
  assert.equal(emptyPackaging.ok, false);
  if (!emptyPackaging.ok) {
    assert.ok(emptyPackaging.errors.some((e) => e.includes("packaging")));
  }

  // An empty applicationId refuses, named.
  const emptyAppId = validateAndroidSynthesisTarget({
    ...VALID_TARGET,
    applicationId: "",
  });
  assert.equal(emptyAppId.ok, false);
  if (!emptyAppId.ok) {
    assert.ok(emptyAppId.errors.some((e) => e.includes("applicationId")));
  }

  // Unsorted activities refuse, named.
  const unsortedActivities = validateAndroidSynthesisTarget({
    ...VALID_TARGET,
    activities: ["SettingsActivity", "MainActivity"],
  });
  assert.equal(unsortedActivities.ok, false);
  if (!unsortedActivities.ok) {
    assert.ok(unsortedActivities.errors.some((e) => e.includes("sorted")));
  }
});

test("CLAPP-NATIVE-ANDROID (f): the verification seam measures counts through the host, carries reasons verbatim, and never constructs a parity/verdict record", async () => {
  const journeys = ["journey-a", "journey-b", "journey-c"];
  const { host, calls } = fakeVerificationHost({
    "journey-a": { completed: true },
    "journey-b": { completed: false, failureReason: "button not found" },
    "journey-c": { completed: true },
  });

  const run = runOf(await verifyAndroidJourneys(host, journeys, VALID_ENVIRONMENT));

  // Every journey ran through the host, in the given order — asserted from
  // the host's own recording, never trusted.
  assert.deepEqual(calls, journeys);
  assert.deepEqual(run.journeyIds, journeys);

  // MEASURED counts: 2 completed, 1 failed.
  assert.equal(run.completed, 2);
  assert.equal(run.failed, 1);
  assert.equal(run.completed + run.failed, journeys.length);

  // The failure reason rides VERBATIM, in journey order.
  assert.deepEqual(run.failures, [{ journeyId: "journey-b", reason: "button not found" }]);

  // The run executes under the validated environment's version.
  assert.equal(run.environmentVersion, VALID_ENVIRONMENT.environmentVersion);

  // THE DIFF BOUNDARY: a host outcome shaped like a DiffReport (carrying a
  // `verdict` or `findings` field) is a NAMED error — the adapter never
  // constructs a parity/verdict record, and refuses a host that feeds it one.
  const diffHost = {
    runJourney: () => Promise.resolve({ verdict: "equivalent", findings: [] }),
  };
  const diffResult = await verifyAndroidJourneys(diffHost, ["journey-a"], VALID_ENVIRONMENT);
  assert.equal(diffResult.ok, false);
  if (!diffResult.ok) {
    assert.ok(
      diffResult.errors.some(
        (e) => e.includes("DiffReport") || e.includes("verdict") || e.includes("parity"),
      ),
      `the DiffReport-shaped outcome is a named error; got: ${diffResult.errors.join("; ")}`,
    );
  }
});

test("CLAPP-NATIVE-ANDROID (g): a malformed host raises a typed error at BIND time, never at a call", async () => {
  // The observation seam: a host missing captureScreen fails the BIND.
  assert.throws(
    () => bindAndroidObservationHost({}),
    (error: unknown) => {
      assert.ok(
        error instanceof ClappNativeAndroidError,
        "the bind error is the typed ClappNativeAndroidError",
      );
      assert.equal((error as ClappNativeAndroidError).component, "observation-host");
      return true;
    },
  );
  // A non-object host fails the bind too.
  assert.throws(
    () => bindAndroidObservationHost(null),
    (error: unknown) => error instanceof ClappNativeAndroidError,
  );

  // The verification seam: a host missing runJourney fails the BIND.
  assert.throws(
    () => bindAndroidVerificationHost({}),
    (error: unknown) => {
      assert.ok(error instanceof ClappNativeAndroidError);
      assert.equal((error as ClappNativeAndroidError).component, "verification-host");
      return true;
    },
  );
  assert.throws(
    () => bindAndroidVerificationHost(null),
    (error: unknown) => error instanceof ClappNativeAndroidError,
  );

  // "Never at a call": the composed observe path with a malformed host
  // raises the typed bind error (the env-validation gate passes on a valid
  // env, so the bind is the next gate — it throws before any host call is
  // reachable). The promise REJECTS with the typed error.
  await assert.rejects(observeAndroidScreen({}, VALID_ENVIRONMENT), (error: unknown) => {
    assert.ok(
      error instanceof ClappNativeAndroidError,
      "observe raises the typed bind error before any call",
    );
    return true;
  });
  await assert.rejects(
    verifyAndroidJourneys({}, ["journey-a"], VALID_ENVIRONMENT),
    (error: unknown) => {
      assert.ok(
        error instanceof ClappNativeAndroidError,
        "verify raises the typed bind error before any call",
      );
      return true;
    },
  );
});

test("CLAPP-NATIVE-ANDROID (h): the package imports ONLY @clapp/contracts TYPE-ONLY plus in-package modules — the no-fork law is pinned", () => {
  const packageRoot = dirname(new URL(".", import.meta.url).pathname); // .../openClapp/
  // The package lives at packages/clapp-native-android under the repo root.
  const srcDir = join(packageRoot, "packages", "clapp-native-android", "src");
  const srcFiles = listTsFiles(srcDir).sort();

  assert.ok(srcFiles.length > 0, "the package's src directory is non-empty");

  const forbiddenSpecifiers = new Set([
    "@clapp/intelligence",
    "@clapp/synthesis",
    "@clapp/runtime-openmuse",
    "@clapp/observation",
    "@clapp/benchmarks",
  ]);
  // The only @clapp/ package this adapter may consume, TYPE-ONLY.
  const allowedClappSpecifier = "@clapp/contracts";
  // The only node builtin the package touches — path-neutral pure code (sha256).
  const allowedNodeBuiltin = "node:crypto";
  const violations: string[] = [];

  for (const file of srcFiles) {
    const display = file.slice(packageRoot.length + 1);
    const source = readFileSync(file, "utf8");

    for (const { clause, specifier } of sourceImports(source)) {
      if (specifier.startsWith("@clapp/")) {
        if (forbiddenSpecifiers.has(specifier)) {
          violations.push(
            `${display}: forbidden import of ${JSON.stringify(specifier)} — the no-fork law allows no sibling @clapp/* package`,
          );
          continue;
        }
        if (specifier !== allowedClappSpecifier) {
          violations.push(
            `${display}: undeclared workspace dependency ${JSON.stringify(specifier)} — the only consumed package is @clapp/contracts (TYPE-ONLY)`,
          );
          continue;
        }
        // The allowed @clapp/contracts must be consumed TYPE-ONLY.
        if (!clause.startsWith("type")) {
          violations.push(
            `${display}: RUNTIME import of ${JSON.stringify(specifier)} — the no-fork law allows TYPE-ONLY consumption of @clapp/contracts`,
          );
        }
        continue;
      }
      if (
        specifier.startsWith("apps/") ||
        specifier.startsWith("./apps/") ||
        specifier.startsWith("../apps/")
      ) {
        violations.push(`${display}: forbidden apps/** import ${JSON.stringify(specifier)}`);
        continue;
      }
      if (specifier.startsWith("node:")) {
        if (specifier !== allowedNodeBuiltin) {
          violations.push(
            `${display}: forbidden node builtin ${JSON.stringify(specifier)} — only the path-neutral ${allowedNodeBuiltin} pure-code primitive is allowed`,
          );
        }
        continue;
      }
      if (specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("/")) {
        continue; // in-package relative module — allowed
      }
      violations.push(
        `${display}: non-workspace package import ${JSON.stringify(specifier)} — the package consumes only @clapp/contracts (TYPE-ONLY) and in-package modules`,
      );
    }

    for (const match of source.matchAll(BARE_RE)) {
      const specifier = match[1] ?? "";
      if (
        !specifier.startsWith("node:") &&
        !specifier.startsWith("./") &&
        !specifier.startsWith("../")
      ) {
        violations.push(`${display}: bare side-effect import ${JSON.stringify(specifier)}`);
      }
    }
    for (const match of source.matchAll(DYNAMIC_RE)) {
      const specifier = match[1] ?? "";
      if (
        !specifier.startsWith("./") &&
        !specifier.startsWith("../") &&
        !specifier.startsWith("node:")
      ) {
        violations.push(`${display}: dynamic import ${JSON.stringify(specifier)}`);
      }
    }

    for (const banned of BANNED_PRIMITIVES) {
      assert.ok(
        !source.includes(banned),
        `${display}: the package src must not contain the banned primitive "${banned}"`,
      );
    }
  }

  assert.deepEqual(
    violations,
    [],
    `the no-fork law is pinned: the package imports only @clapp/contracts TYPE-ONLY + in-package modules + node:crypto; got:\n${violations.join("\n")}`,
  );
});
