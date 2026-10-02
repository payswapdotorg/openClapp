import type { ReconstructionSpec } from "../../../../packages/clapp-contracts/src/index.ts";
import {
  AUTHORIZATION_RECORD_ID_PREFIX,
  type AuthorizationRecord,
  type AuthorizationStore,
  authorizationRecordKey,
} from "../../../../packages/clapp-observation/src/index.ts";
import type { AgentTask } from "../../../../packages/domain/src/agent.ts";
import type {
  ClappArtifactRecord,
  ClappReconstructionRow,
  ClappRepositories,
} from "./repositories.ts";

/**
 * CLAPP-W1-009 — multi-user hardening of the CLAPP control plane.
 *
 * The W1-007 control plane is owner-scoped everywhere: the service threads a
 * single `owner` string through every operation and the substrate store keeps
 * rows under per-owner keys, so a cross-owner read today collapses into an
 * honest bare 404. The W1-008 authorization module persists a
 * content-addressed `AuthorizationRecord` per target before observation, and
 * that record carries the SECURITY.md operator identity. What this module adds
 * is the multi-user enforcement layer wave 10 lane 2 requires: distinct
 * concurrent operators, strictly isolated task and package scope, and
 * cross-user attempts that fail CLOSED carrying an authorization-record-BACKED
 * denial reason instead of a bare not-found.
 *
 * Composition, never modification: the module wraps the FROZEN W1-007
 * `ClappRepositories` (every same-operator call delegates to them unchanged,
 * the operator identity passed as the owner) and reads backing records
 * exclusively through the FROZEN W1-008 `AuthorizationStore` port, keyed with
 * `authorizationRecordKey(spec.targetId)`. It edits nothing, re-implements
 * nothing, and performs no I/O of its own.
 *
 * The scoping rules, fail-closed throughout:
 *
 * - The operator identity is the scoping key — the session owner the routes
 *   read and the W1-008 record's `operatorIdentity`. Identities are validated
 *   and normalized (non-empty, trimmed) up front; an empty or whitespace-only
 *   identity is refused with the typed scope error BEFORE any store access.
 * - An existing reconstruction is granted to a caller only when BOTH hold:
 *   the row is stored under the caller's own owner key (the wrapped
 *   owner-scoped read finds it), AND the stored authorization record for the
 *   row's target backs the caller — it exists, is well-formed, is unexpired
 *   (`expiresAt` strictly before the evaluation instant no longer backs a
 *   grant), and names the caller as both owner and operator. The burden of
 *   proof is on the stored record; absence of a record is a refusal, never a
 *   pass.
 * - A reconstruction id that exists under another operator is NEVER a bare
 *   not-found and NEVER a silent empty result: every addressing operation
 *   throws `ClappOperatorScopeError` whose denial reason cites the persisted
 *   `clapp_authz_` record (its id plus the owner and operator identity it
 *   names), or states explicitly that no authorization record is persisted
 *   for the target, or names the expiry when the record has lapsed.
 * - An id that exists under no operator keeps the honest not-found path (the
 *   wrapped `null` semantics). Absent and cross-owner are distinguished —
 *   `findSpec` is the honest cross-owner probe — and never conflated.
 * - Denials carry identity-level fields only (ids, owner, operator) — never
 *   another operator's task payloads, event bodies, or artifact records.
 * - The package port enforces the same discipline per package coordinate:
 *   an operator's package view contains only packages in that operator's
 *   scope, and registering or promoting into another operator's scope throws
 *   the typed denial backed by the stored package record's identity fields.
 *
 * Clock discipline: expiry is evaluated against an injectable `now`
 * dependency (defaulting to `Date.now` for production callers, pinned by
 * tests) and the module reads no wall clock implicitly anywhere else. It is
 * deterministic: same inputs, same denials.
 *
 * Out of scope (later tech-lead waves): route-level session wiring (the
 * routes already read the owner from the app-level session middleware) and
 * the real `@clapp/intelligence` registry wiring behind the package port —
 * this module declares the port and its enforcement only.
 */

// ---------------------------------------------------------------------------
// The typed scope error
// ---------------------------------------------------------------------------

/** The capability discriminator every operator-scope refusal carries. */
export const OPERATOR_SCOPE_CAPABILITY = "operator-scope";

/**
 * The structured, identity-level denial fields a scope refusal carries. Only
 * ids, owner and operator identities (and, for package denials, the package
 * coordinate and owning operator scope) ever appear here — never another
 * operator's task payloads, event bodies, or artifact records.
 */
export interface OperatorScopeDenial {
  /** The precise, record-backed refusal reason. */
  reason: string;
  /** What the caller addressed: a reconstruction id or a package coordinate. */
  target?: string;
  /** The persisted authorization record backing the denial, when one exists. */
  authorizationRecordId?: string;
  /** The owner identity that record names. */
  recordOwnerId?: string;
  /** The operator identity that record names. */
  recordOperatorIdentity?: string;
  /** Set when the denial turns on an expired record; names the expiry. */
  expiredAt?: string;
  /** For package-scope denials: the stored package record's id. */
  packageId?: string;
  /** For package-scope denials: the stored package record's version. */
  packageVersion?: string;
  /** For package-scope denials: the operator scope that record is stored in. */
  packageOperatorScope?: string;
}

/**
 * The control-plane scope error — the observation-layer error discipline
 * (a capability discriminator, a precise message) adapted to the multi-user
 * seam. Carries the attempted operation, the caller's operator identity and
 * the structured denial; its own enumerable fields serialize to
 * identity-level strings only. Fail closed: a scope error is the correct
 * output for a cross-user attempt, never a silent skip or a bare not-found
 * for a resource that exists under another operator.
 */
export class ClappOperatorScopeError extends Error {
  /** The capability discriminator: always "operator-scope". */
  readonly capability: typeof OPERATOR_SCOPE_CAPABILITY;
  /** The attempted operation, e.g. "reconstruction read", "package write". */
  readonly operation: string;
  /** The caller's operator identity (the raw input when validation refused it). */
  readonly operatorIdentity: string;
  /** The structured, identity-level denial fields. */
  readonly denial: OperatorScopeDenial;

  constructor(
    operation: string,
    operatorIdentity: string,
    denial: OperatorScopeDenial,
    options?: { cause?: unknown },
  ) {
    super(
      `[clapp:multiuser:${OPERATOR_SCOPE_CAPABILITY}] operator "${operatorIdentity}" is refused "${operation}": ${denial.reason}`,
      options,
    );
    this.name = "ClappOperatorScopeError";
    this.capability = OPERATOR_SCOPE_CAPABILITY;
    this.operation = operation;
    this.operatorIdentity = operatorIdentity;
    this.denial = denial;
  }
}

/** Renders the JSON-level shape of an untrusted value without echoing it. */
function describeKind(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * Validates and normalizes an operator identity: non-empty, trimmed. An
 * empty or whitespace-only identity fails closed with the typed scope error
 * BEFORE any store access — there is no anonymous operator to scope.
 */
export function normalizeOperatorIdentity(operatorIdentity: string): string {
  const trimmed = typeof operatorIdentity === "string" ? operatorIdentity.trim() : "";
  if (trimmed === "") {
    throw new ClappOperatorScopeError(
      "operator identity validation",
      typeof operatorIdentity === "string" ? operatorIdentity : describeKind(operatorIdentity),
      {
        reason:
          "operator identity must be a non-empty trimmed string; refusing before any store access",
      },
    );
  }
  return trimmed;
}

// ---------------------------------------------------------------------------
// Stored-record validation (fail closed, never trusted)
// ---------------------------------------------------------------------------

const AUTHORIZATION_KIND_VALUES: readonly string[] = ["explicit", "implicit-benchmark"];
const RETENTION_VALUES: readonly string[] = ["ephemeral", "project", "library"];

/**
 * Collects every violation of the W1-008 AuthorizationRecord shape a stored
 * record exhibits, so a malformed record fails closed with one precise,
 * complete message instead of being trusted. Violations name the field and
 * the expected kind — never the untrusted value.
 */
function collectStoredRecordViolations(record: unknown, targetId: string): string[] {
  const raw = (record !== null && typeof record === "object" ? record : {}) as Record<
    string,
    unknown
  >;
  const violations: string[] = [];
  if (typeof raw.id !== "string" || !raw.id.startsWith(AUTHORIZATION_RECORD_ID_PREFIX))
    violations.push(
      `id must be a string carrying the ${AUTHORIZATION_RECORD_ID_PREFIX} prefix (found ${describeKind(raw.id)})`,
    );
  if (typeof raw.targetId !== "string" || raw.targetId !== targetId)
    violations.push(
      `targetId must equal the store key's target (found ${describeKind(raw.targetId)})`,
    );
  if (typeof raw.ownerId !== "string" || raw.ownerId === "")
    violations.push(`ownerId must be a non-empty string (found ${describeKind(raw.ownerId)})`);
  if (typeof raw.operatorIdentity !== "string" || raw.operatorIdentity === "")
    violations.push(
      `operatorIdentity must be a non-empty string (found ${describeKind(raw.operatorIdentity)})`,
    );
  if (
    !Array.isArray(raw.scope) ||
    raw.scope.length === 0 ||
    !raw.scope.every((entry) => typeof entry === "string" && entry !== "")
  )
    violations.push(
      `scope must be a non-empty list of non-empty strings (found ${describeKind(raw.scope)})`,
    );
  if (
    !Array.isArray(raw.environments) ||
    raw.environments.length === 0 ||
    !raw.environments.every((entry) => typeof entry === "string" && entry !== "")
  )
    violations.push(
      `environments must be a non-empty list of non-empty strings (found ${describeKind(raw.environments)})`,
    );
  if (typeof raw.retention !== "string" || !RETENTION_VALUES.includes(raw.retention))
    violations.push(
      `retention must be one of ephemeral | project | library (found ${describeKind(raw.retention)})`,
    );
  if (typeof raw.benchmarkOwned !== "boolean")
    violations.push(`benchmarkOwned must be a boolean (found ${describeKind(raw.benchmarkOwned)})`);
  if (
    typeof raw.authorizationKind !== "string" ||
    !AUTHORIZATION_KIND_VALUES.includes(raw.authorizationKind)
  )
    violations.push(
      `authorizationKind must be one of explicit | implicit-benchmark (found ${describeKind(raw.authorizationKind)})`,
    );
  if (typeof raw.grantedAt !== "string" || raw.grantedAt === "")
    violations.push(`grantedAt must be a non-empty string (found ${describeKind(raw.grantedAt)})`);
  if (
    raw.expiresAt !== undefined &&
    (typeof raw.expiresAt !== "string" || Number.isNaN(Date.parse(raw.expiresAt)))
  )
    violations.push(
      `expiresAt must be a parseable timestamp when present (found ${describeKind(raw.expiresAt)})`,
    );
  return violations;
}

// ---------------------------------------------------------------------------
// The operator-scoped repository surface
// ---------------------------------------------------------------------------

/**
 * The W1-007 `ClappRepositories` surface with the operator identity threaded
 * first: every method validates and normalizes the caller, resolves the
 * target row, checks the caller against the backing authorization record,
 * and delegates to the wrapped repositories unchanged on a grant. Same
 * signatures as the frozen surface otherwise (the operator takes the owner
 * position); `findSpec` — cross-owner by design in W1-007 — becomes
 * operator-scoped here: the runtime's own discovery use composes over the
 * raw repositories and stays untouched.
 */
export interface OperatorScopedClappRepositories {
  /** Persists a new reconstruction row into the caller's backed scope. */
  create(operatorIdentity: string, row: ClappReconstructionRow): Promise<ClappReconstructionRow>;
  /** Reads one reconstruction in the caller's scope; `null` when absent. */
  get(operatorIdentity: string, id: string): Promise<ClappReconstructionRow | null>;
  /**
   * The caller's scoped view: only rows stored under the caller AND backed
   * by an unexpired record naming the caller. Unbacked rows are never
   * surfaced; a malformed record refuses the whole view (never trusted).
   */
  list(operatorIdentity: string): Promise<ClappReconstructionRow[]>;
  /** Marks a reconstruction cancelled in the caller's scope (idempotent). */
  markCancelled(operatorIdentity: string, id: string): Promise<void>;
  /** The reconstruction's stage-task chain rows, in the caller's scope only. */
  stageTasks(operatorIdentity: string, reconstructionId: string): Promise<AgentTask[]>;
  /** The reconstruction's artifact index records, in the caller's scope only. */
  artifacts(operatorIdentity: string, reconstructionId: string): Promise<ClappArtifactRecord[]>;
  /**
   * Spec discovery, operator-scoped: the caller's own backed reconstruction
   * resolves its spec; another operator's reconstruction is the typed denial;
   * an absent id is the honest `null`.
   */
  findSpec(operatorIdentity: string, reconstructionId: string): Promise<ReconstructionSpec | null>;
}

// ---------------------------------------------------------------------------
// The operator-scoped package port
// ---------------------------------------------------------------------------

/**
 * Promotion evidence, shape-compatible with the W2-005 registry's evidence
 * (verifiedAt, verificationRunId, optional provenanceNotes). Declared
 * locally: `@clapp/intelligence` is never imported here.
 */
export interface OperatorScopedPromotionEvidence {
  /** ISO-8601 timestamp of the verification that justified promotion. */
  verifiedAt: string;
  /** Id of the verification run that justified promotion. */
  verificationRunId: string;
  /** Optional free-form notes preserved next to the promotion record. */
  provenanceNotes?: string[];
}

/**
 * Deterministic registry list filter, shape-compatible with the W2-005
 * registry's filter (mirrored locally per CONTRACTS.md; the intelligence
 * package is never imported). Passed through to the backing port, which owns
 * the document-level semantics.
 */
export interface OperatorPackageListFilter {
  /** Exact category match. */
  category?: string;
  /** Match when the package's capabilities contain the value. */
  capability?: string;
  /** Match when the package's supported targets contain the value. */
  target?: string;
  /** Candidate/promoted lifecycle filter. */
  status?: "candidate" | "promoted";
}

/**
 * A package record as the backing port stores it: the opaque package
 * document (W2-005 validation belongs to the registry layer, not the scope
 * guard) plus its identity coordinate, lifecycle status and the per-package
 * operator-scope tag this guard enforces.
 */
export interface OperatorScopedPackageRecord {
  /** The package document, opaque to the scope guard. */
  document: unknown;
  /** The package identity coordinate. */
  id: string;
  version: string;
  /** The record's lifecycle status (the W2-005 union). */
  status: "candidate" | "promoted";
  /** The operator whose scope owns this package record. */
  operatorScope: string;
  /** The promotion evidence, when the record is promoted. */
  promotion?: OperatorScopedPromotionEvidence;
}

/**
 * The narrow backing port the package guard enforces operator scope over —
 * the seam the real `@clapp/intelligence` registry wiring (a later
 * tech-lead wave) composes behind. Tests supply a fake port carrying the
 * per-package operator-scope tag; the port stays dumb (get/put/list) and the
 * scope enforcement lives entirely in the guard.
 */
export interface OperatorPackageStore {
  /** Reads the record stored under the (id, version) coordinate, or null. */
  get(id: string, version: string): Promise<OperatorScopedPackageRecord | null>;
  /** Persists the record under its coordinate (a later put replaces an earlier one). */
  put(record: OperatorScopedPackageRecord): Promise<void>;
  /** Every stored record matching the filter, in store order. */
  list(filter?: OperatorPackageListFilter): Promise<OperatorScopedPackageRecord[]>;
}

/**
 * The operator-scoped package surface: the W2-005 registry's operation
 * names (list, get, register, promote) with the operator identity threaded
 * first. An operator's view contains only packages in that operator's
 * scope; a cross-operator package write (registering or promoting into
 * another operator's scope) throws the typed denial backed by the stored
 * package record's identity fields; same-scope operations delegate to the
 * port. Registry-level semantics (document validation, content conflicts,
 * version regression, provenance rewrites) compose at the integration wave.
 */
export interface OperatorScopedPackages {
  /** The operator's package view: only records in the operator's scope. */
  list(
    operatorIdentity: string,
    filter?: OperatorPackageListFilter,
  ): Promise<OperatorScopedPackageRecord[]>;
  /** Reads one package in the operator's scope; `null` when absent. */
  get(
    operatorIdentity: string,
    id: string,
    version: string,
  ): Promise<OperatorScopedPackageRecord | null>;
  /** Registers a package into the operator's scope; cross-scope writes are denied. */
  register(operatorIdentity: string, doc: unknown): Promise<OperatorScopedPackageRecord>;
  /** Promotes a package within the operator's scope; cross-scope writes are denied. */
  promote(
    operatorIdentity: string,
    id: string,
    version: string,
    evidence: OperatorScopedPromotionEvidence,
  ): Promise<OperatorScopedPackageRecord>;
}

// ---------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------

/** The dependencies the operator-scoped guard composes. */
export interface OperatorScopedClappDeps {
  /** The frozen W1-007 owner-scoped repositories the guard wraps. */
  repositories: ClappRepositories;
  /** The W1-008 authorization-record port backing every scope decision. */
  authorizationStore: AuthorizationStore;
  /**
   * The backing package port. Optional: when unwired, every package
   * operation fails closed with a precise refusal instead of guessing.
   */
  packages?: OperatorPackageStore;
  /**
   * The injectable clock expiry is evaluated against. Defaults to `Date.now`
   * for production callers; tests pin it. The module reads no wall clock
   * implicitly anywhere else.
   */
  now?: () => number;
}

/** The multi-user CLAPP surface: scoped repositories and scoped packages. */
export interface OperatorScopedClapp {
  repositories: OperatorScopedClappRepositories;
  packages: OperatorScopedPackages;
}

/** What a scope resolution decided for an addressed reconstruction. */
type ScopeResolution = { status: "granted"; row: ClappReconstructionRow } | { status: "absent" };

/** Deterministic, key-sorted JSON rendering for evidence comparison. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Reads a usable (non-empty) string field off an untrusted object. */
function stringFieldOf(value: unknown, field: string): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const raw = (value as Record<string, unknown>)[field];
  return typeof raw === "string" && raw !== "" ? raw : undefined;
}

/**
 * Creates the multi-user enforcement layer over the frozen W1-007
 * repositories and the W1-008 authorization store. Every method takes the
 * operator identity first; same-operator access delegates to the wrapped
 * repositories unchanged (the operator as owner), and every cross-user
 * attempt fails closed with a typed, record-backed denial.
 */
export function createOperatorScopedClapp(deps: OperatorScopedClappDeps): OperatorScopedClapp {
  const wrapped = deps.repositories;
  const authorizationStore = deps.authorizationStore;
  const packageStore = deps.packages;
  const now = typeof deps.now === "function" ? deps.now : Date.now;

  const isExpired = (record: AuthorizationRecord): boolean =>
    record.expiresAt !== undefined && Date.parse(record.expiresAt) < now();

  /**
   * Reads the backing record for a target through the W1-008 port.
   * `undefined` when none is persisted; a malformed stored shape throws the
   * precise fail-closed error instead of being trusted.
   */
  const readBackingRecord = async (
    targetId: string,
    operation: string,
    operator: string,
  ): Promise<AuthorizationRecord | undefined> => {
    const stored = await authorizationStore.get(authorizationRecordKey(targetId));
    if (stored === undefined) return undefined;
    const violations = collectStoredRecordViolations(stored, targetId);
    if (violations.length > 0) {
      throw new ClappOperatorScopeError(operation, operator, {
        reason: `the stored authorization record under key "${authorizationRecordKey(targetId)}" is malformed: ${violations.join("; ")}; refusing to trust it`,
        target: targetId,
      });
    }
    return stored;
  };

  /** Fails closed when a spec-shaped value carries no usable targetId. */
  const targetIdOfSpec = (
    spec: unknown,
    operation: string,
    operator: string,
    described: string,
  ): string => {
    const targetId = stringFieldOf(spec, "targetId");
    if (targetId === undefined) {
      throw new ClappOperatorScopeError(operation, operator, {
        reason: `${described} does not carry a usable targetId; refusing to resolve its scope`,
      });
    }
    return targetId;
  };

  /**
   * Requires a stored record that backs the caller for the target: present,
   * well-formed, unexpired, and naming the caller as both owner and
   * operator. Anything less is a typed refusal — the burden of proof is on
   * the stored record, and absence of a record is a refusal, never a pass.
   */
  const requireBackedRecord = async (
    targetId: string,
    operation: string,
    operator: string,
    reconstructionId: string,
  ): Promise<void> => {
    const record = await readBackingRecord(targetId, operation, operator);
    if (record === undefined) {
      throw new ClappOperatorScopeError(operation, operator, {
        reason: `no authorization record is persisted for target "${targetId}"; the burden of proof is on the stored record, and absence of a record is a refusal, never a pass`,
        target: reconstructionId,
      });
    }
    if (isExpired(record)) {
      throw new ClappOperatorScopeError(operation, operator, {
        reason: `the stored authorization record ${record.id} for target "${targetId}" expired at ${record.expiresAt} and no longer backs a scope grant; refusing`,
        target: reconstructionId,
        authorizationRecordId: record.id,
        recordOwnerId: record.ownerId,
        recordOperatorIdentity: record.operatorIdentity,
        expiredAt: record.expiresAt,
      });
    }
    if (record.ownerId !== operator || record.operatorIdentity !== operator) {
      throw new ClappOperatorScopeError(operation, operator, {
        reason: `the stored authorization record ${record.id} for target "${targetId}" names owner "${record.ownerId}" and operator "${record.operatorIdentity}"; the caller is not the record's named owner and operator, and scope is never widened beyond the record`,
        target: reconstructionId,
        authorizationRecordId: record.id,
        recordOwnerId: record.ownerId,
        recordOperatorIdentity: record.operatorIdentity,
      });
    }
  };

  /**
   * Builds the cross-owner denial: the reconstruction exists under another
   * operator's scope, and the denial reason is backed by whatever the
   * authorization store holds for its target — the persisted record's id
   * plus the owner and operator identity it names, the explicit absence of a
   * record, or the expiry that lapsed. The caller throws it; the guard never
   * falls through to a bare not-found for a resource that exists.
   */
  const crossOwnerDenial = async (
    reconstructionId: string,
    spec: unknown,
    operation: string,
    operator: string,
  ): Promise<ClappOperatorScopeError> => {
    const targetId = targetIdOfSpec(
      spec,
      operation,
      operator,
      `the reconstruction found for ${reconstructionId}`,
    );
    const record = await readBackingRecord(targetId, operation, operator);
    if (record === undefined) {
      return new ClappOperatorScopeError(operation, operator, {
        reason: `reconstruction ${reconstructionId} exists under another operator's scope, and no authorization record is persisted for target "${targetId}"; refusing cross-operator access without a record`,
        target: reconstructionId,
      });
    }
    if (isExpired(record)) {
      return new ClappOperatorScopeError(operation, operator, {
        reason: `reconstruction ${reconstructionId} exists under another operator's scope, and its stored authorization record ${record.id} for target "${targetId}" expired at ${record.expiresAt} and no longer backs a scope grant; refusing cross-operator access`,
        target: reconstructionId,
        authorizationRecordId: record.id,
        recordOwnerId: record.ownerId,
        recordOperatorIdentity: record.operatorIdentity,
        expiredAt: record.expiresAt,
      });
    }
    return new ClappOperatorScopeError(operation, operator, {
      reason: `reconstruction ${reconstructionId} exists under another operator's scope; the persisted authorization record ${record.id} for target "${targetId}" names owner "${record.ownerId}" and operator "${record.operatorIdentity}", and the caller is not that operator; refusing cross-operator access`,
      target: reconstructionId,
      authorizationRecordId: record.id,
      recordOwnerId: record.ownerId,
      recordOperatorIdentity: record.operatorIdentity,
    });
  };

  /**
   * Resolves an addressed reconstruction for a caller: the owner-scoped read
   * first (a hit means the row lives under the caller, and the backing
   * record must then name them), then the honest cross-owner probe —
   * `findSpec` — which distinguishes "exists under another operator" (the
   * typed denial follows) from "does not exist at all" (the honest
   * not-found). Absent and cross-owner are never conflated.
   */
  const resolve = async (
    operator: string,
    reconstructionId: string,
    operation: string,
  ): Promise<ScopeResolution> => {
    const row = await wrapped.get(operator, reconstructionId);
    if (row !== null) {
      const targetId = targetIdOfSpec(
        row.spec,
        operation,
        operator,
        `the reconstruction row ${reconstructionId}'s spec`,
      );
      await requireBackedRecord(targetId, operation, operator, reconstructionId);
      return { status: "granted", row };
    }
    const spec = await wrapped.findSpec(reconstructionId);
    if (spec === null) return { status: "absent" };
    throw await crossOwnerDenial(reconstructionId, spec, operation, operator);
  };

  const repositories: OperatorScopedClappRepositories = {
    async create(operatorIdentity, row) {
      const operator = normalizeOperatorIdentity(operatorIdentity);
      const operation = "reconstruction write";
      const rowId = stringFieldOf(row, "id");
      if (rowId === undefined) {
        throw new ClappOperatorScopeError(operation, operator, {
          reason: "the reconstruction row does not carry a usable id; refusing to scope the write",
        });
      }
      const targetId = targetIdOfSpec(
        (row as { spec?: unknown }).spec,
        operation,
        operator,
        `the new reconstruction row ${rowId}'s spec`,
      );
      // The write's own burden of proof: the target's record must back the
      // caller before anything is persisted.
      await requireBackedRecord(targetId, operation, operator, rowId);
      // The guard also refuses to shadow another operator's reconstruction
      // id: an id that already exists under another operator is a denial,
      // not a silent second row.
      const existing = await wrapped.get(operator, rowId);
      if (existing === null) {
        const spec = await wrapped.findSpec(rowId);
        if (spec !== null) throw await crossOwnerDenial(rowId, spec, operation, operator);
      }
      return wrapped.create(operator, row);
    },

    async get(operatorIdentity, id) {
      const operator = normalizeOperatorIdentity(operatorIdentity);
      const resolution = await resolve(operator, id, "reconstruction read");
      return resolution.status === "granted" ? resolution.row : null;
    },

    async list(operatorIdentity) {
      const operator = normalizeOperatorIdentity(operatorIdentity);
      const operation = "reconstruction list";
      const rows = await wrapped.list(operator);
      const scoped = await Promise.all(
        rows.map(async (row) => {
          const targetId = targetIdOfSpec(
            row.spec,
            operation,
            operator,
            `the reconstruction row ${row.id}'s spec`,
          );
          const record = await readBackingRecord(targetId, operation, operator);
          const backed =
            record !== undefined &&
            !isExpired(record) &&
            record.ownerId === operator &&
            record.operatorIdentity === operator;
          return backed ? row : null;
        }),
      );
      return scoped.filter((row): row is ClappReconstructionRow => row !== null);
    },

    async markCancelled(operatorIdentity, id) {
      const operator = normalizeOperatorIdentity(operatorIdentity);
      const resolution = await resolve(operator, id, "reconstruction cancel");
      if (resolution.status === "absent") return; // the honest wrapped no-op
      await wrapped.markCancelled(operator, id);
    },

    async stageTasks(operatorIdentity, reconstructionId) {
      const operator = normalizeOperatorIdentity(operatorIdentity);
      await resolve(operator, reconstructionId, "stage task read");
      return wrapped.stageTasks(operator, reconstructionId);
    },

    async artifacts(operatorIdentity, reconstructionId) {
      const operator = normalizeOperatorIdentity(operatorIdentity);
      await resolve(operator, reconstructionId, "artifact read");
      return wrapped.artifacts(operator, reconstructionId);
    },

    async findSpec(operatorIdentity, reconstructionId) {
      const operator = normalizeOperatorIdentity(operatorIdentity);
      await resolve(operator, reconstructionId, "reconstruction read");
      return wrapped.findSpec(reconstructionId);
    },
  };

  // -------------------------------------------------------------------------
  // The operator-scoped package surface
  // -------------------------------------------------------------------------

  /** Fails closed when no backing package port is wired. */
  const requirePackageStore = (operation: string, operator: string): OperatorPackageStore => {
    if (packageStore === undefined) {
      throw new ClappOperatorScopeError(operation, operator, {
        reason:
          "no backing package port is wired into the operator-scoped surface; refusing the package operation",
      });
    }
    return packageStore;
  };

  /** Verifies a port record's shape; a malformed record is never trusted. */
  const checkPackageRecordShape = (
    record: unknown,
    operation: string,
    operator: string,
  ): OperatorScopedPackageRecord => {
    const violations: string[] = [];
    const id = stringFieldOf(record, "id");
    if (id === undefined) violations.push("id must be a non-empty string");
    const version = stringFieldOf(record, "version");
    if (version === undefined) violations.push("version must be a non-empty string");
    const rawStatus =
      record !== null && typeof record === "object"
        ? (record as Record<string, unknown>).status
        : undefined;
    if (rawStatus !== "candidate" && rawStatus !== "promoted")
      violations.push(
        `status must be "candidate" or "promoted" (found ${describeKind(rawStatus)})`,
      );
    const operatorScope = stringFieldOf(record, "operatorScope");
    if (operatorScope === undefined) violations.push("operatorScope must be a non-empty string");
    const document =
      record !== null && typeof record === "object"
        ? (record as Record<string, unknown>).document
        : undefined;
    if (document === null || typeof document !== "object")
      violations.push(`document must be an object (found ${describeKind(document)})`);
    const promotion =
      record !== null && typeof record === "object"
        ? (record as Record<string, unknown>).promotion
        : undefined;
    if (promotion !== undefined) {
      const verifiedAt = stringFieldOf(promotion, "verifiedAt");
      const verificationRunId = stringFieldOf(promotion, "verificationRunId");
      if (verifiedAt === undefined || verificationRunId === undefined)
        violations.push(
          "promotion, when present, must carry non-empty verifiedAt and verificationRunId strings",
        );
    }
    if (violations.length > 0) {
      throw new ClappOperatorScopeError(operation, operator, {
        reason: `the package port returned a malformed record: ${violations.join("; ")}; refusing to trust it`,
      });
    }
    return record as OperatorScopedPackageRecord;
  };

  /** Extracts the (id, version) coordinate from a package document. */
  const packageCoordinateOf = (
    doc: unknown,
    operation: string,
    operator: string,
  ): { id: string; version: string } => {
    const id = stringFieldOf(doc, "id");
    const version = stringFieldOf(doc, "version");
    if (id === undefined || version === undefined) {
      throw new ClappOperatorScopeError(operation, operator, {
        reason:
          "the package document does not carry a usable (id, version) identity coordinate; refusing to scope it",
      });
    }
    return { id, version };
  };

  /** Validates promotion evidence (the W2-005 evidence shape). */
  const checkPromotionEvidence = (
    evidence: OperatorScopedPromotionEvidence,
    operation: string,
    operator: string,
  ): OperatorScopedPromotionEvidence => {
    const raw = evidence as unknown as Record<string, unknown>;
    const verifiedAt =
      typeof raw.verifiedAt === "string" && raw.verifiedAt !== "" ? raw.verifiedAt : undefined;
    const verificationRunId =
      typeof raw.verificationRunId === "string" && raw.verificationRunId !== ""
        ? raw.verificationRunId
        : undefined;
    const notes = raw.provenanceNotes;
    const notesValid =
      notes === undefined ||
      (Array.isArray(notes) && notes.every((note) => typeof note === "string"));
    const violations: string[] = [];
    if (verifiedAt === undefined) violations.push("verifiedAt must be a non-empty string");
    if (verificationRunId === undefined)
      violations.push("verificationRunId must be a non-empty string");
    if (!notesValid) violations.push("provenanceNotes, when present, must be an array of strings");
    if (verifiedAt === undefined || verificationRunId === undefined || !notesValid) {
      throw new ClappOperatorScopeError(operation, operator, {
        reason: `promotion evidence is malformed: ${violations.join("; ")}; refusing to promote`,
      });
    }
    return {
      verifiedAt,
      verificationRunId,
      ...(notes !== undefined ? { provenanceNotes: [...(notes as string[])] } : {}),
    };
  };

  /** The typed denial for a package coordinate stored in another scope. */
  const denyCrossScopePackage = (
    record: OperatorScopedPackageRecord,
    operation: string,
    operator: string,
    verb: string,
  ): never => {
    throw new ClappOperatorScopeError(operation, operator, {
      reason: `a package record is already stored at (${record.id}, ${record.version}) in operator "${record.operatorScope}"'s scope; ${verb} into another operator's scope is refused`,
      target: `${record.id}@${record.version}`,
      packageId: record.id,
      packageVersion: record.version,
      packageOperatorScope: record.operatorScope,
    });
  };

  const packages: OperatorScopedPackages = {
    async list(operatorIdentity, filter) {
      const operator = normalizeOperatorIdentity(operatorIdentity);
      const operation = "package list";
      const store = requirePackageStore(operation, operator);
      const records = await store.list(filter);
      return records
        .map((record) => checkPackageRecordShape(record, operation, operator))
        .filter((record) => record.operatorScope === operator);
    },

    async get(operatorIdentity, id, version) {
      const operator = normalizeOperatorIdentity(operatorIdentity);
      const operation = "package read";
      const store = requirePackageStore(operation, operator);
      const stored = await store.get(id, version);
      if (stored === null) return null;
      const record = checkPackageRecordShape(stored, operation, operator);
      if (record.operatorScope !== operator) {
        denyCrossScopePackage(record, operation, operator, "reading");
      }
      return record;
    },

    async register(operatorIdentity, doc) {
      const operator = normalizeOperatorIdentity(operatorIdentity);
      const operation = "package write";
      const store = requirePackageStore(operation, operator);
      const coordinate = packageCoordinateOf(doc, operation, operator);
      const existing = await store.get(coordinate.id, coordinate.version);
      if (existing !== null) {
        const record = checkPackageRecordShape(existing, operation, operator);
        if (record.operatorScope !== operator) {
          denyCrossScopePackage(record, operation, operator, "registering");
        }
        if (record.status === "promoted") {
          throw new ClappOperatorScopeError(operation, operator, {
            reason: `the package record at (${coordinate.id}, ${coordinate.version}) is promoted in the caller's own scope; the scope guard refuses to overwrite a promoted record (registry conflict semantics compose at the integration wave)`,
            target: `${coordinate.id}@${coordinate.version}`,
            packageId: record.id,
            packageVersion: record.version,
            packageOperatorScope: record.operatorScope,
          });
        }
      }
      const record: OperatorScopedPackageRecord = {
        id: coordinate.id,
        version: coordinate.version,
        document: doc,
        status: "candidate",
        operatorScope: operator,
      };
      await store.put(record);
      return record;
    },

    async promote(operatorIdentity, id, version, evidence) {
      const operator = normalizeOperatorIdentity(operatorIdentity);
      const operation = "package promotion";
      const store = requirePackageStore(operation, operator);
      const validatedEvidence = checkPromotionEvidence(evidence, operation, operator);
      const stored = await store.get(id, version);
      if (stored === null) {
        throw new ClappOperatorScopeError(operation, operator, {
          reason: `no package record is stored at (${id}, ${version}); there is nothing to promote`,
          target: `${id}@${version}`,
        });
      }
      const record = checkPackageRecordShape(stored, operation, operator);
      if (record.operatorScope !== operator) {
        denyCrossScopePackage(record, operation, operator, "promoting");
      }
      if (record.status === "promoted") {
        // The W2-005 rule: identical evidence reproduces the promotion
        // (idempotent no-op); different evidence is refused.
        if (
          record.promotion !== undefined &&
          stableStringify(record.promotion) === stableStringify(validatedEvidence)
        ) {
          return record;
        }
        throw new ClappOperatorScopeError(operation, operator, {
          reason: `the package record at (${id}, ${version}) is already promoted with different evidence; re-promotion is refused (immutability semantics compose at the integration wave)`,
          target: `${id}@${version}`,
          packageId: record.id,
          packageVersion: record.version,
          packageOperatorScope: record.operatorScope,
        });
      }
      const promoted: OperatorScopedPackageRecord = {
        ...record,
        status: "promoted",
        promotion: validatedEvidence,
      };
      await store.put(promoted);
      return promoted;
    },
  };

  return { repositories, packages };
}
