import type { ExecutionProvider } from "@clapp/contracts";
import { ClappRuntimeError } from "./errors.ts";

/**
 * CLAPP-W1-010 — isolation/egress controls for candidate execution.
 *
 * The OpenMuse computer container runs `--network none`: the W1-003 execution
 * provider (runtime.ts) honors exactly one network mode ("deny") and fails
 * closed on every other mode before any command starts. This module adds the
 * egress POLICY layer the work item requires ON TOP of that physical truth —
 * it composes the seam, never weakens it:
 *
 * - `normalizeEgressDestination` is the destination vocabulary: an egress
 *   destination is a normalized `host` or `host:port` string (lowercased, no
 *   scheme, no path, no userinfo, no whitespace; a bare port is invalid).
 *   Normalization and validation are pure and deterministic; an invalid
 *   destination string fails closed with a typed error naming it, never a
 *   silent pass-through.
 * - `deriveEgressAllowList` derives the declared allow-list from the target's
 *   authorization record (W1-008, consumed STRUCTURALLY through the local
 *   `EgressAuthorizationRecord` type — the real record satisfies it
 *   structurally, no new package dependency) and the caller's declared
 *   per-environment destination lists: the union of the destination lists of
 *   exactly the environments the record allows, canonical (normalized,
 *   deduplicated, sorted). Fail closed everywhere: no record, a record whose
 *   targetId does not match, or a record expired at the evaluation instant
 *   (expiresAt strictly before `now`; no expiresAt never expires) derives the
 *   EMPTY allow-list; an environment the record does not grant contributes
 *   NOTHING even if the caller declared destinations for it.
 * - `createEgressPolicy` binds the derivation once and exposes the derived
 *   allow-list, the backing record id and the `check(destinations)` decision.
 *   The clock is injectable and defaults to `Date.now` only at the factory;
 *   the policy reads no wall clock implicitly anywhere else and performs no
 *   I/O.
 * - `createEgressEnforcingExecutionProvider` wraps ANY `ExecutionProvider`
 *   (candidate builds and benchmark execution are the same seam) and
 *   enforces, BEFORE the wrapped call: `network: "full"` (and any mode other
 *   than "deny"/"allowlist") fails closed with a typed error and ZERO
 *   delegation — the W1-003 discipline preserved exactly; `network: "deny"`
 *   delegates unchanged and decorates the result with the explicit marker
 *   `egressMode: "denied"` (egress is structurally impossible under the
 *   substrate's network isolation — the honest marker, never an absent
 *   field); `network: "allowlist"` is enforced at the CLAPP seam as a
 *   DECLARATION CHECK: the input must carry the locally-declared
 *   `declaredEgress` destinations (declared on the wrapper's OWN input type,
 *   NOT on the frozen contract — the W1-008 operatorIdentity precedent),
 *   every declared destination must normalize validly and be in the derived
 *   allow-list, and any out-of-scope destination blocks the whole call
 *   BEFORE the wrapped provider runs — raising the typed `ClappEgressError`
 *   carrying the blocked destination and appending one enforcement record
 *   through the narrow `EgressEnforcementLog` port (the W2-005 narrow-port
 *   discipline: put, nothing else). On a pass the wrapper delegates with
 *   `network: "deny"` — the substrate's only physically honest mode — and
 *   decorates the result with `egressMode: "enforced-allowlist"` plus the
 *   enforced destinations.
 *
 * The seam gate is a declaration check, and this module says so: the
 * substrate physically disables networking; what is enforced here is the
 * declared-destination policy at the CLAPP seam, and every execution report
 * leaving the wrapper carries an explicit egress mode — an unmarked report
 * is a failure. The module performs no I/O of its own; the enforcement log
 * is a caller-supplied port (in-memory in tests). Benchmark-server and route
 * wiring are out of scope: composing this wrapper into the benchmark host or
 * the server is a later tech-lead wave.
 */

// ─── The typed egress error ──────────────────────────────────────────────────

/** Why an egress-enforcing call (or derivation) failed closed. */
export type ClappEgressReason =
  /** network "full" (or any mode the wrapper cannot enforce) — zero delegation. */
  | "network-mode"
  /** network "allowlist" without the locally-declared declaredEgress field. */
  | "missing-declaration"
  /** A declared list (or declaredEgress itself) is not an array of strings. */
  | "invalid-declaration"
  /** A destination string that cannot normalize (scheme, path, userinfo, bare port, whitespace...). */
  | "invalid-destination"
  /** A record carrying an unparseable expiresAt — refused, never silently expired or honored. */
  | "invalid-record"
  /** A valid destination outside the allow-list derived from the record. */
  | "out-of-scope";

/**
 * The typed egress error — the `ClappRuntimeError` discipline adapted to the
 * egress capability: the capability discriminator is "egress", the message is
 * precise, and the structured fields name the blocked destination, the
 * derived allow-list's origin record id and the reconstruction whenever they
 * are known. Like every error in this package it fails closed: it is raised
 * BEFORE any delegation, and nothing is recorded as passed when it is thrown.
 */
export class ClappEgressError extends ClappRuntimeError {
  /** The fail-closed reason (the precise discrimination of this error). */
  readonly reason: ClappEgressReason;
  /** The destination that was blocked (invalid or out of scope). */
  readonly blockedDestination?: string;
  /** The authorization record the derived allow-list came from, when one backs the policy. */
  readonly recordId?: string;
  /** The reconstruction whose execution was blocked, when known. */
  readonly reconstructionId?: string;
  /** The declared destinations the decision was made over, when known. */
  readonly declaredEgress?: readonly string[];

  constructor(
    reason: ClappEgressReason,
    message: string,
    fields: {
      blockedDestination?: string;
      recordId?: string;
      reconstructionId?: string;
      declaredEgress?: readonly string[];
      cause?: unknown;
    } = {},
  ) {
    super(
      "execution",
      "egress",
      message,
      fields.cause !== undefined ? { cause: fields.cause } : undefined,
    );
    this.name = "ClappEgressError";
    this.reason = reason;
    if (fields.blockedDestination !== undefined)
      this.blockedDestination = fields.blockedDestination;
    if (fields.recordId !== undefined) this.recordId = fields.recordId;
    if (fields.reconstructionId !== undefined) this.reconstructionId = fields.reconstructionId;
    if (fields.declaredEgress !== undefined) this.declaredEgress = [...fields.declaredEgress];
  }
}

// ─── The destination vocabulary ───────────────────────────────────────────────

/** Maximum length of a normalized destination (the DNS hostname limit). */
const DESTINATION_MAX_LENGTH = 253;
/** One host label: [a-z0-9], with inner hyphens only, 1-63 characters. */
const LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** A port: 1-5 decimal digits (the 1-65535 range is checked separately). */
const PORT_PATTERN = /^[0-9]{1,5}$/;

/**
 * Normalizes one egress destination to its canonical form: a lowercased
 * `host` or `host:port` string with no scheme, no path, no userinfo and no
 * whitespace (bracketed IPv6 literals are hosts: `[::1]` or `[::1]:443`;
 * ports are canonical decimal, so `:0443` and `:443` are one destination).
 * Pure and deterministic: the same input always yields the same output.
 * Throws `ClappEgressError` (reason "invalid-destination") naming the
 * destination when it cannot be normalized — an empty host, a bare port, an
 * empty port, a scheme, a path, userinfo, whitespace or a non-DNS/IPv4 host
 * label — never a silent pass-through.
 */
export function normalizeEgressDestination(destination: string): string {
  if (typeof destination !== "string") {
    throw new ClappEgressError(
      "invalid-destination",
      `an egress destination must be a host or host:port string; received ${typeof destination}`,
      { blockedDestination: String(destination) },
    );
  }
  if (destination.length === 0) {
    throw new ClappEgressError(
      "invalid-destination",
      'the egress destination "" is invalid: the host is empty; a destination is a host or host:port string with no scheme, path, userinfo or whitespace',
      { blockedDestination: destination },
    );
  }
  if (/\s/.test(destination)) {
    throw new ClappEgressError(
      "invalid-destination",
      `the egress destination "${destination}" is invalid: it contains whitespace; a destination is a host or host:port string with no scheme, path, userinfo or whitespace`,
      { blockedDestination: destination },
    );
  }
  const value = destination.toLowerCase();
  if (value.length > DESTINATION_MAX_LENGTH) {
    throw new ClappEgressError(
      "invalid-destination",
      `the egress destination "${destination}" is invalid: it exceeds ${DESTINATION_MAX_LENGTH} characters`,
      { blockedDestination: destination },
    );
  }
  if (value.startsWith("[")) return normalizeBracketedHost(value, destination);
  const colon = value.indexOf(":");
  if (colon === -1) {
    requireHostLabels(value, destination);
    return value;
  }
  if (value.indexOf(":", colon + 1) !== -1) {
    throw new ClappEgressError(
      "invalid-destination",
      `the egress destination "${destination}" is invalid: an unbracketed host may carry at most one colon (the port); IPv6 hosts must be bracketed, e.g. "[2001:db8::1]:443"`,
      { blockedDestination: destination },
    );
  }
  const host = value.slice(0, colon);
  const port = value.slice(colon + 1);
  if (host === "") {
    throw new ClappEgressError(
      "invalid-destination",
      `the egress destination "${destination}" is invalid: a bare port is not a destination; the host is empty`,
      { blockedDestination: destination },
    );
  }
  requireHostLabels(host, destination);
  return `${host}:${requirePort(port, destination)}`;
}

/** Normalizes the bracketed IPv6 form: `[addr]` or `[addr]:port`. */
function normalizeBracketedHost(value: string, raw: string): string {
  const close = value.indexOf("]");
  if (close === -1) {
    throw new ClappEgressError(
      "invalid-destination",
      `the egress destination "${raw}" is invalid: an opening "[" without a closing "]"`,
      { blockedDestination: raw },
    );
  }
  const host = value.slice(0, close + 1);
  const inner = value.slice(1, close);
  const rest = value.slice(close + 1);
  if (inner.length === 0 || /[^0-9a-f:.]/.test(inner)) {
    throw new ClappEgressError(
      "invalid-destination",
      `the egress destination "${raw}" is invalid: the bracketed host is not an IPv6 literal`,
      { blockedDestination: raw },
    );
  }
  if (rest === "") return host;
  if (!rest.startsWith(":")) {
    throw new ClappEgressError(
      "invalid-destination",
      `the egress destination "${raw}" is invalid: nothing may follow the bracketed host except ":port"`,
      { blockedDestination: raw },
    );
  }
  return `${host}:${requirePort(rest.slice(1), raw)}`;
}

/** Requires every dot-separated label of the host to be a DNS/IPv4 label. */
function requireHostLabels(host: string, raw: string): void {
  for (const label of host.split(".")) {
    if (label.length === 0) {
      throw new ClappEgressError(
        "invalid-destination",
        `the egress destination "${raw}" is invalid: the host contains an empty label`,
        { blockedDestination: raw },
      );
    }
    if (!LABEL_PATTERN.test(label)) {
      throw new ClappEgressError(
        "invalid-destination",
        `the egress destination "${raw}" is invalid: the host label "${label}" is not a DNS name or IPv4 label ([a-z0-9] with inner hyphens only)`,
        { blockedDestination: raw },
      );
    }
  }
}

/** Requires a decimal port in 1-65535 and returns its canonical spelling. */
function requirePort(port: string, raw: string): string {
  if (!PORT_PATTERN.test(port)) {
    throw new ClappEgressError(
      "invalid-destination",
      `the egress destination "${raw}" is invalid: the port "${port}" is not 1-5 decimal digits`,
      { blockedDestination: raw },
    );
  }
  const numeric = Number(port);
  if (numeric < 1 || numeric > 65535) {
    throw new ClappEgressError(
      "invalid-destination",
      `the egress destination "${raw}" is invalid: the port ${port} is outside 1-65535`,
      { blockedDestination: raw },
    );
  }
  return String(numeric);
}

// ─── The authorization record, consumed structurally ─────────────────────────

/**
 * The authorization record the egress policy consumes, STRUCTURALLY (the
 * frozen-contract idiom): a local record-like type carrying exactly the
 * fields the egress derivation reads. The real W1-008 `AuthorizationRecord`
 * (packages/clapp-observation/src/authorization.ts) satisfies it
 * structurally, so no new package dependency is added and no frozen file is
 * edited. The burden of proof is on the stored record: absence or expiry of
 * a record is the empty allow-list, never a pass.
 */
export interface EgressAuthorizationRecord {
  /** Content-addressed record id (clapp_authz_ + sha256 prefix of the canonical core). */
  readonly id: string;
  /** The target this record authorizes. */
  readonly targetId: string;
  /** SECURITY.md: target owner. */
  readonly ownerId: string;
  /** SECURITY.md: allowed environments, stored canonically (sorted). */
  readonly environments: readonly string[];
  /**
   * SECURITY.md: expiry. Strictly before the evaluation instant the record
   * is expired; a record with no expiresAt never expires.
   */
  readonly expiresAt?: string;
  /** SECURITY.md: operator identity. */
  readonly operatorIdentity: string;
}

/** The record id, when the supplied value is a record-like object with one. */
function recordIdOf(record: EgressAuthorizationRecord | null | undefined): string | undefined {
  if (record === null || record === undefined || typeof record !== "object") return undefined;
  const id = (record as { id?: unknown }).id;
  return typeof id === "string" ? id : undefined;
}

/**
 * Whether the record is expired at the evaluation instant: its expiresAt is
 * strictly before `now`. A record with no expiresAt never expires. A record
 * carrying an unparseable expiresAt is REFUSED with a typed error (the
 * W1-008 gate discipline) — never silently treated as expired or honored.
 */
function isExpiredAt(record: EgressAuthorizationRecord, now: () => number): boolean {
  const expiresAt = record.expiresAt;
  if (expiresAt === undefined) return false;
  const expiresAtMs = Date.parse(expiresAt);
  if (Number.isNaN(expiresAtMs)) {
    throw new ClappEgressError(
      "invalid-record",
      `authorization record ${String(recordIdOf(record))} carries an unparseable expiresAt "${String(expiresAt)}"; refusing to derive an egress allow-list from it`,
      { recordId: recordIdOf(record) },
    );
  }
  return expiresAtMs < now();
}

// ─── The declared allow-list, derived from the record ─────────────────────────

/**
 * The derivation inputs shared by `deriveEgressAllowList` and
 * `createEgressPolicy`: the target the policy is bound to, the target's
 * authorization record (consumed structurally), the caller's declared
 * per-environment destination lists, and the injectable evaluation clock
 * (default `Date.now`; expiry is evaluated against this source only — never
 * a silently read wall clock).
 */
export interface EgressDerivationInput {
  /** The target whose authorization record must authorize the allow-list. */
  targetId: string;
  /** The target's authorization record; no record derives the empty allow-list. */
  record?: EgressAuthorizationRecord | null;
  /** The caller's declared per-environment destination lists. */
  environmentDestinations: Record<string, readonly string[]>;
  /** The injectable evaluation clock (default Date.now). */
  now?: () => number;
}

/**
 * Derives the declared egress allow-list — a PURE function over the target's
 * authorization record and the caller's declared per-environment destination
 * lists. The derived allow-list is the union of the destination lists of
 * exactly the environments the record allows, canonical: normalized,
 * deduplicated, sorted — so destination list order and duplicates never leak
 * into the derived list, and the same inputs always produce a byte-identical
 * list. Fail closed everywhere: no record, a record whose targetId does not
 * match the requested target, or a record expired at the evaluation instant
 * derives the EMPTY allow-list; an environment the record does not grant
 * contributes NOTHING even if the caller declared destinations for it. Every
 * declared destination list is validated — including lists for environments
 * the record does not grant — and an invalid destination string fails closed
 * with a typed error naming it, never a silent pass-through.
 */
export function deriveEgressAllowList(input: EgressDerivationInput): string[] {
  const clock = typeof input.now === "function" ? input.now : Date.now;
  const declarations: Record<string, readonly string[]> =
    input.environmentDestinations !== null && typeof input.environmentDestinations === "object"
      ? input.environmentDestinations
      : {};
  for (const [environment, destinations] of Object.entries(declarations)) {
    if (!Array.isArray(destinations)) {
      throw new ClappEgressError(
        "invalid-declaration",
        `the declared egress destinations for environment "${environment}" must be an array of host or host:port strings; received ${typeof destinations}`,
        { recordId: recordIdOf(input.record) },
      );
    }
    for (const destination of destinations) normalizeEgressDestination(destination);
  }
  if (typeof input.targetId !== "string" || input.targetId === "") return [];
  const record = input.record;
  if (record === null || record === undefined || typeof record !== "object") return [];
  if (record.targetId !== input.targetId) return [];
  if (isExpiredAt(record, clock)) return [];
  const granted = Array.isArray(record.environments) ? record.environments : [];
  const normalized: string[] = [];
  for (const environment of granted) {
    const destinations = declarations[environment];
    if (destinations === undefined) continue;
    for (const destination of destinations)
      normalized.push(normalizeEgressDestination(destination));
  }
  return [...new Set(normalized)].sort();
}

// ─── The egress policy ────────────────────────────────────────────────────────

/** The `check(destinations)` decision: what is in scope, what is blocked. */
export interface EgressCheckResult {
  /** The declared destinations that are in scope (normalized, declaration order). */
  readonly inScope: readonly string[];
  /** The declared destinations that are blocked (normalized, declaration order). */
  readonly blocked: readonly string[];
  /** The first blocked destination in declaration order, or undefined when none is blocked. */
  readonly firstBlocked: string | undefined;
}

/**
 * The egress policy: the derivation bound once. Exposes the derived
 * allow-list (readonly, canonical), the backing record id and the
 * `check(destinations)` decision. `check` is pure — no clock, no I/O — and
 * throws `ClappEgressError` (reason "invalid-destination") naming a
 * destination that cannot normalize; out-of-scope destinations are a
 * decision (blocked), not a throw, so the wrapper can record them through
 * the enforcement log before failing.
 */
export interface EgressPolicy {
  /** The target the policy is bound to. */
  readonly targetId: string;
  /** The derived allow-list: exactly what the authorization record grants. */
  readonly allowList: readonly string[];
  /** The id of the authorization record the allow-list was derived from, when one backs the policy. */
  readonly recordId: string | undefined;
  /** Partitions declared destinations into in-scope and blocked, identifying the first blocked one. */
  check(destinations: readonly string[]): EgressCheckResult;
}

/**
 * Creates the egress policy: binds the derivation ONCE (the allow-list and
 * its record id are fixed at creation; `check` never re-derives and never
 * reads a clock) and exposes the `check(destinations)` decision. The clock is
 * injectable and defaults to `Date.now` exactly here — nowhere else does the
 * policy read time. The policy performs no I/O.
 */
export function createEgressPolicy(input: EgressDerivationInput): EgressPolicy {
  const now = typeof input.now === "function" ? input.now : Date.now;
  const allowList = deriveEgressAllowList({ ...input, now });
  const allowSet = new Set(allowList);
  const recordId = recordIdOf(input.record);
  return {
    targetId: input.targetId,
    allowList,
    recordId,
    check(destinations: readonly string[]): EgressCheckResult {
      if (!Array.isArray(destinations)) {
        throw new ClappEgressError(
          "invalid-declaration",
          `declaredEgress must be an array of host or host:port strings; received ${typeof destinations}`,
          { recordId },
        );
      }
      const inScope: string[] = [];
      const blocked: string[] = [];
      for (const destination of destinations) {
        const normalized = normalizeEgressDestination(destination);
        if (allowSet.has(normalized)) inScope.push(normalized);
        else blocked.push(normalized);
      }
      return { inScope, blocked, firstBlocked: blocked.length > 0 ? blocked[0] : undefined };
    },
  };
}

// ─── The enforcement log port ─────────────────────────────────────────────────

/** One appended egress-enforcement record: a blocked attempt. */
export interface EgressEnforcementRecord {
  /** The normalized out-of-scope destination that was blocked. */
  readonly blockedDestination: string;
  /** The reconstruction whose execution was blocked. */
  readonly reconstructionId: string;
  /** The authorization record the derived allow-list came from, when one backs the policy. */
  readonly recordId?: string;
  /** The full set of declared destinations, as declared. */
  readonly declaredEgress: readonly string[];
}

/**
 * The narrow append port for egress enforcement records (the W2-005
 * narrow-port discipline: put, NOTHING else). The module performs no I/O of
 * its own — every durable enforcement store lives behind this port and is
 * supplied by the caller; tests supply an in-memory port.
 */
export interface EgressEnforcementLog {
  /** Appends one enforcement record. */
  put(record: EgressEnforcementRecord): Promise<void>;
}

// ─── The egress-enforcing execution provider ──────────────────────────────────

/**
 * The egress-enforcing execution input: the frozen `ExecutionProvider` input
 * plus the locally-declared destinations. `declaredEgress` is declared HERE,
 * on the wrapper's OWN input type — NOT on the frozen contract (the W1-008
 * `operatorIdentity` precedent): the frozen `ExecutionProvider` carries no
 * destinations field, and any contract revision is a tech-lead ADR proposed
 * in the W1-010 delivery record, never an edit to a frozen file.
 */
export interface EgressExecutionInput {
  reconstructionId: string;
  cwd: string;
  command: string;
  timeoutMs: number;
  network: "deny" | "allowlist" | "full";
  /**
   * The destinations this execution declares it will talk to. REQUIRED when
   * network is "allowlist" (a missing declaration fails closed); never
   * consulted — and never delegated — when network is "deny".
   */
  declaredEgress?: readonly string[];
}

/**
 * The execution result with the EXPLICIT egress-enforced marker. The marker
 * is never absent, never `undefined`, never defaulted to silence: an
 * execution report that does not state its egress mode is a failure.
 * `enforcedEgress` (the normalized destinations that were checked) is
 * present exactly when the execution ran under an enforced allow-list.
 */
export interface EgressExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  artifacts: string[];
  /** How this execution's egress was bounded. */
  egressMode: "denied" | "enforced-allowlist";
  /** The enforced destinations (normalized, declaration order) — present when egressMode is "enforced-allowlist". */
  enforcedEgress?: readonly string[];
}

/** The egress-enforcing execution provider: any `ExecutionProvider` wrapped by a policy. */
export interface EgressEnforcingExecutionProvider {
  run(input: EgressExecutionInput, signal?: AbortSignal): Promise<EgressExecutionResult>;
}

/** Options of the egress-enforcing execution provider. */
export interface EgressEnforcingOptions {
  /**
   * The narrow append port blocked attempts are recorded through. Supply it
   * in every production wiring — a blocked attempt must be recorded with its
   * destination; the block itself always happens, log or no log.
   */
  log?: EgressEnforcementLog;
}

/**
 * Creates the egress-enforcing execution provider: ANY `ExecutionProvider`
 * (candidate builds, benchmark execution — both are the same seam) wrapped
 * by one egress policy. Enforced BEFORE the wrapped call:
 *
 * - `network: "full"` (and any mode other than "deny"/"allowlist") → typed
 *   `ClappEgressError`, fail closed, ZERO delegation — the W1-003
 *   discipline preserved exactly.
 * - `network: "deny"` → delegates unchanged and decorates the result with
 *   `egressMode: "denied"` — egress is structurally impossible.
 * - `network: "allowlist"` → the input MUST carry `declaredEgress`; every
 *   declared destination must normalize validly and be in the derived
 *   allow-list. ANY out-of-scope destination blocks the whole call BEFORE
 *   the wrapped provider runs (zero delegation), appends one enforcement
 *   record through the narrow log port (blocked destination, reconstruction
 *   id, backing record id, declared destinations) and raises the typed
 *   `ClappEgressError` carrying the blocked destination. On a pass the
 *   wrapper delegates with `network: "deny"` — the substrate's only
 *   physically honest mode — and decorates the result with `egressMode:
 *   "enforced-allowlist"` plus the enforced destinations.
 */
export function createEgressEnforcingExecutionProvider(
  wrapped: ExecutionProvider,
  policy: EgressPolicy,
  options: EgressEnforcingOptions = {},
): EgressEnforcingExecutionProvider {
  const reconstructionIdOf = (value: unknown): string | undefined =>
    typeof value === "string" && value !== "" ? value : undefined;
  return {
    async run(input, signal) {
      const { network } = input;
      if (network !== "deny" && network !== "allowlist") {
        throw new ClappEgressError(
          "network-mode",
          `the egress-enforcing execution provider cannot honor network "${String(network)}": the OpenMuse computer sandbox is network-isolated, so "full" — and any mode other than "deny" or "allowlist" — is blocked with zero delegation; "allowlist" is enforced as a declaration check that delegates with "deny"`,
          {
            recordId: policy.recordId,
            reconstructionId: reconstructionIdOf(input.reconstructionId),
          },
        );
      }
      if (network === "deny") {
        const result = await wrapped.run(
          {
            reconstructionId: input.reconstructionId,
            cwd: input.cwd,
            command: input.command,
            timeoutMs: input.timeoutMs,
            network: "deny",
          },
          signal,
        );
        // Egress is structurally impossible under the substrate's network
        // isolation — the honest marker, never an absent field.
        return { ...result, egressMode: "denied" };
      }
      // network === "allowlist": the declaration check at the CLAPP seam.
      const declared = input.declaredEgress;
      if (declared === undefined) {
        throw new ClappEgressError(
          "missing-declaration",
          'network "allowlist" requires the locally-declared declaredEgress field — the destinations this execution will talk to; refusing to enforce an allow-list that was never declared',
          {
            recordId: policy.recordId,
            reconstructionId: reconstructionIdOf(input.reconstructionId),
          },
        );
      }
      const decision = policy.check(declared);
      if (decision.blocked.length > 0) {
        const [blockedDestination] = decision.blocked;
        const message = `the declared egress destination "${blockedDestination}" is out of scope for the allow-list derived from authorization record ${String(policy.recordId)} of target "${policy.targetId}"; blocking the whole call before any command runs`;
        const fields = {
          blockedDestination,
          recordId: policy.recordId,
          reconstructionId: reconstructionIdOf(input.reconstructionId),
          declaredEgress: [...declared],
        };
        if (options.log !== undefined) {
          try {
            await options.log.put({
              blockedDestination,
              reconstructionId: input.reconstructionId,
              ...(policy.recordId !== undefined ? { recordId: policy.recordId } : {}),
              declaredEgress: [...declared],
            });
          } catch (cause) {
            throw new ClappEgressError(
              "out-of-scope",
              `${message}; additionally, appending the enforcement record failed`,
              { ...fields, cause },
            );
          }
        }
        throw new ClappEgressError("out-of-scope", message, fields);
      }
      const result = await wrapped.run(
        {
          reconstructionId: input.reconstructionId,
          cwd: input.cwd,
          command: input.command,
          timeoutMs: input.timeoutMs,
          network: "deny", // the substrate's only physically honest mode
        },
        signal,
      );
      return {
        ...result,
        egressMode: "enforced-allowlist",
        enforcedEgress: [...decision.inScope],
      };
    },
  };
}
