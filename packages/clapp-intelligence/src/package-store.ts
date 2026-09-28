/**
 * Package persistence port (CLAPP-W2-005).
 *
 * The registry itself performs no I/O: persistence goes through this
 * narrow port ONLY. It has get, put and list — nothing else. No
 * filesystem, no database, no network anywhere inside @clapp/intelligence;
 * tests supply an in-memory implementation and the OpenMuse adapter
 * (a later wave) supplies the real one.
 *
 * The port is deliberately synchronous: the registry's public surface
 * (register/promote/get/list/history) is synchronous per the frozen W2-005
 * contract, so every record is materialized through these three calls.
 *
 * Semantics the registry relies on:
 * - `get` returns exactly the record stored under the key, or null;
 * - `put` stores or replaces the record under its key (one record per key:
 *   the (id, normalized version) coordinate — conflict, immutability and
 *   version-lineage rules are enforced by the registry, never by the
 *   store);
 * - `list` returns every stored record (order is the store's own; the
 *   registry re-sorts deterministically).
 */

import type { ClappPackage } from "@clapp/contracts";
import type { PackageIdentity } from "./package-identity.ts";

/** Lifecycle status of a stored (id, version) pair. */
export type PackageStatus = "candidate" | "promoted";

/**
 * Store key: the identity coordinate of a package — id plus NORMALIZED
 * version. One record exists per key for the whole registry.
 */
export interface PackageStoreKey {
  id: string;
  /** Normalized MAJOR.MINOR.PATCH version. */
  version: string;
}

/** One stored package row. */
export interface PackageStoreRecord {
  /** The key this record is stored under. */
  key: PackageStoreKey;
  /** Deterministic identity of the stored document (digest included). */
  identity: PackageIdentity;
  /** The validated, normalized package document. */
  document: ClappPackage;
  /** Candidate until promoted; promoted records are immutable. */
  status: PackageStatus;
}

/** Narrow persistence port: get, put, list — and nothing else. */
export interface PackageStore {
  /** Returns the record stored under the key, or null when absent. */
  get(key: PackageStoreKey): PackageStoreRecord | null;
  /** Stores or replaces the record under its own key. */
  put(record: PackageStoreRecord): void;
  /** Returns every stored record. */
  list(): PackageStoreRecord[];
}
