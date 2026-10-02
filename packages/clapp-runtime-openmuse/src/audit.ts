import { createHash } from "node:crypto";
import { ClappRuntimeError } from "./errors.ts";

/**
 * CLAPP-W1-011 — audit/retention enforcement.
 *
 * CLAPP-W1-011 (docs/clapp/WORK_ITEMS.md): "authorization, observation,
 * repair, and promotion events append to a tamper-evident audit log
 * (content-addressed chain) with per-record retention derived from the
 * authorization record, and expired records are excluded from reads while
 * their prior inclusion remains provable." This module implements the audit
 * log itself — the chain, the retention derivation, the reads, the proofs —
 * and performs no I/O of its own:
 *
 * - `appendAuditEvent` is the append path: it validates the caller-supplied
 *   event precisely and with collected violations (nothing is appended when
 *   any exists), derives the entry's per-record retention from the event's
 *   authorization context (`deriveAuditRetention`, consumed STRUCTURALLY
 *   through the local `AuditAuthorizationRecord` type — the real W1-008
 *   `AuthorizationRecord` from packages/clapp-observation satisfies it
 *   structurally, the frozen-contract idiom; no new package dependency), and
 *   appends exactly one content-addressed entry through the narrow
 *   `AuditStore` port, where the canonical core includes the PREVIOUS
 *   entry's id — a hash chain. A byte-identical re-append of the same event
 *   is idempotent: the same id, no duplicate row, the chain untouched. The
 *   module reads no wall clock anywhere: occurredAt is caller-supplied,
 *   expiresAt is derived from it, and the content-addressed id derives from
 *   content only.
 * - `readAuditLog` is the read path: it verifies the whole stored chain
 *   first (integrity before disclosure — a malformed or tampered entry fails
 *   the read closed, never a silent skip, never a silent inclusion), then
 *   excludes entries whose derived expiresAt is strictly before the
 *   evaluation instant (the W1-008 expiry discipline exactly: strictly
 *   before = expired, at or after = valid; a record with no expiresAt never
 *   expires — `library` retention NEVER expires). Unknown kind/subject
 *   filters match nothing: an empty result, never an error, never a guess.
 *   The evaluation clock is an injectable `now` dependency (default
 *   `Date.now` for production callers, pinned by tests); expiry is
 *   evaluated against this source only.
 * - `verifyAuditChain` recomputes every entry id and every chain link from
 *   the stored entries and the stored head: any mutation (summary, detail,
 *   kind, retention, expiresAt, order) or truncation (the stored head no
 *   longer matching the readable chain's last entry) fails closed naming
 *   the FIRST broken entry.
 * - `proveInclusion` is the proof path: exclusion from reads NEVER destroys
 *   the proof. The membership check recomputes the chain over the STORED
 *   entries — expired ones included — requires chain integrity and a head
 *   match, and proves the (possibly expired) entry's prior inclusion. An
 *   expired record's absence from reads and its presence in the proof are
 *   both honest outputs of the same stored chain; nothing ever rewrites or
 *   weakens a stored entry.
 *
 * Persistence flows exclusively through AuditStore (append, list, get and
 * the head pointer — NOTHING else, the W2-005 narrow-port discipline);
 * tests supply an in-memory port. Wiring the four producing stages (the
 * authorize path, the observation adapter, the repair loop, the promotion
 * gate) to append real events is a later tech-lead wave: those modules live
 * in other lanes' and packages' constitutions. This module delivers the
 * audit log itself.
 */

// ─── The identifier prefix ───────────────────────────────────────────────────

/**
 * Prefix of every persisted audit entry id. Ids are content-addressed: this
 * prefix plus a sha256 prefix of the entry's canonical core — the same
 * discipline as the W2-006 package ids, the W1-008 authorization-record ids
 * and the `rr-` repair-report ids — where the canonical core includes the
 * PREVIOUS entry's id, making the log a hash chain.
 *
 * PENDING CONTRACTS REVISION (tech-lead owned): `clapp_audit_` is not yet
 * listed in docs/clapp/CONTRACTS.md "Core identifiers". Adding it requires
 * an ADR and updated acceptance criteria per CONTRACTS.md "Compatibility"
 * (ADR-003 is the precedent for how identifiers join the Core list); this
 * constant declares the prefix locally until that revision lands, and no
 * frozen contract or doc file is edited here.
 */
export const AUDIT_ENTRY_ID_PREFIX = "clapp_audit_";

/** Hex characters of the sha256 digest used in an audit entry id. */
const ID_HASH_LENGTH = 16;

// ─── Content addressing (the W2-006/W1-008 discipline, declared locally) ─────

/**
 * sha256 hex digest over text (text digests as UTF-8). Declared locally in
 * this module — the runtime package carries no canonical-serialization
 * helper and adds no dependency — mirroring the observation package's
 * helper byte-for-byte so ids computed here follow the exact discipline of
 * the W2-006 package ids and the W1-008 authorization-record ids.
 */
const sha256Hex = (text: string): string => createHash("sha256").update(text).digest("hex");

/**
 * Canonical JSON serialization: object keys sorted recursively, arrays kept
 * in order, no whitespace, `undefined` normalized to `null` so optional
 * fields cannot destabilize digests. Declared locally (see sha256Hex) and
 * byte-identical to the observation package's discipline: two structurally
 * equal values always serialize to identical bytes regardless of
 * construction order.
 */
function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

// ─── The event vocabulary ────────────────────────────────────────────────────

/** The frozen union of SECURITY.md event kinds the audit log accepts. */
const AUDIT_KINDS: readonly string[] = ["authorization", "observation", "repair", "promotion"];

/** The frozen artifact-retention union of the TargetAuthorization contract. */
const RETENTION_CLASSES: readonly string[] = ["ephemeral", "project", "library"];

/**
 * The four event kinds the work item names, verbatim: authorization,
 * observation, repair and promotion. An event kind outside this union fails
 * closed at append with a collected typed error; nothing persists.
 */
export type ClappAuditKind = "authorization" | "observation" | "repair" | "promotion";

/**
 * The caller-supplied audit event. The kind is one of the four; the subject
 * is what the event is about (a reconstruction id, target id or package id —
 * a non-empty string); occurredAt is the caller-supplied ISO-8601 occurrence
 * time — NEVER clock-derived, the module reads no wall clock anywhere; the
 * summary is non-empty; the detail is an optional string.
 */
export interface ClappAuditEvent {
  /** The SECURITY.md event kind (one of the four). */
  kind: ClappAuditKind;
  /** The subject the event is about (reconstruction, target or package id). */
  subjectId: string;
  /** The caller-supplied ISO-8601 occurrence time — never clock-derived. */
  occurredAt: string;
  /** A non-empty human-readable summary of what happened. */
  summary: string;
  /** An optional detail string. */
  detail?: string;
}

/**
 * The authorization record the retention derivation consumes, STRUCTURALLY
 * (the frozen-contract idiom): a local record-like type carrying exactly the
 * fields the derivation reads — the record's content-addressed id, the
 * target it authorizes, and its SECURITY.md allowed artifact retention. The
 * real W1-008 `AuthorizationRecord`
 * (packages/clapp-observation/src/authorization.ts) satisfies it
 * structurally, so no new package dependency is added and no frozen file is
 * edited.
 */
export interface AuditAuthorizationRecord {
  /** Content-addressed record id (clapp_authz_ + sha256 prefix of the canonical core). */
  readonly id: string;
  /** The target this record authorizes. */
  readonly targetId: string;
  /** SECURITY.md: allowed artifact retention (the frozen union). */
  readonly retention: "ephemeral" | "project" | "library";
}

/** The frozen artifact-retention classes, as the audit log names them. */
export type AuditRetentionClass = "ephemeral" | "project" | "library";

/**
 * The caller-declared retention policy mapping retention classes to windows:
 * `ephemeral` entries expire at occurredAt + ephemeralMs, `project` entries
 * at occurredAt + projectMs, and `library` entries NEVER expire (the policy
 * carries no library window at all).
 */
export interface AuditRetentionPolicy {
  /** The ephemeral retention window in milliseconds. */
  ephemeralMs: number;
  /** The project retention window in milliseconds. */
  projectMs: number;
}

/**
 * An audit entry's per-record retention: the class derived from the
 * authorization record plus the derived expiry `occurredAt + window` for
 * ephemeral/project entries — and NO expiresAt for library entries, which
 * never expire.
 */
export interface AuditRetention {
  /** The retention class, taken from the authorization record. */
  readonly class: AuditRetentionClass;
  /** Derived expiry (occurredAt + the class's policy window); ABSENT for library. */
  readonly expiresAt?: string;
}

/**
 * One persisted audit entry. Immutable once stored: the content-addressed id
 * pins every field, and any later mutation is detected by
 * `verifyAuditChain`. The entry carries no clock-derived field — occurredAt
 * is the caller-supplied event time, expiresAt is derived from it, and the
 * id derives from content only.
 */
export interface AuditEntry {
  /**
   * Content-addressed id: clapp_audit_ + sha256 prefix of the canonical core,
   * where the core includes the PREVIOUS entry's id — the hash-chain link.
   */
  readonly id: string;
  /** The SECURITY.md event kind (one of the four). */
  readonly kind: ClappAuditKind;
  /** The subject the event is about (reconstruction, target or package id). */
  readonly subjectId: string;
  /** The caller-supplied ISO-8601 occurrence time — never clock-derived. */
  readonly occurredAt: string;
  /** The event's non-empty summary. */
  readonly summary: string;
  /** The event's optional detail — absent when the event carried none. */
  readonly detail?: string;
  /** The per-record retention derived from the authorization record. */
  readonly retention: AuditRetention;
  /** The id of the authorization record the retention was derived from. */
  readonly authorizationRecordId: string;
  /** The previous entry's id — the hash-chain link; absent on the genesis entry. */
  readonly prevEntryId?: string;
}

// ─── The typed audit error ───────────────────────────────────────────────────

/** Why an audit-log operation failed closed. */
export type ClappAuditReason =
  /** The audit event is malformed — collected violations, nothing persisted. */
  | "invalid-event"
  /** The authorization record consumed for the retention derivation is malformed. */
  | "invalid-record"
  /** The retention policy is malformed (windows must be non-negative finite numbers). */
  | "invalid-policy"
  /** The retention cannot be derived (unparseable occurredAt or an overflowing expiry). */
  | "invalid-derivation"
  /** Chain verification failed — the first broken entry is named, never skipped. */
  | "broken-chain"
  /** An inclusion proof was requested for an entry id not in the stored chain. */
  | "unknown-entry";

/**
 * The typed audit error — the `ClappRuntimeError` discipline adapted to the
 * audit capability: the capability discriminator is "audit", the message is
 * precise, and the structured fields carry the collected violations at
 * append and the first broken entry at verify. Like every error in this
 * package it fails closed: it is raised BEFORE anything is persisted, and
 * nothing is reported as verified, read or proven when it is thrown.
 */
export class ClappAuditError extends ClappRuntimeError {
  /** The fail-closed reason (the precise discrimination of this error). */
  readonly reason: ClappAuditReason;
  /** The collected violations (append validation and derivation failures). */
  readonly violations?: readonly string[];
  /** The first broken entry's id (verification) or the proof's target id. */
  readonly entryId?: string;
  /** The first broken entry's chain index; -1 when only the head pointer is broken. */
  readonly index?: number;
  /** The event's subject id, when known at failure. */
  readonly subjectId?: string;
  /** The event's kind, when known at failure. */
  readonly kind?: string;

  constructor(
    reason: ClappAuditReason,
    message: string,
    fields: {
      violations?: readonly string[];
      entryId?: string;
      index?: number;
      subjectId?: string;
      kind?: string;
      cause?: unknown;
    } = {},
  ) {
    super(
      "runtime",
      "audit",
      message,
      fields.cause !== undefined ? { cause: fields.cause } : undefined,
    );
    this.name = "ClappAuditError";
    this.reason = reason;
    if (fields.violations !== undefined) this.violations = [...fields.violations];
    if (fields.entryId !== undefined) this.entryId = fields.entryId;
    if (fields.index !== undefined) this.index = fields.index;
    if (fields.subjectId !== undefined) this.subjectId = fields.subjectId;
    if (fields.kind !== undefined) this.kind = fields.kind;
  }
}

// ─── The narrow store port ───────────────────────────────────────────────────

/**
 * The narrow persistence port for the audit log (the W2-005 narrow-port
 * discipline: append, list, get-by-id and the head pointer — NOTHING else).
 * The module performs no I/O — every durable store lives behind this port
 * and is supplied by the caller; tests supply an in-memory port. The store
 * never filters by expiry: it returns EVERY stored entry (expired ones
 * included), because expiry is a read-side concern and an excluded record's
 * prior inclusion must stay provable over the stored chain.
 */
export interface AuditStore {
  /**
   * Persists the entry and advances the stored head to the entry's id — the
   * atomic append. An entry whose id is already stored is a no-op (no
   * duplicate row).
   */
  append(entry: AuditEntry): Promise<void>;
  /** Returns every stored entry in chain (append) order — expired ones included. */
  list(): Promise<readonly AuditEntry[]>;
  /** Returns the entry stored under id, or undefined when none exists. */
  get(id: string): Promise<AuditEntry | undefined>;
  /** Returns the newest entry's id — the persisted head — or undefined when empty. */
  getHead(): Promise<string | undefined>;
}

/** The append path's dependencies. */
export interface AuditAppendOptions {
  /**
   * The event's authorization context — the W1-008 authorization record the
   * per-record retention is derived from, consumed structurally.
   */
  record: AuditAuthorizationRecord;
  /** The caller-declared retention policy mapping classes to windows. */
  policy: AuditRetentionPolicy;
  /** The narrow persistence port the entry and head are written through. */
  store: AuditStore;
}

/** The read path's dependencies, filters and injectable evaluation clock. */
export interface AuditReadOptions {
  /** The narrow persistence port the chain is read from. */
  store: AuditStore;
  /**
   * The injectable evaluation clock (default `Date.now` for production
   * callers, pinned by tests). Expiry is evaluated against this source only
   * — never a silently read wall clock; no clock-derived field is stored.
   */
  now?: () => number;
  /**
   * Optional kind filter. Unknown values match nothing: an empty result,
   * never an error, never a guess.
   */
  kind?: ClappAuditKind;
  /**
   * Optional subject filter. Unknown values match nothing: an empty result,
   * never an error, never a guess.
   */
  subjectId?: string;
}

/** The chain-wide dependency shared by verification and inclusion proofs. */
export interface AuditChainOptions {
  /** The narrow persistence port the chain is read from. */
  store: AuditStore;
}

/** The successful result of a full chain verification (failures throw). */
export interface AuditVerification {
  /** Always true when returned — verification failures fail closed instead. */
  readonly valid: boolean;
  /** The number of stored entries the chain was verified over. */
  readonly entryCount: number;
  /** The stored head the verification matched to the readable chain's last entry. */
  readonly headId?: string;
}

/** A recomputed-chain proof that one entry is (or was) part of the log. */
export interface AuditInclusionProof {
  /** The proven entry's id. */
  readonly entryId: string;
  /** The proven entry's position in the stored chain (0-based). */
  readonly index: number;
  /** The id of the entry this one links to; absent on the genesis entry. */
  readonly prevEntryId?: string;
  /** The proven entry itself — the evidence whose inclusion is proven. */
  readonly entry: AuditEntry;
  /** The number of stored entries the proof was computed over. */
  readonly entryCount: number;
  /** The stored head the proof matched to the readable chain's last entry. */
  readonly headId?: string;
}

// ─── Validation (precise and collected) ──────────────────────────────────────

/** Whether a value is a finite non-negative number (a retention window). */
function isFiniteNonNegative(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Collects every violation of the audit-event contract so a malformed event
 * fails closed with one precise, complete message — before anything is
 * persisted.
 */
function collectEventViolations(event: ClappAuditEvent): string[] {
  if (typeof event !== "object" || event === null) {
    return ["the audit event must be a non-null object"];
  }
  const violations: string[] = [];
  if (typeof event.kind !== "string" || !AUDIT_KINDS.includes(event.kind)) {
    violations.push(
      `the event kind "${String(event.kind)}" is outside the frozen union (authorization | observation | repair | promotion)`,
    );
  }
  if (typeof event.subjectId !== "string" || event.subjectId === "") {
    violations.push("the event subject id is missing or empty");
  }
  if (
    typeof event.occurredAt !== "string" ||
    event.occurredAt === "" ||
    Number.isNaN(Date.parse(event.occurredAt))
  ) {
    violations.push(
      `the event occurredAt "${String(event.occurredAt)}" is not a parseable ISO-8601 timestamp`,
    );
  }
  if (typeof event.summary !== "string" || event.summary === "") {
    violations.push("the event summary is missing or empty");
  }
  if (event.detail !== undefined && typeof event.detail !== "string") {
    violations.push("the event detail must be a string when present");
  }
  return violations;
}

/**
 * Collects every violation of the structural authorization-record contract
 * (id, targetId, and the frozen retention union) the derivation reads.
 */
function collectRecordViolations(record: AuditAuthorizationRecord): string[] {
  if (typeof record !== "object" || record === null) {
    return ["the authorization record must be a non-null object"];
  }
  const violations: string[] = [];
  if (typeof record.id !== "string" || record.id === "") {
    violations.push("the authorization record id is missing or empty");
  }
  if (typeof record.targetId !== "string" || record.targetId === "") {
    violations.push("the authorization record target id is missing or empty");
  }
  if (typeof record.retention !== "string" || !RETENTION_CLASSES.includes(record.retention)) {
    violations.push(
      `the authorization record retention "${String(record.retention)}" is outside the frozen union (ephemeral | project | library)`,
    );
  }
  return violations;
}

/** Collects every violation of the retention-policy contract. */
function collectPolicyViolations(policy: AuditRetentionPolicy): string[] {
  if (typeof policy !== "object" || policy === null) {
    return ["the retention policy must be a non-null object"];
  }
  const violations: string[] = [];
  if (!isFiniteNonNegative(policy.ephemeralMs)) {
    violations.push("the retention policy ephemeralMs must be a non-negative finite number");
  }
  if (!isFiniteNonNegative(policy.projectMs)) {
    violations.push("the retention policy projectMs must be a non-negative finite number");
  }
  return violations;
}

// ─── Per-record retention derivation ─────────────────────────────────────────

/**
 * Maps the authorization record's retention class through the caller-declared
 * policy into the audit entry's retention: `ephemeral` derives
 * `expiresAt = occurredAt + policy.ephemeralMs`, `project` derives
 * `expiresAt = occurredAt + policy.projectMs`, and `library` NEVER expires
 * (no expiresAt key at all). `occurredAt` is the event's caller-supplied
 * occurrence time — the temporal anchor the window is added to; the
 * derivation reads no clock and derives no field from the wall. Pure and
 * deterministic: the same record, policy and occurredAt always produce a
 * byte-identical retention, and the input record is consumed STRUCTURALLY
 * (the real W1-008 AuthorizationRecord satisfies AuditAuthorizationRecord)
 * and never mutated. Fails closed with a collected typed error when the
 * record, the policy or the occurredAt is malformed, or when the derived
 * expiry overflows the representable time range.
 */
export function deriveAuditRetention(
  record: AuditAuthorizationRecord,
  policy: AuditRetentionPolicy,
  occurredAt: string,
): AuditRetention {
  const recordViolations = collectRecordViolations(record);
  if (recordViolations.length > 0) {
    throw new ClappAuditError(
      "invalid-record",
      `cannot derive audit retention: ${recordViolations.join("; ")}`,
      { violations: recordViolations },
    );
  }
  const policyViolations = collectPolicyViolations(policy);
  if (policyViolations.length > 0) {
    throw new ClappAuditError(
      "invalid-policy",
      `cannot derive audit retention: ${policyViolations.join("; ")}`,
      { violations: policyViolations },
    );
  }
  const occurredAtMs = typeof occurredAt === "string" ? Date.parse(occurredAt) : Number.NaN;
  if (Number.isNaN(occurredAtMs)) {
    throw new ClappAuditError(
      "invalid-derivation",
      `cannot derive audit retention: the occurredAt "${String(occurredAt)}" is not a parseable ISO-8601 timestamp`,
    );
  }
  if (record.retention === "library") {
    return { class: "library" };
  }
  const windowMs = record.retention === "ephemeral" ? policy.ephemeralMs : policy.projectMs;
  const expiresAtDate = new Date(occurredAtMs + windowMs);
  if (Number.isNaN(expiresAtDate.getTime())) {
    throw new ClappAuditError(
      "invalid-derivation",
      `cannot derive audit retention: the derived expiry (occurredAt "${occurredAt}" plus the ${record.retention} window ${windowMs}ms) overflows the representable time range`,
    );
  }
  return { class: record.retention, expiresAt: expiresAtDate.toISOString() };
}

// ─── Content addressing of entries ───────────────────────────────────────────

/**
 * Computes an entry's content-addressed id from its canonical core — the
 * event content, the derived retention (class and expiresAt), the
 * authorization-record provenance and the PREVIOUS entry's id (the
 * hash-chain link; absent on the genesis entry). Deterministic: the same
 * core always hashes to the same id, and ids derive from content only —
 * never from time, randomness or environment.
 */
function auditEntryIdOf(core: {
  kind: ClappAuditKind;
  subjectId: string;
  occurredAt: string;
  summary: string;
  detail?: string;
  retentionClass: AuditRetentionClass;
  expiresAt?: string;
  authorizationRecordId: string;
  prevEntryId?: string;
}): string {
  const canonical = canonicalJson({
    authorizationRecordId: core.authorizationRecordId,
    detail: core.detail ?? null,
    expiresAt: core.expiresAt ?? null,
    kind: core.kind,
    occurredAt: core.occurredAt,
    prevEntryId: core.prevEntryId ?? null,
    retentionClass: core.retentionClass,
    subjectId: core.subjectId,
    summary: core.summary,
  });
  return AUDIT_ENTRY_ID_PREFIX + sha256Hex(canonical).slice(0, ID_HASH_LENGTH);
}

/**
 * The link-free content key of a stored row: everything a byte-identical
 * re-append must match (the event content, the derived retention and the
 * authorization-record provenance) — everything except the chain link,
 * which differs by position. Returns null when the row is not object-like;
 * such a row can never match a validated event's key.
 */
function storedRowContentKey(row: unknown): string | null {
  if (row === null || typeof row !== "object") return null;
  const entry = row as {
    kind?: unknown;
    subjectId?: unknown;
    occurredAt?: unknown;
    summary?: unknown;
    detail?: unknown;
    retention?: { class?: unknown; expiresAt?: unknown } | null;
    authorizationRecordId?: unknown;
  };
  return canonicalJson([
    entry.kind,
    entry.subjectId,
    entry.occurredAt,
    entry.summary,
    entry.detail,
    entry.retention?.class,
    entry.retention?.expiresAt,
    entry.authorizationRecordId,
  ]);
}

// ─── The append path ─────────────────────────────────────────────────────────

/**
 * Appends one audit event to the tamper-evident content-addressed chain.
 *
 * Validation is precise and collected: every violation of the event (and of
 * the record and policy the retention is derived from) is named in one typed
 * error, and NOTHING is appended when any exists — the port stays empty and
 * the head untouched. The per-record retention is derived from the event's
 * authorization context through the caller-declared policy. A byte-identical
 * re-append of the same event (same content, same retention derivation, same
 * record provenance) is idempotent: the already-stored entry is returned —
 * the same id, no duplicate row, the chain and head untouched. Otherwise
 * exactly one entry is appended through the narrow store port, its canonical
 * core including the previous entry's id, and the store's head advances to
 * it. The append reads no clock: occurredAt is caller-supplied, expiresAt is
 * derived from it, and the id derives from content only.
 */
export async function appendAuditEvent(
  event: ClappAuditEvent,
  options: AuditAppendOptions,
): Promise<AuditEntry> {
  const eventViolations = collectEventViolations(event);
  if (eventViolations.length > 0) {
    throw new ClappAuditError(
      "invalid-event",
      `audit event is malformed: ${eventViolations.join("; ")}`,
      {
        violations: eventViolations,
        ...(typeof event.subjectId === "string" ? { subjectId: event.subjectId } : {}),
        ...(typeof event.kind === "string" ? { kind: event.kind } : {}),
      },
    );
  }
  const recordViolations = collectRecordViolations(options.record);
  if (recordViolations.length > 0) {
    throw new ClappAuditError(
      "invalid-record",
      `audit event cannot be appended: the authorization record is malformed: ${recordViolations.join("; ")}`,
      { violations: recordViolations },
    );
  }
  const policyViolations = collectPolicyViolations(options.policy);
  if (policyViolations.length > 0) {
    throw new ClappAuditError(
      "invalid-policy",
      `audit event cannot be appended: the retention policy is malformed: ${policyViolations.join("; ")}`,
      { violations: policyViolations },
    );
  }
  const retention = deriveAuditRetention(options.record, options.policy, event.occurredAt);
  const rows = await options.store.list();
  const contentKey = canonicalJson([
    event.kind,
    event.subjectId,
    event.occurredAt,
    event.summary,
    event.detail,
    retention.class,
    retention.expiresAt,
    options.record.id,
  ]);
  for (const row of rows) {
    const existingKey = storedRowContentKey(row);
    if (existingKey !== null && existingKey === contentKey) {
      return row;
    }
  }
  const headId = rows.length > 0 ? rows[rows.length - 1]?.id : undefined;
  const id = auditEntryIdOf({
    kind: event.kind,
    subjectId: event.subjectId,
    occurredAt: event.occurredAt,
    summary: event.summary,
    detail: event.detail,
    retentionClass: retention.class,
    expiresAt: retention.expiresAt,
    authorizationRecordId: options.record.id,
    prevEntryId: headId,
  });
  const entry: AuditEntry = {
    id,
    kind: event.kind,
    subjectId: event.subjectId,
    occurredAt: event.occurredAt,
    summary: event.summary,
    ...(event.detail !== undefined ? { detail: event.detail } : {}),
    retention,
    authorizationRecordId: options.record.id,
    ...(headId !== undefined ? { prevEntryId: headId } : {}),
  };
  await options.store.append(entry);
  return entry;
}

// ─── The chain walk (the verification core) ──────────────────────────────────

/** Where a stored chain first broke: the index, the entry id and the precise message. */
interface ChainBreak {
  /** The first broken entry's chain index; -1 when only the head pointer is broken. */
  index: number;
  /** The first broken entry's stored id, when it has one. */
  entryId?: string;
  /** The precise failure message naming the first broken entry. */
  message: string;
}

/** The stored id of a row, when it is object-like and carries a non-empty string id. */
function idOfRow(row: unknown): string | undefined {
  if (row === null || typeof row !== "object") return undefined;
  const id = (row as { id?: unknown }).id;
  return typeof id === "string" && id !== "" ? id : undefined;
}

/**
 * Collects every well-formedness violation of one stored row — the precise
 * naming a malformed entry fails closed with. A row that cannot be honestly
 * read as an audit entry (wrong kind, empty subject or summary, unparseable
 * occurredAt or expiresAt, retention outside the union...) is malformed, and
 * verification names it — never a silent skip, never a silent inclusion.
 */
function collectStoredRowViolations(row: unknown): string[] {
  if (row === null || typeof row !== "object") {
    return ["the stored row is not an object"];
  }
  const entry = row as {
    id?: unknown;
    kind?: unknown;
    subjectId?: unknown;
    occurredAt?: unknown;
    summary?: unknown;
    detail?: unknown;
    retention?: { class?: unknown; expiresAt?: unknown } | null;
    authorizationRecordId?: unknown;
    prevEntryId?: unknown;
  };
  const violations: string[] = [];
  const id = entry.id;
  if (typeof id !== "string" || id === "" || !id.startsWith(AUDIT_ENTRY_ID_PREFIX)) {
    violations.push(
      `the entry id "${String(id)}" is missing, empty or does not carry the ${AUDIT_ENTRY_ID_PREFIX} prefix`,
    );
  }
  const kind = entry.kind;
  if (typeof kind !== "string" || !AUDIT_KINDS.includes(kind)) {
    violations.push(
      `the entry kind "${String(kind)}" is outside the frozen union (authorization | observation | repair | promotion)`,
    );
  }
  if (typeof entry.subjectId !== "string" || entry.subjectId === "") {
    violations.push("the entry subject id is missing or empty");
  }
  if (
    typeof entry.occurredAt !== "string" ||
    entry.occurredAt === "" ||
    Number.isNaN(Date.parse(entry.occurredAt))
  ) {
    violations.push(
      `the entry occurredAt "${String(entry.occurredAt)}" is not a parseable ISO-8601 timestamp`,
    );
  }
  if (typeof entry.summary !== "string" || entry.summary === "") {
    violations.push("the entry summary is missing or empty");
  }
  if (entry.detail !== undefined && typeof entry.detail !== "string") {
    violations.push("the entry detail must be a string when present");
  }
  const retention = entry.retention;
  if (retention === null || typeof retention !== "object") {
    violations.push(`the entry retention ${String(retention)} is not an object`);
  } else {
    if (typeof retention.class !== "string" || !RETENTION_CLASSES.includes(retention.class)) {
      violations.push(
        `the entry retention class "${String(retention.class)}" is outside the frozen union (ephemeral | project | library)`,
      );
    }
    if (
      retention.expiresAt !== undefined &&
      (typeof retention.expiresAt !== "string" || Number.isNaN(Date.parse(retention.expiresAt)))
    ) {
      violations.push(
        `the entry retention expiresAt "${String(retention.expiresAt)}" is not a parseable ISO-8601 timestamp`,
      );
    }
  }
  if (typeof entry.authorizationRecordId !== "string" || entry.authorizationRecordId === "") {
    violations.push("the entry authorization record id is missing or empty");
  }
  if (
    entry.prevEntryId !== undefined &&
    (typeof entry.prevEntryId !== "string" || entry.prevEntryId === "")
  ) {
    violations.push("the entry prevEntryId must be a non-empty string when present");
  }
  return violations;
}

/**
 * Recomputes every entry id and every chain link from the stored rows and
 * the stored head, in readable order. Returns the FIRST break — a malformed
 * entry, a broken link, an id that no longer matches its content, or a head
 * that no longer matches the readable tail (truncation) — or null when the
 * stored chain is intact. Pure: it reads the rows and head and computes;
 * it never mutates anything and never skips a row silently.
 */
function walkChain(rows: readonly unknown[], headId: string | undefined): ChainBreak | null {
  let expectedPrev: string | undefined;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const entryId = idOfRow(row);
    const describe = `audit entry ${index}${entryId !== undefined ? ` (${entryId})` : ""}`;
    const violations = collectStoredRowViolations(row);
    if (violations.length > 0) {
      return {
        index,
        ...(entryId !== undefined ? { entryId } : {}),
        message: `${describe} is malformed: ${violations.join("; ")}`,
      };
    }
    const entry = row as AuditEntry;
    if (entry.prevEntryId !== expectedPrev) {
      return {
        index,
        entryId: entry.id,
        message: `${describe} links to ${entry.prevEntryId ?? "no entry"} but the chain's previous readable entry is ${
          expectedPrev ?? "no entry (this should be the chain's first entry)"
        }`,
      };
    }
    const recomputed = auditEntryIdOf({
      kind: entry.kind,
      subjectId: entry.subjectId,
      occurredAt: entry.occurredAt,
      summary: entry.summary,
      detail: entry.detail,
      retentionClass: entry.retention.class,
      expiresAt: entry.retention.expiresAt,
      authorizationRecordId: entry.authorizationRecordId,
      prevEntryId: entry.prevEntryId,
    });
    if (recomputed !== entry.id) {
      return {
        index,
        entryId: entry.id,
        message: `${describe} does not hash to its content-addressed id (its content hashes to ${recomputed}); the entry was mutated`,
      };
    }
    expectedPrev = entry.id;
  }
  const tailId = rows.length > 0 ? idOfRow(rows[rows.length - 1]) : undefined;
  if (headId !== tailId) {
    return {
      index: rows.length - 1,
      ...(tailId !== undefined ? { entryId: tailId } : {}),
      message: `the stored head ${headId ?? "(none)"} does not match the readable chain's last entry ${
        tailId ?? "(none)"
      } over ${rows.length} readable entries; the chain was truncated or the head was rewritten`,
    };
  }
  return null;
}

/** Raises the typed error for a chain break, naming the first broken entry. */
function raiseChainBreak(breakage: ChainBreak): never {
  throw new ClappAuditError("broken-chain", breakage.message, {
    ...(breakage.entryId !== undefined ? { entryId: breakage.entryId } : {}),
    index: breakage.index,
  });
}

// ─── Verification ────────────────────────────────────────────────────────────

/**
 * Recomputes every entry id and every chain link from the stored entries and
 * the stored head. Any mutation (summary, detail, kind, retention,
 * expiresAt, order) or truncation (the stored head no longer matching the
 * readable chain's last entry) fails closed naming the FIRST broken entry —
 * never a silent skip. A pristine chain — including a pristine empty one —
 * verifies and returns the entry count and the matched head.
 */
export async function verifyAuditChain(options: AuditChainOptions): Promise<AuditVerification> {
  const rows = await options.store.list();
  const headId = await options.store.getHead();
  const breakage = walkChain(rows, headId);
  if (breakage !== null) {
    raiseChainBreak(breakage);
  }
  return {
    valid: true,
    entryCount: rows.length,
    ...(headId !== undefined ? { headId } : {}),
  };
}

// ─── The read path ───────────────────────────────────────────────────────────

/**
 * Reads the audit log honestly. The whole stored chain is verified first —
 * integrity before disclosure: a malformed or tampered entry fails the read
 * closed with a precise message naming it, never a silent skip, never a
 * silent inclusion. Then entries whose derived expiresAt is strictly before
 * the evaluation instant (the injectable `now`, default `Date.now`) are
 * excluded — the W1-008 expiry discipline exactly: strictly before =
 * expired, at or after = valid; a record with no expiresAt never expires
 * (library retention NEVER expires). Expiry NEVER destroys the proof: the
 * excluded entries stay stored, and `proveInclusion` still proves their
 * prior inclusion. Unknown kind/subject filters match nothing: an empty
 * result, never an error, never a guess. The returned order is the chain
 * (append) order.
 */
export async function readAuditLog(options: AuditReadOptions): Promise<readonly AuditEntry[]> {
  const now = typeof options.now === "function" ? options.now : Date.now;
  const rows = await options.store.list();
  const headId = await options.store.getHead();
  const breakage = walkChain(rows, headId);
  if (breakage !== null) {
    raiseChainBreak(breakage);
  }
  const instant = now();
  const readable: AuditEntry[] = [];
  for (const entry of rows) {
    const expiresAt = entry.retention.expiresAt;
    if (expiresAt !== undefined) {
      const expiresAtMs = Date.parse(expiresAt);
      if (Number.isNaN(expiresAtMs)) {
        throw new ClappAuditError(
          "broken-chain",
          `audit entry ${entry.id} carries an unparseable expiresAt "${expiresAt}"; refusing to read the log`,
          { entryId: entry.id },
        );
      }
      if (expiresAtMs < instant) {
        continue;
      }
    }
    if (options.kind !== undefined && entry.kind !== options.kind) {
      continue;
    }
    if (options.subjectId !== undefined && entry.subjectId !== options.subjectId) {
      continue;
    }
    readable.push(entry);
  }
  return readable;
}

// ─── The proof path ──────────────────────────────────────────────────────────

/**
 * Proves one entry's prior inclusion in the stored chain — including an
 * entry excluded from reads because its retention expired: expiry removes
 * records from READS, never from PROOF, and nothing here mutates or weakens
 * the stored chain. The proof recomputes every entry id and every chain link
 * over the STORED entries (expired ones included) and requires a head match
 * first — a tampered chain fails the proof closed, because a proof that does
 * not recompute the chain is not a proof. Then the target's id and link are
 * confirmed and returned with its chain position and the full entry. An id
 * not in the readable chain fails closed — distinguishing an id never stored
 * from one stored but detached from the readable chain — never a fabricated
 * proof.
 */
export async function proveInclusion(
  entryId: string,
  options: AuditChainOptions,
): Promise<AuditInclusionProof> {
  const rows = await options.store.list();
  const headId = await options.store.getHead();
  const breakage = walkChain(rows, headId);
  if (breakage !== null) {
    raiseChainBreak(breakage);
  }
  const index = rows.findIndex((row) => row.id === entryId);
  if (index === -1) {
    const stored = await options.store.get(entryId);
    if (stored !== undefined && stored !== null) {
      throw new ClappAuditError(
        "broken-chain",
        `audit entry ${entryId} is stored but is not in the readable chain; the chain was truncated or reordered`,
        { entryId },
      );
    }
    throw new ClappAuditError(
      "unknown-entry",
      `no audit entry with id "${entryId}" is in the stored chain; refusing to fabricate an inclusion proof`,
      { entryId },
    );
  }
  const entry = rows[index] as AuditEntry;
  return {
    entryId,
    index,
    ...(entry.prevEntryId !== undefined ? { prevEntryId: entry.prevEntryId } : {}),
    entry,
    entryCount: rows.length,
    ...(headId !== undefined ? { headId } : {}),
  };
}
