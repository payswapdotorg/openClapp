import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  BehavioralIr,
  ReconstructionSpec,
  SynthesisPlan,
} from "../packages/clapp-contracts/src/index.ts";
import {
  deserializeSynthesisPlan,
  type PlanComponent,
  type PlanRoute,
  planSynthesisApp,
  serializeSynthesisPlan,
  validateSynthesisPlan,
} from "../packages/clapp-synthesis/src/index.ts";

function makeSpec(): ReconstructionSpec {
  return {
    specVersion: "0.1",
    reconstructionId: "rc-w3-0001",
    targetId: "target-w3-0001",
    name: "W3 Fixture Application",
    platform: "web",
    entrypoints: ["/"],
    authorization: {
      ownerId: "owner-1",
      targetId: "target-w3-0001",
      scope: ["reconstruct:ui"],
      environments: ["sandbox"],
      retention: "project",
      benchmarkOwned: true,
      createdAt: "2025-01-01T00:00:00.000Z",
    },
    exploration: { maxStages: 4, maxActions: 64, maxDurationMs: 300000, seed: 42 },
    synthesis: { targetStack: "static-web", allowNetwork: false, packagePolicy: "verified-only" },
    verification: {
      journeys: ["j-login", "j-search"],
      visual: true,
      network: false,
      state: true,
      maxRepairIterations: 2,
    },
  };
}

function makeModel(): BehavioralIr {
  return {
    schemaVersion: "0.1",
    application: {
      id: "app-w3-0001",
      name: "W3 Fixture Application",
      platform: "web",
      entrypoints: ["/"],
    },
    evidence: [
      {
        id: "ev-w3-0001",
        targetId: "target-w3-0001",
        reconstructionId: "rc-w3-0001",
        kind: "screenshot",
        sha256: "0000000000000000000000000000000000000000000000000000000000000000",
        source: "explorer",
        capturedAt: "2025-01-02T00:00:00.000Z",
        classification: "observed",
        redacted: false,
      },
    ],
    journeys: [
      {
        id: "j-login",
        name: "Sign in",
        preconditions: ["signed out"],
        steps: [
          { id: "s-login-1", action: "fill", target: "#username", input: { value: "alice" } },
          { id: "s-login-2", action: "click", target: "#submit" },
        ],
      },
      {
        id: "j-search",
        name: "Search",
        preconditions: ["signed in"],
        steps: [{ id: "s-search-1", action: "fill", target: "#query" }],
      },
      { id: "j-logout", name: "Sign out", preconditions: [], steps: [] },
    ],
    screens: [
      { id: "screen-home", title: "Home" },
      { id: "screen-login", title: "Sign in" },
    ],
    components: [
      { kind: "form", name: "login-form" },
      { kind: "input", name: "query" },
    ],
    state: { session: { signedIn: false, user: null }, ui: { theme: "light" } },
    data: {
      users: [{ id: "u-1", name: "alice" }],
      notes: [{ id: "n-1", ownerId: "u-1" }],
    },
    api: { endpoints: [{ method: "GET", path: "/api/users" }] },
    integrations: [{ kind: "oauth", provider: "example" }],
    assumptions: [{ source: "explore", note: "theme toggle unobserved" }],
    constraints: [{ kind: "platform", note: "no-webrtc" }],
  };
}

/** Deep-copies a value while reversing the key-insertion order of every object. */
function reverseKeyOrder(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((element) => reverseKeyOrder(element));
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const reversed: Record<string, unknown> = {};
    for (const key of Object.keys(record).reverse()) {
      reversed[key] = reverseKeyOrder(record[key]);
    }
    return reversed;
  }
  return value;
}

function derivedAssumptionsOf(plan: SynthesisPlan): Array<Record<string, unknown>> {
  return plan.assumptions.filter((entry) => {
    const source = entry.source;
    return typeof source === "string" && source === "synthesis";
  });
}

test("planning is deterministic", async () => {
  const packageIds = ["pkg-a", "pkg-b"];
  const specA = makeSpec();
  const modelA = makeModel();
  const specB = reverseKeyOrder(makeSpec()) as ReconstructionSpec;
  const modelB = reverseKeyOrder(makeModel()) as BehavioralIr;

  // Sanity: identical values, different key-insertion order.
  assert.deepStrictEqual(specA, specB);
  assert.deepStrictEqual(modelA, modelB);

  const planA = await planSynthesisApp(specA, modelA, [...packageIds]);
  const planB = await planSynthesisApp(specB, modelB, [...packageIds]);

  assert.deepStrictEqual(planA, planB);
  assert.strictEqual(serializeSynthesisPlan(planA), serializeSynthesisPlan(planB));
  assert.strictEqual(serializeSynthesisPlan(planA), serializeSynthesisPlan(planA));
});

test("journeys map to routes", async () => {
  const plan = await planSynthesisApp(makeSpec(), makeModel(), ["pkg-a"]);
  const routes = plan.routes as PlanRoute[];
  assert.equal(routes.length, 3);
  const byJourneyId = new Map(routes.map((route) => [route.journeyId, route]));
  assert.equal(byJourneyId.get("j-login")?.steps, 2);
  assert.equal(byJourneyId.get("j-search")?.steps, 1);
  assert.equal(byJourneyId.get("j-logout")?.steps, 0);
  assert.equal(byJourneyId.get("j-login")?.name, "Sign in");
});

test("input purity", async () => {
  const spec = makeSpec();
  const model = makeModel();
  const specSnapshot = structuredClone(spec);
  const modelSnapshot = structuredClone(model);

  const plan = await planSynthesisApp(spec, model, ["pkg-a"]);

  // Mutating the derived plan must never leak into the inputs.
  plan.state.injected = true;
  (plan.components[0] as PlanComponent).definition.injected = true;
  plan.persistence[0].key = "mutated";

  assert.deepStrictEqual(spec, specSnapshot);
  assert.deepStrictEqual(model, modelSnapshot);
});

test("missing acceptance journeys become assumptions", async () => {
  const spec = makeSpec();
  spec.verification.journeys = ["j-login", "j-missing", "j-search", "j-missing"];
  const plan = await planSynthesisApp(spec, makeModel(), ["pkg-a"]);

  assert.deepEqual(plan.acceptanceJourneyIds, ["j-login", "j-search"]);

  const derived = derivedAssumptionsOf(plan);
  const missing = derived.filter((entry) => {
    const reason = entry.reason;
    return typeof reason === "string" && reason.includes("j-missing");
  });
  assert.equal(missing.length, 1);
  const path = String(missing[0]?.path);
  assert.ok(path.startsWith("spec.verification.journeys"), path);
});

test("packageIds are filtered, not invented", async () => {
  const rawPackageIds = ["pkg-a", "pkg-b", "pkg-a", "", "pkg-c", 42 as unknown as string, "pkg-b"];
  const plan = await planSynthesisApp(makeSpec(), makeModel(), rawPackageIds);
  assert.deepEqual(plan.packageIds, ["pkg-a", "pkg-b", "pkg-c"]);
});

test("empty api/data/packageIds produce explicit assumptions", async () => {
  const model = makeModel();
  model.api = {};
  model.data = {};
  const plan = await planSynthesisApp(makeSpec(), model, []);

  assert.deepEqual(plan.api, []);
  assert.deepEqual(plan.persistence, []);
  assert.deepEqual(plan.packageIds, []);

  const derived = derivedAssumptionsOf(plan);
  const paths = derived.map((entry) => String(entry.path));
  assert.equal(derived.length, 3);
  assert.ok(paths.includes("model.api"));
  assert.ok(paths.includes("model.data"));
  assert.ok(paths.includes("packageIds"));
});

test("validation catches structural breaks with paths", async () => {
  const valid = await planSynthesisApp(makeSpec(), makeModel(), ["pkg-a", "pkg-b"]);
  assert.equal(validateSynthesisPlan(valid).ok, true);

  type Mutation = { name: string; expectedPath: string; apply: (plan: SynthesisPlan) => void };
  const mutations: Mutation[] = [
    {
      name: "wrong schemaVersion",
      expectedPath: "$.schemaVersion",
      apply: (plan) => {
        plan.schemaVersion = "0.2";
      },
    },
    {
      name: "missing routes",
      expectedPath: "$.routes",
      apply: (plan) => {
        plan.routes = undefined as unknown as SynthesisPlan["routes"];
      },
    },
    {
      name: "non-array routes",
      expectedPath: "$.routes",
      apply: (plan) => {
        plan.routes = {} as unknown as SynthesisPlan["routes"];
      },
    },
    {
      name: "non-object route element",
      expectedPath: "$.routes[2]",
      apply: (plan) => {
        plan.routes[2] = "junk" as unknown as SynthesisPlan["routes"][number];
      },
    },
    {
      name: "negative route step count",
      expectedPath: "$.routes[0].steps",
      apply: (plan) => {
        plan.routes[0].steps = -1;
      },
    },
    {
      name: "empty route journeyId",
      expectedPath: "$.routes[0].journeyId",
      apply: (plan) => {
        plan.routes[0].journeyId = "";
      },
    },
    {
      name: "non-array components",
      expectedPath: "$.components",
      apply: (plan) => {
        plan.components = "nope" as unknown as SynthesisPlan["components"];
      },
    },
    {
      name: "empty component id",
      expectedPath: "$.components[0].componentId",
      apply: (plan) => {
        plan.components[0].componentId = "";
      },
    },
    {
      name: "array component definition",
      expectedPath: "$.components[1].definition",
      apply: (plan) => {
        plan.components[1].definition = [];
      },
    },
    {
      name: "array state",
      expectedPath: "$.state",
      apply: (plan) => {
        plan.state = [] as unknown as SynthesisPlan["state"];
      },
    },
    {
      name: "non-array persistence",
      expectedPath: "$.persistence",
      apply: (plan) => {
        plan.persistence = "x" as unknown as SynthesisPlan["persistence"];
      },
    },
    {
      name: "non-string persistence key",
      expectedPath: "$.persistence[0].key",
      apply: (plan) => {
        plan.persistence[0].key = 7;
      },
    },
    {
      name: "non-array integrations",
      expectedPath: "$.integrations",
      apply: (plan) => {
        plan.integrations = {} as unknown as SynthesisPlan["integrations"];
      },
    },
    {
      name: "non-array api",
      expectedPath: "$.api",
      apply: (plan) => {
        plan.api = 3 as unknown as SynthesisPlan["api"];
      },
    },
    {
      name: "duplicate packageIds",
      expectedPath: "$.packageIds",
      apply: (plan) => {
        plan.packageIds = ["pkg-a", "pkg-a"];
      },
    },
    {
      name: "non-string packageIds",
      expectedPath: "$.packageIds",
      apply: (plan) => {
        plan.packageIds = "pkg-a" as unknown as SynthesisPlan["packageIds"];
      },
    },
    {
      name: "non-array acceptanceJourneyIds",
      expectedPath: "$.acceptanceJourneyIds",
      apply: (plan) => {
        plan.acceptanceJourneyIds = 42 as unknown as SynthesisPlan["acceptanceJourneyIds"];
      },
    },
    {
      name: "acceptance journey without a route",
      expectedPath: "$.acceptanceJourneyIds[0]",
      apply: (plan) => {
        plan.acceptanceJourneyIds = ["j-ghost"];
      },
    },
    {
      name: "null assumptions",
      expectedPath: "$.assumptions",
      apply: (plan) => {
        plan.assumptions = null as unknown as SynthesisPlan["assumptions"];
      },
    },
    {
      name: "null architecture",
      expectedPath: "$.architecture",
      apply: (plan) => {
        plan.architecture = null as unknown as SynthesisPlan["architecture"];
      },
    },
  ];

  for (const mutation of mutations) {
    const broken = structuredClone(valid);
    mutation.apply(broken);
    const result = validateSynthesisPlan(broken);
    assert.equal(result.ok, false, `${mutation.name} should not validate`);
    assert.ok(
      result.errors.some((error) => error.includes(mutation.expectedPath)),
      `${mutation.name}: expected an error at ${mutation.expectedPath}, got: ${result.errors.join("; ")}`,
    );
  }

  // Non-plan inputs never throw and always report the root path.
  for (const badInput of [null, undefined, 42, "plan", [], true]) {
    const result = validateSynthesisPlan(badInput);
    assert.equal(result.ok, false);
    assert.equal(result.errors.length > 0, true);
    assert.ok(result.errors.every((error) => error.startsWith("$")));
  }
});

test("serialization round-trip", async () => {
  const plan = await planSynthesisApp(makeSpec(), makeModel(), ["pkg-a", "pkg-b"]);

  const text = serializeSynthesisPlan(plan);
  assert.equal(serializeSynthesisPlan(plan), text);

  // Canonical form: top-level keys are alphabetically sorted.
  const topLevelKeys = Object.keys(JSON.parse(text));
  assert.deepEqual(topLevelKeys, [...topLevelKeys].sort());

  const roundTrip = deserializeSynthesisPlan(text);
  assert.equal(roundTrip.ok, true, roundTrip.errors.join("; "));
  assert.deepStrictEqual(roundTrip.plan, plan);

  const invalidJson = deserializeSynthesisPlan("{not json");
  assert.equal(invalidJson.ok, false);
  assert.ok(invalidJson.errors.some((error) => error.includes("invalid JSON")));

  const invalidPlan = deserializeSynthesisPlan('{"schemaVersion":"0.2"}');
  assert.equal(invalidPlan.ok, false);
  assert.ok(invalidPlan.errors.some((error) => error.includes("$.routes")));
});
