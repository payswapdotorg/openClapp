import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type {
  ReconstructionSpec,
  TargetAuthorization,
} from "../packages/clapp-contracts/src/index.ts";
import {
  type AuthorizationRecord,
  type AuthorizationStore,
  authorizeTarget,
  canonicalJson,
} from "../packages/clapp-observation/src/index.ts";
import {
  AUDIT_ENTRY_ID_PREFIX,
  type AuditAuthorizationRecord,
  type AuditEntry,
  type AuditStore,
  appendAuditEvent,
  ClappAuditError,
  type ClappAuditEvent,
  type ClappAuditKind,
  deriveAuditRetention,
  proveInclusion,
  readAuditLog,
  verifyAuditChain,
} from "../packages/clapp-runtime-openmuse/src/index.ts";

/**
 * CLAPP-W1-011 — audit/retention enforcement.
 *
 * Contract (docs/clapp/WORK_ITEMS.md CLAPP-W1-011): authorization,
 * observation, repair, and promotion events append to a tamper-evident audit
 * log (content-addressed chain) with per-record retention derived from the
 * authorization record, and expired records are excluded from reads while
 * their prior inclusion remains provable.
 *
 * Unit tests bind the audit log to an in-memory AuditStore port and pin the
 * evaluation clock (FIXED_MS, the W1-002/W1-008 FIXED_MS pattern) so expiry
 * is deterministic. Authorization records are minted through the REAL W1-008
 * authorizeTarget — nothing hand-rolled — and entry ids are recomputed
 * independently (the observation package's canonicalJson plus node:crypto
 * sha256) so the content-addressing discipline is pinned, not trusted. The
 * battery-level half of test 8 — the FROZEN
 * tests/clapp-w1-008-authorization.test.ts passing unmodified — is
 * confirmed in the delivery record.
 */

const OWNER = "local-user";
const OPERATOR = "operator-w1-011";
const ENVIRONMENT = "web";
const FIXED_MS = 1735689600000; // 2025-01-01T00:00:00.000Z — pinned clock for deterministic expiry
const FIXED_ISO = new Date(FIXED_MS).toISOString();
const fixedClock = () => FIXED_MS;

/** The caller-declared retention policy: ephemeral 1s, project 60s, library never. */
const POLICY = { ephemeralMs: 1_000, projectMs: 60_000 };

const AUDIT_SOURCE = "../packages/clapp-runtime-openmuse/src/audit.ts";

// ─── Fixtures ────────────────────────────────────────────────────────────────

/** An in-memory AuditStore port: exactly append, list, get and getHead. */
interface MemoryAuditStore {
  store: AuditStore;
  order: string[];
  replace: (index: number, mutate: (entry: AuditEntry) => AuditEntry) => void;
  swap: (a: number, b: number) => void;
  truncate: () => void;
}

function createMemoryAuditStore(): MemoryAuditStore {
  const rows = new Map<string, AuditEntry>();
  const order: string[] = [];
  let head: string | undefined;
  const store: AuditStore = {
    async append(entry) {
      if (rows.has(entry.id)) return; // no duplicate rows, head untouched
      rows.set(entry.id, entry);
      order.push(entry.id);
      head = entry.id;
    },
    async list() {
      return order.map((id) => rows.get(id)).filter((row): row is AuditEntry => row !== undefined);
    },
    async get(id) {
      return rows.get(id);
    },
    async getHead() {
      return head;
    },
  };
  return {
    store,
    order,
    replace(index, mutate) {
      const id = order[index];
      if (id === undefined) throw new Error(`no stored entry at index ${index}`);
      rows.set(id, mutate(rows.get(id) as AuditEntry));
    },
    swap(a, b) {
      const temp = order[a];
      if (temp === undefined || order[b] === undefined) throw new Error("swap out of range");
      order[a] = order[b] as string;
      order[b] = temp;
    },
    truncate() {
      order.pop(); // the readable tail disappears; the stored head does not
    },
  };
}

const authorization = (overrides: Partial<TargetAuthorization> = {}): TargetAuthorization => ({
  ownerId: OWNER,
  targetId: "target-example",
  scope: ["observe"],
  environments: [ENVIRONMENT],
  retention: "ephemeral",
  benchmarkOwned: false,
  createdAt: FIXED_ISO,
  ...overrides,
});

const specOf = (auth: TargetAuthorization): ReconstructionSpec => ({
  specVersion: "0.1",
  reconstructionId: "recon-w1-011",
  targetId: auth.targetId,
  name: "Example App",
  platform: "web",
  entrypoints: ["https://app.example/"],
  authorization: auth,
  exploration: { maxStages: 4, maxActions: 40, maxDurationMs: 600_000, seed: 7 },
  synthesis: {
    targetStack: "web",
    allowNetwork: false,
    packagePolicy: "verified-only",
  },
  verification: {
    journeys: ["home"],
    visual: true,
    network: false,
    state: false,
    maxRepairIterations: 2,
  },
});

/** Mints a REAL W1-008 authorization record through authorizeTarget. */
async function mintRecord(
  retention: "ephemeral" | "project" | "library",
  targetId: string,
): Promise<AuthorizationRecord> {
  const records = new Map<string, AuthorizationRecord>();
  const store: AuthorizationStore = {
    async get(key) {
      return records.get(key);
    },
    async put(key, record) {
      records.set(key, record);
    },
  };
  return authorizeTarget(specOf(authorization({ retention, targetId })), {
    operatorIdentity: OPERATOR,
    store,
  });
}

async function mintRecords(): Promise<{
  ephemeral: AuthorizationRecord;
  project: AuthorizationRecord;
  library: AuthorizationRecord;
}> {
  return {
    ephemeral: await mintRecord("ephemeral", "target-ephemeral"),
    project: await mintRecord("project", "target-project"),
    library: await mintRecord("library", "target-library"),
  };
}

/** The four event kinds, appended in the order the work item names them. */
const EVENTS: {
  event: {
    kind: ClappAuditKind;
    subjectId: string;
    occurredAt: string;
    summary: string;
    detail?: string;
  };
  recordKind: "ephemeral" | "project" | "library";
}[] = [
  {
    event: {
      kind: "authorization",
      subjectId: "target-project",
      occurredAt: FIXED_ISO,
      summary: "target authorization persisted",
      detail: "operator granted the observe scope",
    },
    recordKind: "project",
  },
  {
    event: {
      kind: "observation",
      subjectId: "recon-w1-011",
      occurredAt: FIXED_ISO,
      summary: "target observation captured",
    },
    recordKind: "ephemeral",
  },
  {
    event: {
      kind: "repair",
      subjectId: "recon-w1-011",
      occurredAt: FIXED_ISO,
      summary: "bounded repair applied",
      detail: "one semantic finding repaired",
    },
    recordKind: "library",
  },
  {
    event: {
      kind: "promotion",
      subjectId: "pkg-form-validation",
      occurredAt: FIXED_ISO,
      summary: "package promoted",
    },
    recordKind: "project",
  },
];

async function appendEvent(
  store: AuditStore,
  event: (typeof EVENTS)[number]["event"],
  record: AuthorizationRecord,
): Promise<AuditEntry> {
  return appendAuditEvent(event, { record, policy: POLICY, store });
}

async function buildRig(): Promise<{
  memory: MemoryAuditStore;
  records: Awaited<ReturnType<typeof mintRecords>>;
  entries: AuditEntry[];
}> {
  const memory = createMemoryAuditStore();
  const records = await mintRecords();
  const entries: AuditEntry[] = [];
  for (const item of EVENTS) {
    entries.push(await appendEvent(memory.store, item.event, records[item.recordKind]));
  }
  return { memory, records, entries };
}

/**
 * Independently recomputes an entry's content-addressed id: the observation
 * package's canonicalJson plus node:crypto sha256 over the canonical core
 * (which includes the previous entry's id). This mirrors the discipline
 * without importing the module's private helpers, pinning the contract.
 */
function recomputedId(entry: AuditEntry): string {
  const core = {
    authorizationRecordId: entry.authorizationRecordId,
    detail: entry.detail ?? null,
    expiresAt: entry.retention.expiresAt ?? null,
    kind: entry.kind,
    occurredAt: entry.occurredAt,
    prevEntryId: entry.prevEntryId ?? null,
    retentionClass: entry.retention.class,
    subjectId: entry.subjectId,
    summary: entry.summary,
  };
  return (
    AUDIT_ENTRY_ID_PREFIX +
    createHash("sha256").update(canonicalJson(core)).digest("hex").slice(0, 16)
  );
}

/** Builds the four-entry expiry rig shared by tests 4 and 5. */
async function buildExpiryRig(): Promise<{
  memory: MemoryAuditStore;
  records: Awaited<ReturnType<typeof mintRecords>>;
  e1: AuditEntry;
  e2: AuditEntry;
  e3: AuditEntry;
  e4: AuditEntry;
}> {
  const memory = createMemoryAuditStore();
  const records = await mintRecords();
  const t30 = new Date(FIXED_MS + 30_000).toISOString();
  // e1: ephemeral, occurredAt t0 → expiresAt t0+1000 (expired at t0+60s)
  const e1 = await appendEvent(
    memory.store,
    {
      kind: "observation",
      subjectId: "recon-a",
      occurredAt: FIXED_ISO,
      summary: "ephemeral observation",
    },
    records.ephemeral,
  );
  // e2: project, occurredAt t0+30s → expiresAt t0+90s (after t0+60s)
  const e2 = await appendEvent(
    memory.store,
    { kind: "repair", subjectId: "recon-a", occurredAt: t30, summary: "project repair" },
    records.project,
  );
  // e3: library → never expires
  const e3 = await appendEvent(
    memory.store,
    { kind: "promotion", subjectId: "pkg-x", occurredAt: FIXED_ISO, summary: "library promotion" },
    records.library,
  );
  // e4: project, occurredAt t0 → expiresAt t0+60s (exactly AT the boundary instant)
  const e4 = await appendEvent(
    memory.store,
    {
      kind: "authorization",
      subjectId: "target-project",
      occurredAt: FIXED_ISO,
      summary: "project authorization",
    },
    records.project,
  );
  return { memory, records, e1, e2, e3, e4 };
}

// ─── The eight named acceptance tests ────────────────────────────────────────

test("events append to a tamper-evident content-addressed chain", async () => {
  const { memory, records, entries } = await buildRig();

  // the four kinds appended in order
  assert.deepEqual(
    entries.map((entry) => entry.kind),
    ["authorization", "observation", "repair", "promotion"],
  );

  // every id is clapp_audit_ + 16 hex chars of the sha256 of the canonical core
  for (const [index, entry] of entries.entries()) {
    assert.ok(entry.id.startsWith(AUDIT_ENTRY_ID_PREFIX), "id carries the clapp_audit_ prefix");
    assert.equal(entry.id.length, AUDIT_ENTRY_ID_PREFIX.length + 16);
    assert.match(entry.id.slice(AUDIT_ENTRY_ID_PREFIX.length), /^[0-9a-f]{16}$/);
    assert.equal(
      entry.id,
      recomputedId(entry),
      "the id is content-addressed over the canonical core",
    );
    // the canonical core includes the previous entry's id — the hash chain
    assert.equal(entry.prevEntryId, index === 0 ? undefined : entries[index - 1]?.id);
  }
  // pinning the link inside the core: dropping prevEntryId changes the id
  const mid = entries[2] as AuditEntry;
  assert.notEqual(mid.id, recomputedId({ ...mid, prevEntryId: undefined }));

  // the stored head is the newest entry's id
  assert.equal(await memory.store.getHead(), (entries[3] as AuditEntry).id);

  // byte-identical re-append is idempotent: same id, no duplicate row, head untouched
  const again = await appendEvent(
    memory.store,
    EVENTS[0]?.event as (typeof EVENTS)[number]["event"],
    records.project,
  );
  assert.equal(again.id, (entries[0] as AuditEntry).id);
  assert.equal((await memory.store.list()).length, 4);
  assert.equal(await memory.store.getHead(), (entries[3] as AuditEntry).id);

  // determinism: the same events over a fresh store produce byte-identical entries
  const second = createMemoryAuditStore();
  for (const item of EVENTS) {
    await appendEvent(second.store, item.event, records[item.recordKind]);
  }
  assert.deepEqual(
    (await second.store.list()).map((entry) => JSON.stringify(entry)),
    entries.map((entry) => JSON.stringify(entry)),
  );
});

test("tampering with any entry fails closed", async () => {
  // a pristine chain verifies
  const pristine = await buildRig();
  const verification = await verifyAuditChain({ store: pristine.memory.store });
  assert.equal(verification.valid, true);
  assert.equal(verification.entryCount, 4);
  assert.equal(verification.headId, (pristine.entries[3] as AuditEntry).id);

  const cases: {
    name: string;
    tamper: (memory: MemoryAuditStore) => void;
    firstBroken: (entries: AuditEntry[]) => string;
    messageAlso?: (entries: AuditEntry[]) => string;
  }[] = [
    {
      name: "mutated summary",
      tamper: (memory) => memory.replace(2, (entry) => ({ ...entry, summary: "forged summary" })),
      firstBroken: (entries) => (entries[2] as AuditEntry).id,
    },
    {
      name: "mutated detail",
      tamper: (memory) => memory.replace(1, (entry) => ({ ...entry, detail: "forged detail" })),
      firstBroken: (entries) => (entries[1] as AuditEntry).id,
    },
    {
      name: "mutated kind",
      tamper: (memory) => memory.replace(3, (entry) => ({ ...entry, kind: "observation" })),
      firstBroken: (entries) => (entries[3] as AuditEntry).id,
    },
    {
      name: "mutated retention class",
      tamper: (memory) =>
        memory.replace(0, (entry) => ({ ...entry, retention: { class: "library" } })),
      firstBroken: (entries) => (entries[0] as AuditEntry).id,
    },
    {
      name: "mutated expiresAt",
      tamper: (memory) =>
        memory.replace(1, (entry) => ({
          ...entry,
          retention: { class: entry.retention.class, expiresAt: "2030-01-01T00:00:00.000Z" },
        })),
      firstBroken: (entries) => (entries[1] as AuditEntry).id,
    },
    {
      name: "reordered entries",
      tamper: (memory) => memory.swap(0, 1),
      firstBroken: (entries) => (entries[1] as AuditEntry).id,
    },
    {
      name: "truncated chain",
      tamper: (memory) => memory.truncate(),
      firstBroken: (entries) => (entries[2] as AuditEntry).id,
      messageAlso: (entries) => (entries[3] as AuditEntry).id,
    },
  ];

  for (const item of cases) {
    const rig = await buildRig();
    item.tamper(rig.memory);
    let error: unknown;
    try {
      await verifyAuditChain({ store: rig.memory.store });
    } catch (caught) {
      error = caught;
    }
    assert.ok(error instanceof ClappAuditError, `${item.name}: expected ClappAuditError`);
    assert.equal(error.capability, "audit", `${item.name}: capability discriminator`);
    assert.equal(error.reason, "broken-chain", `${item.name}: reason`);
    const firstBroken = item.firstBroken(rig.entries);
    assert.equal(error.entryId, firstBroken, `${item.name}: names the first broken entry`);
    assert.ok(
      error.message.includes(firstBroken),
      `${item.name}: message names the first broken entry`,
    );
    if (item.messageAlso !== undefined) {
      assert.ok(
        error.message.includes(item.messageAlso(rig.entries)),
        `${item.name}: message names the stored head`,
      );
    }
  }
});

test("per-record retention derives from the authorization record", async () => {
  const records = await mintRecords();
  // the derivation inputs are REAL W1-008 records minted through authorizeTarget
  assert.equal(records.ephemeral.retention, "ephemeral");
  assert.equal(records.project.retention, "project");
  assert.equal(records.library.retention, "library");

  const occurredAt = "2025-06-01T12:00:00.000Z";
  const ephemeral = deriveAuditRetention(records.ephemeral, POLICY, occurredAt);
  assert.deepEqual(ephemeral, { class: "ephemeral", expiresAt: "2025-06-01T12:00:01.000Z" });

  const project = deriveAuditRetention(records.project, POLICY, occurredAt);
  assert.deepEqual(project, { class: "project", expiresAt: "2025-06-01T12:01:00.000Z" });

  const library = deriveAuditRetention(records.library, POLICY, occurredAt);
  assert.deepEqual(library, { class: "library" });
  assert.ok(!("expiresAt" in library), "library retention carries no expiresAt — it never expires");

  // pure and deterministic: byte-identical across re-runs
  assert.equal(
    JSON.stringify(deriveAuditRetention(records.ephemeral, POLICY, occurredAt)),
    JSON.stringify(ephemeral),
  );
  assert.equal(
    JSON.stringify(deriveAuditRetention(records.project, POLICY, occurredAt)),
    JSON.stringify(project),
  );
  assert.equal(
    JSON.stringify(deriveAuditRetention(records.library, POLICY, occurredAt)),
    JSON.stringify(library),
  );
  // a re-mint of the same authorization (same content-addressed record) derives identically
  const reminted = await mintRecord("ephemeral", "target-ephemeral");
  assert.equal(reminted.id, records.ephemeral.id);
  assert.equal(
    JSON.stringify(deriveAuditRetention(reminted, POLICY, occurredAt)),
    JSON.stringify(ephemeral),
  );
});

test("expired records are excluded from reads", async () => {
  const { memory, e1, e2, e3, e4 } = await buildExpiryRig();

  // control: at t0 nothing is expired yet
  const atStart = await readAuditLog({ store: memory.store, now: fixedClock });
  assert.deepEqual(
    atStart.map((entry) => entry.id),
    [e1.id, e2.id, e3.id, e4.id],
  );

  // at t0+60s: the ephemeral entry (expiresAt t0+1000, strictly before) is excluded;
  // the project entry expiring at t0+90s remains; the library entry never expires;
  // the project entry whose expiresAt is exactly AT the instant remains (strictly
  // before = expired, at or after = valid — the W1-008 boundary)
  const atBoundary = await readAuditLog({ store: memory.store, now: () => FIXED_MS + 60_000 });
  assert.deepEqual(
    atBoundary.map((entry) => entry.id),
    [e2.id, e3.id, e4.id],
  );
  assert.ok(!atBoundary.some((entry) => entry.id === e1.id));

  // strictly-before from the other side: at t0+999 the ephemeral entry (expiresAt
  // t0+1000) is NOT yet expired
  const justBefore = await readAuditLog({ store: memory.store, now: () => FIXED_MS + 999 });
  assert.ok(justBefore.some((entry) => entry.id === e1.id));

  // far past every derived expiry: only the library entry remains
  const farPast = await readAuditLog({ store: memory.store, now: () => FIXED_MS + 3_600_000 });
  assert.deepEqual(
    farPast.map((entry) => entry.id),
    [e3.id],
  );
});

test("prior inclusion remains provable for expired entries", async () => {
  const { memory, e1, e2, e3, e4 } = await buildExpiryRig();

  // e1 is excluded from reads at the boundary instant
  const readable = await readAuditLog({ store: memory.store, now: () => FIXED_MS + 60_000 });
  assert.ok(!readable.some((entry) => entry.id === e1.id));

  // ...but its prior inclusion is still proven: the membership check recomputes
  // the chain over the STORED entries (expired included) and matches the stored head
  const proof = await proveInclusion(e1.id, { store: memory.store });
  assert.equal(proof.entryId, e1.id);
  assert.equal(proof.index, 0);
  assert.equal(proof.prevEntryId, undefined); // the genesis entry links to nothing
  assert.deepEqual(proof.entry, e1);
  assert.equal(proof.entryCount, 4);
  assert.equal(proof.headId, e4.id);

  // chain integrity is still required for the proof: tampering another stored
  // entry fails the proof closed (a proof that does not recompute the chain is not a proof)
  const tampered = await buildExpiryRig();
  tampered.memory.replace(2, (entry) => ({ ...entry, summary: "forged" }));
  await assert.rejects(
    proveInclusion(tampered.e1.id, { store: tampered.memory.store }),
    (error) => {
      assert.ok(error instanceof ClappAuditError);
      assert.equal(error.reason, "broken-chain");
      return true;
    },
  );

  // an id that was never in the chain fails closed — never a fabricated proof
  await assert.rejects(
    proveInclusion(`${AUDIT_ENTRY_ID_PREFIX}${"0".repeat(16)}`, { store: memory.store }),
    (error) => {
      assert.ok(error instanceof ClappAuditError);
      assert.equal(error.reason, "unknown-entry");
      return true;
    },
  );

  // exclusion from reads never mutated or weakened the stored chain
  assert.deepEqual(
    (await memory.store.list()).map((entry) => JSON.stringify(entry)),
    [e1, e2, e3, e4].map((entry) => JSON.stringify(entry)),
  );
  assert.equal(await memory.store.getHead(), e4.id);
  const verification = await verifyAuditChain({ store: memory.store });
  assert.equal(verification.valid, true);
  assert.equal(verification.entryCount, 4);
});

test("the store port is narrow and the module performs no I/O", async () => {
  const source = readFileSync(new URL(AUDIT_SOURCE, import.meta.url), "utf8");

  // no I/O imports: exactly one node: import — node:crypto for content addressing
  const nodeImports = [...source.matchAll(/["']node:([a-z_]+)["']/g)].map((match) => match[1]);
  assert.deepEqual(nodeImports, ["crypto"]);
  assert.ok(!/\bfetch\s*\(/.test(source), "no fetch call");

  // no direct wall-clock call: the clock is the injected `now` only (the default
  // binds the Date.now REFERENCE for production callers — it is never called here)
  assert.ok(!/\bDate\.now\s*\(\s*\)/.test(source), "no direct Date.now call");

  // the AuditStore port declares exactly the four declared operations
  const interfaceMatch = source.match(/export interface AuditStore \{([\s\S]*?)\n\}/);
  assert.ok(interfaceMatch !== null, "the AuditStore interface is declared");
  const operations = [...String(interfaceMatch?.[1]).matchAll(/^\s{2}([a-zA-Z]+)\s*\(/gm)]
    .map((match) => match[1])
    .sort();
  assert.deepEqual(operations, ["append", "get", "getHead", "list"]);

  // runtime narrowness: through append, read, verify and proof the module touches
  // only the port's four operations — nothing else is ever accessed
  const memory = createMemoryAuditStore();
  const records = await mintRecords();
  const accessed: string[] = [];
  const store: AuditStore = new Proxy({} as AuditStore, {
    get(_target, property) {
      if (typeof property !== "string") return undefined;
      accessed.push(property);
      const value = (memory.store as unknown as Record<string, unknown>)[property];
      return typeof value === "function" ? value.bind(memory.store) : value;
    },
  });
  await appendEvent(store, EVENTS[0]?.event as (typeof EVENTS)[number]["event"], records.project);
  await appendEvent(store, EVENTS[1]?.event as (typeof EVENTS)[number]["event"], records.ephemeral);
  await readAuditLog({ store, now: fixedClock });
  await verifyAuditChain({ store });
  const firstId = (await memory.store.list())[0]?.id;
  assert.ok(firstId !== undefined);
  await proveInclusion(firstId, { store });
  await assert.rejects(proveInclusion(`${AUDIT_ENTRY_ID_PREFIX}${"0".repeat(16)}`, { store }));
  for (const name of new Set(accessed)) {
    assert.ok(
      ["append", "list", "get", "getHead"].includes(name),
      `the module touched a non-port property "${name}"`,
    );
  }

  // the in-memory port itself exposes exactly the declared operations
  assert.deepEqual(Object.keys(memory.store).sort(), ["append", "get", "getHead", "list"]);
});

test("reads are honest and fail closed on malformed entries", async () => {
  const memory = createMemoryAuditStore();
  const records = await mintRecords();
  await appendEvent(
    memory.store,
    {
      kind: "authorization",
      subjectId: "target-project",
      occurredAt: FIXED_ISO,
      summary: "authorization persisted",
    },
    records.project,
  );
  await appendEvent(
    memory.store,
    {
      kind: "observation",
      subjectId: "recon-w1-011",
      occurredAt: FIXED_ISO,
      summary: "observation captured",
    },
    records.ephemeral,
  );

  // unknown subject or kind filters return empty — never an error, never a guess
  assert.deepEqual(
    await readAuditLog({ store: memory.store, now: fixedClock, subjectId: "no-such-subject" }),
    [],
  );
  assert.deepEqual(
    await readAuditLog({ store: memory.store, now: fixedClock, kind: "promotion" }),
    [],
  );
  assert.deepEqual(
    await readAuditLog({
      store: memory.store,
      now: fixedClock,
      kind: "nonsense" as ClappAuditKind,
    }),
    [],
  );

  // known filters return exactly the matching entries
  const observations = await readAuditLog({
    store: memory.store,
    now: fixedClock,
    kind: "observation",
  });
  assert.equal(observations.length, 1);
  assert.equal(observations[0]?.subjectId, "recon-w1-011");

  // a malformed stored entry makes the read fail closed with a precise message
  // naming it — never a silent skip, never a silent inclusion
  const entries = await memory.store.list();
  const malformedId = entries[1]?.id;
  assert.ok(malformedId !== undefined);
  memory.replace(1, (entry) => ({ ...entry, summary: "" }));
  await assert.rejects(readAuditLog({ store: memory.store, now: fixedClock }), (error) => {
    assert.ok(error instanceof ClappAuditError);
    assert.equal(error.reason, "broken-chain");
    assert.equal(error.entryId, malformedId);
    assert.ok(error.message.includes("malformed"));
    assert.ok(error.message.includes("summary"));
    return true;
  });

  // verification fails closed on the same malformed entry too
  await assert.rejects(verifyAuditChain({ store: memory.store }), (error) => {
    assert.ok(error instanceof ClappAuditError);
    assert.equal(error.reason, "broken-chain");
    assert.equal(error.entryId, malformedId);
    return true;
  });
});

test("append validation is precise and nothing persists on failure", async () => {
  const records = await mintRecords();

  const malformed: { name: string; event: unknown }[] = [
    {
      name: "kind outside the four",
      event: {
        kind: "authorization-x",
        subjectId: "recon-a",
        occurredAt: FIXED_ISO,
        summary: "summary",
      },
    },
    {
      name: "missing subjectId",
      event: { kind: "observation", occurredAt: FIXED_ISO, summary: "summary" },
    },
    {
      name: "empty subjectId",
      event: { kind: "observation", subjectId: "", occurredAt: FIXED_ISO, summary: "summary" },
    },
    {
      name: "empty summary",
      event: { kind: "repair", subjectId: "recon-a", occurredAt: FIXED_ISO, summary: "" },
    },
    {
      name: "missing summary",
      event: { kind: "repair", subjectId: "recon-a", occurredAt: FIXED_ISO },
    },
    {
      name: "unparseable occurredAt",
      event: {
        kind: "promotion",
        subjectId: "pkg-x",
        occurredAt: "not-a-timestamp",
        summary: "summary",
      },
    },
    {
      name: "missing occurredAt",
      event: { kind: "promotion", subjectId: "pkg-x", summary: "summary" },
    },
  ];
  for (const item of malformed) {
    const memory = createMemoryAuditStore();
    await assert.rejects(
      appendAuditEvent(item.event as ClappAuditEvent, {
        record: records.project,
        policy: POLICY,
        store: memory.store,
      }),
      (error) => {
        assert.ok(error instanceof ClappAuditError, `${item.name}: expected ClappAuditError`);
        assert.equal(error.capability, "audit", `${item.name}: capability discriminator`);
        assert.equal(error.reason, "invalid-event", `${item.name}: reason`);
        assert.ok(
          Array.isArray(error.violations) && error.violations.length > 0,
          `${item.name}: violations are collected`,
        );
        assert.ok(
          error.message.includes(error.violations?.[0] as string),
          `${item.name}: the message names the violation`,
        );
        return true;
      },
    );
    // nothing persisted: the port stays empty and the head is untouched
    assert.deepEqual(await memory.store.list(), [], `${item.name}: nothing appended`);
    assert.equal(await memory.store.getHead(), undefined, `${item.name}: head untouched`);
  }

  // collected: every violation of a multiply-malformed event is named in ONE error
  const memory = createMemoryAuditStore();
  await assert.rejects(
    appendAuditEvent(
      {
        kind: "bogus",
        subjectId: "",
        occurredAt: "nope",
        summary: "",
      } as unknown as ClappAuditEvent,
      { record: records.project, policy: POLICY, store: memory.store },
    ),
    (error) => {
      assert.ok(error instanceof ClappAuditError);
      assert.equal(error.reason, "invalid-event");
      assert.equal(error.violations?.length, 4);
      assert.ok(error.message.includes("outside the frozen union"));
      assert.ok(error.message.includes("subject id"));
      assert.ok(error.message.includes("summary"));
      assert.ok(error.message.includes("parseable ISO-8601"));
      return true;
    },
  );
  assert.deepEqual(await memory.store.list(), []);
  assert.equal(await memory.store.getHead(), undefined);

  // a malformed authorization record fails closed with nothing persisted
  const recordMemory = createMemoryAuditStore();
  await assert.rejects(
    appendAuditEvent(
      { kind: "observation", subjectId: "recon-a", occurredAt: FIXED_ISO, summary: "summary" },
      {
        record: { ...records.project, retention: "bogus" } as unknown as AuditAuthorizationRecord,
        policy: POLICY,
        store: recordMemory.store,
      },
    ),
    (error) => {
      assert.ok(error instanceof ClappAuditError);
      assert.equal(error.reason, "invalid-record");
      assert.ok(error.message.includes("outside the frozen union"));
      return true;
    },
  );
  assert.deepEqual(await recordMemory.store.list(), []);

  // a malformed retention policy fails closed with nothing persisted
  const policyMemory = createMemoryAuditStore();
  await assert.rejects(
    appendAuditEvent(
      { kind: "observation", subjectId: "recon-a", occurredAt: FIXED_ISO, summary: "summary" },
      {
        record: records.project,
        policy: { ephemeralMs: -1, projectMs: 60_000 },
        store: policyMemory.store,
      },
    ),
    (error) => {
      assert.ok(error instanceof ClappAuditError);
      assert.equal(error.reason, "invalid-policy");
      assert.ok(error.message.includes("ephemeralMs"));
      return true;
    },
  );
  assert.deepEqual(await policyMemory.store.list(), []);

  // The FROZEN tests/clapp-w1-008-authorization.test.ts passes unmodified in the
  // full battery — confirmed in the delivery record (tests/clapp-w1-008 is never
  // touched by this lane).
});
