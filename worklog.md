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

---
Task ID: CLAPP-W3-003
Agent: openClapp Worker CLAPP-W3-003
Task: CLAPP-W3-003 — generated acceptance suite (Wave 8, Lane 3): deepen the generated acceptance suite in packages/clapp-synthesis without regressing a single W3-002 pin.

Work Log:
- Verified base: the dispatch SHA 0be35fdc915a25f74196828ba2fbae05bf7fa38a exists in the clone as an ancestor of the default HEAD bd3b983 (2 commits forward); checked out the exact specified SHA before branching clapp-w3-003 and recorded the deviation honestly.
- Baseline battery (once, at base): 378 tests / 378 pass / 0 fail — the documented browser+oauth file-level artifacts did not reproduce in this sandbox.
- Recon: generator.ts, emit-web.ts, materialize.ts, plan.ts, app-validate.ts, index.ts, tests/clapp-w3-002-generator.test.ts (the frozen contract), plus validate.ts / hash.ts (load-bearing for the fail-closed digest).
- Deepened emitJourneysTest (emit-web.ts) additively: input gains `routes: WebRouteEntry[]`; new ROUTE_ANCHORS constant keyed by route path (unique per route, so duplicate journeyIds can never collapse anchors); one additive `test("route coverage: <journeyId>")` per non-acceptance plan route asserting 200 + text/html + data-journey + route name + data-step-count + index 200 + API round-trip. Every pre-existing emitted line is untouched; step counts stay plan-derived; no step-action vocabulary is emitted.
- generator.ts passes the full webRoutes list into emitJourneysTest (one additive call-site change; manifest, commands, file set shapes unchanged).
- New packages/clapp-synthesis/src/coverage.ts: pure `digestSuiteCoverage({ plan, app })` reporting per plan journey covered/not-covered with recorded reasons (acceptance selection read from plan.acceptanceJourneyIds, never sniffed from the suite; index verdict + totals), fail-closed on malformed pairings with ONE TypeError collecting every error (missing suite file, planDigest/routeCount/acceptance-selection disagreement, tampered routes.json entries, wrong component/page counts).
- index.ts: additive CLAPP-W3-003 export block (digestSuiteCoverage, JourneyCoverage, SuiteCoverageDigest, SUITE_FILE_NAME, INDEX_ROUTE_TEST_NAME, ACCEPTANCE_JOURNEY_TEST_PREFIX, ROUTE_COVERAGE_TEST_PREFIX).
- tests/clapp-w3-003-acceptance.test.ts: the 8 named deterministic acceptance tests (node:test + node:assert/strict; loopback-only; child spawns strip NODE_TEST_* so nested runners report honestly).
- Evidence: diff of base-emitter vs deepened-emitter output over the same plan — every file except journeys.test.ts byte-identical (sha256-verified); journeys.test.ts diff is pure additions (89 -> 116 lines), no line changed or removed.
- Verification: typecheck 0 errors; lint 0 errors; my 8/8 green; frozen W3-002 suite 8/8 green unmodified; full battery 386 tests / 386 pass / 0 fail.

Stage Summary:
- CLAPP-W3-003 delivered on branch clapp-w3-003: the generated acceptance suite now pins every plan route (counts and anchors only, never invented step actions) with an honest coverage digest and fail-closed malformed-input handling, while every W3-002 pin holds byte-for-byte (strict superset proven at file level).
- Key decision: route-coverage anchors are keyed by route path, not journeyId, so pathological duplicate journeyIds across plan routes can never collapse two routes' anchors; the digest reports such duplicate-carried routes honestly as not-covered.
- Key decision: the honest not-covered case is demonstrated against a structurally-valid W3-002-era suite (route coverage tests stripped) — the digest reports the gap with a recorded reason instead of failing or fabricating coverage.
- Known pinned behavior kept: the frozen W3-002 server.ts CLAPP_CANDIDATE_PORT env read stays (removing it would regress a pin); the deepening adds zero new environment reads or timestamps.
- Base deviation (honest): clone HEAD was bd3b983, 2 commits after the specified wave-8 integration HEAD; built on the exact specified SHA 0be35fd (verified ancestor).
- Battery totals: baseline 378/378/0; after delivery 386/386/0; zero new failures; tests/clapp-w3-002-generator.test.ts unmodified and green.
