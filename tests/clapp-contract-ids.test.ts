import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { TargetAuthorization } from "../packages/clapp-contracts/src/index.ts";
import {
  buildLearningComparison,
  decidePromotionGate,
  EVALUATION_DECISION_ID_PREFIX,
} from "../packages/clapp-intelligence/src/index.ts";
import {
  AUTHORIZATION_RECORD_ID_PREFIX,
  buildAuthorizationRecord,
} from "../packages/clapp-observation/src/index.ts";

/**
 * CLAPP contract identifier compatibility test (ADR-003, tech-lead owned).
 *
 * Pins the wave-9 identifier revision together, so documentation and
 * implementation cannot drift silently:
 *   1. docs/clapp/CONTRACTS.md "Core identifiers" lists every module-declared
 *      persisted-record prefix (`clapp_authz_`, `clapp_eval_`);
 *   2. ids are content-addressed — prefix + first 16 hex chars of sha256 —
 *      matching the W2-006/W2-009 family discipline;
 *   3. ids are deterministic (same canonical content, same id) and
 *      distinguishing (different content, different id).
 *
 * Uses the real module entry points (buildAuthorizationRecord,
 * buildLearningComparison + decidePromotionGate) with the established test
 * fixtures — no reimplementation of the derivation, only observation of it.
 */

const CONTRACTS_PATH = new URL("../docs/clapp/CONTRACTS.md", import.meta.url);

/** The persisted-record prefixes this test pins to the contract doc. */
const PINNED_PREFIXES = [
  { prefix: AUTHORIZATION_RECORD_ID_PREFIX, family: "authorization records" },
  { prefix: EVALUATION_DECISION_ID_PREFIX, family: "evaluation decisions" },
] as const;

const ID_PATTERN = /^[0-9a-f]{16}$/;

/** Extracts the "Core identifiers" bullet list from CONTRACTS.md. */
function coreIdentifiers(): string[] {
  const text = readFileSync(CONTRACTS_PATH, "utf8");
  const start = text.indexOf("## Core identifiers");
  assert.notStrictEqual(start, -1, "CONTRACTS.md must have a Core identifiers section");
  const end = text.indexOf("##", start + 1);
  const section = text.slice(start, end === -1 ? undefined : end);
  return [...section.matchAll(/^- `(clapp_[a-z]+_)`$/gm)].map((m) => m[1]);
}

// --- W1-008 authorization fixture (the established test constants) ---

const FIXED_MS = 1735689600000; // 2025-01-01T00:00:00.000Z
const FIXED_ISO = new Date(FIXED_MS).toISOString();

const authorization = (targetId: string): TargetAuthorization => ({
  ownerId: "local-user",
  targetId,
  scope: ["observe"],
  environments: ["web"],
  retention: "ephemeral",
  benchmarkOwned: false,
  createdAt: FIXED_ISO,
});

// --- W2-010 learning/gate fixtures (the established test constants) ---

const VERIFIED_AT = "2025-07-01T10:00:00.000Z";
const RUN = "clapp_run_fixture_contract_ids";

const equivalentParity = () => ({
  verdict: "equivalent" as const,
  verificationRunId: RUN,
  verifiedAt: VERIFIED_AT,
  minorFindings: 0,
  majorFindings: 0,
});

const buildRecord = (appId: string, phase: "scratch" | "reuse", candidateId: string) => ({
  appId,
  phase,
  reusedPackageIds: phase === "reuse" ? [candidateId] : [],
  rejectedPackageIds: [],
  newCodeUnits: 24,
  repairIterations: 3,
  buildSteps: 40,
  testsPassed: 12,
  testsTotal: 12,
  parity: equivalentParity(),
});

const decisionFor = (candidateId: string, version = "1.0.0") => {
  const report = buildLearningComparison(
    buildRecord("A1", "scratch", candidateId),
    buildRecord("A2", "reuse", candidateId),
  );
  return decidePromotionGate({ candidate: { id: candidateId, version }, report });
};

test("CONTRACTS.md Core identifiers lists both module-declared prefixes", () => {
  const listed = coreIdentifiers();
  for (const { prefix } of PINNED_PREFIXES) {
    assert.ok(listed.includes(prefix), `Core identifiers must list ${prefix}`);
  }
  // The pre-existing family members stay listed — this revision is additive.
  for (const legacy of ["clapp_package_", "clapp_target_", "clapp_run_"]) {
    assert.ok(listed.includes(legacy), `Core identifiers must still list ${legacy}`);
  }
});

test("authorization record ids are clapp_authz_ + 16 hex, content-addressed", () => {
  const record = buildAuthorizationRecord(authorization("target-example"), "operator-contract-ids");
  assert.ok(record.id.startsWith(AUTHORIZATION_RECORD_ID_PREFIX));
  const tail = record.id.slice(AUTHORIZATION_RECORD_ID_PREFIX.length);
  assert.match(tail, ID_PATTERN);

  // Deterministic: same content, byte-identical id.
  const again = buildAuthorizationRecord(authorization("target-example"), "operator-contract-ids");
  assert.strictEqual(again.id, record.id);

  // Distinguishing: different content, different id.
  const other = buildAuthorizationRecord(authorization("target-other"), "operator-contract-ids");
  assert.notStrictEqual(other.id, record.id);
});

test("promotion gate decision ids are clapp_eval_ + 16 hex, content-addressed", () => {
  const decision = decisionFor("clapp_package_fixture_contract_ids");
  assert.ok(decision.id.startsWith(EVALUATION_DECISION_ID_PREFIX));
  const tail = decision.id.slice(EVALUATION_DECISION_ID_PREFIX.length);
  assert.match(tail, ID_PATTERN);

  // Deterministic: same content, byte-identical id.
  assert.strictEqual(decisionFor("clapp_package_fixture_contract_ids").id, decision.id);

  // Distinguishing: different content, different id.
  assert.notStrictEqual(decisionFor("clapp_package_other").id, decision.id);
});
