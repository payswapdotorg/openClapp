import { isPlainObject } from "./canonical.ts";
import type { ValidationResult } from "./validate.ts";

const HEX_64 = /^[0-9a-f]{64}$/;
const EXTERNAL_URL_PATTERN = /https?:\/\/[^\s"'<>`\\]+/gi;

function describe(value: unknown): string {
  if (value === undefined) {
    return "got undefined";
  }
  if (value === null) {
    return "got null";
  }
  if (Array.isArray(value)) {
    return "got an array";
  }
  if (typeof value === "object") {
    return "got an object";
  }
  if (typeof value === "string") {
    const snippet = value.length > 32 ? `${value.slice(0, 32)}…` : value;
    return `got ${JSON.stringify(snippet)}`;
  }
  return `got ${typeof value} (${String(value)})`;
}

function checkNonEmptyString(value: unknown, path: string, errors: string[]): void {
  if (typeof value !== "string" || value.length === 0) {
    errors.push(`${path}: expected a non-empty string, ${describe(value)}`);
  }
}

function checkNonNegativeInteger(value: unknown, path: string, errors: string[]): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    errors.push(`${path}: expected a non-negative integer, ${describe(value)}`);
  }
}

/**
 * The deny-only honesty rule: loopback references are legitimate (the
 * generated server and tests talk to 127.0.0.1), every other http(s) URL is
 * a forbidden external reference because the candidate must build, run and
 * test with zero network access.
 *
 * The host is extracted as a prefix rather than parsed with the URL
 * constructor, because generated code legitimately contains loopback
 * references with template-interpolated ports (`http://127.0.0.1:${port}`)
 * that are not parseable URLs.
 */
function hostOf(candidate: string): string {
  const withoutScheme = candidate.replace(/^https?:\/\//, "");
  if (withoutScheme.startsWith("[")) {
    const end = withoutScheme.indexOf("]");
    return end === -1 ? withoutScheme : withoutScheme.slice(0, end + 1);
  }
  const cut = withoutScheme.search(/[:/?#]/);
  return cut === -1 ? withoutScheme : withoutScheme.slice(0, cut);
}

function isLoopbackUrl(candidate: string): boolean {
  const host = hostOf(candidate);
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "127.0.0.1" ||
    host === "[::1]" ||
    host === "::1"
  );
}

function checkFilePath(value: unknown, path: string, errors: string[]): void {
  if (typeof value !== "string" || value.length === 0) {
    errors.push(`${path}: expected a non-empty string, ${describe(value)}`);
    return;
  }
  if (value.length > 512) {
    errors.push(`${path}: must be at most 512 characters`);
    return;
  }
  if (value.includes("\0")) {
    errors.push(`${path}: must not contain null bytes`);
    return;
  }
  if (value.startsWith("/")) {
    errors.push(`${path}: must be relative to the workspace root, not absolute`);
    return;
  }
  if (value.includes("\\")) {
    errors.push(`${path}: must use forward slashes only`);
    return;
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    errors.push(`${path}: must not contain empty, dot or parent-traversal segments`);
  }
}

function checkAcceptanceJourneyTests(
  manifest: Record<string, unknown>,
  journeyTest: { content: string } | undefined,
  errors: string[],
): void {
  if (!Array.isArray(manifest.acceptanceJourneyIds) || journeyTest === undefined) {
    return;
  }
  for (const [index, id] of (manifest.acceptanceJourneyIds as unknown[]).entries()) {
    if (typeof id !== "string") {
      continue; // already reported by the manifest shape checks
    }
    const testName = `acceptance journey: ${id}`;
    if (!journeyTest.content.includes(testName)) {
      errors.push(
        `$.manifest.acceptanceJourneyIds[${index}]: journeys.test.ts has no test named ${JSON.stringify(testName)}`,
      );
    }
  }
}

function checkForbiddenExternalReferences(
  files: Record<string, unknown>[],
  errors: string[],
): void {
  for (const [index, entry] of files.entries()) {
    const content = entry.content;
    if (typeof content !== "string") {
      continue;
    }
    for (const match of content.matchAll(EXTERNAL_URL_PATTERN)) {
      const url = match[0];
      if (!isLoopbackUrl(url)) {
        errors.push(
          `$.files[${index}].content: forbidden external reference ${JSON.stringify(url)} ` +
            "(deny-only networking: only loopback URLs are allowed)",
        );
      }
    }
  }
}

/**
 * Structural validation of a generated candidate application. Never throws:
 * any non-conforming input yields `ok: false` with errors that each carry a
 * JSON path and a reason. Checks the manifest shape (including the
 * determinism rule that no `generatedAt` timestamp may exist), a non-empty
 * file set sorted and unique by path, the presence of server.ts,
 * journeys.test.ts and the always-generated index page, that every
 * acceptance journey id has a matching generated test name, and that no file
 * content carries a non-loopback http(s) URL.
 */
export function validateGeneratedApp(app: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isPlainObject(app)) {
    return { ok: false, errors: [`$: expected a GeneratedApp object, ${describe(app)}`] };
  }

  const manifest = app.manifest;
  if (!isPlainObject(manifest)) {
    errors.push(`$.manifest: expected a GeneratedAppManifest object, ${describe(manifest)}`);
  } else {
    if (manifest.appKind !== "web") {
      errors.push(`$.manifest.appKind: expected "web", ${describe(manifest.appKind)}`);
    }
    if (typeof manifest.planDigest !== "string" || !HEX_64.test(manifest.planDigest)) {
      errors.push(
        `$.manifest.planDigest: expected a 64-character sha256 hex digest, ${describe(manifest.planDigest)}`,
      );
    }
    checkNonNegativeInteger(manifest.routeCount, "$.manifest.routeCount", errors);
    checkNonNegativeInteger(manifest.componentCount, "$.manifest.componentCount", errors);
    if (!Array.isArray(manifest.acceptanceJourneyIds)) {
      errors.push(
        `$.manifest.acceptanceJourneyIds: expected an array, ${describe(manifest.acceptanceJourneyIds)}`,
      );
    } else {
      const firstSeen = new Map<string, number>();
      for (const [index, id] of manifest.acceptanceJourneyIds.entries()) {
        const idPath = `$.manifest.acceptanceJourneyIds[${index}]`;
        if (typeof id !== "string" || id.length === 0) {
          errors.push(`${idPath}: expected a non-empty string, ${describe(id)}`);
          continue;
        }
        const first = firstSeen.get(id);
        if (first === undefined) {
          firstSeen.set(id, index);
        } else {
          errors.push(`${idPath}: duplicate ${JSON.stringify(id)} (first seen at [${first}])`);
        }
      }
    }
    checkNonEmptyString(manifest.entrypoint, "$.manifest.entrypoint", errors);
    checkNonEmptyString(manifest.buildCommand, "$.manifest.buildCommand", errors);
    checkNonEmptyString(manifest.testCommand, "$.manifest.testCommand", errors);
    if (!Array.isArray(manifest.assumptions)) {
      errors.push(`$.manifest.assumptions: expected an array, ${describe(manifest.assumptions)}`);
    }
    if ("generatedAt" in manifest) {
      errors.push(
        `$.manifest.generatedAt: must never be present (deterministic generation), ${describe(manifest.generatedAt)}`,
      );
    }
  }

  const files = app.files;
  if (!Array.isArray(files) || files.length === 0) {
    errors.push(`$.files: expected a non-empty array of generated files, ${describe(files)}`);
    return { ok: false, errors };
  }

  const present = new Set<string>();
  for (const [index, entry] of files.entries()) {
    const entryPath = `$.files[${index}]`;
    if (!isPlainObject(entry)) {
      errors.push(`${entryPath}: expected an object, ${describe(entry)}`);
      continue;
    }
    checkFilePath(entry.path, `${entryPath}.path`, errors);
    if (typeof entry.content !== "string") {
      errors.push(`${entryPath}.content: expected a string, ${describe(entry.content)}`);
    }
    if (typeof entry.path === "string") {
      present.add(entry.path);
    }
  }

  for (let index = 1; index < files.length; index += 1) {
    const previous = files[index - 1];
    const current = files[index];
    if (!isPlainObject(previous) || !isPlainObject(current)) {
      continue;
    }
    const previousPath = previous.path;
    const currentPath = current.path;
    if (typeof previousPath !== "string" || typeof currentPath !== "string") {
      continue;
    }
    if (previousPath === currentPath) {
      errors.push(
        `$.files[${index}].path: duplicate path ${JSON.stringify(currentPath)} (also at $.files[${index - 1}])`,
      );
    } else if (previousPath > currentPath) {
      errors.push(
        `$.files[${index}].path: files must be sorted by path (${JSON.stringify(previousPath)} must precede ${JSON.stringify(currentPath)})`,
      );
    }
  }

  if (!present.has("server.ts")) {
    errors.push('$.files: missing required file "server.ts" (the manifest entrypoint)');
  }
  if (!present.has("journeys.test.ts")) {
    errors.push('$.files: missing required file "journeys.test.ts"');
  }
  if (!present.has("pages/index.html")) {
    errors.push(
      '$.files: missing required file "pages/index.html" (index route is always generated)',
    );
  }
  if (
    isPlainObject(manifest) &&
    typeof manifest.entrypoint === "string" &&
    manifest.entrypoint.length > 0 &&
    !present.has(manifest.entrypoint)
  ) {
    errors.push(
      `$.manifest.entrypoint: no generated file at ${JSON.stringify(manifest.entrypoint)}`,
    );
  }

  if (isPlainObject(manifest)) {
    const journeyTest = files.find(
      (entry): entry is { path: string; content: string } =>
        isPlainObject(entry) && entry.path === "journeys.test.ts",
    );
    checkAcceptanceJourneyTests(manifest, journeyTest, errors);
  }
  checkForbiddenExternalReferences(files as Record<string, unknown>[], errors);

  return { ok: errors.length === 0, errors };
}
