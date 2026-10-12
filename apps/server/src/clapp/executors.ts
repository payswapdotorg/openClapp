import { PDFDocument } from "pdf-lib";
import type {
  ClappStage,
  ClappTaskInput,
  EvidenceBundle,
  EvidenceRef,
  ReconstructionSpec,
  SynthesisPlan,
} from "../../../../packages/clapp-contracts/src/index.ts";
import {
  classifyFromIr,
  composeExploredIr,
  createPackageRegistry,
  deserializeBehavioralIr,
  explore,
  extractBehavioralIr,
  extractPackageCandidates,
  type GatedPromotionEvaluation,
  type PackageStore,
  promoteGated,
  registerCandidates,
  serializeBehavioralIr,
} from "../../../../packages/clapp-intelligence/src/index.ts";
import {
  type AuthorizationRecord,
  type AuthorizationStore,
  authorizationRecordKey,
  buildAuthorizationRecord,
  sha256Hex,
} from "../../../../packages/clapp-observation/src/index.ts";
import type { OpenMuseRuntime } from "../../../../packages/clapp-runtime-openmuse/src/index.ts";
import {
  type ClappTaskContext,
  type ClappTaskSnapshot,
  candidateSeamOf,
  readClappRunState,
  type StageExecutor,
  type StageExecutorResult,
} from "../../../../packages/clapp-runtime-openmuse/src/index.ts";
import type {
  GeneratedApp,
  PairedJourney,
  PairedSide,
  PairedSuiteResult,
  RepairReport,
} from "../../../../packages/clapp-synthesis/src/index.ts";
import {
  deserializeSynthesisPlan,
  digestE2eAcceptance,
  generateCandidateApp,
  materializeCandidate,
  planSynthesisApp,
  runGeneratedCandidateBuild,
  runPairedSuite,
  runRepairLoop,
  serializeSynthesisPlan,
  validateGeneratedApp,
  validateSynthesisPlan,
} from "../../../../packages/clapp-synthesis/src/index.ts";

/**
 * CLAPP-W3-013 — the real stage executors: the reconstruction chain goes live.
 *
 * One `StageExecutor` that dispatches each of the ten frozen CLAPP stages to
 * its REAL package algorithm, composed read-only (nothing under `packages/**`
 * is re-implemented, mirrored or faked here — every stage calls the frozen
 * exported functions directly):
 *
 * - authorization — the W1-008 record-backed verification: the stored record
 *   is read through the frozen `AuthorizationStore` port, its shape is
 *   validated by re-deriving it through the REAL `buildAuthorizationRecord`
 *   (which throws with every violation when the underlying authorization is
 *   malformed), the content-addressed id must match the stored id byte-exact,
 *   the record must authorize the spec's own target and owner, and the expiry
 *   is evaluated against the injected clock. Benchmark-owned targets with no
 *   stored record take SECURITY.md's implicit path (minted, persisted and
 *   re-read through the port before anything is claimed).
 * - capture — the W1-002 observation semantics over the runtime adapter's
 *   `providers.observation` (browser session evidence with explicit
 *   unavailable states); the bundle lands as a real content-addressed
 *   artifact through `providers.artifacts`.
 * - explore — the REAL W2-003 `explore` over the baseline IR the REAL W2-002
 *   `extractBehavioralIr` derives from the captured bundle, under the spec's
 *   own exploration seed and a conservatively-mapped budget.
 * - model — the W2-001 Behavioral IR construction: `extractBehavioralIr` from
 *   the captured evidence, deepened by `composeExploredIr` when the explore
 *   stage's result exists.
 * - plan — the REAL W3-001 `planSynthesisApp` + `validateSynthesisPlan`.
 * - synthesize — the REAL W3-002 `generateCandidateApp` + `validateGeneratedApp`,
 *   then the W1-003 discipline: bounded candidate execution through the
 *   runtime's candidate seam (`materializeCandidate` + `runGeneratedCandidateBuild`).
 * - verify — the REAL paired differential verification (`runPairedSuite`)
 *   over the reference + candidate sides supplied by the injected
 *   {@link ClappPairedSideSource} binding.
 * - repair — the REAL bounded repair loop (`runRepairLoop`) under the spec's
 *   frozen `verification.maxRepairIterations` budget, over the same paired
 *   binding.
 * - review — the REAL W3-008 `digestE2eAcceptance` over the run's actual
 *   artifacts, plus the promotion gate record (the parity verdict verbatim,
 *   never upgraded).
 * - promote — the REAL W2-006 `extractPackageCandidates` + `registerCandidates`
 *   and the REAL W2-010 `promoteGated` (which composes `decidePromotionGate`
 *   over the benchmark grounding report) with the executable-test-gated
 *   promotion rule.
 *
 * Honesty rules (the non-negotiable core):
 * - Where a stage's real inputs are unavailable — no browser session
 *   (capture), no candidate workspace (synthesize), no paired-side binding
 *   (verify/repair), no prior evidence artifact (every artifact consumer) —
 *   the executor returns the honest unavailable-state error naming the
 *   refusal. Nothing is fabricated, downgraded or silently skipped.
 * - Every stage output is written through `providers.artifacts.put` with the
 *   frozen metadata discipline (kind "stage-output", the target/classification/
 *   source markers), content-addressed and resumable — the W1-004 recovery
 *   semantics untouched (the W1-001 handler around this executor owns
 *   checkpointing, events and idempotence).
 * - The substrate's artifact store is a PDF store in v0.1, so every stage
 *   output rides a deterministic PDF envelope (the skeleton's own discipline,
 *   deepened): a one-page PDF whose document metadata carries the stage's
 *   full structured output, retrievable byte-exact (see
 *   {@link encodeStagePayload}).
 *
 * The skeleton executor (`createSkeletonStageExecutor` in `worker.ts`)
 * remains exported and available as the declared fallback for integration
 * seams a later lane may want to keep on placeholders; THIS composition
 * converts all ten stages, so none is bound as a fallback (the honest seam
 * table in the work record discloses the production wiring per stage).
 */

/** The frozen stage-output artifact kind (the W1-007 skeleton discipline). */
export const CLAPP_STAGE_OUTPUT_KIND = "stage-output";

/** The schema version stamped on every stage artifact payload envelope. */
const PAYLOAD_SCHEMA_VERSION = "0.1";

/** The classification each stage's artifact records (capture is observed; the rest are derived). */
const STAGE_CLASSIFICATIONS: Record<ClappStage, "observed" | "derived"> = {
  authorization: "derived",
  capture: "observed",
  explore: "derived",
  model: "derived",
  plan: "derived",
  synthesize: "derived",
  verify: "derived",
  repair: "derived",
  review: "derived",
  promote: "derived",
};

/** The source marker each stage's artifact records. */
const stageSource = (stage: ClappStage): string => `clapp:stage:${stage}`;

// ---------------------------------------------------------------------------
// The PDF envelope — the v0.1 substrate artifact discipline
// ---------------------------------------------------------------------------

/** The structured output a stage's artifact payload carries. */
export interface StageArtifactPayload {
  schemaVersion: string;
  stage: ClappStage;
  reconstructionId: string;
  output: unknown;
}

/**
 * Encodes a stage payload as a deterministic one-page PDF: the substrate's
 * artifact store accepts PDF documents only (v0.1), so the stage's full
 * structured output rides the document's metadata — byte-exact on retrieval,
 * deterministic per payload (identical payloads yield identical PDF bytes, so
 * the content-addressed artifact id stays stable across idempotent re-runs).
 */
export async function encodeStagePayload(payload: StageArtifactPayload): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  document.addPage();
  document.setTitle(`CLAPP stage output — ${payload.reconstructionId} — ${payload.stage}`);
  document.setSubject(JSON.stringify(payload));
  // pdf-lib otherwise embeds the wall clock in the Info dict, which would make
  // identical payloads produce different bytes (and different content ids).
  // The envelope's dates are pinned to the Unix epoch: timing belongs to the
  // stage records (W1-001), identity to the content addressing.
  const fixedEpoch = new Date(0);
  document.setCreationDate(fixedEpoch);
  document.setModificationDate(fixedEpoch);
  return new Uint8Array(await document.save());
}

/** Decodes a stage artifact's PDF envelope back into its payload. */
export async function decodeStagePayload(bytes: Uint8Array): Promise<StageArtifactPayload> {
  let subject: string | undefined;
  try {
    subject = (await PDFDocument.load(bytes)).getSubject();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`the artifact bytes are not a decodable PDF envelope (${message})`);
  }
  if (typeof subject !== "string" || subject.length === 0)
    throw new Error(
      "the artifact PDF carries no stage payload in its document metadata; it is not a real stage-output envelope",
    );
  const parsed = JSON.parse(subject) as Partial<StageArtifactPayload>;
  if (
    parsed.schemaVersion !== PAYLOAD_SCHEMA_VERSION ||
    typeof parsed.stage !== "string" ||
    typeof parsed.reconstructionId !== "string" ||
    !("output" in parsed)
  )
    throw new Error(
      "the artifact's payload envelope is malformed (schemaVersion, stage, reconstructionId or output missing)",
    );
  return parsed as StageArtifactPayload;
}

// ---------------------------------------------------------------------------
// The executor's dependencies
// ---------------------------------------------------------------------------

/**
 * The paired-side binding: how the verify and repair stages obtain the
 * reference and candidate sides of the differential pairing. A narrow
 * structural seam (the W1-003 CandidateSeam precedent): the frozen
 * `runPairedSuite`/`runRepairLoop` consume `PairedSide` handles, and any
 * faithful binding — a benchmark harness, a generated candidate's
 * start(port) adapter, a scripted test side — satisfies it without this
 * module importing its source. The candidate binding receives the CURRENT
 * plan (the repair loop re-materializes per repaired plan).
 */
export interface ClappPairedSideSource {
  /** A factory for fresh reference sides (started per verification run). */
  reference(spec: ReconstructionSpec, plan: SynthesisPlan): PairedSide | Promise<PairedSide>;
  /** Materializes the candidate side for a plan (the repaired plan included). */
  candidate(spec: ReconstructionSpec, plan: SynthesisPlan): PairedSide | Promise<PairedSide>;
}

/**
 * The benchmark evaluation the promotion gate composes (the W2-009
 * repeated-sequence build records). Supplied by the learning system when it
 * has measured the candidate; absent means unevaluated — the gate then
 * withholds with the recorded reason, never silently promoting.
 */
export type ClappPromotionEvaluationSource = (candidate: {
  id: string;
  version: string;
}) => GatedPromotionEvaluation | undefined | Promise<GatedPromotionEvaluation | undefined>;

/** Dependencies the real stage executor composes. */
export interface RealStageExecutorDeps {
  /** Reads the frozen spec of a reconstruction (cross-owner discovery by id). */
  readSpec(reconstructionId: string): Promise<ReconstructionSpec | null>;
  /**
   * Reads the durable tasks carrying a reconstruction (the W1-004 chain
   * view) — the executor derives each prior stage's output artifact ids from
   * the same task chain the run-state derivations use; there is no second
   * store.
   */
  readTasks(reconstructionId: string): Promise<ClappTaskSnapshot[]>;
  /** The W1-008 authorization-record port (the authorization stage's input). */
  authorizationStore: AuthorizationStore;
  /**
   * The W2-005 package-store port backing the promote stage's registry.
   * The production binding is the process-local in-memory store (the
   * catalog-store lane owns the durable wiring); tests supply their own.
   */
  packageStore: PackageStore;
  /**
   * The paired-side binding for verify + repair. Absent in the current
   * production wiring (disclosed): those stages then return the honest
   * unavailable-state error instead of fabricating a differential verdict.
   */
  pairedSides?: ClappPairedSideSource;
  /**
   * The benchmark evaluation source for the promotion gate. Absent means
   * the gate composes no evaluation and withholds with the recorded
   * unevaluated reason.
   */
  evaluation?: ClappPromotionEvaluationSource;
  /**
   * The declared skeleton fallback for integration seams this wiring does
   * not convert (the honest seam table names every fallback stage with its
   * reason). A stage dispatched to the fallback runs the placeholder — the
   * W1-007 skeleton's own honest "no real work" discipline — never a fake
   * real output.
   */
  fallback?: StageExecutor;
  /**
   * The stages dispatched to {@link fallback} (every other stage of the ten
   * runs its real algorithm). Empty or absent means no fallback is bound.
   */
  fallbackStages?: readonly ClappStage[];
  /**
   * The injectable clock (the W1-008 discipline): authorization expiry and
   * the promotion evidence's verifiedAt are evaluated against this source
   * only. Tests pin it; production callers omit it.
   */
  now?: () => number;
}

/** What {@link createRealStageExecutor} returns. */
export interface RealStageExecutor {
  /** The dispatching stage executor (one object, all ten stages). */
  executor: StageExecutor;
  /** How many times each stage's executor was invoked (test observability). */
  invocations(stage: ClappStage): number;
}

/** An honest unavailable-state refusal (never a fabricated success). */
const unavailable = (error: string): StageExecutorResult => ({ outputArtifactIds: [], error });

/** Renders an error honestly for an unavailable-state message. */
const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// ---------------------------------------------------------------------------
// Chain-artifact reading (the W1-004 derivation, no second store)
// ---------------------------------------------------------------------------

/** The artifact ids a prior stage's succeeded record carries. */
async function priorArtifactIds(
  deps: RealStageExecutorDeps,
  reconstructionId: string,
  stage: ClappStage,
): Promise<string[]> {
  const snapshots = await deps.readTasks(reconstructionId);
  const state = readClappRunState(snapshots.map((snapshot) => snapshot.task));
  const entry = state.stages.find((row) => row.stage === stage);
  return entry?.status === "succeeded" ? [...entry.outputArtifactIds] : [];
}

/** Reads and decodes one prior stage's single output artifact payload. */
async function readStagePayload(
  deps: RealStageExecutorDeps,
  providers: OpenMuseRuntime,
  input: ClappTaskInput,
  stage: ClappStage,
): Promise<StageArtifactPayload> {
  const ids = await priorArtifactIds(deps, input.reconstructionId, stage);
  const id = ids[0];
  if (id === undefined)
    throw new Error(
      `the ${input.stage} stage requires the ${stage} stage's output artifact; the durable chain records none (the ${stage} stage did not succeed) — refusing to guess`,
    );
  const bytes = await providers.artifacts.get(id);
  const payload = await decodeStagePayload(bytes);
  if (payload.reconstructionId !== input.reconstructionId)
    throw new Error(
      `the ${stage} stage's artifact belongs to reconstruction "${payload.reconstructionId}" but the chain is "${input.reconstructionId}"; durable state is inconsistent`,
    );
  return payload;
}

/** Reads a prior stage's payload when its record exists (soft dependency). */
async function maybeStagePayload(
  deps: RealStageExecutorDeps,
  providers: OpenMuseRuntime,
  input: ClappTaskInput,
  stage: ClappStage,
): Promise<StageArtifactPayload | undefined> {
  const ids = await priorArtifactIds(deps, input.reconstructionId, stage);
  if (ids[0] === undefined) return undefined;
  return readStagePayload(deps, providers, input, stage);
}

/** Writes one stage's output through the artifact provider (the frozen discipline). */
async function putStagePayload(
  providers: OpenMuseRuntime,
  input: ClappTaskInput,
  spec: ReconstructionSpec,
  output: unknown,
): Promise<EvidenceRef> {
  const bytes = await encodeStagePayload({
    schemaVersion: PAYLOAD_SCHEMA_VERSION,
    stage: input.stage,
    reconstructionId: input.reconstructionId,
    output,
  });
  return providers.artifacts.put({
    reconstructionId: input.reconstructionId,
    kind: CLAPP_STAGE_OUTPUT_KIND,
    bytes,
    metadata: {
      targetId: spec.targetId,
      classification: STAGE_CLASSIFICATIONS[input.stage],
      source: stageSource(input.stage),
    },
  });
}

/** The spec every stage needs, refused honestly when the record is absent. */
async function mustSpec(
  deps: RealStageExecutorDeps,
  input: ClappTaskInput,
): Promise<ReconstructionSpec> {
  const spec = await deps.readSpec(input.reconstructionId);
  if (!spec)
    throw new Error(
      `the real stage executor found no reconstruction record for "${input.reconstructionId}"; refusing to guess the artifact target`,
    );
  return spec;
}

// ---------------------------------------------------------------------------
// 1. authorization — the W1-008 record-backed verification
// ---------------------------------------------------------------------------

/** Maps a stored record's own fields back onto the authorization shape the frozen builder validates. */
function authorizationOfRecord(record: AuthorizationRecord): ReconstructionSpec["authorization"] {
  return {
    ownerId: record.ownerId,
    targetId: record.targetId,
    scope: [...record.scope],
    environments: [...record.environments],
    ...(record.expiresAt !== undefined ? { expiresAt: record.expiresAt } : {}),
    retention: record.retention,
    benchmarkOwned: record.benchmarkOwned,
    createdAt: record.grantedAt,
  };
}

/**
 * The authorization stage's real work: validate the STORED record's shape
 * and expiry. Shape: the REAL W1-008 `buildAuthorizationRecord` re-derives the
 * canonical record from the stored record's own fields (throwing with every
 * violation when they are malformed) and the content-addressed id must equal
 * the stored id byte-exact, so a tampered or malformed record fails closed.
 * The record must then authorize the spec's own target and owner. Expiry is
 * evaluated against the injected clock only. Benchmark-owned targets with no
 * stored record take SECURITY.md's implicit path: minted through the real
 * builder, persisted through the port, re-read before anything is claimed.
 */
async function executeAuthorization(
  deps: RealStageExecutorDeps,
  input: ClappTaskInput,
  providers: OpenMuseRuntime,
  spec: ReconstructionSpec,
): Promise<StageExecutorResult> {
  const now = typeof deps.now === "function" ? deps.now : Date.now;
  const store = deps.authorizationStore;
  const key = authorizationRecordKey(spec.targetId);
  let stored = await store.get(key);
  if (stored === undefined && spec.authorization.benchmarkOwned === true) {
    // SECURITY.md implicit benchmark authorization, the W1-008 gate's own
    // discipline: mint, persist, re-read — a record that was never stored
    // does not exist.
    const minted = buildAuthorizationRecord(spec.authorization, spec.authorization.ownerId);
    await store.put(key, minted);
    stored = await store.get(key);
  }
  if (stored === undefined)
    return unavailable(
      `the authorization stage found no persisted authorization record for target "${spec.targetId}"; the burden of proof is on the stored record (W1-008), and absence is a refusal, never a pass — refusing to authorize reconstruction "${input.reconstructionId}"`,
    );

  let expected: AuthorizationRecord;
  try {
    // The real builder validates every field (fail-closed with the complete
    // violation list) and re-derives the canonical content-addressed record.
    expected = buildAuthorizationRecord(authorizationOfRecord(stored), stored.operatorIdentity);
  } catch (error) {
    return unavailable(
      `the stored authorization record under key "${key}" for target "${spec.targetId}" is malformed: ${describeError(error)}; refusing to trust it`,
    );
  }
  if (expected.id !== stored.id)
    return unavailable(
      `the stored authorization record for target "${spec.targetId}" carries id "${stored.id}" but its own fields re-derive id "${expected.id}"; the record is tampered or inconsistent, and a mismatched record never authorizes`,
    );
  if (stored.targetId !== spec.targetId)
    return unavailable(
      `the stored authorization record ${stored.id} authorizes target "${stored.targetId}" but the reconstruction's spec names target "${spec.targetId}"; refusing to observe a target the record does not cover`,
    );
  if (stored.ownerId !== spec.authorization.ownerId)
    return unavailable(
      `the stored authorization record ${stored.id} for target "${stored.targetId}" names owner "${stored.ownerId}" but the reconstruction's authorization names owner "${spec.authorization.ownerId}"; scope is never widened beyond the record`,
    );
  if (stored.expiresAt !== undefined) {
    const expiresAtMs = Date.parse(stored.expiresAt);
    if (Number.isNaN(expiresAtMs))
      return unavailable(
        `authorization record ${stored.id} for target "${stored.targetId}" carries an unparseable expiresAt "${stored.expiresAt}"; refusing to observe`,
      );
    if (expiresAtMs < now())
      return unavailable(
        `authorization record ${stored.id} for target "${stored.targetId}" expired at ${stored.expiresAt} and no longer backs the reconstruction; refusing to observe`,
      );
  }

  const reference = await putStagePayload(providers, input, spec, {
    authorizationRecordId: stored.id,
    targetId: stored.targetId,
    ownerId: stored.ownerId,
    scope: [...stored.scope],
    environments: [...stored.environments],
    ...(stored.expiresAt !== undefined ? { expiresAt: stored.expiresAt } : {}),
    retention: stored.retention,
    benchmarkOwned: stored.benchmarkOwned,
    authorizationKind: stored.authorizationKind,
    operatorIdentity: stored.operatorIdentity,
    grantedAt: stored.grantedAt,
  });
  return { outputArtifactIds: [reference.id] };
}

// ---------------------------------------------------------------------------
// 2. capture — the W1-002 observation semantics over the runtime providers
// ---------------------------------------------------------------------------

/**
 * The capture stage: real browser-session evidence through the runtime's
 * observation provider (the W1-002 discipline — a channel the handle cannot
 * produce is returned classified "unavailable", never "observed"), landed as
 * a real content-addressed artifact. A provider refusal (no browser session
 * handle, a failed observe) is the honest unavailable-state error naming the
 * reason; no evidence is ever fabricated.
 */
async function executeCapture(
  input: ClappTaskInput,
  providers: OpenMuseRuntime,
  context: ClappTaskContext,
  spec: ReconstructionSpec,
): Promise<StageExecutorResult> {
  let bundle: EvidenceBundle;
  try {
    bundle = await providers.observation.observe(spec, context.signal);
  } catch (error) {
    return unavailable(
      `the capture stage could not observe target "${spec.targetId}" for reconstruction "${input.reconstructionId}": the runtime's observation provider refused: ${describeError(error)}; no evidence was fabricated`,
    );
  }
  const reference = await putStagePayload(providers, input, spec, bundle);
  return { outputArtifactIds: [reference.id] };
}

// ---------------------------------------------------------------------------
// 3. explore — the REAL W2-003 deepening over the baseline IR
// ---------------------------------------------------------------------------

/** Reads the capture stage's bundle payload as an evidence bundle (fail closed). */
async function readCaptureBundle(
  deps: RealStageExecutorDeps,
  providers: OpenMuseRuntime,
  input: ClappTaskInput,
): Promise<EvidenceBundle> {
  const payload = await readStagePayload(deps, providers, input, "capture");
  const output = payload.output as Partial<EvidenceBundle>;
  if (
    typeof output !== "object" ||
    output === null ||
    !Array.isArray(output.refs) ||
    typeof output.rootSha256 !== "string"
  )
    throw new Error(
      "the capture stage's artifact is not an evidence bundle (no refs array / root sha256); refusing to explore over it",
    );
  return output as EvidenceBundle;
}

/**
 * The exploration budget mapped conservatively from the spec's own frozen
 * numbers: journeys are capped by `maxStages`, per-journey steps by
 * `maxActions` — over-bounding (never under-bounding) so exploration stays
 * within the spec's declared budget while the seed rides verbatim.
 */
function explorationBudgetOf(spec: ReconstructionSpec) {
  return {
    maxJourneys: spec.exploration.maxStages,
    maxStepsPerJourney: spec.exploration.maxActions,
  };
}

/** The explore stage: the REAL W2-002 extraction then the REAL W2-003 deepening. */
async function executeExplore(
  deps: RealStageExecutorDeps,
  input: ClappTaskInput,
  providers: OpenMuseRuntime,
  spec: ReconstructionSpec,
): Promise<StageExecutorResult> {
  const bundle = await readCaptureBundle(deps, providers, input);
  const baseline = extractBehavioralIr({ bundle, spec });
  const result = explore({
    ir: baseline,
    seed: spec.exploration.seed,
    budget: explorationBudgetOf(spec),
  });
  const reference = await putStagePayload(providers, input, spec, result);
  return { outputArtifactIds: [reference.id] };
}

// ---------------------------------------------------------------------------
// 4. model — the W2-001 Behavioral IR construction
// ---------------------------------------------------------------------------

/**
 * The model stage: the REAL W2-002 `extractBehavioralIr` from the captured
 * evidence, deepened by the REAL W2-003 `composeExploredIr` when the explore
 * stage's result exists (a chain that skipped explore models the baseline
 * honestly). The artifact carries the canonical `serializeBehavioralIr` form.
 */
async function executeModel(
  deps: RealStageExecutorDeps,
  input: ClappTaskInput,
  providers: OpenMuseRuntime,
  spec: ReconstructionSpec,
): Promise<StageExecutorResult> {
  const bundle = await readCaptureBundle(deps, providers, input);
  const baseline = extractBehavioralIr({ bundle, spec });
  const explorePayload = await maybeStagePayload(deps, providers, input, "explore");
  let ir = baseline;
  if (explorePayload !== undefined) {
    const result = explorePayload.output as {
      journeys?: unknown;
      assumptions?: unknown;
    };
    if (!Array.isArray(result.journeys) || !Array.isArray(result.assumptions))
      return unavailable(
        "the explore stage's artifact is not an exploration result (journeys/assumptions missing); refusing to compose it into the model",
      );
    ir = composeExploredIr(baseline, explorePayload.output as never);
  }
  const reference = await putStagePayload(providers, input, spec, serializeBehavioralIr(ir));
  return { outputArtifactIds: [reference.id] };
}

// ---------------------------------------------------------------------------
// 5. plan — the REAL W3-001 planner
// ---------------------------------------------------------------------------

/** Reads the model stage's canonical IR text and validates it with the real deserializer. */
async function readModelIr(
  deps: RealStageExecutorDeps,
  providers: OpenMuseRuntime,
  input: ClappTaskInput,
): Promise<ReturnType<typeof deserializeBehavioralIr>> {
  const payload = await readStagePayload(deps, providers, input, "model");
  if (typeof payload.output !== "string")
    throw new Error(
      "the model stage's artifact does not carry the canonical Behavioral IR serialization",
    );
  return deserializeBehavioralIr(payload.output);
}

/**
 * The plan stage: the REAL W3-001 `planSynthesisApp` (no package ids — the
 * retrieval lane is not wired into the chain; the planner records the honest
 * derived assumption itself) validated by the REAL `validateSynthesisPlan`,
 * carried canonically through `serializeSynthesisPlan`.
 */
async function executePlan(
  deps: RealStageExecutorDeps,
  input: ClappTaskInput,
  providers: OpenMuseRuntime,
  spec: ReconstructionSpec,
): Promise<StageExecutorResult> {
  const model = await readModelIr(deps, providers, input);
  if (!model.ok || model.ir === undefined)
    return unavailable(
      `the model stage's Behavioral IR failed validation: ${(model.errors ?? []).join("; ")}; refusing to plan over an invalid model`,
    );
  const plan = await planSynthesisApp(spec, model.ir, []);
  const validation = validateSynthesisPlan(plan);
  if (!validation.ok)
    return unavailable(
      `the synthesis plan the real planner derived failed structural validation: ${validation.errors.join("; ")}; failing closed`,
    );
  const reference = await putStagePayload(providers, input, spec, serializeSynthesisPlan(plan));
  return { outputArtifactIds: [reference.id] };
}

/** Reads the plan stage's canonical text and validates it with the real deserializer. */
async function readPlan(
  deps: RealStageExecutorDeps,
  providers: OpenMuseRuntime,
  input: ClappTaskInput,
): Promise<SynthesisPlan> {
  const payload = await readStagePayload(deps, providers, input, "plan");
  if (typeof payload.output !== "string")
    throw new Error(
      "the plan stage's artifact does not carry the canonical SynthesisPlan serialization",
    );
  const result = deserializeSynthesisPlan(payload.output);
  if (!result.ok || result.plan === undefined)
    throw new Error(
      `the plan stage's artifact failed plan validation: ${result.errors.join("; ")}`,
    );
  return result.plan;
}

// ---------------------------------------------------------------------------
// 6. synthesize — the REAL W3-002 candidate + the W1-003 bounded execution
// ---------------------------------------------------------------------------

/** The synthesize stage's output record (the honest execution disclosure). */
interface SynthesizeStageOutput {
  app: GeneratedApp;
  materialization: {
    workspaceId: string;
    workspacePath: string;
    buildCommand: string;
    testCommand: string;
  };
  execution: {
    steps: { name: string; command: string; exitCode: number }[];
    exitCode: number;
    succeeded: boolean;
  };
}

/**
 * The synthesize stage: the REAL W3-002 `generateCandidateApp` over the plan
 * (validated by the REAL `validateGeneratedApp`), then the W1-003 discipline —
 * bounded candidate execution through the runtime's candidate seam
 * (`materializeCandidate` + `runGeneratedCandidateBuild`, which composes the
 * manifest's own build and test commands). Where the seam cannot run (no
 * candidate options wired, no computer handle, the sandbox refusing), the
 * stage returns the honest unavailable-state error and claims nothing; a
 * failed build or test fails the stage with the recorded step outcomes.
 */
async function executeSynthesize(
  deps: RealStageExecutorDeps,
  input: ClappTaskInput,
  providers: OpenMuseRuntime,
  context: ClappTaskContext,
  spec: ReconstructionSpec,
): Promise<StageExecutorResult> {
  const plan = await readPlan(deps, providers, input);
  const app = generateCandidateApp(plan);
  const validation = validateGeneratedApp(app);
  if (!validation.ok)
    return unavailable(
      `the generated candidate failed structural validation: ${validation.errors.join("; ")}; refusing to materialize a broken candidate`,
    );

  const seam = candidateSeamOf(providers);
  let output: SynthesizeStageOutput;
  try {
    const materialization = await materializeCandidate(app, seam, {
      reconstructionId: input.reconstructionId,
      network: "deny",
    });
    const execution = await runGeneratedCandidateBuild(seam, materialization, context.signal);
    output = {
      app,
      materialization: {
        workspaceId: materialization.workspaceId,
        workspacePath: materialization.workspacePath,
        buildCommand: materialization.buildCommand,
        testCommand: materialization.testCommand,
      },
      execution: {
        steps: execution.steps.map((step) => ({
          name: step.name,
          command: step.command,
          exitCode: step.exitCode,
        })),
        exitCode: execution.exitCode,
        succeeded: execution.succeeded,
      },
    };
  } catch (error) {
    return unavailable(
      `the synthesize stage generated the candidate artifact for reconstruction "${input.reconstructionId}" but the runtime's candidate-execution seam refused to run it (no candidate workspace): ${describeError(error)}; the stage claims no execution it did not perform`,
    );
  }
  if (!output.execution.succeeded) {
    const steps = output.execution.steps
      .map((step) => `${step.name} exited ${step.exitCode}`)
      .join("; ");
    return unavailable(
      `the candidate's bounded execution failed for reconstruction "${input.reconstructionId}" (${steps}); the generated artifact is not claimed as verified`,
    );
  }
  const reference = await putStagePayload(providers, input, spec, output);
  return { outputArtifactIds: [reference.id] };
}

// ---------------------------------------------------------------------------
// 7. verify — the REAL paired differential verification
// ---------------------------------------------------------------------------

/** The verify stage's output record: the driven journeys plus the full suite. */
interface VerifyStageOutput {
  journeys: PairedJourney[];
  suite: PairedSuiteResult;
}

/** Reads the synthesize stage's output record (fail closed). */
async function readSynthesizeOutput(
  deps: RealStageExecutorDeps,
  providers: OpenMuseRuntime,
  input: ClappTaskInput,
): Promise<SynthesizeStageOutput> {
  const payload = await readStagePayload(deps, providers, input, "synthesize");
  const output = payload.output as SynthesizeStageOutput;
  if (
    typeof output !== "object" ||
    output === null ||
    typeof output.app !== "object" ||
    output.app === null ||
    !Array.isArray(output.app.files) ||
    typeof output.app.manifest !== "object" ||
    output.app.manifest === null
  )
    throw new Error(
      "the synthesize stage's artifact is not a generated-app record (manifest/files missing)",
    );
  return output;
}

/**
 * Derives the paired journeys the verification drives: the plan's acceptance
 * selection resolved onto the generated app's own route table (routes.json,
 * the real generated surface), each carrying the route name as its anchor
 * (the name every generated journey page renders as its h1 — the plan's own
 * derivable anchor, never an invented one). API-check journeys are
 * deliberately not derived: the reference-side API binding does not exist
 * yet, and parity is never claimed over a channel that cannot run.
 */
function pairedJourneysOf(plan: SynthesisPlan, synth: SynthesizeStageOutput): PairedJourney[] {
  const routesFile = synth.app.files.find((file) => file.path === "routes.json");
  if (routesFile === undefined)
    throw new Error(
      "the generated candidate carries no routes.json; its route table cannot be read",
    );
  const routes = JSON.parse(routesFile.content) as {
    journeyId: string;
    name: string;
    path: string;
  }[];
  const byJourney = new Map(routes.map((route) => [route.journeyId, route]));
  const journeys: PairedJourney[] = [];
  for (const journeyId of plan.acceptanceJourneyIds) {
    const route = byJourney.get(journeyId);
    if (route === undefined) continue;
    journeys.push({
      id: route.journeyId,
      name: route.name,
      routePath: route.path,
      anchors: [route.name],
    });
  }
  return journeys;
}

/** The diff-dimension policy derived from the spec's own verification flags. */
function dimensionsOf(spec: ReconstructionSpec) {
  return {
    visual: spec.verification.visual,
    network: spec.verification.network,
  };
}

/**
 * The verify stage: the REAL `runPairedSuite` driving the acceptance journeys
 * against the reference and candidate sides supplied by the paired-side
 * binding. Without a binding there is no differential verification — the
 * honest unavailable-state error, never a fabricated verdict.
 */
async function executeVerify(
  deps: RealStageExecutorDeps,
  input: ClappTaskInput,
  providers: OpenMuseRuntime,
  spec: ReconstructionSpec,
): Promise<StageExecutorResult> {
  const sides = deps.pairedSides;
  if (sides === undefined)
    return unavailable(
      `the verify stage has no paired-side binding for reconstruction "${input.reconstructionId}" (no reference/candidate binding is wired into this composition); a differential verdict is never fabricated without both sides — refusing to verify`,
    );
  const plan = await readPlan(deps, providers, input);
  const synth = await readSynthesizeOutput(deps, providers, input);
  const journeys = pairedJourneysOf(plan, synth);
  if (journeys.length === 0)
    return unavailable(
      `the plan pins no acceptance journeys resolvable onto the generated routes for reconstruction "${input.reconstructionId}"; there is nothing to verify and no verdict is invented`,
    );
  const suite = await runPairedSuite({
    journeys,
    reference: await sides.reference(spec, plan),
    candidate: await sides.candidate(spec, plan),
    reconstructionId: input.reconstructionId,
    dimensions: dimensionsOf(spec),
  });
  const reference = await putStagePayload(providers, input, spec, {
    journeys,
    suite,
  } satisfies VerifyStageOutput);
  return { outputArtifactIds: [reference.id] };
}

// ---------------------------------------------------------------------------
// 8. repair — the REAL bounded repair loop
// ---------------------------------------------------------------------------

/**
 * The repair stage: the REAL `runRepairLoop` over the plan, re-materializing
 * the candidate per repaired plan through the paired binding, under the
 * spec's frozen `verification.maxRepairIterations` budget. Without a binding
 * the honest unavailable-state error. The artifact carries the full report
 * (id, iterations, abstentions, the final verdict verbatim and the repaired
 * finalPlan — the deliverable handed to regeneration).
 */
async function executeRepair(
  deps: RealStageExecutorDeps,
  input: ClappTaskInput,
  providers: OpenMuseRuntime,
  spec: ReconstructionSpec,
): Promise<StageExecutorResult> {
  const sides = deps.pairedSides;
  if (sides === undefined)
    return unavailable(
      `the repair stage has no paired-side binding for reconstruction "${input.reconstructionId}" (no reference/candidate binding is wired into this composition); the bounded repair loop cannot re-verify — refusing to run it`,
    );
  const plan = await readPlan(deps, providers, input);
  const synth = await readSynthesizeOutput(deps, providers, input);
  const journeys = pairedJourneysOf(plan, synth);
  if (journeys.length === 0)
    return unavailable(
      `the plan pins no acceptance journeys for reconstruction "${input.reconstructionId}"; the repair loop has nothing to drive`,
    );
  // The loop's reference factory is synchronous by contract, so the binding's
  // reference side resolves once here and every verification run restarts it
  // (the paired-side contract: each start() yields a fresh running side).
  const referenceSide = await sides.reference(spec, plan);
  const report = await runRepairLoop({
    reference: () => referenceSide,
    candidatePlan: plan,
    materialize: (repaired) => sides.candidate(spec, repaired),
    journeys,
    budget: spec.verification.maxRepairIterations,
    reconstructionId: input.reconstructionId,
    dimensions: dimensionsOf(spec),
  });
  const reference = await putStagePayload(providers, input, spec, report);
  return { outputArtifactIds: [reference.id] };
}

// ---------------------------------------------------------------------------
// 9. review — the REAL W3-008 digest + the promotion gate record
// ---------------------------------------------------------------------------

/** The review stage's output record: the digest plus the gate verdict. */
interface ReviewStageOutput {
  digest: ReturnType<typeof digestE2eAcceptance>;
  gate: {
    rule: string;
    parityVerdict: string;
    promotionReady: boolean;
  };
}

/**
 * The review stage: the REAL W3-008 `digestE2eAcceptance` mapped over the
 * run's ACTUAL artifacts (every stage outcome derived from what that stage
 * returned; absent stages recorded unavailable with reasons, never
 * fabricated), plus the promotion gate record — the parity verdict carried
 * verbatim (never upgraded) and the executable-test-gated promotion rule
 * stated: promotion proceeds only on a verified "equivalent" final parity.
 */
async function executeReview(
  deps: RealStageExecutorDeps,
  input: ClappTaskInput,
  providers: OpenMuseRuntime,
  spec: ReconstructionSpec,
): Promise<StageExecutorResult> {
  const capture = await readStagePayload(deps, providers, input, "capture");
  const model = await readModelIr(deps, providers, input);
  if (!model.ok || model.ir === undefined)
    return unavailable(
      `the review stage cannot read the behavioral model: ${(model.errors ?? []).join("; ")}`,
    );
  const plan = await readPlan(deps, providers, input);
  const synth = await readSynthesizeOutput(deps, providers, input);
  const verifyPayload = await maybeStagePayload(deps, providers, input, "verify");
  const verifyOutput =
    verifyPayload !== undefined ? (verifyPayload.output as VerifyStageOutput) : undefined;
  const repairPayload = await maybeStagePayload(deps, providers, input, "repair");
  const repairReport =
    repairPayload !== undefined ? (repairPayload.output as RepairReport) : undefined;
  if (verifyOutput !== undefined && !Array.isArray(verifyOutput.journeys))
    return unavailable("the verify stage's artifact carries no driven journeys array");
  if (
    repairReport !== undefined &&
    (typeof repairReport.converged !== "boolean" ||
      typeof repairReport.stoppedBy !== "string" ||
      !Array.isArray(repairReport.iterations) ||
      !Array.isArray(repairReport.abstained) ||
      typeof repairReport.finalVerdict !== "string")
  )
    return unavailable("the repair stage's artifact is not a repair report");

  const digest = digestE2eAcceptance({
    reconstructionId: input.reconstructionId,
    observation: capture.output as EvidenceBundle,
    extraction: model.ir,
    plan,
    candidate: synth.app,
    verification: verifyOutput?.suite,
    ...(repairReport !== undefined
      ? { repair: repairReport }
      : {
          repairUnavailableReason:
            "the repair stage did not run in this chain; no repair outcome is fabricated",
        }),
    journeys: verifyOutput?.journeys ?? [],
  });
  const output: ReviewStageOutput = {
    digest,
    gate: {
      rule: "promotion proceeds only on a verified 'equivalent' final parity verdict (the executable-test-gated promotion rule, W2-010); the verdict is carried verbatim and never upgraded",
      parityVerdict: digest.finalParityVerdict,
      promotionReady: digest.finalParityVerdict === "equivalent",
    },
  };
  const reference = await putStagePayload(providers, input, spec, output);
  return { outputArtifactIds: [reference.id] };
}

// ---------------------------------------------------------------------------
// 10. promote — the REAL W2-006 extraction + the REAL W2-010 gate
// ---------------------------------------------------------------------------

/** The promote stage's output record: the parity, the extraction, the gate. */
interface PromoteStageOutput {
  parity: {
    verdict: string;
    verificationRunId: string;
    minorFindings: number;
    majorFindings: number;
    verifiedAt: string;
    derivation: string;
  };
  extraction: ReturnType<typeof extractPackageCandidates>;
  registration: ReturnType<typeof registerCandidates>;
  outcomes: {
    candidate: { id: string; version: string };
    outcome: ReturnType<typeof promoteGated>;
  }[];
}

/** Reads the repair stage's report (fail closed on shape). */
async function readRepairReport(
  deps: RealStageExecutorDeps,
  providers: OpenMuseRuntime,
  input: ClappTaskInput,
): Promise<RepairReport> {
  const payload = await readStagePayload(deps, providers, input, "repair");
  const report = payload.output as RepairReport;
  if (
    typeof report !== "object" ||
    report === null ||
    typeof report.id !== "string" ||
    typeof report.finalVerdict !== "string" ||
    typeof report.converged !== "boolean" ||
    !Array.isArray(report.iterations)
  )
    throw new Error(
      "the repair stage's artifact is not a repair report (id/finalVerdict/converged/iterations missing)",
    );
  return report;
}

/**
 * The promote stage: the learning loop's gate, composed from the REAL frozen
 * functions only. The final parity summary derives from the repair loop's own
 * final verdict (the loop's convergence semantics are the W2-006 discipline:
 * a converged loop verified zero findings at or above minor severity, and the
 * report's content-addressed id cites the verification run); the plan
 * inventory and the IR digest derive from the plan and model artifacts; the
 * category derives from the REAL W2-004 classifier. The REAL W2-006
 * `extractPackageCandidates` then abstains or produces schema-valid
 * candidates, the REAL W2-005 registry registers them, and the REAL W2-010
 * `promoteGated` (composing `decidePromotionGate` over the benchmark
 * grounding report) applies the executable-test-gated promotion rule:
 * promotion happens only when both the parity discipline and the benchmark
 * evaluation gate pass; every refusal is carried verbatim with its reasons.
 */
async function executePromote(
  deps: RealStageExecutorDeps,
  input: ClappTaskInput,
  providers: OpenMuseRuntime,
  spec: ReconstructionSpec,
): Promise<StageExecutorResult> {
  const now = typeof deps.now === "function" ? deps.now : Date.now;
  const report = await readRepairReport(deps, providers, input);
  const plan = await readPlan(deps, providers, input);
  const model = await readModelIr(deps, providers, input);
  if (!model.ok || model.ir === undefined)
    return unavailable(
      `the promote stage cannot read the behavioral model: ${(model.errors ?? []).join("; ")}`,
    );

  // The final parity summary: the repair loop's verdict is the final word,
  // and its convergence semantics prove the zero-blocking-finding counts. The
  // blocking total in the non-converged case is the loop's own >=-minor count
  // (recorded in minorFindings — the repair report carries no severity split,
  // and every downstream gate refuses a non-equivalent verdict before the
  // counts are ever consumed; the derivation is disclosed on the artifact).
  const lastIteration = report.iterations[report.iterations.length - 1];
  const blockingTotal = report.converged ? 0 : (lastIteration?.findingsAfter ?? 0);
  const parity = {
    verdict: report.finalVerdict,
    verificationRunId: report.id,
    minorFindings: blockingTotal,
    majorFindings: 0,
    verifiedAt: new Date(now()).toISOString(),
    derivation:
      "verdict and verification run id carried verbatim from the repair loop's content-addressed report; counts are the loop's own zero-blocking convergence semantics (a converged loop verified zero findings at or above minor severity), and the non-converged blocking total is recorded in minorFindings because the repair report carries no severity split",
  };

  // The structural plan inventory (the generated surface's own derivable
  // entries — component definition fields pass through and malformed entries
  // are dropped by the extractor's own normalizer, never invented here).
  const inventory = {
    components: plan.components.flatMap((entry: Record<string, unknown>) => {
      const definition = entry.definition as Record<string, unknown> | undefined;
      if (
        typeof definition?.path === "string" &&
        typeof definition?.kind === "string" &&
        typeof definition?.name === "string"
      )
        return [{ path: definition.path, kind: definition.kind, name: definition.name }];
      return [];
    }),
    apiEntries: (plan.api as Record<string, unknown>[]).map((entry) => ({
      path: `/api/${String(entry.key)}`,
    })),
    persistenceKeys: (plan.persistence as Record<string, unknown>[]).map((entry) =>
      String(entry.key),
    ),
  };

  const archetype = { label: classifyFromIr({ ir: model.ir }).label };
  const modelPayload = await readStagePayload(deps, providers, input, "model");
  if (typeof modelPayload.output !== "string")
    throw new Error("the model stage's artifact does not carry the canonical IR serialization");
  const irDigest = sha256Hex(modelPayload.output);

  const extraction = extractPackageCandidates({
    reconstructionId: input.reconstructionId,
    parity: {
      verdict: parity.verdict as "equivalent" | "divergent" | "blocked",
      verificationRunId: parity.verificationRunId,
      minorFindings: parity.minorFindings,
      majorFindings: parity.majorFindings,
    },
    planInventory: inventory,
    archetype,
    irDigest,
  });

  const registry = createPackageRegistry(deps.packageStore);
  const registration = registerCandidates(registry, extraction.candidates);
  const outcomes: PromoteStageOutput["outcomes"] = [];
  for (const candidate of extraction.candidates) {
    const coordinate = {
      id: candidate.package.id,
      version: candidate.package.version,
    };
    const evaluation = deps.evaluation ? await deps.evaluation(coordinate) : undefined;
    const outcome = promoteGated(registry, {
      candidate: coordinate,
      parity: {
        verdict: parity.verdict as "equivalent" | "divergent" | "blocked",
        verificationRunId: parity.verificationRunId,
        verifiedAt: parity.verifiedAt,
        minorFindings: parity.minorFindings,
        majorFindings: parity.majorFindings,
        reconstructionId: input.reconstructionId,
        irDigest,
      },
      ...(evaluation !== undefined ? { evaluation } : {}),
    });
    outcomes.push({ candidate: coordinate, outcome });
  }

  const reference = await putStagePayload(providers, input, spec, {
    parity,
    extraction,
    registration,
    outcomes,
  } satisfies PromoteStageOutput);
  return { outputArtifactIds: [reference.id] };
}

// ---------------------------------------------------------------------------
// The dispatcher
// ---------------------------------------------------------------------------

/**
 * Creates the real stage executor: one `StageExecutor` dispatching each of the
 * ten frozen CLAPP stages to its real algorithm above. Unexpected conditions a
 * stage cannot honestly resolve throw, and the W1-001 handler around this
 * executor records them as the stage's failure; every anticipated
 * unavailability is the honest unavailable-state error returned by the stage.
 * The returned invocation counts exist for deterministic test observability.
 */
export function createRealStageExecutor(deps: RealStageExecutorDeps): RealStageExecutor {
  const invocations = new Map<ClappStage, number>();
  const fallbackStages = new Set(deps.fallbackStages ?? []);
  const executor: StageExecutor = {
    async execute(input, providers, context): Promise<StageExecutorResult> {
      invocations.set(input.stage, (invocations.get(input.stage) ?? 0) + 1);
      // The declared fallback: the honest seam table names each of these
      // stages with its reason — the placeholder runs, never a fake real run.
      if (deps.fallback !== undefined && fallbackStages.has(input.stage))
        return deps.fallback.execute(input, providers, context);
      if (!providers)
        return unavailable(
          "the real stage executor was invoked without the runtime's providers; the stage's outputs cannot be recorded",
        );
      const spec = await mustSpec(deps, input);
      switch (input.stage) {
        case "authorization":
          return executeAuthorization(deps, input, providers, spec);
        case "capture":
          return executeCapture(input, providers, context, spec);
        case "explore":
          return executeExplore(deps, input, providers, spec);
        case "model":
          return executeModel(deps, input, providers, spec);
        case "plan":
          return executePlan(deps, input, providers, spec);
        case "synthesize":
          return executeSynthesize(deps, input, providers, context, spec);
        case "verify":
          return executeVerify(deps, input, providers, spec);
        case "repair":
          return executeRepair(deps, input, providers, spec);
        case "review":
          return executeReview(deps, input, providers, spec);
        case "promote":
          return executePromote(deps, input, providers, spec);
      }
    },
  };
  return { executor, invocations: (stage) => invocations.get(stage) ?? 0 };
}
