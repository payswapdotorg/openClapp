import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ExecutionProvider,
  ReconstructionSpec,
  TargetAuthorization,
} from "../packages/clapp-contracts/src/index.ts";
import {
  AUTHORIZATION_RECORD_ID_PREFIX,
  type AuthorizationRecord,
  type AuthorizationStore,
  authorizeTarget,
} from "../packages/clapp-observation/src/index.ts";
import {
  ClappEgressError,
  createEgressEnforcingExecutionProvider,
  createEgressPolicy,
  deriveEgressAllowList,
  type EgressEnforcementLog,
  type EgressEnforcementRecord,
  type EgressExecutionInput,
  type EgressPolicy,
  normalizeEgressDestination,
} from "../packages/clapp-runtime-openmuse/src/index.ts";

/**
 * CLAPP-W1-010 — isolation/egress controls for candidate execution.
 *
 * Contract (docs/clapp/WORK_ITEMS.md, CLAPP-W1-010): candidate and benchmark
 * execution is bounded to a declared egress allow-list derived from the
 * target's authorization record — attempted out-of-scope egress is blocked
 * before the call, recorded with the blocked destination through the narrow
 * enforcement-log port, and every execution report carries an explicit
 * egress-enforced marker.
 *
 * Unit tests wrap a FAKE ExecutionProvider recording invocations (the W1-003
 * fake-provider pattern), mint REAL authorization records through the W1-008
 * `authorizeTarget` (nothing hand-rolled), and pin the policy's clock
 * (FIXED_MS, the W1-002/W1-008 FIXED_MS pattern) so expiry is deterministic.
 * No wall clock, no randomness, no external network. The battery-level half
 * of test 8 — the FROZEN W1-003 execution suite passing unmodified — is
 * confirmed in the delivery record.
 */

const OWNER = "local-user";
const OPERATOR = "operator-w1-010";
const TARGET = "target-egress";
const OTHER_TARGET = "target-other";
const FIXED_MS = 1735689600000; // 2025-01-01T00:00:00.000Z — pinned clock for deterministic expiry
const FIXED_ISO = new Date(FIXED_MS).toISOString();
const fixedClock = () => FIXED_MS;

/** The target authorization of the main fixture: production + staging granted. */
const authorization = (overrides: Partial<TargetAuthorization> = {}): TargetAuthorization => ({
  ownerId: OWNER,
  targetId: TARGET,
  scope: ["observe", "execute"],
  environments: ["production", "staging"],
  retention: "ephemeral",
  benchmarkOwned: false,
  createdAt: FIXED_ISO,
  ...overrides,
});

/** A reconstruction spec whose authorization is the given one (the W1-008 shape). */
const spec = (auth: TargetAuthorization = authorization()): ReconstructionSpec => ({
  specVersion: "0.1",
  reconstructionId: "recon-w1-010",
  targetId: auth.targetId,
  name: "Example App",
  platform: "web",
  entrypoints: ["https://app.example/"],
  authorization: auth,
  exploration: { maxStages: 4, maxActions: 40, maxDurationMs: 600_000, seed: 7 },
  synthesis: { targetStack: "web", allowNetwork: false, packagePolicy: "verified-only" },
  verification: {
    journeys: ["home"],
    visual: true,
    network: false,
    state: false,
    maxRepairIterations: 2,
  },
});

/** An in-memory AuthorizationStore port: exactly get and put. */
function createMemoryStore() {
  const records = new Map<string, AuthorizationRecord>();
  const store: AuthorizationStore = {
    async get(key) {
      return records.get(key);
    },
    async put(key, record) {
      records.set(key, record);
    },
  };
  return { store, records };
}

/** Mints a REAL authorization record through the W1-008 authorizeTarget. */
async function mintRecord(
  overrides: Partial<TargetAuthorization> = {},
): Promise<AuthorizationRecord> {
  const { store } = createMemoryStore();
  return authorizeTarget(spec(authorization(overrides)), {
    operatorIdentity: OPERATOR,
    store,
  });
}

/** A fake ExecutionProvider recording invocations (the W1-003 pattern). */
function fakeProvider() {
  const invocations: { input: Record<string, unknown>; signal?: AbortSignal }[] = [];
  const provider: ExecutionProvider = {
    async run(input, signal) {
      invocations.push({ input: { ...input }, signal });
      return {
        exitCode: 0,
        stdout: `ran:${input.command}`,
        stderr: "",
        artifacts: ["artifact.txt"],
      };
    },
  };
  return { provider, invocations };
}

/** An in-memory EgressEnforcementLog port: exactly put, recording records. */
function memoryLog() {
  const records: EgressEnforcementRecord[] = [];
  const log: EgressEnforcementLog = {
    async put(record) {
      records.push({ ...record, declaredEgress: [...record.declaredEgress] });
    },
  };
  return { log, records };
}

/** The base execution input of the wrapper tests. */
const executionInput = (overrides: Partial<EgressExecutionInput> = {}): EgressExecutionInput => ({
  reconstructionId: "recon-w1-010",
  cwd: "/workspace/clapp/recon-w1-010",
  command: "npm run build",
  timeoutMs: 30_000,
  network: "allowlist",
  ...overrides,
});

test("the allow-list derives from the target's authorization record", async () => {
  const record = await mintRecord(); // environments ["production", "staging"], no expiry
  assert.ok(record.id.startsWith(AUTHORIZATION_RECORD_ID_PREFIX));
  const environmentDestinations: Record<string, readonly string[]> = {
    production: ["cdn.example.com:443", "API.Example.com", "api.example.com"],
    staging: ["STAGING.Example.com:8443", "staging.example.com:8443"],
    development: ["dev.example.com:3000"], // NOT granted — must contribute nothing
  };
  const allowList = deriveEgressAllowList({
    targetId: TARGET,
    record,
    environmentDestinations,
    now: fixedClock,
  });
  // exactly the union of the granted environments' lists: normalized, deduplicated, sorted
  assert.deepEqual(allowList, [
    "api.example.com",
    "cdn.example.com:443",
    "staging.example.com:8443",
  ]);
  // deterministic: same inputs, byte-identical derivation
  assert.deepEqual(
    deriveEgressAllowList({ targetId: TARGET, record, environmentDestinations, now: fixedClock }),
    allowList,
  );
  // the environment the record does not grant contributed nothing
  assert.ok(!allowList.includes("dev.example.com:3000"));
  // duplicates (post-normalization) never leak into the derived list
  assert.equal(allowList.filter((destination) => destination === "api.example.com").length, 1);
  assert.equal(
    allowList.filter((destination) => destination === "staging.example.com:8443").length,
    1,
  );
});

test("no record or expired record derives the empty allow-list", async () => {
  const environmentDestinations: Record<string, readonly string[]> = {
    production: ["api.example.com"],
  };
  // no record at all (null, and omitted entirely)
  assert.deepEqual(
    deriveEgressAllowList({
      targetId: TARGET,
      record: null,
      environmentDestinations,
      now: fixedClock,
    }),
    [],
  );
  assert.deepEqual(
    deriveEgressAllowList({ targetId: TARGET, environmentDestinations, now: fixedClock }),
    [],
  );
  // a record whose targetId does not match the requested target
  const record = await mintRecord();
  assert.deepEqual(
    deriveEgressAllowList({
      targetId: OTHER_TARGET,
      record,
      environmentDestinations,
      now: fixedClock,
    }),
    [],
  );
  // a record expired strictly before the pinned instant
  const expired = await mintRecord({ expiresAt: new Date(FIXED_MS - 1).toISOString() });
  assert.deepEqual(
    deriveEgressAllowList({
      targetId: TARGET,
      record: expired,
      environmentDestinations,
      now: fixedClock,
    }),
    [],
  );
  // every destination is out of scope under the expired record
  const policy = createEgressPolicy({
    targetId: TARGET,
    record: expired,
    environmentDestinations,
    now: fixedClock,
  });
  const decision = policy.check(["api.example.com"]);
  assert.deepEqual(decision.inScope, []);
  assert.deepEqual(decision.blocked, ["api.example.com"]);
  assert.equal(decision.firstBlocked, "api.example.com");
  // a record with no expiresAt never expires
  const laterClock = () => FIXED_MS + 365 * 24 * 60 * 60 * 1000; // a year after the pinned instant
  assert.deepEqual(
    deriveEgressAllowList({
      targetId: TARGET,
      record,
      environmentDestinations,
      now: laterClock,
    }),
    ["api.example.com"],
  );
  // a record whose expiresAt is exactly at the evaluation instant still grants
  const exactly = await mintRecord({ expiresAt: FIXED_ISO });
  assert.deepEqual(
    deriveEgressAllowList({
      targetId: TARGET,
      record: exactly,
      environmentDestinations,
      now: fixedClock,
    }),
    ["api.example.com"],
  );
});

test("out-of-scope declared egress is blocked before the call", async () => {
  const record = await mintRecord();
  const policy = createEgressPolicy({
    targetId: TARGET,
    record,
    environmentDestinations: {
      production: ["api.example.com"],
      staging: ["staging.example.com:8443"],
    },
    now: fixedClock,
  });
  const { provider, invocations } = fakeProvider();
  const enforcing = createEgressEnforcingExecutionProvider(provider, policy);
  await assert.rejects(
    enforcing.run(executionInput({ declaredEgress: ["api.example.com", "evil.example.com:443"] })),
    (error: unknown) => {
      assert.ok(error instanceof ClappEgressError);
      assert.equal(error.reason, "out-of-scope");
      assert.equal(error.blockedDestination, "evil.example.com:443");
      assert.equal(error.recordId, record.id);
      assert.equal(error.reconstructionId, "recon-w1-010");
      assert.deepEqual(error.declaredEgress, ["api.example.com", "evil.example.com:443"]);
      return true;
    },
  );
  // blocked BEFORE the wrapped provider runs: zero invocations
  assert.equal(invocations.length, 0);
});

test("the blocked destination is recorded through the enforcement log", async () => {
  const record = await mintRecord();
  const policy = createEgressPolicy({
    targetId: TARGET,
    record,
    environmentDestinations: { production: ["api.example.com"] },
    now: fixedClock,
  });
  const { provider, invocations } = fakeProvider();
  const { log, records } = memoryLog();
  const enforcing = createEgressEnforcingExecutionProvider(provider, policy, { log });

  // a blocked call appends exactly one enforcement record
  await assert.rejects(
    enforcing.run(executionInput({ declaredEgress: ["api.example.com", "evil.example.com:443"] })),
    (error: unknown) => error instanceof ClappEgressError,
  );
  assert.equal(records.length, 1);
  const [enforcement] = records;
  assert.equal(enforcement.blockedDestination, "evil.example.com:443");
  assert.equal(enforcement.reconstructionId, "recon-w1-010");
  assert.equal(enforcement.recordId, record.id);
  assert.deepEqual(enforcement.declaredEgress, ["api.example.com", "evil.example.com:443"]);

  // a pass appends nothing
  const passed = await enforcing.run(
    executionInput({ command: "npm run pass", declaredEgress: ["api.example.com"] }),
  );
  assert.equal(passed.egressMode, "enforced-allowlist");
  assert.equal(records.length, 1);

  // a deny-mode call appends nothing
  const denied = await enforcing.run(executionInput({ network: "deny", command: "npm run deny" }));
  assert.equal(denied.egressMode, "denied");
  assert.equal(records.length, 1);

  // the blocked call itself never reached the wrapped provider
  assert.equal(invocations.length, 2);
});

test("in-scope declared egress executes and the report carries the egress-enforced marker", async () => {
  const record = await mintRecord();
  const policy = createEgressPolicy({
    targetId: TARGET,
    record,
    environmentDestinations: { production: ["api.example.com", "api.example.com:443"] },
    now: fixedClock,
  });
  const { provider, invocations } = fakeProvider();
  const { log } = memoryLog();
  const enforcing = createEgressEnforcingExecutionProvider(provider, policy, { log });
  const result = await enforcing.run(
    executionInput({ declaredEgress: ["API.Example.com:443", "api.example.com"] }),
  );
  // the explicit egress-enforced marker plus the enforced destinations (normalized)
  assert.equal(result.egressMode, "enforced-allowlist");
  assert.deepEqual(result.enforcedEgress, ["api.example.com:443", "api.example.com"]);
  // the wrapper delegated exactly once, with network "deny" — the substrate's only honest mode
  assert.equal(invocations.length, 1);
  const [invocation] = invocations;
  assert.equal(invocation.input.network, "deny");
  assert.equal(invocation.input.reconstructionId, "recon-w1-010");
  assert.equal(invocation.input.cwd, "/workspace/clapp/recon-w1-010");
  assert.equal(invocation.input.command, "npm run build");
  assert.equal(invocation.input.timeoutMs, 30_000);
  // the seam-level declaredEgress never crosses into the substrate input
  assert.equal("declaredEgress" in invocation.input, false);
  // the wrapped provider's own result fields pass through unchanged
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "ran:npm run build");
  assert.equal(result.stderr, "");
  assert.deepEqual(result.artifacts, ["artifact.txt"]);
});

test("network mode deny passes through with an explicit marker", async () => {
  const record = await mintRecord();
  // a policy whose check REFUSES if consulted: deny mode must never check
  const refusingPolicy: EgressPolicy = {
    targetId: TARGET,
    allowList: deriveEgressAllowList({
      targetId: TARGET,
      record,
      environmentDestinations: { production: ["api.example.com"] },
      now: fixedClock,
    }),
    recordId: record.id,
    check() {
      throw new Error("policy.check must not be called on a deny-mode input");
    },
  };
  const { provider, invocations } = fakeProvider();
  const { log, records } = memoryLog();
  const enforcing = createEgressEnforcingExecutionProvider(provider, refusingPolicy, { log });
  const result = await enforcing.run(executionInput({ network: "deny" }));
  // the explicit marker: egress is structurally impossible under deny
  assert.equal(result.egressMode, "denied");
  assert.equal(result.enforcedEgress, undefined);
  assert.ok("egressMode" in result); // the marker is never absent on any path
  // delegated unchanged: exactly one invocation carrying the frozen input fields
  assert.equal(invocations.length, 1);
  const [invocation] = invocations;
  assert.deepEqual(invocation.input, {
    reconstructionId: "recon-w1-010",
    cwd: "/workspace/clapp/recon-w1-010",
    command: "npm run build",
    timeoutMs: 30_000,
    network: "deny",
  });
  // no policy check (the refusing check never fired), no log record
  assert.equal(records.length, 0);
  // the wrapped provider's own result fields pass through unchanged
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "ran:npm run build");
  assert.deepEqual(result.artifacts, ["artifact.txt"]);
});

test("full network mode fails closed with zero delegation", async () => {
  const record = await mintRecord();
  const policy = createEgressPolicy({
    targetId: TARGET,
    record,
    environmentDestinations: { production: ["api.example.com"] },
    now: fixedClock,
  });
  const { provider, invocations } = fakeProvider();
  const { log, records } = memoryLog();
  const enforcing = createEgressEnforcingExecutionProvider(provider, policy, { log });
  await assert.rejects(
    enforcing.run(executionInput({ network: "full", declaredEgress: ["api.example.com"] })),
    (error: unknown) => {
      assert.ok(error instanceof ClappEgressError);
      assert.equal(error.reason, "network-mode");
      assert.ok(
        error.message.includes('cannot honor network "full"'),
        "the full-mode error states the W1-003 physical truth",
      );
      return true;
    },
  );
  // the W1-003 discipline preserved through the wrapper: zero invocations
  assert.equal(invocations.length, 0);
  assert.equal(records.length, 0);
  // an unknown network mode fails closed the same way — never delegated
  await assert.rejects(
    enforcing.run({
      ...executionInput(),
      network: "open" as unknown as EgressExecutionInput["network"],
    }),
    (error: unknown) => error instanceof ClappEgressError,
  );
  assert.equal(invocations.length, 0);
});

test("destinations normalize deterministically and invalid ones fail closed", async () => {
  // host and host:port inputs normalize: lowercase, no scheme/path/userinfo
  assert.equal(normalizeEgressDestination("API.Example.COM"), "api.example.com");
  assert.equal(normalizeEgressDestination("Api.Example.Com:443"), "api.example.com:443");
  assert.equal(normalizeEgressDestination("localhost"), "localhost");
  assert.equal(normalizeEgressDestination("192.168.1.10:8080"), "192.168.1.10:8080");
  assert.equal(normalizeEgressDestination("[2001:DB8::1]:443"), "[2001:db8::1]:443");
  assert.equal(normalizeEgressDestination("api.example.com:0443"), "api.example.com:443");
  // the same destination spelled differently is one derived entry
  assert.deepEqual(
    deriveEgressAllowList({
      targetId: TARGET,
      record: await mintRecord(),
      environmentDestinations: {
        production: [
          "api.example.com",
          "API.Example.com",
          "api.example.com:443",
          "API.EXAMPLE.COM:443",
        ],
      },
      now: fixedClock,
    }),
    ["api.example.com", "api.example.com:443"],
  );
  // invalid destinations fail closed with a typed error naming them
  const invalid = [
    ":8080", // a bare port
    "", // an empty host
    "https://api.example.com", // a scheme
    "api.example.com/v1", // a path
    "user@api.example.com", // userinfo
    " api.example.com", // leading whitespace
    "api.example.com ", // trailing whitespace
    "api.example.com:", // an empty port
    "api..example.com", // an empty host label
  ];
  for (const destination of invalid) {
    assert.throws(
      () => normalizeEgressDestination(destination),
      (error: unknown) => {
        assert.ok(error instanceof ClappEgressError);
        assert.equal(error.reason, "invalid-destination");
        assert.ok(
          error.message.includes(destination === "" ? '""' : destination),
          `the error names the invalid destination: ${destination}`,
        );
        assert.equal(error.blockedDestination, destination);
        return true;
      },
    );
  }
  // an invalid declared destination blocks BEFORE delegation and BEFORE the log
  const record = await mintRecord();
  const policy = createEgressPolicy({
    targetId: TARGET,
    record,
    environmentDestinations: { production: ["api.example.com"] },
    now: fixedClock,
  });
  const { provider, invocations } = fakeProvider();
  const { log, records } = memoryLog();
  const enforcing = createEgressEnforcingExecutionProvider(provider, policy, { log });
  await assert.rejects(
    enforcing.run(
      executionInput({ declaredEgress: ["api.example.com", "https://evil.example.com"] }),
    ),
    (error: unknown) => {
      assert.ok(error instanceof ClappEgressError);
      assert.equal(error.reason, "invalid-destination");
      assert.equal(error.blockedDestination, "https://evil.example.com");
      return true;
    },
  );
  assert.equal(invocations.length, 0);
  assert.equal(records.length, 0);
});
