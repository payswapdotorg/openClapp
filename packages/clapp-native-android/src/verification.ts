/**
 * @clapp/native-android — the Android verification adapter (ADR-004,
 * component 5 of the frozen five-component v0.1 contract).
 *
 * This module is the platform's duck-typed journey-runner seam: the host
 * runs a journey against the synthesized target, and the adapter returns
 * the MEASURED outcomes — completed and failed counted, failure reasons
 * carried VERBATIM.
 *
 * THE HOST-SEAM LAW (the honest boundary, ADR-004 binding): everything
 * environment-specific enters through ONE duck-typed seam —
 * AndroidVerificationHost ("an object with a callable runJourney()"). The
 * CONTRACTS are this lane's deliverable; the tests fake the seam. Real
 * emulator/instrumentation bindings are deployment scope (a later TL
 * composition wave) — never this module.
 *
 * THE HONEST-ABSENT LAW (ADR-004 binding, applied consistently): a `none`
 * uiTestFramework is a VALID descriptor — the honest-absent state. The
 * verification adapter REFUSES it with a typed named error and NEVER calls
 * the host (no framework is bound to run a journey). This mirrors the
 * observation component's none-refusal and the failure principle of
 * docs/clapp/ARCHITECTURE.md §12 — disclosed as a boundary note (the ADR
 * pins the none-refusal explicitly for observation; verification inherits
 * the same honest-absent discipline for symmetry).
 *
 * THE MEASUREMENT LAW: completed and failed are MEASURED from the host's
 * outcomes (counted, never asserted, never derived from the input list's
 * length); the failure reasons ride VERBATIM in journey order (the host's
 * reason carried exactly — never re-worded, never normalized; a failed
 * journey whose host said nothing carries "" — the host said nothing, and
 * nothing is never invented).
 *
 * THE DIFF BOUNDARY (the no-fork law, documented as the boundary,
 * ADR-004 binding): the run's data is the shape the diff lane consumes —
 * the paired-run evidence enters the frozen @clapp/contracts DiffReport
 * through the diff discipline's EXISTING machinery (a later consumer); THIS
 * ADAPTER NEVER CONSTRUCTS A DiffReport. A host outcome shaped like a
 * DiffReport (carrying a `verdict` or `findings` field — the contracts'
 * DiffReport signature) is a NAMED error result: the adapter refuses a host
 * that tries to feed it parity/verdict data, and it never builds a verdict
 * itself.
 *
 * THE LOUD-HOST LAW: a THROWING host propagates loudly (never swallowed,
 * never a synthetic result). A MALFORMED host outcome (not an object,
 * completed not a boolean, failureReason present but not a string) is a
 * NAMED error result — fail-closed, never guessed.
 *
 * Discipline (binding — the ADR-004 hard rules): no wall-clock, no
 * randomness, no network, no filesystem, no global state; the module never
 * mutates its inputs; results, never exceptions (except the loud-host law
 * above, and the typed bind-time host-seam error).
 */

import type { AndroidEnvironment } from "./environment.ts";
import { validateAndroidEnvironment } from "./environment.ts";
import { ClappNativeAndroidError, describeShape, isObject, preview } from "./errors.ts";

// ---- the host seam (the honest boundary) -------------------------------------------

/**
 * The verification host seam: runs ONE journey on the target (duck-typed;
 * the test fakes it). The outcome is the host's own: a boolean `completed`
 * and, when present, a `failureReason` string. The adapter never accepts a
 * parity/verdict payload here (the diff discipline owns verdict construction).
 */
export interface AndroidVerificationHost {
  /** Run a journey (a journey id) against the target; resolve with the outcome. */
  runJourney(journeyId: string): Promise<{ completed: boolean; failureReason?: string }>;
}

/** One verification run — the journey outcomes, MEASURED. */
export interface AndroidVerificationRun {
  /** The descriptor version the run executed under (CLAPP_NATIVE_ANDROID_ENVIRONMENT_VERSION). */
  environmentVersion: string;
  /** The journey ids attempted (the caller's list, in the order run). */
  journeyIds: string[];
  /** MEASURED: how many completed. */
  completed: number;
  /** MEASURED: how many failed. */
  failed: number;
  /** The host's failure reasons, VERBATIM, in journey order. */
  failures: Array<{ journeyId: string; reason: string }>;
}

/** The verification adapter's fail-closed result (the house shape). */
export type AndroidVerificationResult =
  | { ok: true; run: AndroidVerificationRun }
  | { ok: false; errors: string[] };

// ---- the bind-time seam validation -------------------------------------------------

/**
 * Duck-types an untyped host handle onto AndroidVerificationHost. Fails
 * closed with a TYPED error at BIND time (never deferred to a call): a host
 * that is not an object, or that is missing a callable runJourney(),
 * raises ClappNativeAndroidError naming the component and the observed
 * shape. This is the ADR-004 hard rule: bind-time seam validation — a
 * malformed host fails the bind, never the call.
 */
export function bindAndroidVerificationHost(host: unknown): AndroidVerificationHost {
  if (!isObject(host)) {
    throw new ClappNativeAndroidError(
      "verification-host",
      `the verification host must be an object providing a callable runJourney() method (the journey-runner seam); received ${describeShape(host)}`,
    );
  }
  if (typeof host.runJourney !== "function") {
    throw new ClappNativeAndroidError(
      "verification-host",
      `the verification host is missing the required capability "runJourney" (the journey-runner seam); bind fails closed — observed: ${preview(host.runJourney)}`,
    );
  }
  return host as unknown as AndroidVerificationHost;
}

// ---- the verification adapter --------------------------------------------------------

/**
 * Verify a list of journeys through the host seam — fail-closed, measured,
 * verbatim.
 *
 * The env must pass validateAndroidEnvironment (its errors are carried); the
 * host is then duck-typed at BIND time (a malformed host raises
 * ClappNativeAndroidError, never deferred to a call). When the env's
 * uiTestFramework is "none" — the VALID honest-absent state — the adapter
 * REFUSES with a typed named error and NEVER calls the host (no framework is
 * bound to run a journey). The journeys must be an array of non-empty strings
 * (the caller owns order and uniqueness; the adapter runs them IN THE GIVEN
 * ORDER — no silent reordering, no silent dedupe). Every journey is then run
 * through the host; completed/failed are MEASURED from the host's outcomes;
 * the failure reasons ride VERBATIM in journey order. A host outcome shaped
 * like a DiffReport (carrying `verdict` or `findings`) is a NAMED error —
 * the adapter never constructs a parity/verdict record. Results, never
 * exceptions — a THROWING host propagates loudly (never swallowed, never a
 * synthetic result).
 */
export async function verifyAndroidJourneys(
  host: unknown,
  journeys: unknown,
  env: unknown,
): Promise<AndroidVerificationResult> {
  const errors: string[] = [];

  const environmentValidation = validateAndroidEnvironment(env);
  if (!environmentValidation.ok) {
    return { ok: false, errors: environmentValidation.errors };
  }

  // Bind the host at bind time — a malformed host raises here, never at a call.
  const verificationHost = bindAndroidVerificationHost(host);
  const environment = env as AndroidEnvironment;

  // The honest-absent refusal: a "none" framework never calls the host.
  if (environment.uiTestFramework === "none") {
    return {
      ok: false,
      errors: [
        `uiTestFramework is "none" — the honest-absent state; the Android verification adapter refuses to run journeys (no UI test framework is bound to call the host seam) and never calls runJourney()`,
      ],
    };
  }

  // The journeys — an array of non-empty strings. The caller owns order and
  // uniqueness; the adapter runs them IN THE GIVEN ORDER (no silent reorder,
  // no silent dedupe — the caller's list is the caller's contract).
  if (!Array.isArray(journeys)) {
    return {
      ok: false,
      errors: [`journeys must be an array of journey id strings (observed: ${preview(journeys)})`],
    };
  }
  const journeyIds: string[] = [];
  for (const [index, journeyId] of journeys.entries()) {
    if (typeof journeyId !== "string" || journeyId.length === 0) {
      errors.push(
        `journeys[${index}] must be a non-empty string (observed: ${preview(journeyId)})`,
      );
      continue;
    }
    journeyIds.push(journeyId);
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }

  // The run — every journey through the host, in the given order. A
  // THROWING host propagates loudly (never swallowed: no synthetic result is
  // ever invented).
  const completedIds: string[] = [];
  const failures: Array<{ journeyId: string; reason: string }> = [];

  for (const journeyId of journeyIds) {
    const outcome: unknown = await verificationHost.runJourney(journeyId);

    // THE DIFF BOUNDARY: a host outcome shaped like a DiffReport (carrying
    // a `verdict` or `findings` field — the contracts' DiffReport signature)
    // is a NAMED error. The adapter never constructs a parity/verdict
    // record, and it refuses a host that tries to feed it one.
    if (isObject(outcome) && ("verdict" in outcome || "findings" in outcome)) {
      return {
        ok: false,
        errors: [
          `host outcome for journey ${preview(journeyId)} carries a parity/verdict payload (observed keys include ${[...Object.keys(outcome)].map((k) => JSON.stringify(k)).join(", ")}); the verification adapter never constructs a DiffReport — the diff discipline owns verdict construction (a later consumer)`,
        ],
      };
    }

    if (!isObject(outcome) || typeof outcome.completed !== "boolean") {
      return {
        ok: false,
        errors: [
          `host outcome for journey ${preview(journeyId)} must be an object with a boolean completed (observed: ${preview(outcome)})`,
        ],
      };
    }

    const failureReason = (outcome as { failureReason?: unknown }).failureReason;
    if (failureReason !== undefined && typeof failureReason !== "string") {
      return {
        ok: false,
        errors: [
          `host outcome failureReason for journey ${preview(journeyId)} must be a string when present (observed: ${preview(failureReason)})`,
        ],
      };
    }

    if (outcome.completed) {
      completedIds.push(journeyId);
    } else {
      // VERBATIM: the host's reason carried exactly, in journey order; a
      // failed journey whose host said nothing carries "" (the host said
      // nothing — never invented, never re-worded).
      failures.push({
        journeyId,
        reason: typeof failureReason === "string" ? failureReason : "",
      });
    }
  }

  // MEASURED: completed/failed counted from the host's outcomes — never
  // asserted, never derived from the input list's length.
  const run: AndroidVerificationRun = {
    environmentVersion: environment.environmentVersion,
    journeyIds,
    completed: completedIds.length,
    failed: failures.length,
    failures,
  };
  return { ok: true, run };
}
