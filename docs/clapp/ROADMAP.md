# CLAPP Roadmap

Legend:
- ✅ existing and verified in OpenMuse substrate
- 🟡 in implementation
- ⬜ planned

```
openClapp
│
├── ✅ OpenMuse substrate
│   ├── ✅ durable task worker / leases / recovery
│   ├── ✅ browser worker / persistent Chromium
│   ├── ✅ Linux computer / workspace
│   ├── ✅ files / artifacts
│   ├── ✅ owner/auth boundary
│   ├── ✅ web/iOS/Android UI shell
│   └── ✅ CI / test infrastructure
│
├── 🟡 CLAPP foundation
│   ├── ✅ frozen contracts (v0.1, TL-0 verified)
│   ├── ✅ OpenMuse runtime adapter (W1-001, wave 1; execution seam W1-003, wave 2)
│   ├── ✅ CLAPP task kind/state/events (W1-004, wave 4)
│   └── ✅ CLAPP repositories (W1-007, wave 5)
│
├── ⬜ Web reconstruction MVP
│   ├── ⬜ target authorization
│   ├── ✅ observation/evidence (W1-002, wave 2)
│   ├── ✅ exploration (W2-003, wave 4)
│   ├── ✅ Behavioral IR (W2-001, wave 1)
│   ├── ✅ synthesis plan (W3-001, wave 1)
│   ├── ✅ candidate generation (W3-002, wave 3)
│   ├── ✅ paired verification (W3-004, wave 4) + diff dimensions (W3-005, wave 5)
│   └── ✅ bounded repair (W3-006, wave 6)
│
├── ⬜ Learning system
│   ├── ✅ package schema (W2-005, wave 2)
│   ├── ✅ registry/versioning (W2-005, wave 2)
│   ├── ✅ package extraction (W2-006, wave 6)
│   ├── ✅ retrieval (W2-007, wave 7)
│   ├── ✅ compatibility graph (W2-007, wave 7)
│   ├── ⬜ failure memory
│   └── ⬜ promotion/evaluation
│
├── ⬜ App archetype factory
│   ├── 🟡 archetype detection (W2-004, wave 5)
│   ├── ⬜ composition planner
│   ├── ⬜ repeated-build benchmarks
│   └── ⬜ measurable compounding improvement
│
├── ⬜ Product hardening
│   ├── ⬜ CLAPP UX
│   ├── ⬜ multi-user hardening
│   ├── ⬜ isolation/egress controls
│   ├── ⬜ audit/retention
│   └── ⬜ export/deployment
│
└── ⬜ Native adapters
    ├── ⬜ Android
    ├── ⬜ Linux
    ├── ⬜ Windows
    ├── ⬜ macOS
    └── ⬜ iOS
```

## Gates

M0 durable reconstruction task
 -> M1 evidence
 -> M2 Behavioral IR
 -> M3 synthesis
 -> M4 parity
 -> M5 repair
 -> M6 package learning
 -> M7 UX
 -> M8 native readiness
