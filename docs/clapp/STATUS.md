# CLAPP Verified Status

Audit date: 2026-09-27

Repository: `payswapdotorg/openClapp`

Base repository: OpenMuse clone on branch `main`.

Verified source snapshot: commit `34b15bc80340e582fb8c25573646cfb0bbc5184d`.

## What already exists and should be reused

### Durable orchestration
OpenMuse already has:
- durable AgentTask records;
- SQL-backed lease acquisition;
- up to three concurrent eligible tasks per tick;
- heartbeats;
- interruption recovery;
- checkpointing;
- run records;
- pause/resume/cancel/retry;
- stored action review;
- background maintenance.

Primary source:
`apps/server/src/engine/worker.ts`
`apps/server/src/engine/service.ts`

### Browser substrate
OpenMuse already has:
- a server-side BrowserService;
- a token-protected browser worker;
- persistent Chromium sessions;
- screenshots;
- read/navigation/input;
- downloads;
- live browser preview/console.

Primary source:
`apps/server/src/browser.ts`
`apps/worker/src/browser.ts`

### Linux computer
OpenMuse already has:
- Docker-backed Linux computer;
- bounded commands;
- persistent `/workspace`;
- files;
- isolation tests.

Primary source:
`apps/server/src/computer.ts`
`apps/computer`

### Product surfaces
OpenMuse already has:
- web/mobile UI;
- chat;
- tasks/activity;
- browser/computer views;
- files;
- approvals;
- artifacts.

Primary source:
`apps/mobile`

### Shared domain/runtime
OpenMuse already has:
- Hono server;
- PGlite/PostgreSQL store abstraction;
- auth/owner boundary;
- CopilotKit/AG-UI runtime;
- existing tests.

## What is missing for CLAPP

The following are not present in the current clone as a CLAPP system:

- target authorization model;
- CLAPP evidence bundle;
- Behavioral IR;
- exploration engine;
- app archetype classification;
- synthesis plan;
- independent code generation pipeline;
- paired differential verification;
- CLAPP repair engine;
- reusable package registry;
- package retrieval/composition;
- failure memory;
- package promotion;
- learning benchmarks;
- CLAPP-native task kinds/routes/UI.

## Important substrate limitation

The current OpenMuse Linux computer is a Linux container, not a general desktop VM. Do not describe it as a Windows/macOS/iOS/Android execution environment.

The current browser worker is an execution provider; CLAPP must own observation semantics and evidence provenance.

## Current contract decision

No CLAPP feature should modify the OpenMuse durable task semantics directly until the CLAPP task payload/state/event contracts in `packages/clapp-contracts` are frozen.

## Current milestone

The immediate milestone is **CLAPP-WEB-M0**:

> From an authorized web target, create a durable CLAPP reconstruction task that can observe and archive evidence, build a Behavioral IR, synthesize a candidate, compare reference and candidate, and expose the run through the existing OpenMuse activity/task UI.

The package-learning loop becomes the next milestone once this vertical slice is green.
