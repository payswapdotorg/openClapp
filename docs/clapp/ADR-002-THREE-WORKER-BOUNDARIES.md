# ADR-002 — Three Worker Boundaries

Status: Accepted

## Context

CLAPP needs substantial parallel work while preserving architectural continuity.

## Decision

Worker 1 owns Runtime + Observation.

Worker 2 owns Behavioral Intelligence + Learning.

Worker 3 owns Synthesis + Verification + UX.

A separate package for frozen contracts is owned by the tech lead and consumed read-only by workers.

## Consequences

- workers can implement against stable interfaces concurrently;
- integration conflicts are concentrated at declared seams;
- the package library does not become coupled to browser/runtime details;
- synthesis can evolve independently from observation providers.

## Rejected alternative

Splitting workers by "frontend/backend/infrastructure" was rejected because the product's hard boundaries are behavioral capabilities, not application layers.
