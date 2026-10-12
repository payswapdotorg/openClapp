import type {
  PackageStore,
  PackageStoreRecord,
} from "../../../../packages/clapp-intelligence/src/index.ts";
import type {
  AuthorizationRecord,
  AuthorizationStore,
} from "../../../../packages/clapp-observation/src/index.ts";
import type { Store } from "../db.ts";

/**
 * CLAPP-W3-013 — the executor chain's store adapters.
 *
 * Two small, honest adapters the real stage executors compose:
 *
 * - {@link createClappAuthorizationStore} — the FROZEN W1-008
 *   `AuthorizationStore` port (get and put, nothing else) over the substrate
 *   `Store`. Rows live under the substrate kind `clapp-authz`, one row per
 *   target, keyed by the W1-008 store key (`authorizationRecordKey(targetId)`
 *   — the targetId itself). Reads are the W1-007 cross-owner discovery idiom
 *   (a scan by key, exactly how `findSpec` discovers reconstruction specs),
 *   because the frozen port carries no owner parameter; writes attribute the
 *   row to the record's OWN `ownerId` (the SECURITY.md target owner the W1-008
 *   builder validates), so a cross-owner read can never widen scope — the
 *   authorization stage re-checks the record against the reconstruction's spec
 *   and refuses on any mismatch.
 * - {@link createInMemoryPackageStore} — the FROZEN W2-005 `PackageStore`
 *   port (synchronous get/put/list, the shape the registry itself documents as
 *   a valid store) as the process-local production binding for the promote
 *   stage's registry. Process-local by design and disclosed as such: the
 *   durable package catalog wiring belongs to the catalog-store lane (W2-013)
 *   and the tech lead's composition; this binding keeps the promotion gate
 *   real without inventing a second durable store.
 */

/** The substrate store kind the authorization records persist under. */
export const CLAPP_AUTHORIZATION_STORE_KIND = "clapp-authz";

/** One row of the `clapp-authz` store kind: the W1-008 record verbatim, keyed by target. */
interface ClappAuthorizationRow {
  /** The substrate row id — the W1-008 store key (the targetId). */
  id: string;
  /** The frozen W1-008 record, carried verbatim (its own content-addressed id included). */
  authorization: AuthorizationRecord;
}

/**
 * The W1-008 AuthorizationStore port over the substrate store. `get` scans
 * cross-owner by key (the findSpec discovery idiom — the frozen port carries
 * no owner); `put` attributes the row to the record's own ownerId.
 */
export function createClappAuthorizationStore(db: Store): AuthorizationStore {
  return {
    async get(key) {
      const rows = await db.scan<ClappAuthorizationRow>(CLAPP_AUTHORIZATION_STORE_KIND);
      const match = rows.find(({ value }) => value.id === key);
      return match ? match.value.authorization : undefined;
    },
    async put(key, record) {
      const row: ClappAuthorizationRow = { id: key, authorization: record };
      await db.put(record.ownerId, CLAPP_AUTHORIZATION_STORE_KIND, row);
    },
  };
}

/**
 * The W2-005 PackageStore port, in-memory: the synchronous get/put/list shape
 * `createPackageRegistry` documents as a valid store. Process-local — restarts
 * lose the registered candidates, and a re-run of the promote stage re-registers
 * them idempotently (content-addressed documents). Disclosed in the lane's
 * honest seam table; the durable composition is the catalog-store lane's.
 */
export function createInMemoryPackageStore(): PackageStore {
  const records = new Map<string, PackageStoreRecord>();
  return {
    get(key) {
      return records.get(`${key.id}@${key.version}`) ?? null;
    },
    put(record) {
      records.set(`${record.key.id}@${record.key.version}`, record);
    },
    list() {
      return [...records.values()];
    },
  };
}
