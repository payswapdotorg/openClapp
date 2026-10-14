/**
 * @clapp/native-android — the evidence emitter (ADR-004, component 3 of the
 * frozen five-component v0.1 contract).
 *
 * This module turns one measured observation into one EvidenceRef-shaped
 * record — the FROZEN @clapp/contracts EvidenceRef shape, consumed
 * TYPE-ONLY (never a forked lookalike). The emitter mints CONTENT-DERIVED,
 * DETERMINISTIC ids with the per-platform prefix ADR-004 freezes for
 * Android: `ndev_` + the content digest hex. Classification is the honest
 * one — `observed` only for what the host actually produced (the ADR's
 * hard rule: never fabricated).
 *
 * THE PREFIX DISCIPLINE (ADR-004 binding): every Android observation
 * evidence id starts `ndev_` and continues with a sha256 hex digest over
 * the content that DISTINGUISHES the evidence — the observation's measured
 * screenDigest (the capture's own digest), the kind, the target id and the
 * reconstruction id. The same observation + kind + context mints the same
 * evidence id forever (no uuid, no wall-clock, no randomness — the
 * content-addressed-identity house law). A changed tree changes the
 * screenDigest, which changes the evidence id.
 *
 * THE NO-FORK LAW (ADR-004 binding): the emitter RETURNS @clapp/contracts'
 * EvidenceRef type — imported TYPE-ONLY — and never redefines, rewrites, or
 * forks the shape. sha256 carries the observation's screenDigest VERBATIM
 * (the capture's own measured digest, measured upstream by the observation
 * seam, never re-asserted here). The kind vocabulary is caller-owned at
 * v0.1 (the openClapp contracts EvidenceRef.kind is a plain string; no
 * frozen kind list is consumed here — disclosed as an honest v0.1 boundary:
 * the emitter validates the kind is a non-empty string and never invents one).
 *
 * Discipline (binding — the ADR-004 hard rules): no wall-clock, no
 * randomness, no network, no filesystem, no global state; the module never
 * mutates its inputs; results, never exceptions.
 *
 * Honest v0.1 scope: the emitter validates the observation's screenDigest
 * (what it consumes — a non-empty string) and the kind/context strings; the
 * observation's other measured fields (nodeCount, observedDepth) are the
 * observation seam's guarantee, not re-validated here. Persisting the
 * evidence is the persistence lane's concern, never this one (the
 * capturedAt is caller-supplied — clock-free by construction).
 */

import type { EvidenceClassification, EvidenceRef } from "@clapp/contracts";
import { canonicalJsonBytes, sha256Hex } from "./canonical.ts";
import { isObject, preview } from "./errors.ts";
import type { AndroidObservation } from "./observation.ts";

// ---- the frozen vocabulary (consumed, never redefined) ------------------------------

/** Evidence id prefix discipline: every Android observation evidence id starts "ndev_" (ADR-004). */
export const ANDROID_EVIDENCE_ID_PREFIX = "ndev_";

/**
 * The honest classification for an observation's evidence — `observed` only,
 * for what the host actually produced (the ADR's hard rule: never fabricated,
 * never derived/inferred/assumed by this emitter).
 */
export const ANDROID_EVIDENCE_CLASSIFICATION: EvidenceClassification = "observed";

/** The deterministic source note for one kind (the honest provenance string). */
const sourceNoteFor = (kind: string): string => `@clapp/native-android:observation:${kind}`;

// ---- the evidence context ----------------------------------------------------------

/**
 * The caller-supplied evidence context — the immutable, clock-free facts the
 * emitter pairs with a measured observation to mint a content-addressed
 * EvidenceRef. capturedAt is caller-supplied (deterministic — never the
 * wall-clock; the ADR's no-wall-clock hard rule).
 */
export interface AndroidEvidenceContext {
  /** The target id this evidence belongs to (non-empty string). */
  targetId: string;
  /** The reconstruction id this evidence belongs to (non-empty string). */
  reconstructionId: string;
  /** The capture timestamp (caller-supplied, deterministic — never the wall-clock). */
  capturedAt: string;
}

/** The emitter's fail-closed result: the contracts' EvidenceRef, or named errors. */
export type ObservationEvidenceResult =
  | { ok: true; evidence: EvidenceRef }
  | { ok: false; errors: string[] };

// ---- the evidence emitter ----------------------------------------------------------

/**
 * Emit one EvidenceRef-shaped record for the observation — the frozen
 * @clapp/contracts shape, never forked.
 *
 * evidenceId is minted CONTENT-DERIVED: `ndev_` + sha256Hex(canonicalJson({
 * targetId, reconstructionId, kind, screenDigest })) — deterministic, no
 * uuid, no clock. The kind must be a non-empty string (the caller-owned
 * vocabulary at v0.1; an empty/non-string kind is a NAMED error, never an
 * invented one). sha256 carries the observation's screenDigest verbatim —
 * the capture's own measured digest. classification is `observed` (the
 * honest one). Emitting twice for the same observation + kind + context
 * mints deep-equal EvidenceRefs (the determinism law). A changed tree
 * (different screenDigest) mints a different evidence id.
 */
export function emitObservationEvidence(
  observation: unknown,
  kind: unknown,
  context: unknown,
): ObservationEvidenceResult {
  const errors: string[] = [];

  if (!isObject(observation)) {
    return {
      ok: false,
      errors: [
        `observation must be an AndroidObservation object (observed: ${preview(observation)})`,
      ],
    };
  }

  const screenDigest = (observation as { screenDigest?: unknown }).screenDigest;
  if (typeof screenDigest !== "string" || screenDigest.length === 0) {
    errors.push(
      `observation.screenDigest must be a non-empty string — the measured capture digest (observed: ${preview(screenDigest)})`,
    );
  }

  if (typeof kind !== "string" || kind.length === 0) {
    errors.push(
      `kind must be a non-empty string (the caller-owned v0.1 evidence-kind vocabulary; observed: ${preview(kind)})`,
    );
  }

  if (!isObject(context)) {
    errors.push(`context must be an AndroidEvidenceContext object (observed: ${preview(context)})`);
  } else {
    const ctx = context as Record<string, unknown>;
    if (typeof ctx.targetId !== "string" || ctx.targetId.length === 0) {
      errors.push(
        `context.targetId must be a non-empty string (observed: ${preview(ctx.targetId)})`,
      );
    }
    if (typeof ctx.reconstructionId !== "string" || ctx.reconstructionId.length === 0) {
      errors.push(
        `context.reconstructionId must be a non-empty string (observed: ${preview(ctx.reconstructionId)})`,
      );
    }
    if (typeof ctx.capturedAt !== "string" || ctx.capturedAt.length === 0) {
      errors.push(
        `context.capturedAt must be a non-empty string — caller-supplied, clock-free (observed: ${preview(ctx.capturedAt)})`,
      );
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const observation_ = observation as unknown as AndroidObservation;
  const ctx_ = context as unknown as AndroidEvidenceContext;
  const kind_ = kind as string;

  // The content-derived evidence id: ndev_ + the content digest that
  // DISTINGUISHES the evidence (targetId, reconstructionId, kind, and the
  // observation's measured screenDigest). Deterministic, collision-free
  // across kinds for the same capture.
  const evidenceId = `${ANDROID_EVIDENCE_ID_PREFIX}${sha256Hex(
    canonicalJsonBytes({
      targetId: ctx_.targetId,
      reconstructionId: ctx_.reconstructionId,
      kind: kind_,
      screenDigest: observation_.screenDigest,
    }),
  )}`;

  const evidence: EvidenceRef = {
    id: evidenceId,
    targetId: ctx_.targetId,
    reconstructionId: ctx_.reconstructionId,
    kind: kind_,
    sha256: observation_.screenDigest,
    source: sourceNoteFor(kind_),
    capturedAt: ctx_.capturedAt,
    classification: ANDROID_EVIDENCE_CLASSIFICATION,
    redacted: false,
  };
  return { ok: true, evidence };
}
