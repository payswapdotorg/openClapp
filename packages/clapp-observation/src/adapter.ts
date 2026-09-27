import type { EvidenceBundle, EvidenceRef, ReconstructionSpec } from "@clapp/contracts";
import { canonicalJsonBytes, sha256Hex, utf8 } from "./canonical.ts";
import {
  OBSERVATION_CHANNEL_NAMES,
  OBSERVATION_CHANNELS,
  PAGE_TEXT_LIMIT,
  sourceNoteForKind,
} from "./channels.ts";
import { ClappObservationAbortError, ClappObservationError, describeError } from "./errors.ts";
import {
  type BrowserSessionSeam,
  bindBrowserSeam,
  type PageSnapshot,
  type SeamOutcome,
  validatePageSnapshot,
  validateSessionResult,
} from "./seam.ts";

/** Version of the observation adapter recorded in every environment fingerprint. */
export const OBSERVATION_ADAPTER_VERSION = "0.1.0";
const ADAPTER_ID = "@clapp/observation";

const UNAVAILABLE_KINDS = ["dom-structure", "a11y", "network", "storage"] as const;

/**
 * Dependencies the observation adapter binds at creation time.
 *
 * `browser` is an UNTYPED handle (e.g. the OpenMuse BrowserService instance);
 * it is duck-typed against the narrow BrowserSessionSeam interface declared
 * by this package, with typed fail-closed errors naming any missing
 * capability. `ownerId` is the ownership context routed to every seam call.
 * `now` is an injectable clock: tests pin it for deterministic capture;
 * production callers omit it (Date.now).
 */
export interface ObservationDependencies {
  ownerId: string;
  browser: unknown;
  now?: () => number;
}

/**
 * The result of an explicitly partial observation: an honest bundle of only
 * the refs that completed, plus the abort state. This is the ONLY shape under
 * which a partial bundle ever escapes the adapter — callers must opt in via
 * observePartial().
 */
export interface PartialObservationResult {
  /** Bundle containing only refs completed before the run ended. */
  bundle: EvidenceBundle;
  /** True when the run ended by abort rather than completion. */
  aborted: boolean;
  /** Entrypoints whose full channel set was captured. */
  completedEntrypoints: string[];
  /** Entrypoints that were in flight or never started. */
  pendingEntrypoints: string[];
}

/** The dedicated browser observation adapter (implements the frozen ObservationProvider). */
export interface BrowserObservationAdapter {
  /** Captures every declared channel for every spec entrypoint, or throws a typed error. */
  observe(spec: ReconstructionSpec, signal?: AbortSignal): Promise<EvidenceBundle>;
  /**
   * Opt-in partial capture: like observe(), but an abort returns the honestly
   * marked partial bundle through PartialObservationResult instead of throwing.
   */
  observePartial(spec: ReconstructionSpec, signal?: AbortSignal): Promise<PartialObservationResult>;
  /**
   * Bytes this adapter captured for a ref, content-addressed by ref.sha256 in
   * the adapter's in-memory vault. Durable persistence of these bytes belongs
   * to the artifacts provider and is composed by a later TL wave; the
   * environment fingerprint records this honestly (evidenceStorage).
   */
  evidenceBytes(ref: EvidenceRef): Uint8Array;
}

interface CaptureState {
  sessionId?: string;
  sessionIds: string[];
  refs: EvidenceRef[];
  entrypointRefs: Record<string, string[]>;
}

/**
 * Creates the browser observation adapter. Bind-time validation fails closed:
 * a handle missing create/navigate/read (or exposing a malformed preview)
 * raises ClappObservationError naming the capability; an absent ownerId
 * likewise. The screenshot channel is optional at the seam level — when
 * preview is missing, the bundle marks screenshot evidence unavailable with
 * a binding-level reason instead of failing the bind.
 */
export function createBrowserObservationAdapter(
  deps: ObservationDependencies,
): BrowserObservationAdapter {
  if (typeof deps?.ownerId !== "string" || deps.ownerId.trim() === "")
    throw new ClappObservationError(
      "ownerId",
      `the observation binding requires a non-empty ownerId (the ownership context routed to every browser seam call); received ${typeof deps?.ownerId}`,
    );
  const seam: BrowserSessionSeam = bindBrowserSeam(deps.browser);
  const owner = deps.ownerId;
  const now = typeof deps.now === "function" ? deps.now : Date.now;
  const iso = () => new Date(now()).toISOString();
  const vault = new Map<string, Uint8Array>();

  /**
   * Runs one seam call with the abort signal honored before, during and after
   * the await. A seam failure (sync throw, rejection or invalid payload
   * shape) is returned as an honest not-ok outcome so the affected channels
   * degrade to "unavailable" with the precise reason; only aborts throw. The
   * abandoned promise is always handler-attached so a raced abort can never
   * surface an unhandled rejection.
   */
  async function attempt<T>(
    thunk: () => Promise<T>,
    signal: AbortSignal | undefined,
    where: string,
  ): Promise<SeamOutcome<T>> {
    const abortError = (cause?: unknown) =>
      new ClappObservationAbortError(where, `observation aborted while awaiting ${where}`, {
        cause,
      });
    if (signal?.aborted) throw abortError();
    let promise: Promise<T>;
    try {
      promise = thunk();
    } catch (error) {
      return { ok: false, reason: describeError(error) };
    }
    void promise.catch(() => {});
    if (!signal) {
      try {
        return { ok: true, value: await promise };
      } catch (error) {
        return { ok: false, reason: describeError(error) };
      }
    }
    if (signal.aborted) throw abortError();
    let onAbort: () => void = () => {};
    const abort = new Promise<never>((_, reject) => {
      onAbort = () => reject(abortError());
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const value = await Promise.race([promise, abort]);
      if (signal.aborted) throw abortError();
      return { ok: true, value };
    } catch (error) {
      if (signal.aborted)
        throw error instanceof ClappObservationAbortError ? error : abortError(error);
      return { ok: false, reason: describeError(error) };
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  /** Validates the spec and its authorization against the bound owner. */
  function validateSpec(spec: ReconstructionSpec): void {
    if (typeof spec !== "object" || spec === null)
      throw new ClappObservationError(
        "spec",
        `spec must be a ReconstructionSpec object; received ${typeof spec}`,
      );
    const requireText = (value: unknown, label: string) => {
      if (typeof value !== "string" || value.trim() === "")
        throw new ClappObservationError(
          "spec",
          `${label} must be a non-empty string; received ${typeof value}`,
        );
      return value;
    };
    requireText(spec.specVersion, "spec.specVersion");
    requireText(spec.reconstructionId, "spec.reconstructionId");
    requireText(spec.targetId, "spec.targetId");
    if (typeof spec.authorization !== "object" || spec.authorization === null)
      throw new ClappObservationError(
        "authorization",
        "spec.authorization must be a TargetAuthorization object",
      );
    const ownerId = requireText(spec.authorization.ownerId, "spec.authorization.ownerId");
    if (ownerId !== owner)
      throw new ClappObservationError(
        "authorization",
        `spec.authorization.ownerId "${ownerId}" does not match the observation binding's owner "${owner}"; refusing to observe on behalf of a different owner`,
      );
    if (spec.platform !== "web")
      throw new ClappObservationError(
        "platform",
        `the browser observation adapter only observes web targets; spec.platform is "${String(spec.platform)}"`,
      );
    if (!Array.isArray(spec.entrypoints) || spec.entrypoints.length === 0)
      throw new ClappObservationError(
        "spec",
        "spec.entrypoints must list at least one entrypoint to observe",
      );
    const seen = new Set<string>();
    for (const entrypoint of spec.entrypoints) {
      if (typeof entrypoint !== "string" || entrypoint.trim() === "")
        throw new ClappObservationError(
          "spec",
          "spec.entrypoints must contain non-empty URL strings",
        );
      if (seen.has(entrypoint))
        throw new ClappObservationError(
          "spec",
          `spec.entrypoints must not repeat an entrypoint; "${entrypoint}" appears more than once`,
        );
      seen.add(entrypoint);
    }
  }

  /** Builds a complete EvidenceRef over payload bytes and stores them content-addressed. */
  function refFor(
    spec: ReconstructionSpec,
    entrypoint: string,
    kind: string,
    payload: Uint8Array,
    classification: EvidenceRef["classification"],
    source: string,
    capturedAt: string,
  ): EvidenceRef {
    const sha256 = sha256Hex(payload);
    vault.set(sha256, payload);
    return {
      id: sha256Hex(
        canonicalJsonBytes({
          entrypoint,
          kind,
          reconstructionId: spec.reconstructionId,
          targetId: spec.targetId,
        }),
      ),
      targetId: spec.targetId,
      reconstructionId: spec.reconstructionId,
      kind,
      sha256,
      source,
      capturedAt,
      classification,
      redacted: false,
    };
  }

  /** An unavailable ref whose manifest payload records the precise reason. */
  function unavailableRef(
    spec: ReconstructionSpec,
    entrypoint: string,
    kind: string,
    reason: string,
    capturedAt: string,
  ): EvidenceRef {
    const payload = canonicalJsonBytes({ entrypoint, kind, reason });
    return refFor(
      spec,
      entrypoint,
      kind,
      payload,
      "unavailable",
      sourceNoteForKind(kind),
      capturedAt,
    );
  }

  /**
   * Captures every channel for one entrypoint against the shared session.
   * Seam failures degrade the affected channels to unavailable refs with the
   * precise reason; only aborts propagate. Ref ids are capture-position
   * addressed (entrypoint x kind x reconstruction) and therefore stable
   * under redaction.
   */
  async function captureEntrypoint(
    spec: ReconstructionSpec,
    entrypoint: string,
    signal: AbortSignal | undefined,
    state: CaptureState,
  ): Promise<void> {
    const capturedAt = iso();
    const refIds: string[] = [];
    const push = (ref: EvidenceRef) => {
      state.refs.push(ref);
      refIds.push(ref.id);
    };
    state.entrypointRefs[entrypoint] = refIds;

    // Ensure a session: create for the first entrypoint, navigate afterwards.
    let currentSession: string | undefined = state.sessionId;
    let sessionFailure: string | undefined;
    if (currentSession === undefined) {
      const outcome = await attempt(
        () => seam.create(owner, entrypoint),
        signal,
        `create:${entrypoint}`,
      );
      if (outcome.ok) {
        const session = validateSessionResult(outcome.value);
        if (session.ok) {
          currentSession = session.value;
          state.sessionId = session.value;
          state.sessionIds.push(session.value);
        } else {
          sessionFailure = session.reason;
        }
      } else {
        sessionFailure = outcome.reason;
      }
    } else {
      const outcome = await attempt(
        () => seam.navigate(owner, currentSession as string, entrypoint),
        signal,
        `navigate:${entrypoint}`,
      );
      if (outcome.ok) {
        const session = validateSessionResult(outcome.value);
        if (session.ok && session.value !== currentSession)
          sessionFailure = `the browser seam returned session "${session.value}" while navigating session "${currentSession}"`;
        else if (!session.ok) sessionFailure = session.reason;
      } else {
        sessionFailure = outcome.reason;
      }
    }
    if (sessionFailure !== undefined || currentSession === undefined) {
      const reason = `the browser seam could not establish the browser session: ${sessionFailure ?? "no session id was returned"}`;
      push(unavailableRef(spec, entrypoint, "dom-text", reason, capturedAt));
      push(unavailableRef(spec, entrypoint, "page-meta", reason, capturedAt));
      push(unavailableRef(spec, entrypoint, "screenshot", reason, capturedAt));
      for (const kind of UNAVAILABLE_KINDS)
        push(unavailableRef(spec, entrypoint, kind, sourceNoteForKind(kind), capturedAt));
      return;
    }
    const sessionId: string = currentSession;

    // Page text snapshot + metadata via read().
    const readOutcome = await attempt(
      () => seam.read(owner, sessionId),
      signal,
      `read:${entrypoint}`,
    );
    let snapshot: PageSnapshot | undefined;
    if (readOutcome.ok) {
      const page = validatePageSnapshot(readOutcome.value);
      if (page.ok) {
        snapshot = page.value;
        push(
          refFor(
            spec,
            entrypoint,
            "dom-text",
            utf8(snapshot.text),
            "observed",
            `${sourceNoteForKind("dom-text")}${snapshot.truncated ? ` (truncated at ${PAGE_TEXT_LIMIT} characters)` : ""}`,
            capturedAt,
          ),
        );
        push(
          refFor(
            spec,
            entrypoint,
            "page-meta",
            canonicalJsonBytes({ url: snapshot.url, title: snapshot.title }),
            "observed",
            sourceNoteForKind("page-meta"),
            capturedAt,
          ),
        );
      } else {
        push(unavailableRef(spec, entrypoint, "page-meta", page.reason, capturedAt));
        push(unavailableRef(spec, entrypoint, "dom-text", page.reason, capturedAt));
      }
    } else {
      push(unavailableRef(spec, entrypoint, "page-meta", readOutcome.reason, capturedAt));
      push(unavailableRef(spec, entrypoint, "dom-text", readOutcome.reason, capturedAt));
    }

    // Screenshot via the optional preview capability.
    const preview = seam.preview;
    if (typeof preview !== "function") {
      push(
        unavailableRef(
          spec,
          entrypoint,
          "screenshot",
          "the browser seam does not expose the screenshot capability (no preview method); the underlying browser worker can produce PNG screenshots but this binding cannot reach them",
          capturedAt,
        ),
      );
    } else {
      const outcome = await attempt(
        () => preview.call(seam, owner, sessionId),
        signal,
        `screenshot:${entrypoint}`,
      );
      if (outcome.ok && typeof outcome.value?.arrayBuffer === "function") {
        const bytes = await attempt(
          () => outcome.value.arrayBuffer(),
          signal,
          `screenshot:${entrypoint}`,
        );
        if (bytes.ok) {
          push(
            refFor(
              spec,
              entrypoint,
              "screenshot",
              new Uint8Array(bytes.value),
              "observed",
              sourceNoteForKind("screenshot"),
              capturedAt,
            ),
          );
        } else {
          push(
            unavailableRef(
              spec,
              entrypoint,
              "screenshot",
              `the browser seam could not read the screenshot bytes: ${bytes.reason}`,
              capturedAt,
            ),
          );
        }
      } else if (outcome.ok) {
        push(
          unavailableRef(
            spec,
            entrypoint,
            "screenshot",
            "the browser seam returned a screenshot payload without an arrayBuffer() method",
            capturedAt,
          ),
        );
      } else {
        push(
          unavailableRef(
            spec,
            entrypoint,
            "screenshot",
            `the browser seam could not capture a screenshot: ${outcome.reason}`,
            capturedAt,
          ),
        );
      }
    }

    // Channels the existing worker cannot produce: explicit unavailable refs.
    for (const kind of UNAVAILABLE_KINDS)
      push(unavailableRef(spec, entrypoint, kind, sourceNoteForKind(kind), capturedAt));
  }

  /**
   * The shared capture run. Aborts are honored at every await point; a
   * non-partial run rethrows the typed abort error, a partial run returns the
   * honestly marked PartialObservationResult. The bundle is only assembled
   * after the per-entrypoint loop resolves, so an aborted observe() never
   * presents a partial bundle as complete.
   */
  async function run(
    spec: ReconstructionSpec,
    signal: AbortSignal | undefined,
    partial: boolean,
  ): Promise<PartialObservationResult> {
    validateSpec(spec);
    if (signal?.aborted)
      throw new ClappObservationAbortError(
        "observe",
        "observation aborted before any capture started",
      );
    const state: CaptureState = { sessionIds: [], refs: [], entrypointRefs: {} };
    const completed: string[] = [];
    const pending: string[] = [];
    let abortError: ClappObservationAbortError | undefined;
    for (const entrypoint of spec.entrypoints) {
      if (abortError) {
        pending.push(entrypoint);
        continue;
      }
      try {
        await captureEntrypoint(spec, entrypoint, signal, state);
        completed.push(entrypoint);
      } catch (error) {
        if (!(error instanceof ClappObservationAbortError)) throw error;
        abortError = error;
        pending.push(entrypoint);
      }
    }
    if (abortError && !partial) throw abortError;
    const refs = state.refs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const rootSha256 = sha256Hex(canonicalJsonBytes(refs));
    const environment: Record<string, unknown> = {
      adapter: ADAPTER_ID,
      adapterVersion: OBSERVATION_ADAPTER_VERSION,
      channels: [...OBSERVATION_CHANNEL_NAMES],
      evidenceKinds: OBSERVATION_CHANNELS.map((item) => item.kind),
      channelAvailability: Object.fromEntries(
        OBSERVATION_CHANNELS.map((item) => [item.kind, item.available]),
      ),
      specVersion: spec.specVersion,
      platform: spec.platform,
      entrypoints: [...spec.entrypoints],
      entrypointRefs: state.entrypointRefs,
      sessionIds: [...state.sessionIds],
      startedAt: iso(),
      finishedAt: iso(),
      entrypointCount: spec.entrypoints.length,
      aborted: abortError !== undefined,
      persisted: false,
      evidenceStorage: "adapter-memory-vault",
    };
    if (abortError) {
      environment.completedEntrypoints = completed;
      environment.pendingEntrypoints = pending;
    }
    return {
      bundle: {
        id: `clapp-observation:${rootSha256}`,
        targetId: spec.targetId,
        reconstructionId: spec.reconstructionId,
        environment,
        refs,
        rootSha256,
      },
      aborted: abortError !== undefined,
      completedEntrypoints: completed,
      pendingEntrypoints: pending,
    };
  }

  return {
    observe(spec, signal) {
      return run(spec, signal, false).then((result) => result.bundle);
    },
    observePartial(spec, signal) {
      return run(spec, signal, true);
    },
    evidenceBytes(ref) {
      if (typeof ref !== "object" || ref === null || typeof ref.sha256 !== "string")
        throw new ClappObservationError(
          "evidence",
          "evidenceBytes requires an EvidenceRef carrying sha256",
        );
      const bytes = vault.get(ref.sha256);
      if (bytes === undefined)
        throw new ClappObservationError(
          "evidence",
          `no bytes are stored in this adapter's vault for evidence "${ref.id}" (content digest ${ref.sha256}); the vault only holds bytes this adapter captured itself`,
        );
      return bytes;
    },
  };
}
