/**
 * Typed CLAPP native-iOS errors.
 *
 * Every failure raised by `@clapp/native-ios` names the component and field
 * that was missing, malformed, or refused. The adapter fails closed: it never
 * guesses a host handle's shape, never fabricates an observed element tree,
 * never silently constructs a parity/verdict record (that belongs to the diff
 * discipline, a later consumer), and never calls the host seam when the
 * environment is the honest-absent `none` state. A `none` framework is a
 * typed refusal, never a silent skip.
 *
 * The error shape mirrors the established `@clapp/observation` typed-error
 * discipline: a single base class carrying the component and field that
 * failed, so callers can switch on `error.component` / `error.field` without
 * parsing message text.
 */

/** Base error for every native-iOS adapter failure. */
export class ClappNativeIosError extends Error {
  /** The component that failed, e.g. "environment", "observation", "evidence", "synthesis-target", "verification". */
  readonly component: string;
  /** The field or capability within the component, e.g. "uiTestFramework", "host-seam", "packaging". */
  readonly field: string;

  constructor(component: string, field: string, message: string, options?: { cause?: unknown }) {
    super(`[clapp:native-ios:${component}:${field}] ${message}`, options);
    this.name = "ClappNativeIosError";
    this.component = component;
    this.field = field;
  }
}

/** Renders the JSON-level shape of an unknown value for typed error messages. */
export function describeShape(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
