/**
 * Typed CLAPP runtime errors.
 *
 * Every failure raised by `@clapp/runtime-openmuse` names the provider (or
 * handle) that failed and the capability that was missing or could not be
 * honored. The adapter fails closed: it never guesses a handle's shape and
 * never fabricates provider results.
 */
export class ClappRuntimeError extends Error {
  /** The provider (or handle binding) that failed, e.g. "artifacts" or "computer". */
  readonly provider: string;
  /** The capability that was missing or could not be honored, e.g. "execute". */
  readonly capability: string;

  constructor(
    provider: string,
    capability: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(`[clapp:${provider}:${capability}] ${message}`, options);
    this.name = "ClappRuntimeError";
    this.provider = provider;
    this.capability = capability;
  }
}

/**
 * Raised when an explicitly-optional handle was not bound at all and one of
 * its providers is called. Optional handles never silently no-op: the
 * corresponding provider fails closed at call time instead.
 */
export class ClappHandleNotProvidedError extends ClappRuntimeError {
  constructor(provider: string, handle: string) {
    super(
      provider,
      `${handle}-handle`,
      `the ${handle} handle was not provided to createOpenMuseRuntime, so the ${provider} provider cannot serve this call; refusing to guess`,
    );
    this.name = "ClappHandleNotProvidedError";
  }
}

/**
 * Raised when the candidate workspace execution seam (W1-003) is used without
 * the `CandidateExecutionOptions` wiring. The runtime still constructs without
 * the options — every Wave 1 provider and behavior stays intact — but the
 * candidate-build orchestration surface fails closed with this typed error at
 * call time instead of silently degrading to a guess.
 */
export class ClappNotConfiguredError extends ClappRuntimeError {
  constructor(provider: string, capability: string) {
    super(
      provider,
      capability,
      `the candidate execution options were not provided to createOpenMuseRuntime, so the ${provider} provider cannot serve "${capability}"; pass CandidateExecutionOptions to wire the candidate seam`,
    );
    this.name = "ClappNotConfiguredError";
  }
}

/** Renders an unknown thrown value without echoing secrets or stack traces. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "unknown error";
}
