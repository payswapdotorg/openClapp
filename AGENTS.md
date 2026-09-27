# openClapp Agent Instructions

## Read this first

This repository is the sole source of truth for building openClapp/CLAPP. Do not depend on conversation history, external instructions, or remembered plans.

Before changing architecture or dispatching work, read:

1. `CLAPP.md`
2. `docs/clapp/README.md`
3. `docs/clapp/ARCHITECTURE.md`
4. `docs/clapp/REPO_MAP.md`
5. `docs/clapp/CONTRACTS.md`
6. `docs/clapp/IMPLEMENTATION_PLAN.md`
7. `docs/clapp/WORK_ITEMS.md`
8. `docs/clapp/WORKER_PROTOCOL.md`
9. `docs/clapp/ACCEPTANCE.md`
10. `docs/clapp/SECURITY.md`
11. `docs/clapp/LEARNING.md`
12. `docs/clapp/OPENMUSE_INTEGRATION.md`
13. `docs/clapp/UI.md`
14. `docs/clapp/ROADMAP.md`
15. `docs/clapp/STATUS.md`

## Authority order

When sources disagree:

1. Frozen contract in `packages/clapp-contracts`
2. Architecture/ADR
3. Acceptance criteria
4. Work item packet
5. Implementation
6. Other documentation

Never silently change a frozen contract.

## Mission

Turn the OpenMuse durable-agent substrate into CLAPP: an application reconstruction, parity, repair, and continuous-learning system.

The product loop is:

```
authorized target
  -> observe
  -> explore
  -> evidence
  -> Behavioral IR
  -> archetype/package retrieval
  -> synthesis
  -> paired verification
  -> repair
  -> human review
  -> package promotion
  -> future composition
```

## Non-negotiables

- OpenMuse remains the durable runtime/control plane.
- CLAPP domain logic must not depend on OpenMuse UI implementation details.
- Behavioral IR is platform-neutral.
- Evidence, inference, assumptions, and generated choices remain distinguishable.
- Differential verification is first-class.
- Package promotion is executable-test and provenance gated.
- Generated and target software execute in isolated environments.
- No credential theft, authentication bypass, DRM bypass, attestation bypass, anti-tamper evasion, or unauthorized access features.
- Never claim hidden server-side behavior from client observations alone.
- Do not weaken acceptance tests to make a worker pass.
- Do not duplicate OpenMuse's task, lease, browser session, or computer subsystems when an adapter will do.
- Preserve existing OpenMuse behavior unless a CLAPP ADR explicitly replaces it.

## Tech lead mode

The tech lead coordinates exactly three workers concurrently.

The tech lead:
- freezes contracts;
- assigns work packets;
- controls integration order;
- runs clean-checkout validation;
- updates `docs/clapp/STATUS.md`, `ROADMAP.md`, and `WORKLOG.md`;
- records architecture changes as ADRs;
- rejects work that crosses package ownership without a declared interface.

## Worker mode

Workers own only the files/packages stated in their packet unless the packet explicitly grants a cross-cutting edit.

Every worker handoff must report:
- objective;
- implementation;
- files;
- contract impact;
- tests;
- acceptance evidence;
- known limitations;
- risks;
- next dependency unlocked.

## Quality bar

A feature is complete only when:
- code exists;
- tests exist;
- acceptance evidence exists;
- documentation matches implementation;
- clean checkout works;
- no critical known regression exists.

## Git discipline

Prefer small focused commits. Use commit messages containing the work-item ID.

Never commit secrets, browser profiles, credentials, generated private target evidence, or personal data.

## Product language

Use:
- behavioral reconstruction
- parity engineering
- compatibility implementation
- software migration
- authorized reverse engineering

Do not promise perfect source recovery or universal cloning of arbitrary applications.
