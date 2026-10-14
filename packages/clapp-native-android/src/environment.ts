/**
 * @clapp/native-android — the Android environment descriptor (ADR-004,
 * component 1 of the frozen five-component v0.1 contract).
 *
 * This module is the FIRST of the five platform components ADR-004 freezes:
 * the platform facts as a frozen v0.1 vocabulary with a fail-closed
 * validator. The vocabulary is platform-specific and frozen at v0.1:
 *   - environmentVersion: "0.1" (CLAPP_NATIVE_ANDROID_ENVIRONMENT_VERSION)
 *   - platform: "android" (the platform literal — frozen)
 *   - apiLevel: a non-negative integer (the ADR's law — zero is a valid
 *     honest-absent API level, unlike the reference repo's positive-integer
 *     screen geometry; the ADR is the binding authority here, disclosed)
 *   - uiTestFramework: "uiautomator" | "espresso" | "none" (the frozen
 *     test-framework vocabulary; "none" is the VALID honest-absent state —
 *     the descriptor admits it, and the observation adapter refuses it with
 *     a typed named error and never calls the host)
 *   - packaging: "apk" | "aab" | "zip" (the frozen deployable-artifact
 *     vocabulary for the environment's single target packaging format)
 *
 * Discipline (binding — the ADR-004 hard rules):
 * - Fail closed: the validator collects EVERY field error in a
 *   { ok: false, errors } result — each error names its field and the
 *   OBSERVED value — results, never exceptions; refusal is the DEFAULT.
 * - Determinism: a pure function over caller-supplied facts; no wall-clock,
 *   no randomness, no network, no filesystem, no global state.
 * - The module never mutates its inputs.
 * - THE NO-FORK LAW (ADR-004, binding): this package CONSUMES the frozen
 *   @clapp/contracts via TYPE-ONLY imports and produces contract-shaped
 *   DATA — it never redefines any contract type. The import-discipline test
 *   in tests/clapp-native-android.test.ts pins this.
 *
 * Honest v0.1 scope: the descriptor is the CONTRACT, not a device probe —
 * real `adb shell`/PackageInfo extraction is deployment scope (the host-seam
 * law, see src/observation.ts).
 */

import { isNonNegativeInteger, isObject, preview } from "./errors.ts";

// ---- the frozen v0.1 vocabulary ---------------------------------------------------

/** The Android environment descriptor's version (frozen at v0.1 per ADR-004). */
export const CLAPP_NATIVE_ANDROID_ENVIRONMENT_VERSION = "0.1";

/** The frozen v0.1 UI test-framework vocabulary (the only strings uiTestFramework may carry). */
export const ANDROID_UI_TEST_FRAMEWORKS = ["uiautomator", "espresso", "none"] as const;

/** The frozen v0.1 packaging vocabulary (the only string the environment's packaging may carry). */
export const ANDROID_PACKAGING_FORMATS = ["apk", "aab", "zip"] as const;

/** The Android environment descriptor (the frozen v0.1 vocabulary). */
export interface AndroidEnvironment {
  /** The descriptor's version — always CLAPP_NATIVE_ANDROID_ENVIRONMENT_VERSION ("0.1"). */
  environmentVersion: string;
  /** The platform literal — frozen at "android". */
  platform: "android";
  /** The target device's API level (a non-negative integer; zero is the honest-absent value). */
  apiLevel: number;
  /** The UI test framework the observation/verification adapters bind (uiautomator | espresso | none). */
  uiTestFramework: (typeof ANDROID_UI_TEST_FRAMEWORKS)[number];
  /** The environment's single target packaging format (apk | aab | zip). */
  packaging: (typeof ANDROID_PACKAGING_FORMATS)[number];
}

/** The frozen vocabularies rendered for error messages (the observed-value law). */
const FRAMEWORKS_FOR_MESSAGES = ANDROID_UI_TEST_FRAMEWORKS.map((f) => JSON.stringify(f)).join(
  " | ",
);
const PACKAGING_FOR_MESSAGES = ANDROID_PACKAGING_FORMATS.map((p) => JSON.stringify(p)).join(" | ");

/** The validator's fail-closed result (the house shape). */
export type AndroidEnvironmentValidation = { ok: true } | { ok: false; errors: string[] };

// ---- the environment validator -----------------------------------------------------

/**
 * Fail-closed validation of an AndroidEnvironment: platform exactly
 * "android"; environmentVersion exactly CLAPP_NATIVE_ANDROID_ENVIRONMENT_VERSION;
 * apiLevel a non-negative integer (zero is valid — the honest-absent API
 * level); uiTestFramework one of the frozen v0.1 three-value vocabulary
 * (uiautomator | espresso | none); packaging one of the frozen v0.1
 * three-value vocabulary (apk | aab | zip). EVERY malformation is collected
 * and named (with the observed value) — results, never exceptions; refusal
 * is the DEFAULT. A foreign value in either vocabulary refuses, naming the
 * observed value (the frozen-vocabulary pin).
 */
export function validateAndroidEnvironment(env: unknown): AndroidEnvironmentValidation {
  const errors: string[] = [];

  if (!isObject(env)) {
    return { ok: false, errors: [`environment must be an object (observed: ${preview(env)})`] };
  }

  if (env.platform !== "android") {
    errors.push(`platform must be exactly "android" (observed: ${preview(env.platform)})`);
  }

  if (env.environmentVersion !== CLAPP_NATIVE_ANDROID_ENVIRONMENT_VERSION) {
    errors.push(
      `environmentVersion must be ${JSON.stringify(CLAPP_NATIVE_ANDROID_ENVIRONMENT_VERSION)} (observed: ${preview(env.environmentVersion)})`,
    );
  }

  if (!isNonNegativeInteger(env.apiLevel)) {
    errors.push(
      `apiLevel must be a non-negative integer (zero is the honest-absent value; observed: ${preview(env.apiLevel)})`,
    );
  }

  if (
    typeof env.uiTestFramework !== "string" ||
    !ANDROID_UI_TEST_FRAMEWORKS.includes(
      env.uiTestFramework as (typeof ANDROID_UI_TEST_FRAMEWORKS)[number],
    )
  ) {
    errors.push(
      `uiTestFramework must be one of the frozen v0.1 vocabulary: ${FRAMEWORKS_FOR_MESSAGES} (observed: ${preview(env.uiTestFramework)})`,
    );
  }

  if (
    typeof env.packaging !== "string" ||
    !ANDROID_PACKAGING_FORMATS.includes(env.packaging as (typeof ANDROID_PACKAGING_FORMATS)[number])
  ) {
    errors.push(
      `packaging must be one of the frozen v0.1 vocabulary: ${PACKAGING_FOR_MESSAGES} (observed: ${preview(env.packaging)})`,
    );
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
