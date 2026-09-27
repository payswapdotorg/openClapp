# CLAPP Product UX

OpenMuse's existing UI remains the shell. CLAPP adds a dedicated application-building workspace.

## Primary navigation

```
Chat
Tasks
CLAPP
  Targets
  Reconstructions
  Evidence
  Candidates
  Parity
  Packages
  Learning
Computers
Files
Settings
```

## Target intake

A target should show:
- target name;
- platform;
- entrypoint;
- authorization status;
- scope;
- environment;
- capture budget.

## Reconstruction detail

```
Header
  Target | platform | status | controls

Timeline
  Authorization
  Capture
  Explore
  Model
  Plan
  Build
  Verify
  Repair
  Review
  Promote

Main
  live evidence / browser / computer

Side panels
  Behavioral IR
  parity findings
  artifacts
```

## Explainability

Every major conclusion should be drillable:

```
Conclusion
  -> evidence
  -> journey
  -> model element
  -> generated implementation
  -> parity result
```

## Repair review

Each repair shows:
- why it was created;
- exact affected files;
- evidence;
- expected vs actual;
- proposed change;
- re-test result;
- remaining uncertainty.

## Package library

Show:
- package;
- version;
- capability;
- compatibility;
- reuse count;
- benchmark success;
- repair cost;
- provenance.

## Learning dashboard

Show trends, not a fake single score:
- package reuse;
- new-code volume;
- repair iterations;
- build duration;
- parity pass rate;
- recurring failures.

## Human gate

The final release surface must explicitly separate:
- observed;
- inferred;
- generated;
- substituted;
- unreproducible.
