import type { DiffFinding } from "@clapp/contracts";
import { contentHash } from "./hash.ts";
import type {
  PairedApiCapture,
  PairedApiCheck,
  PairedArtifact,
  PairedJourney,
  PairedPageCapture,
  PairedSideCapture,
  PairedSideLabel,
} from "./paired.ts";

/**
 * The pure comparison core of the reference/candidate paired runner
 * (CLAPP-W3-004): evidence addressing plus the semantic and state dimension
 * logic, isolated from all I/O so W3-005 can reuse the same pattern across
 * the visual and network dimensions.
 *
 * Everything in this module is a pure function of its inputs: no servers, no
 * fetches, no clocks, no randomness. Findings are content-addressed (ids are
 * sha256 prefixes of the canonical finding form), so the same pair of
 * captures always produces byte-identical findings in a deterministic order.
 */

/**
 * Relative body-length divergence (fraction of the larger body) that must be
 * exceeded before body length counts as divergent. Text content equality is
 * NOT required across sides — only the anchor contract — so length findings
 * are informational: they never affect the verdict.
 */
export const PAIRED_BODY_LENGTH_TOLERANCE = 0.1;

// ---------------------------------------------------------------------------
// Evidence addressing
// ---------------------------------------------------------------------------

/** The pseudo-path of a state snapshot artifact (never a servable route). */
export function stateArtifactPath(phase: "pre" | "post"): string {
  return phase === "pre" ? "state://pre" : "state://post";
}

/** Stamps a content-addressed id onto an artifact body (sha256, 16 hex). */
function withId(content: Omit<PairedArtifact, "id">): PairedArtifact {
  return { ...content, id: `pa-${contentHash(content).slice(0, 16)}` };
}

/** The page artifact of one side's route capture: the fetched body's digest. */
export function pageArtifact(
  side: PairedSideLabel,
  routePath: string,
  page: PairedPageCapture,
): PairedArtifact {
  return withId({
    side,
    kind: "page",
    routePath,
    digest: page.bodyDigest,
    status: page.status,
    anchorsFound: [...page.anchorsFound],
  });
}

/** The artifact of one side's API-check capture (raw bytes + semantic digest). */
export function apiArtifact(side: PairedSideLabel, entry: PairedApiCapture): PairedArtifact {
  return withId({
    side,
    kind: "api",
    routePath: entry.path,
    digest: entry.bodyDigest,
    status: entry.status,
    ...(entry.parsedKeyDigest !== null ? { semanticDigest: entry.parsedKeyDigest } : {}),
    ...(entry.expectKey !== null ? { expectKey: entry.expectKey } : {}),
  });
}

/** The artifact of one side's state snapshot for one journey phase. */
export function stateArtifact(
  side: PairedSideLabel,
  phase: "pre" | "post",
  digest: string,
): PairedArtifact {
  return withId({ side, kind: "state", routePath: stateArtifactPath(phase), digest });
}

/** The full evidence inventory of one side's journey capture, in capture order. */
export function artifactsOfCapture(capture: PairedSideCapture): PairedArtifact[] {
  const artifacts: PairedArtifact[] = [pageArtifact(capture.side, capture.routePath, capture.page)];
  for (const entry of capture.api) {
    artifacts.push(apiArtifact(capture.side, entry));
  }
  if (capture.state !== undefined) {
    artifacts.push(stateArtifact(capture.side, "pre", capture.state.preDigest));
    artifacts.push(stateArtifact(capture.side, "post", capture.state.postDigest));
  }
  return artifacts;
}

// ---------------------------------------------------------------------------
// Finding construction
// ---------------------------------------------------------------------------

/** Stamps a content-addressed id onto a finding body (sha256, 16 hex). */
function finding(input: Omit<DiffFinding, "id">): DiffFinding {
  return { ...input, id: `df-${contentHash(input).slice(0, 16)}` };
}

/** Deterministic finding order: dimension, then anchor, then id. */
function sortFindings(findings: DiffFinding[]): DiffFinding[] {
  return [...findings].sort((a, b) => {
    if (a.dimension !== b.dimension) return a.dimension < b.dimension ? -1 : 1;
    if (a.anchor !== b.anchor) return a.anchor < b.anchor ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** The media type of a content type (the portion before any ";"). */
function mediaTypeOf(contentType: string): string {
  return contentType.split(";")[0].trim();
}

/** Body lengths count as divergent beyond the documented relative tolerance. */
function bodyLengthDiverges(referenceChars: number, candidateChars: number): boolean {
  const larger = Math.max(referenceChars, candidateChars);
  if (larger === 0) return false;
  return Math.abs(referenceChars - candidateChars) / larger > PAIRED_BODY_LENGTH_TOLERANCE;
}

/**
 * The deterministic kind of an error: a system error code ("ECONNREFUSED")
 * or the error name ("Error", "TypeError"). Raw messages are deliberately
 * excluded — they can embed nondeterministic transport facts (ports,
 * addresses) that must never reach the deterministic report.
 */
function errorKindOf(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  if (error instanceof Error) return error.name;
  return typeof error;
}

/** A side that fails to start blocks the whole journey — honestly, never fabricated. */
export function startBlockedFinding(
  journey: PairedJourney,
  side: PairedSideLabel,
  error: unknown,
): DiffFinding {
  return finding({
    dimension: "semantic",
    severity: "critical",
    anchor: journey.routePath,
    expected: { phase: "start", side, outcome: "started" },
    actual: { phase: "start", side, outcome: "rejected", errorKind: errorKindOf(error) },
    evidenceRefs: [],
    repairability: "manual",
  });
}

/** A page fetch that rejects blocks the journey; captured evidence is cited. */
export function pageBlockedFinding(
  journey: PairedJourney,
  side: PairedSideLabel,
  error: unknown,
  captured: PairedArtifact[],
): DiffFinding {
  return finding({
    dimension: "semantic",
    severity: "critical",
    anchor: journey.routePath,
    expected: { phase: "page", side, routePath: journey.routePath, outcome: "responded" },
    actual: {
      phase: "page",
      side,
      routePath: journey.routePath,
      outcome: "rejected",
      errorKind: errorKindOf(error),
    },
    evidenceRefs: captured.map((artifact) => artifact.id),
    repairability: "manual",
  });
}

/** An API-check fetch that rejects blocks the journey; evidence is cited. */
export function apiBlockedFinding(
  check: PairedApiCheck,
  side: PairedSideLabel,
  error: unknown,
  captured: PairedArtifact[],
): DiffFinding {
  return finding({
    dimension: "semantic",
    severity: "critical",
    anchor: check.path,
    expected: { phase: "api", side, path: check.path, outcome: "responded" },
    actual: {
      phase: "api",
      side,
      path: check.path,
      outcome: "rejected",
      errorKind: errorKindOf(error),
    },
    evidenceRefs: captured.map((artifact) => artifact.id),
    repairability: "manual",
  });
}

/** A route that errors (status >= 400) on BOTH sides cannot be compared. */
export function bothPagesErrorBlockedFinding(
  journey: PairedJourney,
  referenceStatus: number,
  candidateStatus: number,
  captured: PairedArtifact[],
): DiffFinding {
  return finding({
    dimension: "semantic",
    severity: "critical",
    anchor: journey.routePath,
    expected: {
      phase: "page",
      routePath: journey.routePath,
      requirement: "the route must be servable (status < 400) on at least one side",
    },
    actual: {
      phase: "page",
      routePath: journey.routePath,
      referenceStatus,
      candidateStatus,
    },
    evidenceRefs: captured.map((artifact) => artifact.id),
    repairability: "manual",
  });
}

// ---------------------------------------------------------------------------
// The dimension comparison
// ---------------------------------------------------------------------------

/**
 * Compares one reference capture against one candidate capture into the
 * semantic and state dimension findings — the pure core of
 * {@link runPairedJourney} and the seam W3-005 reuses for the visual and
 * network dimensions.
 *
 * Semantic dimension (per route and per API check):
 * - an anchor present on one side but missing on the other is a "major"
 *   finding naming the anchor, with the full anchorsFound inventories as
 *   expected/actual (an anchor missing on BOTH sides is agreement, not a
 *   divergence, and produces no finding);
 * - page status divergence is "major";
 * - content-type divergence is "major" when the media types differ and
 *   "minor" when only parameters (charset and friends) differ;
 * - body-length divergence beyond PAIRED_BODY_LENGTH_TOLERANCE is "info"
 *   (text equality is not required across sides, only the anchor contract);
 * - an API check whose statuses diverge is "major" (bodies are then not
 *   comparable); equal error statuses (>= 400) are equivalent absence and
 *   produce no finding; when both sides served (< 400), diverging canonical
 *   JSON digests are "major", and non-JSON bodies that differ at byte level
 *   are "info".
 *
 * State dimension (only when BOTH captures carry state snapshots):
 * - pre-journey digest divergence is a "major" finding anchored at
 *   "state:pre-journey" (the sides did not boot to the same state);
 * - post-journey digest divergence is a "major" finding anchored at
 *   "state:post-journey" (the journey transitioned the sides differently).
 *
 * The returned findings are content-addressed and deterministically ordered,
 * so identical captures always yield a byte-identical list.
 */
export function compareSidesSemantically(
  referenceCapture: PairedSideCapture,
  candidateCapture: PairedSideCapture,
): DiffFinding[] {
  const findings: DiffFinding[] = [];
  const reference = referenceCapture.page;
  const candidate = candidateCapture.page;
  const pageEvidence = [
    pageArtifact(referenceCapture.side, referenceCapture.routePath, reference).id,
    pageArtifact(candidateCapture.side, candidateCapture.routePath, candidate).id,
  ];

  // --- semantic: the anchor contract ---
  const anchorUniverse: string[] = [];
  const seenAnchors = new Set<string>();
  for (const anchor of [
    ...reference.anchorsFound,
    ...reference.anchorsMissing,
    ...candidate.anchorsFound,
    ...candidate.anchorsMissing,
  ]) {
    if (seenAnchors.has(anchor)) continue;
    seenAnchors.add(anchor);
    anchorUniverse.push(anchor);
  }
  for (const anchor of anchorUniverse) {
    const inReference = reference.anchorsFound.includes(anchor);
    const inCandidate = candidate.anchorsFound.includes(anchor);
    if (inReference === inCandidate) continue;
    findings.push(
      finding({
        dimension: "semantic",
        severity: "major",
        anchor,
        expected: [...reference.anchorsFound],
        actual: [...candidate.anchorsFound],
        evidenceRefs: [...pageEvidence],
        repairability: "assisted",
      }),
    );
  }

  // --- semantic: page status ---
  if (reference.status !== candidate.status) {
    findings.push(
      finding({
        dimension: "semantic",
        severity: "major",
        anchor: referenceCapture.routePath,
        expected: reference.status,
        actual: candidate.status,
        evidenceRefs: [...pageEvidence],
        repairability: "assisted",
      }),
    );
  }

  // --- semantic: content type (media type major, parameters minor) ---
  const referenceMedia = mediaTypeOf(reference.contentType);
  const candidateMedia = mediaTypeOf(candidate.contentType);
  if (referenceMedia !== candidateMedia || reference.contentType !== candidate.contentType) {
    findings.push(
      finding({
        dimension: "semantic",
        severity: referenceMedia !== candidateMedia ? "major" : "minor",
        anchor: referenceCapture.routePath,
        expected: reference.contentType,
        actual: candidate.contentType,
        evidenceRefs: [...pageEvidence],
        repairability: "assisted",
      }),
    );
  }

  // --- semantic: body length (informational only) ---
  if (bodyLengthDiverges(reference.bodyChars, candidate.bodyChars)) {
    findings.push(
      finding({
        dimension: "semantic",
        severity: "info",
        anchor: referenceCapture.routePath,
        expected: reference.bodyChars,
        actual: candidate.bodyChars,
        evidenceRefs: [...pageEvidence],
        repairability: "manual",
      }),
    );
  }

  // --- semantic: the API checks ---
  if (referenceCapture.api.length !== candidateCapture.api.length) {
    const apiEvidence = [
      ...referenceCapture.api.map((entry) => apiArtifact(referenceCapture.side, entry).id),
      ...candidateCapture.api.map((entry) => apiArtifact(candidateCapture.side, entry).id),
    ];
    findings.push(
      finding({
        dimension: "semantic",
        severity: "major",
        anchor: "api-check-inventory",
        expected: referenceCapture.api.map((entry) => entry.path),
        actual: candidateCapture.api.map((entry) => entry.path),
        evidenceRefs: apiEvidence,
        repairability: "manual",
      }),
    );
  }
  const apiCount = Math.min(referenceCapture.api.length, candidateCapture.api.length);
  for (let index = 0; index < apiCount; index += 1) {
    const referenceApi = referenceCapture.api[index];
    const candidateApi = candidateCapture.api[index];
    if (referenceApi === undefined || candidateApi === undefined) continue;
    const apiEvidence = [
      apiArtifact(referenceCapture.side, referenceApi).id,
      apiArtifact(candidateCapture.side, candidateApi).id,
    ];
    if (referenceApi.status !== candidateApi.status) {
      findings.push(
        finding({
          dimension: "semantic",
          severity: "major",
          anchor: referenceApi.path,
          expected: referenceApi.status,
          actual: candidateApi.status,
          evidenceRefs: apiEvidence,
          repairability: "assisted",
        }),
      );
      continue; // bodies are not comparable across different statuses
    }
    if (referenceApi.status >= 400) continue; // equal absence on both sides
    if (referenceApi.parsedKeyDigest !== null || candidateApi.parsedKeyDigest !== null) {
      if (referenceApi.parsedKeyDigest !== candidateApi.parsedKeyDigest) {
        findings.push(
          finding({
            dimension: "semantic",
            severity: "major",
            anchor: referenceApi.path,
            expected: referenceApi.parsedKeyDigest,
            actual: candidateApi.parsedKeyDigest,
            evidenceRefs: apiEvidence,
            repairability: "assisted",
          }),
        );
      }
    } else if (referenceApi.bodyDigest !== candidateApi.bodyDigest) {
      findings.push(
        finding({
          dimension: "semantic",
          severity: "info",
          anchor: referenceApi.path,
          expected: referenceApi.bodyDigest,
          actual: candidateApi.bodyDigest,
          evidenceRefs: apiEvidence,
          repairability: "manual",
        }),
      );
    }
  }

  // --- state: pre/post-journey snapshot digests (both sides only) ---
  if (referenceCapture.state !== undefined && candidateCapture.state !== undefined) {
    const preEvidence = [
      stateArtifact(referenceCapture.side, "pre", referenceCapture.state.preDigest).id,
      stateArtifact(candidateCapture.side, "pre", candidateCapture.state.preDigest).id,
    ];
    if (referenceCapture.state.preDigest !== candidateCapture.state.preDigest) {
      findings.push(
        finding({
          dimension: "state",
          severity: "major",
          anchor: "state:pre-journey",
          expected: referenceCapture.state.preDigest,
          actual: candidateCapture.state.preDigest,
          evidenceRefs: preEvidence,
          repairability: "assisted",
        }),
      );
    }
    const postEvidence = [
      stateArtifact(referenceCapture.side, "post", referenceCapture.state.postDigest).id,
      stateArtifact(candidateCapture.side, "post", candidateCapture.state.postDigest).id,
    ];
    if (referenceCapture.state.postDigest !== candidateCapture.state.postDigest) {
      findings.push(
        finding({
          dimension: "state",
          severity: "major",
          anchor: "state:post-journey",
          expected: referenceCapture.state.postDigest,
          actual: candidateCapture.state.postDigest,
          evidenceRefs: postEvidence,
          repairability: "assisted",
        }),
      );
    }
  }

  return sortFindings(findings);
}
