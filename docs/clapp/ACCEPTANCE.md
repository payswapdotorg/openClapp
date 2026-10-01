# CLAPP Acceptance Gates

## Global gate

Every CLAPP integration must pass:
- `pnpm install --frozen-lockfile`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm build:server`
- existing browser/container/computer tests applicable to the change.

## M0 — Durable reconstruction task

Given a fixture target:
1. create a reconstruction;
2. observe task status;
3. restart worker/server;
4. resume;
5. finish with durable artifacts.

PASS requires no duplicate stage execution that causes inconsistent artifacts.
Target authorization persists with content-addressed `clapp_authz_` ids
(prefix + 16-hex sha256; ADR-003).

## M1 — Evidence

Reference run must include:
- DOM/a11y;
- screenshot;
- network;
- console/runtime;
- storage;
- static inventory where available.

Each artifact must have a hash and provenance.

## M2 — Behavioral model

Every major route/state/transition must:
- be validated;
- cite evidence;
- preserve uncertainty.

Unknown must remain unknown.

## M3 — Synthesis

Candidate must:
- build from clean checkout;
- run with the declared environment;
- expose all selected benchmark routes;
- execute canonical journeys.

## M4 — Differential parity

Same journey runs against reference and candidate.

Minimum report dimensions:
- semantic;
- visual;
- network;
- state/storage.

Reports must be deterministic enough for regression tracking.

## M5 — Repair

Seed at least:
- visible-text mutation;
- interaction/test-id mutation;
- network/mock mutation;
- state/storage mutation.

Repair loop must:
- repair boundedly;
- re-run verification;
- stop on convergence;
- abstain honestly when the defect is not derivable.

## M6 — Learning

For at least two materially different benchmark apps:
1. build independently;
2. extract package candidate(s);
3. promote verified package(s);
4. build a second app that matches a prior archetype;
5. reuse packages;
6. compare new-code, repair iterations, build time and package reuse.
7. every promotion/evaluation decision carries a content-addressed
   `clapp_eval_` id (prefix + 16-hex sha256; ADR-003).

Do not reduce results to one score.

## M7 — UX

A first-time user must be able to:
- define target;
- see authorization scope;
- start reconstruction;
- watch progress;
- inspect browser/computer;
- inspect evidence;
- inspect model;
- inspect parity;
- review repairs;
- pause/resume/cancel;
- export candidate and report.

## M8 — Native readiness

A platform adapter is accepted only when it provides:
- observation;
- execution;
- evidence;
- synthesis;
- verification;
with the same CLAPP contracts.

## Failure semantics

A test passes only when the documented behavior occurs. Do not turn unsupported functionality into fake success.
