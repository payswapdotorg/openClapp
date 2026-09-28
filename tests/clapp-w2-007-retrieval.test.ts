import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { ClappPackage } from "../packages/clapp-contracts/src/index.ts";
import {
  buildCompatGraph,
  type CompatGraph,
  type CompatNodeIdentity,
  comparePackageVersions,
  createPackageRegistry,
  explainCompatibility,
  extractPackageCandidates,
  PackageImmutabilityError,
  type PackageRegistry,
  type PackageStore,
  type PackageStoreKey,
  type PackageStoreRecord,
  promoteVerified,
  RETRIEVAL_WEIGHTS,
  type ReconstructionArtifacts,
  RetrievalError,
  type RetrievalErrorCode,
  type RetrievalQuery,
  type RetrievalResult,
  registerCandidates,
  retrievalSummary,
  retrievePackages,
} from "../packages/clapp-intelligence/src/index.ts";

/**
 * CLAPP-W2-007 — package retrieval and the compatibility graph.
 *
 * Proves the M6 step-5 "reuse packages" feed over the W2-005 registry and
 * the W2-006 extraction output: the compatibility graph is a pure
 * deterministic function of registry contents whose edges carry derivation
 * reasons; retrieval over a populated registry is deterministic, explained
 * and fail-closed; absent capabilities/targets are recorded as honest
 * unknowns, never as matches; lineage is graph-visible across candidates
 * and promoted packages together. The integration test registers real
 * documents (extraction output shape) through createPackageRegistry and
 * retrieves over them end-to-end. Everything is pure in-process: no network.
 */

/** Deterministic fixture digest of the "behavioral IR" the artifacts cite. */
const IR_DIGEST = createHash("sha256").update("clapp-w2-007 fixture behavioral IR").digest("hex");

/** A second, different IR digest (content difference -> different package id). */
const OTHER_IR_DIGEST = createHash("sha256")
  .update("clapp-w2-007 fixture behavioral IR (revised)")
  .digest("hex");

/** The fixed verification timestamp fixtures use (determinism; never invented). */
const VERIFIED_AT = "2025-07-01T10:00:00.000Z";

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

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

interface PackageDocOverrides {
  id?: string;
  version?: string;
  category?: string;
  purpose?: string;
  capabilities?: string[];
  supportedTargets?: string[];
  provenance?: Record<string, unknown>;
}

/** A flat, registry-normalized ClappPackage fixture document. */
function makePackageDoc(overrides: PackageDocOverrides = {}): ClappPackage {
  return {
    schemaVersion: "0.1",
    id: overrides.id ?? "clapp_pkg_fixture",
    version: overrides.version ?? "0.1.0",
    category: overrides.category ?? "CRUD SaaS",
    purpose: overrides.purpose ?? "W2-007 retrieval fixture",
    interface: {},
    capabilities: overrides.capabilities ?? [],
    constraints: [],
    dependencies: [],
    supportedTargets: overrides.supportedTargets ?? [],
    tests: [],
    benchmark: {},
    failureModes: [],
    provenance: overrides.provenance ?? {},
  };
}

/** Registers a fixture through the registry in the W2-006 envelope shape. */
function registerFixture(registry: PackageRegistry, overrides: PackageDocOverrides): void {
  const doc = makePackageDoc(overrides);
  const { schemaVersion, ...packageBody } = doc;
  const result = registry.register({ schemaVersion, package: packageBody });
  if (!result.ok) {
    assert.fail(
      `fixture registration failed: ${result.errors.map((error) => error.message).join("; ")}`,
    );
  }
}

/** The derivation reasons of every edge between two identities, sorted. */
function reasonsBetween(
  graph: CompatGraph,
  left: CompatNodeIdentity,
  right: CompatNodeIdentity,
): string[] {
  return graph.edges
    .filter(
      (edge) =>
        (edge.from.id === left.id &&
          edge.from.version === left.version &&
          edge.to.id === right.id &&
          edge.to.version === right.version) ||
        (edge.from.id === right.id &&
          edge.from.version === right.version &&
          edge.to.id === left.id &&
          edge.to.version === left.version),
    )
    .map((edge) => edge.reason)
    .sort();
}

/** Asserts that a call fails closed with a typed RetrievalError. */
function expectRetrievalError(
  call: () => unknown,
  code: RetrievalErrorCode,
  issueIncludes?: string,
): void {
  let thrown = false;
  try {
    call();
  } catch (error) {
    thrown = true;
    assert.ok(error instanceof RetrievalError, `expected a RetrievalError, got: ${String(error)}`);
    assert.strictEqual(
      error.code,
      code,
      `expected code "${code}", got "${error.code}" (${error.message})`,
    );
    assert.ok(error.message.length > 0, "the error explains itself");
    if (issueIncludes !== undefined) {
      assert.ok(
        error.issues.some((issue) => issue.includes(issueIncludes)),
        `expected an issue containing "${issueIncludes}", got: ${error.issues.join("; ")}`,
      );
    }
  }
  assert.ok(thrown, "expected the call to fail closed");
}

/** Casts an unknown value to the retrievePackages input shape (TS bypass). */
function asRetrieveInput(value: unknown): { registry: PackageRegistry; query: RetrievalQuery } {
  return value as { registry: PackageRegistry; query: RetrievalQuery };
}

/** B02-shaped reconstruction artifacts (a successful reconstruction). */
function makeArtifacts(
  overrides: { reconstructionId?: string; verificationRunId?: string; irDigest?: string } = {},
): ReconstructionArtifacts {
  return {
    reconstructionId: overrides.reconstructionId ?? "rc-w2-007-0001",
    parity: {
      verdict: "equivalent",
      verificationRunId: overrides.verificationRunId ?? "clapp_run_fixture_0001",
      minorFindings: 0,
      majorFindings: 0,
    },
    planInventory: {
      components: [
        { path: "/", kind: "page", name: "Dashboard" },
        { path: "/tasks", kind: "page", name: "Task queue" },
        { path: "/settings", kind: "form", name: "Board settings" },
      ],
      apiEntries: [{ path: "/api/" }],
      persistenceKeys: ["boardName", "openTasks", "status", "tasks"],
    },
    archetype: { label: "CRUD SaaS" },
    irDigest: overrides.irDigest ?? IR_DIGEST,
  };
}

// ---------------------------------------------------------------------------
// Required test 1 — "graph is a pure deterministic function of contents"
// ---------------------------------------------------------------------------

test("graph is a pure deterministic function of contents", () => {
  const packages = [
    makePackageDoc({
      id: "clapp_pkg_alpha",
      version: "0.1.0",
      capabilities: ["http-api", "persistent-state"],
      supportedTargets: ["web"],
    }),
    makePackageDoc({
      id: "clapp_pkg_alpha",
      version: "0.2.0",
      category: "application",
    }),
    makePackageDoc({
      id: "clapp_pkg_beta",
      version: "0.1.0",
      capabilities: ["http-api"],
      supportedTargets: ["web", "android"],
    }),
    makePackageDoc({
      id: "clapp_pkg_gamma",
      version: "0.1.0",
      category: "marketing/content site",
      capabilities: ["seo"],
      supportedTargets: ["linux"],
    }),
  ];
  const snapshot = JSON.parse(JSON.stringify(packages));

  // The same contents always produce a byte-identical graph...
  const first = buildCompatGraph(packages);
  const second = buildCompatGraph([packages[2], packages[0], packages[3], packages[1]]);
  assert.strictEqual(JSON.stringify(second), JSON.stringify(first));

  // ...even through fresh deep copies (no hidden mutable state).
  const third = buildCompatGraph(JSON.parse(JSON.stringify(packages)));
  assert.strictEqual(JSON.stringify(third), JSON.stringify(first));

  // The input documents are never mutated.
  assert.deepStrictEqual(packages, snapshot);

  // Non-trivial contents: nodes and edges both present, nodes (id, version)-ordered.
  assert.strictEqual(first.nodes.length, 4);
  assert.ok(first.edges.length > 0, "the fixtures derive real relations");
  assert.deepStrictEqual(
    first.nodes.map((node) => `${node.id}@${node.version}`),
    [
      "clapp_pkg_alpha@0.1.0",
      "clapp_pkg_alpha@0.2.0",
      "clapp_pkg_beta@0.1.0",
      "clapp_pkg_gamma@0.1.0",
    ],
  );

  // Empty contents derive an empty graph.
  assert.deepStrictEqual(buildCompatGraph([]), { nodes: [], edges: [] });

  // Contents the graph cannot derive from fail closed, typed, never guessed:
  // a non-conforming version...
  expectRetrievalError(
    () => buildCompatGraph([makePackageDoc({ version: "1.0" })]),
    "invalid-packages",
    "version",
  );
  // ...a malformed capabilities field...
  expectRetrievalError(
    () => buildCompatGraph([makePackageDoc({ capabilities: "http-api" as unknown as string[] })]),
    "invalid-packages",
    "capabilities",
  );
  // ...and a duplicate identity (the registry never holds one).
  expectRetrievalError(
    () => buildCompatGraph([packages[0], JSON.parse(JSON.stringify(packages[0]))]),
    "invalid-packages",
    "duplicate package identity",
  );
});

// ---------------------------------------------------------------------------
// Required test 2 — "edges carry derivation reasons"
// ---------------------------------------------------------------------------

test("edges carry derivation reasons", () => {
  const alpha = makePackageDoc({
    id: "clapp_pkg_alpha",
    version: "0.1.0",
    capabilities: ["http-api", "persistent-state"],
    supportedTargets: ["web"],
  });
  const beta = makePackageDoc({
    id: "clapp_pkg_beta",
    version: "0.1.0",
    capabilities: ["http-api"],
    supportedTargets: ["web", "android"],
  });
  const gamma = makePackageDoc({
    id: "clapp_pkg_gamma",
    version: "0.1.0",
    category: "marketing/content site",
    capabilities: ["seo"],
    supportedTargets: ["linux"],
  });
  const alphaNext = makePackageDoc({
    id: "clapp_pkg_alpha",
    version: "0.2.0",
    category: "application",
  });
  const graph = buildCompatGraph([alphaNext, gamma, beta, alpha]);

  // Category + capability + target derivations, each its own reasoned edge.
  assert.deepStrictEqual(
    reasonsBetween(
      graph,
      { id: "clapp_pkg_alpha", version: "0.1.0" },
      { id: "clapp_pkg_beta", version: "0.1.0" },
    ),
    ["capability-overlap:http-api", "category-shared", "target-overlap:web"],
  );

  // Lineage derivation: same id, different version, and nothing else in common.
  assert.deepStrictEqual(
    reasonsBetween(
      graph,
      { id: "clapp_pkg_alpha", version: "0.1.0" },
      { id: "clapp_pkg_alpha", version: "0.2.0" },
    ),
    ["lineage-neighbor"],
  );

  // Un-derivable pairs have NO edge: alpha/gamma and beta/gamma share nothing,
  // and beta/alphaNext share neither category, capability nor target.
  assert.deepStrictEqual(
    reasonsBetween(
      graph,
      { id: "clapp_pkg_alpha", version: "0.1.0" },
      { id: "clapp_pkg_gamma", version: "0.1.0" },
    ),
    [],
  );
  assert.deepStrictEqual(
    reasonsBetween(
      graph,
      { id: "clapp_pkg_beta", version: "0.1.0" },
      { id: "clapp_pkg_gamma", version: "0.1.0" },
    ),
    [],
  );
  assert.deepStrictEqual(
    reasonsBetween(
      graph,
      { id: "clapp_pkg_beta", version: "0.1.0" },
      { id: "clapp_pkg_alpha", version: "0.2.0" },
    ),
    [],
  );

  // Every edge's reason is exactly its kind, optionally parameterized.
  for (const edge of graph.edges) {
    assert.ok(
      edge.reason === edge.kind || edge.reason.startsWith(`${edge.kind}:`),
      `reason "${edge.reason}" does not derive from kind "${edge.kind}"`,
    );
  }

  // Canonical direction: from is the identity-smaller endpoint.
  for (const edge of graph.edges) {
    if (edge.from.id === edge.to.id) {
      assert.ok(comparePackageVersions(edge.from.version, edge.to.version) < 0);
    } else {
      assert.ok(edge.from.id < edge.to.id);
    }
  }
});

// ---------------------------------------------------------------------------
// Required test 3 — "retrieval filters fail closed"
// ---------------------------------------------------------------------------

test("retrieval filters fail closed", () => {
  const registry = createPackageRegistry(new InMemoryPackageStore());
  registerFixture(registry, { id: "clapp_pkg_one", capabilities: ["http-api"] });
  registerFixture(registry, { id: "clapp_pkg_two", capabilities: ["seo"] });

  // An unknown category matches nothing: empty result, never an error.
  const unknownCategory = retrievePackages({
    registry,
    query: { category: "no-such-category" },
  });
  assert.deepStrictEqual(unknownCategory, { results: [], matched: 0 });
  assert.deepStrictEqual(retrievalSummary(unknownCategory), {
    matched: 0,
    ranked: 0,
    reasonsUsed: [],
  });

  // A criteria-free query is valid and matches everything, deterministically.
  const all = retrievePackages({ registry, query: {} });
  assert.strictEqual(all.matched, 2);
  assert.deepStrictEqual(
    all.results.map((entry) => entry.package.id),
    ["clapp_pkg_one", "clapp_pkg_two"],
  );

  // Unknown query fields are NEVER silently ignored: typed error, named issue.
  expectRetrievalError(
    () =>
      retrievePackages({
        registry,
        query: { categori: "CRUD SaaS" } as unknown as RetrievalQuery,
      }),
    "invalid-query",
    'unknown query field "categori"',
  );

  // Every structural violation is collected in one typed error, not one-by-one.
  let collected: RetrievalError | undefined;
  try {
    retrievePackages({
      registry,
      query: {
        category: 123,
        status: "shipped",
        maxResults: 0,
        extra: true,
      } as unknown as RetrievalQuery,
    });
  } catch (error) {
    collected = error instanceof RetrievalError ? error : undefined;
  }
  assert.ok(collected, "the multi-issue query failed closed");
  assert.strictEqual(collected?.code, "invalid-query");
  assert.strictEqual(collected?.issues.length, 4, "all four violations are reported");
  assert.deepStrictEqual([...(collected?.issues ?? [])].sort(), [
    "query.category must be a non-empty string when present",
    "query.maxResults must be an integer >= 1 when present",
    'query.status must be "candidate" or "promoted" when present',
    'unknown query field "extra" (allowed: capability, category, maxResults, status, target)',
  ]);

  // Wrong types, empty criteria and fractional limits are all invalid.
  expectRetrievalError(
    () => retrievePackages({ registry, query: null as unknown as RetrievalQuery }),
    "invalid-query",
  );
  expectRetrievalError(
    () => retrievePackages({ registry, query: { capability: "" } }),
    "invalid-query",
    "query.capability",
  );
  expectRetrievalError(
    () => retrievePackages({ registry, query: { target: 7 as unknown as string } }),
    "invalid-query",
    "query.target",
  );
  expectRetrievalError(
    () => retrievePackages({ registry, query: { maxResults: 1.5 } }),
    "invalid-query",
    "query.maxResults",
  );

  // A malformed input envelope or registry port fails closed too.
  expectRetrievalError(() => retrievePackages(asRetrieveInput(null)), "invalid-input");
  expectRetrievalError(() => retrievePackages(asRetrieveInput({ query: {} })), "invalid-registry");
  expectRetrievalError(
    () => retrievePackages(asRetrieveInput({ registry: { list: "not callable" }, query: {} })),
    "invalid-registry",
  );
  expectRetrievalError(() => retrievePackages(asRetrieveInput({ registry })), "invalid-query");
});

// ---------------------------------------------------------------------------
// Required test 4 — "ranking is deterministic and explained"
// ---------------------------------------------------------------------------

test("ranking is deterministic and explained", () => {
  function populate(registry: PackageRegistry): void {
    registerFixture(registry, {
      id: "clapp_pkg_zulu",
      capabilities: ["http-api"],
      supportedTargets: ["web"],
    });
    registerFixture(registry, {
      id: "clapp_pkg_aaa",
      version: "0.1.0",
      capabilities: ["http-api"],
      supportedTargets: ["web"],
    });
    registerFixture(registry, {
      id: "clapp_pkg_aaa",
      version: "0.2.0",
      capabilities: ["http-api"],
      supportedTargets: ["web"],
    });
    registerFixture(registry, {
      id: "clapp_pkg_mid",
      capabilities: ["http-api"],
      supportedTargets: [],
    });
    registerFixture(registry, {
      id: "clapp_pkg_mismatch",
      capabilities: ["seo"],
      supportedTargets: ["linux"],
    });
  }
  const registry = createPackageRegistry(new InMemoryPackageStore());
  populate(registry);
  const query: RetrievalQuery = {
    category: "CRUD SaaS",
    capability: "http-api",
    target: "web",
  };

  // Same registry + same query -> identical order, scores and reasons.
  const first = retrievePackages({ registry, query });
  const second = retrievePackages({ registry, query });
  assert.deepStrictEqual(second, first);

  // A differently-inserted registry (same contents) ranks identically:
  // order comes from identity fields, never from insertion accident.
  const reorderedRegistry = createPackageRegistry(new InMemoryPackageStore());
  registerFixture(reorderedRegistry, {
    id: "clapp_pkg_mismatch",
    capabilities: ["seo"],
    supportedTargets: ["linux"],
  });
  registerFixture(reorderedRegistry, {
    id: "clapp_pkg_zulu",
    capabilities: ["http-api"],
    supportedTargets: ["web"],
  });
  registerFixture(reorderedRegistry, { id: "clapp_pkg_mid", capabilities: ["http-api"] });
  registerFixture(reorderedRegistry, {
    id: "clapp_pkg_aaa",
    version: "0.1.0",
    capabilities: ["http-api"],
    supportedTargets: ["web"],
  });
  registerFixture(reorderedRegistry, {
    id: "clapp_pkg_aaa",
    version: "0.2.0",
    capabilities: ["http-api"],
    supportedTargets: ["web"],
  });
  assert.deepStrictEqual(retrievePackages({ registry: reorderedRegistry, query }), first);

  // The declared mismatch is filtered out; everything else is explained.
  assert.strictEqual(first.matched, 4);
  assert.deepStrictEqual(
    first.results.map((entry) => `${entry.package.id}@${entry.package.version}`),
    ["clapp_pkg_aaa@0.1.0", "clapp_pkg_aaa@0.2.0", "clapp_pkg_zulu@0.1.0", "clapp_pkg_mid@0.1.0"],
  );

  // Scores: full matches 1 + 4 + 4; the target-unknown package loses the
  // target weight and ranks below every match.
  assert.deepStrictEqual(
    first.results.map((entry) => entry.score),
    [9, 9, 9, 5],
  );
  assert.strictEqual(
    9,
    RETRIEVAL_WEIGHTS.categoryShared +
      RETRIEVAL_WEIGHTS.capabilityOverlap +
      RETRIEVAL_WEIGHTS.targetOverlap,
  );

  // Every result carries its exact match reasons.
  assert.deepStrictEqual(first.results[0]?.reasons, [
    "capability-overlap:http-api",
    "category-shared",
    "target-overlap:web",
  ]);
  assert.deepStrictEqual(first.results[3]?.reasons, [
    "capability-overlap:http-api",
    "category-shared",
    "target-unknown:web",
  ]);

  // Ties break by id first, then version — never by insertion accident.
  assert.ok(first.results[0] && first.results[1] && first.results[2]);
  assert.strictEqual(first.results[0].package.id, "clapp_pkg_aaa");
  assert.strictEqual(first.results[1].package.id, "clapp_pkg_aaa");
  assert.ok(
    comparePackageVersions(first.results[0].package.version, first.results[1].package.version) < 0,
  );
  assert.ok(first.results[1].package.id < first.results[2].package.id);
});

// ---------------------------------------------------------------------------
// Required test 5 — "unknown capabilities are honest"
// ---------------------------------------------------------------------------

test("unknown capabilities are honest", () => {
  const registry = createPackageRegistry(new InMemoryPackageStore());
  registerFixture(registry, {
    id: "clapp_pkg_match",
    capabilities: ["http-api", "persistent-state"],
    supportedTargets: ["web"],
  });
  registerFixture(registry, {
    id: "clapp_pkg_unknown_caps",
    capabilities: [],
    supportedTargets: ["web"],
  });
  registerFixture(registry, {
    id: "clapp_pkg_unknown_targets",
    capabilities: ["http-api"],
    supportedTargets: [],
  });
  registerFixture(registry, {
    id: "clapp_pkg_declared_mismatch",
    capabilities: ["seo"],
    supportedTargets: ["linux"],
  });

  // Capability-only query: the two capability matches tie (broken by id);
  // the capability-unknown package ranks below BOTH with weight 0; the
  // declared mismatch is absent.
  const capabilityOnly = retrievePackages({ registry, query: { capability: "http-api" } });
  assert.deepStrictEqual(
    capabilityOnly.results.map((entry) => `${entry.package.id}:${entry.score}`),
    ["clapp_pkg_match:4", "clapp_pkg_unknown_targets:4", "clapp_pkg_unknown_caps:0"],
  );
  assert.deepStrictEqual(capabilityOnly.results[0]?.reasons, ["capability-overlap:http-api"]);
  assert.strictEqual(capabilityOnly.results[0]?.score, RETRIEVAL_WEIGHTS.capabilityOverlap);
  assert.deepStrictEqual(capabilityOnly.results[2]?.reasons, ["capability-unknown:http-api"]);
  assert.strictEqual(capabilityOnly.results[2]?.score, 0);
  assert.ok(
    !capabilityOnly.results[2]?.reasons.includes("capability-overlap:http-api"),
    "an unknown capability is never recorded as a match",
  );
  assert.strictEqual(capabilityOnly.matched, 3);
  for (const entry of capabilityOnly.results) {
    assert.notStrictEqual(entry.package.id, "clapp_pkg_declared_mismatch");
  }

  // Combined query: target unknowns behave identically, and the unknown
  // packages tie (score 4 each) broken by identity order.
  const combined = retrievePackages({
    registry,
    query: { capability: "http-api", target: "web" },
  });
  assert.deepStrictEqual(
    combined.results.map((entry) => `${entry.package.id}:${entry.score}`),
    ["clapp_pkg_match:8", "clapp_pkg_unknown_caps:4", "clapp_pkg_unknown_targets:4"],
  );
  assert.deepStrictEqual(combined.results[1]?.reasons, [
    "capability-unknown:http-api",
    "target-overlap:web",
  ]);
  assert.deepStrictEqual(combined.results[2]?.reasons, [
    "capability-overlap:http-api",
    "target-unknown:web",
  ]);

  // The declared mismatch never appears in any honest result.
  for (const entry of combined.results) {
    assert.notStrictEqual(entry.package.id, "clapp_pkg_declared_mismatch");
  }
  assert.strictEqual(combined.matched, 3);
});

// ---------------------------------------------------------------------------
// Required test 6 — "lineage neighbors are graph-visible"
// ---------------------------------------------------------------------------

test("lineage neighbors are graph-visible", () => {
  const registry = createPackageRegistry(new InMemoryPackageStore());
  const id = "clapp_pkg_lineage";
  registerFixture(registry, {
    id,
    version: "0.1.0",
    category: "CRUD SaaS",
    capabilities: ["http-api"],
    supportedTargets: ["web"],
  });
  registerFixture(registry, {
    id,
    version: "0.2.0",
    category: "marketing/content site",
    capabilities: ["seo"],
    supportedTargets: ["linux"],
  });
  registerFixture(registry, {
    id,
    version: "0.3.0",
    category: "application",
    capabilities: ["export"],
    supportedTargets: ["macos"],
  });

  // Only the middle version is promoted; candidates and promoted coexist.
  registry.promote(id, "0.2.0", {
    verifiedAt: VERIFIED_AT,
    verificationRunId: "clapp_run_fixture_0001",
  });
  assert.strictEqual(registry.list({ status: "promoted" }).length, 1);
  assert.strictEqual(registry.list({ status: "candidate" }).length, 2);

  // History and list both see every version, candidates + promoted together.
  assert.deepStrictEqual(
    registry.history(id).map((doc) => doc.version),
    ["0.1.0", "0.2.0", "0.3.0"],
  );
  const graph = buildCompatGraph(registry.list());
  assert.strictEqual(graph.nodes.length, 3);

  // Every same-id version pair is a lineage neighbor (all pairs, in order).
  assert.deepStrictEqual(
    graph.edges.map((edge) => `${edge.from.version}->${edge.to.version}:${edge.reason}`),
    [
      "0.1.0->0.2.0:lineage-neighbor",
      "0.1.0->0.3.0:lineage-neighbor",
      "0.2.0->0.3.0:lineage-neighbor",
    ],
  );

  // Promotion status is content-derived: only the middle node is promoted.
  assert.deepStrictEqual(
    graph.nodes.map((node) => `${node.version}:${node.promoted}`),
    ["0.1.0:false", "0.2.0:true", "0.3.0:false"],
  );

  // The explanation shows the lineage neighbors in version order and the
  // single promoted neighbor as the best (only) promoted match.
  const tip = explainCompatibility(graph, id, "0.3.0");
  assert.deepStrictEqual(tip.node, { id, version: "0.3.0" });
  assert.deepStrictEqual(tip.lineageNeighbors, [
    { id, version: "0.1.0" },
    { id, version: "0.2.0" },
  ]);
  assert.deepStrictEqual(tip.bestMatchingPromoted, [
    { id, version: "0.2.0", score: 1, reasons: ["lineage-neighbor"] },
  ]);
  // The promoted middle version has no OTHER promoted neighbor (self excluded).
  const middle = explainCompatibility(graph, id, "0.2.0");
  assert.deepStrictEqual(middle.bestMatchingPromoted, []);

  // Promote immutability is respected: identical evidence re-promotes as a
  // no-op, different evidence and register-overwrites fail closed, and the
  // refused mutations leave the graph byte-identical.
  const before = JSON.stringify(graph);
  const idempotent = registry.promote(id, "0.2.0", {
    verifiedAt: VERIFIED_AT,
    verificationRunId: "clapp_run_fixture_0001",
  });
  assert.strictEqual(idempotent.version, "0.2.0");
  assert.throws(
    () =>
      registry.promote(id, "0.2.0", {
        verifiedAt: VERIFIED_AT,
        verificationRunId: "clapp_run_fixture_9999",
      }),
    (error: unknown) => error instanceof PackageImmutabilityError,
  );
  assert.throws(
    () =>
      registry.register({
        schemaVersion: "0.1",
        package: {
          id,
          version: "0.2.0",
          category: "CRUD SaaS",
          purpose: "an overwrite attempt",
          interface: {},
          tests: [],
          provenance: {},
        },
      }),
    (error: unknown) => error instanceof PackageImmutabilityError,
  );
  assert.strictEqual(JSON.stringify(buildCompatGraph(registry.list())), before);
});

// ---------------------------------------------------------------------------
// Required test 7 — "integration with the real registry"
// ---------------------------------------------------------------------------

test("integration with the real registry", () => {
  // M6 step 2 — real W2-006 extraction output from reconstruction artifacts.
  const first = extractPackageCandidates(makeArtifacts());
  const second = extractPackageCandidates(
    makeArtifacts({
      reconstructionId: "rc-w2-007-0002",
      verificationRunId: "clapp_run_fixture_0002",
      irDigest: OTHER_IR_DIGEST,
    }),
  );
  assert.strictEqual(first.candidates.length, 1);
  assert.strictEqual(second.candidates.length, 1);
  const firstBody = first.candidates[0].package;
  const secondBody = second.candidates[0].package;
  assert.notStrictEqual(firstBody.id, secondBody.id);

  // M6 step 3 — register through the real registry, promote the verified ones.
  const registry = createPackageRegistry(new InMemoryPackageStore());
  const registration = registerCandidates(registry, [...first.candidates, ...second.candidates]);
  assert.strictEqual(registration.results[0]?.ok, true);
  assert.strictEqual(registration.results[1]?.ok, true);
  for (const [extraction, artifacts] of [
    [first, makeArtifacts()],
    [
      second,
      makeArtifacts({
        reconstructionId: "rc-w2-007-0002",
        verificationRunId: "clapp_run_fixture_0002",
        irDigest: OTHER_IR_DIGEST,
      }),
    ],
  ] as const) {
    const promotion = promoteVerified(
      registry,
      {
        id: extraction.candidates[0].package.id,
        version: extraction.candidates[0].package.version,
      },
      {
        verdict: "equivalent",
        verificationRunId: artifacts.parity.verificationRunId,
        verifiedAt: VERIFIED_AT,
        minorFindings: 0,
        majorFindings: 0,
        reconstructionId: artifacts.reconstructionId,
        irDigest: artifacts.irDigest,
      },
    );
    assert.strictEqual(promotion.promoted, true);
  }

  // A lineage successor registered directly in the W2-006 envelope shape.
  const successor = registry.register({
    schemaVersion: "0.1",
    package: {
      id: firstBody.id,
      version: "0.2.0",
      category: "CRUD SaaS",
      purpose: "W2-007 lineage successor fixture",
      interface: {},
      tests: [],
      provenance: {},
      capabilities: ["http-api"],
      supportedTargets: ["web"],
    },
  });
  assert.strictEqual(successor.ok, true);

  // Retrieval over the populated registry, end-to-end. The successor matches
  // everything (9); the extraction packages match category + capability but
  // their supportedTargets is empty -> honest target unknowns (5).
  const query: RetrievalQuery = {
    category: "CRUD SaaS",
    capability: "http-api",
    target: "web",
  };
  const result = retrievePackages({ registry, query });
  const repeated = retrievePackages({ registry, query });
  assert.deepStrictEqual(repeated, result);
  assert.strictEqual(result.matched, 3);
  assert.strictEqual(result.results[0]?.package.version, "0.2.0");
  assert.strictEqual(result.results[0]?.score, 9);
  assert.deepStrictEqual(result.results[0]?.reasons, [
    "capability-overlap:http-api",
    "category-shared",
    "target-overlap:web",
  ]);
  const extractionOrder = [firstBody.id, secondBody.id].sort();
  assert.strictEqual(result.results[1]?.package.id, extractionOrder[0]);
  assert.strictEqual(result.results[2]?.package.id, extractionOrder[1]);
  for (const entry of result.results.slice(1)) {
    assert.strictEqual(entry.score, 5);
    assert.deepStrictEqual(entry.reasons, [
      "capability-overlap:http-api",
      "category-shared",
      "target-unknown:web",
    ]);
  }

  // The status filter delegates to the registry: only promoted packages.
  const promotedOnly = retrievePackages({
    registry,
    query: { status: "promoted", capability: "http-api" },
  });
  assert.strictEqual(promotedOnly.matched, 2);
  assert.deepStrictEqual(
    promotedOnly.results.map((entry) => entry.package.id),
    extractionOrder,
  );
  assert.deepStrictEqual(promotedOnly.results[0]?.reasons, ["capability-overlap:http-api"]);

  // The graph over the same registry contents derives every relation with
  // reasons: the two extraction packages share category + 4 capabilities...
  const graph = buildCompatGraph(registry.list());
  assert.strictEqual(graph.nodes.length, 3);
  assert.deepStrictEqual(
    reasonsBetween(
      graph,
      { id: firstBody.id, version: "0.1.0" },
      { id: secondBody.id, version: "0.1.0" },
    ),
    [
      "capability-overlap:component:form",
      "capability-overlap:component:page",
      "capability-overlap:http-api",
      "capability-overlap:persistent-state",
      "category-shared",
    ],
  );
  // ...the successor adds lineage + category + http-api to its ancestor...
  assert.deepStrictEqual(
    reasonsBetween(
      graph,
      { id: firstBody.id, version: "0.1.0" },
      { id: firstBody.id, version: "0.2.0" },
    ),
    ["capability-overlap:http-api", "category-shared", "lineage-neighbor"],
  );
  // ...and shares category + http-api with the other extraction package.
  assert.deepStrictEqual(
    reasonsBetween(
      graph,
      { id: secondBody.id, version: "0.1.0" },
      { id: firstBody.id, version: "0.2.0" },
    ),
    ["capability-overlap:http-api", "category-shared"],
  );

  // The explanation of the successor: lineage neighbor + best promoted
  // matches ranked by shared derivation reasons.
  const explanation = explainCompatibility(graph, firstBody.id, "0.2.0");
  assert.deepStrictEqual(explanation.node, { id: firstBody.id, version: "0.2.0" });
  assert.deepStrictEqual(explanation.lineageNeighbors, [{ id: firstBody.id, version: "0.1.0" }]);
  assert.strictEqual(explanation.edges.length, 5);
  assert.deepStrictEqual(explanation.bestMatchingPromoted, [
    {
      id: firstBody.id,
      version: "0.1.0",
      score: 3,
      reasons: ["capability-overlap:http-api", "category-shared", "lineage-neighbor"],
    },
    {
      id: secondBody.id,
      version: "0.1.0",
      score: 2,
      reasons: ["capability-overlap:http-api", "category-shared"],
    },
  ]);

  // Unknown identities fail closed with the typed node-not-found error.
  expectRetrievalError(
    () => explainCompatibility(graph, "clapp_pkg_missing", "0.1.0"),
    "node-not-found",
  );

  // The accounting digest over the end-to-end feed.
  assert.deepStrictEqual(retrievalSummary(result), {
    matched: 3,
    ranked: 3,
    reasonsUsed: [
      "capability-overlap:http-api",
      "category-shared",
      "target-overlap:web",
      "target-unknown:web",
    ],
  });
});

// ---------------------------------------------------------------------------
// Required test 8 — "summary accounting is exact"
// ---------------------------------------------------------------------------

test("summary accounting is exact", () => {
  const registry = createPackageRegistry(new InMemoryPackageStore());
  for (const id of ["clapp_pkg_w", "clapp_pkg_x", "clapp_pkg_y", "clapp_pkg_z"]) {
    registerFixture(registry, { id, capabilities: ["http-api"] });
  }
  registerFixture(registry, {
    id: "clapp_pkg_other_category",
    category: "application",
    capabilities: ["http-api"],
  });
  registerFixture(registry, { id: "clapp_pkg_other_capability", capabilities: ["seo"] });

  // Four matches, truncated to two by maxResults AFTER deterministic ranking.
  const result = retrievePackages({
    registry,
    query: { category: "CRUD SaaS", capability: "http-api", maxResults: 2 },
  });
  assert.strictEqual(result.matched, 4);
  assert.strictEqual(result.results.length, 2);
  assert.deepStrictEqual(
    result.results.map((entry) => entry.package.id),
    ["clapp_pkg_w", "clapp_pkg_x"],
  );

  const summary = retrievalSummary(result);
  assert.deepStrictEqual(summary, {
    matched: 4,
    ranked: 2,
    reasonsUsed: ["capability-overlap:http-api", "category-shared"],
  });

  // The digest recomputes exactly from the result it summarizes.
  const union = new Set<string>();
  for (const entry of result.results) {
    for (const reason of entry.reasons) {
      union.add(reason);
    }
  }
  assert.deepStrictEqual(summary.reasonsUsed, [...union].sort());
  assert.strictEqual(summary.ranked, result.results.length);
  assert.strictEqual(summary.matched, result.matched);

  // maxResults beyond the match count truncates nothing.
  const untruncated = retrievePackages({
    registry,
    query: { category: "CRUD SaaS", capability: "http-api", maxResults: 50 },
  });
  const untruncatedSummary = retrievalSummary(untruncated);
  assert.strictEqual(untruncatedSummary.matched, 4);
  assert.strictEqual(untruncatedSummary.ranked, 4);

  // A no-match query accounts to exact zeroes.
  const empty = retrievePackages({ registry, query: { category: "missing" } });
  assert.deepStrictEqual(retrievalSummary(empty), {
    matched: 0,
    ranked: 0,
    reasonsUsed: [],
  });

  // A malformed result fails closed instead of mis-accounting.
  expectRetrievalError(() => retrievalSummary({} as unknown as RetrievalResult), "invalid-input");
});
