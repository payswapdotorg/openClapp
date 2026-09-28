import type { DiffFinding, SynthesisPlan } from "@clapp/contracts";
import { canonicalJson, isPlainObject } from "./canonical.ts";
import { generateCandidateApp } from "./generator.ts";
import { contentHash } from "./hash.ts";
import type {
  PairedDimensions,
  PairedJourney,
  PairedSide,
  PairedSuiteResult,
  PairedVerdict,
} from "./paired.ts";
import { runPairedSuite } from "./paired.ts";

/**
 * CLAPP-W3-006 — bounded autonomous repair.
 *
 * The M5 repair loop: a deterministic, model-free rules engine that consumes
 * the paired parity engine's DiffReport (CLAPP-W3-004/W3-005), classifies each
 * finding into one of the four M5 mutation classes, applies the derived
 * mutations to the CANDIDATE'S PLAN INPUTS (never to generated code — the
 * generated candidate is a pure function of its SynthesisPlan, so repair =
 * plan mutation -> regenerate -> re-materialize -> re-verify), and stops on
 * convergence, stagnation or budget exhaustion — whichever comes first.
 *
 * Honesty discipline (ARCHITECTURE §6):
 * - every non-derivable finding (skeleton digest only, manual/unrepairable
 *   repairability, dimensions outside the repair vocabulary, anchors with no
 *   structured plan channel) is ABSTAINED with a recorded reason — never a
 *   guessed mutation;
 * - replacements come from the finding's own expected/actual where the value
 *   is directly derivable, and from the LIVE REFERENCE side (an authorized
 *   loop input) where the finding carries only a one-way digest — the loop
 *   resolves those by probing the reference before applying;
 * - purity: no clocks, no ports, no durations; ids are content-hashed; the
 *   same inputs produce byte-identical repair trajectories and reports.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** The four M5 mutation classes (ACCEPTANCE.md). */
export type RepairMutationClass =
  | "visible-text"
  | "interaction-id"
  | "network-mock"
  | "state-storage";

/**
 * The structural plan-input target of one mutation. Page-scoped targets carry
 * the target page path when the finding (or the loop's journey context)
 * supplied one, plus the content fingerprint the finding observed; `null`
 * means the channel was not derivable and the mutation cannot be located.
 */
export type RepairMutationTarget =
  | { field: "route.name"; page: string | null; currentName: string | null }
  | { field: "route.steps"; page: string | null; currentSteps: number | null }
  | { field: "api.entry"; key: string }
  | { field: "state.shape" };

/**
 * How the replacement value is obtained:
 * - "finding": the value was directly derivable from the finding (title text,
 *   heading text, step count, anchor text, or the probed/aligned value after
 *   loop-level resolution) and rides in {@link RepairMutation.value};
 * - "reference-api": the finding carried only a digest/status; the loop must
 *   probe the live reference at the path and resolve the value;
 * - "reference-state": the finding carried only a state digest; the loop must
 *   snapshot the live reference side's state and resolve the value;
 * - "removal": the reference's surface carries an honest absence (e.g. a 404
 *   where the candidate serves a mock) — the entry must be removed.
 */
export type RepairReplacement =
  | { source: "finding"; value: unknown }
  | { source: "reference-api"; path: string }
  | { source: "reference-state" }
  | { source: "removal" };

/** One bounded, structural plan-input mutation. */
export type RepairMutation = {
  target: RepairMutationTarget;
  replacement: RepairReplacement;
};

/**
 * One classified finding: either a bounded mutation action, or an honest
 * abstention (no mutation, a recorded reason — never a guess).
 */
export type RepairAction =
  | {
      kind: "mutation";
      /** Content-addressed id: `ra-` + sha256 of the action's core. */
      id: string;
      class: RepairMutationClass;
      anchor: string;
      mutation: RepairMutation;
      rationale: string;
    }
  | {
      kind: "abstention";
      /** Content-addressed id: `ra-` + sha256 of the abstention's core. */
      id: string;
      anchor: string;
      reason: string;
    };

/** One repair iteration's honest record (counts are of >= minor findings). */
export type RepairIterationRecord = {
  findingsBefore: number;
  actionsApplied: number;
  findingsAfter: number;
  verdict: PairedVerdict;
  /** The mutation classes actually applied this iteration (sorted, unique). */
  mutationClasses: RepairMutationClass[];
};

/** Why the loop stopped. */
export type RepairStopReason = "converged" | "stagnation" | "budget";

/** One honest abstention entry in the report. */
export type RepairAbstention = { anchor: string; reason: string };

/** The applied arm of the RepairAction union (module-internal shorthand). */
type MutationAction = Extract<RepairAction, { kind: "mutation" }>;

/** The bounded repair loop's report — the review stage's input. */
export type RepairReport = {
  /** Content-addressed id: `rr-` + sha256 of the report's core. */
  id: string;
  reconstructionId: string;
  iterations: RepairIterationRecord[];
  finalVerdict: PairedVerdict;
  abstained: RepairAbstention[];
  actionsTotal: number;
  converged: boolean;
  stoppedBy: RepairStopReason;
  /** The repaired plan — the deliverable handed to regeneration (additive). */
  finalPlan: SynthesisPlan;
};

/** The human-reviewable digest of a repair report. */
export type RepairSummary = {
  reportId: string;
  reconstructionId: string;
  converged: boolean;
  stoppedBy: RepairStopReason;
  iterations: number;
  finalVerdict: PairedVerdict;
  /** The verdict after every iteration, in order. */
  verdictTrajectory: PairedVerdict[];
  /** Every mutation class applied anywhere in the loop (sorted, unique). */
  mutationClassesUsed: RepairMutationClass[];
  actionsTotal: number;
  abstentionCount: number;
};

/** The input of {@link runRepairLoop}. */
export type RunRepairLoopInput = {
  /** A factory for fresh reference sides (started per verification run). */
  reference: () => PairedSide;
  /** The candidate's plan inputs — the only thing repair ever mutates. */
  candidatePlan: SynthesisPlan;
  /** Turns a plan into a servable candidate side (the W3-002/W3-003 pipeline). */
  materialize: (plan: SynthesisPlan) => PairedSide | Promise<PairedSide>;
  /** The acceptance journeys driven against both sides. */
  journeys: PairedJourney[];
  /**
   * The absolute iteration bound (ReconstructionSpec.verification.
   * maxRepairIterations). The loop also stops early on convergence or
   * stagnation — never grinding to the budget when honestly done.
   */
  budget: number;
  /** Defaults to "repair-loop"; carried into every paired run. */
  reconstructionId?: string;
  /** Optional diff dimensions policy, shared by every verification run. */
  dimensions?: Partial<PairedDimensions>;
};

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

/** A content-addressed action/abstention id. */
function actionIdOf(core: unknown): string {
  return `ra-${contentHash(core).slice(0, 16)}`;
}

/** The severities that block parity (minor or worse). */
function isBlocking(finding: DiffFinding): boolean {
  return finding.severity !== "info";
}

/** All findings of a suite, in journey-then-report order (deterministic). */
function findingsOf(suite: PairedSuiteResult): DiffFinding[] {
  return suite.envelopes.flatMap((envelope) => envelope.report.findings);
}

/** The blocking (>= minor) findings of a suite. */
function blockingFindingsOf(suite: PairedSuiteResult): DiffFinding[] {
  return findingsOf(suite).filter(isBlocking);
}

/** A single-heading view of a headings array: { level: 1, text } or null. */
function singleLevelOneHeading(value: unknown): { level: number; text: string } | null {
  if (!Array.isArray(value) || value.length !== 1) return null;
  const entry = value[0];
  if (!isPlainObject(entry)) return null;
  if (entry.level !== 1 || typeof entry.text !== "string") return null;
  return { level: 1, text: entry.text };
}

// ---------------------------------------------------------------------------
// 1. classifyRepairActions — findings -> bounded mutation actions
// ---------------------------------------------------------------------------

/** An abstention action, content-addressed. */
function abstention(anchor: string, reason: string): RepairAction {
  return {
    kind: "abstention",
    id: actionIdOf({ kind: "abstention", anchor, reason }),
    anchor,
    reason,
  };
}

/** A mutation action, content-addressed. */
function mutationAction(
  mutationClass: RepairMutationClass,
  anchor: string,
  mutation: RepairMutation,
  rationale: string,
): RepairAction {
  return {
    kind: "mutation",
    id: actionIdOf({ kind: "mutation", class: mutationClass, anchor, mutation, rationale }),
    class: mutationClass,
    anchor,
    mutation,
    rationale,
  };
}

/** Classifies one finding; total — every path returns a RepairAction. */
function classifyOne(finding: DiffFinding): RepairAction {
  const { dimension, severity, anchor, expected, actual, repairability } = finding;

  // The skeleton digest is non-invertible by anchor vocabulary alone — no
  // structured channel pinpoints the change, whatever the declared
  // repairability says. The named honest catch-all of the visual dimension.
  if (anchor === "visual:skeleton") {
    return abstention(
      anchor,
      "skeleton digest only — no structured channel pinpoints the change, so no bounded mutation is derivable",
    );
  }

  // Repairability gate: only automatic/assisted findings are repairable this
  // wave; manual/unrepairable findings are honestly abstained.
  if (repairability !== "automatic" && repairability !== "assisted") {
    return abstention(
      anchor,
      `repairability "${repairability}" is outside the bounded automatic repair scope; human review required`,
    );
  }

  // Dimension gates: the repair vocabulary covers the four paired dimensions.
  if (dimension === "performance" || dimension === "integration") {
    return abstention(
      anchor,
      `the "${dimension}" dimension is outside the bounded mutation classes`,
    );
  }
  if (dimension === "storage") {
    return abstention(
      anchor,
      "no structured anchor vocabulary exists for the storage dimension yet",
    );
  }

  // Informational findings never block parity (the skeleton digest is
  // already handled above by its anchor vocabulary).
  if (severity === "info") {
    return abstention(anchor, "informational finding — not parity-blocking, no repair required");
  }

  if (dimension === "visual") {
    if (anchor === "visual:title") {
      if (typeof expected !== "string" || typeof actual !== "string") {
        return abstention(anchor, "the title finding does not carry comparable string values");
      }
      return mutationAction(
        "visible-text",
        anchor,
        {
          target: { field: "route.name", page: null, currentName: actual },
          replacement: { source: "finding", value: expected },
        },
        "the page <title> channel is the plan route's name; the reference title is the replacement",
      );
    }
    if (anchor.startsWith("visual:heading:")) {
      const referenceHeading = singleLevelOneHeading(expected);
      const candidateHeading = singleLevelOneHeading(actual);
      if (referenceHeading === null || candidateHeading === null) {
        return abstention(
          anchor,
          "the reference heading structure is not expressible in the plan's single-h1 page model",
        );
      }
      return mutationAction(
        "visible-text",
        anchor,
        {
          target: { field: "route.name", page: null, currentName: candidateHeading.text },
          replacement: { source: "finding", value: referenceHeading.text },
        },
        "the page heading channel is the plan route's name; the reference level-1 heading is the replacement",
      );
    }
    if (anchor.startsWith("visual:image:") || anchor.startsWith("visual:control:")) {
      return abstention(anchor, "the plan's page model exposes no image or form-control channel");
    }
    if (anchor.startsWith("visual:link:")) {
      return abstention(anchor, "the plan's page model exposes no hyperlink channel");
    }
    return abstention(
      anchor,
      "unrecognized visual anchor — no structured plan channel is derivable",
    );
  }

  if (dimension === "network") {
    return abstention(
      anchor,
      "the plan's page model exposes no response redirect or header channel; the generated server emits neither",
    );
  }

  if (dimension === "state") {
    if (anchor === "state:pre-journey" || anchor === "state:post-journey") {
      return mutationAction(
        "state-storage",
        anchor,
        { target: { field: "state.shape" }, replacement: { source: "reference-state" } },
        "the state finding carries only a one-way digest; the replacement is the live reference side's state snapshot",
      );
    }
    return abstention(
      anchor,
      "unrecognized state anchor — no structured plan channel is derivable",
    );
  }

  if (dimension === "semantic") {
    if (anchor === "api-check-inventory") {
      return abstention(anchor, "the API check inventory divergence carries no per-key target");
    }

    // Page anchor gap: expected/actual are the sides' anchorsFound arrays.
    if (Array.isArray(expected) && Array.isArray(actual)) {
      const inReference = expected.includes(anchor);
      const inCandidate = actual.includes(anchor);
      if (!inReference || inCandidate) {
        return abstention(
          anchor,
          "candidate-side extra anchor text removal is not derivable from the finding's expected/actual sets",
        );
      }
      // The generator's own step-count text format: "Steps: <n>".
      const stepsMatch = /^Steps: (\d+)$/.exec(anchor);
      if (stepsMatch !== null) {
        const steps = Number.parseInt(stepsMatch[1] ?? "", 10);
        return mutationAction(
          "interaction-id",
          anchor,
          {
            target: { field: "route.steps", page: null, currentSteps: null },
            replacement: { source: "finding", value: steps },
          },
          "the anchor is the generator's own step-count text; the plan route's steps value is the replacement",
        );
      }
      return mutationAction(
        "visible-text",
        anchor,
        {
          target: { field: "route.name", page: null, currentName: null },
          replacement: { source: "finding", value: anchor },
        },
        "the anchor text is missing from the candidate page; the plan route's name is the page's heading text channel",
      );
    }

    // Status divergence: expected/actual are HTTP status numbers.
    if (typeof expected === "number" && typeof actual === "number") {
      if (anchor.startsWith("/api/") && anchor.length > "/api/".length) {
        const key = anchor.slice("/api/".length);
        if (expected >= 400 && actual < 400) {
          return mutationAction(
            "network-mock",
            anchor,
            { target: { field: "api.entry", key }, replacement: { source: "removal" } },
            "the reference's network surface carries no such endpoint; the candidate's spurious mock entry is removed",
          );
        }
        if (expected < 400 && actual >= 400) {
          return mutationAction(
            "network-mock",
            anchor,
            {
              target: { field: "api.entry", key },
              replacement: { source: "reference-api", path: anchor },
            },
            "the reference serves this endpoint; the replacement is the live reference's served value",
          );
        }
        return abstention(
          anchor,
          "the api status divergence is not repair-derivable (both sides error differently)",
        );
      }
      if (anchor.startsWith("/api/")) {
        return abstention(
          anchor,
          "the whole-store api endpoint is not expressible in the plan's per-key api surface",
        );
      }
      if (anchor.startsWith("/")) {
        return abstention(
          anchor,
          "route-presence divergence is outside the bounded mutation classes (route topology is not plan-mutable)",
        );
      }
      return abstention(
        anchor,
        "unrecognized status anchor — no structured plan channel is derivable",
      );
    }

    // Content-type or api digest divergence: expected/actual are strings.
    if (typeof expected === "string" && typeof actual === "string") {
      if (anchor.startsWith("/api/") && anchor.length > "/api/".length) {
        const key = anchor.slice("/api/".length);
        return mutationAction(
          "network-mock",
          anchor,
          {
            target: { field: "api.entry", key },
            replacement: { source: "reference-api", path: anchor },
          },
          "the api value finding carries only a one-way digest; the replacement is the live reference's served value",
        );
      }
      return abstention(anchor, "the served content-type channel is not plan-expressible");
    }

    return abstention(anchor, "finding shape not recognized by the repair vocabulary");
  }

  return abstention(anchor, "dimension outside the repair vocabulary");
}

/**
 * Deterministic mapping from findings to bounded mutation actions. Findings
 * whose anchor is not derivable (skeleton digest only, manual/unrepairable
 * repairability, performance/integration dimensions, anchors with no plan
 * channel) yield honest abstentions with reasons — never a guessed mutation.
 * Actions are returned in the findings' given order (the paired runner's
 * findings are already deterministically sorted).
 */
export function classifyRepairActions(findings: DiffFinding[]): RepairAction[] {
  return findings.map((finding) => classifyOne(finding));
}

// ---------------------------------------------------------------------------
// 2. applyRepairActions — pure plan transformation
// ---------------------------------------------------------------------------

/**
 * Resolves every plan route's generated page path to its journey id, through
 * the generator itself (no derivation mirroring). Returns null when the plan
 * does not generate (fail-closed: page-scoped mutations will be skipped).
 */
function routePathIndex(plan: SynthesisPlan): Map<string, string> | null {
  try {
    const app = generateCandidateApp(plan);
    const routesFile = app.files.find((file) => file.path === "routes.json");
    if (routesFile === undefined) return null;
    const parsed: unknown = JSON.parse(routesFile.content);
    if (!Array.isArray(parsed)) return null;
    const map = new Map<string, string>();
    for (const entry of parsed) {
      if (
        isPlainObject(entry) &&
        typeof entry.journeyId === "string" &&
        typeof entry.path === "string"
      ) {
        map.set(entry.path, entry.journeyId);
      }
    }
    return map;
  } catch {
    return null;
  }
}

/** The plan's route records (plain objects only), in plan order. */
function planRoutes(plan: SynthesisPlan): Record<string, unknown>[] {
  return plan.routes.filter(isPlainObject);
}

/** Reads a string field off a plan route record. */
function routeStringField(route: Record<string, unknown>, field: string): string | null {
  const value = route[field];
  return typeof value === "string" ? value : null;
}

/** A content fingerprint that locates a page-scoped mutation's target route. */
type RouteFingerprint = { kind: "name"; value: string } | { kind: "steps"; value: number };

/**
 * Locates the single plan route a page-scoped mutation targets. Returns the
 * route, or an honest skip reason. Deterministic and fail-closed.
 */
function locateRoute(
  plan: SynthesisPlan,
  page: string | null,
  fingerprint: RouteFingerprint | null,
  pathIndex: Map<string, string> | null,
): { route: Record<string, unknown> } | { reason: string } {
  const routes = planRoutes(plan);
  if (page !== null) {
    const journeyId = pathIndex?.get(page);
    if (journeyId === undefined) {
      return { reason: `no plan route generates the page path "${page}"` };
    }
    const matches = routes.filter((route) => routeStringField(route, "journeyId") === journeyId);
    if (matches.length !== 1) {
      return {
        reason:
          matches.length === 0
            ? `no plan route carries journeyId "${journeyId}"`
            : `journeyId "${journeyId}" is ambiguous across ${matches.length} routes`,
      };
    }
    return { route: matches[0] as Record<string, unknown> };
  }
  if (fingerprint === null) {
    return {
      reason:
        "the mutation target carries no page channel or content fingerprint — the repair loop must resolve it from the journey context",
    };
  }
  if (fingerprint.kind === "name") {
    const matches = routes.filter((route) => routeStringField(route, "name") === fingerprint.value);
    if (matches.length !== 1) {
      return {
        reason:
          matches.length === 0
            ? `no plan route carries the current name "${fingerprint.value}"`
            : `the current name "${fingerprint.value}" is ambiguous across ${matches.length} routes`,
      };
    }
    return { route: matches[0] as Record<string, unknown> };
  }
  const matches = routes.filter((route) => route.steps === fingerprint.value);
  if (matches.length !== 1) {
    return {
      reason:
        matches.length === 0
          ? `no plan route carries the current step count ${fingerprint.value}`
          : `the current step count ${fingerprint.value} is ambiguous across ${matches.length} routes`,
    };
  }
  return { route: matches[0] as Record<string, unknown> };
}

/** Applies one mutation to the working plan in place; returns a skip reason or null. */
function applyOne(
  working: SynthesisPlan,
  mutation: RepairMutation,
  pathIndex: Map<string, string> | null,
): string | null {
  const { target, replacement } = mutation;

  if (target.field === "route.name" || target.field === "route.steps") {
    const fingerprint: RouteFingerprint | null =
      target.field === "route.name"
        ? target.currentName !== null
          ? { kind: "name", value: target.currentName }
          : null
        : target.currentSteps !== null
          ? { kind: "steps", value: target.currentSteps }
          : null;
    const located = locateRoute(working, target.page, fingerprint, pathIndex);
    if ("reason" in located) return located.reason;
    if (replacement.source !== "finding") {
      return `the replacement source "${replacement.source}" was not resolved before apply`;
    }
    if (target.field === "route.name") {
      if (typeof replacement.value !== "string" || replacement.value.length === 0) {
        return "the route name replacement must be a non-empty string";
      }
      located.route.name = replacement.value;
      return null;
    }
    if (
      typeof replacement.value !== "number" ||
      !Number.isInteger(replacement.value) ||
      replacement.value < 0
    ) {
      return "the route steps replacement must be a non-negative integer";
    }
    located.route.steps = replacement.value;
    return null;
  }

  if (target.field === "api.entry") {
    if (typeof target.key !== "string" || target.key.length === 0) {
      return "the api entry target must carry a non-empty store key";
    }
    if (replacement.source === "removal") {
      // Remove from both channels — the store merges persistence first and
      // api fills the gaps, so both must drop the key.
      working.persistence = working.persistence.filter(
        (entry) => !(isPlainObject(entry) && entry.key === target.key),
      );
      working.api = working.api.filter(
        (entry) => !(isPlainObject(entry) && entry.key === target.key),
      );
      return null;
    }
    if (replacement.source !== "finding") {
      return `the replacement source "${replacement.source}" was not resolved before apply`;
    }
    // Replace the store-effective entry: persistence wins in the generated
    // server's merge, so persistence first, then api, else append to api.
    const persistenceEntry = working.persistence.find(
      (entry) => isPlainObject(entry) && entry.key === target.key,
    );
    if (persistenceEntry !== undefined && isPlainObject(persistenceEntry)) {
      persistenceEntry.value = structuredClone(replacement.value);
      return null;
    }
    const apiEntry = working.api.find((entry) => isPlainObject(entry) && entry.key === target.key);
    if (apiEntry !== undefined && isPlainObject(apiEntry)) {
      apiEntry.value = structuredClone(replacement.value);
      return null;
    }
    working.api.push({ key: target.key, value: structuredClone(replacement.value) });
    return null;
  }

  // state.shape
  if (replacement.source !== "finding") {
    return `the replacement source "${replacement.source}" was not resolved before apply`;
  }
  if (!isPlainObject(replacement.value)) {
    return "the state shape replacement must be a plain object";
  }
  working.state = structuredClone(replacement.value) as Record<string, unknown>;
  return null;
}

/**
 * PURE plan transformation: applies each mutation to the plan's page/api/
 * persistence/state inputs. Structurally-invalid or unresolvable actions are
 * skipped with reasons (fail-closed — never a thrown guess); the input plan
 * is never mutated (a deep copy is returned); abstention entries carry no
 * mutation and are neither applied nor skipped. Actions apply in the given
 * order; later mutations on the same target overwrite earlier ones.
 */
export function applyRepairActions(
  plan: SynthesisPlan,
  actions: RepairAction[],
): {
  plan: SynthesisPlan;
  applied: RepairAction[];
  skipped: { action: RepairAction; reason: string }[];
} {
  const working = structuredClone(plan) as SynthesisPlan;
  // Paths derive from journeyIds, which no mutation touches — resolve once
  // from the input plan.
  const pathIndex = routePathIndex(plan);
  const applied: RepairAction[] = [];
  const skipped: { action: RepairAction; reason: string }[] = [];
  for (const action of actions) {
    if (action.kind === "abstention") continue;
    const reason = applyOne(working, action.mutation, pathIndex);
    if (reason === null) {
      applied.push(action);
    } else {
      skipped.push({ action, reason });
    }
  }
  return { plan: working, applied, skipped };
}

// ---------------------------------------------------------------------------
// 3. runRepairLoop — the bounded loop
// ---------------------------------------------------------------------------

/** Normalizes the budget: a non-negative integer, fail-closed. */
function normalizeBudget(budget: number): number {
  if (typeof budget !== "number" || !Number.isInteger(budget) || budget < 0) {
    throw new TypeError("budget must be a non-negative integer iteration bound");
  }
  return budget;
}

/** A mutation action whose reference-sourced replacement was resolved to a value. */
function withResolvedReplacement(action: MutationAction, value: unknown): MutationAction {
  return {
    ...action,
    mutation: {
      ...action.mutation,
      replacement: { source: "finding" as const, value: structuredClone(value) },
    },
  };
}

/** A mutation action whose page-unresolved target was resolved to a page path. */
function withResolvedPage(action: MutationAction, page: string): MutationAction {
  const target = action.mutation.target;
  if (target.field !== "route.name" && target.field !== "route.steps") return action;
  if (target.page !== null) return action;
  return {
    ...action,
    mutation: {
      ...action.mutation,
      target: { ...target, page },
    },
  };
}

/** Best-effort stop of a started side handle. */
async function stopQuietly(handle: { stop(): Promise<void> }): Promise<void> {
  try {
    await handle.stop();
  } catch {
    return;
  }
}

/**
 * Resolves reference-sourced replacements by probing the live reference side:
 * GET each distinct api path (JSON-parsed body), snapshot the state once.
 * Actions whose probe fails keep their unresolved source and are skipped
 * fail-closed at apply time.
 */
async function resolveReferenceReplacements(
  actions: MutationAction[],
  reference: () => PairedSide,
): Promise<MutationAction[]> {
  const apiPaths = new Set<string>();
  let needsState = false;
  for (const action of actions) {
    const { replacement } = action.mutation;
    if (replacement.source === "reference-api") apiPaths.add(replacement.path);
    if (replacement.source === "reference-state") needsState = true;
  }
  if (apiPaths.size === 0 && !needsState) return actions;

  const apiValues = new Map<string, unknown>();
  let stateValue: Record<string, unknown> | null = null;
  let handle: Awaited<ReturnType<PairedSide["start"]>> | null = null;
  try {
    const side = reference();
    handle = await side.start();
    for (const path of [...apiPaths].sort()) {
      try {
        const response = await fetch(`${handle.baseUrl}${path}`);
        if (!response.ok) continue;
        const text = await response.text();
        apiValues.set(path, JSON.parse(text) as unknown);
      } catch {
        // An honest unresolved probe: the action keeps its reference source
        // and is skipped at apply time.
      }
    }
    if (needsState && typeof side.snapshotState === "function") {
      try {
        const snapshot = side.snapshotState();
        if (isPlainObject(snapshot)) stateValue = snapshot;
      } catch {
        // Honest absence — unresolved.
      }
    }
  } catch {
    // The probe side could not start; everything stays unresolved.
  } finally {
    if (handle !== null) await stopQuietly(handle);
  }

  return actions.map((action) => {
    const { replacement } = action.mutation;
    if (replacement.source === "reference-api" && apiValues.has(replacement.path)) {
      return withResolvedReplacement(action, apiValues.get(replacement.path));
    }
    if (replacement.source === "reference-state" && stateValue !== null) {
      return withResolvedReplacement(action, stateValue);
    }
    return action;
  });
}

/** Records an abstention into the deduping, insertion-ordered map. */
function recordAbstention(
  map: Map<string, RepairAbstention>,
  anchor: string,
  reason: string,
): void {
  const key = `${anchor}\u0000${reason}`;
  if (!map.has(key)) map.set(key, { anchor, reason });
}

/** Sorted unique mutation classes of an applied action list. */
function classesOf(applied: RepairAction[]): RepairMutationClass[] {
  const seen = new Set<RepairMutationClass>();
  for (const action of applied) {
    if (action.kind === "mutation") seen.add(action.class);
  }
  return [...seen].sort();
}

/**
 * The bounded repair loop: run the paired suite -> classify (per journey, so
 * page-scoped actions resolve their target page from the journey's route
 * path) -> resolve reference-sourced replacements -> apply -> re-materialize
 * -> re-verify -> repeat. Stops on convergence (zero >= minor findings),
 * stagnation (an iteration with zero fixed findings — where "fixed" means a
 * blocking finding whose dimension+anchor disappeared), or budget exhaustion
 * — whichever comes first.
 *
 * Deterministic and content-addressed: identical inputs produce byte-identical
 * reports (ids are content-hashed; no clocks, ports or durations anywhere).
 */
export async function runRepairLoop(input: RunRepairLoopInput): Promise<RepairReport> {
  const reconstructionId =
    typeof input.reconstructionId === "string" && input.reconstructionId.length > 0
      ? input.reconstructionId
      : "repair-loop";
  const budget = normalizeBudget(input.budget);

  let plan = input.candidatePlan;
  let suite = await runPairedSuite({
    journeys: input.journeys,
    reference: input.reference(),
    candidate: await input.materialize(plan),
    reconstructionId,
    dimensions: input.dimensions,
  });

  let blocking = blockingFindingsOf(suite);
  const abstained = new Map<string, RepairAbstention>();
  const iterations: RepairIterationRecord[] = [];
  let actionsTotal = 0;
  let converged = false;
  let stoppedBy: RepairStopReason | null = null;

  if (blocking.length === 0) {
    converged = true;
    stoppedBy = "converged";
  }

  for (let iteration = 0; iteration < budget && stoppedBy === null; iteration += 1) {
    // Classify per journey so page-unresolved actions can adopt the journey's
    // route path as their target page (the finding itself carries no page).
    const mutationActions: MutationAction[] = [];
    for (const [journeyIndex, journey] of input.journeys.entries()) {
      const findings = suite.envelopes[journeyIndex]?.report.findings ?? [];
      for (const action of classifyRepairActions(findings)) {
        if (action.kind === "abstention") {
          recordAbstention(abstained, action.anchor, action.reason);
          continue;
        }
        mutationActions.push(withResolvedPage(action, journey.routePath));
      }
    }

    const resolved = await resolveReferenceReplacements(mutationActions, input.reference);
    const appliedResult = applyRepairActions(plan, resolved);
    for (const skip of appliedResult.skipped) {
      recordAbstention(abstained, skip.action.anchor, skip.reason);
    }
    actionsTotal += appliedResult.applied.length;
    plan = appliedResult.plan;

    // Re-materialize and re-verify through the paired runner — fresh sides.
    suite = await runPairedSuite({
      journeys: input.journeys,
      reference: input.reference(),
      candidate: await input.materialize(plan),
      reconstructionId,
      dimensions: input.dimensions,
    });

    const blockingAfter = blockingFindingsOf(suite);
    iterations.push({
      findingsBefore: blocking.length,
      actionsApplied: appliedResult.applied.length,
      findingsAfter: blockingAfter.length,
      verdict: suite.verdict,
      mutationClasses: classesOf(appliedResult.applied),
    });

    if (blockingAfter.length === 0) {
      converged = true;
      stoppedBy = "converged";
    } else {
      const afterKeys = new Set(
        blockingAfter.map((finding) => `${finding.dimension}\u0000${finding.anchor}`),
      );
      const fixed = blocking.filter(
        (finding) => !afterKeys.has(`${finding.dimension}\u0000${finding.anchor}`),
      ).length;
      if (fixed === 0) stoppedBy = "stagnation";
    }
    blocking = blockingAfter;
  }

  if (stoppedBy === null) stoppedBy = "budget";

  const core = {
    reconstructionId,
    iterations,
    finalVerdict: suite.verdict,
    abstained: [...abstained.values()],
    actionsTotal,
    converged,
    stoppedBy,
  };
  const report: RepairReport = {
    id: `rr-${contentHash(core).slice(0, 16)}`,
    ...core,
    finalPlan: plan,
  };
  return report;
}

// ---------------------------------------------------------------------------
// 4. summarizeRepair — the review-stage digest
// ---------------------------------------------------------------------------

/**
 * The human-reviewable digest of a repair report: convergence, the per-
 * iteration verdict trajectory, the mutation classes used, and the abstention
 * count. A pure function of the report.
 */
export function summarizeRepair(report: RepairReport): RepairSummary {
  const classes = new Set<RepairMutationClass>();
  for (const iteration of report.iterations) {
    for (const mutationClass of iteration.mutationClasses) classes.add(mutationClass);
  }
  return {
    reportId: report.id,
    reconstructionId: report.reconstructionId,
    converged: report.converged,
    stoppedBy: report.stoppedBy,
    iterations: report.iterations.length,
    finalVerdict: report.finalVerdict,
    verdictTrajectory: report.iterations.map((iteration) => iteration.verdict),
    mutationClassesUsed: [...classes].sort(),
    actionsTotal: report.actionsTotal,
    abstentionCount: report.abstained.length,
  };
}

/** Canonical serialization of a repair report — the deterministic review form. */
export function serializeRepairReport(report: RepairReport): string {
  const { id: _id, finalPlan: _finalPlan, ...core } = report;
  return canonicalJson(core);
}
