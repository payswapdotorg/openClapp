import { createHash } from "node:crypto";
import type { ArtifactProvider, ExecutionProvider, WorkspaceProvider } from "@clapp/contracts";
import { ClappRuntimeError, describeError } from "./errors.ts";
import type { BoundHandles, ClappComputerHandle } from "./handles.ts";
import { requireCapabilities } from "./handles.ts";

/**
 * CLAPP-W1-003 — the candidate workspace execution seam.
 *
 * This module implements the candidate-build orchestration surface that the
 * Wave 3 candidate generator composes: deterministic workspaces, chunked
 * workspace seeding under the substrate's 256 KB file-write limit, bounded
 * build/test command composition, produced-artifact harvesting through the
 * artifact provider, and restart-safe workspace discovery by deterministic
 * path scheme. Everything here runs through the narrow structural computer
 * handle declared in `handles.ts`; no OpenMuse server module is imported.
 *
 * Substrate ceilings honored (apps/server/src/computer.ts):
 * - a command runs at most 30 000 ms regardless of the caller's request;
 * - a command string is at most 16 000 characters;
 * - a single text file write is at most 256 KB (262 144 bytes);
 * - terminal networking is disabled in the sandbox ("deny" is the only honest
 *   network mode; "allowlist"/"full" fail closed in the execution provider);
 * - every operation is exclusive per owner and durable in the store.
 */

/** The substrate refuses a single text write above 256 KB. */
export const SUBSTRATE_FILE_LIMIT_BYTES = 256 * 1024;
/** The substrate refuses a command string longer than 16 000 characters. */
export const SUBSTRATE_COMMAND_LIMIT_CHARS = 16_000;
/** Default bytes per seeded chunk: a safety margin under the 256 KB limit. */
export const DEFAULT_CANDIDATE_CHUNK_BYTES = 245_760;
/** Default total bytes a single seed call accepts (16 MiB). */
export const DEFAULT_CANDIDATE_SEED_BYTES = 16 * 1024 * 1024;
/** Default entry cap for a bounded workspace listing. */
export const DEFAULT_CANDIDATE_LIST_ENTRIES = 1024;
/** Hard cap on directories visited by one bounded workspace listing. */
const CANDIDATE_LIST_DIRECTORY_BUDGET = 128;
/**
 * Composed `cat` reassembly commands stay under this character budget so the
 * composed command can never reach the substrate's 16 000-character limit.
 */
const CANDIDATE_COMMAND_BUDGET_CHARS = 12_000;
/** Root directory for every CLAPP workspace in the sandbox. */
const CLAPP_WORKSPACE_ROOT = "/workspace/clapp";

/**
 * Options that wire the candidate execution seam onto the runtime adapter.
 * Passing the options object is what upgrades the execution and workspaces
 * providers to the real ComputerService candidate semantics; constructing the
 * runtime without them keeps every Wave 1 behavior byte-for-byte and makes
 * the seam methods fail closed with a typed not-configured error at call
 * time.
 */
export interface CandidateExecutionOptions {
  /**
   * Maximum bytes written per chunk when seeding workspace files larger than
   * this. Content above the limit is split into chunks of at most this size
   * and reassembled with one bounded `cat` command per batch. Default 245 760
   * (240 KB). Must be an integer between 1 and 262 144 (the substrate refuses
   * single writes above 256 KB).
   */
  maxChunkBytes?: number;
  /**
   * Maximum total bytes accepted by one `seedWorkspaceFile` call. Default
   * 16 MiB. Must be an integer between `maxChunkBytes` and 256 MiB so the
   * number of composed commands stays bounded.
   */
  maxSeedBytes?: number;
  /**
   * Maximum entries returned by `listWorkspaceFiles` before the bounded walk
   * fails closed with a typed error. Default 1024. Must be an integer between
   * 1 and 10 000.
   */
  listEntryBudget?: number;
}

/** Resolved, validated candidate seam configuration. */
export interface CandidateSeamConfiguration {
  maxChunkBytes: number;
  maxSeedBytes: number;
  listEntryBudget: number;
}

/**
 * Input of one seeded candidate file. `path` is relative to the workspace
 * root; `content` is the complete UTF-8 text of the file.
 */
export interface CandidateSeedFileInput {
  reconstructionId: string;
  workspaceId: string;
  path: string;
  content: string;
}

/** Result of one seeded candidate file. */
export interface CandidateSeedResult {
  path: string;
  bytes: number;
  chunks: number;
}

/** One bounded listing entry, relative to the workspace root. */
export interface CandidateWorkspaceFile {
  path: string;
  name: string;
  type: "file" | "directory" | "symlink";
  size: number;
}

/** Input of the bounded workspace listing. */
export interface CandidateWorkspaceFilesInput {
  reconstructionId: string;
  workspaceId: string;
}

/**
 * One workspace directory located by the deterministic path scheme. Discovery
 * is honest about registration: a directory that exists under the scheme but
 * carries no live registry record (the crash window between `mkdir` and the
 * registry write) is still returned, flagged `registered: false`.
 */
export interface CandidateWorkspaceSummary {
  id: string;
  path: string;
  kind: "reference" | "candidate";
  instance: number;
  registered: boolean;
  tombstoned: boolean;
}

/** Input of restart-safe workspace discovery. */
export interface CandidateDiscoverInput {
  reconstructionId: string;
}

/** One honest harvest failure: a path that could not become an artifact. */
export interface CandidateHarvestFailure {
  path: string;
  reason: string;
}

/** Input of produced-artifact harvesting. */
export interface CandidateHarvestInput {
  reconstructionId: string;
  workspaceId: string;
  paths: string[];
  targetId: string;
}

/** Result of produced-artifact harvesting. */
export interface CandidateHarvestOutcome {
  artifacts: string[];
  failures: CandidateHarvestFailure[];
}

/** Harvest configuration inside a candidate build plan. */
export interface CandidateBuildHarvest {
  workspaceId: string;
  paths: string[];
  targetId: string;
}

/**
 * Input of the composed candidate build. `build` and `test` are the sandbox
 * commands to compose; `harvest` optionally stores produced files through the
 * artifact provider once every step has succeeded.
 */
export interface CandidateBuildInput {
  reconstructionId: string;
  cwd: string;
  build: string;
  test?: string;
  timeoutMs: number;
  network?: "deny" | "allowlist" | "full";
  harvest?: CandidateBuildHarvest;
}

/** Result of one composed build/test step (a result, never an exception). */
export interface CandidateBuildStepResult {
  name: "build" | "test";
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  artifacts: string[];
}

/** Overall outcome of the composed candidate build. */
export interface CandidateBuildOutcome {
  steps: CandidateBuildStepResult[];
  exitCode: number;
  succeeded: boolean;
  artifacts: string[];
  harvestFailures: CandidateHarvestFailure[];
}

const sha256Hex = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const nowIso = () => new Date().toISOString();

/** Durable registry record of a live workspace (db kind "clapp-workspaces"). */
export interface WorkspaceIndexRecord {
  id: string;
  workspaceId: string;
  reconstructionId: string;
  kind: "reference" | "candidate";
  path: string;
  instance: number;
  createdAt: string;
}

/** Durable tombstone of a destroyed workspace id (kind "clapp-workspace-tombstones"). */
export interface WorkspaceTombstoneRecord {
  id: string;
  workspaceId: string;
  reconstructionId: string;
  kind: "reference" | "candidate";
  path: string;
  instance: number;
  destroyedAt: string;
}

/**
 * Everything the seam functions need: the bound handles, the resolved
 * configuration and the runtime's artifact provider. The context exists only
 * when `CandidateExecutionOptions` wired the seam.
 */
export interface CandidateSeamContext {
  bound: BoundHandles;
  configuration: CandidateSeamConfiguration;
  artifacts: ArtifactProvider;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requireText(value: unknown, provider: string, capability: string, label: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new ClappRuntimeError(
      provider,
      capability,
      `${label} must be a non-empty string; received ${typeof value}`,
    );
  return value;
}

/**
 * Validates the untyped candidate options at bind time. Values outside the
 * documented bounds fail closed with typed errors before any provider is
 * constructed.
 */
export function resolveCandidateOptions(
  options: CandidateExecutionOptions,
): CandidateSeamConfiguration {
  const positiveInteger = (value: unknown, label: string): number => {
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0)
      throw new ClappRuntimeError(
        "candidate",
        "options",
        `${label} must be a positive integer; received ${String(value)}`,
      );
    return value;
  };
  const maxChunkBytes = positiveInteger(
    options.maxChunkBytes ?? DEFAULT_CANDIDATE_CHUNK_BYTES,
    "maxChunkBytes",
  );
  if (maxChunkBytes > SUBSTRATE_FILE_LIMIT_BYTES)
    throw new ClappRuntimeError(
      "candidate",
      "options",
      `maxChunkBytes ${maxChunkBytes} exceeds the substrate's ${SUBSTRATE_FILE_LIMIT_BYTES}-byte single-write limit`,
    );
  const maxSeedBytes = positiveInteger(
    options.maxSeedBytes ?? DEFAULT_CANDIDATE_SEED_BYTES,
    "maxSeedBytes",
  );
  if (maxSeedBytes < maxChunkBytes || maxSeedBytes > 256 * 1024 * 1024)
    throw new ClappRuntimeError(
      "candidate",
      "options",
      `maxSeedBytes must be between maxChunkBytes (${maxChunkBytes}) and 268435456; received ${maxSeedBytes}`,
    );
  const listEntryBudget = positiveInteger(
    options.listEntryBudget ?? DEFAULT_CANDIDATE_LIST_ENTRIES,
    "listEntryBudget",
  );
  if (listEntryBudget > 10_000)
    throw new ClappRuntimeError(
      "candidate",
      "options",
      `listEntryBudget must not exceed 10000; received ${listEntryBudget}`,
    );
  return { maxChunkBytes, maxSeedBytes, listEntryBudget };
}

/**
 * Bind-time validation of the candidate capabilities on the computer handle.
 * Called only when the options object is present AND a computer handle was
 * bound: a handle that survived Wave 1 binding but cannot serve the seam
 * fails closed here with a typed error naming the missing capability.
 */
export function bindCandidateCapabilities(bound: BoundHandles): void {
  if (!bound.computer) return;
  requireCapabilities(bound.computer, "computer", "candidate execution and workspaces", [
    "read",
    "write",
    "list",
  ]);
}

/** Guards a seam call: the computer handle must be bound and complete. */
function requireComputer(seam: CandidateSeamContext): ClappComputerHandle {
  const computer = seam.bound.computer;
  if (!computer)
    throw new ClappRuntimeError(
      "candidate",
      "computer-handle",
      "the computer handle was not provided to createOpenMuseRuntime, so the candidate seam cannot serve this call; refusing to guess",
    );
  for (const capability of ["read", "write", "list"] as const)
    if (typeof computer[capability] !== "function")
      throw new ClappRuntimeError(
        "computer",
        capability,
        `the computer handle is missing the required capability "${capability}" needed by the candidate seam; bind fails closed`,
      );
  return computer;
}

/**
 * Maps a workspace-relative path to validated segments. Rejects absolute
 * paths, parent traversal, empty and dot segments, and null bytes so a seeded
 * or harvested path can never escape the workspace directory.
 */
function requireRelativeSegments(
  value: unknown,
  provider: string,
  capability: string,
  label: string,
): string[] {
  const path = requireText(value, provider, capability, label);
  if (path.length > 512)
    throw new ClappRuntimeError(provider, capability, `${label} must be at most 512 characters`);
  if (path.includes("\0"))
    throw new ClappRuntimeError(provider, capability, `${label} must not contain null bytes`);
  if (path.startsWith("/"))
    throw new ClappRuntimeError(
      provider,
      capability,
      `${label} must be relative to the workspace root, not absolute`,
    );
  const segments = path.split("/");
  const invalid = segments.find((segment) => segment === "" || segment === "." || segment === "..");
  if (invalid !== undefined)
    throw new ClappRuntimeError(
      provider,
      capability,
      `${label} must not contain empty, "." or ".." segments; received "${path}"`,
    );
  return segments;
}

/** Validates one workspace-relative path and returns it in normalized form. */
export function requireWorkspaceRelativePath(
  value: unknown,
  provider: string,
  capability: string,
  label: string,
): string {
  return requireRelativeSegments(value, provider, capability, label).join("/");
}

/** Single-quotes a path for the composed sandbox command, escaping embedded quotes. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * The deterministic path segment for one reconstruction: a sanitized prefix
 * plus an 8-hex digest of the true id, so distinct ids never share a parent
 * directory and the parent is always derivable from the id alone.
 */
export function safeSegment(reconstructionId: string): string {
  const sanitized = Array.from(reconstructionId)
    .map((character) => (/[A-Za-z0-9._-]/.test(character) ? character : "-"))
    .join("")
    .slice(0, 40);
  const safe = sanitized === "." || sanitized === ".." || sanitized === "" ? "-" : sanitized;
  return `${safe}-${sha256Hex(reconstructionId).slice(0, 8)}`;
}

/** Deterministic parent directory of every workspace of one reconstruction. */
export function workspaceParent(reconstructionId: string): string {
  return `${CLAPP_WORKSPACE_ROOT}/${safeSegment(reconstructionId)}`;
}

/** Deterministic workspace id: the digest of the absolute workspace path. */
export function workspaceIdOf(path: string): string {
  return sha256Hex(path);
}

const WORKSPACE_ENTRY_PATTERN = /^(reference|candidate)-(\d+)$/;

/** Parses `<kind>-<instance>` entry names of the deterministic scheme. */
function parseWorkspaceEntry(name: string): { kind: "reference" | "candidate"; instance: number } {
  const match = WORKSPACE_ENTRY_PATTERN.exec(name);
  if (!match) return { kind: "candidate", instance: 0 };
  return { kind: match[1] as "reference" | "candidate", instance: Number(match[2]) };
}

/**
 * Splits text content into chunks of at most `maxBytes` UTF-8 bytes without
 * cutting a code point in half, so every chunk is a valid string and the
 * reassembled file is byte-identical to the input.
 */
export function chunkTextContent(content: string, maxBytes: number): string[] {
  const chunks: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const character of content) {
    const size = Buffer.byteLength(character, "utf8");
    if (currentBytes > 0 && currentBytes + size > maxBytes) {
      chunks.push(current);
      current = "";
      currentBytes = 0;
    }
    current += character;
    currentBytes += size;
  }
  if (current !== "" || chunks.length === 0) chunks.push(current);
  return chunks;
}

/** One composed reassembly command: create (`>`) or append (`>>`). */
interface CatBatch {
  command: string;
  mode: "create" | "append";
}

/**
 * Composes bounded `cat` reassembly commands. Batches keep every composed
 * command under the character budget so the substrate's 16 000-character
 * command limit can never be reached. The first batch creates the target;
 * every later batch appends.
 */
export function composeCatBatches(parts: string[], target: string): CatBatch[] {
  const batches: CatBatch[] = [];
  let currentParts: string[] = [];
  let mode: "create" | "append" = "create";
  let length = `cat  > ${shellQuote(target)}`.length;
  for (const part of parts) {
    const quoted = shellQuote(part);
    if (currentParts.length > 0 && length + 1 + quoted.length > CANDIDATE_COMMAND_BUDGET_CHARS) {
      batches.push({
        command: `cat ${currentParts.map(shellQuote).join(" ")} ${mode === "create" ? ">" : ">>"} ${shellQuote(target)}`,
        mode,
      });
      currentParts = [];
      mode = "append";
      length = `cat  >> ${shellQuote(target)}`.length;
    }
    currentParts.push(part);
    length += 1 + quoted.length;
  }
  batches.push({
    command: `cat ${currentParts.map(shellQuote).join(" ")} ${mode === "create" ? ">" : ">>"} ${shellQuote(target)}`,
    mode,
  });
  return batches;
}

/** Finds the live registry record of a workspace id, owner-scoped. */
async function findLiveWorkspace(
  seam: CandidateSeamContext,
  reconstructionId: string,
  workspaceId: string,
): Promise<{ owner: string; record: WorkspaceIndexRecord }> {
  const rows = await seam.bound.db.scan("clapp-workspaces");
  const match = rows.find(({ value }) => value.workspaceId === workspaceId);
  if (!match)
    throw new ClappRuntimeError(
      "candidate",
      "workspace",
      `no CLAPP workspace is registered under id "${workspaceId}"`,
    );
  const record = match.value as unknown as WorkspaceIndexRecord;
  if (record.reconstructionId !== reconstructionId)
    throw new ClappRuntimeError(
      "candidate",
      "workspace",
      `workspace "${workspaceId}" belongs to reconstruction "${record.reconstructionId}", not "${reconstructionId}"`,
    );
  return { owner: match.owner, record };
}

/** Lists a directory through the computer handle; typed errors name the path. */
async function listDirectory(
  computer: ClappComputerHandle,
  owner: string,
  path: string,
  provider: string,
): Promise<{ name: string; path: string; type: "file" | "directory" | "symlink"; size: number }[]> {
  const list = computer.list;
  if (typeof list !== "function")
    throw new ClappRuntimeError(
      "computer",
      "list",
      `the computer handle is missing the "list" capability needed to enumerate "${path}"; bind fails closed`,
    );
  let directory: Awaited<ReturnType<NonNullable<ClappComputerHandle["list"]>>>;
  try {
    directory = await list.call(computer, owner, path);
  } catch (error) {
    throw new ClappRuntimeError(
      provider,
      "list",
      `the computer handle could not list "${path}": ${describeError(error)}`,
      { cause: error },
    );
  }
  if (directory?.path !== path || !Array.isArray(directory.entries))
    throw new ClappRuntimeError(
      provider,
      "list",
      `the computer returned an invalid listing for "${path}"`,
    );
  return directory.entries;
}

/**
 * Lists a directory that may legitimately not exist yet. Only ever called on
 * parents whose existence was established by the previous listing, so a
 * missing entry means "no workspaces" while a genuine failure stays a typed
 * error.
 */
async function listWorkspaceParent(
  computer: ClappComputerHandle,
  owner: string,
  parent: string,
): Promise<{ name: string; path: string; type: "file" | "directory" | "symlink"; size: number }[]> {
  const steps = parent.split("/").filter(Boolean); // ["workspace", "clapp", "<safe>"]
  let current = "";
  let entries = await listDirectory(computer, owner, "/workspace", "workspaces");
  for (const step of steps.slice(1)) {
    const next = entries.find((entry) => entry.name === step);
    if (next?.type !== "directory") return [];
    current = next.path;
    entries = await listDirectory(computer, owner, current, "workspaces");
  }
  return entries;
}

/**
 * Creates a workspace directory with the deterministic naming scheme
 * (reconstructionId + kind + instance discriminator), registers it in the
 * durable registry and in the run's stage state, and never reuses an id after
 * destroy. Instance allocation consults the directories that exist under the
 * scheme AND the tombstones of destroyed ids, so it is restart-safe without
 * in-memory state.
 */
export async function candidateCreateWorkspace(
  seam: CandidateSeamContext,
  input: { reconstructionId: string; kind: "reference" | "candidate" },
): Promise<{ id: string; path: string }> {
  const computer = requireComputer(seam);
  const { reconstructionId, kind } = input;
  const owner = await resolveSeamOwner(seam, reconstructionId, "workspaces");
  const registryId = `${reconstructionId}:${kind}`;
  const existing = await seam.bound.db.get(owner, "clapp-workspaces", registryId);
  if (existing !== null && existing !== undefined) {
    const record = existing as unknown as WorkspaceIndexRecord;
    return { id: record.workspaceId, path: record.path };
  }
  const parent = workspaceParent(reconstructionId);
  const entries = await listWorkspaceParent(computer, owner, parent);
  const tombstones = (await seam.bound.db.scan("clapp-workspace-tombstones"))
    .filter(({ owner: tombstoneOwner }) => tombstoneOwner === owner)
    .map(({ value }) => value as unknown as WorkspaceTombstoneRecord)
    .filter((record) => record.reconstructionId === reconstructionId && record.kind === kind);
  let instance = 0;
  for (const entry of entries) {
    const parsed = parseWorkspaceEntry(entry.name);
    if (parsed.kind === kind) instance = Math.max(instance, parsed.instance);
  }
  for (const tombstone of tombstones) instance = Math.max(instance, tombstone.instance ?? 0);
  instance += 1;
  const path = `${parent}/${kind}-${instance}`;
  const id = workspaceIdOf(path);
  let made: { path: string };
  try {
    made = await computer.mkdir(owner, path);
  } catch (error) {
    throw new ClappRuntimeError(
      "workspaces",
      "mkdir",
      `the computer handle could not create the workspace directory "${path}" for reconstruction "${reconstructionId}": ${describeError(error)}`,
      { cause: error },
    );
  }
  if (made?.path !== path)
    throw new ClappRuntimeError(
      "workspaces",
      "mkdir",
      `the computer created "${made?.path}" instead of the requested workspace path "${path}"`,
    );
  const record: WorkspaceIndexRecord = {
    id: registryId,
    workspaceId: id,
    reconstructionId,
    kind,
    path,
    instance,
    createdAt: nowIso(),
  };
  await seam.bound.db.put(owner, "clapp-workspaces", record);
  await registerWorkspaceInStageState(seam.bound, reconstructionId, kind, {
    id,
    path,
    instance,
    createdAt: record.createdAt,
  });
  return { id, path };
}

/**
 * Destroys a workspace: removes the registry entry (the id stops being live),
 * writes the tombstone (the id is never reused), then removes the sandbox
 * directory. Destroying an already-destroyed KNOWN id is an idempotent no-op;
 * destroying an unknown id is a typed error.
 */
export async function candidateDestroyWorkspace(
  seam: CandidateSeamContext,
  id: string,
): Promise<void> {
  const computer = requireComputer(seam);
  requireText(id, "workspaces", "destroy", "workspace id");
  const live = (await seam.bound.db.scan("clapp-workspaces")).find(
    ({ value }) => value.workspaceId === id,
  );
  const tombstoned = (await seam.bound.db.scan("clapp-workspace-tombstones")).find(
    ({ value }) => value.workspaceId === id,
  );
  if (!live) {
    if (tombstoned) return;
    throw new ClappRuntimeError(
      "workspaces",
      "destroy",
      `no CLAPP workspace is registered under id "${id}"`,
    );
  }
  const record = live.value as unknown as WorkspaceIndexRecord;
  await seam.bound.db.remove(live.owner, "clapp-workspaces", record.id);
  const tombstone: WorkspaceTombstoneRecord = {
    id: record.workspaceId,
    workspaceId: record.workspaceId,
    reconstructionId: record.reconstructionId,
    kind: record.kind,
    path: record.path,
    instance: record.instance ?? 0,
    destroyedAt: nowIso(),
  };
  await seam.bound.db.put(live.owner, "clapp-workspace-tombstones", tombstone);
  const receipt = await computer.execute(live.owner, {
    command: `rm -rf ${shellQuote(record.path)}`,
    cwd: "/workspace",
  });
  if (receipt.exitCode !== 0)
    throw new ClappRuntimeError(
      "workspaces",
      "destroy",
      `the sandbox removal for workspace "${id}" exited ${String(receipt.exitCode)}; the directory "${record.path}" may remain, but the workspace id is no longer registered or reusable`,
    );
}

/**
 * Registers a created workspace id into the durable `state` of every task
 * carrying the reconstruction, fenced by a compare-and-swap on the task's
 * current (status, leaseId) exactly like the tasks provider's own
 * checkpoints, so recovery can find the workspace from stage state too.
 */
async function registerWorkspaceInStageState(
  bound: BoundHandles,
  reconstructionId: string,
  kind: "reference" | "candidate",
  entry: { id: string; path: string; instance: number; createdAt: string },
): Promise<void> {
  const rows = (await bound.db.scan("tasks")).filter(
    ({ value }) =>
      isObject(value.input) &&
      (value.input as Record<string, unknown>).reconstructionId === reconstructionId,
  );
  if (rows.length === 0)
    throw new ClappRuntimeError(
      "workspaces",
      "reconstruction",
      `no durable OpenMuse task carries reconstructionId "${reconstructionId}"; the workspace registration has nowhere to land`,
    );
  let landed = 0;
  for (const { owner, value } of rows) {
    const taskId = typeof value.id === "string" ? value.id : String(value.id);
    const state = isObject(value.state) ? value.state : {};
    const existing = isObject(state.clappWorkspaces) ? state.clappWorkspaces : {};
    const merged = { ...existing, [kind]: entry };
    const updated = await bound.db.compareAndSwap(
      owner,
      "tasks",
      taskId,
      { id: value.id, status: value.status, leaseId: value.leaseId ?? null },
      { state: { ...state, clappWorkspaces: merged } },
    );
    if (updated !== null && updated !== undefined) landed += 1;
  }
  if (landed === 0)
    throw new ClappRuntimeError(
      "workspaces",
      "stage-state",
      `every task for reconstruction "${reconstructionId}" changed before the workspace registration landed; nothing was written`,
    );
}

/** Resolves the owning workspace owner for a reconstruction (fails closed). */
async function resolveSeamOwner(
  seam: CandidateSeamContext,
  reconstructionId: string,
  provider: string,
): Promise<string> {
  const rows = (await seam.bound.db.scan("tasks")).filter(
    ({ value }) =>
      isObject(value.input) &&
      (value.input as Record<string, unknown>).reconstructionId === reconstructionId,
  );
  if (rows.length === 0)
    throw new ClappRuntimeError(
      provider,
      "reconstruction",
      `no durable OpenMuse task carries reconstructionId "${reconstructionId}"; the owning workspace cannot be resolved`,
    );
  rows.sort((a, b) =>
    String(b.value.updatedAt ?? "").localeCompare(String(a.value.updatedAt ?? "")),
  );
  return rows[0].owner;
}

/**
 * Seeds one candidate file into a workspace. Content above the chunk limit is
 * split into chunks that each stay under the substrate's 256 KB write limit,
 * reassembled by bounded `cat` commands, verified against the intended
 * content digest with `sha256sum`, and the temporary parts are removed. Every
 * composed command is idempotent under a key derived from the command itself,
 * so an interrupted seed replays its durable receipts instead of re-running.
 */
export async function candidateSeedFile(
  seam: CandidateSeamContext,
  input: CandidateSeedFileInput,
): Promise<CandidateSeedResult> {
  const computer = requireComputer(seam);
  const { reconstructionId, workspaceId, content } = input;
  requireText(reconstructionId, "candidate", "reconstructionId", "reconstructionId");
  requireText(workspaceId, "candidate", "workspaceId", "workspaceId");
  const segments = requireRelativeSegments(input.path, "candidate", "seed", "path");
  if (typeof content !== "string")
    throw new ClappRuntimeError(
      "candidate",
      "seed",
      `content must be a string; received ${typeof content}`,
    );
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > seam.configuration.maxSeedBytes)
    throw new ClappRuntimeError(
      "candidate",
      "seed",
      `content is ${bytes} bytes, above the configured maxSeedBytes of ${seam.configuration.maxSeedBytes}; refusing an unbounded seed`,
    );
  const { owner, record } = await findLiveWorkspace(seam, reconstructionId, workspaceId);
  const target = `${record.path}/${segments.join("/")}`;
  const write = computer.write;
  if (typeof write !== "function")
    throw new ClappRuntimeError(
      "computer",
      "write",
      `the computer handle is missing the "write" capability needed to seed "${target}"; bind fails closed`,
    );
  // The substrate's write requires the target's parent directory to exist;
  // its recursive mkdir is idempotent, so creating it is always safe.
  const parentDirectory = target.slice(0, target.lastIndexOf("/"));
  try {
    await computer.mkdir(owner, parentDirectory);
  } catch (error) {
    throw new ClappRuntimeError(
      "candidate",
      "seed",
      `the computer handle could not create the seed directory "${parentDirectory}": ${describeError(error)}`,
      { cause: error },
    );
  }
  if (bytes <= seam.configuration.maxChunkBytes) {
    try {
      await write.call(computer, owner, target, content);
    } catch (error) {
      throw new ClappRuntimeError(
        "candidate",
        "seed",
        `the computer handle rejected the seed write for "${target}": ${describeError(error)}`,
        { cause: error },
      );
    }
    return { path: target, bytes, chunks: 1 };
  }
  const chunks = chunkTextContent(content, seam.configuration.maxChunkBytes);
  const contentDigest = sha256Hex(content);
  // Parts live under the shared CLAPP root, OUTSIDE the workspace directory,
  // so a chunked seed never leaves temporary state inside the candidate tree
  // that W3-002 materializes and verifies. The hash-specific directory keeps
  // concurrent seeds of different content independent.
  const partsDirectory = `${CLAPP_WORKSPACE_ROOT}/.clapp-parts/${workspaceId}/${contentDigest.slice(0, 16)}`;
  const parts = chunks.map(
    (_, index) => `${partsDirectory}/part-${String(index).padStart(6, "0")}`,
  );
  try {
    await computer.mkdir(owner, partsDirectory);
  } catch (error) {
    throw new ClappRuntimeError(
      "candidate",
      "seed",
      `the computer handle could not create the parts directory "${partsDirectory}": ${describeError(error)}`,
      { cause: error },
    );
  }
  for (const [index, chunk] of chunks.entries()) {
    try {
      await write.call(computer, owner, parts[index], chunk);
    } catch (error) {
      throw new ClappRuntimeError(
        "candidate",
        "seed",
        `chunk ${index} of "${input.path}" could not be written to the parts directory: ${describeError(error)}`,
        { cause: error },
      );
    }
  }
  const batches = composeCatBatches(parts, target);
  for (const batch of batches) {
    const receipt = await computer.execute(
      owner,
      {
        command: batch.command,
        cwd: "/workspace",
      },
      { idempotencyKey: seedCommandKey(reconstructionId, batch.command) },
    );
    if (
      receipt.exitCode !== 0 ||
      receipt.status === "interrupted" ||
      receipt.status === "timed_out"
    )
      throw new ClappRuntimeError(
        "candidate",
        "seed",
        `the reassembly of "${input.path}" exited ${String(receipt.exitCode)} (${receipt.status}); the parts directory "${partsDirectory}" remains for inspection`,
      );
  }
  const verify = await computer.execute(
    owner,
    {
      command: `sha256sum ${shellQuote(target)}`,
      cwd: "/workspace",
    },
    { idempotencyKey: seedCommandKey(reconstructionId, `sha256sum ${shellQuote(target)}`) },
  );
  if (verify.exitCode !== 0)
    throw new ClappRuntimeError(
      "candidate",
      "seed",
      `the integrity digest of "${target}" could not be read (exit ${String(verify.exitCode)})`,
    );
  const actual = verify.stdout.trim().split(/\s+/)[0];
  if (actual !== contentDigest)
    throw new ClappRuntimeError(
      "candidate",
      "seed",
      `the reassembled file "${target}" digests to "${actual}" instead of "${contentDigest}"; refusing to claim the seed succeeded`,
    );
  const cleanup = await computer.execute(
    owner,
    {
      command: `rm -rf ${shellQuote(partsDirectory)}`,
      cwd: "/workspace",
    },
    { idempotencyKey: seedCommandKey(reconstructionId, `rm -rf ${shellQuote(partsDirectory)}`) },
  );
  if (cleanup.exitCode !== 0)
    throw new ClappRuntimeError(
      "candidate",
      "seed",
      `the temporary parts of "${input.path}" could not be removed (exit ${String(cleanup.exitCode)}); the seeded file itself is verified`,
    );
  return { path: target, bytes, chunks: chunks.length };
}

/** Deterministic idempotency key for one composed seed command. */
function seedCommandKey(reconstructionId: string, command: string): string {
  return sha256Hex(`clapp-seed:${reconstructionId}:${command}`);
}

/**
 * Bounded recursive listing of a workspace. One substrate `list` per
 * directory, symlinks recorded but never followed, and hard budgets on
 * directories visited and entries returned: a workspace that exceeds the
 * budget fails closed with a typed error instead of an unbounded walk.
 */
export async function candidateListWorkspaceFiles(
  seam: CandidateSeamContext,
  input: CandidateWorkspaceFilesInput,
): Promise<CandidateWorkspaceFile[]> {
  const computer = requireComputer(seam);
  requireText(input.reconstructionId, "candidate", "reconstructionId", "reconstructionId");
  requireText(input.workspaceId, "candidate", "workspaceId", "workspaceId");
  const { owner, record } = await findLiveWorkspace(
    seam,
    input.reconstructionId,
    input.workspaceId,
  );
  const entries: CandidateWorkspaceFile[] = [];
  const queue: string[] = [record.path];
  let listed = 0;
  while (queue.length > 0) {
    if (listed >= CANDIDATE_LIST_DIRECTORY_BUDGET)
      throw new ClappRuntimeError(
        "candidate",
        "list",
        `the workspace "${record.path}" exceeds the bounded listing budget of ${CANDIDATE_LIST_DIRECTORY_BUDGET} directories; prune the workspace or list a subdirectory`,
      );
    const directory = queue.shift();
    if (directory === undefined) break;
    listed += 1;
    const found = await listDirectory(computer, owner, directory, "candidate");
    for (const entry of found) {
      if (entries.length >= seam.configuration.listEntryBudget)
        throw new ClappRuntimeError(
          "candidate",
          "list",
          `the workspace "${record.path}" exceeds the bounded listing budget of ${seam.configuration.listEntryBudget} entries`,
        );
      entries.push({
        path: entry.path.slice(record.path.length + 1),
        name: entry.name,
        type: entry.type,
        size: entry.size,
      });
      if (entry.type === "directory") queue.push(entry.path);
    }
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return entries;
}

/**
 * Restart-safe workspace discovery for one reconstruction: lists the
 * deterministic parent directory through the substrate and reconstructs ids
 * from the path scheme alone. No in-memory state is consulted. Registry and
 * tombstone records only ENRICH the result (registered/tombstoned flags), so
 * a directory created in the crash window between `mkdir` and the registry
 * write is still discovered.
 */
export async function candidateDiscoverWorkspaces(
  seam: CandidateSeamContext,
  input: CandidateDiscoverInput,
): Promise<CandidateWorkspaceSummary[]> {
  const computer = requireComputer(seam);
  const reconstructionId = requireText(
    input.reconstructionId,
    "candidate",
    "reconstructionId",
    "reconstructionId",
  );
  const owner = await resolveSeamOwner(seam, reconstructionId, "candidate");
  const entries = await listWorkspaceParent(computer, owner, workspaceParent(reconstructionId));
  const registry = await seam.bound.db.get(
    owner,
    "clapp-workspaces",
    `${reconstructionId}:candidate`,
  );
  const referenceRegistry = await seam.bound.db.get(
    owner,
    "clapp-workspaces",
    `${reconstructionId}:reference`,
  );
  const tombstones = (await seam.bound.db.scan("clapp-workspace-tombstones"))
    .filter(({ owner: tombstoneOwner }) => tombstoneOwner === owner)
    .map(({ value }) => value as unknown as WorkspaceTombstoneRecord)
    .filter((record) => record.reconstructionId === reconstructionId);
  const summaries: CandidateWorkspaceSummary[] = [];
  for (const entry of entries) {
    if (entry.type !== "directory") continue;
    const parsed = parseWorkspaceEntry(entry.name);
    if (!WORKSPACE_ENTRY_PATTERN.test(entry.name)) continue;
    const registeredRecord =
      parsed.kind === "candidate"
        ? (registry as unknown as WorkspaceIndexRecord | null)
        : (referenceRegistry as unknown as WorkspaceIndexRecord | null);
    const registered =
      registeredRecord !== null &&
      registeredRecord !== undefined &&
      registeredRecord.path === entry.path &&
      registeredRecord.workspaceId === workspaceIdOf(entry.path);
    const tombstoned = tombstones.some(
      (record) => record.path === entry.path && record.kind === parsed.kind,
    );
    summaries.push({
      id: workspaceIdOf(entry.path),
      path: entry.path,
      kind: parsed.kind,
      instance: parsed.instance,
      registered,
      tombstoned,
    });
  }
  summaries.sort((a, b) => a.kind.localeCompare(b.kind) || a.instance - b.instance);
  return summaries;
}

/**
 * Harvests produced workspace files through the artifact provider. Every path
 * either becomes a stored artifact id or an honest per-path failure; nothing
 * is silently dropped. The OpenMuse files service stores PDF documents in
 * v0.1, so non-PDF outputs surface as typed failures here rather than being
 * guessed into the store.
 */
export async function candidateHarvestWorkspaceArtifacts(
  seam: CandidateSeamContext,
  input: CandidateHarvestInput,
): Promise<CandidateHarvestOutcome> {
  const computer = requireComputer(seam);
  const { reconstructionId, workspaceId, targetId, paths } = input;
  requireText(reconstructionId, "candidate", "reconstructionId", "reconstructionId");
  requireText(workspaceId, "candidate", "workspaceId", "workspaceId");
  requireText(targetId, "candidate", "targetId", "targetId");
  if (!Array.isArray(paths) || paths.length === 0)
    throw new ClappRuntimeError(
      "candidate",
      "harvest",
      "paths must be a non-empty array of workspace-relative paths",
    );
  const read = computer.read;
  if (typeof read !== "function")
    throw new ClappRuntimeError(
      "computer",
      "read",
      `the computer handle is missing the "read" capability needed to harvest workspace files; bind fails closed`,
    );
  const { owner, record } = await findLiveWorkspace(seam, reconstructionId, workspaceId);
  const artifacts: string[] = [];
  const failures: CandidateHarvestFailure[] = [];
  for (const rawPath of paths) {
    const segments = requireRelativeSegments(rawPath, "candidate", "harvest", "harvest path");
    const target = `${record.path}/${segments.join("/")}`;
    try {
      const file = await read.call(computer, owner, target);
      const bytes = new TextEncoder().encode(file.text);
      const reference = await seam.artifacts.put({
        reconstructionId,
        kind: "candidate-output",
        bytes,
        metadata: {
          targetId,
          source: `openmuse:workspace:${workspaceId}`,
          classification: "derived",
        },
      });
      artifacts.push(reference.id);
    } catch (error) {
      failures.push({ path: segments.join("/"), reason: describeError(error) });
    }
  }
  return { artifacts, failures };
}

/** Containment check: a cwd must be a workspace path or live inside it. */
export function isInsideDirectory(cwd: string, directory: string): boolean {
  return cwd === directory || (cwd.startsWith(`${directory}/`) && cwd.length > directory.length);
}

/**
 * The frozen ExecutionProvider contract extended with the W1-003 candidate
 * seam: build/test command composition and produced-artifact harvesting. The
 * seam methods exist on every runtime the adapter produces; without the
 * candidate options they fail closed with a typed not-configured error at
 * call time.
 */
export interface CandidateExecutionProvider extends ExecutionProvider {
  /**
   * Composes and runs the candidate build (and, when it succeeds, the test)
   * as bounded, idempotent execution-provider runs. A non-zero exit code is
   * a recorded step result, never an exception; the test step is honestly
   * skipped when the build fails.
   */
  runCandidateBuild(
    input: CandidateBuildInput,
    signal?: AbortSignal,
  ): Promise<CandidateBuildOutcome>;
  /** Harvests produced workspace files through the artifact provider. */
  harvestWorkspaceArtifacts(input: CandidateHarvestInput): Promise<CandidateHarvestOutcome>;
}

/**
 * The frozen WorkspaceProvider contract extended with the W1-003 candidate
 * seam: chunked seeding, bounded listing and restart-safe discovery. The seam
 * methods exist on every runtime the adapter produces; without the candidate
 * options they fail closed with a typed not-configured error at call time.
 */
export interface CandidateWorkspaceProvider extends WorkspaceProvider {
  /**
   * Seeds one file into a workspace, splitting content above the substrate's
   * 256 KB write limit into chunks and reassembling via a bounded command.
   */
  seedWorkspaceFile(input: CandidateSeedFileInput): Promise<CandidateSeedResult>;
  /** Bounded recursive listing of workspace contents. */
  listWorkspaceFiles(input: CandidateWorkspaceFilesInput): Promise<CandidateWorkspaceFile[]>;
  /**
   * Restart-safe discovery of live workspace directories by the deterministic
   * path scheme alone — no in-memory state is consulted.
   */
  discoverWorkspaces(input: CandidateDiscoverInput): Promise<CandidateWorkspaceSummary[]>;
}
