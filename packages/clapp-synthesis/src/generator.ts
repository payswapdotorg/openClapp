import type { SynthesisPlan } from "@clapp/contracts";
import { isPlainObject } from "./canonical.ts";
import {
  emitApiJson,
  emitComponentJson,
  emitIndexPage,
  emitJourneyPage,
  emitJourneysTest,
  emitPackageJson,
  emitPersistenceJson,
  emitRoutesJson,
  emitServerSource,
  emitStateJson,
  type WebAcceptanceJourney,
  type WebRouteEntry,
} from "./emit-web.ts";
import { contentHash } from "./hash.ts";
import type { PlanComponent, PlanKeyedEntry, PlanRoute } from "./plan.ts";
import { validateSynthesisPlan } from "./validate.ts";

/** One generated file of a candidate application: workspace-relative path + UTF-8 text. */
export type GeneratedFile = { path: string; content: string };

/**
 * The manifest of a generated candidate application. Deterministic by
 * construction: no timestamps, no random ids — the same SynthesisPlan always
 * produces the same manifest and the same byte-identical file set. There is
 * deliberately no `generatedAt` field.
 */
export type GeneratedAppManifest = {
  appKind: "web";
  /** sha256 of the plan's canonical serialization. */
  planDigest: string;
  routeCount: number;
  componentCount: number;
  acceptanceJourneyIds: string[];
  entrypoint: string;
  buildCommand: string;
  testCommand: string;
  /** Carried verbatim (deep-copied) from plan.assumptions. */
  assumptions: Record<string, unknown>[];
};

/** A fully generated candidate application: manifest plus sorted file set. */
export type GeneratedApp = { manifest: GeneratedAppManifest; files: GeneratedFile[] };

/** The generated server module — the candidate workspace entrypoint. */
export const CANDIDATE_ENTRYPOINT = "server.ts";
/** Build command the seam composes as a bounded run: syntax-checks the server. */
export const CANDIDATE_BUILD_COMMAND = "node --check server.ts";
/** Test command the seam composes as a bounded run: runs the generated suite. */
export const CANDIDATE_TEST_COMMAND = "npx tsx --test journeys.test.ts";

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

/** Normalized, copied plan routes (the plan validator has already run). */
function planRoutesOf(plan: SynthesisPlan): PlanRoute[] {
  return plan.routes.map((entry) => {
    const route = entry as unknown as PlanRoute;
    return {
      journeyId: String(route.journeyId),
      name: String(route.name),
      steps: Number(route.steps),
    };
  });
}

/** Normalized, deep-copied plan components. */
function planComponentsOf(plan: SynthesisPlan): PlanComponent[] {
  return plan.components.map((entry) => {
    const component = entry as unknown as PlanComponent;
    return {
      componentId: String(component.componentId),
      definition: deepCopy(component.definition) as Record<string, unknown>,
    };
  });
}

/** Normalized, deep-copied keyed entries (persistence / api). */
function planKeyedEntriesOf(source: Record<string, unknown>[]): PlanKeyedEntry[] {
  return source.map((entry) => {
    const keyed = entry as unknown as PlanKeyedEntry;
    return { key: String(keyed.key), value: deepCopy(keyed.value) };
  });
}

/**
 * Stable slug for a route path segment: lowercase ASCII alphanumerics and
 * hyphens only. Collisions never occur inside one slug space because
 * `allocateStem` disambiguates with numeric suffixes in plan order.
 */
function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "route";
}

/**
 * File-name-safe stem for a component id: keeps filename-friendly ASCII,
 * refuses hidden-file and traversal shapes, caps the length. The charset
 * excludes backticks and quotes, so stems are always safe to embed.
 */
function safeComponentStem(componentId: string): string {
  const cleaned = componentId.replaceAll(/[^a-zA-Z0-9._-]+/g, "-").replaceAll(/^-+|-+$/g, "");
  const trimmed = cleaned.length > 96 ? cleaned.slice(0, 96) : cleaned;
  if (trimmed.length === 0) {
    return "component";
  }
  if (trimmed.startsWith(".")) {
    return `component-${trimmed.slice(1)}`;
  }
  return trimmed;
}

/** Allocates a unique stem in first-come order with -2, -3, ... suffixes. */
function allocateStem(used: Set<string>, base: string): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let counter = 2;
  while (used.has(`${base}-${counter}`)) {
    counter += 1;
  }
  const stem = `${base}-${counter}`;
  used.add(stem);
  return stem;
}

/**
 * Deterministically generates a runnable web candidate application from a
 * SynthesisPlan: the file set plus its manifest.
 *
 * The emitted application is a zero-dependency node:http server (server.ts)
 * with one semantic HTML page per plan route (plus the always-generated index
 * route "/"), a JSON API store seeded from the plan's persistence and api
 * entries (GET/PUT /api/<key>), the plan's state/api/components artifacts as
 * canonical JSON files, and a generated node:test acceptance suite replaying
 * every acceptance journey over loopback.
 *
 * Guarantees:
 * - purity — the input plan is never mutated; every carried value is copied;
 * - determinism — the same plan yields byte-identical files (content-hash and
 *   counter-stable ids only, no timestamps, no environment reads);
 * - honesty — an invalid plan is refused with a TypeError listing the
 *   structural errors instead of generating a broken candidate.
 */
export function generateCandidateApp(plan: SynthesisPlan): GeneratedApp {
  const validation = validateSynthesisPlan(plan);
  if (!validation.ok) {
    throw new TypeError(
      `SynthesisPlan failed structural validation: ${validation.errors.join("; ")}`,
    );
  }

  const routes = planRoutesOf(plan);
  const components = planComponentsOf(plan);
  const persistence = planKeyedEntriesOf(plan.persistence);
  const api = planKeyedEntriesOf(plan.api);

  // One page stem per route; the index route reserves "index" first.
  const usedStems = new Set<string>(["index"]);
  const webRoutes: WebRouteEntry[] = [];
  for (const route of routes) {
    const stem = allocateStem(usedStems, slugify(route.journeyId));
    webRoutes.push({
      journeyId: route.journeyId,
      name: route.name,
      steps: route.steps,
      path: `/${stem}`,
      page: `pages/${stem}.html`,
    });
  }
  const indexRoute: WebRouteEntry = {
    journeyId: "index",
    name: "Index",
    steps: 0,
    path: "/",
    page: "pages/index.html",
  };

  // First route per journeyId resolves acceptance journeys to their pages.
  const routeByJourney = new Map<string, WebRouteEntry>();
  for (const webRoute of webRoutes) {
    if (!routeByJourney.has(webRoute.journeyId)) {
      routeByJourney.set(webRoute.journeyId, webRoute);
    }
  }

  // API store seed: persistence entries first, api entries fill the gaps —
  // exactly the merge order the generated server performs at startup.
  const store: Record<string, unknown> = {};
  for (const entry of persistence) {
    store[entry.key] = entry.value;
  }
  for (const entry of api) {
    if (!(entry.key in store)) {
      store[entry.key] = entry.value;
    }
  }
  const apiKeys = Object.keys(store).sort();

  const acceptance: WebAcceptanceJourney[] = [];
  for (const journeyId of plan.acceptanceJourneyIds) {
    const route = routeByJourney.get(journeyId);
    if (route === undefined) {
      // Unreachable after validateSynthesisPlan (acceptance ids must have
      // routes); kept as a fail-closed guard rather than an invention.
      throw new TypeError(`acceptance journey "${journeyId}" has no route`);
    }
    acceptance.push({
      journeyId,
      name: route.name,
      steps: route.steps,
      path: route.path,
    });
  }

  const componentStems = new Set<string>();
  const componentFiles: GeneratedFile[] = components.map((component) => {
    const stem = allocateStem(componentStems, safeComponentStem(component.componentId));
    return {
      path: `components/${stem}.json`,
      content: emitComponentJson(component),
    };
  });

  const files: GeneratedFile[] = [
    {
      path: "package.json",
      content: emitPackageJson(CANDIDATE_BUILD_COMMAND, CANDIDATE_TEST_COMMAND),
    },
    { path: "server.ts", content: emitServerSource() },
    { path: "routes.json", content: emitRoutesJson([indexRoute, ...webRoutes]) },
    { path: "state.json", content: emitStateJson(plan.state) },
    { path: "persistence.json", content: emitPersistenceJson(persistence) },
    { path: "api.json", content: emitApiJson(api) },
    { path: "pages/index.html", content: emitIndexPage(webRoutes) },
    ...webRoutes.map(
      (route): GeneratedFile => ({ path: route.page, content: emitJourneyPage(route) }),
    ),
    ...componentFiles,
    {
      path: "journeys.test.ts",
      content: emitJourneysTest({ acceptance, apiKeys, expectedApi: store }),
    },
  ];
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const manifest: GeneratedAppManifest = {
    appKind: "web",
    planDigest: contentHash(plan),
    routeCount: routes.length,
    componentCount: components.length,
    acceptanceJourneyIds: [...plan.acceptanceJourneyIds],
    entrypoint: CANDIDATE_ENTRYPOINT,
    buildCommand: CANDIDATE_BUILD_COMMAND,
    testCommand: CANDIDATE_TEST_COMMAND,
    assumptions: deepCopy(plan.assumptions) as Record<string, unknown>[],
  };
  return { manifest, files };
}
