# OpenMuse Integration

## Decision

Use OpenMuse as the execution/control-plane substrate.

Do not fork or duplicate:
- AgentService;
- TaskWorker;
- BrowserService;
- ComputerService;
- Files;
- owner/auth boundary;
- mobile/web shell.

## Mapping

### Durable task

OpenMuse:
`AgentService.createTask -> TaskWorker -> lease/checkpoint/event`

CLAPP:
`ReconstructionSpec -> ClappTaskHandler -> stage execution`

The CLAPP handler returns only task-level state needed by OpenMuse. Large evidence/model/candidate artifacts live in CLAPP repositories/artifact stores, with IDs referenced from task state.

### Browser

OpenMuse `BrowserService` and `apps/worker` provide browser execution.

CLAPP adds an observation adapter that can request:
- DOM;
- accessibility;
- screenshot;
- console/runtime;
- request/response;
- WebSocket;
- storage;
- service-worker;
- static-resource evidence.

When the worker cannot provide a signal, the result must say `unavailable`.

### Linux computer

Use OpenMuse's Linux computer for:
- candidate builds;
- package installation;
- tests;
- local servers;
- repository inspection.

Do not assume it is a general desktop VM.

### Files/artifacts

Use OpenMuse file APIs for user-visible outputs. Large internal evidence should use content-addressed CLAPP artifacts and only surface summaries/links in OpenMuse.

### Auth

OpenMuse owner identity remains the user boundary.

CLAPP adds:
- target ownership/authorization;
- target scope;
- expiration;
- evidence-retention policy.

## Adapter package

`packages/clapp-runtime-openmuse` should provide:

```ts
ObservationProvider
ExecutionProvider
ArtifactProvider
TaskProvider
ApprovalProvider
WorkspaceProvider
NotificationProvider
```

The domain packages never call OpenMuse directly.

## Future alternate runtimes

A future runtime adapter may use:
- a different task queue;
- another browser farm;
- GitHub Actions;
- remote GPU/VM providers;
- native device labs.

This is why OpenMuse is an adapter, not a core dependency.
