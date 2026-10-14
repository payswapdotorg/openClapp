/**
 * @clapp/native-linux — the Linux synthesis target (ADR-004, component 4
 * of 5).
 *
 * ADR-004: each platform implements a synthesis target. THIS MODULE IS
 * THE LINUX ONE: the descriptor the codegen lane aims at — the built
 * binary's name, the window classes (WM_CLASS values) to target, the
 * packaging formats to emit artifacts for, and the minimum kernel major
 * the artifact supports.
 *
 * THE FROZEN v0.1 VOCABULARY (binding — ADR-004):
 *   - targetVersion: '0.1' (CLAPP_NATIVE_LINUX_TARGET_VERSION)
 *   - platform: 'linux' (the platform literal — frozen)
 *   - the five packaging formats (LINUX_PACKAGING_FORMATS): appimage, deb,
 *     flatpak, tar, zip
 *
 * "Sorted" means lexicographic ascending (code-unit order — the default
 * `Array.prototype.sort()` on strings), the same law for every sorted
 * vocabulary in this package (windowClasses AND packagingFormats).
 *
 * THE CROSS-CHECK BOUNDARY (honest scope): minKernelMajor <= the
 * environment's kernelMajor WHEN BOTH ARE KNOWN is a caller-owned
 * cross-check — this validator checks the target's OWN shape only (it
 * never sees the environment; the two-sided check needs both sides and
 * belongs to the caller holding both).
 *
 * Discipline (binding — ADR-004 hard rules): fail closed (EVERY field
 * error collected and named with the observed value — results, never
 * exceptions; refusal is the DEFAULT); no clock, no randomness, no
 * network, no filesystem, no global state; the module never mutates its
 * inputs. THE NO-FORK LAW: the target is a local descriptor the codegen
 * lane consumes — it never redefines any IR/plan contract type.
 */

// ---- the frozen v0.1 vocabulary -----------------------------------------------------

/**
 * The Linux synthesis target's version (frozen at v0.1, ADR-004
 * "Contract version: CLAPP_NATIVE_<PLATFORM>_VERSION = '0.1'"). Disclosed:
 * the ADR names a single CLAPP_NATIVE_<PLATFORM>_VERSION constant per
 * package; this lane ships TWO version constants — environment and
 * target — so each frozen vocabulary is independently addressable for
 * future revisions. Both are pinned at '0.1' at landing; the contract
 * impact section of the worklog records this naming.
 */
export const CLAPP_NATIVE_LINUX_TARGET_VERSION = "0.1";

/** The Linux synthesis target — what the codegen lane aims at (v0.1: the descriptor). */
export interface LinuxSynthesisTarget {
  /** The target's version (always CLAPP_NATIVE_LINUX_TARGET_VERSION ('0.1')). */
  targetVersion: string;
  /** The platform literal — frozen at 'linux'. */
  platform: "linux";
  /** The built binary name (non-empty, e.g. 'clapp-example'). */
  binaryName: string;
  /** The window classes to target (WM_CLASS values) (sorted, deduped, non-empty strings). */
  windowClasses: string[];
  /**
   * The packaging formats to emit artifacts for (frozen v0.1 vocabulary:
   * 'appimage' | 'deb' | 'flatpak' | 'tar' | 'zip' — sorted, deduped).
   */
  packagingFormats: string[];
  /** The minimum kernel major the artifact supports (a positive integer). */
  minKernelMajor: number;
}

/**
 * The frozen v0.1 packaging-format vocabulary (the artifact formats the
 * codegen lane emits for — the only strings packagingFormats may carry).
 */
export const LINUX_PACKAGING_FORMATS: readonly string[] = [
  "appimage",
  "deb",
  "flatpak",
  "tar",
  "zip",
];

/** The frozen vocabulary rendered for error messages (the observed-value law). */
const PACKAGING_FORMATS_FOR_MESSAGES = LINUX_PACKAGING_FORMATS.map((format) =>
  JSON.stringify(format),
).join(" | ");

/** The validator's fail-closed result (the house shape). */
export type LinuxSynthesisTargetValidation =
  | { ok: true }
  | { ok: false; errors: string[] };

// ---- internal helpers (module-level; NOT re-exported by src/index.ts) --------------

/**
 * Positive-integer check (the v0.1 numeric law: integers only, no zero,
 * no negatives, no fractions). In-package per the fixed six-file src list.
 */
function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/** Plain-object guard (arrays are NOT objects here — the house helper). */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Human preview of an unknown value, for error messages. */
function preview(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "undefined") return "undefined";
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Fail-closed string-list validation: every entry a non-empty string,
 * membership in the frozen vocabulary (when given), no duplicates,
 * sorted ascending. EVERY violation is collected and named with the
 * observed value. (In-package per the fixed six-file src list.)
 */
function validateStringList(
  value: unknown,
  field: string,
  errors: string[],
  vocabulary?: readonly string[],
  vocabularyForMessages?: string,
): void {
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
 * Fail-closed validation of a LinuxSynthesisTarget: platform exactly
 * 'linux'; targetVersion exactly CLAPP_NATIVE_LINUX_TARGET_VERSION;
 * binaryName a non-empty string; windowClasses a sorted, deduped array of
 * non-empty strings (free-form WM_CLASS values — no frozen vocabulary, but
 * the sorted/deduped law holds); packagingFormats a sorted, deduped array
 * from the frozen v0.1 five-format vocabulary (an unknown format is named
 * with its observed value); minKernelMajor a positive integer. EVERY
 * malformation is collected and named (with the observed value) — results,
 * never exceptions; refusal is the DEFAULT.
 */
export function validateLinuxSynthesisTarget(target: unknown): LinuxSynthesisTargetValidation {
  const errors: string[] = [];

  if (!isObject(target)) {
    return {
      ok: false,
      errors: [`synthesis target must be an object (observed: ${preview(target)})`],
    };
  }

  if (target.platform !== "linux") {
    errors.push(`platform must be exactly 'linux' (observed: ${preview(target.platform)})`);
  }

  if (target.targetVersion !== CLAPP_NATIVE_LINUX_TARGET_VERSION) {
    errors.push(
      `targetVersion must be ${JSON.stringify(CLAPP_NATIVE_LINUX_TARGET_VERSION)} (observed: ${preview(target.targetVersion)})`,
    );
  }

  if (typeof target.binaryName !== "string" || target.binaryName.length === 0) {
    errors.push(`binaryName must be a non-empty string (observed: ${preview(target.binaryName)})`);
  }

  validateStringList(target.windowClasses, "windowClasses", errors);

  validateStringList(
    target.packagingFormats,
    "packagingFormats",
    errors,
    LINUX_PACKAGING_FORMATS,
    `the frozen v0.1 packaging-format vocabulary: ${PACKAGING_FORMATS_FOR_MESSAGES}`,
  );

  if (!isPositiveInteger(target.minKernelMajor)) {
    errors.push(
      `minKernelMajor must be a positive integer (observed: ${preview(target.minKernelMajor)})`,
    );
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
