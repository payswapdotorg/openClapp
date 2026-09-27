import type { BehavioralIr } from "@clapp/contracts";
import {
  arrayEntriesAreKeylessMaps,
  canonicalJson,
  compareStrings,
  describeType,
  isPlainObject,
  joinKey,
  sha256Hex,
  snippet,
} from "./json.ts";

export interface IrDiffFinding {
  /** JSON path of the offending value, e.g. "journeys[login].steps[s1].action". */
  path: string;
  kind: "added" | "removed" | "changed";
  detail: string;
}

interface IndexedEntry {
  entry: Record<string, unknown>;
  index: number;
}

const KEYLESS_ENTRY_FIELDS = [
  "screens",
  "components",
  "integrations",
  "assumptions",
  "constraints",
] as const;
const RECORD_FIELDS = ["state", "data", "api"] as const;
const TOP_LEVEL_KNOWN_FIELDS = new Set([
  "schemaVersion",
  "application",
  "evidence",
  "journeys",
  ...KEYLESS_ENTRY_FIELDS,
  ...RECORD_FIELDS,
]);

/**
 * Deterministic, pure structural diff between two IRs of the same
 * application. Journeys, steps and evidence refs are compared by id;
 * screens/components/integrations/assumptions/constraints and keyless-map
 * arrays in unknown regions are compared by content-defined identity
 * (sha256 of the canonical form, multiset semantics); state/data/api,
 * application and unknown fields are compared deeply and path-addressed.
 * Findings are sorted by path, then kind, then detail. diff(a, a) is always
 * exactly []. Never throws and never mutates its inputs.
 */
export function diffBehavioralIr(a: BehavioralIr, b: BehavioralIr): IrDiffFinding[] {
  if (!isPlainObject(a) || !isPlainObject(b)) {
    return [{ path: "$", kind: "changed", detail: "changed: expected two Behavioral IR objects" }];
  }
  const findings: IrDiffFinding[] = [];
  diffTopLevel(a, b, findings);
  return findings.sort((left, right) => {
    if (left.path !== right.path) {
      return compareStrings(left.path, right.path);
    }
    if (left.kind !== right.kind) {
      return compareStrings(left.kind, right.kind);
    }
    return compareStrings(left.detail, right.detail);
  });
}

function diffTopLevel(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  findings: IrDiffFinding[],
): void {
  diffValue(a.schemaVersion, b.schemaVersion, "schemaVersion", findings);
  diffByKeys(a.application, b.application, "application", findings);
  diffEvidence(a.evidence, b.evidence, findings);
  diffJourneys(a.journeys, b.journeys, findings);
  for (const field of KEYLESS_ENTRY_FIELDS) {
    diffValue(a[field], b[field], field, findings);
  }
  for (const field of RECORD_FIELDS) {
    diffValue(a[field], b[field], field, findings);
  }
  for (const key of sortedUnion(Object.keys(a), Object.keys(b))) {
    if (TOP_LEVEL_KNOWN_FIELDS.has(key)) {
      continue;
    }
    diffValue(a[key], b[key], key, findings);
  }
}

/** Deep, path-addressed comparison of two values under canonical semantics. */
function diffValue(left: unknown, right: unknown, path: string, findings: IrDiffFinding[]): void {
  const leftCanonical = canonicalJson(left);
  const rightCanonical = canonicalJson(right);
  if (leftCanonical !== undefined && leftCanonical === rightCanonical) {
    return;
  }
  if (leftCanonical === undefined || rightCanonical === undefined) {
    findings.push({
      path,
      kind: "changed",
      detail: `changed: <${describeType(left)}> -> <${describeType(right)}>`,
    });
    return;
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    diffByKeys(left, right, path, findings);
    return;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    if (arrayEntriesAreKeylessMaps(left) && arrayEntriesAreKeylessMaps(right)) {
      diffKeylessArrays(left, right, path, findings);
    } else {
      diffOrderedArrays(left, right, path, findings);
    }
    return;
  }
  findings.push({
    path,
    kind: "changed",
    detail: `changed: ${snippet(leftCanonical)} -> ${snippet(rightCanonical)}`,
  });
}

/** Compares two plain objects key by key (sorted union, presence-aware). */
function diffByKeys(
  left: unknown,
  right: unknown,
  path: string,
  findings: IrDiffFinding[],
  skipKeys?: readonly string[],
): void {
  if (!isPlainObject(left) || !isPlainObject(right)) {
    diffValue(left, right, path, findings);
    return;
  }
  const skip = new Set(skipKeys);
  for (const key of sortedUnion(Object.keys(left), Object.keys(right))) {
    if (skip.has(key)) {
      continue;
    }
    const childPath = joinKey(path, key);
    if (!(key in left)) {
      findings.push({
        path: childPath,
        kind: "added",
        detail: `added: ${valueSnippet(right[key])}`,
      });
    } else if (!(key in right)) {
      findings.push({
        path: childPath,
        kind: "removed",
        detail: `removed: ${valueSnippet(left[key])}`,
      });
    } else {
      diffValue(left[key], right[key], childPath, findings);
    }
  }
}

/** Index-based comparison for arrays whose order is semantic. */
function diffOrderedArrays(
  left: unknown[],
  right: unknown[],
  path: string,
  findings: IrDiffFinding[],
): void {
  const maxLength = Math.max(left.length, right.length);
  for (let index = 0; index < maxLength; index += 1) {
    const childPath = `${path}[${index}]`;
    if (index >= left.length) {
      findings.push({
        path: childPath,
        kind: "added",
        detail: `added: ${valueSnippet(right[index])}`,
      });
    } else if (index >= right.length) {
      findings.push({
        path: childPath,
        kind: "removed",
        detail: `removed: ${valueSnippet(left[index])}`,
      });
    } else {
      diffValue(left[index], right[index], childPath, findings);
    }
  }
}

/**
 * Multiset comparison for arrays of keyless maps: entries are identified by
 * the sha256 of their canonical form, so pure reordering produces no
 * findings.
 */
function diffKeylessArrays(
  left: unknown[],
  right: unknown[],
  path: string,
  findings: IrDiffFinding[],
): void {
  const leftCounts = countCanonicalForms(left);
  const rightCounts = countCanonicalForms(right);
  const keys = sortedUnion([...leftCounts.keys()], [...rightCounts.keys()]);
  for (const key of keys) {
    const leftCount = leftCounts.get(key) ?? 0;
    const rightCount = rightCounts.get(key) ?? 0;
    const delta = rightCount - leftCount;
    if (delta === 0) {
      continue;
    }
    const kind = delta > 0 ? "added" : "removed";
    const countLabel = Math.abs(delta) > 1 ? ` x${Math.abs(delta)}` : "";
    findings.push({
      path: `${path}[sha256:${sha256Hex(key)}]`,
      kind,
      detail: `${kind}${countLabel}: ${snippet(key)}`,
    });
  }
}

function countCanonicalForms(entries: readonly unknown[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const key = canonicalJson(entry) ?? `<${describeType(entry)}>`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** Evidence refs are compared by id; field changes are path-addressed. */
function diffEvidence(left: unknown, right: unknown, findings: IrDiffFinding[]): void {
  if (!Array.isArray(left) || !Array.isArray(right)) {
    diffValue(left, right, "evidence", findings);
    return;
  }
  const leftById = indexById(left);
  const rightById = indexById(right);
  for (const id of sortedMapKeys(leftById)) {
    if (!rightById.has(id)) {
      const entry = leftById.get(id);
      findings.push({
        path: `evidence[${id}]`,
        kind: "removed",
        detail: `evidence ref removed (kind: ${valueSnippet(entry?.entry.kind)})`,
      });
    }
  }
  for (const id of sortedMapKeys(rightById)) {
    if (!leftById.has(id)) {
      const entry = rightById.get(id);
      findings.push({
        path: `evidence[${id}]`,
        kind: "added",
        detail: `evidence ref added (kind: ${valueSnippet(entry?.entry.kind)})`,
      });
    }
  }
  for (const id of sortedMapKeys(leftById)) {
    const leftEntry = leftById.get(id);
    const rightEntry = rightById.get(id);
    if (leftEntry === undefined || rightEntry === undefined) {
      continue;
    }
    diffByKeys(leftEntry.entry, rightEntry.entry, `evidence[${id}]`, findings);
  }
}

/** Journeys are compared by id, with step-level (by step id) detail. */
function diffJourneys(left: unknown, right: unknown, findings: IrDiffFinding[]): void {
  if (!Array.isArray(left) || !Array.isArray(right)) {
    diffValue(left, right, "journeys", findings);
    return;
  }
  const leftById = indexById(left);
  const rightById = indexById(right);
  for (const id of sortedMapKeys(leftById)) {
    if (!rightById.has(id)) {
      const entry = leftById.get(id);
      findings.push({
        path: `journeys[${id}]`,
        kind: "removed",
        detail: `journey removed (name: ${valueSnippet(entry?.entry.name)})`,
      });
    }
  }
  for (const id of sortedMapKeys(rightById)) {
    if (!leftById.has(id)) {
      const entry = rightById.get(id);
      findings.push({
        path: `journeys[${id}]`,
        kind: "added",
        detail: `journey added (name: ${valueSnippet(entry?.entry.name)})`,
      });
    }
  }
  for (const id of sortedMapKeys(leftById)) {
    const leftJourney = leftById.get(id);
    const rightJourney = rightById.get(id);
    if (leftJourney === undefined || rightJourney === undefined) {
      continue;
    }
    const basePath = `journeys[${id}]`;
    diffByKeys(leftJourney.entry, rightJourney.entry, basePath, findings, ["steps"]);
    diffSteps(leftJourney.entry.steps, rightJourney.entry.steps, basePath, findings);
  }
}

/** Steps are compared by id within their journey; pure moves are reported. */
function diffSteps(
  left: unknown,
  right: unknown,
  journeyPath: string,
  findings: IrDiffFinding[],
): void {
  if (!Array.isArray(left) || !Array.isArray(right)) {
    diffValue(left, right, `${journeyPath}.steps`, findings);
    return;
  }
  const leftById = indexById(left);
  const rightById = indexById(right);
  for (const id of sortedMapKeys(leftById)) {
    if (!rightById.has(id)) {
      const entry = leftById.get(id);
      findings.push({
        path: `${journeyPath}.steps[${id}]`,
        kind: "removed",
        detail: `step removed (action: ${valueSnippet(entry?.entry.action)})`,
      });
    }
  }
  for (const id of sortedMapKeys(rightById)) {
    if (!leftById.has(id)) {
      const entry = rightById.get(id);
      findings.push({
        path: `${journeyPath}.steps[${id}]`,
        kind: "added",
        detail: `step added (action: ${valueSnippet(entry?.entry.action)})`,
      });
    }
  }
  for (const id of sortedMapKeys(leftById)) {
    const leftStep = leftById.get(id);
    const rightStep = rightById.get(id);
    if (leftStep === undefined || rightStep === undefined) {
      continue;
    }
    const stepPath = `${journeyPath}.steps[${id}]`;
    diffByKeys(leftStep.entry, rightStep.entry, stepPath, findings);
    if (leftStep.index !== rightStep.index) {
      findings.push({
        path: stepPath,
        kind: "changed",
        detail: `step moved from index ${leftStep.index} to ${rightStep.index}`,
      });
    }
  }
}

/** First-occurrence index of each id-keyed entry; id-less entries are skipped. */
function indexById(entries: readonly unknown[]): Map<string, IndexedEntry> {
  const byId = new Map<string, IndexedEntry>();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!isPlainObject(entry)) {
      continue;
    }
    const id = entry.id;
    if (typeof id !== "string" || id.length === 0 || byId.has(id)) {
      continue;
    }
    byId.set(id, { entry, index });
  }
  return byId;
}

function valueSnippet(value: unknown): string {
  const canonical = canonicalJson(value);
  return canonical === undefined ? `<${describeType(value)}>` : snippet(canonical);
}

function sortedUnion(left: readonly string[], right: readonly string[]): string[] {
  return [...new Set([...left, ...right])].sort(compareStrings);
}

function sortedMapKeys(map: ReadonlyMap<string, IndexedEntry>): string[] {
  return [...map.keys()].sort(compareStrings);
}
