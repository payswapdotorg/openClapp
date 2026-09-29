import assert from "node:assert/strict";
import test from "node:test";
import {
  advanceStateFrom,
  artifactLinksFrom,
  type ClappArtifactWire,
  type ClappCreateFormInput,
  type ClappListEntryWire,
  type ClappReconstructionWire,
  type ClappRunWire,
  type ClappStatusWire,
  clappCreateRequestFrom,
  clappErrorText,
  controlActionsFor,
  reconstructionListFrom,
  refreshPolicyFrom,
  stageChainFrom,
} from "../src/clapp-view-models.ts";

/**
 * CLAPP-W3-007 — the CLAPP UX view-model tests. The view-models are pure
 * functions of the /api/clapp response shapes, so every test here runs
 * without a React Native renderer: fixtures in, derivations out.
 */

const baseSpec: ClappReconstructionWire["spec"] = {
  specVersion: "0.1",
  reconstructionId: "clapp_run_x",
  targetId: "target-1",
  name: "Fixture app",
  platform: "web",
  entrypoints: ["https://app.example.com"],
  authorization: {
    ownerId: "owner-1",
    targetId: "target-1",
    scope: ["read:screens"],
    environments: ["staging"],
    retention: "project",
    benchmarkOwned: true,
    createdAt: "2026-02-01T09:00:00.000Z",
  },
  exploration: { maxStages: 6, maxActions: 200, maxDurationMs: 900_000, seed: 7 },
  synthesis: {
    targetStack: "nextjs-typescript-tailwind",
    allowNetwork: false,
    packagePolicy: "verified-only",
  },
  verification: {
    journeys: ["sign-in"],
    visual: true,
    network: false,
    state: true,
    maxRepairIterations: 2,
  },
};

interface StageFixture {
  stage: string;
  status: string;
  attempts?: number;
  error?: string;
}

function runFixture(input: {
  stages?: StageFixture[];
  runStatus?: string;
  malformed?: number;
}): ClappRunWire {
  return {
    reconstructionId: "clapp_run_x",
    stages: (input.stages ?? [{ stage: "authorization", status: "pending", attempts: 0 }]).map(
      (stage) => ({
        stage: stage.stage,
        status: stage.status,
        attempts: stage.attempts ?? 1,
        outputArtifactIds: [],
        ...(stage.error ? { error: stage.error } : {}),
      }),
    ),
    runStatus: input.runStatus ?? "running",
    malformed: input.malformed ?? 0,
  };
}

function artifactFixture(input: {
  id: string;
  kind?: string;
  source?: string;
  capturedAt?: string;
  contentUrl?: string;
  redacted?: boolean;
}): ClappArtifactWire {
  return {
    id: input.id,
    targetId: "target-1",
    reconstructionId: "clapp_run_x",
    kind: input.kind ?? "evidence",
    sha256: "a".repeat(64),
    source: input.source ?? "explore",
    capturedAt: input.capturedAt ?? "2026-02-03T10:00:00.000Z",
    classification: "observed",
    redacted: input.redacted ?? false,
    fileId: `file-${input.id}`,
    ...(input.contentUrl ? { contentUrl: input.contentUrl } : {}),
  };
}

function reconstructionFixture(input: {
  id?: string;
  name?: string;
  createdAt?: string;
  status?: "active" | "cancelled";
}): ClappReconstructionWire {
  const id = input.id ?? "clapp_run_x";
  return {
    id,
    spec: {
      ...baseSpec,
      reconstructionId: id,
      ...(input.name ? { name: input.name } : {}),
    },
    createdAt: input.createdAt ?? "2026-02-02T10:00:00.000Z",
    status: input.status ?? "active",
  };
}

function listEntryFixture(input: {
  id?: string;
  name?: string;
  createdAt?: string;
  status?: "active" | "cancelled";
  stages?: StageFixture[];
  runStatus?: string;
  complete?: boolean;
}): ClappListEntryWire {
  return {
    reconstruction: reconstructionFixture(input),
    run: runFixture(input),
    complete: input.complete ?? false,
  };
}

function statusFixture(input: {
  id?: string;
  name?: string;
  createdAt?: string;
  status?: "active" | "cancelled";
  stages?: StageFixture[];
  runStatus?: string;
  malformed?: number;
  ledger?: { stage: string; artifactIds: string[] }[];
  artifacts?: ClappArtifactWire[];
  complete?: boolean;
}): ClappStatusWire {
  return {
    reconstruction: reconstructionFixture(input),
    run: runFixture(input),
    ledger: input.ledger ?? [],
    artifacts: input.artifacts ?? [],
    complete: input.complete ?? false,
  };
}

test("list view-model derives deterministically", () => {
  const older = listEntryFixture({
    id: "clapp_run_a",
    createdAt: "2026-02-01T10:00:00.000Z",
    name: "Older app",
  });
  const newer = listEntryFixture({
    id: "clapp_run_b",
    createdAt: "2026-02-03T10:00:00.000Z",
    name: "Newer app",
  });
  const tieOne = listEntryFixture({ id: "clapp_run_c1", createdAt: "2026-02-03T10:00:00.000Z" });
  const tieTwo = listEntryFixture({ id: "clapp_run_c2", createdAt: "2026-02-03T10:00:00.000Z" });
  const model = reconstructionListFrom([older, newer, tieOne, tieTwo]);
  // The order is imposed locally: newest createdAt first, id as the tiebreak.
  assert.deepEqual(
    model.map((row) => row.id),
    ["clapp_run_b", "clapp_run_c1", "clapp_run_c2", "clapp_run_a"],
  );
  // The derivation is independent of the order the server returned.
  assert.deepEqual(
    reconstructionListFrom([older, newer, tieOne, tieTwo]),
    reconstructionListFrom([tieTwo, tieOne, newer, older]),
  );
  // Labels are stable and derived.
  assert.equal(model[0]?.name, "Newer app");
  assert.equal(model[0]?.platform, "web");
  assert.equal(model[0]?.runStatusLabel, "Running");
  assert.equal(model[0]?.statusDetail, "Deepest stage: Authorization (Pending)");
  assert.equal(model[0]?.complete, false);
  assert.equal(model[0]?.cancelled, false);
  // An unknown run-level status renders explicitly-unknown.
  const unknown = reconstructionListFrom([
    listEntryFixture({ id: "clapp_run_z", runStatus: "hibernating" }),
  ]);
  assert.equal(unknown[0]?.runStatusLabel, "Unknown (hibernating)");
  // A cancelled reconstruction says so, without inventing stage truth.
  const cancelled = reconstructionListFrom([
    listEntryFixture({ id: "clapp_run_q", status: "cancelled" }),
  ]);
  assert.equal(cancelled[0]?.cancelled, true);
  assert.equal(cancelled[0]?.statusDetail, "Cancelled — the chain no longer accepts control");
  // An empty list derives an empty model.
  assert.deepEqual(reconstructionListFrom([]), []);
});

test("stage chain maps every stage status honestly", () => {
  const status = statusFixture({
    stages: [
      { stage: "authorization", status: "pending", attempts: 0 },
      { stage: "capture", status: "running" },
      { stage: "explore", status: "waiting_input" },
      { stage: "model", status: "waiting_approval" },
      { stage: "plan", status: "succeeded" },
      { stage: "synthesize", status: "failed", attempts: 2, error: "synthesis diverged" },
      { stage: "audit", status: "running" },
      { stage: "verify", status: "cancelled" },
      { stage: "repair", status: "skipped" },
      { stage: "review", status: "hibernating" },
    ],
    ledger: [
      { stage: "plan", artifactIds: ["art-1", "art-2"] },
      { stage: "synthesize", artifactIds: ["art-3"] },
      { stage: "audit", artifactIds: ["art-7"] },
    ],
  });
  const chips = stageChainFrom(status);
  // The ten frozen stages in chain order, plus the reported foreign stage.
  assert.equal(chips.length, 11);
  const byStage = new Map(chips.map((chip) => [chip.stage, chip]));
  // Each of the eight frozen statuses renders its own chip state.
  assert.deepEqual(byStage.get("authorization"), {
    stage: "authorization",
    label: "Authorization",
    reported: true,
    status: "pending",
    statusLabel: "Pending",
    rawStatus: "pending",
    attempts: 0,
    artifactCount: 0,
    error: null,
  });
  assert.deepEqual(byStage.get("capture"), {
    stage: "capture",
    label: "Capture",
    reported: true,
    status: "running",
    statusLabel: "Running",
    rawStatus: "running",
    attempts: 1,
    artifactCount: 0,
    error: null,
  });
  assert.deepEqual(byStage.get("explore"), {
    stage: "explore",
    label: "Explore",
    reported: true,
    status: "waiting_input",
    statusLabel: "Waiting for input",
    rawStatus: "waiting_input",
    attempts: 1,
    artifactCount: 0,
    error: null,
  });
  assert.deepEqual(byStage.get("model"), {
    stage: "model",
    label: "Model",
    reported: true,
    status: "waiting_approval",
    statusLabel: "Waiting for approval",
    rawStatus: "waiting_approval",
    attempts: 1,
    artifactCount: 0,
    error: null,
  });
  assert.deepEqual(byStage.get("plan"), {
    stage: "plan",
    label: "Plan",
    reported: true,
    status: "succeeded",
    statusLabel: "Succeeded",
    rawStatus: "succeeded",
    attempts: 1,
    artifactCount: 2,
    error: null,
  });
  assert.deepEqual(byStage.get("synthesize"), {
    stage: "synthesize",
    label: "Synthesize",
    reported: true,
    status: "failed",
    statusLabel: "Failed",
    rawStatus: "failed",
    attempts: 2,
    artifactCount: 1,
    error: "synthesis diverged",
  });
  assert.deepEqual(byStage.get("verify"), {
    stage: "verify",
    label: "Verify",
    reported: true,
    status: "cancelled",
    statusLabel: "Cancelled",
    rawStatus: "cancelled",
    attempts: 1,
    artifactCount: 0,
    error: null,
  });
  assert.deepEqual(byStage.get("repair"), {
    stage: "repair",
    label: "Repair",
    reported: true,
    status: "skipped",
    statusLabel: "Skipped",
    rawStatus: "skipped",
    attempts: 1,
    artifactCount: 0,
    error: null,
  });
  // A status outside the frozen union renders explicitly-unknown.
  assert.deepEqual(byStage.get("review"), {
    stage: "review",
    label: "Review",
    reported: true,
    status: "unknown",
    statusLabel: "Unknown (hibernating)",
    rawStatus: "hibernating",
    attempts: 1,
    artifactCount: 0,
    error: null,
  });
  // A stage the server did not report renders as not started — never pending.
  assert.deepEqual(byStage.get("promote"), {
    stage: "promote",
    label: "Promote",
    reported: false,
    status: "not_started",
    statusLabel: "Not started",
    rawStatus: null,
    attempts: null,
    artifactCount: 0,
    error: null,
  });
  // A stage outside the frozen chain is appended, never hidden.
  assert.deepEqual(byStage.get("audit"), {
    stage: "audit",
    label: "audit",
    reported: true,
    status: "running",
    statusLabel: "Running",
    rawStatus: "running",
    attempts: 1,
    artifactCount: 1,
    error: null,
  });
});

test("control actions derive from stage statuses", () => {
  const actionsFor = (stage: string, stageStatus: string, runStatus: string, complete = false) =>
    controlActionsFor(
      statusFixture({
        stages: [{ stage, status: stageStatus }],
        runStatus,
        complete,
      }),
    );
  // running -> pause / cancel
  assert.deepEqual(actionsFor("explore", "running", "running"), ["pause", "cancel"]);
  // waiting_input -> resume visible
  assert.ok(actionsFor("explore", "waiting_input", "running").includes("resume"));
  // waiting_approval -> resume visible
  assert.ok(actionsFor("explore", "waiting_approval", "running").includes("resume"));
  // succeeded -> none (the frontier finished; advance is the path, not control)
  assert.deepEqual(actionsFor("plan", "succeeded", "running"), []);
  // a completed chain -> none (the server refuses control)
  assert.deepEqual(actionsFor("promote", "succeeded", "succeeded", true), []);
  // failed -> retry
  assert.deepEqual(actionsFor("synthesize", "failed", "failed"), ["retry"]);
  // cancelled -> retry (the frontier stage was cancelled; the run is not terminal)
  assert.deepEqual(actionsFor("verify", "cancelled", "mixed"), ["retry"]);
  // a terminal-cancelled run -> none (the server refuses control)
  assert.deepEqual(actionsFor("verify", "cancelled", "cancelled"), []);
  // an unknown frontier status -> none, never fabricated
  assert.deepEqual(actionsFor("review", "hibernating", "running"), []);
  // a paused run offers resume and never pause again
  assert.deepEqual(actionsFor("explore", "running", "paused"), ["resume", "cancel"]);
  // never fabricated: every offered action is one the route's zod body accepts
  const offered = [
    actionsFor("explore", "running", "running"),
    actionsFor("explore", "waiting_input", "running"),
    actionsFor("synthesize", "failed", "failed"),
    actionsFor("verify", "cancelled", "mixed"),
  ].flat();
  for (const action of offered) {
    assert.ok(
      action === "pause" || action === "resume" || action === "cancel" || action === "retry",
    );
  }
});

test("artifact links carry signed urls and names", () => {
  const status = statusFixture({
    artifacts: [
      artifactFixture({
        id: "ev-1",
        kind: "screen-tree",
        source: "explore",
        capturedAt: "2026-02-03T11:00:00.000Z",
        contentUrl: "/api/files/file-1/content?sig=abc",
      }),
      artifactFixture({
        id: "ev-2",
        kind: "network-log",
        source: "explore",
        capturedAt: "2026-02-03T12:00:00.000Z",
        contentUrl: "/api/files/file-2/content?sig=def",
      }),
      artifactFixture({
        id: "ev-3",
        kind: "behavioral-ir",
        source: "model",
        capturedAt: "2026-02-03T13:00:00.000Z",
      }),
    ],
  });
  const links = artifactLinksFrom(status);
  // The unsigned artifact never becomes a link.
  assert.equal(links.length, 2);
  assert.deepEqual(
    links.map((link) => link.id),
    ["ev-2", "ev-1"],
  );
  // Every url is the signed contentUrl exactly as delivered.
  assert.deepEqual(
    links.map((link) => link.url),
    ["/api/files/file-2/content?sig=def", "/api/files/file-1/content?sig=abc"],
  );
  for (const link of links) {
    assert.ok(link.url.startsWith("/api/files/"));
    assert.ok(link.url.includes("?"));
    assert.ok(!link.url.startsWith("http"));
  }
  // Names derive deterministically from the artifact's kind and source.
  assert.equal(links[0]?.name, "network-log · explore");
  assert.equal(links[1]?.name, "screen-tree · explore");
  assert.equal(links[0]?.classification, "observed");
  assert.equal(links[0]?.redacted, false);
  assert.ok(!links.some((link) => link.id === "ev-3"));
});

test("create request body matches the API contract", () => {
  const form: ClappCreateFormInput = {
    reconstructionId: "clapp_draft_demo",
    name: "Demo app",
    platform: "web",
    targetId: "target-9",
    entrypoints: ["https://demo.example.com"],
    ownerId: "owner-9",
    scope: ["read:screens", "read:network"],
    environments: ["staging"],
    retention: "project",
    benchmarkOwned: true,
    authorizationCreatedAt: "2026-02-04T08:00:00.000Z",
    maxStages: 6,
    maxActions: 200,
    maxDurationMs: 900_000,
    seed: 7,
    targetStack: "nextjs-typescript-tailwind",
    allowNetwork: false,
    packagePolicy: "verified-only",
    journeys: ["sign-in"],
    visual: true,
    network: false,
    state: true,
    maxRepairIterations: 2,
  };
  const body = clappCreateRequestFrom(form);
  // Exactly the frozen ReconstructionSpec shape the server's strict zod
  // schema validates — field for field, nothing defaulted or extra.
  assert.deepEqual(body, {
    specVersion: "0.1",
    reconstructionId: "clapp_draft_demo",
    targetId: "target-9",
    name: "Demo app",
    platform: "web",
    entrypoints: ["https://demo.example.com"],
    authorization: {
      ownerId: "owner-9",
      targetId: "target-9",
      scope: ["read:screens", "read:network"],
      environments: ["staging"],
      retention: "project",
      benchmarkOwned: true,
      createdAt: "2026-02-04T08:00:00.000Z",
    },
    exploration: { maxStages: 6, maxActions: 200, maxDurationMs: 900_000, seed: 7 },
    synthesis: {
      targetStack: "nextjs-typescript-tailwind",
      allowNetwork: false,
      packagePolicy: "verified-only",
    },
    verification: {
      journeys: ["sign-in"],
      visual: true,
      network: false,
      state: true,
      maxRepairIterations: 2,
    },
  });
  // The strict schema rejects extra keys — the top-level key set is exact.
  assert.deepEqual(
    Object.keys(body).sort(),
    [
      "authorization",
      "entrypoints",
      "exploration",
      "name",
      "platform",
      "reconstructionId",
      "specVersion",
      "synthesis",
      "targetId",
      "verification",
    ].sort(),
  );
  // expiresAt is included only when provided, matching the optional key.
  assert.equal("expiresAt" in body.authorization, false);
  const withExpiry = clappCreateRequestFrom({ ...form, expiresAt: "2026-03-01T00:00:00.000Z" });
  assert.equal(withExpiry.authorization.expiresAt, "2026-03-01T00:00:00.000Z");
  assert.deepEqual(
    Object.keys(withExpiry.authorization).sort(),
    [
      "benchmarkOwned",
      "createdAt",
      "environments",
      "expiresAt",
      "ownerId",
      "retention",
      "scope",
      "targetId",
    ].sort(),
  );
});

test("status polling model is explicit", () => {
  // An active run polls: the interval is a positive number, stated in a label.
  const active = refreshPolicyFrom(statusFixture({ runStatus: "running" }));
  assert.equal(typeof active.intervalMs, "number");
  assert.ok((active.intervalMs ?? 0) > 0);
  assert.ok(active.label.length > 0);
  // A waiting run still polls — it can move without the user acting.
  assert.ok((refreshPolicyFrom(statusFixture({ runStatus: "pending" })).intervalMs ?? 0) > 0);
  // Terminal runs do not poll; only manual refresh applies.
  for (const runStatus of ["succeeded", "failed", "cancelled"]) {
    assert.equal(refreshPolicyFrom(statusFixture({ runStatus })).intervalMs, null);
  }
  assert.equal(
    refreshPolicyFrom(statusFixture({ runStatus: "running", complete: true })).intervalMs,
    null,
  );
  // The policy is a pure derivation of the response — same input, same policy.
  assert.deepEqual(active, refreshPolicyFrom(statusFixture({ runStatus: "running" })));
});

test("failure states surface server messages", () => {
  // The app's api layer throws Error with the server's message — verbatim.
  assert.equal(
    clappErrorText(new Error("Reconstruction spec rejected: name: name is required")),
    "Reconstruction spec rejected: name: name is required",
  );
  // A raw server error payload maps to its error field.
  assert.equal(
    clappErrorText({ error: "Stage synthesize failed; retry it (control action retry) first" }),
    "Stage synthesize failed; retry it (control action retry) first",
  );
  // An empty error field falls through to the message field, never swallowed.
  assert.equal(clappErrorText({ error: "", message: "fallback message" }), "fallback message");
  // Every other shape still produces non-empty displayed text.
  for (const shape of [undefined, null, 42, {}, { complex: true }, new Error("")]) {
    const text = clappErrorText(shape);
    assert.equal(typeof text, "string");
    assert.ok(text.length > 0);
  }
});

test("purity: same inputs -> byte-identical view-models", () => {
  const entries = [
    listEntryFixture({ id: "clapp_run_a", createdAt: "2026-02-01T10:00:00.000Z", name: "Older" }),
    listEntryFixture({
      id: "clapp_run_b",
      createdAt: "2026-02-03T10:00:00.000Z",
      name: "Newer",
      stages: [
        { stage: "authorization", status: "succeeded" },
        { stage: "capture", status: "running" },
      ],
    }),
  ];
  const status = statusFixture({
    stages: [
      { stage: "authorization", status: "succeeded" },
      { stage: "capture", status: "running" },
    ],
    ledger: [{ stage: "authorization", artifactIds: ["art-1"] }],
    artifacts: [artifactFixture({ id: "ev-1", contentUrl: "/api/files/file-1/content?sig=abc" })],
  });
  const form: ClappCreateFormInput = {
    reconstructionId: "clapp_draft_demo",
    name: "Demo app",
    platform: "web",
    targetId: "target-9",
    entrypoints: ["https://demo.example.com"],
    ownerId: "owner-9",
    scope: ["read:screens"],
    environments: ["staging"],
    retention: "project",
    benchmarkOwned: true,
    authorizationCreatedAt: "2026-02-04T08:00:00.000Z",
    maxStages: 6,
    maxActions: 200,
    maxDurationMs: 900_000,
    seed: 7,
    targetStack: "nextjs-typescript-tailwind",
    allowNetwork: false,
    packagePolicy: "verified-only",
    journeys: ["sign-in"],
    visual: true,
    network: false,
    state: true,
    maxRepairIterations: 2,
  };
  assert.deepEqual(reconstructionListFrom(entries), reconstructionListFrom(entries));
  assert.equal(
    JSON.stringify(reconstructionListFrom(entries)),
    JSON.stringify(reconstructionListFrom(entries)),
  );
  assert.deepEqual(stageChainFrom(status), stageChainFrom(status));
  assert.equal(JSON.stringify(stageChainFrom(status)), JSON.stringify(stageChainFrom(status)));
  assert.deepEqual(artifactLinksFrom(status), artifactLinksFrom(status));
  assert.equal(
    JSON.stringify(artifactLinksFrom(status)),
    JSON.stringify(artifactLinksFrom(status)),
  );
  assert.deepEqual(controlActionsFor(status), controlActionsFor(status));
  assert.deepEqual(refreshPolicyFrom(status), refreshPolicyFrom(status));
  assert.deepEqual(advanceStateFrom(status), advanceStateFrom(status));
  assert.deepEqual(clappCreateRequestFrom(form), clappCreateRequestFrom(form));
  assert.equal(
    JSON.stringify(clappCreateRequestFrom(form)),
    JSON.stringify(clappCreateRequestFrom(form)),
  );
});
