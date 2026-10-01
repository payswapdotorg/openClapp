# CLAPP Contracts

## Contract owner

`packages/clapp-contracts/src/index.ts) is the canonical contract owner.

Workers may mirror types for local convenience only. Mirrors must be byte-identical or generated from the canonical source.

## Core identifiers

- `clapp_target_`
- `clapp_run_`
- `clapp_stage_`
- `clapp_evidence_`
- `clapp_journey_`
- `clapp_model_`
- `clapp_plan_`
- `clapp_candidate_`
- `clapp_finding_`
- `clapp_repair_`
- `clapp_package_`
- `clapp_authz_`
- `clapp_eval_`

Persisted-record identifiers (`clapp_package_`, `clapp_authz_`, `clapp_eval_`,
and the W2-009 learning-report family) are content-addressed: prefix + first
16 hex characters of sha256 over the record's canonical serialization
(ADR-003). The module-exported prefix constants are the runtime declaration;
this list is normative, and `tests/clapp-contract-ids.test.ts` pins the two
together.

## ReconstructionSpec

Must contain:
- target;
- authorization;
- platform;
- entrypoint(s);
- execution environment;
- exploration budget;
- synthesis policy;
- verification policy;
- retention policy.

## CLAPP task payload

The OpenMuse task remains generic. Its `input`/state should contain a versioned CLAPP payload:

```ts
type ClappTaskInput = {
  specVersion: string;
  reconstructionId: string;
  stage: ClappStage;
};
```

All progress is emitted through OpenMuse RunEvent-compatible events plus CLAPP typed stage events.

## Stage states

```
pending
running
waiting_input
waiting_approval
succeeded
failed
cancelled
skipped
```

## EvidenceRef

Minimum fields:
- evidenceId;
- kind;
- sha256;
- source;
- capturedAt;
- targetId;
- runId;
- classification.

## Behavioral IR

See `schemas/clapp/behavioral-ir.schema.json`.

The IR is versioned and has no OpenMuse imports.

## SynthesisPlan

Must describe:
- architecture;
- target stack;
- routes/screens;
- components/elements;
- state;
- persistence;
- integrations;
- API contracts;
- package dependencies;
- acceptance journeys;
- assumptions.

## DiffReport

Every finding includes:
- id;
- dimension;
- severity;
- anchor;
- expected;
- actual;
- evidenceRefs;
- repairability.

Dimensions:
- semantic;
- visual;
- network;
- state;
- storage;
- performance;
- integration.

## Repair

RepairDirective includes:
- id;
- findingIds;
- candidateScope;
- strategy;
- budget;
- preconditions.

The repair engine must never edit outside candidateScope.

## Package

See `schemas/clapp/package.schema.json`.

A package is code + interface + tests + provenance + compatibility + benchmark data.

## Compatibility

All contract changes require:
- ADR;
- schema/version bump when applicable;
- migration/compatibility test;
- updated acceptance criteria.
