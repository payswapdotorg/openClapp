import type {
  ClappPlatform,
  ClappStageStatus,
  EvidenceRef,
  ReconstructionSpec,
} from "../../../packages/clapp-contracts/src/index.ts";

/**
 * CLAPP-W3-007 — the pure view-model layer for the CLAPP UX surfaces.
 *
 * Every exported function here is a pure derivation of the /api/clapp HTTP
 * response shapes: no rendering, no react-native imports, no wall clock, no
 * randomness. The screens map these models to pixels and nothing else, and
 * the unit tests exercise them without a renderer. Honesty rules, per the
 * work item:
 *
 * - A stage renders exactly what the status endpoint reported. A stage the
 *   server did not report renders as not started; a status outside the
 *   frozen v0.1 union renders as explicitly unknown; nothing is ever
 *   optimistically fabricated.
 * - Control actions are derived from the reported stage statuses plus the
 *   server's own terminal-state refusals (a completed chain and a
 *   terminal-cancelled run accept no control) — the UI never offers an
 *   action the surface rejects.
 * - Artifact links carry the signed contentUrls exactly as delivered; an
 *   artifact without a signed URL is never offered as a link.
 * - Refresh semantics are explicit: the model exposes whether and how often
 *   to re-fetch, and the screens re-fetch through the real HTTP surface —
 *   there are no hidden optimistic updates.
 */

// ---------------------------------------------------------------------------
// Wire shapes — the structural JSON the /api/clapp routes return
// ---------------------------------------------------------------------------

/** One stage's derived state in a run; statuses arrive as bare strings. */
export interface ClappRunStageWire {
  stage: string;
  status: string;
  attempts: number;
  outputArtifactIds: string[];
  error?: string;
}

/** The run-level view the server derives from the whole task chain. */
export interface ClappRunWire {
  reconstructionId: string;
  stages: ClappRunStageWire[];
  /** pending | running | succeeded | failed | cancelled | paused | mixed. */
  runStatus: string;
  lastCompletedStage?: string;
  /** Tasks that could not be attributed to the chain — counted, never thrown. */
  malformed: number;
}

/** One stage's artifact attribution in the run's ledger. */
export interface ClappLedgerWire {
  stage: string;
  artifactIds: string[];
}

/** The frozen EvidenceRef plus the backing file id and its signed content URL. */
export interface ClappArtifactWire extends EvidenceRef {
  fileId: string;
  /** Signed by the route layer: /api/files/<fileId>/content?… */
  contentUrl?: string;
}

/** A reconstruction row exactly as the repositories write it. */
export interface ClappReconstructionWire {
  id: string;
  spec: ReconstructionSpec;
  createdAt: string;
  status: "active" | "cancelled";
}

/** GET /api/clapp/reconstructions/:id — the status endpoint's body. */
export interface ClappStatusWire {
  reconstruction: ClappReconstructionWire;
  run: ClappRunWire;
  ledger: ClappLedgerWire[];
  artifacts: ClappArtifactWire[];
  /** Whether the deepest stage is the chain's final stage and succeeded. */
  complete: boolean;
}

/** GET /api/clapp/reconstructions — one list entry. */
export interface ClappListEntryWire {
  reconstruction: ClappReconstructionWire;
  run: ClappRunWire;
  complete: boolean;
}

/** POST /api/clapp/reconstructions — the create result (201). */
export interface ClappCreateResultWire {
  reconstruction: ClappReconstructionWire;
  task: { id: string; status: string; title?: string };
}

/** POST /api/clapp/reconstructions/:id/advance — the advance result. */
export interface ClappAdvanceResultWire {
  advanced: boolean;
  stage: string;
  task: { id: string; status: string; title?: string };
  reason: string;
}

/** POST /api/clapp/reconstructions/:id/control — the control result. */
export interface ClappControlResultWire {
  task: { id: string; status: string; title?: string };
  run: ClappRunWire;
}

/** The control actions the /control route's zod body accepts. */
export type ClappControlActionWire = "pause" | "resume" | "cancel" | "retry";

// ---------------------------------------------------------------------------
// The frozen v0.1 stage chain and its labels
// ---------------------------------------------------------------------------

/** The ten frozen v0.1 stages, in chain order (packages/clapp-contracts). */
export const CLAPP_STAGE_CHAIN: readonly string[] = [
  "authorization",
  "capture",
  "explore",
  "model",
  "plan",
  "synthesize",
  "verify",
  "repair",
  "review",
  "promote",
];

const STAGE_LABELS: Record<string, string> = {
  authorization: "Authorization",
  capture: "Capture",
  explore: "Explore",
  model: "Model",
  plan: "Plan",
  synthesize: "Synthesize",
  verify: "Verify",
  repair: "Repair",
  review: "Review",
  promote: "Promote",
};

const KNOWN_STAGE_STATUSES: readonly string[] = [
  "pending",
  "running",
  "waiting_input",
  "waiting_approval",
  "succeeded",
  "failed",
  "cancelled",
  "skipped",
];

const STAGE_STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  running: "Running",
  waiting_input: "Waiting for input",
  waiting_approval: "Waiting for approval",
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
  skipped: "Skipped",
};

const RUN_STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
  paused: "Paused",
  mixed: "Mixed",
};

const stageLabel = (stage: string): string => STAGE_LABELS[stage] ?? stage;

/** Maps a raw status string to the frozen union, or null when unknown. */
const knownStatusOf = (raw: string): ClappStageStatus | null =>
  KNOWN_STAGE_STATUSES.includes(raw) ? (raw as ClappStageStatus) : null;

/** Chain order for reported stages; unknown stage names sort last, deterministically. */
const byChainOrder = (a: ClappRunStageWire, b: ClappRunStageWire): number => {
  const indexA = CLAPP_STAGE_CHAIN.indexOf(a.stage);
  const indexB = CLAPP_STAGE_CHAIN.indexOf(b.stage);
  const rankA = indexA === -1 ? Number.MAX_SAFE_INTEGER : indexA;
  const rankB = indexB === -1 ? Number.MAX_SAFE_INTEGER : indexB;
  if (rankA !== rankB) return rankA - rankB;
  return a.stage.localeCompare(b.stage);
};

/** The deepest reported stage in chain order — null when none is reported. */
const frontierStageOf = (run: ClappRunWire): ClappRunStageWire | null => {
  const ordered = [...run.stages].sort(byChainOrder);
  return ordered.length > 0 ? (ordered[ordered.length - 1] ?? null) : null;
};

// ---------------------------------------------------------------------------
// 1) The list view-model
// ---------------------------------------------------------------------------

/** One row of the reconstructions list. */
export interface ClappReconstructionListItem {
  id: string;
  name: string;
  platform: ClappPlatform;
  createdAt: string;
  /** The run-level status chip label; unknown statuses render explicitly-unknown. */
  runStatusLabel: string;
  /** What the row shows underneath the name — derived, never fabricated. */
  statusDetail: string;
  complete: boolean;
  cancelled: boolean;
}

/**
 * Derives the list view-model from the list endpoint's entries. The order is
 * imposed locally (newest createdAt first, id as the tiebreak) so the model
 * is deterministic regardless of the order the server returned.
 */
export function reconstructionListFrom(
  entries: ClappListEntryWire[],
): ClappReconstructionListItem[] {
  return [...entries]
    .sort((a, b) => {
      const byCreated = b.reconstruction.createdAt.localeCompare(a.reconstruction.createdAt);
      return byCreated !== 0 ? byCreated : a.reconstruction.id.localeCompare(b.reconstruction.id);
    })
    .map((entry) => {
      const { reconstruction, run, complete } = entry;
      const frontier = frontierStageOf(run);
      const frontierStatus = frontier
        ? (STAGE_STATUS_LABELS[frontier.status] ?? `unknown status ${frontier.status}`)
        : "";
      return {
        id: reconstruction.id,
        name: reconstruction.spec.name,
        platform: reconstruction.spec.platform,
        createdAt: reconstruction.createdAt,
        runStatusLabel: RUN_STATUS_LABELS[run.runStatus] ?? `Unknown (${run.runStatus})`,
        statusDetail:
          reconstruction.status === "cancelled"
            ? "Cancelled — the chain no longer accepts control"
            : complete
              ? "Complete — the final stage succeeded"
              : frontier
                ? `Deepest stage: ${stageLabel(frontier.stage)} (${frontierStatus})`
                : "No stage tasks reported yet",
        complete,
        cancelled: reconstruction.status === "cancelled",
      };
    });
}

// ---------------------------------------------------------------------------
// 2) The stage-chain view-model
// ---------------------------------------------------------------------------

/** A chip status: the eight frozen stage statuses, plus honest derivations. */
export type ClappChipStatus = ClappStageStatus | "not_started" | "unknown";

/** One stage chip in the chain — exactly what the status endpoint reported. */
export interface ClappStageChip {
  stage: string;
  label: string;
  /** Whether the status endpoint reported this stage at all. */
  reported: boolean;
  status: ClappChipStatus;
  statusLabel: string;
  /** Exactly what the server sent — null when the stage was not reported. */
  rawStatus: string | null;
  attempts: number | null;
  artifactCount: number;
  error: string | null;
}

/**
 * Derives the stage chain from the status endpoint's body: one chip per
 * frozen v0.1 stage (in chain order), carrying the stage's reported status,
 * attempt count and ledger artifact count. Stages the server reported
 * outside the frozen chain are appended in run order — never hidden, never
 * folded into a fabricated status.
 */
export function stageChainFrom(status: ClappStatusWire): ClappStageChip[] {
  const reported = new Map<string, ClappRunStageWire>();
  for (const stage of status.run.stages) {
    if (!reported.has(stage.stage)) reported.set(stage.stage, stage);
  }
  const artifactCounts = new Map<string, number>();
  for (const entry of status.ledger) {
    artifactCounts.set(
      entry.stage,
      (artifactCounts.get(entry.stage) ?? 0) + entry.artifactIds.length,
    );
  }
  const chipFor = (stage: string): ClappStageChip => {
    const record = reported.get(stage);
    const artifactCount = artifactCounts.get(stage) ?? 0;
    if (!record) {
      return {
        stage,
        label: stageLabel(stage),
        reported: false,
        status: "not_started",
        statusLabel: "Not started",
        rawStatus: null,
        attempts: null,
        artifactCount,
        error: null,
      };
    }
    const raw = String(record.status);
    const known = knownStatusOf(raw);
    return {
      stage,
      label: stageLabel(stage),
      reported: true,
      status: known ?? "unknown",
      statusLabel: known ? STAGE_STATUS_LABELS[known] : `Unknown (${raw})`,
      rawStatus: raw,
      attempts: typeof record.attempts === "number" ? record.attempts : null,
      artifactCount,
      error: typeof record.error === "string" && record.error.length > 0 ? record.error : null,
    };
  };
  const chain = CLAPP_STAGE_CHAIN.map((stage) => chipFor(stage));
  const extras: ClappStageChip[] = [];
  for (const stage of status.run.stages) {
    if (
      !CLAPP_STAGE_CHAIN.includes(stage.stage) &&
      !extras.some((chip) => chip.stage === stage.stage)
    ) {
      extras.push(chipFor(stage.stage));
    }
  }
  return [...chain, ...extras];
}

// ---------------------------------------------------------------------------
// 3) The control-actions view-model
// ---------------------------------------------------------------------------

/**
 * Derives which control actions are valid RIGHT NOW. The mapping follows the
 * server's own refusal rules exactly: a completed chain and a
 * terminal-cancelled run accept no control at all, and beyond that the
 * actions come from the frontier stage's reported status — never fabricated:
 *
 * - running -> pause, cancel
 * - waiting_input / waiting_approval -> resume
 * - failed / cancelled -> retry
 * - pending, succeeded, skipped or unknown -> none (advance is the path)
 * - a paused run offers resume and never offers pause again
 */
export function controlActionsFor(status: ClappStatusWire): ClappControlActionWire[] {
  if (status.complete) return [];
  if (status.run.runStatus === "cancelled") return [];
  const frontier = frontierStageOf(status.run);
  if (!frontier) return [];
  const known = knownStatusOf(frontier.status);
  let actions: ClappControlActionWire[] = [];
  if (known === "running") actions = ["pause", "cancel"];
  else if (known === "waiting_input" || known === "waiting_approval") actions = ["resume"];
  else if (known === "failed" || known === "cancelled") actions = ["retry"];
  if (status.run.runStatus === "paused") {
    actions = ["resume", ...actions.filter((action) => action !== "pause" && action !== "resume")];
  }
  return actions;
}

// ---------------------------------------------------------------------------
// 4) The artifact-links view-model
// ---------------------------------------------------------------------------

/** One openable artifact link — the signed contentUrl with a derived name. */
export interface ClappArtifactLink {
  id: string;
  name: string;
  /** The signed contentUrl exactly as the status endpoint delivered it. */
  url: string;
  kind: string;
  classification: string;
  redacted: boolean;
  capturedAt: string;
}

/**
 * Derives the openable artifact links from the status endpoint's body. Only
 * artifacts that actually carry a signed contentUrl become links — an
 * unsigned artifact is never offered as one. The order is imposed locally
 * (most recently captured first, id as the tiebreak) so the model is
 * deterministic regardless of the order the server returned.
 */
export function artifactLinksFrom(status: ClappStatusWire): ClappArtifactLink[] {
  return status.artifacts
    .filter((artifact) => typeof artifact.contentUrl === "string" && artifact.contentUrl.length > 0)
    .sort((a, b) => {
      const byCaptured = b.capturedAt.localeCompare(a.capturedAt);
      return byCaptured !== 0 ? byCaptured : a.id.localeCompare(b.id);
    })
    .map((artifact) => ({
      id: artifact.id,
      name:
        [artifact.kind, artifact.source].filter((part) => part.length > 0).join(" · ") ||
        artifact.id,
      url: artifact.contentUrl ?? "",
      kind: artifact.kind,
      classification: artifact.classification,
      redacted: artifact.redacted,
      capturedAt: artifact.capturedAt,
    }));
}

// ---------------------------------------------------------------------------
// 5) The create-request view-model
// ---------------------------------------------------------------------------

/** The create form's inputs at submit time — the builder itself stays pure. */
export interface ClappCreateFormInput {
  /** Client-minted draft id — the server stamps its own id over it. */
  reconstructionId: string;
  name: string;
  platform: ClappPlatform;
  targetId: string;
  entrypoints: string[];
  ownerId: string;
  scope: string[];
  environments: string[];
  expiresAt?: string;
  retention: "ephemeral" | "project" | "library";
  benchmarkOwned: boolean;
  /** Client clock at submit time — keeps the builder pure. */
  authorizationCreatedAt: string;
  maxStages: number;
  maxActions: number;
  maxDurationMs: number;
  seed: number;
  targetStack: string;
  allowNetwork: boolean;
  packagePolicy: "verified-only" | "verified-and-candidates";
  journeys: string[];
  visual: boolean;
  network: boolean;
  state: boolean;
  maxRepairIterations: number;
}

/**
 * Builds the POST /api/clapp/reconstructions body from the form's inputs —
 * exactly the frozen ReconstructionSpec shape the server's strict zod schema
 * validates (no extra keys, nothing defaulted or coerced). `expiresAt` is
 * included only when provided, matching the schema's optional key.
 */
export function clappCreateRequestFrom(form: ClappCreateFormInput): ReconstructionSpec {
  return {
    specVersion: "0.1",
    reconstructionId: form.reconstructionId,
    targetId: form.targetId,
    name: form.name,
    platform: form.platform,
    entrypoints: form.entrypoints,
    authorization: {
      ownerId: form.ownerId,
      targetId: form.targetId,
      scope: form.scope,
      environments: form.environments,
      ...(form.expiresAt ? { expiresAt: form.expiresAt } : {}),
      retention: form.retention,
      benchmarkOwned: form.benchmarkOwned,
      createdAt: form.authorizationCreatedAt,
    },
    exploration: {
      maxStages: form.maxStages,
      maxActions: form.maxActions,
      maxDurationMs: form.maxDurationMs,
      seed: form.seed,
    },
    synthesis: {
      targetStack: form.targetStack,
      allowNetwork: form.allowNetwork,
      packagePolicy: form.packagePolicy,
    },
    verification: {
      journeys: form.journeys,
      visual: form.visual,
      network: form.network,
      state: form.state,
      maxRepairIterations: form.maxRepairIterations,
    },
  };
}

// ---------------------------------------------------------------------------
// 6) The refresh-policy view-model
// ---------------------------------------------------------------------------

/** The explicit refresh semantics for one reconstruction's status. */
export interface ClappRefreshPolicy {
  /** null — the run is no longer active; only manual refresh applies. */
  intervalMs: number | null;
  label: string;
}

const TERMINAL_RUN_STATUSES: readonly string[] = ["succeeded", "failed", "cancelled"];

/**
 * Derives the refresh semantics from the status endpoint's body. Polling
 * applies only while the run is active; a completed or terminal run refreshes
 * manually. There are no hidden optimistic updates anywhere — every refresh
 * is a real re-fetch of the status endpoint.
 */
export function refreshPolicyFrom(status: ClappStatusWire): ClappRefreshPolicy {
  if (status.complete || TERMINAL_RUN_STATUSES.includes(status.run.runStatus)) {
    return {
      intervalMs: null,
      label: "This run has finished — status changes only when you refresh.",
    };
  }
  return {
    intervalMs: 4000,
    label: "Checking for stage updates every 4 seconds while the run is active.",
  };
}

// ---------------------------------------------------------------------------
// 7) The advance-state view-model
// ---------------------------------------------------------------------------

/** Whether the advance action is offered right now, and why. */
export interface ClappAdvanceState {
  enabled: boolean;
  hint: string;
}

/**
 * Derives the advance button's state from the status endpoint's body,
 * following the server's own advance rules: advance applies once the
 * frontier task finished (succeeded — or skipped, which the server also
 * treats as advanceable); a failed frontier must be retried first; a
 * cancelled chain no longer advances; a live frontier must finish first.
 */
export function advanceStateFrom(status: ClappStatusWire): ClappAdvanceState {
  if (status.complete) {
    return { enabled: false, hint: "The final stage succeeded — the chain is complete." };
  }
  const frontier = frontierStageOf(status.run);
  if (!frontier) {
    return { enabled: false, hint: "No stage task has been reported yet." };
  }
  const label = stageLabel(frontier.stage);
  const known = knownStatusOf(frontier.status);
  if (known === "succeeded" || known === "skipped") {
    return {
      enabled: true,
      hint: `Stage ${label} is ${STAGE_STATUS_LABELS[known]} — advance plans the next stage.`,
    };
  }
  if (known === "failed") {
    return { enabled: false, hint: `Stage ${label} failed — retry it before advancing.` };
  }
  if (known === "cancelled") {
    return { enabled: false, hint: "The chain was cancelled — it no longer advances." };
  }
  if (known === null) {
    return {
      enabled: false,
      hint: `Stage ${label} reported an unknown status (${frontier.status}).`,
    };
  }
  return {
    enabled: false,
    hint: `Stage ${label} is ${STAGE_STATUS_LABELS[known]} — the frontier task must finish first.`,
  };
}

// ---------------------------------------------------------------------------
// 8) The error view-model
// ---------------------------------------------------------------------------

/**
 * Maps any thrown error shape to displayed text — never swallowed, never
 * empty. The app's api layer throws Error with the server's `error` message;
 * anything else degrades honestly to its string form.
 */
export function clappErrorText(error: unknown): string {
  if (typeof error === "string") return error.length > 0 ? error : "Something went wrong.";
  if (error instanceof Error) {
    return error.message.length > 0 ? error.message : "Something went wrong.";
  }
  if (error && typeof error === "object") {
    const serverError = (error as { error?: unknown }).error;
    if (typeof serverError === "string" && serverError.length > 0) return serverError;
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
    try {
      const serialized = JSON.stringify(error);
      return serialized === undefined ? "Something went wrong." : serialized;
    } catch {
      return "Something went wrong.";
    }
  }
  return "Something went wrong.";
}
