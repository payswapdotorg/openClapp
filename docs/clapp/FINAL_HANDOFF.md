# CLAPP Final Handoff to Tech Lead

## Repository audit result

The repository is a substantial OpenMuse clone, not an empty shell.

Verified substrate:
- durable AgentService and TaskWorker;
- durable leases and recovery;
- browser service + Playwright worker;
- Docker Linux computer/workspace;
- web/iOS/Android application shell;
- owner/auth boundary;
- files/artifacts;
- CI and extensive tests.

The source snapshot audited is commit `34b15bc80340e582fb8c25573646cfb0bbc5184d`.

## Architecture decision

Do not rebuild OpenMuse.

Treat it as the runtime/control plane.

Build CLAPP as a framework-neutral domain engine plus one OpenMuse adapter.

## First milestone

### CLAPP-WEB-M0

A user submits an authorized web application.

The system creates a durable OpenMuse task that:
1. validates authorization;
2. creates or reserves a browser session;
3. captures evidence;
4. explores the target;
5. emits Behavioral IR;
6. creates a synthesis plan;
7. generates a candidate in an isolated workspace;
8. runs paired journeys;
9. produces a parity report;
10. performs bounded repairs;
11. publishes a reconstruction report and candidate artifact.

This milestone does not require package learning to be complete, but the interfaces must already support it.

## Three-worker allocation

### Worker 1 — Runtime and Observation

Owns:
- `packages/clapp-runtime-openmuse`
- `packages/clapp-observation`
- browser/computer adapters;
- task-stage persistence;
- evidence capture;
- environment/benchmark execution.

Do not own:
- Behavioral IR semantics;
- synthesis;
- package retrieval.

First packets:
W1-001, W1-002, W1-003, W1-004.

### Worker 2 — Intelligence and Learning

Owns:
- `packages/clapp-intelligence`
- Behavioral IR;
- exploration;
- archetypes;
- package schema/registry;
- retrieval;
- failure memory;
- learning.

First packets:
W2-001, then W2-002/W2-003 in parallel where contracts permit.

### Worker 3 — Synthesis, Verification and UX

Owns:
- `packages/clapp-synthesis`;
- synthesis planning;
- web generation;
- paired verification;
- repair;
- CLAPP API/UI surfaces.

First packets:
W3-001, then W3-002/W3-003/W3-004 as dependencies freeze.

## Tech lead sequence

### TL-0
Freeze:
- CLAPP task payload;
- provider interfaces;
- evidence contract;
- IR contract;
- synthesis contract;
- parity contract;
- package contract.

### TL-1
Integrate W1 runtime adapter and restart/recovery test.

### TL-2
Integrate W1 observation with W2 IR.

### TL-3
Integrate W2 IR with W3 synthesis.

### TL-4
Integrate paired verification and repair.

### TL-5
Dogfood the complete web reconstruction flow.

### TL-6
Begin package learning only after M0 is repeatably green.

## Architecture invariants

1. OpenMuse task lifecycle stays authoritative.
2. CLAPP stages are resumable from durable artifacts.
3. Core algorithms are independent of OpenMuse.
4. Provider failures are explicit.
5. Evidence is immutable.
6. Unknown remains unknown.
7. Package promotion is executable-test gated.
8. Repairs are bounded and scoped.
9. Final release has a human review boundary.
10. Every new platform uses the same CLAPP contracts.

## Definition of done for M0

A clean checkout can:
- install;
- run OpenMuse;
- start browser/computer providers;
- create a CLAPP reconstruction task;
- survive worker restart;
- capture a benchmark target;
- generate a Behavioral IR;
- synthesize a candidate;
- run parity;
- repair seeded defects;
- show the entire timeline in the UI;
- export a report.

No chat transcript is required to understand or execute any part of this plan.
