import type { BehavioralIr } from "@clapp/contracts";
import { canonicalize, canonicalizeArray, isPlainObject } from "./json.ts";
import { validateBehavioralIr } from "./validate.ts";

/**
 * Top-level arrays whose entries are keyless maps: their order carries no
 * identity, so canonical serialization sorts them by content.
 */
const KEYLESS_ENTRY_FIELDS = new Set([
  "screens",
  "components",
  "integrations",
  "assumptions",
  "constraints",
]);

export interface DeserializedBehavioralIr {
  ok: boolean;
  errors: string[];
  ir?: BehavioralIr;
}

/**
 * Canonical deterministic serialization of a Behavioral IR:
 * - object keys are sorted alphabetically (code-unit order) at every level;
 * - journeys, their steps and evidence keep their semantic order (they are
 *   id-keyed sequences);
 * - screens/components/integrations/assumptions/constraints (keyless maps)
 *   and any all-object array inside unknown regions are sorted by their
 *   canonical content;
 * - pretty-printed with two-space indentation, no timestamps, no randomness.
 * Identical IR content always produces byte-identical output, across calls
 * and across processes.
 */
export function serializeBehavioralIr(ir: BehavioralIr): string {
  return JSON.stringify(canonicalizeIr(ir), null, 2);
}

/**
 * Parses text as JSON (rejecting invalid JSON with a precise error), then
 * validates it with the same total validator. On success returns the typed
 * IR; never throws.
 */
export function deserializeBehavioralIr(text: string): DeserializedBehavioralIr {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, errors: [`$: invalid JSON (${message})`] };
  }
  const validation = validateBehavioralIr(parsed);
  if (!validation.ok) {
    return { ok: false, errors: validation.errors };
  }
  return { ok: true, errors: [], ir: parsed as BehavioralIr };
}

function canonicalizeIr(ir: BehavioralIr): unknown {
  const record = ir as unknown as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    const value = record[key];
    if (key === "journeys" && Array.isArray(value)) {
      output[key] = value.map((entry) => canonicalizeJourneyEntry(entry));
      continue;
    }
    if (Array.isArray(value)) {
      if (key === "evidence") {
        output[key] = canonicalizeArray(value, "ordered");
      } else if (KEYLESS_ENTRY_FIELDS.has(key)) {
        output[key] = canonicalizeArray(value, "content-sorted");
      } else {
        output[key] = canonicalize(value);
      }
      continue;
    }
    output[key] = canonicalize(value);
  }
  return output;
}

/**
 * Journey entries are id-keyed objects whose "steps" array keeps its semantic
 * order; every other key (known or unknown) follows the generic canonical
 * rules for unknown regions.
 */
function canonicalizeJourneyEntry(entry: unknown): unknown {
  if (!isPlainObject(entry)) {
    return canonicalize(entry);
  }
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(entry).sort()) {
    if (key === "steps" && Array.isArray(entry.steps)) {
      output.steps = entry.steps.map((step) => canonicalize(step));
      continue;
    }
    output[key] = canonicalize(entry[key]);
  }
  return output;
}
