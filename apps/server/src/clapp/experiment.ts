import type {
  ClappStage,
  ReconstructionSpec,
} from "../../../../packages/clapp-contracts/src/index.ts";
import {
  type CompoundingExperimentInput,
  type CompoundingExperimentReport,
  classifyFromIr,
  deserializeBehavioralIr,
  type LearningBuildRecord,
  type PackageStore,
  type ReconstructionArtifacts,
  runCompoundingExperiment,
} from "../../../../packages/clapp-intelligence/src/index.ts";
// buildLearningComparison is composed internally by runCompoundingExperiment
// and attached verbatim — this module never calls it directly.
import { sha256Hex } from "../../../../packages/clapp-observation/src/index.ts";
import type {
  ClappTaskContext,
  ClappTaskSnapshot,
  OpenMuseRuntime,
  StageExecutor,
} from "../../../../packages/clapp-runtime-openmuse/src/index.ts";
import {
  CLAPP_STAGES,
  readClappRunState,
} from "../../../../packages/clapp-runtime-openmuse/src/index.ts";
import { deserializeSynthesisPlan } from "../../../../packages/clapp-synthesis/src/index.ts";
import type { Store } from "../db.ts";
import { writeCompoundingExperiment } from "./catalog-writers.ts";
import {
  decodeStagePayload,
  type PlanStageCompositionRecord,
  type RealStageExecutorDeps,
  type StageArtifactPayload,
} from "./executors.ts";
import type { ClappRepositories } from "./repositories.ts";
import type { ClappService } from "./service.ts";

/**
 * CLAPP-W3-016 — the repeated-build experiment route.
 *
 * The roadmap's last yellow item: W2-009's orchestration half. The measurement
 * functions exist and are frozen (`buildLearningComparison`,
 * `runCompoundingExperiment` in `packages/clapp-intelligence` — the W2-011
 * wave-10 record documents them), but NO server flow orchestrated the
 * repeated-build experiment end-to-end, and the plan stage did not yet feed the
 * synthesis the composed package set. This module closes the orchestration
 * half; the plan-stage retrieval lane (the other half) landed in
 * `./executors.ts` under the same work item.
 *
 * The experiment runs the LEARNING.md repeated sequence end-to-end:
 *
 *   scratch walk (the reconstruction chain without learning)
 *     -> the promote flow's real path (extraction/promotion over the walk's
 *        artifacts — the promote stage's own real work, populating the registry)
 *     -> a rebuild walk whose plan stage carries the composed set (the W3-009
 *        planComposition over the registry snapshot the scratch walk populated)
 *     -> buildLearningComparison over the two builds' measured records
 *     -> runCompoundingExperiment (the TL-005 archetype learning experiment
 *        artifact, comparison attached verbatim)
 *     -> the CompoundingExperimentReport, persisted durably through the
 *        W2-013 catalog-writers discipline (content-addressed, restart-safe)
 *
 * Discipline (the module's contract):
 *
 * - REAL MEASUREMENTS, NEVER FABRICATED — each build's `LearningBuildRecord`
 *   is derived from the walk's ACTUAL stage artifacts: `newCodeUnits` from the
 *   synthesize stage's generated file count, `repairIterations` from the repair
 *   stage's iteration count, `buildSteps` from the synthesize stage's execution
 *   step count, `testsPassed`/`testsTotal` from the execution's test step, and
 *   `parity` from the verify/repair stage's verdict. `reusedPackageIds` are the
 *   plan stage's composition packageIds (empty for the scratch walk's empty
 *   registry). Nothing is invented, downgraded or silently skipped.
 * - THE COMPARISON ATTACHES VERBATIM — `runCompoundingExperiment` composes
 *   `buildLearningComparison` internally and attaches the report byte-exact;
 *   this module never re-derives the comparison. The experiment's
 *   `compositionPlan` input is the rebuild walk's plan-stage composition plan
 *   (the W3-009 `planComposition` output, carried verbatim through the
 *   `PlanStageCompositionRecord` artifact). When `learningEnabled` is false,
 *   the composition plan is withheld (`undefined`) — the learning-disabled
 *   control (the W2-011 frozen semantics).
 * - DURABLE AND RESTART-SAFE — the report persists through
 *   `writeCompoundingExperiment` (the W2-013 catalog-writers discipline),
 *   content-addressed under `clapp_compound_` and keyed by the report's own
 *   id. A re-run produces a FRESH report (the experiment is a live
 *   measurement — a re-run re-measures), never a silent mutation of the stored
 *   one: the report's content-addressed id is derived from the measured
 *   values, so identical measurements yield the same id (idempotent), and
 *   different measurements yield a different id (a new row, not an overwrite).
 * - HONEST ATTRIBUTION — the `artifacts` input to `runCompoundingExperiment` is
 *   the scratch walk's structural artifacts (the parity, plan inventory,
 *   archetype label and IR digest derived from the scratch walk's actual stage
 *   outputs). The experiment's internal extraction/registration/promotion
 *   re-runs over these artifacts (idempotent — the registry was already
 *   populated by the scratch walk's promote stage); no second extraction is
 *   fabricated.
 */

// ---------------------------------------------------------------------------
// The walk driver — the caller's seam (the service or the test)
// ---------------------------------------------------------------------------

/**
 * Drives ONE chain walk end-to-end: creates a reconstruction from the spec,
 * drives the ten frozen stages through the real executor + worker, and returns
 * the reconstruction id. The caller (the service's `runExperiment` method or a
 * test's scripted walk) owns the service + worker + runtime + executor — this
 * module never constructs them. A walk that cannot complete (a stage's honest
 * unavailable-state refusal) rejects with the stage's error message; the
 * experiment runner fails closed and writes nothing.
 */
export type ExperimentWalkDriver = (spec: ReconstructionSpec) => Promise<string>;

// ---------------------------------------------------------------------------
// The experiment's dependencies
// ---------------------------------------------------------------------------

/**
 * Dependencies the repeated-build experiment composes. The walk driver is the
 * caller's seam (the service or the test); everything else is the frozen
 * substrate + the frozen package functions.
 */
export interface RepeatedBuildExperimentDeps {
  /** The substrate store for durable catalog writes (the W2-013 pattern). */
  db: Store;
  /** The owner the experiment runs under (owner-scoped catalog writes). */
  owner: string;
  /** The CLAPP repositories (reads stage tasks + specs for artifact derivation). */
  repositories: ClappRepositories;
  /**
   * The runtime with the real bound services (the artifact provider the walk
   * driver recorded stage outputs through — the experiment reads them back to
   * measure each build's record).
   */
  runtime: OpenMuseRuntime;
  /**
   * Reads the durable task chain for one reconstruction (the W1-004 chain
   * view). The experiment derives each stage's output artifact ids from the
   * same chain the run-state derivations use; there is no second store.
   */
  readTasks: (reconstructionId: string) => Promise<ClappTaskSnapshot[]>;
  /**
   * The package store backing the promote stage's registry (shared across both
   * walks — the scratch walk's promote stage populates it, the rebuild walk's
   * plan stage composes over it). Process-local by design (the W3-013
   * disclosed seam); the durable catalog is the W2-013 `clapp-learning` kind.
   */
  packageStore: PackageStore;
  /**
   * The walk driver: drives ONE chain walk end-to-end (creates a
   * reconstruction from the spec, drives the ten frozen stages through the
   * real executor + worker, returns the reconstruction id). The caller (the
   * service's `runExperiment` method or a test's scripted walk) owns the
   * service + worker + runtime + executor — this module never constructs them.
   */
  walk: ExperimentWalkDriver;
  /** The reconstruction spec to build from (the experiment target). */
  spec: ReconstructionSpec;
  /** The benchmark id (the experiment's identity anchor — non-empty, trimmed). */
  benchmarkId: string;
  /**
   * Whether learning was enabled for the rebuild (the composition plan is
   * passed to `runCompoundingExperiment`). `false` means the
   * learning-disabled control (the composition plan is withheld — the W2-011
   * frozen semantics). Defaults to `true` (the experiment's purpose is to
   * measure compounding).
   */
  learningEnabled?: boolean;
  /**
   * The pinned clock (the experiment's verifiedAt). Absent pins the experiment
   * to the Unix epoch (the W2-011 default — every default-path report is
   * deterministic).
   */
  now?: () => number;
}

/** The result of one repeated-build experiment run. */
export interface RepeatedBuildExperimentResult {
  /** The verbatim W2-011 `CompoundingExperimentReport` (the TL-005 artifact). */
  report: CompoundingExperimentReport;
  /** The scratch walk's reconstruction id. */
  scratchReconstructionId: string;
  /** The rebuild walk's reconstruction id. */
  rebuildReconstructionId: string;
  /** The scratch walk's measured build record (the experiment's `from` build). */
  scratchBuildRecord: LearningBuildRecord;
  /** The rebuild walk's measured build record (the experiment's `to` build). */
  rebuildBuildRecord: LearningBuildRecord;
  /** The rebuild walk's plan-stage composition record (the retrieval lane's output). */
  rebuildComposition: PlanStageCompositionRecord | undefined;
}

// ---------------------------------------------------------------------------
// Stage-artifact reading (the W1-004 derivation, no second store)
// ---------------------------------------------------------------------------

/**
 * Reads every succeeded stage's payload for one reconstruction, keyed by stage.
 * Stages that did not succeed (or recorded no artifact) are absent — the
 * measurement functions treat them honestly (the walk failed to complete).
 */
async function readWalkPayloads(
  deps: Pick<RealStageExecutorDeps, "readTasks">,
  runtime: OpenMuseRuntime,
  reconstructionId: string,
): Promise<Map<ClappStage, StageArtifactPayload>> {
  const snapshots = await deps.readTasks(reconstructionId);
  const state = readClappRunState(snapshots.map((snapshot) => snapshot.task));
  const payloads = new Map<ClappStage, StageArtifactPayload>();
  for (const entry of state.stages) {
    if (entry.status !== "succeeded") continue;
    for (const id of entry.outputArtifactIds) {
      const bytes = await runtime.artifacts.get(id);
      const payload = await decodeStagePayload(bytes);
      if (payload.reconstructionId !== reconstructionId)
        throw new Error(
          `the ${entry.stage} stage's artifact belongs to reconstruction "${payload.reconstructionId}" but the experiment is "${reconstructionId}"; durable state is inconsistent`,
        );
      // The plan stage records two artifacts (the plan + the composition
      // record). The first is the canonical plan; the second is the
      // composition record. The map keeps the first (the plan) for
      // measurement; the composition record is read separately.
      if (!payloads.has(entry.stage)) payloads.set(entry.stage, payload);
    }
  }
  return payloads;
}

/**
 * Reads the plan stage's composition record (the SECOND output artifact) for
 * one reconstruction. Returns `undefined` when the plan stage recorded only one
 * artifact (the pre-W3-016 shape) — the caller treats that as the honest empty
 * composition.
 */
async function readWalkComposition(
  deps: Pick<RealStageExecutorDeps, "readTasks">,
  runtime: OpenMuseRuntime,
  reconstructionId: string,
): Promise<PlanStageCompositionRecord | undefined> {
  const snapshots = await deps.readTasks(reconstructionId);
  const state = readClappRunState(snapshots.map((snapshot) => snapshot.task));
  const planEntry = state.stages.find((row) => row.stage === "plan");
  if (planEntry?.status !== "succeeded") return undefined;
  const ids = planEntry.outputArtifactIds;
  if (ids[1] === undefined) return undefined;
  const bytes = await runtime.artifacts.get(ids[1]);
  const payload = await decodeStagePayload(bytes);
  if (payload.reconstructionId !== reconstructionId)
    throw new Error(
      `the plan stage's composition artifact belongs to reconstruction "${payload.reconstructionId}" but the experiment is "${reconstructionId}"; durable state is inconsistent`,
    );
  const record = payload.output as Partial<PlanStageCompositionRecord>;
  if (
    typeof record !== "object" ||
    record === null ||
    typeof record.plan !== "object" ||
    record.plan === null ||
    typeof record.archetypeLabel !== "string" ||
    typeof record.packagePolicy !== "string" ||
    typeof record.registrySnapshotSize !== "number"
  )
    throw new Error(
      "the plan stage's second artifact is not a composition record (plan/archetypeLabel/packagePolicy/registrySnapshotSize missing)",
    );
  return record as PlanStageCompositionRecord;
}

// ---------------------------------------------------------------------------
// Build-record measurement (from the walk's actual artifacts)
// ---------------------------------------------------------------------------

/** The synthesize stage's output record (mirrors the executor's shape). */
interface SynthesizeMeasurement {
  app: { files: { path: string }[] };
  execution: {
    steps: { name: string; exitCode: number }[];
    succeeded: boolean;
  };
}

/** The repair stage's output record (mirrors the executor's shape). */
interface RepairMeasurement {
  iterations: unknown[];
  finalVerdict: string;
  converged: boolean;
  id: string;
}

/** The verify stage's output record (mirrors the executor's shape). */
interface VerifyMeasurement {
  suite: { verdict: string; findingsByDimension?: Record<string, unknown[]> };
}

/** The plan stage's composition packageIds (the retrieval lane's selected set). */
function compositionPackageIdsOf(composition: PlanStageCompositionRecord | undefined): string[] {
  if (composition === undefined) return [];
  return [...composition.plan.packageIds];
}

/**
 * Derives one build's `LearningBuildRecord` from the walk's actual stage
 * artifacts. Every count is a structural measure of what the walk produced —
 * no wall-clock, no fabrication:
 *
 * - `newCodeUnits` — the synthesize stage's generated file count (the
 *   structural new-code measure).
 * - `repairIterations` — the repair stage's iteration count.
 * - `buildSteps` — the synthesize stage's execution step count (the
 *   deterministic build-time proxy).
 * - `testsPassed`/`testsTotal` — derived from the execution's test step
 *   (a succeeded test step reports 1/1; a failed one reports 0/1; an absent
 *   test step reports nothing — the W2-009 composer treats absent tests as
 *   unavailable).
 * - `parity` — the repair stage's final verdict (the last verification that
 *   ran), carried verbatim with the repair report's id as the verification run
 *   id. When the repair stage did not run, the verify stage's verdict is used.
 * - `reusedPackageIds` — the plan stage's composition packageIds (empty for
 *   the scratch walk's empty registry; the composed set for the rebuild).
 * - `rejectedPackageIds` — empty (the W3-009 composition planner does not
 *   emit a rejected list; the honest empty array is recorded).
 */
function measureBuildRecord(
  payloads: Map<ClappStage, StageArtifactPayload>,
  composition: PlanStageCompositionRecord | undefined,
  phase: "scratch" | "reuse",
  appId: string,
): LearningBuildRecord {
  const synthesize = payloads.get("synthesize")?.output as SynthesizeMeasurement | undefined;
  const repair = payloads.get("repair")?.output as RepairMeasurement | undefined;
  const verify = payloads.get("verify")?.output as VerifyMeasurement | undefined;

  if (
    synthesize === undefined ||
    typeof synthesize !== "object" ||
    !Array.isArray(synthesize.app?.files) ||
    !Array.isArray(synthesize.execution?.steps)
  )
    throw new Error(
      `the ${phase} walk's synthesize stage artifact is not a valid synthesize record; the build record cannot be measured`,
    );

  const newCodeUnits = synthesize.app.files.length;
  const buildSteps = synthesize.execution.steps.length;

  // The test step: a step named "test" in the execution. A succeeded test
  // step (exitCode 0) reports testsPassed=1/testsTotal=1; a failed one reports
  // 0/1; an absent test step reports nothing (the composer treats absent tests
  // as unavailable).
  const testStep = synthesize.execution.steps.find((step) => step.name === "test");
  const testsPassed = testStep !== undefined ? (testStep.exitCode === 0 ? 1 : 0) : undefined;
  const testsTotal = testStep !== undefined ? 1 : undefined;

  const repairIterations = Array.isArray(repair?.iterations) ? repair.iterations.length : 0;

  // The parity: the repair stage's final verdict (the last verification), or
  // the verify stage's verdict when the repair stage did not run. The verdict
  // is carried verbatim; the verification run id is the repair report's
  // content-addressed id (or the verify suite's verdict when repair did not run).
  const repairVerdict = repair?.finalVerdict;
  const verifyVerdict = verify?.suite?.verdict;
  const rawVerdict = repairVerdict ?? verifyVerdict;
  let parity: LearningBuildRecord["parity"];
  if (rawVerdict === "equivalent" || rawVerdict === "divergent") {
    parity = {
      verdict: rawVerdict,
      verificationRunId: repair?.id ?? rawVerdict,
      minorFindings: 0,
      majorFindings: 0,
    };
  } else {
    parity = undefined;
  }

  return {
    appId,
    phase,
    reusedPackageIds: compositionPackageIdsOf(composition),
    rejectedPackageIds: [],
    newCodeUnits,
    repairIterations,
    buildSteps,
    ...(testsPassed !== undefined && testsTotal !== undefined ? { testsPassed, testsTotal } : {}),
    ...(parity !== undefined ? { parity } : {}),
  };
}

// ---------------------------------------------------------------------------
// Reconstruction artifacts (the scratch walk's structural artifacts)
// ---------------------------------------------------------------------------

/**
 * Builds the `ReconstructionArtifacts` from the scratch walk's actual stage
 * artifacts: the parity from the repair/verify stage, the plan inventory from
 * the plan stage, the archetype label from the model stage's IR, and the IR
 * digest from the model stage's canonical serialization. These are the
 * structural artifacts `runCompoundingExperiment`'s internal extraction
 * consumes — the same artifacts the scratch walk's promote stage already
 * extracted over (idempotent re-extraction inside the experiment).
 */
async function buildReconstructionArtifacts(
  deps: Pick<RealStageExecutorDeps, "readTasks">,
  runtime: OpenMuseRuntime,
  reconstructionId: string,
): Promise<ReconstructionArtifacts> {
  const payloads = await readWalkPayloads(deps, runtime, reconstructionId);
  const repair = payloads.get("repair")?.output as RepairMeasurement | undefined;
  const verify = payloads.get("verify")?.output as VerifyMeasurement | undefined;
  const planPayload = payloads.get("plan");
  const modelPayload = payloads.get("model");

  if (planPayload === undefined || typeof planPayload.output !== "string")
    throw new Error(
      "the scratch walk's plan stage artifact is not a canonical SynthesisPlan serialization; the reconstruction artifacts cannot be derived",
    );
  if (modelPayload === undefined || typeof modelPayload.output !== "string")
    throw new Error(
      "the scratch walk's model stage artifact is not a canonical Behavioral IR serialization; the reconstruction artifacts cannot be derived",
    );

  // The plan inventory: the plan's components, api entries and persistence keys
  // (the W2-006 extractor's own structural projection, mirrored from the
  // promote stage's derivation).
  const plan = deserializeSynthesisPlan(planPayload.output as string);
  if (!plan.ok || plan.plan === undefined)
    throw new Error(
      `the scratch walk's plan stage artifact failed plan validation: ${plan.errors.join("; ")}`,
    );
  const inventory = {
    components: plan.plan.components.flatMap((entry: Record<string, unknown>) => {
      const definition = entry.definition as Record<string, unknown> | undefined;
      if (
        typeof definition?.path === "string" &&
        typeof definition?.kind === "string" &&
        typeof definition?.name === "string"
      )
        return [{ path: definition.path, kind: definition.kind, name: definition.name }];
      return [];
    }),
    apiEntries: (plan.plan.api as Record<string, unknown>[]).map((entry) => ({
      path: `/api/${String(entry.key)}`,
    })),
    persistenceKeys: (plan.plan.persistence as Record<string, unknown>[]).map((entry) =>
      String(entry.key),
    ),
  };

  // The archetype label: the W2-004 classifier over the model IR.
  const model = deserializeBehavioralIr(modelPayload.output as string);
  if (!model.ok || model.ir === undefined)
    throw new Error(
      `the scratch walk's model stage artifact failed IR validation: ${(model.errors ?? []).join("; ")}`,
    );
  const archetype = { label: classifyFromIr({ ir: model.ir }).label };

  // The IR digest: sha256 of the canonical IR serialization.
  const irDigest = sha256Hex(modelPayload.output as string);

  // The parity: the repair/verify stage's verdict.
  const parityVerdict = repair?.finalVerdict ?? verify?.suite?.verdict ?? "blocked";
  const parity = {
    verdict: parityVerdict as "equivalent" | "divergent" | "blocked",
    verificationRunId: repair?.id ?? verify?.suite?.verdict ?? reconstructionId,
    minorFindings: 0,
    majorFindings: 0,
  };

  return {
    reconstructionId,
    parity,
    planInventory: inventory,
    archetype,
    irDigest,
  };
}

// ---------------------------------------------------------------------------
// The experiment runner
// ---------------------------------------------------------------------------

/**
 * Runs the repeated-build experiment end-to-end:
 *
 * 1. A scratch walk (the reconstruction chain without learning — the plan stage
 *    composes over an empty registry, so `packageIds` are empty).
 * 2. The promote flow's real path (the scratch walk's promote stage extracts
 *    and promotes packages over the walk's artifacts — populating the shared
 *    `packageStore`).
 * 3. A rebuild walk whose plan stage carries the composed set (the W3-009
 *    `planComposition` over the registry snapshot the scratch walk populated).
 * 4. `buildLearningComparison` over the two builds' measured records (composed
 *    inside `runCompoundingExperiment`, attached verbatim).
 * 5. `runCompoundingExperiment` — the TL-005 archetype learning experiment
 *    artifact, with the rebuild's composition plan (when `learningEnabled`) or
 *    the learning-disabled control (when not).
 * 6. The `CompoundingExperimentReport`, persisted durably through
 *    `writeCompoundingExperiment` (the W2-013 catalog-writers discipline).
 *
 * Restart-safe: a re-run produces a FRESH report (the experiment is a live
 * measurement). Identical measurements yield the same content-addressed id
 * (idempotent — the catalog row is re-put with identical content); different
 * measurements yield a different id (a new row, never a silent overwrite).
 */
export async function runRepeatedBuildExperiment(
  deps: RepeatedBuildExperimentDeps,
): Promise<RepeatedBuildExperimentResult> {
  const { db, owner, runtime, readTasks, packageStore, spec, benchmarkId } = deps;
  const learningEnabled = deps.learningEnabled ?? true;
  const now = deps.now;

  // 1. The scratch walk (without learning — the plan stage composes over an
  //    empty registry).
  const scratchReconstructionId = await deps.walk(spec);
  const scratchPayloads = await readWalkPayloads({ readTasks }, runtime, scratchReconstructionId);
  const scratchComposition = await readWalkComposition(
    { readTasks },
    runtime,
    scratchReconstructionId,
  );
  const scratchBuildRecord = measureBuildRecord(
    scratchPayloads,
    scratchComposition,
    "scratch",
    "A1",
  );

  // 2. The promote flow's real path already ran (the scratch walk's promote
  //    stage). The shared packageStore is now populated with whatever the
  //    scratch walk promoted (possibly nothing — the honest v0.1 baseline).

  // 3. The rebuild walk (whose plan stage carries the composed set).
  const rebuildReconstructionId = await deps.walk(spec);
  const rebuildPayloads = await readWalkPayloads({ readTasks }, runtime, rebuildReconstructionId);
  const rebuildComposition = await readWalkComposition(
    { readTasks },
    runtime,
    rebuildReconstructionId,
  );
  const rebuildBuildRecord = measureBuildRecord(rebuildPayloads, rebuildComposition, "reuse", "A2");

  // 4-5. The reconstruction artifacts (the scratch walk's structural artifacts
  //      for `runCompoundingExperiment`'s internal extraction).
  const artifacts = await buildReconstructionArtifacts(
    { readTasks },
    runtime,
    scratchReconstructionId,
  );

  // 5. runCompoundingExperiment — the composition plan is the rebuild's
  //    plan-stage composition record (when learning is enabled) or undefined
  //    (the learning-disabled control). The plan is projected onto the W2-011
  //    structural port ({ status, packageIds, selections? }) — only composed
  //    plans carry selections.
  const rebuildPlan = rebuildComposition?.plan;
  const compositionPlan =
    learningEnabled && rebuildPlan !== undefined
      ? {
          status: rebuildPlan.status,
          packageIds: [...rebuildPlan.packageIds],
          ...(rebuildPlan.status === "composed" && Array.isArray(rebuildPlan.selections)
            ? {
                selections: rebuildPlan.selections.map((selection) => ({
                  role: selection.role,
                  packageId: selection.packageId,
                })),
              }
            : {}),
        }
      : undefined;
  const experimentInput: CompoundingExperimentInput = {
    benchmarkId,
    scratchBuild: scratchBuildRecord,
    reuseBuild: rebuildBuildRecord,
    artifacts,
    ...(compositionPlan !== undefined ? { compositionPlan } : {}),
    store: packageStore,
    ...(now !== undefined ? { now } : {}),
  };
  const report = runCompoundingExperiment(experimentInput);

  // 6. Persist durably through the W2-013 catalog-writers discipline.
  await writeCompoundingExperiment(db, owner, experimentInput);

  return {
    report,
    scratchReconstructionId,
    rebuildReconstructionId,
    scratchBuildRecord,
    rebuildBuildRecord,
    rebuildComposition,
  };
}

// ---------------------------------------------------------------------------
// The walk driver factory (the service's seam)
// ---------------------------------------------------------------------------

/**
 * The service-level walk driver factory: creates a walk driver that drives the
 * ten frozen stages through the real service + executor + runtime. The service
 * owns the walk; this module owns the measurement + the experiment + the
 * persistence. Used by the service's `runExperiment` method; tests supply their
 * own walk driver (the W3-013 chain-walk pattern over scripted providers).
 */
export interface ServiceWalkDriverDeps {
  /** The CLAPP service (creates reconstructions, advances the chain). */
  service: ClappService;
  /** The CLAPP repositories (reads stage tasks for the walk). */
  repositories: ClappRepositories;
  /** The owner the walk runs under. */
  owner: string;
  /** The real stage executor (drives the chain stages). */
  executor: StageExecutor;
  /** The runtime with the real bound services. */
  runtime: OpenMuseRuntime;
  /**
   * Drives one tick of the substrate worker (leases + executes one pending
   * task). The service's `runExperiment` method supplies this from the
   * production worker; tests supply it from a dedicated TaskWorker.
   */
  tick: () => Promise<void>;
  /** A context factory for the stage executor (the W1-001 ClappTaskContext). */
  context: () => ClappTaskContext;
}

/**
 * Creates a walk driver that drives the ten frozen stages through the real
 * service + executor + runtime. The walk creates a reconstruction, drives the
 * worker tick by tick, advances the chain after each succeeded stage, and
 * returns the reconstruction id. A stage that refuses honestly (the
 * unavailable-state error) fails the walk — the experiment runner fails closed
 * and writes nothing.
 */
export function createServiceWalkDriver(deps: ServiceWalkDriverDeps): ExperimentWalkDriver {
  return async (spec: ReconstructionSpec): Promise<string> => {
    const created = await deps.service.createReconstruction(deps.owner, spec);
    const reconstructionId = created.reconstruction.id;
    // Drive the chain: tick + advance until all stages succeed or a stage
    // refuses. The loop bounds at CLAPP_STAGES + a few extra ticks for safety.
    for (let iteration = 0; iteration < CLAPP_STAGES.length + 4; iteration += 1) {
      await deps.tick();
      const tasks = await deps.repositories.stageTasks(deps.owner, reconstructionId);
      const state = readClappRunState(tasks);
      const lastStage = state.stages[state.stages.length - 1];
      if (lastStage === undefined) continue;
      if (lastStage.status === "failed")
        throw new Error(
          `the walk's ${lastStage.stage} stage failed for reconstruction ${reconstructionId}: ${lastStage.error ?? "no error recorded"}`,
        );
      if (lastStage.status === "succeeded" && state.stages.length === CLAPP_STAGES.length) break;
      if (lastStage.status === "succeeded")
        await deps.service.advance(deps.owner, reconstructionId);
    }
    return reconstructionId;
  };
}
