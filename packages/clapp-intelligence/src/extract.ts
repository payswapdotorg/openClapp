import type {
  BehavioralIr,
  EvidenceBundle,
  EvidenceClassification,
  EvidenceRef,
  Journey,
  ReconstructionSpec,
} from "@clapp/contracts";
import { canonicalJson, compareStrings, isPlainObject, sha256Hex } from "./json.ts";

/**
 * CLAPP-W2-002 — evidence-to-IR extraction (the extraction half of
 * IMPLEMENTATION_PLAN Phase 3; exploration/journey deepening is W2-003).
 *
 * `extractBehavioralIr` derives a BehavioralIr from an EvidenceBundle
 * produced by the W1-002 browser observation adapter plus the
 * ReconstructionSpec that drove the capture. The derivation is:
 *
 * - DETERMINISTIC — identical (bundle, spec) produce deep-equal IRs and
 *   byte-identical canonical serialization (no timestamps, no random ids;
 *   every derived id is a content hash or an input literal, and every
 *   array is built in a fixed construction order);
 * - HONEST (ARCHITECTURE.md section 6) — nothing derived from unavailable
 *   evidence is ever presented as observed: every unavailable ref becomes an
 *   explicit assumption, and fields whose content lives in the observation
 *   vault rather than the bundle refs (screen url/title, and the page text
 *   length when not truncated) are recorded as null instead of guessed;
 * - PURE — the bundle and the spec are never mutated (evidence refs are
 *   shallow-copied into the IR, never re-minted, never duplicated).
 *
 * Shape notes, mirroring the LANDED W1-002 output:
 * - refs are attributed to entrypoints through the bundle environment's
 *   `entrypointRefs` fingerprint; entrypoints without attribution (or a
 *   bundle without the fingerprint) derive no screens/journeys, and the gap
 *   is recorded per entrypoint as assumptions, never as fabricated elements;
 * - a screen requires an OBSERVED dom-text/page-meta pair (zipped by
 *   bundle order; the current adapter emits at most one of each per
 *   entrypoint); a baseline journey requires at least one observed
 *   page-evidence ref for the entrypoint;
 * - the truncation fact is parsed from the dom-text ref source note (the
 *   only place the adapter records it); `textChars` carries the truncation
 *   bound when the text was cut and null otherwise;
 * - components/state/data/api stay empty this wave, each with an assumption
 *   recording why (honest emptiness, never silent).
 */

/** The single input of the extraction stage. */
export interface ExtractionInput {
  bundle: EvidenceBundle;
  spec: ReconstructionSpec;
}

/** One row of the evidence coverage inventory. */
export interface EvidenceCoverageEntry {
  kind: string;
  count: number;
  classification: EvidenceClassification;
}

const IR_SCHEMA_VERSION = "0.1";
const DOM_TEXT_KIND = "dom-text";
const PAGE_META_KIND = "page-meta";
const TRUNCATION_PATTERN = /\(truncated at (\d+) characters?\)/;
const PLATFORMS = new Set<string>(["web", "android", "linux", "windows", "macos", "ios"]);

/**
 * Derives the Behavioral IR from an observation bundle and its spec.
 * Throws a TypeError (naming the field) for structurally unusable inputs;
 * never mutates its inputs; never fabricates observed properties.
 */
export function extractBehavioralIr(input: ExtractionInput): BehavioralIr {
  const { bundle, spec } = input;
  requireBundle(bundle);
  requireSpec(spec);
  const entrypoints = dedupeEntrypoints(spec.entrypoints);
  const linkage = readEntrypointLinkage(bundle);
  const refEntrypoint = new Map<string, string>();
  if (linkage !== undefined) {
    for (const [entrypoint, ids] of linkage) {
      for (const id of ids) {
        if (!refEntrypoint.has(id)) refEntrypoint.set(id, entrypoint);
      }
    }
  }

  const evidence: EvidenceRef[] = bundle.refs.map((ref) => ({ ...ref }));
  const screens: Record<string, unknown>[] = [];
  const journeys: Journey[] = [];
  const assumptions: Record<string, unknown>[] = [];

  // 1. Every unavailable ref becomes explicit uncertainty, never observation.
  for (const ref of bundle.refs) {
    if (ref.classification !== "unavailable") continue;
    assumptions.push({
      source: "extraction",
      path: "evidence",
      reason: ref.source,
      kind: ref.kind,
      evidenceIds: [ref.id],
      entrypoint: refEntrypoint.get(ref.id) ?? null,
    });
  }

  // 2. Per-entrypoint derivation (screens, baseline journeys) plus the
  //    per-entrypoint honesty records for what could NOT be derived.
  for (const entrypoint of entrypoints) {
    const domTextAll: EvidenceRef[] = [];
    const pageMetaAll: EvidenceRef[] = [];
    const domTexts: EvidenceRef[] = [];
    const pageMetas: EvidenceRef[] = [];
    const ids = linkage?.get(entrypoint);
    if (ids !== undefined) {
      for (const ref of bundle.refs) {
        if (!ids.has(ref.id)) continue;
        if (ref.kind === DOM_TEXT_KIND) {
          domTextAll.push(ref);
          if (ref.classification === "observed") domTexts.push(ref);
        } else if (ref.kind === PAGE_META_KIND) {
          pageMetaAll.push(ref);
          if (ref.classification === "observed") pageMetas.push(ref);
        }
      }
    }

    // Screens: one per observed dom-text/page-meta pair, zipped by bundle order.
    const pairCount = Math.min(domTexts.length, pageMetas.length);
    for (let index = 0; index < pairCount; index += 1) {
      const domText = domTexts[index];
      const pageMeta = pageMetas[index];
      const truncation = TRUNCATION_PATTERN.exec(domText.source);
      screens.push({
        screenId: `screen-${digestOf({
          entrypoint,
          domText: domText.sha256,
          pageMeta: pageMeta.sha256,
        })}`,
        entrypoint,
        url: null,
        title: null,
        textDigest: domText.sha256,
        textChars: truncation === null ? null : Number(truncation[1]),
        truncated: truncation !== null,
        evidenceIds: [domText.id, pageMeta.id],
      });
    }

    // Baseline journey: cites every observed page-evidence ref of the entrypoint.
    if (domTexts.length + pageMetas.length > 0) {
      journeys.push({
        id: `visit:${entrypoint}`,
        name: `visit ${entrypoint}`,
        preconditions: [],
        steps: [
          {
            id: `visit:${entrypoint}:step-1`,
            action: "visit",
            target: entrypoint,
            assertions: { evidenceIds: [...domTexts, ...pageMetas].map((ref) => ref.id) },
          },
        ],
      });
    }

    // Truncation honesty: a truncated observed dom-text is an assumption, never a silent cut.
    for (const ref of domTexts) {
      const truncation = TRUNCATION_PATTERN.exec(ref.source);
      if (truncation === null) continue;
      assumptions.push({
        source: "extraction",
        path: "screens",
        reason: `DOM text for entrypoint "${entrypoint}" was truncated by the observation layer (${truncation[0]}); textDigest covers the truncated text and textChars records the truncation bound`,
        entrypoint,
        evidenceIds: [ref.id],
      });
    }

    // No-screen honesty: the entrypoint lacks an observed pair.
    if (pairCount === 0) {
      assumptions.push({
        source: "extraction",
        path: "screens",
        reason: noDerivationReason(
          entrypoint,
          ids,
          domTextAll,
          pageMetaAll,
          linkage !== undefined,
          "screen",
        ),
        entrypoint,
        evidenceIds: [...domTextAll, ...pageMetaAll].map((ref) => ref.id),
      });
    }

    // No-journey honesty: the entrypoint has no observed page evidence at all.
    if (domTexts.length + pageMetas.length === 0) {
      assumptions.push({
        source: "extraction",
        path: "journeys",
        reason: noDerivationReason(
          entrypoint,
          ids,
          domTextAll,
          pageMetaAll,
          linkage !== undefined,
          "journey",
        ),
        entrypoint,
        evidenceIds: [...domTextAll, ...pageMetaAll].map((ref) => ref.id),
      });
    }
  }

  // 3. Honest emptiness of the regions this wave cannot extract.
  assumptions.push(
    {
      source: "extraction",
      path: "components",
      reason: `components left empty: component extraction requires DOM structure evidence; ${channelNote(
        bundle.refs,
        "dom-structure",
      )}`,
      evidenceIds: idsOfClassification(bundle.refs, "dom-structure", "unavailable"),
    },
    {
      source: "extraction",
      path: "state",
      reason: `state left empty: state extraction requires storage evidence; ${channelNote(
        bundle.refs,
        "storage",
      )}`,
      evidenceIds: idsOfClassification(bundle.refs, "storage", "unavailable"),
    },
    {
      source: "extraction",
      path: "data",
      reason: `data left empty: data extraction requires network and storage evidence; ${channelNote(
        bundle.refs,
        "network",
      )}; ${channelNote(bundle.refs, "storage")}`,
      evidenceIds: [
        ...idsOfClassification(bundle.refs, "network", "unavailable"),
        ...idsOfClassification(bundle.refs, "storage", "unavailable"),
      ],
    },
    {
      source: "extraction",
      path: "api",
      reason: `api left empty: API extraction requires network evidence; ${channelNote(
        bundle.refs,
        "network",
      )}`,
      evidenceIds: idsOfClassification(bundle.refs, "network", "unavailable"),
    },
  );

  // 4. The content-access gap behind null url/title/textChars.
  if (screens.length > 0) {
    assumptions.push({
      source: "extraction",
      path: "screens",
      reason:
        "screen url, title and textChars are recorded as null when not derivable: page content is held in the observation evidence vault and the frozen EvidenceBundle refs carry content digests only, so this wave's extractor cannot read url/title/text values (a contract revision exposing evidence content to extraction is proposed)",
      evidenceIds: [],
    });
  }

  return {
    schemaVersion: IR_SCHEMA_VERSION,
    application: {
      id: `app-${sha256Hex(spec.targetId)}`,
      name: spec.name,
      platform: spec.platform,
      entrypoints: [...spec.entrypoints],
    },
    evidence,
    journeys,
    screens,
    components: [],
    state: {},
    data: {},
    api: {},
    integrations: [],
    assumptions,
    constraints: [],
  };
}

/**
 * Deterministic inventory of an IR's evidence by kind and classification
 * (one row per kind/classification pair actually present, sorted by kind
 * then classification). Feeds the parity dashboards and W2-003.
 */
export function evidenceCoverage(ir: BehavioralIr): EvidenceCoverageEntry[] {
  const refs =
    typeof ir === "object" && ir !== null && Array.isArray(ir.evidence) ? ir.evidence : [];
  const rows = new Map<string, EvidenceCoverageEntry>();
  for (const ref of refs) {
    if (typeof ref !== "object" || ref === null) continue;
    const kind = typeof ref.kind === "string" && ref.kind !== "" ? ref.kind : "unknown";
    const rawClassification = String(ref.classification);
    const classification = (
      rawClassification !== "" ? rawClassification : "unknown"
    ) as EvidenceClassification;
    const row = rows.get(`${kind}\u0000${classification}`);
    if (row === undefined) {
      rows.set(`${kind}\u0000${classification}`, { kind, count: 1, classification });
    } else {
      row.count += 1;
    }
  }
  return [...rows.values()].sort(
    (left, right) =>
      compareStrings(left.kind, right.kind) ||
      compareStrings(left.classification, right.classification),
  );
}

/** sha256 over the canonical JSON of a value (content-defined identity). */
function digestOf(value: unknown): string {
  return sha256Hex(canonicalJson(value) ?? "null");
}

/** First-occurrence dedupe of the entrypoint list (journey ids must stay unique). */
function dedupeEntrypoints(entrypoints: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const entrypoint of entrypoints) {
    if (seen.has(entrypoint)) continue;
    seen.add(entrypoint);
    unique.push(entrypoint);
  }
  return unique;
}

/** Classification summary of one kind's refs: "observed", the first ref's classification, or "absent". */
function refStatus(refs: EvidenceRef[]): string {
  if (refs.some((ref) => ref.classification === "observed")) return "observed";
  return refs.length > 0 ? String(refs[0].classification) : "absent";
}

/** Honest per-kind explanation for an empty extraction region. */
function channelNote(refs: EvidenceRef[], kind: string): string {
  const ofKind = refs.filter((ref) => ref.kind === kind);
  if (ofKind.some((ref) => ref.classification === "observed")) {
    return `observed "${kind}" evidence is present, but extraction from it is not implemented in this wave`;
  }
  const unavailable = ofKind.find((ref) => ref.classification === "unavailable");
  if (unavailable !== undefined) {
    return `the "${kind}" channel is unavailable in this bundle ("${unavailable.source}")`;
  }
  if (ofKind.length > 0) {
    return `the "${kind}" refs in this bundle are classified "${ofKind[0].classification}", and extraction from them is not implemented in this wave`;
  }
  return `the bundle carries no "${kind}" evidence at all`;
}

/** Ids of one kind's refs carrying a classification. */
function idsOfClassification(refs: EvidenceRef[], kind: string, classification: string): string[] {
  return refs
    .filter((ref) => ref.kind === kind && ref.classification === classification)
    .map((ref) => ref.id);
}

/**
 * The reason an entrypoint produced no screen (or no baseline journey):
 * names the entrypoint, whether attribution was available, and the
 * classification state of the two page-evidence kinds.
 */
function noDerivationReason(
  entrypoint: string,
  ids: Set<string> | undefined,
  domTextAll: EvidenceRef[],
  pageMetaAll: EvidenceRef[],
  hasLinkage: boolean,
  subject: "screen" | "journey",
): string {
  if (ids === undefined) {
    return hasLinkage
      ? `no ${subject} derived for entrypoint "${entrypoint}": the bundle records no evidence refs for this entrypoint (aborted or partial capture)`
      : `no ${subject} derived for entrypoint "${entrypoint}": the bundle's environment fingerprint does not carry entrypoint ref attribution (entrypointRefs), so refs cannot be attributed to entrypoints`;
  }
  const domStatus = refStatus(domTextAll);
  const metaStatus = refStatus(pageMetaAll);
  return subject === "screen"
    ? `no screen derived for entrypoint "${entrypoint}": no observed dom-text/page-meta pair (dom-text: ${domStatus}; page-meta: ${metaStatus})`
    : `no baseline journey derived for entrypoint "${entrypoint}": no observed page-meta/dom-text evidence (dom-text: ${domStatus}; page-meta: ${metaStatus})`;
}

/**
 * Reads the W1-002 environment fingerprint's entrypoint ref attribution
 * (entrypoint -> ref ids). Returns undefined when the fingerprint is absent
 * or malformed; malformed per-entrypoint values are skipped defensively.
 */
function readEntrypointLinkage(bundle: EvidenceBundle): Map<string, Set<string>> | undefined {
  if (!isPlainObject(bundle.environment)) return undefined;
  const raw = bundle.environment.entrypointRefs;
  if (!isPlainObject(raw)) return undefined;
  const linkage = new Map<string, Set<string>>();
  for (const entrypoint of Object.keys(raw)) {
    const ids = raw[entrypoint];
    if (!Array.isArray(ids)) continue;
    if (!ids.every((id) => typeof id === "string")) continue;
    linkage.set(entrypoint, new Set(ids as string[]));
  }
  return linkage;
}

/** Fail-closed structural guards over the bundle (precise TypeError, never a silent crash). */
function requireBundle(bundle: EvidenceBundle): void {
  if (typeof bundle !== "object" || bundle === null || Array.isArray(bundle)) {
    throw new TypeError("extractBehavioralIr requires an EvidenceBundle object");
  }
  if (!Array.isArray(bundle.refs)) {
    throw new TypeError(
      "extractBehavioralIr requires bundle.refs to be an array of EvidenceRef objects",
    );
  }
  for (const ref of bundle.refs) {
    if (typeof ref !== "object" || ref === null || Array.isArray(ref)) {
      throw new TypeError(
        "extractBehavioralIr requires every bundle.refs entry to be an EvidenceRef object",
      );
    }
    if (typeof ref.id !== "string" || ref.id === "") {
      throw new TypeError(
        "extractBehavioralIr requires every evidence ref to carry a non-empty string id",
      );
    }
    if (typeof ref.kind !== "string" || ref.kind === "") {
      throw new TypeError(
        "extractBehavioralIr requires every evidence ref to carry a non-empty string kind",
      );
    }
  }
}

/** Fail-closed structural guards over the spec (the fields the IR copies verbatim). */
function requireSpec(spec: ReconstructionSpec): void {
  if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
    throw new TypeError("extractBehavioralIr requires a ReconstructionSpec object");
  }
  for (const field of ["specVersion", "reconstructionId", "targetId", "name"] as const) {
    const value = spec[field];
    if (typeof value !== "string" || value.trim() === "") {
      throw new TypeError(`extractBehavioralIr requires spec.${field} to be a non-empty string`);
    }
  }
  if (!PLATFORMS.has(spec.platform)) {
    throw new TypeError(
      `extractBehavioralIr requires spec.platform to be one of ${[...PLATFORMS].join(", ")}; received ${JSON.stringify(
        spec.platform,
      )}`,
    );
  }
  if (!Array.isArray(spec.entrypoints)) {
    throw new TypeError(
      "extractBehavioralIr requires spec.entrypoints to be an array of entrypoint strings",
    );
  }
  for (const entrypoint of spec.entrypoints) {
    if (typeof entrypoint !== "string" || entrypoint.trim() === "") {
      throw new TypeError(
        "extractBehavioralIr requires spec.entrypoints entries to be non-empty strings",
      );
    }
  }
}
