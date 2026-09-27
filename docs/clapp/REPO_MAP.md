# CLAPP Repository Map

## Existing OpenMuse substrate

| Area | Existing location | CLAPP treatment |
|---|---|---|
| UI | `apps/mobile` | extend with CLAPP surfaces |
| API/server | `apps/server` | add thin CLAPP routes/adapters |
| task worker | `apps/server/src/engine` | reuse |
| browser API | `apps/server/src/browser.ts` | reuse through provider |
| browser worker | `apps/worker` | reuse/extend capture capabilities |
| Linux computer | `apps/computer`, `apps/server/src/computer.ts` | reuse as provider |
| domain | `packages/domain` | preserve generic OpenMuse domain; add CLAPP types separately |
| persistence | `apps/server/src/db.ts` | reuse through CLAPP repositories |
| files | `apps/server/src/files.ts` | reuse for user-facing artifacts |
| auth | `apps/server/src/auth.ts` | reuse owner boundary; add target authorization on top |

## New CLAPP boundaries

### `packages/clapp-contracts`
Frozen, framework-neutral contracts.

### `packages/clapp-runtime-openmuse`
Adapters from CLAPP providers/tasks to OpenMuse services.

### `packages/clapp-observation`
Evidence ingestion and web observation semantics.

### `packages/clapp-intelligence`
Behavioral IR, exploration, archetypes, package library, retrieval and learning.

### `packages/clapp-synthesis`
Synthesis planning, generation, differential verification and repair.

The last three packages map to the three workers.

## Server integration

Eventually add:
- `apps/server/src/clapp/service.ts`
- `apps/server/src/clapp/routes.ts`
- `apps/server/src/clapp/worker.ts`
- `apps/server/src/clapp/repositories.ts`

These are orchestration adapters only. Domain algorithms remain in packages.

## UI integration

Add CLAPP views under `apps/mobile/src` without coupling domain algorithms to React.

Required concepts:
- Targets;
- Reconstructions;
- live run;
- evidence;
- Behavioral IR;
- candidate;
- parity findings;
- repair attempts;
- package library;
- learning metrics.

## Test boundaries

Keep existing OpenMuse tests green.

Add:
- `tests/clapp-contracts.test.ts`
- `tests/clapp-runtime.test.ts`
- `tests/clapp-observation.test.ts`
- `tests/clapp-intelligence.test.ts`
- `tests/clapp-synthesis.test.ts`
- `tests/clapp-e2e.test.ts`

Browser-gated tests belong beside existing browser tests and must use disposable fixtures.
