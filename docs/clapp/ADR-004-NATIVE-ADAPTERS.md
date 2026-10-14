# ADR-004: Native platform adapters (v0.1 contract freeze)

Status: ACCEPTED (tech-lead freeze, 2026-10-14)
Scope: the roadmap's final ⬜ block — native adapters for Android, Linux,
Windows, macOS, iOS.
Precedent: the five-component adapter architecture proven in the public
reference repo `payswapdotorg/clapp` (phase 8, `packages/android|linux|
windows|macos|ios`); this ADR transplants that pattern onto the openClapp
seam style (duck-typed host seams, fail-closed validation, honest refusal,
content-addressed ids).

## Decision

Five new packages, one per platform:

- `packages/clapp-native-android`
- `packages/clapp-native-linux`
- `packages/clapp-native-windows`
- `packages/clapp-native-macos`
- `packages/clapp-native-ios`

Each implements the SAME five-component v0.1 contract, consumed through
`@clapp/contracts` only. No adapter imports `@clapp/intelligence`,
`@clapp/synthesis`, `@clapp/runtime-openmuse`, or any `apps/**` module —
the no-fork law, pinned by an import-discipline test in every package.

## The five components (per platform)

1. **Environment descriptor** (`src/environment.ts`) — the platform facts
   as a frozen v0.1 vocabulary with a fail-closed validator. The vocabulary
   is platform-specific and frozen at v0.1 per package:
   - android: `apiLevel` (non-negative int), `uiTestFramework`
     (`uiautomator | espresso | none`), packaging
     (`apk | aab | zip`);
   - linux: `displayServer` (`x11 | wayland | none`), `accessibilityBus`
     (`at-spi | none`), packaging (`appimage | deb | flatpak | tar | zip`);
   - windows: `uiAccessProvider` (`uia | none`), packaging
     (`msi | exe | zip`);
   - macos: `accessibilityFramework` (`ax | none`), packaging
     (`app | dmg | pkg | zip`);
   - ios: `uiTestFramework` (`xcuitest | none`), packaging
     (`ipa | app | xcarchive | dSYM | zip`).
   `none` is a VALID descriptor — the honest-absent state; its observation
   component refuses with a typed named error and never calls the host.

2. **Observation adapter** (`src/observation.ts`) — the platform's
   observation law: a structured element-tree snapshot over the duck-typed
   host seam (`Observe<Platform>Screen`-style structural interface:
   the host provides the framework's element tree). A `none` framework
   refuses with a typed error, host never called. The snapshot is
   MEASURED (digest derived from the host's own payload); the adapter
   never derives, upgrades, or fabricates.

3. **Evidence emitter** (`src/evidence.ts`) — `EvidenceRef`-shaped records
   (TYPE-ONLY alignment with `@clapp/contracts`), deterministic
   content-derived ids with a per-platform prefix:
   `ndev_` (android), `lidev_` (linux), `wdev_` (windows), `mdev_`
   (macos), `idev_` (ios) + the digest hex. Classification is the honest
   one (`observed` only for what the host actually produced).

4. **Synthesis target** (`src/synthesis-target.ts`) — the platform's
   deployable artifact descriptor over the frozen packaging vocabulary,
   fail-closed validator, sorted/deduped identifier lists.

5. **Verification adapter** (`src/verification.ts`) — the duck-typed
   journey-runner seam: the host runs a journey; counts are MEASURED,
   failure reasons are carried VERBATIM, and the adapter NEVER constructs
   a parity/verdict record (that belongs to the diff discipline, a later
   consumer).

## Hard rules (binding on all five lanes)

- Fail-closed everywhere: malformed input → a typed named error; nothing
  partial, nothing defaulted, nothing fabricated.
- Duck-typed host seams: adapters bind untyped host handles through narrow
  structural interfaces validated at bind time. No production host is
  bound in-repo (composition is a later TL wave).
- Determinism: pure functions over caller-supplied facts; ids
  content-addressed; no wall-clock, no randomness, no network.
- One package per lane; tests at repo root (`tests/clapp-native-
  <platform>.test.ts`), node:test + `tsx`, ~8 named tests including the
  import-discipline pin.
- Lockfile: workers may run `pnpm install` locally (the `packages/*` glob
  registers the new package) but leave `pnpm-lock.yaml` drift UNCOMMITTED
  — the workspace/lock regen is a TL integration step, exactly as the
  reference repo's integration history shows.
- Contract version: `CLAPP_NATIVE_<PLATFORM>_VERSION = '0.1'` per package,
  frozen at landing.

## Consequences

- The five lanes are fully parallel: each depends only on this ADR and the
  frozen `@clapp/contracts` v0.1 surface.
- Native reconstruction (observe→IR→synthesis→parity on a native target)
  remains a future composition wave; these adapters land the frozen
  per-platform seams it will compose.
- The roadmap's Native adapters block flips ✅ only when all five are
  integrated.
