import type { SynthesisPlan } from "@clapp/contracts";
import { validateGeneratedApp } from "./app-validate.ts";
import { isPlainObject } from "./canonical.ts";
import type { GeneratedApp } from "./generator.ts";
import { contentHash } from "./hash.ts";
import type { PlanRoute } from "./plan.ts";
import { validateSynthesisPlan } from "./validate.ts";

/** The generated acceptance suite file name (the frozen W3-002 pin). */
export const SUITE_FILE_NAME = "journeys.test.ts";

/** The frozen index-route test name inside the generated suite. */
export const INDEX_ROUTE_TEST_NAME = "index route serves the generated app";

/** Prefix of the frozen acceptance-journey test names (one per spec selection). */
export const ACCEPTANCE_JOURNEY_TEST_PREFIX = "acceptance journey: ";

/** Prefix of the CLAPP-W3-003 additive route-coverage test names. */
export const ROUTE_COVERAGE_TEST_PREFIX = "route coverage: ";

/**
 * One plan journey's coverage verdict: the route contract (journeyId, name,
 * observed step count, path), whether the spec selected the journey for
 * acceptance (from plan.acceptanceJourneyIds — never sniffed from the suite),
 * whether a generated test actually pins it, and the recorded reason. A
 * not-covered verdict with an honest reason is a correct output; a fabricated
 * pin or an invented step action is a failure.
 */
export type JourneyCoverage = {
  journeyId: string;
  name: string;
  steps: number;
  path: string;
  /** The spec's acceptance selection, carried by plan.acceptanceJourneyIds. */
  acceptance: boolean;
  /** True only when a generated test pins this route's page anchors. */
  covered: boolean;
  /** The pinning test's name when covered; null otherwise. */
  pinningTest: string | null;
  /** The recorded reason: which test pins it, or why nothing does. */
  reason: string;
};

/**
 * The honest coverage digest of a generated application's acceptance suite:
 * per plan journey, covered or not-covered with a recorded reason, plus the
 * index route's verdict and totals. Journeys the suite genuinely does not pin
 * are reported as not-covered, never silently dropped.
 */
export type SuiteCoverageDigest = {
  indexCovered: boolean;
  indexReason: string;
  journeys: JourneyCoverage[];
  totals: { planJourneys: number; covered: number; notCovered: number };
};

/** The emitted `test(<name>, ...)` source prefix for a generated test name. */
function suiteTestCall(testName: string): string {
  return `test(${JSON.stringify(testName)}`;
}

/** Normalized, copied plan routes (the plan validator has already run). */
function normalizedPlanRoutes(plan: SynthesisPlan): PlanRoute[] {
  return plan.routes.map((entry) => {
    const route = entry as unknown as PlanRoute;
    return {
      journeyId: String(route.journeyId),
      name: String(route.name),
      steps: Number(route.steps),
    };
  });
}

/** Order-sensitive equality of the manifest's and the plan's acceptance selection. */
function acceptanceSelectionMatches(manifestIds: string[], planIds: string[]): boolean {
  return (
    manifestIds.length === planIds.length && manifestIds.every((id, index) => id === planIds[index])
  );
}

/**
 * Computes the honest suite coverage digest of a generated application against
 * the plan it claims to implement. Pure: neither the plan nor the app is ever
 * mutated.
 *
 * Fail-closed: a malformed pairing — a plan or app that fails structural
 * validation, a missing suite file, a manifest/plan disagreement (digest,
 * route count, acceptance selection), tampered routes.json route entries, or
 * wrong manifest counts (components, pages) — surfaces as ONE TypeError
 * carrying every collected error, never as silently-degraded coverage.
 *
 * Coverage honesty: acceptance selection comes from the spec (via
 * plan.acceptanceJourneyIds), never from sniffing the suite's test names; a
 * journey the suite does not pin is reported not-covered with its reason.
 */
export function digestSuiteCoverage(input: {
  plan: SynthesisPlan;
  app: GeneratedApp;
}): SuiteCoverageDigest {
  const errors: string[] = [];

  const planValidation = validateSynthesisPlan(input.plan);
  if (!planValidation.ok) {
    errors.push(
      `plan: SynthesisPlan failed structural validation: ${planValidation.errors.join("; ")}`,
    );
  }
  const appValidation = validateGeneratedApp(input.app);
  if (!appValidation.ok) {
    errors.push(
      `app: generated app failed structural validation: ${appValidation.errors.join("; ")}`,
    );
  }

  const suiteFile = input.app.files.find((file) => file.path === SUITE_FILE_NAME);
  if (suiteFile === undefined) {
    errors.push(`$.files: missing the generated acceptance suite "${SUITE_FILE_NAME}"`);
  }

  if (planValidation.ok && appValidation.ok) {
    const planRoutes = normalizedPlanRoutes(input.plan);
    const manifest = input.app.manifest;

    if (manifest.planDigest !== contentHash(input.plan)) {
      errors.push(
        "$.manifest.planDigest: app/plan disagreement — the app was not generated from this plan",
      );
    }
    if (manifest.routeCount !== planRoutes.length) {
      errors.push(
        `$.manifest.routeCount: expected ${planRoutes.length} (the plan's route count), got ${manifest.routeCount}`,
      );
    }
    if (
      !acceptanceSelectionMatches(manifest.acceptanceJourneyIds, input.plan.acceptanceJourneyIds)
    ) {
      errors.push(
        "$.manifest.acceptanceJourneyIds: app/plan disagreement — does not match the plan's acceptance selection",
      );
    }

    const componentFileCount = input.app.files.filter(
      (file) => file.path.startsWith("components/") && file.path.endsWith(".json"),
    ).length;
    if (componentFileCount !== manifest.componentCount) {
      errors.push(
        `$.manifest.componentCount: expected ${componentFileCount} generated component files, got ${manifest.componentCount}`,
      );
    }
    const pageFileCount = input.app.files.filter(
      (file) => file.path.startsWith("pages/") && file.path.endsWith(".html"),
    ).length;
    if (pageFileCount !== manifest.routeCount + 1) {
      errors.push(
        `pages: expected ${manifest.routeCount + 1} generated pages (index plus routes), got ${pageFileCount}`,
      );
    }

    const routesFile = input.app.files.find((file) => file.path === "routes.json");
    let parsedRoutes: unknown;
    if (routesFile === undefined) {
      errors.push('$.files: missing "routes.json" (the route inventory the suite replays)');
      parsedRoutes = [];
    } else {
      try {
        parsedRoutes = JSON.parse(routesFile.content);
      } catch {
        parsedRoutes = undefined;
      }
    }
    if (routesFile !== undefined && !Array.isArray(parsedRoutes)) {
      errors.push("routes.json: expected a JSON array of route entries");
    } else if (Array.isArray(parsedRoutes)) {
      const entries = parsedRoutes as Record<string, unknown>[];
      const indexEntry = entries[0];
      if (
        !isPlainObject(indexEntry) ||
        indexEntry.journeyId !== "index" ||
        indexEntry.path !== "/"
      ) {
        errors.push(
          'routes.json[0]: expected the always-generated index route (journeyId "index", path "/")',
        );
      }
      if (entries.length !== planRoutes.length + 1) {
        errors.push(
          `routes.json: expected ${planRoutes.length + 1} entries (index plus ${planRoutes.length} plan routes), got ${entries.length}`,
        );
      }
      const seenPaths = new Set<string>();
      for (const [index, route] of planRoutes.entries()) {
        const entry = entries[index + 1];
        const entryPath = `routes.json[${index + 1}]`;
        if (!isPlainObject(entry)) {
          errors.push(`${entryPath}: expected an object`);
          continue;
        }
        const path = typeof entry.path === "string" ? entry.path : "";
        if (path.length === 0 || !path.startsWith("/") || seenPaths.has(path)) {
          errors.push(`${entryPath}.path: expected a unique route path starting with "/"`);
        } else {
          seenPaths.add(path);
        }
        if (
          entry.journeyId !== route.journeyId ||
          entry.name !== route.name ||
          entry.steps !== route.steps
        ) {
          errors.push(
            `${entryPath}: app/plan disagreement for journey ${JSON.stringify(route.journeyId)} (journeyId, name and steps must match the plan route)`,
          );
        }
      }
    }
  }

  if (errors.length > 0) {
    throw new TypeError(`suite coverage digest failed closed: ${errors.join("; ")}`);
  }

  // Structural validation guarantees the suite file exists past this point.
  const suite = suiteFile?.content ?? "";
  const planRoutes = normalizedPlanRoutes(input.plan);
  const acceptanceIds = new Set<string>(input.plan.acceptanceJourneyIds);
  const firstRouteIndexByJourney = new Map<string, number>();
  for (const [index, route] of planRoutes.entries()) {
    if (!firstRouteIndexByJourney.has(route.journeyId)) {
      firstRouteIndexByJourney.set(route.journeyId, index);
    }
  }
  const routePaths: string[] = [];
  const routesFile = input.app.files.find((file) => file.path === "routes.json");
  if (routesFile !== undefined) {
    const entries = JSON.parse(routesFile.content) as Array<{ path?: unknown }>;
    for (const [index] of planRoutes.entries()) {
      const entry = entries[index + 1];
      routePaths.push(typeof entry?.path === "string" ? entry.path : "");
    }
  }

  const journeys: JourneyCoverage[] = planRoutes.map((route, index) => {
    const path = routePaths[index] ?? "";
    if (acceptanceIds.has(route.journeyId)) {
      if (firstRouteIndexByJourney.get(route.journeyId) === index) {
        const testName = `${ACCEPTANCE_JOURNEY_TEST_PREFIX}${route.journeyId}`;
        const covered = suite.includes(suiteTestCall(testName));
        return {
          journeyId: route.journeyId,
          name: route.name,
          steps: route.steps,
          path,
          acceptance: true,
          covered,
          pinningTest: covered ? testName : null,
          reason: covered
            ? `pinned by the generated acceptance test (the spec's acceptance selection, carried by plan.acceptanceJourneyIds)`
            : `the spec selects this journey for acceptance, but the suite has no test named ${JSON.stringify(testName)}`,
        };
      }
      return {
        journeyId: route.journeyId,
        name: route.name,
        steps: route.steps,
        path,
        acceptance: true,
        covered: false,
        pinningTest: null,
        reason: `an earlier route already carries journeyId ${JSON.stringify(route.journeyId)}; the acceptance test pins that route's page`,
      };
    }
    const testName = `${ROUTE_COVERAGE_TEST_PREFIX}${route.journeyId}`;
    const namePinned = suite.includes(suiteTestCall(testName));
    const pathPinned = path.length > 0 && suite.includes(JSON.stringify(path));
    const covered = namePinned && pathPinned;
    return {
      journeyId: route.journeyId,
      name: route.name,
      steps: route.steps,
      path,
      acceptance: false,
      covered,
      pinningTest: covered ? testName : null,
      reason: covered
        ? "pinned by the additive route coverage test (not selected for acceptance by the spec)"
        : namePinned
          ? `the suite names a route coverage test but never pins this route's path ${JSON.stringify(path)}`
          : "the generated suite emits no test for this journey (the spec does not select it for acceptance, so only route coverage could pin it)",
    };
  });

  const indexCovered = suite.includes(suiteTestCall(INDEX_ROUTE_TEST_NAME));
  const coveredCount = journeys.filter((journey) => journey.covered).length;

  return {
    indexCovered,
    indexReason: indexCovered
      ? "the always-generated index test pins the index route's anchors and the API round-trip"
      : "the generated suite has no index route test",
    journeys,
    totals: {
      planJourneys: planRoutes.length,
      covered: coveredCount,
      notCovered: planRoutes.length - coveredCount,
    },
  };
}
