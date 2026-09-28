import { createHash } from "node:crypto";
import type { DiffFinding } from "@clapp/contracts";
import { isPlainObject } from "./canonical.ts";
import { contentHash } from "./hash.ts";
import type {
  PairedApiCapture,
  PairedArtifact,
  PairedSideCapture,
  PairedSideLabel,
} from "./paired.ts";
import { compareSidesSemantically, sortFindings } from "./paired-compare.ts";

/**
 * The pure visual and network dimension core of the paired parity engine
 * (CLAPP-W3-005): the M4 minimum report dimensions — semantic, visual,
 * network, state/storage — completed on top of the W3-004 capture/compare
 * seam. Everything here is a pure function of its inputs: no servers, no
 * fetches, no clocks, no randomness. Findings are content-addressed (ids are
 * sha256 prefixes of the canonical finding form) and deterministically
 * ordered, so the same pair of captures always produces byte-identical
 * findings in a deterministic order.
 *
 * The VISUAL dimension is a derived visual inventory of the served page —
 * title, headings, images, links, form controls, and a normalized visible-text
 * skeleton digest — extracted from the served HTML by a tolerant, deterministic
 * scanner (no DOM engine, no browser): what a renderer would structurally show,
 * as a pure function of the body bytes. Screenshot/pixel parity is explicitly
 * future work and is never claimed here.
 *
 * The NETWORK dimension compares the deterministic protocol facts of every
 * fetched response: whether the fetch followed a redirect, and the values of a
 * frozen allowlist of protocol headers (cache-control, allow, etag, …). Clock
 * headers (date/age), body-derived headers (content-length) and hop-by-hop
 * transport noise (connection/keep-alive/transfer-encoding) are excluded BY
 * DESIGN so the report stays a pure function of served content (ACCEPTANCE.md
 * M4: "deterministic enough for regression tracking") — the excluded names are
 * transport facts, exactly like the paired runner's ports and durations.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** One heading of the derived visual inventory, in document order. */
export type PairedVisualHeading = {
  /** The heading level, 1 through 6. */
  level: number;
  /** The heading's visible text, whitespace-normalized. */
  text: string;
};

/** One image of the derived visual inventory, in document order. */
export type PairedVisualImage = {
  /** The image's src attribute (images without a src are skipped). */
  src: string;
  /** The image's alt attribute, or null when absent. */
  alt: string | null;
};

/** One hyperlink of the derived visual inventory, in document order. */
export type PairedVisualLink = {
  /** The link's href attribute (anchors without an href are skipped). */
  href: string;
  /** The link's visible text, whitespace-normalized. */
  text: string;
};

/** One form control of the derived visual inventory, in document order. */
export type PairedVisualControl = {
  /** The control's tag name: input, button, select or textarea. */
  tag: string;
  /** The control's type attribute, or null when absent. */
  type: string | null;
  /** The control's name attribute, or null when absent. */
  name: string | null;
};

/**
 * The derived visual inventory of one served page: a pure function of the
 * served body bytes. This is the evidence the visual dimension compares —
 * an honest derived channel, never a fabricated screenshot.
 */
export type PairedVisualCapture = {
  /** The page's title text, or null when the page has no title element. */
  title: string | null;
  /** Every heading (h1-h6) with non-empty visible text, in document order. */
  headings: PairedVisualHeading[];
  /** Every image with a src attribute, in document order. */
  images: PairedVisualImage[];
  /** Every link with an href attribute, in document order. */
  links: PairedVisualLink[];
  /** Every form control, in document order. */
  controls: PairedVisualControl[];
  /** sha256 of the normalized visible text (script/style content excluded). */
  skeletonDigest: string;
};

/** One allowlisted response header of the network capture. */
export type PairedNetworkHeader = {
  /** The lowercased header name (always a NETWORK_HEADER_ALLOWLIST entry). */
  name: string;
  /** The header value verbatim (repeated headers join with ", "). */
  value: string;
};

/**
 * The deterministic protocol facts of one fetched response: whether the fetch
 * followed a redirect, and the allowlisted header values. Clock headers,
 * body-derived headers and hop-by-hop transport headers are excluded by
 * design — they are transport facts, not served-content parity.
 */
export type PairedNetworkCapture = {
  /** Whether the fetch was redirected before the final response. */
  redirected: boolean;
  /** The allowlisted headers, sorted by name. */
  headers: PairedNetworkHeader[];
};

/**
 * Which optional diff dimensions a paired run captures. Both default to true
 * (the M4 four-dimension report is the product); a dimension disabled by
 * verification policy is an honest absence — no capture, no findings, no
 * artifacts for that dimension, never a fabricated equivalence claim.
 */
export type PairedDimensions = {
  visual: boolean;
  network: boolean;
};

// ---------------------------------------------------------------------------
// Determinism exclusion discipline (the network allowlist)
// ---------------------------------------------------------------------------

/**
 * The frozen network header allowlist: protocol headers that are stable across
 * identical served content. Sorted for the manifest, lowercase on the wire.
 *
 * Deliberately EXCLUDED (with reasons — these are transport facts, and the
 * M4 determinism gate keeps them out of the report):
 * - `date`, `age`, `expires`: wall-clock values;
 * - `content-type`: the semantic dimension's channel (media type findings);
 * - `content-length`: derived from the body bytes (duplicate signal);
 * - `connection`, `keep-alive`, `transfer-encoding`, `host`, `upgrade`:
 *   hop-by-hop/transport headers that vary with the HTTP stack, not the app.
 */
export const NETWORK_HEADER_ALLOWLIST: readonly string[] = Object.freeze([
  "access-control-allow-headers",
  "access-control-allow-methods",
  "access-control-allow-origin",
  "accept-ranges",
  "allow",
  "cache-control",
  "content-encoding",
  "etag",
  "location",
  "retry-after",
  "server",
  "vary",
  "www-authenticate",
  "x-content-type-options",
]);

const NETWORK_ALLOWED = new Set<string>(NETWORK_HEADER_ALLOWLIST);

// ---------------------------------------------------------------------------
// Content-addressed stamps (same discipline as paired-compare.ts)
// ---------------------------------------------------------------------------

/** Stamps a content-addressed id onto an artifact body (sha256, 16 hex). */
function withId(content: Omit<PairedArtifact, "id">): PairedArtifact {
  return { ...content, id: `pa-${contentHash(content).slice(0, 16)}` };
}

/** Stamps a content-addressed id onto a finding body (sha256, 16 hex). */
function finding(input: Omit<DiffFinding, "id">): DiffFinding {
  return { ...input, id: `df-${contentHash(input).slice(0, 16)}` };
}

// ---------------------------------------------------------------------------
// The derived visual inventory (pure, tolerant, deterministic)
// ---------------------------------------------------------------------------

/** Blocks whose content is never visible: script and style elements. */
const INVISIBLE_BLOCK_PATTERN =
  /<script\b[^>]*>[\s\S]*?<\/script\s*>|<style\b[^>]*>[\s\S]*?<\/style\s*>/gi;
/** The first title element's inner HTML. */
const TITLE_PATTERN = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i;
/** Every heading element, capturing the level and the inner HTML. */
const HEADING_PATTERN = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/g;
/** Every self-closing-ish image tag. */
const IMAGE_PATTERN = /<img\b[^>]*>/g;
/** Every anchor element, capturing the attribute span and the inner HTML. */
const LINK_PATTERN = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/g;
/** Every form control's opening tag, capturing the tag name. */
const CONTROL_PATTERN = /<(input|button|select|textarea)\b[^>]*>/g;
/** Any tag at all (used to strip markup down to visible text). */
const ANY_TAG_PATTERN = /<[^>]+>/g;

/** Collapses every whitespace run to a single space and trims the ends. */
function normalizeSpace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Decodes the minimal deterministic entity set. `&amp;` decodes LAST so a
 * literal "&amp;lt;" stays a visible "&lt;" instead of double-decoding.
 */
function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/** The visible text of a markup fragment: tags stripped, entities decoded. */
function visibleTextOf(fragment: string): string {
  return normalizeSpace(decodeEntities(fragment.replace(ANY_TAG_PATTERN, " ")));
}

/**
 * Extracts one attribute value from a tag's source, tolerantly: double-quoted,
 * single-quoted and unquoted forms, case-insensitive name, null when absent.
 */
function attributeOf(tagSource: string, name: string): string | null {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const match = pattern.exec(tagSource);
  if (match === null) return null;
  const raw = match[1] ?? match[2] ?? match[3] ?? "";
  return normalizeSpace(decodeEntities(raw));
}

/** sha256 of a text's UTF-8 bytes, hex-encoded. */
function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Extracts the derived visual inventory of one served page body: a pure,
 * deterministic, tolerant scan of the HTML — title, headings, images, links,
 * form controls, and the normalized visible-text skeleton digest. Tolerant by
 * design: malformed markup simply yields the inventory the scanner can see
 * (an honest partial view, never a thrown guess). Invisible script/style
 * content is excluded; images without a src and anchors without an href are
 * skipped (they render no visual imagery/navigation); headings with empty
 * visible text are skipped (empty headings render nothing).
 */
export function extractVisualInventory(body: string): PairedVisualCapture {
  const visibleSource = body.replace(INVISIBLE_BLOCK_PATTERN, " ");

  const titleMatch = TITLE_PATTERN.exec(visibleSource);
  const title = titleMatch === null ? null : visibleTextOf(titleMatch[1] ?? "");

  const headings: PairedVisualHeading[] = [];
  for (const match of visibleSource.matchAll(HEADING_PATTERN)) {
    const level = Number.parseInt(match[1] ?? "", 10);
    const text = visibleTextOf(match[2] ?? "");
    if (!Number.isInteger(level) || level < 1 || level > 6) continue;
    if (text.length === 0) continue;
    headings.push({ level, text });
  }

  const images: PairedVisualImage[] = [];
  for (const match of visibleSource.matchAll(IMAGE_PATTERN)) {
    const src = attributeOf(match[0], "src");
    if (src === null || src.length === 0) continue;
    images.push({ src, alt: attributeOf(match[0], "alt") });
  }

  const links: PairedVisualLink[] = [];
  for (const match of visibleSource.matchAll(LINK_PATTERN)) {
    const href = attributeOf(`<a${match[1] ?? ""}`, "href");
    if (href === null || href.length === 0) continue;
    links.push({ href, text: visibleTextOf(match[2] ?? "") });
  }

  const controls: PairedVisualControl[] = [];
  for (const match of visibleSource.matchAll(CONTROL_PATTERN)) {
    const tag = (match[1] ?? "").toLowerCase();
    if (tag.length === 0) continue;
    controls.push({
      tag,
      type: attributeOf(match[0], "type"),
      name: attributeOf(match[0], "name"),
    });
  }

  const skeleton = normalizeSpace(decodeEntities(visibleSource.replace(ANY_TAG_PATTERN, " ")));

  return { title, headings, images, links, controls, skeletonDigest: sha256Text(skeleton) };
}

// ---------------------------------------------------------------------------
// The network capture (pure over the response facts)
// ---------------------------------------------------------------------------

/**
 * Builds the deterministic network capture of one response from its header
 * facts and redirect flag. Pure: the header source is the minimal structural
 * interface every Headers implementation satisfies (a forEach over the
 * received pairs in header-list order — deterministic for identical
 * responses); only allowlisted names are kept, repeated headers join with
 * ", " in arrival order, and the result is sorted by name — so identical
 * served protocols always capture identically, regardless of wire arrival
 * order.
 */
export function networkCaptureOf(
  headers: { forEach(callback: (value: string, name: string) => void): void },
  redirected: boolean,
): PairedNetworkCapture {
  const collected: PairedNetworkHeader[] = [];
  headers.forEach((value, rawName) => {
    const name = rawName.toLowerCase();
    if (!NETWORK_ALLOWED.has(name)) return;
    const existing = collected.find((header) => header.name === name);
    if (existing === undefined) {
      collected.push({ name, value });
    } else if (existing.value === "") {
      existing.value = value;
    } else {
      existing.value = `${existing.value}, ${value}`;
    }
  });
  collected.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { redirected, headers: collected };
}

// ---------------------------------------------------------------------------
// Dimension normalization (fail-closed, pure)
// ---------------------------------------------------------------------------

/** A single dimension flag: undefined means default-on; booleans pass through. */
function dimensionFlagOf(value: unknown, field: string, errors: string[]): boolean | null {
  if (value === undefined) return null;
  if (typeof value === "boolean") return value;
  errors.push(`${field} must be a boolean when provided`);
  return null;
}

/**
 * Normalizes the optional dimensions input, fail-closed: absent means both
 * dimensions on; an object with optional boolean flags passes through; anything
 * else (non-object, non-boolean flags) is a TypeError naming every structural
 * problem — before any side starts, exactly like journey validation.
 */
export function normalizeDimensions(input: unknown): PairedDimensions {
  if (input === undefined) return { visual: true, network: true };
  if (!isPlainObject(input)) {
    throw new TypeError("dimensions must be an object when provided");
  }
  const errors: string[] = [];
  const visual = dimensionFlagOf(input.visual, "dimensions.visual", errors);
  const network = dimensionFlagOf(input.network, "dimensions.network", errors);
  if (errors.length > 0) {
    throw new TypeError(`dimensions failed structural validation: ${errors.join("; ")}`);
  }
  return { visual: visual ?? true, network: network ?? true };
}

// ---------------------------------------------------------------------------
// Evidence addressing (the new artifact kinds)
// ---------------------------------------------------------------------------

/** The visual inventory artifact of one side's page capture. */
export function visualArtifact(
  side: PairedSideLabel,
  routePath: string,
  capture: PairedVisualCapture,
): PairedArtifact {
  return withId({ side, kind: "visual", routePath, digest: contentHash(capture) });
}

/** The network capture artifact of one side's fetch (page or API check). */
export function networkArtifact(
  side: PairedSideLabel,
  routePath: string,
  capture: PairedNetworkCapture,
): PairedArtifact {
  return withId({ side, kind: "network", routePath, digest: contentHash(capture) });
}

/** Drops byte-identical (content-addressed) duplicates, keeping first order. */
function dedupeById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const unique: T[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    unique.push(item);
  }
  return unique;
}

/**
 * The visual and network artifacts of one side's journey capture, in capture
 * order: the page's visual inventory, the page's network capture, then each
 * API check's network capture. Sides whose dimensions were disabled (or whose
 * captures are unavailable) contribute nothing — an honest absence.
 * Byte-identical captures collapse: a journey that walks the same route as
 * both its page and an API check observes one protocol fact through two
 * channels, and identical content-addressed evidence is listed once.
 */
export function dimensionArtifactsOf(capture: PairedSideCapture): PairedArtifact[] {
  const artifacts: PairedArtifact[] = [];
  if (capture.page.visual !== undefined) {
    artifacts.push(visualArtifact(capture.side, capture.routePath, capture.page.visual));
  }
  if (capture.page.network !== undefined) {
    artifacts.push(networkArtifact(capture.side, capture.routePath, capture.page.network));
  }
  for (const entry of capture.api) {
    if (entry.network !== undefined) {
      artifacts.push(networkArtifact(capture.side, entry.path, entry.network));
    }
  }
  return dedupeById(artifacts);
}

// ---------------------------------------------------------------------------
// The visual dimension comparison
// ---------------------------------------------------------------------------

/** The comparison key of one heading: `h<level>:<text>`. */
function headingKeyOf(heading: PairedVisualHeading): string {
  return `h${heading.level}:${heading.text}`;
}

/** The comparison key of one form control: `<tag>:<type|->:<name|->`. */
function controlKeyOf(control: PairedVisualControl): string {
  return `${control.tag}:${control.type ?? "-"}:${control.name ?? "-"}`;
}

/**
 * The first-occurrence ordered universe of keys seen on either side (the same
 * discipline as the semantic anchor universe: presence on both sides is
 * agreement, presence on one side only is a divergence, absence on both is
 * agreement-by-absence and produces no finding).
 */
function keyUniverse(referenceKeys: string[], candidateKeys: string[]): string[] {
  const universe: string[] = [];
  const seen = new Set<string>();
  for (const key of [...referenceKeys, ...candidateKeys]) {
    if (seen.has(key)) continue;
    seen.add(key);
    universe.push(key);
  }
  return universe;
}

/**
 * Compares one reference capture against one candidate capture into the
 * VISUAL dimension findings — pure, content-addressed, deterministically
 * ordered. Both captures must carry a visual inventory (the dimension is an
 * honest absence otherwise — disabled by policy or unavailable — and returns
 * no findings rather than a fabricated equivalence).
 *
 * Findings (each citing both sides' visual artifacts):
 * - title text divergence: "minor", anchored `visual:title` — user-visible
 *   chrome, not structure;
 * - heading divergence (a `h<level>:<text>` key present on one side only):
 *   "major", anchored `visual:heading:<key>` — headings are the primary
 *   visual structure; expected/actual are the full heading inventories;
 * - image divergence (a src present on one side only): "major", anchored
 *   `visual:image:<src>`, full inventories as expected/actual;
 * - form control divergence (a `<tag>:<type>:<name>` key present on one side
 *   only): "major", anchored `visual:control:<key>`;
 * - link divergence (an href present on one side only): "minor", anchored
 *   `visual:link:<href>`;
 * - visible-text skeleton digest divergence: "info", anchored
 *   `visual:skeleton` — the honest catch-all for visible text that changed
 *   without any structured channel pinpointing it (the W3-006 repair loop's
 *   visible-text mutation signal).
 */
export function compareSidesVisually(
  referenceCapture: PairedSideCapture,
  candidateCapture: PairedSideCapture,
): DiffFinding[] {
  const referenceVisual = referenceCapture.page.visual;
  const candidateVisual = candidateCapture.page.visual;
  if (referenceVisual === undefined || candidateVisual === undefined) return [];

  const findings: DiffFinding[] = [];
  const visualEvidence = [
    visualArtifact(referenceCapture.side, referenceCapture.routePath, referenceVisual).id,
    visualArtifact(candidateCapture.side, candidateCapture.routePath, candidateVisual).id,
  ];

  if (referenceVisual.title !== candidateVisual.title) {
    findings.push(
      finding({
        dimension: "visual",
        severity: "minor",
        anchor: "visual:title",
        expected: referenceVisual.title,
        actual: candidateVisual.title,
        evidenceRefs: [...visualEvidence],
        repairability: "assisted",
      }),
    );
  }

  const referenceHeadingKeys = referenceVisual.headings.map(headingKeyOf);
  const candidateHeadingKeys = candidateVisual.headings.map(headingKeyOf);
  for (const key of keyUniverse(referenceHeadingKeys, candidateHeadingKeys)) {
    if (referenceHeadingKeys.includes(key) === candidateHeadingKeys.includes(key)) continue;
    findings.push(
      finding({
        dimension: "visual",
        severity: "major",
        anchor: `visual:heading:${key}`,
        expected: referenceVisual.headings,
        actual: candidateVisual.headings,
        evidenceRefs: [...visualEvidence],
        repairability: "assisted",
      }),
    );
  }

  const referenceImageKeys = referenceVisual.images.map((image) => image.src);
  const candidateImageKeys = candidateVisual.images.map((image) => image.src);
  for (const key of keyUniverse(referenceImageKeys, candidateImageKeys)) {
    if (referenceImageKeys.includes(key) === candidateImageKeys.includes(key)) continue;
    findings.push(
      finding({
        dimension: "visual",
        severity: "major",
        anchor: `visual:image:${key}`,
        expected: referenceVisual.images,
        actual: candidateVisual.images,
        evidenceRefs: [...visualEvidence],
        repairability: "assisted",
      }),
    );
  }

  const referenceControlKeys = referenceVisual.controls.map(controlKeyOf);
  const candidateControlKeys = candidateVisual.controls.map(controlKeyOf);
  for (const key of keyUniverse(referenceControlKeys, candidateControlKeys)) {
    if (referenceControlKeys.includes(key) === candidateControlKeys.includes(key)) continue;
    findings.push(
      finding({
        dimension: "visual",
        severity: "major",
        anchor: `visual:control:${key}`,
        expected: referenceVisual.controls,
        actual: candidateVisual.controls,
        evidenceRefs: [...visualEvidence],
        repairability: "assisted",
      }),
    );
  }

  const referenceLinkKeys = referenceVisual.links.map((link) => link.href);
  const candidateLinkKeys = candidateVisual.links.map((link) => link.href);
  for (const key of keyUniverse(referenceLinkKeys, candidateLinkKeys)) {
    if (referenceLinkKeys.includes(key) === candidateLinkKeys.includes(key)) continue;
    findings.push(
      finding({
        dimension: "visual",
        severity: "minor",
        anchor: `visual:link:${key}`,
        expected: referenceVisual.links,
        actual: candidateVisual.links,
        evidenceRefs: [...visualEvidence],
        repairability: "assisted",
      }),
    );
  }

  if (referenceVisual.skeletonDigest !== candidateVisual.skeletonDigest) {
    findings.push(
      finding({
        dimension: "visual",
        severity: "info",
        anchor: "visual:skeleton",
        expected: referenceVisual.skeletonDigest,
        actual: candidateVisual.skeletonDigest,
        evidenceRefs: [...visualEvidence],
        repairability: "manual",
      }),
    );
  }

  return sortFindings(findings);
}

// ---------------------------------------------------------------------------
// The network dimension comparison
// ---------------------------------------------------------------------------

/**
 * Compares one fetch target's network captures (page or API check) into
 * network dimension findings. Pure; honest absence when either capture lacks
 * network facts. Findings (each citing both sides' network artifacts):
 * - redirect divergence: "major", anchored `network:redirect:<path>` — a
 *   redirect the reference takes and the candidate does not (or vice versa)
 *   is behavioral, not cosmetic;
 * - allowlisted header divergence (value differs, or present on one side
 *   only): "minor", anchored `network:header:<name>`, expected/actual are the
 *   values or null for absence.
 */
function compareNetworkTarget(
  path: string,
  routePath: string,
  referenceNetwork: PairedNetworkCapture | undefined,
  candidateNetwork: PairedNetworkCapture | undefined,
  referenceSide: PairedSideLabel,
  candidateSide: PairedSideLabel,
): DiffFinding[] {
  if (referenceNetwork === undefined || candidateNetwork === undefined) return [];

  const findings: DiffFinding[] = [];
  const networkEvidence = [
    networkArtifact(referenceSide, routePath, referenceNetwork).id,
    networkArtifact(candidateSide, routePath, candidateNetwork).id,
  ];

  if (referenceNetwork.redirected !== candidateNetwork.redirected) {
    findings.push(
      finding({
        dimension: "network",
        severity: "major",
        anchor: `network:redirect:${path}`,
        expected: referenceNetwork.redirected,
        actual: candidateNetwork.redirected,
        evidenceRefs: [...networkEvidence],
        repairability: "assisted",
      }),
    );
  }

  const referenceHeaders = new Map<string, string>();
  for (const header of referenceNetwork.headers) referenceHeaders.set(header.name, header.value);
  const candidateHeaders = new Map<string, string>();
  for (const header of candidateNetwork.headers) candidateHeaders.set(header.name, header.value);

  const names = keyUniverse([...referenceHeaders.keys()], [...candidateHeaders.keys()]).sort();
  for (const name of names) {
    const inReference = referenceHeaders.has(name);
    const inCandidate = candidateHeaders.has(name);
    if (inReference && inCandidate && referenceHeaders.get(name) === candidateHeaders.get(name)) {
      continue;
    }
    findings.push(
      finding({
        dimension: "network",
        severity: "minor",
        anchor: `network:header:${name}`,
        expected: inReference ? referenceHeaders.get(name) : null,
        actual: inCandidate ? candidateHeaders.get(name) : null,
        evidenceRefs: [...networkEvidence],
        repairability: "assisted",
      }),
    );
  }

  return findings;
}

/**
 * Compares one reference capture against one candidate capture into the
 * NETWORK dimension findings — pure, content-addressed, deterministically
 * ordered. The page fetch and every API-check fetch (paired by index, exactly
 * like the semantic API comparison; an API inventory divergence is already a
 * semantic finding) each contribute their protocol facts. Sides without
 * network captures (dimension disabled) contribute nothing — honest absence.
 */
export function compareSidesNetwork(
  referenceCapture: PairedSideCapture,
  candidateCapture: PairedSideCapture,
): DiffFinding[] {
  const findings: DiffFinding[] = [
    ...compareNetworkTarget(
      referenceCapture.routePath,
      referenceCapture.routePath,
      referenceCapture.page.network,
      candidateCapture.page.network,
      referenceCapture.side,
      candidateCapture.side,
    ),
  ];

  const apiCount = Math.min(referenceCapture.api.length, candidateCapture.api.length);
  for (let index = 0; index < apiCount; index += 1) {
    const referenceApi: PairedApiCapture | undefined = referenceCapture.api[index];
    const candidateApi: PairedApiCapture | undefined = candidateCapture.api[index];
    if (referenceApi === undefined || candidateApi === undefined) continue;
    findings.push(
      ...compareNetworkTarget(
        referenceApi.path,
        referenceApi.path,
        referenceApi.network,
        candidateApi.network,
        referenceCapture.side,
        candidateCapture.side,
      ),
    );
  }

  // A journey that walks the same route as both its page and an API check
  // observes one protocol fact through two channels; identical
  // content-addressed findings collapse into one (deduplication by identity,
  // never by similarity).
  return sortFindings(dedupeById(findings));
}

// ---------------------------------------------------------------------------
// The four-dimension composite
// ---------------------------------------------------------------------------

/**
 * Compares one reference capture against one candidate capture across ALL
 * four M4 minimum report dimensions — semantic and state (W3-004's
 * {@link compareSidesSemantically}) plus visual and network (this module) —
 * into one deterministically ordered, content-addressed finding list. The
 * paired runner's comparison entry point as of CLAPP-W3-005: the DiffReport
 * remains a pure function of the served content, and every dimension that
 * lacks captures on either side is an honest absence, never a fabricated
 * equivalence.
 */
export function compareSides(
  referenceCapture: PairedSideCapture,
  candidateCapture: PairedSideCapture,
): DiffFinding[] {
  const semanticAndState = compareSidesSemantically(referenceCapture, candidateCapture);
  const visual = compareSidesVisually(referenceCapture, candidateCapture);
  const network = compareSidesNetwork(referenceCapture, candidateCapture);
  // Content-addressed identity deduplication: byte-identical findings collapse
  // (a no-op for the W3-004 channels, whose anchor-keyed findings never
  // collide; the guard keeps the composite total under any channel overlap).
  return sortFindings(dedupeById([...semanticAndState, ...visual, ...network]));
}
