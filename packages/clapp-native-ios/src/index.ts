/**
 * @clapp/native-ios — the iOS native adapter (ADR-004, lane 5 of 5).
 *
 * The roadmap's final ⬜ block — native adapters for Android, Linux, Windows,
 * macOS, iOS — lands five new packages, one per platform. This is the iOS
 * lane. Each adapter implements the SAME five-component v0.1 contract,
 * consumed through `@clapp/contracts` only. No adapter imports
 * `@clapp/intelligence`, `@clapp/synthesis`, `@clapp/runtime-openmuse`, or
 * any `apps/**` module — the no-fork law (ADR-002), pinned by an
 * import-discipline test in this package.
 *
 * The five components (per platform):
 *   1. Environment descriptor — `src/environment.ts`
 *   2. Observation adapter   — `src/observation.ts`
 *   3. Evidence emitter      — `src/evidence.ts`
 *   4. Synthesis target      — `src/synthesis-target.ts`
 *   5. Verification adapter  — `src/verification.ts`
 *
 * Hard rules (binding): fail-closed everywhere (malformed input → a typed
 * named error; nothing partial, nothing defaulted, nothing fabricated);
 * duck-typed host seams (adapters bind untyped host handles through narrow
 * structural interfaces validated at bind time); no production host bound
 * in-repo (composition is a later TL wave); determinism (pure functions over
 * caller-supplied facts; ids content-addressed; no wall-clock, no
 * randomness, no network).
 *
 * Native reconstruction (observe→IR→synthesis→parity on a native target)
 * remains a future composition wave; this adapter lands the frozen
 * per-platform seam it will compose.
 */

// Deterministic content addressing (in-package, path-neutral pure code).
export { canonicalJson, canonicalJsonBytes, sha256Hex, utf8 } from "./canonical.ts";
// Component 1 — Environment descriptor (frozen iOS v0.1 vocabulary).
export type {
  IosEnvironment,
  IosPackaging,
  IosUiTestFramework,
} from "./environment.ts";
export {
  CLAPP_NATIVE_IOS_ENVIRONMENT_VERSION,
  IOS_PACKAGING_FORMATS,
  IOS_UI_TEST_FRAMEWORKS,
  isNoneIosEnvironment,
  validateIosEnvironment,
} from "./environment.ts";
// Typed errors (fail-closed everywhere).
export { ClappNativeIosError, describeShape } from "./errors.ts";

// Component 3 — Evidence emitter (EvidenceRef-shape, idev_ prefix).
export type { IosEvidenceManifest, IosEvidenceManifestInputs } from "./evidence.ts";
export {
  IOS_EVIDENCE_ID_PREFIX,
  iosEvidenceId,
  iosEvidenceRef,
  iosEvidenceRefForText,
  isIosEvidenceId,
} from "./evidence.ts";
// Component 2 — Observation adapter (duck-typed host seam, MEASURED snapshot).
export type {
  IosElementTreeNode,
  IosObservationAdapter,
  IosObservationDependencies,
  IosObservationHostSeam,
  IosObservationResult,
  IosObservationSnapshot,
} from "./observation.ts";
export {
  bindIosObservationSeam,
  createIosObservationAdapter,
} from "./observation.ts";
// Component 4 — Synthesis target (frozen packaging vocabulary, sorted/deduped).
export type { IosSynthesisTarget } from "./synthesis-target.ts";
export {
  CLAPP_NATIVE_IOS_TARGET_VERSION,
  isIosPackaging,
  validateIosSynthesisTarget,
} from "./synthesis-target.ts";
// Component 5 — Verification adapter (duck-typed runner, MEASURED, VERBATIM).
export type {
  IosVerificationAdapter,
  IosVerificationHostSeam,
  IosVerificationResult,
} from "./verification.ts";
export {
  bindIosVerificationSeam,
  createIosVerificationAdapter,
} from "./verification.ts";
