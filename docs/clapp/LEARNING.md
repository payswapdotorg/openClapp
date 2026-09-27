# CLAPP Continuous Learning

## Objective

Each finished project should reduce future application-construction work.

## Memory layers

1. **Evidence memory** — what was observed.
2. **Behavior memory** — reusable state/transition patterns.
3. **Architecture memory** — proven composition patterns.
4. **Package memory** — executable reusable components.
5. **Failure memory** — what broke and how it was fixed.
6. **Evaluation memory** — where each package succeeds/fails.

## Package taxonomy

Initial web package families:
- shell/navigation;
- authentication/session;
- roles/permissions;
- forms/validation;
- tables/filtering/pagination;
- dashboard cards/charts;
- search;
- files/uploads;
- notifications;
- realtime;
- editor;
- offline/PWA;
- CRUD backend;
- audit log;
- background jobs;
- API client;
- deployment;
- parity-test harness.

## Package promotion

Candidate
 -> local tests
 -> provenance/security checks
 -> independent replay
 -> cross-project replay
 -> promoted immutable version

Never mutate a promoted version.

## Retrieval

Rank candidates by:
- capability;
- target platform;
- stack compatibility;
- interface compatibility;
- dependency compatibility;
- benchmark success;
- prior repair cost;
- recency.

Every retrieval decision must be explainable.

## Learning signal

Track:
- package reuse rate;
- generated new code;
- repair iterations;
- build time;
- test pass rate;
- parity improvement;
- failure recurrence;
- package rejection rate.

## Learning experiment

Use a repeated sequence:

```
App A1 -> build from scratch -> extract packages
App A2 -> retrieve -> compose -> verify
App B1 -> build from scratch -> extract packages
App B2 -> retrieve -> compose -> verify
```

The claim "CLAPP learns" is accepted only when the repeated benchmark shows measurable improvement without weakening acceptance criteria.

## Model use

Model fine-tuning is optional.

The first durable learning mechanism is the executable verified library. It is deterministic, auditable, versioned and reversible.
