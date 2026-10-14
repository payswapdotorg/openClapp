/**
 * @clapp/native-linux — the Linux verification adapter (ADR-004, component
 * 5 of 5 — the fifth of the five platform components).
 *
 * ADR-004: each platform implements a verification adapter. THIS MODULE IS
 * THE LINUX ONE: `verifyLinuxJourneys` runs a caller-supplied list of
 * journeys through the host seam against the synthesized target and returns
 * the MEASURED outcomes — completed and failed counted, failure reasons
 * carried VERBATIM.
 *
 * THE HOST-SEAM LAW (the honest boundary, ADR-004): everything environment-
 * specific enters through ONE duck-typed seam — LinuxVerificationHost
 * ("an object with a callable runJourney()"). The journey ids are the
 * caller's vocabulary this adapter RUNS (TYPE-ONLY consumption — never
 * redefined here; the journey lane owns the ids); the tests fake the host;
 * real X11/Wayland input synthesis and AT-SPI-driven target bindings are
 * deployment scope (later lanes) — never this module.
 *
 * THE MEASUREMENT LAW (ADR-004): completed and failed are MEASURED from the
 * host's outcomes (counted, never asserted, never derived from the input
 * list's length); the failure reasons ride VERBATIM in journey order (the
 * host's reason carried exactly — never re-worded, never normalized; a
 * failed journey whose host said nothing carries '' — the host said
 * nothing, and nothing is never invented).
 *
 * THE DIFF BOUNDARY (the no-fork law, ADR-004 binding): the run's data is
 * the shape the diff discipline consumes — the paired-run evidence enters
 * the frozen DiffReport (@clapp/contracts' DiffReport/DiffDimension/
 * DiffSeverity vocabulary) through the diff lane's EXISTING machinery;
 * THIS ADAPTER NEVER CONSTRUCTS A DiffReport. The journey outcomes this
 * module measures are the facts that machinery weighs — never the report
 * itself. A fake DiffReport-shaped host outcome (an object carrying
 * findings/verdict/referenceRunId/candidateRunId instead of
 * completed/failureReason) is a NAMED error result — fail-closed, never
 * guessed.
 *
 * THE LOUD-HOST LAW: a THROWING host propagates loudly (never swallowed,
 * never a synthetic result — the replay-benchmark precedent). A MALFORMED
 * host outcome (not an object, completed not a boolean, failureReason
 * present but not a string, OR a DiffReport-shaped object) is a NAMED
 * error result — fail-closed, never guessed.
 *
 * Discipline (binding — ADR-004 hard rules): no clock, no randomness, no
 * network, no filesystem, no global state; the module never mutates its
 * inputs; results, never exceptions (except the loud-host law above).
 */

import type { LinuxEnvironment } from "./environment.ts";
import { validateLinuxEnvironment } from "./environment.ts";

// ---- the host seam (the honest boundary) -------------------------------------------

/**
 * The verification host seam: runs ONE journey on the target (duck-typed
 * at bind time with a typed fail-closed error — the test fakes it).
 */
export interface LinuxVerificationHost {
  /**
   * Run a journey (a journey id) against the target; resolve with the
   * outcome. The outcome MUST be an object with a boolean `completed` and
   * an optional string `failureReason` — never a DiffReport-shaped object.
   */
  runJourney(journeyId: string): Promise<{ completed: boolean; failureReason?: string }>;
}

/** One verification run — the journey outcomes, MEASURED. */
export interface LinuxVerificationRun {
  /** The descriptor version the run executed under (CLAPP_NATIVE_LINUX_ENVIRONMENT_VERSION). */
  environmentVersion: string;
  /** The journey ids attempted (the caller's list, sorted, deduped). */
  journeyIds: string[];
  /** MEASURED: how many completed. */
  completed: number;
  /** MEASURED: how many failed. */
  failed: number;
  /** The host's failure reasons, VERBATIM, in journey order. */
  failures: Array<{ journeyId: string; reason: string }>;
}

/** The verification adapter's fail-closed result (the house shape). */
export type LinuxVerificationResult =
  | { ok: true; run: LinuxVerificationRun }
  | { ok: false; errors: string[] };

// ---- internal helpers (module-level; NOT re-exported by src/index.ts) --------------

/**
 * Duck-typed host-seam guard: an object with a callable runJourney.
 * Bind-time validation — a malformed host (missing structural member) fails
 * closed here at bind, never at call (ADR-004 hard gate (g)).
 */
function isVerificationHost(host: unknown): host is LinuxVerificationHost {
  return (
    typeof host === "object" &&
    host !== null &&
    typeof (host as Record<string, unknown>).runJourney === "function"
  );
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
 * The DiffReport-shaped keys the diff lane owns (TYPE-ONLY reference, the
 * @clapp/contracts DiffReport shape). If a host outcome carries any of
 * these, the adapter was handed a DiffReport-shaped object — ADR-004
 * forbids this adapter from constructing one (it never does), and equally
 * forbids accepting one masquerading as a journey outcome (fail-closed).
 */
const DIFFREPORT_KEYS = new Set(["findings", "verdict", "referenceRunId", "candidateRunId"]);

/**
 * Validates one host outcome: must be a plain object with a boolean
 * `completed` and an optional string `failureReason`; MUST NOT carry any
 * DiffReport-shaped key (the diff boundary, ADR-004). Returns the validated
 * outcome or a named error string.
 */
function validateHostOutcome(
  outcome: unknown,
  journeyId: string,
): { ok: true; completed: boolean; failureReason?: string } | { ok: false; reason: string } {
  if (!isObject(outcome)) {
    return {
      ok: false,
      reason: `host outcome for journey ${preview(journeyId)} must be an object with a boolean completed (observed: ${preview(outcome)})`,
    };
  }
  // THE DIFF BOUNDARY (ADR-004): a host outcome carrying DiffReport-shaped
  // keys is a named error — the adapter never constructs a DiffReport and
  // never accepts one masquerading as a journey outcome. The diff lane
  // owns the verdict/findings/referenceRunId/candidateRunId vocabulary.
  const diffKeysPresent = Object.keys(outcome).filter((key) => DIFFREPORT_KEYS.has(key));
  if (diffKeysPresent.length > 0) {
    return {
      ok: false,
      reason: `host outcome for journey ${preview(journeyId)} carries DiffReport-shaped keys (${diffKeysPresent
        .map((key) => JSON.stringify(key))
        .join(
          ", ",
        )}) — the adapter never constructs a parity/verdict record (ADR-004); a fake DiffReport-shaped return is a named error`,
    };
  }
  if (typeof outcome.completed !== "boolean") {
    return {
      ok: false,
      reason: `host outcome for journey ${preview(journeyId)} must have a boolean completed (observed: ${preview(outcome.completed)})`,
    };
  }
  const failureReason = outcome.failureReason;
  if (failureReason !== undefined && typeof failureReason !== "string") {
    return {
      ok: false,
      reason: `host outcome failureReason for journey ${preview(journeyId)} must be a string when present (observed: ${preview(failureReason)})`,
    };
  }
  return {
    ok: true,
    completed: outcome.completed as boolean,
    ...(typeof failureReason === "string" ? { failureReason } : {}),
  };
}

// ---- the verification adapter --------------------------------------------------------

/**
 * Verify a list of journeys through the host seam — fail-closed, measured,
 * verbatim.
 *
 * The host must be an object with a callable runJourney; the journeys must
 * be an array of non-empty strings, deduped (a duplicate is a named error)
 * and sorted ascending; the env must pass validateLinuxEnvironment (its
 * errors are carried). Every journey is then run through the host IN THE
 * SORTED ORDER; completed/failed are MEASURED from the host's outcomes
 * (each outcome must be `{ completed: boolean, failureReason?: string }`
 * — a DiffReport-shaped outcome is a NAMED error, never accepted); the
 * failure reasons ride VERBATIM in journey order. Results, never
 * exceptions — a THROWING host propagates loudly (never swallowed, never a
 * synthetic result).
 */
export async function verifyLinuxJourneys(
  host: unknown,
  journeys: unknown,
  env: unknown,
): Promise<LinuxVerificationResult> {
  const errors: string[] = [];

  if (!isVerificationHost(host)) {
    errors.push(
      `verification host must be an object with a callable runJourney() method (observed: ${preview(host)})`,
    );
  }

  if (!Array.isArray(journeys)) {
    errors.push(`journeys must be an array of journey id strings (observed: ${preview(journeys)})`);
  } else {
    const ids: string[] = [];
    for (const [index, journeyId] of journeys.entries()) {
      if (typeof journeyId !== "string" || journeyId.length === 0) {
        errors.push(
          `journeys[${index}] must be a non-empty string (observed: ${preview(journeyId)})`,
        );
        continue;
      }
      ids.push(journeyId);
    }
    const seen = new Set<string>();
    for (const journeyId of ids) {
      if (seen.has(journeyId)) {
        errors.push(`journeys contains a duplicate journey id (observed: ${preview(journeyId)})`);
      } else {
        seen.add(journeyId);
      }
    }
    const sorted = [...ids].sort();
    if (ids.some((journeyId, index) => journeyId !== sorted[index])) {
      errors.push(`journeys must be sorted ascending (observed: ${preview(ids)})`);
    }
  }

  const environmentValidation = validateLinuxEnvironment(env);
  if (!environmentValidation.ok) {
    errors.push(...environmentValidation.errors);
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const environment = env as LinuxEnvironment;
  const verificationHost = host as LinuxVerificationHost;
  const journeyIds = journeys as string[];

  // The run — every journey through the host, in the sorted order. A
  // THROWING host propagates loudly (never swallowed: no synthetic result
  // is ever invented — the replay-benchmark precedent).
  const completedIds: string[] = [];
  const failures: Array<{ journeyId: string; reason: string }> = [];

  for (const journeyId of journeyIds) {
    const outcome: unknown = await verificationHost.runJourney(journeyId);
    const validated = validateHostOutcome(outcome, journeyId);
    if (!validated.ok) {
      return { ok: false, errors: [validated.reason] };
    }
    if (validated.completed) {
      completedIds.push(journeyId);
    } else {
      // VERBATIM: the host's reason carried exactly, in journey order; a
      // failed journey whose host said nothing carries '' (the host said
      // nothing — never invented, never re-worded).
      failures.push({
        journeyId,
        reason: typeof validated.failureReason === "string" ? validated.failureReason : "",
      });
    }
  }

  // MEASURED: completed/failed counted from the host's outcomes — never
  // asserted, never derived from the input list's length.
  const run: LinuxVerificationRun = {
    environmentVersion: environment.environmentVersion,
    journeyIds,
    completed: completedIds.length,
    failed: failures.length,
    failures,
  };
  return { ok: true, run };
}
