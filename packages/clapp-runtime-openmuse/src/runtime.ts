import { createHash, randomUUID } from "node:crypto";
import type {
  ApprovalProvider,
  ArtifactProvider,
  EvidenceBundle,
  EvidenceClassification,
  EvidenceRef,
  ExecutionProvider,
  ObservationProvider,
  ReconstructionSpec,
  TaskProvider,
  WorkspaceProvider,
} from "@clapp/contracts";
import { ClappHandleNotProvidedError, ClappRuntimeError, describeError } from "./errors.ts";
import type { BoundHandles, ClappBrowserSessionHandle, ClappComputerHandle } from "./handles.ts";
import { bindHandles } from "./handles.ts";

export interface OpenMuseRuntime {
  observation: ObservationProvider;
  execution: ExecutionProvider;
  artifacts: ArtifactProvider;
  tasks: TaskProvider;
  approvals: ApprovalProvider;
  workspaces: WorkspaceProvider;
}

/**
 * Adapter factory implemented in the OpenMuse integration layer.
 * Kept framework-free so CLAPP core never imports OpenMuse server classes.
 *
 * Handles are untyped; they are duck-typed at bind time against the narrow
 * structural interfaces declared in `handles.ts`. The `db` handle is required;
 * the other four are explicitly optional and their providers fail closed with
 * a typed "not provided" error at call time when absent.
 */
export interface OpenMuseRuntimeDependencies {
  browserSession: unknown;
  computer: unknown;
  files: unknown;
  agent: unknown;
  db: unknown;
}

const EVIDENCE_CLASSIFICATIONS: EvidenceClassification[] = [
  "observed",
  "derived",
  "inferred",
  "assumed",
  "unavailable",
];
/** The OpenMuse computer kills every command after 30 seconds. */
const COMPUTER_COMMAND_LIMIT_MS = 30_000;
const sha256Hex = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const nowIso = () => new Date().toISOString();

/** Durable task snapshot used for owner discovery and reconcile reads. */
interface TaskRow {
  owner: string;
  value: {
    id: string;
    status: string;
    leaseId?: string | null;
    updatedAt?: string;
    state?: Record<string, unknown>;
    input?: Record<string, unknown>;
  };
}

function asTaskRows(rows: { owner: string; value: Record<string, unknown> }[]): TaskRow[] {
  return rows.map(({ owner, value }) => ({ owner, value: value as TaskRow["value"] }));
}

function inputOf(value: TaskRow["value"]): Record<string, unknown> {
  const input = value.input;
  return typeof input === "object" && input !== null ? input : {};
}

/** Finds every durable task that carries a CLAPP input for a reconstruction. */
async function locateTasks(bound: BoundHandles, reconstructionId: string): Promise<TaskRow[]> {
  return asTaskRows(await bound.db.scan("tasks")).filter(
    ({ value }) => inputOf(value).reconstructionId === reconstructionId,
  );
}

/**
 * Resolves the owning workspace for a reconstruction. The frozen v0.1 provider
 * contracts carry no owner parameter, so ownership is discovered from the
 * durable task that carries the reconstruction. Fails closed when no task
 * exists.
 */
async function resolveOwner(bound: BoundHandles, reconstructionId: string, provider: string) {
  const rows = await locateTasks(bound, reconstructionId);
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

function requireText(value: unknown, provider: string, capability: string, label: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new ClappRuntimeError(
      provider,
      capability,
      `${label} must be a non-empty string; received ${typeof value}`,
    );
  return value;
}

function makeTaskProvider(bound: BoundHandles): TaskProvider {
  return {
    /**
     * Merges a CLAPP-owned patch into the durable `state` of every task that
     * carries the reconstruction. Each write is fenced by a compare-and-swap
     * on the task's current (status, leaseId) so it never stompss an owner
     * transition that happened after the read. Patch keys are CLAPP-owned
     * state keys; OpenMuse's own state keys are left untouched.
     */
    async checkpoint(reconstructionId, patch) {
      const rows = await locateTasks(bound, reconstructionId);
      if (rows.length === 0)
        throw new ClappRuntimeError(
          "tasks",
          "reconstruction",
          `no durable OpenMuse task carries reconstructionId "${reconstructionId}"; the checkpoint has nowhere to land`,
        );
      let landed = 0;
      for (const { owner, value } of rows) {
        const state = typeof value.state === "object" && value.state !== null ? value.state : {};
        const updated = await bound.db.compareAndSwap(
          owner,
          "tasks",
          value.id,
          { id: value.id, status: value.status, leaseId: value.leaseId ?? null },
          { state: { ...state, ...patch } },
        );
        if (updated !== null && updated !== undefined) landed += 1;
      }
      if (landed === 0)
        throw new ClappRuntimeError(
          "tasks",
          "checkpoint",
          `every task for reconstruction "${reconstructionId}" changed before the checkpoint landed; nothing was written`,
        );
    },
    /**
     * Appends a durable RunEvent shaped exactly like the OpenMuse task
     * worker's own events (id, taskId, date, kind, title, detail) onto every
     * task that carries the reconstruction at the given stage. CLAPP stage
     * progress maps onto the closed-union kind "step".
     */
    async event(reconstructionId, stage, title, detail = "") {
      const rows = await locateTasks(bound, reconstructionId);
      const staged = rows.filter(({ value }) => inputOf(value).stage === stage);
      if (staged.length === 0)
        throw new ClappRuntimeError(
          "tasks",
          "reconstruction",
          `no durable OpenMuse task carries reconstructionId "${reconstructionId}" at stage "${stage}"; the event has no task to attach to`,
        );
      for (const { owner, value } of staged) {
        // Shaped exactly like the substrate task worker's own durable events.
        const record: {
          id: string;
          taskId: string;
          date: string;
          kind: string;
          title: string;
          detail: string;
        } = {
          id: randomUUID(),
          taskId: value.id,
          date: nowIso(),
          kind: "step",
          title,
          detail,
        };
        await bound.db.put(owner, "run-events", record);
      }
    },
  };
}

interface ArtifactIndexRecord extends EvidenceRef {
  fileId: string;
}

function evidenceRefOf(record: ArtifactIndexRecord): EvidenceRef {
  return {
    id: record.id,
    targetId: record.targetId,
    reconstructionId: record.reconstructionId,
    kind: record.kind,
    sha256: record.sha256,
    source: record.source,
    capturedAt: record.capturedAt,
    classification: record.classification,
    redacted: record.redacted,
  };
}

function makeArtifactProvider(bound: BoundHandles): ArtifactProvider {
  return {
    /**
     * Stores bytes content-addressed through the OpenMuse files handle. The
     * returned EvidenceRef.sha256 is always computed from the actual bytes
     * (never trusted from metadata) and doubles as the artifact id, so
     * re-putting identical bytes is idempotent. The OpenMuse files service
     * stores PDF documents in v0.1; other bytes are rejected with a typed
     * error instead of being guessed into the store.
     */
    async put(input) {
      if (!bound.files) throw new ClappHandleNotProvidedError("artifacts", "files");
      const { reconstructionId, bytes, metadata } = input;
      const kind = requireText(input.kind, "artifacts", "kind", "artifact kind");
      requireText(reconstructionId, "artifacts", "reconstructionId", "reconstructionId");
      if (!(bytes instanceof Uint8Array) || bytes.length === 0)
        throw new ClappRuntimeError(
          "artifacts",
          "bytes",
          "artifact bytes must be a non-empty Uint8Array of genuinely captured content",
        );
      if (typeof metadata !== "object" || metadata === null)
        throw new ClappRuntimeError("artifacts", "metadata", "metadata must be an object");
      for (const [key, value] of Object.entries(metadata))
        if (typeof value !== "string")
          throw new ClappRuntimeError(
            "artifacts",
            "metadata",
            `metadata value for "${key}" must be a string; received ${typeof value}`,
          );
      const targetId = requireText(
        metadata.targetId,
        "artifacts",
        "targetId",
        "metadata.targetId (the EvidenceRef target)",
      );
      let classification: EvidenceClassification = "observed";
      if (metadata.classification !== undefined) {
        if (!EVIDENCE_CLASSIFICATIONS.includes(metadata.classification as EvidenceClassification))
          throw new ClappRuntimeError(
            "artifacts",
            "classification",
            `metadata.classification "${metadata.classification}" is not one of ${EVIDENCE_CLASSIFICATIONS.join(", ")}`,
          );
        classification = metadata.classification as EvidenceClassification;
      }
      let redacted = false;
      if (metadata.redacted !== undefined) {
        if (metadata.redacted !== "true" && metadata.redacted !== "false")
          throw new ClappRuntimeError(
            "artifacts",
            "redacted",
            `metadata.redacted must be "true" or "false"; received "${metadata.redacted}"`,
          );
        redacted = metadata.redacted === "true";
      }
      const source = metadata.source ?? "openmuse:files";
      const sha256 = sha256Hex(bytes);
      const owner = await resolveOwner(bound, reconstructionId, "artifacts");
      const existing = await bound.db.get(owner, "clapp-artifacts", sha256);
      if (existing !== null && existing !== undefined) {
        const record = existing as unknown as ArtifactIndexRecord;
        if (record.fileId) return evidenceRefOf(record);
      }
      let fileId: string;
      try {
        const stored = await bound.files.import(
          owner,
          `${kind}-${sha256.slice(0, 12)}.pdf`,
          bytes,
          `clapp:${reconstructionId}`,
        );
        fileId = stored.id;
      } catch (error) {
        throw new ClappRuntimeError(
          "artifacts",
          "import",
          `the OpenMuse files handle rejected the bytes for reconstruction "${reconstructionId}" (it stores PDF documents in v0.1): ${describeError(error)}`,
          { cause: error },
        );
      }
      const record: ArtifactIndexRecord = {
        id: sha256,
        targetId,
        reconstructionId,
        kind,
        sha256,
        source,
        capturedAt: nowIso(),
        classification,
        redacted,
        fileId,
      };
      await bound.db.put(owner, "clapp-artifacts", record);
      return evidenceRefOf(record);
    },
    /** Retrieves stored bytes by content id. Content addressing makes every stored copy of an id byte-identical. */
    async get(id) {
      if (!bound.files) throw new ClappHandleNotProvidedError("artifacts", "files");
      requireText(id, "artifacts", "get", "artifact id");
      const rows = await bound.db.scan("clapp-artifacts");
      const match = rows.find(({ value }) => value.id === id);
      if (!match)
        throw new ClappRuntimeError(
          "artifacts",
          "get",
          `no CLAPP artifact is stored under content id "${id}"`,
        );
      const record = match.value as unknown as ArtifactIndexRecord;
      return bound.files.bytes(match.owner, record.fileId);
    },
  };
}

function makeObservationProvider(bound: BoundHandles): ObservationProvider {
  const unavailableRef = (
    spec: ReconstructionSpec,
    channel: string,
    entrypoint: string,
    reason: string,
  ): EvidenceRef => {
    const manifest = JSON.stringify({ channel, entrypoint, reason });
    const digest = sha256Hex(manifest);
    return {
      id: digest,
      targetId: spec.targetId,
      reconstructionId: spec.reconstructionId,
      kind: channel,
      sha256: digest,
      source: entrypoint,
      capturedAt: nowIso(),
      classification: "unavailable",
      redacted: false,
    };
  };
  const observedRef = (
    spec: ReconstructionSpec,
    channel: string,
    entrypoint: string,
    bytes: Uint8Array,
  ): EvidenceRef => {
    const digest = sha256Hex(bytes);
    return {
      id: digest,
      targetId: spec.targetId,
      reconstructionId: spec.reconstructionId,
      kind: channel,
      sha256: digest,
      source: entrypoint,
      capturedAt: nowIso(),
      classification: "observed",
      redacted: false,
    };
  };
  return {
    /**
     * Requests evidence channels for every spec entrypoint through the
     * browserSession handle. Honesty rule: a channel the handle cannot
     * produce — because the capability is absent or the channel call failed —
     * is returned in the bundle classified "unavailable", never "observed".
     * W1 computes real content digests for captured channels but does not yet
     * persist the bytes (Phase 2 / CLAPP-W1-002 owns durable evidence
     * storage); the bundle environment records this.
     */
    async observe(spec, signal) {
      if (!bound.browserSession)
        throw new ClappHandleNotProvidedError("observation", "browserSession");
      signal?.throwIfAborted();
      requireText(spec.reconstructionId, "observation", "spec", "spec.reconstructionId");
      requireText(spec.targetId, "observation", "spec", "spec.targetId");
      requireText(spec.authorization?.ownerId, "observation", "spec", "spec.authorization.ownerId");
      if (!Array.isArray(spec.entrypoints) || spec.entrypoints.length === 0)
        throw new ClappRuntimeError(
          "observation",
          "spec",
          "spec.entrypoints must list at least one entrypoint to observe",
        );
      const owner = spec.authorization.ownerId;
      const handle: ClappBrowserSessionHandle = bound.browserSession;
      const refs: EvidenceRef[] = [];
      for (const entrypoint of spec.entrypoints) {
        signal?.throwIfAborted();
        if (typeof entrypoint !== "string" || entrypoint.trim() === "")
          throw new ClappRuntimeError(
            "observation",
            "spec",
            "spec.entrypoints must contain non-empty URL strings",
          );
        let page: Awaited<ReturnType<ClappBrowserSessionHandle["observe"]>> | undefined;
        try {
          page = await handle.observe(owner, entrypoint);
        } catch (error) {
          refs.push(
            unavailableRef(
              spec,
              "page-text",
              entrypoint,
              `the browserSession handle could not observe the entrypoint: ${describeError(error)}`,
            ),
          );
        }
        if (!page) continue;
        refs.push(
          observedRef(
            spec,
            "page-text",
            entrypoint,
            new TextEncoder().encode(`${page.title}\n${page.text}`),
          ),
        );
        const preview = handle.preview;
        if (typeof preview !== "function") {
          refs.push(
            unavailableRef(
              spec,
              "screenshot",
              entrypoint,
              "the browserSession handle does not provide the preview capability",
            ),
          );
          continue;
        }
        try {
          const response = await preview.call(handle, owner, page.sessionId);
          refs.push(
            observedRef(
              spec,
              "screenshot",
              entrypoint,
              new Uint8Array(await response.arrayBuffer()),
            ),
          );
        } catch (error) {
          refs.push(
            unavailableRef(
              spec,
              "screenshot",
              entrypoint,
              `the browserSession handle could not capture a screenshot: ${describeError(error)}`,
            ),
          );
        }
      }
      refs.sort((a, b) => a.id.localeCompare(b.id));
      const rootSha256 = sha256Hex(
        JSON.stringify(refs.map((r) => [r.id, r.sha256, r.classification])),
      );
      const bundle: EvidenceBundle = {
        id: `clapp-bundle:${rootSha256}`,
        targetId: spec.targetId,
        reconstructionId: spec.reconstructionId,
        environment: {
          runtime: "@clapp/runtime-openmuse",
          substrate: "openmuse",
          specVersion: spec.specVersion,
          entrypoints: spec.entrypoints,
          channels: ["page-text", "screenshot"],
          persisted: false,
        },
        refs,
        rootSha256,
      };
      return bundle;
    },
  };
}

function makeExecutionProvider(bound: BoundHandles): ExecutionProvider {
  return {
    /**
     * Runs a command in the OpenMuse sandbox computer, honoring the exact
     * input semantics that the sandbox can express and failing closed on the
     * ones it cannot: the sandbox is network-isolated ("deny" only) and kills
     * every command after 30 seconds. Non-zero exit codes (including the
     * 124 timeout and 137 interruption conventions) are results, not
     * exceptions. Produced-file reporting is empty in W1 because the computer
     * receipt does not enumerate per-command file outputs.
     */
    async run(input, signal) {
      if (!bound.computer) throw new ClappHandleNotProvidedError("execution", "computer");
      const { reconstructionId, command, cwd, timeoutMs, network } = input;
      requireText(reconstructionId, "execution", "reconstructionId", "reconstructionId");
      requireText(command, "execution", "command", "command");
      requireText(cwd, "execution", "cwd", "cwd");
      if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0)
        throw new ClappRuntimeError(
          "execution",
          "timeoutMs",
          `timeoutMs must be a positive finite number; received ${String(timeoutMs)}`,
        );
      if (network !== "deny" && network !== "allowlist" && network !== "full")
        throw new ClappRuntimeError(
          "execution",
          "network",
          `network must be "deny", "allowlist" or "full"; received ${String(network)}`,
        );
      if (network !== "deny")
        throw new ClappRuntimeError(
          "execution",
          "network",
          `the OpenMuse computer sandbox is network-isolated and cannot honor network "${network}"; only "deny" is supported in v0.1`,
        );
      if (timeoutMs > COMPUTER_COMMAND_LIMIT_MS)
        throw new ClappRuntimeError(
          "execution",
          "timeoutMs",
          `the OpenMuse computer kills commands after ${COMPUTER_COMMAND_LIMIT_MS}ms and cannot honor timeoutMs ${timeoutMs}ms`,
        );
      signal?.throwIfAborted();
      const owner = await resolveOwner(bound, reconstructionId, "execution");
      const controller = new AbortController();
      let timedOutByProvider = false;
      const timer = setTimeout(() => {
        timedOutByProvider = true;
        controller.abort();
      }, timeoutMs);
      const onCallerAbort = () => controller.abort();
      signal?.addEventListener("abort", onCallerAbort);
      let receipt: Awaited<ReturnType<NonNullable<ClappComputerHandle["execute"]>>>;
      try {
        receipt = await bound.computer.execute(
          owner,
          { command, cwd },
          { signal: controller.signal },
        );
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onCallerAbort);
      }
      const stdout = typeof receipt.stdout === "string" ? receipt.stdout : "";
      const stderr = typeof receipt.stderr === "string" ? receipt.stderr : "";
      let exitCode: number;
      if (typeof receipt.exitCode === "number") exitCode = receipt.exitCode;
      else if (receipt.status === "succeeded") exitCode = 0;
      else if (timedOutByProvider || receipt.status === "timed_out") exitCode = 124;
      else exitCode = 137;
      const notes =
        timedOutByProvider && exitCode === 124
          ? [`command exceeded the requested ${timeoutMs}ms and was aborted`]
          : [];
      return {
        exitCode,
        stdout,
        stderr: [stderr, ...notes].filter(Boolean).join("\n"),
        artifacts: [],
      };
    },
  };
}

function makeApprovalProvider(bound: BoundHandles): ApprovalProvider {
  return {
    /**
     * Bridges to the OpenMuse approval surface through the agent handle. The
     * inherited handles expose no approval surface in v0.1 (the agent service
     * can notify but cannot express an approval without a live task
     * context), so this provider fails closed with a typed error and never
     * fabricates an approval id. A handle that grows a `requestApproval`
     * capability is bridged directly.
     */
    async request(input) {
      if (!bound.agent) throw new ClappHandleNotProvidedError("approvals", "agent");
      const { reconstructionId } = input;
      requireText(reconstructionId, "approvals", "reconstructionId", "reconstructionId");
      requireText(input.kind, "approvals", "kind", "approval kind");
      requireText(input.summary, "approvals", "summary", "approval summary");
      if (input.expiresAt !== undefined && Number.isNaN(Date.parse(input.expiresAt)))
        throw new ClappRuntimeError(
          "approvals",
          "expiresAt",
          `expiresAt must be an ISO-8601 timestamp; received "${input.expiresAt}"`,
        );
      const requestApproval = bound.agent.requestApproval;
      if (typeof requestApproval !== "function")
        throw new ClappRuntimeError(
          "approvals",
          "approval-expression",
          `the OpenMuse agent handle cannot express a CLAPP approval in v0.1 (notify only); refusing to fabricate an approval id for reconstruction "${reconstructionId}"`,
        );
      const owner = await resolveOwner(bound, reconstructionId, "approvals");
      const result = await requestApproval.call(bound.agent, owner, {
        kind: input.kind,
        summary: input.summary,
        ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
        reconstructionId,
      });
      const id = (result as { id?: unknown } | null)?.id;
      if (typeof id !== "string" || id.trim() === "")
        throw new ClappRuntimeError(
          "approvals",
          "approval-expression",
          `the agent handle returned no usable approval id for reconstruction "${reconstructionId}"`,
        );
      return { id };
    },
  };
}

interface WorkspaceIndexRecord {
  id: string;
  workspaceId: string;
  reconstructionId: string;
  kind: "reference" | "candidate";
  path: string;
  createdAt: string;
}

function makeWorkspaceProvider(bound: BoundHandles): WorkspaceProvider {
  return {
    /**
     * Creates a sandbox workspace directory for a reconstruction. Repeated
     * creates while the workspace is alive return the same stable id; after a
     * destroy the registry entry is gone, so the next create allocates a
     * genuinely new id and never resurrects a destroyed one.
     */
    async create(input) {
      if (!bound.computer) throw new ClappHandleNotProvidedError("workspaces", "computer");
      const { reconstructionId } = input;
      requireText(reconstructionId, "workspaces", "reconstructionId", "reconstructionId");
      if (input.kind !== "reference" && input.kind !== "candidate")
        throw new ClappRuntimeError(
          "workspaces",
          "kind",
          `workspace kind must be "reference" or "candidate"; received ${String(input.kind)}`,
        );
      const owner = await resolveOwner(bound, reconstructionId, "workspaces");
      const registryId = `${reconstructionId}:${input.kind}`;
      const existing = await bound.db.get(owner, "clapp-workspaces", registryId);
      if (existing !== null && existing !== undefined) {
        const record = existing as unknown as WorkspaceIndexRecord;
        return { id: record.workspaceId, path: record.path };
      }
      const id = randomUUID();
      const path = `/workspace/clapp/${input.kind}-${id}`;
      let made: { path: string };
      try {
        made = await bound.computer.mkdir(owner, path);
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
        kind: input.kind,
        path,
        createdAt: nowIso(),
      };
      await bound.db.put(owner, "clapp-workspaces", record);
      return { id, path };
    },
    /**
     * Destroys a workspace by removing its registry entry first (so the id
     * stops being live) and then removing the sandbox directory. A failed
     * directory removal surfaces as a typed error; the orphaned directory
     * never re-enters the registry, so its id is never reused.
     */
    async destroy(id) {
      if (!bound.computer) throw new ClappHandleNotProvidedError("workspaces", "computer");
      requireText(id, "workspaces", "destroy", "workspace id");
      const rows = await bound.db.scan("clapp-workspaces");
      const match = rows.find(({ value }) => value.workspaceId === id);
      if (!match)
        throw new ClappRuntimeError(
          "workspaces",
          "destroy",
          `no CLAPP workspace is registered under id "${id}"`,
        );
      const record = match.value as unknown as WorkspaceIndexRecord;
      await bound.db.remove(match.owner, "clapp-workspaces", record.id);
      const receipt = await bound.computer.execute(match.owner, {
        command: `rm -rf '${record.path}'`,
        cwd: "/workspace",
      });
      if (receipt.exitCode !== 0)
        throw new ClappRuntimeError(
          "workspaces",
          "destroy",
          `the sandbox removal for workspace "${id}" exited ${String(receipt.exitCode)}; the directory "${record.path}" may remain, but the workspace id is no longer registered or reusable`,
        );
    },
  };
}

/** Binds the five untyped OpenMuse handles onto the six CLAPP providers. */
export function createOpenMuseRuntime(deps: OpenMuseRuntimeDependencies): OpenMuseRuntime {
  const bound = bindHandles(deps);
  return {
    observation: makeObservationProvider(bound),
    execution: makeExecutionProvider(bound),
    artifacts: makeArtifactProvider(bound),
    tasks: makeTaskProvider(bound),
    approvals: makeApprovalProvider(bound),
    workspaces: makeWorkspaceProvider(bound),
  };
}
