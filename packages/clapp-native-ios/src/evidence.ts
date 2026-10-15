import type { EvidenceClassification, EvidenceRef } from "@clapp/contracts";
import { canonicalJsonBytes, sha256Hex, utf8 } from "./canonical.ts";
import { ClappNativeIosError, describeShape } from "./errors.ts";

/**
 * The iOS evidence emitter — `EvidenceRef`-shaped records with deterministic
 * content-derived ids and the per-platform `idev_` prefix (ADR-004, component 3).
 *
 * TYPE-ONLY alignment with `@clapp/contracts`: the EvidenceRef shape is
 * imported as a type only and constructed over bytes this package holds. The
 * id is `idev_` + the first 16 hex characters of the sha256 over the
 * canonical content payload (ADR-003 family discipline: `clapp_authz_`,
 * `clapp_eval_`, `clapp_package_`, `clapp_run_`, `clapp_target_` all use the
 * same 16-hex shape). Classification is the honest one — `observed` only for
 * what the host seam actually produced; the emitter never upgrades an
 * `unavailable` classification to `observed`, never fabricates a digest from
 * upstream metadata, and never introduces wall-clock, randomness, or network.
 */

/**
 * The iOS evidence id prefix (ADR-004). The five native adapters each carry
 * their own prefix (`ndev_`, `lidev_`, `wdev_`, `mdev_`, `idev_`); this is the
 * iOS lane's.
 */
export const IOS_EVIDENCE_ID_PREFIX = "idev_";

/** The honest classification the emitter assigns to host-produced evidence. */
const OBSERVED: EvidenceClassification = "observed";

/** The manifest payload the emitter hashes to derive an evidence id. */
export interface IosEvidenceManifest {
  /** The application target the evidence was captured against (e.g. CFBundleIdentifier). */
  readonly application: string;
  /** The evidence kind (e.g. "element-tree", "failure-reason"). */
  readonly kind: string;
  /** The reconstruction the evidence belongs to. */
  readonly reconstructionId: string;
  /** The target the evidence belongs to. */
  readonly targetId: string;
  /** The content digest of the evidence payload (sha256 hex, full 64). */
  readonly digest: string;
}

/** The id form pinned by the ADR-003 family discipline: prefix + 16 hex. */
const IOS_EVIDENCE_ID_PATTERN = /^idev_[0-9a-f]{16}$/;

/** Caller-supplied manifest inputs (without the digest, which is always re-measured from the payload). */
export type IosEvidenceManifestInputs = Omit<IosEvidenceManifest, "digest">;

/** Derives the iOS evidence id from a manifest (deterministic, content-derived). */
export function iosEvidenceId(manifest: IosEvidenceManifest): string {
  return `${IOS_EVIDENCE_ID_PREFIX}${sha256Hex(canonicalJsonBytes(manifest)).slice(0, 16)}`;
}

/** True when a value is shaped like an iOS evidence id (prefix + 16 hex). */
export function isIosEvidenceId(value: unknown): value is string {
  return typeof value === "string" && IOS_EVIDENCE_ID_PATTERN.test(value);
}

/**
 * Builds an EvidenceRef over caller-supplied payload bytes and a manifest.
 * The digest is RE-MEASURED from the payload (never copied from upstream
 * metadata); the id is derived from the manifest (application, kind,
 * reconstruction, target, digest) so two structurally equal payloads under
 * the same manifest produce byte-identical ids. The classification is always
 * the honest `observed` — this emitter produces only evidence the host seam
 * actually produced; an honest absence is the observation component's typed
 * refusal, not a fabricated evidence ref.
 */
export function iosEvidenceRef(
  manifest: IosEvidenceManifestInputs,
  payload: Uint8Array,
  source: string,
  capturedAt: string,
): EvidenceRef {
  if (typeof manifest?.application !== "string" || manifest.application.trim() === "")
    throw new ClappNativeIosError(
      "evidence",
      "application",
      `the evidence manifest requires a non-empty application target; received ${describeShape(manifest?.application)}`,
    );
  if (typeof manifest?.kind !== "string" || manifest.kind.trim() === "")
    throw new ClappNativeIosError(
      "evidence",
      "kind",
      `the evidence manifest requires a non-empty kind; received ${describeShape(manifest?.kind)}`,
    );
  if (typeof manifest?.reconstructionId !== "string" || manifest.reconstructionId.trim() === "")
    throw new ClappNativeIosError(
      "evidence",
      "reconstructionId",
      `the evidence manifest requires a non-empty reconstructionId; received ${describeShape(manifest?.reconstructionId)}`,
    );
  if (typeof manifest?.targetId !== "string" || manifest.targetId.trim() === "")
    throw new ClappNativeIosError(
      "evidence",
      "targetId",
      `the evidence manifest requires a non-empty targetId; received ${describeShape(manifest?.targetId)}`,
    );
  if (!(payload instanceof Uint8Array))
    throw new ClappNativeIosError(
      "evidence",
      "payload",
      `the evidence payload must be a Uint8Array this package holds; received ${describeShape(payload)}`,
    );

  // Re-measure the digest from the payload bytes — never trust upstream metadata.
  const sha256 = sha256Hex(payload);
  const id = iosEvidenceId({ ...manifest, digest: sha256 });

  return {
    id,
    targetId: manifest.targetId,
    reconstructionId: manifest.reconstructionId,
    kind: manifest.kind,
    sha256,
    source,
    capturedAt,
    classification: OBSERVED,
    redacted: false,
  };
}

/** Convenience: builds an EvidenceRef over a UTF-8 text payload. */
export function iosEvidenceRefForText(
  manifest: IosEvidenceManifestInputs,
  text: string,
  source: string,
  capturedAt: string,
): EvidenceRef {
  return iosEvidenceRef(manifest, utf8(text), source, capturedAt);
}
