/**
 * @clapp/native-linux — the evidence emitter (ADR-004, component 3 of 5).
 *
 * ADR-004: each platform implements an evidence emitter. THIS MODULE IS
 * THE LINUX ONE: `emitObservationEvidence` turns one measured observation
 * into one EvidenceRef-shaped record — the FROZEN @clapp/contracts shape,
 * never a forked lookalike. TYPE-ONLY alignment with @clapp/contracts: the
 * EvidenceRef type is imported `import type`-only; no runtime surface of
 * @clapp/contracts is consumed (it has none — it is a pure-type contract
 * package), and the import-discipline test pins this.
 *
 * THE NO-FORK LAW (ADR-004 cardinal law, binding here at its sharpest):
 * the emitter RETURNS the contracts' EvidenceRef type and validates its
 * kind against the frozen evidence kinds the openClapp surface admits. It
 * never redefines, rewrites, or forks the shape; never invents a kind;
 * never re-hashes (sha256 carries the observation's screenDigest VERBATIM
 * — the capture's own measured digest, measured upstream by the
 * observation seam, never re-asserted here). An unknown kind is a NAMED
 * error result.
 *
 * THE PREFIX DISCIPLINE (ADR-004): Linux observation evidence ids are
 * minted 'lidev_' + the observation's screenDigest hex —
 * CONTENT-DERIVED and deterministic (the same capture mints the same
 * evidence id forever; no uuid, no clock, no randomness — the
 * content-addressed-identity house law, 'lidev_' being this lane's
 * prefix per ADR-004: 'lidev_' (linux) + the digest hex).
 *
 * EvidenceRef.id (a plain string in @clapp/contracts) carries this lane's
 * 'lidev_' + digest form; the sha256 field carries the observation's
 * screenDigest VERBATIM (the capture's own measured digest); the
 * classification is the honest one ('observed' only for what the host
 * actually produced, per ADR-004 — never 'derived', never 'inferred',
 * never 'assumed' from this emitter).
 *
 * Discipline (binding — ADR-004 hard rules): no clock, no randomness, no
 * network, no filesystem, no global state; the module never mutates its
 * inputs; results, never exceptions.
 *
 * Honest v0.1 scope: the emitter validates the observation's DIGEST
 * (what it consumes — a non-empty string) and the kind; the observation's
 * other measured fields (environmentVersion, nodeCount, observedDepth) are
 * the observation seam's guarantee, not re-validated here. Persisting the
 * evidence (the EvidenceBundle machinery) is a later consumer, never this
 * one — this emitter returns the EvidenceRef only.
 */

import type { EvidenceClassification, EvidenceRef } from "@clapp/contracts";

import type { LinuxObservation } from "./observation.ts";

// ---- the frozen vocabulary (consumed, never redefined) ------------------------------

/**
 * The frozen evidence-kind vocabulary for the Linux observation lane. The
 * openClapp EvidenceClassification contract admits five values
 * (observed/derived/inferred/assumed/unavailable); ADR-004 says the emitter
 * carries the HONEST classification only — 'observed' for what the host
 * actually produced. The kinds here are the artifact kinds the openClapp
 * observation lanes use (dom-text, page-meta, screenshot, dom-structure,
 * a11y, network, storage — the @clapp/observation channel names). A kind
 * outside this list is a NAMED error — never an invented one. The list is
 * frozen at v0.1 per ADR-004 "the frozen vocabulary is platform-specific".
 */
const LINUX_EVIDENCE_KINDS: readonly string[] = [
  "dom-text",
  "page-meta",
  "screenshot",
  "dom-structure",
  "a11y",
  "network",
  "storage",
];

/** The frozen kinds rendered for error messages (the observed-value law). */
const KINDS_FOR_MESSAGES = LINUX_EVIDENCE_KINDS.map((kind) => JSON.stringify(kind)).join(" | ");

// ---- the emitter ---------------------------------------------------------------------

/** The emitter's fail-closed result: the contracts' EvidenceRef, or named errors. */
export type ObservationEvidenceResult =
  | { ok: true; evidence: EvidenceRef }
  | { ok: false; errors: string[] };

/** Evidence id prefix discipline (ADR-004): every Linux observation evidence id starts 'lidev_'. */
export const LINUX_EVIDENCE_ID_PREFIX = "lidev_";

// ---- internal helpers (module-level; NOT re-exported by src/index.ts) --------------

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

// ---- the evidence emitter ------------------------------------------------------------

/**
 * Emit one EvidenceRef-shaped record for the observation — the frozen
 * @clapp/contracts shape, never forked.
 *
 * evidenceId is minted CONTENT-DERIVED (ADR-004): 'lidev_' + the
 * observation's screenDigest hex — deterministic, no uuid, no clock. The
 * kind must be one of the frozen LINUX_EVIDENCE_KINDS (an unknown kind is
 * a NAMED error, never an invented one). sha256 carries the observation's
 * screenDigest verbatim — the capture's own measured digest.
 * classification is the honest 'observed' for what the host actually
 * produced (ADR-004: never fabricated, never defaulted). Emitting twice
 * for the same observation and kind mints deep-equal EvidenceRefs (the
 * determinism law).
 *
 * The required EvidenceRef fields (targetId, reconstructionId, capturedAt,
 * redacted) are caller-supplied — the emitter fails closed if any is
 * missing or malformed. The emitter never invents them (no clock → no
 * capturedAt, no caller context → no targetId); it composes the
 * caller-supplied identity with the content-derived id and digest.
 */
export function emitObservationEvidence(
  observation: LinuxObservation,
  kind: string,
  context: {
    targetId: string;
    reconstructionId: string;
    capturedAt: string;
  },
): ObservationEvidenceResult {
  const errors: string[] = [];

  if (!isObject(observation)) {
    return {
      ok: false,
      errors: [`observation must be a LinuxObservation object (observed: ${preview(observation)})`],
    };
  }

  const screenDigest = observation.screenDigest;
  if (typeof screenDigest !== "string" || screenDigest.length === 0) {
    errors.push(
      `observation.screenDigest must be a non-empty string — the measured capture digest (observed: ${preview(screenDigest)})`,
    );
  }

  if (typeof kind !== "string" || !LINUX_EVIDENCE_KINDS.includes(kind)) {
    errors.push(
      `kind must be one of the frozen LINUX_EVIDENCE_KINDS: ${KINDS_FOR_MESSAGES} (observed: ${preview(kind)})`,
    );
  }

  if (!isObject(context)) {
    errors.push(
      `context must be an object with targetId, reconstructionId, capturedAt (observed: ${preview(context)})`,
    );
  } else {
    if (typeof context.targetId !== "string" || context.targetId.length === 0) {
      errors.push(
        `context.targetId must be a non-empty string (observed: ${preview(context.targetId)})`,
      );
    }
    if (
      typeof context.reconstructionId !== "string" ||
      context.reconstructionId.length === 0
    ) {
      errors.push(
        `context.reconstructionId must be a non-empty string (observed: ${preview(context.reconstructionId)})`,
      );
    }
    if (typeof context.capturedAt !== "string" || context.capturedAt.length === 0) {
      errors.push(
        `context.capturedAt must be a non-empty string (observed: ${preview(context.capturedAt)})`,
      );
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  // ADR-004: 'lidev_' (linux) + the digest hex. The full digest is used
  // (64 hex chars); the openClapp contracts' EvidenceRef.id is a plain
  // string so any prefix + hex form is admissible, and the full digest
  // preserves the content-addressed guarantee the diff lane relies on.
  const evidence: EvidenceRef = {
    id: `${LINUX_EVIDENCE_ID_PREFIX}${screenDigest}`,
    targetId: context.targetId,
    reconstructionId: context.reconstructionId,
    kind,
    sha256: screenDigest,
    source: `@clapp/native-linux:${kind}`,
    capturedAt: context.capturedAt,
    classification: "observed" as EvidenceClassification,
    redacted: false,
  };
  return { ok: true, evidence };
}
