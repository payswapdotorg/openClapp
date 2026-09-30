import type {
  EvidenceBundle,
  EvidenceRef,
  ReconstructionSpec,
  TargetAuthorization,
} from "@clapp/contracts";
import {
  type BrowserObservationAdapter,
  createBrowserObservationAdapter,
  type ObservationDependencies,
  type PartialObservationResult,
} from "./adapter.ts";
import { canonicalJson, sha256Hex } from "./canonical.ts";
import { ClappObservationError } from "./errors.ts";

/**
 * CLAPP-W1-008 — Target authorization persistence.
 *
 * SECURITY.md (Authorization) requires that, before target observation, an
 * authorization record is persisted carrying: target owner; authorized
 * scope; allowed environments; allowed artifact retention; expiry; operator
 * identity — and that observation fails closed without a valid unexpired
 * record. This module implements that contract additively over the W1-002
 * browser observation adapter, and performs no I/O of its own:
 *
 * - `authorizeTarget` is the authorize path: it validates the spec's frozen
 *   TargetAuthorization plus the caller-supplied operator identity (which
 *   the frozen contract type does not carry and this module therefore
 *   declares locally on the record), derives a content-addressed
 *   AuthorizationRecord, and PUTS it through the narrow AuthorizationStore
 *   port BEFORE any observation can run. Only a stored record can
 *   green-light a run: a record that was never stored does not exist, no
 *   matter what the in-memory spec object claims.
 * - `createGatedBrowserObservationAdapter` composes the EXISTING W1-002
 *   adapter: observe()/observePartial() run the fail-closed authorization
 *   precondition first and delegate to the real adapter only on a stored,
 *   unexpired, owner- and environment-matching record; evidenceBytes passes
 *   through unchanged. The W1-002 adapter code stays untouched, and its own
 *   structural spec validation still runs after the gate (defense in depth:
 *   the owner check remains).
 * - Benchmark-owned targets (`authorization.benchmarkOwned === true`) use
 *   SECURITY.md's implicit benchmark authorization: when no record is stored
 *   the gate mints one MARKED as implicit benchmark authorization, persists
 *   it through the same port and re-reads it before observation — there is
 *   no bypass, every observed target has a stored record, and the same
 *   precondition applies to the implicit record.
 *
 * Persistence flows exclusively through AuthorizationStore (get and put,
 * nothing else — the W2-005 narrow-port discipline); tests supply an
 * in-memory port. The clock is supplied exactly the way the W1-002 adapter
 * supplies its capture clock: an injectable `now` dependency that tests pin
 * and production callers omit. The record itself carries no clock-derived
 * field — grantedAt is the caller-supplied `spec.authorization.createdAt`
 * and expiresAt is the caller-supplied value; expiry is evaluated against
 * the supplied time source only, never a silently read wall clock.
 */

/**
 * Prefix of every persisted authorization record id. Ids are
 * content-addressed: this prefix plus a sha256 prefix of the record's
 * canonical core — the same discipline as the W2-006 package ids and the
 * `rr-` repair-report ids. The hash prefix length (16 hex chars) is chosen
 * locally and must be deduped against those conventions at integration.
 *
 * PENDING CONTRACTS REVISION (tech-lead owned): `clapp_authz_` is not yet
 * listed in docs/clapp/CONTRACTS.md "Core identifiers". Adding it requires
 * an ADR and updated acceptance criteria per CONTRACTS.md "Compatibility";
 * this constant declares the prefix locally until that revision lands, and
 * no frozen contract or doc file is edited here.
 */
export const AUTHORIZATION_RECORD_ID_PREFIX = "clapp_authz_";

/** Hex characters of the sha256 digest used in an authorization record id. */
const ID_HASH_LENGTH = 16;

/** The frozen artifact-retention union of the TargetAuthorization contract. */
const RETENTION_VALUES: readonly string[] = ["ephemeral", "project", "library"];

/**
 * How a record was authorized. SECURITY.md: "Benchmarks owned by CLAPP can
 * use implicit benchmark authorization" — records derived from a
 * benchmark-owned authorization are marked "implicit-benchmark" so the
 * implicit path stays distinguishable from explicit authorization while the
 * same precondition applies to both.
 */
export type AuthorizationKind = "explicit" | "implicit-benchmark";

/**
 * The persisted authorization record SECURITY.md requires before target
 * observation. Six fields are SECURITY.md's own: target owner
 * (ownerId), authorized scope (scope), allowed environments
 * (environments), allowed artifact retention (retention), expiry
 * (expiresAt) and operator identity (operatorIdentity). `operatorIdentity`
 * is NOT a field of the frozen TargetAuthorization — it is declared locally
 * here and supplied by the caller. The record is derived from the spec's
 * authorization object and never mutates or rewrites it; scope and
 * environments are stored as sorted copies so array order cannot leak into
 * the record or its id. The record carries no clock-derived field.
 */
export interface AuthorizationRecord {
  /** Content-addressed id: clapp_authz_ + sha256 prefix of the canonical core. */
  id: string;
  /** The target this record authorizes (the store key; one record per target). */
  targetId: string;
  /** SECURITY.md: target owner. */
  ownerId: string;
  /** SECURITY.md: authorized scope, stored canonically (sorted). */
  scope: string[];
  /** SECURITY.md: allowed environments, stored canonically (sorted). */
  environments: string[];
  /** SECURITY.md: allowed artifact retention (the frozen union). */
  retention: "ephemeral" | "project" | "library";
  /**
   * SECURITY.md: expiry — the caller-supplied value. Strictly before the
   * evaluation instant the record is expired; a record with no expiresAt
   * never expires.
   */
  expiresAt?: string;
  /** SECURITY.md: operator identity — declared locally, not on the frozen contract. */
  operatorIdentity: string;
  /** Whether the source authorization is owned by a CLAPP benchmark. */
  benchmarkOwned: boolean;
  /** Marks implicit benchmark authorization records (SECURITY.md). */
  authorizationKind: AuthorizationKind;
  /** The caller-supplied spec.authorization.createdAt — never clock-derived. */
  grantedAt: string;
}

/**
 * The narrow persistence port for authorization records (the W2-005
 * narrow-port discipline: get and put, NOTHING else). The module performs
 * no I/O — every durable store lives behind this port and is supplied by
 * the caller; tests supply an in-memory port. One record per key: a later
 * put replaces an earlier one, and only a record that was actually stored
 * exists.
 */
export interface AuthorizationStore {
  /** Reads the single record stored under key, or undefined when none exists. */
  get(key: string): Promise<AuthorizationRecord | undefined>;
  /** Persists record under key (one record per key; later puts replace earlier ones). */
  put(key: string, record: AuthorizationRecord): Promise<void>;
}

/**
 * The store key under which a target's authorization record persists —
 * one record per target. The authorize path, the implicit benchmark path
 * and the gate all address the store through this single scheme.
 */
export function authorizationRecordKey(targetId: string): string {
  return targetId;
}

/** Options the authorize path requires beyond the spec itself. */
export interface AuthorizeTargetOptions {
  /**
   * SECURITY.md operator identity — who authorizes this target run. Not a
   * field of the frozen TargetAuthorization; supplied by the caller and
   * declared locally on the record.
   */
  operatorIdentity: string;
  /** The narrow persistence port the record is put through. */
  store: AuthorizationStore;
}

/**
 * The gate's dependencies: the W1-002 ObservationDependencies (same untyped
 * browser handle, same ownership context routed to every seam call, same
 * injectable clock) extended with the authorization-persistence surface.
 * `environment` is the environment observation is requested to run in,
 * checked against the record's allowed environments; `operatorIdentity` is
 * recorded on implicit benchmark authorizations the gate mints; `store` is
 * the narrow AuthorizationStore port.
 */
export interface AuthorizationGateDependencies extends ObservationDependencies {
  /** The environment observation is requested to run in. */
  environment: string;
  /**
   * The operator identity recorded on implicit benchmark authorizations
   * minted by the gate (SECURITY.md operator identity).
   */
  operatorIdentity: string;
  /** The narrow persistence port records are read from and put through. */
  store: AuthorizationStore;
}

/**
 * The gated observation surface: the W1-002 BrowserObservationAdapter with
 * the fail-closed authorization precondition composed in front of
 * observe()/observePartial(). evidenceBytes passes through unchanged — the
 * gate decides only whether capture may start, never touches evidence.
 */
export interface GatedBrowserObservationAdapter {
  /** Runs the authorization precondition, then the W1-002 observe(). */
  observe(spec: ReconstructionSpec, signal?: AbortSignal): Promise<EvidenceBundle>;
  /** Runs the authorization precondition, then the W1-002 observePartial(). */
  observePartial(spec: ReconstructionSpec, signal?: AbortSignal): Promise<PartialObservationResult>;
  /** Passes through to the wrapped W1-002 adapter unchanged. */
  evidenceBytes(ref: EvidenceRef): Uint8Array;
}

/** Extracts the spec's authorization object, failing closed when absent. */
function authorizationOf(spec: ReconstructionSpec): TargetAuthorization {
  const authorization = (spec as { authorization?: TargetAuthorization } | null | undefined)
    ?.authorization;
  if (typeof authorization !== "object" || authorization === null)
    throw new ClappObservationError(
      "authorization",
      "spec.authorization must be a TargetAuthorization object; there is no target authorization to persist or verify",
    );
  return authorization;
}

/**
 * Collects every violation of the authorization contract (SECURITY.md's
 * fields plus the operator identity and the frozen retention union) so a
 * malformed authorization fails closed with one precise, complete message.
 */
function collectAuthorizationViolations(
  authorization: TargetAuthorization,
  operatorIdentity: string,
): string[] {
  const violations: string[] = [];
  if (typeof authorization.ownerId !== "string" || authorization.ownerId === "")
    violations.push("target owner is missing");
  if (typeof authorization.targetId !== "string" || authorization.targetId === "")
    violations.push("target id is missing");
  if (!Array.isArray(authorization.scope) || authorization.scope.length === 0)
    violations.push("authorized scope is empty");
  else if (authorization.scope.some((entry) => typeof entry !== "string" || entry === ""))
    violations.push("authorized scope contains an empty entry");
  if (!Array.isArray(authorization.environments) || authorization.environments.length === 0)
    violations.push("allowed environments is empty");
  else if (authorization.environments.some((entry) => typeof entry !== "string" || entry === ""))
    violations.push("allowed environments contains an empty entry");
  if (
    typeof authorization.retention !== "string" ||
    !RETENTION_VALUES.includes(authorization.retention)
  )
    violations.push(
      `artifact retention "${String(authorization.retention)}" is outside the frozen union (ephemeral | project | library)`,
    );
  const expiresAt = authorization.expiresAt;
  if (
    expiresAt !== undefined &&
    (typeof expiresAt !== "string" || Number.isNaN(Date.parse(expiresAt)))
  )
    violations.push(`expiresAt "${String(expiresAt)}" is not a parseable timestamp`);
  if (typeof authorization.benchmarkOwned !== "boolean")
    violations.push("benchmarkOwned must be a boolean");
  if (typeof authorization.createdAt !== "string" || authorization.createdAt === "")
    violations.push("grantedAt is missing (spec.authorization.createdAt)");
  if (typeof operatorIdentity !== "string" || operatorIdentity === "")
    violations.push("operator identity is empty");
  return violations;
}

/**
 * Derives the AuthorizationRecord from the spec's frozen
 * TargetAuthorization plus the caller-supplied operator identity. Pure and
 * deterministic: the input authorization object is never mutated or
 * rewritten (scope and environments are copied and sorted), the same
 * inputs always produce a byte-identical record with the same id, and ids
 * derive from content only — never from time, randomness or environment.
 * Throws ClappObservationError with capability "authorization" naming
 * every collected violation when the authorization (or operator identity)
 * is malformed — before anything is persisted.
 */
export function buildAuthorizationRecord(
  authorization: TargetAuthorization,
  operatorIdentity: string,
): AuthorizationRecord {
  const violations = collectAuthorizationViolations(authorization, operatorIdentity);
  if (violations.length > 0) {
    throw new ClappObservationError(
      "authorization",
      `target authorization is malformed: ${violations.join("; ")}`,
    );
  }
  const authorizationKind: AuthorizationKind = authorization.benchmarkOwned
    ? "implicit-benchmark"
    : "explicit";
  const core = {
    authorizationKind,
    benchmarkOwned: authorization.benchmarkOwned,
    environments: [...authorization.environments].sort(),
    expiresAt: authorization.expiresAt ?? null,
    grantedAt: authorization.createdAt,
    operatorIdentity,
    ownerId: authorization.ownerId,
    retention: authorization.retention,
    scope: [...authorization.scope].sort(),
    targetId: authorization.targetId,
  };
  const id =
    AUTHORIZATION_RECORD_ID_PREFIX + sha256Hex(canonicalJson(core)).slice(0, ID_HASH_LENGTH);
  return {
    id,
    targetId: core.targetId,
    ownerId: core.ownerId,
    scope: core.scope,
    environments: core.environments,
    retention: core.retention,
    ...(core.expiresAt !== null ? { expiresAt: core.expiresAt } : {}),
    operatorIdentity: core.operatorIdentity,
    benchmarkOwned: core.benchmarkOwned,
    authorizationKind: core.authorizationKind,
    grantedAt: core.grantedAt,
  };
}

/**
 * The authorize path: validates the spec's TargetAuthorization plus the
 * caller-supplied operator identity and persists the derived record through
 * the store port, keyed by target — so the record exists BEFORE observation
 * begins. Benchmark-owned authorizations persist a record marked as
 * implicit benchmark authorization. Nothing is persisted when validation
 * fails; a record that was never stored does not exist.
 */
export async function authorizeTarget(
  spec: ReconstructionSpec,
  options: AuthorizeTargetOptions,
): Promise<AuthorizationRecord> {
  const authorization = authorizationOf(spec);
  const record = buildAuthorizationRecord(authorization, options.operatorIdentity);
  await options.store.put(authorizationRecordKey(record.targetId), record);
  return record;
}

/**
 * The fail-closed authorization precondition. Reads the port and REFUSES
 * observation (ClappObservationError, capability "authorization", precise
 * message — never a silent skip, never a downgrade to an unavailable ref)
 * when: no record is stored for the target; the stored record is expired
 * (its expiresAt is strictly before the evaluation instant; a record with
 * no expiresAt never expires); the record's target owner does not match the
 * observation binding's owner; or the requested environment is not in the
 * record's allowed environments. Benchmark-owned targets with no stored
 * record take SECURITY.md's implicit path: the record is minted, persisted
 * and re-read from the port first — a record that was never stored does not
 * exist — and the same precondition then applies to it.
 */
async function requireAuthorizedRecord(
  spec: ReconstructionSpec,
  deps: AuthorizationGateDependencies,
): Promise<AuthorizationRecord> {
  // The injectable clock, defaulted exactly the way the W1-002 adapter
  // defaults its capture clock; the module never calls the wall clock
  // directly — expiry is evaluated against this source only.
  const now = typeof deps.now === "function" ? deps.now : Date.now;
  const authorization = authorizationOf(spec);
  const key = authorizationRecordKey(authorization.targetId);
  let record = await deps.store.get(key);
  if (record === undefined && authorization.benchmarkOwned === true) {
    const minted = buildAuthorizationRecord(authorization, deps.operatorIdentity);
    await deps.store.put(key, minted);
    record = await deps.store.get(key);
  }
  if (record === undefined) {
    throw new ClappObservationError(
      "authorization",
      `no persisted authorization record for target "${authorization.targetId}"; refusing to observe`,
    );
  }
  if (record.expiresAt !== undefined) {
    const expiresAtMs = Date.parse(record.expiresAt);
    if (Number.isNaN(expiresAtMs)) {
      throw new ClappObservationError(
        "authorization",
        `authorization record ${record.id} for target "${record.targetId}" carries an unparseable expiresAt "${record.expiresAt}"; refusing to observe`,
      );
    }
    if (expiresAtMs < now()) {
      throw new ClappObservationError(
        "authorization",
        `authorization record ${record.id} for target "${record.targetId}" expired at ${record.expiresAt}; refusing to observe`,
      );
    }
  }
  if (record.ownerId !== deps.ownerId) {
    throw new ClappObservationError(
      "authorization",
      `authorization record ${record.id} for target "${record.targetId}" authorizes owner "${record.ownerId}" but the observation binding's owner is "${deps.ownerId}"; refusing to observe`,
    );
  }
  const environments = Array.isArray(record.environments) ? record.environments : [];
  if (!environments.includes(deps.environment)) {
    throw new ClappObservationError(
      "authorization",
      `authorization record ${record.id} for target "${record.targetId}" allows environments [${environments.join(", ")}] but observation requested environment "${deps.environment}"; refusing to observe`,
    );
  }
  return record;
}

/**
 * Creates the gated browser observation adapter: the EXISTING W1-002
 * adapter composed behind the fail-closed authorization precondition. The
 * wrapped adapter is created from the same dependencies (same untyped
 * browser handle, same owner, same injectable clock) and stays completely
 * untouched — this factory only adds the gate around it. observe() and
 * observePartial() refuse with ClappObservationError (capability
 * "authorization") BEFORE any browser seam call when no valid, unexpired,
 * owner- and environment-matching record is stored; on a valid record the
 * W1-002 behaviors pass through unchanged, and evidenceBytes is a pure
 * pass-through.
 */
export function createGatedBrowserObservationAdapter(
  deps: AuthorizationGateDependencies,
): GatedBrowserObservationAdapter {
  const adapter: BrowserObservationAdapter = createBrowserObservationAdapter(deps);
  return {
    async observe(spec, signal) {
      await requireAuthorizedRecord(spec, deps);
      return adapter.observe(spec, signal);
    },
    async observePartial(spec, signal) {
      await requireAuthorizedRecord(spec, deps);
      return adapter.observePartial(spec, signal);
    },
    evidenceBytes(ref) {
      return adapter.evidenceBytes(ref);
    },
  };
}
