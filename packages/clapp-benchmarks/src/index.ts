/**
 * @clapp/benchmarks — disposable benchmark hosting and reset (CLAPP-W1-005).
 *
 * The canonical web benchmarks (ACCEPTANCE.md M5/M6: two materially
 * different apps — a static marketing site and a stateful CRUD-ish
 * operations app) and the two hosting surfaces around them:
 *
 *   - the IN-PROCESS harness (createBenchmarkHarness): a node:http loopback
 *     server on an ephemeral port for tests and tooling, with snapshot /
 *     mutate / reset over an in-memory JSON store — the disposable host;
 *
 *   - the WORKSPACE composition (hostBenchmarkInWorkspace): reference
 *     workspace creation, chunked file seeding and tombstone-safe reset
 *     over the W1-003 candidate workspace execution seam — a structural
 *     interface declared here, satisfied by the runtime package's provider
 *     or by any faithful fake, never by importing a runtime module.
 *
 * Determinism is the gate: the same definition hosts byte-identical content
 * every time (canonical JSON everywhere, no timestamps, no random ids), and
 * a reset re-seeds to bytes identical to a fresh start on a new port / a
 * new workspace instance — never an id or port reuse.
 */

// Deterministic serialization and content addressing.
export { canonicalJson, cloneJson, deepFreezeJson, sha256Hex } from "./canonical.ts";
// Typed errors.
export { ClappBenchmarkError, describeError, describeShape } from "./errors.ts";
// The sandbox host shipped inside every benchmark's files.
export { BENCHMARK_SERVE_JS } from "./fixtures/serve-script.ts";
// The in-process disposable harness.
export { createBenchmarkHarness, renderTokens } from "./harness.ts";
// The canonical inventory.
export { CANONICAL_BENCHMARKS, listBenchmarks } from "./inventory.ts";
// Public types.
export type {
  BenchmarkApp,
  BenchmarkFile,
  BenchmarkHarness,
  BenchmarkKind,
  BenchmarkRoute,
  BenchmarkWorkspaceSeam,
  BenchmarkWorkspaceSummary,
  StartedBenchmark,
  WorkspaceHosting,
} from "./types.ts";
// Validation.
export {
  assertValidBenchmarkApp,
  BENCHMARK_API_PREFIX,
  BENCHMARK_COMMAND_LIMIT_CHARS,
  BENCHMARK_STATE_FILE,
  fileRoutePath,
  routeFilePath,
  validateBenchmarkApp,
} from "./validate.ts";
// Workspace composition over the W1-003 seam.
export {
  bindBenchmarkWorkspaceSeam,
  hostBenchmarkInWorkspace,
  hostingContentDigest,
  resetBenchmarkInWorkspace,
} from "./workspace.ts";
