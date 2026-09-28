import { deepFreezeJson } from "./canonical.ts";
import { B01 } from "./fixtures/b01.ts";
import { B02 } from "./fixtures/b02.ts";
import type { BenchmarkApp } from "./types.ts";

/**
 * The canonical benchmark inventory (ACCEPTANCE.md M5/M6): at least two
 * materially different web apps — a static marketing/content site (B01) and
 * a stateful CRUD-ish operations app (B02) — that serve as the reference
 * targets for observation (W1-002), parity (W3-004), repair (W3-005) and
 * learning (Phase 6).
 *
 * The inventory is deep-frozen at module load: no consumer can mutate a
 * canonical definition in place, so every harness, workspace hosting and
 * parity run against the same immutable bytes. listBenchmarks() hands out a
 * fresh array (stable order by id) so callers cannot reorder the canonical
 * inventory itself either.
 */

const INVENTORY: readonly BenchmarkApp[] = Object.freeze(
  [B01, B02].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map(deepFreezeJson),
);

/** The frozen canonical benchmark apps, in stable id order. */
export const CANONICAL_BENCHMARKS: readonly BenchmarkApp[] = INVENTORY;

/**
 * The canonical inventory as a fresh array in stable order by id. The
 * entries themselves are the same frozen definitions — mutating a returned
 * entry throws in strict mode; mutating the array changes nothing canonical.
 */
export function listBenchmarks(): BenchmarkApp[] {
  return [...INVENTORY];
}
