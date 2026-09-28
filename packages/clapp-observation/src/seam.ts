import { ClappObservationError, describeShape } from "./errors.ts";

/**
 * The narrow structural interface the observation adapter needs from the
 * browser seam.
 *
 * The adapter never imports OpenMuse server modules. It receives an untyped
 * handle and duck-types it at bind time against this interface (the shape of
 * the OpenMuse BrowserService):
 *
 *   create(owner, url)   — establish a worker session navigated to the url
 *                          (BrowserService.create);
 *   navigate(owner, id, url) — move an existing session to the url
 *                          (BrowserService.navigate / reopen);
 *   read(owner, id)      — page text snapshot + metadata
 *                          (BrowserService.read over GET /sessions/:id/read);
 *   preview(owner, id)?  — PNG screenshot response
 *                          (BrowserService.preview over GET /sessions/:id/screenshot).
 *
 * create, navigate and read are REQUIRED: without them no observation is
 * possible, and bind fails closed with a typed error naming the missing
 * capability. preview is OPTIONAL: when absent the screenshot channel
 * degrades to an explicit "unavailable" evidence ref rather than failing the
 * binding — an honest absence, not a broken binding.
 */

/** Page snapshot returned by the seam's read capability (worker read() shape). */
export interface PageSnapshot {
  url: string;
  title: string;
  text: string;
  truncated: boolean;
}

/** Minimal response shape a screenshot capability must return. */
export interface ScreenshotResponse {
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** The browser seam, as validated by {@link bindBrowserSeam}. */
export interface BrowserSessionSeam {
  create(owner: string, url: string): Promise<{ id: string }>;
  navigate(owner: string, id: string, url: string): Promise<{ id: string }>;
  read(owner: string, id: string): Promise<PageSnapshot>;
  preview?(owner: string, id: string): Promise<ScreenshotResponse>;
}

const REQUIRED_CAPABILITIES = ["create", "navigate", "read"] as const;

/**
 * Duck-types an untyped browser handle onto {@link BrowserSessionSeam}.
 * Fails closed with a typed error naming the missing or malformed capability.
 */
export function bindBrowserSeam(browser: unknown): BrowserSessionSeam {
  if (typeof browser !== "object" || browser === null)
    throw new ClappObservationError(
      "browser-seam",
      `the browser handle must be an object providing ${REQUIRED_CAPABILITIES.join(", ")} (and optionally preview); received ${describeShape(browser)}`,
    );
  const handle = browser as Record<string, unknown>;
  for (const capability of REQUIRED_CAPABILITIES)
    if (typeof handle[capability] !== "function")
      throw new ClappObservationError(
        capability,
        `the browser handle is missing the required capability "${capability}" (create, navigate and read are required for observation; preview is optional and degrades the screenshot channel to unavailable); bind fails closed`,
      );
  if (handle.preview !== undefined && typeof handle.preview !== "function")
    throw new ClappObservationError(
      "preview",
      'the browser handle exposes "preview" but it is not a function; a malformed optional capability fails the bind',
    );
  return handle as unknown as BrowserSessionSeam;
}

/** Outcome of a seam call: a value, or an honest failure reason (never fabricated). */
export type SeamOutcome<T> = { ok: true; value: T } | { ok: false; reason: string };

/** Validates a session-establishment result ({ id: string }). */
export function validateSessionResult(value: unknown): SeamOutcome<string> {
  const id =
    typeof value === "object" && value !== null ? (value as { id?: unknown }).id : undefined;
  if (typeof id !== "string" || id === "")
    return {
      ok: false,
      reason: `the browser seam returned a session payload without a non-empty id (received ${describeShape(value)})`,
    };
  return { ok: true, value: id };
}

/** Validates a read() result against the PageSnapshot shape. */
export function validatePageSnapshot(value: unknown): SeamOutcome<PageSnapshot> {
  if (typeof value !== "object" || value === null)
    return {
      ok: false,
      reason: `the browser seam returned ${describeShape(value)} instead of a page snapshot`,
    };
  const { url, title, text, truncated } = value as Record<string, unknown>;
  if (
    typeof url !== "string" ||
    typeof title !== "string" ||
    typeof text !== "string" ||
    typeof truncated !== "boolean"
  )
    return {
      ok: false,
      reason:
        "the browser seam returned a read payload that does not match { url, title, text, truncated }",
    };
  return { ok: true, value: { url, title, text, truncated } };
}
