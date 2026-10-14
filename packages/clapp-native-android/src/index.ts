/**
 * @clapp/native-android — public API (ADR-004, the Android native adapter).
 *
 * One of the five native platform adapters ADR-004 freezes (Android, Linux,
 * Windows, macOS, iOS), each implementing the SAME five-component v0.1
 * contract, consumed through `@clapp/contracts` only:
 *   1. the environment descriptor  (src/environment.ts)
 *   2. the observation adapter     (src/observation.ts — the host seam)
 *   3. the evidence emitter        (src/evidence.ts)
 *   4. the synthesis target        (src/synthesis-target.ts)
 *   5. the verification adapter    (src/verification.ts — the host seam)
 *
 * THE NO-FORK LAW (ADR-004, binding): this package CONSUMES the frozen
 * `@clapp/contracts` (TYPE-ONLY — EvidenceRef/EvidenceClassification) and
 * produces contract-shaped DATA — it never redefines, rewrites, or forks
 * any contract type. It imports NO sibling `@clapp/*` package (never
 * `@clapp/intelligence`, `@clapp/synthesis`, `@clapp/runtime-openmuse`,
 * `@clapp/observation`) and no `apps/**` module. The only node builtin it
 * touches is `node:crypto` (the path-neutral pure sha256 primitive —
 * disclosed in the import-discipline test). The import-discipline test in
 * tests/clapp-native-android.test.ts pins all of this (the readdirSync/
 * src-list pin style).
 *
 * The host seams (AndroidObservationHost, AndroidVerificationHost) are
 * duck-typed: everything environment-specific enters through them, the
 * tests fake them, and real adb/uiautomator/instrumentation/emulator
 * bindings are deployment scope — the CONTRACTS are this lane's deliverable
 * (no production host is bound in-repo; composition is a later TL wave).
 *
 * Contract version (frozen at landing, ADR-004):
 *   - CLAPP_NATIVE_ANDROID_ENVIRONMENT_VERSION = "0.1" (component 1)
 *   - CLAPP_NATIVE_ANDROID_TARGET_VERSION = "0.1" (component 4)
 *
 * Sibling packages must import `@clapp/native-android` and never reach into
 * deeper paths. Linux/Windows/macOS/iOS are the parallel lanes of the same
 * five-component freeze.
 */

export type { AndroidEnvironment, AndroidEnvironmentValidation } from "./environment.ts";
// ---- the environment descriptor (component 1) ---------------------------------------
export {
  ANDROID_PACKAGING_FORMATS,
  ANDROID_UI_TEST_FRAMEWORKS,
  CLAPP_NATIVE_ANDROID_ENVIRONMENT_VERSION,
  validateAndroidEnvironment,
} from "./environment.ts";
// ---- the typed error (raised only at bind time, the ADR-004 hard rule) --------------
export { ClappNativeAndroidError } from "./errors.ts";
export type { AndroidEvidenceContext, ObservationEvidenceResult } from "./evidence.ts";

// ---- the evidence emitter (component 3) --------------------------------------------
export {
  ANDROID_EVIDENCE_CLASSIFICATION,
  ANDROID_EVIDENCE_ID_PREFIX,
  emitObservationEvidence,
} from "./evidence.ts";
export type {
  AndroidElementNode,
  AndroidObservation,
  AndroidObservationHost,
  AndroidObservationResult,
} from "./observation.ts";
// ---- the observation adapter — the host seam (component 2) -------------------------
export { bindAndroidObservationHost, observeAndroidScreen } from "./observation.ts";
export type {
  AndroidSynthesisTarget,
  AndroidSynthesisTargetValidation,
} from "./synthesis-target.ts";
// ---- the synthesis target (component 4) --------------------------------------------
export {
  CLAPP_NATIVE_ANDROID_TARGET_VERSION,
  validateAndroidSynthesisTarget,
} from "./synthesis-target.ts";
export type {
  AndroidVerificationHost,
  AndroidVerificationResult,
  AndroidVerificationRun,
} from "./verification.ts";
// ---- the verification adapter — the host seam (component 5) -------------------------
export { bindAndroidVerificationHost, verifyAndroidJourneys } from "./verification.ts";
