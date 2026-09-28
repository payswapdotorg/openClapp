import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  canonicalJson as benchmarkCanonicalJson,
  sha256Hex as benchmarkSha256Hex,
  CANONICAL_BENCHMARKS,
  createBenchmarkHarness,
} from "../packages/clapp-benchmarks/src/index.ts";
import {
  createPackageRegistry,
  extractionSummary,
  extractPackageCandidates,
  type PackageCandidateDocument,
  type PackageStore,
  type PackageStoreKey,
  type PackageStoreRecord,
  promoteVerified,
  type ReconstructionArtifacts,
  registerCandidates,
  validatePackageDocument,
} from "../packages/clapp-intelligence/src/index.ts";

/**
 * CLAPP-W2-006 — package extraction and promotion.
 *
 * Proves the M6 steps 1-3 chain over the W2-005 registry: a successful
 * reconstruction's structural artifacts (a parity outcome summary, a plan
 * component inventory, an archetype hint, an IR digest) extract into
 * schema-valid package candidate documents, and ONLY parity-verified
 * extractions promote with real evidence. The fixtures mirror a B02-shaped
 * successful reconstruction; the final test composes the REAL benchmark
 * harness from @clapp/benchmarks (the integration seam) and runs the full
 * extract -> register -> promote chain end-to-end. Everything else is pure
 * in-process: no network beyond the harness's own loopback servers.
 */

/** Deterministic fixture digest of the "behavioral IR" the artifacts cite. */
const IR_DIGEST = createHash("sha256").update("clapp-w2-006 fixture behavioral IR").digest("hex");

/** A second, different IR digest (content difference -> different package id). */
const OTHER_IR_DIGEST = createHash("sha256")
  .update("clapp-w2-006 fixture behavioral IR (revised)")
  .digest("hex");

/** The fixed verification timestamp fixtures use (determinism; never invented). */
const VERIFIED_AT = "2025-07-01T10:00:00.000Z";

interface ArtifactOverrides {
  reconstructionId?: string;
  verdict?: "equivalent" | "divergent" | "blocked";
  verificationRunId?: string;
  minorFindings?: number;
  majorFindings?: number;
  components?: Array<{ path: string; kind: string; name: string }>;
  apiEntries?: Array<{ path: string }>;
  persistenceKeys?: string[];
  archetype?: { label: string };
  irDigest?: string;
}

/** B02-shaped reconstruction artifacts (a successful reconstruction). */
function makeArtifacts(overrides: ArtifactOverrides = {}): ReconstructionArtifacts {
  return {
    reconstructionId: overrides.reconstructionId ?? "rc-w2-006-0001",
    parity: {
      verdict: overrides.verdict ?? "equivalent",
      verificationRunId: overrides.verificationRunId ?? "clapp_run_fixture_0001",
      minorFindings: overrides.minorFindings ?? 0,
      majorFindings: overrides.majorFindings ?? 0,
    },
    planInventory: {
      components: overrides.components ?? [
        { path: "/", kind: "page", name: "Dashboard" },
        { path: "/tasks", kind: "page", name: "Task queue" },
        { path: "/settings", kind: "form", name: "Board settings" },
      ],
      apiEntries: overrides.apiEntries ?? [{ path: "/api/" }],
      persistenceKeys: overrides.persistenceKeys ?? ["boardName", "openTasks", "status", "tasks"],
    },
    archetype: "archetype" in overrides ? overrides.archetype : { label: "CRUD SaaS" },
    irDigest: overrides.irDigest ?? IR_DIGEST,
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

/** Extracts the single candidate of a successful extraction (or fails). */
function soleCandidate(
  result: ReturnType<typeof extractPackageCandidates>,
): PackageCandidateDocument {
  assert.strictEqual(
    result.skipped.length,
    0,
    `expected no skips, got: ${JSON.stringify(result.skipped)}`,
  );
  assert.strictEqual(result.candidates.length, 1, "expected exactly one candidate");
  return result.candidates[0];
}

test("successful reconstruction extracts schema-valid candidates", () => {
  const result = extractPackageCandidates(makeArtifacts());
  const candidate = soleCandidate(result);

  // The W2-005 validator is the gate: the candidate passes it exactly.
  const validated = validatePackageDocument(candidate);
  if (!validated.ok) {
    assert.fail(
      `expected candidate to validate, got: ${validated.errors.map((e) => e.message).join("; ")}`,
    );
  }

  // The frozen v0.1 envelope: root keys are exactly schemaVersion + package.
  assert.deepStrictEqual(Object.keys(candidate).sort(), ["package", "schemaVersion"]);
  assert.strictEqual(candidate.schemaVersion, "0.1");

  // Deterministic ids/versions derived from the artifacts.
  assert.match(candidate.package.id, /^clapp_package_[0-9a-f]{16}$/);
  assert.strictEqual(candidate.package.version, "0.1.0");
  assert.strictEqual(candidate.package.category, "CRUD SaaS");

  // The inventory-derived capability vocabulary, sorted.
  assert.deepStrictEqual(candidate.package.capabilities, [
    "component:form",
    "component:page",
    "http-api",
    "persistent-state",
  ]);

  // Identical artifacts extract identically; different artifacts do not.
  const again = extractPackageCandidates(makeArtifacts());
  assert.deepStrictEqual(again, result);
  const different = extractPackageCandidates(makeArtifacts({ irDigest: OTHER_IR_DIGEST }));
  assert.notStrictEqual(soleCandidate(different).package.id, candidate.package.id);
});

test("unverified parity abstains", () => {
  // Divergent parity: zero candidates, one recorded reason.
  const divergent = extractPackageCandidates(
    makeArtifacts({ verdict: "divergent", minorFindings: 2, majorFindings: 1 }),
  );
  assert.strictEqual(divergent.candidates.length, 0);
  assert.strictEqual(divergent.skipped.length, 1);
  assert.match(divergent.skipped[0].reason, /divergent/);

  // Blocked parity: the same fail-closed abstention.
  const blocked = extractPackageCandidates(
    makeArtifacts({ verdict: "blocked", minorFindings: 0, majorFindings: 1 }),
  );
  assert.strictEqual(blocked.candidates.length, 0);
  assert.strictEqual(blocked.skipped.length, 1);
  assert.match(blocked.skipped[0].reason, /blocked/);

  // An equivalence claim citing no verification run is equally unverified.
  const unverifiable = extractPackageCandidates(makeArtifacts({ verificationRunId: "" }));
  assert.strictEqual(unverifiable.candidates.length, 0);
  assert.match(unverifiable.skipped[0].reason, /verification run id/);

  // Contradictory parity (equivalent verdict with >= minor findings) abstains.
  const contradictory = extractPackageCandidates(makeArtifacts({ minorFindings: 1 }));
  assert.strictEqual(contradictory.candidates.length, 0);
  assert.match(contradictory.skipped[0].reason, /contradictory/);

  // Promotion refuses unverified parity and never touches the registry.
  const store = new InMemoryPackageStore();
  const registry = createPackageRegistry(store);
  const registered = registerCandidates(
    registry,
    extractPackageCandidates(makeArtifacts()).candidates,
  );
  assert.strictEqual(registered.results[0].ok, true);
  const identity = registered.results[0];
  if (!identity.ok) {
    assert.fail("unreachable");
  }
  for (const verdict of ["divergent", "blocked"] as const) {
    const refused = promoteVerified(
      registry,
      { id: identity.id, version: identity.version },
      { verdict, verificationRunId: "clapp_run_fixture_0002", verifiedAt: VERIFIED_AT },
    );
    assert.strictEqual(refused.promoted, false);
    if (!refused.promoted) {
      assert.match(refused.reason, /equivalent/);
    }
  }
  assert.strictEqual(registry.list({ status: "promoted" }).length, 0);
  assert.strictEqual(registry.list({ status: "candidate" }).length, 1);
  assert.strictEqual(store.rows.size, 1);
});

test("promotion is evidence-gated", () => {
  const registry = createPackageRegistry(new InMemoryPackageStore());
  const candidate = soleCandidate(extractPackageCandidates(makeArtifacts())).package;
  const registration = registerCandidates(registry, [
    soleCandidate(extractPackageCandidates(makeArtifacts())),
  ]);
  assert.strictEqual(registration.results[0].ok, true);

  const evidence = {
    verdict: "equivalent" as const,
    verificationRunId: "clapp_run_fixture_0001",
    verifiedAt: VERIFIED_AT,
    minorFindings: 0,
    majorFindings: 0,
    reconstructionId: "rc-w2-006-0001",
    irDigest: IR_DIGEST,
  };

  // Equivalent parity + a real run id promotes through the registry.
  const promotion = promoteVerified(
    registry,
    { id: candidate.id, version: candidate.version },
    evidence,
  );
  assert.strictEqual(promotion.promoted, true);
  if (promotion.promoted) {
    assert.strictEqual(promotion.idempotent, false);
    assert.strictEqual(
      (promotion.document.provenance.promotion as Record<string, unknown>).verificationRunId,
      "clapp_run_fixture_0001",
    );
    assert.deepStrictEqual(promotion.evidence, {
      verifiedAt: VERIFIED_AT,
      verificationRunId: "clapp_run_fixture_0001",
      provenanceNotes: [
        "parity verdict: equivalent (0 major, 0 minor findings)",
        "verification run: clapp_run_fixture_0001",
        "reconstruction: rc-w2-006-0001",
        `ir digest: ${IR_DIGEST}`,
      ],
    });
  }

  // Re-promotion with identical evidence is the registry's own no-op.
  const repeat = promoteVerified(
    registry,
    { id: candidate.id, version: candidate.version },
    evidence,
  );
  assert.strictEqual(repeat.promoted, true);
  if (repeat.promoted && promotion.promoted) {
    assert.strictEqual(repeat.idempotent, true);
    assert.deepStrictEqual(repeat.document, promotion.document);
  }

  // Without a run id it fails closed with a reason and never promotes.
  const freshRegistry = createPackageRegistry(new InMemoryPackageStore());
  const freshCandidate = soleCandidate(
    extractPackageCandidates(makeArtifacts({ reconstructionId: "rc-w2-006-0002" })),
  ).package;
  registerCandidates(freshRegistry, [
    soleCandidate(extractPackageCandidates(makeArtifacts({ reconstructionId: "rc-w2-006-0002" }))),
  ]);
  const noRunId = promoteVerified(
    freshRegistry,
    { id: freshCandidate.id, version: freshCandidate.version },
    { verdict: "equivalent", verificationRunId: "", verifiedAt: VERIFIED_AT },
  );
  assert.strictEqual(noRunId.promoted, false);
  if (!noRunId.promoted) {
    assert.match(noRunId.reason, /verification run id/);
  }

  // Without a verifiedAt timestamp it fails closed too (promotion never invents one).
  const noTimestamp = promoteVerified(
    freshRegistry,
    { id: freshCandidate.id, version: freshCandidate.version },
    { verdict: "equivalent", verificationRunId: "clapp_run_fixture_0001" },
  );
  assert.strictEqual(noTimestamp.promoted, false);
  if (!noTimestamp.promoted) {
    assert.match(noTimestamp.reason, /verifiedAt/);
  }

  // The registry was never touched by the refused promotions.
  assert.strictEqual(freshRegistry.list({ status: "candidate" }).length, 1);
  assert.strictEqual(freshRegistry.list({ status: "promoted" }).length, 0);
});

test("registration is idempotent", () => {
  const store = new InMemoryPackageStore();
  const registry = createPackageRegistry(store);
  const candidate = soleCandidate(extractPackageCandidates(makeArtifacts()));

  // First registration: a fresh candidate row.
  const first = registerCandidates(registry, [candidate]);
  assert.deepStrictEqual(first.results[0], {
    ok: true,
    id: candidate.package.id,
    version: "0.1.0",
    idempotent: false,
  });
  assert.strictEqual(store.rows.size, 1);

  // Registering the same candidates twice: no-op success, one row per identity.
  const second = registerCandidates(registry, JSON.parse(JSON.stringify([candidate])));
  assert.deepStrictEqual(second.results[0], {
    ok: true,
    id: candidate.package.id,
    version: "0.1.0",
    idempotent: true,
  });
  assert.strictEqual(store.rows.size, 1);
  assert.strictEqual(registry.list().length, 1);

  // Same id/version with different content: the typed conflict, reported per
  // package and never thrown; the original stays untouched.
  const mutated = JSON.parse(JSON.stringify(candidate)) as PackageCandidateDocument;
  mutated.package.purpose = "A mutated purpose.";
  const conflicted = registerCandidates(registry, [mutated]);
  assert.strictEqual(conflicted.results[0].ok, false);
  if (!conflicted.results[0].ok) {
    assert.strictEqual(conflicted.results[0].id, candidate.package.id);
    assert.match(conflicted.results[0].reason, /already registered with different content/);
  }
  const stored = registry.get(candidate.package.id, "0.1.0");
  assert.ok(stored, "the original candidate is still registered");
  assert.strictEqual(stored.purpose, candidate.package.purpose);
  assert.strictEqual(store.rows.size, 1);
});

test("extraction is deterministic and cited", () => {
  const first = extractPackageCandidates(makeArtifacts());
  const second = extractPackageCandidates(makeArtifacts());

  // Two extractions of the same artifacts produce byte-identical documents.
  assert.strictEqual(JSON.stringify(second), JSON.stringify(first));

  // Inventory array order is not content: reordered inputs extract identically.
  const reordered = extractPackageCandidates(
    makeArtifacts({
      components: [
        { path: "/settings", kind: "form", name: "Board settings" },
        { path: "/", kind: "page", name: "Dashboard" },
        { path: "/tasks", kind: "page", name: "Task queue" },
      ],
      persistenceKeys: ["tasks", "status", "boardName", "openTasks"],
    }),
  );
  assert.strictEqual(JSON.stringify(reordered), JSON.stringify(first));

  // The provenance cites the reconstruction and the verification run.
  const provenance = first.candidates[0].package.provenance as Record<string, unknown>;
  assert.strictEqual(provenance.reconstructionId, "rc-w2-006-0001");
  assert.strictEqual(provenance.verificationRunId, "clapp_run_fixture_0001");
  assert.strictEqual(provenance.parityVerdict, "equivalent");
  assert.strictEqual(provenance.irDigest, IR_DIGEST);
  assert.ok(
    typeof provenance.artifactDigest === "string" &&
      (provenance.artifactDigest as string).length === 64,
    "the artifact digest is a sha256 hex string",
  );
});

test("archetype feeds category honestly", () => {
  // A W2-004 vocabulary label derives the package category verbatim.
  const labeled = extractPackageCandidates(
    makeArtifacts({ archetype: { label: "marketing/content site" } }),
  );
  assert.strictEqual(soleCandidate(labeled).package.category, "marketing/content site");

  // The classifier's honest "unknown" flows through as-is.
  const unknown = extractPackageCandidates(makeArtifacts({ archetype: { label: "unknown" } }));
  assert.strictEqual(soleCandidate(unknown).package.category, "unknown");

  // Absent archetype: the conservative generic category, never an invented label.
  const absent = extractPackageCandidates(makeArtifacts({ archetype: undefined }));
  const absentPackage = soleCandidate(absent).package;
  assert.strictEqual(absentPackage.category, "application");
  assert.strictEqual(
    (absentPackage.provenance as Record<string, unknown>).archetypeLabel,
    undefined,
    "no archetype label is cited when none fed the category",
  );

  // An out-of-vocabulary label is not trusted: the conservative generic again.
  const invented = extractPackageCandidates(
    makeArtifacts({ archetype: { label: "spaceship cockpit" } }),
  );
  assert.strictEqual(soleCandidate(invented).package.category, "application");
});

test("empty inventories abstain", () => {
  const result = extractPackageCandidates(
    makeArtifacts({ components: [], apiEntries: [], persistenceKeys: [] }),
  );
  assert.strictEqual(result.candidates.length, 0, "never an empty shell package");
  assert.strictEqual(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /nothing to package/);

  // The accounting digest reports the abstention.
  assert.deepStrictEqual(extractionSummary(result), {
    extracted: 0,
    promoted: 0,
    abstained: 1,
    reasons: [result.skipped[0].reason],
  });
});

test("end-to-end seam over the real harness", async () => {
  const app = CANONICAL_BENCHMARKS.find((benchmark) => benchmark.id === "clapp_benchmark_b02");
  assert.ok(app, "the B02 stateful benchmark is in the canonical inventory");

  // M6 step 1 — build independently: two fresh harness instances of the same
  // benchmark definition (the reference and an independently started rebuild).
  const reference = createBenchmarkHarness(app);
  const rebuilt = createBenchmarkHarness(app);
  const referenceSide = await reference.start();
  const candidateSide = await rebuilt.start();
  try {
    // The paired seam shape: the same journeys run against both sides.
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

    // The stateful app's /api/ store agrees across the sides (and both
    // harness stores are the untouched seed).
    const [referenceApi, candidateApi] = await Promise.all([
      fetch(new URL("/api/", referenceSide.baseUrl)),
      fetch(new URL("/api/", candidateSide.baseUrl)),
    ]);
    const referenceApiBody = await referenceApi.text();
    const candidateApiBody = await candidateApi.text();
    if (referenceApi.status !== candidateApi.status || referenceApiBody !== candidateApiBody) {
      divergences += 1;
    }
    assert.deepStrictEqual(reference.snapshotState(), rebuilt.snapshotState());

    const verdict = divergences === 0 ? "equivalent" : "divergent";
    assert.strictEqual(verdict, "equivalent");

    // A content-addressed verification run id: no ports, no timestamps.
    const verificationRunId = `clapp_run_${benchmarkSha256Hex(
      benchmarkCanonicalJson({
        benchmarkId: app.id,
        reference: referenceCaptures,
        candidate: candidateCaptures,
        api: { reference: referenceApiBody, candidate: candidateApiBody },
      }),
    ).slice(0, 16)}`;

    // The structural reconstruction artifacts of the successful run.
    const reconstructionId = "rc-clapp-benchmark-b02-0001";
    const artifacts: ReconstructionArtifacts = {
      reconstructionId,
      parity: { verdict, verificationRunId, minorFindings: 0, majorFindings: 0 },
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
      irDigest: benchmarkSha256Hex(benchmarkCanonicalJson(referenceCaptures)),
    };

    // M6 step 2 — extract package candidate(s) from the artifacts.
    const extraction = extractPackageCandidates(artifacts);
    const candidate = soleCandidate(extraction).package;
    assert.ok(validatePackageDocument(extraction.candidates[0]).ok);
    assert.strictEqual(candidate.category, "CRUD SaaS");
    assert.deepStrictEqual(candidate.capabilities, [
      "component:page",
      "http-api",
      "persistent-state",
    ]);

    // M6 step 3 — register, then promote the verified package.
    const registry = createPackageRegistry(new InMemoryPackageStore());
    const registration = registerCandidates(registry, extraction.candidates);
    assert.deepStrictEqual(registration.results[0], {
      ok: true,
      id: candidate.id,
      version: candidate.version,
      idempotent: false,
    });

    const promotion = promoteVerified(
      registry,
      { id: candidate.id, version: candidate.version },
      {
        verdict,
        verificationRunId,
        verifiedAt: VERIFIED_AT,
        minorFindings: 0,
        majorFindings: 0,
        reconstructionId,
        irDigest: artifacts.irDigest,
      },
    );
    assert.strictEqual(promotion.promoted, true);

    const promoted = registry.get(candidate.id, candidate.version);
    assert.ok(promoted, "the promoted package is retrievable through the registry");
    const promotionRecord = promoted.provenance.promotion as Record<string, unknown>;
    assert.strictEqual(promotionRecord.verificationRunId, verificationRunId);
    assert.strictEqual(promotionRecord.verifiedAt, VERIFIED_AT);
    assert.strictEqual(registry.list({ status: "promoted" }).length, 1);

    // The M6 accounting digest over the full steps 1-3 chain.
    assert.deepStrictEqual(extractionSummary(extraction, [promotion]), {
      extracted: 1,
      promoted: 1,
      abstained: 0,
      reasons: [],
    });
  } finally {
    await referenceSide.stop();
    await candidateSide.stop();
  }
});
