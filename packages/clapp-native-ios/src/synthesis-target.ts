import type { IosPackaging } from "./environment.ts";
import { IOS_PACKAGING_FORMATS } from "./environment.ts";
import { ClappNativeIosError, describeShape } from "./errors.ts";

/**
 * The iOS synthesis target — the platform's deployable artifact descriptor
 * over the frozen packaging vocabulary (ADR-004, component 4).
 *
 * The target is the synthesis lane's contract for what the iOS adapter will
 * deploy: a bundle identifier, the packaging format (one of the frozen v0.1
 * vocabulary), and optional product/signing/version identifiers. The
 * validator is fail-closed: a foreign packaging value, a missing bundle
 * identifier, or a non-string identifier entry refuses with a typed named
 * error; nothing is defaulted, nothing is fabricated. Identifier lists are
 * normalized to a sorted, deduplicated form so two structurally equal targets
 * are byte-identical regardless of construction order.
 */

/**
 * The frozen iOS v0.1 synthesis-target contract version (ADR-004). The
 * packaging vocabulary is frozen at v0.1 at landing; a future revision is a
 * tech-lead wave that bumps this constant and re-pins the test.
 */
export const CLAPP_NATIVE_IOS_TARGET_VERSION = "0.1";

/** The frozen iOS v0.1 synthesis-target descriptor. */
export interface IosSynthesisTarget {
  /** The application bundle identifier (CFBundleIdentifier), e.g. com.example.app. */
  readonly bundleIdentifier: string;
  /** The deployable packaging format (one of the frozen v0.1 vocabulary). */
  readonly packaging: IosPackaging;
  /** Optional product identifiers (sorted, deduplicated). */
  readonly productIdentifiers?: readonly string[];
  /** Optional signing identity (content only — never a secret or P8 key). */
  readonly signingIdentity?: string;
  /** Optional minimum iOS version (e.g. "17.0"). */
  readonly minimumOsVersion?: string;
}

const PACKAGING_SET: ReadonlySet<string> = new Set(IOS_PACKAGING_FORMATS);

/** True when a value is one of the frozen v0.1 packaging formats. */
export function isIosPackaging(value: unknown): value is IosPackaging {
  return typeof value === "string" && PACKAGING_SET.has(value);
}

/** Sorts and deduplicates a string identifier list (deterministic normalization). */
function normalizeIdentifiers(field: string, values: unknown): readonly string[] {
  if (!Array.isArray(values))
    throw new ClappNativeIosError(
      "synthesis-target",
      field,
      `${field} must be an array of non-empty strings; received ${describeShape(values)}`,
    );
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const entry of values) {
    if (typeof entry !== "string" || entry.trim() === "")
      throw new ClappNativeIosError(
        "synthesis-target",
        field,
        `${field} entry must be a non-empty string; a foreign value refuses; received ${describeShape(entry)}`,
      );
    if (seen.has(entry)) continue;
    seen.add(entry);
    normalized.push(entry);
  }
  normalized.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return Object.freeze(normalized);
}

/**
 * Validates an untyped input against the frozen iOS v0.1 synthesis-target
 * descriptor. Fails closed with a typed named error for every malformed field;
 * never defaults, never returns a partial descriptor. Identifier lists are
 * normalized to a sorted, deduplicated form.
 */
export function validateIosSynthesisTarget(input: unknown): IosSynthesisTarget {
  if (typeof input !== "object" || input === null)
    throw new ClappNativeIosError(
      "synthesis-target",
      "descriptor",
      `the iOS synthesis target must be an object { bundleIdentifier, packaging, ... }; received ${describeShape(input)}`,
    );
  const record = input as Record<string, unknown>;
  const { bundleIdentifier, packaging, productIdentifiers, signingIdentity, minimumOsVersion } =
    record;

  if (typeof bundleIdentifier !== "string" || bundleIdentifier.trim() === "")
    throw new ClappNativeIosError(
      "synthesis-target",
      "bundleIdentifier",
      `bundleIdentifier must be a non-empty string (the CFBundleIdentifier); received ${describeShape(bundleIdentifier)}`,
    );

  if (!isIosPackaging(packaging))
    throw new ClappNativeIosError(
      "synthesis-target",
      "packaging",
      `packaging must be one of ${IOS_PACKAGING_FORMATS.map((value) => `"${value}"`).join(", ")} (the frozen iOS v0.1 vocabulary); a foreign value refuses; received ${describeShape(packaging)}`,
    );

  if (
    signingIdentity !== undefined &&
    (typeof signingIdentity !== "string" || signingIdentity.trim() === "")
  )
    throw new ClappNativeIosError(
      "synthesis-target",
      "signingIdentity",
      `signingIdentity must be a non-empty string (content only — never a P8 key); received ${describeShape(signingIdentity)}`,
    );

  if (
    minimumOsVersion !== undefined &&
    (typeof minimumOsVersion !== "string" || minimumOsVersion.trim() === "")
  )
    throw new ClappNativeIosError(
      "synthesis-target",
      "minimumOsVersion",
      `minimumOsVersion must be a non-empty string (e.g. "17.0"); received ${describeShape(minimumOsVersion)}`,
    );

  return Object.freeze({
    bundleIdentifier,
    packaging,
    ...(productIdentifiers !== undefined
      ? { productIdentifiers: normalizeIdentifiers("productIdentifiers", productIdentifiers) }
      : {}),
    ...(signingIdentity !== undefined ? { signingIdentity } : {}),
    ...(minimumOsVersion !== undefined ? { minimumOsVersion } : {}),
  });
}
