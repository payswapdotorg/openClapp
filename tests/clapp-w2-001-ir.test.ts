import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { BehavioralIr } from "../packages/clapp-contracts/src/index.ts";
import {
  deserializeBehavioralIr,
  diffBehavioralIr,
  serializeBehavioralIr,
  validateBehavioralIr,
} from "../packages/clapp-intelligence/src/index.ts";

function record(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

function records(value: unknown): Record<string, unknown>[] {
  return value as Record<string, unknown>[];
}

function toIr(value: unknown): BehavioralIr {
  return value as BehavioralIr;
}

function evidenceRef(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "ev-1",
    targetId: "target-1",
    reconstructionId: "rec-1",
    kind: "dom-snapshot",
    sha256: "a".repeat(64),
    source: "browser-worker",
    capturedAt: "2024-05-01T00:00:00.000Z",
    classification: "observed",
    redacted: false,
    ...overrides,
  };
}

function step(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: "s1", action: "click", target: "button.submit", ...overrides };
}

function journey(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "login",
    name: "Login",
    preconditions: ["signed out"],
    steps: [step()],
    ...overrides,
  };
}

function behavioralIr(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "0.1",
    application: { id: "app-1", name: "Demo App", platform: "web", entrypoints: ["/"] },
    evidence: [evidenceRef()],
    journeys: [journey()],
    screens: [{ id: "screen-home", title: "Home" }],
    components: [{ id: "button-submit", role: "button" }],
    state: { session: { signedIn: false } },
    data: { records: [] },
    api: { baseUrl: "/api" },
    integrations: [],
    assumptions: [],
    constraints: [],
    ...overrides,
  };
}

function expectErrorAt(result: { ok: boolean; errors: string[] }, path: string): string {
  assert.equal(result.ok, false, `mutation at ${path} must invalidate the IR`);
  const match = result.errors.find((error) => error.startsWith(`${path}:`));
  assert.ok(
    match !== undefined,
    `expected an error starting with "${path}:", got: ${result.errors.join(" | ")}`,
  );
  return match;
}

test("valid minimal IR passes validation", () => {
  const minimal = behavioralIr({
    screens: [],
    components: [],
    state: {},
    data: {},
    api: {},
    integrations: [],
    assumptions: [],
    constraints: [],
  });
  const result = validateBehavioralIr(minimal);
  assert.deepEqual(result, { ok: true, errors: [] });
});

test("each invalid mutation is caught with the correct path", () => {
  interface MutationCase {
    path: string;
    mutate: (ir: Record<string, unknown>) => void;
    exact?: string;
  }
  const cases: MutationCase[] = [
    {
      path: "evidence[0].sha256",
      mutate: (ir) => {
        records(ir.evidence)[0].sha256 = "not-hex";
      },
      exact: "evidence[0].sha256: must be 64 lowercase hex characters, got a string of length 7",
    },
    {
      path: "evidence[0].sha256",
      mutate: (ir) => {
        records(ir.evidence)[0].sha256 = "A".repeat(64);
      },
    },
    {
      path: "evidence[0].classification",
      mutate: (ir) => {
        records(ir.evidence)[0].classification = "guessed";
      },
    },
    {
      path: "evidence[0].source",
      mutate: (ir) => {
        records(ir.evidence)[0].source = "";
      },
    },
    {
      path: "evidence[0].redacted",
      mutate: (ir) => {
        records(ir.evidence)[0].redacted = "yes";
      },
    },
    {
      path: "evidence[0].capturedAt",
      mutate: (ir) => {
        delete records(ir.evidence)[0].capturedAt;
      },
    },
    {
      path: "evidence[1].id",
      mutate: (ir) => {
        ir.evidence = [evidenceRef(), evidenceRef()];
      },
    },
    {
      path: "journeys[1].id",
      mutate: (ir) => {
        ir.journeys = [journey(), journey()];
      },
    },
    {
      path: "journeys[0].steps[1].id",
      mutate: (ir) => {
        records(ir.journeys)[0].steps = [step(), step()];
      },
    },
    {
      path: "journeys[0].steps[0].action",
      mutate: (ir) => {
        (records(records(ir.journeys)[0].steps)[0] as Record<string, unknown>).action = "";
      },
    },
    {
      path: "journeys[0].steps[0].id",
      mutate: (ir) => {
        (records(records(ir.journeys)[0].steps)[0] as Record<string, unknown>).id = "";
      },
      exact: "journeys[0].steps[0].id: must be a non-empty string",
    },
    {
      path: "application.name",
      mutate: (ir) => {
        delete record(ir.application).name;
      },
    },
    {
      path: "application.platform",
      mutate: (ir) => {
        record(ir.application).platform = "plan9";
      },
    },
    {
      path: "application.entrypoints[1]",
      mutate: (ir) => {
        record(ir.application).entrypoints = ["/", 42];
      },
    },
    {
      path: "schemaVersion",
      mutate: (ir) => {
        ir.schemaVersion = "0.2";
      },
    },
    {
      path: "state",
      mutate: (ir) => {
        ir.state = [];
      },
    },
    {
      path: "journeys",
      mutate: (ir) => {
        ir.journeys = "none";
      },
    },
    {
      path: "screens[0]",
      mutate: (ir) => {
        records(ir.screens)[0] = [] as unknown as Record<string, unknown>;
      },
    },
    {
      path: "state.session.token",
      mutate: (ir) => {
        record(record(ir.state).session).token = () => {};
      },
    },
    {
      path: "data.size",
      mutate: (ir) => {
        record(ir.data).size = BigInt(7);
      },
    },
    {
      path: "api.latency",
      mutate: (ir) => {
        record(ir.api).latency = Number.NaN;
      },
    },
    {
      path: "state.session.loop.self",
      mutate: (ir) => {
        const loop: Record<string, unknown> = {};
        loop.self = loop;
        record(record(ir.state).session).loop = loop;
      },
    },
  ];
  for (const { path, mutate, exact } of cases) {
    const ir = behavioralIr();
    mutate(ir);
    const result = validateBehavioralIr(ir);
    const error = expectErrorAt(result, path);
    if (exact !== undefined) {
      assert.equal(error, exact);
    }
  }
});

test("validation never throws", () => {
  const deepJunk: Record<string, unknown> = {};
  let cursor: Record<string, unknown> = deepJunk;
  for (let depth = 0; depth < 500; depth += 1) {
    cursor.child = {};
    cursor = cursor.child as Record<string, unknown>;
  }
  const cyclic: Record<string, unknown> = { schemaVersion: "0.1" };
  cyclic.self = cyclic;
  const cyclicArray: unknown[] = [];
  cyclicArray.push(cyclicArray);
  const mutualA: Record<string, unknown> = {};
  const mutualB: Record<string, unknown> = { a: mutualA };
  mutualA.b = mutualB;
  const hostileInputs: unknown[] = [
    null,
    undefined,
    42,
    Number.POSITIVE_INFINITY,
    "",
    "behavioral-ir",
    true,
    Symbol("ir"),
    BigInt(9),
    () => {},
    [],
    [[]],
    [null, 1, "mixed"],
    new Date(),
    new Map(),
    new Set([1]),
    { schemaVersion: "0.1" },
    Object.assign(Object.create(null), { schemaVersion: "0.1" }),
    deepJunk,
    cyclic,
    { state: { cycle: cyclicArray } },
    { state: { mutualA, mutualB } },
    { evidence: [{ id: "ev-1" }] },
    { journeys: [{ id: "j1", steps: [{ id: "s1" }] }] },
  ];
  for (const input of hostileInputs) {
    let result: { ok: boolean; errors: string[] } | undefined;
    assert.doesNotThrow(() => {
      result = validateBehavioralIr(input);
    });
    assert.ok(result !== undefined, "validator must return a result");
    assert.equal(typeof result.ok, "boolean");
    assert.ok(Array.isArray(result.errors));
    assert.ok(result.errors.every((error) => typeof error === "string" && error.length > 0));
  }
  const cyclicResult = validateBehavioralIr(cyclic);
  assert.equal(cyclicResult.ok, false);
  assert.ok(
    cyclicResult.errors.some((error) => error.startsWith("self.self:")),
    `expected a cyclic-reference error at self.self, got: ${cyclicResult.errors.join(" | ")}`,
  );
  const deepResult = validateBehavioralIr(behavioralIr({ state: deepJunk }));
  assert.equal(deepResult.ok, true, "500-level deep plain JSON state must stay valid");
});

test("serialization is canonical", () => {
  const canonical = behavioralIr();
  const reordered = {
    constraints: [],
    assumptions: [],
    integrations: [],
    api: { baseUrl: "/api" },
    data: { records: [] },
    state: { session: { signedIn: false } },
    components: [{ role: "button", id: "button-submit" }],
    screens: [{ title: "Home", id: "screen-home" }],
    journeys: [
      {
        steps: [{ target: "button.submit", action: "click", id: "s1" }],
        preconditions: ["signed out"],
        name: "Login",
        id: "login",
      },
    ],
    evidence: [
      {
        redacted: false,
        classification: "observed",
        capturedAt: "2024-05-01T00:00:00.000Z",
        source: "browser-worker",
        sha256: "a".repeat(64),
        kind: "dom-snapshot",
        reconstructionId: "rec-1",
        targetId: "target-1",
        id: "ev-1",
      },
    ],
    application: { entrypoints: ["/"], platform: "web", name: "Demo App", id: "app-1" },
    schemaVersion: "0.1",
  };
  const first = serializeBehavioralIr(toIr(canonical));
  const second = serializeBehavioralIr(toIr(reordered));
  assert.equal(first, second, "key insertion order must not affect the canonical output");
  assert.equal(first, serializeBehavioralIr(toIr(behavioralIr())));

  const roundTripped = deserializeBehavioralIr(first);
  assert.equal(roundTripped.ok, true);
  assert.ok(roundTripped.ir);
  assert.equal(
    serializeBehavioralIr(roundTripped.ir),
    first,
    "re-serialization must be a fixed point",
  );

  const screensReordered = behavioralIr({
    screens: [
      { id: "screen-a", title: "A" },
      { id: "screen-b", title: "B" },
    ],
  });
  const screensShuffled = behavioralIr({
    screens: [
      { title: "B", id: "screen-b" },
      { title: "A", id: "screen-a" },
    ],
  });
  assert.equal(
    serializeBehavioralIr(toIr(screensReordered)),
    serializeBehavioralIr(toIr(screensShuffled)),
    "keyless-map arrays (screens) must be content-sorted",
  );

  const journeysAb = behavioralIr({ journeys: [journey({ id: "j-a" }), journey({ id: "j-b" })] });
  const journeysBa = behavioralIr({ journeys: [journey({ id: "j-b" }), journey({ id: "j-a" })] });
  assert.notEqual(
    serializeBehavioralIr(toIr(journeysAb)),
    serializeBehavioralIr(toIr(journeysBa)),
    "journey order is semantic and must be preserved",
  );

  const stepsAb = behavioralIr({
    journeys: [journey({ steps: [step({ id: "s1" }), step({ id: "s2", action: "type" })] })],
  });
  const stepsBa = behavioralIr({
    journeys: [journey({ steps: [step({ id: "s2", action: "type" }), step({ id: "s1" })] })],
  });
  assert.notEqual(
    serializeBehavioralIr(toIr(stepsAb)),
    serializeBehavioralIr(toIr(stepsBa)),
    "step order is semantic and must be preserved",
  );
});

test("deserialize round-trip", () => {
  const ir = toIr(behavioralIr());
  const text = serializeBehavioralIr(ir);
  const result = deserializeBehavioralIr(text);
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.ok(result.ir);
  assert.deepEqual(result.ir, ir);

  const invalidJson = deserializeBehavioralIr("{ not json");
  assert.equal(invalidJson.ok, false);
  assert.equal(invalidJson.errors.length, 1);
  assert.match(invalidJson.errors[0] ?? "", /^\$: invalid JSON \(.+\)$/);

  const empty = deserializeBehavioralIr("");
  assert.equal(empty.ok, false);
  assert.match(empty.errors[0] ?? "", /invalid JSON/);

  const invalidIr = deserializeBehavioralIr(
    JSON.stringify({ schemaVersion: "0.9", application: {} }),
  );
  assert.equal(invalidIr.ok, false);
  assert.ok(invalidIr.errors.some((error) => error.startsWith("schemaVersion:")));
  assert.ok(invalidIr.errors.some((error) => error.startsWith("application.id:")));

  const root = deserializeBehavioralIr("null");
  assert.equal(root.ok, false);
  assert.equal(root.errors[0], "$: must be a Behavioral IR object, got null");
});

test("diff is deterministic and path-addressed", () => {
  const ir = toIr(behavioralIr());
  const sameContent = toIr(behavioralIr());

  assert.deepEqual(diffBehavioralIr(ir, ir), []);
  assert.deepEqual(diffBehavioralIr(ir, sameContent), []);

  const changedAction = toIr(
    behavioralIr({
      journeys: [
        journey({
          steps: [step({ action: "type" })],
        }),
      ],
    }),
  );
  const actionFindings = diffBehavioralIr(ir, changedAction);
  assert.deepEqual(actionFindings, [
    {
      path: "journeys[login].steps[s1].action",
      kind: "changed",
      detail: 'changed: "click" -> "type"',
    },
  ]);
  assert.deepEqual(diffBehavioralIr(ir, changedAction), actionFindings, "diff must be stable");

  const withAddedJourney = toIr(
    behavioralIr({
      journeys: [journey(), journey({ id: "signup", name: "Signup" })],
    }),
  );
  assert.deepEqual(diffBehavioralIr(ir, withAddedJourney), [
    { path: "journeys[signup]", kind: "added", detail: 'journey added (name: "Signup")' },
  ]);

  const withRemovedJourney = toIr(behavioralIr({ journeys: [] }));
  assert.deepEqual(diffBehavioralIr(ir, withRemovedJourney), [
    { path: "journeys[login]", kind: "removed", detail: 'journey removed (name: "Login")' },
  ]);

  const withAddedEvidence = toIr(
    behavioralIr({
      evidence: [evidenceRef(), evidenceRef({ id: "ev-2", kind: "network-log" })],
    }),
  );
  assert.deepEqual(diffBehavioralIr(ir, withAddedEvidence), [
    { path: "evidence[ev-2]", kind: "added", detail: 'evidence ref added (kind: "network-log")' },
  ]);

  const withChangedEvidence = toIr(
    behavioralIr({ evidence: [evidenceRef({ sha256: "b".repeat(64) })] }),
  );
  assert.deepEqual(diffBehavioralIr(ir, withChangedEvidence), [
    {
      path: "evidence[ev-1].sha256",
      kind: "changed",
      detail: `changed: "${"a".repeat(64)}" -> "${"b".repeat(64)}"`,
    },
  ]);

  const withStateAddition = toIr(
    behavioralIr({ state: { session: { signedIn: false }, theme: "dark" } }),
  );
  assert.deepEqual(diffBehavioralIr(ir, withStateAddition), [
    { path: "state.theme", kind: "added", detail: 'added: "dark"' },
  ]);

  const withChangedScreen = toIr(
    behavioralIr({ screens: [{ id: "screen-home", title: "Home v2" }] }),
  );
  const screenFindings = diffBehavioralIr(ir, withChangedScreen);
  assert.equal(screenFindings.length, 2);
  assert.deepEqual(screenFindings.map((finding) => finding.kind).sort(), ["added", "removed"]);
  for (const finding of screenFindings) {
    assert.match(finding.path, /^screens\[sha256:[0-9a-f]{64}\]$/);
  }

  const withMovedStep = toIr(
    behavioralIr({
      journeys: [journey({ steps: [step({ id: "s2", action: "wait" }), step()] })],
    }),
  );
  assert.deepEqual(diffBehavioralIr(ir, withMovedStep), [
    {
      path: "journeys[login].steps[s1]",
      kind: "changed",
      detail: "step moved from index 0 to 1",
    },
    {
      path: "journeys[login].steps[s2]",
      kind: "added",
      detail: 'step added (action: "wait")',
    },
  ]);

  const multiChange = toIr(
    behavioralIr({
      schemaVersion: "0.1",
      application: { id: "app-2", name: "Demo App", platform: "web", entrypoints: ["/"] },
      state: { session: { signedIn: true } },
    }),
  );
  const multiFindings = diffBehavioralIr(ir, multiChange);
  assert.deepEqual(
    multiFindings.map((finding) => `${finding.path}:${finding.kind}`),
    ["application.id:changed", "state.session.signedIn:changed"],
  );
  const paths = multiFindings.map((finding) => finding.path);
  assert.deepEqual([...paths].sort(), paths, "findings must be sorted by path");
});

interface SchemaNode {
  type?: string;
  required?: string[];
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  enum?: unknown[];
  additionalProperties?: boolean;
}

function checkAgainstSchema(
  value: unknown,
  schema: SchemaNode,
  path: string,
  errors: string[],
): void {
  if (schema.enum !== undefined && !schema.enum.some((option) => option === value)) {
    errors.push(`${path}: value not in schema enum`);
  }
  if (schema.type === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      errors.push(`${path}: schema expects an object`);
      return;
    }
    const recordValue = value as Record<string, unknown>;
    for (const field of schema.required ?? []) {
      if (recordValue[field] === undefined) {
        errors.push(`${path}.${field}: required by schema`);
      }
    }
    for (const [key, childSchema] of Object.entries(schema.properties ?? {})) {
      if (recordValue[key] !== undefined) {
        checkAgainstSchema(recordValue[key], childSchema, `${path}.${key}`, errors);
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(recordValue)) {
        if (!(key in (schema.properties ?? {}))) {
          errors.push(`${path}.${key}: not allowed by schema`);
        }
      }
    }
    return;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) {
      errors.push(`${path}: schema expects an array`);
      return;
    }
    if (schema.items !== undefined) {
      for (let index = 0; index < value.length; index += 1) {
        checkAgainstSchema(value[index], schema.items, `${path}[${index}]`, errors);
      }
    }
    return;
  }
  if (schema.type === "string" && typeof value !== "string") {
    errors.push(`${path}: schema expects a string`);
  }
}

test("schema/contract alignment", () => {
  const schemaUrl = new URL("../schemas/clapp/behavioral-ir.schema.json", import.meta.url);
  const schema = JSON.parse(readFileSync(schemaUrl, "utf8")) as SchemaNode;

  const minimal = behavioralIr();
  const schemaErrors: string[] = [];
  checkAgainstSchema(minimal, schema, "$", schemaErrors);
  assert.deepEqual(schemaErrors, [], "the minimal contract-valid IR satisfies the schema mirror");
  assert.deepEqual(validateBehavioralIr(minimal), { ok: true, errors: [] });

  for (const field of schema.required ?? []) {
    const mutated = behavioralIr();
    delete mutated[field];
    expectErrorAt(validateBehavioralIr(mutated), field);
  }

  const evidenceRequired = schema.properties?.evidence?.items?.required ?? [];
  for (const field of evidenceRequired) {
    const mutated = behavioralIr();
    delete records(mutated.evidence)[0][field];
    expectErrorAt(validateBehavioralIr(mutated), `evidence[0].${field}`);
  }

  const journeyRequired = schema.properties?.journeys?.items?.required ?? [];
  for (const field of journeyRequired) {
    const mutated = behavioralIr();
    delete record(records(mutated.journeys)[0])[field];
    expectErrorAt(validateBehavioralIr(mutated), `journeys[0].${field}`);
  }

  // Documented strictness difference: this instance is schema-valid but
  // contract-invalid (the frozen TS type is stricter than the schema mirror).
  const schemaValidOnly = {
    schemaVersion: "0.1",
    application: { id: "app-1", name: "Demo", platform: "plan9" },
    evidence: [{ id: "ev-1", kind: "dom", sha256: "not-a-hash", classification: "observed" }],
    journeys: [{ id: "j1", steps: [] }],
  };
  const schemaOnlyErrors: string[] = [];
  checkAgainstSchema(schemaValidOnly, schema, "$", schemaOnlyErrors);
  assert.deepEqual(schemaOnlyErrors, []);
  const contractResult = validateBehavioralIr(schemaValidOnly);
  assert.equal(contractResult.ok, false);
  for (const path of [
    "application.entrypoints",
    "application.platform",
    "evidence[0].targetId",
    "evidence[0].sha256",
    "evidence[0].redacted",
    "journeys[0].name",
    "journeys[0].preconditions",
  ]) {
    expectErrorAt(contractResult, path);
  }

  // Documented forward-compatibility difference: the schema mirror forbids
  // unknown top-level fields (additionalProperties: false) while the contract
  // validator treats them as forward-compatible.
  const withUnknownField = behavioralIr({ annotations: [{ note: "experimental" }] });
  const unknownFieldSchemaErrors: string[] = [];
  checkAgainstSchema(withUnknownField, schema, "$", unknownFieldSchemaErrors);
  assert.deepEqual(unknownFieldSchemaErrors, ["$.annotations: not allowed by schema"]);
  assert.deepEqual(validateBehavioralIr(withUnknownField), { ok: true, errors: [] });
});
