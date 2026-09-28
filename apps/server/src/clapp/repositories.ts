import type {
  ClappTaskInput,
  EvidenceRef,
  ReconstructionSpec,
} from "../../../../packages/clapp-contracts/src/index.ts";
import type { AgentTask } from "../../../../packages/domain/src/agent.ts";
import type { Store } from "../db.ts";

/**
 * CLAPP-W1-007 — server-side CLAPP repositories.
 *
 * Owner-scoped, store-backed persistence for the CLAPP orchestration layer.
 * Everything here is a thin adapter over the substrate `Store` (the same
 * get/put/list/scan/compareAndSwap surface the engine uses) plus the durable
 * store kinds the `@clapp/runtime-openmuse` adapter owns:
 *
 * - `clapp-reconstructions` — one row per reconstruction
 *   `{ id, spec, createdAt, status }`, written by this module.
 * - `clapp-artifacts` — the artifact provider's content-addressed index
 *   (EvidenceRef plus the backing `fileId`), written by the runtime's
 *   artifact provider and read here for the run's artifact view.
 * - `tasks` — the substrate task chain itself; stage tasks are derived rows,
 *   never a second store (the W1-004 derivation contract).
 *
 * Typing is fail-closed: reads return `null`/honest shapes, never guesses;
 * not-found decisions are the service layer's (it owns the error mapping).
 */

/** The reconstruction record persisted under the `clapp-reconstructions` kind. */
export interface ClappReconstructionRow {
  /** Server-minted stable identity, `clapp_run_…` style. */
  id: string;
  /** The validated frozen spec, with its `reconstructionId` stamped to the row id. */
  spec: ReconstructionSpec;
  createdAt: string;
  /**
   * The service-lifecycle status: `active` from creation, `cancelled` when the
   * owner cancels the run. Stage-level truth always comes from the task chain
   * (W1-004's run state); this field never pretends to be it.
   */
  status: "active" | "cancelled";
}

/**
 * An artifact index record as the runtime's artifact provider writes it: the
 * frozen EvidenceRef plus the backing OpenMuse file id. The `fileId` lets the
 * route layer sign the substrate's content URL without re-reading bytes.
 */
export interface ClappArtifactRecord extends EvidenceRef {
  fileId: string;
}

/** The owner-scoped repository surface the CLAPP service consumes. */
export interface ClappRepositories {
  /** Persists a new reconstruction row (idempotent on the minted id). */
  create(owner: string, row: ClappReconstructionRow): Promise<ClappReconstructionRow>;
  /** Reads one reconstruction, owner-scoped; `null` when absent. */
  get(owner: string, id: string): Promise<ClappReconstructionRow | null>;
  /** Lists the owner's reconstruction rows (most recently updated first). */
  list(owner: string): Promise<ClappReconstructionRow[]>;
  /** Marks a reconstruction cancelled (owner intent; idempotent). */
  markCancelled(owner: string, id: string): Promise<void>;
  /**
   * The reconstruction's stage-task chain rows: the owner's tasks whose input
   * carries this reconstructionId. Derived — never a second store.
   */
  stageTasks(owner: string, reconstructionId: string): Promise<AgentTask[]>;
  /**
   * The reconstruction's artifact index records (the runtime artifact
   * provider's store), owner-scoped, in store order.
   */
  artifacts(owner: string, reconstructionId: string): Promise<ClappArtifactRecord[]>;
  /**
   * Cross-owner spec discovery by reconstructionId — the discovery idiom the
   * runtime adapter itself uses (its providers resolve owners the same way,
   * because the frozen v0.1 provider contracts carry no owner parameter).
   * Returns `null` when no reconstruction exists under that id.
   */
  findSpec(reconstructionId: string): Promise<ReconstructionSpec | null>;
}

const reconstructionInputId = (task: AgentTask): unknown =>
  (task.input as Record<string, unknown> | undefined)?.reconstructionId;

export function createClappRepositories(db: Store): ClappRepositories {
  return {
    async create(owner, row) {
      const existing = await db.insertIfAbsent(owner, "clapp-reconstructions", row);
      return existing ?? row;
    },
    async get(owner, id) {
      return db.get<ClappReconstructionRow>(owner, "clapp-reconstructions", id);
    },
    async list(owner) {
      return db.list<ClappReconstructionRow>(owner, "clapp-reconstructions");
    },
    async markCancelled(owner, id) {
      await db.compareAndSwap(
        owner,
        "clapp-reconstructions",
        id,
        { status: "active" },
        { status: "cancelled" },
      );
    },
    async stageTasks(owner, reconstructionId) {
      const tasks = await db.list<AgentTask>(owner, "tasks");
      return tasks.filter((task) => reconstructionInputId(task) === reconstructionId);
    },
    async artifacts(owner, reconstructionId) {
      const records = await db.list<ClappArtifactRecord>(owner, "clapp-artifacts");
      return records.filter((record) => record.reconstructionId === reconstructionId);
    },
    async findSpec(reconstructionId) {
      const rows = await db.scan<ClappReconstructionRow>("clapp-reconstructions");
      const match = rows.find(({ value }) => value.id === reconstructionId);
      return match ? match.value.spec : null;
    },
  };
}

/**
 * The CLAPP task input of a stage task, when its input is a valid
 * ClappTaskInput; `null` otherwise. Detection is by input shape only — the
 * W1-001 contract — and this helper never guesses: a half-shaped input is
 * reported as absent so the caller can treat it honestly (the run-state
 * derivation counts it as malformed instead of trusting it).
 */
export function clappInputOf(task: AgentTask): ClappTaskInput | null {
  const input = task.input as Record<string, unknown> | undefined;
  if (!input || typeof input !== "object") return null;
  if (input.specVersion !== "0.1") return null;
  if (typeof input.reconstructionId !== "string" || input.reconstructionId === "") return null;
  if (typeof input.stage !== "string") return null;
  return {
    specVersion: "0.1",
    reconstructionId: input.reconstructionId,
    stage: input.stage as ClappTaskInput["stage"],
  };
}
