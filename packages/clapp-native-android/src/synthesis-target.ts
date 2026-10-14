/**
 * @clapp/native-android — the Android synthesis target (ADR-004, component
 * 4 of the frozen five-component v0.1 contract).
 *
 * This module is the platform's deployable artifact descriptor over the
 * frozen packaging vocabulary — what the codegen lane aims at: the
 * application id, the activity identifiers, and the deployable packaging
 * formats. The frozen v0.1 vocabulary (binding — the only shapes this
 * target admits):
 *   - targetVersion: "0.1" (CLAPP_NATIVE_ANDROID_TARGET_VERSION)
 *   - platform: "android" (the platform literal — frozen)
 *   - packaging: a sorted, deduped list from {apk, aab, zip} (the frozen
 *     deployable-artifact vocabulary; the ADR's "sorted/deduped identifier
 *     lists" law)
 *   - activities: a sorted, deduped list of non-empty strings (the
 *     deployable's activity identifiers — the ADR's "sorted/deduped
 *     identifier lists" law)
 *
 * "Sorted" means lexicographic ascending (code-unit order — the default
 * `Array.prototype.sort()` on strings), the same law as every sorted
 * vocabulary in this package.
 *
 * THE CROSS-CHECK BOUNDARY (honest scope): a synthesis target's
 * minApiLevel <= the environment's apiLevel WHEN BOTH ARE KNOWN is a
 * caller-owned cross-check — this validator checks the target's OWN shape
 * only (it never sees the environment; the two-sided check belongs to the
 * caller holding both). v0.1 ships no minApiLevel field (the ADR freezes
 * only the packaging vocabulary + sorted/deduped identifier lists); this is
 * an honest scope boundary, disclosed.
 *
 * Discipline (binding — the ADR-004 hard rules): fail closed (EVERY field
 * error collected and named with the observed value — results, never
 * exceptions; refusal is the DEFAULT); no wall-clock, no randomness, no
 * network, no filesystem, no global state; the module never mutates its
 * inputs. THE NO-FORK LAW: the target is a local descriptor the codegen
 * lane consumes — it never redefines any IR/plan/contract type.
 */

import { isObject, preview } from "./errors.ts";

// ---- the frozen v0.1 vocabulary -----------------------------------------------------

/** The Android synthesis target's version (frozen at v0.1 per ADR-004). */
export const CLAPP_NATIVE_ANDROID_TARGET_VERSION = "0.1";

/** The frozen v0.1 packaging vocabulary (the deployable-artifact formats the codegen lane emits). */
export const ANDROID_PACKAGING_FORMATS = ["apk", "aab", "zip"] as const;

/** The frozen vocabulary rendered for error messages (the observed-value law). */
const PACKAGING_FOR_MESSAGES = ANDROID_PACKAGING_FORMATS.map((p) => JSON.stringify(p)).join(" | ");

/** The Android synthesis target — what the codegen lane aims at (v0.1: the descriptor). */
export interface AndroidSynthesisTarget {
  /** The target's version (always CLAPP_NATIVE_ANDROID_TARGET_VERSION ("0.1")). */
  targetVersion: string;
  /** The platform literal — frozen at "android". */
  platform: "android";
  /** The application id (the manifest package, e.g. "org.clapp.example" — non-empty). */
  applicationId: string;
  /** The deployable packaging formats (sorted, deduped, non-empty, from the frozen v0.1 vocabulary). */
  packaging: string[];
  /** The activity identifiers to generate (sorted, deduped, non-empty strings). */
  activities: string[];
}

/** The validator's fail-closed result (the house shape). */
export type AndroidSynthesisTargetValidation = { ok: true } | { ok: false; errors: string[] };

// ---- internal helpers (module-level; NOT re-exported by src/index.ts) --------------

/**
 * Fail-closed string-list validation: every entry a non-empty string,
 * membership in the frozen vocabulary (when given), no duplicates,
 * sorted ascending, and (when required) at least one entry. EVERY violation
 * is collected and named with the observed value.
 */
function validateStringList(
  value: unknown,
  field: string,
  errors: string[],
  options: {
    vocabulary?: readonly string[];
    vocabularyForMessages?: string;
    requireNonEmpty?: boolean;
  } = {},
): void {
  const { vocabulary, vocabularyForMessages, requireNonEmpty } = options;
  if (!Array.isArray(value)) {
    errors.push(`${field} must be an array of strings (observed: ${preview(value)})`);
    return;
  }
  const entries: string[] = [];
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "string" || entry.length === 0) {
      errors.push(`${field}[${index}] must be a non-empty string (observed: ${preview(entry)})`);
      continue;
    }
    entries.push(entry);
  }
  if (requireNonEmpty && entries.length === 0) {
    errors.push(`${field} must contain at least one entry (observed: ${preview(value)})`);
  }
  if (vocabulary !== undefined) {
    for (const [index, entry] of entries.entries()) {
      if (!vocabulary.includes(entry)) {
        errors.push(
          `${field}[${index}] is not in ${vocabularyForMessages ?? "the frozen vocabulary"} (observed: ${preview(entry)})`,
        );
      }
    }
  }
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry)) {
      errors.push(`${field} contains a duplicate entry (observed: ${preview(entry)})`);
    } else {
      seen.add(entry);
    }
  }
  const sorted = [...entries].sort();
  if (entries.some((entry, index) => entry !== sorted[index])) {
    errors.push(`${field} must be sorted ascending (observed: ${preview(entries)})`);
  }
}

// ---- the synthesis target validator -------------------------------------------------

/**
 * Fail-closed validation of an AndroidSynthesisTarget: platform exactly
 * "android"; targetVersion exactly CLAPP_NATIVE_ANDROID_TARGET_VERSION;
 * applicationId a non-empty string; packaging a sorted, deduped, non-empty
 * array from the frozen v0.1 three-value vocabulary {apk, aab, zip} (an
 * unknown format is named with its observed value); activities a sorted,
 * deduped, non-empty array of non-empty strings. EVERY malformation is
 * collected and named (with the observed value) — results, never
 * exceptions; refusal is the DEFAULT.
 */
export function validateAndroidSynthesisTarget(target: unknown): AndroidSynthesisTargetValidation {
  const errors: string[] = [];

  if (!isObject(target)) {
    return {
      ok: false,
      errors: [`synthesis target must be an object (observed: ${preview(target)})`],
    };
  }

  if (target.platform !== "android") {
    errors.push(`platform must be exactly "android" (observed: ${preview(target.platform)})`);
  }

  if (target.targetVersion !== CLAPP_NATIVE_ANDROID_TARGET_VERSION) {
    errors.push(
      `targetVersion must be ${JSON.stringify(CLAPP_NATIVE_ANDROID_TARGET_VERSION)} (observed: ${preview(target.targetVersion)})`,
    );
  }

  if (typeof target.applicationId !== "string" || target.applicationId.length === 0) {
    errors.push(
      `applicationId must be a non-empty string (observed: ${preview(target.applicationId)})`,
    );
  }

  validateStringList(target.packaging, "packaging", errors, {
    vocabulary: ANDROID_PACKAGING_FORMATS,
    vocabularyForMessages: `the frozen v0.1 packaging vocabulary: ${PACKAGING_FOR_MESSAGES}`,
    requireNonEmpty: true,
  });

  validateStringList(target.activities, "activities", errors, {
    requireNonEmpty: true,
  });

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
