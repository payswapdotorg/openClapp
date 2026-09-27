import type { EvidenceBundle, EvidenceRef } from "@clapp/contracts";
import { canonicalJsonBytes, sha256Hex } from "./canonical.ts";
import { ClappObservationError, describeShape } from "./errors.ts";
import { redactionMarkerPayload } from "./markers.ts";

/**
 * Redaction over evidence bundles.
 *
 * Rules name evidence kinds and/or ref id prefixes. redact() returns a NEW
 * bundle — the original is never mutated — whose matching refs are marked
 * redacted:true with their content replaced by a deterministic redaction
 * marker payload of identical shape (text stays text; the screenshot stays a
 * real PNG). The rootSha256 is recomputed over the new refs; the environment
 * carries an honest, deterministic redaction record.
 */

/** Redaction rule set: match refs by evidence kind and/or id prefix. */
export interface RedactionRules {
  /** Evidence kinds whose refs must be redacted (matched on EvidenceRef.kind). */
  kinds?: string[];
  /** Ref id prefixes; a ref whose id starts with any prefix is redacted. */
  idPrefixes?: string[];
}

/** The deterministic redaction record appended to the bundle environment. */
export interface RedactionRecord {
  clapp: "redaction";
  redactedRefCount: number;
  rules: { kinds: string[]; idPrefixes: string[] };
  redactedRefIds: string[];
}

/** The result of a redaction: the new bundle plus the matched ref ids. */
export interface RedactionResult {
  bundle: EvidenceBundle;
  record: RedactionRecord;
}

const REDACTED_SOURCE_PREFIX = "redacted:";

/** True when the rules select this ref (kind list or id prefix). */
function matches(ref: EvidenceRef, kinds: Set<string>, idPrefixes: string[]): boolean {
  if (kinds.has(ref.kind)) return true;
  return idPrefixes.some((prefix) => prefix !== "" && ref.id.startsWith(prefix));
}

/**
 * Redacts a bundle: returns a NEW bundle whose matching refs are marked
 * redacted with marker content of identical shape; the original bundle (and
 * its refs) is left untouched. The redacted ref keeps its identity fields —
 * id, targetId, reconstructionId, kind, capturedAt, classification — and
 * records redaction honestly in its source ("redacted:<original source>")
 * and sha256 (the true digest of the marker bytes). rootSha256 is
 * recomputed over the redacted ref list. Rules with no matches are an error:
 * silent no-op redaction would be dishonest.
 */
export function redact(bundle: EvidenceBundle, rules: RedactionRules): RedactionResult {
  if (typeof bundle !== "object" || bundle === null || !Array.isArray(bundle.refs))
    throw new ClappObservationError(
      "redaction",
      `redact requires an EvidenceBundle with a refs array; received ${describeShape(bundle)}`,
    );
  const kinds = rules?.kinds ?? [];
  const idPrefixes = rules?.idPrefixes ?? [];
  if (!Array.isArray(kinds) || kinds.some((kind) => typeof kind !== "string"))
    throw new ClappObservationError(
      "redaction",
      "rules.kinds must be an array of evidence kind strings",
    );
  if (!Array.isArray(idPrefixes) || idPrefixes.some((prefix) => typeof prefix !== "string"))
    throw new ClappObservationError(
      "redaction",
      "rules.idPrefixes must be an array of id prefix strings",
    );
  if (kinds.length === 0 && idPrefixes.length === 0)
    throw new ClappObservationError(
      "redaction",
      "redaction rules must name at least one evidence kind or id prefix; empty rules would silently redact nothing",
    );
  const kindSet = new Set(kinds);
  const redactedRefIds: string[] = [];
  const refs = bundle.refs.map((ref) => {
    if (!matches(ref, kindSet, idPrefixes)) return ref;
    redactedRefIds.push(ref.id);
    const payload = redactionMarkerPayload(ref);
    return {
      ...ref,
      sha256: sha256Hex(payload),
      source: `${REDACTED_SOURCE_PREFIX}${ref.source}`,
      redacted: true,
    };
  });
  if (redactedRefIds.length === 0)
    throw new ClappObservationError(
      "redaction",
      `no refs in bundle "${bundle.id}" matched the redaction rules (kinds: [${kinds.join(", ")}], idPrefixes: [${idPrefixes.join(", ")}]); refusing to return an unchanged bundle as redacted`,
    );
  const rootSha256 = sha256Hex(canonicalJsonBytes(refs));
  const record: RedactionRecord = {
    clapp: "redaction",
    redactedRefCount: redactedRefIds.length,
    rules: { kinds: [...kinds], idPrefixes: [...idPrefixes] },
    redactedRefIds: [...redactedRefIds],
  };
  const environment: Record<string, unknown> = {
    ...bundle.environment,
    redaction: record,
  };
  return {
    bundle: {
      ...bundle,
      environment,
      refs,
      rootSha256,
    },
    record,
  };
}
