/**
 * Typed CLAPP native-Android errors (the v0.1 house style — the same law the
 * openClapp observation package follows in its own errors.ts).
 *
 * Every failure raised by `@clapp/native-android` names the component (and,
 * where applicable, the capability or field) that was missing, malformed, or
 * interrupted. The package fails closed: it never guesses a handle's shape
 * and never fabricates observed evidence. A malformed host seam fails the
 * BIND (the typed error is raised at bind time, never deferred to a call);
 * the per-component validators and adapters return named-error RESULT shapes
 * (the reference repo's result-never-exceptions discipline); a throwing host
 * propagates loudly (never swallowed into a synthetic result).
 */

/**
 * Base error for every native-Android bind-time failure. The per-component
 * validators and adapter bodies return named-error results (the house
 * result shape); this class is raised only where the ADR's hard rules
 * demand a typed error AT BIND — the host-seam structural validation
 * (a host missing captureScreen/runJourney fails the bind, never the call).
 */
export class ClappNativeAndroidError extends Error {
  /** The component/capability that failed, e.g. "observation-host", "verification-host". */
  readonly component: string;

  constructor(component: string, message: string, options?: { cause?: unknown }) {
    super(`[clapp:native-android:${component}] ${message}`, options);
    this.name = "ClappNativeAndroidError";
    this.component = component;
  }
}

/** Renders the JSON-level shape of an unknown value for typed error messages. */
export function describeShape(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/** Renders an unknown thrown value without echoing secrets or stack traces. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "unknown error";
}

/** Human preview of an unknown value, for named-error result strings (the observed-value law). */
export function preview(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Plain-object guard (arrays are NOT objects here — the house helper). */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Non-negative-integer check (the ADR's apiLevel law: integers only, zero allowed, no negatives, no fractions). */
export function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** Positive-integer check (the v0.1 numeric law for counts/depths: integers only, no zero, no negatives). */
export function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}
