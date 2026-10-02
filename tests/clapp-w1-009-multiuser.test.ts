import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
  ClappOperatorScopeError,
  createOperatorScopedClapp,
  type OperatorPackageStore,
  type OperatorScopedPackageRecord,
} from "../apps/server/src/clapp/multiuser.ts";
import {
  type ClappArtifactRecord,
  type ClappReconstructionRow,
  type ClappRepositories,
  createClappRepositories,
} from "../apps/server/src/clapp/repositories.ts";
import type { Store } from "../apps/server/src/db.ts";
import { createStore } from "../apps/server/src/db.ts";
import {
  AUTHORIZATION_RECORD_ID_PREFIX,
  type AuthorizationRecord,
  type AuthorizationStore,
  authorizationRecordKey,
  authorizeTarget,
  buildAuthorizationRecord,
} from "../packages/clapp-observation/src/index.ts";
import type { AgentTask } from "../packages/domain/src/agent.ts";

/**
 * CLAPP-W1-009 — multi-user hardening of the CLAPP control plane.
 *
 * Contract under test (docs/clapp/WORK_ITEMS.md, CLAPP-W1-009): concurrent
 * operators with distinct identities observe strictly isolated task and
 * package scope — cross-user reads and writes fail CLOSED with
 * authorization-record-backed denial reasons, and no operator can observe
 * another operator's task events or artifacts. Absent and cross-owner are
 * distinguished honestly; the burden of proof is on the stored W1-008
 * authorization record, and absence of a record is a refusal, never a pass.
 *
 * Deterministic only: the guard's clock is pinned (FIXED_MS), every id and
 * timestamp is a fixed literal, and the substrate is the REAL in-process
 * store plus the REAL W1-007 repositories (createStore +
 * createClappRepositories, the W1-007 precedent) with two concurrent
 * operators holding distinct identities. Authorization records are minted
 * through the real W1-008 authorize path (authorizeTarget /
 * buildAuthorizationRecord) — never hand-rolled lookalikes; the one
 * deliberate exception is the malformed-record fault injection in the last
 * test, whose whole point is a stored shape the W1-008 mint path can never
 * produce.
 */

// ---------------------------------------------------------------------------
// Deterministic fixtures
// ---------------------------------------------------------------------------

/** The pinned evaluation instant: 2026-01-01T00:00:00.000Z. */
const FIXED_MS = 1767225600000;
const FIXED_ISO = "2026-01-01T00:00:00.000Z";

/** The guard's injectable clock — tests mutate nowMs between phases. */
let nowMs = FIXED_MS;
const pinnedNow = (): number => nowMs;

const OPERATOR_A = "operator-alice";
const OPERATOR_B = "operator-bob";

/** A deterministic clapp_run_-style reconstruction id (32 hex-ish chars). */
const runId = (fill: string): string => `clapp_run_${fill.repeat(32).slice(0, 32)}`;

const ID_A1 = runId("a1");
const ID_A2 = runId("a2");
const ID_B1 = runId("b1");
const ID_B2 = runId("b2");
const ID_GAMMA = runId("c1");
const ID_UNBACKED = runId("c2");
const ID_DELTA = runId("d1");
const ID_DELTA_FOREIGN = runId("d2");
const ID_EPSILON = runId("e1");
const ID_ZETA = runId("e2");
const ID_ETA = runId("f1");
const ID_LAPSED = runId("f2");
const ID_BOUNDARY = runId("f3");
const ID_LEAK = runId("81");
const ID_BROKEN = runId("82");

/** A valid frozen-shaped ReconstructionSpec for one operator and target. */
const specFor = (
  operator: string,
  targetId: string,
  reconstructionId: string,
  authorizationOverrides: Record<string, unknown> = {},
) => ({
  specVersion: "0.1",
  reconstructionId,
  targetId,
  name: `${targetId} demo target`,
  platform: "web" as const,
  entrypoints: ["https://example.test/"],
  authorization: {
    ownerId: operator,
    targetId,
    scope: ["read"],
    environments: ["production"],
    retention: "project" as const,
    benchmarkOwned: false,
    createdAt: FIXED_ISO,
    ...authorizationOverrides,
  },
  exploration: { maxStages: 4, maxActions: 200, maxDurationMs: 60000, seed: 7 },
  synthesis: { targetStack: "web", allowNetwork: false, packagePolicy: "verified-only" as const },
  verification: { journeys: [], visual: true, network: false, state: true, maxRepairIterations: 2 },
});

/** A reconstruction row carrying the frozen spec, deterministic throughout. */
const rowFor = (
  operator: string,
  reconstructionId: string,
  targetId: string,
  authorizationOverrides: Record<string, unknown> = {},
): ClappReconstructionRow => ({
  id: reconstructionId,
  spec: specFor(operator, targetId, reconstructionId, authorizationOverrides),
  createdAt: FIXED_ISO,
  status: "active",
});

/** A CLAPP stage-task chain row (the W1-004 payload shape). */
const stageTaskFor = (
  reconstructionId: string,
  stage: string,
  taskId: string,
  prompt = `Reconstruct stage ${stage} for ${reconstructionId}`,
): AgentTask => ({
  id: taskId,
  title: `${reconstructionId} — ${stage} stage`,
  prompt,
  kind: "agent",
  status: "succeeded",
  plan: [],
  evidence: [],
  input: { specVersion: "0.1", reconstructionId, stage },
  state: {},
  createdAt: FIXED_ISO,
  updatedAt: FIXED_ISO,
  attempts: 1,
  artifactIds: [],
});

/** An artifact index record as the runtime artifact provider writes it. */
const artifactFor = (
  reconstructionId: string,
  targetId: string,
  shaFill: string,
): ClappArtifactRecord => ({
  id: `clapp_evidence_${shaFill.repeat(16)}`,
  targetId,
  reconstructionId,
  kind: "screenshot",
  sha256: shaFill.repeat(32),
  source: "clapp-stage-artifact",
  capturedAt: FIXED_ISO,
  classification: "derived",
  redacted: false,
  fileId: `file-${shaFill}`,
});

/** The real W1-008 AuthorizationStore port, in-memory (the test seam). */
function authorizationStoreFixture(): AuthorizationStore & {
  records: Map<string, AuthorizationRecord>;
} {
  const records = new Map<string, AuthorizationRecord>();
  return {
    records,
    async get(key) {
      return records.get(key);
    },
    async put(key, record) {
      records.set(key, record);
    },
  };
}

/** A counting AuthorizationStore — proves "before any store access". */
function countingAuthorizationStoreFixture(): AuthorizationStore & {
  getCalls: () => number;
  putCalls: () => number;
} {
  const backing = authorizationStoreFixture();
  let getCalls = 0;
  let putCalls = 0;
  return {
    getCalls: () => getCalls,
    putCalls: () => putCalls,
    async get(key) {
      getCalls += 1;
      return backing.get(key);
    },
    async put(key, record) {
      putCalls += 1;
      await backing.put(key, record);
    },
  };
}

/**
 * The fake package port: a dumb per-coordinate store carrying the
 * per-package operator-scope tag (the real @clapp/intelligence registry
 * wiring is a later tech-lead wave). Implements the list filter over its
 * own opaque documents.
 */
function packageStoreFixture(): OperatorPackageStore {
  const records = new Map<string, OperatorScopedPackageRecord>();
  const keyOf = (id: string, version: string) => `${id}@${version}`;
  return {
    async get(id, version) {
      return records.get(keyOf(id, version)) ?? null;
    },
    async put(record) {
      records.set(keyOf(record.id, record.version), { ...record });
    },
    async list(filter) {
      const all = [...records.values()];
      if (filter === undefined) return all;
      return all.filter((record) => {
        const doc = (record.document ?? {}) as Record<string, unknown>;
        if (filter.category !== undefined && doc.category !== filter.category) return false;
        if (
          filter.capability !== undefined &&
          (!Array.isArray(doc.capabilities) || !doc.capabilities.includes(filter.capability))
        )
          return false;
        if (
          filter.target !== undefined &&
          (!Array.isArray(doc.supportedTargets) || !doc.supportedTargets.includes(filter.target))
        )
          return false;
        if (filter.status !== undefined && record.status !== filter.status) return false;
        return true;
      });
    },
  };
}

const packageDoc = (id: string, version: string, extra: Record<string, unknown> = {}) => ({
  id,
  version,
  category: "ui",
  capabilities: ["button"],
  supportedTargets: ["web"],
  ...extra,
});

const PROMOTION_EVIDENCE = {
  verifiedAt: FIXED_ISO,
  verificationRunId: "clapp_eval_fixed_evidence_run",
};

/** The W1-007-shaped spy: records every call, faithful in-memory semantics. */
function spyRepositoriesFixture(
  seeds: {
    rows?: Array<{ owner: string; row: ClappReconstructionRow }>;
    tasks?: Array<{ owner: string; task: AgentTask }>;
    artifacts?: Array<{ owner: string; record: ClappArtifactRecord }>;
  } = {},
): ClappRepositories & { calls: Array<{ method: string; args: unknown[] }> } {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const rowsByOwner = new Map<string, Map<string, ClappReconstructionRow>>();
  const tasksByOwner = new Map<string, AgentTask[]>();
  const artifactsByOwner = new Map<string, ClappArtifactRecord[]>();
  for (const { owner, row } of seeds.rows ?? []) {
    const ownerRows = rowsByOwner.get(owner) ?? new Map();
    ownerRows.set(row.id, row);
    rowsByOwner.set(owner, ownerRows);
  }
  for (const { owner, task } of seeds.tasks ?? []) {
    const list = tasksByOwner.get(owner) ?? [];
    list.push(task);
    tasksByOwner.set(owner, list);
  }
  for (const { owner, record } of seeds.artifacts ?? []) {
    const list = artifactsByOwner.get(owner) ?? [];
    list.push(record);
    artifactsByOwner.set(owner, list);
  }
  return {
    calls,
    async create(owner, row) {
      calls.push({ method: "create", args: [owner, row] });
      const ownerRows = rowsByOwner.get(owner) ?? new Map();
      const existing = ownerRows.get(row.id);
      if (existing === undefined) ownerRows.set(row.id, row);
      rowsByOwner.set(owner, ownerRows);
      return existing ?? row;
    },
    async get(owner, id) {
      calls.push({ method: "get", args: [owner, id] });
      return rowsByOwner.get(owner)?.get(id) ?? null;
    },
    async list(owner) {
      calls.push({ method: "list", args: [owner] });
      return [...(rowsByOwner.get(owner)?.values() ?? [])];
    },
    async markCancelled(owner, id) {
      calls.push({ method: "markCancelled", args: [owner, id] });
      const ownerRows = rowsByOwner.get(owner);
      const row = ownerRows?.get(id);
      if (row) ownerRows?.set(id, { ...row, status: "cancelled" });
    },
    async stageTasks(owner, reconstructionId) {
      calls.push({ method: "stageTasks", args: [owner, reconstructionId] });
      return (tasksByOwner.get(owner) ?? []).filter(
        (task) => (task.input as Record<string, unknown>).reconstructionId === reconstructionId,
      );
    },
    async artifacts(owner, reconstructionId) {
      calls.push({ method: "artifacts", args: [owner, reconstructionId] });
      return (artifactsByOwner.get(owner) ?? []).filter(
        (record) => record.reconstructionId === reconstructionId,
      );
    },
    async findSpec(reconstructionId) {
      calls.push({ method: "findSpec", args: [reconstructionId] });
      for (const ownerRows of rowsByOwner.values()) {
        const row = ownerRows.get(reconstructionId);
        if (row) return row.spec;
      }
      return null;
    },
  };
}

/** The shared assertion: every cross-user refusal is the typed scope error. */
const isScopeError = (error: unknown): boolean => {
  assert.ok(
    error instanceof ClappOperatorScopeError,
    `expected ClappOperatorScopeError, got: ${String(error)}`,
  );
  return true;
};

// ---------------------------------------------------------------------------
// The shared real substrate
// ---------------------------------------------------------------------------

let db: Store;
let directory: string;
/** The REAL W1-007 repositories over the real in-process store. */
let rawRepositories: ReturnType<typeof createClappRepositories>;
/** The real W1-008 authorization-store port (in-memory test seam). */
let authz: ReturnType<typeof authorizationStoreFixture>;
/** The operator-scoped guard under test (clock pinned to nowMs). */
let scoped: ReturnType<typeof createOperatorScopedClapp>;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "openmuse-clapp-w1-009-"));
  db = await createStore({ dataDir: join(directory, "db") });
  rawRepositories = createClappRepositories(db);
  authz = authorizationStoreFixture();
  scoped = createOperatorScopedClapp({
    repositories: rawRepositories,
    authorizationStore: authz,
    packages: packageStoreFixture(),
    now: pinnedNow,
  });
});

after(async () => {
  await db?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. Strictly isolated reconstruction scope under interleaving
// ---------------------------------------------------------------------------

test("concurrent operators with distinct identities observe strictly isolated reconstruction scope", async () => {
  nowMs = FIXED_MS;
  // Mint the real W1-008 records for each operator's target (the authorize path).
  await authorizeTarget(specFor(OPERATOR_A, "target-alpha", ID_A1), {
    operatorIdentity: OPERATOR_A,
    store: authz,
  });
  await authorizeTarget(specFor(OPERATOR_B, "target-beta", ID_B1), {
    operatorIdentity: OPERATOR_B,
    store: authz,
  });
  // Interleaved creation round: all four creates race over the same store.
  await Promise.all([
    scoped.repositories.create(OPERATOR_A, rowFor(OPERATOR_A, ID_A1, "target-alpha")),
    scoped.repositories.create(OPERATOR_B, rowFor(OPERATOR_B, ID_B1, "target-beta")),
    scoped.repositories.create(OPERATOR_A, rowFor(OPERATOR_A, ID_A2, "target-alpha")),
    scoped.repositories.create(OPERATOR_B, rowFor(OPERATOR_B, ID_B2, "target-beta")),
  ]);
  // Interleaved read round: A's reads return A's rows only, B's return B's only.
  const [listA, listB, a1, a2, b1, b2] = await Promise.all([
    scoped.repositories.list(OPERATOR_A),
    scoped.repositories.list(OPERATOR_B),
    scoped.repositories.get(OPERATOR_A, ID_A1),
    scoped.repositories.get(OPERATOR_A, ID_A2),
    scoped.repositories.get(OPERATOR_B, ID_B1),
    scoped.repositories.get(OPERATOR_B, ID_B2),
  ]);
  assert.deepEqual(
    new Set(listA.map((row) => row.id)),
    new Set([ID_A1, ID_A2]),
    "A's list view carries only A's rows",
  );
  assert.deepEqual(
    new Set(listB.map((row) => row.id)),
    new Set([ID_B1, ID_B2]),
    "B's list view carries only B's rows",
  );
  assert.equal(a1?.id, ID_A1);
  assert.equal(a2?.id, ID_A2);
  assert.equal(b1?.id, ID_B1);
  assert.equal(b2?.id, ID_B2);
  // B reading A's reconstruction id throws the typed scope error — never A's row.
  await assert.rejects(
    () => scoped.repositories.get(OPERATOR_B, ID_A1),
    (error: unknown) => {
      assert.ok(error instanceof ClappOperatorScopeError);
      assert.equal(error.operatorIdentity, OPERATOR_B);
      assert.equal(error.denial.target, ID_A1);
      return true;
    },
  );
  // A's reads keep working after B's denials — isolation holds both ways.
  const a1After = await scoped.repositories.get(OPERATOR_A, ID_A1);
  assert.equal(a1After?.id, ID_A1);
  assert.equal((await scoped.repositories.list(OPERATOR_A)).length, 2);
  await assert.rejects(() => scoped.repositories.get(OPERATOR_A, ID_B1), isScopeError);
  const b2After = await scoped.repositories.get(OPERATOR_B, ID_B2);
  assert.equal(b2After?.id, ID_B2);
});

// ---------------------------------------------------------------------------
// 2. Cross-user reads fail closed with record-backed denial reasons
// ---------------------------------------------------------------------------

test("cross-user reads fail closed with authorization-record-backed denial reasons", async () => {
  nowMs = FIXED_MS;
  // A's reconstruction, backed by a real minted clapp_authz_ record.
  const record = await authorizeTarget(specFor(OPERATOR_A, "target-gamma", ID_GAMMA), {
    operatorIdentity: OPERATOR_A,
    store: authz,
  });
  assert.match(record.id, /^clapp_authz_/);
  await scoped.repositories.create(OPERATOR_A, rowFor(OPERATOR_A, ID_GAMMA, "target-gamma"));
  // B attempts every read path on A's reconstruction.
  const readPaths: Array<[string, () => Promise<unknown>]> = [
    ["reconstruction read", () => scoped.repositories.get(OPERATOR_B, ID_GAMMA)],
    ["stage task read", () => scoped.repositories.stageTasks(OPERATOR_B, ID_GAMMA)],
    ["artifact read", () => scoped.repositories.artifacts(OPERATOR_B, ID_GAMMA)],
  ];
  for (const [operation, attempt] of readPaths) {
    await assert.rejects(attempt, (error: unknown) => {
      assert.ok(error instanceof ClappOperatorScopeError, operation);
      assert.equal(error.capability, "operator-scope");
      assert.equal(error.operation, operation);
      assert.equal(error.operatorIdentity, OPERATOR_B);
      // The denial reason is backed by the persisted record: its id plus the
      // owner and operator identity it names.
      assert.equal(error.denial.authorizationRecordId, record.id);
      assert.equal(error.denial.recordOwnerId, OPERATOR_A);
      assert.equal(error.denial.recordOperatorIdentity, OPERATOR_A);
      assert.ok(error.denial.reason.includes(record.id));
      assert.ok(error.denial.reason.includes(OPERATOR_A));
      return true;
    });
  }
  // With no record persisted for the target, the denial says so explicitly
  // and still fails closed — for the cross-user caller AND the row's own
  // operator (absence of a record is a refusal, never a pass).
  await rawRepositories.create(OPERATOR_A, rowFor(OPERATOR_A, ID_UNBACKED, "target-unbacked"));
  await assert.rejects(
    () => scoped.repositories.get(OPERATOR_B, ID_UNBACKED),
    (error: unknown) => {
      assert.ok(error instanceof ClappOperatorScopeError);
      assert.ok(
        error.denial.reason.includes(
          'no authorization record is persisted for target "target-unbacked"',
        ),
      );
      assert.equal(error.denial.authorizationRecordId, undefined);
      return true;
    },
  );
  await assert.rejects(
    () => scoped.repositories.get(OPERATOR_A, ID_UNBACKED),
    (error: unknown) => {
      assert.ok(error instanceof ClappOperatorScopeError);
      assert.ok(error.denial.reason.includes("no authorization record is persisted"));
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// 3. Cross-user writes fail closed
// ---------------------------------------------------------------------------

test("cross-user writes fail closed", async () => {
  nowMs = FIXED_MS;
  const record = await authorizeTarget(specFor(OPERATOR_A, "target-delta", ID_DELTA), {
    operatorIdentity: OPERATOR_A,
    store: authz,
  });
  await scoped.repositories.create(OPERATOR_A, rowFor(OPERATOR_A, ID_DELTA, "target-delta"));
  await db.put(OPERATOR_A, "tasks", stageTaskFor(ID_DELTA, "authorization", "task-d-1"));
  // B attempts the write path on A's reconstruction: typed, record-backed denial.
  await assert.rejects(
    () => scoped.repositories.markCancelled(OPERATOR_B, ID_DELTA),
    (error: unknown) => {
      assert.ok(error instanceof ClappOperatorScopeError);
      assert.equal(error.operation, "reconstruction cancel");
      assert.equal(error.operatorIdentity, OPERATOR_B);
      assert.equal(error.denial.authorizationRecordId, record.id);
      assert.equal(error.denial.recordOwnerId, OPERATOR_A);
      assert.equal(error.denial.recordOperatorIdentity, OPERATOR_A);
      return true;
    },
  );
  // A's row is untouched afterwards: status still active, stage chain unchanged.
  assert.equal((await rawRepositories.get(OPERATOR_A, ID_DELTA))?.status, "active");
  assert.equal((await rawRepositories.stageTasks(OPERATOR_A, ID_DELTA)).length, 1);
  // B cannot create a reconstruction against a target whose record names A.
  await assert.rejects(
    () =>
      scoped.repositories.create(OPERATOR_B, rowFor(OPERATOR_B, ID_DELTA_FOREIGN, "target-delta")),
    (error: unknown) => {
      assert.ok(error instanceof ClappOperatorScopeError);
      assert.equal(error.operation, "reconstruction write");
      assert.equal(error.denial.authorizationRecordId, record.id);
      return true;
    },
  );
  assert.equal(await rawRepositories.get(OPERATOR_B, ID_DELTA_FOREIGN), null);
  // A's own control path still works — and stays idempotent.
  await scoped.repositories.markCancelled(OPERATOR_A, ID_DELTA);
  assert.equal((await rawRepositories.get(OPERATOR_A, ID_DELTA))?.status, "cancelled");
  await scoped.repositories.markCancelled(OPERATOR_A, ID_DELTA);
  assert.equal((await rawRepositories.get(OPERATOR_A, ID_DELTA))?.status, "cancelled");
});

// ---------------------------------------------------------------------------
// 4. Task events and artifacts are never observable cross-user
// ---------------------------------------------------------------------------

test("no operator observes another operator's task events or artifacts", async () => {
  nowMs = FIXED_MS;
  await authorizeTarget(specFor(OPERATOR_A, "target-epsilon", ID_EPSILON), {
    operatorIdentity: OPERATOR_A,
    store: authz,
  });
  await scoped.repositories.create(OPERATOR_A, rowFor(OPERATOR_A, ID_EPSILON, "target-epsilon"));
  // A's chain: two stage tasks with distinctive payloads, two artifact records.
  await db.put(OPERATOR_A, "tasks", stageTaskFor(ID_EPSILON, "authorization", "task-e-1"));
  await db.put(OPERATOR_A, "tasks", stageTaskFor(ID_EPSILON, "capture", "task-e-2"));
  await db.put(OPERATOR_A, "clapp-artifacts", artifactFor(ID_EPSILON, "target-epsilon", "e1"));
  await db.put(OPERATOR_A, "clapp-artifacts", artifactFor(ID_EPSILON, "target-epsilon", "e2"));
  // B has their own reconstruction with their own single-link chain.
  await authorizeTarget(specFor(OPERATOR_B, "target-zeta", ID_ZETA), {
    operatorIdentity: OPERATOR_B,
    store: authz,
  });
  await scoped.repositories.create(OPERATOR_B, rowFor(OPERATOR_B, ID_ZETA, "target-zeta"));
  await db.put(OPERATOR_B, "tasks", stageTaskFor(ID_ZETA, "authorization", "task-z-1"));
  await db.put(OPERATOR_B, "clapp-artifacts", artifactFor(ID_ZETA, "target-zeta", "z1"));
  // B's scoped list surfaces nothing of A's — only B's own rows, never
  // A's reconstruction (B's earlier rows from the shared store included).
  const bListIds = (await scoped.repositories.list(OPERATOR_B)).map((row) => row.id);
  assert.ok(bListIds.includes(ID_ZETA));
  assert.ok(!bListIds.includes(ID_EPSILON), "B's list view never surfaces A's reconstruction");
  assert.ok(!bListIds.includes(ID_A1), "B's list view never surfaces A's first reconstruction");
  // B addressing A's exact reconstructionId: every chain read path throws the
  // typed denial — never A's stage tasks, never A's artifact records, even
  // though B guessed the exact id.
  await assert.rejects(() => scoped.repositories.stageTasks(OPERATOR_B, ID_EPSILON), isScopeError);
  await assert.rejects(() => scoped.repositories.artifacts(OPERATOR_B, ID_EPSILON), isScopeError);
  await assert.rejects(
    () => scoped.repositories.findSpec(OPERATOR_B, ID_EPSILON),
    (error: unknown) => {
      assert.ok(error instanceof ClappOperatorScopeError);
      assert.equal(error.operation, "reconstruction read");
      return true;
    },
  );
  // B's own chain reads return exactly B's own rows.
  const bTasks = await scoped.repositories.stageTasks(OPERATOR_B, ID_ZETA);
  assert.deepEqual(
    bTasks.map((task) => task.id),
    ["task-z-1"],
  );
  const bArtifacts = await scoped.repositories.artifacts(OPERATOR_B, ID_ZETA);
  assert.deepEqual(
    bArtifacts.map((record) => record.id),
    [`clapp_evidence_${"z1".repeat(16)}`],
  );
  // A's own read returns the full chain (store order; membership asserted).
  const aTaskIds = (await scoped.repositories.stageTasks(OPERATOR_A, ID_EPSILON)).map(
    (task) => task.id,
  );
  assert.equal(aTaskIds.length, 2);
  assert.deepEqual(new Set(aTaskIds), new Set(["task-e-1", "task-e-2"]));
  const aArtifacts = await scoped.repositories.artifacts(OPERATOR_A, ID_EPSILON);
  assert.equal(aArtifacts.length, 2);
  const aSpec = await scoped.repositories.findSpec(OPERATOR_A, ID_EPSILON);
  assert.equal(aSpec?.targetId, "target-epsilon");
});

// ---------------------------------------------------------------------------
// 5. Absent versus cross-owner, expiry, and the eternal record
// ---------------------------------------------------------------------------

test("absent versus cross-owner are distinguished honestly", async () => {
  nowMs = FIXED_MS;
  // An id that exists under no operator: the honest not-found path — null
  // semantics, no scope error, for every operator and every read shape.
  assert.equal(await scoped.repositories.get(OPERATOR_A, ID_ETA), null);
  assert.equal(await scoped.repositories.get(OPERATOR_B, ID_ETA), null);
  assert.equal(await scoped.repositories.findSpec(OPERATOR_B, ID_ETA), null);
  assert.deepEqual(await scoped.repositories.stageTasks(OPERATOR_B, ID_ETA), []);
  await scoped.repositories.markCancelled(OPERATOR_B, ID_ETA); // the honest wrapped no-op
  // The same id after A creates it under A becomes a record-backed denial for B.
  const etaRecord = await authorizeTarget(specFor(OPERATOR_A, "target-eta", ID_ETA), {
    operatorIdentity: OPERATOR_A,
    store: authz,
  });
  await scoped.repositories.create(OPERATOR_A, rowFor(OPERATOR_A, ID_ETA, "target-eta"));
  await assert.rejects(
    () => scoped.repositories.get(OPERATOR_B, ID_ETA),
    (error: unknown) => {
      assert.ok(error instanceof ClappOperatorScopeError);
      assert.equal(error.denial.authorizationRecordId, etaRecord.id);
      assert.equal(error.denial.recordOwnerId, OPERATOR_A);
      return true;
    },
  );
  // A record whose expiresAt is strictly before the pinned instant no longer
  // backs a scope grant, and the denial names the expiry — for the row's own
  // operator and for the cross-user caller alike.
  const lapsedIso = new Date(FIXED_MS + 60000).toISOString();
  await authorizeTarget(specFor(OPERATOR_A, "target-lapsed", ID_LAPSED, { expiresAt: lapsedIso }), {
    operatorIdentity: OPERATOR_A,
    store: authz,
  });
  await scoped.repositories.create(OPERATOR_A, rowFor(OPERATOR_A, ID_LAPSED, "target-lapsed"));
  assert.ok(
    (await scoped.repositories.get(OPERATOR_A, ID_LAPSED)) !== null,
    "granted while unexpired",
  );
  nowMs = FIXED_MS + 120000;
  await assert.rejects(
    () => scoped.repositories.get(OPERATOR_A, ID_LAPSED),
    (error: unknown) => {
      assert.ok(error instanceof ClappOperatorScopeError);
      assert.equal(error.denial.expiredAt, lapsedIso);
      assert.ok(error.denial.reason.includes(lapsedIso), "the denial names the expiry");
      assert.equal(error.denial.authorizationRecordId !== undefined, true);
      return true;
    },
  );
  await assert.rejects(
    () => scoped.repositories.get(OPERATOR_B, ID_LAPSED),
    (error: unknown) => {
      assert.ok(error instanceof ClappOperatorScopeError);
      assert.equal(error.denial.expiredAt, lapsedIso);
      assert.ok(error.denial.reason.includes(lapsedIso));
      return true;
    },
  );
  // The lapsed row also drops out of A's own list view: never surfaced unbacked.
  assert.ok(
    !(await scoped.repositories.list(OPERATOR_A)).some((row) => row.id === ID_LAPSED),
    "an expired record's row leaves the scoped list view",
  );
  // Strictness pinned: a record expiring exactly AT the evaluation instant
  // is not yet expired.
  nowMs = FIXED_MS;
  const boundaryIso = new Date(FIXED_MS + 60000).toISOString();
  await authorizeTarget(
    specFor(OPERATOR_A, "target-boundary", ID_BOUNDARY, { expiresAt: boundaryIso }),
    { operatorIdentity: OPERATOR_A, store: authz },
  );
  await scoped.repositories.create(OPERATOR_A, rowFor(OPERATOR_A, ID_BOUNDARY, "target-boundary"));
  nowMs = FIXED_MS + 60000;
  assert.equal((await scoped.repositories.get(OPERATOR_A, ID_BOUNDARY))?.id, ID_BOUNDARY);
  nowMs = FIXED_MS + 60001;
  await assert.rejects(
    () => scoped.repositories.get(OPERATOR_A, ID_BOUNDARY),
    (error: unknown) => {
      assert.ok(error instanceof ClappOperatorScopeError);
      assert.equal(error.denial.expiredAt, boundaryIso);
      return true;
    },
  );
  // A record with no expiresAt never expires.
  nowMs = FIXED_MS + 315360000000; // a decade past the pinned instant
  assert.equal((await scoped.repositories.get(OPERATOR_A, ID_ETA))?.id, ID_ETA);
});

// ---------------------------------------------------------------------------
// 6. The package scope port
// ---------------------------------------------------------------------------

test("the package scope port enforces operator isolation", async () => {
  nowMs = FIXED_MS;
  // A registers a package in A's scope.
  const aPackage = await scoped.packages.register(
    OPERATOR_A,
    packageDoc("clapp_package_alpha", "0.1.0"),
  );
  assert.equal(aPackage.operatorScope, OPERATOR_A);
  assert.equal(aPackage.status, "candidate");
  // B registers their own package in B's scope.
  await scoped.packages.register(OPERATOR_B, packageDoc("clapp_package_beta", "0.1.0"));
  // B's list contains only B's packages — never A's.
  assert.deepEqual(
    (await scoped.packages.list(OPERATOR_B)).map((record) => record.id),
    ["clapp_package_beta"],
  );
  assert.deepEqual(
    (await scoped.packages.list(OPERATOR_A)).map((record) => record.id),
    ["clapp_package_alpha"],
  );
  // B's register into A's scope throws the record-backed typed denial.
  await assert.rejects(
    () =>
      scoped.packages.register(
        OPERATOR_B,
        packageDoc("clapp_package_alpha", "0.1.0", { category: "hostile" }),
      ),
    (error: unknown) => {
      assert.ok(error instanceof ClappOperatorScopeError);
      assert.equal(error.operation, "package write");
      assert.equal(error.operatorIdentity, OPERATOR_B);
      assert.equal(error.denial.packageId, "clapp_package_alpha");
      assert.equal(error.denial.packageVersion, "0.1.0");
      assert.equal(error.denial.packageOperatorScope, OPERATOR_A);
      return true;
    },
  );
  // B's promote into A's scope throws the same record-backed denial.
  await assert.rejects(
    () => scoped.packages.promote(OPERATOR_B, "clapp_package_alpha", "0.1.0", PROMOTION_EVIDENCE),
    (error: unknown) => {
      assert.ok(error instanceof ClappOperatorScopeError);
      assert.equal(error.operation, "package promotion");
      assert.equal(error.denial.packageOperatorScope, OPERATOR_A);
      return true;
    },
  );
  // B's read of A's package is denied — never A's document.
  await assert.rejects(
    () => scoped.packages.get(OPERATOR_B, "clapp_package_alpha", "0.1.0"),
    isScopeError,
  );
  // An absent package coordinate is the honest not-found: null, no scope error.
  assert.equal(await scoped.packages.get(OPERATOR_B, "clapp_package_nobody", "9.9.9"), null);
  // B's own-scope package operations succeed.
  const promoted = await scoped.packages.promote(
    OPERATOR_B,
    "clapp_package_beta",
    "0.1.0",
    PROMOTION_EVIDENCE,
  );
  assert.equal(promoted.status, "promoted");
  assert.deepEqual(promoted.promotion, PROMOTION_EVIDENCE);
  assert.equal(
    (await scoped.packages.get(OPERATOR_B, "clapp_package_beta", "0.1.0"))?.status,
    "promoted",
  );
  const bSecond = await scoped.packages.register(
    OPERATOR_B,
    packageDoc("clapp_package_beta2", "0.1.0"),
  );
  assert.equal(bSecond.operatorScope, OPERATOR_B);
  // The list filter passes through to the port, still scoped to the operator.
  assert.deepEqual(
    (await scoped.packages.list(OPERATOR_B, { status: "promoted" })).map((record) => record.id),
    ["clapp_package_beta"],
  );
  // Idempotent re-promotion with identical evidence is the W2-005 no-op.
  const rePromoted = await scoped.packages.promote(
    OPERATOR_B,
    "clapp_package_beta",
    "0.1.0",
    PROMOTION_EVIDENCE,
  );
  assert.equal(rePromoted.status, "promoted");
  // A's package is untouched by B's denials: still a candidate, still A's scope.
  const aAfter = await scoped.packages.get(OPERATOR_A, "clapp_package_alpha", "0.1.0");
  assert.equal(aAfter?.status, "candidate");
  assert.equal(aAfter?.operatorScope, OPERATOR_A);
});

// ---------------------------------------------------------------------------
// 7. Composition without modification (delegation proof)
// ---------------------------------------------------------------------------

test("the guard composes the W1-007 surfaces without modifying them", async () => {
  nowMs = FIXED_MS;
  const spyOperator = "operator-spy";
  const ID_SPY = runId("s1");
  const ID_SPY2 = runId("s2");
  const spyRow = rowFor(spyOperator, ID_SPY, "target-spy");
  const spyTask = stageTaskFor(ID_SPY, "authorization", "task-s-1");
  const spyArtifact = artifactFor(ID_SPY, "target-spy", "s1");
  const spy = spyRepositoriesFixture({
    rows: [{ owner: spyOperator, row: spyRow }],
    tasks: [{ owner: spyOperator, task: spyTask }],
    artifacts: [{ owner: spyOperator, record: spyArtifact }],
  });
  await authorizeTarget(spyRow.spec, { operatorIdentity: spyOperator, store: authz });
  await authorizeTarget(specFor(spyOperator, "target-spy-2", ID_SPY2), {
    operatorIdentity: spyOperator,
    store: authz,
  });
  const scopedSpy = createOperatorScopedClapp({
    repositories: spy,
    authorizationStore: authz,
    now: pinnedNow,
  });
  // Same-operator reads delegate exactly once, with the operator as owner,
  // and pass the wrapped values through unchanged.
  let mark = spy.calls.length;
  assert.deepEqual(await scopedSpy.repositories.get(spyOperator, ID_SPY), spyRow);
  assert.deepEqual(spy.calls.slice(mark), [{ method: "get", args: [spyOperator, ID_SPY] }]);

  mark = spy.calls.length;
  assert.deepEqual(await scopedSpy.repositories.findSpec(spyOperator, ID_SPY), spyRow.spec);
  assert.deepEqual(spy.calls.slice(mark), [
    { method: "get", args: [spyOperator, ID_SPY] },
    { method: "findSpec", args: [ID_SPY] },
  ]);

  mark = spy.calls.length;
  assert.deepEqual(await scopedSpy.repositories.stageTasks(spyOperator, ID_SPY), [spyTask]);
  assert.deepEqual(spy.calls.slice(mark), [
    { method: "get", args: [spyOperator, ID_SPY] },
    { method: "stageTasks", args: [spyOperator, ID_SPY] },
  ]);

  mark = spy.calls.length;
  assert.deepEqual(await scopedSpy.repositories.artifacts(spyOperator, ID_SPY), [spyArtifact]);
  assert.deepEqual(spy.calls.slice(mark), [
    { method: "get", args: [spyOperator, ID_SPY] },
    { method: "artifacts", args: [spyOperator, ID_SPY] },
  ]);

  mark = spy.calls.length;
  await scopedSpy.repositories.markCancelled(spyOperator, ID_SPY);
  assert.deepEqual(spy.calls.slice(mark), [
    { method: "get", args: [spyOperator, ID_SPY] },
    { method: "markCancelled", args: [spyOperator, ID_SPY] },
  ]);
  assert.equal((await scopedSpy.repositories.get(spyOperator, ID_SPY))?.status, "cancelled");

  mark = spy.calls.length;
  assert.deepEqual(await scopedSpy.repositories.list(spyOperator), [
    { ...spyRow, status: "cancelled" },
  ]);
  assert.deepEqual(spy.calls.slice(mark), [{ method: "list", args: [spyOperator] }]);

  const spyRow2 = rowFor(spyOperator, ID_SPY2, "target-spy-2");
  mark = spy.calls.length;
  assert.deepEqual(await scopedSpy.repositories.create(spyOperator, spyRow2), spyRow2);
  assert.deepEqual(spy.calls.slice(mark), [
    { method: "get", args: [spyOperator, ID_SPY2] },
    { method: "findSpec", args: [ID_SPY2] },
    { method: "create", args: [spyOperator, spyRow2] },
  ]);

  // The identity is normalized before delegation: a padded caller delegates
  // with the trimmed operator as owner.
  mark = spy.calls.length;
  await scopedSpy.repositories.get(`  ${spyOperator}  `, ID_SPY);
  assert.deepEqual(spy.calls.slice(mark), [{ method: "get", args: [spyOperator, ID_SPY] }]);

  // Every owner-bearing wrapped call in the whole session used the operator.
  for (const call of spy.calls) {
    if (call.method !== "findSpec") {
      assert.equal(
        call.args[0],
        spyOperator,
        `${call.method} delegated with the operator as owner`,
      );
    }
  }
  // No package port is wired into this guard: package operations fail closed
  // with a precise refusal rather than guessing.
  await assert.rejects(
    () => scopedSpy.packages.list(spyOperator),
    (error: unknown) => {
      assert.ok(error instanceof ClappOperatorScopeError);
      assert.ok(error.denial.reason.includes("no backing package port is wired"));
      return true;
    },
  );
  // The frozen W1-007/W1-008/W1-002 suites are asserted unmodified-green by
  // the full battery run recorded in DELIVERY.md; this test pins the
  // behavioral half of the contract — the guard only ever delegates.
});

// ---------------------------------------------------------------------------
// 8. Typed, precise, leak-free scope errors
// ---------------------------------------------------------------------------

test("scope errors are typed, precise, and never leak cross-user data", async () => {
  nowMs = FIXED_MS;
  // A's reconstruction with a distinctive payload chain: if any of these
  // strings ever appears in a denial, the guard leaks cross-user data.
  const PROMPT_SENTINEL = "SECRET-A-PROMPT-never-to-leak";
  const TITLE_SENTINEL = "SECRET-A-TITLE-never-to-leak";
  const FILE_SENTINEL = "file-SECRET-A-never-to-leak";
  const SHA_SENTINEL = "SECRET-A-SHA-never-to-leak";
  const leakRecord = await authorizeTarget(specFor(OPERATOR_A, "target-leak", ID_LEAK), {
    operatorIdentity: OPERATOR_A,
    store: authz,
  });
  await scoped.repositories.create(OPERATOR_A, rowFor(OPERATOR_A, ID_LEAK, "target-leak"));
  await db.put(
    OPERATOR_A,
    "tasks",
    stageTaskFor(ID_LEAK, "authorization", "task-leak-1", PROMPT_SENTINEL),
  );
  const leakTask = stageTaskFor(ID_LEAK, "capture", "task-leak-2", PROMPT_SENTINEL);
  leakTask.title = TITLE_SENTINEL;
  await db.put(OPERATOR_A, "tasks", leakTask);
  const leakArtifact: ClappArtifactRecord = {
    ...artifactFor(ID_LEAK, "target-leak", "e1"),
    sha256: SHA_SENTINEL,
    fileId: FILE_SENTINEL,
  };
  await db.put(OPERATOR_A, "clapp-artifacts", leakArtifact);
  // B's denied read carries the capability discriminator, the attempted
  // operation, the caller identity, and the record-backed reason.
  const error = await scoped.repositories.get(OPERATOR_B, ID_LEAK).then(
    () => assert.fail("expected the cross-user read to fail closed"),
    (thrown: unknown) => thrown as ClappOperatorScopeError,
  );
  assert.ok(error instanceof ClappOperatorScopeError);
  assert.equal(error.capability, "operator-scope");
  assert.equal(error.operation, "reconstruction read");
  assert.equal(error.operatorIdentity, OPERATOR_B);
  assert.ok(error.denial.authorizationRecordId?.startsWith(AUTHORIZATION_RECORD_ID_PREFIX));
  assert.equal(error.denial.authorizationRecordId, leakRecord.id);
  assert.equal(error.denial.recordOwnerId, OPERATOR_A);
  assert.equal(error.denial.recordOperatorIdentity, OPERATOR_A);
  assert.equal(error.name, "ClappOperatorScopeError");
  // The denial fields are exactly the identity-level set — nothing else.
  assert.deepEqual(Object.keys(error.denial).sort(), [
    "authorizationRecordId",
    "reason",
    "recordOperatorIdentity",
    "recordOwnerId",
    "target",
  ]);
  // Serialized denial fields contain identity-level strings only (ids,
  // owner, operator) — never another operator's payloads or records.
  const serialized = JSON.stringify({
    capability: error.capability,
    operation: error.operation,
    operatorIdentity: error.operatorIdentity,
    denial: error.denial,
    message: error.message,
  });
  for (const identity of [OPERATOR_A, OPERATOR_B, ID_LEAK, "target-leak", leakRecord.id]) {
    assert.ok(serialized.includes(identity), `the denial carries ${identity}`);
  }
  for (const secret of [PROMPT_SENTINEL, TITLE_SENTINEL, FILE_SENTINEL, SHA_SENTINEL]) {
    assert.ok(!serialized.includes(secret), `the denial must never carry ${secret}`);
  }
  // An empty or whitespace operator identity fails closed before any store
  // access — no repository call, no authorization-port call.
  const freshSpy = spyRepositoriesFixture();
  const countingStore = countingAuthorizationStoreFixture();
  const guard = createOperatorScopedClapp({
    repositories: freshSpy,
    authorizationStore: countingStore,
    now: pinnedNow,
  });
  for (const empty of ["", "   ", "\t\n "]) {
    await assert.rejects(
      () => guard.repositories.get(empty, ID_LEAK),
      (thrown: unknown) => {
        assert.ok(thrown instanceof ClappOperatorScopeError);
        assert.equal(thrown.capability, "operator-scope");
        assert.ok(thrown.denial.reason.includes("non-empty trimmed string"));
        return true;
      },
    );
  }
  await assert.rejects(() => guard.repositories.list("  "), isScopeError);
  await assert.rejects(() => guard.repositories.stageTasks("", ID_LEAK), isScopeError);
  await assert.rejects(
    () => guard.repositories.markCancelled(null as unknown as string, ID_LEAK),
    isScopeError,
  );
  await assert.rejects(
    () => guard.packages.register("   ", packageDoc("clapp_package_x", "0.1.0")),
    isScopeError,
  );
  assert.equal(freshSpy.calls.length, 0, "no repository call may happen for an empty identity");
  assert.equal(countingStore.getCalls(), 0, "no authorization-port read may happen either");
  assert.equal(countingStore.putCalls(), 0);
  // A malformed stored record shape fails closed with a precise message
  // rather than being trusted — the fault-injected record below is the one
  // deliberate non-minted record in this suite (the W1-008 mint path cannot
  // produce it; that is the point).
  const brokenRecord = buildAuthorizationRecord(
    specFor(OPERATOR_A, "target-broken", ID_BROKEN).authorization,
    OPERATOR_A,
  );
  await authz.put(
    authorizationRecordKey("target-broken"),
    // Deliberate fault injection: a stored shape the W1-008 mint path can
    // never produce — the guard must refuse to trust it.
    {
      ...brokenRecord,
      ownerId: 42,
      authorizationKind: "mystery-kind",
    } as unknown as AuthorizationRecord,
  );
  await rawRepositories.create(OPERATOR_A, rowFor(OPERATOR_A, ID_BROKEN, "target-broken"));
  for (const caller of [OPERATOR_A, OPERATOR_B]) {
    await assert.rejects(
      () => scoped.repositories.get(caller, ID_BROKEN),
      (thrown: unknown) => {
        assert.ok(thrown instanceof ClappOperatorScopeError);
        assert.ok(thrown.denial.reason.includes("malformed"));
        assert.ok(thrown.denial.reason.includes("ownerId must be a non-empty string"));
        assert.ok(thrown.denial.reason.includes("authorizationKind must be one of"));
        assert.ok(!thrown.denial.reason.includes("mystery-kind"), "never echo untrusted values");
        assert.ok(!thrown.denial.reason.includes("42"), "never echo untrusted values");
        return true;
      },
    );
  }
});
