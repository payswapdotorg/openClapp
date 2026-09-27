import type { SynthesisPlan } from "@clapp/contracts";
import { canonicalJson } from "./canonical.ts";
import type { ValidationResult } from "./validate.ts";
import { validateSynthesisPlan } from "./validate.ts";

export type DeserializeResult = ValidationResult & { plan?: SynthesisPlan };

/**
 * Canonical deterministic serialization: object keys sorted alphabetically at
 * every level, arrays in semantic order, byte-stable across calls. Round-trips
 * through `deserializeSynthesisPlan`.
 */
export function serializeSynthesisPlan(plan: SynthesisPlan): string {
  return canonicalJson(plan);
}

/**
 * Parse, validate and type a serialized SynthesisPlan. Invalid JSON and
 * structurally invalid plans both return `ok: false` with precise errors;
 * never throws.
 */
export function deserializeSynthesisPlan(text: string): DeserializeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, errors: [`$: invalid JSON (${message})`] };
  }
  const result = validateSynthesisPlan(parsed);
  if (!result.ok) {
    return { ok: false, errors: result.errors };
  }
  return { ok: true, errors: [], plan: parsed as SynthesisPlan };
}
