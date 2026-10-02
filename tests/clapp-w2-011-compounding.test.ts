import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  type AvailableCompoundingSignalRow,
  buildLearningComparison,
  COMPOUNDING_EXPERIMENT_ID_PREFIX,
  type CompoundingCompositionPlan,
  CompoundingError,
  type CompoundingExperimentReport,
  type CompoundingSignalRow,
  createPackageRegistry,
  extractPackageCandidates,
  LEARNING_SIGNAL_IDS,
  type LearningBuildRecord,
  type LearningComparisonReport,
  type LearningSignalId,
  type LearningSignalRow,
  type PackageStore,
  type PackageStoreKey,
  type PackageStoreRecord,
  type ParitySummary,
  type ReconstructionArtifacts,
  runCompoundingExperiment,
} from "../packages/clapp-intelligence/src/index.ts";
import { canonicalJson, sha256Hex } from "../packages/clapp-intelligence/src/json.ts";

/**
 * CLAPP-W2-011 — measurable compounding improvement (repeated-build
 * orchestration).
 *
 * Contract: two measured builds of the same benchmark — the W2-009 repeated
 * sequence (scratch build, reuse build) — are orchestrated end-to-end
 * (build -> extract -> evaluate -> promote -> rebuild -> compare) over the
 * REAL frozen surfaces: the REAL W2-006 extractPackageCandidates +
 * registerCandidates, the REAL W2-005 registry over the in-memory store
 * port, the REAL W2-010 decidePromotionGate + promoteGated, and the REAL
 * W2-009 buildLearningComparison attached VERBATIM. The per-signal
 * compounding record is derived ACROSS the comparison — one row per
 * LEARNING.md signal, each available (improved/worsened/unchanged with the
 * measured values) or unavailable with the recorded reason, never
 * fabricated. A PRESENT composition plan (passed in as data through the
 * structural port, never imported from @clapp/synthesis) means learning was
 * enabled: improved rows record the attribution — the plan's packageIds ∩
 * the promoted set, honest attribution to the package SET, never a
 * fabricated per-signal causal claim. An ABSENT plan is the
 * learning-disabled control: the whole chain still runs and the verdict is
 * "control" without fabricated improvement. The experiment is pure,
 * synchronous, deterministic (a pinned FIXED_MS clock, fixed literals, no
 * network) and fail-closed: malformed inputs throw ONE typed
 * CompoundingError collecting every issue, before any stage runs.
 */

/** The pinned experiment clock (2025-01-01T00:00:00.000Z; never a wall-clock read). */
const FIXED_MS = 1735689600000;

/** The pinned clock's ISO-8601 rendering (the promotion evidence verifiedAt). */
const FIXED_VERIFIED_AT = "2025-01-01T00:00:00.000Z";

/** The module under contract, for the purity and import-discipline scans. */
const MODULE_URL = new URL("../packages/clapp-intelligence/src/compounding.ts", import.meta.url);
const MODULE_SOURCE = readFileSync(MODULE_URL, "utf8");

/** Wall-clock and randomness primitives that must never appear in the module. */
const BANNED_PRIMITIVES = [
  "Date.now",
  "new Date",
  "performance.now",
  "Math.random",
  "setTimeout",
  "setInterval",
];

/** Cross-lane packages the module must never import (ADR-002). */
const BANNED_IMPORTS = [
  "@clapp/synthesis",
  "@clapp/observation",
  "@clapp/runtime-openmuse",
  "@clapp/benchmarks",
  "@clapp/backends",
  "@clapp/domain",
  "@clapp/integrations",
];

const RECONSTRUCTION_ID = "rc-w2-011-0001";
const RUN_A1 = "clapp_run_fixture_w2_011_a1";
const RUN_A2 = "clapp_run_fixture_w2_011_a2";
const IR_DIGEST = createHash("sha256").update("clapp-w2-011 fixture behavioral IR").digest("hex");

// ---------------------------------------------------------------------------
// Fixtures (the established W2-009/W2-010 fixture idioms)
// ---------------------------------------------------------------------------

/** An equivalent parity summary citing a verification run. */
function equivalentParity(verificationRunId: string): ParitySummary {
  return { verdict: "equivalent", verificationRunId, minorFindings: 0, majorFindings: 0 };
}

/** The fixture reconstruction artifacts of a successful scratch build (W2-006). */
function makeArtifacts(overrides: Partial<ReconstructionArtifacts> = {}): ReconstructionArtifacts {
  return {
    reconstructionId: RECONSTRUCTION_ID,
    parity: equivalentParity(RUN_A1),
    planInventory: {
      components: [
        { path: "/", kind: "page", name: "index" },
        { path: "/items", kind: "page", name: "items" },
        { path: "/items/new", kind: "form", name: "item-form" },
      ],
      apiEntries: [{ path: "/api/items" }],
      persistenceKeys: ["items"],
    },
    archetype: { label: "CRUD SaaS" },
    irDigest: IR_DIGEST,
    ...overrides,
  };
}

interface RecordOverrides {
  appId?: string;
  phase?: "scratch" | "reuse";
  reusedPackageIds?: string[];
  rejectedPackageIds?: string[];
  newCodeUnits?: number;
  repairIterations?: number;
  buildSteps?: number;
  testsPassed?: number;
  testsTotal?: number;
  parity?: ParitySummary;
  acceptanceWeakened?: boolean;
}

/** A well-formed learning build record fixture (caller-supplied measurements). */
function makeRecord(overrides: RecordOverrides = {}): LearningBuildRecord {
  return {
    appId: overrides.appId ?? "A1",
    phase: overrides.phase ?? "scratch",
    reusedPackageIds: overrides.reusedPackageIds ?? [],
    rejectedPackageIds: overrides.rejectedPackageIds ?? [],
    newCodeUnits: overrides.newCodeUnits ?? 24,
    repairIterations: overrides.repairIterations ?? 3,
    buildSteps: overrides.buildSteps ?? 40,
    ...(overrides.testsPassed !== undefined ? { testsPassed: overrides.testsPassed } : {}),
    ...(overrides.testsTotal !== undefined ? { testsTotal: overrides.testsTotal } : {}),
    ...(overrides.parity !== undefined ? { parity: overrides.parity } : {}),
    ...(overrides.acceptanceWeakened !== undefined
      ? { acceptanceWeakened: overrides.acceptanceWeakened }
      : {}),
  };
}

/** The from-record: the A1 scratch build, verified, reusing nothing. */
function scratchBuild(overrides: RecordOverrides = {}): LearningBuildRecord {
  return makeRecord({
    appId: "A1",
    phase: "scratch",
    newCodeUnits: 24,
    repairIterations: 3,
    buildSteps: 40,
    testsPassed: 12,
    testsTotal: 12,
    parity: equivalentParity(RUN_A1),
    ...overrides,
  });
}

/** The to-record: the A2 reuse build, verified, reusing the given packages. */
function reuseBuild(
  reusedPackageIds: string[],
  overrides: RecordOverrides = {},
): LearningBuildRecord {
  return makeRecord({
    appId: "A2",
    phase: "reuse",
    reusedPackageIds,
    newCodeUnits: 9,
    repairIterations: 1,
    buildSteps: 18,
    testsPassed: 14,
    testsTotal: 14,
    parity: equivalentParity(RUN_A2),
    ...overrides,
  });
}

/**
 * A composition plan fixture that structurally satisfies the port AND
 * mirrors the real W3-009 ComposedCompositionPlan shape (selections with
 * role/packageId, notes, compositionDigest are extra fields the port
 * welcomes) — passed in as data, never imported from @clapp/synthesis.
 */
function learningPlan(
  packageIds: string[],
  status: "composed" | "fallback" | "abstained" = "composed",
): {
  status: "composed" | "fallback" | "abstained";
  packageIds: string[];
  selections?: { role: string; packageId: string }[];
  notes: string[];
  compositionDigest: string;
} {
  if (status !== "composed") {
    return {
      status,
      packageIds,
      notes: [`no compatible set: ${packageIds.length} survivor(s)`],
      compositionDigest: sha256Hex(`clapp-w2-011 fixture plan ${status}`),
    };
  }
  return {
    status,
    packageIds,
    selections: packageIds.map((packageId, index) => ({
      role: index === 0 ? "archetype-anchor" : "compatible-extension",
      packageId,
      version: "0.1.0",
      provenance: {
        category: "CRUD SaaS",
        capabilities: ["component:form", "component:page"],
        supportedTargets: ["web"],
        lifecycle: "promoted",
        edgeReasons: [],
      },
    })),
    notes: [],
    compositionDigest: sha256Hex(`clapp-w2-011 fixture plan ${packageIds.join(",")}`),
  };
}

/** In-memory PackageStore (the W2-005 port's only test implementation). */
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

/** The report's signal row for one signal (fails the test when absent). */
function rowFor(
  report: CompoundingExperimentReport,
  signal: LearningSignalId,
): CompoundingSignalRow {
  const row = report.signalRows.find((entry) => entry.signal === signal);
  if (row === undefined) {
    assert.fail(`expected exactly one compounding row for signal "${signal}"`);
  }
  return row;
}

/** The comparison's row for one signal (fails the test when absent). */
function comparisonRowFor(
  report: LearningComparisonReport,
  signal: LearningSignalId,
): LearningSignalRow {
  const row = report.rows.find((entry) => entry.signal === signal);
  if (row === undefined) {
    assert.fail(`expected exactly one comparison row for signal "${signal}"`);
  }
  return row;
}

/** The candidate id the fixture artifacts deterministically extract (real W2-006). */
function fixtureCandidateId(artifacts: ReconstructionArtifacts = makeArtifacts()): string {
  const extraction = extractPackageCandidates(artifacts);
  const candidate = extraction.candidates[0];
  assert.ok(candidate, "the fixture artifacts extract a candidate");
  return candidate.package.id;
}

/** The coherent learning-enabled fixture: scratch build, artifacts, plan, reuse build. */
function learningEnabledFixture() {
  const artifacts = makeArtifacts();
  const candidateId = fixtureCandidateId(artifacts);
  const from = scratchBuild();
  const to = reuseBuild([candidateId]);
  const plan = learningPlan([candidateId]);
  return { artifacts, candidateId, from, to, plan };
}

// ---------------------------------------------------------------------------
// The 8 named tests
// ---------------------------------------------------------------------------

test("repeated builds with learning enabled produce a per-signal compounding record across learning reports", () => {
  const { artifacts, candidateId, from, to, plan } = learningEnabledFixture();
  const store = new InMemoryPackageStore();

  const report = runCompoundingExperiment({
    benchmarkId: "benchmark-w2-011-repeated-build",
    scratchBuild: from,
    reuseBuild: to,
    artifacts,
    compositionPlan: plan,
    store,
    now: () => FIXED_MS,
  });

  // The experiment report spans the two builds' learning report: the
  // comparison embeds both canonical records and is attached verbatim.
  assert.strictEqual(report.benchmarkId, "benchmark-w2-011-repeated-build");
  assert.strictEqual(report.learningEnabled, true);
  assert.strictEqual(report.comparison.fromBuild.appId, "A1");
  assert.strictEqual(report.comparison.toBuild.appId, "A2");
  assert.deepStrictEqual(report.comparison, buildLearningComparison(from, to));

  // The per-signal compounding record: exactly one row per LEARNING.md
  // signal, in vocabulary order.
  assert.strictEqual(report.signalRows.length, LEARNING_SIGNAL_IDS.length);
  assert.deepStrictEqual(
    report.signalRows.map((row) => row.signal),
    [...LEARNING_SIGNAL_IDS],
  );

  // The chain's every stage is recorded, end-to-end.
  assert.strictEqual(report.extraction.candidates.length, 1);
  assert.strictEqual(report.extraction.candidates[0]?.id, candidateId);
  assert.strictEqual(report.extraction.candidates[0]?.version, "0.1.0");
  assert.deepStrictEqual(report.extraction.skipped, []);
  assert.deepStrictEqual(report.extraction.summary, {
    extracted: 1,
    promoted: 1,
    abstained: 0,
    reasons: [],
  });
  assert.strictEqual(report.registrations.length, 1);
  assert.strictEqual(report.registrations[0]?.ok, true);
  assert.strictEqual(report.promotions.length, 1);
  assert.strictEqual(report.promotions[0]?.promoted, true);
  assert.strictEqual(report.promotions[0]?.idempotent, false);
  assert.strictEqual(report.promotions[0]?.decision.outcome, "promoted");
  assert.match(report.promotions[0]?.decision.id ?? "", /^clapp_eval_[0-9a-f]{16}$/);
  assert.strictEqual(report.promotions[0]?.decision.reportId, report.comparison.id);
  assert.deepStrictEqual(report.promotedPackageIds, [candidateId]);
  assert.deepStrictEqual(report.selectedPackageIds, [candidateId]);

  // The measured improvement is visible per signal: reuse up, new code down,
  // repairs down — each with the measured from/to values carried.
  const reuseRow = rowFor(report, "package-reuse-rate");
  assert.strictEqual(reuseRow.status, "available");
  if (reuseRow.status === "available") {
    assert.strictEqual(reuseRow.direction, "improved");
    assert.strictEqual(reuseRow.fromValue, 0);
    assert.strictEqual(reuseRow.toValue, 1);
    assert.strictEqual(reuseRow.delta, 1);
  }
  const newCodeRow = rowFor(report, "generated-new-code");
  assert.strictEqual(newCodeRow.status, "available");
  if (newCodeRow.status === "available") {
    assert.strictEqual(newCodeRow.direction, "improved");
    assert.strictEqual(newCodeRow.fromValue, 24);
    assert.strictEqual(newCodeRow.toValue, 9);
    assert.strictEqual(newCodeRow.delta, -15);
  }
  const repairRow = rowFor(report, "repair-iterations");
  assert.strictEqual(repairRow.status, "available");
  if (repairRow.status === "available") {
    assert.strictEqual(repairRow.direction, "improved");
    assert.strictEqual(repairRow.fromValue, 3);
    assert.strictEqual(repairRow.toValue, 1);
  }

  // The verdict: measurable improvement with attribution.
  assert.strictEqual(report.verdict, "compounding");
  assert.match(report.verdictReason, /attributed to the promoted package set/);

  // The rebuild's promotion is real: the store carries the promoted document
  // with the pinned clock's timestamp and the gate's clapp_eval_ provenance.
  const registry = createPackageRegistry(store);
  const promoted = registry.list({ status: "promoted" });
  assert.strictEqual(promoted.length, 1);
  assert.strictEqual(promoted[0]?.id, candidateId);
  const promotion = promoted[0]?.provenance.promotion as Record<string, unknown>;
  assert.strictEqual(promotion.verifiedAt, FIXED_VERIFIED_AT);
  assert.strictEqual(promotion.verificationRunId, RUN_A1);
  const notes = promotion.provenanceNotes as string[] | undefined;
  assert.ok(notes?.includes(`benchmark report: ${report.comparison.id}`));
  assert.ok(notes?.includes(`gate decision: ${report.promotions[0]?.decision.id}`));
  assert.strictEqual(registry.list({ status: "candidate" }).length, 0);
});

test("every signal row is honest — improved, worsened, unchanged, or unavailable with a recorded reason", () => {
  // (a) Weakened acceptance: the would-be improvement is NOT claimable (it
  // abstains with the recorded reason), and measured worsening stays
  // visible — honest worsening is never hidden.
  const weakenedArtifacts = makeArtifacts();
  const weakenedCandidate = fixtureCandidateId(weakenedArtifacts);
  const weakened = runCompoundingExperiment({
    benchmarkId: "benchmark-w2-011-weakened",
    scratchBuild: scratchBuild(),
    reuseBuild: reuseBuild([weakenedCandidate], {
      newCodeUnits: 30,
      repairIterations: 5,
      testsPassed: 10,
      testsTotal: 12,
      rejectedPackageIds: ["clapp_package_rejected_fixture"],
      acceptanceWeakened: true,
    }),
    artifacts: weakenedArtifacts,
    compositionPlan: learningPlan([weakenedCandidate]),
    now: () => FIXED_MS,
  });

  const weakenedReuseRow = rowFor(weakened, "package-reuse-rate");
  assert.strictEqual(weakenedReuseRow.status, "unavailable");
  if (weakenedReuseRow.status === "unavailable") {
    assert.match(weakenedReuseRow.reason, /improvement is not claimable/);
    assert.match(weakenedReuseRow.reason, /weakened/);
    assert.match(weakenedReuseRow.reason, /A2/);
  }
  for (const [signal, fromValue, toValue] of [
    ["generated-new-code", 24, 30],
    ["repair-iterations", 3, 5],
    ["package-rejection-rate", 0, 1],
  ] as const) {
    const row = rowFor(weakened, signal);
    assert.strictEqual(row.status, "available", signal);
    if (row.status === "available") {
      assert.strictEqual(row.direction, "worsened", signal);
      assert.strictEqual(row.fromValue, fromValue, signal);
      assert.strictEqual(row.toValue, toValue, signal);
    }
  }
  const weakenedTestRow = rowFor(weakened, "test-pass-rate");
  assert.strictEqual(weakenedTestRow.status, "available");
  if (weakenedTestRow.status === "available") {
    assert.strictEqual(weakenedTestRow.direction, "worsened");
    assert.strictEqual(weakenedTestRow.fromValue, 1);
  }
  // Unavailable rows carry the comparison row's reason VERBATIM.
  for (const signal of ["build-time", "failure-recurrence"] as const) {
    const row = rowFor(weakened, signal);
    const comparisonRow = comparisonRowFor(weakened.comparison, signal);
    assert.strictEqual(row.status, "unavailable", signal);
    if (row.status === "unavailable" && comparisonRow.status === "unavailable") {
      assert.strictEqual(row.reason, comparisonRow.reason, `the ${signal} reason is verbatim`);
    }
  }
  // Zero improved signals: no-compounding, and the gate withheld (the
  // weakened evaluation can never justify promotion).
  assert.strictEqual(
    weakened.signalRows.filter((row) => row.status === "available" && row.direction === "improved")
      .length,
    0,
  );
  assert.strictEqual(weakened.verdict, "no-compounding");
  assert.deepStrictEqual(weakened.promotedPackageIds, []);

  // (b) A fallback plan (learning enabled, nothing selected): improvement
  // measured on signals but NOTHING promoted from the selected set, so no
  // attribution is fabricated — the rows record the honest empty set.
  const fallbackArtifacts = makeArtifacts();
  const fallback = runCompoundingExperiment({
    benchmarkId: "benchmark-w2-011-fallback",
    scratchBuild: scratchBuild(),
    reuseBuild: reuseBuild([], { newCodeUnits: 18, repairIterations: 1, testsPassed: 12 }),
    artifacts: fallbackArtifacts,
    compositionPlan: learningPlan([], "fallback"),
    now: () => FIXED_MS,
  });
  assert.strictEqual(fallback.learningEnabled, true);
  assert.deepStrictEqual(fallback.selectedPackageIds, []);
  assert.deepStrictEqual(fallback.promotedPackageIds, []);
  for (const signal of ["generated-new-code", "repair-iterations"] as const) {
    const row = rowFor(fallback, signal);
    assert.strictEqual(row.status, "available", signal);
    if (row.status === "available") {
      assert.strictEqual(row.direction, "improved", signal);
      assert.deepStrictEqual(
        row.attributedPackageIds,
        [],
        `${signal} records the empty attribution`,
      );
    }
  }
  assert.strictEqual(fallback.verdict, "no-compounding");
  assert.match(fallback.verdictReason, /none of the improvement is attributable/);

  // (c) Unverified scratch artifacts: extraction honestly abstains (no
  // candidates, the recorded reason), and the record is still complete.
  const divergentArtifacts = makeArtifacts({
    parity: { verdict: "divergent", verificationRunId: RUN_A1, minorFindings: 2, majorFindings: 1 },
  });
  const divergentParity: ParitySummary = {
    verdict: "divergent",
    verificationRunId: RUN_A2,
    minorFindings: 2,
    majorFindings: 1,
  };
  const abstained = runCompoundingExperiment({
    benchmarkId: "benchmark-w2-011-abstained",
    scratchBuild: scratchBuild({
      parity: {
        verdict: "divergent",
        verificationRunId: RUN_A1,
        minorFindings: 2,
        majorFindings: 1,
      },
    }),
    reuseBuild: reuseBuild([], { newCodeUnits: 30, parity: divergentParity }),
    artifacts: divergentArtifacts,
    compositionPlan: learningPlan([], "fallback"),
    now: () => FIXED_MS,
  });
  assert.deepStrictEqual(abstained.extraction.candidates, []);
  assert.strictEqual(abstained.extraction.skipped.length, 1);
  assert.match(abstained.extraction.skipped[0]?.reason ?? "", /parity verdict is/);
  assert.deepStrictEqual(abstained.registrations, []);
  assert.deepStrictEqual(abstained.promotions, []);
  assert.strictEqual(abstained.signalRows.length, LEARNING_SIGNAL_IDS.length);
  assert.strictEqual(abstained.verdict, "no-compounding");
});

test("the learning-disabled control runs the chain and records the control verdict without fabricated improvement", () => {
  const artifacts = makeArtifacts();
  const candidateId = fixtureCandidateId(artifacts);
  const store = new InMemoryPackageStore();

  // The control's rebuild: no plan was supplied, and the reuse build reused
  // nothing — but it may still measure incidental improvement (fewer
  // repairs), which the control must neither claim nor attribute.
  const control = runCompoundingExperiment({
    benchmarkId: "benchmark-w2-011-control",
    scratchBuild: scratchBuild(),
    reuseBuild: reuseBuild([], { repairIterations: 1, newCodeUnits: 24, testsPassed: 12 }),
    artifacts,
    store,
    now: () => FIXED_MS,
  });

  assert.strictEqual(control.verdict, "control");
  assert.strictEqual(control.learningEnabled, false);
  assert.deepStrictEqual(control.selectedPackageIds, []);
  assert.match(control.verdictReason, /learning was disabled for the rebuild/);

  // Stages 2-5 still ran against the scratch artifacts: the extraction
  // found the candidate (that is honest), it registered, and the gate
  // evaluated it — withholding, because the reuse build exercised nothing.
  assert.strictEqual(control.extraction.candidates.length, 1);
  assert.strictEqual(control.extraction.candidates[0]?.id, candidateId);
  assert.strictEqual(control.registrations[0]?.ok, true);
  assert.strictEqual(control.promotions.length, 1);
  assert.strictEqual(control.promotions[0]?.promoted, false);
  assert.strictEqual(control.promotions[0]?.decision.outcome, "withheld");
  assert.match(
    control.promotions[0]?.reasons.join(" | ") ?? "",
    /evaluation-exercised-the-package/,
    "the honest criterion reason is recorded",
  );
  assert.deepStrictEqual(control.promotedPackageIds, []);

  // The registry holds the candidate, promoted nothing.
  const registry = createPackageRegistry(store);
  assert.strictEqual(registry.list({ status: "promoted" }).length, 0);
  assert.strictEqual(registry.list({ status: "candidate" }).length, 1);

  // Per-signal rows unchanged from the comparison: the incidental
  // improvement is visible with its measured values, but NO row carries an
  // attribution — the control never fabricates improvement credit.
  assert.strictEqual(control.signalRows.length, LEARNING_SIGNAL_IDS.length);
  for (const row of control.signalRows) {
    if (row.status === "available") {
      assert.ok(!("attributedPackageIds" in row), "a control row never carries an attribution");
      const comparisonRow = comparisonRowFor(control.comparison, row.signal);
      assert.strictEqual(comparisonRow.status, "available", row.signal);
      if (comparisonRow.status === "available") {
        assert.strictEqual(row.direction, comparisonRow.direction, row.signal);
        assert.deepStrictEqual(row.fromValue, comparisonRow.fromValue, row.signal);
        assert.deepStrictEqual(row.toValue, comparisonRow.toValue, row.signal);
      }
    } else {
      const comparisonRow = comparisonRowFor(control.comparison, row.signal);
      assert.strictEqual(comparisonRow.status, "unavailable", row.signal);
      if (comparisonRow.status === "unavailable") {
        assert.strictEqual(row.reason, comparisonRow.reason, row.signal);
      }
    }
  }
  const repairRow = rowFor(control, "repair-iterations");
  assert.strictEqual(repairRow.status, "available");
  if (repairRow.status === "available") {
    assert.strictEqual(repairRow.direction, "improved");
    assert.strictEqual(repairRow.fromValue, 3);
    assert.strictEqual(repairRow.toValue, 1);
  }
});

test("improvement on a signal is attributed to the promoted package set — never a fabricated causal claim", () => {
  const artifacts = makeArtifacts();
  const candidateId = fixtureCandidateId(artifacts);
  // The plan selected TWO packages; the experiment extracted and promoted
  // ONE of them. Attribution must be the INTERSECTION — the promoted set
  // the selection plausibly produced — never the whole plan, never a
  // per-signal cause.
  const selectedNotPromoted = "clapp_package_selected_not_promoted_w2_011";
  const plan = learningPlan([candidateId, selectedNotPromoted]);

  const report = runCompoundingExperiment({
    benchmarkId: "benchmark-w2-011-attribution",
    scratchBuild: scratchBuild(),
    reuseBuild: reuseBuild([candidateId, selectedNotPromoted]),
    artifacts,
    compositionPlan: plan,
    now: () => FIXED_MS,
  });

  assert.strictEqual(report.verdict, "compounding");
  assert.deepStrictEqual(report.promotedPackageIds, [candidateId]);
  assert.deepStrictEqual(report.selectedPackageIds, [candidateId, selectedNotPromoted]);

  const improvedSignals = report.signalRows.filter(
    (row): row is AvailableCompoundingSignalRow =>
      row.status === "available" && row.direction === "improved",
  );
  assert.ok(improvedSignals.length >= 1, "the fixture improved at least one signal");
  for (const row of improvedSignals) {
    // The attribution is the promoted package SET (the intersection), and
    // the row shape carries nothing beyond the set — no per-signal causal
    // claim exists anywhere to fabricate.
    assert.deepStrictEqual(
      row.attributedPackageIds,
      [candidateId],
      `${row.signal} attributes exactly the promoted ∩ selected set`,
    );
    assert.ok(
      !(row.attributedPackageIds ?? []).includes(selectedNotPromoted),
      "a selected-but-not-promoted package is never credited",
    );
    assert.deepStrictEqual(Object.keys(row).sort(), [
      "attributedPackageIds",
      "delta",
      "direction",
      "fromValue",
      "label",
      "measure",
      "signal",
      "status",
      "toValue",
    ]);
  }

  // Only improved rows carry an attribution: worsened, unchanged and
  // unavailable rows carry none.
  for (const row of report.signalRows) {
    if (row.status !== "available" || row.direction !== "improved") {
      assert.ok(
        !("attributedPackageIds" in row),
        `${row.signal} (${row.status}) carries no attribution`,
      );
    }
  }

  // The verdict reason names the SET attribution explicitly.
  assert.match(report.verdictReason, /promoted package set \(clapp_package_[0-9a-f]{16}\)/);
  assert.match(report.verdictReason, /never a per-signal causal claim/);
});

test("the experiment report attaches the comparison report verbatim and is content-addressed", () => {
  const { artifacts, from, to, plan } = learningEnabledFixture();
  const input = {
    benchmarkId: "benchmark-w2-011-addressed",
    scratchBuild: from,
    reuseBuild: to,
    artifacts,
    compositionPlan: plan,
    now: () => FIXED_MS,
  };

  const report = runCompoundingExperiment(input);

  // VERBATIM attachment: deep-equal to a fresh real composition of the same
  // records — no re-derivation, not one rewritten row.
  assert.deepStrictEqual(report.comparison, buildLearningComparison(from, to));
  assert.strictEqual(report.comparison.id, buildLearningComparison(from, to).id);

  // The two build records' content digests (not the full records): sha256
  // over the canonical records the comparison embeds.
  assert.strictEqual(
    report.scratchBuildDigest,
    sha256Hex(canonicalJson(report.comparison.fromBuild) as string),
  );
  assert.strictEqual(
    report.reuseBuildDigest,
    sha256Hex(canonicalJson(report.comparison.toBuild) as string),
  );

  // Content-addressed: clapp_compound_ + the first 16 hex of sha256 over
  // the report's canonical core (everything except the id — the digest
  // never covers itself; a stable recompute from the id-less core proves it).
  assert.match(report.id, /^clapp_compound_[0-9a-f]{16}$/);
  assert.ok(report.id.startsWith(COMPOUNDING_EXPERIMENT_ID_PREFIX));
  const { id, ...core } = report;
  assert.strictEqual(
    id,
    `${COMPOUNDING_EXPERIMENT_ID_PREFIX}${sha256Hex(canonicalJson(core) as string).slice(0, 16)}`,
  );

  // Deterministic: same inputs, same id. Distinguishing: different content,
  // different id.
  assert.strictEqual(runCompoundingExperiment(input).id, report.id);
  const otherBenchmark = runCompoundingExperiment({
    ...input,
    benchmarkId: "benchmark-w2-011-other",
  });
  assert.notStrictEqual(otherBenchmark.id, report.id);
  const otherMeasurements = runCompoundingExperiment({
    ...input,
    reuseBuild: reuseBuild(to.reusedPackageIds, { newCodeUnits: 10 }),
  });
  assert.notStrictEqual(otherMeasurements.id, report.id);
});

test("the experiment is deterministic — same inputs, byte-identical report", () => {
  const artifacts = makeArtifacts();
  const candidateId = fixtureCandidateId(artifacts);
  const from = scratchBuild();
  const to = reuseBuild([candidateId, "clapp_package_coselected_w2_011"]);

  const baseInput = {
    benchmarkId: "benchmark-w2-011-determinism",
    scratchBuild: from,
    reuseBuild: to,
    artifacts,
    compositionPlan: learningPlan([candidateId, "clapp_package_coselected_w2_011"]),
    now: () => FIXED_MS,
  };

  const first = runCompoundingExperiment(baseInput);
  const second = runCompoundingExperiment(baseInput);
  assert.deepStrictEqual(second, first);
  assert.strictEqual(JSON.stringify(second), JSON.stringify(first), "byte-identical serialization");
  assert.strictEqual(second.id, first.id);

  // Reordered package-id arrays in the build records are not content (the
  // W2-009 composer canonicalizes them): the report is still byte-identical.
  const reordered = runCompoundingExperiment({
    ...baseInput,
    reuseBuild: reuseBuild(["clapp_package_coselected_w2_011", candidateId]),
  });
  assert.strictEqual(reordered.id, first.id);
  assert.deepStrictEqual(reordered, first);

  // The promoted registry state is byte-identical across runs too (the
  // pinned clock yields identical promotion evidence).
  const storeA = new InMemoryPackageStore();
  const storeB = new InMemoryPackageStore();
  runCompoundingExperiment({ ...baseInput, store: storeA });
  runCompoundingExperiment({ ...baseInput, store: storeB });
  assert.deepStrictEqual(
    createPackageRegistry(storeA).list({ status: "promoted" }),
    createPackageRegistry(storeB).list({ status: "promoted" }),
  );
});

test("malformed inputs fail closed with one typed error collecting every issue", () => {
  const artifacts = makeArtifacts();
  const candidateId = fixtureCandidateId(artifacts);

  // ONE input carrying MANY malformations: every issue is collected into
  // ONE typed error — never just the first, never a partial run.
  assert.throws(
    () =>
      runCompoundingExperiment({
        benchmarkId: "   ",
        scratchBuild: scratchBuild({ newCodeUnits: -1, phase: "reuse" }),
        reuseBuild: null as unknown as LearningBuildRecord,
        artifacts: {
          ...artifacts,
          parity: undefined,
          irDigest: "",
        } as unknown as ReconstructionArtifacts,
        compositionPlan: {
          status: "bogus",
          packageIds: "nope",
        } as unknown as CompoundingCompositionPlan,
        store: 42 as unknown as PackageStore,
        now: () => -1,
      }),
    (error: unknown) => {
      assert.ok(error instanceof CompoundingError, "the typed fail-closed error");
      assert.ok(error instanceof Error);
      assert.strictEqual(error.name, "CompoundingError");
      assert.strictEqual(error.code, "invalid-input");
      const issues = [...error.issues];
      assert.ok(
        issues.length >= 10,
        `every issue is collected (${issues.length}): ${issues.join(" | ")}`,
      );
      assert.ok(issues.includes("benchmarkId must be a non-empty string (trimmed)"));
      assert.ok(issues.includes("from.newCodeUnits must be a non-negative integer"));
      assert.ok(
        issues.includes('scratchBuild.phase must be "scratch" (the experiment\'s first build)'),
      );
      assert.ok(issues.includes("the to build record must be an object"));
      assert.ok(issues.includes("artifacts.parity must be a parity summary object"));
      assert.ok(issues.includes("artifacts.irDigest must be a non-empty string"));
      assert.ok(
        issues.includes('compositionPlan.status must be "composed", "fallback" or "abstained"'),
      );
      assert.ok(
        issues.includes(
          "compositionPlan.packageIds must be an array of non-empty package id strings",
        ),
      );
      assert.ok(issues.includes("store must be a PackageStore (get, put, list) when supplied"));
      assert.ok(
        issues.includes(
          "the injected now clock must return a non-negative integer epoch-millisecond value",
        ),
      );
      return true;
    },
  );

  // A single malformation still fails closed — and never a partial run: the
  // supplied store is left untouched (no registration side effect).
  const store = new InMemoryPackageStore();
  assert.throws(
    () =>
      runCompoundingExperiment({
        benchmarkId: "benchmark-w2-011-invalid",
        scratchBuild: scratchBuild(),
        reuseBuild: reuseBuild([candidateId], { newCodeUnits: -5 }),
        artifacts,
        compositionPlan: learningPlan([candidateId]),
        store,
        now: () => FIXED_MS,
      }),
    (error: unknown) => {
      assert.ok(error instanceof CompoundingError);
      assert.strictEqual(error.code, "invalid-input");
      assert.ok(
        [...error.issues].includes("to.newCodeUnits must be a non-negative integer"),
        "the composer's collected issue is carried verbatim",
      );
      return true;
    },
  );
  assert.strictEqual(store.rows.size, 0, "no stage ran: the store is untouched");

  // A throwing injected clock is a collected issue, never a propagated surprise.
  assert.throws(
    () =>
      runCompoundingExperiment({
        benchmarkId: "benchmark-w2-011-throwing-clock",
        scratchBuild: scratchBuild(),
        reuseBuild: reuseBuild([candidateId]),
        artifacts,
        now: () => {
          throw new Error("boom");
        },
      }),
    (error: unknown) => {
      assert.ok(error instanceof CompoundingError);
      assert.ok(
        [...error.issues].includes("the injected now clock threw when read; failing closed"),
      );
      return true;
    },
  );
});

test("the module composes only frozen W2 surfaces — no cross-lane import", () => {
  // The module source imports only within ./ relative intelligence modules
  // (+ the frozen @clapp/contracts types if needed) — never a cross-lane
  // package or any app (ADR-002).
  const specifiers = [...MODULE_SOURCE.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
  assert.ok(specifiers.length >= 4, "the module's imports are inspectable");
  for (const specifier of specifiers) {
    assert.ok(
      specifier.startsWith("./") || specifier === "@clapp/contracts",
      `module import "${specifier}" must be in-package (relative) or the frozen @clapp/contracts`,
    );
    for (const banned of BANNED_IMPORTS) {
      assert.ok(!specifier.includes(banned), `module import "${specifier}" must not be ${banned}`);
    }
  }

  // The W3-009 composition plan is consumed only through the structural
  // port (the type name is declared locally; no cross-lane package name
  // ever appears in an import specifier).
  assert.ok(MODULE_SOURCE.includes("CompoundingCompositionPlan"));
  assert.ok(
    specifiers.every((specifier) => specifier.startsWith("./")),
    "every module import is an in-package relative import",
  );

  // Clock-free and randomness-free in source as well as in behavior: the
  // ISO-8601 rendering is hand-rolled (no Date API anywhere).
  for (const banned of BANNED_PRIMITIVES) {
    assert.ok(!MODULE_SOURCE.includes(banned), `the module source must not contain "${banned}"`);
  }
});
