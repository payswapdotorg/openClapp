/**
 * Typed CLAPP benchmark errors.
 *
 * Every failure raised by `@clapp/benchmarks` names the capability that was
 * missing, malformed or refused: a definition that failed validation, a
 * harness misused across lifecycles, or a workspace seam that broke the
 * hosting invariants (id reuse, short seeds, undiscoverable workspaces).
 * The package fails closed everywhere: it never guesses a shape and never
 * claims a start, seed or reset that did not verifiably happen.
 */

/** Base error for every benchmark-layer failure. */
export class ClappBenchmarkError extends Error {
  /** The capability that failed, e.g. "validate", "harness", "workspace", "seam". */
  readonly capability: string;

  constructor(capability: string, message: string, options?: { cause?: unknown }) {
    super(`[clapp:benchmarks:${capability}] ${message}`, options);
    this.name = "ClappBenchmarkError";
    this.capability = capability;
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
