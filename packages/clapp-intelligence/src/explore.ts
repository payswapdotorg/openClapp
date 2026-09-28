import type { BehavioralIr, Journey, JourneyStep } from "@clapp/contracts";
import { canonicalJson, compareStrings, isPlainObject, sha256Hex } from "./json.ts";
import { validateBehavioralIr } from "./validate.ts";

/**
 * CLAPP-W2-003 — deterministic exploration and journey model (the exploration
 * half of IMPLEMENTATION_PLAN Phase 3; evidence-to-IR extraction is W2-002).
 *
 * `explore` deepens the IR's baseline journeys from the screens and evidence
 * the IR already carries. The derivation is:
 *
 * - DETERMINISTIC — identical (ir, seed, budget) produce deep-equal results and
 *   byte-identical canonical serializations (no timestamps, no random ids; every
 *   derived journey id is a content hash, every step id a position-stable
 *   counter; the seed only tie-breaks candidates whose (entrypoint,
 *   followed-path) sort keys are EQUAL — for the W2-002 shape, one baseline
 *   journey per entrypoint, no equal keys exist and the seed is inert: the seed
 *   never invents steps);
 * - HONEST (ARCHITECTURE.md section 6) — a link becomes a journey step only when
 *   its target URL is an observed screen carrying evidence citations; step
 *   assertions claim only what observed page evidence can prove (url/title via
 *   page-meta; textContains is reserved for a content-bearing extraction and is
 *   never fabricated from a digest); unobserved targets, unavailable channels
 *   and budget truncations become explicit assumptions, and unexercised
 *   candidate links land in the deferred inventory — never silent gaps;
 * - PURE — the IR, the seed and the budget are never mutated; every derived
 *   object is fresh.
 *
 * Screen input convention: alongside the W2-002 screen shape (entrypoint, url,
 * title, textDigest, textChars, truncated, evidenceIds), exploration reads the
 * optional `links` array — the per-screen anchor-target inventory a
 * content-bearing extraction would emit (plain URL strings, or objects carrying
 * a `url` field; first occurrence wins, order is observation order). A screen
 * without a `links` field carries no link inventory (no deepening from it, and
 * the global gap is recorded when no screen has one); `links: []` means the
 * page was observed to have no links.
 *
 * Budget semantics: `maxJourneys` bounds the DEEPENED variants exploration
 * produces; baselines that cannot be deepened (or whose variants were all
 * dropped by the cap) are carried verbatim so observed behavior is never lost —
 * carried journeys do not count against `maxJourneys`. `maxStepsPerJourney`
 * bounds the total steps of each produced journey (carried baseline steps
 * included).
 */

/** The exploration budget: caps the journeys and steps exploration produces. */
export interface ExplorationBudget {
  maxJourneys: number;
  maxStepsPerJourney: number;
}

/** The single input of the exploration stage. */
export interface ExplorationInput {
  ir: BehavioralIr;
  seed: number;
  budget: ExplorationBudget;
}

/** One observed candidate link no selected journey exercised (never dropped silently). */
export type DeferredLink = {
  fromUrl: string | null;
  targetUrl: string;
};

/** Honest bookkeeping of what exploration produced and what it left unexplored. */
export interface ExplorationStats {
  journeys: number;
  steps: number;
  linksFollowed: number;
  linksDeferred: number;
}

/** An exploration assumption (source is always "exploration"; extra fields are contextual). */
export type ExplorationAssumption = {
  source: "exploration";
  reason: string;
  path: string;
  evidenceIds?: string[];
  kind?: string;
  fromUrl?: string | null;
  targetUrl?: string;
  journeyId?: string;
  budget?: number;
};

/** The deterministic deepening of one IR's journeys, with its honesty records. */
export interface ExplorationResult {
  /** Deepened journeys (replaces the IR's baseline journeys when composed). */
  journeys: Journey[];
  assumptions: ExplorationAssumption[];
  deferred: DeferredLink[];
  /** sha256 over the canonical journey+screen feature summary (archetype-ready). */
  featureDigest: string;
  stats: ExplorationStats;
}

/** One row of the journey evidence-coverage audit. */
export interface JourneyCoverage {
  journeyId: string;
  steps: number;
  citedEvidence: number;
  uncitedSteps: number;
}

interface ParsedScreen {
  index: number;
  identity: string;
  screenId: string | null;
  entrypoint: string | null;
  url: string | null;
  title: string | null;
  textDigest: string | null;
  truncated: boolean;
  textChars: number | null;
  evidenceIds: string[];
  linkUrls: string[] | null;
}

interface JourneySlot {
  journey: Journey;
  entrypointKey: string;
  path: readonly string[];
  rank: string;
}

interface CandidateVariant {
  slot: JourneySlot;
  baselineIndex: number;
  edges: string[];
}

interface ChainHop {
  screen: ParsedScreen;
  url: string;
}

const UNAVAILABLE_CHANNEL_CAPABILITIES: ReadonlyArray<{ kind: string; capability: string }> = [
  {
    kind: "dom-structure",
    capability: "journey steps cannot assert DOM structure facts (anchor and form markup)",
  },
  {
    kind: "a11y",
    capability: "journey steps cannot assert accessibility semantics (roles and labels)",
  },
  {
    kind: "network",
    capability: "form-submission and API journeys cannot be derived (no network observation)",
  },
  {
    kind: "storage",
    capability: "journey preconditions cannot reference observed state (no storage observation)",
  },
];
const FEATURE_SUMMARY_KIND = "clapp-exploration-features";
const FEATURE_SUMMARY_VERSION = 1;

/**
 * Deterministic deepening of the IR's journeys from its screens/evidence.
 * Throws a TypeError (naming the field) for structurally unusable inputs;
 * never mutates its inputs; never fabricates steps, assertions or observations.
 */
export function explore(input: ExplorationInput): ExplorationResult {
  const { ir, seed, budget } = input;
  requireBehavioralIrShape(ir);
  requireSeed(seed);
  requireBudget(budget);

  const knownEvidenceIds = new Set<string>();
  for (const ref of ir.evidence) {
    if (isPlainObject(ref) && typeof ref.id === "string" && ref.id !== "") {
      knownEvidenceIds.add(ref.id);
    }
  }

  const screens = parseScreens(ir.screens, knownEvidenceIds);
  const byUrl = new Map<string, ParsedScreen>();
  for (const screen of screens) {
    if (screen.url !== null && !byUrl.has(screen.url)) byUrl.set(screen.url, screen);
  }

  const assumptions: ExplorationAssumption[] = [];
  const seedRank = (id: string): string => sha256Hex(`${seed}\u0000${id}`);

  // 1. Unavailable observation channels are explicit uncertainty for journeys
  //    (the source note travels verbatim; no assertion ever claims them).
  for (const channel of UNAVAILABLE_CHANNEL_CAPABILITIES) {
    const refs = ir.evidence.filter(
      (ref) =>
        isPlainObject(ref) && ref.kind === channel.kind && ref.classification === "unavailable",
    );
    if (refs.length === 0) continue;
    assumptions.push({
      source: "exploration",
      path: "journeys",
      reason: `${channel.capability}: the "${channel.kind}" channel is unavailable ("${refs[0].source}")`,
      kind: channel.kind,
      evidenceIds: refs.map((ref) => ref.id),
    });
  }

  // 2. Content-access honesty: what the digest-only screen shape cannot give.
  if (screens.length > 0) {
    if (screens.every((screen) => screen.linkUrls === null)) {
      assumptions.push({
        source: "exploration",
        path: "journeys",
        reason:
          "no screen carries a link inventory: page content (anchor targets, form fields) is not exposed to exploration - screens carry content digests only, so journeys remain baseline depth (a contract revision exposing observed page content to exploration is proposed)",
      });
    }
    assumptions.push({
      source: "exploration",
      path: "journeys",
      reason:
        "journey assertions are limited to url/title facts: observed page text reaches exploration as digests only, so no step asserts textContains and no form-field steps are derived (form interactions, where present, remain recorded uncertainty, never steps)",
    });
  }

  // 3. Link-level honesty: unobserved and unciteable targets never become steps.
  for (const screen of screens) {
    if (screen.linkUrls === null) continue;
    for (const targetUrl of screen.linkUrls) {
      const target = byUrl.get(targetUrl);
      if (target !== undefined && target.evidenceIds.length > 0) continue;
      const cause =
        target === undefined
          ? "no observed screen carries this URL (unobserved target)"
          : "the target screen cites no evidence present in this IR, so the step would be uncited";
      assumptions.push({
        source: "exploration",
        path: "journeys",
        reason: `link from "${describeScreen(screen)}" to "${targetUrl}" cannot become a journey step: ${cause}; recorded as an assumption and deferred, never fabricated`,
        fromUrl: screen.url,
        targetUrl,
        evidenceIds: [...screen.evidenceIds],
      });
    }
  }

  // 4. Deepen each baseline journey from its landing screen: one variant per
  //    distinct observed first link target, each continued as a single
  //    deterministic chain (first-occurrence observation order, no revisits).
  const variantsByBaseline: CandidateVariant[][] = ir.journeys.map(() => []);
  const carriedSlots: JourneySlot[] = [];
  const truncatedJourneyIds: string[] = [];
  const landings: (ParsedScreen | null)[] = [];
  for (let index = 0; index < ir.journeys.length; index += 1) {
    const baseline = ir.journeys[index];
    const landing = resolveLandingScreen(baseline, byUrl, screens);
    landings.push(landing);
    if (landing === null) {
      assumptions.push({
        source: "exploration",
        path: "journeys",
        reason: `journey "${baseline.id}" could not be deepened: no observed screen matches its step targets by url or entrypoint, so no landing screen can be attributed; the journey is carried unchanged`,
        journeyId: baseline.id,
      });
      carriedSlots.push(carrySlot(baseline, landing, seedRank));
      continue;
    }
    const candidates = candidateFirstTargets(landing, byUrl);
    const followBudget = budget.maxStepsPerJourney - baseline.steps.length;
    if (candidates.length === 0 || followBudget <= 0) {
      if (candidates.length > 0) truncatedJourneyIds.push(baseline.id);
      carriedSlots.push(carrySlot(baseline, landing, seedRank));
      continue;
    }
    variantsByBaseline[index] = buildCandidateVariants(
      baseline,
      index,
      landing,
      byUrl,
      followBudget,
      truncatedJourneyIds,
      seedRank,
    );
  }

  // 5. Step-budget honesty (chains stopped early, or deepening that could not start).
  if (truncatedJourneyIds.length > 0) {
    const unique = [...new Set(truncatedJourneyIds)].sort(compareStrings);
    assumptions.push({
      source: "exploration",
      path: "journeys",
      reason: `exploration budget truncated deepening at maxStepsPerJourney=${budget.maxStepsPerJourney}: ${unique.length} journey chain(s) stopped before their observed links were exhausted or could not start (journeys: ${unique.join(", ")})`,
      budget: budget.maxStepsPerJourney,
    });
  }

  // 6. Select under maxJourneys (deepened variants only; carried baselines
  //    preserve observed behavior and never count against the budget).
  const allVariants = variantsByBaseline.flat();
  allVariants.sort((left, right) => compareSlots(left.slot, right.slot));
  const selectedVariants = allVariants.slice(0, budget.maxJourneys);
  const droppedVariants = allVariants.slice(budget.maxJourneys);
  if (droppedVariants.length > 0) {
    const unexplored = [...new Set(droppedVariants.map((variant) => variant.slot.path[0]))]
      .sort(compareStrings)
      .join(", ");
    assumptions.push({
      source: "exploration",
      path: "journeys",
      reason: `exploration budget truncated the journey set: ${allVariants.length} candidate journey(s) exceeded maxJourneys=${budget.maxJourneys}; ${droppedVariants.length} candidate(s) left unexplored (unexplored first targets: ${unexplored})`,
      budget: budget.maxJourneys,
    });
  }
  const selectedBaselines = new Set(selectedVariants.map((variant) => variant.baselineIndex));
  for (let index = 0; index < ir.journeys.length; index += 1) {
    if (variantsByBaseline[index].length > 0 && !selectedBaselines.has(index)) {
      carriedSlots.push(carrySlot(ir.journeys[index], landings[index], seedRank));
    }
  }

  const slots = [...selectedVariants.map((variant) => variant.slot), ...carriedSlots];
  slots.sort(compareSlots);
  const journeys = slots.map((slot) => slot.journey);

  // 7. Deferred inventory: every observed link edge no selected journey exercised.
  const exercisedEdges = new Set<string>();
  for (const variant of selectedVariants) {
    for (const edge of variant.edges) exercisedEdges.add(edge);
  }
  const deferred: DeferredLink[] = [];
  for (const screen of screens) {
    if (screen.linkUrls === null) continue;
    for (const targetUrl of screen.linkUrls) {
      if (exercisedEdges.has(`${screen.identity}\u0000${targetUrl}`)) continue;
      deferred.push({ fromUrl: screen.url, targetUrl });
    }
  }

  // 8. Feature digest (archetype-ready: canonical journey+screen summary) + stats.
  const featureSummary = {
    kind: FEATURE_SUMMARY_KIND,
    version: FEATURE_SUMMARY_VERSION,
    screens: screens.map((screen) => ({
      entrypoint: screen.entrypoint,
      url: screen.url,
      title: screen.title,
      textDigest: screen.textDigest,
      truncated: screen.truncated,
      textChars: screen.textChars,
      evidenceIds: [...screen.evidenceIds],
      linkTargets: screen.linkUrls === null ? null : [...screen.linkUrls],
    })),
    journeys: journeys.map((journey) => ({
      id: journey.id,
      name: journey.name,
      steps: journey.steps.map((step) => `${step.action} ${step.target ?? "-"}`),
    })),
  };
  const featureDigest = sha256Hex(canonicalJson(featureSummary) ?? "null");
  const stats: ExplorationStats = {
    journeys: journeys.length,
    steps: journeys.reduce((total, journey) => total + journey.steps.length, 0),
    linksFollowed: journeys.reduce(
      (total, journey) =>
        total + journey.steps.filter((step) => step.action === "follow-link").length,
      0,
    ),
    linksDeferred: deferred.length,
  };

  return { journeys, assumptions, deferred, featureDigest, stats };
}

/**
 * The IR with deepened journeys and exploration assumptions appended. Evidence
 * refs are carried verbatim (content-identical clones; never re-minted, never
 * dropped); screens/components/state/data/api/integrations/constraints are
 * carried unchanged. Throws a TypeError when the composed IR would not pass
 * validateBehavioralIr. Never mutates its inputs.
 */
export function composeExploredIr(ir: BehavioralIr, result: ExplorationResult): BehavioralIr {
  requireBehavioralIrShape(ir);
  if (
    !isPlainObject(result) ||
    !Array.isArray(result.journeys) ||
    !Array.isArray(result.assumptions)
  ) {
    throw new TypeError(
      "composeExploredIr requires an ExplorationResult carrying journeys and assumptions arrays",
    );
  }
  let composed: BehavioralIr;
  let journeyCopies: Journey[];
  let assumptionCopies: Record<string, unknown>[];
  try {
    composed = structuredClone(ir);
    journeyCopies = structuredClone(result.journeys);
    assumptionCopies = structuredClone(result.assumptions).map(
      (entry): Record<string, unknown> => ({ ...entry }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new TypeError(`composeExploredIr requires plain-data IR and result (${message})`);
  }
  composed.journeys = journeyCopies;
  composed.assumptions = [...composed.assumptions, ...assumptionCopies];
  const validation = validateBehavioralIr(composed);
  if (!validation.ok) {
    throw new TypeError(
      `composeExploredIr produced an invalid Behavioral IR: ${validation.errors.slice(0, 5).join("; ")}`,
    );
  }
  return composed;
}

/**
 * Evidence-coverage audit: one row per journey reporting its step count, the
 * number of DISTINCT evidence ids its steps cite, and how many steps cite no
 * evidence at all (a validator-style honesty metric for the parity dashboards —
 * every step should cite at least one evidence id). Tolerant: never throws.
 */
export function journeyDiffCoverage(ir: BehavioralIr): JourneyCoverage[] {
  if (!isPlainObject(ir) || !Array.isArray(ir.journeys)) {
    return [];
  }
  const rows: JourneyCoverage[] = [];
  for (const journey of ir.journeys) {
    if (!isPlainObject(journey)) continue;
    const steps = Array.isArray(journey.steps) ? journey.steps : [];
    const cited = new Set<string>();
    let uncitedSteps = 0;
    for (const step of steps) {
      const ids = citedEvidenceIds(step);
      if (ids.length === 0) {
        uncitedSteps += 1;
        continue;
      }
      for (const id of ids) cited.add(id);
    }
    rows.push({
      journeyId: typeof journey.id === "string" ? journey.id : "",
      steps: steps.length,
      citedEvidence: cited.size,
      uncitedSteps,
    });
  }
  return rows;
}

/** Fail-closed structural guards over the exploration input IR. */
function requireBehavioralIrShape(ir: BehavioralIr): void {
  if (!isPlainObject(ir)) {
    throw new TypeError("exploration requires a BehavioralIr object");
  }
  for (const field of ["journeys", "screens", "evidence"] as const) {
    if (!Array.isArray(ir[field])) {
      throw new TypeError(`exploration requires ir.${field} to be an array`);
    }
  }
  const journeyIds = new Set<string>();
  for (const journey of ir.journeys) {
    if (!isPlainObject(journey)) {
      throw new TypeError("exploration requires every ir.journeys entry to be a Journey object");
    }
    if (typeof journey.id !== "string" || journey.id === "") {
      throw new TypeError("exploration requires every journey to carry a non-empty string id");
    }
    if (journeyIds.has(journey.id)) {
      throw new TypeError(
        `exploration requires journey ids to be unique (duplicate "${journey.id}")`,
      );
    }
    journeyIds.add(journey.id);
    if (!Array.isArray(journey.steps)) {
      throw new TypeError(`exploration requires journey "${journey.id}" to carry a steps array`);
    }
    for (const step of journey.steps) {
      if (!isPlainObject(step)) {
        throw new TypeError(
          `exploration requires every step of journey "${journey.id}" to be an object`,
        );
      }
    }
  }
}

function requireSeed(seed: number): void {
  if (typeof seed !== "number" || !Number.isFinite(seed)) {
    throw new TypeError("exploration requires the seed to be a finite number");
  }
}

function requireBudget(budget: ExplorationBudget): void {
  if (!isPlainObject(budget)) {
    throw new TypeError("exploration requires a budget object");
  }
  for (const field of ["maxJourneys", "maxStepsPerJourney"] as const) {
    const value = budget[field];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      throw new TypeError(`exploration requires budget.${field} to be a non-negative integer`);
    }
  }
}

/** Tolerant screen parse: fields by name, evidence filtered to the IR's refs, links deduped. */
function parseScreens(
  raw: Record<string, unknown>[],
  knownEvidenceIds: Set<string>,
): ParsedScreen[] {
  const screens: ParsedScreen[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const entry = raw[index];
    if (!isPlainObject(entry)) continue;
    const screenId = stringOrNull(entry.screenId);
    const evidenceIds: string[] = [];
    if (Array.isArray(entry.evidenceIds)) {
      for (const id of entry.evidenceIds) {
        if (typeof id === "string" && knownEvidenceIds.has(id)) evidenceIds.push(id);
      }
    }
    screens.push({
      index,
      identity: screenId ?? `screen@${index}`,
      screenId,
      entrypoint: stringOrNull(entry.entrypoint),
      url: stringOrNull(entry.url),
      title: stringOrNull(entry.title),
      textDigest: stringOrNull(entry.textDigest),
      truncated: entry.truncated === true,
      textChars:
        typeof entry.textChars === "number" && Number.isFinite(entry.textChars)
          ? entry.textChars
          : null,
      evidenceIds,
      linkUrls: parseLinkUrls(entry.links),
    });
  }
  return screens;
}

/**
 * Parses the optional per-screen link inventory: null when absent (no
 * inventory was exposed), else the distinct target URLs in first-occurrence
 * observation order. Accepts plain URL strings or objects carrying a `url`.
 */
function parseLinkUrls(value: unknown): string[] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) return null;
  const urls: string[] = [];
  for (const entry of value) {
    let url: unknown = entry;
    if (isPlainObject(entry)) url = entry.url;
    if (typeof url !== "string" || url === "") continue;
    if (!urls.includes(url)) urls.push(url);
  }
  return urls;
}

/**
 * The screen a baseline journey lands on: the observed screen whose url equals
 * the journey's last step target, else the first screen whose entrypoint equals
 * it (the W2-002 shape, where the visit target is the entrypoint string and
 * screen urls are null). Null when nothing matches.
 */
function resolveLandingScreen(
  baseline: Journey,
  byUrl: Map<string, ParsedScreen>,
  screens: ParsedScreen[],
): ParsedScreen | null {
  const target = lastStepTarget(baseline);
  if (target === null) return null;
  const byUrlHit = byUrl.get(target);
  if (byUrlHit !== undefined) return byUrlHit;
  for (const screen of screens) {
    if (screen.entrypoint === target) return screen;
  }
  return null;
}

/** The journey's last step target carrying a non-empty string, or null. */
function lastStepTarget(baseline: Journey): string | null {
  for (let index = baseline.steps.length - 1; index >= 0; index -= 1) {
    const step = baseline.steps[index];
    if (isPlainObject(step) && typeof step.target === "string" && step.target !== "") {
      return step.target;
    }
  }
  return null;
}

/** The sort key's entrypoint: the landing screen's entrypoint, else the last step target. */
function entrypointKeyOf(baseline: Journey, landing: ParsedScreen | null): string {
  if (landing !== null && landing.entrypoint !== null) return landing.entrypoint;
  return lastStepTarget(baseline) ?? "";
}

/**
 * The distinct observed, evidence-cited first link targets of a screen
 * (self-links excluded: a step back to the displayed screen is vacuous and is
 * deferred instead). First-occurrence observation order.
 */
function candidateFirstTargets(screen: ParsedScreen, byUrl: Map<string, ParsedScreen>): string[] {
  if (screen.linkUrls === null) return [];
  const targets: string[] = [];
  for (const url of screen.linkUrls) {
    const target = byUrl.get(url);
    if (target === undefined || target.evidenceIds.length === 0) continue;
    if (target.identity === screen.identity) continue;
    targets.push(url);
  }
  return targets;
}

/** The next chain hop: first observed, evidence-cited, unvisited link target. */
function nextChainTarget(
  screen: ParsedScreen,
  byUrl: Map<string, ParsedScreen>,
  visited: ReadonlySet<string>,
): ChainHop | null {
  if (screen.linkUrls === null) return null;
  for (const url of screen.linkUrls) {
    const target = byUrl.get(url);
    if (target === undefined || target.evidenceIds.length === 0) continue;
    if (visited.has(target.identity)) continue;
    return { screen: target, url };
  }
  return null;
}

/**
 * Builds one candidate variant per distinct first link target of the landing
 * screen: the baseline steps carried (re-ided) plus one follow-link step per
 * followed target, each asserting only url/title facts cited by the target
 * screen's evidence. Continuation is a single deterministic chain.
 */
function buildCandidateVariants(
  baseline: Journey,
  baselineIndex: number,
  landing: ParsedScreen,
  byUrl: Map<string, ParsedScreen>,
  followBudget: number,
  truncatedJourneyIds: string[],
  seedRank: (id: string) => string,
): CandidateVariant[] {
  const entrypointKey = entrypointKeyOf(baseline, landing);
  const variants: CandidateVariant[] = [];
  for (const firstTarget of candidateFirstTargets(landing, byUrl)) {
    const targets: string[] = [firstTarget];
    const visited = new Set<string>([landing.identity]);
    const firstScreen = byUrl.get(firstTarget);
    if (firstScreen === undefined) continue;
    visited.add(firstScreen.identity);
    let current = firstScreen;
    while (targets.length < followBudget) {
      const hop = nextChainTarget(current, byUrl, visited);
      if (hop === null) break;
      targets.push(hop.url);
      visited.add(hop.screen.identity);
      current = hop.screen;
    }
    const stoppedByBudget =
      targets.length >= followBudget && nextChainTarget(current, byUrl, visited) !== null;
    const id = `${baseline.id}:explore:${sha256Hex(canonicalJson(targets) ?? "null")}`;
    if (stoppedByBudget) truncatedJourneyIds.push(id);
    const steps: JourneyStep[] = baseline.steps.map((step, index) => ({
      ...structuredClone(step),
      id: `${id}:step-${index + 1}`,
    }));
    const edges: string[] = [];
    let from = landing;
    for (const targetUrl of targets) {
      const targetScreen = byUrl.get(targetUrl);
      if (targetScreen === undefined) break;
      const assertions: Record<string, unknown> = {
        urlEquals: targetUrl,
        evidenceIds: [...targetScreen.evidenceIds],
      };
      if (targetScreen.title !== null) assertions.titleEquals = targetScreen.title;
      steps.push({
        id: `${id}:step-${steps.length + 1}`,
        action: "follow-link",
        target: targetUrl,
        input: { fromScreenId: from.screenId, fromUrl: from.url },
        assertions,
      });
      edges.push(`${from.identity}\u0000${targetUrl}`);
      from = targetScreen;
    }
    variants.push({
      slot: {
        journey: {
          id,
          name: `${baseline.name} - explore ${targets.join(" -> ")}`,
          preconditions: [...baseline.preconditions],
          steps,
        },
        entrypointKey,
        path: targets,
        rank: seedRank(id),
      },
      baselineIndex,
      edges,
    });
  }
  return variants;
}

/** A baseline carried verbatim (no deepening possible or selected for it). */
function carrySlot(
  baseline: Journey,
  landing: ParsedScreen | null,
  seedRank: (id: string) => string,
): JourneySlot {
  return {
    journey: structuredClone(baseline),
    entrypointKey: entrypointKeyOf(baseline, landing),
    path: [],
    rank: seedRank(baseline.id),
  };
}

/**
 * The deterministic total order over journeys: (entrypoint, followed target
 * path, seed rank). The seed rank only ever distinguishes candidates whose
 * entrypoint AND path are EQUAL — tie-breaking, never invention.
 */
function compareSlots(left: JourneySlot, right: JourneySlot): number {
  return (
    compareStrings(left.entrypointKey, right.entrypointKey) ||
    comparePaths(left.path, right.path) ||
    compareStrings(left.rank, right.rank)
  );
}

function comparePaths(left: readonly string[], right: readonly string[]): number {
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    const comparison = compareStrings(left[index], right[index]);
    if (comparison !== 0) return comparison;
  }
  return left.length - right.length;
}

function describeScreen(screen: ParsedScreen): string {
  if (screen.url !== null) return screen.url;
  if (screen.screenId !== null) return screen.screenId;
  return `screen ${screen.index}`;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** The evidence ids a step's assertions cite (non-empty strings only). */
function citedEvidenceIds(step: unknown): string[] {
  if (!isPlainObject(step)) return [];
  const assertions = step.assertions;
  if (!isPlainObject(assertions)) return [];
  const ids = assertions.evidenceIds;
  if (!Array.isArray(ids)) return [];
  const collected: string[] = [];
  for (const id of ids) {
    if (typeof id === "string" && id !== "") collected.push(id);
  }
  return collected;
}
