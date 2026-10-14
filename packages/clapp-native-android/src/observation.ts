/**
 * @clapp/native-android — the Android observation adapter (ADR-004,
 * component 2 of the frozen five-component v0.1 contract).
 *
 * This module is the platform's observation law: a structured element-tree
 * snapshot over the duck-typed host seam. The host provides the framework's
 * element tree (the uiautomator/espresso view-hierarchy dump, shape-defined
 * by AndroidElementNode below); the adapter MEASURES the tree's facts — the
 * digest, the node count, the observed depth — and never derives, upgrades,
 * or fabricates.
 *
 * THE HOST-SEAM LAW (the honest boundary, ADR-004 binding): everything
 * environment-specific enters through ONE duck-typed seam —
 * AndroidObservationHost ("an object with a callable captureScreen()"). The
 * CONTRACTS are this lane's deliverable; the tests fake the seam. Real
 * `adb shell uiautomator` / instrumentation / emulator bindings are
 * deployment scope (a later TL composition wave) — never this module.
 *
 * THE HONEST-ABSENT LAW (ADR-004 binding): `none` is a VALID descriptor —
 * the honest-absent state. Its observation component REFUSES with a typed
 * named error and NEVER calls the host (a spy host proves zero calls —
 * there is no framework bound to call). This is the failure principle of
 * docs/clapp/ARCHITECTURE.md §12: a missing observation is not permission
 * to invent a behavior.
 *
 * THE MEASUREMENT LAW: screenDigest, nodeCount, and observedDepth are
 * MEASURED from the captured tree — never asserted, never fabricated:
 *   - screenDigest = sha256Hex(canonicalJson(tree)) — the in-package
 *     content-addressing helpers (the same law the openClapp observation
 *     package's own canonical.ts follows; no sibling-package hash import —
 *     the no-fork law pins @clapp/contracts as the only consumed package);
 *   - nodeCount = the traversal count of every node, at every depth;
 *   - observedDepth = the deepest node's level (root = 1).
 *
 * THE LOUD-HOST LAW: a THROWING host propagates loudly (the caller's failure
 * is the caller's — never swallowed, never converted into a synthetic result).
 * canonicalJson's deliberate throw on non-canonicalizable payloads is
 * inherited loud behavior.
 *
 * THE NO-FORK LAW (ADR-004 binding): AndroidElementNode is a SCREEN-LEVEL
 * capture shape local to this adapter — the Behavioral IR stays authoritative;
 * this module references, never redefines, IR vocabulary.
 *
 * Discipline (binding — the ADR-004 hard rules): no wall-clock, no
 * randomness, no network, no filesystem, no global state; the module never
 * mutates its inputs; results, never exceptions (except the loud-host law
 * above, and the typed bind-time host-seam error).
 */

import { canonicalJsonBytes, sha256Hex } from "./canonical.ts";
import type { AndroidEnvironment } from "./environment.ts";
import { validateAndroidEnvironment } from "./environment.ts";
import { ClappNativeAndroidError, describeShape, isObject, preview } from "./errors.ts";

// ---- the capture shapes ------------------------------------------------------------

/**
 * One captured UI element — the Android view-hierarchy equivalence (a
 * SCREEN-LEVEL shape; the IR stays authoritative). Mirrors the fields a
 * uiautomator dump exposes: the resource id, the class name, the text, the
 * content description, and the children (any depth).
 */
export interface AndroidElementNode {
  /** The node's resource id (e.g. "com.example:id/submit" — non-empty). */
  resourceId: string;
  /** The node's class name (non-empty, e.g. "android.widget.Button"). */
  className: string;
  /** The node's text (may be an empty string). */
  text: string;
  /** The node's content description (may be an empty string). */
  contentDescription: string;
  /** The node's children (any depth). */
  children: AndroidElementNode[];
}

// ---- the host seam (the honest boundary) -------------------------------------------

/**
 * The observation host seam: everything environment-specific enters HERE
 * (duck-typed — the test fakes it; real adb/uiautomator bindings are
 * deployment scope, never this module). The host provides the framework's
 * element tree through one callable capability.
 */
export interface AndroidObservationHost {
  /** Capture the current screen's element tree. */
  captureScreen(): Promise<AndroidElementNode>;
}

/** One observation — the captured tree's MEASURED facts. */
export interface AndroidObservation {
  /** The descriptor version the observation ran under (CLAPP_NATIVE_ANDROID_ENVIRONMENT_VERSION). */
  environmentVersion: string;
  /** sha256Hex(canonicalJson(tree)) — the capture's digest (MEASURED, never asserted). */
  screenDigest: string;
  /** The node count (MEASURED, at every depth). */
  nodeCount: number;
  /** The max observed depth (MEASURED; the root is depth 1). */
  observedDepth: number;
}

/** The observation adapter's fail-closed result (the house shape). */
export type AndroidObservationResult =
  | { ok: true; observation: AndroidObservation }
  | { ok: false; errors: string[] };

// ---- the bind-time seam validation -------------------------------------------------

/**
 * Duck-types an untyped host handle onto AndroidObservationHost. Fails
 * closed with a TYPED error at BIND time (never deferred to a call): a host
 * that is not an object, or that is missing a callable captureScreen(),
 * raises ClappNativeAndroidError naming the component and the observed
 * shape. This is the ADR-004 hard rule: bind-time seam validation — a
 * malformed host fails the bind, never the call.
 */
export function bindAndroidObservationHost(host: unknown): AndroidObservationHost {
  if (!isObject(host)) {
    throw new ClappNativeAndroidError(
      "observation-host",
      `the observation host must be an object providing a callable captureScreen() method (the framework's element tree); received ${describeShape(host)}`,
    );
  }
  if (typeof host.captureScreen !== "function") {
    throw new ClappNativeAndroidError(
      "observation-host",
      `the observation host is missing the required capability "captureScreen" (the framework's element tree); bind fails closed — observed: ${preview(host.captureScreen)}`,
    );
  }
  return host as unknown as AndroidObservationHost;
}

// ---- internal helpers (module-level; NOT re-exported by src/index.ts) --------------

/**
 * Fail-closed element-tree validation, node by node: resourceId and
 * className non-empty strings; text and contentDescription strings (may be
 * empty); children an array. Every violation is collected and named with the
 * node's depth and the observed value. A non-canonicalizable tree (a class
 * instance, a cycle) throws loudly when the measurement computes its digest.
 */
function validateElementTree(node: unknown, depth: number, errors: string[]): void {
  if (!isObject(node)) {
    errors.push(`element node at depth ${depth} must be an object (observed: ${preview(node)})`);
    return;
  }
  if (typeof node.resourceId !== "string" || node.resourceId.length === 0) {
    errors.push(
      `element node at depth ${depth}: resourceId must be a non-empty string (observed: ${preview(node.resourceId)})`,
    );
  }
  if (typeof node.className !== "string" || node.className.length === 0) {
    errors.push(
      `element node at depth ${depth}: className must be a non-empty string (observed: ${preview(node.className)})`,
    );
  }
  if (typeof node.text !== "string") {
    errors.push(
      `element node at depth ${depth}: text must be a string, possibly empty (observed: ${preview(node.text)})`,
    );
  }
  if (typeof node.contentDescription !== "string") {
    errors.push(
      `element node at depth ${depth}: contentDescription must be a string, possibly empty (observed: ${preview(node.contentDescription)})`,
    );
  }
  if (!Array.isArray(node.children)) {
    errors.push(
      `element node at depth ${depth}: children must be an array (observed: ${preview(node.children)})`,
    );
    return;
  }
  for (const child of node.children) {
    validateElementTree(child, depth + 1, errors);
  }
}

/** The node count, measured by traversal (every node, every depth). */
function countElementNodes(node: AndroidElementNode): number {
  return 1 + node.children.reduce((total, child) => total + countElementNodes(child), 0);
}

/** The max observed depth, measured by traversal (the root is depth 1). */
function measureElementDepth(node: AndroidElementNode): number {
  if (node.children.length === 0) {
    return 1;
  }
  return 1 + Math.max(...node.children.map((child) => measureElementDepth(child)));
}

// ---- the observation adapter --------------------------------------------------------

/**
 * Observe one screen through the host seam — fail-closed, measured,
 * honest-absent.
 *
 * The env must pass validateAndroidEnvironment (its errors are carried,
 * named, and the host is never bound while the environment is malformed);
 * the host is then duck-typed at BIND time (a malformed host raises
 * ClappNativeAndroidError, never deferred to a call). When the env's
 * uiTestFramework is "none" — the VALID honest-absent state — the adapter
 * REFUSES with a typed named error and NEVER calls the host (no framework is
 * bound to call; a spy host proves zero calls). On success the observation
 * is MEASURED: screenDigest = sha256Hex(canonicalJson(tree)), nodeCount and
 * observedDepth counted by traversal. Results, never exceptions — a
 * THROWING host propagates loudly (never swallowed, never a synthetic
 * result).
 */
export async function observeAndroidScreen(
  host: unknown,
  env: unknown,
): Promise<AndroidObservationResult> {
  const environmentValidation = validateAndroidEnvironment(env);
  if (!environmentValidation.ok) {
    return { ok: false, errors: environmentValidation.errors };
  }

  // Bind the host at bind time — a malformed host raises here, never at a call.
  const observationHost = bindAndroidObservationHost(host);
  const environment = env as AndroidEnvironment;

  // The honest-absent refusal: a "none" framework never calls the host.
  if (environment.uiTestFramework === "none") {
    return {
      ok: false,
      errors: [
        `uiTestFramework is "none" — the honest-absent state; the Android observation adapter refuses to observe (no UI test framework is bound to call the host seam) and never calls captureScreen()`,
      ],
    };
  }

  // The capture — a THROWING host propagates loudly (never swallowed).
  const tree: unknown = await observationHost.captureScreen();

  // The tree validation — every node, every level.
  const treeErrors: string[] = [];
  validateElementTree(tree, 1, treeErrors);
  if (treeErrors.length > 0) {
    return { ok: false, errors: treeErrors };
  }

  // The measurement — MEASURED, never asserted: the digest over the canonical
  // serialization, the counts by traversal of the captured tree AS CAPTURED.
  const viewTree = tree as AndroidElementNode;
  const observation: AndroidObservation = {
    environmentVersion: environment.environmentVersion,
    screenDigest: sha256Hex(canonicalJsonBytes(viewTree)),
    nodeCount: countElementNodes(viewTree),
    observedDepth: measureElementDepth(viewTree),
  };
  return { ok: true, observation };
}
