import { createHash } from "node:crypto";
import type { DiffFinding, DiffReport } from "@clapp/contracts";
import { canonicalJson, isPlainObject } from "./canonical.ts";
import { contentHash } from "./hash.ts";
import {
  apiBlockedFinding,
  artifactsOfCapture,
  bothPagesErrorBlockedFinding,
  compareSidesSemantically,
  pageArtifact,
  pageBlockedFinding,
  startBlockedFinding,
} from "./paired-compare.ts";

/**
 * The reference/candidate paired runner (CLAPP-W3-004): the M4 parity
 * engine's runner half. The same journey is driven against a reference side
 * and a candidate side — both pure in-process loopback services — and the
 * captured evidence is compared into a deterministic, content-addressed
 * DiffReport with the semantic and state dimensions (the visual and network
 * dimensions arrive in W3-005 on top of the same capture/compare seam).
 *
 * Both sides are taken through the STRUCTURAL {@link PairedSide} interface
 * declared here: the benchmark harness (createBenchmarkHarness(app).start()
 * → { port, baseUrl, stop }) and the W3-002 generated candidate (server.ts
 * exports start(port) → { port, close }) both satisfy it — the former
 * directly, the latter through a thin adapter — so this package never
 * imports @clapp/benchmarks or @clapp-runtime-openmuse (ADR-002 layering).
 *
 * Determinism is the gate (ACCEPTANCE.md M4: "deterministic enough for
 * regression tracking"): the DiffReport is a pure function of the served
 * content — ids are content-hashed, no timestamps, no ports, no durations —
 * while the honestly nondeterministic transport facts ride in the separate
 * `transport` field of the returned envelope.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Which side of the pairing a surface plays. */
export type PairedSideLabel = "reference" | "candidate";

/** The frozen verdict semantics: equivalent, divergent, or blocked. */
export type PairedVerdict = DiffReport["verdict"];

/** One JSON endpoint a journey GETs and compares across the sides. */
export type PairedApiCheck = {
  /** The endpoint path, starting with "/". */
  path: string;
  /** When set, the compared value is parsedBody[expectKey]; the whole body otherwise. */
  expectKey?: string;
};

/**
 * The journey contract the runner drives: one route page (with the anchor
 * texts expected present in the served body) plus optional JSON API checks.
 */
export type PairedJourney = {
  /** Stable journey id (content-hashed into the run ids). */
  id: string;
  /** Human-readable journey name. */
  name: string;
  /** The page route to fetch on both sides, starting with "/". */
  routePath: string;
  /** Texts expected present (substring match) in the served page body. */
  anchors: string[];
  /** JSON endpoints to GET and compare across the sides, in order. */
  apiChecks?: PairedApiCheck[];
};

/** A started paired side: an ephemeral loopback server plus its stop handle. */
export type StartedPairedSide = {
  /** The ephemeral port the side listens on (loopback). */
  port: number;
  /** The loopback base URL, `http://127.0.0.1:<port>`. */
  baseUrl: string;
  /** Stops the server. Must be safe to await exactly once per start. */
  stop(): Promise<void>;
};

/**
 * The structural interface both sides of a pairing are taken through. The
 * benchmark harness satisfies it directly (its start() returns exactly this
 * handle shape and it exposes snapshotState); the generated candidate
 * satisfies it through a thin adapter over its exported start(port). The
 * optional snapshotState participates in the state dimension only when BOTH
 * sides expose it.
 */
export type PairedSide = {
  label: PairedSideLabel;
  start(): Promise<StartedPairedSide>;
  /** When exposed (and callable), the side's state participates in the state dimension. */
  snapshotState?(): Record<string, unknown>;
};

/** What one side's page fetch captured: the comparable page evidence. */
export type PairedPageCapture = {
  status: number;
  contentType: string;
  /** sha256 of the fetched body bytes (content-addressed evidence). */
  bodyDigest: string;
  bodyChars: number;
  anchorsFound: string[];
  anchorsMissing: string[];
};

/** What one side's API-check fetch captured. */
export type PairedApiCapture = {
  path: string;
  status: number;
  /** sha256 of the fetched raw body bytes. */
  bodyDigest: string;
  /**
   * sha256 of the canonical JSON form of the compared value (the whole
   * parsed body, or parsedBody[expectKey] when the check names one), or null
   * when the body is not comparable JSON — an honest absence.
   */
  parsedKeyDigest: string | null;
  /** The check's expectKey, or null when the check compares the whole body. */
  expectKey: string | null;
};

/** The pre/post-journey state digests of one side (canonical-JSON sha256). */
export type PairedStateCapture = {
  preDigest: string;
  postDigest: string;
};

/** Everything one side contributed to one paired journey run. */
export type PairedSideCapture = {
  side: PairedSideLabel;
  journeyId: string;
  routePath: string;
  page: PairedPageCapture;
  api: PairedApiCapture[];
  /** Present only when the side exposed a working snapshotState for both phases. */
  state?: PairedStateCapture;
};

/** One content-addressed evidence artifact of the run's inventory. */
export type PairedArtifact = {
  /** Content-addressed id: `pa-` + sha256(artifact body), 16 hex chars. */
  id: string;
  side: PairedSideLabel;
  /** "page" (route body), "api" (endpoint body) or "state" (snapshot digest). */
  kind: "page" | "api" | "state";
  /** The route path, the API path, or "state://pre" / "state://post". */
  routePath: string;
  /** sha256 of the captured bytes (or of the canonical state snapshot). */
  digest: string;
  /** HTTP status of the page/api capture. */
  status?: number;
  /** The anchors found in the page body (page captures only). */
  anchorsFound?: string[];
  /** Canonical-JSON digest of the compared API value (api captures only). */
  semanticDigest?: string;
  /** The check's expectKey, when it named one (api captures only). */
  expectKey?: string;
};

/** The honestly nondeterministic transport facts of one run — never in the report. */
export type PairedTransport = {
  referencePort: number;
  candidatePort: number;
  startedAtMs: number;
  durationMs: number;
};

/**
 * What one paired journey run returns: the deterministic frozen DiffReport,
 * the transport facts, and the content-addressed evidence inventory.
 */
export type PairedRunEnvelope = {
  report: DiffReport;
  transport: PairedTransport;
  artifacts: PairedArtifact[];
};

/** One journey's aggregate inside a suite result. */
export type PairedJourneySummary = {
  journeyId: string;
  journeyName: string;
  verdict: PairedVerdict;
  findingCount: number;
};

/** The suite aggregate: worst verdict, findings by dimension, per-journey summaries. */
export type PairedSuiteResult = {
  verdict: PairedVerdict;
  findingsByDimension: {
    semantic: DiffFinding[];
    state: DiffFinding[];
  };
  journeys: PairedJourneySummary[];
  envelopes: PairedRunEnvelope[];
};

/** The input of {@link runPairedJourney}. */
export type RunPairedJourneyInput = {
  journey: PairedJourney;
  reference: PairedSide;
  candidate: PairedSide;
  /** Defaults to `paired:<journey.id>`; carried into the report verbatim. */
  reconstructionId?: string;
};

/** The input of {@link runPairedSuite}. */
export type RunPairedSuiteInput = {
  journeys: PairedJourney[];
  reference: PairedSide;
  candidate: PairedSide;
  /** Defaults to "paired-suite"; shared by every per-journey report. */
  reconstructionId?: string;
};

// ---------------------------------------------------------------------------
// Fail-closed side binding
// ---------------------------------------------------------------------------

/** The typed error bindPairedSide raises when a side lacks a capability. */
export class PairedSideError extends Error {
  /** The capabilities that were missing or not callable, e.g. ["start()"]. */
  readonly missingCapabilities: readonly string[];

  constructor(missingCapabilities: readonly string[], detail: string) {
    super(`not a valid PairedSide (${missingCapabilities.join(", ")}): ${detail}`);
    this.name = "PairedSideError";
    this.missingCapabilities = missingCapabilities;
  }
}

/** Honest kind names for binding error messages. */
function describeKind(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * Binds an unknown surface as a {@link PairedSide}, fail-closed: the surface
 * must be an object with a callable `start()` (and, when it carries a
 * `snapshotState`, that must be callable too; a carried `label`, if any,
 * must be valid). The label parameter is authoritative — the side's position
 * in the pairing decides its role — and defaults to "candidate".
 *
 * The benchmark harness, the generated candidate's start(port) adapter, and
 * any faithful literal all bind without this package importing their
 * sources: the check is structural (duck-typed), never nominal.
 */
export function bindPairedSide(
  candidate: unknown,
  label: PairedSideLabel = "candidate",
): PairedSide {
  if (!isPlainObject(candidate)) {
    throw new PairedSideError(
      ["start()"],
      `expected an object with a start() capability, received ${describeKind(candidate)}`,
    );
  }
  const source = candidate as unknown as {
    start?: unknown;
    snapshotState?: unknown;
    label?: unknown;
  };
  const missing: string[] = [];
  if (typeof source.start !== "function") missing.push("start()");
  if (source.snapshotState !== undefined && typeof source.snapshotState !== "function") {
    missing.push("snapshotState()");
  }
  if (missing.length > 0) {
    throw new PairedSideError(
      missing,
      "the capability(s) above are missing or not callable on the bound surface",
    );
  }
  if (source.label !== undefined && source.label !== "reference" && source.label !== "candidate") {
    throw new PairedSideError(
      ["label"],
      `a carried label must be "reference" or "candidate"; received ${JSON.stringify(
        String(source.label),
      )}`,
    );
  }
  const side: PairedSide = {
    label,
    // Method-style calls keep the source as the receiver, so prototype
    // methods on class-instance sides keep working through the binding.
    start: () =>
      (source.start as () => Promise<StartedPairedSide>).call(source) as Promise<StartedPairedSide>,
  };
  if (typeof source.snapshotState === "function") {
    side.snapshotState = () =>
      (source.snapshotState as () => Record<string, unknown>).call(source) as Record<
        string,
        unknown
      >;
  }
  return side;
}

// ---------------------------------------------------------------------------
// Journey normalization (fail-closed, pure)
// ---------------------------------------------------------------------------

/** A required-string validator that collects errors instead of throwing early. */
function requireNonEmptyString(value: unknown, field: string, errors: string[]): string | null {
  if (typeof value !== "string" || value.length === 0) {
    errors.push(`${field} must be a non-empty string`);
    return null;
  }
  return value;
}

/** A route-path validator (must start with "/"). */
function requireRoutePath(value: unknown, field: string, errors: string[]): string | null {
  if (typeof value !== "string" || !value.startsWith("/")) {
    errors.push(`${field} must be a route path starting with "/"`);
    return null;
  }
  return value;
}

/**
 * Validates a journey and returns a normalized, defensively-copied form: a
 * structuredClone snapshot of the input (the caller's object is never
 * touched, read or written), duplicate anchors dropped in first-occurrence
 * order, and an empty/absent apiChecks normalized to absent. Invalid journeys
 * fail closed with a TypeError listing every structural problem.
 */
function normalizePairedJourney(input: PairedJourney): PairedJourney {
  let snapshot: unknown;
  try {
    snapshot = structuredClone(input);
  } catch {
    throw new TypeError("PairedJourney must be a structured-cloneable (plain JSON) value");
  }
  if (!isPlainObject(snapshot)) {
    throw new TypeError(`PairedJourney must be an object; received ${describeKind(snapshot)}`);
  }
  const errors: string[] = [];
  const id = requireNonEmptyString(snapshot.id, "$.id", errors);
  const name = requireNonEmptyString(snapshot.name, "$.name", errors);
  const routePath = requireRoutePath(snapshot.routePath, "$.routePath", errors);

  const anchors: string[] = [];
  if (!Array.isArray(snapshot.anchors)) {
    errors.push("$.anchors must be an array of anchor strings");
  } else {
    const seen = new Set<string>();
    for (const [index, anchor] of snapshot.anchors.entries()) {
      if (typeof anchor !== "string" || anchor.trim().length === 0) {
        errors.push(`$.anchors[${index}] must be a non-empty string`);
        continue;
      }
      if (seen.has(anchor)) continue; // duplicates drop, first occurrence wins
      seen.add(anchor);
      anchors.push(anchor);
    }
  }

  let apiChecks: PairedApiCheck[] | undefined;
  if (snapshot.apiChecks !== undefined) {
    if (!Array.isArray(snapshot.apiChecks)) {
      errors.push("$.apiChecks must be an array when present");
    } else {
      const checks: PairedApiCheck[] = [];
      for (const [index, entry] of snapshot.apiChecks.entries()) {
        if (!isPlainObject(entry)) {
          errors.push(`$.apiChecks[${index}] must be an object`);
          continue;
        }
        const path = requireRoutePath(entry.path, `$.apiChecks[${index}].path`, errors);
        const expectKey = entry.expectKey;
        if (expectKey !== undefined && (typeof expectKey !== "string" || expectKey.length === 0)) {
          errors.push(`$.apiChecks[${index}].expectKey must be a non-empty string when present`);
          continue;
        }
        if (path === null) continue;
        checks.push(expectKey === undefined ? { path } : { path, expectKey });
      }
      apiChecks = checks;
    }
  }

  if (errors.length > 0) {
    throw new TypeError(`PairedJourney failed structural validation: ${errors.join("; ")}`);
  }
  if (id === null || name === null || routePath === null) {
    throw new TypeError("PairedJourney failed structural validation: required fields missing");
  }
  const journey: PairedJourney = { id, name, routePath, anchors };
  if (apiChecks !== undefined && apiChecks.length > 0) journey.apiChecks = apiChecks;
  return journey;
}

/** The reconstruction id of a run: explicit, or derived from the journey. */
function normalizeReconstructionId(provided: string | undefined, journeyId: string): string {
  if (provided === undefined) return `paired:${journeyId}`;
  if (typeof provided !== "string" || provided.length === 0) {
    throw new TypeError("reconstructionId must be a non-empty string when provided");
  }
  return provided;
}

// ---------------------------------------------------------------------------
// Capture helpers (the only I/O of the runner)
// ---------------------------------------------------------------------------

/** sha256 of raw bytes, hex-encoded. */
function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Parses JSON honestly: a result, never an exception. */
function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/** Fetches the journey's route page on one side and captures the evidence. */
async function fetchPageCapture(
  baseUrl: string,
  journey: PairedJourney,
): Promise<PairedPageCapture> {
  const response = await fetch(`${baseUrl}${journey.routePath}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const text = Buffer.from(bytes).toString("utf8");
  const anchorsFound: string[] = [];
  const anchorsMissing: string[] = [];
  for (const anchor of journey.anchors) {
    if (text.includes(anchor)) anchorsFound.push(anchor);
    else anchorsMissing.push(anchor);
  }
  return {
    status: response.status,
    contentType: (response.headers.get("content-type") ?? "").toLowerCase().trim(),
    bodyDigest: sha256Bytes(bytes),
    bodyChars: text.length,
    anchorsFound,
    anchorsMissing,
  };
}

/** Fetches one API check on one side and captures the evidence. */
async function fetchApiCapture(baseUrl: string, check: PairedApiCheck): Promise<PairedApiCapture> {
  const response = await fetch(`${baseUrl}${check.path}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const text = Buffer.from(bytes).toString("utf8");
  let parsedKeyDigest: string | null = null;
  const parsed = tryParseJson(text);
  if (parsed.ok) {
    const target =
      check.expectKey === undefined
        ? parsed.value
        : isPlainObject(parsed.value) && Object.hasOwn(parsed.value, check.expectKey)
          ? parsed.value[check.expectKey]
          : undefined;
    if (target !== undefined) parsedKeyDigest = contentHash(target);
  }
  return {
    path: check.path,
    status: response.status,
    bodyDigest: sha256Bytes(bytes),
    parsedKeyDigest,
    expectKey: check.expectKey ?? null,
  };
}

/**
 * Snapshots one side's state when it exposes a working snapshotState. A
 * missing, non-callable, throwing, or non-object snapshot makes the state
 * dimension unavailable for that side (returned as null) — an honest skip,
 * never an invented divergence.
 */
function snapshotStateOf(side: PairedSide): Record<string, unknown> | null {
  if (typeof side.snapshotState !== "function") return null;
  try {
    const snapshot = side.snapshotState();
    return isPlainObject(snapshot) ? snapshot : null;
  } catch {
    return null;
  }
}

/** Best-effort stop: a failed stop never invalidates the captured comparison. */
async function stopQuietly(handle: StartedPairedSide): Promise<void> {
  try {
    await handle.stop();
  } catch {
    return;
  }
}

// ---------------------------------------------------------------------------
// Report assembly (pure)
// ---------------------------------------------------------------------------

/**
 * The run id of one side: the content digest of its served-content inventory
 * (page, API checks, state transitions — side-label-independent, so two
 * sides serving identical content hash to the same run id). A side that
 * served nothing has the digest of the canonical empty inventory.
 */
function inventoryRunId(capture: PairedSideCapture | null): string {
  if (capture === null) return contentHash(null);
  return contentHash({
    journeyId: capture.journeyId,
    routePath: capture.routePath,
    page: capture.page,
    api: capture.api,
    state: capture.state ?? null,
  });
}

/** The content-addressed report id: sha256 of the report's own fields. */
function reportIdOf(report: Omit<DiffReport, "id">): string {
  return `dr-${contentHash(report).slice(0, 16)}`;
}

// ---------------------------------------------------------------------------
// The paired journey runner
// ---------------------------------------------------------------------------

/**
 * Runs one journey against both sides, deterministically, and returns the
 * paired run envelope: { report, transport, artifacts }.
 *
 * Execution order (fixed): start reference, start candidate, snapshot both
 * pre-states, drive the reference (page then API checks in order), snapshot
 * the reference post-state, drive the candidate, snapshot the candidate
 * post-state. Any start failure, any fetch rejection, or a route that errors
 * (status >= 400) on BOTH sides blocks the journey: the verdict is
 * "blocked" with exactly one honest critical finding (deterministic
 * errorKind facts, never raw messages) and no fabricated diffs. Otherwise
 * the findings come from the pure comparison core (semantic + state
 * dimensions) and the verdict is "divergent" when any finding is minor or
 * worse, "equivalent" when findings are empty or info-only.
 *
 * The report is a pure function of the served content (byte-identical across
 * runs of identical sides); the transport field carries the honestly
 * nondeterministic facts (ports, wall-clock); the artifacts field carries
 * the content-addressed evidence inventory the findings cite.
 *
 * Purity: the journey input is structuredClone-snapshotted and validated
 * before anything starts; the caller's objects are never mutated. Both
 * sides are re-bound fail-closed (parameter position decides the label),
 * and every started side is stopped again — even on a blocked run.
 */
export async function runPairedJourney(input: RunPairedJourneyInput): Promise<PairedRunEnvelope> {
  const startedAtMs = Date.now();
  const journey = normalizePairedJourney(input.journey);
  const reconstructionId = normalizeReconstructionId(input.reconstructionId, journey.id);
  const reference = bindPairedSide(input.reference, "reference");
  const candidate = bindPairedSide(input.candidate, "candidate");

  let referenceHandle: StartedPairedSide | null = null;
  let candidateHandle: StartedPairedSide | null = null;
  let blocked: DiffFinding | null = null;
  let referencePage: PairedPageCapture | null = null;
  let candidatePage: PairedPageCapture | null = null;
  const referenceApis: PairedApiCapture[] = [];
  const candidateApis: PairedApiCapture[] = [];
  let referenceState: PairedStateCapture | null = null;
  let candidateState: PairedStateCapture | null = null;

  try {
    try {
      referenceHandle = await reference.start();
    } catch (error) {
      blocked = startBlockedFinding(journey, "reference", error);
    }
    if (blocked === null) {
      try {
        candidateHandle = await candidate.start();
      } catch (error) {
        blocked = startBlockedFinding(journey, "candidate", error);
      }
    }

    if (blocked === null && referenceHandle !== null && candidateHandle !== null) {
      const referencePre = snapshotStateOf(reference);
      const candidatePre = snapshotStateOf(candidate);

      try {
        referencePage = await fetchPageCapture(referenceHandle.baseUrl, journey);
      } catch (error) {
        blocked = pageBlockedFinding(journey, "reference", error, []);
      }
      if (blocked === null && referencePage !== null) {
        const evidenceSoFar = [pageArtifact("reference", journey.routePath, referencePage)];
        for (const check of journey.apiChecks ?? []) {
          try {
            referenceApis.push(await fetchApiCapture(referenceHandle.baseUrl, check));
          } catch (error) {
            blocked = apiBlockedFinding(check, "reference", error, evidenceSoFar);
            break;
          }
        }
      }
      if (blocked === null && referencePre !== null) {
        const referencePost = snapshotStateOf(reference);
        if (referencePost !== null) {
          referenceState = {
            preDigest: contentHash(referencePre),
            postDigest: contentHash(referencePost),
          };
        }
      }

      if (blocked === null) {
        const captured =
          referencePage === null
            ? []
            : [pageArtifact("reference", journey.routePath, referencePage)];
        try {
          candidatePage = await fetchPageCapture(candidateHandle.baseUrl, journey);
        } catch (error) {
          blocked = pageBlockedFinding(journey, "candidate", error, captured);
        }
      }
      if (
        blocked === null &&
        referencePage !== null &&
        candidatePage !== null &&
        referencePage.status >= 400 &&
        candidatePage.status >= 400
      ) {
        blocked = bothPagesErrorBlockedFinding(
          journey,
          referencePage.status,
          candidatePage.status,
          [
            pageArtifact("reference", journey.routePath, referencePage),
            pageArtifact("candidate", journey.routePath, candidatePage),
          ],
        );
      }
      if (blocked === null && referencePage !== null && candidatePage !== null) {
        const evidenceSoFar = [
          pageArtifact("reference", journey.routePath, referencePage),
          pageArtifact("candidate", journey.routePath, candidatePage),
        ];
        for (const check of journey.apiChecks ?? []) {
          try {
            candidateApis.push(await fetchApiCapture(candidateHandle.baseUrl, check));
          } catch (error) {
            blocked = apiBlockedFinding(check, "candidate", error, evidenceSoFar);
            break;
          }
        }
      }
      if (blocked === null && candidatePre !== null) {
        const candidatePost = snapshotStateOf(candidate);
        if (candidatePost !== null) {
          candidateState = {
            preDigest: contentHash(candidatePre),
            postDigest: contentHash(candidatePost),
          };
        }
      }
    }
  } finally {
    if (candidateHandle !== null) await stopQuietly(candidateHandle);
    if (referenceHandle !== null) await stopQuietly(referenceHandle);
  }

  const referenceCapture: PairedSideCapture | null =
    referencePage === null
      ? null
      : {
          side: "reference",
          journeyId: journey.id,
          routePath: journey.routePath,
          page: referencePage,
          api: [...referenceApis],
          state: referenceState ?? undefined,
        };
  const candidateCapture: PairedSideCapture | null =
    candidatePage === null
      ? null
      : {
          side: "candidate",
          journeyId: journey.id,
          routePath: journey.routePath,
          page: candidatePage,
          api: [...candidateApis],
          state: candidateState ?? undefined,
        };

  let findings: DiffFinding[];
  if (blocked !== null) {
    findings = [blocked];
  } else if (referenceCapture !== null && candidateCapture !== null) {
    findings = compareSidesSemantically(referenceCapture, candidateCapture);
  } else {
    // Unreachable by construction: a missing page capture always implies a
    // blocked finding above. Kept as an honest empty fallback, never a guess.
    findings = [];
  }

  const verdict: PairedVerdict =
    blocked !== null
      ? "blocked"
      : findings.some((each) => each.severity !== "info")
        ? "divergent"
        : "equivalent";

  const referenceRunId = inventoryRunId(referenceCapture);
  const candidateRunId = inventoryRunId(candidateCapture);
  const report: DiffReport = {
    id: reportIdOf({
      reconstructionId,
      referenceRunId,
      candidateRunId,
      findings,
      verdict,
    }),
    reconstructionId,
    referenceRunId,
    candidateRunId,
    findings,
    verdict,
  };

  const artifacts: PairedArtifact[] = [
    ...(referenceCapture !== null ? artifactsOfCapture(referenceCapture) : []),
    ...(candidateCapture !== null ? artifactsOfCapture(candidateCapture) : []),
  ];

  return {
    report,
    transport: {
      referencePort: referenceHandle === null ? 0 : referenceHandle.port,
      candidatePort: candidateHandle === null ? 0 : candidateHandle.port,
      startedAtMs,
      durationMs: Date.now() - startedAtMs,
    },
    artifacts,
  };
}

// ---------------------------------------------------------------------------
// The suite runner
// ---------------------------------------------------------------------------

/** The worst of a set of verdicts: blocked over divergent over equivalent. */
function worstVerdict(verdicts: PairedVerdict[]): PairedVerdict {
  if (verdicts.includes("blocked")) return "blocked";
  if (verdicts.includes("divergent")) return "divergent";
  return "equivalent";
}

/**
 * Runs every journey sequentially (input order — deterministic), one paired
 * run per journey, and aggregates: the worst verdict (a side that cannot
 * start fails the whole suite closed as "blocked"), the findings grouped by
 * dimension, the per-journey summaries, and the full envelope set.
 *
 * Every journey is normalized (and the whole set validated) BEFORE any side
 * starts, so an invalid journey fails closed with no partial runs. The sides
 * are started and stopped once per journey — fresh incarnations, no state
 * reuse assumptions.
 */
export async function runPairedSuite(input: RunPairedSuiteInput): Promise<PairedSuiteResult> {
  const reconstructionId = normalizeReconstructionId(input.reconstructionId, "suite");
  if (!Array.isArray(input.journeys)) {
    throw new TypeError("journeys must be an array of PairedJourney values");
  }
  const journeys = input.journeys.map((journey) => normalizePairedJourney(journey));

  const envelopes: PairedRunEnvelope[] = [];
  const summaries: PairedJourneySummary[] = [];
  for (const journey of journeys) {
    const envelope = await runPairedJourney({
      journey,
      reference: input.reference,
      candidate: input.candidate,
      reconstructionId,
    });
    envelopes.push(envelope);
    summaries.push({
      journeyId: journey.id,
      journeyName: journey.name,
      verdict: envelope.report.verdict,
      findingCount: envelope.report.findings.length,
    });
  }

  const semantic: DiffFinding[] = [];
  const state: DiffFinding[] = [];
  for (const envelope of envelopes) {
    for (const each of envelope.report.findings) {
      if (each.dimension === "semantic") semantic.push(each);
      else if (each.dimension === "state") state.push(each);
    }
  }

  return {
    verdict: worstVerdict(envelopes.map((envelope) => envelope.report.verdict)),
    findingsByDimension: { semantic, state },
    journeys: summaries,
    envelopes,
  };
}

// ---------------------------------------------------------------------------
// Deterministic serializers
// ---------------------------------------------------------------------------

/**
 * Canonical serialization of the frozen DiffReport — the deterministic form
 * regression tracking compares byte-for-byte. Contains no transport facts
 * by construction (no ports, no durations, no timestamps).
 */
export function serializePairedReport(report: DiffReport): string {
  return canonicalJson(report);
}

/**
 * Canonical serialization of a run's deterministic core (report + evidence
 * inventory). The transport field is excluded — it carries the honestly
 * nondeterministic facts.
 */
export function serializePairedRun(run: PairedRunEnvelope): string {
  return canonicalJson({ report: run.report, artifacts: run.artifacts });
}

/**
 * Canonical serialization of a suite's deterministic core (verdict, findings
 * by dimension, per-journey summaries, and every run's deterministic core).
 * Transports are excluded.
 */
export function serializePairedSuite(suite: PairedSuiteResult): string {
  return canonicalJson({
    verdict: suite.verdict,
    findingsByDimension: suite.findingsByDimension,
    journeys: suite.journeys,
    runs: suite.envelopes.map((envelope) => ({
      report: envelope.report,
      artifacts: envelope.artifacts,
    })),
  });
}
