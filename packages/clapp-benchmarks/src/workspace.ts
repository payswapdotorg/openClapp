import { canonicalJson, cloneJson, deepFreezeJson, sha256Hex } from "./canonical.ts";
import { ClappBenchmarkError, describeShape } from "./errors.ts";
import type {
  BenchmarkApp,
  BenchmarkWorkspaceSeam,
  BenchmarkWorkspaceSummary,
  WorkspaceHosting,
} from "./types.ts";
import { assertValidBenchmarkApp } from "./validate.ts";

/**
 * Benchmark hosting inside isolated execution (CLAPP-W1-005), composed over
 * the W1-003 candidate workspace execution seam.
 *
 * The seam is a STRUCTURAL interface declared in types.ts — the shapes of
 * the runtime package's candidate workspace provider (`create`, `destroy`,
 * `seedWorkspaceFile`, and the optional `discoverWorkspaces`) without
 * importing any runtime module. bindBenchmarkWorkspaceSeam duck-types an
 * untyped handle onto it and fails closed naming the missing capability,
 * so a test FAKE (a structural literal) and the REAL runtime provider both
 * satisfy the same interface.
 *
 * hostBenchmarkInWorkspace creates the REFERENCE workspace for the
 * benchmark (the benchmark is its own reference reconstruction: the
 * reconstructionId is the benchmark's stable id), seeds every file in path
 * order under the seam's chunked, integrity-verified writes, verifies each
 * seed's reported byte count, and — when the seam can discover — verifies
 * the fresh workspace is discoverable before reporting success. It returns
 * the hosting WITHOUT executing the start command: execution is the
 * caller's bounded runCandidateBuild-style call.
 *
 * resetBenchmarkInWorkspace is destroy + host again: the seam's tombstone
 * semantics mean the new hosting never reuses the old workspace id, and
 * this module verifies that invariant instead of trusting it. The re-seed
 * uses the immutable app snapshot captured at hosting time, so a caller
 * mutating its own app object can never change what a reset re-seeds: the
 * new workspace's content is byte-identical to the original by
 * construction.
 */

const REQUIRED_SEAM_CAPABILITIES = ["create", "destroy", "seedWorkspaceFile"] as const;

/**
 * Duck-types an untyped workspace seam handle onto the structural
 * BenchmarkWorkspaceSeam interface. Fails closed with a typed error naming
 * the missing or malformed capability; discoverWorkspaces is optional and,
 * when present but malformed, fails the bind exactly like a required one.
 */
export function bindBenchmarkWorkspaceSeam(seam: unknown): BenchmarkWorkspaceSeam {
  if (typeof seam !== "object" || seam === null)
    throw new ClappBenchmarkError(
      "seam",
      `the workspace seam must be an object providing ${REQUIRED_SEAM_CAPABILITIES.join(", ")} (and optionally discoverWorkspaces); received ${describeShape(seam)}`,
    );
  const handle = seam as Record<string, unknown>;
  for (const capability of REQUIRED_SEAM_CAPABILITIES)
    if (typeof handle[capability] !== "function")
      throw new ClappBenchmarkError(
        capability,
        `the workspace seam is missing the required capability "${capability}" (create, destroy and seedWorkspaceFile are required for benchmark hosting; discoverWorkspaces is optional and skips the post-hosting discovery check); bind fails closed`,
      );
  if (handle.discoverWorkspaces !== undefined && typeof handle.discoverWorkspaces !== "function")
    throw new ClappBenchmarkError(
      "discoverWorkspaces",
      'the workspace seam exposes "discoverWorkspaces" but it is not a function; a malformed optional capability fails the bind',
    );
  return handle as unknown as BenchmarkWorkspaceSeam;
}

/** Validates a seam-returned workspace creation result (fail closed). */
function requireCreatedWorkspace(
  value: { id: unknown; path: unknown },
  app: BenchmarkApp,
): { id: string; path: string } {
  if (typeof value.id !== "string" || value.id.trim() === "")
    throw new ClappBenchmarkError(
      "workspace",
      `the seam returned a created workspace without a non-empty id for benchmark "${app.id}"; refusing to host into an unusable workspace`,
    );
  if (typeof value.path !== "string" || value.path.trim() === "")
    throw new ClappBenchmarkError(
      "workspace",
      `the seam returned workspace "${value.id}" without a non-empty path; refusing to seed into an unusable workspace`,
    );
  return { id: value.id, path: value.path };
}

/** Verifies the freshly hosted workspace is discoverable through the seam. */
async function verifyDiscovered(
  seam: BenchmarkWorkspaceSeam,
  app: BenchmarkApp,
  workspaceId: string,
): Promise<void> {
  const discover = seam.discoverWorkspaces;
  if (discover === undefined) return; // honest degradation: unverifiable, not failed
  let summaries: readonly BenchmarkWorkspaceSummary[];
  try {
    summaries = await discover.call(seam, { reconstructionId: app.id });
  } catch (error) {
    throw new ClappBenchmarkError(
      "workspace",
      `the seam could not discover workspaces for reconstruction "${app.id}": ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!Array.isArray(summaries))
    throw new ClappBenchmarkError(
      "workspace",
      `the seam returned a non-array discovery result for reconstruction "${app.id}"; refusing to claim the hosting is discoverable`,
    );
  const found = summaries.find((summary) => summary?.id === workspaceId);
  if (found === undefined)
    throw new ClappBenchmarkError(
      "workspace",
      `workspace "${workspaceId}" is not discoverable for reconstruction "${app.id}"; the hosting is not verifiable and fails closed`,
    );
  if (found.kind !== "reference" || found.tombstoned)
    throw new ClappBenchmarkError(
      "workspace",
      `workspace "${workspaceId}" was discovered as kind "${String(found.kind)}" tombstoned="${String(found.tombstoned)}" instead of a live reference workspace; the hosting fails closed`,
    );
}

/**
 * Hosts a benchmark inside an isolated-execution workspace: creates the
 * reference workspace through the seam, seeds every file in path order,
 * verifies each seed's reported byte count (a short seed is never claimed
 * complete), verifies discoverability when the seam supports it, and
 * returns the hosting — WITHOUT executing the start command.
 */
export async function hostBenchmarkInWorkspace(
  app: BenchmarkApp,
  seam: BenchmarkWorkspaceSeam,
): Promise<WorkspaceHosting> {
  assertValidBenchmarkApp(app);
  const bound = bindBenchmarkWorkspaceSeam(seam);
  const reconstructionId = app.id;

  let created: { id: string; path: string };
  try {
    created = requireCreatedWorkspace(
      await bound.create({ reconstructionId, kind: "reference" }),
      app,
    );
  } catch (error) {
    if (error instanceof ClappBenchmarkError) throw error;
    throw new ClappBenchmarkError(
      "workspace",
      `the seam could not create the reference workspace for benchmark "${reconstructionId}": ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  // Seed every file in path order (the definition's files array is validated
  // sorted, so path order is the array order). Each seed's reported byte
  // count must equal the intended content — a dropped or short file never
  // passes silently.
  for (const file of app.files) {
    let seeded: { path: unknown; bytes: unknown; chunks: unknown };
    try {
      seeded = await bound.seedWorkspaceFile({
        reconstructionId,
        workspaceId: created.id,
        path: file.path,
        content: file.content,
      });
    } catch (error) {
      throw new ClappBenchmarkError(
        "workspace",
        `the seam could not seed "${file.path}" into workspace "${created.id}": ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    if (
      typeof seeded?.bytes !== "number" ||
      seeded.bytes !== Buffer.byteLength(file.content, "utf8")
    )
      throw new ClappBenchmarkError(
        "workspace",
        `the seam reported seeding "${file.path}" with ${String(seeded?.bytes)} bytes instead of ${Buffer.byteLength(file.content, "utf8")}; a short or inflated seed is never claimed complete`,
      );
    if (typeof seeded?.chunks !== "number" || !Number.isInteger(seeded.chunks) || seeded.chunks < 1)
      throw new ClappBenchmarkError(
        "workspace",
        `the seam reported an invalid chunk count for "${file.path}": ${String(seeded?.chunks)}`,
      );
  }

  await verifyDiscovered(bound, app, created.id);

  return {
    benchmarkId: app.id,
    workspaceId: created.id,
    workspacePath: created.path,
    startCommand: app.startCommand,
    routes: deepFreezeJson(app.routes.map((route) => ({ ...route, anchors: [...route.anchors] }))),
    // An immutable snapshot: resets re-seed from THIS copy, so later caller
    // mutations of their app object cannot drift what a reset reproduces.
    app: deepFreezeJson(cloneJson(app)),
  };
}

/**
 * Resets a hosted benchmark: destroys the old workspace (the seam
 * tombstones the id — it is never reused), hosts the same definition again
 * as a fresh instance, and verifies the new workspace id differs from the
 * old one before returning. The new workspace's content is byte-identical
 * to the original hosting by construction (same immutable app snapshot).
 */
export async function resetBenchmarkInWorkspace(
  seam: BenchmarkWorkspaceSeam,
  hosting: WorkspaceHosting,
): Promise<WorkspaceHosting> {
  const bound = bindBenchmarkWorkspaceSeam(seam);
  try {
    await bound.destroy(hosting.workspaceId);
  } catch (error) {
    throw new ClappBenchmarkError(
      "workspace",
      `the seam could not destroy workspace "${hosting.workspaceId}" for benchmark "${hosting.benchmarkId}": ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const renewed = await hostBenchmarkInWorkspace(hosting.app, bound);
  if (renewed.workspaceId === hosting.workspaceId)
    throw new ClappBenchmarkError(
      "workspace",
      `the seam reused workspace id "${hosting.workspaceId}" after destroy for benchmark "${hosting.benchmarkId}"; tombstone semantics forbid id reuse and the reset fails closed`,
    );
  return renewed;
}

/**
 * Deterministic content digest of a benchmark's file set: the sha256 of the
 * canonical JSON of [{ path, contentSha256 }] over the files in path order.
 * A reset hosting must reproduce this digest exactly; exported for callers
 * that want to verify byte-identity without re-reading every file.
 */
export function hostingContentDigest(app: BenchmarkApp): string {
  return sha256Hex(
    canonicalJson(
      app.files.map((file) => ({ path: file.path, contentSha256: sha256Hex(file.content) })),
    ),
  );
}
