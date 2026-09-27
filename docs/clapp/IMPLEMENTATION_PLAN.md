# CLAPP Implementation Plan

## Phase 0 — Freeze the substrate seam

Goal: make it impossible for workers to accidentally rebuild OpenMuse.

Deliver:
- canonical CLAPP contracts;
- provider interfaces;
- package ownership;
- repository rules;
- task payload;
- artifact references;
- acceptance harness.

Workers:
- W1 runtime adapter;
- W2 contracts/IR foundations;
- W3 synthesis/verification contract foundations.

Gate:
- no CLAPP domain package imports OpenMuse/framework modules.

## Phase 1 — Durable CLAPP task and runtime adapter

Goal: a CLAPP reconstruction is a real durable OpenMuse task.

Deliver:
- `@clapp/runtime-openmuse`;
- CLAPP task kind/state mapping;
- stage events;
- artifact references;
- pause/resume/cancel/retry behavior;
- browser/computer provider adapters;
- task recovery after restart.

Worker 1 leads runtime.
Workers 2/3 provide contract-compatible fixtures.

Gate:
- kill/restart the server during a reconstruction and resume from the last durable stage.

## Phase 2 — Web observation and evidence

Goal: capture a reference application with provenance.

Deliver:
- browser observation channels;
- content-addressed evidence;
- redaction;
- environment fingerprint;
- deterministic capture manifests;
- disposable web benchmark fixtures.

Gate:
- one authorized benchmark produces replayable evidence without credentials stored in evidence.

## Phase 3 — Behavioral IR and exploration

Goal: turn evidence into an executable model.

Deliver:
- IR validator;
- evidence linkage;
- deterministic exploration;
- journey DSL;
- uncertainty propagation;
- archetype-ready feature extraction.

Gate:
- same target + seed produces equivalent model/journey output.

## Phase 4 — Web synthesis

Goal: produce independent candidate applications.

Deliver:
- synthesis planner;
- package-aware composition API;
- initial web generator;
- local backend/mock generation;
- generated tests;
- candidate workspace/materialization.

Gate:
- candidate builds from a clean workspace and passes selected canonical journeys.

## Phase 5 — Differential verification and repair

Goal: close the observe-build-test-repair loop.

Deliver:
- paired runner;
- semantic diff;
- visual diff;
- network diff;
- state/storage diff;
- finding classifier;
- bounded repair;
- regression protection.

Gate:
- seeded defects in B01/B02 are detected and repaired; unrepairable defects are reported honestly.

## Phase 6 — Learning/package library

Goal: make the next application cheaper to build.

Deliver:
- package schema;
- registry;
- package extraction;
- compatibility graph;
- retrieval;
- benchmark replay;
- promotion policy;
- failure memory;
- repair-pattern mining.

Gate:
- package extracted from app A is independently reused in app B without manual file surgery.

## Phase 7 — Application archetypes and composition

Goal: move from raw cloning to architecture composition.

Initial archetypes:
- marketing/content site;
- CRUD SaaS;
- dashboard/admin;
- realtime collaboration;
- editor;
- file/document app;
- PWA/offline;
- API-heavy app;
- auth/roles;
- marketplace/catalog;
- workflow/operations system.

Gate:
- repeated builds of the same archetype show lower new-code and repair effort.

## Phase 8 — CLAPP product UX

Goal: make every capability discoverable in OpenMuse.

Surfaces:
- target intake;
- reconstruction queue;
- stage timeline;
- live browser/computer;
- evidence explorer;
- IR inspector;
- candidate workspace;
- parity dashboard;
- repair review;
- package library;
- learning metrics.

Gate:
- a first-time user can create, inspect, pause, resume, review, and export a reconstruction without a developer.

## Phase 9 — Production hardening

Deliver:
- multi-user tenancy;
- stronger isolation;
- secret handling;
- artifact retention;
- quotas;
- cancellation;
- audit;
- observability;
- signed exports;
- package supply-chain checks.

## Phase 10 — Native adapters

Order:
1. Android
2. Linux
3. Windows
4. macOS
5. iOS

Each adapter implements the same provider contracts.

## Phase 11 — Autonomous application factory

End state:

```
target
  -> classify
  -> adaptive explore
  -> model
  -> retrieve package graph
  -> synthesize
  -> verify
  -> repair
  -> human gate
  -> package learning
```

The measurable objective is not "perfect clone". It is increasing parity, decreasing repair cost, increasing package reuse, and growing the set of application families CLAPP can build reliably.
