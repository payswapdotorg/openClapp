/**
 * Package retrieval and the compatibility graph (CLAPP-W2-007).
 *
 * Two deterministic, fail-closed views over package registry contents —
 * the M6 step-5 "reuse packages" feed:
 *
 * 1. The compatibility graph (`buildCompatGraph`) is a PURE function of the
 *    package documents it is built from: no wall-clock, no randomness, no
 *    external data. Nodes are package identities (id@version); edges are
 *    DERIVED relations only — same category ("category-shared"), each shared
 *    capability ("capability-overlap:<cap>"), each shared supported target
 *    ("target-overlap:<target>"), and every same-id different-version pair
 *    ("lineage-neighbor"). Every edge carries its derivation reason; pairs
 *    with no derivable relation have NO edge, never a guessed one. The same
 *    contents produce a byte-identical graph regardless of input array order
 *    (nodes order by (id, version), edges by (from, to, reason)).
 *
 * 2. Retrieval (`retrievePackages`) composes the graph's derivation rules:
 *    a query for "what can I reuse for target X with capabilities Y"
 *    delegates the category/status hard filters to the frozen W2-005
 *    registry surface, then ranks survivors by derived compatibility with
 *    the query using the SAME relation vocabulary the graph derives. Ranking
 *    is deterministic (fixed weights in RETRIEVAL_WEIGHTS; ties broken by id
 *    then version — identity fields, never insertion accident) and explained
 *    (every result carries its match reasons).
 *
 * Honesty discipline: absent capabilities/targets (empty arrays) are UNKNOWN
 * — recorded as "capability-unknown:<cap>" / "target-unknown:<target>"
 * reasons with weight 0, ranked below matches, never treated as matches and
 * never as mismatches. DECLARED but non-matching capabilities/targets are
 * derivable mismatches and filter the package out. Unknown categories match
 * nothing (empty result, the registry's own exact-match semantics).
 * Structurally-invalid queries fail closed with a typed RetrievalError that
 * collects every issue — criteria are never silently ignored.
 *
 * A package's promoted status is derived from its CONTENT (the
 * provenance.promotion record the registry's promote() writes) inside the
 * graph, because the graph is a pure function of documents; retrieval
 * instead delegates status filtering to the registry's authoritative
 * status filter. NO cross-package imports: the graph is built over the
 * registry interface only.
 */

import type { ClappPackage } from "@clapp/contracts";
import { compareStrings, isPlainObject } from "./json.ts";
import type { PackageListFilter, PackageRegistry } from "./package-registry.ts";
import type { PackageStatus } from "./package-store.ts";
import {
  comparePackageVersions,
  isConformingVersion,
  normalizePackageVersion,
} from "./package-version.ts";

// ---------------------------------------------------------------------------
// Public types — the compatibility graph
// ---------------------------------------------------------------------------

/** Identity of a graph node: a package's registry coordinate. */
export interface CompatNodeIdentity {
  id: string;
  /** The normalized MAJOR.MINOR.PATCH spelling of the version. */
  version: string;
}

/**
 * A graph node: one package identity plus the status derived from its
 * content (provenance.promotion present => the registry promoted it).
 */
export interface CompatNode extends CompatNodeIdentity {
  promoted: boolean;
}

/** The derived relation an edge represents. */
export type CompatEdgeKind =
  | "category-shared"
  | "capability-overlap"
  | "target-overlap"
  | "lineage-neighbor";

/** One derived compatibility relation between two package identities. */
export interface CompatEdge {
  /** The identity-smaller endpoint (canonical direction). */
  from: CompatNodeIdentity;
  /** The identity-larger endpoint. */
  to: CompatNodeIdentity;
  kind: CompatEdgeKind;
  /**
   * The full derivation reason: "category-shared", "capability-overlap:<cap>",
   * "target-overlap:<target>" or "lineage-neighbor".
   */
  reason: string;
}

/** The compatibility graph: a pure derived view of package contents. */
export interface CompatGraph {
  /** Every package identity, ordered by (id, version). */
  nodes: CompatNode[];
  /** Every derivable relation, ordered by (from id, from version, to id, to version, reason). */
  edges: CompatEdge[];
}

// ---------------------------------------------------------------------------
// Public types — retrieval
// ---------------------------------------------------------------------------

/** A retrieval query: what the caller wants to reuse. Validated fail-closed. */
export interface RetrievalQuery {
  /**
   * Exact category match, delegated to the registry. Unknown categories
   * match nothing: an empty result, never an error.
   */
  category?: string;
  /**
   * Capability the caller needs. Packages whose declared capabilities
   * include it match ("capability-overlap:<cap>"); packages with NO declared
   * capabilities are unknown ("capability-unknown:<cap>", weight 0, ranked
   * below matches); packages that declare capabilities without this one are
   * derivable mismatches and are filtered out.
   */
  capability?: string;
  /** Like `capability`, over supportedTargets ("target-overlap:<target>"). */
  target?: string;
  /** Lifecycle filter, delegated to the registry's own status semantics. */
  status?: PackageStatus;
  /** Truncation applied AFTER deterministic ranking. Integer >= 1. */
  maxResults?: number;
}

/** One ranked retrieval result: the package, its score, its match reasons. */
export interface RetrievalEntry {
  package: ClappPackage;
  score: number;
  reasons: string[];
}

/**
 * The retrieval outcome. `matched` counts the packages that passed every
 * hard filter (including honesty unknowns) BEFORE maxResults truncation;
 * `results` is the ranked, possibly truncated list.
 */
export interface RetrievalResult {
  results: RetrievalEntry[];
  matched: number;
}

/** The accounting digest over a retrieval result. */
export interface RetrievalSummary {
  matched: number;
  ranked: number;
  reasonsUsed: string[];
}

// ---------------------------------------------------------------------------
// Public types — explanation
// ---------------------------------------------------------------------------

/** A promoted neighbor ranked by shared derivation reasons. */
export interface CompatNeighborMatch {
  id: string;
  version: string;
  /** The number of derivation reasons shared with the explained node. */
  score: number;
  reasons: string[];
}

/** The explanation of one node's place in the compatibility graph. */
export interface CompatExplanation {
  node: CompatNodeIdentity;
  /** Every edge incident to the node, in graph (deterministic) order. */
  edges: CompatEdge[];
  /** Other versions of the same id, in version order. */
  lineageNeighbors: CompatNodeIdentity[];
  /**
   * The node's promoted neighbors, best-matching first: ranked by the number
   * of shared derivation reasons, ties by (id, version).
   */
  bestMatchingPromoted: CompatNeighborMatch[];
}

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

/** Why a retrieval-surface call failed closed. */
export type RetrievalErrorCode =
  | "invalid-input"
  | "invalid-registry"
  | "invalid-query"
  | "invalid-packages"
  | "node-not-found";

/**
 * The typed fail-closed error of the retrieval surface. `issues` carries
 * every collected violation (never just the first) so no criterion is ever
 * silently ignored or thrown into the void.
 */
export class RetrievalError extends Error {
  readonly code: RetrievalErrorCode;
  readonly issues: readonly string[];

  constructor(code: RetrievalErrorCode, message: string, issues: readonly string[] = []) {
    super(message);
    this.name = "RetrievalError";
    this.code = code;
    this.issues = [...issues];
  }
}

// ---------------------------------------------------------------------------
// Deterministic ranking weights
// ---------------------------------------------------------------------------

/**
 * The fixed ranking weights. Matches contribute their weight to the score;
 * honesty unknowns contribute 0 — which is exactly why packages with absent
 * capabilities/targets rank below matching ones. The category weight is
 * uniform across survivors of the category hard filter (it documents the
 * match in reasons[] without ever affecting order).
 */
export const RETRIEVAL_WEIGHTS = {
  categoryShared: 1,
  capabilityOverlap: 4,
  targetOverlap: 4,
} as const;

// ---------------------------------------------------------------------------
// Internal projections and derivation helpers
// ---------------------------------------------------------------------------

/** The document fields the derivations read, validated and normalized. */
interface PackageProjection {
  identity: CompatNodeIdentity;
  category: string;
  capabilities: string[];
  supportedTargets: string[];
  promoted: boolean;
}

/** The query fields the surface recognizes; anything else is an issue. */
const QUERY_FIELDS = ["capability", "category", "maxResults", "status", "target"] as const;

/** Deduplicated, deterministically sorted copy of a string list. */
function dedupeSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareStrings);
}

/**
 * Reads one package document into the projection the derivations need,
 * collecting every structural violation (the graph checks only the fields it
 * derives from — it is not a re-implementation of the schema validator).
 * Returns null when the document is unusable.
 */
function projectPackage(doc: unknown, index: number, issues: string[]): PackageProjection | null {
  if (!isPlainObject(doc)) {
    issues.push(`packages[${index}] must be an object`);
    return null;
  }
  const docIssues: string[] = [];
  const id = doc.id;
  if (typeof id !== "string" || id.length === 0) {
    docIssues.push(`packages[${index}].id must be a non-empty string`);
  }
  const version = doc.version;
  if (typeof version !== "string" || !isConformingVersion(version)) {
    docIssues.push(`packages[${index}].version must be a conforming MAJOR.MINOR.PATCH version`);
  }
  const category = doc.category;
  if (typeof category !== "string") {
    docIssues.push(`packages[${index}].category must be a string`);
  }
  const capabilities = readStringArray(doc.capabilities, "capabilities", index, docIssues);
  const supportedTargets = readStringArray(
    doc.supportedTargets,
    "supportedTargets",
    index,
    docIssues,
  );
  const provenance = doc.provenance;
  if (provenance !== undefined && !isPlainObject(provenance)) {
    docIssues.push(`packages[${index}].provenance must be an object`);
  }
  if (docIssues.length > 0) {
    issues.push(...docIssues);
    return null;
  }
  const promotion = isPlainObject(provenance) ? provenance.promotion : undefined;
  return {
    identity: {
      id: id as string,
      version: normalizePackageVersion(version as string),
    },
    category: category as string,
    capabilities: capabilities as string[],
    supportedTargets: supportedTargets as string[],
    promoted: isPlainObject(promotion),
  };
}

/**
 * Reads an optional string-array field. Absent means the dimension is
 * UNKNOWN (no derivable relations); present-but-malformed is a collected
 * issue. Returns null when malformed.
 */
function readStringArray(
  value: unknown,
  field: string,
  index: number,
  issues: string[],
): string[] | null {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    issues.push(`packages[${index}].${field} must be an array of strings`);
    return null;
  }
  return dedupeSorted(value as string[]);
}

/** Deterministic order over ranked matches: score, then identity. */
interface ScoredMatch {
  document: ClappPackage;
  score: number;
  reasons: string[];
}

/** Total deterministic order over projections (id, then version). */
function compareProjections(left: PackageProjection, right: PackageProjection): number {
  return (
    compareStrings(left.identity.id, right.identity.id) ||
    comparePackageVersions(left.identity.version, right.identity.version)
  );
}

/** Total deterministic order over edges (from, to, reason). */
function compareEdges(left: CompatEdge, right: CompatEdge): number {
  return (
    compareStrings(left.from.id, right.from.id) ||
    comparePackageVersions(left.from.version, right.from.version) ||
    compareStrings(left.to.id, right.to.id) ||
    comparePackageVersions(left.to.version, right.to.version) ||
    compareStrings(left.reason, right.reason)
  );
}

/**
 * Derives every relation between two projections, in the canonical
 * direction (a is identity-smaller). Only derivable relations produce
 * edges; absent dimensions derive nothing.
 */
function deriveEdges(a: PackageProjection, b: PackageProjection, edges: CompatEdge[]): void {
  const push = (kind: CompatEdgeKind, reason: string): void => {
    edges.push({
      from: { id: a.identity.id, version: a.identity.version },
      to: { id: b.identity.id, version: b.identity.version },
      kind,
      reason,
    });
  };
  if (a.identity.id === b.identity.id) {
    push("lineage-neighbor", "lineage-neighbor");
  }
  if (a.category === b.category) {
    push("category-shared", "category-shared");
  }
  for (const capability of a.capabilities) {
    if (b.capabilities.includes(capability)) {
      push("capability-overlap", `capability-overlap:${capability}`);
    }
  }
  for (const target of a.supportedTargets) {
    if (b.supportedTargets.includes(target)) {
      push("target-overlap", `target-overlap:${target}`);
    }
  }
}

// ---------------------------------------------------------------------------
// buildCompatGraph
// ---------------------------------------------------------------------------

/**
 * Builds the compatibility graph over the given package documents.
 *
 * Pure and deterministic: the returned nodes are ordered by (id, version),
 * the edges by (from, to, reason), so the same contents always serialize
 * byte-identically regardless of the input array's order. Structurally
 * unusable documents or duplicate (id, version) identities fail closed with
 * a typed RetrievalError collecting every issue — the graph never builds on
 * state it cannot derive from.
 */
export function buildCompatGraph(packages: ClappPackage[]): CompatGraph {
  if (!Array.isArray(packages)) {
    throw new RetrievalError("invalid-packages", "packages must be an array of package documents");
  }
  const issues: string[] = [];
  const projections: PackageProjection[] = [];
  const sourceIndices: number[] = [];
  for (let index = 0; index < packages.length; index += 1) {
    const projected = projectPackage(packages[index], index, issues);
    if (projected !== null) {
      projections.push(projected);
      sourceIndices.push(index);
    }
  }
  const seen = new Map<string, number>();
  for (let position = 0; position < projections.length; position += 1) {
    const key = `${projections[position].identity.id}@${projections[position].identity.version}`;
    const firstAt = seen.get(key);
    if (firstAt === undefined) {
      seen.set(key, position);
      continue;
    }
    issues.push(
      `duplicate package identity ${key} (packages[${sourceIndices[firstAt]}] and packages[${sourceIndices[position]}])`,
    );
  }
  if (issues.length > 0) {
    throw new RetrievalError(
      "invalid-packages",
      `the compatibility graph is not derivable from these packages (${issues.length} ${
        issues.length === 1 ? "issue" : "issues"
      }); failing closed`,
      issues,
    );
  }

  const sorted = [...projections].sort(compareProjections);
  const nodes: CompatNode[] = sorted.map((projection) => ({
    id: projection.identity.id,
    version: projection.identity.version,
    promoted: projection.promoted,
  }));
  const edges: CompatEdge[] = [];
  for (let left = 0; left < sorted.length; left += 1) {
    for (let right = left + 1; right < sorted.length; right += 1) {
      deriveEdges(sorted[left], sorted[right], edges);
    }
  }
  edges.sort(compareEdges);
  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// retrievePackages
// ---------------------------------------------------------------------------

/**
 * Validates the query structurally, collecting every violation. Unknown
 * fields, wrong types, empty filter strings and non-positive/fractional
 * maxResults are all issues — criteria are never silently ignored.
 */
function validateQuery(query: unknown): RetrievalQuery {
  if (!isPlainObject(query)) {
    throw new RetrievalError(
      "invalid-query",
      "the retrieval query must be an object (category, capability, target, status, maxResults)",
    );
  }
  const issues: string[] = [];
  for (const key of Object.keys(query).sort(compareStrings)) {
    if (!QUERY_FIELDS.includes(key as (typeof QUERY_FIELDS)[number])) {
      issues.push(`unknown query field "${key}" (allowed: ${QUERY_FIELDS.join(", ")})`);
    }
  }
  for (const field of ["category", "capability", "target"] as const) {
    const value = query[field];
    if (value !== undefined && (typeof value !== "string" || value.length === 0)) {
      issues.push(`query.${field} must be a non-empty string when present`);
    }
  }
  const status = query.status;
  if (status !== undefined && status !== "candidate" && status !== "promoted") {
    issues.push('query.status must be "candidate" or "promoted" when present');
  }
  const maxResults = query.maxResults;
  if (
    maxResults !== undefined &&
    (typeof maxResults !== "number" || !Number.isInteger(maxResults) || maxResults < 1)
  ) {
    issues.push("query.maxResults must be an integer >= 1 when present");
  }
  if (issues.length > 0) {
    throw new RetrievalError(
      "invalid-query",
      `the retrieval query is structurally invalid (${issues.length} ${
        issues.length === 1 ? "issue" : "issues"
      }); failing closed`,
      issues,
    );
  }
  return query as RetrievalQuery;
}

/** Duck-types the read port retrieval consumes (a callable list()). */
function assertRegistryPort(registry: unknown): asserts registry is PackageRegistry {
  if (
    typeof registry !== "object" ||
    registry === null ||
    typeof (registry as Record<string, unknown>).list !== "function"
  ) {
    throw new RetrievalError(
      "invalid-registry",
      "retrieval requires a PackageRegistry with a callable list()",
    );
  }
}

/**
 * Retrieves the reusable packages for a query — the M6 step-5 feed.
 *
 * The category and status hard filters delegate to the frozen W2-005
 * registry surface (deterministic (id, version) order, unknown categories
 * matching nothing). Capability and target are then applied retrieval-side
 * because honesty requires unknown-inclusion, which the registry's exact
 * includes() filter cannot express: declared matches score, absent
 * dimensions are recorded unknowns with weight 0, declared mismatches are
 * filtered out. Survivors are ranked by derived compatibility score
 * (RETRIEVAL_WEIGHTS; ties by id then version) and truncated by maxResults.
 * Every result carries its match reasons.
 */
export function retrievePackages(input: {
  registry: PackageRegistry;
  query: RetrievalQuery;
}): RetrievalResult {
  if (!isPlainObject(input)) {
    throw new RetrievalError(
      "invalid-input",
      "retrieval input must be an object with registry and query",
    );
  }
  assertRegistryPort(input.registry);
  const query = validateQuery(input.query);

  const hardFilter: PackageListFilter = {};
  if (query.category !== undefined) {
    hardFilter.category = query.category;
  }
  if (query.status !== undefined) {
    hardFilter.status = query.status;
  }
  // registry.list() is the frozen W2-005 surface: schema-normalized
  // documents in deterministic (id, version) order.
  const listed = input.registry.list(hardFilter);

  const matches: ScoredMatch[] = [];
  for (const document of listed) {
    const reasons: string[] = [];
    let score = 0;
    if (query.category !== undefined && document.category === query.category) {
      reasons.push("category-shared");
      score += RETRIEVAL_WEIGHTS.categoryShared;
    }
    if (query.capability !== undefined) {
      if (document.capabilities.includes(query.capability)) {
        reasons.push(`capability-overlap:${query.capability}`);
        score += RETRIEVAL_WEIGHTS.capabilityOverlap;
      } else if (document.capabilities.length === 0) {
        // Absent capabilities are unknown: recorded, weight 0, ranked below.
        reasons.push(`capability-unknown:${query.capability}`);
      } else {
        // Declared and non-matching: a derivable mismatch, filtered out.
        continue;
      }
    }
    if (query.target !== undefined) {
      if (document.supportedTargets.includes(query.target)) {
        reasons.push(`target-overlap:${query.target}`);
        score += RETRIEVAL_WEIGHTS.targetOverlap;
      } else if (document.supportedTargets.length === 0) {
        reasons.push(`target-unknown:${query.target}`);
      } else {
        continue;
      }
    }
    matches.push({ document, score, reasons: reasons.sort(compareStrings) });
  }

  matches.sort(
    (left, right) =>
      right.score - left.score ||
      compareStrings(left.document.id, right.document.id) ||
      comparePackageVersions(left.document.version, right.document.version),
  );

  const limited = query.maxResults === undefined ? matches : matches.slice(0, query.maxResults);
  const results: RetrievalEntry[] = limited.map((match) => ({
    package: match.document,
    score: match.score,
    reasons: match.reasons,
  }));
  return { results, matched: matches.length };
}

// ---------------------------------------------------------------------------
// retrievalSummary
// ---------------------------------------------------------------------------

/**
 * The accounting digest over a retrieval result: how many packages matched,
 * how many are in the ranked (possibly truncated) list, and the sorted set
 * of reasons actually used across the ranked results.
 */
export function retrievalSummary(result: RetrievalResult): RetrievalSummary {
  if (!isPlainObject(result) || !Array.isArray(result.results)) {
    throw new RetrievalError(
      "invalid-input",
      "retrievalSummary requires a RetrievalResult with a results array",
    );
  }
  if (typeof result.matched !== "number") {
    throw new RetrievalError(
      "invalid-input",
      "retrievalSummary requires a RetrievalResult with a numeric matched count",
    );
  }
  const reasons = new Set<string>();
  for (const entry of result.results) {
    if (
      !isPlainObject(entry) ||
      !Array.isArray(entry.reasons) ||
      !entry.reasons.every((reason) => typeof reason === "string")
    ) {
      throw new RetrievalError(
        "invalid-input",
        "every retrieval result entry must carry a string[] reasons array",
      );
    }
    for (const reason of entry.reasons) {
      reasons.add(reason);
    }
  }
  return {
    matched: result.matched,
    ranked: result.results.length,
    reasonsUsed: [...reasons].sort(compareStrings),
  };
}

// ---------------------------------------------------------------------------
// explainCompatibility
// ---------------------------------------------------------------------------

/**
 * Explains one node's place in the compatibility graph: its incident edges
 * with reasons, its lineage neighbors (other versions of the same id, in
 * version order), and its best-matching promoted packages (promoted
 * neighbors ranked by shared derivation reasons, ties by identity).
 *
 * Unknown identities fail closed with a typed node-not-found error — the
 * graph only explains what it was built from.
 */
export function explainCompatibility(
  graph: CompatGraph,
  id: string,
  version: string,
): CompatExplanation {
  if (!isPlainObject(graph) || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    throw new RetrievalError(
      "invalid-input",
      "explainCompatibility requires a CompatGraph with nodes and edges arrays",
    );
  }
  if (typeof id !== "string" || id.length === 0) {
    throw new RetrievalError("invalid-input", "explainCompatibility requires a non-empty id");
  }
  if (typeof version !== "string" || version.length === 0) {
    throw new RetrievalError("invalid-input", "explainCompatibility requires a non-empty version");
  }
  const normalized = normalizePackageVersion(version);
  const nodes = graph.nodes;
  const edges = graph.edges;
  const isNode = (identity: CompatNodeIdentity): boolean =>
    identity.id === id && identity.version === normalized;
  const node = nodes.find((candidate) => isNode(candidate));
  if (node === undefined) {
    throw new RetrievalError(
      "node-not-found",
      `no compatibility graph node for ${id}@${normalized}; the graph only explains identities it was built from`,
    );
  }

  const incident = edges.filter((edge) => isNode(edge.from) || isNode(edge.to));
  const lineageNeighbors: CompatNodeIdentity[] = nodes
    .filter((candidate) => candidate.id === id && candidate.version !== normalized)
    .sort((left, right) => comparePackageVersions(left.version, right.version))
    .map((candidate) => ({ id: candidate.id, version: candidate.version }));

  const promotedByIdentity = new Map<string, boolean>();
  for (const candidate of nodes) {
    promotedByIdentity.set(`${candidate.id}@${candidate.version}`, candidate.promoted);
  }
  interface NeighborAccumulator {
    identity: CompatNodeIdentity;
    reasons: string[];
  }
  const neighbors = new Map<string, NeighborAccumulator>();
  for (const edge of incident) {
    const other = isNode(edge.from) ? edge.to : edge.from;
    const key = `${other.id}@${other.version}`;
    const accumulator = neighbors.get(key) ?? { identity: { ...other }, reasons: [] };
    accumulator.reasons.push(edge.reason);
    neighbors.set(key, accumulator);
  }
  const bestMatchingPromoted: CompatNeighborMatch[] = [...neighbors.values()]
    .filter(
      (accumulator) =>
        promotedByIdentity.get(`${accumulator.identity.id}@${accumulator.identity.version}`) ===
        true,
    )
    .map((accumulator) => ({
      id: accumulator.identity.id,
      version: accumulator.identity.version,
      score: accumulator.reasons.length,
      reasons: [...accumulator.reasons].sort(compareStrings),
    }))
    .sort(
      (left, right) =>
        right.score - left.score ||
        compareStrings(left.id, right.id) ||
        comparePackageVersions(left.version, right.version),
    );

  return {
    node: { id, version: normalized },
    edges: incident,
    lineageNeighbors,
    bestMatchingPromoted,
  };
}
