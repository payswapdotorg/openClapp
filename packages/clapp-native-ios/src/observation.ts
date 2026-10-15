import type { EvidenceRef } from "@clapp/contracts";
import { canonicalJsonBytes, sha256Hex } from "./canonical.ts";
import type { IosEnvironment } from "./environment.ts";
import { isNoneIosEnvironment } from "./environment.ts";
import { ClappNativeIosError, describeShape } from "./errors.ts";
import { iosEvidenceRef } from "./evidence.ts";

/**
 * The iOS observation adapter — the platform's observation law over a
 * duck-typed host seam (ADR-004, component 2).
 *
 * The host provides the framework's element tree through a narrow structural
 * interface (the `Observe<Ios>Screen`-style seam declared here). The adapter:
 *   - refuses a `none` framework with a typed named error and NEVER calls
 *     the host (the failure principle, ARCHITECTURE.md section 12);
 *   - takes a structured element-tree snapshot MEASURED from the host's own
 *     payload (digest derived from the canonical serialization of the host
 *     tree — the adapter never derives, upgrades, or fabricates a node);
 *   - emits `EvidenceRef`-shaped records with the `idev_` prefix over the
 *     measured payload, classified `observed` only for what the host produced.
 *
 * The adapter never imports a production host; it duck-types an untyped
 * handle at bind time against `IosObservationHostSeam` with typed fail-closed
 * errors naming any missing structural member. Composition of a production
 * host (e.g. an XCUITest runner binding) is a later TL wave; this package
 * lands the frozen per-platform seam.
 */

/**
 * The framework-native element tree the host seam returns — the XCUITest
 * element-tree shape, structurally duck-typed at bind time.
 */
export interface IosElementTreeNode {
  /** Framework-native element kind, e.g. "application", "window", "button". */
  readonly kind: string;
  /** Element identifier supplied by the framework (label / accessibility id). */
  readonly identifier?: string;
  /** Element text/value if the framework exposes one. */
  readonly value?: string;
  /** Child elements, in framework order. */
  readonly children?: readonly IosElementTreeNode[];
}

/**
 * The narrow structural interface the iOS observation adapter needs from the
 * host seam. The adapter receives an untyped handle and duck-types it against
 * this interface at bind time.
 *
 *   snapshot(application) — return the framework's element tree for the
 *                           given application target (a structured,
 *                           framework-native node tree).
 *
 * `snapshot` is REQUIRED: without it no observation is possible, and bind
 * fails closed with a typed error naming the missing structural member.
 */
export interface IosObservationHostSeam {
  /** Returns the framework element tree for an application target. */
  snapshot(application: string): Promise<IosElementTreeNode>;
}

/** The MEASURED observation snapshot — the host's own payload, digested. */
export interface IosObservationSnapshot {
  /** The application target the snapshot was taken against. */
  readonly application: string;
  /** The content digest of the canonical host payload (sha256 hex, full 64). */
  readonly digest: string;
  /** The canonical JSON serialization of the host element tree (UTF-8 bytes). */
  readonly canonical: Uint8Array;
}

/** The result of an iOS observation run: a measured snapshot and its evidence refs. */
export interface IosObservationResult {
  /** The MEASURED snapshot (digest derived from the host's own payload). */
  readonly snapshot: IosObservationSnapshot;
  /** Evidence refs over the measured payload, classified `observed`. */
  readonly refs: EvidenceRef[];
}

/** The dependencies the iOS observation adapter binds at creation time. */
export interface IosObservationDependencies {
  /** The untyped host handle (e.g. an XCUITest runner binding), duck-typed at bind time. */
  readonly host: unknown;
  /**
   * The capture timestamp injected by the caller — pin in tests, omit in
   * production (composition is a later TL wave). The adapter never reads a
   * wall-clock; this is the only time the emitter ever sees.
   */
  readonly capturedAt: string;
  /** The reconstruction the observation belongs to. */
  readonly reconstructionId: string;
  /** The target the observation belongs to. */
  readonly targetId: string;
}

const REQUIRED_CAPABILITIES = ["snapshot"] as const;

/**
 * Duck-types an untyped host handle onto {@link IosObservationHostSeam}.
 * Fails closed with a typed error at bind time (never at call time) naming
 * the missing or malformed structural member. A handle missing `snapshot`
 * (or exposing it as a non-function) cannot be bound; the adapter never
 * proceeds to a call where the failure would surface as a runtime TypeError.
 */
export function bindIosObservationSeam(host: unknown): IosObservationHostSeam {
  if (typeof host !== "object" || host === null)
    throw new ClappNativeIosError(
      "observation",
      "host-seam",
      `the iOS host seam must be an object providing ${REQUIRED_CAPABILITIES.join(", ")}; received ${describeShape(host)}`,
    );
  const handle = host as Record<string, unknown>;
  for (const capability of REQUIRED_CAPABILITIES)
    if (typeof handle[capability] !== "function")
      throw new ClappNativeIosError(
        "observation",
        "host-seam",
        `the iOS host handle is missing the required structural member "${capability}" (snapshot returns the framework element tree for an application target); bind fails closed`,
      );
  return handle as unknown as IosObservationHostSeam;
}

/** Validates a host-returned element tree against the structural node shape. */
function validateElementTree(value: unknown, path: string): IosElementTreeNode {
  if (typeof value !== "object" || value === null)
    throw new ClappNativeIosError(
      "observation",
      "element-tree",
      `the host seam returned ${describeShape(value)} at ${path} instead of an element-tree node`,
    );
  const node = value as Record<string, unknown>;
  if (typeof node.kind !== "string" || node.kind.trim() === "")
    throw new ClappNativeIosError(
      "observation",
      "element-tree",
      `the host seam returned an element-tree node at ${path} without a non-empty "kind" string`,
    );
  const children = node.children;
  if (children !== undefined) {
    if (!Array.isArray(children))
      throw new ClappNativeIosError(
        "observation",
        "element-tree",
        `the host seam returned an element-tree node at ${path} whose "children" is not an array`,
      );
    for (let index = 0; index < children.length; index++)
      children[index] = validateElementTree(children[index], `${path}.children[${index}]`);
  }
  return node as unknown as IosElementTreeNode;
}

/** The iOS observation adapter (implements the frozen per-platform seam). */
export interface IosObservationAdapter {
  /**
   * Observes an application target. A `none` framework refuses with a typed
   * named error and NEVER calls the host; a valid framework produces a MEASURED
   * snapshot and `observed` evidence refs over the host's own payload.
   */
  observe(environment: IosEnvironment, application: string): Promise<IosObservationResult>;
}

/**
 * Creates the iOS observation adapter. Bind-time validation fails closed: a
 * host handle missing `snapshot` (or exposing it as a non-function) raises
 * a typed error before any call is made; a missing capturedAt, reconstructionId
 * or targetId likewise (the emitter needs them).
 */
export function createIosObservationAdapter(
  deps: IosObservationDependencies,
): IosObservationAdapter {
  const seam = bindIosObservationSeam(deps.host);
  if (typeof deps?.capturedAt !== "string" || deps.capturedAt.trim() === "")
    throw new ClappNativeIosError(
      "observation",
      "capturedAt",
      `the observation binding requires a non-empty capturedAt timestamp (the emitter never reads a wall-clock); received ${describeShape(deps?.capturedAt)}`,
    );
  if (typeof deps?.reconstructionId !== "string" || deps.reconstructionId.trim() === "")
    throw new ClappNativeIosError(
      "observation",
      "reconstructionId",
      `the observation binding requires a non-empty reconstructionId; received ${describeShape(deps?.reconstructionId)}`,
    );
  if (typeof deps?.targetId !== "string" || deps.targetId.trim() === "")
    throw new ClappNativeIosError(
      "observation",
      "targetId",
      `the observation binding requires a non-empty targetId; received ${describeShape(deps?.targetId)}`,
    );

  return {
    async observe(environment, application) {
      if (typeof environment !== "object" || environment === null)
        throw new ClappNativeIosError(
          "observation",
          "environment",
          `the observation binding requires a validated IosEnvironment; received ${describeShape(environment)}`,
        );
      if (typeof application !== "string" || application.trim() === "")
        throw new ClappNativeIosError(
          "observation",
          "application",
          `the observation binding requires a non-empty application target (e.g. CFBundleIdentifier); received ${describeShape(application)}`,
        );

      // The honest-absent `none` framework: refuse with a typed named error,
      // and NEVER call the host. The failure principle: a missing observation
      // is not permission to invent a behavior.
      if (isNoneIosEnvironment(environment))
        throw new ClappNativeIosError(
          "observation",
          "uiTestFramework",
          `the iOS environment declares uiTestFramework "none" (the honest-absent state); the observation adapter refuses to call the host seam and never fabricates an element tree`,
        );

      // Take the host's own payload. The host seam's structural shape was
      // validated at bind time; the returned tree is structurally validated
      // again here (fail-closed: a malformed tree is a typed error, not a
      // partial snapshot).
      const raw = await seam.snapshot(application);
      const tree = validateElementTree(raw, "root");

      // MEASURE the digest from the host's own canonical payload — the
      // adapter never derives, upgrades, or fabricates a node. The canonical
      // serialization is stable: two structurally equal trees produce identical
      // bytes regardless of construction order.
      const canonical = canonicalJsonBytes(tree);
      const digest = sha256Hex(canonical);

      const snapshot: IosObservationSnapshot = Object.freeze({
        application,
        digest,
        canonical,
      });

      const ref = iosEvidenceRef(
        {
          application,
          kind: "element-tree",
          reconstructionId: deps.reconstructionId,
          targetId: deps.targetId,
        },
        canonical,
        "ios-observation:host-snapshot:element-tree",
        deps.capturedAt,
      );

      return { snapshot, refs: [ref] };
    },
  };
}
