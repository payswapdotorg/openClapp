# openClapp / CLAPP

CLAPP is the application-intelligence layer built on the OpenMuse durable-agent substrate.

## North star

A user gives CLAPP an application they are authorized to analyze.

CLAPP should autonomously:

1. create an isolated reconstruction job;
2. observe the target;
3. explore it;
4. build a provenance-linked Behavioral IR;
5. classify the application archetype;
6. retrieve verified reusable packages;
7. synthesize an independent implementation;
8. run reference-vs-candidate parity tests;
9. repair mismatches within bounded budgets;
10. present evidence and remaining uncertainty for human review;
11. promote verified reusable components;
12. use those components to make future applications faster to build.

The strategic asset is the verified package/knowledge library, not a one-off generated application.

## First target

Web applications are the first complete target.

Native targets are future adapters:
- Android
- Linux
- Windows
- macOS
- iOS

They all reuse the same Behavioral IR, package library, orchestration model, and parity concepts.

## What OpenMuse provides

Reuse the existing OpenMuse substrate for:
- user-facing web/mobile surfaces;
- durable tasks;
- plans/checkpoints;
- worker leases;
- pause/resume/cancel/retry;
- browser sessions;
- Linux computer/workspace;
- files/artifacts;
- approvals;
- authenticated owner boundary;
- AG-UI/CopilotKit transport.

## What CLAPP provides

Build new CLAPP domain capabilities:
- target authorization record;
- observation/evidence model;
- exploration;
- Behavioral IR;
- application archetypes;
- synthesis plans;
- code generation;
- paired differential verification;
- repair;
- reusable package registry;
- package retrieval/composition;
- failure memory;
- learning/promotion;
- reconstruction-specific UX.

## Core rule

OpenMuse is the operating environment for work.

CLAPP is the system that understands and builds software.
