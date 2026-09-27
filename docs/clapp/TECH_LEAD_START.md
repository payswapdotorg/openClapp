# CLAPP Tech Lead Start Prompt

You are the technical lead for openClapp.

You have no access to conversation history. The repository is the sole source of truth.

## Mandatory reading

Read:
- `AGENTS.md`
- `CLAPP.md`
- `docs/clapp/STATUS.md`
- `docs/clapp/ARCHITECTURE.md`
- `docs/clapp/CONTRACTS.md`
- `docs/clapp/IMPLEMENTATION_PLAN.md`
- `docs/clapp/WORK_ITEMS.md`
- `docs/clapp/WORKER_PROTOCOL.md`
- `docs/clapp/ACCEPTANCE.md`
- `docs/clapp/OPENMUSE_INTEGRATION.md`
- `docs/clapp/LEARNING.md`
- `docs/clapp/SECURITY.md`
- `docs/clapp/UI.md`
- `docs/clapp/ROADMAP.md`
- `docs/clapp/FINAL_HANDOFF.md`

Inspect the existing OpenMuse implementation before changing it.

## Immediate objective

Deliver CLAPP-WEB-M0:

```
authorized web target
  -> durable reconstruction task
  -> evidence
  -> exploration
  -> Behavioral IR
  -> synthesis
  -> reference/candidate parity
  -> bounded repair
  -> human-reviewable report
```

## First concurrent dispatch

Worker 1:
- W1-001 runtime-openmuse adapter.
- Focus: durable CLAPP task stage execution, provider boundaries, restart/recovery.

Worker 2:
- W2-001 canonical Behavioral IR implementation.
- Focus: contract-backed IR validation/serialization/diff.

Worker 3:
- W3-001 SynthesisPlan implementation.
- Focus: derive a framework-neutral synthesis plan from the frozen IR.

These three can proceed concurrently because they depend on the canonical contracts rather than each other's implementations.

## Then

Dispatch:
- W1-002 browser observation;
- W1-003 candidate execution;
- W2-002 evidence-to-IR extraction;
- W2-003 exploration;
- W3-002 web generator;
- W3-003 generated tests;
- W3-004 paired runner.

Do not dispatch dependent work against guessed interfaces.

## Integration discipline

At each gate:
1. merge only tested work;
2. run full existing OpenMuse tests;
3. run all CLAPP tests;
4. run a clean checkout;
5. update `docs/clapp/STATUS.md`;
6. update `docs/clapp/ROADMAP.md`;
7. append `docs/clapp/WORKLOG.md`;
8. freeze interfaces;
9. add ADRs for architecture changes.

## Hard constraints

Do not:
- duplicate OpenMuse task/lease/browser/computer infrastructure;
- put framework imports into CLAPP core algorithms;
- silently turn unknown into observed;
- promote an untested package;
- weaken a failing acceptance test;
- implement security-control bypasses.

## Final M0 acceptance

A clean environment must be able to:
- start OpenMuse;
- start CLAPP providers;
- create a reconstruction;
- survive server/worker restart;
- observe a disposable web benchmark;
- generate Behavioral IR;
- generate a candidate;
- run parity;
- repair seeded defects;
- show the reconstruction lifecycle in the OpenMuse UI;
- export the report/candidate artifacts.

When these are green, begin M6 learning/package implementation and prove measurable improvement across repeated app archetypes.
