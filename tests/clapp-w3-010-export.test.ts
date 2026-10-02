import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type {
  BehavioralIr,
  ClappPackage,
  EvidenceRef,
  Journey,
  ReconstructionSpec,
} from "../packages/clapp-contracts/src/index.ts";
import { canonicalJson } from "../packages/clapp-synthesis/src/canonical.ts";
import { contentHash } from "../packages/clapp-synthesis/src/hash.ts";
import {
  buildExportBundle,
  type CompositionGraph,
  type CompositionInput,
  type CompositionPlan,
  digestE2eAcceptance,
  E2E_BASE_STATE_LIMITATIONS,
  type E2eAcceptanceDigest,
  type E2eAcceptanceRun,
  EXPORT_BUNDLE_DIGEST_PREFIX,
  EXPORT_BUNDLE_FORMAT_VERSION,
  type ExportBundle,
  ExportBundleError,
  type ExportBundleInput,
  generateCandidateApp,
  planComposition,
  planSynthesisApp,
  serializeExportBundle,
  type ValidationResult,
  validateSynthesisPlan,
  verifyExportBundle,
} from "../packages/clapp-synthesis/src/index.ts";

/**
 * CLAPP-W3-010 — export/deployment packaging (wave 10 lane 6).
 *
 * Proves the deployment half of the reconstruction chain: a reconstructed,
 * VERIFIED candidate exports as a deployable artifact bundle whose
 * provenance manifest carries the base SHA, the composition plan, the
 * package set and the verification report ids, sealed by a content-addressed
 * bundle digest; the documented reproducible-build check passes byte-exact
 * on the untampered bundle and fails closed — collecting EVERY issue — when
 * any artifact or manifest field disagrees; an unverified candidate refuses
 * export honestly; the whole export is deterministic; malformed inputs fail
 * closed with one typed error; and the module composes only frozen
 * synthesis surfaces (no cross-lane import).
 *
 * The seam composes the REAL surfaces end-to-end: a real W3-009
 * `planComposition` mints the composition plan, a real W3-001
 * `planSynthesisApp` → `validateSynthesisPlan` flow mints the plan input, a
 * real W3-002 `generateCandidateApp` mints the candidate's deployable file
 * set, and a real W3-008 `digestE2eAcceptance` run (a small honest
 * E2eAcceptanceRun — every stage artifact is present and well-formed, every
 * stage outcome "succeeded") mints the verification evidence. Deterministic
 * throughout: pinned FIXED_MS clock, fixed literals, no network.
 */

// ---------------------------------------------------------------------------
// Fixed constants (the established pinned-clock pattern)
// ---------------------------------------------------------------------------

const FIXED_MS = 1735689600000; // 2025-01-01T00:00:00.000Z — the pinned export clock
const FIXED_ISO = new Date(FIXED_MS).toISOString();
const fixedClock = () => FIXED_MS;

/** The reconstruction base commit — this very work item's base SHA (40-hex). */
const BASE_SHA = "3a792b99e0f70a8bc3e25d060f0736bd2788bbee";

/** Two paired-verification report ids in the frozen "dr-" family shape. */
const PAIRED_REPORT_IDS = [
  "dr-fedcba9876543210", // deliberately unsorted input order — the manifest canonicalizes
  "dr-0123456789abcdef",
] as const;
const SORTED_PAIRED_REPORT_IDS = [...PAIRED_REPORT_IDS].sort();

const RECON = "rc-w3-0010";
const CANDIDATE_ID = "cand-w3-0010";

// ---------------------------------------------------------------------------
// Registry / composition fixtures (the W3-009 pattern, two-package variant)
// ---------------------------------------------------------------------------

function makePackageDoc(overrides: Partial<ClappPackage> = {}): ClappPackage {
  return {
    schemaVersion: "0.1",
    id: overrides.id ?? "clapp_pkg_fixture",
    version: overrides.version ?? "0.1.0",
    category: overrides.category ?? "CRUD SaaS",
    purpose: overrides.purpose ?? "W3-010 export fixture",
    interface: overrides.interface ?? {},
    capabilities: overrides.capabilities ?? [],
    constraints: overrides.constraints ?? [],
    dependencies: overrides.dependencies ?? [],
    supportedTargets: overrides.supportedTargets ?? [],
    tests: overrides.tests ?? [],
    benchmark: overrides.benchmark ?? {},
    failureModes: overrides.failureModes ?? [],
    provenance: overrides.provenance ?? {},
  };
}

/** The two same-archetype, graph-adjacent, promoted packages the plan composes. */
const ANCHOR = makePackageDoc({
  id: "clapp_pkg_anchor",
  version: "1.0.0",
  capabilities: ["http-api", "persistent-state"],
  supportedTargets: ["web"],
});
const EXTENSION = makePackageDoc({
  id: "clapp_pkg_ext",
  version: "0.2.0",
  capabilities: ["auth-sessions"],
  supportedTargets: ["web"],
});

/** The W3-009 composition input: verdict + snapshot + graph + policy. */
function compositionInput(): CompositionInput {
  const graph: CompositionGraph = {
    nodes: [
      { id: "clapp_pkg_anchor", version: "1.0.0", promoted: true },
      { id: "clapp_pkg_ext", version: "0.2.0", promoted: true },
    ],
    edges: [
      {
        from: { id: "clapp_pkg_anchor", version: "1.0.0" },
        to: { id: "clapp_pkg_ext", version: "0.2.0" },
        kind: "category-shared",
        reason: "category-shared",
      },
    ],
  };
  return {
    verdict: { label: "CRUD SaaS", confidence: 0.82 },
    // Deliberately unsorted input order — the manifest canonicalizes the set.
    packages: [EXTENSION, ANCHOR],
    graph,
    packagePolicy: "verified-only",
  };
}

// ---------------------------------------------------------------------------
// Plan/generator fixtures (the W3-001 pattern)
// ---------------------------------------------------------------------------

function makeSpec(): ReconstructionSpec {
  return {
    specVersion: "0.1",
    reconstructionId: RECON,
    targetId: "target-w3-0010",
    name: "W3-010 Export Fixture",
    platform: "web",
    entrypoints: ["/"],
    authorization: {
      ownerId: "owner-1",
      targetId: "target-w3-0010",
      scope: ["reconstruct:ui"],
      environments: ["sandbox"],
      retention: "project",
      benchmarkOwned: true,
      createdAt: FIXED_ISO,
    },
    exploration: { maxStages: 4, maxActions: 64, maxDurationMs: 300000, seed: 42 },
    synthesis: { targetStack: "static-web", allowNetwork: false, packagePolicy: "verified-only" },
    verification: {
      journeys: ["j-login", "j-search"],
      visual: true,
      network: false,
      state: true,
      maxRepairIterations: 2,
    },
  };
}

function makeModel(): BehavioralIr {
  const observedRef = (kind: string, id: string): EvidenceRef =>
    ({
      kind,
      id,
      classification: "observed",
      capturedAt: FIXED_ISO,
    }) as EvidenceRef;
  const unavailableRef = (kind: string, id: string): EvidenceRef =>
    ({
      kind,
      id,
      classification: "unavailable",
      capturedAt: FIXED_ISO,
    }) as EvidenceRef;
  const journeys: Journey[] = [
    {
      id: "j-login",
      name: "Sign in",
      preconditions: [],
      steps: [
        { id: "s-login-1", action: "fill", target: "#username", input: { value: "alice" } },
        { id: "s-login-2", action: "click", target: "#submit" },
      ],
    },
    {
      id: "j-search",
      name: "Search",
      preconditions: [],
      steps: [{ id: "s-search-1", action: "fill", target: "#query" }],
    },
  ];
  return {
    schemaVersion: "0.1",
    application: {
      id: "app-w3-0010",
      name: "W3-010 Export Fixture",
      platform: "web",
      entrypoints: ["/"],
    },
    evidence: [
      observedRef("dom", "evidence-dom-login"),
      observedRef("network", "evidence-net-search"),
      unavailableRef("storage", "evidence-storage-login"),
    ],
    journeys,
    screens: [],
    components: [],
    state: {},
    data: {},
    api: {},
    integrations: [],
    assumptions: [],
    constraints: [],
  };
}

// ---------------------------------------------------------------------------
// The composed export input — every real surface in the chain
// ---------------------------------------------------------------------------

/**
 * Runs the REAL reconstruction chain up to the verified candidate and
 * assembles the export input: W3-009 composition → W3-001 planning →
 * validation → W3-002 generation → the candidate artifact port, plus the
 * W3-008 honest e2e acceptance digest and the paired report ids.
 */
async function composeExportInput(): Promise<{
  input: ExportBundleInput;
  compositionPlan: CompositionPlan;
  digest: E2eAcceptanceDigest;
  generatedFilePaths: string[];
}> {
  const compositionPlan = planComposition(compositionInput());
  assert.equal(compositionPlan.status, "composed");
  assert.deepEqual(compositionPlan.packageIds, ["clapp_pkg_anchor", "clapp_pkg_ext"]);

  const plan = await planSynthesisApp(makeSpec(), makeModel(), compositionPlan.packageIds);
  const validation: ValidationResult = validateSynthesisPlan(plan);
  assert.ok(validation.ok, `the real plan must validate: ${validation.errors.join("; ")}`);

  const generated = generateCandidateApp(plan);

  // The small honest E2eAcceptanceRun: every stage artifact present and
  // well-formed — the real digest therefore reports every stage succeeded.
  const run: E2eAcceptanceRun = {
    reconstructionId: RECON,
    observation: {
      refs: [
        { classification: "observed", capturedAt: FIXED_ISO },
        { classification: "observed", capturedAt: FIXED_ISO },
        { classification: "unavailable", capturedAt: FIXED_ISO },
      ],
      rootSha256: "a".repeat(64),
    },
    extraction: makeModel(),
    plan,
    candidate: generated,
    verification: {
      verdict: "equivalent",
      journeys: [
        { journeyId: "j-login", verdict: "equivalent", findingCount: 0 },
        { journeyId: "j-search", verdict: "equivalent", findingCount: 0 },
      ],
    },
    repair: {
      converged: true,
      stoppedBy: "converged",
      iterations: [{ directiveCount: 0 }],
      abstained: [],
      finalVerdict: "equivalent",
    },
    journeys: [
      { id: "j-login", routePath: "/j-login" },
      { id: "j-search", routePath: "/j-search" },
    ],
  };
  const digest = digestE2eAcceptance(run);
  assert.ok(
    digest.stages.every((stage) => stage.outcome === "succeeded"),
    "the fixture run is honest verification evidence",
  );

  const input: ExportBundleInput = {
    candidateId: CANDIDATE_ID,
    baseSha: BASE_SHA,
    candidateArtifact: {
      files: new Map(generated.files.map((file) => [file.path, file.content])),
    },
    compositionPlan,
    // Deliberately unsorted input order — the manifest canonicalizes the set.
    packageSet: [EXTENSION, ANCHOR],
    verification: { e2eDigest: digest, pairedReportIds: [...PAIRED_REPORT_IDS] },
    now: fixedClock,
  };
  return { input, compositionPlan, digest, generatedFilePaths: generated.files.map((f) => f.path) };
}

/** A parsed copy of the canonical serialization (the deployment round-trip form). */
function parsedCopy(bundle: ExportBundle): Record<string, unknown> {
  return JSON.parse(serializeExportBundle(bundle)) as Record<string, unknown>;
}

/** Loose JSON value / object types for the adversarial tamper mutations. */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

/** Casts an unknown value to the build input shape (the TS bypass pattern). */
function asInput(value: unknown): ExportBundleInput {
  return value as ExportBundleInput;
}

/** Deep-clones a build input, re-attaching the (unclonable) injected clock. */
function cloneInput(input: ExportBundleInput): ExportBundleInput {
  const { now, ...rest } = input;
  const clone = structuredClone(rest) as Omit<ExportBundleInput, "now">;
  return now === undefined ? (clone as ExportBundleInput) : { ...clone, now };
}

/** Asserts a call fails closed with a typed ExportBundleError; returns it. */
function expectExportError(call: () => unknown): ExportBundleError {
  let thrown: unknown = null;
  let threw = false;
  try {
    call();
  } catch (error) {
    threw = true;
    thrown = error;
  }
  assert.ok(threw, "expected the call to fail closed");
  assert.ok(
    thrown instanceof ExportBundleError,
    `expected an ExportBundleError, got: ${String(thrown)}`,
  );
  assert.equal(thrown.name, "ExportBundleError");
  assert.ok(thrown.message.length > 0, "the error explains itself");
  assert.ok(Array.isArray(thrown.issues), "the error collects its issues");
  return thrown;
}

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

/** The module specifiers of every import/export-from statement in a source. */
function importSpecifiersOf(source: string): string[] {
  const specifiers: string[] = [];
  const pattern = /\bfrom\s+(["'])([^"'\n]+)\1/g;
  let match = pattern.exec(source);
  while (match !== null) {
    specifiers.push(match[2]);
    match = pattern.exec(source);
  }
  return specifiers;
}

const EXPORT_SOURCE = "../packages/clapp-synthesis/src/export-bundle.ts";

// ---------------------------------------------------------------------------
// Required test 1 — the verified candidate exports as a deployable bundle
// ---------------------------------------------------------------------------

test("a reconstructed, verified candidate exports as a deployable artifact bundle with a provenance manifest", async () => {
  const { input, generatedFilePaths } = await composeExportInput();
  const inputSnapshot = cloneInput(input);
  const manifestSnapshot = structuredClone(input.compositionPlan);

  const bundle = buildExportBundle(input);

  // Purity: the input is never mutated.
  assert.deepEqual(input, inputSnapshot);
  assert.deepEqual(input.compositionPlan, manifestSnapshot);

  // The bundle is the manifest + the artifact payload itself.
  assert.equal(typeof bundle.manifest, "object");
  assert.ok(bundle.files instanceof Map);
  assert.deepEqual(
    [...bundle.files.keys()].sort(),
    [...generatedFilePaths].sort(),
    "the payload is exactly the candidate's deployable file set",
  );
  for (const [path, content] of bundle.files.entries()) {
    assert.equal(content, input.candidateArtifact.files.get(path));
  }

  // The manifest's per-file entries: one per file, path + sha256 of the content.
  assert.ok(Array.isArray(bundle.manifest.files));
  assert.equal(bundle.manifest.files.length, generatedFilePaths.length);
  assert.deepEqual(
    bundle.manifest.files.map((entry) => entry.path),
    [...bundle.files.keys()],
    "the entries are sorted by path (the canonical form)",
  );
  for (const entry of bundle.manifest.files) {
    assert.deepEqual(Object.keys(entry).sort(), ["path", "sha256"]);
    assert.equal(entry.sha256, contentHash(bundle.files.get(entry.path)));
  }

  // The bundle digest: the clapp_export_ family shape, sealed over the core.
  assert.match(bundle.manifest.bundleDigest, /^clapp_export_[0-9a-f]{16}$/);
  assert.ok(
    bundle.manifest.bundleDigest.startsWith(EXPORT_BUNDLE_DIGEST_PREFIX),
    "the digest carries the module-declared prefix",
  );
  assert.equal(bundle.manifest.formatVersion, EXPORT_BUNDLE_FORMAT_VERSION);
  assert.equal(bundle.manifest.formatVersion, "0.1");
  assert.equal(bundle.manifest.builtAt, FIXED_MS);

  // The reproducible-build check passes on the fresh bundle — in-memory and
  // after the serialize → parse round-trip.
  assert.deepEqual(verifyExportBundle(bundle), { verified: true, issues: [] });
  const parsed = parsedCopy(bundle);
  assert.deepEqual(verifyExportBundle(parsed), { verified: true, issues: [] });
});

// ---------------------------------------------------------------------------
// Required test 2 — the manifest carries the provenance fields
// ---------------------------------------------------------------------------

test("the manifest carries the base SHA, the composition plan, the package set, and the verification report ids", async () => {
  const { input, compositionPlan, digest } = await composeExportInput();
  // The candidateId is trimmed on the way in.
  const bundle = buildExportBundle({
    ...input,
    candidateId: `  ${CANDIDATE_ID}  `,
  });
  const manifest = bundle.manifest;

  // The base SHA — verbatim, full 40-hex.
  assert.equal(manifest.baseSha, BASE_SHA);
  assert.match(manifest.baseSha, /^[0-9a-f]{40}$/);
  assert.equal(manifest.candidateId, CANDIDATE_ID);

  // The composition plan — verbatim: status, selections, packageIds, notes,
  // compositionDigest (a deep copy, never an alias).
  assert.equal(manifest.composition.status, "composed");
  assert.deepEqual(manifest.composition, compositionPlan);
  assert.deepEqual(manifest.composition.packageIds, ["clapp_pkg_anchor", "clapp_pkg_ext"]);
  assert.equal(manifest.composition.selections.length, 2);
  assert.deepEqual(
    manifest.composition.selections.map((selection) => [selection.role, selection.packageId]),
    [
      ["archetype-anchor", "clapp_pkg_anchor"],
      ["compatible-extension", "clapp_pkg_ext"],
    ],
  );
  assert.ok(manifest.composition.compositionDigest.length > 0);
  assert.notEqual(manifest.composition, compositionPlan, "the plan is deep-copied, never aliased");

  // The package set — id, version and contentDigest per package, sorted by
  // id, and NEVER the full documents.
  assert.deepEqual(
    manifest.packageSet.map((entry) => entry.id),
    ["clapp_pkg_anchor", "clapp_pkg_ext"],
    "the entries are sorted by id (the canonical form)",
  );
  for (const entry of manifest.packageSet) {
    assert.deepEqual(Object.keys(entry).sort(), ["contentDigest", "id", "version"]);
    assert.equal(entry.contentDigest, contentHash(ANCHOR.id === entry.id ? ANCHOR : EXTENSION));
  }

  // The verification report ids — every id, sorted (the canonical set).
  assert.deepEqual(manifest.verification.pairedReportIds, SORTED_PAIRED_REPORT_IDS);
  assert.deepEqual(manifest.verification.e2eDigest, digest, "the e2e evidence is carried verbatim");
  assert.deepEqual(manifest.verification.e2eDigest.limitations, E2E_BASE_STATE_LIMITATIONS);
});

// ---------------------------------------------------------------------------
// Required test 3 — the reproducible-build check passes byte-exact
// ---------------------------------------------------------------------------

test("the reproducible-build check passes byte-exact on an untampered bundle", async () => {
  const { input } = await composeExportInput();
  const bundle = buildExportBundle(input);

  // In-memory form: verified, zero issues.
  assert.deepEqual(verifyExportBundle(bundle), { verified: true, issues: [] });

  // The canonical serialization: sorted keys, sorted file paths, no
  // whitespace variance — and a re-parse reproduces byte-identical digests.
  const text = serializeExportBundle(bundle);
  const parsed = JSON.parse(text) as {
    manifest: Record<string, unknown>;
    files: Record<string, string>;
  };
  assert.deepEqual(verifyExportBundle(parsed), { verified: true, issues: [] });
  assert.equal(
    (parsed.manifest.bundleDigest as string) ?? "",
    bundle.manifest.bundleDigest,
    "the digest survives the round-trip byte-exact",
  );

  // The serialized file payload is sorted by path (the canonical form).
  assert.deepEqual(Object.keys(parsed.files), [...bundle.files.keys()]);

  // Re-serializing the reconstructed bundle reproduces byte-identical text.
  const reconstructed = {
    manifest: parsed.manifest as unknown as ExportBundle["manifest"],
    files: new Map(Object.entries(parsed.files)),
  };
  assert.equal(serializeExportBundle(reconstructed), text);

  // The serialized manifest itself is canonical: re-serializing its parse is
  // a fixed point.
  assert.equal(
    canonicalJson(parsed.manifest),
    canonicalJson(JSON.parse(canonicalJson(parsed.manifest))),
  );
});

// ---------------------------------------------------------------------------
// Required test 4 — tampering fails closed with every issue collected
// ---------------------------------------------------------------------------

test("any tampered artifact or manifest field fails closed with every issue collected", async () => {
  const { input } = await composeExportInput();
  const bundle = buildExportBundle(input);
  const aFilePath = [...bundle.files.keys()].find((path) => path.endsWith("server.ts")) ?? "";

  /** A tampered PARSED copy (the deployment form), verified fail-closed. */
  const tamperIssues = (mutate: (parsed: JsonObject) => void): string[] => {
    const parsed = JSON.parse(serializeExportBundle(bundle)) as JsonObject;
    mutate(parsed);
    const result = verifyExportBundle(parsed);
    assert.equal(result.verified, false, "a tampered bundle must fail closed");
    assert.ok(result.issues.length > 0, "the verdict collects issues");
    return result.issues;
  };

  // --- a tampered artifact payload ---
  let issues = tamperIssues((parsed) => {
    (parsed.files as JsonObject)[aFilePath] = "tampered content";
  });
  assert.ok(
    issues.some((issue) => issue.includes("hash mismatch")),
    issues.join("; "),
  );
  assert.ok(
    issues.some((issue) => issue.includes(aFilePath)),
    issues.join("; "),
  );

  // --- a missing artifact payload file ---
  issues = tamperIssues((parsed) => {
    delete (parsed.files as JsonObject)[aFilePath];
  });
  assert.ok(
    issues.some(
      (issue) => issue.includes("the manifest lists file") && issue.includes("does not carry it"),
    ),
    issues.join("; "),
  );

  // --- an extra artifact payload file ---
  issues = tamperIssues((parsed) => {
    (parsed.files as JsonObject)["sneaky/extra.js"] = "extra";
  });
  assert.ok(
    issues.some(
      (issue) => issue.includes("the payload carries file") && issue.includes("does not list it"),
    ),
    issues.join("; "),
  );

  // --- tampered manifest fields: even shape-valid values break the digest ---
  const digestTamper = (mutate: (manifest: JsonObject) => void, fragment: string): void => {
    const found = tamperIssues((parsed) => {
      mutate(parsed.manifest as JsonObject);
    });
    assert.ok(
      found.some((issue) => issue.includes("bundle digest mismatch")),
      `${fragment}: expected the re-derived digest to disagree, got: ${found.join("; ")}`,
    );
  };
  digestTamper((m) => {
    m.baseSha = "0".repeat(40);
  }, "baseSha");
  digestTamper((m) => {
    m.candidateId = "cand-imposter";
  }, "candidateId");
  digestTamper((m) => {
    m.builtAt = FIXED_MS + 1;
  }, "builtAt");
  digestTamper((m) => {
    (m.composition as JsonObject).compositionDigest = "0".repeat(64);
  }, "compositionDigest");
  digestTamper((m) => {
    (m.packageSet as JsonObject[])[0].contentDigest = "0".repeat(64);
  }, "package contentDigest");
  digestTamper((m) => {
    (m.verification as JsonObject).pairedReportIds = ["dr-0000000000000bad"];
  }, "pairedReportIds");
  digestTamper((m) => {
    m.bundleDigest = `${EXPORT_BUNDLE_DIGEST_PREFIX}${"0".repeat(16)}`;
  }, "the digest itself");

  // --- a manifest field made structurally invalid: BOTH the field issue and
  // the digest mismatch are collected ---
  issues = tamperIssues((parsed) => {
    (parsed.manifest as JsonObject).baseSha = "not-a-sha";
  });
  assert.equal(issues.length, 2, issues.join("; "));
  assert.ok(issues.some((issue) => issue.includes("baseSha must be a full 40-character")));
  assert.ok(issues.some((issue) => issue.includes("bundle digest mismatch")));

  // --- a removed manifest field: same double collection ---
  issues = tamperIssues((parsed) => {
    delete (parsed.manifest as JsonObject).baseSha;
  });
  assert.ok(issues.some((issue) => issue.includes("baseSha")));
  assert.ok(issues.some((issue) => issue.includes("bundle digest mismatch")));

  // --- a reordered (non-canonical) artifact entry list ---
  issues = tamperIssues((parsed) => {
    const manifest = parsed.manifest as JsonObject;
    manifest.files = [...(manifest.files as JsonObject[])].reverse();
  });
  assert.ok(
    issues.some((issue) => issue.includes("sorted ascending by path")),
    issues.join("; "),
  );
  assert.ok(issues.some((issue) => issue.includes("bundle digest mismatch")));

  // --- an ADDED manifest field (nothing may slip past the core) ---
  issues = tamperIssues((parsed) => {
    (parsed.manifest as JsonObject).smuggled = "field";
  });
  assert.ok(issues.some((issue) => issue.includes("bundle digest mismatch")));

  // --- a dishonest e2e stage: the honesty check fires even when the
  // tamperer RE-DERIVES the digest over the tampered core ---
  issues = tamperIssues((parsed) => {
    const manifest = parsed.manifest as JsonObject;
    const stages = ((manifest.verification as JsonObject).e2eDigest as JsonObject)
      .stages as JsonObject[];
    stages[4].outcome = "failed";
    const { bundleDigest: _omitted, ...core } = manifest;
    manifest.bundleDigest = `${EXPORT_BUNDLE_DIGEST_PREFIX}${contentHash(core).slice(0, 16)}`;
  });
  assert.ok(
    issues.some((issue) => issue.includes('stage "verify" as FAILED')),
    issues.join("; "),
  );
  assert.ok(issues.some((issue) => issue.includes("does not carry honest verification evidence")));

  // --- a multi-tamper bundle: EVERY issue is collected, never just the first ---
  const stateFilePath = [...bundle.files.keys()].find((path) => path.endsWith("state.json")) ?? "";
  const routesEntryIndex = bundle.manifest.files.findIndex((entry) =>
    entry.path.endsWith("routes.json"),
  );
  issues = tamperIssues((parsed) => {
    const files = parsed.files as JsonObject;
    const manifest = parsed.manifest as JsonObject;
    files[aFilePath] = "tampered content";
    files["sneaky/extra.js"] = "extra";
    delete files[stateFilePath];
    (manifest.files as JsonObject[])[routesEntryIndex].sha256 = "0".repeat(64);
    manifest.baseSha = "not-a-sha";
    manifest.candidateId = "cand-imposter";
    (manifest.packageSet as JsonObject[])[0].contentDigest = "0".repeat(64);
  });
  assert.ok(
    issues.length >= 6,
    `expected every issue collected, got ${issues.length}: ${issues.join("; ")}`,
  );
  assert.ok(issues.some((issue) => issue.includes(aFilePath) && issue.includes("hash mismatch")));
  assert.ok(
    issues.some((issue) => issue.includes("sneaky/extra.js") && issue.includes("does not list it")),
  );
  assert.ok(
    issues.some((issue) => issue.includes(stateFilePath) && issue.includes("does not carry it")),
  );
  assert.ok(
    issues.some((issue) => issue.includes("routes.json") && issue.includes("hash mismatch")),
  );
  assert.ok(issues.some((issue) => issue.includes("baseSha must be a full 40-character")));
  assert.ok(issues.some((issue) => issue.includes("bundle digest mismatch")));

  // --- the in-memory form fails closed the same way ---
  const inMemoryTampered = {
    manifest: bundle.manifest,
    files: new Map([...bundle.files.entries(), ["sneaky/extra.js", "extra"]]),
  };
  const inMemoryResult = verifyExportBundle(inMemoryTampered);
  assert.equal(inMemoryResult.verified, false);
  assert.ok(inMemoryResult.issues.some((issue) => issue.includes("does not list it")));

  // --- structurally unparseable inputs are honest verdicts, never throws ---
  for (const garbage of [null, undefined, 42, "text", [], { manifest: 1 }, { files: new Map() }]) {
    const result = verifyExportBundle(garbage);
    assert.equal(result.verified, false, `${String(garbage)} must fail closed`);
    assert.ok(result.issues.length > 0);
  }
});

// ---------------------------------------------------------------------------
// Required test 5 — an unverified candidate refuses export honestly
// ---------------------------------------------------------------------------

test("an unverified candidate refuses export honestly", async () => {
  const { input } = await composeExportInput();

  // A digest whose verification stage FAILED (an unknown paired verdict) is
  // not verification evidence.
  const failedVerificationRun: E2eAcceptanceRun = {
    reconstructionId: RECON,
    observation: { refs: [], rootSha256: "a".repeat(64) },
    extraction: { journeys: [], screens: [], evidence: [], assumptions: [] },
    plan: { routes: [], acceptanceJourneyIds: [] },
    candidate: { manifest: {}, files: [] },
    verification: { verdict: "exploded", journeys: [] },
    journeys: [],
  };
  const failedDigest = digestE2eAcceptance(failedVerificationRun);
  assert.equal(failedDigest.stages[4]?.outcome, "failed");

  const failedError = expectExportError(() =>
    buildExportBundle({
      ...cloneInput(input),
      verification: { e2eDigest: failedDigest, pairedReportIds: [...PAIRED_REPORT_IDS] },
    }),
  );
  assert.equal(failedError.code, "unverified-candidate");
  assert.match(failedError.message, /refuses export/);
  assert.ok(
    failedError.issues.some((issue) => issue.includes('stage "verify" as FAILED')),
    failedError.issues.join("; "),
  );
  assert.ok(
    failedError.issues.some((issue) => issue.includes("not verification evidence")),
    failedError.issues.join("; "),
  );

  // No paired-verification report ids: no verification evidence either.
  const emptyIdsError = expectExportError(() =>
    buildExportBundle({
      ...cloneInput(input),
      verification: {
        e2eDigest: structuredClone(input.verification.e2eDigest),
        pairedReportIds: [],
      },
    }),
  );
  assert.equal(emptyIdsError.code, "unverified-candidate");
  assert.match(emptyIdsError.message, /refuses export/);
  assert.ok(
    emptyIdsError.issues.some((issue) => issue.includes("no paired-verification report ids")),
    emptyIdsError.issues.join("; "),
  );

  // The refusal is honest about the rule's scope: "unavailable" stages are
  // not "failed" stages — the enumerated refusal rule governs, and the
  // bundle carries the digest verbatim so the unavailability stays visible.
  const unavailableDigest = digestE2eAcceptance({ reconstructionId: RECON });
  const exportedAnyway = buildExportBundle({
    ...cloneInput(input),
    verification: { e2eDigest: unavailableDigest, pairedReportIds: [...PAIRED_REPORT_IDS] },
  });
  assert.ok(
    exportedAnyway.manifest.verification.e2eDigest.stages.every(
      (stage) => stage.outcome === "unavailable",
    ),
  );
});

// ---------------------------------------------------------------------------
// Required test 6 — determinism
// ---------------------------------------------------------------------------

test("the export is deterministic — same inputs, byte-identical bundle and serialization", async () => {
  const { input } = await composeExportInput();

  // Same inputs (pinned clock): deep-equal manifests, byte-identical digests
  // and serialization.
  const first = buildExportBundle(cloneInput(input));
  const second = buildExportBundle(cloneInput(input));
  assert.deepEqual(second.manifest, first.manifest);
  assert.equal(second.manifest.bundleDigest, first.manifest.bundleDigest);
  assert.equal(serializeExportBundle(second), serializeExportBundle(first));

  // The default clock path is pinned to the Unix epoch — deterministic too.
  const { now: _clock, ...inputWithoutClock } = input;
  const defaultFirst = buildExportBundle(structuredClone(inputWithoutClock));
  const defaultSecond = buildExportBundle(structuredClone(inputWithoutClock));
  assert.equal(defaultFirst.manifest.builtAt, 0);
  assert.equal(defaultSecond.manifest.builtAt, 0);
  assert.equal(serializeExportBundle(defaultSecond), serializeExportBundle(defaultFirst));

  // Input ORDER never leaks: reversed file-map insertion order, reversed
  // packageSet array order, reversed paired-id order, and key-shuffled
  // input objects all produce the byte-identical serialization.
  const reversedFiles = new Map([...input.candidateArtifact.files.entries()].reverse());
  const shuffledPlan = shuffleKeyOrder(input.compositionPlan);
  const reordered = buildExportBundle({
    ...cloneInput(input),
    candidateArtifact: { files: reversedFiles },
    compositionPlan: shuffledPlan as CompositionPlan,
    packageSet: [...input.packageSet].reverse(),
    verification: {
      e2eDigest: shuffleKeyOrder(input.verification.e2eDigest) as E2eAcceptanceDigest,
      pairedReportIds: [...PAIRED_REPORT_IDS].reverse(),
    },
  });
  assert.equal(serializeExportBundle(reordered), serializeExportBundle(first));
  assert.equal(reordered.manifest.bundleDigest, first.manifest.bundleDigest);

  // Different content produces a different digest (content-addressed, not
  // sequence-addressed).
  const { now: _omit, ...noClock } = input;
  const different = buildExportBundle({
    ...structuredClone(noClock),
    baseSha: "f".repeat(40),
  });
  assert.notEqual(different.manifest.bundleDigest, defaultFirst.manifest.bundleDigest);
});

// ---------------------------------------------------------------------------
// Required test 7 — malformed inputs fail closed, one typed error
// ---------------------------------------------------------------------------

test("malformed inputs fail closed with one typed error collecting every issue", async () => {
  const { input } = await composeExportInput();
  const compositionPlan = input.compositionPlan as unknown as Record<string, unknown>;

  // One call, many malformations: ONE typed error carries EVERY issue.
  const broken = expectExportError(() =>
    buildExportBundle(
      asInput({
        candidateId: "   ",
        baseSha: "not-a-sha",
        candidateArtifact: { files: "nope" },
        compositionPlan: { status: "composed" },
        packageSet: [
          { ...EXTENSION, version: "not-semver" },
          ANCHOR,
          makePackageDoc({ id: "clapp_pkg_anchor", version: "1.0.0" }),
        ],
        verification: { e2eDigest: "not-a-digest", pairedReportIds: [] },
        now: 42,
      }),
    ),
  );
  assert.equal(broken.code, "invalid-input");
  const allBroken = broken.issues.join("\n");
  for (const fragment of [
    "candidateId must be a non-empty string (trimmed)",
    "baseSha must be a full 40-character lowercase-hex git commit SHA",
    "candidateArtifact.files must be a ReadonlyMap",
    "packageIds must be an array of non-empty strings",
    "selections must be an array",
    "compositionDigest must be a 64-hex sha256",
    "packageSet[0].version must be a conforming MAJOR.MINOR.PATCH",
    "duplicate package id",
    "verification.e2eDigest must be an E2eAcceptanceDigest object",
    "now must be a zero-argument clock function",
    "refuses export: the verification port carries no paired-verification report ids",
  ]) {
    assert.ok(
      allBroken.includes(fragment),
      `expected an issue containing "${fragment}", got:\n${allBroken}`,
    );
  }
  assert.ok(broken.issues.length >= 11, `every issue collected, got ${broken.issues.length}`);

  // A non-object input fails closed with the structural issue.
  const nonObject = expectExportError(() => buildExportBundle(asInput(null)));
  assert.equal(nonObject.code, "invalid-input");
  assert.ok(nonObject.issues.some((issue) => issue.includes("must be an object carrying")));

  // The artifact file set: not a Map, empty, and every path violation.
  for (const [files, fragment] of [
    [[], "must be a ReadonlyMap"],
    [new Map(), "must carry at least one file"],
  ] as const) {
    const error = expectExportError(() =>
      buildExportBundle({
        ...cloneInput(input),
        candidateArtifact: { files: files as Map<string, string> },
      }),
    );
    assert.ok(
      error.issues.some((issue) => issue.includes(fragment)),
      `${fragment}: ${error.issues.join("; ")}`,
    );
  }
  const badPaths = new Map<string, string>([
    ["/absolute.js", "must be a relative path"],
    ["../escape.js", '".." segment'],
    ["a//double.js", "empty segment"],
    ["trailing/", "empty segment"],
    ["./dot.js", '"." segment'],
  ]);
  const pathError = expectExportError(() =>
    buildExportBundle({ ...cloneInput(input), candidateArtifact: { files: badPaths } }),
  );
  for (const [path, fragment] of badPaths) {
    assert.ok(
      pathError.issues.some(
        (issue) => issue.includes(JSON.stringify(path)) && issue.includes(fragment),
      ),
      `${path} → ${fragment}: ${pathError.issues.join("; ")}`,
    );
  }

  // A fallback plan with a non-empty package set: the ids disagree.
  const fallback = planComposition({
    ...compositionInput(),
    verdict: { label: "marketing/content site", confidence: 0.9 },
  });
  assert.equal(fallback.status, "fallback");
  const mismatch = expectExportError(() =>
    buildExportBundle({
      ...cloneInput(input),
      compositionPlan: fallback,
      packageSet: [ANCHOR, EXTENSION],
    }),
  );
  assert.ok(
    mismatch.issues.some((issue) => issue.includes("does not list it")),
    mismatch.issues.join("; "),
  );

  // A composed plan with an empty package set: no provenance.
  const emptySet = expectExportError(() =>
    buildExportBundle({ ...cloneInput(input), packageSet: [] }),
  );
  assert.ok(
    emptySet.issues.some((issue) =>
      issue.includes("packageSet must be non-empty when the composition plan is composed"),
    ),
    emptySet.issues.join("; "),
  );

  // The injected clock: a throwing clock and a negative clock are collected
  // issues, never propagated surprises.
  const throwingClock = expectExportError(() =>
    buildExportBundle({
      ...cloneInput(input),
      now: () => {
        throw new Error("boom");
      },
    }),
  );
  assert.ok(throwingClock.issues.some((issue) => issue.includes("threw when read")));
  const negativeClock = expectExportError(() =>
    buildExportBundle({ ...cloneInput(input), now: () => -1 }),
  );
  assert.ok(
    negativeClock.issues.some((issue) => issue.includes("non-negative integer epoch-millisecond")),
  );

  // Non-JSON-representable package documents fail closed (the digest must be
  // computable and the verbatim carry must survive serialization).
  const unrepresentable = expectExportError(() =>
    buildExportBundle({
      ...cloneInput(input),
      packageSet: [ANCHOR, { ...EXTENSION, benchmark: { ratio: Number.NaN } }],
    }),
  );
  assert.ok(
    unrepresentable.issues.some((issue) => issue.includes("numbers must be finite")),
    unrepresentable.issues.join("; "),
  );

  // Malformed e2e digests: every collected shape violation.
  const malformedDigest = {
    schemaVersion: "0.1",
    reconstructionId: RECON,
    stages: [{ stage: "observation", outcome: "in-progress", reason: "" }],
    finalParityVerdict: "equivalent",
    repair: {
      converged: "yes",
      stoppedBy: "converged",
      iterations: [],
      abstained: [],
      finalVerdict: "equivalent",
    },
    journeyCoverage: [],
    limitations: [{ id: "l1", status: "passing-check", reason: "nope" }],
  } as unknown as E2eAcceptanceDigest;
  const badDigest = expectExportError(() =>
    buildExportBundle({
      ...cloneInput(input),
      verification: {
        e2eDigest: malformedDigest,
        pairedReportIds: [...PAIRED_REPORT_IDS],
      },
    }),
  );
  const digestIssues = badDigest.issues.join("\n");
  for (const fragment of [
    'outcome must be "succeeded", "failed" or "unavailable"',
    "reason must be a non-empty string",
    "repair.converged must be a boolean",
    'status must be "limitation"',
  ]) {
    assert.ok(digestIssues.includes(fragment), `expected "${fragment}", got:\n${digestIssues}`);
  }

  // The structural code wins when both kinds of issue are present, and the
  // refusal is still listed.
  const both = expectExportError(() =>
    buildExportBundle(
      asInput({
        ...cloneInput(input),
        candidateId: "",
        verification: { ...input.verification, pairedReportIds: [] },
      }),
    ),
  );
  assert.equal(both.code, "invalid-input");
  assert.ok(both.issues.some((issue) => issue.includes("candidateId")));
  assert.ok(both.issues.some((issue) => issue.includes("no paired-verification report ids")));

  // The serializer fails closed on structurally wrong bundles too.
  assert.throws(
    () => serializeExportBundle({ manifest: {}, files: [] } as unknown as ExportBundle),
    TypeError,
  );
  assert.throws(
    () => serializeExportBundle({ manifest: "nope", files: new Map() } as unknown as ExportBundle),
    TypeError,
  );

  // The plan shape itself is validated (a garbage plan is refused).
  const garbagePlan = expectExportError(() =>
    buildExportBundle({
      ...cloneInput(input),
      compositionPlan: { status: "exploded" } as unknown as CompositionPlan,
    }),
  );
  assert.ok(
    garbagePlan.issues.some((issue) =>
      issue.includes('status must be "composed", "fallback" or "abstained"'),
    ),
    garbagePlan.issues.join("; "),
  );

  // composed plan missing the composed-only fields
  const composedShallow = expectExportError(() =>
    buildExportBundle({
      ...cloneInput(input),
      compositionPlan: {
        status: "composed",
        packageIds: compositionPlan.packageIds,
      } as unknown as CompositionPlan,
    }),
  );
  const shallowIssues = composedShallow.issues.join("\n");
  for (const fragment of [
    "selections must be an array",
    "notes must be an array",
    "compositionDigest must be",
  ]) {
    assert.ok(shallowIssues.includes(fragment), `expected "${fragment}", got:\n${shallowIssues}`);
  }
});

// ---------------------------------------------------------------------------
// Required test 8 — the module composes only frozen synthesis surfaces
// ---------------------------------------------------------------------------

test("the module composes only frozen synthesis surfaces — no cross-lane import", () => {
  const source = readFileSync(new URL(EXPORT_SOURCE, import.meta.url), "utf8");
  const specifiers = importSpecifiersOf(source);
  assert.ok(specifiers.length > 0, "the module declares its imports");

  const forbidden = [
    "@clapp/intelligence",
    "@clapp/observation",
    "@clapp/runtime-openmuse",
    "@clapp/synthesis",
  ];
  for (const specifier of specifiers) {
    assert.ok(
      specifier.startsWith("./") || specifier === "@clapp/contracts",
      `every import must be ./-relative synthesis or @clapp/contracts, found ${specifier}`,
    );
    for (const banned of forbidden) {
      assert.ok(!specifier.includes(banned), `cross-lane import forbidden: ${specifier}`);
    }
    assert.ok(!specifier.startsWith("apps/"), `app import forbidden: ${specifier}`);
  }
  assert.ok(
    specifiers.includes("@clapp/contracts"),
    "the frozen contract package is the one cross-package composition",
  );

  // The banned-primitives scan: no wall clock, no randomness, no timers.
  for (const banned of [
    "Date.now",
    "new Date",
    "performance.now",
    "Math.random",
    "setTimeout",
    "setInterval",
  ]) {
    assert.ok(!source.includes(banned), `the pure module must not use ${banned}`);
  }
});
