import type { ClappPackage } from "@clapp/contracts";
import { isPlainObject } from "./canonical.ts";
import { contentHash } from "./hash.ts";

/**
 * Archetype composition planner (CLAPP-W3-009) — the composition half of
 * IMPLEMENTATION_PLAN Phase 7's "App archetype factory" (ARCHITECTURE.md
 * section 7: synthesis is IR + package graph + constraints + policy →
 * SynthesisPlan; ACCEPTANCE.md M6 steps 4-5: build a second app that matches
 * a prior archetype, reuse packages).
 *
 * `planComposition` derives, for one detected archetype, which registry
 * packages fill which composition slots: the archetype anchor and its
 * compatible extensions, selected from a registry snapshot through the
 * compatibility graph under the frozen package policy. The selected
 * `packageIds` are exactly the list `planSynthesisApp(spec, model,
 * packageIds)` consumes and the frozen `SynthesisPlan.packageIds` field
 * carries — composition selects, W3-001 plans, W3-002 generates; this module
 * never fabricates a SynthesisPlan and never calls the generator.
 *
 * The module consumes three neighbour surfaces as READ-ONLY data through
 * structural ports (the ADR-002 discipline — no `@clapp/intelligence`
 * import; the pattern of the local `ArchetypeHint` in the W2-006 extractor):
 *
 * - the W2-004 `ArchetypeVerdict` — the planner reads `label` and
 *   `confidence`; the real classifier output satisfies the local
 *   `CompositionVerdict` port structurally;
 * - the W2-005 registry snapshot — the `ClappPackage[]` that
 *   `PackageRegistry.list()` returns (`ClappPackage` from `@clapp/contracts`
 *   is the one cross-package import of this module);
 * - the W2-007 `CompatGraph` — the object `buildCompatGraph(packages)`
 *   produces, passed in as data (nodes `{id, version, promoted}`, edges
 *   `{from, to, kind, reason}`).
 *
 * Derivation rules (deterministic and honest):
 *
 * - ABSTAIN FIRST — a verdict labeled "unknown" (the classifier's honest
 *   emission when no archetype reaches its threshold) yields an `abstained`
 *   plan: never a composition over an unknown label, never a guessed
 *   category.
 * - CATEGORY GATE — only snapshot documents whose `category` equals the
 *   verdict label survive. W2-006 extraction writes the archetype label
 *   VERBATIM as the package category, so the match is exact; the
 *   conservative generic category "application" (W2-006's
 *   GENERIC_PACKAGE_CATEGORY, which is not a member of the archetype
 *   vocabulary) is never coerced into a match.
 * - POLICY GATE — "verified-only" admits only packages whose graph node
 *   carries `promoted: true`; "verified-and-candidates" admits both. The
 *   policy mirrors the frozen `ReconstructionSpec.synthesis.packagePolicy`
 *   and is REQUIRED — there is no silent default.
 * - ANCHOR SLOT — the best-ranked survivor fills the `archetype-anchor`
 *   role. Ranking is identity-stable only: promoted first, then descending
 *   count of graph edges incident within the survivor set, then (id,
 *   version) ascending; input array order never leaks into output.
 * - EXTENSION SLOTS — each further survivor fills a `compatible-extension`
 *   role only when it is graph-adjacent to EVERY already-selected package by
 *   at least one derivable edge (that mutual adjacency is the compatible
 *   set) AND contributes a capability the selection lacks (no redundant
 *   slots). The scan walks the rank order, and at most one version of any
 *   package id is ever selected (the downstream `SynthesisPlan.packageIds`
 *   must stay unique).
 * - NO COMPATIBLE SET — zero survivors after the gates yields a `fallback`
 *   plan with empty `packageIds` and a recorded reason naming what was
 *   missing; a single anchor alone IS a compatible set.
 *
 * Fail-closed validation: structurally unusable input (a non-array snapshot;
 * a package missing id/version/category or carrying non-string / non-array
 * fields; duplicate `(id, version)` identities; a graph whose nodes/edges
 * are not arrays or whose edges lack from/to/kind/reason; a graph that does
 * not cover the snapshot; a missing or malformed verdict or policy) throws a
 * typed `CompositionError` collecting EVERY issue — never a plan built on
 * untrusted state, never a silent drop.
 *
 * Purity: no wall-clock, no randomness, no I/O, no async. The same input
 * yields a deep-equal plan and a byte-identical canonical serialization with
 * a stable `compositionDigest` whatever the snapshot's or graph's array
 * order; inputs are never mutated and every carried value is a deep copy
 * (the plan.ts discipline).
 */

// ---------------------------------------------------------------------------
// Public types — structural ports of the consumed neighbour surfaces
// ---------------------------------------------------------------------------

/**
 * Structural port of the W2-004 `ArchetypeVerdict`: the fields the planner
 * reads. The real classifier output satisfies this shape structurally
 * (extra fields are welcome; the planner never imports the real type).
 */
export interface CompositionVerdict {
  /** An ARCHETYPES label or "unknown" — read verbatim, never guessed. */
  label: string;
  /** The calibrated certainty of the emitted label (0..1). */
  confidence: number;
}

/** A compatibility graph node: one package identity plus its derived status. */
export interface CompositionGraphNode {
  id: string;
  version: string;
  /** The status derived from content: provenance.promotion present => true. */
  promoted: boolean;
}

/** One endpoint of a compatibility edge (a package's registry coordinate). */
export interface CompositionGraphEndpoint {
  id: string;
  version: string;
}

/**
 * One derived compatibility relation between two package identities, as the
 * W2-007 graph emits it. `kind` is validated structurally (a non-empty
 * string); the planner carries the VERBATIM `reason` strings only.
 */
export interface CompositionGraphEdge {
  from: CompositionGraphEndpoint;
  to: CompositionGraphEndpoint;
  kind: string;
  reason: string;
}

/**
 * Structural port of the W2-007 `CompatGraph`: the object
 * `buildCompatGraph(packages)` produces, passed in as data.
 */
export interface CompositionGraph {
  nodes: CompositionGraphNode[];
  edges: CompositionGraphEdge[];
}

/**
 * The package admission policy, mirroring the frozen
 * `ReconstructionSpec.synthesis.packagePolicy` verbatim. Required on every
 * call — there is no silent default.
 */
export type CompositionPackagePolicy = "verified-only" | "verified-and-candidates";

/** The planner input: the (verdict, snapshot, graph, policy) tuple. */
export interface CompositionInput {
  /** A structural `ArchetypeVerdict` (label + confidence). */
  verdict: CompositionVerdict;
  /** The registry snapshot — the `PackageRegistry.list()` output, as data. */
  packages: ClappPackage[];
  /** The compatibility graph over that same snapshot, as data. */
  graph: CompositionGraph;
  /** REQUIRED: the frozen synthesis package policy. */
  packagePolicy: CompositionPackagePolicy;
}

// ---------------------------------------------------------------------------
// Public types — the fail-closed error
// ---------------------------------------------------------------------------

/** The typed fail-closed error code of the composition surface. */
export type CompositionErrorCode = "invalid-input";

/**
 * The typed fail-closed error of the composition surface (the RetrievalError
 * discipline). `issues` carries every collected violation (never just the
 * first) so no structural problem is ever silently ignored.
 */
export class CompositionError extends Error {
  readonly code: CompositionErrorCode;
  readonly issues: readonly string[];

  constructor(code: CompositionErrorCode, message: string, issues: readonly string[] = []) {
    super(message);
    this.name = "CompositionError";
    this.code = code;
    this.issues = [...issues];
  }
}

// ---------------------------------------------------------------------------
// Public types — the composition plan
// ---------------------------------------------------------------------------

/** The slot a selected package fills. */
export type CompositionSelectionRole = "archetype-anchor" | "compatible-extension";

/** The registry lifecycle of a selected package, derived by the graph. */
export type CompositionLifecycle = "promoted" | "candidate";

/**
 * Recorded provenance for one selection, always: the registry fields the
 * selection read, its lifecycle, and the VERBATIM edge reasons connecting it
 * to the rest of the selection. An isolated selection (no derivable edge to
 * any other selection) carries the honest empty-reasons note — never an
 * invented edge.
 */
export interface CompositionProvenance {
  /** The registry category the category gate read (the archetype label). */
  category: string;
  /** The declared capabilities, carried verbatim as a deep copy. */
  capabilities: string[];
  /** The declared supported targets, carried verbatim as a deep copy. */
  supportedTargets: string[];
  /** The graph-derived lifecycle at selection time. */
  lifecycle: CompositionLifecycle;
  /**
   * The VERBATIM graph edge reasons connecting this selection to every other
   * selection (sorted ascending; empty when isolated).
   */
  edgeReasons: string[];
  /** The honest accounting note for this selection's connectivity. */
  note: string;
}

/** One filled slot: a role, the package that fills it, and its provenance. */
export interface CompositionSelection {
  role: CompositionSelectionRole;
  packageId: string;
  version: string;
  provenance: CompositionProvenance;
}

/** A composed plan: the compatible set, ready for the W3-001 seam. */
export interface ComposedCompositionPlan {
  status: "composed";
  /** One entry per filled slot, in selection order (anchor first). */
  selections: CompositionSelection[];
  /**
   * The selected package ids, unique, in selection order — exactly the list
   * `planSynthesisApp(spec, model, packageIds)` consumes.
   */
  packageIds: string[];
  /** Honest accounting: redundant skips, isolated nodes, id-version skips. */
  notes: string[];
  /**
   * Content-addressed sha256 (this package's `contentHash`) over the plan's
   * canonical core — `{status, selections, packageIds, notes}` — the same
   * discipline as the W3-002 manifest's planDigest. The digest never covers
   * itself.
   */
  compositionDigest: string;
}

/**
 * The no-compatible-set fallback: zero survivors after the category and
 * policy gates. Vanilla synthesis (W3-001 with no packages) proceeds; it
 * records its own assumption.
 */
export interface FallbackCompositionPlan {
  status: "fallback";
  packageIds: string[];
  /** The recorded reason naming what was missing. */
  reason: string;
}

/**
 * The honest abstention: the classifier emitted "unknown", so no composition
 * is derived over a guessed category. Vanilla synthesis proceeds.
 */
export interface AbstainedCompositionPlan {
  status: "abstained";
  packageIds: string[];
  /** The recorded reason for the abstention. */
  reason: string;
}

/** The status-discriminated composition plan. */
export type CompositionPlan =
  | ComposedCompositionPlan
  | FallbackCompositionPlan
  | AbstainedCompositionPlan;

// ---------------------------------------------------------------------------
// Deterministic comparison helpers (identity fields only)
// ---------------------------------------------------------------------------

/** Code-unit string order — the repo's identity-field comparison. */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Deterministic MAJOR.MINOR.PATCH version order (numeric segments compared
 * numerically, non-numeric segments lexically) — a local mirror of the
 * registry's normalized-version ordering discipline; the planner never
 * imports the intelligence comparator.
 */
function compareVersions(a: string, b: string): number {
  const aParts = a.split(".");
  const bParts = b.split(".");
  const length = Math.max(aParts.length, bParts.length);
  for (let index = 0; index < length; index += 1) {
    const aPart = aParts[index];
    const bPart = bParts[index];
    if (aPart === undefined) {
      return -1;
    }
    if (bPart === undefined) {
      return 1;
    }
    const aNumeric = /^\d+$/.test(aPart) ? Number(aPart) : null;
    const bNumeric = /^\d+$/.test(bPart) ? Number(bPart) : null;
    if (aNumeric !== null && bNumeric !== null) {
      if (aNumeric !== bNumeric) {
        return aNumeric < bNumeric ? -1 : 1;
      }
    } else {
      const order = compareStrings(aPart, bPart);
      if (order !== 0) {
        return order;
      }
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Fail-closed validation (collects EVERY issue)
// ---------------------------------------------------------------------------

/** A readable description for a validation message (the validate.ts style). */
function describe(value: unknown): string {
  if (value === undefined) {
    return "got undefined";
  }
  if (value === null) {
    return "got null";
  }
  if (Array.isArray(value)) {
    return "got an array";
  }
  if (typeof value === "object") {
    return "got an object";
  }
  if (typeof value === "string") {
    const snippet = value.length > 32 ? `${value.slice(0, 32)}…` : value;
    return `got ${JSON.stringify(snippet)}`;
  }
  return `got ${typeof value} (${String(value)})`;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Reads a required string-array field (capabilities / supportedTargets).
 * Returns a fresh-copied array of the read values, or null after recording
 * the issue.
 */
function readStringArrayField(
  doc: Record<string, unknown>,
  field: string,
  path: string,
  issues: string[],
): string[] | null {
  const value = doc[field];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    issues.push(`${path}.${field} must be an array of strings, ${describe(value)}`);
    return null;
  }
  return value.map((entry) => entry as string);
}

/**
 * Reads one edge endpoint. Returns the endpoint identity key
 * (`id@version`) or null after recording the issue.
 */
function readEndpoint(value: unknown, path: string, issues: string[]): string | null {
  if (!isPlainObject(value)) {
    issues.push(`${path} must be an object carrying id and version, ${describe(value)}`);
    return null;
  }
  const idOk = isNonEmptyString(value.id);
  const versionOk = isNonEmptyString(value.version);
  if (!idOk) {
    issues.push(`${path}.id must be a non-empty string, ${describe(value.id)}`);
  }
  if (!versionOk) {
    issues.push(`${path}.version must be a non-empty string, ${describe(value.version)}`);
  }
  if (!idOk || !versionOk) {
    return null;
  }
  return `${value.id}@${value.version}`;
}

/** The validated projection of one snapshot document (fields the planner reads). */
interface PackageView {
  id: string;
  version: string;
  identity: string;
  category: string;
  capabilities: string[];
  supportedTargets: string[];
  promoted: boolean;
}

/** The validated projection of one graph edge (identity keys + reason). */
interface EdgeView {
  from: string;
  to: string;
  reason: string;
}

/** The validated input projection the planner derives from. */
interface ValidatedInput {
  verdict: CompositionVerdict;
  packages: PackageView[];
  edges: EdgeView[];
  packagePolicy: CompositionPackagePolicy;
}

/**
 * Structural validation of the (verdict, snapshot, graph, policy) tuple,
 * collecting every violation. Throws a typed `CompositionError` carrying all
 * issues — never a partially-derived plan, never a silent drop.
 */
function validateCompositionInput(input: unknown): ValidatedInput {
  if (!isPlainObject(input)) {
    throw new CompositionError(
      "invalid-input",
      "the composition input must be an object carrying verdict, packages, graph and packagePolicy",
      ["input must be an object carrying verdict, packages, graph and packagePolicy"],
    );
  }
  const issues: string[] = [];

  // --- verdict ---
  let verdict: CompositionVerdict | null = null;
  if (!isPlainObject(input.verdict)) {
    issues.push(
      `verdict must be an object carrying label and confidence, ${describe(input.verdict)}`,
    );
  } else {
    const label = isNonEmptyString(input.verdict.label) ? input.verdict.label : null;
    const confidence = input.verdict.confidence;
    const confidenceOk =
      typeof confidence === "number" &&
      Number.isFinite(confidence) &&
      confidence >= 0 &&
      confidence <= 1;
    if (label === null) {
      issues.push(`verdict.label must be a non-empty string, ${describe(input.verdict.label)}`);
    }
    if (!confidenceOk) {
      issues.push(
        `verdict.confidence must be a finite number between 0 and 1, ${describe(confidence)}`,
      );
    }
    if (label !== null && confidenceOk) {
      verdict = { label, confidence };
    }
  }

  // --- packages (the registry snapshot) ---
  const packages: PackageView[] = [];
  const firstIndexOfIdentity = new Map<string, number>();
  if (!Array.isArray(input.packages)) {
    issues.push(
      `packages must be an array of registry package documents (the registry list() snapshot), ${describe(input.packages)}`,
    );
  } else {
    for (const [index, doc] of input.packages.entries()) {
      const path = `packages[${index}]`;
      if (!isPlainObject(doc)) {
        issues.push(`${path} must be an object, ${describe(doc)}`);
        continue;
      }
      const id = isNonEmptyString(doc.id) ? doc.id : null;
      const version = isNonEmptyString(doc.version) ? doc.version : null;
      const category = isNonEmptyString(doc.category) ? doc.category : null;
      if (id === null) {
        issues.push(`${path}.id must be a non-empty string, ${describe(doc.id)}`);
      }
      if (version === null) {
        issues.push(`${path}.version must be a non-empty string, ${describe(doc.version)}`);
      }
      if (category === null) {
        issues.push(`${path}.category must be a non-empty string, ${describe(doc.category)}`);
      }
      const capabilities = readStringArrayField(doc, "capabilities", path, issues);
      const supportedTargets = readStringArrayField(doc, "supportedTargets", path, issues);
      if (
        id === null ||
        version === null ||
        category === null ||
        capabilities === null ||
        supportedTargets === null
      ) {
        continue;
      }
      const identity = `${id}@${version}`;
      const firstAt = firstIndexOfIdentity.get(identity);
      if (firstAt === undefined) {
        firstIndexOfIdentity.set(identity, index);
      } else {
        issues.push(
          `duplicate package identity ${identity} (packages[${firstAt}] and packages[${index}])`,
        );
        continue;
      }
      packages.push({
        id,
        version,
        identity,
        category,
        capabilities,
        supportedTargets,
        promoted: false,
      });
    }
  }

  // --- graph (the derived compatibility view of the same snapshot) ---
  const nodePromotionByIdentity = new Map<string, boolean>();
  const edges: EdgeView[] = [];
  if (!isPlainObject(input.graph)) {
    issues.push(`graph must be an object carrying nodes and edges, ${describe(input.graph)}`);
  } else {
    if (!Array.isArray(input.graph.nodes)) {
      issues.push(`graph.nodes must be an array, ${describe(input.graph.nodes)}`);
    } else {
      const seenNodeIdentities = new Set<string>();
      for (const [index, node] of input.graph.nodes.entries()) {
        const path = `graph.nodes[${index}]`;
        if (!isPlainObject(node)) {
          issues.push(`${path} must be an object, ${describe(node)}`);
          continue;
        }
        const id = isNonEmptyString(node.id) ? node.id : null;
        const version = isNonEmptyString(node.version) ? node.version : null;
        const promoted = typeof node.promoted === "boolean" ? node.promoted : null;
        if (id === null) {
          issues.push(`${path}.id must be a non-empty string, ${describe(node.id)}`);
        }
        if (version === null) {
          issues.push(`${path}.version must be a non-empty string, ${describe(node.version)}`);
        }
        if (promoted === null) {
          issues.push(`${path}.promoted must be a boolean, ${describe(node.promoted)}`);
        }
        if (id === null || version === null || promoted === null) {
          continue;
        }
        const identity = `${id}@${version}`;
        if (seenNodeIdentities.has(identity)) {
          issues.push(`duplicate graph node identity ${identity} (${path})`);
          continue;
        }
        seenNodeIdentities.add(identity);
        nodePromotionByIdentity.set(identity, promoted);
      }
    }
    if (!Array.isArray(input.graph.edges)) {
      issues.push(`graph.edges must be an array, ${describe(input.graph.edges)}`);
    } else {
      for (const [index, edge] of input.graph.edges.entries()) {
        const path = `graph.edges[${index}]`;
        if (!isPlainObject(edge)) {
          issues.push(`${path} must be an object, ${describe(edge)}`);
          continue;
        }
        const from = readEndpoint(edge.from, `${path}.from`, issues);
        const to = readEndpoint(edge.to, `${path}.to`, issues);
        const kind = isNonEmptyString(edge.kind) ? edge.kind : null;
        const reason = isNonEmptyString(edge.reason) ? edge.reason : null;
        if (kind === null) {
          issues.push(`${path}.kind must be a non-empty string, ${describe(edge.kind)}`);
        }
        if (reason === null) {
          issues.push(`${path}.reason must be a non-empty string, ${describe(edge.reason)}`);
        }
        if (from === null || to === null || kind === null || reason === null) {
          continue;
        }
        edges.push({ from, to, reason });
      }
    }
  }

  // --- packagePolicy (required; no silent default) ---
  const packagePolicy = input.packagePolicy;
  if (packagePolicy !== "verified-only" && packagePolicy !== "verified-and-candidates") {
    issues.push(
      `packagePolicy must be "verified-only" or "verified-and-candidates" (required; there is no silent default), ${describe(packagePolicy)}`,
    );
  }

  // --- snapshot coverage: every snapshot package must have its graph node ---
  for (const view of packages) {
    const promoted = nodePromotionByIdentity.get(view.identity);
    if (promoted === undefined) {
      issues.push(
        `graph.nodes has no node for ${view.identity}; the compatibility graph must be the derived view of the registry snapshot`,
      );
      continue;
    }
    view.promoted = promoted;
  }

  if (issues.length > 0) {
    throw new CompositionError(
      "invalid-input",
      `the composition plan is not derivable from this input (${issues.length} ${
        issues.length === 1 ? "issue" : "issues"
      }); failing closed`,
      issues,
    );
  }
  if (verdict === null) {
    throw new CompositionError("invalid-input", "the composition verdict is unusable", [
      "verdict is unusable",
    ]);
  }
  return {
    verdict,
    packages,
    edges,
    packagePolicy: packagePolicy as CompositionPackagePolicy,
  };
}

// ---------------------------------------------------------------------------
// The composition derivation
// ---------------------------------------------------------------------------

/** Identity-stable rank order: promoted first, edges descending, then id/version. */
function compareSurvivorRank(
  a: PackageView,
  b: PackageView,
  incidentEdges: Map<string, number>,
): number {
  if (a.promoted !== b.promoted) {
    return a.promoted ? -1 : 1;
  }
  const aEdges = incidentEdges.get(a.identity) ?? 0;
  const bEdges = incidentEdges.get(b.identity) ?? 0;
  if (aEdges !== bEdges) {
    return bEdges - aEdges;
  }
  const byId = compareStrings(a.id, b.id);
  if (byId !== 0) {
    return byId;
  }
  return compareVersions(a.version, b.version);
}

/**
 * The archetype composition planner: derives the composition plan for one
 * detected archetype from the (verdict, snapshot, graph, policy) tuple.
 *
 * Pure and deterministic: the same input always yields a deep-equal plan, a
 * byte-identical canonical serialization and a stable `compositionDigest`,
 * whatever the snapshot's or graph's array order. Inputs are never mutated;
 * every carried value is a deep copy. Throws `CompositionError` (collecting
 * every issue) on structurally unusable input.
 */
export function planComposition(input: CompositionInput): CompositionPlan {
  const { verdict, packages, edges, packagePolicy } = validateCompositionInput(input);

  // Abstain first: never compose over an unknown label, never guess a category.
  if (verdict.label === "unknown") {
    return {
      status: "abstained",
      packageIds: [],
      reason:
        'abstained: the archetype verdict is "unknown" (no archetype reached the classification threshold); ' +
        "no composition is derived over an unknown label — vanilla synthesis proceeds without packages",
    };
  }

  // Category gate: the archetype label matches the package category verbatim.
  const sameCategory = packages.filter((view) => view.category === verdict.label);
  if (sameCategory.length === 0) {
    return {
      status: "fallback",
      packageIds: [],
      reason:
        `fallback: no package in the registry snapshot carries category "${verdict.label}" (the detected archetype); ` +
        "no compatible set exists — vanilla synthesis proceeds without packages",
    };
  }

  // Policy gate: verified-only admits only graph-promoted packages.
  const survivors =
    packagePolicy === "verified-only" ? sameCategory.filter((view) => view.promoted) : sameCategory;
  if (survivors.length === 0) {
    return {
      status: "fallback",
      packageIds: [],
      reason:
        `fallback: ${sameCategory.length} same-archetype package(s) carry category "${verdict.label}" ` +
        'but none is promoted and the package policy is "verified-only"; ' +
        "no compatible set exists — vanilla synthesis proceeds without packages",
    };
  }

  // Adjacency index over the survivor set (edges incident within it only).
  const survivorIdentities = new Set(survivors.map((view) => view.identity));
  const adjacency = new Map<string, Map<string, string[]>>();
  for (const edge of edges) {
    if (!survivorIdentities.has(edge.from) || !survivorIdentities.has(edge.to)) {
      continue;
    }
    for (const [a, b] of [
      [edge.from, edge.to],
      [edge.to, edge.from],
    ] as const) {
      let neighbors = adjacency.get(a);
      if (neighbors === undefined) {
        neighbors = new Map<string, string[]>();
        adjacency.set(a, neighbors);
      }
      const reasons = neighbors.get(b);
      if (reasons === undefined) {
        neighbors.set(b, [edge.reason]);
      } else {
        reasons.push(edge.reason);
      }
    }
  }

  const isAdjacent = (a: string, b: string): boolean => {
    const reasons = adjacency.get(a)?.get(b);
    return reasons !== undefined && reasons.length > 0;
  };

  // Incident edge counts within the survivor set (the ranking signal).
  const incidentEdges = new Map<string, number>();
  for (const view of survivors) {
    let count = 0;
    for (const [neighbor, reasons] of adjacency.get(view.identity) ?? []) {
      if (neighbor !== view.identity) {
        count += reasons.length;
      }
    }
    incidentEdges.set(view.identity, count);
  }

  const ranked = [...survivors].sort((a, b) => compareSurvivorRank(a, b, incidentEdges));

  // The selection scan walks the rank order.
  const selected: PackageView[] = [];
  const selectedCapabilities = new Set<string>();
  const notes: string[] = [];
  for (const [rank, view] of ranked.entries()) {
    if (rank === 0) {
      selected.push(view);
      for (const capability of view.capabilities) {
        selectedCapabilities.add(capability);
      }
      continue;
    }
    const alreadySelectedVersion = selected.find((entry) => entry.id === view.id)?.version;
    if (alreadySelectedVersion !== undefined) {
      notes.push(
        `skipped ${view.identity}: package id ${view.id} is already selected at ${alreadySelectedVersion} ` +
          "(SynthesisPlan.packageIds must stay unique)",
      );
      continue;
    }
    const notAdjacentTo = selected.filter((entry) => !isAdjacent(view.identity, entry.identity));
    if (notAdjacentTo.length > 0) {
      if ((incidentEdges.get(view.identity) ?? 0) === 0) {
        notes.push(
          `skipped ${view.identity}: isolated within the survivor set ` +
            "(no derivable compatibility edge to any other survivor); not part of the compatible set",
        );
      } else {
        notes.push(
          `skipped ${view.identity}: not graph-adjacent to every selected package ` +
            `(no derivable edge to ${notAdjacentTo.map((entry) => entry.identity).join(", ")})`,
        );
      }
      continue;
    }
    const contribution = view.capabilities.filter(
      (capability) => !selectedCapabilities.has(capability),
    );
    if (contribution.length === 0) {
      notes.push(
        `skipped ${view.identity}: contributes no capability the selection lacks (redundant slot)`,
      );
      continue;
    }
    selected.push(view);
    for (const capability of view.capabilities) {
      selectedCapabilities.add(capability);
    }
  }

  const anchor = selected[0];
  if (anchor === undefined) {
    throw new CompositionError("invalid-input", "the survivor set is empty after the scan", [
      "survivor set is empty after the scan",
    ]);
  }

  // Honest anchor accounting first, then the scan-order skip notes.
  if (survivors.length === 1) {
    notes.unshift(
      "the survivor set is the archetype anchor alone (no other same-archetype package survived the gates); " +
        "a single anchor is a compatible set",
    );
  } else if ((incidentEdges.get(anchor.identity) ?? 0) === 0) {
    notes.unshift(
      `the archetype anchor ${anchor.identity} carries no derivable compatibility edge to any other survivor; ` +
        "recorded isolated",
    );
  }

  // Provenance per selection, over the final selected set.
  const selections: CompositionSelection[] = selected.map((view, index) => {
    const reasons: string[] = [];
    for (const other of selected) {
      if (other.identity === view.identity) {
        continue;
      }
      const connected = adjacency.get(view.identity)?.get(other.identity);
      if (connected !== undefined) {
        reasons.push(...connected);
      }
    }
    reasons.sort(compareStrings);
    const isolated = reasons.length === 0;
    return {
      role: index === 0 ? "archetype-anchor" : "compatible-extension",
      packageId: view.id,
      version: view.version,
      provenance: {
        category: view.category,
        capabilities: [...view.capabilities],
        supportedTargets: [...view.supportedTargets],
        lifecycle: view.promoted ? ("promoted" as const) : ("candidate" as const),
        edgeReasons: reasons,
        note: isolated
          ? "no derivable compatibility edge connects this package to the rest of the selection; " +
            "recorded isolated (absence is neutral, never positive)"
          : `connected to the rest of the selection by ${reasons.length} derivable compatibility edge reason(s)`,
      },
    };
  });

  const packageIds = selected.map((view) => view.id);
  const compositionDigest = contentHash({
    status: "composed",
    selections,
    packageIds,
    notes,
  });
  return { status: "composed", selections, packageIds, notes, compositionDigest };
}
