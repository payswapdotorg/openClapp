import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import {
  type CatalogWriteResult,
  CLAPP_CATALOG_KINDS,
  type GatedPromotionOutcome,
  getExportEvidence,
  getLearningReport,
  getPromotedPackage,
  listExportEvidence,
  listLearningReports,
  listPromotedPackages,
  writeCompoundingExperiment,
  writeExportEvidence,
  writeGatedPromotion,
  writeLearningComparison,
  writePromotedPackage,
} from "../apps/server/src/clapp/catalog-writers.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import {
  buildLearningComparison,
  CompoundingError,
  type CompoundingExperimentInput,
  createPackageRegistry,
  extractPackageCandidates,
  type GatedPromotionInput,
  type LearningBuildRecord,
  LearningRecordError,
  type PackageRegistry,
  type PackageStore,
  type PackageStoreKey,
  type PackageStoreRecord,
  type ParityEvidence,
  type ParitySummary,
  promoteGated,
  type ReconstructionArtifacts,
  registerCandidates,
  runCompoundingExperiment,
} from "../packages/clapp-intelligence/src/index.ts";

/**
 * CLAPP-W2-013 — catalog store writers.
 *
 * Contract: small honest adapters over the REAL substrate `Store` (an
 * in-process PGlite through the real `createStore`) for the three
 * owner-scoped catalog kinds — `clapp-packages`, `clapp-learning`,
 * `clapp-export-evidence` — composing the REAL package functions: the REAL
 * W2-010 `promoteGated` (through `writeGatedPromotion`, over the real W2-005
 * registry materialized from the real W2-006 extraction), the REAL W2-009
 * `buildLearningComparison` (through `writeLearningComparison`), and the REAL
 * W2-011 `runCompoundingExperiment` (through `writeCompoundingExperiment`).
 * Writers persist ONLY what the real functions produced: a withheld
 * promotion writes nothing to either catalog kind; a rejected learning record
 * or experiment input fails closed with nothing written (empty stores stay
 * empty); every row id is the artifact's own content-addressed id or the
 * package coordinate, and every row body is a verbatim carry. Owner scoping
 * is the substrate's own boundary. Deterministic only: a pinned FIXED_MS
 * clock, fixed literals, no network, no wall clock, no randomness.
 */

/** The pinned experiment clock (2025-01-01T00:00:00.000Z; never a wall-clock read). */
const FIXED_MS = 1735689600000;

/** The fixed verification timestamp the parity-evidence fixture carries. */
const VERIFIED_AT = "2025-07-01T10:00:00.000Z";

/** The module under contract, for the purity and import-discipline scans. */
const MODULE_URL = new URL("../apps/server/src/clapp/catalog-writers.ts", import.meta.url);
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

/** The only import specifiers the module is allowed to carry. */
const ALLOWED_IMPORTS = new Set([
  "../../../../packages/clapp-contracts/src/index.ts",
  "../../../../packages/clapp-intelligence/src/index.ts",
  "../db.ts",
]);

const RECONSTRUCTION_ID = "rc-w2-013-0001";
const RUN_A1 = "clapp_run_fixture_w2_013_a1";
const RUN_A2 = "clapp_run_fixture_w2_013_a2";
const IR_DIGEST = createHash("sha256").update("clapp-w2-013 fixture behavioral IR").digest("hex");

let db: Store;

// ---------------------------------------------------------------------------
// Fixtures (the established W2-009/W2-010/W2-011 fixture idioms)
// ---------------------------------------------------------------------------

/** An equivalent parity summary citing a verification run. */
function equivalentParity(verificationRunId: string): ParitySummary {
  return { verdict: "equivalent", verificationRunId, minorFindings: 0, majorFindings: 0 };
}

/** The fixture reconstruction artifacts of a successful scratch build (W2-006). */
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

/** A real candidate over a real registry: the W2-010 integration-seam fixture. */
function setupCandidate(): {
  registry: PackageRegistry;
  candidate: { id: string; version: string };
} {
  const extraction = extractPackageCandidates(makeArtifacts());
  assert.strictEqual(extraction.candidates.length, 1, "the fixture artifacts extract a candidate");
  const candidate = extraction.candidates[0].package;
  const registry = createPackageRegistry(new InMemoryPackageStore());
  const registration = registerCandidates(registry, extraction.candidates);
  assert.strictEqual(registration.results[0]?.ok, true, "the candidate registers");
  return { registry, candidate };
}

/** A gated-promotion input that passes both gates for the given candidate. */
function promotingInput(candidate: { id: string; version: string }): GatedPromotionInput {
  return {
    candidate,
    parity: flowParityEvidence(),
    evaluation: { from: scratchBuild(), to: reuseBuild([candidate.id]) },
  };
}

/**
 * A fresh learning-enabled experiment input (a fresh store per call: the
 * experiment mutates the supplied package store, so every run needs its
 * own to stay byte-identical to an independent direct run).
 */
function compoundingInput(benchmarkId: string): CompoundingExperimentInput {
  const candidateId = extractPackageCandidates(makeArtifacts()).candidates[0].package.id;
  return {
    benchmarkId,
    scratchBuild: scratchBuild(),
    reuseBuild: reuseBuild([candidateId]),
    artifacts: makeArtifacts(),
    compositionPlan: {
      status: "composed",
      packageIds: [candidateId],
      selections: [{ role: "archetype-anchor", packageId: candidateId }],
    },
    store: new InMemoryPackageStore(),
    now: () => FIXED_MS,
  };
}

before(async () => {
  db = await createStore();
});

after(async () => {
  await db.close();
});

// ---------------------------------------------------------------------------
// The named tests
// ---------------------------------------------------------------------------

test("writeLearningComparison persists exactly the real W2-009 report under the clapp-learning kind", async () => {
  const owner = "w2-013-owner-comparison";
  const from = scratchBuild();
  const to = reuseBuild(["clapp_package_fixture_reused"]);

  const written = await writeLearningComparison(db, owner, from, to);

  // The report the writer returned IS the real composer's report.
  assert.deepStrictEqual(written, buildLearningComparison(from, to));
  assert.match(written.id, /^clapp_learning_[0-9a-f]{16}$/);

  // The stored row carries it verbatim, keyed by its own content-addressed id.
  const row = await getLearningReport(db, owner, written.id);
  assert.ok(row, "the comparison report row exists");
  assert.strictEqual(row.reportKind, "comparison");
  assert.deepStrictEqual(row.report, written);
  const rows = await listLearningReports(db, owner);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0]?.id, written.id);

  // The raw substrate kind is exactly the documented string.
  const raw = await db.list(owner, "clapp-learning");
  assert.strictEqual(raw.length, 1);
});

test("writeLearningComparison persists nothing when the real composer rejects the records", async () => {
  const owner = "w2-013-owner-comparison-reject";
  const malformed = makeRecord({ newCodeUnits: -1 });

  await assert.rejects(
    () => writeLearningComparison(db, owner, scratchBuild(), malformed),
    (error: unknown) => error instanceof LearningRecordError,
    "the composer's typed error propagates",
  );

  // Empty stores stay empty: nothing was persisted for this owner.
  assert.deepStrictEqual(await listLearningReports(db, owner), []);
});

test("writeCompoundingExperiment persists exactly the real W2-011 report under the clapp-learning kind", async () => {
  const owner = "w2-013-owner-compounding";
  const input = compoundingInput("benchmark-w2-013-repeated-build");

  const written = await writeCompoundingExperiment(db, owner, input);

  assert.strictEqual(written.verdict, "compounding");
  assert.strictEqual(written.learningEnabled, true);
  assert.match(written.id, /^clapp_compound_[0-9a-f]{16}$/);
  assert.deepStrictEqual(
    written.comparison,
    buildLearningComparison(input.scratchBuild, input.reuseBuild),
  );

  const row = await getLearningReport(db, owner, written.id);
  assert.ok(row, "the experiment report row exists");
  assert.strictEqual(row.reportKind, "compounding");
  if (row.reportKind === "compounding") {
    assert.deepStrictEqual(row.report, written);
  }
  // The verbatim report an independent direct run produces over a fresh
  // store: byte-identical, the determinism proof.
  assert.deepStrictEqual(
    written,
    runCompoundingExperiment(compoundingInput("benchmark-w2-013-repeated-build")),
  );
});

test("writeCompoundingExperiment persists nothing on invalid input (the store stays empty)", async () => {
  const owner = "w2-013-owner-compounding-reject";
  const candidateId = extractPackageCandidates(makeArtifacts()).candidates[0].package.id;

  await assert.rejects(
    () =>
      writeCompoundingExperiment(db, owner, {
        benchmarkId: "benchmark-w2-013-invalid",
        scratchBuild: makeRecord({ phase: "reuse" }),
        reuseBuild: reuseBuild([candidateId]),
        artifacts: makeArtifacts(),
        store: new InMemoryPackageStore(),
        now: () => FIXED_MS,
      }),
    (error: unknown) => error instanceof CompoundingError,
    "the experiment's typed error propagates",
  );

  assert.deepStrictEqual(await listLearningReports(db, owner), []);
});

test("the learning-disabled control experiment persists with the honest control verdict", async () => {
  const owner = "w2-013-owner-control";
  const candidateId = extractPackageCandidates(makeArtifacts()).candidates[0].package.id;
  const written = await writeCompoundingExperiment(db, owner, {
    benchmarkId: "benchmark-w2-013-control",
    scratchBuild: scratchBuild(),
    reuseBuild: reuseBuild([candidateId]),
    artifacts: makeArtifacts(),
    store: new InMemoryPackageStore(),
    now: () => FIXED_MS,
  });

  assert.strictEqual(written.verdict, "control");
  assert.strictEqual(written.learningEnabled, false);
  assert.deepStrictEqual(written.selectedPackageIds, []);

  const row = await getLearningReport(db, owner, written.id);
  assert.ok(row, "the control report row exists");
  if (row.reportKind === "compounding") {
    assert.strictEqual(row.report.verdict, "control");
  }
});

test("writeGatedPromotion composes the real W2-010 gate and persists the promoted package and evidence", async () => {
  const owner = "w2-013-owner-promoting";
  const { registry, candidate } = setupCandidate();

  const result = await writeGatedPromotion(db, owner, registry, promotingInput(candidate));

  // The outcome is the real flow's outcome, verbatim.
  assert.strictEqual(result.outcome.promoted, true);
  assert.strictEqual(result.packageRow.written, true);
  assert.strictEqual(result.evidenceRow.written, true);

  // The package row: the registry's own promoted document, verbatim.
  const rowId = result.packageRow.written ? result.packageRow.id : "";
  assert.strictEqual(rowId, `${candidate.id}@${candidate.version}`);
  const packageRow = await getPromotedPackage(db, owner, rowId);
  assert.ok(packageRow, "the promoted package row exists");
  if (result.outcome.promoted) {
    assert.deepStrictEqual(packageRow.document, result.outcome.document);
    assert.deepStrictEqual(packageRow.document, registry.get(candidate.id, candidate.version));
    assert.deepStrictEqual(packageRow.evidence, result.outcome.evidence);
    assert.match(packageRow.decisionId, /^clapp_eval_[0-9a-f]{16}$/);
    assert.match(packageRow.reportId, /^clapp_learning_[0-9a-f]{16}$/);
    assert.strictEqual(packageRow.idempotent, false);
  }

  // The evidence row: the promotion evidence with the gate citations.
  const evidenceRow = await getExportEvidence(db, owner, packageRow.decisionId);
  assert.ok(evidenceRow, "the export-evidence row exists");
  if (result.outcome.promoted) {
    assert.strictEqual(evidenceRow.id, result.outcome.decision.id);
    assert.strictEqual(evidenceRow.packageId, candidate.id);
    assert.strictEqual(evidenceRow.version, candidate.version);
    assert.strictEqual(evidenceRow.reportId, result.outcome.decision.reportId);
    assert.deepStrictEqual(evidenceRow.evidence, result.outcome.evidence);
    assert.strictEqual(evidenceRow.idempotent, false);
  }
});

test("writeGatedPromotion withholds: neither catalog kind is written and every reason is carried", async () => {
  const owner = "w2-013-owner-withheld";
  const { registry, candidate } = setupCandidate();

  // An unevaluated candidate: the gate withholds, never silently promotes.
  const result = await writeGatedPromotion(db, owner, registry, {
    candidate,
    parity: flowParityEvidence(),
  });

  assert.strictEqual(result.outcome.promoted, false);
  const packageRow = result.packageRow as Extract<CatalogWriteResult, { written: false }>;
  const evidenceRow = result.evidenceRow as Extract<CatalogWriteResult, { written: false }>;
  assert.strictEqual(packageRow.written, false);
  assert.strictEqual(evidenceRow.written, false);
  if (!result.outcome.promoted) {
    assert.deepStrictEqual(packageRow.reasons, result.outcome.reasons);
    assert.deepStrictEqual(evidenceRow.reasons, result.outcome.reasons);
    assert.ok(result.outcome.reasons.length > 0, "the withheld outcome carries its reasons");
  }

  // Empty stores stay empty; the registry was left untouched by the gate.
  assert.deepStrictEqual(await listPromotedPackages(db, owner), []);
  assert.deepStrictEqual(await listExportEvidence(db, owner), []);
  assert.strictEqual(registry.list({ status: "promoted" }).length, 0);
  assert.strictEqual(registry.list({ status: "candidate" }).length, 1);
});

test("the granular writers persist exactly the outcome they are given, withheld outcomes write nothing", async () => {
  const owner = "w2-013-owner-granular";
  const { registry, candidate } = setupCandidate();

  // Promoting: the granular writers persist from the real outcome.
  const outcome = promoteGated(registry, promotingInput(candidate));
  assert.strictEqual(outcome.promoted, true, "the fixture outcome promotes");

  const packageWrite = await writePromotedPackage(db, owner, outcome);
  const evidenceWrite = await writeExportEvidence(db, owner, outcome);
  assert.strictEqual(packageWrite.written, true);
  assert.strictEqual(evidenceWrite.written, true);
  assert.strictEqual(
    (await listPromotedPackages(db, owner)).length,
    1,
    "exactly one package row was written",
  );
  assert.strictEqual(
    (await listExportEvidence(db, owner)).length,
    1,
    "exactly one evidence row was written",
  );

  // Withheld: nothing is written, the verbatim reasons are carried.
  const withheldRegistry = setupCandidate().registry;
  const withheld = promoteGated(withheldRegistry, { candidate, parity: flowParityEvidence() });
  const withheldPackageWrite = await writePromotedPackage(db, owner, withheld);
  const withheldEvidenceWrite = await writeExportEvidence(db, owner, withheld);
  assert.strictEqual(withheldPackageWrite.written, false);
  assert.strictEqual(withheldEvidenceWrite.written, false);
  if (!withheldPackageWrite.written && !withheld.promoted) {
    assert.deepStrictEqual(withheldPackageWrite.reasons, withheld.reasons);
  }
  if (!withheldEvidenceWrite.written && !withheld.promoted) {
    assert.deepStrictEqual(withheldEvidenceWrite.reasons, withheld.reasons);
  }
  assert.strictEqual((await listPromotedPackages(db, owner)).length, 1, "still exactly one row");
  assert.strictEqual((await listExportEvidence(db, owner)).length, 1, "still exactly one row");
});

test("owner scoping: a second owner sees none of the first owner's catalog rows", async () => {
  const ownerA = "w2-013-owner-scope-a";
  const ownerB = "w2-013-owner-scope-b";
  const { registry, candidate } = setupCandidate();

  const promotion = await writeGatedPromotion(db, ownerA, registry, promotingInput(candidate));
  const comparison = await writeLearningComparison(db, ownerA, scratchBuild(), reuseBuild([]));
  await writeCompoundingExperiment(db, ownerA, {
    benchmarkId: "benchmark-w2-013-scope",
    scratchBuild: scratchBuild(),
    reuseBuild: reuseBuild([candidate.id]),
    artifacts: makeArtifacts(),
    store: new InMemoryPackageStore(),
    now: () => FIXED_MS,
  });

  // Owner B's view: all three kinds empty, every get null.
  assert.deepStrictEqual(await listPromotedPackages(db, ownerB), []);
  assert.deepStrictEqual(await listLearningReports(db, ownerB), []);
  assert.deepStrictEqual(await listExportEvidence(db, ownerB), []);
  const comparisonId = comparison.id;
  assert.strictEqual(await getLearningReport(db, ownerB, comparisonId), null);
  if (promotion.packageRow.written && promotion.evidenceRow.written) {
    assert.strictEqual(await getPromotedPackage(db, ownerB, promotion.packageRow.id), null);
    assert.strictEqual(await getExportEvidence(db, ownerB, promotion.evidenceRow.id), null);
  }

  // Owner A's view: intact.
  assert.strictEqual((await listPromotedPackages(db, ownerA)).length, 1);
  assert.strictEqual((await listLearningReports(db, ownerA)).length, 2);
  assert.strictEqual((await listExportEvidence(db, ownerA)).length, 1);
});

test("re-writing the same promotion is idempotent: no duplicate rows, identical content", async () => {
  const owner = "w2-013-owner-idempotent";
  const { registry, candidate } = setupCandidate();
  const input = promotingInput(candidate);

  const first = await writeGatedPromotion(db, owner, registry, input);
  const second = await writeGatedPromotion(db, owner, registry, input);

  assert.strictEqual(first.outcome.promoted, true);
  assert.strictEqual(second.outcome.promoted, true);
  if (first.outcome.promoted && second.outcome.promoted) {
    // The registry's own idempotent no-op is reported honestly.
    assert.strictEqual(first.outcome.idempotent, false);
    assert.strictEqual(second.outcome.idempotent, true);
    // The content-addressed decision and evidence are byte-stable.
    assert.strictEqual(second.outcome.decision.id, first.outcome.decision.id);
    assert.deepStrictEqual(second.outcome.evidence, first.outcome.evidence);
  }

  // Exactly one row per kind, content unchanged.
  const packageRows = await listPromotedPackages(db, owner);
  const evidenceRows = await listExportEvidence(db, owner);
  assert.strictEqual(packageRows.length, 1);
  assert.strictEqual(evidenceRows.length, 1);
  if (first.outcome.promoted) {
    assert.deepStrictEqual(packageRows[0]?.document, first.outcome.document);
    assert.deepStrictEqual(evidenceRows[0]?.evidence, first.outcome.evidence);
  }
});

test("catalog readers return honest nulls and empty lists for absent rows", async () => {
  const owner = "w2-013-owner-absent";

  assert.strictEqual(await getPromotedPackage(db, owner, "clapp_package_absent@0.1.0"), null);
  assert.strictEqual(await getLearningReport(db, owner, "clapp_learning_absent0000"), null);
  assert.strictEqual(await getExportEvidence(db, owner, "clapp_eval_absent000000"), null);
  assert.deepStrictEqual(await listPromotedPackages(db, owner), []);
  assert.deepStrictEqual(await listLearningReports(db, owner), []);
  assert.deepStrictEqual(await listExportEvidence(db, owner), []);
});

test("a corrupted promoting outcome is refused fail-closed before any store write", async () => {
  const owner = "w2-013-owner-corrupt";

  // A non-outcome object writes nothing, honestly: it carries neither a
  // promoted result nor recorded reasons, and the fallback states that.
  const notAnOutcome = await writePromotedPackage(db, owner, {} as GatedPromotionOutcome);
  assert.strictEqual(notAnOutcome.written, false);
  if (!notAnOutcome.written) {
    assert.deepStrictEqual(notAnOutcome.reasons, [
      "the gated promotion outcome carries neither a promoted result nor recorded reasons",
    ]);
  }
  const notAnObject = await writePromotedPackage(
    db,
    owner,
    null as unknown as GatedPromotionOutcome,
  );
  assert.strictEqual(notAnObject.written, false);
  if (!notAnObject.written) {
    assert.deepStrictEqual(notAnObject.reasons, [
      "the gated promotion outcome is missing or malformed",
    ]);
  }

  // A promoting outcome missing its decision is refused with a TypeError.
  await assert.rejects(
    () => writePromotedPackage(db, owner, { promoted: true } as GatedPromotionOutcome),
    TypeError,
    "a corrupted outcome must never half-write a row",
  );
  await assert.rejects(
    () => writeExportEvidence(db, owner, { promoted: true } as GatedPromotionOutcome),
    TypeError,
    "a corrupted outcome must never half-write a row",
  );

  // Nothing was written to either kind.
  assert.deepStrictEqual(await listPromotedPackages(db, owner), []);
  assert.deepStrictEqual(await listExportEvidence(db, owner), []);
});

test("an invalid owner is refused fail-closed before any composition or store write", async () => {
  const { registry, candidate } = setupCandidate();

  await assert.rejects(
    () => writeLearningComparison(db, "", scratchBuild(), reuseBuild([])),
    TypeError,
    "an empty owner is refused",
  );
  await assert.rejects(
    () =>
      writeCompoundingExperiment(db, "   ", {
        benchmarkId: "benchmark-w2-013-owner",
        scratchBuild: scratchBuild(),
        reuseBuild: reuseBuild([candidate.id]),
        artifacts: makeArtifacts(),
      }),
    TypeError,
    "a blank owner is refused",
  );
  await assert.rejects(
    () => writeGatedPromotion(db, "", registry, promotingInput(candidate)),
    TypeError,
    "an empty owner is refused",
  );

  // No row landed under any blank-owner identity.
  assert.deepStrictEqual(await listLearningReports(db, ""), []);
  assert.deepStrictEqual(await listPromotedPackages(db, ""), []);
  assert.deepStrictEqual(await listExportEvidence(db, ""), []);
});

test("the writers write exactly the three documented catalog kinds", async () => {
  const owner = "w2-013-owner-kinds";
  const { registry, candidate } = setupCandidate();

  await writeGatedPromotion(db, owner, registry, promotingInput(candidate));
  const comparison = await writeLearningComparison(db, owner, scratchBuild(), reuseBuild([]));
  await writeCompoundingExperiment(db, owner, {
    benchmarkId: "benchmark-w2-013-kinds",
    scratchBuild: scratchBuild(),
    reuseBuild: reuseBuild([candidate.id]),
    artifacts: makeArtifacts(),
    store: new InMemoryPackageStore(),
    now: () => FIXED_MS,
  });

  // The kinds constant is exactly the documented triple.
  assert.deepStrictEqual(CLAPP_CATALOG_KINDS, [
    "clapp-packages",
    "clapp-learning",
    "clapp-export-evidence",
  ]);

  // Each substrate kind holds exactly what the writers wrote: 1 package row,
  // 2 learning rows (one comparison, one compounding), 1 evidence row.
  assert.strictEqual((await db.list(owner, "clapp-packages")).length, 1);
  const learning = await db.list<{ reportKind: string; id: string }>(owner, "clapp-learning");
  assert.strictEqual(learning.length, 2);
  assert.deepStrictEqual(learning.map((row) => row.reportKind).sort(), [
    "comparison",
    "compounding",
  ]);
  assert.ok(
    learning.some((row) => row.id === comparison.id),
    "one row is the comparison report",
  );
  assert.ok(
    learning.some((row) => /^clapp_compound_[0-9a-f]{16}$/.test(row.id)),
    "one row is the compounding report",
  );
  assert.strictEqual((await db.list(owner, "clapp-export-evidence")).length, 1);

  // And the learning rows are the reports the real functions produced.
  const rows = await listLearningReports(db, owner);
  const kinds = rows.map((row) => row.reportKind).sort();
  assert.deepStrictEqual(kinds, ["comparison", "compounding"]);
});

test("the module is pure: no wall-clock, no randomness, and only the allowed imports", async () => {
  for (const banned of BANNED_PRIMITIVES) {
    assert.ok(!MODULE_SOURCE.includes(banned), `the module must not contain "${banned}"`);
  }

  const specifiers = [...MODULE_SOURCE.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
  assert.ok(specifiers.length > 0, "the module does import its composed surfaces");
  for (const specifier of specifiers) {
    assert.ok(
      ALLOWED_IMPORTS.has(specifier),
      `unexpected import specifier "${specifier}": only the substrate store and the intelligence package are allowed`,
    );
  }
});
