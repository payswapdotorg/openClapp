/**
 * @clapp/native-linux — public API (ADR-004, lane 2 of 5: native adapters).
 *
 * The Linux lane — second of the five platforms per ADR-004 (Android,
 * Linux, Windows, macOS, iOS) — the five platform components that ADR
 * demands, as v0.1 contracts:
 *   1. the environment descriptor  (src/environment.ts)
 *   2. the observation adapter    (src/observation.ts — the host seam)
 *   3. the evidence emitter       (src/evidence.ts)
 *   4. the synthesis target       (src/synthesis-target.ts)
 *   5. the verification adapter   (src/verification.ts — the host seam)
 *
 * THE NO-FORK LAW (ADR-004, binding): this package CONSUMES the frozen
 * contracts (@clapp/contracts) via TYPE-ONLY imports and produces
 * contract-shaped DATA — it never redefines, rewrites, or forks any
 * IR/contract type. The runtime helpers (sha256Hex, canonicalJson) live
 * in-package (src/canonical.ts) so the import-discipline test
 * (tests/clapp-native-linux.test.ts) can pin: every src import is either
 * in-package (`./…`) or the frozen @clapp/contracts surface (TYPE-ONLY);
 * the package never imports @clapp/intelligence, @clapp/synthesis,
 * @clapp/runtime-openmuse, or any apps/** module.
 *
 * The host seams (LinuxObservationHost, LinuxVerificationHost) are
 * duck-typed at bind time with typed fail-closed errors (the openClapp
 * `@clapp/observation` BrowserSessionSeam style): everything environment-
 * specific enters through them, the tests fake them, and real X11/Wayland/
 * AT-SPI-over-D-Bus bindings are deployment scope — the CONTRACTS are this
 * lane's deliverable.
 *
 * Sibling packages must import `@clapp/native-linux` and never reach into
 * deeper paths. Windows/macOS/iOS are later lanes (the roadmap's Native
 * adapters block flips ✅ only when all five are integrated).
 */

export type { LinuxEnvironment, LinuxEnvironmentValidation } from "./environment.ts";
// ---- the environment descriptor (component 1) ---------------------------------------
export {
  CLAPP_NATIVE_LINUX_ENVIRONMENT_VERSION,
  LINUX_ACCESSIBILITY_BUSES,
  LINUX_DISPLAY_SERVERS,
  validateLinuxEnvironment,
} from "./environment.ts";
export type { ObservationEvidenceResult } from "./evidence.ts";
// ---- the evidence emitter (component 3) ----------------------------------------------
export {
  emitObservationEvidence,
  LINUX_EVIDENCE_ID_PREFIX,
} from "./evidence.ts";
export type {
  LinuxObservation,
  LinuxObservationHost,
  LinuxObservationResult,
  LinuxViewNode,
} from "./observation.ts";
// ---- the observation adapter — the host seam (component 2) ---------------------------
export { observeLinuxScreen } from "./observation.ts";
export type {
  LinuxSynthesisTarget,
  LinuxSynthesisTargetValidation,
} from "./synthesis-target.ts";
// ---- the synthesis target (component 4) ----------------------------------------------
export {
  CLAPP_NATIVE_LINUX_TARGET_VERSION,
  LINUX_PACKAGING_FORMATS,
  validateLinuxSynthesisTarget,
} from "./synthesis-target.ts";
export type {
  LinuxVerificationHost,
  LinuxVerificationResult,
  LinuxVerificationRun,
} from "./verification.ts";
// ---- the verification adapter — the host seam (component 5) ----------------------------
export { verifyLinuxJourneys } from "./verification.ts";
