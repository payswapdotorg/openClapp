/**
 * The channel registry — the honest capability map of the observation layer
 * against the EXISTING browser worker.
 *
 * CLAPP declares five observation channels (dom, a11y, screenshot, network,
 * storage). Every EvidenceBundle this adapter produces represents all five.
 * The existing OpenMuse browser worker can genuinely produce:
 *   - the page text snapshot (innerText, <=100k chars, truncation flag);
 *   - the page metadata (url/title);
 *   - a PNG screenshot.
 * It CANNOT produce DOM structure, an a11y tree, network capture, or storage
 * state export. Channels the worker cannot produce appear in every bundle as
 * EvidenceClassification "unavailable" with the precise source note recorded
 * here — never fabricated (honesty rule, ARCHITECTURE.md section 6).
 *
 * The `dom` channel splits into three evidence kinds against the existing
 * worker: `dom-text` and `page-meta` are observed; `dom-structure` is
 * unavailable because read() returns innerText only. The registry therefore
 * carries one descriptor per evidence kind, grouped under the five channel
 * names, so downstream consumers (W2-002 evidence-to-IR) can rely on
 * kind-level exactness.
 */

/** The five contract-level observation channels every EvidenceBundle represents. */
export type ObservationChannelName = "dom" | "a11y" | "screenshot" | "network" | "storage";

/** Availability of one evidence kind against the existing browser worker. */
export interface ObservationChannelDescriptor {
  /** The contract channel this descriptor reports on. */
  readonly channel: ObservationChannelName;
  /** The EvidenceRef.kind this descriptor governs. */
  readonly kind: string;
  /** Whether the existing browser worker can genuinely produce this evidence. */
  readonly available: boolean;
  /** Precise statement of what the worker does, or lacks, for this channel. */
  readonly sourceNote: string;
}

const SOURCE_NOTES = {
  domText: "browser-worker read() innerText snapshot",
  pageMeta: "browser-worker read() url+title",
  domStructure:
    "browser-worker lacks a DOM structure snapshot endpoint; read() returns innerText only",
  a11y: "browser-worker lacks an a11y snapshot endpoint",
  screenshot: "browser-worker screenshot() png",
  network:
    "browser-worker lacks a network capture endpoint; egress flows through its proxy without an observation surface",
  storage:
    "browser-worker lacks a storage state export endpoint; storageState is persisted internally per session",
} as const;

const descriptor = (
  channel: ObservationChannelName,
  kind: string,
  available: boolean,
  sourceNote: string,
): ObservationChannelDescriptor => Object.freeze({ channel, kind, available, sourceNote });

/**
 * Frozen registry of every evidence kind the observation layer can emit.
 * Availability is a fact about the EXISTING browser worker; a particular seam
 * binding may still lack the screenshot capability (no preview method), in
 * which case the produced ref is classified unavailable with a binding-level
 * reason while this registry continues to describe the worker itself.
 */
export const OBSERVATION_CHANNELS: readonly ObservationChannelDescriptor[] = Object.freeze([
  descriptor("dom", "dom-text", true, SOURCE_NOTES.domText),
  descriptor("dom", "page-meta", true, SOURCE_NOTES.pageMeta),
  descriptor("dom", "dom-structure", false, SOURCE_NOTES.domStructure),
  descriptor("a11y", "a11y", false, SOURCE_NOTES.a11y),
  descriptor("screenshot", "screenshot", true, SOURCE_NOTES.screenshot),
  descriptor("network", "network", false, SOURCE_NOTES.network),
  descriptor("storage", "storage", false, SOURCE_NOTES.storage),
]);

/** The five declared channel names, in registry order. */
export const OBSERVATION_CHANNEL_NAMES: readonly ObservationChannelName[] = Object.freeze([
  ...new Set(OBSERVATION_CHANNELS.map((item) => item.channel)),
]);

/** Looks up the declared source note for an evidence kind (worker-level truth). */
export function sourceNoteForKind(kind: string): string {
  const found = OBSERVATION_CHANNELS.find((item) => item.kind === kind);
  return (
    found?.sourceNote ?? `unknown evidence kind "${kind}"; no registered browser-worker capability`
  );
}

/** Maps an evidence kind to its declared channel; "unknown" for foreign bundles. */
export function channelOfKind(kind: string): string {
  return OBSERVATION_CHANNELS.find((item) => item.kind === kind)?.channel ?? "unknown";
}

/** The innerText cap enforced by the browser worker's read(); reported in sources when truncation occurred. */
export const PAGE_TEXT_LIMIT = 100_000;
