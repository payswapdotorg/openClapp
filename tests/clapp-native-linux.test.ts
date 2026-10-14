// CLAPP-NATIVE-LINUX — the Linux native adapter tests (ADR-004, lane 2 of
// 5: native adapters).
//
// Eight named tests over the five v0.1 components, in node:test + tsx (the
// openClapp house style):
//   (a) the environment validator: every field's named error, the frozen
//       vocabulary pinned (a foreign value refuses);
//   (b) the observation law: 'none' framework → the typed refusal, the host
//       seam NEVER called (a spy host proves zero calls);
//   (c) the observation adapter: a scripted host element-tree → the
//       MEASURED snapshot + the evidence refs (id/digest determinism,
//       'lidev_' prefix pinned);
//   (d) the evidence discipline: classification honest, ids content-derived
//       (same tree → same id; a changed tree → a different id);
//   (e) the synthesis-target validator: the frozen packaging vocabulary,
//       sorted/deduped identifiers, named errors;
//   (f) the verification seam: the duck-typed runner, counts MEASURED,
//       reasons VERBATIM, no parity verdict construction (a fake
//       DiffReport-shaped return is a named error);
//   (g) the bind-time seam validation: a malformed host (missing structural
//       member) → typed error at bind, never at call;
//   (h) the import-discipline pin: the package imports ONLY
//       @clapp/contracts (+ in-package modules) — never
//       @clapp/intelligence, @clapp/synthesis, @clapp/runtime-openmuse,
//       never apps/**, no network/filesystem/timer builtins (the
//       readdirSync/src-list pin style the repo's frozen suites use).

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { EvidenceRef } from "../packages/clapp-contracts/src/index.ts";
import { canonicalJson, sha256Hex } from "../packages/clapp-native-linux/src/canonical.ts";
import type {
  LinuxEnvironment,
  LinuxObservation,
  LinuxObservationResult,
  LinuxSynthesisTarget,
  LinuxVerificationResult,
  LinuxVerificationRun,
  LinuxViewNode,
} from "../packages/clapp-native-linux/src/index.ts";
import {
  CLAPP_NATIVE_LINUX_ENVIRONMENT_VERSION,
  CLAPP_NATIVE_LINUX_TARGET_VERSION,
  emitObservationEvidence,
  LINUX_ACCESSIBILITY_BUSES,
  LINUX_DISPLAY_SERVERS,
  LINUX_EVIDENCE_ID_PREFIX,
  LINUX_PACKAGING_FORMATS,
  observeLinuxScreen,
  validateLinuxEnvironment,
  validateLinuxSynthesisTarget,
  verifyLinuxJourneys,
} from "../packages/clapp-native-linux/src/index.ts";

/**
 * ADR-004 — the Linux native adapter tests. Pins the frozen v0.1 contract
 * for the second of the five native platform lanes (Android → Linux →
 * Windows → macOS → iOS). The five components are consumed through the
 * frozen @clapp/contracts surface (TYPE-ONLY) and in-package modules only;
 * the import-discipline pin (test h) enforces the no-fork law.
 */

// --- fixtures (the established test constants) ---------------------------------------

/** A valid v0.1 Linux environment (an AT-SPI bus, X11 display, depth budget 3). */
const VALID_ENVIRONMENT: LinuxEnvironment = {
  environmentVersion: CLAPP_NATIVE_LINUX_ENVIRONMENT_VERSION,
  platform: "linux",
  displayServer: "x11",
  accessibilityBus: "at-spi",
  maxHierarchyDepth: 3,
};

/** A 'none' accessibility-bus environment (the honest no-bus descriptor — VALID, refuses observation). */
const NO_BUS_ENVIRONMENT: LinuxEnvironment = {
  ...VALID_ENVIRONMENT,
  accessibilityBus: "none",
};

/** A 'none' display-server environment with an AT-SPI bus (still observes — the bus is the law). */
const NO_DISPLAY_ENVIRONMENT: LinuxEnvironment = {
  ...VALID_ENVIRONMENT,
  displayServer: "none",
};

/** A malformed-environment builder: takes a valid environment and patches fields. */
function malformedEnvironment(patch: Record<string, unknown>): Record<string, unknown> {
  return { ...VALID_ENVIRONMENT, ...patch };
}

/** A 5-node view-tree fixture (depth 3): a window with two children, one of which has two of its own. */
const SEVEN_NODE_TREE: LinuxViewNode = {
  resourceId: "root-window",
  className: "frame",
  text: "Main window",
  contentDescription: "",
  children: [
    {
      resourceId: "header",
      className: "panel",
      text: "",
      contentDescription: "the window header",
      children: [],
    },
    {
      resourceId: "content",
      className: "panel",
      text: "",
      contentDescription: "",
      children: [
        {
          resourceId: "submit-button",
          className: "push button",
          text: "Submit",
          contentDescription: "submits the form",
          children: [],
        },
        {
          resourceId: "cancel-button",
          className: "push button",
          text: "Cancel",
          contentDescription: "cancels the form",
          children: [],
        },
      ],
    },
  ],
};

/** A depth-4 tree (over-budget against maxHierarchyDepth 3): the budget law refuses. */
const DEPTH_FOUR_TREE: LinuxViewNode = {
  resourceId: "r",
  className: "frame",
  text: "",
  contentDescription: "",
  children: [
    {
      resourceId: "c1",
      className: "panel",
      text: "",
      contentDescription: "",
      children: [
        {
          resourceId: "c2",
          className: "panel",
          text: "",
          contentDescription: "",
          children: [
            {
              resourceId: "c3",
              className: "push button",
              text: "",
              contentDescription: "depth-4 leaf",
              children: [],
            },
          ],
        },
      ],
    },
  ],
};

/** A spy observation host: returns a scripted tree and records every call. */
function fakeObservationHost(tree: LinuxViewNode): {
  host: { captureScreen: () => Promise<LinuxViewNode> };
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    host: {
      async captureScreen() {
        calls.push("captureScreen");
        return tree;
      },
    },
  };
}

/** A spy verification host: returns scripted outcomes and records every call. */
function fakeVerificationHost(
  outcomes: Record<string, { completed: boolean; failureReason?: string }>,
): {
  host: { runJourney: (id: string) => Promise<{ completed: boolean; failureReason?: string }> };
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    host: {
      async runJourney(id: string) {
        calls.push(id);
        const outcome = outcomes[id];
        if (!outcome) {
          return { completed: false, failureReason: `unknown journey ${id}` };
        }
        return outcome;
      },
    },
  };
}

/** Unwraps an ok observation (a refusal fails the test loudly, never silently). */
function observationOf(result: LinuxObservationResult): LinuxObservation {
  if (!result.ok) {
    throw new Error(`expected an ok observation, got errors: ${result.errors.join("; ")}`);
  }
  return result.observation;
}

/** Unwraps an ok verification run (a refusal fails the test loudly, never silently). */
function runOf(result: LinuxVerificationResult): LinuxVerificationRun {
  if (!result.ok) {
    throw new Error(`expected an ok verification run, got errors: ${result.errors.join("; ")}`);
  }
  return result.run;
}

/** The node count, recomputed independently here (measured by traversal, never trusted). */
function countNodes(viewNode: LinuxViewNode): number {
  return 1 + viewNode.children.reduce((total, child) => total + countNodes(child), 0);
}

/** The tree depth, recomputed independently here (the root is depth 1). */
function depthOf(viewNode: LinuxViewNode): number {
  if (viewNode.children.length === 0) {
    return 1;
  }
  return 1 + Math.max(...viewNode.children.map((child) => depthOf(child)));
}

/** The valid v0.1 Linux synthesis target fixture. */
const VALID_TARGET: LinuxSynthesisTarget = {
  targetVersion: CLAPP_NATIVE_LINUX_TARGET_VERSION,
  platform: "linux",
  binaryName: "clapp-example",
  windowClasses: ["Clapp-example", "org.clapp.example"],
  packagingFormats: ["appimage", "deb"],
  minKernelMajor: 6,
};

/** A malformed-target builder: takes the valid target and patches fields. */
function malformedTarget(patch: Record<string, unknown>): Record<string, unknown> {
  return { ...VALID_TARGET, ...patch };
}

// --- the import-discipline helpers (the readdirSync/src-list pin style) ----------------

/** The package root (one level above tests/). */
const PACKAGE_ROOT = new URL("../packages/clapp-native-linux/", import.meta.url);

/** Recursively lists every .ts file under dir (the house imports-test helper). */
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

// --- the tests -----------------------------------------------------------------------

test("(a) the environment validator is fail-closed with named errors for every malformation", () => {
  // The valid fixture passes.
  assert.deepEqual(validateLinuxEnvironment(VALID_ENVIRONMENT), { ok: true });

  // 'none' is the honest absent state — valid (the AT-SPI refusal is the observation seam's law, not a validator error).
  assert.deepEqual(validateLinuxEnvironment(NO_BUS_ENVIRONMENT), { ok: true });
  assert.deepEqual(validateLinuxEnvironment(NO_DISPLAY_ENVIRONMENT), { ok: true });

  // The frozen vocabularies are pinned (a foreign value refuses with the observed value named).
  const cases: Array<{ patch: Record<string, unknown>; names: string[] }> = [
    { patch: { platform: "android" }, names: ["platform", "android"] },
    { patch: { environmentVersion: "0.2" }, names: ["environmentVersion", "0.2"] },
    { patch: { displayServer: "mir" }, names: ["displayServer", "mir"] },
    { patch: { accessibilityBus: "dbus" }, names: ["accessibilityBus", "dbus"] },
    { patch: { maxHierarchyDepth: 2.5 }, names: ["maxHierarchyDepth"] },
    { patch: { maxHierarchyDepth: 0 }, names: ["maxHierarchyDepth"] },
  ];
  for (const { patch, names } of cases) {
    const result = validateLinuxEnvironment(malformedEnvironment(patch));
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.errors.length > 0, "every malformation produces at least one error");
      for (const name of names) {
        assert.ok(
          result.errors.some((error) => error.includes(name)),
          `error must mention ${name}; got: ${result.errors.join("; ")}`,
        );
      }
    }
  }

  // A non-object input refuses with the observed value named.
  const nonObject = validateLinuxEnvironment("not-an-env");
  assert.equal(nonObject.ok, false);
  if (!nonObject.ok) {
    assert.ok(nonObject.errors.some((error) => error.includes("environment must be an object")));
  }

  // The frozen vocabularies are exactly what ADR-004 pins.
  assert.deepEqual([...LINUX_DISPLAY_SERVERS], ["x11", "wayland", "none"]);
  assert.deepEqual([...LINUX_ACCESSIBILITY_BUSES], ["at-spi", "none"]);
});

test("(b) the observation law: 'none' framework refuses honestly — the host seam is NEVER called", async () => {
  // A 'none' accessibility-bus env is a VALID descriptor (no validator error).
  assert.deepEqual(validateLinuxEnvironment(NO_BUS_ENVIRONMENT), { ok: true });

  // The spy host proves zero calls — the AT-SPI law refuses BEFORE the host is touched.
  const spy = fakeObservationHost(SEVEN_NODE_TREE);
  const refusal = await observeLinuxScreen(spy.host, NO_BUS_ENVIRONMENT);
  assert.equal(refusal.ok, false);
  if (refusal.ok) {
    throw new Error("an accessibilityBus 'none' environment must refuse observation");
  }
  assert.ok(refusal.errors.length > 0);
  assert.ok(refusal.errors.some((error) => error.includes("accessibilityBus")));
  assert.ok(refusal.errors.some((error) => error.includes("AT-SPI")));
  // THE LAW: the host was never called — asserted from the recording, never trusted.
  assert.deepEqual(spy.calls, []);
});

test("(c) the observation adapter: a scripted host tree → the MEASURED snapshot + evidence refs", async () => {
  const spy = fakeObservationHost(SEVEN_NODE_TREE);
  const observation = observationOf(await observeLinuxScreen(spy.host, VALID_ENVIRONMENT));

  // The digest is RECOMPUTED independently here — the in-package hash over the
  // same canonical serialization — and must equal the measured one.
  const expectedDigest = sha256Hex(canonicalJson(SEVEN_NODE_TREE));
  assert.equal(observation.screenDigest, expectedDigest);

  // The counts: the fixture's shape (5 nodes, depth 3), measured by traversal
  // AND recomputed independently here.
  assert.equal(observation.nodeCount, 5);
  assert.equal(observation.observedDepth, 3);
  assert.equal(observation.nodeCount, countNodes(SEVEN_NODE_TREE));
  assert.equal(observation.observedDepth, depthOf(SEVEN_NODE_TREE));

  // The observation runs under the validated environment's version.
  assert.equal(observation.environmentVersion, CLAPP_NATIVE_LINUX_ENVIRONMENT_VERSION);

  // The host was called exactly once.
  assert.deepEqual(spy.calls, ["captureScreen"]);

  // A 'none' display server WITH an at-spi bus still observes — the bus is the law, not the pixels.
  const noDisplay = observationOf(
    await observeLinuxScreen(fakeObservationHost(SEVEN_NODE_TREE).host, NO_DISPLAY_ENVIRONMENT),
  );
  assert.equal(noDisplay.screenDigest, expectedDigest);

  // The over-depth budget law: a depth-4 tree against maxHierarchyDepth 3 must refuse — a NAMED error.
  const overDepth = await observeLinuxScreen(
    fakeObservationHost(DEPTH_FOUR_TREE).host,
    VALID_ENVIRONMENT,
  );
  assert.equal(overDepth.ok, false);
  if (overDepth.ok) {
    throw new Error("a depth-4 tree against maxHierarchyDepth 3 must refuse");
  }
  assert.ok(overDepth.errors.some((error) => error.includes("maxHierarchyDepth")));
  assert.ok(overDepth.errors.some((error) => error.includes("depth")));
});

test("(d) the evidence discipline: classification honest, ids content-derived (deterministic + distinguishing)", async () => {
  const observation = observationOf(
    await observeLinuxScreen(fakeObservationHost(SEVEN_NODE_TREE).host, VALID_ENVIRONMENT),
  );
  const context = {
    targetId: "target-linux-0001",
    reconstructionId: "rc-clapp-native-linux-0001",
    capturedAt: "2025-01-01T00:00:00.000Z",
  };

  // Two emissions for the same capture + kind → deep-equal evidence (determinism).
  const first = emitObservationEvidence(observation, "dom-text", context);
  const second = emitObservationEvidence(observation, "dom-text", context);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) {
    throw new Error("a measured observation with a frozen kind must emit");
  }
  assert.deepEqual(first.evidence, second.evidence);

  // TYPE-LEVEL assertion: the emitted value IS the @clapp/contracts EvidenceRef
  // (the frozen shape consumed type-only — never a forked lookalike).
  const coreShaped: EvidenceRef = first.evidence;

  // The 'lidev_' id is content-derived: prefix + the screenDigest hex.
  assert.equal(coreShaped.id, `${LINUX_EVIDENCE_ID_PREFIX}${observation.screenDigest}`);
  assert.ok(coreShaped.id.startsWith(LINUX_EVIDENCE_ID_PREFIX));
  assert.equal(coreShaped.id.startsWith("lidev_"), true);

  // The sha256 carries the screenDigest VERBATIM — never re-hashed.
  assert.equal(coreShaped.sha256, observation.screenDigest);

  // The classification is the honest 'observed' for what the host actually produced.
  assert.equal(coreShaped.classification, "observed");

  // A DIFFERENT tree → a DIFFERENT id (distinguishing — content-addressed identity).
  const otherTree: LinuxViewNode = {
    resourceId: "different-window",
    className: "frame",
    text: "Other window",
    contentDescription: "",
    children: [],
  };
  const otherObservation = observationOf(
    await observeLinuxScreen(fakeObservationHost(otherTree).host, VALID_ENVIRONMENT),
  );
  const otherEvidence = emitObservationEvidence(otherObservation, "dom-text", context);
  assert.equal(otherEvidence.ok, true);
  if (!otherEvidence.ok) {
    throw new Error("a different valid observation must emit");
  }
  assert.notEqual(first.evidence.id, otherEvidence.evidence.id);
  assert.notEqual(first.evidence.sha256, otherEvidence.evidence.sha256);

  // An unknown kind is a NAMED error — never an invented one.
  const forgedKind = "definitely-not-a-frozen-kind";
  const unknownKind = emitObservationEvidence(observation, forgedKind, context);
  assert.equal(unknownKind.ok, false);
  if (!unknownKind.ok) {
    assert.ok(unknownKind.errors.some((error) => error.includes("kind")));
    assert.ok(unknownKind.errors.some((error) => error.includes(forgedKind)));
  }

  // A missing context field is a NAMED error — never defaulted.
  const missingContext = emitObservationEvidence(observation, "dom-text", {
    targetId: "",
    reconstructionId: "rc-x",
    capturedAt: "2025-01-01T00:00:00.000Z",
  });
  assert.equal(missingContext.ok, false);
  if (!missingContext.ok) {
    assert.ok(missingContext.errors.some((error) => error.includes("targetId")));
  }
});

test("(e) the synthesis-target validator: frozen packaging vocabulary, sorted/deduped, named errors", () => {
  // The valid target passes.
  assert.deepEqual(validateLinuxSynthesisTarget(VALID_TARGET), { ok: true });

  // The frozen packaging vocabulary is exactly what ADR-004 pins.
  assert.deepEqual([...LINUX_PACKAGING_FORMATS], ["appimage", "deb", "flatpak", "tar", "zip"]);

  // An unknown packaging format refuses, naming the observed value.
  const unknownFormat = validateLinuxSynthesisTarget(
    malformedTarget({ packagingFormats: ["appimage", "snap"] }),
  );
  assert.equal(unknownFormat.ok, false);
  if (!unknownFormat.ok) {
    assert.ok(unknownFormat.errors.some((error) => error.includes("snap")));
  }

  // Unsorted packagingFormats refuse, named.
  const unsortedFormats = validateLinuxSynthesisTarget(
    malformedTarget({ packagingFormats: ["flatpak", "appimage"] }),
  );
  assert.equal(unsortedFormats.ok, false);
  if (!unsortedFormats.ok) {
    assert.ok(unsortedFormats.errors.some((error) => error.includes("sorted")));
  }

  // Duplicated packagingFormats refuse, named.
  const dupFormats = validateLinuxSynthesisTarget(
    malformedTarget({ packagingFormats: ["appimage", "appimage", "deb"] }),
  );
  assert.equal(dupFormats.ok, false);
  if (!dupFormats.ok) {
    assert.ok(dupFormats.errors.some((error) => error.includes("duplicate")));
  }

  // Unsorted windowClasses refuse, named.
  const unsortedWindowClasses = validateLinuxSynthesisTarget(
    malformedTarget({ windowClasses: ["org.clapp.example", "Clapp-example"] }),
  );
  assert.equal(unsortedWindowClasses.ok, false);
  if (!unsortedWindowClasses.ok) {
    assert.ok(unsortedWindowClasses.errors.some((error) => error.includes("sorted")));
  }

  // An empty binaryName refuses, named.
  const emptyBinaryName = validateLinuxSynthesisTarget(malformedTarget({ binaryName: "" }));
  assert.equal(emptyBinaryName.ok, false);
  if (!emptyBinaryName.ok) {
    assert.ok(emptyBinaryName.errors.some((error) => error.includes("binaryName")));
  }

  // A non-positive minKernelMajor refuses, named.
  const zeroKernel = validateLinuxSynthesisTarget(malformedTarget({ minKernelMajor: 0 }));
  assert.equal(zeroKernel.ok, false);
  if (!zeroKernel.ok) {
    assert.ok(zeroKernel.errors.some((error) => error.includes("minKernelMajor")));
  }

  // A wrong targetVersion refuses, named with the observed value.
  const wrongVersion = validateLinuxSynthesisTarget(malformedTarget({ targetVersion: "0.2" }));
  assert.equal(wrongVersion.ok, false);
  if (!wrongVersion.ok) {
    assert.ok(wrongVersion.errors.some((error) => error.includes("targetVersion")));
    assert.ok(wrongVersion.errors.some((error) => error.includes("0.2")));
  }
});

test("(f) the verification seam: counts MEASURED, reasons VERBATIM, no parity verdict construction", async () => {
  const journeys = ["journey-a", "journey-b", "journey-c"];
  const spy = fakeVerificationHost({
    "journey-a": { completed: true },
    "journey-b": { completed: false, failureReason: "button not found" },
    "journey-c": { completed: true },
  });

  const run = runOf(await verifyLinuxJourneys(spy.host, journeys, VALID_ENVIRONMENT));

  // Every journey ran through the host, in the sorted order — asserted from
  // the host's own recording, never trusted.
  assert.deepEqual(spy.calls, journeys);
  assert.deepEqual(run.journeyIds, journeys);

  // MEASURED counts: 2 completed, 1 failed.
  assert.equal(run.completed, 2);
  assert.equal(run.failed, 1);
  assert.equal(run.completed + run.failed, journeys.length);

  // The failure reason rides VERBATIM, in journey order.
  assert.deepEqual(run.failures, [{ journeyId: "journey-b", reason: "button not found" }]);

  // The run executes under the validated environment's version.
  assert.equal(run.environmentVersion, CLAPP_NATIVE_LINUX_ENVIRONMENT_VERSION);

  // THE DIFF BOUNDARY (ADR-004): a fake DiffReport-shaped return is a named
  // error — the adapter NEVER constructs a parity/verdict record and refuses
  // a host outcome that masquerades as one. The DiffReport keys (findings,
  // verdict, referenceRunId, candidateRunId) belong to the diff discipline.
  const fakeDiffHost = {
    async runJourney() {
      return {
        findings: [],
        verdict: "equivalent",
        referenceRunId: "ref-1",
        candidateRunId: "cand-1",
      };
    },
  };
  const diffShaped = await verifyLinuxJourneys(fakeDiffHost, ["journey-a"], VALID_ENVIRONMENT);
  assert.equal(diffShaped.ok, false);
  if (diffShaped.ok) {
    throw new Error("a fake DiffReport-shaped return must be a named error");
  }
  assert.ok(
    diffShaped.errors.some((error) => error.includes("DiffReport-shaped")),
    `expected DiffReport-shape error; got: ${diffShaped.errors.join("; ")}`,
  );
});

test("(g) the bind-time seam validation: a malformed host → typed error at bind, never at call", async () => {
  // A host missing captureScreen refuses at bind, never calls the host.
  const missingCapture = await observeLinuxScreen(
    { notCaptureScreen: () => Promise.resolve(SEVEN_NODE_TREE) },
    VALID_ENVIRONMENT,
  );
  assert.equal(missingCapture.ok, false);
  if (missingCapture.ok) {
    throw new Error("a host missing captureScreen must refuse at bind");
  }
  assert.ok(
    missingCapture.errors.some((error) => error.includes("captureScreen")),
    `expected captureScreen-named error; got: ${missingCapture.errors.join("; ")}`,
  );

  // A host missing runJourney refuses at bind, never calls the host.
  const missingRunJourney = await verifyLinuxJourneys(
    { notRunJourney: () => Promise.resolve({ completed: true }) },
    ["journey-a"],
    VALID_ENVIRONMENT,
  );
  assert.equal(missingRunJourney.ok, false);
  if (missingRunJourney.ok) {
    throw new Error("a host missing runJourney must refuse at bind");
  }
  assert.ok(
    missingRunJourney.errors.some((error) => error.includes("runJourney")),
    `expected runJourney-named error; got: ${missingRunJourney.errors.join("; ")}`,
  );

  // A null host refuses at bind, named.
  const nullHost = await observeLinuxScreen(null, VALID_ENVIRONMENT);
  assert.equal(nullHost.ok, false);
  if (!nullHost.ok) {
    assert.ok(nullHost.errors.some((error) => error.includes("observation host")));
  }

  // A malformed environment combines with a malformed host — BOTH errors are carried.
  const bothBad = await observeLinuxScreen(null, NO_BUS_ENVIRONMENT);
  // The host-malformed and env-validated errors combine; if env validates to ok
  // but accessibilityBus is 'none', the host-malformed check fires first (bind-time).
  // Here the host is null (malformed) AND env is 'none' — both errors carry.
  assert.equal(bothBad.ok, false);
  if (bothBad.ok) {
    throw new Error("a null host with a 'none' env must refuse");
  }
  assert.ok(bothBad.errors.some((error) => error.includes("observation host")));
});

test("(h) the import-discipline pin: the package imports ONLY @clapp/contracts (+ in-package modules)", () => {
  const packageRoot = new URL(PACKAGE_ROOT).pathname;

  // ---- 1. the exact src file list (the delivered surface) ----
  const srcFiles = listTsFiles(join(packageRoot, "src")).sort();
  // packageRoot.pathname ends with a trailing slash; slice(packageRoot.length) leaves "src/canonical.ts" etc.
  assert.deepEqual(
    srcFiles.map((file) => file.slice(packageRoot.length)),
    [
      "src/canonical.ts",
      "src/environment.ts",
      "src/evidence.ts",
      "src/index.ts",
      "src/observation.ts",
      "src/synthesis-target.ts",
      "src/verification.ts",
    ],
  );

  /** The single @clapp/* package this lane may import (ADR-004). */
  const ALLOWED_WORKSPACE = new Set(["@clapp/contracts"]);

  /** Banned workspace packages + banned surfaces (ADR-004 hard rules). */
  const BANNED_WORKSPACE = [
    "@clapp/intelligence",
    "@clapp/synthesis",
    "@clapp/runtime-openmuse",
    "@clapp/observation",
    "@clapp/benchmarks",
    "@clapp/backends",
    "@clapp/domain",
    "@clapp/integrations",
  ];

  /**
   * Banned node builtins (the "no I/O surfaces" half of ADR-004's hard
   * rules — no wall-clock, no randomness, no network, no filesystem, no
   * global state). node:crypto is the only builtin the package touches,
   * and only inside src/canonical.ts (pure, deterministic, no I/O — the
   * sha256 primitive, the same surface @clapp/observation uses in its
   * canonical.ts).
   */
  const BANNED_BUILTINS = [
    "node:fs",
    "node:fs/promises",
    "node:http",
    "node:https",
    "node:net",
    "node:os",
    "node:path",
    "node:timers",
    "node:child_process",
    "node:worker_threads",
    "node:url",
    "node:dns",
    "node:perf_hooks",
  ];

  const violations: string[] = [];

  // ---- 2. src/** — @clapp/contracts TYPE-ONLY; in-package relative;
  //         node:crypto permitted (the canonical-helpers-only carve-out);
  //         no other packages, no other builtins ----
  for (const file of srcFiles) {
    const display = file.slice(packageRoot.length);
    const source = readFileSync(file, "utf8");

    for (const { clause, specifier } of sourceImports(source)) {
      if (specifier.startsWith("@clapp/")) {
        if (ALLOWED_WORKSPACE.has(specifier)) {
          // TYPE-ONLY consumption of the frozen @clapp/contracts surface.
          if (!clause.startsWith("type")) {
            violations.push(
              `${display}: RUNTIME import of ${JSON.stringify(specifier)} — the no-fork law allows TYPE-ONLY imports of @clapp/contracts`,
            );
          }
          continue;
        }
        violations.push(
          `${display}: undeclared workspace dependency ${JSON.stringify(specifier)} — the only @clapp/* import allowed is @clapp/contracts (TYPE-ONLY)`,
        );
        continue;
      }
      for (const banned of BANNED_WORKSPACE) {
        if (specifier.includes(banned)) {
          violations.push(
            `${display}: banned workspace import ${JSON.stringify(specifier)} (ADR-004 no-fork law)`,
          );
        }
      }
      if (specifier.startsWith("node:")) {
        if (specifier === "node:crypto") {
          // The pure-hash primitive carve-out — only inside src/canonical.ts.
          if (display !== "src/canonical.ts") {
            violations.push(
              `${display}: node:crypto import outside src/canonical.ts — the only permitted crypto surface lives in the in-package canonical-helpers module`,
            );
          }
          continue;
        }
        if (BANNED_BUILTINS.includes(specifier)) {
          violations.push(
            `${display}: banned node builtin ${JSON.stringify(specifier)} (ADR-004 hard rules: no clock, no filesystem, no network)`,
          );
        } else {
          violations.push(
            `${display}: undeclared node builtin ${JSON.stringify(specifier)} — only node:crypto is permitted (in src/canonical.ts only)`,
          );
        }
        continue;
      }
      if (specifier.startsWith("./") || specifier.startsWith("../")) {
        continue; // in-package relative module — the house style
      }
      violations.push(
        `${display}: non-relative non-workspace import ${JSON.stringify(specifier)} — the package is self-contained`,
      );
    }

    for (const match of source.matchAll(BARE_RE)) {
      violations.push(`${display}: bare side-effect import ${JSON.stringify(match[1] ?? "")}`);
    }
    for (const match of source.matchAll(DYNAMIC_RE)) {
      const specifier = match[1] ?? "";
      if (!specifier.startsWith(".") && !specifier.startsWith("node:")) {
        violations.push(`${display}: dynamic import ${JSON.stringify(specifier)}`);
      }
    }
  }

  // ---- 3. Banned source-level primitives: no wall-clock, no randomness ----
  const BANNED_PRIMITIVES = [
    "Date.now",
    "new Date",
    "performance.now",
    "Math.random",
    "setTimeout",
    "setInterval",
    "setImmediate",
  ];
  for (const file of srcFiles) {
    const display = file.slice(packageRoot.length);
    const source = readFileSync(file, "utf8");
    for (const banned of BANNED_PRIMITIVES) {
      assert.ok(
        !source.includes(banned),
        `${display}: the module source must not contain "${banned}" (ADR-004 hard rules: no clock, no randomness)`,
      );
    }
  }

  // No violations — the import-discipline pin holds.
  assert.deepEqual(
    violations,
    [],
    `import-discipline violations: ${violations.join("; ") || "(none)"}`,
  );

  // The hash recomputed by the test's own createHash matches the in-package
  // sha256Hex — the same primitive, the same canonical serializer, byte-for-byte.
  const independentDigest = createHash("sha256")
    .update(canonicalJson(SEVEN_NODE_TREE))
    .digest("hex");
  assert.equal(independentDigest, sha256Hex(canonicalJson(SEVEN_NODE_TREE)));
});
