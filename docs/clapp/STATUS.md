# CLAPP Verified Status

Audit date: 2026-09-27

Repository: `payswapdotorg/openClapp`

Base OpenMuse snapshot audited: `34b15bc80340e582fb8c25573646cfb0bbc5184d`.

## Verified OpenMuse substrate

The inherited repository already provides:
- durable AgentService and TaskWorker;
- SQL lease/checkpoint/recovery behavior;
- browser session service and Playwright worker;
- persistent Chromium sessions;
- Linux Docker computer/workspace;
- generic files/artifacts;
- owner/auth boundary;
- OpenMuse web/iOS/Android shell;
- CI/test infrastructure.

Primary source locations:
- `apps/server/src/engine/worker.ts`
- `apps/server/src/engine/service.ts`
- `apps/server/src/browser.ts`
- `apps/worker/src/browser.ts`
- `apps/server/src/computer.ts`
- `apps/computer`
- `apps/mobile`
- `packages/domain`

## CLAPP scaffold now present

Repository-level CLAPP architecture has been added.

Present:
- `AGENTS.md`
- `CLAPP.md`
- `docs/clapp/*`
- `schemas/clapp/*`
- `packages/clapp-contracts`
- `packages/clapp-runtime-openmuse`
- `packages/clapp-observation`
- `packages/clapp-intelligence`
- `packages/clapp-synthesis`

The canonical CLAPP TypeScript contract is currently declared in:
`packages/clapp-contracts/src/index.ts`

The runtime/observation/intelligence/synthesis packages are intentionally scaffolds. Their TODO/throwing paths are expected until workers implement the corresponding work items.

## Workspace state

`pnpm-workspace.yaml` now includes:
```
packages/*
apps/mobile
apps/worker
```

The lockfile contains importer entries for all CLAPP packages.

The next clean-checkout install is the authoritative test that the manually added workspace/lockfile seam is accepted by pnpm.

## CI status

At audit time GitHub returned zero workflow runs for this repository.

Therefore:
- do not claim the new CLAPP scaffold is CI-green yet;
- first TL task is clean-checkout install/typecheck/lint/test validation;
- any lockfile or TypeScript failure must be fixed before functional worker work is accepted.

## TL-0 gate results (2026-09-27)

Executed in a clean checkout of `bae700938c6e651d115fc1e921771c0fc2b04b6b`
(pnpm 11.19.0, Node v24.21.0), compared against a base worktree of
`34b15bc80340e582fb8c25573646cfb0bbc5184d` for failure attribution.

| Gate | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | PASS (34.6s; workspace/lockfile seam accepted) |
| CLAPP workspace resolution | PASS (`@clapp/contracts` resolves via `workspace:*` symlinks from all four sibling packages) |
| `pnpm typecheck` (root + mobile) | PASS, zero errors |
| `pnpm lint` | PASS after reformatting 12 new CLAPP files (format-only; schema/package JSON verified semantically identical; zero substrate files touched) |
| `pnpm test` | 192 tests / 189 pass / 3 fail — identical to base snapshot; see attribution below |
| `pnpm build:server` | PASS |
| `pnpm test:browser` | PASS after provisioning Playwright chromium r1234 (the TL environment previously held r1200/r1243 only; playwright 1.62.1 pins r1234) |
| `pnpm test:computer` | NOT RUN in the TL environment: Docker is unavailable there (no passwordless sudo). All computer-semantics tests in the mocked suite pass. Must be executed in a Docker-capable environment before final M0 acceptance. |

Pre-existing failure attribution (identical at base and overlay; zero overlay
regressions):
- `tests/oauth.test.ts` and `tests/browser.test.ts`: every named subtest
  passes in both states; only the node:test file-level wrapper fails in this
  environment.
- `tests/conversation-browser.test.ts`: passes 5/5 when run individually in
  both states; fails only under the default parallel full-suite execution
  (test isolation artifact of the environment).

## Contract freeze

Typecheck over the scaffolded `@clapp/contracts` revealed no missing fields.
The contracts are frozen as **v0.1** at the TL-0 commit. Consumers
(W1-001/W2-001/W3-001) may now implement against them; any required change
must go through the tech lead as a deliberate contract revision.

## Functional CLAPP status

Not yet implemented:
- runtime adapter behavior;
- target authorization persistence;
- browser evidence capture;
- Behavioral IR implementation;
- exploration;
- synthesis;
- differential verification;
- repair;
- package registry/retrieval;
- continuous learning;
- CLAPP-specific UI/routes.

## Current milestone

`CLAPP-WEB-M0`:

Authorized web target
-> durable reconstruction task
-> evidence
-> exploration
-> Behavioral IR
-> synthesis
-> reference/candidate parity
-> bounded repair
-> human-reviewable report.

## Immediate TL gate

Before dispatching functional work:
1. run clean install;
2. run typecheck;
3. run lint;
4. run existing tests;
5. run server build;
6. verify browser/computer tests still pass;
7. verify CLAPP packages are resolved as workspace packages;
8. freeze/revise contracts if compilation reveals missing fields.

Only then dispatch W1-001, W2-001 and W3-001.
