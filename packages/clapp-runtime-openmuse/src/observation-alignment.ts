import { createHash } from "node:crypto";
import type { EvidenceClassification, EvidenceRef, ReconstructionSpec } from "@clapp/contracts";

/**
 * The page snapshot the aligned refs derive from — the structural subset of
 * `ClappBrowserPage` (and the W1-002 `read()` payload) the alignment reads:
 * `url`/`title`/`text`/`truncated`. Declared here (rather than importing
 * `ClappBrowserPage`) so the alignment is parametric over any page snapshot
 * carrying these four fields, and so this module stays free of the handles
 * dependency for the pure derivation helpers.
 */
export interface AlignedPageSnapshot {
  url: string;
  title: string;
  text: string;
  truncated: boolean;
}

/**
 * CLAPP-W3-017 — the observation channel alignment.
 *
 * The runtime's W1-001-era observation provider emitted `page-text`/`screenshot`
 * channel names, while the W2-002 extraction consumes the W1-002
 * `dom-text`/`page-meta` vocabulary — so a production capture (over a handle
 * that exposes the W1-002 browser-session seam) yielded the honest SPARSE
 * model: zero screens, zero journeys, per-entrypoint no-attribution
 * assumptions. This module closes that seam.
 *
 * The aligned emission activates exactly when the bound browserSession handle
 * ALSO provides the W1-002 browser-session seam (`create`/`navigate`/`read` —
 * the production BrowserService exposes them alongside `observe`; an
 * observe-only shim does not). The aligned refs are derived from the SAME
 * `handle.observe()` page snapshot the legacy `page-text` ref came from
 * (`ClappBrowserPage` already carries `url`/`title`/`text`/`truncated` — the
 * W1-002 `read()` payload): no second navigation, no fabrication, frozen
 * consumers unchanged.
 *
 * Vocabulary fidelity: the aligned refs mirror the W1-002 adapter's own
 * discipline — payload bytes `utf8(text)` / `canonical{url,title}`, registry
 * source notes (with the truncation suffix, the only place the extraction
 * parses it), and the adapter's capture-position id scheme — so an aligned ref
 * is id- and digest-identical to the W1-002 ref the same capture would mint.
 *
 * The vocabulary is mirrored as LITERALS here (the registry source notes, the
 * canonical-JSON helpers, the capture-position id scheme) rather than imported
 * from `@clapp/observation`: that package is frozen for this lane and is
 * consumed verbatim. The three literal mirror sites (the registry, the frozen
 * W2-002 test, and this runtime mirror) are the cross-lane proposal recorded
 * in the worklog.
 */

// ---------------------------------------------------------------------------
// The vocabulary mirror — literals of the W1-002 registry's source notes.
// (Mirrors packages/clapp-observation/src/channels.ts SOURCE_NOTES verbatim.)
// ---------------------------------------------------------------------------

/** The page-text snapshot source note (dom-text observed). */
export const SOURCE_NOTE_DOM_TEXT = "browser-worker read() innerText snapshot";
/** The page metadata source note (page-meta observed). */
export const SOURCE_NOTE_PAGE_META = "browser-worker read() url+title";
/** The screenshot source note (screenshot observed). */
export const SOURCE_NOTE_SCREENSHOT = "browser-worker screenshot() png";
/** The DOM-structure source note (no runtime source). */
export const SOURCE_NOTE_DOM_STRUCTURE =
  "browser-worker lacks a DOM structure snapshot endpoint; read() returns innerText only";
/** The a11y source note (no runtime source). */
export const SOURCE_NOTE_A11Y = "browser-worker lacks an a11y snapshot endpoint";
/** The network source note (no runtime source). */
export const SOURCE_NOTE_NETWORK =
  "browser-worker lacks a network capture endpoint; egress flows through its proxy without an observation surface";
/** The storage source note (no runtime source). */
export const SOURCE_NOTE_STORAGE =
  "browser-worker lacks a storage state export endpoint; storageState is persisted internally per session";

/** The innerText cap enforced by the browser worker's read() (mirrors PAGE_TEXT_LIMIT). */
export const PAGE_TEXT_LIMIT = 100_000;

/** The registry source note for an evidence kind (worker-level truth). */
export function sourceNoteForKind(kind: string): string {
  switch (kind) {
    case "dom-text":
      return SOURCE_NOTE_DOM_TEXT;
    case "page-meta":
      return SOURCE_NOTE_PAGE_META;
    case "dom-structure":
      return SOURCE_NOTE_DOM_STRUCTURE;
    case "a11y":
      return SOURCE_NOTE_A11Y;
    case "screenshot":
      return SOURCE_NOTE_SCREENSHOT;
    case "network":
      return SOURCE_NOTE_NETWORK;
    case "storage":
      return SOURCE_NOTE_STORAGE;
    default:
      return `unknown evidence kind "${kind}"; no registered browser-worker capability`;
  }
}

/**
 * The four W1-002 kinds with no runtime source. The runtime provider discloses
 * them in the bundle environment (channelAlignment.noRuntimeSourceKinds)
 * rather than fabricating them as unavailable refs — the production capture's
 * aligned vocabulary carries only the kinds the `handle.observe()` snapshot
 * can honestly derive (dom-text, page-meta) plus the legacy kinds (page-text,
 * screenshot). The extraction records these gaps as assumptions citing empty
 * evidenceIds over the runtime path (both paths record the assumption
 * honestly).
 */
export const NO_RUNTIME_SOURCE_KINDS = ["dom-structure", "a11y", "network", "storage"] as const;

/** The aligned vocabulary the runtime's aligned bundle carries (both vocabularies). */
export const ALIGNED_CHANNEL_KINDS = ["page-text", "screenshot", "dom-text", "page-meta"] as const;

// ---------------------------------------------------------------------------
// The canonical-JSON / content-addressing helpers (mirrors
// packages/clapp-observation/src/canonical.ts — reproduced as literals so the
// runtime package never imports the frozen observation package).
// ---------------------------------------------------------------------------

/** sha256 hex digest over bytes or text (text digests as UTF-8). */
const sha256Hex = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");

/** Encodes text as UTF-8 bytes. */
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

/**
 * Canonical JSON serialization: object keys sorted recursively, arrays kept in
 * order, no whitespace. Two structurally equal values always serialize to
 * identical bytes regardless of construction order. `undefined` normalizes to
 * `null` so optional fields cannot destabilize digests.
 */
function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Canonical JSON encoded as UTF-8 bytes — the standard evidence payload form. */
const canonicalJsonBytes = (value: unknown): Uint8Array => utf8(canonicalJson(value));

// ---------------------------------------------------------------------------
// The capability gate — the W1-002 browser-session seam.
// ---------------------------------------------------------------------------

/**
 * The three capabilities that make up the W1-002 browser-session seam. The
 * production BrowserService exposes them alongside `observe`; an observe-only
 * shim does not. Their presence is the capability marker that activates the
 * aligned emission: the gate is a fact about the bound handle, never a
 * behavior change the W1-001 observe-only pin (which asserts every observed
 * ref from an observe-only handle is `page-text`) could trip.
 */
const BROWSER_SESSION_SEAM_CAPABILITIES = ["create", "navigate", "read"] as const;

/**
 * Returns true when the bound browserSession handle also provides the W1-002
 * browser-session seam (`create`/`navigate`/`read`). This is the capability
 * marker that activates the aligned emission: the aligned refs derive from the
 * same `handle.observe()` snapshot the legacy page-text ref came from, so no
 * second navigation occurs and no fabrication is introduced — the seam's
 * presence merely licenses the W1-002 vocabulary for the same capture.
 */
export function hasBrowserSessionSeam(handle: unknown): boolean {
  if (typeof handle !== "object" || handle === null) return false;
  const record = handle as Record<string, unknown>;
  return BROWSER_SESSION_SEAM_CAPABILITIES.every(
    (capability) => typeof record[capability] === "function",
  );
}

// ---------------------------------------------------------------------------
// The mapping totality — the explicit legacy-to-aligned channel mapping.
// ---------------------------------------------------------------------------

/** One row of the total legacy-to-aligned channel mapping. */
export interface AlignmentMapping {
  /** The legacy (runtime) channel kind this row maps. */
  readonly sourceKind: string;
  /** The aligned W1-002 kinds this source kind maps to (empty when unmapped). */
  readonly alignedKinds: readonly string[];
  /** True when the legacy ref IS the aligned ref (no transformation). */
  readonly identity: boolean;
}

/**
 * The frozen total mapping. `page-text` maps to the W1-002 `dom-text` +
 * `page-meta` pair (the page snapshot's text and metadata); `screenshot` maps
 * to `screenshot` as the identity (the legacy screenshot ref IS the aligned
 * screenshot ref — no duplication, no second capture). Every other kind is
 * foreign and returns an explicit unmapped row (never silently dropped).
 */
const ALIGNMENT_MAPPING: Readonly<Record<string, AlignmentMapping>> = Object.freeze({
  "page-text": Object.freeze({
    sourceKind: "page-text",
    alignedKinds: Object.freeze(["dom-text", "page-meta"]),
    identity: false,
  }),
  screenshot: Object.freeze({
    sourceKind: "screenshot",
    alignedKinds: Object.freeze(["screenshot"]),
    identity: true,
  }),
});

/** The legacy channel kinds the runtime emits (the mapping's domain). */
const LEGACY_SOURCE_KINDS = Object.freeze(["page-text", "screenshot"]);

/**
 * Looks up the total mapping for a legacy channel kind. Foreign kinds (anything
 * not `page-text` or `screenshot`) return an unmapped row: an empty
 * `alignedKinds` array and `identity: false`, so foreign channels surface in
 * the bundle environment's `channelAlignment.unmapped` scan rather than being
 * silently dropped or invented.
 */
export function alignmentForKind(sourceKind: string): AlignmentMapping {
  const found = ALIGNMENT_MAPPING[sourceKind];
  if (found !== undefined) return found;
  return Object.freeze({
    sourceKind,
    alignedKinds: Object.freeze([]),
    identity: false,
  });
}

/** True when the kind is part of the aligned vocabulary the aligned bundle carries. */
function isAlignedVocabularyKind(kind: string): boolean {
  return (ALIGNED_CHANNEL_KINDS as readonly string[]).includes(kind);
}

// ---------------------------------------------------------------------------
// The aligned ref builders — mirror the W1-002 adapter's refFor / unavailableRef.
// ---------------------------------------------------------------------------

/**
 * Capture-position ref id: `sha256(canonical{entrypoint, kind,
 * reconstructionId, targetId})`. Identical to the W1-002 adapter's id scheme,
 * so an aligned ref is id-identical to the W1-002 ref the same capture would
 * mint (stable under redaction: the id never depends on payload bytes).
 */
function alignedRefId(spec: ReconstructionSpec, entrypoint: string, kind: string): string {
  return sha256Hex(
    canonicalJsonBytes({
      entrypoint,
      kind,
      reconstructionId: spec.reconstructionId,
      targetId: spec.targetId,
    }),
  );
}

/** Builds a complete aligned EvidenceRef over payload bytes (content-addressed). */
function refFor(
  spec: ReconstructionSpec,
  entrypoint: string,
  kind: string,
  payload: Uint8Array,
  classification: EvidenceClassification,
  source: string,
  capturedAt: string,
): EvidenceRef {
  return {
    id: alignedRefId(spec, entrypoint, kind),
    targetId: spec.targetId,
    reconstructionId: spec.reconstructionId,
    kind,
    sha256: sha256Hex(payload),
    source,
    capturedAt,
    classification,
    redacted: false,
  };
}

/** An unavailable aligned ref whose manifest payload records the precise reason. */
function unavailableRef(
  spec: ReconstructionSpec,
  entrypoint: string,
  kind: string,
  reason: string,
  capturedAt: string,
): EvidenceRef {
  return refFor(
    spec,
    entrypoint,
    kind,
    canonicalJsonBytes({ entrypoint, kind, reason }),
    "unavailable",
    sourceNoteForKind(kind),
    capturedAt,
  );
}

/** The aligned page-evidence pair (dom-text + page-meta) for one entrypoint. */
export interface AlignedPageEvidence {
  readonly domText: EvidenceRef;
  readonly pageMeta: EvidenceRef;
}

/**
 * Derives the OBSERVED aligned page-evidence pair (dom-text + page-meta) from
 * the same `handle.observe()` page snapshot the legacy `page-text` ref came
 * from. The dom-text payload is `utf8(text)` (the W1-002 discipline — NOT
 * `title\ntext` like the legacy page-text ref); the page-meta payload is
 * `canonical{url, title}`. The dom-text source carries the truncation suffix
 * when the snapshot was cut (the only place the extraction parses it). The
 * refs are id- and digest-identical to the W1-002 adapter's refs for the same
 * capture (capture-position id, content digest, registry source note).
 */
export function alignPageEvidence(
  spec: ReconstructionSpec,
  entrypoint: string,
  page: AlignedPageSnapshot,
  capturedAt: string,
): AlignedPageEvidence {
  const domTextSource = page.truncated
    ? `${SOURCE_NOTE_DOM_TEXT} (truncated at ${PAGE_TEXT_LIMIT} characters)`
    : SOURCE_NOTE_DOM_TEXT;
  return {
    domText: refFor(
      spec,
      entrypoint,
      "dom-text",
      utf8(page.text),
      "observed",
      domTextSource,
      capturedAt,
    ),
    pageMeta: refFor(
      spec,
      entrypoint,
      "page-meta",
      canonicalJsonBytes({ url: page.url, title: page.title }),
      "observed",
      SOURCE_NOTE_PAGE_META,
      capturedAt,
    ),
  };
}

/**
 * Emits the honest UNAVAILABLE aligned page-evidence pair (dom-text +
 * page-meta) when `handle.observe()` could not capture the entrypoint. The
 * reason (the observe failure) is recorded in the payload; the registry source
 * note is the ref source — identical discipline to the W1-002 adapter's
 * unavailable refs. Never fabricated, never silently dropped.
 */
export function alignUnavailablePageEvidence(
  spec: ReconstructionSpec,
  entrypoint: string,
  reason: string,
  capturedAt: string,
): AlignedPageEvidence {
  return {
    domText: unavailableRef(spec, entrypoint, "dom-text", reason, capturedAt),
    pageMeta: unavailableRef(spec, entrypoint, "page-meta", reason, capturedAt),
  };
}

// ---------------------------------------------------------------------------
// The channelAlignment environment record.
// ---------------------------------------------------------------------------

/** One foreign (unmapped) kind found among the bundle's refs. */
export interface UnmappedChannel {
  readonly kind: string;
  readonly count: number;
}

/** One W1-002 kind with no runtime source (disclosed, not fabricated as a ref). */
export interface NoRuntimeSourceKind {
  readonly kind: string;
  readonly sourceNote: string;
}

/**
 * The channelAlignment record carried in the aligned bundle's environment. The
 * mapping is the total legacy-to-aligned mapping (explicit); the unmapped scan
 * surfaces any foreign kinds found among the bundle's refs (never silently
 * dropped); the noRuntimeSourceKinds disclose the four W1-002 kinds the
 * runtime cannot produce (dom-structure/a11y/network/storage) so the
 * extraction's assumptions cite the honest gap rather than invented refs.
 */
export interface ChannelAlignmentRecord {
  /** True when the aligned emission activated (the bound handle provides the seam). */
  readonly aligned: boolean;
  /** The total legacy-to-aligned channel mapping. */
  readonly mapping: readonly AlignmentMapping[];
  /** Foreign (unmapped) kinds found among the bundle's refs. */
  readonly unmapped: readonly UnmappedChannel[];
  /** The W1-002 kinds the runtime cannot produce (disclosed, not fabricated). */
  readonly noRuntimeSourceKinds: readonly NoRuntimeSourceKind[];
}

/** The frozen no-runtime-source disclosure (the four W1-002 kinds). */
const NO_RUNTIME_SOURCE_DISCLOSURE: readonly NoRuntimeSourceKind[] = Object.freeze(
  NO_RUNTIME_SOURCE_KINDS.map((kind) =>
    Object.freeze({ kind, sourceNote: sourceNoteForKind(kind) }),
  ),
);

/** The frozen total mapping rows (page-text, screenshot). */
const ALIGNMENT_MAPPING_ROWS: readonly AlignmentMapping[] = Object.freeze(
  LEGACY_SOURCE_KINDS.map((kind) => alignmentForKind(kind)),
);

/**
 * Builds the channelAlignment record for a bundle's refs. The mapping is the
 * fixed total mapping; the unmapped scan reports any ref kind not in the
 * aligned vocabulary (page-text/screenshot/dom-text/page-meta) — foreign
 * channels surface here rather than being silently dropped; the
 * noRuntimeSourceKinds disclosure is constant.
 */
export function buildChannelAlignment(
  refs: readonly EvidenceRef[],
  aligned: boolean,
): ChannelAlignmentRecord {
  const counts = new Map<string, number>();
  for (const ref of refs) {
    if (typeof ref?.kind !== "string") continue;
    if (isAlignedVocabularyKind(ref.kind)) continue;
    counts.set(ref.kind, (counts.get(ref.kind) ?? 0) + 1);
  }
  const unmapped: UnmappedChannel[] = [...counts.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
  return {
    aligned,
    mapping: ALIGNMENT_MAPPING_ROWS,
    unmapped,
    noRuntimeSourceKinds: NO_RUNTIME_SOURCE_DISCLOSURE,
  };
}
