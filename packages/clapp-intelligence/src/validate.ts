import { checkJsonSafety, describeType, isPlainObject, joinKey } from "./json.ts";

export interface BehavioralIrValidationResult {
  ok: boolean;
  errors: string[];
}

const ROOT_PATH = "$";
const EXPECTED_SCHEMA_VERSION = "0.1";
const EVIDENCE_CLASSIFICATIONS = [
  "observed",
  "derived",
  "inferred",
  "assumed",
  "unavailable",
] as const;
const PLATFORMS = ["web", "android", "linux", "windows", "macos", "ios"] as const;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const IR_TOP_LEVEL_FIELDS = [
  "schemaVersion",
  "application",
  "evidence",
  "journeys",
  "screens",
  "components",
  "state",
  "data",
  "api",
  "integrations",
  "assumptions",
  "constraints",
] as const;
const EVIDENCE_STRING_FIELDS = [
  "id",
  "targetId",
  "reconstructionId",
  "kind",
  "source",
  "capturedAt",
] as const;
const EVIDENCE_KNOWN_FIELDS = [...EVIDENCE_STRING_FIELDS, "sha256", "classification", "redacted"];
const APPLICATION_KNOWN_FIELDS = ["id", "name", "platform", "entrypoints"];
const JOURNEY_KNOWN_FIELDS = ["id", "name", "preconditions", "steps"];
const STEP_KNOWN_FIELDS = ["id", "action", "target", "input", "assertions"];
const KEYLESS_ENTRY_FIELDS = [
  "screens",
  "components",
  "integrations",
  "assumptions",
  "constraints",
] as const;
const RECORD_FIELDS = ["state", "data", "api"] as const;

/**
 * Total validation of a candidate Behavioral IR against the frozen
 * @clapp/contracts v0.1 type (the stricter reading wherever the JSON Schema
 * mirror is looser). Never throws: every problem is returned as an error
 * string carrying the JSON path of the offending value plus a human reason.
 * Unknown fields are forward-compatible (never an error by themselves) but
 * their content must still be JSON-serializable so the IR can be canonically
 * serialized.
 */
export function validateBehavioralIr(ir: unknown): BehavioralIrValidationResult {
  const errors: string[] = [];
  if (!isPlainObject(ir)) {
    return {
      ok: false,
      errors: [`${ROOT_PATH}: must be a Behavioral IR object, got ${describeType(ir)}`],
    };
  }
  const record = ir;
  validateSchemaVersion(record.schemaVersion, errors);
  validateApplication(record.application, errors);
  validateEvidence(record.evidence, errors);
  validateJourneys(record.journeys, errors);
  for (const field of KEYLESS_ENTRY_FIELDS) {
    const entries = record[field];
    if (requireArray(entries, field, errors)) {
      for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index];
        const path = `${field}[${index}]`;
        if (requireObject(entry, path, errors)) {
          checkJsonSafety(entry, path, errors);
        }
      }
    }
  }
  for (const field of RECORD_FIELDS) {
    const value = record[field];
    if (requireObject(value, field, errors)) {
      checkJsonSafety(value, field, errors);
    }
  }
  checkUnknownFields(record, IR_TOP_LEVEL_FIELDS, "", errors);
  return { ok: errors.length === 0, errors };
}

function validateSchemaVersion(value: unknown, errors: string[]): void {
  if (value === undefined) {
    errors.push("schemaVersion: required field is missing");
    return;
  }
  if (typeof value !== "string") {
    errors.push(`schemaVersion: must be the string "0.1", got ${describeType(value)}`);
    return;
  }
  if (value !== EXPECTED_SCHEMA_VERSION) {
    errors.push(`schemaVersion: must be "${EXPECTED_SCHEMA_VERSION}", got "${value}"`);
  }
}

function validateApplication(value: unknown, errors: string[]): void {
  if (!requireObject(value, "application", errors)) {
    return;
  }
  requireNonEmptyString(value.id, "application.id", errors);
  requireNonEmptyString(value.name, "application.name", errors);
  requireEnumValue(value.platform, PLATFORMS, "application.platform", errors);
  const entrypoints = value.entrypoints;
  if (requireArray(entrypoints, "application.entrypoints", errors)) {
    for (let index = 0; index < entrypoints.length; index += 1) {
      requireNonEmptyString(entrypoints[index], `application.entrypoints[${index}]`, errors);
    }
  }
  checkUnknownFields(value, APPLICATION_KNOWN_FIELDS, "application", errors);
}

function validateEvidence(value: unknown, errors: string[]): void {
  if (!requireArray(value, "evidence", errors)) {
    return;
  }
  const evidenceIds = new Map<string, number>();
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    const path = `evidence[${index}]`;
    if (!requireObject(entry, path, errors)) {
      continue;
    }
    for (const field of EVIDENCE_STRING_FIELDS) {
      requireNonEmptyString(entry[field], `${path}.${field}`, errors);
    }
    requireSha256(entry.sha256, `${path}.sha256`, errors);
    requireEnumValue(
      entry.classification,
      EVIDENCE_CLASSIFICATIONS,
      `${path}.classification`,
      errors,
    );
    requireBoolean(entry.redacted, `${path}.redacted`, errors);
    if (isNonEmptyString(entry.id)) {
      recordUniqueId(evidenceIds, entry.id, index, `${path}.id`, "evidence", errors);
    }
    checkUnknownFields(entry, EVIDENCE_KNOWN_FIELDS, path, errors);
  }
}

function validateJourneys(value: unknown, errors: string[]): void {
  if (!requireArray(value, "journeys", errors)) {
    return;
  }
  const journeyIds = new Map<string, number>();
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    const path = `journeys[${index}]`;
    if (!requireObject(entry, path, errors)) {
      continue;
    }
    requireNonEmptyString(entry.id, `${path}.id`, errors);
    requireNonEmptyString(entry.name, `${path}.name`, errors);
    const preconditions = entry.preconditions;
    if (requireArray(preconditions, `${path}.preconditions`, errors)) {
      for (let preIndex = 0; preIndex < preconditions.length; preIndex += 1) {
        requireNonEmptyString(
          preconditions[preIndex],
          `${path}.preconditions[${preIndex}]`,
          errors,
        );
      }
    }
    if (isNonEmptyString(entry.id)) {
      recordUniqueId(journeyIds, entry.id, index, `${path}.id`, "journeys", errors);
    }
    validateSteps(entry.steps, path, errors);
    checkUnknownFields(entry, JOURNEY_KNOWN_FIELDS, path, errors);
  }
}

function validateSteps(steps: unknown, journeyPath: string, errors: string[]): void {
  if (!requireArray(steps, `${journeyPath}.steps`, errors)) {
    return;
  }
  const stepIds = new Map<string, number>();
  for (let index = 0; index < steps.length; index += 1) {
    const entry = steps[index];
    const path = `${journeyPath}.steps[${index}]`;
    if (!requireObject(entry, path, errors)) {
      continue;
    }
    requireNonEmptyString(entry.id, `${path}.id`, errors);
    requireNonEmptyString(entry.action, `${path}.action`, errors);
    if (entry.target !== undefined) {
      requireNonEmptyString(entry.target, `${path}.target`, errors);
    }
    if (entry.input !== undefined) {
      if (requireObject(entry.input, `${path}.input`, errors)) {
        checkJsonSafety(entry.input, `${path}.input`, errors);
      }
    }
    if (entry.assertions !== undefined) {
      if (requireObject(entry.assertions, `${path}.assertions`, errors)) {
        checkJsonSafety(entry.assertions, `${path}.assertions`, errors);
      }
    }
    if (isNonEmptyString(entry.id)) {
      recordUniqueId(stepIds, entry.id, index, `${path}.id`, `${journeyPath}.steps`, errors);
    }
    checkUnknownFields(entry, STEP_KNOWN_FIELDS, path, errors);
  }
}

/**
 * Records the first occurrence of an id; reports a duplicate against the path
 * of its second occurrence ("...: duplicate id "x" (also at prefix[i])").
 */
function recordUniqueId(
  ids: Map<string, number>,
  id: string,
  index: number,
  path: string,
  containerPrefix: string,
  errors: string[],
): void {
  const firstIndex = ids.get(id);
  if (firstIndex === undefined) {
    ids.set(id, index);
    return;
  }
  errors.push(`${path}: duplicate id "${id}" (also at ${containerPrefix}[${firstIndex}])`);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function requireArray(value: unknown, path: string, errors: string[]): value is unknown[] {
  if (value === undefined) {
    errors.push(`${path}: required field is missing`);
    return false;
  }
  if (!Array.isArray(value)) {
    errors.push(`${path}: must be an array, got ${describeType(value)}`);
    return false;
  }
  return true;
}

function requireObject(
  value: unknown,
  path: string,
  errors: string[],
): value is Record<string, unknown> {
  if (value === undefined) {
    errors.push(`${path}: required field is missing`);
    return false;
  }
  if (!isPlainObject(value)) {
    errors.push(`${path}: must be an object, got ${describeType(value)}`);
    return false;
  }
  return true;
}

function requireBoolean(value: unknown, path: string, errors: string[]): void {
  if (value === undefined) {
    errors.push(`${path}: required field is missing`);
    return;
  }
  if (typeof value !== "boolean") {
    errors.push(`${path}: must be a boolean, got ${describeType(value)}`);
  }
}

function requireNonEmptyString(value: unknown, path: string, errors: string[]): void {
  if (value === undefined) {
    errors.push(`${path}: required field is missing`);
    return;
  }
  if (typeof value !== "string") {
    errors.push(`${path}: must be a non-empty string, got ${describeType(value)}`);
    return;
  }
  if (value.length === 0) {
    errors.push(`${path}: must be a non-empty string`);
  }
}

function requireSha256(value: unknown, path: string, errors: string[]): void {
  if (value === undefined) {
    errors.push(`${path}: required field is missing`);
    return;
  }
  if (typeof value !== "string") {
    errors.push(`${path}: must be 64 lowercase hex characters, got ${describeType(value)}`);
    return;
  }
  if (!SHA256_PATTERN.test(value)) {
    errors.push(
      `${path}: must be 64 lowercase hex characters, got a string of length ${value.length}`,
    );
  }
}

function requireEnumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
  errors: string[],
): void {
  if (value === undefined) {
    errors.push(`${path}: required field is missing`);
    return;
  }
  const suffix = typeof value === "string" ? `, got "${value}"` : `, got ${describeType(value)}`;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    errors.push(`${path}: must be one of: ${allowed.join(", ")}${suffix}`);
  }
}

/** Unknown fields are forward-compatible, but their content must be JSON-safe. */
function checkUnknownFields(
  record: Record<string, unknown>,
  knownFields: readonly string[],
  path: string,
  errors: string[],
): void {
  const known = new Set<string>(knownFields);
  for (const key of Object.keys(record).sort()) {
    if (known.has(key)) {
      continue;
    }
    checkJsonSafety(record[key], joinKey(path, key), errors);
  }
}
