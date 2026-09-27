/**
 * @clapp/observation — the dedicated browser observation layer for CLAPP.
 *
 * Captures the five declared observation channels (dom, a11y, screenshot,
 * network, storage) for every entrypoint of a web ReconstructionSpec into a
 * deterministic, content-addressed EvidenceBundle. Channels the existing
 * browser worker cannot produce are represented in every bundle as
 * EvidenceClassification "unavailable" with a precise source note — never
 * fabricated (honesty rule, ARCHITECTURE.md section 6).
 *
 * The package is framework-neutral and self-contained: it binds an untyped
 * browser handle (e.g. the OpenMuse BrowserService) through the narrow
 * structural BrowserSessionSeam interface declared here, validated at bind
 * time with typed fail-closed errors. It never imports OpenMuse app/server
 * modules; the Wave 1 runtime adapter's minimal observation bridge remains
 * untouched, and a later TL wave composes this adapter in as the observation
 * provider.
 */

// Adapter and dependencies.
export type {
  BrowserObservationAdapter,
  ObservationDependencies,
  PartialObservationResult,
} from "./adapter.ts";
export { createBrowserObservationAdapter, OBSERVATION_ADAPTER_VERSION } from "./adapter.ts";
// Deterministic content addressing.
export { canonicalJson, canonicalJsonBytes, sha256Hex, utf8 } from "./canonical.ts";
// Channel registry.
export type { ObservationChannelDescriptor, ObservationChannelName } from "./channels.ts";
export {
  channelOfKind,
  OBSERVATION_CHANNEL_NAMES,
  OBSERVATION_CHANNELS,
  PAGE_TEXT_LIMIT,
  sourceNoteForKind,
} from "./channels.ts";
// Typed errors.
export {
  ClappObservationAbortError,
  ClappObservationError,
  describeError,
  describeShape,
} from "./errors.ts";
export type { RedactionMarkerDocument } from "./markers.ts";
export { redactionMarkerDocument, redactionMarkerPayload } from "./markers.ts";
// Redaction.
export type { RedactionRecord, RedactionResult, RedactionRules } from "./redact.ts";
export { redact } from "./redact.ts";
// Structural browser seam (duck-typed at bind time).
export type { BrowserSessionSeam, PageSnapshot, ScreenshotResponse, SeamOutcome } from "./seam.ts";
export { bindBrowserSeam, validatePageSnapshot, validateSessionResult } from "./seam.ts";
