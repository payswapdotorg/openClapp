# CLAPP Documentation Index

This directory is the implementation specification for CLAPP.

## Start here

- [STATUS](STATUS.md) — verified repository audit and current completion state.
- [FINAL_HANDOFF](FINAL_HANDOFF.md) — direct handoff to the next tech lead.
- [ARCHITECTURE](ARCHITECTURE.md) — target architecture and ownership boundaries.
- [CONTRACTS](CONTRACTS.md) — frozen interfaces and event/state vocabulary.
- [IMPLEMENTATION_PLAN](IMPLEMENTATION_PLAN.md) — phased build program.
- [WORK_ITEMS](WORK_ITEMS.md) — worker-sized executable work packets.
- [WORKER_PROTOCOL](WORKER_PROTOCOL.md) — three-worker coordination rules.
- [ACCEPTANCE](ACCEPTANCE.md) — gates and benchmark requirements.
- [OPENMUSE_INTEGRATION](OPENMUSE_INTEGRATION.md) — exact reuse/adaptation map.
- [LEARNING](LEARNING.md) — package library and compounding-learning architecture.
- [SECURITY](SECURITY.md) — authorization, secrets, isolation, and package trust.
- [UI](UI.md) — product surfaces and discoverability.
- [ROADMAP](ROADMAP.md) — dependency graph.

## Canonical implementation contracts

The first CLAPP contracts live in:
- `packages/clapp-contracts/src/index.ts`
- `schemas/clapp/behavioral-ir.schema.json`
- `schemas/clapp/package.schema.json`

The CLAPP contract package must remain independent of React, Hono, CopilotKit, Playwright, PGlite, PostgreSQL, and any specific model provider.

## Existing OpenMuse source

Important substrate locations:
- `apps/server/src/engine/worker.ts` — durable task worker and lease handling.
- `apps/server/src/engine/service.ts` — AgentService lifecycle, task creation, control and recovery.
- `apps/server/src/engine/routes.ts` — task HTTP API.
- `apps/server/src/browser.ts` — browser session adapter/client.
- `apps/worker/src/browser.ts` — Playwright browser worker.
- `apps/server/src/computer.ts` — Linux computer adapter.
- `apps/computer` — isolated Linux computer image.
- `apps/mobile` — cross-platform product UI.
- `packages/domain/src/agent.ts` — existing OpenMuse task/domain types.

Do not clone those systems into CLAPP packages.

## Change policy

Add new architecture documents and ADRs when behavior crosses package boundaries. Keep current OpenMuse docs intact where they describe still-supported OpenMuse capabilities; augment them with CLAPP-specific docs rather than pretending legacy surfaces are CLAPP-native.
