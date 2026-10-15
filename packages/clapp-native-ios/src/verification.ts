import { ClappNativeIosError, describeShape } from "./errors.ts";

/**
 * The iOS verification adapter — the duck-typed journey-runner seam
 * (ADR-004, component 5).
 *
 * The host runs a journey. The adapter:
 *   - carries the journey's measured counts (stepsTotal / stepsPassed /
 *     stepsFailed) VERBATIM from the host's own payload — it never derives,
 *     upgrades, or fabricates a count;
 *   - carries the host's failure reasons VERBATIM — it never paraphrases,
 *     never summarizes, never invents a reason;
 *   - NEVER constructs a parity/verdict record (a DiffReport) — that belongs
 *     to the diff discipline, a later consumer. A host that returns a payload
 *     shaped like a DiffReport (with `verdict` or `findings` fields) is a
 *     typed named error: the verification seam refuses to be silently
 *     promoted into the diff lane.
 *
 * The adapter never imports a production host; it duck-types an untyped
 * handle at bind time against `IosVerificationHostSeam` with typed fail-closed
 * errors naming any missing structural member.
 */

/**
 * The result the iOS verification adapter carries — measured counts and
 * verbatim failure reasons. The adapter NEVER constructs a DiffReport
 * (`verdict`, `findings`); that belongs to the diff discipline.
 */
export interface IosVerificationResult {
  /** The journey that was run. */
  readonly journeyId: string;
  /** The application target the journey was run against. */
  readonly application: string;
  /** MEASURED: the total number of steps the host ran (carried verbatim). */
  readonly stepsTotal: number;
  /** MEASURED: the number of steps that passed (carried verbatim). */
  readonly stepsPassed: number;
  /** MEASURED: the number of steps that failed (carried verbatim). */
  readonly stepsFailed: number;
  /** VERBATIM: the failure reasons the host returned, in host order. */
  readonly failureReasons: readonly string[];
}

/**
 * The narrow structural interface the iOS verification adapter needs from the
 * host seam. The adapter receives an untyped handle and duck-types it against
 * this interface at bind time.
 *
 *   runJourney({ journeyId, application }) — run a journey against an
 *                                             application target, returning
 *                                             measured counts and verbatim
 *                                             failure reasons.
 *
 * `runJourney` is REQUIRED: without it no verification is possible, and bind
 * fails closed with a typed error naming the missing structural member.
 */
export interface IosVerificationHostSeam {
  /** Runs a journey; returns measured counts and verbatim failure reasons. */
  runJourney(input: { journeyId: string; application: string }): Promise<{
    stepsTotal: number;
    stepsPassed: number;
    stepsFailed: number;
    failureReasons: readonly string[];
  }>;
}

const REQUIRED_CAPABILITIES = ["runJourney"] as const;

/**
 * Duck-types an untyped host handle onto {@link IosVerificationHostSeam}.
 * Fails closed with a typed error at bind time (never at call time) naming
 * the missing or malformed structural member.
 */
export function bindIosVerificationSeam(host: unknown): IosVerificationHostSeam {
  if (typeof host !== "object" || host === null)
    throw new ClappNativeIosError(
      "verification",
      "host-seam",
      `the iOS verification host seam must be an object providing ${REQUIRED_CAPABILITIES.join(", ")}; received ${describeShape(host)}`,
    );
  const handle = host as Record<string, unknown>;
  for (const capability of REQUIRED_CAPABILITIES)
    if (typeof handle[capability] !== "function")
      throw new ClappNativeIosError(
        "verification",
        "host-seam",
        `the iOS verification host handle is missing the required structural member "${capability}" (runJourney runs a journey against an application target); bind fails closed`,
      );
  return handle as unknown as IosVerificationHostSeam;
}

/**
 * The shape of a DiffReport payload (the diff discipline's record). The
 * verification adapter detects any host return carrying `verdict` or
 * `findings` as a typed named error — the verification lane never silently
 * produces a parity/verdict record.
 */
const DIFF_REPORT_KEYS = new Set(["verdict", "findings"]);

/** True when a host return looks like a DiffReport payload. */
function looksLikeDiffReport(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const keys = Object.keys(value as Record<string, unknown>);
  return keys.some((key) => DIFF_REPORT_KEYS.has(key));
}

/** Validates a host return against the measured-counts + verbatim-reasons shape. */
function validateHostReturn(
  value: unknown,
  where: string,
): {
  stepsTotal: number;
  stepsPassed: number;
  stepsFailed: number;
  failureReasons: readonly string[];
} {
  if (typeof value !== "object" || value === null)
    throw new ClappNativeIosError(
      "verification",
      "host-return",
      `the iOS verification host at ${where} returned ${describeShape(value)} instead of { stepsTotal, stepsPassed, stepsFailed, failureReasons }`,
    );

  // The verification lane NEVER constructs a parity/verdict record: a host
  // that returns a DiffReport-shaped payload (with `verdict` or `findings`)
  // is a typed named error. The diff discipline owns DiffReports.
  if (looksLikeDiffReport(value))
    throw new ClappNativeIosError(
      "verification",
      "host-return",
      `the iOS verification host at ${where} returned a payload carrying verdict/findings fields (a DiffReport shape); the verification adapter never constructs a parity/verdict record — that belongs to the diff discipline, a later consumer`,
    );

  const record = value as Record<string, unknown>;
  const { stepsTotal, stepsPassed, stepsFailed, failureReasons } = record;

  const requireNonNegativeInt = (value: unknown, field: string): number => {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0)
      throw new ClappNativeIosError(
        "verification",
        "host-return",
        `the iOS verification host at ${where} returned ${field} = ${describeShape(value)}; expected a non-negative integer (measured verbatim from the host)`,
      );
    return value;
  };

  const total = requireNonNegativeInt(stepsTotal, "stepsTotal");
  const passed = requireNonNegativeInt(stepsPassed, "stepsPassed");
  const failed = requireNonNegativeInt(stepsFailed, "stepsFailed");
  if (passed + failed !== total)
    throw new ClappNativeIosError(
      "verification",
      "host-return",
      `the iOS verification host at ${where} returned counts that do not add up: stepsPassed (${passed}) + stepsFailed (${failed}) !== stepsTotal (${total}); the adapter carries counts verbatim but cannot present an inconsistent host return as a coherent result`,
    );

  if (!Array.isArray(failureReasons))
    throw new ClappNativeIosError(
      "verification",
      "host-return",
      `the iOS verification host at ${where} returned failureReasons = ${describeShape(failureReasons)}; expected an array of strings (carried verbatim)`,
    );
  for (let index = 0; index < failureReasons.length; index++) {
    const reason = failureReasons[index];
    if (typeof reason !== "string")
      throw new ClappNativeIosError(
        "verification",
        "host-return",
        `the iOS verification host at ${where} returned failureReasons[${index}] = ${describeShape(reason)}; expected a string (carried verbatim, never paraphrased)`,
      );
  }

  return {
    stepsTotal: total,
    stepsPassed: passed,
    stepsFailed: failed,
    failureReasons: Object.freeze([...failureReasons]),
  };
}

/** The iOS verification adapter (implements the frozen per-platform seam). */
export interface IosVerificationAdapter {
  /**
   * Runs a journey against an application target. Counts are MEASURED and
   * carried verbatim from the host's own payload; failure reasons are
   * carried verbatim. The adapter never constructs a parity/verdict record.
   */
  verify(journeyId: string, application: string): Promise<IosVerificationResult>;
}

/**
 * Creates the iOS verification adapter. Bind-time validation fails closed: a
 * host handle missing `runJourney` (or exposing it as a non-function) raises
 * a typed error before any call is made.
 */
export function createIosVerificationAdapter(deps: {
  /** The untyped host handle (e.g. an XCUITest journey-runner binding), duck-typed at bind time. */
  readonly host: unknown;
}): IosVerificationAdapter {
  const seam = bindIosVerificationSeam(deps.host);
  return {
    async verify(journeyId, application) {
      if (typeof journeyId !== "string" || journeyId.trim() === "")
        throw new ClappNativeIosError(
          "verification",
          "journeyId",
          `the verification binding requires a non-empty journeyId; received ${describeShape(journeyId)}`,
        );
      if (typeof application !== "string" || application.trim() === "")
        throw new ClappNativeIosError(
          "verification",
          "application",
          `the verification binding requires a non-empty application target; received ${describeShape(application)}`,
        );
      const where = `runJourney(${journeyId}, ${application})`;
      const raw = await seam.runJourney({ journeyId, application });
      const measured = validateHostReturn(raw, where);
      return Object.freeze({ journeyId, application, ...measured });
    },
  };
}
