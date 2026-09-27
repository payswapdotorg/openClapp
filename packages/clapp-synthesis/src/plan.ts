import type { BehavioralIr, ReconstructionSpec, SynthesisPlan } from "@clapp/contracts";
import { CLAPP_CONTRACT_VERSION } from "@clapp/contracts";
import { isPlainObject } from "./canonical.ts";
import { contentHash } from "./hash.ts";

/**
 * A plan route: the journey-addressable navigation contract derived from one
 * behavioral journey. `steps` is the journey's step count.
 */
export type PlanRoute = { journeyId: string; name: string; steps: number };

/**
 * A plan component: one IR component carrying a stable content-derived id and
 * a deep copy of its definition.
 */
export type PlanComponent = { componentId: string; definition: Record<string, unknown> };

/**
 * A keyed plan entry: one stable key of a model record (`model.data`,
 * `model.api`) together with a deep copy of its value.
 */
export type PlanKeyedEntry = { key: string; value: unknown };

/**
 * An assumption derived by the planner itself, never by observation. Every
 * derived assumption names where it came from so review can trace it.
 */
export type DerivedAssumption = { source: "synthesis"; reason: string; path: string };

function deepCopy(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((element) => deepCopy(element));
  }
  if (isPlainObject(value)) {
    const copy: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      copy[key] = deepCopy(value[key]);
    }
    return copy;
  }
  return value;
}

function keyedEntries(source: Record<string, unknown>): PlanKeyedEntry[] {
  return Object.keys(source)
    .sort()
    .map((key) => ({ key, value: deepCopy(source[key]) }));
}

function filterPackageIds(packageIds: string[]): string[] {
  const seen = new Set<string>();
  const filtered: string[] = [];
  for (const id of Array.isArray(packageIds) ? packageIds : []) {
    if (typeof id !== "string" || id.length === 0 || seen.has(id)) {
      continue;
    }
    seen.add(id);
    filtered.push(id);
  }
  return filtered;
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    unique.push(value);
  }
  return unique;
}

function deriveComponents(sources: Record<string, unknown>[]): PlanComponent[] {
  const seen = new Map<string, number>();
  return sources.map((source) => {
    const base = `comp-${contentHash(source).slice(0, 16)}`;
    const occurrence = seen.get(base) ?? 0;
    seen.set(base, occurrence + 1);
    return {
      componentId: occurrence === 0 ? base : `${base}-${occurrence + 1}`,
      definition: deepCopy(source) as Record<string, unknown>,
    };
  });
}

function derivedAssumptions(
  spec: ReconstructionSpec,
  model: BehavioralIr,
  effectivePackageIds: string[],
): DerivedAssumption[] {
  const assumptions: DerivedAssumption[] = [];
  const journeyIds = new Set(model.journeys.map((journey) => journey.id));
  const reported = new Set<string>();
  for (const [index, id] of spec.verification.journeys.entries()) {
    if (journeyIds.has(id) || reported.has(id)) {
      continue;
    }
    reported.add(id);
    assumptions.push({
      source: "synthesis",
      reason: `Acceptance journey "${id}" is required by the reconstruction spec but is absent from the behavioral model.`,
      path: `spec.verification.journeys[${index}]`,
    });
  }
  if (Object.keys(model.api).length === 0) {
    assumptions.push({
      source: "synthesis",
      reason:
        "Behavioral model declares no API surface (model.api is empty); the plan carries no api entries.",
      path: "model.api",
    });
  }
  if (Object.keys(model.data).length === 0) {
    assumptions.push({
      source: "synthesis",
      reason:
        "Behavioral model declares no persisted data (model.data is empty); the plan carries no persistence entries.",
      path: "model.data",
    });
  }
  if (effectivePackageIds.length === 0) {
    assumptions.push({
      source: "synthesis",
      reason: "No well-formed package ids were supplied; the plan references no packages.",
      path: "packageIds",
    });
  }
  return assumptions;
}

/**
 * Deterministic derivation of a framework-neutral SynthesisPlan from a frozen
 * BehavioralIr, a ReconstructionSpec and candidate package ids.
 *
 * The same (spec, model, packageIds) triple always yields a deep-equal plan and
 * a byte-identical canonical serialization: no timestamps, no random ids, and
 * derived component ids are content-hashed over the canonical JSON form. The
 * inputs are never mutated; every carried value is deep-copied, so the plan
 * shares no references with the model or spec.
 */
function planSynthesis(
  spec: ReconstructionSpec,
  model: BehavioralIr,
  packageIds: string[],
): SynthesisPlan {
  const journeyIds = new Set(model.journeys.map((journey) => journey.id));

  const routes: PlanRoute[] = model.journeys.map((journey) => ({
    journeyId: journey.id,
    name: journey.name,
    steps: journey.steps.length,
  }));

  const components = deriveComponents(model.components);
  const persistence = keyedEntries(model.data);
  const api = keyedEntries(model.api);
  const integrations = model.integrations.map(
    (entry) => deepCopy(entry) as Record<string, unknown>,
  );

  const effectivePackageIds = filterPackageIds(packageIds);
  const acceptanceJourneyIds = uniqueStrings(
    spec.verification.journeys.filter((id) => journeyIds.has(id)),
  );

  const assumptions: Record<string, unknown>[] = model.assumptions.map(
    (entry) => deepCopy(entry) as Record<string, unknown>,
  );
  assumptions.push(...derivedAssumptions(spec, model, effectivePackageIds));

  return {
    schemaVersion: CLAPP_CONTRACT_VERSION,
    architecture: {
      platform: spec.platform,
      targetStack: spec.synthesis.targetStack,
      deterministic: true,
      journeyCount: model.journeys.length,
      componentCount: model.components.length,
      integrationCount: model.integrations.length,
    },
    routes,
    components,
    state: deepCopy(model.state) as Record<string, unknown>,
    persistence,
    integrations,
    api,
    packageIds: effectivePackageIds,
    acceptanceJourneyIds,
    assumptions,
  };
}

/**
 * Public planner API: deterministic synchronous derivation wrapped in a
 * Promise for contract compatibility with `Synthesizer.plan`.
 */
export function planSynthesisApp(
  spec: ReconstructionSpec,
  model: BehavioralIr,
  packageIds: string[],
): Promise<SynthesisPlan> {
  return Promise.resolve(planSynthesis(spec, model, packageIds));
}
