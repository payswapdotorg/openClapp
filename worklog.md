---
Task ID: CLAPP-W2-009
Agent: openClapp Worker CLAPP-W2-009
Task: CLAPP-W2-009 — @clapp/intelligence: continuous-learning benchmarks (Wave 8, Lane 2). Learning build records + the M6 steps 4-6 comparison report over the LEARNING.md eight-signal vocabulary, with honest abstention, clock-free build time (build-steps proxy), caller-supplied repair counts, acceptance-integrity guard, content-addressed clapp_learning_ ids, and fail-closed validation.

Work Log:
- Verified base 990c9485c118a7b7539925738a8f1574884ef6c1 (wave integration HEAD) on a fresh clone; Node v24.21.0 / pnpm 11.19.0; pnpm install --frozen-lockfile clean.
- Baseline battery: typecheck 0 errors; biome lint clean (213 files); tests 370/369 pass/1 fail (tests/browser.test.ts — the documented pre-existing file-level artifact; oauth passed on this checkout).
- Recon: docs/clapp/LEARNING.md, docs/clapp/CONTRACTS.md (confirmed clapp_learning_ NOT in "Core identifiers"), packages/clapp-intelligence src (index.ts, extract-package.ts, retrieval.ts, package-registry.ts, package-store.ts, json.ts), tests/clapp-w2-006-extract.test.ts, tests/clapp-w2-007-retrieval.test.ts.
- Added packages/clapp-intelligence/src/learning-benchmark.ts: LearningBuildRecord (caller-supplied structural counts; no wall-clock input), buildLearningComparison(from, to) -> LearningComparisonReport (exactly 8 rows in LEARNING.md order, available/unavailable per row, digest, acceptanceIntegrity, no aggregate score), LearningRecordError (collected issues, fail-closed), LEARNING_REPORT_ID_PREFIX / LEARNING_SIGNAL_IDS constants.
- Honest abstentions implemented: build-time row unavailable (clock-free package) with the deterministic build-steps proxy (from/to values); failure-recurrence row unavailable naming the W2-008 failure-memory dependency as not a declared dependency / not composed; unmeasured tests/parity and blocked parity unavailable with recorded reasons, never fabricated.
- Acceptance guard: when either record declares acceptanceWeakened, available rows whose derived direction is "improved" abstain with a recorded reason (LEARNING.md: improvement only without weakened acceptance); measured worsening/unchanged stay visible; report-level acceptanceIntegrity declares the weakening.
- Content-addressed ids: clapp_learning_ + 16-hex sha256 of canonical JSON of the report core (the W2-006 discipline); canonical records sort package-id arrays so input array order never leaks.
- Added the additive // CLAPP-W2-009 export block to packages/clapp-intelligence/src/index.ts (existing exports untouched; W2-008 block untouched).
- Added tests/clapp-w2-009-learning.test.ts: the 8 named acceptance tests, including the M6 steps 4-6 integration seam composing the REAL W2-005 registry, W2-006 extraction and W2-007 retrieval over the B02 loopback harness.
- Results: own file 8/8 pass; typecheck 0 errors; biome lint clean (215 files); full battery 378 tests / 377 pass / 1 fail (the same documented tests/browser.test.ts artifact — zero new failures).
- Staged the delivery at /home/z/my-project/delivery/CLAPP-W2-009/ (git bundle 990c9485..work-head + DELIVERY.md with SHAs and hashes) and committed the staging copies on the branch.

Stage Summary:
- CLAPP-W2-009 delivered on branch clapp-w2-009: the learning-benchmark module that MEASURES whether CLAPP learns (M6 steps 4-6), all 8 named acceptance tests green, zero new battery failures.
- Key decision: the failure-recurrence row abstains because W2-008 is not a declared dependency of this benchmark and is not composed into it — NOTE: at this base W2-008 HAS landed in the repo (commits d8bf1d7/10bddd2/990c948), contrary to the work item's premise "it has NOT landed at your base"; per the binding instruction the module still does not import/compose/reference it, and the abstention reason is worded honestly (not-composed) rather than "un-landed".
- Key decision: acceptance-weakening guard flips would-be-improved rows to unavailable (never an improvement under weakened criteria) while keeping honest worsening/unchanged visible.
- Contract/ADR note: clapp_learning_ prefix proposed for CONTRACTS.md "Core identifiers" (tech-lead-owned; NOT edited by this worker).
