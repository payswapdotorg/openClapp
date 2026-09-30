# CLAPP Work Items

## Rules

- Exactly three concurrent worker lanes.
- Tech lead owns integration and frozen cross-lane interfaces.
- Work items may be parallelized only after their declared contract dependencies are frozen.
- A worker may not take ownership of another worker's package without a handoff.

## W1 — Runtime / Observation / Platform

### CLAPP-W1-001
Build `@clapp/runtime-openmuse`.
Depends: contracts.
Done when CLAPP can create/reconcile a durable reconstruction task using OpenMuse AgentService.

### CLAPP-W1-002
Implement browser observation adapter over the existing browser worker.
Depends: W1-001, observation contract.
Done when a target run can collect DOM/a11y/screenshot/network/storage evidence with explicit unavailable states.

### CLAPP-W1-003
Implement candidate workspace execution provider using OpenMuse ComputerService.
Depends: W1-001.
Done when candidate code can build/test under bounded execution.

### CLAPP-W1-004
Implement run artifact/recovery semantics.
Depends: W1-001.
Done when restart/pause/cancel/retry preserve CLAPP stage state correctly.

### CLAPP-W1-005
Add disposable benchmark hosting and reset helpers.
Depends: W1-002.
Done when every web benchmark can start/reset inside isolated execution.

### CLAPP-W1-006
Future native provider interface implementations.
Depends: native ADR.
Do not begin before Phase 10.

### CLAPP-W1-008
Target authorization persistence.
Depends: W1-002, SECURITY authorization record.
Done when a target run persists an authorization record (target owner, authorized scope, allowed environments, artifact retention, expiry, operator identity) before observation begins, and observation fails closed without a valid unexpired record.

## W2 — Behavioral Intelligence / Learning

### CLAPP-W2-001
Canonical Behavioral IR implementation and validation.
Depends: contracts.

### CLAPP-W2-002
Evidence-to-IR extraction.
Depends: W1-002.

### CLAPP-W2-003
Deterministic exploration and journey model.
Depends: W1-002.

### CLAPP-W2-004
Archetype classifier.
Depends: W2-001 and exploration features.

### CLAPP-W2-005
Package schema, registry and versioning.
Depends: contracts.

### CLAPP-W2-006
Package extraction/promotion.
Depends: W2-005 and parity success.

### CLAPP-W2-007
Package retrieval/compatibility graph.
Depends: W2-005.

### CLAPP-W2-008
Failure memory and repair-pattern learning.
Depends: parity findings.

### CLAPP-W2-010
Package promotion/evaluation gate.
Depends: W2-006, W2-009.

## W3 — Synthesis / Verification / Product

### CLAPP-W3-001
SynthesisPlan implementation.
Depends: W2-001.

### CLAPP-W3-002
Web candidate generator.
Depends: W3-001, W1-003.

### CLAPP-W3-003
Generated acceptance suite.
Depends: W3-002.

### CLAPP-W3-004
Reference/candidate paired runner.
Depends: W1-002 and W1-003.

### CLAPP-W3-005
Semantic/visual/network/state diff.
Depends: W3-004.

### CLAPP-W3-006
Bounded autonomous repair.
Depends: W3-005.

### CLAPP-W3-007
CLAPP user interface surfaces.
Depends: stable API/events.

### CLAPP-W3-008
End-to-end app reconstruction acceptance.
Depends: W1/W2/W3 core gates.

## Tech lead gates

### CLAPP-TL-001
Freeze contracts before worker implementation.

### CLAPP-TL-002
Integrate first vertical slice.

### CLAPP-TL-003
Run clean-checkout recovery test.

### CLAPP-TL-004
Approve package promotion policy.

### CLAPP-TL-005
Run archetype learning experiment.

### CLAPP-TL-006
Update status/roadmap after every integrated wave.
