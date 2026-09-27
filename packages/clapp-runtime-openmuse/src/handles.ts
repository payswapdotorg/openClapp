import { ClappRuntimeError } from "./errors.ts";

/**
 * Narrow structural interfaces the adapter binds the five OpenMuse handles
 * onto. The adapter never imports OpenMuse server modules; it duck-types the
 * handles it receives. Each interface documents the capabilities a handle
 * must provide for the corresponding CLAPP provider to bind.
 *
 * Required handles (bind fails closed when absent or missing capabilities):
 * - `db` — durable record store used by the tasks provider and owner discovery.
 *
 * Explicitly-optional handles (bind succeeds when absent; the provider then
 * throws a typed "not provided" error at call time, never a silent no-op):
 * - `browserSession` — observation channels. Present handles must provide
 *   `observe`; the `preview` capability is optional and degrades to an
 *   `unavailable` evidence entry.
 * - `computer` — execution and workspaces. Present handles must provide
 *   `execute` and `mkdir`.
 * - `files` — artifact storage. Present handles must provide `import` and
 *   `bytes`.
 * - `agent` — approval surface. Present handles must provide `notify`; an
 *   optional `requestApproval` capability is used when present.
 */

/** Structural subset of the OpenMuse record store (in-process or Postgres). */
export interface ClappDbHandle {
  get(owner: string, kind: string, id: string): Promise<unknown>;
  scan(kind: string): Promise<{ owner: string; value: Record<string, unknown> }[]>;
  put(owner: string, kind: string, value: { id: string }): Promise<unknown>;
  compareAndSwap(
    owner: string,
    kind: string,
    id: string,
    expected: Record<string, unknown>,
    patch: Record<string, unknown>,
  ): Promise<unknown>;
  remove(owner: string, kind: string, id: string): Promise<void>;
}

/** Page observation result produced by the browserSession handle. */
export interface ClappBrowserPage {
  sessionId: string;
  url: string;
  title: string;
  text: string;
  truncated: boolean;
}

/** Structural subset of the OpenMuse browser service. */
export interface ClappBrowserSessionHandle {
  /** Required: page-text evidence channel for an entrypoint URL. */
  observe(owner: string, url: string, existingId?: string): Promise<ClappBrowserPage>;
  /** Optional: screenshot channel for an established session. */
  preview?(owner: string, sessionId: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> }>;
}

/** Durable command receipt produced by the computer handle. */
export interface ClappComputerReceipt {
  id: string;
  status: string;
  stdout: string;
  stderr: string;
  exitCode?: number | null;
  truncated?: boolean;
}

/** Structural subset of the OpenMuse computer service. */
export interface ClappComputerHandle {
  /** Required by the execution provider: run a sandboxed bash command. */
  execute(
    owner: string,
    raw: { command: string; cwd: string },
    options?: { idempotencyKey?: string; signal?: AbortSignal },
  ): Promise<ClappComputerReceipt>;
  /** Required by the workspaces provider: create a sandbox directory. */
  mkdir(owner: string, path: string): Promise<{ path: string }>;
}

/** Structural subset of the OpenMuse files service (PDF document store). */
export interface ClappFilesHandle {
  /** Required by the artifacts provider: store document bytes. */
  import(owner: string, name: string, bytes: Uint8Array, source: string): Promise<{ id: string }>;
  /** Required by the artifacts provider: read stored bytes back. */
  bytes(owner: string, id: string): Promise<Uint8Array>;
}

/** Structural subset of the OpenMuse agent service. */
export interface ClappAgentHandle {
  /** Required: durable owner notification surface. */
  notify(owner: string, title: string, body: string, taskId?: string, key?: string): Promise<void>;
  /** Optional: approval expression. Absent means approvals cannot be expressed. */
  requestApproval?(
    owner: string,
    input: { kind: string; summary: string; expiresAt?: string; reconstructionId: string },
  ): Promise<{ id: string }>;
}

/** Handles that survived bind-time validation. */
export interface BoundHandles {
  db: ClappDbHandle;
  browserSession?: ClappBrowserSessionHandle;
  computer?: ClappComputerHandle;
  files?: ClappFilesHandle;
  agent?: ClappAgentHandle;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requireCapabilities(
  handle: unknown,
  handleName: string,
  provider: string,
  capabilities: string[],
): Record<string, unknown> {
  if (!isObject(handle))
    throw new ClappRuntimeError(
      handleName,
      "handle",
      `the ${handleName} handle must be an object providing ${capabilities.join(", ")} for the ${provider} provider(s); received ${typeof handle}`,
    );
  for (const capability of capabilities)
    if (typeof handle[capability] !== "function")
      throw new ClappRuntimeError(
        handleName,
        capability,
        `the ${handleName} handle is missing the required capability "${capability}" needed by the ${provider} provider(s); bind fails closed`,
      );
  return handle;
}

/**
 * Validates the five untyped handles at bind time. Absent optional handles
 * bind as `undefined`; their providers fail closed with a typed
 * "not provided" error at call time.
 */
export function bindHandles(deps: {
  browserSession: unknown;
  computer: unknown;
  files: unknown;
  agent: unknown;
  db: unknown;
}): BoundHandles {
  const db = requireCapabilities(deps.db, "db", "tasks", [
    "get",
    "scan",
    "put",
    "compareAndSwap",
    "remove",
  ]) as unknown as ClappDbHandle;
  const browserSession =
    deps.browserSession === undefined || deps.browserSession === null
      ? undefined
      : (requireCapabilities(deps.browserSession, "browserSession", "observation", [
          "observe",
        ]) as unknown as ClappBrowserSessionHandle);
  const computer =
    deps.computer === undefined || deps.computer === null
      ? undefined
      : (requireCapabilities(deps.computer, "computer", "execution and workspaces", [
          "execute",
          "mkdir",
        ]) as unknown as ClappComputerHandle);
  const files =
    deps.files === undefined || deps.files === null
      ? undefined
      : (requireCapabilities(deps.files, "files", "artifacts", [
          "import",
          "bytes",
        ]) as unknown as ClappFilesHandle);
  const agent =
    deps.agent === undefined || deps.agent === null
      ? undefined
      : (requireCapabilities(deps.agent, "agent", "approvals", [
          "notify",
        ]) as unknown as ClappAgentHandle);
  return { db, browserSession, computer, files, agent };
}
