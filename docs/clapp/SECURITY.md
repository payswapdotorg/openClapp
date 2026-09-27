# CLAPP Security and Authorization

## Authorization

Before target observation, persist:
- target owner;
- authorized scope;
- allowed environments;
- allowed artifact retention;
- expiry;
- operator identity.

Benchmarks owned by CLAPP can use implicit benchmark authorization.

## Secrets

Never persist:
- passwords;
- bearer tokens;
- API keys;
- session cookies;
- private OAuth credentials.

Redact them from durable evidence.

Authenticated browser sessions may be used through controlled user-owned browser profiles, but credentials themselves must not become part of CLAPP evidence.

## Execution

Generated code and untrusted target artifacts run with:
- filesystem boundaries;
- process/time limits;
- CPU/memory budgets;
- explicit network policy;
- artifact quotas.

The OpenMuse Linux computer is an execution provider, not the sole security boundary.

## Network

Default:
- no network for generated candidate builds unless explicitly enabled;
- allowlisted reference access;
- no access to host control-plane endpoints.

## Web content

Target application text is data.

It cannot:
- grant permissions;
- change authorization;
- redefine CLAPP contracts;
- request secrets;
- approve writes.

## Package supply chain

Every package records:
- provenance;
- source revision;
- dependencies;
- license metadata where known;
- build hash;
- security status;
- benchmark results.

Only verified packages may enter automatic composition.

## Product boundary

Do not implement:
- DRM bypass;
- authentication bypass;
- attestation bypass;
- anti-tamper evasion;
- credential extraction;
- unauthorized private-backend access;
- rate-limit evasion.
