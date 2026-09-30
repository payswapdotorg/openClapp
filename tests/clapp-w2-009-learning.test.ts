import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  canonicalJson as benchmarkCanonicalJson,
  sha256Hex as benchmarkSha256Hex,
  CANONICAL_BENCHMARKS,
  createBenchmarkHarness,
} from "../packages/clapp-benchmarks/src/index.ts";
import {
  buildLearningComparison,
  createPackageRegistry,
  extractPackageCandidates,
  LEARNING_REPORT_ID_PREFIX,
  LEARNING_SIGNAL_IDS,
  type LearningBuildRecord,
  type LearningComparisonReport,
  LearningRecordError,
  type LearningSignalId,
  type LearningSignalRow,
  type PackageStore,
  type PackageStoreKey,
  type PackageStoreRecord,
  type ParitySummary,
  promoteVerified,
  type ReconstructionArtifacts,
  registerCandidates,
  retrievePackages,
} from "../packages/clapp-intelligence/src/index.ts";

/**
 * CLAPP-W2-009 — continuous-learning benchmarks.
 *
 * Contract: the M6 steps 4-6 comparison report maps a from-scratch build
 * record (A1/B1) and a reuse build record (A2/B2) onto EXACTLY the eight
 * LEARNING.md learning signals — package reuse rate, generated new code,
 * repair iterations, build time, test pass rate, parity improvement,
 * failure recurrence, package rejection rate — one row each, no aggregate
 * score. Every row is available (both sides measured, comparison derived)
 * or unavailable with a recorded reason: build time abstains because
 * @clapp/intelligence is clock-free (the build-steps count is the proxy),
 * failure recurrence abstains because the failure-memory module (W2-008)
 * is not composed, and unmeasured tests/parity are never fabricated.
 * Repair iterations are caller-supplied structural counts, never derived.
 * Measured improvement is reported only without weakened acceptance
 * criteria. The report is a pure deterministic function with a
 * content-addressed clapp_learning_ id, malformed records fail closed with
 * collected typed errors, and the integration seam composes the REAL
 * W2-005 registry, W2-006 extraction and W2-007 retrieval end-to-end (the
 * established in-process loopback harness pattern). Deterministic only: no
 * wall-clock, no randomness, no external network beyond the harness's own
 * loopback servers.
 */

/** The fixed verification timestamp fixtures use (determinism; never invented). */
const VERIFIED_AT = "2025-07-01T10:00:00.000Z";

/** The module under contract, for the purity and import-discipline scans. */
const MODULE_URL = new URL(
  "../packages/clapp-intelligence/src/learning-benchmark.ts",
  import.meta.url,
);
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

/** An equivalent parity summary citing a verification run. */
function equivalentParity(verificationRunId: string): ParitySummary {
  return { verdict: "equivalent", verificationRunId, minorFindings: 0, majorFindings: 0 };
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

/** The report's row for one signal (fails the test when absent). */
function rowFor(report: LearningComparisonReport, signal: LearningSignalId): LearningSignalRow {
  const row = report.rows.find((entry) => entry.signal === signal);
  if (row === undefined) {
    assert.fail(`expected exactly one row for signal "${signal}"`);
  }
  return row;
}

/** The recorded reason of a row asserted to be unavailable. */
function unavailableReason(report: LearningComparisonReport, signal: LearningSignalId): string {
  const row = rowFor(report, signal);
  if (row.status !== "unavailable") {
    assert.fail(`expected the "${signal}" row to be unavailable`);
  }
  return row.reason;
}

/** Every object key of a value, at any depth (for the no-aggregate-score scan). */
function deepKeys(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => deepKeys(entry));
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return Object.keys(record).flatMap((key) => [key, ...deepKeys(record[key])]);
  }
  return [];
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

test("the comparison table covers the learning-signal vocabulary exactly", () => {
  const report = buildLearningComparison(
    makeRecord({
      appId: "A1",
      phase: "scratch",
      testsPassed: 12,
      testsTotal: 12,
      parity: equivalentParity("clapp_run_fixture_a1"),
    }),
    makeRecord({
      appId: "A2",
      phase: "reuse",
      reusedPackageIds: ["clapp_package_alpha", "clapp_package_beta"],
      newCodeUnits: 9,
      repairIterations: 1,
      buildSteps: 18,
      testsPassed: 14,
      testsTotal: 14,
      parity: equivalentParity("clapp_run_fixture_a2"),
    }),
  );

  // Exactly the eight LEARNING.md signals, in vocabulary order, with their
  // verbatim phrases — no extra rows, none missing.
  assert.deepStrictEqual(
    report.rows.map((row) => ({ signal: row.signal, label: row.label })),
    [
      { signal: "package-reuse-rate", label: "package reuse rate" },
      { signal: "generated-new-code", label: "generated new code" },
      { signal: "repair-iterations", label: "repair iterations" },
      { signal: "build-time", label: "build time" },
      { signal: "test-pass-rate", label: "test pass rate" },
      { signal: "parity-improvement", label: "parity improvement" },
      { signal: "failure-recurrence", label: "failure recurrence" },
      { signal: "package-rejection-rate", label: "package rejection rate" },
    ],
  );
  assert.strictEqual(report.rows.length, 8);
  assert.deepStrictEqual(LEARNING_SIGNAL_IDS, [
    "package-reuse-rate",
    "generated-new-code",
    "repair-iterations",
    "build-time",
    "test-pass-rate",
    "parity-improvement",
    "failure-recurrence",
    "package-rejection-rate",
  ]);

  // No aggregate score field anywhere on the report (ACCEPTANCE.md M6:
  // "Do not reduce results to one score").
  assert.deepStrictEqual(
    deepKeys(report).filter((key) => /score/i.test(key)),
    [],
  );

  // The table accounts for itself: every row is available or unavailable
  // with a reason, and the digest adds up.
  assert.strictEqual(report.digest.rowsTotal, 8);
  assert.strictEqual(report.digest.available + report.digest.unavailable, 8);
  assert.strictEqual(report.digest.reasons.length, report.digest.unavailable);
});

test("build time abstains honestly with a deterministic proxy", () => {
  const from = makeRecord({ appId: "A1", phase: "scratch", buildSteps: 47 });
  const to = makeRecord({ appId: "A2", phase: "reuse", buildSteps: 19 });
  const report = buildLearningComparison(from, to);

  const row = rowFor(report, "build-time");
  assert.strictEqual(row.status, "unavailable");
  if (row.status !== "unavailable") {
    assert.fail("unreachable");
  }
  // The recorded reason states the honest cause: no wall-clock input exists.
  assert.match(row.reason, /clock-free/);
  assert.match(row.reason, /wall-clock/);
  // The deterministic proxy: the build-steps counts flow through verbatim.
  assert.deepStrictEqual(row.proxy, { measure: "build-steps", fromValue: 47, toValue: 19 });

  // No wall-clock primitive enters the module source.
  for (const banned of BANNED_PRIMITIVES) {
    assert.ok(!MODULE_SOURCE.includes(banned), `the module source must not contain "${banned}"`);
  }
  // No timestamp-looking value leaks into the report either.
  assert.doesNotMatch(JSON.stringify(report), /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  assert.match(report.id, /^clapp_learning_[0-9a-f]{16}$/);
});

test("reuse improves only when the evidence says so", () => {
  // Clean evidence: the reuse build reused more packages than its scratch
  // baseline (which reused none) — the reuse-rate row improves.
  const clean = buildLearningComparison(
    makeRecord({
      appId: "A1",
      phase: "scratch",
      reusedPackageIds: [],
      testsPassed: 10,
      testsTotal: 12,
      parity: equivalentParity("clapp_run_fixture_a1"),
    }),
    makeRecord({
      appId: "A2",
      phase: "reuse",
      reusedPackageIds: ["clapp_package_alpha", "clapp_package_beta"],
      newCodeUnits: 9,
      repairIterations: 1,
      buildSteps: 18,
      testsPassed: 14,
      testsTotal: 14,
      parity: equivalentParity("clapp_run_fixture_a2"),
    }),
  );
  const reuseRow = rowFor(clean, "package-reuse-rate");
  assert.strictEqual(reuseRow.status, "available");
  if (reuseRow.status !== "available") {
    assert.fail("unreachable");
  }
  assert.strictEqual(reuseRow.fromValue, 0);
  assert.strictEqual(reuseRow.toValue, 2);
  assert.strictEqual(reuseRow.delta, 2);
  assert.strictEqual(reuseRow.measure, "reused-package-count");
  assert.strictEqual(reuseRow.direction, "improved");

  // Weakened parity is reported as the worsening it is — never an improvement.
  const parityWorsened = buildLearningComparison(
    makeRecord({
      appId: "A1",
      phase: "scratch",
      parity: equivalentParity("clapp_run_fixture_a1"),
    }),
    makeRecord({
      appId: "A2",
      phase: "reuse",
      reusedPackageIds: ["clapp_package_alpha"],
      parity: {
        verdict: "divergent",
        verificationRunId: "clapp_run_fixture_a2",
        minorFindings: 0,
        majorFindings: 1,
      },
    }),
  );
  const parityRow = rowFor(parityWorsened, "parity-improvement");
  assert.strictEqual(parityRow.status, "available");
  if (parityRow.status !== "available") {
    assert.fail("unreachable");
  }
  assert.strictEqual(parityRow.direction, "worsened");
  assert.deepStrictEqual(parityRow.fromValue, {
    verdict: "equivalent",
    majorFindings: 0,
    minorFindings: 0,
  });
  assert.deepStrictEqual(parityRow.toValue, {
    verdict: "divergent",
    majorFindings: 1,
    minorFindings: 0,
  });
  assert.deepStrictEqual(parityRow.delta, { majorFindings: 1, minorFindings: 0 });

  // Weakened acceptance criteria: the same reuse gain is NEVER reported as
  // an improvement — no row claims improvement, the would-be improvements
  // abstain with the recorded reason, and the weakening is declared.
  const tainted = buildLearningComparison(
    makeRecord({
      appId: "A1",
      phase: "scratch",
      reusedPackageIds: [],
      testsPassed: 10,
      testsTotal: 12,
      parity: equivalentParity("clapp_run_fixture_a1"),
    }),
    makeRecord({
      appId: "A2",
      phase: "reuse",
      reusedPackageIds: ["clapp_package_alpha", "clapp_package_beta"],
      newCodeUnits: 9,
      repairIterations: 1,
      buildSteps: 18,
      testsPassed: 14,
      testsTotal: 14,
      parity: equivalentParity("clapp_run_fixture_a2"),
      acceptanceWeakened: true,
    }),
  );
  for (const row of tainted.rows) {
    if (row.status === "available") {
      assert.notStrictEqual(
        row.direction,
        "improved",
        `signal "${row.signal}" must not claim improvement under weakened acceptance criteria`,
      );
    }
  }
  for (const signal of [
    "package-reuse-rate",
    "generated-new-code",
    "repair-iterations",
    "test-pass-rate",
  ] as const) {
    assert.strictEqual(
      rowFor(tainted, signal).status,
      "unavailable",
      `signal "${signal}" abstains under weakened acceptance`,
    );
    const reason = unavailableReason(tainted, signal);
    assert.match(reason, /weakened/);
    assert.match(reason, /A2/);
  }
  assert.deepStrictEqual(tainted.acceptanceIntegrity, { weakened: true, weakenedAppIds: ["A2"] });

  // Parity was measured and unchanged on the tainted pair: it stays visible
  // and honest ("unchanged"), never spun and never hidden.
  const unchangedParity = rowFor(tainted, "parity-improvement");
  assert.strictEqual(unchangedParity.status, "available");
  if (unchangedParity.status === "available") {
    assert.strictEqual(unchangedParity.direction, "unchanged");
  }
});

test("unmeasured signals are unavailable, never fabricated", () => {
  // Neither build supplied test counts or a parity summary.
  const report = buildLearningComparison(
    makeRecord({ appId: "A1", phase: "scratch" }),
    makeRecord({ appId: "A2", phase: "reuse", reusedPackageIds: ["clapp_package_alpha"] }),
  );

  const testsRow = rowFor(report, "test-pass-rate");
  assert.strictEqual(testsRow.status, "unavailable");
  if (testsRow.status !== "unavailable") {
    assert.fail("unreachable");
  }
  assert.match(testsRow.reason, /test pass rate is not measured/);
  assert.match(testsRow.reason, /A1/);
  assert.match(testsRow.reason, /A2/);
  // Never fabricated: the unavailable row carries no values at all.
  assert.ok(!("fromValue" in testsRow));
  assert.ok(!("toValue" in testsRow));
  assert.ok(!("delta" in testsRow));
  assert.ok(!("proxy" in testsRow));

  const parityRow = rowFor(report, "parity-improvement");
  assert.strictEqual(parityRow.status, "unavailable");
  if (parityRow.status !== "unavailable") {
    assert.fail("unreachable");
  }
  assert.match(parityRow.reason, /parity improvement is not measured/);
  assert.match(parityRow.reason, /A1/);
  assert.ok(!("fromValue" in parityRow));

  // Failure recurrence abstains on the un-composed dependency, naming it.
  const recurrenceRow = rowFor(report, "failure-recurrence");
  assert.strictEqual(recurrenceRow.status, "unavailable");
  if (recurrenceRow.status !== "unavailable") {
    assert.fail("unreachable");
  }
  assert.match(recurrenceRow.reason, /failure-memory/);
  assert.match(recurrenceRow.reason, /W2-008/);
  assert.match(recurrenceRow.reason, /not composed/);

  // One-sided measurement stays unavailable and names the unmeasured side.
  const oneSided = buildLearningComparison(
    makeRecord({ appId: "A1", phase: "scratch" }),
    makeRecord({
      appId: "A2",
      phase: "reuse",
      testsPassed: 14,
      testsTotal: 14,
      parity: equivalentParity("clapp_run_fixture_a2"),
    }),
  );
  const oneSidedReason = unavailableReason(oneSided, "test-pass-rate");
  assert.match(oneSidedReason, /A1/);
  assert.ok(!oneSidedReason.includes("A2"), "the reason names only the unmeasured side");

  // A blocked parity is equally unmeasured: no verdict, no comparison.
  const blocked = buildLearningComparison(
    makeRecord({
      appId: "A1",
      phase: "scratch",
      parity: equivalentParity("clapp_run_fixture_a1"),
    }),
    makeRecord({
      appId: "A2",
      phase: "reuse",
      parity: {
        verdict: "blocked",
        verificationRunId: "clapp_run_fixture_a2",
        minorFindings: 0,
        majorFindings: 0,
      },
    }),
  );
  const blockedReason = unavailableReason(blocked, "parity-improvement");
  assert.match(blockedReason, /blocked/);
  assert.match(blockedReason, /A2/);

  // The digest accounts for every unavailable row with its reason.
  assert.deepStrictEqual(report.digest, {
    rowsTotal: 8,
    available: 4,
    unavailable: 4,
    reasons: [
      unavailableReason(report, "build-time"),
      unavailableReason(report, "test-pass-rate"),
      unavailableReason(report, "parity-improvement"),
      unavailableReason(report, "failure-recurrence"),
    ],
  });
});

test("the report is a pure deterministic function", () => {
  const from = makeRecord({
    appId: "A1",
    phase: "scratch",
    rejectedPackageIds: ["clapp_package_delta", "clapp_package_gamma"],
    testsPassed: 10,
    testsTotal: 12,
    parity: equivalentParity("clapp_run_fixture_a1"),
  });
  const to = makeRecord({
    appId: "A2",
    phase: "reuse",
    reusedPackageIds: ["clapp_package_beta", "clapp_package_alpha"],
    newCodeUnits: 9,
    repairIterations: 1,
    buildSteps: 18,
    testsPassed: 14,
    testsTotal: 14,
    parity: equivalentParity("clapp_run_fixture_a2"),
  });

  // Re-running over the same records produces a byte-identical report.
  const first = buildLearningComparison(from, to);
  const second = buildLearningComparison(
    JSON.parse(JSON.stringify(from)) as LearningBuildRecord,
    JSON.parse(JSON.stringify(to)) as LearningBuildRecord,
  );
  assert.strictEqual(JSON.stringify(second), JSON.stringify(first));
  assert.deepStrictEqual(second, first);

  // Input array order never leaks into the output: reversed id arrays
  // produce the same canonical records, rows and content-addressed id.
  const reordered = buildLearningComparison(
    makeRecord({
      ...from,
      rejectedPackageIds: ["clapp_package_gamma", "clapp_package_delta"],
    }),
    makeRecord({ ...to, reusedPackageIds: ["clapp_package_alpha", "clapp_package_beta"] }),
  );
  assert.strictEqual(JSON.stringify(reordered), JSON.stringify(first));

  // The report id is content-addressed over the report's core.
  assert.ok(first.id.startsWith(LEARNING_REPORT_ID_PREFIX));
  assert.match(first.id, /^clapp_learning_[0-9a-f]{16}$/);
  // Different content produces a different report id.
  const different = buildLearningComparison(from, makeRecord({ ...to, newCodeUnits: 12 }));
  assert.notStrictEqual(different.id, first.id);
  assert.notStrictEqual(JSON.stringify(different), JSON.stringify(first));
});

test("malformed build records fail closed", () => {
  const expectIssues = (from: unknown, to: unknown, ...expected: string[]): readonly string[] => {
    let caught: LearningRecordError | null = null;
    try {
      buildLearningComparison(from as LearningBuildRecord, to as LearningBuildRecord);
    } catch (error) {
      if (error instanceof LearningRecordError) {
        caught = error;
      } else {
        throw error;
      }
    }
    assert.ok(
      caught,
      "expected the malformed build records to fail closed with LearningRecordError",
    );
    assert.strictEqual(caught.code, "invalid-record");
    for (const fragment of expected) {
      assert.ok(
        caught.issues.some((issue) => issue.includes(fragment)),
        `expected a collected issue mentioning "${fragment}", got: ${JSON.stringify(caught.issues)}`,
      );
    }
    return caught.issues;
  };

  const wellFormed = {
    appId: "A2",
    phase: "reuse",
    reusedPackageIds: [],
    rejectedPackageIds: [],
    newCodeUnits: 5,
    repairIterations: 0,
    buildSteps: 12,
  };

  // Every malformation of one record is collected — never just the first.
  const collected = expectIssues(
    {
      appId: "A1",
      phase: "rebuild",
      reusedPackageIds: [],
      rejectedPackageIds: [],
      newCodeUnits: -1,
      repairIterations: 1.5,
      buildSteps: 40,
    },
    wellFormed,
    'from.phase must be "scratch" or "reuse"',
    "from.newCodeUnits must be a non-negative integer",
    "from.repairIterations must be a non-negative integer",
  );
  assert.ok(collected.length >= 3, "all three malformations were collected");

  // A missing app id is malformed.
  expectIssues(
    {
      phase: "scratch",
      reusedPackageIds: [],
      rejectedPackageIds: [],
      newCodeUnits: 1,
      repairIterations: 0,
      buildSteps: 2,
    },
    wellFormed,
    "from.appId must be a non-empty string",
  );

  // A non-integer count on the to-record.
  expectIssues(
    wellFormed,
    { ...wellFormed, buildSteps: 2.5 },
    "to.buildSteps must be a non-negative integer",
  );

  // Malformations on BOTH records are collected together.
  expectIssues(
    {
      appId: "",
      phase: "scratch",
      reusedPackageIds: [],
      rejectedPackageIds: [],
      newCodeUnits: 1,
      repairIterations: 0,
      buildSteps: 2,
    },
    { ...wellFormed, phase: "unknown" },
    "from.appId must be a non-empty string",
    'to.phase must be "scratch" or "reuse"',
  );

  // Partial or contradictory test data never yields a half-measured row.
  expectIssues(
    wellFormed,
    { ...wellFormed, testsPassed: 4 },
    "to.testsPassed and to.testsTotal must be supplied together",
  );
  expectIssues(
    wellFormed,
    { ...wellFormed, testsPassed: 4, testsTotal: 0 },
    "to.testsTotal must be an integer >= 1",
  );
  expectIssues(
    wellFormed,
    { ...wellFormed, testsPassed: 5, testsTotal: 4 },
    "to.testsPassed must be an integer between 0 and to.testsTotal",
  );

  // Contradictory parity (an equivalence claim with findings) never compares.
  expectIssues(
    wellFormed,
    {
      ...wellFormed,
      parity: {
        verdict: "equivalent",
        verificationRunId: "clapp_run_fixture_x",
        minorFindings: 0,
        majorFindings: 1,
      },
    },
    "contradictory parity never compares",
  );

  // Package id lists are structural: duplicates and contradictions fail.
  expectIssues(
    wellFormed,
    { ...wellFormed, reusedPackageIds: ["clapp_package_alpha", "clapp_package_alpha"] },
    'to.reusedPackageIds contains duplicate package id "clapp_package_alpha"',
  );
  expectIssues(
    wellFormed,
    {
      ...wellFormed,
      reusedPackageIds: ["clapp_package_alpha"],
      rejectedPackageIds: ["clapp_package_alpha"],
    },
    'to lists package id "clapp_package_alpha" as both reused and rejected',
  );

  // A non-object record fails closed outright; a non-boolean acceptance
  // declaration is malformed.
  expectIssues(null, wellFormed, "the from build record must be an object");
  expectIssues(
    wellFormed,
    { ...wellFormed, acceptanceWeakened: "yes" },
    "to.acceptanceWeakened must be a boolean when present",
  );

  // The same call site over well-formed records returns the fully-derived
  // report — never a partial one.
  const report = buildLearningComparison(
    makeRecord({ appId: "A1", phase: "scratch" }),
    makeRecord({ appId: "A2", phase: "reuse" }),
  );
  assert.strictEqual(report.digest.rowsTotal, 8);
});

test("the M6 steps 4-6 seam composes the real extraction and retrieval", async () => {
  const app = CANONICAL_BENCHMARKS.find((benchmark) => benchmark.id === "clapp_benchmark_b02");
  assert.ok(app, "the B02 stateful benchmark is in the canonical inventory");

  // One verified paired harness run of the benchmark: both builds of the
  // repeated sequence measure their parity through it (in-process loopback
  // only, the established seam-test pattern).
  const runPaired = async (): Promise<{
    verdict: "equivalent" | "divergent";
    verificationRunId: string;
    irDigest: string;
  }> => {
    const reference = createBenchmarkHarness(app);
    const rebuilt = createBenchmarkHarness(app);
    const referenceSide = await reference.start();
    const candidateSide = await rebuilt.start();
    try {
      const pageJourneys = app.routes.map((route) => ({
        path: route.path,
        anchors: [...route.anchors],
      }));
      const referenceCaptures: Array<Record<string, unknown>> = [];
      const candidateCaptures: Array<Record<string, unknown>> = [];
      let divergences = 0;
      for (const journey of pageJourneys) {
        const [referenceResponse, candidateResponse] = await Promise.all([
          fetch(new URL(journey.path, referenceSide.baseUrl)),
          fetch(new URL(journey.path, candidateSide.baseUrl)),
        ]);
        const referenceBody = await referenceResponse.text();
        const candidateBody = await candidateResponse.text();
        referenceCaptures.push({
          path: journey.path,
          status: referenceResponse.status,
          contentType: referenceResponse.headers.get("content-type"),
          bodyDigest: benchmarkSha256Hex(referenceBody),
        });
        candidateCaptures.push({
          path: journey.path,
          status: candidateResponse.status,
          contentType: candidateResponse.headers.get("content-type"),
          bodyDigest: benchmarkSha256Hex(candidateBody),
        });
        if (
          referenceResponse.status !== candidateResponse.status ||
          referenceResponse.headers.get("content-type") !==
            candidateResponse.headers.get("content-type") ||
          referenceBody !== candidateBody
        ) {
          divergences += 1;
        }
        for (const anchor of journey.anchors) {
          if (!referenceBody.includes(anchor) || !candidateBody.includes(anchor)) {
            divergences += 1;
          }
        }
      }
      const [referenceApi, candidateApi] = await Promise.all([
        fetch(new URL("/api/", referenceSide.baseUrl)),
        fetch(new URL("/api/", candidateSide.baseUrl)),
      ]);
      const referenceApiBody = await referenceApi.text();
      const candidateApiBody = await candidateApi.text();
      if (referenceApi.status !== candidateApi.status || referenceApiBody !== candidateApiBody) {
        divergences += 1;
      }
      const verdict = divergences === 0 ? "equivalent" : "divergent";
      // A content-addressed verification run id: no ports, no timestamps.
      const verificationRunId = `clapp_run_${benchmarkSha256Hex(
        benchmarkCanonicalJson({
          benchmarkId: app.id,
          reference: referenceCaptures,
          candidate: candidateCaptures,
          api: { reference: referenceApiBody, candidate: candidateApiBody },
        }),
      ).slice(0, 16)}`;
      return {
        verdict,
        verificationRunId,
        irDigest: benchmarkSha256Hex(benchmarkCanonicalJson(referenceCaptures)),
      };
    } finally {
      await referenceSide.stop();
      await candidateSide.stop();
    }
  };

  // A1 — build from scratch, verify parity, extract packages (M6 steps 1-3,
  // the W2-006 chain over the real W2-005 registry).
  const a1 = await runPaired();
  assert.strictEqual(a1.verdict, "equivalent");
  const reconstructionId = "rc-clapp-benchmark-b02-0001";
  const artifacts: ReconstructionArtifacts = {
    reconstructionId,
    parity: {
      verdict: a1.verdict,
      verificationRunId: a1.verificationRunId,
      minorFindings: 0,
      majorFindings: 0,
    },
    planInventory: {
      components: app.routes.map((route) => ({
        path: route.path,
        kind: "page",
        name: route.path === "/" ? "index" : route.path.slice(1),
      })),
      apiEntries: [{ path: "/api/" }],
      persistenceKeys: Object.keys(app.stateSeed ?? {}).sort(),
    },
    archetype: { label: "CRUD SaaS" },
    irDigest: a1.irDigest,
  };
  const extraction = extractPackageCandidates(artifacts);
  assert.strictEqual(extraction.candidates.length, 1, "the successful A1 build extracts a package");
  const candidate = extraction.candidates[0].package;

  const registry = createPackageRegistry(new InMemoryPackageStore());
  const registration = registerCandidates(registry, extraction.candidates);
  assert.strictEqual(registration.results[0].ok, true);
  const promotion = promoteVerified(
    registry,
    { id: candidate.id, version: candidate.version },
    {
      verdict: a1.verdict,
      verificationRunId: a1.verificationRunId,
      verifiedAt: VERIFIED_AT,
      minorFindings: 0,
      majorFindings: 0,
      reconstructionId,
      irDigest: artifacts.irDigest,
    },
  );
  assert.strictEqual(promotion.promoted, true);

  // A2 — build a second app matching the prior archetype (M6 step 4) and
  // reuse packages through the real retrieval feed (M6 step 5).
  const a2 = await runPaired();
  assert.strictEqual(a2.verdict, "equivalent");
  const retrieval = retrievePackages({
    registry,
    query: { category: candidate.category, status: "promoted" },
  });
  assert.strictEqual(retrieval.results.length, 1, "the promoted A1 package is retrieved");
  const reusedIds = retrieval.results.map((entry) => entry.package.id);
  assert.deepStrictEqual(reusedIds, [candidate.id]);

  // The two records: all counts are the caller's structural measurements of
  // the harness runs; A2's reused package ids come from the retrieval output.
  const a1Record = makeRecord({
    appId: "A1",
    phase: "scratch",
    reusedPackageIds: [],
    rejectedPackageIds: [],
    newCodeUnits: app.routes.length + 1,
    repairIterations: 3,
    buildSteps: app.routes.length + 2,
    testsPassed: app.routes.length,
    testsTotal: app.routes.length,
    parity: {
      verdict: a1.verdict,
      verificationRunId: a1.verificationRunId,
      minorFindings: 0,
      majorFindings: 0,
    },
  });
  const a2Record = makeRecord({
    appId: "A2",
    phase: "reuse",
    reusedPackageIds: reusedIds,
    rejectedPackageIds: [],
    newCodeUnits: 1,
    repairIterations: 0,
    buildSteps: 2,
    testsPassed: app.routes.length,
    testsTotal: app.routes.length,
    parity: {
      verdict: a2.verdict,
      verificationRunId: a2.verificationRunId,
      minorFindings: 0,
      majorFindings: 0,
    },
  });

  // M6 step 6 — compare: the reuse-rate row counts exactly those ids.
  const report = buildLearningComparison(a1Record, a2Record);
  const reuseRow = rowFor(report, "package-reuse-rate");
  assert.strictEqual(reuseRow.status, "available");
  if (reuseRow.status !== "available") {
    assert.fail("unreachable");
  }
  assert.strictEqual(reuseRow.fromValue, 0);
  assert.strictEqual(reuseRow.toValue, reusedIds.length);
  assert.strictEqual(reuseRow.direction, "improved");
  assert.deepStrictEqual(report.toBuild.reusedPackageIds, [...reusedIds].sort());

  // The comparison reports the other M6 step-6 dimensions honestly: six
  // measured rows, the two honest abstentions, no weakened acceptance.
  assert.strictEqual(report.digest.rowsTotal, 8);
  assert.strictEqual(report.digest.available, 6);
  assert.strictEqual(report.digest.unavailable, 2);
  assert.deepStrictEqual(report.acceptanceIntegrity, { weakened: false, weakenedAppIds: [] });
  const parityRow = rowFor(report, "parity-improvement");
  if (parityRow.status !== "available") {
    assert.fail("expected the parity row to be measured on the seam pair");
  }
  assert.strictEqual(parityRow.direction, "unchanged");
});

test("repair iterations are caller-supplied structural counts", () => {
  const from = makeRecord({
    appId: "A1",
    phase: "scratch",
    repairIterations: 4,
    testsPassed: 12,
    testsTotal: 12,
    parity: equivalentParity("clapp_run_fixture_a1"),
  });
  const toBase = {
    appId: "A2",
    phase: "reuse" as const,
    reusedPackageIds: ["clapp_package_alpha"],
    newCodeUnits: 9,
    buildSteps: 18,
    testsPassed: 12,
    testsTotal: 12,
    parity: equivalentParity("clapp_run_fixture_a2"),
  };

  // Identical records except the caller-supplied repair counts: the rows
  // echo the supplied counts exactly — never derived, never estimated.
  const improvedPair = buildLearningComparison(
    from,
    makeRecord({ ...toBase, repairIterations: 2 }),
  );
  const improvedRow = rowFor(improvedPair, "repair-iterations");
  assert.strictEqual(improvedRow.status, "available");
  if (improvedRow.status !== "available") {
    assert.fail("unreachable");
  }
  assert.strictEqual(improvedRow.fromValue, 4);
  assert.strictEqual(improvedRow.toValue, 2);
  assert.strictEqual(improvedRow.delta, -2);
  assert.strictEqual(improvedRow.measure, "repair-iterations");
  assert.strictEqual(improvedRow.direction, "improved");
  assert.strictEqual(improvedPair.fromBuild.repairIterations, 4);
  assert.strictEqual(improvedPair.toBuild.repairIterations, 2);

  const worsenedPair = buildLearningComparison(
    from,
    makeRecord({ ...toBase, repairIterations: 5 }),
  );
  const worsenedRow = rowFor(worsenedPair, "repair-iterations");
  assert.strictEqual(worsenedRow.status, "available");
  if (worsenedRow.status !== "available") {
    assert.fail("unreachable");
  }
  assert.strictEqual(worsenedRow.fromValue, 4);
  assert.strictEqual(worsenedRow.toValue, 5);
  assert.strictEqual(worsenedRow.delta, 1);
  assert.strictEqual(worsenedRow.direction, "worsened");
  // The supplied count itself changes the report identity.
  assert.notStrictEqual(worsenedPair.id, improvedPair.id);

  // The module composes nothing outside @clapp/intelligence and runs no
  // repair: every import of the module source is in-package (relative).
  const specifiers = [...MODULE_SOURCE.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
  assert.ok(specifiers.length >= 2, "the module's imports are inspectable");
  for (const specifier of specifiers) {
    assert.ok(
      specifier.startsWith("./"),
      `module import "${specifier}" must be in-package (relative)`,
    );
  }
  for (const banned of BANNED_PRIMITIVES) {
    assert.ok(!MODULE_SOURCE.includes(banned), `the module source must not contain "${banned}"`);
  }

  // Purity: the function never mutates its inputs.
  const fromSnapshot = JSON.stringify(from);
  buildLearningComparison(from, makeRecord({ appId: "A2", phase: "reuse" }));
  assert.strictEqual(JSON.stringify(from), fromSnapshot);
});
