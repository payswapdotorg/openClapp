# Three-Worker Protocol

## Worker allocation

### Worker 1 — Runtime + Observation

Primary question:
> Can CLAPP reliably observe and execute software?

Own:
- `packages/clapp-runtime-openmuse`
- `packages/clapp-observation`
- browser/computer adapter changes
- disposable environments
- execution/recovery integration

### Worker 2 — Intelligence + Learning

Primary question:
> Can CLAPP represent software behavior and remember how to build it?

Own:
- `packages/clapp-intelligence`
- Behavioral IR
- exploration model
- archetypes
- packages
- retrieval
- failure memory
- promotion

### Worker 3 — Synthesis + Verification + UX

Primary question:
> Can CLAPP turn the model into a working application, prove parity, and expose the process?

Own:
- `packages/clapp-synthesis`
- synthesis plan;
- generator;
- paired verification;
- repair;
- CLAPP API/UI surfaces.

## Cross-worker rules

1. Contracts are written before consumers.
2. All external results cross a typed interface.
3. Artifacts are referenced by immutable IDs.
4. Workers do not share mutable in-memory state.
5. No worker copies logic from another worker's package.
6. Any required cross-owner change is proposed to the tech lead.
7. Integration tests use real provider adapters whenever feasible.
8. Fakes are only for unit tests; end-to-end gates use real OpenMuse providers.

## Parallel wave pattern

```
                Tech Lead
                    |
          freezes contract
                    |
          +---------+---------+
          |         |         |
         W1        W2        W3
          |         |         |
          +---------+---------+
                    |
             Integration gate
                    |
                new freeze
```

## Reporting template

Each worker must add a report under the current worklog entry containing:

- work item;
- baseline commit;
- changes;
- public interfaces;
- tests;
- acceptance evidence;
- limitations;
- risk;
- unblocked work.

The report must be understandable without this conversation.
