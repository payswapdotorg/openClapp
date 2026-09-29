import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { DiffFinding, SynthesisPlan } from "../packages/clapp-contracts/src/index.ts";
import {
  aggregateRepairPatterns,
  buildFailureMemoryRecord,
  countFailureRecurrence,
  FAILURE_MEMORY_ID_PREFIX,
  type FailureAbstentionRecord,
  type FailureIterationRecord,
  type FailureMemoryInput,
  type FailureMemoryRecord,
  type FailureMemoryResult,
  type FailureRepairOutcome,
  failureMemoryDigest,
  REPAIR_PATTERN_EVIDENCE_MINIMUM,
  suggestRepairHints,
} from "../packages/clapp-intelligence/src/index.ts";
import { canonicalJson } from "../packages/clapp-intelligence/src/json.ts";
import type {
  RepairIterationRecord,
  RepairReport,
} from "../packages/clapp-synthesis/src/repair.ts";

/**
 * CLAPP-W2-008 — failure memory and repair-pattern learning.
 *
 * Proves the memory-layer-5 surface of docs/clapp/LEARNING.md ("what broke
 * and how it was fixed", plus the failure-recurrence signal): the structural
 * outcome of a finished W3-006 bounded repair loop plus the W3-005 parity
 * findings that fed it distill into content-addressed `clapp_learning_`
 * records; corroborated records aggregate into evidence-gated repair
 * patterns; patterns — and only patterns — suggest honest hints for NEW
 * findings; and the accounting digest makes the whole surface auditable.
 *
 * This file is the integration seam (ADR-002): it is the ONE place where
 * cross-package types are legal, composing the real W3-006 RepairReport and
 * the frozen v0.1 DiffFinding shapes into the W2-008 structural input —
 * while asserting that the module itself mirrors those shapes without ever
 * importing @clapp/synthesis. Everything is deterministic and in-process: no
 * clock, no randomness, no network, no filesystem beyond reading the one
 * source file the no-import proof asserts over.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A W3-005-shaped parity finding (the frozen v0.1 DiffFinding). */
function makeFinding(overrides: Partial<DiffFinding> = {}): DiffFinding {
  return {
    id: "clapp_finding_w2_008_0001",
    dimension: "visual",
    severity: "minor",
    anchor: "text:heading[1]",
    evidenceRefs: ["clapp_evidence_w2_008_0001"],
    repairability: "automatic",
    ...overrides,
  };
}

/** An iteration of a converged single-class visible-text repair loop. */
const VISIBLE_TEXT_ITERATION: FailureIterationRecord = {
  findingsBefore: 1,
  actionsApplied: 1,
  findingsAfter: 0,
  verdict: "equivalent",
  mutationClasses: ["visible-text"],
};

/** An iteration of a converged single-class network-mock repair loop. */
const NETWORK_MOCK_ITERATION: FailureIterationRecord = {
  findingsBefore: 1,
  actionsApplied: 1,
  findingsAfter: 0,
  verdict: "equivalent",
  mutationClasses: ["network-mock"],
};

/** An iteration of a converged single-class interaction-id repair loop. */
const INTERACTION_ID_ITERATION: FailureIterationRecord = {
  findingsBefore: 1,
  actionsApplied: 1,
  findingsAfter: 0,
  verdict: "equivalent",
  mutationClasses: ["interaction-id"],
};

/** One honest abstention entry of a repair report. */
const SKELETON_ABSTENTION: FailureAbstentionRecord = {
  anchor: "visual:skeleton",
  reason: "skeleton digest only — no structured channel pinpoints the change",
};

/**
 * A structural repair outcome — the W3-006 RepairReport shape minus the plan
 * body. Defaults to a converged, equivalent, single-class (visible-text)
 * loop: the honest witness of a successful unambiguous repair.
 */
function makeOutcome(overrides: Partial<FailureRepairOutcome> = {}): FailureRepairOutcome {
  return {
    id: "rr-w2-008-0001",
    reconstructionId: "rc-w2-008-0001",
    iterations: [VISIBLE_TEXT_ITERATION],
    finalVerdict: "equivalent",
    abstained: [],
    actionsTotal: 1,
    converged: true,
    stoppedBy: "converged",
    ...(overrides.finalPlanDigest !== undefined
      ? { finalPlanDigest: overrides.finalPlanDigest }
      : {}),
    ...overrides,
  };
}

/** The record a successful build must produce (fails loudly on abstention). */
function remembered(input: FailureMemoryInput): FailureMemoryRecord {
  const result = buildFailureMemoryRecord(input);
  assert.ok(result.ok, `expected a record, abstained: ${result.ok ? "" : result.reason}`);
  if (!result.ok) {
    throw new Error("unreachable");
  }
  return result.record;
}

/** The abstention reason an honest failure must carry (fails on a record). */
function abstentionReason(result: FailureMemoryResult): string {
  assert.ok(!result.ok, "expected an honest abstention, not a record");
  if (result.ok) {
    throw new Error("unreachable");
  }
  return result.reason;
}

/**
 * A record that corroborates (visual, "text:heading[1]", visible-text): a
 * converged single-class loop over one blocking visual finding.
 */
function corroboratingRecord(reconstructionId: string, reportId: string): FailureMemoryRecord {
  return remembered({
    findings: [makeFinding({ severity: "minor" })],
    outcome: makeOutcome({ reconstructionId, id: reportId }),
  });
}

/** The canonical core of a record (the preimage of its content-addressed id). */
function recordCoreOf(record: FailureMemoryRecord): Record<string, unknown> {
  return {
    kind: "failure-memory/1",
    reconstructionId: record.reconstructionId,
    reportId: record.reportId,
    successful: record.successful,
    failures: record.failures,
    repair: record.repair,
  };
}

// ---------------------------------------------------------------------------
// The 8 named acceptance tests
// ---------------------------------------------------------------------------

test("records are content-addressed and deterministic", () => {
  const input: FailureMemoryInput = {
    findings: [
      makeFinding({
        id: "clapp_finding_a",
        dimension: "visual",
        anchor: "text:heading[1]",
        severity: "minor",
      }),
      makeFinding({
        id: "clapp_finding_b",
        dimension: "state",
        anchor: "state:boardName",
        severity: "major",
      }),
    ],
    outcome: makeOutcome({
      id: "rr-det-0001",
      reconstructionId: "rc-det-0001",
      iterations: [
        {
          findingsBefore: 2,
          actionsApplied: 2,
          findingsAfter: 1,
          verdict: "divergent",
          mutationClasses: ["visible-text"],
        },
        {
          findingsBefore: 1,
          actionsApplied: 1,
          findingsAfter: 0,
          verdict: "equivalent",
          mutationClasses: ["state-storage"],
        },
      ],
      abstained: [
        SKELETON_ABSTENTION,
        { anchor: "network:api:/tasks", reason: "reference-api probe declined" },
      ],
      actionsTotal: 3,
    }),
  };

  // Same input twice (a deep copy, not the same reference): byte-identical.
  const first = remembered(input);
  const second = remembered(JSON.parse(JSON.stringify(input)) as FailureMemoryInput);
  assert.deepEqual(first, second);

  // Reordered findings / iterations / abstained arrays: the same record id
  // and the same core — the identity is the content, never the input order.
  const reordered = remembered({
    findings: [...input.findings].reverse(),
    outcome: makeOutcome({
      ...input.outcome,
      iterations: [...input.outcome.iterations].reverse(),
      abstained: [...input.outcome.abstained].reverse(),
    }),
  });
  assert.equal(reordered.id, first.id);
  assert.deepEqual(reordered, first);

  // The id is the prefix plus a 16-hex-char sha256 prefix of the canonical core.
  assert.ok(
    first.id.startsWith(FAILURE_MEMORY_ID_PREFIX),
    `id must carry the ${FAILURE_MEMORY_ID_PREFIX} prefix`,
  );
  const digestHex = first.id.slice(FAILURE_MEMORY_ID_PREFIX.length);
  assert.match(digestHex, /^[0-9a-f]{16}$/);
  const canonicalCore = canonicalJson(recordCoreOf(first));
  assert.ok(
    typeof canonicalCore === "string",
    "the record core must be canonical-JSON-serializable",
  );
  const expectedId =
    FAILURE_MEMORY_ID_PREFIX +
    createHash("sha256").update(canonicalCore).digest("hex").slice(0, 16);
  assert.equal(first.id, expectedId);

  // What broke and how it was fixed, with full citation of the sources.
  assert.equal(first.reconstructionId, "rc-det-0001");
  assert.equal(first.reportId, "rr-det-0001");
  assert.deepEqual(first.failures.map((failure) => failure.findingId).sort(), [
    "clapp_finding_a",
    "clapp_finding_b",
  ]);
  assert.deepEqual(first.repair.mutationClassesUsed, ["state-storage", "visible-text"]);
  assert.equal(first.repair.iterations, 2);
  assert.equal(first.repair.actionsTotal, 3);
  assert.equal(first.repair.abstentionCount, 2);
  assert.equal(first.repair.finalVerdict, "equivalent");
  assert.equal(first.repair.stoppedBy, "converged");
  assert.equal(first.repair.converged, true);
  assert.equal(first.successful, true);

  // A content difference changes the id (content addressing is honest).
  const otherContent = remembered({
    findings: input.findings,
    outcome: makeOutcome({ ...input.outcome, actionsTotal: 4 }),
  });
  assert.notEqual(otherContent.id, first.id);
});

test("nothing-to-remember outcomes abstain honestly", () => {
  // No blocking findings: info-only findings teach no repair lesson.
  const infoOnly = buildFailureMemoryRecord({
    findings: [
      makeFinding({ severity: "info" }),
      makeFinding({ id: "clapp_finding_info2", severity: "info" }),
    ],
    outcome: makeOutcome(),
  });
  assert.match(abstentionReason(infoOnly), /no blocking findings/);

  // An empty findings feed abstains the same honest way.
  const noFindings = buildFailureMemoryRecord({ findings: [], outcome: makeOutcome() });
  assert.match(abstentionReason(noFindings), /no blocking findings/);

  // An unattributable reconstruction id abstains with a recorded reason.
  const unattributable = buildFailureMemoryRecord({
    findings: [makeFinding()],
    outcome: makeOutcome({ reconstructionId: "" }),
  });
  assert.match(abstentionReason(unattributable), /reconstruction id/);
  assert.match(abstentionReason(unattributable), /not attributable/);

  // A report without provenance (no source report id) abstains.
  const noProvenance = buildFailureMemoryRecord({
    findings: [makeFinding()],
    outcome: makeOutcome({ id: "" }),
  });
  assert.match(abstentionReason(noProvenance), /repair report id/);

  // Malformed shapes abstain with collected reasons — never a thrown-away
  // input, never a fabricated record.
  const malformedInput = buildFailureMemoryRecord(undefined as unknown as FailureMemoryInput);
  assert.match(abstentionReason(malformedInput), /failure memory input is/);

  const malformedFindings = buildFailureMemoryRecord({
    findings: "not an array" as unknown as readonly DiffFinding[],
    outcome: makeOutcome(),
  });
  assert.match(abstentionReason(malformedFindings), /findings feed is/);

  const malformedOutcome = buildFailureMemoryRecord({
    findings: [makeFinding()],
    outcome: "garbage" as unknown as FailureRepairOutcome,
  });
  assert.match(abstentionReason(malformedOutcome), /repair outcome is/);

  const malformedVerdict = buildFailureMemoryRecord({
    findings: [makeFinding()],
    outcome: makeOutcome({ finalVerdict: "banana" as FailureRepairOutcome["finalVerdict"] }),
  });
  assert.match(abstentionReason(malformedVerdict), /final verdict is/);

  const malformedIterations = buildFailureMemoryRecord({
    findings: [makeFinding()],
    outcome: makeOutcome({ iterations: 7 as unknown as FailureIterationRecord[] }),
  });
  assert.match(abstentionReason(malformedIterations), /repair iterations are/);

  // Every abstention is a recorded reason, never a partial record.
  for (const result of [
    infoOnly,
    noFindings,
    unattributable,
    noProvenance,
    malformedInput,
    malformedFindings,
    malformedOutcome,
    malformedVerdict,
    malformedIterations,
  ]) {
    assert.ok(!result.ok);
    assert.ok(!("record" in result), "an abstention never carries a record");
  }
});

test("patterns respect the evidence minimum", () => {
  // The exported constant, documented default 2.
  assert.equal(REPAIR_PATTERN_EVIDENCE_MINIMUM, 2);

  const recordA = corroboratingRecord("rc-pat-a", "rr-pat-a");
  const recordB = corroboratingRecord("rc-pat-b", "rr-pat-b");

  // One corroborating record is an anecdote, not a pattern: the signature is
  // reported as insufficient evidence with the recorded reason.
  const one = aggregateRepairPatterns([recordA]);
  assert.equal(one.patterns.length, 0);
  assert.equal(one.insufficientEvidence.length, 1);
  const insufficient = one.insufficientEvidence[0];
  assert.equal(insufficient.dimension, "visual");
  assert.equal(insufficient.anchor, "text:heading[1]");
  assert.equal(insufficient.mutationClass, "visible-text");
  assert.equal(insufficient.supportCount, 1);
  assert.deepEqual(insufficient.recordIds, [recordA.id]);
  assert.match(insufficient.reason, /below the evidence minimum of 2/);

  // With the minimum met, the pattern appears with its support count and the
  // citing record ids.
  const two = aggregateRepairPatterns([recordA, recordB]);
  assert.equal(two.insufficientEvidence.length, 0);
  assert.equal(two.patterns.length, 1);
  const pattern = two.patterns[0];
  assert.equal(pattern.dimension, "visual");
  assert.equal(pattern.anchor, "text:heading[1]");
  assert.equal(pattern.mutationClass, "visible-text");
  assert.equal(pattern.supportCount, 2);
  assert.deepEqual(pattern.recordIds, [recordA.id, recordB.id].sort());
});

test("aggregation is pure and order-independent", () => {
  const visualA = corroboratingRecord("rc-ord-1", "rr-ord-1");
  const visualB = corroboratingRecord("rc-ord-2", "rr-ord-2");
  const networkA = remembered({
    findings: [
      makeFinding({
        id: "clapp_finding_net_a",
        dimension: "network",
        anchor: "api:/tasks",
        severity: "major",
      }),
    ],
    outcome: makeOutcome({
      reconstructionId: "rc-ord-3",
      id: "rr-ord-3",
      iterations: [NETWORK_MOCK_ITERATION],
    }),
  });
  const networkB = remembered({
    findings: [
      makeFinding({
        id: "clapp_finding_net_b",
        dimension: "network",
        anchor: "api:/tasks",
        severity: "minor",
      }),
    ],
    outcome: makeOutcome({
      reconstructionId: "rc-ord-4",
      id: "rr-ord-4",
      iterations: [NETWORK_MOCK_ITERATION],
    }),
  });
  // An unsuccessful loop: remembered, recurrent, but corroborating nothing.
  const failed = remembered({
    findings: [makeFinding({ id: "clapp_finding_fail", severity: "critical" })],
    outcome: makeOutcome({
      reconstructionId: "rc-ord-5",
      id: "rr-ord-5",
      finalVerdict: "divergent",
      converged: false,
      stoppedBy: "stagnation",
    }),
  });
  // A tampered record and a duplicate: the first fails closed, the second
  // counts once.
  const tampered: unknown = { ...visualA, id: `${FAILURE_MEMORY_ID_PREFIX}0000000000000000` };

  const ordered = aggregateRepairPatterns([
    visualA,
    visualB,
    networkA,
    networkB,
    failed,
    tampered,
    visualA,
  ]);
  const shuffled = aggregateRepairPatterns([
    visualA,
    tampered,
    networkB,
    failed,
    visualB,
    visualA,
    networkA,
  ]);

  // Byte-identical summaries regardless of input order.
  assert.deepEqual(ordered, shuffled);

  // Output arrays are deterministically sorted by (dimension, anchor, class).
  assert.deepEqual(
    ordered.patterns.map((pattern) => [pattern.dimension, pattern.anchor, pattern.mutationClass]),
    [
      ["network", "api:/tasks", "network-mock"],
      ["visual", "text:heading[1]", "visible-text"],
    ],
  );

  // The duplicate counts once; the tampered record fails closed with a
  // collected error and corroborates nothing.
  const visualPattern = ordered.patterns.find((pattern) => pattern.dimension === "visual");
  assert.ok(visualPattern !== undefined);
  assert.equal(visualPattern.supportCount, 2);
  assert.deepEqual(visualPattern.recordIds, [visualA.id, visualB.id].sort());
  assert.equal(ordered.invalidRecords.length, 1);
  assert.equal(ordered.invalidRecords[0].recordId, (tampered as { id: string }).id);
  assert.match(ordered.invalidRecords[0].reason, /content-address mismatch/);

  // A failed loop corroborates no pattern (attribution honesty).
  assert.ok(
    ordered.patterns.every((pattern) => pattern.supportCount >= REPAIR_PATTERN_EVIDENCE_MINIMUM),
  );
});

test("repair hints never fabricate", () => {
  const corroboratingA = corroboratingRecord("rc-hint-1", "rr-hint-1");
  const corroboratingB = corroboratingRecord("rc-hint-2", "rr-hint-2");
  // A signature seen exactly once: below the evidence minimum.
  const onceSeen = remembered({
    findings: [
      makeFinding({
        id: "clapp_finding_once",
        dimension: "network",
        anchor: "api:/tasks",
        severity: "major",
      }),
    ],
    outcome: makeOutcome({
      reconstructionId: "rc-hint-3",
      id: "rr-hint-3",
      iterations: [NETWORK_MOCK_ITERATION],
    }),
  });
  const records = [corroboratingA, corroboratingB, onceSeen];

  const matched = makeFinding({
    id: "clapp_finding_new_1",
    dimension: "visual",
    anchor: "text:heading[1]",
    severity: "major",
  });
  const belowMinimum = makeFinding({
    id: "clapp_finding_new_2",
    dimension: "network",
    anchor: "api:/tasks",
    severity: "minor",
  });
  const neverSeen = makeFinding({
    id: "clapp_finding_new_3",
    dimension: "state",
    anchor: "state:boardName",
    severity: "critical",
  });

  const result = suggestRepairHints([matched, belowMinimum, neverSeen], records);

  // Exactly one hint — for the only finding whose signature matches a
  // corroborated pattern — and it cites its supporting record ids and the
  // historically-successful mutation class.
  assert.equal(result.hints.length, 1);
  const hint = result.hints[0];
  assert.equal(hint.findingId, "clapp_finding_new_1");
  assert.equal(hint.dimension, "visual");
  assert.equal(hint.anchor, "text:heading[1]");
  assert.equal(hint.mutationClass, "visible-text");
  assert.equal(hint.supportCount, 2);
  assert.deepEqual(hint.supportingRecordIds, [corroboratingA.id, corroboratingB.id].sort());
  const memoryIds = new Set(records.map((record) => record.id));
  for (const recordId of hint.supportingRecordIds) {
    assert.ok(memoryIds.has(recordId), `hint cites a record outside memory: ${recordId}`);
  }

  // Absence, not a placeholder: the other findings produce NO hint.
  const hintedIds = result.hints.map((each) => each.findingId);
  assert.equal(hintedIds.includes("clapp_finding_new_2"), false);
  assert.equal(hintedIds.includes("clapp_finding_new_3"), false);
  const unmatchedById = new Map(result.unmatched.map((entry) => [entry.findingId, entry.reason]));
  assert.match(
    unmatchedById.get("clapp_finding_new_2") ?? "",
    /below the repair-pattern evidence minimum of 2/,
  );
  assert.match(unmatchedById.get("clapp_finding_new_3") ?? "", /no corroborated repair pattern/);

  // An ambiguous history (two classes corroborated at the minimum) yields no
  // hint: hinting one would be a guess.
  const linkByTextA = remembered({
    findings: [makeFinding({ id: "clapp_finding_link_a", anchor: "link:label[0]" })],
    outcome: makeOutcome({ reconstructionId: "rc-hint-4", id: "rr-hint-4" }),
  });
  const linkByTextB = remembered({
    findings: [makeFinding({ id: "clapp_finding_link_b", anchor: "link:label[0]" })],
    outcome: makeOutcome({ reconstructionId: "rc-hint-5", id: "rr-hint-5" }),
  });
  const linkByInteractionA = remembered({
    findings: [makeFinding({ id: "clapp_finding_link_c", anchor: "link:label[0]" })],
    outcome: makeOutcome({
      reconstructionId: "rc-hint-6",
      id: "rr-hint-6",
      iterations: [INTERACTION_ID_ITERATION],
    }),
  });
  const linkByInteractionB = remembered({
    findings: [makeFinding({ id: "clapp_finding_link_d", anchor: "link:label[0]" })],
    outcome: makeOutcome({
      reconstructionId: "rc-hint-7",
      id: "rr-hint-7",
      iterations: [INTERACTION_ID_ITERATION],
    }),
  });
  const ambiguous = suggestRepairHints(
    [makeFinding({ id: "clapp_finding_amb", anchor: "link:label[0]", severity: "minor" })],
    [linkByTextA, linkByTextB, linkByInteractionA, linkByInteractionB],
  );
  assert.equal(ambiguous.hints.length, 0);
  assert.equal(ambiguous.unmatched.length, 1);
  assert.match(ambiguous.unmatched[0].reason, /hinting one would be a guess/);

  // Info findings and malformed findings never hint either.
  const infoOnly = suggestRepairHints(
    [makeFinding({ id: "clapp_finding_info", severity: "info" })],
    records,
  );
  assert.equal(infoOnly.hints.length, 0);
  assert.match(infoOnly.unmatched[0].reason, /info severity/);
  const malformed = suggestRepairHints(["garbage" as unknown as DiffFinding], records);
  assert.equal(malformed.hints.length, 0);
  assert.equal(malformed.unmatched.length, 1);
  assert.match(malformed.unmatched[0].reason, /no well-formed failure signature/);
});

test("failure recurrence is counted from records only", () => {
  const heading = { dimension: "visual" as const, anchor: "text:heading[1]" };
  const at = (id: string) => makeFinding({ id, ...heading });

  // Two different outcomes of the SAME reconstruction hitting the same
  // signature: the reconstruction counts once.
  const sameReconFirst = remembered({
    findings: [at("clapp_finding_rec_1")],
    outcome: makeOutcome({ reconstructionId: "rc-rec-1", id: "rr-rec-1" }),
  });
  const sameReconSecond = remembered({
    findings: [at("clapp_finding_rec_2")],
    outcome: makeOutcome({ reconstructionId: "rc-rec-1", id: "rr-rec-2" }),
  });
  const otherRecon = remembered({
    findings: [at("clapp_finding_rec_3")],
    outcome: makeOutcome({ reconstructionId: "rc-rec-2", id: "rr-rec-3" }),
  });
  // An UNsuccessful loop still counts: recurrence counts failures, not fixes.
  const failedRecon = remembered({
    findings: [at("clapp_finding_rec_4")],
    outcome: makeOutcome({
      reconstructionId: "rc-rec-3",
      id: "rr-rec-4",
      finalVerdict: "divergent",
      converged: false,
      stoppedBy: "stagnation",
    }),
  });

  const summary = countFailureRecurrence([
    sameReconFirst,
    sameReconSecond,
    otherRecon,
    failedRecon,
  ]);
  assert.equal(summary.recordCount, 4);
  assert.equal(summary.recurrences.length, 1);
  const recurrence = summary.recurrences[0];
  assert.equal(recurrence.dimension, "visual");
  assert.equal(recurrence.anchor, "text:heading[1]");
  assert.equal(recurrence.recurrenceCount, 3);
  assert.deepEqual(recurrence.reconstructionIds, ["rc-rec-1", "rc-rec-2", "rc-rec-3"]);
  assert.equal(recurrence.recordIds.length, 4);
  assert.deepEqual(
    recurrence.recordIds,
    [sameReconFirst.id, sameReconSecond.id, otherRecon.id, failedRecon.id].sort(),
  );

  // Empty memory: an honest zero accounting — no records, no signatures, no
  // invented numbers, no errors. A signature never recorded simply does not
  // appear: absence is neutral, never positive.
  const empty = countFailureRecurrence([]);
  assert.equal(empty.recordCount, 0);
  assert.deepEqual(empty.recurrences, []);
  assert.deepEqual(empty.invalidRecords, []);
});

test("the structural mirror composes the W3-006 shapes without imports", () => {
  // Compile-time proof (the one place cross-package types are legal): a
  // W3-006 RepairReport — finalPlan included — and W3-005-shaped findings
  // (the frozen v0.1 DiffFinding) are assignable to the W2-008 input types.
  const plan: SynthesisPlan = {
    schemaVersion: "0.1",
    architecture: {},
    routes: [],
    components: [],
    state: {},
    persistence: [],
    integrations: [],
    api: [],
    packageIds: [],
    acceptanceJourneyIds: [],
    assumptions: [],
  };
  const iteration: RepairIterationRecord = {
    findingsBefore: 1,
    actionsApplied: 1,
    findingsAfter: 0,
    verdict: "equivalent",
    mutationClasses: ["visible-text"],
  };
  const report: RepairReport = {
    id: "rr-w2-008-mirror-0001",
    reconstructionId: "rc-w2-008-mirror-0001",
    iterations: [iteration],
    finalVerdict: "equivalent",
    abstained: [],
    actionsTotal: 1,
    converged: true,
    stoppedBy: "converged",
    finalPlan: plan,
  };
  const findings: readonly DiffFinding[] = [
    makeFinding({
      id: "clapp_finding_mirror_0001",
      dimension: "visual",
      anchor: "text:heading[1]",
      severity: "minor",
    }),
  ];
  const input: FailureMemoryInput = { findings, outcome: report };

  // End-to-end: the W3-006-shaped outcome flows through the whole surface —
  // record, pattern, recurrence and hint.
  const recordOne = remembered(input);
  const reportTwo: RepairReport = {
    ...report,
    id: "rr-w2-008-mirror-0002",
    reconstructionId: "rc-w2-008-mirror-0002",
  };
  const recordTwo = remembered({ findings, outcome: reportTwo });
  const records: readonly unknown[] = [recordOne, recordTwo];

  const summary = aggregateRepairPatterns(records);
  assert.equal(summary.patterns.length, 1);
  assert.equal(summary.patterns[0].mutationClass, "visible-text");
  assert.deepEqual(summary.patterns[0].recordIds, [recordOne.id, recordTwo.id].sort());

  const recurrence = countFailureRecurrence(records);
  assert.equal(recurrence.recurrences.length, 1);
  assert.equal(recurrence.recurrences[0].recurrenceCount, 2);

  const hints = suggestRepairHints(
    [
      makeFinding({
        id: "clapp_finding_mirror_new",
        dimension: "visual",
        anchor: "text:heading[1]",
        severity: "major",
      }),
    ],
    records,
  );
  assert.equal(hints.hints.length, 1);
  assert.equal(hints.hints[0].mutationClass, "visible-text");
  assert.deepEqual(hints.hints[0].supportingRecordIds, [recordOne.id, recordTwo.id].sort());

  const digest = failureMemoryDigest({ records, abstentions: [] });
  assert.equal(digest.recordCount, 2);
  assert.equal(digest.patternCount, 1);

  // Source assertion: the module mirrors the W3-006 shapes structurally,
  // never by import. The check targets import syntax specifically — a bare
  // substring check would false-positive on the module's own header comment,
  // which cites the discipline it upholds.
  const source = readFileSync(
    fileURLToPath(new URL("../packages/clapp-intelligence/src/failure-memory.ts", import.meta.url)),
    "utf8",
  );
  assert.equal(
    /(?:from|require\(|import\()\s*"@clapp\/synthesis"/.test(source),
    false,
    "failure-memory.ts must not import @clapp/synthesis",
  );
});

test("empty and malformed memory degrade honestly", () => {
  // Empty record lists: zero-count summaries and no hints — no errors.
  assert.deepEqual(aggregateRepairPatterns([]), {
    patterns: [],
    insufficientEvidence: [],
    invalidRecords: [],
  });
  assert.deepEqual(countFailureRecurrence([]), {
    recurrences: [],
    recordCount: 0,
    invalidRecords: [],
  });
  const emptyHints = suggestRepairHints([makeFinding()], []);
  assert.equal(emptyHints.hints.length, 0);
  assert.equal(emptyHints.unmatched.length, 1);
  assert.deepEqual(emptyHints.invalidRecords, []);
  assert.deepEqual(failureMemoryDigest({}), {
    recordCount: 0,
    reconstructionCount: 0,
    patternCount: 0,
    insufficientEvidenceCount: 0,
    invalidRecordCount: 0,
    abstentionCount: 0,
    abstentionReasons: [],
  });

  // A non-array records input degrades to a collected error, never a crash.
  const notAnArray = aggregateRepairPatterns("garbage" as unknown as readonly unknown[]);
  assert.equal(notAnArray.patterns.length, 0);
  assert.equal(notAnArray.invalidRecords.length, 1);
  assert.match(notAnArray.invalidRecords[0].reason, /not an array/);

  // Malformed records fail closed with collected typed errors; nothing is
  // silently dropped.
  const good = corroboratingRecord("rc-degrade-1", "rr-degrade-1");
  const missingRepair: unknown = { ...good, repair: undefined };
  const tamperedFailures: unknown = {
    ...good,
    failures: [{ ...good.failures[0], anchor: "state:tampered" }],
  };
  const contradictory: unknown = { ...good, successful: false };
  const malformed: readonly unknown[] = [
    "not even an object",
    {},
    missingRepair,
    tamperedFailures,
    contradictory,
  ];

  const degraded = aggregateRepairPatterns(malformed);
  assert.equal(degraded.patterns.length, 0);
  assert.equal(degraded.insufficientEvidence.length, 0);
  assert.equal(degraded.invalidRecords.length, 5);
  for (const error of degraded.invalidRecords) {
    assert.ok(error.reason.length > 0, "every rejected record carries a reason");
  }
  // Lexicographic order: "(" (0x28) sorts before "c", so the two unattributable
  // entries lead, followed by the three good-id records that failed validation.
  assert.deepEqual(degraded.invalidRecords.map((error) => error.recordId).sort(), [
    "(unknown)",
    "(unknown)",
    good.id,
    good.id,
    good.id,
  ]);

  // The same honest degradation across the whole surface.
  const degradedRecurrence = countFailureRecurrence(malformed);
  assert.equal(degradedRecurrence.recordCount, 0);
  assert.equal(degradedRecurrence.recurrences.length, 0);
  assert.equal(degradedRecurrence.invalidRecords.length, 5);

  const degradedHints = suggestRepairHints([makeFinding()], malformed);
  assert.equal(degradedHints.hints.length, 0);
  assert.equal(degradedHints.unmatched.length, 1);
  assert.equal(degradedHints.invalidRecords.length, 5);

  const degradedDigest = failureMemoryDigest({
    records: malformed,
    abstentions: [
      {
        ok: false,
        reason:
          "outcome of reconstruction rc-x reports no blocking findings (0 info, 0 malformed dropped)",
      },
      { ok: true, record: good },
    ],
  });
  assert.equal(degradedDigest.recordCount, 0);
  assert.equal(degradedDigest.invalidRecordCount, 5);
  assert.equal(degradedDigest.abstentionCount, 1);
  assert.deepEqual(degradedDigest.abstentionReasons, [
    "outcome of reconstruction rc-x reports no blocking findings (0 info, 0 malformed dropped)",
  ]);

  // A healthy memory digests to its true counts (auditable without reading
  // a single record).
  const healthyA = corroboratingRecord("rc-degrade-2", "rr-degrade-2");
  const healthyB = corroboratingRecord("rc-degrade-3", "rr-degrade-3");
  const healthyDigest = failureMemoryDigest({
    records: [healthyA, healthyB, good],
    abstentions: [{ ok: false, reason: 'parity verdict is "divergent"' }],
  });
  assert.equal(healthyDigest.recordCount, 3);
  assert.equal(healthyDigest.reconstructionCount, 3);
  assert.equal(healthyDigest.patternCount, 1);
  assert.equal(healthyDigest.insufficientEvidenceCount, 0);
  assert.equal(healthyDigest.invalidRecordCount, 0);
  assert.equal(healthyDigest.abstentionCount, 1);
});
