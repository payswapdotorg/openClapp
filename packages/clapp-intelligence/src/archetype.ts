import type { BehavioralIr, Journey } from "@clapp/contracts";
import type { ExplorationResult } from "./explore.ts";
import { canonicalJson, compareStrings, isPlainObject } from "./json.ts";

/**
 * CLAPP-W2-004 — deterministic archetype classifier (the classifier half of
 * IMPLEMENTATION_PLAN Phase 7's archetype vocabulary; the labels are the
 * grouping key LEARNING.md's retrieval ranks by, and the grouping key behind
 * Phase 7's "repeated builds of the same archetype show lower effort" gate).
 *
 * `classifyFromIr` maps a BehavioralIr plus its optional W2-003 exploration
 * result onto one label of the frozen 11-archetype Phase 7 vocabulary. The
 * derivation is:
 *
 * - DETERMINISTIC — identical inputs produce deep-equal verdicts and
 *   byte-identical canonical serializations (a pure rules+scoring engine: no
 *   randomness, no model calls, no timestamps; every score is a fixed
 *   weighted ramp over the feature vector, ties break by label sort, and the
 *   rationale/citations are built in fixed construction order);
 * - HONEST (ARCHITECTURE.md section 6) — classification confidence respects
 *   evidence provenance: an IR whose api/state/data dimensions are empty with
 *   recorded assumptions (the sparse-honest wave-3 shape) caps confidence
 *   below 0.6 and the rationale says why; absence of a signal in a sparse
 *   dimension is NEUTRAL evidence, never positive; archetypes whose
 *   distinguishing channels (realtime transport, file activity, offline
 *   caches, auth journeys) carry no evidence kinds are channel-discounted;
 *   and "unknown" is emitted whenever no archetype reaches the threshold;
 * - PURE — the IR and the exploration result are never mutated; every
 *   returned object is fresh.
 *
 * Shape notes, mirroring the LANDED surfaces this composes:
 * - the journey model is the exploration result's when one is provided (its
 *   journeys supersede the IR's baselines and its stats carry the counts);
 *   otherwise the IR's own journeys are the model;
 * - screens follow the W2-002 shape (textChars carries the observed character
 *   count; null means unknown, never zero) plus the W2-003 `links` inventory
 *   convention (used for link density only when no exploration result is
 *   provided — an exploration result's linksFollowed+linksDeferred already
 *   covers every observed edge);
 * - formSignals counts form-like patterns over what the IR honestly carries:
 *   each step whose action's first segment is a form verb (fill/submit/type/
 *   select/check/uncheck/press/enter/set/clear/upload/choose/toggle), each
 *   step assertion carrying a POST-family method hint, and each POST-family
 *   method value in the api record's canonical JSON;
 * - apiSignals counts the non-empty records among the api and data dimensions
 *   (0-2); stateSignals is the non-empty state record plus the count of
 *   stateful journeys (non-empty preconditions, form-like steps, or
 *   state/storage/persist assertion keys);
 * - sparseDimensions lists every honestly-empty record dimension
 *   (api, components, data, integrations, state — alphabetical) as
 *   `${dimension} (empty; assumed: assumptions[i]:evId,...)` or
 *   `${dimension} (empty; no assumption recorded)`;
 * - citations split by surface: classifyArchetype (features only) cites the
 *   assumption refs and evidence ids embedded in sparseDimensions, while
 *   classifyFromIr additionally grounds citations in the IR's actual evidence
 *   ids (screen citations, form-step citations, and the evidenceIds arrays
 *   the api/data/state records carry) — same label, confidence, scores and
 *   rationale either way.
 */

/** One entry of the frozen Phase 7 archetype vocabulary. */
export interface ArchetypeDefinition {
  readonly label: string;
  readonly description: string;
}

/**
 * The closed archetype vocabulary — IMPLEMENTATION_PLAN Phase 7's eleven
 * initial archetypes, each with a one-line description. Frozen for this wave;
 * extending it is a vocabulary revision, not an edit.
 */
export const ARCHETYPES = [
  {
    label: "marketing/content site",
    description:
      "Multi-page content-first surface: text-heavy screens, link-driven navigation, and no form/api/state machinery.",
  },
  {
    label: "CRUD SaaS",
    description:
      "Stateful entity app: forms create, update and delete records through an API with persistent state.",
  },
  {
    label: "dashboard/admin",
    description:
      "Read-mostly console: several data views over api/state signals with light prose and few forms.",
  },
  {
    label: "realtime collaboration",
    description: "Multi-user live surface: concurrent state propagation over realtime channels.",
  },
  {
    label: "editor",
    description:
      "Single-surface editing: long content-editing journeys with rich form and state interactions.",
  },
  {
    label: "file/document app",
    description:
      "File-centric app: upload/download/binary handling over an API with stateful documents.",
  },
  {
    label: "PWA/offline",
    description:
      "Installable offline app: local-first state and cached screens that work without the network.",
  },
  {
    label: "API-heavy app",
    description:
      "Thin client over an API: most behavior flows through api records with minimal screens, text and links.",
  },
  {
    label: "auth/roles",
    description:
      "Identity-gated app: a small form-driven surface with session state and few screens.",
  },
  {
    label: "marketplace/catalog",
    description:
      "Catalog surface: many listing screens over api data with dense cross-linking and light text.",
  },
  {
    label: "workflow/operations system",
    description: "Operational board: stateful task queues driven by forms and API transitions.",
  },
] as const satisfies ReadonlyArray<ArchetypeDefinition>;

/** The union of the eleven frozen archetype labels. */
export type ArchetypeLabel = (typeof ARCHETYPES)[number]["label"];

/** One row of the per-kind evidence inventory. */
export interface EvidenceKindCount {
  kind: string;
  count: number;
}

/**
 * The deterministic archetype feature vector: the evidence-cited summary of
 * what the IR and exploration result honestly carry. All numeric features are
 * finite; float features are rounded to 4 decimals.
 */
export interface ArchetypeFeatures {
  screenCount: number;
  journeyCount: number;
  stepCount: number;
  avgStepsPerJourney: number;
  /** Observed link edges (followed + deferred) per screen. */
  linkDensity: number;
  /** Form-like step/assertion/api patterns. */
  formSignals: number;
  /** Non-empty records among the api and data dimensions (0-2). */
  apiSignals: number;
  /** Non-empty state record plus stateful journeys. */
  stateSignals: number;
  /** Average textChars per screen over screens carrying a known count. */
  textHeavy: number;
  entrypointCount: number;
  /** Per-kind evidence inventory, sorted by kind. */
  evidenceKinds: EvidenceKindCount[];
  /** Honestly-empty dimensions with their assumption citations. */
  sparseDimensions: string[];
}

/** One archetype's score row (score in 0..1, rounded to 4 decimals). */
export interface ArchetypeScore {
  label: string;
  score: number;
}

/**
 * The deterministic classification verdict. `label` is always an ARCHETYPES
 * value or "unknown"; `scores` carries all eleven archetypes sorted by score
 * descending then label ascending; `confidence` is the calibrated certainty
 * of the emitted label (capped below 0.6 for sparse-honest inputs); the
 * `rationale` cites the feature counts and the sparse dimensions that lowered
 * confidence; `evidenceCitations` carries the evidence ids / assumption paths
 * the verdict leaned on.
 */
export interface ArchetypeVerdict {
  label: string;
  confidence: number;
  scores: ArchetypeScore[];
  rationale: string;
  evidenceCitations: string[];
}

/** The classifier input: the IR plus the optional exploration result. */
export interface ArchetypeClassificationInput {
  ir: BehavioralIr;
  exploration?: ExplorationResult;
}

const UNKNOWN_LABEL = "unknown";
/** Labels at or above this score are classifiable; below it, "unknown". */
const UNKNOWN_THRESHOLD = 0.4;
/** Sparse-honest inputs (empty api/state/data with assumptions) cap below 0.6. */
const SPARSE_CONFIDENCE_CAP = 0.59;
/** Rules+scoring is a heuristic: confidence never claims certainty. */
const CONFIDENCE_CEILING = 0.95;
/** The record dimensions inventoried for sparsity (alphabetical). */
const SPARSE_DIMENSIONS = ["api", "components", "data", "integrations", "state"] as const;
/** Empty api/state/data dimensions cap confidence (the spec's named set). */
const CRITICAL_SPARSE_DIMENSIONS = ["api", "data", "state"] as const;
/** Step actions whose first segment is one of these are form-like. */
const FORM_ACTIONS = new Set([
  "fill",
  "submit",
  "type",
  "select",
  "check",
  "uncheck",
  "press",
  "enter",
  "set",
  "clear",
  "upload",
  "choose",
  "toggle",
]);
/** Mutation-carrying HTTP methods (the POST family). */
const POST_FAMILY_METHODS = new Set(["post", "put", "patch", "delete"]);
/** Assertion keys whose value may carry a POST-family method hint. */
const METHOD_ASSERTION_KEYS = new Set(["method", "verb", "httpmethod", "http_verb"]);
/** Assertion keys referencing state channels. */
const STATE_ASSERTION_KEY_PATTERN = /state|storage|persist/i;

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
const ramp = (value: number, low: number, high: number): number =>
  clamp01((value - low) / (high - low));
const rampDown = (value: number, low: number, high: number): number => 1 - ramp(value, low, high);
const round4 = (value: number): number => Math.round(value * 10000) / 10000;
const round2 = (value: number): number => Math.round(value * 100) / 100;

/**
 * The deterministic feature vector of an IR and its optional exploration
 * result. Throws a TypeError (naming the field) for structurally unusable
 * inputs; never mutates its inputs; never fabricates signals.
 */
export function extractArchetypeFeatures(input: ArchetypeClassificationInput): ArchetypeFeatures {
  const { ir, exploration } = input;
  requireClassifierIr(ir);
  if (exploration !== undefined) requireExplorationResult(exploration);

  const screens = parseScreensForFeatures(ir.screens);
  const journeys: readonly Journey[] =
    exploration !== undefined ? exploration.journeys : ir.journeys;
  const journeyCount =
    exploration !== undefined ? exploration.stats.journeys : countJourneys(ir.journeys);
  const stepCount =
    exploration !== undefined
      ? exploration.stats.steps
      : ir.journeys.reduce((total, journey) => {
          if (!isPlainObject(journey) || !Array.isArray(journey.steps)) return total;
          return total + journey.steps.length;
        }, 0);
  const avgStepsPerJourney = journeyCount > 0 ? round4(stepCount / journeyCount) : 0;

  const linkEdges =
    exploration !== undefined
      ? exploration.stats.linksFollowed + exploration.stats.linksDeferred
      : screens.reduce((total, screen) => total + screen.linkCount, 0);
  const linkDensity = screens.length > 0 ? round4(linkEdges / screens.length) : 0;

  const knownTextChars = screens.filter((screen) => screen.textChars !== null);
  const textHeavy =
    knownTextChars.length > 0
      ? round4(
          knownTextChars.reduce((total, screen) => total + (screen.textChars ?? 0), 0) /
            knownTextChars.length,
        )
      : 0;

  return {
    screenCount: screens.length,
    journeyCount,
    stepCount,
    avgStepsPerJourney,
    linkDensity,
    formSignals: countFormSignals(journeys, ir.api),
    apiSignals: (recordHasEntries(ir.api) ? 1 : 0) + (recordHasEntries(ir.data) ? 1 : 0),
    stateSignals: (recordHasEntries(ir.state) ? 1 : 0) + countStatefulJourneys(journeys),
    textHeavy,
    entrypointCount: distinctEntrypointCount(ir),
    evidenceKinds: evidenceKindCounts(ir.evidence),
    sparseDimensions: sparseDimensionEntries(ir),
  };
}

/**
 * Deterministic scoring of the feature vector over the closed vocabulary.
 * Every archetype gets a score in 0..1 (gate x weighted match x channel
 * factor); the verdict cites the feature counts, caps confidence for
 * sparse-honest inputs, and emits "unknown" below the threshold.
 */
export function classifyArchetype(features: ArchetypeFeatures): ArchetypeVerdict {
  requireFeatures(features);
  const sparse = new Set(features.sparseDimensions.map(sparseDimensionOf));
  const scored: ArchetypeScore[] = ARCHETYPE_SCORERS.map((scorer) => ({
    label: scorer.label,
    score: round4(channelFactor(scorer, features) * scorer.score(features, sparse)),
  }));
  scored.sort((left, right) => right.score - left.score || compareStrings(left.label, right.label));

  const top = scored[0];
  const criticalSparse = CRITICAL_SPARSE_DIMENSIONS.filter((dimension) => sparse.has(dimension));
  const capped = criticalSparse.length > 0;
  const label = top.score >= UNKNOWN_THRESHOLD ? top.label : UNKNOWN_LABEL;
  const confidence = round4(
    Math.min(top.score, capped ? SPARSE_CONFIDENCE_CAP : CONFIDENCE_CEILING),
  );

  return {
    label,
    confidence,
    scores: scored,
    rationale: buildRationale(features, scored, label, criticalSparse),
    evidenceCitations: sparseDimensionCitations(features.sparseDimensions),
  };
}

/**
 * The composed convenience: extract the features, classify, and ground the
 * citations in the IR's actual evidence ids. Identical to
 * classifyArchetype(extractArchetypeFeatures(input)) in label, confidence,
 * scores and rationale; only evidenceCitations is enriched.
 */
export function classifyFromIr(input: ArchetypeClassificationInput): ArchetypeVerdict {
  const verdict = classifyArchetype(extractArchetypeFeatures(input));
  const citations = [...irGroundedCitations(input), ...verdict.evidenceCitations];
  const deduped: string[] = [];
  for (const citation of citations) {
    if (!deduped.includes(citation)) deduped.push(citation);
  }
  return { ...verdict, evidenceCitations: deduped };
}

// --- Feature-extraction helpers -------------------------------------------------

interface FeatureScreen {
  textChars: number | null;
  linkCount: number;
}

/** Tolerant screen parse: known textChars and the deduped link inventory size. */
function parseScreensForFeatures(raw: Record<string, unknown>[]): FeatureScreen[] {
  const screens: FeatureScreen[] = [];
  for (const entry of raw) {
    if (!isPlainObject(entry)) continue;
    const textChars =
      typeof entry.textChars === "number" && Number.isFinite(entry.textChars)
        ? entry.textChars
        : null;
    screens.push({ textChars, linkCount: parseLinkCount(entry.links) });
  }
  return screens;
}

/** The distinct link targets a screen's inventory carries (W2-003 convention). */
function parseLinkCount(value: unknown): number {
  if (!Array.isArray(value)) return 0;
  const urls: string[] = [];
  for (const entry of value) {
    let url: unknown = entry;
    if (isPlainObject(entry)) url = entry.url;
    if (typeof url !== "string" || url === "") continue;
    if (!urls.includes(url)) urls.push(url);
  }
  return urls.length;
}

/** Journeys that are plain objects with a steps array (the honest model). */
function countJourneys(journeys: readonly Journey[]): number {
  return journeys.filter((journey) => isPlainObject(journey)).length;
}

/** True when the record is a plain object carrying at least one key. */
function recordHasEntries(record: unknown): boolean {
  return isPlainObject(record) && Object.keys(record).length > 0;
}

/** Form-like patterns: form-verb steps, POST-family assertions, POST-family api values. */
function countFormSignals(journeys: readonly Journey[], apiRecord: unknown): number {
  let count = 0;
  for (const journey of journeys) {
    if (!isPlainObject(journey) || !Array.isArray(journey.steps)) continue;
    for (const step of journey.steps) {
      if (!isPlainObject(step)) continue;
      if (isFormAction(step.action)) count += 1;
      if (hasPostFamilyAssertion(step.assertions)) count += 1;
    }
  }
  return count + countPostFamilyApiHints(apiRecord);
}

/** The action's first segment (fill, submit-form, type-input, ...) is a form verb. */
function isFormAction(action: unknown): boolean {
  if (typeof action !== "string" || action === "") return false;
  const head = action.split(/[-_:;\s]+/)[0];
  return head !== undefined && FORM_ACTIONS.has(head.toLowerCase());
}

/** A step assertion carries a POST-family method hint. */
function hasPostFamilyAssertion(assertions: unknown): boolean {
  if (!isPlainObject(assertions)) return false;
  for (const key of Object.keys(assertions)) {
    if (!METHOD_ASSERTION_KEYS.has(key.toLowerCase())) continue;
    const value = assertions[key];
    if (typeof value === "string" && POST_FAMILY_METHODS.has(value.toLowerCase())) return true;
  }
  return false;
}

/** POST-family method values in the api record's canonical JSON. */
function countPostFamilyApiHints(apiRecord: unknown): number {
  if (!recordHasEntries(apiRecord)) return 0;
  const text = canonicalJson(apiRecord);
  if (text === undefined) return 0;
  return [...text.matchAll(/"(?:method|verb|httpMethod|http_verb)":"(?:post|put|patch|delete)"/gi)]
    .length;
}

/** Journeys with preconditions, form-like steps, or state-channel assertions. */
function countStatefulJourneys(journeys: readonly Journey[]): number {
  let count = 0;
  for (const journey of journeys) {
    if (!isPlainObject(journey)) continue;
    if (hasStatefulPreconditions(journey)) {
      count += 1;
      continue;
    }
    const steps = Array.isArray(journey.steps) ? journey.steps : [];
    const stateful = steps.some((step) => {
      if (!isPlainObject(step)) return false;
      if (isFormAction(step.action)) return true;
      return (
        isPlainObject(step.assertions) &&
        Object.keys(step.assertions).some((key) => STATE_ASSERTION_KEY_PATTERN.test(key))
      );
    });
    if (stateful) count += 1;
  }
  return count;
}

function hasStatefulPreconditions(journey: Record<string, unknown>): boolean {
  const preconditions = journey.preconditions;
  return (
    Array.isArray(preconditions) &&
    preconditions.some((entry) => typeof entry === "string" && entry !== "")
  );
}

/** Per-kind evidence counts, sorted by kind (deterministic inventory). */
function evidenceKindCounts(refs: readonly unknown[]): EvidenceKindCount[] {
  const counts = new Map<string, number>();
  for (const ref of refs) {
    if (!isPlainObject(ref)) continue;
    const kind = typeof ref.kind === "string" && ref.kind !== "" ? ref.kind : "unknown";
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((left, right) => compareStrings(left.kind, right.kind));
}

/** The honestly-empty dimensions with their assumption citations (alphabetical). */
function sparseDimensionEntries(ir: BehavioralIr): string[] {
  const entries: string[] = [];
  for (const dimension of SPARSE_DIMENSIONS) {
    if (!isSparseDimension(ir, dimension)) continue;
    const refs = assumptionRefsFor(ir.assumptions, dimension);
    entries.push(
      refs.length === 0
        ? `${dimension} (empty; no assumption recorded)`
        : `${dimension} (empty; assumed: ${refs.join("; ")})`,
    );
  }
  return entries;
}

/** api/components/data/integrations/state emptiness by contract shape. */
function isSparseDimension(ir: BehavioralIr, dimension: string): boolean {
  if (dimension === "components" || dimension === "integrations") {
    const value = ir[dimension];
    return !Array.isArray(value) || value.length === 0;
  }
  return !recordHasEntries(ir[dimension as "api" | "data" | "state"]);
}

/** `assumptions[i]:evId,...` refs for the assumptions recording a dimension. */
function assumptionRefsFor(assumptions: readonly unknown[], dimension: string): string[] {
  const refs: string[] = [];
  for (let index = 0; index < assumptions.length; index += 1) {
    const assumption = assumptions[index];
    if (!isPlainObject(assumption)) continue;
    if (String(assumption.path) !== dimension) continue;
    const evidenceIds = Array.isArray(assumption.evidenceIds)
      ? assumption.evidenceIds.filter((id) => typeof id === "string" && id !== "")
      : [];
    refs.push(
      evidenceIds.length > 0
        ? `assumptions[${index}]:${(evidenceIds as string[]).join(",")}`
        : `assumptions[${index}]`,
    );
  }
  return refs;
}

/** Distinct non-empty entrypoint strings. */
function distinctEntrypointCount(ir: BehavioralIr): number {
  const application = ir.application;
  if (!isPlainObject(application)) return 0;
  const entrypoints = application.entrypoints;
  if (!Array.isArray(entrypoints)) return 0;
  const seen = new Set<string>();
  for (const entrypoint of entrypoints) {
    if (typeof entrypoint === "string" && entrypoint !== "") seen.add(entrypoint);
  }
  return seen.size;
}

// --- Scoring helpers --------------------------------------------------------------

/** The dimension name of a sparseDimensions entry. */
function sparseDimensionOf(entry: string): string {
  const cut = entry.indexOf(" (");
  return cut === -1 ? entry : entry.slice(0, cut);
}

/** Absence of form steps is weak evidence of formlessness (digest-only captures). */
const formAbsence = (formSignals: number): number => 0.75 * rampDown(formSignals, 0, 3);

/** Absence in a sparse dimension is neutral; observed absence declines with signals. */
const channelAbsence = (signals: number, sparse: boolean, saturation: number): number =>
  sparse ? 0.5 : rampDown(signals, 0, saturation);

interface ArchetypeScorer {
  readonly label: ArchetypeLabel;
  /** A channel discount applied while the IR carries no matching evidence kind. */
  readonly channel?: { readonly factor: number; readonly pattern: RegExp };
  score(features: ArchetypeFeatures, sparse: ReadonlySet<string>): number;
}

/**
 * The closed scoring table: every archetype's required-evidence gate, its
 * weighted match terms (weights sum to 1), and its channel factor. Calibrated
 * so the B01-like profile (multi-page, text-heavy, no forms/api/state) scores
 * marketing/content site highest and the B02-like profile (forms + api +
 * state) scores CRUD SaaS highest.
 */
const ARCHETYPE_SCORERS: ReadonlyArray<ArchetypeScorer> = [
  {
    label: "marketing/content site",
    score: (f, sparse) => {
      const gate = Math.min(ramp(f.screenCount, 1, 2), ramp(f.linkDensity, 0.5, 1.5));
      if (gate === 0) return 0;
      const match =
        0.22 * ramp(f.screenCount, 1, 4) +
        0.22 * ramp(f.textHeavy, 250, 1200) +
        0.16 * ramp(f.linkDensity, 1, 3) +
        0.1 * ramp(f.journeyCount, 1, 4) +
        0.1 * formAbsence(f.formSignals) +
        0.1 * channelAbsence(f.apiSignals, sparse.has("api"), 2) +
        0.1 * channelAbsence(f.stateSignals, sparse.has("state"), 3);
      return gate * match;
    },
  },
  {
    label: "CRUD SaaS",
    score: (f) => {
      const gate = Math.min(
        ramp(f.formSignals, 0, 1),
        ramp(f.apiSignals, 0, 1),
        ramp(f.stateSignals, 0, 1),
      );
      if (gate === 0) return 0;
      const match =
        0.32 * ramp(f.formSignals, 1, 3) +
        0.24 * ramp(f.apiSignals, 1, 2) +
        0.2 * ramp(f.stateSignals, 1, 2) +
        0.08 * rampDown(f.screenCount, 6, 20) +
        0.08 * rampDown(f.textHeavy, 900, 2200) +
        0.08 * ramp(f.avgStepsPerJourney, 1.5, 3);
      return gate * match;
    },
  },
  {
    label: "dashboard/admin",
    score: (f) => {
      const gate = Math.min(ramp(f.apiSignals, 0, 1), ramp(f.screenCount, 1, 3));
      if (gate === 0) return 0;
      const match =
        0.26 * ramp(f.apiSignals, 1, 2) +
        0.18 * rampDown(f.textHeavy, 500, 1500) +
        0.16 * ramp(f.screenCount, 2, 6) +
        0.14 * ramp(f.stateSignals, 1, 3) +
        0.12 * formAbsence(f.formSignals) +
        0.14 * ramp(f.linkDensity, 0.5, 2);
      return gate * match;
    },
  },
  {
    label: "realtime collaboration",
    channel: {
      factor: 0.45,
      pattern:
        /websocket|\bsocket\b|\bsse\b|realtime|real-time|\bpush\b|\bpubsub\b|\blive\b|\bstream\b/i,
    },
    score: (f) => {
      const gate = Math.min(
        ramp(f.stateSignals, 0, 1),
        ramp(f.apiSignals, 0, 1),
        ramp(f.journeyCount, 1, 3),
      );
      if (gate === 0) return 0;
      const match =
        0.35 * ramp(f.stateSignals, 1, 3) +
        0.25 * ramp(f.apiSignals, 1, 2) +
        0.2 * ramp(f.formSignals, 2, 6) +
        0.1 * ramp(f.journeyCount, 2, 6) +
        0.1 * rampDown(f.screenCount, 6, 20);
      return gate * match;
    },
  },
  {
    label: "editor",
    channel: {
      factor: 0.55,
      pattern: /editor|contenteditable|rich.?text|prosemirror|tiptap|\bcanvas\b/i,
    },
    score: (f) => {
      const gate = Math.min(ramp(f.formSignals, 1, 2), rampDown(f.screenCount, 4, 12));
      if (gate === 0) return 0;
      const match =
        0.3 * ramp(f.formSignals, 2, 8) +
        0.22 * ramp(f.avgStepsPerJourney, 2, 5) +
        0.2 * ramp(f.textHeavy, 500, 2000) +
        0.14 * rampDown(f.screenCount, 3, 10) +
        0.14 * ramp(f.stateSignals, 1, 3);
      return gate * match;
    },
  },
  {
    label: "file/document app",
    channel: {
      factor: 0.4,
      pattern: /file|upload|download|blob|binary|attachment|\bpdf\b|media/i,
    },
    score: (f) => {
      const gate = ramp(f.apiSignals, 0, 1);
      if (gate === 0) return 0;
      const match =
        0.35 * ramp(f.apiSignals, 1, 2) +
        0.25 * ramp(f.formSignals, 1, 4) +
        0.2 * ramp(f.stateSignals, 1, 3) +
        0.2 * rampDown(f.textHeavy, 800, 2000);
      return gate * match;
    },
  },
  {
    label: "PWA/offline",
    channel: {
      factor: 0.4,
      pattern: /service.?worker|\bmanifest\b|offline|\bcache\b|\bpwa\b|\bsw\b/i,
    },
    score: (f) => {
      const gate = ramp(f.stateSignals, 0, 1);
      if (gate === 0) return 0;
      const match =
        0.35 * ramp(f.stateSignals, 1, 3) +
        0.25 * ramp(f.formSignals, 1, 4) +
        0.2 * ramp(f.screenCount, 2, 6) +
        0.2 * ramp(f.journeyCount, 2, 6);
      return gate * match;
    },
  },
  {
    label: "API-heavy app",
    score: (f) => {
      const gate = ramp(f.apiSignals, 0, 1);
      if (gate === 0) return 0;
      const match =
        0.3 * ramp(f.apiSignals, 1, 2) +
        0.2 * rampDown(f.screenCount, 2, 8) +
        0.15 * rampDown(f.textHeavy, 300, 900) +
        0.15 * rampDown(f.formSignals, 2, 6) +
        0.1 * rampDown(f.linkDensity, 2, 5) +
        0.1 * rampDown(f.journeyCount, 3, 8);
      return gate * match;
    },
  },
  {
    label: "auth/roles",
    channel: {
      factor: 0.75,
      pattern: /auth|session|login|identity|token|oauth|sso|role|permission|credential/i,
    },
    score: (f) => {
      const gate = ramp(f.formSignals, 1, 2);
      if (gate === 0) return 0;
      const match =
        0.45 * ramp(f.formSignals, 1, 2) +
        0.2 * rampDown(f.screenCount, 2, 6) +
        0.15 * rampDown(f.textHeavy, 300, 900) +
        0.1 * rampDown(f.linkDensity, 2, 4) +
        0.1 * ramp(f.stateSignals, 1, 2);
      return gate * match;
    },
  },
  {
    label: "marketplace/catalog",
    channel: {
      factor: 0.45,
      pattern: /marketplace|catalog|listing|product|\bcart\b|checkout|commerce|inventory|\bshop\b/i,
    },
    score: (f) => {
      const gate = Math.min(ramp(f.apiSignals, 0, 1), ramp(f.screenCount, 2, 4));
      if (gate === 0) return 0;
      const match =
        0.3 * ramp(f.screenCount, 3, 12) +
        0.25 * ramp(f.apiSignals, 1, 2) +
        0.2 * ramp(f.formSignals, 1, 3) +
        0.15 * ramp(f.linkDensity, 2, 6) +
        0.1 * rampDown(f.textHeavy, 600, 1500);
      return gate * match;
    },
  },
  {
    label: "workflow/operations system",
    channel: {
      factor: 0.8,
      pattern:
        /workflow|queue|\bjob\b|scheduler|kanban|\bboard\b|operations|\bops\b|process|pipeline|\btask\b/i,
    },
    score: (f) => {
      const gate = Math.min(ramp(f.stateSignals, 0, 1), ramp(f.formSignals, 0, 1));
      if (gate === 0) return 0;
      const match =
        0.28 * ramp(f.stateSignals, 1, 3) +
        0.22 * ramp(f.formSignals, 1, 4) +
        0.18 * ramp(f.apiSignals, 1, 2) +
        0.12 * ramp(f.avgStepsPerJourney, 2, 4) +
        0.1 * rampDown(f.textHeavy, 700, 1800) +
        0.1 * rampDown(f.screenCount, 8, 20);
      return gate * match;
    },
  },
];

/** 1 while the IR carries no evidence kind of the archetype's channel. */
function channelFactor(scorer: ArchetypeScorer, features: ArchetypeFeatures): number {
  if (scorer.channel === undefined) return 1;
  const carries = features.evidenceKinds.some((row) => scorer.channel?.pattern.test(row.kind));
  return carries ? 1 : scorer.channel.factor;
}

/** Assumption refs and evidence ids embedded in the sparseDimensions entries. */
function sparseDimensionCitations(entries: readonly string[]): string[] {
  const citations: string[] = [];
  for (const entry of entries) {
    const dimension = sparseDimensionOf(entry);
    for (const match of entry.matchAll(/assumptions\[(\d+)\](?::([^;)]+))?/g)) {
      citations.push(`assumptions[${match[1]}]:${dimension}`);
      const ids = match[2];
      if (ids === undefined) continue;
      for (const id of ids.split(",")) {
        if (id !== "") citations.push(id);
      }
    }
  }
  return citations;
}

/** The IR evidence ids the verdict's features were derived from. */
function irGroundedCitations(input: ArchetypeClassificationInput): string[] {
  const { ir, exploration } = input;
  const known = new Set<string>();
  for (const ref of ir.evidence) {
    if (isPlainObject(ref) && typeof ref.id === "string" && ref.id !== "") known.add(ref.id);
  }
  const citations: string[] = [];
  const pushKnown = (ids: readonly unknown[]): void => {
    for (const id of ids) {
      if (typeof id === "string" && id !== "" && known.has(id)) citations.push(id);
    }
  };

  for (const screen of ir.screens) {
    if (!isPlainObject(screen)) continue;
    if (Array.isArray(screen.evidenceIds)) pushKnown(screen.evidenceIds);
  }
  const journeys: readonly Journey[] =
    exploration !== undefined ? exploration.journeys : ir.journeys;
  for (const journey of journeys) {
    if (!isPlainObject(journey) || !Array.isArray(journey.steps)) continue;
    for (const step of journey.steps) {
      if (!isPlainObject(step)) continue;
      if (!isFormAction(step.action) && !hasPostFamilyAssertion(step.assertions)) continue;
      if (isPlainObject(step.assertions) && Array.isArray(step.assertions.evidenceIds)) {
        pushKnown(step.assertions.evidenceIds);
      }
    }
  }
  for (const record of [ir.api, ir.data, ir.state]) {
    if (recordHasEntries(record) && Array.isArray(record.evidenceIds)) {
      pushKnown(record.evidenceIds);
    }
  }
  return citations;
}

// --- Rationale -------------------------------------------------------------------

/** The deterministic rationale: counts, evidence kinds, caps, insufficiency. */
function buildRationale(
  features: ArchetypeFeatures,
  scored: readonly ArchetypeScore[],
  label: string,
  criticalSparse: readonly string[],
): string {
  const top = scored[0];
  const runnerUp = scored[1];
  const parts: string[] = [];
  parts.push(
    top.score === 0
      ? `no archetype scored above 0 (label-sorted zero ties led by "${top.label}")`
      : `top match "${top.label}" scored ${top.score}`,
  );
  if (runnerUp !== undefined && runnerUp.score > 0) {
    parts.push(`runner-up "${runnerUp.label}" ${runnerUp.score}`);
  } else {
    parts.push("no other archetype scored above 0");
  }
  parts.push(
    `features: screens=${features.screenCount}, journeys=${features.journeyCount}, ` +
      `steps=${features.stepCount} (avg ${round2(features.avgStepsPerJourney)} per journey), ` +
      `linkDensity=${round2(features.linkDensity)}, formSignals=${features.formSignals}, ` +
      `apiSignals=${features.apiSignals}, stateSignals=${features.stateSignals}, ` +
      `textChars/screen=${round2(features.textHeavy)}, entrypoints=${features.entrypointCount}`,
  );
  const kinds = features.evidenceKinds.map((row) => `${row.kind} x${row.count}`).join(", ");
  parts.push(`evidence kinds: ${kinds === "" ? "none" : kinds}`);
  if (criticalSparse.length > 0) {
    parts.push(
      `confidence capped at ${SPARSE_CONFIDENCE_CAP} by sparse dimensions: ` +
        `${criticalSparse.join(", ")} — empty IR dimensions lower certainty ` +
        "(the cited assumptions record why; see evidenceCitations)",
    );
  }
  if (label === UNKNOWN_LABEL) {
    parts.push(
      `no archetype reached the ${UNKNOWN_THRESHOLD} threshold (top "${top.label}" ${top.score}): ` +
        "the evidence is insufficient for any archetype label",
    );
  }
  return `${parts.join("; ")}.`;
}

// --- Guards ----------------------------------------------------------------------

/** Fail-closed structural guards over the classifier input IR. */
function requireClassifierIr(ir: BehavioralIr): void {
  if (!isPlainObject(ir)) {
    throw new TypeError("archetype classification requires a BehavioralIr object");
  }
  for (const field of ["journeys", "screens", "evidence", "assumptions"] as const) {
    if (!Array.isArray(ir[field])) {
      throw new TypeError(`archetype classification requires ir.${field} to be an array`);
    }
  }
}

/** Fail-closed structural guards over the optional exploration result. */
function requireExplorationResult(exploration: ExplorationResult): void {
  if (!isPlainObject(exploration)) {
    throw new TypeError("archetype classification requires an ExplorationResult object");
  }
  if (!Array.isArray(exploration.journeys)) {
    throw new TypeError("archetype classification requires exploration.journeys to be an array");
  }
  const stats = exploration.stats;
  if (!isPlainObject(stats)) {
    throw new TypeError("archetype classification requires exploration.stats to be an object");
  }
  for (const field of ["journeys", "steps", "linksFollowed", "linksDeferred"] as const) {
    const value = stats[field];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      throw new TypeError(
        `archetype classification requires exploration.stats.${field} to be a non-negative integer`,
      );
    }
  }
}

/** Fail-closed structural guards over a feature vector. */
function requireFeatures(features: ArchetypeFeatures): void {
  if (!isPlainObject(features)) {
    throw new TypeError("classifyArchetype requires an ArchetypeFeatures object");
  }
  for (const field of [
    "screenCount",
    "journeyCount",
    "stepCount",
    "avgStepsPerJourney",
    "linkDensity",
    "formSignals",
    "apiSignals",
    "stateSignals",
    "textHeavy",
    "entrypointCount",
  ] as const) {
    const value = features[field];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new TypeError(`classifyArchetype requires features.${field} to be a finite number`);
    }
  }
  for (const field of ["evidenceKinds", "sparseDimensions"] as const) {
    if (!Array.isArray(features[field])) {
      throw new TypeError(`classifyArchetype requires features.${field} to be an array`);
    }
  }
}
