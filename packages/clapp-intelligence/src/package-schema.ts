/**
 * Package document validation (CLAPP-W2-005).
 *
 * Validates an unknown document against the FROZEN package schema
 * (schemas/clapp/package.schema.json, v0.1) exactly:
 *
 * - root: object, required ["schemaVersion", "package"], additionalProperties
 *   false (only those two keys are allowed);
 * - "schemaVersion": string — additionally MUST equal CLAPP_CONTRACT_VERSION
 *   ("0.1"); a mismatch is a validation error;
 * - "package": object with required ["id", "version", "category", "purpose",
 *   "interface", "tests", "provenance"] and additionalProperties true;
 * - types per the frozen schema: strings for id/version/category/purpose,
 *   objects for interface/benchmark/provenance, arrays of strings for
 *   capabilities/constraints/dependencies/supportedTargets, arrays of
 *   objects for tests/failureModes;
 * - "version" must be a conforming MAJOR.MINOR.PATCH numeric version (v0.1
 *   has no pre-release; non-conforming versions are validation errors);
 * - the whole document must be JSON-representable so identity and canonical
 *   serialization are always computable.
 *
 * Validation collects ALL violations (never just the first). Every
 * violation is a PackageValidationError with a JSON-pointer-style path
 * ("package/id", "package/capabilities/1", "" for the root), the violated
 * constraint, and the offending value truncated to 120 characters.
 *
 * The ok-branch value is the validated, normalized ClappPackage: optional
 * schema fields default (empty arrays / empty object), the version is in
 * normalized form, package-level extra keys (additionalProperties: true)
 * are preserved, and every field is a detached deep copy of the input.
 *
 * NOTE on the frozen contracts: the JSON schema types "tests" as an array of
 * objects while the frozen TS interface ClappPackage declares tests: string[].
 * This validator enforces the JSON schema (array of objects) and casts the
 * value to the TS type; the mismatch is reported as a proposed contract
 * revision (see the W2-005 completion report).
 */

import { CLAPP_CONTRACT_VERSION, type ClappPackage } from "@clapp/contracts";
import { compareStrings, describeType, isPlainObject, snippet } from "./json.ts";
import { PackageValidationError } from "./package-error.ts";
import { normalizePackageVersion, parsePackageVersion } from "./package-version.ts";

/** Result of validating a package document: all violations, or the value. */
export type PackageDocumentValidationResult =
  | { ok: true; value: ClappPackage }
  | { ok: false; errors: PackageValidationError[] };

/** Depth guard for the recursive JSON-representability walk. */
const MAX_JSON_DEPTH = 2000;

/** Root-level keys allowed by the frozen schema (additionalProperties: false). */
const ROOT_ALLOWED_KEYS = ["schemaVersion", "package"] as const;

/** package-level required fields, in the frozen schema's declaration order. */
const PACKAGE_REQUIRED_FIELDS = [
  "id",
  "version",
  "category",
  "purpose",
  "interface",
  "tests",
  "provenance",
] as const;

/** package-level fields the frozen schema types as string. */
const PACKAGE_STRING_FIELDS = ["id", "version", "category", "purpose"] as const;

/** package-level fields the frozen schema types as object. */
const PACKAGE_OBJECT_FIELDS = ["interface", "benchmark", "provenance"] as const;

/** package-level fields the frozen schema types as array of strings. */
const PACKAGE_STRING_ARRAY_FIELDS = [
  "capabilities",
  "constraints",
  "dependencies",
  "supportedTargets",
] as const;

/** package-level fields the frozen schema types as array of objects. */
const PACKAGE_OBJECT_ARRAY_FIELDS = ["tests", "failureModes"] as const;

/** The expected string for a missing required field. */
const EXPECTED_REQUIRED = "required";
/** The actual string for a missing required field. */
const ACTUAL_MISSING = "missing";
/** The expected string for a non-conforming version. */
const EXPECTED_VERSION = "MAJOR.MINOR.PATCH numeric version";

/**
 * Validates an unknown document against the frozen CLAPP package schema.
 * Never throws: every violation is collected into the returned errors
 * array. On success the value is the normalized, detached ClappPackage.
 */
export function validatePackageDocument(doc: unknown): PackageDocumentValidationResult {
  const errors: PackageValidationError[] = [];

  if (!isPlainObject(doc)) {
    return {
      ok: false,
      errors: [new PackageValidationError("", "object", describeType(doc))],
    };
  }
  const root = doc;

  // schemaVersion: required, string, equal to CLAPP_CONTRACT_VERSION.
  if (reportMissing(root.schemaVersion, "schemaVersion", errors)) {
    if (typeof root.schemaVersion !== "string") {
      errors.push(
        new PackageValidationError("schemaVersion", "string", describeType(root.schemaVersion)),
      );
    } else if (root.schemaVersion !== CLAPP_CONTRACT_VERSION) {
      errors.push(
        new PackageValidationError(
          "schemaVersion",
          `"${CLAPP_CONTRACT_VERSION}" (CLAPP_CONTRACT_VERSION)`,
          `"${snippet(root.schemaVersion)}"`,
        ),
      );
    }
  }

  // package: required, object. Field checks are only possible when it is one.
  reportMissing(root.package, "package", errors);
  if (isPlainObject(root.package)) {
    validatePackageFields(root.package, errors);
  }

  // Root additionalProperties: false — every other root key is a violation.
  for (const key of Object.keys(root).sort(compareStrings)) {
    if (!ROOT_ALLOWED_KEYS.includes(key as (typeof ROOT_ALLOWED_KEYS)[number])) {
      errors.push(
        new PackageValidationError(
          key,
          "absent (additionalProperties: false at document root)",
          "present",
        ),
      );
    }
  }

  // The whole document must be JSON-representable (identity depends on it).
  collectJsonSafetyErrors(root, "", errors);

  if (errors.length > 0 || !isPlainObject(root.package)) {
    return { ok: false, errors };
  }
  return { ok: true, value: buildValue(root.package) };
}

/** Field-by-field enforcement of the frozen package schema. */
function validatePackageFields(
  pkg: Record<string, unknown>,
  errors: PackageValidationError[],
): void {
  for (const field of PACKAGE_REQUIRED_FIELDS) {
    reportMissing(pkg[field], `package/${field}`, errors);
  }
  for (const field of PACKAGE_STRING_FIELDS) {
    if (pkg[field] !== undefined && typeof pkg[field] !== "string") {
      errors.push(
        new PackageValidationError(`package/${field}`, "string", describeType(pkg[field])),
      );
    }
  }
  for (const field of PACKAGE_OBJECT_FIELDS) {
    if (pkg[field] !== undefined && !isPlainObject(pkg[field])) {
      errors.push(
        new PackageValidationError(`package/${field}`, "object", describeType(pkg[field])),
      );
    }
  }
  for (const field of PACKAGE_STRING_ARRAY_FIELDS) {
    validateStringArray(pkg[field], `package/${field}`, errors);
  }
  for (const field of PACKAGE_OBJECT_ARRAY_FIELDS) {
    validateObjectArray(pkg[field], `package/${field}`, errors);
  }
  // Version format: conforming MAJOR.MINOR.PATCH (v0.1 has no pre-release).
  if (typeof pkg.version === "string" && parsePackageVersion(pkg.version) === null) {
    errors.push(
      new PackageValidationError("package/version", EXPECTED_VERSION, `"${snippet(pkg.version)}"`),
    );
  }
}

/** Array of strings, per the frozen schema. */
function validateStringArray(value: unknown, path: string, errors: PackageValidationError[]): void {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    errors.push(new PackageValidationError(path, "array", describeType(value)));
    return;
  }
  for (let index = 0; index < value.length; index += 1) {
    if (typeof value[index] !== "string") {
      errors.push(
        new PackageValidationError(`${path}/${index}`, "string", describeType(value[index])),
      );
    }
  }
}

/** Array of objects, per the frozen schema. */
function validateObjectArray(value: unknown, path: string, errors: PackageValidationError[]): void {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    errors.push(new PackageValidationError(path, "array", describeType(value)));
    return;
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!isPlainObject(value[index])) {
      errors.push(
        new PackageValidationError(`${path}/${index}`, "object", describeType(value[index])),
      );
    }
  }
}

/**
 * True when the value is present (the caller then applies type rules).
 * Pushes the missing-required violation and returns false otherwise.
 */
function reportMissing(value: unknown, path: string, errors: PackageValidationError[]): boolean {
  if (value === undefined) {
    errors.push(new PackageValidationError(path, EXPECTED_REQUIRED, ACTUAL_MISSING));
    return false;
  }
  return true;
}

/**
 * Walks a value and reports every non-JSON-representable leaf (undefined,
 * functions, symbols, bigints, non-finite numbers, non-plain objects such
 * as Date/Map/class instances, cyclic references, over-deep nesting) as a
 * structured error. Never throws and never recurses past MAX_JSON_DEPTH.
 */
function collectJsonSafetyErrors(
  value: unknown,
  path: string,
  errors: PackageValidationError[],
): void {
  const ancestors = new WeakSet<object>();
  visit(value, path, 0);

  function visit(current: unknown, currentPath: string, depth: number): void {
    if (depth > MAX_JSON_DEPTH) {
      errors.push(
        new PackageValidationError(
          currentPath,
          "JSON-representable value",
          `nested deeper than ${MAX_JSON_DEPTH}`,
        ),
      );
      return;
    }
    switch (typeof current) {
      case "string":
      case "boolean":
        return;
      case "number":
        if (!Number.isFinite(current)) {
          errors.push(
            new PackageValidationError(
              currentPath,
              "JSON-representable value",
              "non-finite number",
            ),
          );
        }
        return;
      case "bigint":
        errors.push(
          new PackageValidationError(currentPath, "JSON-representable value", "bigint value"),
        );
        return;
      case "symbol":
        errors.push(
          new PackageValidationError(currentPath, "JSON-representable value", "symbol value"),
        );
        return;
      case "function":
        errors.push(
          new PackageValidationError(currentPath, "JSON-representable value", "function value"),
        );
        return;
      case "undefined":
        errors.push(
          new PackageValidationError(currentPath, "JSON-representable value", "undefined value"),
        );
        return;
      case "object": {
        if (current === null) {
          return;
        }
        const node = current as object;
        if (ancestors.has(node)) {
          errors.push(
            new PackageValidationError(currentPath, "JSON-representable value", "cyclic reference"),
          );
          return;
        }
        ancestors.add(node);
        if (Array.isArray(current)) {
          for (let index = 0; index < current.length; index += 1) {
            visit(current[index], `${currentPath}/${index}`, depth + 1);
          }
        } else if (isPlainObject(current)) {
          for (const key of Object.keys(current).sort(compareStrings)) {
            visit(current[key], currentPath === "" ? key : `${currentPath}/${key}`, depth + 1);
          }
        } else {
          errors.push(
            new PackageValidationError(
              currentPath,
              "JSON-representable value",
              describeType(current),
            ),
          );
        }
        ancestors.delete(node);
        return;
      }
    }
  }
}

/** Detached deep copy of an already-validated JSON value. */
function deepCopyJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Builds the normalized ok-branch value: defaults for schema-optional
 * fields, normalized version, package-level extra keys preserved
 * (additionalProperties: true), everything detached from the input.
 */
function buildValue(pkg: Record<string, unknown>): ClappPackage {
  const copy = deepCopyJson(pkg);
  return {
    ...copy,
    schemaVersion: CLAPP_CONTRACT_VERSION,
    id: copy.id as string,
    version: normalizePackageVersion(copy.version as string),
    category: copy.category as string,
    purpose: copy.purpose as string,
    interface: copy.interface as Record<string, unknown>,
    capabilities: (copy.capabilities ?? []) as string[],
    constraints: (copy.constraints ?? []) as string[],
    dependencies: (copy.dependencies ?? []) as string[],
    supportedTargets: (copy.supportedTargets ?? []) as string[],
    // Frozen TS contract declares tests: string[]; frozen JSON schema says
    // array of objects — cast, see module docstring.
    tests: (copy.tests ?? []) as unknown as string[],
    benchmark: (copy.benchmark ?? {}) as Record<string, unknown>,
    failureModes: (copy.failureModes ?? []) as Record<string, unknown>[],
    provenance: copy.provenance as Record<string, unknown>,
  };
}
