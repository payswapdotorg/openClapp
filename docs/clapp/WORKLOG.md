# CLAPP Worklog

## 2026-09-27 — TL-0 verification wave: gates run, format seam fixed, contracts frozen v0.1

Baseline: `bae700938c6e651d115fc1e921771c0fc2b04b6b` (handoff head).
Base reference worktree: `34b15bc80340e582fb8c25573646cfb0bbc5184d`.

Verification environment: pnpm 11.19.0, Node v24.21.0, clean checkout.

Gate results (details in `docs/clapp/STATUS.md`):
- clean `pnpm install --frozen-lockfile`: PASS — the manually added
  workspace/lockfile seam is accepted by pnpm;
- CLAPP packages resolve as workspace packages (`workspace:*` symlinks): PASS;
- typecheck (root + mobile): PASS, zero errors — contracts compile as declared;
- lint: 13 errors, all format-only in new CLAPP files; fixed by reformatting
  12 files (schemas/package JSON verified semantically identical; no substrate
  file touched); lint now PASS;
- `pnpm test`: 192/189/3, identical failure set to the base snapshot
  (pre-existing environment artifacts; zero overlay regressions);
- `pnpm build:server`: PASS;
- `pnpm test:browser`: PASS after provisioning Playwright chromium r1234
  (pinned by playwright 1.62.1);
- `pnpm test:computer`: not runnable in the TL environment (no Docker);
  deferred to a Docker-capable environment; mocked computer suite passes.

Decisions:
- contracts frozen at **v0.1** (typecheck surfaced no missing fields);
- W1-001 / W2-001 / W3-001 cleared for concurrent dispatch against the frozen
  contracts;
- computer smoke remains an open acceptance item for M0 (environment-dep).

## 2026-09-27 — openClapp substrate audit and CLAPP architecture handoff

Repository: `payswapdotorg/openClapp`

Base snapshot audited: `34b15bc80340e582fb8c25573646cfb0bbc5184d`.

Verified reusable OpenMuse capabilities:
- durable task engine and SQL leases;
- browser worker and persistent Chromium sessions;
- Linux Docker computer/workspace;
- files/artifacts;
- authentication/owner boundary;
- web/mobile UI;
- CI and tests.

Architectural decision:
- OpenMuse remains the runtime/control plane.
- CLAPP is implemented as a framework-neutral application-intelligence layer.
- `packages/clapp-runtime-openmuse` is the only required domain-to-OpenMuse adapter.
- Three worker packages divide into Runtime/Observation, Intelligence/Learning, Synthesis/Verification/UX.

No CLAPP implementation existed in the cloned repository before this handoff.

Next:
- TL-0 freeze contracts.
- Dispatch W1-001, W2-001, W3-001 in parallel.
- Do not start dependent work before contract freeze.

## Required update format

Date:
Phase:
Work items:
Integrated commits:
Tests:
Acceptance:
New risks:
Contract/ADR changes:
Next unblocked work:


## 2026-09-27 — CLAPP repository scaffold integrated

Work items: repository-level source of truth, canonical contracts, five CLAPP package boundaries, schemas, OpenMuse integration architecture, three-worker execution plan.

Integrated commits: multiple direct main commits during handoff construction.

Tests: not executed in the available environment; GitHub reported zero workflow runs at audit time. This is explicitly pending the first TL clean-checkout validation.

Acceptance: documentation/scaffold acceptance complete; functional CLAPP acceptance not started.

New risks: workspace/lockfile registration was edited manually and must be validated by pnpm install --frozen-lockfile. CLAPP package implementations are scaffolds and intentionally throw on unimplemented runtime paths.

Contract/ADR changes: ADR-001 OpenMuse runtime substrate; ADR-002 three-worker boundaries; canonical CLAPP contract v0.1 declared for TL review/freeze.

Next unblocked work: clean-checkout gate, then W1-001 + W2-001 + W3-001 in parallel.

## 2026-09-27 — Wave 1 Lane 1 (CLAPP-W1-001) integrated

Date: 2026-09-27
Phase: Phase 1 (durable CLAPP task and runtime adapter) — lane 1 of wave 1.
Work items: CLAPP-W1-001 — @clapp/runtime-openmuse durable OpenMuse runtime adapter.
Integrated commits: b7a170e (worker, single commit on base bd3ac43, verified byte-identical via git bundle sha256 316bb1af…; fetched from staged delivery) → merge 76df865.
Tests: worker env 214/213/1 (1 pre-existing file-level browser artifact); TL env base 194/192/2 → branch 203/201/2 (same two pre-existing file-level artifacts: browser.test.ts, oauth.test.ts); +9 new tests all passing; typecheck 0; lint 0; build:server OK; pnpm-lock.yaml unchanged.
Acceptance: all 7 required named tests + 1 worker-added invalid-input test PASS (durable stage run; restart reconcile without re-execution; pause/cancel clean state; bind validation fail-closed; content-addressed artifact roundtrip; unavailable evidence stays unavailable; non-CLAPP delegation; invalid input fails). Per-file sha256 declaration verified against the bundle tree — 6/6 match. Constitution verified: only packages/clapp-runtime-openmuse/** + tests/clapp-w1-001-runtime.test.ts touched (+1922/−33).
New risks: production wiring of createClappTaskHandler into the AgentService worker chain is the TL seam (proven against a real TaskWorker over a real store, not a re-wired createApp); artifacts are PDF-only via the OpenMuse Files service (typed error otherwise); ApprovalProvider fails closed pending an approval-capable handle; owner discovery scans tasks by reconstructionId (multi-owner resolves to most recent). StageRecord state key "clappStage" + "reconciled"/"cancelled" event vocabulary are W1 conventions to standardize in W1-004+.
Contract/ADR changes: none applied (contracts frozen). Worker proposed three revisions for TL review at next freeze: owner-scoped provider inputs / for(owner) factory; ArtifactProvider.put first-class source/classification/targetId + expected-output paths for ExecutionProvider.run; an approvals-capable handle or approval id vocabulary. Recorded, not enacted — v0.1 stays frozen for wave 1.
Next unblocked work: CLAPP-W1-002 (browser observation adapter — runs against this base), CLAPP-W1-003 (candidate workspace execution), CLAPP-W1-004 (run artifact/recovery semantics).

## 2026-09-27 — Wave 1 Lane 2 (CLAPP-W2-001) integrated

Date: 2026-09-27
Phase: Phase 3 (Behavioral IR foundation) — lane 2 of wave 1.
Work items: CLAPP-W2-001 — canonical Behavioral IR validation/serialization/diff in @clapp/intelligence.
Integrated commits: 720f67f (worker, single commit on base bd3ac43; bundle sha256 684460bf… verified, 6/6 per-file sha256s match) → merge on top of W1 integration.
Tests: worker env 213/212/1 (pre-existing browser file-level artifact); TL env integrated main: 209/207/2 vs base 194/192/2 — exactly +15 new tests (8 W1 + 7 W2) all passing; same two pre-existing file-level artifacts (browser, oauth); typecheck 0; lint 0; build:server OK; lockfile unchanged.
Acceptance: 7/7 required named tests PASS (minimal IR validation; 22 single-mutation path checks; never-throw on 25 hostile inputs incl. cycles/500-deep nesting; canonical serialization incl. cross-process byte-stability; deserialize round-trip; deterministic path-addressed diff; schema/contract alignment proof). Constitution verified: only packages/clapp-intelligence/** + tests/clapp-w2-001-ir.test.ts touched.
New risks: validator enforces strict invariants beyond the schema (non-empty identity strings, evidence-id uniqueness, JSON-safety of unknown fields) — other IR-producing channels must pass validateBehavioralIr early; canonical hashing depends on code-unit key sort + engine number formatting (stable per Node major).
Contract/ADR changes: none enacted. Worker surfaced FIVE genuine schema-vs-TS misalignments (top-level additionalProperties:false vs forward-compat; schema EvidenceRef.runId absent from TS; schema required-lists looser than TS; platform/sha256/schemaVersion unconstrained in schema; option to codify stricter invariants). Recorded for the next freeze — v0.1 stays frozen for wave 1.
Next unblocked work: W2-002 (evidence-to-IR extraction), W2-003 (exploration/journey model), W2-004 (archetype classifier); canonical serialize/diff now usable as IR hashing/persistence/structural-compare primitives.

## 2026-09-27 — Wave 1 Lane 3 (CLAPP-W3-001) integrated — WAVE 1 COMPLETE

Date: 2026-09-27
Phase: Phase 4 foundation (SynthesisPlan) — lane 3 of wave 1; wave 1 now fully integrated.
Work items: CLAPP-W3-001 — deterministic SynthesisPlan derivation/validation/canonical serialization in @clapp/synthesis.
Integrated commits: 7480b8b (worker, single commit on EXACTLY bd3ac43 — worker disclosed and correctly handled the clone-HEAD-at-ec9eccf deviation by explicitly branching from the frozen base; bundle sha256 41750d36… verified, 7/7 per-file sha256s match) → merge on top of W1+W2 integration.
Tests: worker sandbox 214/214/0 (their env has zero file-level artifacts; base 206/206/0 at the same SHA); TL env full-wave battery: 215-216 tests / 213 pass / 2-3 fail — the failures are exactly the TL-0-documented pre-existing file-level artifacts (browser, oauth, intermittently conversation-browser; run-to-run count variance is the known wrapper-failure counting behavior); all 23 wave-1 clapp tests pass standalone and in-suite; typecheck 0; lint 0; build:server OK; lockfile unchanged.
Acceptance: 8/8 required named tests PASS (determinism incl. reversed key-insertion orders; journey→route mapping; input purity via structuredClone; missing acceptance journeys become explicit assumptions; packageIds filtered-not-invented; empty api/data/packageIds produce assumptions; 20-mutation validation with JSON paths; serialization round-trip). Constitution verified: only packages/clapp-synthesis/** + tests/clapp-w3-001-plan.test.ts touched (+880/−9).
New risks: the plan's concrete record shapes (PlanRoute/PlanComponent/keyed entries) are package-level decisions W3-002 must match or the TL relaxes at integration; routes are journey-addressable only (the frozen IR has no navigation section); createSynthesisEngine().plan is now wired to the real planner (the one scaffold behavior change, flagged by the worker).
Contract/ADR changes: none enacted. Worker proposed two field-level revisions for the next freeze (typed plan record shapes; a BehavioralIr navigation/screen-graph section). Recorded — v0.1 stays frozen through wave 1.
Next unblocked work: W3-002 (web candidate generator), then W3-003; wave 2 lanes W1-002/W1-003/W2-005 dispatch against this integrated base.
