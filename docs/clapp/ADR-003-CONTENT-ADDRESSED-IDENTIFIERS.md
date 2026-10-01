# ADR-003 — Content-Addressed Identifiers for Authorization and Evaluation

Status: Accepted

## Context

Wave 9 landed two modules whose persisted artifacts need stable, content-derived ids:

- `clapp_authz_` — AuthorizationRecord ids (`packages/clapp-observation/src/authorization.ts`, W1-008);
- `clapp_eval_` — PromotionGateDecision ids (`packages/clapp-intelligence/src/promotion-gate.ts`, W2-010).

Both workers declared their prefix locally with an explicit "PENDING CONTRACTS
REVISION (tech-lead owned)" note: the prefixes were not listed in
docs/clapp/CONTRACTS.md "Core identifiers", and listing them requires this ADR
plus updated acceptance criteria per CONTRACTS.md "Compatibility".

Both workers independently chose a 16-hex sha256 prefix of the record's
canonical core, citing the same precedent: the W2-006 `clapp_package_` ids,
the W2-009 learning-report ids, and the `rr-`/`dr-` report-id family
(`contentHash(...).n` with n = 16).

## Decision

1. `clapp_authz_` and `clapp_eval_` join the CONTRACTS.md "Core identifiers"
   list.
2. Both id families are content-addressed: prefix + the first 16 hex
   characters of sha256 over the record's canonical serialization. This
   matches the existing family discipline (W2-006 package ids, W2-009
   learning-report ids) — no new length convention is introduced.
3. The exported constants in the two modules remain the single runtime
   declaration of the prefixes; CONTRACTS.md is the normative list, and a
   compatibility test (`tests/clapp-contract-ids.test.ts`) pins the two
   together: the doc must list every module-declared prefix, and ids must
   match `^<prefix>[0-9a-f]{16}$` and be deterministic (same content, same
   id; different content, different id).

## Consequences

- workers keep ownership of their modules; no worker-owned source changes;
- identifier drift between documentation and modules becomes a test failure,
  not a silent divergence;
- future persisted-record identifiers follow the same family shape
  (`clapp_<domain>_` + 16 hex) unless a dedicated ADR argues otherwise.

## Rejected alternatives

- Moving the prefix constants into `packages/clapp-contracts` — rejected:
  this would touch a frozen tier and force a contracts version bump for a
  documentation-scale decision; the modules already export the constants.
- 32- or 40-hex prefixes — rejected: no collision-analysis need at current
  corpus scale, and 16 hex is already the uniform family convention; changing
  length per family would fragment the discipline.
- Deriving ids from wall-clock time or sequence numbers — rejected:
  content addressing is what makes repair, promotion, and authorization
  records reproducible across re-runs.
