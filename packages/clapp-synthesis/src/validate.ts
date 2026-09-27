import { CLAPP_CONTRACT_VERSION } from "@clapp/contracts";
import { isPlainObject } from "./canonical.ts";

export type ValidationResult = { ok: boolean; errors: string[] };

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

function checkString(value: unknown, path: string, errors: string[]): void {
  if (typeof value !== "string") {
    errors.push(`${path}: expected a string, ${describe(value)}`);
  }
}

function checkNonEmptyString(value: unknown, path: string, errors: string[]): void {
  if (typeof value !== "string" || value.length === 0) {
    errors.push(`${path}: expected a non-empty string, ${describe(value)}`);
  }
}

function checkNonNegativeInteger(value: unknown, path: string, errors: string[]): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    errors.push(`${path}: expected a non-negative integer, ${describe(value)}`);
  }
}

function checkObject(value: unknown, path: string, errors: string[]): void {
  if (!isPlainObject(value)) {
    errors.push(`${path}: expected an object, ${describe(value)}`);
  }
}

function checkRecordArray(
  value: unknown,
  path: string,
  errors: string[],
  checkElement?: (element: Record<string, unknown>, elementPath: string) => void,
): void {
  if (!Array.isArray(value)) {
    errors.push(`${path}: expected an array, ${describe(value)}`);
    return;
  }
  for (const [index, element] of value.entries()) {
    const elementPath = `${path}[${index}]`;
    if (!isPlainObject(element)) {
      errors.push(`${elementPath}: expected an object, ${describe(element)}`);
      continue;
    }
    checkElement?.(element, elementPath);
  }
}

function checkIdList(value: unknown, path: string, errors: string[]): void {
  if (!Array.isArray(value)) {
    errors.push(`${path}: expected an array of strings, ${describe(value)}`);
    return;
  }
  const firstSeen = new Map<string, number>();
  for (const [index, id] of value.entries()) {
    const idPath = `${path}[${index}]`;
    if (typeof id !== "string" || id.length === 0) {
      errors.push(`${idPath}: expected a non-empty string, ${describe(id)}`);
      continue;
    }
    const first = firstSeen.get(id);
    if (first === undefined) {
      firstSeen.set(id, index);
    } else {
      errors.push(`${idPath}: duplicate ${JSON.stringify(id)} (first seen at ${path}[${first}])`);
    }
  }
}

/**
 * Every acceptance journey must be addressable through a route, otherwise the
 * verification stage could never replay it against the candidate.
 */
function checkAcceptanceJourneysHaveRoutes(plan: Record<string, unknown>, errors: string[]): void {
  if (!Array.isArray(plan.routes) || !Array.isArray(plan.acceptanceJourneyIds)) {
    return;
  }
  const routes = plan.routes as unknown[];
  const acceptanceJourneyIds = plan.acceptanceJourneyIds as unknown[];
  const routeJourneyIds = new Set<string>();
  for (const route of routes) {
    if (isPlainObject(route) && typeof route.journeyId === "string" && route.journeyId.length > 0) {
      routeJourneyIds.add(route.journeyId);
    }
  }
  for (const [index, id] of acceptanceJourneyIds.entries()) {
    if (typeof id === "string" && !routeJourneyIds.has(id)) {
      errors.push(
        `$.acceptanceJourneyIds[${index}]: no route carries journeyId ${JSON.stringify(id)}`,
      );
    }
  }
}

/**
 * Structural validation of a SynthesisPlan against the frozen v0.1 contract
 * plus the plan record shapes defined by this package. Never throws: any
 * non-conforming input yields `ok: false` with errors that each carry a JSON
 * path and a reason.
 */
export function validateSynthesisPlan(plan: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isPlainObject(plan)) {
    return { ok: false, errors: [`$: expected a SynthesisPlan object, ${describe(plan)}`] };
  }

  if (plan.schemaVersion !== CLAPP_CONTRACT_VERSION) {
    errors.push(
      `$.schemaVersion: expected "${CLAPP_CONTRACT_VERSION}", ${describe(plan.schemaVersion)}`,
    );
  }

  checkRecordArray(plan.routes, "$.routes", errors, (route, path) => {
    checkNonEmptyString(route.journeyId, `${path}.journeyId`, errors);
    checkString(route.name, `${path}.name`, errors);
    checkNonNegativeInteger(route.steps, `${path}.steps`, errors);
  });

  checkRecordArray(plan.components, "$.components", errors, (component, path) => {
    checkNonEmptyString(component.componentId, `${path}.componentId`, errors);
    checkObject(component.definition, `${path}.definition`, errors);
  });

  checkObject(plan.state, "$.state", errors);

  checkRecordArray(plan.persistence, "$.persistence", errors, (entry, path) => {
    checkNonEmptyString(entry.key, `${path}.key`, errors);
  });

  checkRecordArray(plan.integrations, "$.integrations", errors);

  checkRecordArray(plan.api, "$.api", errors, (entry, path) => {
    checkNonEmptyString(entry.key, `${path}.key`, errors);
  });

  checkIdList(plan.packageIds, "$.packageIds", errors);
  checkIdList(plan.acceptanceJourneyIds, "$.acceptanceJourneyIds", errors);

  checkRecordArray(plan.assumptions, "$.assumptions", errors);
  checkObject(plan.architecture, "$.architecture", errors);

  checkAcceptanceJourneysHaveRoutes(plan, errors);

  return { ok: errors.length === 0, errors };
}
