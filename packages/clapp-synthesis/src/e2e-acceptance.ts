/**
 * CLAPP-W3-008 — the end-to-end acceptance digest.
 *
 * One additive, pure, deterministic function mapping ONE end-to-end
 * reconstruction run onto an honest summary: per-stage outcomes
 * (succeeded / failed / unavailable, each derived from what the stage
 * actually returned), the final parity verdict VERBATIM (never upgraded),
 * the bounded repair outcome (converged, stoppedBy, iterations,
 * abstentions), journey coverage, and the base-state limitations — recorded
 * as limitations, never as passing checks, never fabricated.
 *
 * There is deliberately NO aggregate score anywhere in the digest
 * (ACCEPTANCE.md M6: "Do not reduce results to one score").
 *
 * Discipline (ADR-002): this module imports NOTHING — not even from
 * @clapp/contracts. Its inputs are structural, duck-typed shapes declared
 * locally, so the real artifacts of a run satisfy them without any
 * cross-package dependency; the composition of the real stages lives in the
 * test seam (tests/clapp-w3-008-e2e.test.ts), never here. Deterministic by
 * construction: fixed stage order, fixed journey order, no clocks, no
 * randomness, content-derived reasons only.
 */

/** The schema version of the digest shape. */
export const E2E_ACCEPTANCE_DIGEST_VERSION = "0.1";

/** The outcome of one composed stage, derived from its actual artifact. */
export type E2eStageOutcome = "succeeded" | "failed" | "unavailable";

/** One composed stage of the end-to-end run and what its artifact shows. */
export type E2eStageRecord = {
  stage: string;
  outcome: E2eStageOutcome;
  reason: string;
};

/** A recorded base-state limitation — never a passing check. */
export type E2eAcceptanceLimitation = {
  id: string;
  status: "limitation";
  reason: string;
};

/** One driven journey and the verdict the paired engine produced for it. */
export type E2eJourneyCoverageEntry = {
  journeyId: string;
  routePath: string;
  verdict: string;
  findingCount: number;
};

/** The bounded repair outcome, carried verbatim from the repair report. */
export type E2eRepairOutcome = {
  converged: boolean;
  stoppedBy: string;
  iterations: number;
  abstentions: number;
  finalVerdict: string;
};

/** The honest summary of ONE end-to-end run. No aggregate score exists. */
export type E2eAcceptanceDigest = {
  schemaVersion: string;
  reconstructionId: string;
  stages: E2eStageRecord[];
  finalParityVerdict: string;
  repair: E2eRepairOutcome | null;
  journeyCoverage: E2eJourneyCoverageEntry[];
  limitations: E2eAcceptanceLimitation[];
};

// ---------------------------------------------------------------------------
// Structural (duck-typed) inputs — the ADR-002 discipline, declared locally
// ---------------------------------------------------------------------------

/** The structural shape of an observation stage artifact (EvidenceBundle). */
export type E2eObservationArtifact = {
  refs?: unknown;
  rootSha256?: unknown;
};

/** The structural shape of an extraction stage artifact (BehavioralIr). */
export type E2eExtractionArtifact = {
  journeys?: unknown;
  screens?: unknown;
  evidence?: unknown;
  assumptions?: unknown;
};

/** The structural shape of a plan stage artifact (SynthesisPlan). */
export type E2ePlanArtifact = {
  routes?: unknown;
  acceptanceJourneyIds?: unknown;
};

/** The structural shape of a generation stage artifact (GeneratedApp). */
export type E2eCandidateArtifact = {
  manifest?: unknown;
  files?: unknown;
};

/** The structural shape of a verification stage artifact (PairedSuiteResult). */
export type E2eVerificationArtifact = {
  verdict?: unknown;
  journeys?: unknown;
};

/** The structural shape of a repair stage artifact (RepairReport). */
export type E2eRepairArtifact = {
  converged?: unknown;
  stoppedBy?: unknown;
  iterations?: unknown;
  abstained?: unknown;
  finalVerdict?: unknown;
};

/** One driven journey of the run (the structural PairedJourney shape). */
export type E2eJourneyInput = {
  id?: unknown;
  routePath?: unknown;
};

/** The structural shape of ONE end-to-end run handed to the digest. */
export type E2eAcceptanceRun = {
  reconstructionId?: unknown;
  observation?: E2eObservationArtifact;
  extraction?: E2eExtractionArtifact;
  plan?: E2ePlanArtifact;
  candidate?: E2eCandidateArtifact;
  verification?: E2eVerificationArtifact;
  repair?: E2eRepairArtifact;
  /** Why the repair stage is absent, when it is (recorded, never guessed). */
  repairUnavailableReason?: unknown;
  /** The journeys the verification stage drove. */
  journeys?: unknown;
};

/**
 * The base-state limitations of the composed end-to-end pipeline, recorded in
 * every digest. These are statements about the COMPOSED CHAIN this digest
 * summarizes — never fabricated into an authorization check or a promotion
 * gate inside it, and never presented as passing checks.
 */
export const E2E_BASE_STATE_LIMITATIONS: readonly E2eAcceptanceLimitation[] = Object.freeze([
  Object.freeze({
    id: "target-authorization-persistence",
    status: "limitation",
    reason:
      "Target authorization is not persisted before observation in the composed end-to-end pipeline: the observation stage binds the browser observation adapter directly, with no authorization gate or authorization store wired into the chain, so no authorization record is persisted ahead of capture (tracking item CLAPP-W1-008). Recorded as a limitation of the composed pipeline, never as a passing check.",
  }),
  Object.freeze({
    id: "package-promotion-gate",
    status: "limitation",
    reason:
      "Package promotion is not evaluation-gated in the composed end-to-end pipeline: the plan references no packages and the chain exercises no promotion path, so no promotion evaluation gate runs anywhere in the composed stages (tracking item CLAPP-W2-010). Recorded as a limitation of the composed pipeline, never as a passing check.",
  }),
]);

// ---------------------------------------------------------------------------
// Local structural helpers (no imports — the module is self-contained)
// ---------------------------------------------------------------------------

/** A plain, non-array object (the duck-typing guard). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A non-empty string, or the fallback. */
function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

/** A non-negative integer count of an array value, or null when absent. */
function arrayCount(value: unknown): number | null {
  return Array.isArray(value) ? value.length : null;
}

// ---------------------------------------------------------------------------
// Per-stage derivation — each outcome derived from the actual artifact
// ---------------------------------------------------------------------------

/** The observation stage: real page evidence, honestly classified. */
function observationStage(artifact: E2eObservationArtifact | undefined): E2eStageRecord {
  if (artifact === undefined) {
    return {
      stage: "observation",
      outcome: "unavailable",
      reason: "the observation stage did not run: no evidence bundle was provided to the digest",
    };
  }
  if (!isRecord(artifact)) {
    return {
      stage: "observation",
      outcome: "failed",
      reason: "the observation artifact is not a structured evidence bundle",
    };
  }
  const refs = artifact.refs;
  if (!Array.isArray(refs)) {
    return {
      stage: "observation",
      outcome: "failed",
      reason: "the evidence bundle carries no refs array",
    };
  }
  const rootSha256 = artifact.rootSha256;
  if (typeof rootSha256 !== "string" || rootSha256.length === 0) {
    return {
      stage: "observation",
      outcome: "failed",
      reason: "the evidence bundle carries no root sha256",
    };
  }
  const observed = refs.filter((ref) => isRecord(ref) && ref.classification === "observed").length;
  const unavailable = refs.filter(
    (ref) => isRecord(ref) && ref.classification === "unavailable",
  ).length;
  return {
    stage: "observation",
    outcome: "succeeded",
    reason: `captured ${refs.length} evidence refs (${observed} observed, ${unavailable} unavailable) with root sha256 ${rootSha256}`,
  };
}

/** The extraction stage: journeys derived from observed evidence only. */
function extractionStage(artifact: E2eExtractionArtifact | undefined): E2eStageRecord {
  if (artifact === undefined) {
    return {
      stage: "extraction",
      outcome: "unavailable",
      reason: "the extraction stage did not run: no behavioral IR was provided to the digest",
    };
  }
  if (!isRecord(artifact)) {
    return {
      stage: "extraction",
      outcome: "failed",
      reason: "the extraction artifact is not a structured behavioral IR",
    };
  }
  const journeys = artifact.journeys;
  const evidence = artifact.evidence;
  const assumptions = artifact.assumptions;
  const screens = artifact.screens;
  for (const [field, value] of [
    ["journeys", journeys],
    ["evidence", evidence],
    ["assumptions", assumptions],
    ["screens", screens],
  ] as const) {
    if (!Array.isArray(value)) {
      return {
        stage: "extraction",
        outcome: "failed",
        reason: `the behavioral IR carries no ${field} array`,
      };
    }
  }
  const journeyCount = (journeys as unknown[]).length;
  const screenCount = (screens as unknown[]).length;
  const evidenceCount = (evidence as unknown[]).length;
  const assumptionCount = (assumptions as unknown[]).length;
  return {
    stage: "extraction",
    outcome: "succeeded",
    reason: `derived ${journeyCount} journeys and ${screenCount} screens from ${evidenceCount} evidence refs with ${assumptionCount} recorded assumptions`,
  };
}

/** The plan stage: routes derived from the IR journeys. */
function planStage(artifact: E2ePlanArtifact | undefined): E2eStageRecord {
  if (artifact === undefined) {
    return {
      stage: "plan",
      outcome: "unavailable",
      reason: "the plan stage did not run: no synthesis plan was provided to the digest",
    };
  }
  if (!isRecord(artifact)) {
    return {
      stage: "plan",
      outcome: "failed",
      reason: "the plan artifact is not a structured synthesis plan",
    };
  }
  const routes = artifact.routes;
  if (!Array.isArray(routes)) {
    return {
      stage: "plan",
      outcome: "failed",
      reason: "the synthesis plan carries no routes array",
    };
  }
  const acceptance = artifact.acceptanceJourneyIds;
  if (!Array.isArray(acceptance)) {
    return {
      stage: "plan",
      outcome: "failed",
      reason: "the synthesis plan carries no acceptanceJourneyIds array",
    };
  }
  return {
    stage: "plan",
    outcome: "succeeded",
    reason: `planned ${routes.length} routes covering ${acceptance.length} acceptance journeys`,
  };
}

/** The generation stage: the deterministic candidate file set. */
function candidateStage(artifact: E2eCandidateArtifact | undefined): E2eStageRecord {
  if (artifact === undefined) {
    return {
      stage: "generate",
      outcome: "unavailable",
      reason: "the candidate generation stage did not run: no generated application was provided",
    };
  }
  if (!isRecord(artifact)) {
    return {
      stage: "generate",
      outcome: "failed",
      reason: "the candidate artifact is not a structured generated application",
    };
  }
  const files = artifact.files;
  if (!Array.isArray(files)) {
    return {
      stage: "generate",
      outcome: "failed",
      reason: "the generated application carries no files array",
    };
  }
  const manifest = artifact.manifest;
  if (!isRecord(manifest)) {
    return {
      stage: "generate",
      outcome: "failed",
      reason: "the generated application carries no manifest object",
    };
  }
  const planDigest = stringOr(manifest.planDigest, "unrecorded");
  return {
    stage: "generate",
    outcome: "succeeded",
    reason: `generated ${files.length} files from plan digest ${planDigest}`,
  };
}

/** The verification stage: the paired suite and its verbatim verdict. */
function verificationStage(artifact: E2eVerificationArtifact | undefined): E2eStageRecord {
  if (artifact === undefined) {
    return {
      stage: "verify",
      outcome: "unavailable",
      reason: "the paired verification stage did not run: no paired suite result was provided",
    };
  }
  if (!isRecord(artifact)) {
    return {
      stage: "verify",
      outcome: "failed",
      reason: "the verification artifact is not a structured paired suite result",
    };
  }
  const verdict = artifact.verdict;
  if (verdict !== "equivalent" && verdict !== "divergent" && verdict !== "blocked") {
    return {
      stage: "verify",
      outcome: "failed",
      reason: `the paired suite verdict is not a known verdict: ${JSON.stringify(verdict)}`,
    };
  }
  const journeys = artifact.journeys;
  if (!Array.isArray(journeys)) {
    return {
      stage: "verify",
      outcome: "failed",
      reason: "the paired suite result carries no journeys array",
    };
  }
  return {
    stage: "verify",
    outcome: "succeeded",
    reason: `paired verification ran ${journeys.length} journeys on both sides; verdict "${verdict}"`,
  };
}

/** The repair stage: the bounded loop's honest stop and verbatim verdict. */
function repairStage(
  artifact: E2eRepairArtifact | undefined,
  unavailableReason: unknown,
): E2eStageRecord {
  if (artifact === undefined) {
    return {
      stage: "repair",
      outcome: "unavailable",
      reason:
        typeof unavailableReason === "string" && unavailableReason.length > 0
          ? unavailableReason
          : "the bounded repair stage did not run: no repair report was provided",
    };
  }
  if (!isRecord(artifact)) {
    return {
      stage: "repair",
      outcome: "failed",
      reason: "the repair artifact is not a structured repair report",
    };
  }
  const converged = artifact.converged;
  const stoppedBy = artifact.stoppedBy;
  const iterations = artifact.iterations;
  const abstained = artifact.abstained;
  const finalVerdict = artifact.finalVerdict;
  if (typeof converged !== "boolean") {
    return {
      stage: "repair",
      outcome: "failed",
      reason: "the repair report carries no boolean converged flag",
    };
  }
  if (typeof stoppedBy !== "string" || stoppedBy.length === 0) {
    return {
      stage: "repair",
      outcome: "failed",
      reason: "the repair report carries no stop reason",
    };
  }
  if (!Array.isArray(iterations) || !Array.isArray(abstained)) {
    return {
      stage: "repair",
      outcome: "failed",
      reason: "the repair report carries no iterations or abstentions arrays",
    };
  }
  if (typeof finalVerdict !== "string" || finalVerdict.length === 0) {
    return {
      stage: "repair",
      outcome: "failed",
      reason: "the repair report carries no final verdict",
    };
  }
  return {
    stage: "repair",
    outcome: "succeeded",
    reason: `the repair loop stopped by ${stoppedBy} after ${iterations.length} iterations with ${abstained.length} recorded abstentions; final verdict "${finalVerdict}"`,
  };
}

/** The final parity verdict, verbatim; "unavailable" when no verdict exists. */
function finalVerdictOf(artifact: E2eVerificationArtifact | undefined): string {
  if (artifact === undefined || !isRecord(artifact)) {
    return "unavailable";
  }
  const verdict = artifact.verdict;
  if (verdict === "equivalent" || verdict === "divergent" || verdict === "blocked") {
    return verdict;
  }
  return "unavailable";
}

/** The repair outcome carried verbatim; null when the stage did not run. */
function repairOutcomeOf(artifact: E2eRepairArtifact | undefined): E2eRepairOutcome | null {
  if (artifact === undefined || !isRecord(artifact)) {
    return null;
  }
  const converged = artifact.converged;
  const stoppedBy = artifact.stoppedBy;
  const iterations = arrayCount(artifact.iterations);
  const abstentions = arrayCount(artifact.abstained);
  const finalVerdict = artifact.finalVerdict;
  if (
    typeof converged !== "boolean" ||
    typeof stoppedBy !== "string" ||
    iterations === null ||
    abstentions === null ||
    typeof finalVerdict !== "string"
  ) {
    return null;
  }
  return { converged, stoppedBy, iterations, abstentions, finalVerdict };
}

/** Journey coverage: the driven journeys with their verbatim per-journey verdicts. */
function journeyCoverageOf(
  journeys: unknown,
  verification: E2eVerificationArtifact | undefined,
): E2eJourneyCoverageEntry[] {
  if (!Array.isArray(journeys)) {
    return [];
  }
  const summaries =
    verification !== undefined && isRecord(verification)
      ? Array.isArray(verification.journeys)
        ? verification.journeys.filter(isRecord)
        : []
      : [];
  const coverage: E2eJourneyCoverageEntry[] = [];
  for (const journey of journeys) {
    if (!isRecord(journey)) {
      continue;
    }
    const journeyId = journey.id;
    const routePath = journey.routePath;
    if (typeof journeyId !== "string" || typeof routePath !== "string") {
      continue;
    }
    const summary = summaries.find((entry) => entry.journeyId === journeyId);
    const verdict =
      summary !== undefined &&
      (summary.verdict === "equivalent" ||
        summary.verdict === "divergent" ||
        summary.verdict === "blocked")
        ? summary.verdict
        : "unavailable";
    const findingCount =
      summary !== undefined && typeof summary.findingCount === "number" ? summary.findingCount : 0;
    coverage.push({ journeyId, routePath, verdict, findingCount });
  }
  return coverage;
}

// ---------------------------------------------------------------------------
// The digest
// ---------------------------------------------------------------------------

/**
 * Maps ONE end-to-end run onto its honest acceptance summary.
 *
 * Every stage outcome is derived from the artifact that stage actually
 * returned; the final parity verdict and the repair outcome are carried
 * verbatim; absent stages are recorded "unavailable" with reasons — never
 * fabricated as successes. The base-state limitations are recorded in every
 * digest. Deterministic and pure: the same run always yields a deep-equal
 * digest, and the run object is never mutated.
 */
export function digestE2eAcceptance(run: E2eAcceptanceRun): E2eAcceptanceDigest {
  if (typeof run !== "object" || run === null || Array.isArray(run)) {
    throw new TypeError("digestE2eAcceptance requires an E2eAcceptanceRun object");
  }
  return {
    schemaVersion: E2E_ACCEPTANCE_DIGEST_VERSION,
    reconstructionId: stringOr(run.reconstructionId, "unrecorded"),
    stages: [
      observationStage(run.observation),
      extractionStage(run.extraction),
      planStage(run.plan),
      candidateStage(run.candidate),
      verificationStage(run.verification),
      repairStage(run.repair, run.repairUnavailableReason),
    ],
    finalParityVerdict: finalVerdictOf(run.verification),
    repair: repairOutcomeOf(run.repair),
    journeyCoverage: journeyCoverageOf(run.journeys, run.verification),
    limitations: E2E_BASE_STATE_LIMITATIONS.map((limitation) => ({ ...limitation })),
  };
}
