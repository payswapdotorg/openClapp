import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  buildLearningComparison,
  createPackageRegistry,
  decidePromotionGate,
  EVALUATION_DECISION_ID_PREFIX,
  extractPackageCandidates,
  type GatedPromotionInput,
  type LearningBuildRecord,
  type LearningComparisonReport,
  type LearningSignalId,
  type LearningSignalRow,
  type PackageRegistry,
  type PackageStore,
  type PackageStoreKey,
  type PackageStoreRecord,
  type ParityEvidence,
  type ParitySummary,
  PROMOTION_GATE_CRITERIA,
  PromotionGateError,
  promoteGated,
  type ReconstructionArtifacts,
  registerCandidates,
  retrievePackages,
} from "../packages/clapp-intelligence/src/index.ts";

/**
 * CLAPP-W2-010 — package promotion/evaluation gate.
 *
 * Contract: a package candidate is promoted ONLY when BOTH gates pass. First
 * the W2-006 parity discipline (the promoteVerified semantics: verdict
 * "equivalent" with a non-empty verification run id AND a real verifiedAt
 * timestamp; contradictory equivalence refused), then the benchmark-grounded
 * evaluation gate: the W2-009 repeated-sequence pair (scratch build, reuse
 * build) is composed through the real buildLearningComparison into the
 * grounding report, and the frozen PROMOTION_GATE_CRITERIA contract decides —
 * the reuse build's parity is a real verified "equivalent", the evaluation's
 * acceptance integrity is unweakened, the reuse build reused the candidate,
 * and the parity evidence cites a verification run. Every criterion is
 * fail-closed: unevaluated packages, unmeasured parity, weakened acceptance
 * and unexercised packages are withheld with every recorded reason, never
 * silently promoted; the registry is left untouched. When both gates pass,
 * the registry's promote records evidence whose provenance notes cite the
 * benchmark report id and the gate decision id. The decision is pure,
 * deterministic, clock-free and content-addressed under clapp_eval_; there
 * is no per-call criteria override and no aggregate score. The integration
 * seam composes the REAL W2-005 registry (in-memory store port), the REAL
 * W2-006 extraction and the REAL W2-007 retrieval. Deterministic only: no
 * wall-clock, no randomness, no external network.
 */

/** The fixed verification timestamp fixtures use (determinism; never invented). */
const VERIFIED_AT = "2025-07-01T10:00:00.000Z";

/** The module under contract, for the purity and import-discipline scans. */
const MODULE_URL = new URL("../packages/clapp-intelligence/src/promotion-gate.ts", import.meta.url);
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

const RECONSTRUCTION_ID = "rc-w2-010-0001";
const RUN_A1 = "clapp_run_fixture_w2_010_a1";
const RUN_A2 = "clapp_run_fixture_w2_010_a2";
const IR_DIGEST = createHash("sha256").update("clapp-w2-010 fixture behavioral IR").digest("hex");

/** An equivalent parity summary citing a verification run. */
function equivalentParity(verificationRunId: string): ParitySummary {
  return { verdict: "equivalent", verificationRunId, minorFindings: 0, majorFindings: 0 };
}

/** The fixture reconstruction artifacts of a successful A1 build (W2-006). */
function makeArtifacts(): ReconstructionArtifacts {
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
function baseFrom(overrides: RecordOverrides = {}): LearningBuildRecord {
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

/** The to-record: the A2 reuse build, verified, reusing the candidate. */
function baseTo(candidateId: string, overrides: RecordOverrides = {}): LearningBuildRecord {
  return makeRecord({
    appId: "A2",
    phase: "reuse",
    reusedPackageIds: [candidateId],
    newCodeUnits: 9,
    repairIterations: 1,
    buildSteps: 18,
    testsPassed: 14,
    testsTotal: 14,
    parity: equivalentParity(RUN_A2),
    ...overrides,
  });
}

/** The caller's parity evidence for the candidate (A1's verification). */
function flowParityEvidence(overrides: Partial<ParityEvidence> = {}): ParityEvidence {
  return {
    verdict: "equivalent",
    verificationRunId: RUN_A1,
    verifiedAt: VERIFIED_AT,
    minorFindings: 0,
    majorFindings: 0,
    reconstructionId: RECONSTRUCTION_ID,
    irDigest: IR_DIGEST,
    ...overrides,
  };
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

/** The report's row for one signal (fails the test when absent). */
function rowFor(report: LearningComparisonReport, signal: LearningSignalId): LearningSignalRow {
  const row = report.rows.find((entry) => entry.signal === signal);
  if (row === undefined) {
    assert.fail(`expected exactly one row for signal "${signal}"`);
  }
  return row;
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

/**
 * The integration-seam fixture: extracts the candidate from a successful
 * reconstruction's structural artifacts (the REAL W2-006 extraction) and
 * registers it through the REAL W2-005 registry (in-memory store port).
 */
function setupCandidate(): {
  registry: PackageRegistry;
  candidate: { id: string; version: string; category: string };
} {
  const artifacts = makeArtifacts();
  const extraction = extractPackageCandidates(artifacts);
  assert.strictEqual(
    extraction.candidates.length,
    1,
    "the fixture reconstruction extracts a candidate",
  );
  const candidate = extraction.candidates[0].package;
  const registry = createPackageRegistry(new InMemoryPackageStore());
  const registration = registerCandidates(registry, extraction.candidates);
  assert.strictEqual(registration.results[0]?.ok, true, "the candidate registers as a candidate");
  assert.strictEqual(registry.list({ status: "candidate" }).length, 1);
  assert.strictEqual(registry.list({ status: "promoted" }).length, 0);
  return { registry, candidate };
}

test("unevaluated packages are withheld, never silently promoted", () => {
  const { registry, candidate } = setupCandidate();

  // Parity evidence alone — no benchmark evaluation — must never promote.
  const outcome = promoteGated(registry, {
    candidate: { id: candidate.id, version: candidate.version },
    parity: flowParityEvidence(),
  });

  assert.strictEqual(outcome.promoted, false);
  if (!outcome.promoted) {
    assert.strictEqual(outcome.decision, null, "no decision is derived without a grounding report");
    const unevaluated = outcome.reasons.find((reason) => /unevaluated/.test(reason));
    assert.ok(unevaluated, `a recorded unevaluated reason exists: ${outcome.reasons.join(" | ")}`);
    assert.ok(unevaluated?.includes(candidate.id), "the reason names the withheld package");
  }

  // The registry is untouched: the promoted list is unchanged and the
  // package stays a candidate.
  assert.strictEqual(registry.list({ status: "promoted" }).length, 0);
  const candidates = registry.list({ status: "candidate" });
  assert.strictEqual(candidates.length, 1);
  assert.strictEqual(candidates[0]?.id, candidate.id);
  assert.strictEqual(candidates[0]?.version, candidate.version);
});

test("a benchmark-grounded evaluation promotes through the real registry", () => {
  const { registry, candidate } = setupCandidate();
  const evaluation = { from: baseFrom(), to: baseTo(candidate.id) };
  const report = buildLearningComparison(evaluation.from, evaluation.to);

  const outcome = promoteGated(registry, {
    candidate: { id: candidate.id, version: candidate.version },
    parity: flowParityEvidence(),
    evaluation,
  });

  assert.strictEqual(
    outcome.promoted,
    true,
    JSON.stringify(outcome.promoted ? null : outcome.reasons),
  );
  if (!outcome.promoted) {
    assert.fail("unreachable");
  }
  assert.strictEqual(outcome.decision.outcome, "promoted");
  assert.strictEqual(outcome.decision.reportId, report.id);
  assert.match(outcome.decision.id, /^clapp_eval_[0-9a-f]{16}$/);
  assert.strictEqual(outcome.idempotent, false);

  // The promotion evidence cites the benchmark report and the gate decision.
  assert.ok(
    outcome.evidence.provenanceNotes?.includes(`benchmark report: ${report.id}`),
    "the evidence notes cite the benchmark report id",
  );
  assert.ok(
    outcome.evidence.provenanceNotes?.includes(`gate decision: ${outcome.decision.id}`),
    "the evidence notes cite the gate decision id",
  );
  assert.strictEqual(outcome.evidence.verifiedAt, VERIFIED_AT);
  assert.strictEqual(outcome.evidence.verificationRunId, RUN_A1);

  // The registry recorded the promotion with the grounding citations.
  const promoted = registry.list({ status: "promoted" });
  assert.strictEqual(promoted.length, 1);
  assert.strictEqual(promoted[0]?.id, candidate.id);
  assert.strictEqual(promoted[0]?.version, candidate.version);
  assert.deepStrictEqual(outcome.document, promoted[0]);
  const stored = promoted[0];
  assert.ok(stored);
  const promotion = stored.provenance.promotion as Record<string, unknown>;
  assert.strictEqual(promotion.verificationRunId, RUN_A1);
  const notes = promotion.provenanceNotes as string[] | undefined;
  assert.ok(notes?.includes(`benchmark report: ${report.id}`));
  assert.ok(notes?.includes(`gate decision: ${outcome.decision.id}`));

  // Re-promotion with byte-identical evidence is the registry's own no-op.
  const repeat = promoteGated(registry, {
    candidate: { id: candidate.id, version: candidate.version },
    parity: flowParityEvidence(),
    evaluation: JSON.parse(JSON.stringify(evaluation)) as typeof evaluation,
  });
  assert.strictEqual(repeat.promoted, true);
  if (repeat.promoted && outcome.promoted) {
    assert.strictEqual(repeat.idempotent, true);
    assert.deepStrictEqual(repeat.document, outcome.document);
    assert.deepStrictEqual(repeat.evidence, outcome.evidence);
    assert.strictEqual(repeat.decision.id, outcome.decision.id);
  }

  // The W2-007 retrieval feed sees the promoted package.
  const retrieval = retrievePackages({
    registry,
    query: { category: candidate.category, status: "promoted" },
  });
  assert.strictEqual(retrieval.results.length, 1, "the promoted package is retrieved");
  assert.strictEqual(retrieval.results[0]?.package.id, candidate.id);
  assert.strictEqual(registry.list({ status: "candidate" }).length, 0);
});

test("weakened acceptance withholds would-be promotion", () => {
  const { registry, candidate } = setupCandidate();
  const evaluation = {
    from: baseFrom(),
    to: baseTo(candidate.id, { acceptanceWeakened: true }),
  };

  // The evaluation itself is well-formed and declares the weakening.
  const report = buildLearningComparison(evaluation.from, evaluation.to);
  assert.deepStrictEqual(report.acceptanceIntegrity, { weakened: true, weakenedAppIds: ["A2"] });

  const outcome = promoteGated(registry, {
    candidate: { id: candidate.id, version: candidate.version },
    parity: flowParityEvidence(),
    evaluation,
  });

  assert.strictEqual(outcome.promoted, false);
  if (!outcome.promoted) {
    // LEARNING.md's bar applies to promotion exactly as it applies to
    // improvement claims: the weakening is recorded, never hidden.
    assert.ok(
      outcome.reasons.some((reason) => /weakened/.test(reason) && /A2/.test(reason)),
      `the weakening is recorded: ${outcome.reasons.join(" | ")}`,
    );
    assert.ok(outcome.decision !== null);
    assert.strictEqual(outcome.decision?.outcome, "withheld");
    assert.ok(outcome.decision?.reasons.some((reason) => /weakened/.test(reason)));
  }

  // The registry is untouched.
  assert.strictEqual(registry.list({ status: "promoted" }).length, 0);
  assert.strictEqual(registry.list({ status: "candidate" }).length, 1);
});

test("divergent or unmeasured parity withholds", () => {
  // (a) The evaluated build's parity is divergent: withheld.
  const divergentSetup = setupCandidate();
  const divergent = promoteGated(divergentSetup.registry, {
    candidate: { id: divergentSetup.candidate.id, version: divergentSetup.candidate.version },
    parity: flowParityEvidence(),
    evaluation: {
      from: baseFrom(),
      to: baseTo(divergentSetup.candidate.id, {
        parity: {
          verdict: "divergent",
          verificationRunId: RUN_A2,
          minorFindings: 0,
          majorFindings: 1,
        },
      }),
    },
  });
  assert.strictEqual(divergent.promoted, false);
  if (!divergent.promoted) {
    assert.ok(
      divergent.reasons.some((reason) => /divergent/.test(reason)),
      `the divergent verdict is recorded: ${divergent.reasons.join(" | ")}`,
    );
    assert.strictEqual(divergent.decision?.outcome, "withheld");
  }
  assert.strictEqual(divergentSetup.registry.list({ status: "promoted" }).length, 0);
  assert.strictEqual(divergentSetup.registry.list({ status: "candidate" }).length, 1);

  // (b) The parity signal is unmeasured (no parity on the reuse build):
  // withheld with recorded reasons — never a promotion on unmeasured parity.
  const unmeasuredSetup = setupCandidate();
  const unmeasured = promoteGated(unmeasuredSetup.registry, {
    candidate: { id: unmeasuredSetup.candidate.id, version: unmeasuredSetup.candidate.version },
    parity: flowParityEvidence(),
    evaluation: {
      from: baseFrom(),
      to: baseTo(unmeasuredSetup.candidate.id, { parity: undefined }),
    },
  });
  assert.strictEqual(unmeasured.promoted, false);
  if (!unmeasured.promoted) {
    assert.ok(
      unmeasured.reasons.some((reason) => /did not measure parity/.test(reason)),
      `the unmeasured parity is recorded: ${unmeasured.reasons.join(" | ")}`,
    );
    assert.ok(
      unmeasured.reasons.some((reason) => /cites no verification run id/.test(reason)),
      "the missing verification run citation is recorded too",
    );
    assert.strictEqual(unmeasured.decision?.outcome, "withheld");
    assert.ok((unmeasured.decision?.reasons.length ?? 0) >= 2, "every reason, not just the first");
  }
  assert.strictEqual(unmeasuredSetup.registry.list({ status: "promoted" }).length, 0);
  assert.strictEqual(unmeasuredSetup.registry.list({ status: "candidate" }).length, 1);
});

test("the evaluation must exercise the package", () => {
  const { registry, candidate } = setupCandidate();

  // The reuse build reused some OTHER package: the benchmark never
  // exercised the candidate, so the evaluation cannot justify its promotion.
  const outcome = promoteGated(registry, {
    candidate: { id: candidate.id, version: candidate.version },
    parity: flowParityEvidence(),
    evaluation: {
      from: baseFrom(),
      to: baseTo("clapp_package_some_other_package"),
    },
  });

  assert.strictEqual(outcome.promoted, false);
  if (!outcome.promoted) {
    const notReused = outcome.reasons.find((reason) => /did not reuse/.test(reason));
    assert.ok(notReused, `the unexercised package is recorded: ${outcome.reasons.join(" | ")}`);
    assert.ok(notReused?.includes(candidate.id), "the reason names the candidate");
    assert.strictEqual(outcome.decision?.outcome, "withheld");
  }

  // The registry is untouched.
  assert.strictEqual(registry.list({ status: "promoted" }).length, 0);
  assert.strictEqual(registry.list({ status: "candidate" }).length, 1);
});

test("gate decisions are deterministic and content-addressed", () => {
  const { candidate } = setupCandidate();
  const report = buildLearningComparison(baseFrom(), baseTo(candidate.id));
  const coordinate = { id: candidate.id, version: candidate.version };
  const input = { candidate: coordinate, report };

  // The same inputs produce a byte-identical decision with the same id.
  const first = decidePromotionGate(input);
  const second = decidePromotionGate(JSON.parse(JSON.stringify(input)) as typeof input);
  assert.deepStrictEqual(first, second);
  assert.strictEqual(first.id, second.id);
  assert.match(first.id, /^clapp_eval_[0-9a-f]{16}$/);
  assert.strictEqual(
    first.id.slice(0, EVALUATION_DECISION_ID_PREFIX.length),
    EVALUATION_DECISION_ID_PREFIX,
  );

  // Purity: the decision never mutates its input.
  const reportSnapshot = JSON.stringify(report);
  decidePromotionGate(input);
  assert.strictEqual(JSON.stringify(report), reportSnapshot);

  // Reordered package-id arrays in the build records do not change the
  // report (the W2-009 composer canonicalizes them) nor the decision.
  const orderA = buildLearningComparison(
    baseFrom(),
    baseTo(candidate.id, { reusedPackageIds: [candidate.id, "clapp_package_extra"] }),
  );
  const orderB = buildLearningComparison(
    baseFrom(),
    baseTo(candidate.id, { reusedPackageIds: ["clapp_package_extra", candidate.id] }),
  );
  assert.deepStrictEqual(orderB, orderA);
  const decisionA = decidePromotionGate({ candidate: coordinate, report: orderA });
  const decisionB = decidePromotionGate({ candidate: coordinate, report: orderB });
  assert.deepStrictEqual(decisionB, decisionA);
  assert.strictEqual(decisionB.id, decisionA.id);

  // The decision embeds the criteria it applied and cites the candidate
  // coordinate and the report id.
  assert.deepStrictEqual(first.criteria, PROMOTION_GATE_CRITERIA);
  assert.deepStrictEqual(first.candidate, { id: candidate.id, version: candidate.version });
  assert.strictEqual(first.reportId, report.id);
  assert.strictEqual(first.outcome, "promoted");
  assert.deepStrictEqual(first.reasons, []);

  // No aggregate score exists anywhere on the decision.
  assert.deepStrictEqual(
    deepKeys(first).filter((key) => /score/i.test(key)),
    [],
  );

  // The withheld shape is deterministic too: every reason, in criteria order.
  const withheldReport = buildLearningComparison(baseFrom(), baseTo("clapp_package_other"));
  const withheld = decidePromotionGate({ candidate: coordinate, report: withheldReport });
  assert.strictEqual(withheld.outcome, "withheld");
  assert.strictEqual(withheld.reasons.length, 1);
  assert.deepStrictEqual(
    decidePromotionGate({ candidate: coordinate, report: withheldReport }),
    withheld,
  );
});

test("the W2-006 parity gate still applies underneath", () => {
  const cases: Array<{ label: string; parity: ParityEvidence; pattern: RegExp }> = [
    {
      label: "contradictory equivalence (findings at or above minor severity)",
      parity: flowParityEvidence({ minorFindings: 2, majorFindings: 1 }),
      pattern: /contradictory/,
    },
    {
      label: "missing verifiedAt",
      parity: {
        verdict: "equivalent",
        verificationRunId: RUN_A1,
        minorFindings: 0,
        majorFindings: 0,
      },
      pattern: /verifiedAt/,
    },
    {
      label: "missing verification run id",
      parity: {
        verdict: "equivalent",
        verificationRunId: "",
        verifiedAt: VERIFIED_AT,
        minorFindings: 0,
        majorFindings: 0,
      },
      pattern: /verification run id/,
    },
  ];

  for (const { label, parity, pattern } of cases) {
    const { registry, candidate } = setupCandidate();
    const evaluation = { from: baseFrom(), to: baseTo(candidate.id) };

    // The evaluation itself passes: only the parity evidence is bad.
    const report = buildLearningComparison(evaluation.from, evaluation.to);
    const decision = decidePromotionGate({
      candidate: { id: candidate.id, version: candidate.version },
      report,
    });
    assert.strictEqual(decision.outcome, "promoted", `the evaluation passes (${label})`);

    const outcome = promoteGated(registry, {
      candidate: { id: candidate.id, version: candidate.version },
      parity,
      evaluation,
    });
    assert.strictEqual(outcome.promoted, false, `the parity gate withholds (${label})`);
    if (!outcome.promoted) {
      assert.ok(
        outcome.reasons.some((reason) => /parity gate/.test(reason) && pattern.test(reason)),
        `the reasons name the parity gate (${label}): ${outcome.reasons.join(" | ")}`,
      );
    }

    // The registry is untouched: the package stays a candidate.
    assert.strictEqual(
      registry.list({ status: "promoted" }).length,
      0,
      `registry untouched (${label})`,
    );
    assert.strictEqual(
      registry.list({ status: "candidate" }).length,
      1,
      `candidate stays (${label})`,
    );
  }
});

test("the gate is fail-closed and cannot be gamed per call", () => {
  const { registry, candidate } = setupCandidate();
  const evaluation = { from: baseFrom(), to: baseTo(candidate.id) };
  const report = buildLearningComparison(evaluation.from, evaluation.to);
  const coordinate = { id: candidate.id, version: candidate.version };

  // The exported criteria constant is what every decision applied.
  const decision = decidePromotionGate({ candidate: coordinate, report });
  assert.deepStrictEqual(decision.criteria, PROMOTION_GATE_CRITERIA);

  // No per-call criteria override exists on the public surface: smuggled
  // excess properties are ignored — the decision still applies the frozen
  // constant and keeps its identity.
  const gamedInput: GatedPromotionInput & { criteria?: unknown } = {
    candidate: coordinate,
    parity: flowParityEvidence(),
    evaluation,
    criteria: [{ id: "sneaky-criterion", description: "weakened everything" }],
  };
  const gamed = promoteGated(registry, gamedInput);
  assert.strictEqual(gamed.promoted, true, JSON.stringify(gamed.promoted ? null : gamed.reasons));
  if (gamed.promoted) {
    assert.deepStrictEqual(gamed.decision.criteria, PROMOTION_GATE_CRITERIA);
    assert.strictEqual(gamed.decision.id, decision.id);
  }
  const gamedDecisionInput: Parameters<typeof decidePromotionGate>[0] & { criteria?: unknown } = {
    candidate: coordinate,
    report,
    criteria: "weakened",
  };
  assert.deepStrictEqual(decidePromotionGate(gamedDecisionInput), decision);

  // Malformed evaluation input — a missing candidate coordinate — fails
  // closed with collected typed errors, never a partially-derived decision.
  assert.throws(
    () => decidePromotionGate({ candidate: { id: "", version: "" }, report }),
    (error: unknown) => {
      assert.ok(error instanceof PromotionGateError, "the typed fail-closed error");
      assert.strictEqual(error.code, "invalid-input");
      assert.ok(
        error.issues.includes("candidate.id must be a non-empty string"),
        "every collected issue is carried",
      );
      assert.ok(error.issues.includes("candidate.version must be a non-empty string"));
      return true;
    },
  );
  const malformedSetup = setupCandidate();
  const malformed = promoteGated(malformedSetup.registry, {
    candidate: { id: "", version: "" },
    parity: flowParityEvidence(),
    evaluation,
  });
  assert.strictEqual(malformed.promoted, false);
  if (!malformed.promoted) {
    assert.ok(
      malformed.reasons.some((reason) => /candidate\.id must be a non-empty string/.test(reason)),
      "the collected typed errors flow into the outcome reasons",
    );
    assert.ok(
      malformed.reasons.some((reason) =>
        /candidate\.version must be a non-empty string/.test(reason),
      ),
    );
    assert.strictEqual(malformed.decision, null, "never a partially-derived decision");
  }
  assert.strictEqual(malformedSetup.registry.list({ status: "promoted" }).length, 0);
  assert.strictEqual(malformedSetup.registry.list({ status: "candidate" }).length, 1);

  // Malformed build records fail closed the same way: the W2-009 composer's
  // collected typed issues are carried as reasons, not swallowed.
  const badRecordsSetup = setupCandidate();
  const badRecords = promoteGated(badRecordsSetup.registry, {
    candidate: { id: badRecordsSetup.candidate.id, version: badRecordsSetup.candidate.version },
    parity: flowParityEvidence(),
    evaluation: {
      from: null as unknown as LearningBuildRecord,
      to: baseTo(badRecordsSetup.candidate.id),
    },
  });
  assert.strictEqual(badRecords.promoted, false);
  if (!badRecords.promoted) {
    assert.ok(
      badRecords.reasons.some((reason) => /from build record must be an object/.test(reason)),
      `the composer's typed issues are carried: ${badRecords.reasons.join(" | ")}`,
    );
    assert.strictEqual(badRecords.decision, null);
  }
  assert.strictEqual(badRecordsSetup.registry.list({ status: "promoted" }).length, 0);
  assert.strictEqual(badRecordsSetup.registry.list({ status: "candidate" }).length, 1);

  // The report's honestly-unavailable rows (build time, failure recurrence)
  // never block the gate: the gate requires exactly what its criteria name.
  assert.strictEqual(rowFor(report, "build-time").status, "unavailable");
  assert.strictEqual(rowFor(report, "failure-recurrence").status, "unavailable");
  assert.ok(report.digest.unavailable >= 2);
  assert.strictEqual(decidePromotionGate({ candidate: coordinate, report }).outcome, "promoted");

  // The module is clock-free, randomness-free, and composes only in-package
  // modules plus the frozen @clapp/contracts types.
  for (const banned of BANNED_PRIMITIVES) {
    assert.ok(!MODULE_SOURCE.includes(banned), `the module source must not contain "${banned}"`);
  }
  const specifiers = [...MODULE_SOURCE.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
  assert.ok(specifiers.length >= 2, "the module's imports are inspectable");
  for (const specifier of specifiers) {
    assert.ok(
      specifier.startsWith("./") || specifier === "@clapp/contracts",
      `module import "${specifier}" must be in-package (relative) or the frozen @clapp/contracts`,
    );
  }
});
