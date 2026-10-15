import { ClappNativeIosError, describeShape } from "./errors.ts";

/**
 * The iOS environment descriptor — the platform facts as a frozen v0.1
 * vocabulary with a fail-closed validator (ADR-004, component 1).
 *
 * The frozen iOS v0.1 vocabulary is exactly two fields:
 *   - `uiTestFramework` ∈ { "xcuitest", "none" } — the UI test framework the
 *     host seam binds (XCUITest), or the honest-absent `none` state;
 *   - `packaging`     ⊂ { "ipa", "app", "xcarchive", "dSYM", "zip" } — the
 *     deployable artifact formats the synthesis target may produce.
 *
 * `none` is a VALID descriptor — the honest-absent state. Its observation
 * component refuses with a typed named error and never calls the host (the
 * failure principle, ARCHITECTURE.md section 12: a missing observation is not
 * permission to invent a behavior). Every other field is required and must
 * match the frozen vocabulary exactly; a foreign value refuses with a typed
 * named error. The validator never defaults, never silently coerces, and
 * never returns a partial descriptor.
 */

/** The frozen iOS v0.1 UI test framework vocabulary. */
export type IosUiTestFramework = "xcuitest" | "none";

/** The frozen iOS v0.1 packaging format vocabulary. */
export type IosPackaging = "ipa" | "app" | "xcarchive" | "dSYM" | "zip";

/** The frozen iOS v0.1 environment descriptor. */
export interface IosEnvironment {
  /** The UI test framework the host seam binds, or `none` (the honest-absent state). */
  readonly uiTestFramework: IosUiTestFramework;
  /** The deployable artifact formats the synthesis target may produce (deduplicated, order-preserved). */
  readonly packaging: readonly IosPackaging[];
}

/** The frozen iOS v0.1 environment vocabulary — UI test frameworks, in registry order. */
export const IOS_UI_TEST_FRAMEWORKS: readonly IosUiTestFramework[] = Object.freeze([
  "xcuitest",
  "none",
]);

/** The frozen iOS v0.1 environment vocabulary — packaging formats, in registry order. */
export const IOS_PACKAGING_FORMATS: readonly IosPackaging[] = Object.freeze([
  "ipa",
  "app",
  "xcarchive",
  "dSYM",
  "zip",
]);

/**
 * The frozen iOS environment descriptor contract version (ADR-004). The
 * environment vocabulary is frozen at v0.1 at landing; a future revision is
 * a tech-lead wave that bumps this constant and re-pins the test.
 */
export const CLAPP_NATIVE_IOS_ENVIRONMENT_VERSION = "0.1";

const UI_FRAMEWORK_SET: ReadonlySet<string> = new Set(IOS_UI_TEST_FRAMEWORKS);
const PACKAGING_SET: ReadonlySet<string> = new Set(IOS_PACKAGING_FORMATS);

/** True when the environment is the honest-absent `none` state. */
export function isNoneIosEnvironment(environment: IosEnvironment): boolean {
  return environment.uiTestFramework === "none";
}

/**
 * Validates an untyped input against the frozen iOS v0.1 environment
 * descriptor. Fails closed with a typed named error for every malformed field;
 * never defaults, never returns a partial descriptor, never fabricates a
 * framework the host did not declare.
 */
export function validateIosEnvironment(input: unknown): IosEnvironment {
  if (typeof input !== "object" || input === null)
    throw new ClappNativeIosError(
      "environment",
      "descriptor",
      `the iOS environment descriptor must be an object { uiTestFramework, packaging }; received ${describeShape(input)}`,
    );
  const record = input as Record<string, unknown>;
  const { uiTestFramework, packaging } = record;

  if (typeof uiTestFramework !== "string" || !UI_FRAMEWORK_SET.has(uiTestFramework))
    throw new ClappNativeIosError(
      "environment",
      "uiTestFramework",
      `uiTestFramework must be one of ${IOS_UI_TEST_FRAMEWORKS.map((value) => `"${value}"`).join(", ")} (the frozen iOS v0.1 vocabulary); received ${describeShape(uiTestFramework)}`,
    );

  if (!Array.isArray(packaging))
    throw new ClappNativeIosError(
      "environment",
      "packaging",
      `packaging must be an array of ${IOS_PACKAGING_FORMATS.map((value) => `"${value}"`).join(", ")} (the frozen iOS v0.1 vocabulary); received ${describeShape(packaging)}`,
    );

  const seen = new Set<string>();
  const normalized: IosPackaging[] = [];
  for (const format of packaging) {
    if (typeof format !== "string" || !PACKAGING_SET.has(format))
      throw new ClappNativeIosError(
        "environment",
        "packaging",
        `packaging entry must be one of ${IOS_PACKAGING_FORMATS.map((value) => `"${value}"`).join(", ")} (the frozen iOS v0.1 vocabulary); a foreign value refuses; received ${describeShape(format)}`,
      );
    if (seen.has(format)) continue;
    seen.add(format);
    normalized.push(format as IosPackaging);
  }

  return Object.freeze({
    uiTestFramework: uiTestFramework as IosUiTestFramework,
    packaging: normalized,
  });
}
