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

## 2026-09-28 — Wave 5 Lane 3 (CLAPP-W3-005) integrated

Date: 2026-09-28
Phase: Phase 5 (differential verification, dimensions half) — wave 5 lane 3.
Work items: CLAPP-W3-005 — semantic/visual/network/state diff in @clapp/synthesis (the M4 minimum report dimensions completed on the W3-004 capture/compare seam).
Integrated commits: single worker commit on base c2358ac (branch clapp-w3-005; per-file sha256 manifest + bundle sha256 declared in the staged delivery's DELIVERY.md, project root delivery/CLAPP-W3-005/).
Tests: W3-005 suite 8/8 standalone (identical-sides four-dimension equivalence + byte-determinism; seeded visual divergence with exact inventories; seeded network divergence incl. redirects; honest dimension gating; the REAL generated-candidate four-dimension diff; purity + fail-closed dimension normalization; deterministic four-bucket suite aggregation; clock/transport-noise exclusion through the REAL Date-bearing responses). W3-004 suite 8/8 after the two documented expectation supersessions below. Root + mobile typecheck 0; biome lint 0; build:server OK; lockfile unchanged (frozen install verified clean).
Acceptance: every M4 minimum dimension now lands in one deterministic, content-addressed DiffReport — semantic + state (W3-004, unchanged) plus visual (derived visual inventory of the served HTML: title, headings, images, links, controls, skeleton digest; a pure tolerant scanner, never a claimed screenshot) and network (redirect facts + a frozen allowlist of protocol headers; clock/body-derived/hop-by-hop headers excluded by design). Dimension flags are fail-closed normalized with honest-absence semantics (no capture, no findings, no artifacts). Content-addressed identity deduplication collapses the page/API channel overlap of the same route. The suite aggregate buckets all four dimensions; serializers unchanged in shape.
New risks: the visual channel is a derived structural inventory, not pixel parity — screenshot/pixel comparison remains future work (browser-evidence channel); the network allowlist intentionally excludes `expires`/`date`/`age` (wall-clock) so a candidate whose ONLY divergence is a clock header would report equivalent across the network dimension — documented and honest; storage remains folded into the state dimension until durable storage channels exist (W3-006+ can split it).
Contract/ADR changes: none enacted — DiffDimension "visual"/"network" and ReconstructionSpec.verification.{visual,network} were already frozen in contracts v0.1; @clapp/synthesis implements against them unchanged.
W3-004 test supersessions (documented in-file, strengthened not weakened): (1) the anchor-divergence test now pins exactly FOUR findings — the semantic anchor gap plus the two visual heading keys and the skeleton catch-all that the mutated h1 genuinely produces; (2) the REAL generated-candidate test now asserts no state/no network findings and names the visual title/heading/skeleton findings instead of restricting every finding to the semantic dimension. Both were pinned at the W3-004 four-dimension boundary ("by design until richer diff dimensions land (W3-005)" — W3-004 wave record).
Next unblocked work: W3-006 (bounded autonomous repair — the skeleton catch-all and per-channel anchors are its visible-text/interaction/network mutation signals), M4 parity gate runs over both canonical benchmarks, server-side verification orchestration (spec.verification.{visual,network} policy flags feed the runner's dimensions input).

## 2026-09-28 — Wave 5 Lane 2 (CLAPP-W2-004) integrated

Date: 2026-09-28
Phase: Phase 6 (learning/archetype foundations) — wave 5 lane 2.
Work items: CLAPP-W2-004 — archetype classifier (packages/clapp-intelligence: deterministic rules+scoring classification over the frozen 11-label Phase 7 vocabulary, evidence-cited confidence caps for sparse IRs, B01/B02 calibration).
Dispatch note: the original clapp-w2-004 chat turned PHANTOM after its verified dispatch (chats-detail 500 + absent from the list); re-dispatched fresh as clapp-w2-004b with the identical prompt (insert 100%, sent verified) — the wave-1 phantom rescue pattern.
Integrated commits: worker branch clapp-w2-004 head 0e72d74 on base c2358ac (git bundle sha256 49ad0d93… verified EXACT; 3/3 per-file sha256s verified: archetype.ts, index.ts, tests/clapp-w2-004-archetype.test.ts).
Tests: 8/8 named tests (B01-like → marketing/content with the sparse cap; B02-like → CRUD SaaS at 0.95 with record-grounded citations; determinism; sparse-evidence confidence cap; honest unknown; pure+cited feature extraction; engine classify() composition; closed documented vocabulary). TL battery on merged main: typecheck 0, lint 0 (197 files), build:server OK, full suite 310/308/2 (the 2 pre-existing file-level browser/oauth artifacts, identical at base), wave-5 suites standalone 16/16.
Acceptance: the classifier composes the W2-002 IR + W2-003 exploration into a deterministic 11-label verdict with an honesty-first confidence model — sparse dimensions cap confidence below 0.6, channel-less archetypes discount, absence is neutral-never-positive, every rationale cites the feature counts and the sparse dimensions that lowered it. The ONE scaffold surface change (createIntelligenceEngine().classify()) is flagged and delegates to classifyFromIr; model()/explore() untouched.
New risks: apiSignals bounded 0-2 (frozen v0.1 IR carries no endpoint inventory — "API-heavy" cannot separate from "api-present" this wave); realtime/editor/file/PWA/auth/marketplace/workflow archetypes stay channel-discounted until the observation stack emits their evidence kinds (rankable, confidence-bounded — honest, not a wiring gap); real wave-3 IRs (null textChars, digest-only) classify capped or unknown by design (calibration targets the content-bearing conventions).
Contract/ADR changes: none blocking. Optional proposals recorded not enacted: (a) textHeavy/apiSignals from observed values instead of conventions (already proposed by W2-002/W2-003 assumption records); (b) a per-dimension "observed-empty" marker distinguishing absence from not-captured without string-matching assumption reasons.
Next unblocked work: W2-006 (package extraction/promotion — parity success now available), W2-007 (retrieval/compatibility graph), W2-008 (failure memory — parity findings now available), W3-006 (bounded autonomous repair).

## 2026-09-28 — Wave 5 Lane 1 (CLAPP-W1-007) integrated — WAVE 5 CLOSED

Date: 2026-09-28
Phase: Phase 7 (server orchestration — the CLAPP repositories roadmap item) — wave 5 lane 1.
Work items: CLAPP-W1-007 — server-side CLAPP orchestration (apps/server/src/clapp/*: repositories/service with create/advance/status/control/list, worker handler wrapping the substrate chain with the W1-001 CLAPP handler + skeleton stage executor, thin owner-scoped routes, minimal additive app.ts wiring; the M0 end-to-end loop test).
Dispatch note: the original clapp-w1-007 chat queue-starved 2.5h with a stale pod (sends swallowed server-null-commit); void + pod release + fresh re-dispatch clapp-w1-007b — generation started IMMEDIATELY (the wave-1 lesson) and completed in ~35 min.
Integrated commits: worker branch clapp-w1-007 head f8f93b7 on base c2358ac (bundle sha256 b0b5f5a3… verified EXACT; 6/6 per-file sha256s verified).
Tests: 8/8 named tests (validation fail-closed; create persists + starts the first stage task; stage runs durably and advances; run status aggregates the chain; control delegates to the current stage; non-clapp tasks flow through unchanged; routes thin and owner-scoped; the FULL M0 loop). Worker also ran a REAL-server process smoke over HTTP (auth 401/201/precise 422/durable advance/idempotent re-advance/status aggregation with real content-addressed artifacts/signed artifact serving without auth header/substrate finance-task passthrough). TL battery on merged main: typecheck 0, lint 0 (202 files), build:server OK, full suite 319/317/2 (the 2 pre-existing file-level browser/oauth artifacts).
Acceptance: the CLAPP stack is now DRIVABLE from OpenMuse — create a reconstruction through /api/clapp, the wrapped worker runs stages durably through the substrate chain, status aggregates the chain with artifacts, control actions delegate to the current stage; non-clapp tasks flow through unchanged (the wrapped-handler fallback is the extracted substrate handler).
New risks: the skeleton stage executor is a placeholder seam for capture/explore/model/plan/synthesize/verify/repair/review/promote (the stage vocabulary CLAPP_SERVER_STAGES) — real stage executors compose as they land; the .env DATABASE_URL is environment-local (git-ignored, not delivered); apps/server compiles as part of the root openmuse package by relative source import (no workspace dependency entry — the app.ts convention).
Contract/ADR changes: none.
Next unblocked work: WAVE 6 — W3-006 (bounded autonomous repair), W2-006 (package extraction/promotion); then W2-007 (retrieval/compat graph), W2-008 (failure memory), W3-007 (UX surfaces — API/events now stable).

## 2026-09-28 — Wave 6 Lane 2 (CLAPP-W2-006) integrated

Date: 2026-09-28
Phase: Phase 6 (M6 learning steps 1-3) — wave 6 lane 2.
Work items: CLAPP-W2-006 — package extraction & promotion (packages/clapp-intelligence/src/extract-package.ts: structural ReconstructionArtifacts input, extractPackageCandidates/registerCandidates/promoteVerified/extractionSummary).
Integrated commits: worker branch clapp-w2-006 head c9f7b23 on base 493bbd1 (bundle sha256 f2eaef2e… verified EXACT; 3/3 per-file sha256s verified).
Tests: 8/8 named tests (schema-valid extraction; unverified-parity abstention; evidence-gated promotion; idempotent registration; deterministic+cited extraction; honest archetype category; empty-inventory abstention; the end-to-end M6 steps 1-3 seam over the REAL B02 harness — two independent instances). TL battery on merged main: typecheck 0, lint 0 (204 files), build:server OK, full suite 326/324/2 (the 2 pre-existing file-level artifacts), W2-006 suite 8/8 standalone.
Acceptance: M6 steps 1-3 now close end-to-end — a successful reconstruction's structural artifacts extract into frozen-schema-valid package candidates, register idempotently through the W2-005 registry, and ONLY parity-verified evidence (verdict equivalent + real verificationRunId) promotes; everything unverified abstains with recorded reasons (fail-closed, never fabricated).
New risks: extraction emits tests: [] (the frozen JSON schema vs TS interface tests mismatch — W2-005's documented known gap; empty satisfies both); the generic category fallback (GENERIC_PACKAGE_CATEGORY) covers absent archetypes honestly; package reuse measurement (M6 steps 4-6) waits on W2-007 retrieval.
Contract/ADR changes: none.
Next unblocked work: W2-007 (retrieval/compatibility graph), W2-008 (failure memory), W2-009 (continuous-learning benchmarks, partial).

## 2026-09-28 — Wave 6 Lane 1 (CLAPP-W3-006) integrated — WAVE 6 CLOSED

Date: 2026-09-28
Phase: Phase 5 (M5 repair) — wave 6 lane 1.
Work items: CLAPP-W3-006 — bounded autonomous repair (packages/clapp-synthesis/src/repair.ts: classifyRepairActions/applyRepairActions/runRepairLoop/summarizeRepair; the M5 mutation classes over plan inputs).
Dispatch note: SEVEN dispatches — the platform's agent-turn infrastructure degraded after ~07:30 UTC (six consecutive mid-flight turn deaths, all mid-tool-execution, pod Running, sends swallowed). The exploration-lite r2 prompt revision (embedded key surfaces, ~15-tool-call recon budget, baseline-battery-once discipline) got the winning run from setup to writing in 8 minutes; it completed in 38 minutes once the platform window improved.
Integrated commits: worker branch clapp-w3-006 head f5cbb25 on base 493bbd1 (bundle sha256 d2f40a31… verified EXACT; 3/3 per-file sha256s verified: repair.ts, index.ts additive block, 8-test file).
Tests: 8/8 named tests (visible-text repair to convergence; network-mock repair; state-storage repair; absolute budget; stagnation stop; honest abstention; purity of apply; byte-identical reports). TL battery on merged main: typecheck 0, lint 0 (206 files), build:server OK, full suite 335/333/2 (the 2 pre-existing file-level artifacts), W3-006 suite 8/8 standalone.
Acceptance: the repair loop consumes W3-005's DiffFinding feed, maps findings to bounded plan-input mutations per the M5 classes, resolves reference-sourced replacements by probing the LIVE reference (GET per api path + snapshotState once — never fabricated), re-materializes and re-verifies through the paired runner, and stops on convergence/stagnation/budget — with honest abstention for every non-derivable finding (skeleton digest, manual repairability, unstructured anchors: links/images/controls/headers/redirects/content-type/route topology).
New risks: reference-probe resolution assumes the reference side's api GETs and snapshotState are stable during the loop (true for the in-process benchmarks; server-orchestrated references should snapshot once); the repair mutates PLAN inputs only (never generated code) — repairs needing structural template changes abstain honestly.
Contract/ADR changes: none.
Next unblocked work: WAVE 7 — W2-007 (retrieval/compat graph), W3-007 (UX surfaces — prompts authored); then W2-008 (failure memory), W2-009, W3-003/W3-008.

## 2026-09-28 — Wave 7 Lane 1 (CLAPP-W2-007) integrated

Date: 2026-09-28
Phase: Phase 6 (M6 step 5 — the package-reuse feed) — wave 7 lane 1.
Work items: CLAPP-W2-007 — package retrieval & compatibility graph (packages/clapp-intelligence/src/retrieval.ts: buildCompatGraph/retrievePackages/explainCompatibility/retrievalSummary).
Dispatch note: 2nd dispatch — the first died at the baseline battery in a closed platform window; a lesson-105 Chrome restart cleared the CDP WebSocket strain and the re-dispatch ran clean (setup→writing in ~15 min, complete in ~33 min).
Integrated commits: worker branch clapp-w2-007 head 5d8709a on base 397a3c7 (bundle sha256 bd484fb5… verified EXACT; 3/3 per-file sha256s verified).
Tests: 8/8 named tests (graph pure+deterministic; edges carry derivation reasons; fail-closed filters; deterministic explained ranking; honest unknown capabilities; lineage neighbors visible; real-registry integration; exact accounting). TL battery on merged main: typecheck 0, lint 0 (208 files), build:server OK, full suite 342/341/1 (the 1 pre-existing file-level artifact), W2-007 suite 8/8 standalone.
Acceptance: retrieval over a populated registry is deterministic, explained, fail-closed; the compatibility graph is a pure derived function of registry contents (category/capability/target/lineage edges with reasons); the M6 "reuse packages" feed composes extraction (W2-006) + graph + ranked retrieval end-to-end.
New risks: compatibility is derived from declared metadata only (category/capabilities/targets) — semantic compatibility (actual interface fit) waits for richer package interface contracts; ranking weights are the documented defaults (deterministic, revisitable).
Contract/ADR changes: none.
Next unblocked work: W3-007 (UX surfaces — in flight), W2-008 (failure memory), W2-009 (continuous-learning benchmarks).

## 2026-09-29 — TL resident note: post-reset W3-007e re-dispatch armed

Sandbox reset #2 (12:04 UTC) fully recovered: operator JWT re-captured (14:30),
byte-exact W3-007 prompt extracted from landed chat 3364489b and re-based to
main 0c3aae6 (battery 342/341/1). Immortality ring re-armed 14:34:57
(clapp-w3-007e; sentinel round 1 landed chat ab6bbbe8 but the capacity gate
is still closed — strain now ~25.5h continuous). Ring grinds autonomously;
next: marker → harvest → battery → review → merge --no-ff. W2-008 prompt
staged for serial dispatch after W3-007 lands.

## 2026-09-29 — TL resident note: sentinel multi-chat adoption patch; strain deepens

Ring update: adoption probe now scans ALL staged chats (not just the last).
Degradation note: since ~16:55 the platform rejects chat creation outright
(strain >29h continuous). ROADMAP under-ticks corrected (fdbfd9a):
registry/versioning + compatibility graph ticked. Ring grinds; next landing
triggers harvest → battery → review → merge.

## 2026-09-29 — W3-007 worker LIVE (chat 72ee147c)

The ~31h capacity strain broke ~18:55; the patched multi-chat adoption probe
caught round-4 chat 72ee147c generating at 18:59 (the last-registered chat was
round 6's — the old probe would have missed it). Marker written; completion
watch armed 19:00:57. Worker on the re-based prompt (base 0c3aae6, battery
342/341/1). Harvest follows the completion report.

## 2026-09-29 — Wave 7 Lane 2 (CLAPP-W3-007) integrated — WAVE 7 COMPLETE

Date: 2026-09-29
Phase: Phase 8 (product hardening — CLAPP UX surfaces) — wave 7 lane 2; wave 7 now fully integrated.
Work items: CLAPP-W3-007 — CLAPP UX surfaces (apps/mobile/src/clapp-view-models.ts: pure deterministic view-models — reconstructionListFrom / stageChainFrom / controlActionsFor / artifactLinksFrom / clappCreateRequestFrom / refreshPolicyFrom / advanceStateFrom / clappErrorText; apps/mobile/src/clapp-screens.tsx: ClappScreen navigator + list/create/detail surfaces over /api/clapp).
Dispatch note: FIVE dispatch generations under the longest capacity strain on record (~31h continuous, Sep 28 13:00 → Sep 29 ~18:55). The winning chat (72ee147c, round 4) landed in a brief window at 18:24, fired at ~18:55, and was caught by the sentinel's NEW multi-chat adoption probe (patched this session — probes ALL staged chats, not just the last registered; the last-registered chat was round 6's, so the old probe would have missed the worker). Worker completed the full run in ~35 minutes once fired.
Integrated commits: worker branch clapp-w3-007 head 563ce4a on base 0c3aae6 (bundle sha256 b477eac8… verified EXACT; 7/7 per-file sha256s verified: clapp-view-models.ts, clapp-screens.tsx, clapp-w3-007-ux.test.ts NEW; screens.tsx +11, workspace.tsx +1, details.tsx +2, agent-ui.tsx +8 additive).
Tests: 8/8 named tests (list view-model determinism; stage-chain honest status mapping incl. unreported→not_started and foreign→unknown; control actions from stage statuses incl. paused-runs and terminal refusals; artifact links only with signed contentUrls; create request body matches the frozen API contract; explicit polling policy; failure surfaces server messages verbatim; purity — byte-identical outputs). TL battery on merged main: typecheck 0, lint 0 (211 files), build:server OK, full suite 350/348/2 (the 2 pre-existing file-level artifacts — the exact same set at base 0c3aae6: 342/340/2; zero new failures; +8 new tests all passing), W3-007 suite 8/8 standalone.
Acceptance: the app's Apps screen reaches the CLAPP surfaces (additive LinkRow); list/create/detail render exactly what the /api/clapp routes report — the frozen ten-stage chain, honest unreported/unknown/foreign-stage handling, control actions gated by the server's own refusal rules, artifacts opened only by their signed contentUrls, refresh polling explicit (4s active / manual terminal), every action followed by a real re-fetch; the create form emits the exact strict ReconstructionSpec the server's zod validates.
New risks: the wire interfaces restate the API shapes locally (the routes are not exported from apps/server for type-sharing — a cross-package contracts extraction is a future refinement); polling interval is fixed at 4000ms (no backoff); no list-level pagination yet.
Contract/ADR changes: none.
Next unblocked work: W2-008 (failure memory), W2-009 (continuous-learning benchmarks), W3-003 (generated acceptance suite) — wave 8.

## 2026-09-29 — Wave 8 Lane 1 (CLAPP-W2-008) integrated

Date: 2026-09-29
Phase: Phase 6 (M6 failure memory — the "what broke and how it was fixed" layer) — wave 8 lane 1.
Work items: CLAPP-W2-008 — failure memory and repair-pattern learning (packages/clapp-intelligence/src/failure-memory.ts: buildFailureMemoryRecord / aggregateRepairPatterns / suggestRepairHints / countFailureRecurrence / failureMemoryDigest; REPAIR_PATTERN_EVIDENCE_MINIMUM=2; FAILURE_MEMORY_ID_PREFIX="clapp_learning_").
Dispatch note: 10 packet-landed rounds under the reopened capacity gate; round 9's chat (03ccc03a) fired at 21:56 and was adopted by the multi-chat probe. The worker turn died mid-run at its test-bug fixes ("Fixing:") under platform strain; a continuation nudge revived the session with full context ~15 min later — the worker completed honestly (disclosed the interrupted half-finished work, line-by-line reviewed it, fixed 3 test-side bugs). One further nudge corrected the delivery staging path (clone-root delivery/ is outside the harvest API's my-project root).
Integrated commits: worker branch clapp-w2-008 head d8bf1d7 on base b4038c8 (bundle sha256 ef20293c… verified EXACT; 3/3 per-file sha256s verified: failure-memory.ts NEW, index.ts +36 additive exports, 8-test file NEW).
Tests: 8/8 named tests (content-addressed determinism; nothing-to-remember abstention; evidence minimum respected; pure order-independent aggregation; hints never fabricate; recurrence from records only; the structural mirror composes real W3-006 RepairReport + frozen v0.1 DiffFinding without imports; empty/malformed memory degrades honestly). TL battery on merged main: typecheck 0, lint 0 (213 files), build:server OK, full suite 359/358/1 (the 1 pre-existing browser file-level artifact; run-to-run variance documented), W2-008 suite 8/8 standalone.
Acceptance: a finished W3-006 repair outcome + its parity findings distill into a content-addressed clapp_learning_ record (canonical core, sorted keys); corroborated records (>=2) aggregate into repair patterns; patterns suggest hints ONLY for matching finding signatures — honest attribution requires single-mutation-class converged loops; stored records re-validated on every read (id must equal sha256 of the canonical core, shape must match the builder's, malformed records fail closed as typed errors); recurrence counted from records only.
New risks: pattern attribution only covers single-class successes (multi-class loops count recurrence but corroborate nothing — honest, revisitable when W3-006 reports per-finding classes); 16-hex id digest has the same theoretical collision discipline as ra-/rr- ids; no persistence yet (records in-memory until the integration wave lands a narrow store port, the W2-005 discipline).
Contract/ADR changes: none enacted; the clapp_learning_ prefix is proposed for the Core identifiers list (frozen v0.1 revision — tech-lead-owned, pending).
Next unblocked work: W2-009 (continuous-learning benchmarks — failure memory now available), W3-003 (generated acceptance suite), then promotion/evaluation and the store-port integration wave.

## 2026-09-30 — Wave 8 Lane 2 (CLAPP-W2-009) integrated

Date: 2026-09-30
Phase: Phase 6 (M6 steps 4-6 — the does-CLAPP-learn measurement) — wave 8 lane 2.
Work items: CLAPP-W2-009 — continuous-learning benchmarks (packages/clapp-intelligence/src/learning-benchmark.ts: buildLearningComparison / LearningRecordError / LEARNING_SIGNAL_IDS / LEARNING_REPORT_ID_PREFIX; the 8-signal comparison report over LEARNING.md's vocabulary).
Dispatch note: 9 packet-landed rounds; round 7's chat (327e4ff0) fired ~35 min after landing and was adopted by the multi-chat probe (3rd adoption save tonight). Completed in one uninterrupted turn (~40 min). The pre-dispatch staging-path fix worked — the delivery landed directly at the my-project harvest root (no correction nudge needed).
Integrated commits: worker branch clapp-w2-009 heads aa6226e+93170e9 on base 990c948 (bundle sha256 33efce60… verified EXACT; 4/4 per-file sha256s verified: learning-benchmark.ts NEW 788 lines, index.ts +27 additive, 8-test file NEW, repo worklog.md NEW).
Tests: 8/8 named tests (vocabulary-exact coverage; build-time honest abstention with deterministic proxy; reuse improves only on evidence; unmeasured signals unavailable never fabricated; pure deterministic function; malformed records fail closed; the M6 seam composes REAL extraction→registry→promotion→retrieval; repair iterations caller-supplied). TL battery on merged main: typecheck 0, lint 0 (215 files), build:server OK, full suite 367/365/2 (browser+oauth — identical file set failing at base; zero new failures), W2-009 suite 8/8 standalone.
Acceptance: one row per LEARNING.md signal in vocabulary order (no aggregate score); available rows carry measured from/to/delta/direction; unavailable rows carry recorded reasons; the acceptance-integrity guard withholds would-be improvement under weakened acceptance while honest worsening/unchanged stay visible; ids content-addressed clapp_learning_+16-hex; report pure and byte-identical across runs.
Honest findings (worker-reported, verified): the work-item premise said W2-008 "has not landed" but it HAD at the dispatched base (serial dispatch order) — the worker abstained the failure-recurrence row with the TRUE state reason instead of the false premise, exactly right.
New risks: one (from,to) pair per report (the repeated sequence is caller-orchestrated by design); reuse/rejection rows are structural id counts (ratio semantics is a future contract decision); the acceptance-weakened guard is deliberately conservative.
Contract/ADR changes: none enacted; the clapp_learning_ prefix revision proposal is now recorded by BOTH W2-008 and W2-009 (dedupe at the contract-revision wave).
Next unblocked work: W3-003 (generated acceptance suite — wave 8 lane 3, prompt ready), then promotion/evaluation, the repeated-build orchestration + composition planner (archetype factory), and the clapp_learning_ contract revision.
