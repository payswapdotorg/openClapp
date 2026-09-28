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

## 2026-09-27 — Wave 2 Lane 3 (CLAPP-W1-003) integrated

Date: 2026-09-27
Phase: Phase 1 completion (candidate workspace execution seam) — wave 2 lane 3, executed by the W3-lane worker under the documented TL handoff.
Work items: CLAPP-W1-003 — candidate workspace execution provider extending @clapp/runtime-openmuse.
Integrated commits: ce0eea7 (worker, single commit on base 7350970; bundle sha256 b9bbcd72… verified, 6/6 per-file sha256s match) → merge.
Tests: worker sandbox 239/238/1 (their baseline 228/227/1 at 7350970 — the single failure the documented browser file-level artifact); TL env: 227/225/2 — the same two pre-existing file-level artifacts (browser, oauth); W1-003 suite 10/10 standalone (9 required + 1 worker-added); wave-1 runtime suite 8/8 unchanged on the extended package (backward compatibility PROVEN, including the no-options constructor throwing typed not-configured only at call time); typecheck 0; lint 0; build:server OK; lockfile unchanged.
Acceptance: all required named tests PASS (result-not-exception on failure; network modes fail closed; timeout ceiling before start; idempotent runs return the same receipt; workspace lifecycle with tombstoned ids never reused; chunked seeding under 256KB with sha256-verified reassembly; abort surfaces interrupted state honestly; wave-1 surface unchanged; restart-safe discovery by path scheme). Constitution verified: only packages/clapp-runtime-openmuse/** + tests/clapp-w1-003-execution.test.ts touched (+2410/−28).
New risks: harvest is PDF-only through the v0.1 files service (per-path honest failure reports); run().artifacts stays [] (harvest is an explicit seam call); workspace registry is enrichment-only (discovery works without it).
Contract/ADR changes: none enacted. Worker followed the frozen contracts; the seam's concrete shapes (CandidateExecutionOptions, runCandidateBuild, seedWorkspaceFile, discoverWorkspaces, candidateSeamOf) are package-level surface for W3-002 to compose.
Next unblocked work: W3-002 (web candidate generator — the seam's primary consumer).

## 2026-09-28 — Wave 2 Lane 2 (CLAPP-W2-005) integrated

Date: 2026-09-28
Phase: Phase 6 foundation (package library) — wave 2 lane 2.
Work items: CLAPP-W2-005 — package schema, registry and versioning in @clapp/intelligence.
Integrated commits: 76e2d17 (worker, single commit on base 7350970; bundle sha256 2fce490c… verified, 8/8 per-file sha256s match) → merge.
Tests: worker sandbox 239/238/1 (baseline 229/228/1, the documented browser artifact); TL env 237/236/1 — failures stay within the pre-existing file-level artifact set (browser/oauth, run-to-run variance); W2-005 suite 10/10 standalone; typecheck 0; lint 0; build:server OK; lockfile unchanged.
Acceptance: all 10 required named tests PASS (validation round-trip + identity stability; multi-violation collection with exact JSON paths; idempotent register; content-conflict typing; version monotonicity incl. BigInt-exact 1.10.0>1.9.0 and zero-padded normalization; immutable promotion with idempotent identical-evidence re-promotion; deterministic list filters; plus the remaining named tests as delivered). Constitution verified: only packages/clapp-intelligence/** + tests/clapp-w2-005-packages.test.ts touched (+1727).
New risks: the registry surface is synchronous by design (store port is sync — the OpenMuse-backed adapter will wrap async substrate calls behind it or the surface gets an async sibling in a later wave); JSON-Schema enforcement is hand-implemented against the frozen schema (no ajv — constitution).
Contract/ADR changes: none enacted; the frozen package.schema.json is enforced EXACTLY.
Next unblocked work: W2-006 (package extraction/promotion), W2-007 (retrieval/compatibility graph) — both build on this registry.

## 2026-09-28 — Wave 2 Lane 1 (CLAPP-W1-002) integrated — WAVE 2 COMPLETE

Date: 2026-09-28
Phase: Phase 2 (web observation and evidence) — wave 2 lane 1; wave 2 now fully integrated.
Work items: CLAPP-W1-002 — browser observation adapter in @clapp-observation.
Integrated commits: b6c73e9 (worker, single commit on base 7350970; bundle sha256 05caa2f3… verified, 9/9 per-file sha256s match) → merge.
Tests: worker sandbox 238/237/1 (baseline 228/227/1, the documented browser artifact); TL env full-wave-2 battery: 247/245/2 — the same pre-existing file-level artifacts; W1-002 suite 9/9 standalone; typecheck 0; lint 0; build:server OK; lockfile unchanged.
Acceptance: all 9 required named tests PASS incl. the integration-seam test (real BrowserService/Store/Auth/Files against a node:http loopback stub worker — no Chromium); per-channel honesty (dom-text/page-meta/screenshot observed; dom-structure/a11y/network/storage unavailable with precise source notes); content-addressed refs with locally computed sha256; deterministic byte-identical capture; typed abort (ClappObservationAbortError) with an honest observePartial escape shape; copy-on-write redaction with shape-preserving markers (screenshot markers are real PNGs); frozen OBSERVATION_CHANNELS registry for W2-002. Constitution verified: only packages/clapp-observation/** + tests/clapp-w1-002-observation.test.ts touched.
New risks: the evidence byte vault is in-memory (durable evidence storage is a later wave); the seam binds the real BrowserService shape but the live worker's response envelope is only exercised through the stub.
Contract/ADR changes: none enacted.
Next unblocked work: W2-002 (evidence-to-IR), W2-003 (exploration), W1-005 (benchmark hosting) — all depend on W1-002, now landed; wave 3 dispatch (W1-005, W2-002, W3-002) against this integrated base.

## 2026-09-28 — Wave 3 Lane 1 (CLAPP-W1-005) integrated

Date: 2026-09-28
Phase: Phase 2 deliverable (disposable web benchmark fixtures) — wave 3 lane 1.
Work items: CLAPP-W1-005 — disposable benchmark hosting and reset in the NEW @clapp/benchmarks package.
Integrated commits: c6f4725 (worker, single commit on base bdc6fd5; bundle sha256 f5b9e3ea… verified, 13/13 per-file sha256s match) → merge + TL lockfile regeneration commit (the packages/clapp-benchmarks importer entry — exactly the worker's prediction, +8/−2 lines).
Tests: worker sandbox 266/265/1 (baseline 258/257/1, the documented browser artifact); TL env 254/252/2 — the same pre-existing file-level artifacts; W1-005 suite 8/8 standalone; typecheck 0; lint 0; build:server OK.
Acceptance: all 8 required named tests PASS (canonical validation incl. B01's deliberate repeated anchor for parity-diff stress and B02's store-rendered counter/status; deterministic loopback hosting; stateful round-trip + byte-identical reset; idempotent static reset; fake-seam workspace composition with path-ordered seeding; tombstone-respecting workspace reset; fail-closed validator; network-free content). Constitution verified: only packages/clapp-benchmarks/** + tests/clapp-w1-005-benchmarks.test.ts touched (+2586); lockfile left to the TL exactly as declared.
New risks: serve.js (the per-benchmark sandbox host) is manually verified cross-mode against the harness (constitution forbids process spawning in tests); route grammar is flat/nested lowercase (richer routing needs a contract revision).
Contract/ADR changes: none; BenchmarkApp/seam types live wholly in @clapp/benchmarks.
Next unblocked work: W3-004 (paired runner — B01/B02 ready as reference targets), W3-005 (repair — mutateState + PUT /api/ + visible-text surfaces ready), W1-002 observation composition, Phase 6 learning (two materially different archetypes per M6).

## 2026-09-28 — Wave 3 Lane 3 (CLAPP-W3-002) integrated

Date: 2026-09-28
Phase: Phase 4 (web synthesis, generator half) — wave 3 lane 3.
Work items: CLAPP-W3-002 — web candidate generator in @clapp/synthesis.
Integrated commits: 76ea771 (worker, single commit on base bdc6fd5; bundle sha256 b7f9347a… verified, 6/6 per-file sha256s match) → merge.
Tests: worker sandbox 266/265/1 (baseline 258/257/1, the documented browser artifact; the generated suite itself also passes 3/3 out-of-band); TL env 262/260/2 — the same pre-existing file-level artifacts; W3-002 suite 8/8 standalone; typecheck 0; lint 0; build:server OK; lockfile unchanged.
Acceptance: all 8 required named tests PASS (determinism incl. cross-process byte-stability; route→page+anchor mapping served over loopback; api endpoints serving seeded persistence with PUT updates; acceptance journeys as passing tests; fake-seam materialization with path-ordered seeding and composed build/test commands; plan purity; validator incl. the deny-only loopback-URL rule; empty-plan honest degradation). Constitution verified: only packages/clapp-synthesis/** + tests/clapp-w3-002-generator.test.ts touched.
New risks: the generated server.ts is deliberately plan-independent boilerplate (routes/persistence/api JSON + pages) — candidate differentiation lives in data, not server code, until the generator grows stack policies; npx tsx inside the candidate workspace relies on the repo-root toolchain availability (documented constraint).
Contract/ADR changes: none; the reconstructionId needed by seam calls is a materialization input (not smuggled through the plan) — clean.
Next unblocked work: W3-003 (generated acceptance suite deepening), W3-004 (paired runner — reference B01/B02 vs generated candidates), Phase 5 differential verification chain.

## 2026-09-28 — Wave 3 Lane 2 (CLAPP-W2-002) integrated — WAVE 3 COMPLETE

Date: 2026-09-28
Phase: Phase 3 (Behavioral IR, extraction half) — wave 3 lane 2; wave 3 now fully integrated.
Work items: CLAPP-W2-002 — evidence-to-IR extraction in @clapp/intelligence.
Integrated commits: adb4281 (worker, single commit on base bdc6fd5; bundle sha256 8b286ad8… verified, 3/3 per-file sha256s match) → merge.
Tests: worker battery as reported (their sandbox baseline + artifact class identical); TL env full-wave-3: 270/268/2 — the same pre-existing file-level artifacts; W2-002 suite 8/8 standalone; typecheck 0; lint 0; build:server OK; lockfile unchanged.
Acceptance: all 8 required named tests PASS (extracted IR validates under W2-001's validator; evidence refs carried verbatim; unavailable channels become assumptions never observations — ARCHITECTURE §6 upheld; determinism; purity; truncation recorded honestly; empty/partial bundles degrade honestly; engine model() now extracts). Constitution verified: only packages/clapp-intelligence/** + tests/clapp-w2-002-extract.test.ts touched.
New risks: extraction relies on the bundle's environment.entrypointRefs fingerprint for ref attribution (a bundle without it degrades to per-ref entrypoint parsing); screens/journeys are baseline-depth until W2-003's exploration.
Contract/ADR changes: none enacted.
Next unblocked work: W2-003 (deterministic exploration + journey model — deepens the baseline journeys), W2-004 (archetype classifier), the Phase 5 chain (W3-004 paired runner — benchmarks + candidates + IR all ready).

## 2026-09-28 — Wave 4 Lane 3 (CLAPP-W3-004) integrated

Date: 2026-09-28
Phase: Phase 5 (differential verification, runner half) — wave 4 lane 3.
Work items: CLAPP-W3-004 — reference/candidate paired runner in @clapp/synthesis.
Integrated commits: 8c62a84 (worker, single commit on base 8c55320; bundle sha256 c9f11835… verified) → merge.
Tests: TL env 278/276/2 — the same pre-existing file-level artifacts; W3-004 suite 8/8 standalone (incl. the real-benchmark-harness vs real-generated-candidate paired run); typecheck 0; lint 0; build:server OK; lockfile unchanged.
Acceptance: all 8 required named tests PASS (identical-sides equivalence + byte-determinism; anchor divergence detection with expected/actual inventories; state-transition divergence; blocked-verdict honesty on dead sides; deterministic suite aggregation; the REAL generated-candidate paired run; fail-closed structural binding + purity; transport facts kept out of the deterministic report). Constitution verified: only packages/clapp-synthesis/** + tests/clapp-w3-004-paired.test.ts touched; synthesis stayed decoupled from benchmarks via the PairedSide structural interface.
New risks: the DiffReport semantic dimension compares the ANCHOR contract (not full text equality) — by design until richer diff dimensions land (W3-005); one DELIVERY.md declared hash has a single-character transcription discrepancy for paired-compare.ts (declared …315… vs tree …325…) — the bundle sha256 and the other 3/4 file hashes match exactly; the git tree is the artifact of record and passed the full battery. Recorded honestly per the declaration-accuracy discipline.
Contract/ADR changes: none enacted.
Next unblocked work: W3-005 (semantic/visual/network/state diff dimensions on top of compareSidesSemantically), W3-006 (bounded repair), the M4 parity gate runs.

## 2026-09-28 — Wave 4 Lane 1 (CLAPP-W1-004) integrated

Date: 2026-09-28
Phase: Phase 1 final gate (run artifact/recovery semantics) — wave 4 lane 1.
Work items: CLAPP-W1-004 — ClappRunState/task-chain recovery in @clapp/runtime-openmuse.
Integrated commits: 15059f8 (worker, single commit on base 8c55320; bundle sha256 aa3ccef5… verified, 6/6 per-file sha256s match) → merge.
Tests: TL env 285/282/3 — the full intermittent artifact trio this run (browser, oauth, conversation-browser; all named subtests pass; run-to-run variance as documented); W1-004 suite 8/8 standalone incl. the M0 GATE test "kill/restart resumes from the last durable stage" over a REAL TaskWorker; typecheck 0; lint 0; build:server OK; lockfile unchanged.
Acceptance: run-state derivation from the task chain (malformed entries counted, never thrown); restart/pause/cancel/retry preserving stage state; deterministic restart planner with honest rationales; artifact ledger with per-stage attribution; stage-chain handler with successor planning that NEVER auto-creates tasks; the W1 conventions (clappStage key, event title vocabulary) now exported standardized consts.
New risks: none flagged beyond the W1-001 baseline set; run-level state derives purely from the task chain (no second store — by design).
Contract/ADR changes: none enacted.
Next unblocked work: server-side stage orchestration (the chain's planNextTask consumers), W3-005/W3-006 (repair loop over durable runs), Phase 6 learning over run artifacts.

## 2026-09-28 — Wave 4 Lane 2 (CLAPP-W2-003) integrated — WAVE 4 COMPLETE

Date: 2026-09-28
Phase: Phase 3 (exploration and journey model) — wave 4 lane 2; wave 4 now fully integrated.
Work items: CLAPP-W2-003 — deterministic exploration and journey model in @clapp/intelligence.
Integrated commits: 43841d4 (worker, single commit on base 8c55320; bundle sha256 b2e36ae7… verified, 3/3 per-file sha256s match) → merge.
Tests: TL env 293/291/2 — the same pre-existing file-level artifacts; W2-003 suite 8/8 standalone; typecheck 0; lint 0; build:server OK; lockfile unchanged.
Acceptance: all 8 required named tests PASS (determinism incl. seed tie-breaking semantics; journeys follow only observed links with unobserved targets as assumptions+deferred; assertions cite evidence and prove only text/url/title; honest budget truncation; composed IR validates and stays diffable with evidence refs untouched; purity; complete journey diff coverage; stable+sensitive feature digest).
New risks: exploration depth is bounded by the page-text evidence channel (link discovery from observed text — richer discovery waits for DOM-structure channels); journey tie-breaking is seed-controlled by design.
Contract/ADR changes: none enacted.
Next unblocked work: W2-004 (archetype classifier — exploration features now available), W3-005 (diff dimensions), W2-007 (retrieval/compat graph), server-side CLAPP orchestration.
