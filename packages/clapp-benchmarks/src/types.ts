/**
 * The public shape of a CLAPP web benchmark and the hosting surfaces around
 * it. A BenchmarkApp is a fully deterministic fixture definition: every byte
 * of served content is a pure function of the definition (plus, for stateful
 * apps, the current store) — no timestamps, no random ids, no external
 * resources. The benchmarks are the reference targets for observation
 * (W1-002), parity (W3-004), repair (W3-005) and learning (Phase 6).
 */

/** The two benchmark archetypes. */
export type BenchmarkKind = "static" | "stateful";

/** One seeded fixture file. `path` is workspace-relative; `content` is UTF-8 text. */
export interface BenchmarkFile {
  /** Workspace-relative path, POSIX separators, sorted unique across the app. */
  readonly path: string;
  /** The complete UTF-8 text of the file (no binary, no external references). */
  readonly content: string;
}

/**
 * One served route and its anchor inventory. Anchors are stable strings
 * (headings, nav labels, form labels, status-line prefixes) that observation
 * and parity stages use to identify page regions; every anchor must occur in
 * the route's served content while the benchmark is in its seeded state.
 */
export interface BenchmarkRoute {
  /** The served path: "/" or "/segment" ("/segment/sub" nests into files). */
  readonly path: string;
  /** Stable strings that must appear in the rendered page. */
  readonly anchors: readonly string[];
}

/**
 * A deterministic web benchmark definition.
 *
 * Invariants (enforced by validateBenchmarkApp):
 * - `id` is a stable `clapp_benchmark_`-prefixed string; no timestamps, no
 *   random ids anywhere in the definition.
 * - `files` are sorted by path (strict code-unit order) with unique paths.
 * - `routes` are sorted by path with unique paths; every route maps to an
 *   existing file ("/" -> "index.html", "/x" -> "x.html", "/a/b" ->
 *   "a/b.html"); the "/api/" prefix is reserved for the state API.
 * - `stateSeed` exists for stateful apps only (a JSON-safe object) and must
 *   deep-equal the parsed "state.json" file, which the sandbox host reads.
 * - `startCommand` is non-empty, at most 16 000 characters, and references
 *   no external http(s) URL (deny-only execution honesty).
 */
export interface BenchmarkApp {
  /** Stable identifier, "clapp_benchmark_" + lowercase alphanumeric/dashes. */
  readonly id: string;
  /** Human-readable benchmark name. */
  readonly name: string;
  /** Definition version (semver-style string). */
  readonly version: string;
  /** Whether the benchmark serves static files only or also the /api/ store. */
  readonly kind: BenchmarkKind;
  /** Every fixture file, sorted by path. Includes the node:http sandbox host. */
  readonly files: readonly BenchmarkFile[];
  /** The served route inventory, sorted by path. */
  readonly routes: readonly BenchmarkRoute[];
  /** stateful only: the JSON store seed the /api/ store starts from. */
  readonly stateSeed?: Record<string, unknown>;
  /** The bounded, deny-network-safe command that starts the sandbox host. */
  readonly startCommand: string;
  /** Authoring assumptions downstream stages should know about. */
  readonly assumptions: readonly string[];
}

/** A running in-process benchmark server on an ephemeral loopback port. */
export interface StartedBenchmark {
  /** The ephemeral port the server listens on (127.0.0.1). */
  readonly port: number;
  /** The loopback base URL, `http://127.0.0.1:<port>`. */
  readonly baseUrl: string;
  /**
   * Stops this server incarnation. Idempotent: a stale handle (the server was
   * replaced by reset()) stops nothing. The harness can then be started again.
   */
  stop(): Promise<void>;
}

/**
 * Disposable in-process hosting for one benchmark app: the test/tooling
 * substrate with the same serving semantics as the sandbox host file.
 *
 * Lifecycle:
 * - `start()` starts (or, after reset(), re-handles) the loopback server and
 *   fails closed on double starts;
 * - `reset()` stops a running server, discards the store, re-seeds from
 *   stateSeed and restarts on a NEW ephemeral port; the next `start()`
 *   returns that fresh incarnation;
 * - after any reset, served content and state are byte-identical to a fresh
 *   start of the same definition.
 */
export interface BenchmarkHarness {
  /** Starts (or re-handles) the loopback server on an ephemeral port. */
  start(): Promise<StartedBenchmark>;
  /** The stateful store's current value (a deep copy); {} for static apps. */
  snapshotState(): Record<string, unknown>;
  /**
   * Test/repair-loop support: merges a JSON-safe object patch into the store
   * (top-level keys). Static benchmarks fail closed with a typed error.
   */
  mutateState(patch: Record<string, unknown>): void;
  /**
   * Stops the running server, discards the store, re-seeds from stateSeed and
   * (when the harness was running) restarts on a new ephemeral port. Never
   * reuses a port or preserves mutated state.
   */
  reset(): Promise<void>;
}

/**
 * One workspace summary as the W1-003 seam reports it. Shape-compatible with
 * the runtime package's discovery result so a real seam satisfies this
 * package's structural interface without any import.
 */
export interface BenchmarkWorkspaceSummary {
  readonly id: string;
  readonly path: string;
  readonly kind: "reference" | "candidate";
  readonly instance: number;
  readonly registered: boolean;
  readonly tombstoned: boolean;
}

/**
 * The narrow structural interface the benchmark workspace composition needs
 * from the W1-003 candidate seam. Declared HERE, duck-typed at bind time,
 * and shape-compatible with the runtime package's candidate workspace
 * provider (`create`, `destroy`, `seedWorkspaceFile`, and optionally
 * `discoverWorkspaces`) so the real provider satisfies it without this
 * package importing any runtime module:
 *
 *   create(input)            — make a workspace (kind "reference" here)
 *   destroy(id)              — tombstone the id and remove the directory
 *   seedWorkspaceFile(input) — write one file into the workspace (chunked,
 *                              integrity-verified, under the substrate's
 *                              256 KB single-write ceiling)
 *   discoverWorkspaces?(in)  — restart-safe discovery by the deterministic
 *                              path scheme; when present, hosting verifies
 *                              the fresh workspace is discoverable.
 */
export interface BenchmarkWorkspaceSeam {
  /** Creates a workspace directory for a reconstruction. */
  create(input: {
    reconstructionId: string;
    kind: "reference" | "candidate";
  }): Promise<{ id: string; path: string }>;
  /** Destroys a workspace: the id stops being live and is never reused. */
  destroy(id: string): Promise<void>;
  /** Seeds one file into a live workspace (path relative to its root). */
  seedWorkspaceFile(input: {
    reconstructionId: string;
    workspaceId: string;
    path: string;
    content: string;
  }): Promise<{ path: string; bytes: number; chunks: number }>;
  /**
   * Optional restart-safe discovery. When the seam provides it, hosting
   * verifies the freshly created reference workspace is discoverable before
   * reporting success; without it hosting proceeds honestly unverifed.
   */
  discoverWorkspaces?(input: {
    reconstructionId: string;
  }): Promise<readonly BenchmarkWorkspaceSummary[]>;
}

/**
 * The result of hosting a benchmark inside an isolated-execution workspace:
 * everything the caller needs to later run the bounded start command and to
 * reset the hosting. The hosting does NOT execute the start command — that
 * is the caller's bounded runCandidateBuild-style call.
 */
export interface WorkspaceHosting {
  /** The hosted benchmark's stable id (also the hosting's reconstructionId). */
  readonly benchmarkId: string;
  /** The workspace id (never reused after reset — tombstone semantics). */
  readonly workspaceId: string;
  /** The absolute workspace path inside the isolated execution root. */
  readonly workspacePath: string;
  /** The bounded, deny-network-safe start command for the caller to run. */
  readonly startCommand: string;
  /** The hosted benchmark's route inventory (observation/parity inputs). */
  readonly routes: readonly BenchmarkRoute[];
  /**
   * The immutable validated snapshot of the hosted definition. reset uses
   * this snapshot, so a caller mutating its own app object can never change
   * what a reset re-seeds.
   */
  readonly app: BenchmarkApp;
}
