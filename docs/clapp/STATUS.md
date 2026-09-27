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
