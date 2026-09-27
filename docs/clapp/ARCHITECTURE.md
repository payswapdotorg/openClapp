# CLAPP Architecture

## 1. System shape

```
                         OpenMuse UI
                Web / iOS / Android client
                           |
                    AG-UI / HTTP API
                           |
                  OpenMuse Server/API
                           |
                 Durable AgentService
                           |
                 CLAPP Task Handler
                           |
        +------------------+------------------+
        |                  |                  |
        v                  v                  v
   Observation       Intelligence       Synthesis/Parity
      Plane              Plane                Plane
        |                  |                  |
        +------------------+------------------+
                           |
                    CLAPP Behavioral IR
                           |
                  Verified Package Library
                           |
                    Evidence/Artifacts
                           |
        +------------------+------------------+
        |                  |                  |
        v                  v                  v
   Browser provider   Linux provider     Future native
   OpenMuse worker   OpenMuse computer   platform adapters
```

## 2. Ownership

### OpenMuse owns
- task lifecycle;
- lease state;
- authentication;
- user/session identity;
- generic files;
- generic artifact transport;
- browser-session ownership;
- Linux computer lifecycle;
- mobile/web shell;
- generic notifications.

### CLAPP owns
- reconstruction job semantics;
- target authorization;
- evidence;
- exploration;
- Behavioral IR;
- synthesis plans;
- generated candidate provenance;
- parity reports;
- repair directives;
- package knowledge;
- learning/promotion.

## 3. Layering

```
apps/server / apps/mobile
        |
adapters (runtime-openmuse)
        |
CLAPP application services
        |
CLAPP contracts
        |
pure algorithms / package library
```

CLAPP core packages must not import:
- React Native;
- Hono;
- CopilotKit;
- PGlite/pg;
- Playwright;
- Docker client;
- any model SDK.

Adapters may import those technologies.

## 4. Run model

A CLAPP reconstruction is a durable OpenMuse task with a CLAPP payload:

```
Task
  -> ReconstructionSpec
  -> stages
       authorization
       capture
       exploration
       modeling
       planning
       synthesis
       verification
       repair
       review
       promotion
```

Each stage produces immutable artifacts and a stage result.

A stage can be replayed from artifacts without re-running previous stages unless it declares an external dependency.

## 5. Evidence model

Evidence is immutable and content-addressed.

Every evidence artifact has:
- runId;
- targetId;
- source/provider;
- capture time;
- environment fingerprint;
- kind;
- hash;
- redaction status;
- provenance;
- retention classification.

## 6. Behavioral model

Behavioral IR separates:
- OBSERVED;
- DERIVED;
- INFERRED;
- ASSUMED;
- UNAVAILABLE.

No synthesis stage may silently promote an ASSUMED property to OBSERVED.

## 7. Synthesis

Synthesis is:

```
Behavioral IR
  + package graph
  + target constraints
  + implementation policy
      |
      v
SynthesisPlan
      |
      v
candidate workspace
      |
      v
build/test
```

One default web output stack should be supported first. Framework proliferation is explicitly postponed.

## 8. Verification

Reference and candidate run the same canonical journeys under comparable environments.

Compare:
- route/navigation;
- visible/semantic UI;
- screenshots;
- network contracts;
- state/storage;
- errors;
- timing envelopes when meaningful.

Every finding contains:
- severity;
- dimension;
- anchor;
- expected;
- actual;
- evidence refs;
- candidate scope;
- repairability.

## 9. Repair

Repair is bounded and evidence-driven.

```
DiffReport
  -> RepairDirectives
  -> candidate edits
  -> rebuild
  -> paired verification
  -> next bounded attempt
```

A repair engine must be able to abstain.

## 10. Learning

```
verified build
  -> reusable-pattern extraction
  -> package candidate
  -> standalone tests
  -> independent replay
  -> promotion
  -> future retrieval
```

The library must retain provenance, compatibility, dependencies, tests, benchmarks and failure modes.

## 11. Native expansion

Native platforms attach to:
- ObservationProvider;
- ExecutionProvider;
- EvidenceProvider;
- SynthesisTarget;
- VerificationProvider.

They do not receive separate architectures.

## 12. Failure principle

A missing observation is not permission to invent a behavior. CLAPP reports uncertainty and asks for user input or uses an explicit substitute.
