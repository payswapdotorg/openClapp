/**
 * Typed CLAPP observation errors.
 *
 * Every failure raised by `@clapp/observation` names the capability that was
 * missing, malformed or interrupted. The adapter fails closed: it never
 * guesses a handle's shape and never fabricates observed evidence. A channel
 * the browser seam cannot produce is classified "unavailable" in the bundle
 * (honest absence), while a broken binding, an invalid spec or an aborted run
 * raises one of these typed errors.
 */

/** Base error for every observation-layer failure. */
export class ClappObservationError extends Error {
  /** The capability that failed, e.g. "read", "browser-seam", "spec", "redaction". */
  readonly capability: string;

  constructor(capability: string, message: string, options?: { cause?: unknown }) {
    super(`[clapp:observation:${capability}] ${message}`, options);
    this.name = "ClappObservationError";
    this.capability = capability;
  }
}

/**
 * Raised when an observe() run is aborted through its AbortSignal. Aborted
 * observation never returns a partial bundle presented as complete: the
 * caller must explicitly opt into partial results via observePartial().
 */
export class ClappObservationAbortError extends ClappObservationError {
  /** The capture step that was in flight when the abort was honored, e.g. "read:https://app.example/". */
  readonly where: string;

  constructor(where: string, message: string, options?: { cause?: unknown }) {
    super("abort", message, options);
    this.name = "ClappObservationAbortError";
    this.where = where;
  }
}

/** Renders an unknown thrown value without echoing secrets or stack traces. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "unknown error";
}

/** Renders the JSON-level shape of an unknown value for typed error messages. */
export function describeShape(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
