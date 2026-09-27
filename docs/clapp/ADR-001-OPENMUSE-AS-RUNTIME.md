# ADR-001 — OpenMuse Is the CLAPP Runtime Substrate

Status: Accepted

## Context

openClapp is a clone of OpenMuse. The repository already provides durable task execution, browser sessions, Linux workspace execution, files, authentication, UI, and mobile/web packaging.

Reimplementing those facilities inside CLAPP would duplicate tested infrastructure and couple the intelligence layer to operational concerns.

## Decision

OpenMuse remains the runtime/control plane.

CLAPP is a framework-neutral intelligence/application layer connected through `packages/clapp-runtime-openmuse`.

## Consequences

Positive:
- faster path to durable autonomous reconstruction;
- reuse of existing pause/resume/retry/recovery;
- reuse of browser and computer surfaces;
- future runtime adapters remain possible.

Negative:
- CLAPP must maintain an explicit adapter boundary;
- OpenMuse domain concepts must not leak into the Behavioral IR.

## Rejected alternative

Making CLAPP a deep fork with logic scattered through OpenMuse services was rejected because it would make future platform/runtime substitution and package testing difficult.
