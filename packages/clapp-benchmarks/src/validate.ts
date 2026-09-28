import { canonicalJson, isJsonSafeValue } from "./canonical.ts";
import { ClappBenchmarkError, describeShape } from "./errors.ts";
import type { BenchmarkApp, BenchmarkFile, BenchmarkRoute } from "./types.ts";

/**
 * Fail-closed validation of an untyped benchmark definition.
 *
 * validateBenchmarkApp never throws: every problem is collected as a
 * JSON-path-addressed error string ("$.routes[1].path: ..."), so callers get
 * the complete diagnosis of a corrupted definition in one pass. An app is
 * valid only when `ok` is true and `errors` is empty.
 *
 * Beyond the per-field shape checks, the validator enforces the coherence
 * rules the hosting surfaces rely on:
 * - files are sorted by path (strict code-unit order) with unique paths;
 * - routes are sorted by path, never touch the reserved "/api/" prefix, and
 *   each maps to an existing file through the deterministic route rule;
 * - stateful apps declare a JSON-safe stateSeed that deep-equals the parsed
 *   "state.json" file (the sandbox host's seed source), and never ship a
 *   state.json as a static app;
 * - the startCommand is non-empty, within the substrate's 16 000-character
 *   command ceiling, and references no external http(s) URL.
 */

/** The substrate refuses a command string longer than 16 000 characters. */
export const BENCHMARK_COMMAND_LIMIT_CHARS = 16_000;

/** The reserved state-API path prefix; page routes must never use it. */
export const BENCHMARK_API_PREFIX = "/api/";

/** The stateful store seed file the sandbox host reads at boot. */
export const BENCHMARK_STATE_FILE = "state.json";

/** Valid benchmark ids: "clapp_benchmark_" plus lowercase alphanumerics/dashes. */
const ID_PATTERN = /^clapp_benchmark_[a-z0-9][a-z0-9-]*$/;

/** Valid route paths: "/" or "/seg" or "/seg/sub..." with seg = [a-z0-9-]+. */
const ROUTE_PATH_PATTERN = /^\/(?:[a-z0-9-]+(?:\/[a-z0-9-]+)*)?$/;

/** Valid workspace-relative file paths (bounded, no traversal, no NUL). */
function fileSegments(path: unknown, errorPath: string, errors: string[]): string[] | null {
  if (typeof path !== "string" || path.trim() === "") {
    errors.push(`${errorPath}: must be a non-empty string; received ${describeShape(path)}`);
    return null;
  }
  if (path.length > 512) {
    errors.push(`${errorPath}: must be at most 512 characters; received ${path.length}`);
    return null;
  }
  if (path.includes("\0")) {
    errors.push(`${errorPath}: must not contain null bytes`);
    return null;
  }
  if (path.startsWith("/")) {
    errors.push(`${errorPath}: must be relative to the workspace root, not absolute`);
    return null;
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    errors.push(`${errorPath}: must not contain empty, "." or ".." segments; received "${path}"`);
    return null;
  }
  return segments;
}

/**
 * The deterministic route-to-file rule the harness and the sandbox host both
 * apply: "/" maps to "index.html"; "/x" maps to "x.html"; "/a/b" maps to
 * "a/b.html". serve.js derives its routes by inverting this rule.
 */
export function routeFilePath(routePath: string): string {
  if (routePath === "/") return "index.html";
  return `${routePath.slice(1)}.html`;
}

/** Inverse of routeFilePath: the route a sibling .html file serves. */
export function fileRoutePath(filePath: string): string | null {
  if (!filePath.endsWith(".html")) return null;
  if (filePath === "index.html") return "/";
  return `/${filePath.slice(0, -5)}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates an untyped benchmark definition against the full BenchmarkApp
 * contract. Never throws; returns every JSON-path-addressed problem found.
 */
export function validateBenchmarkApp(app: unknown): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!isPlainObject(app)) {
    errors.push(`$: the benchmark app must be a plain object; received ${describeShape(app)}`);
    return { ok: false, errors };
  }

  // --- Identity fields -------------------------------------------------
  const { id, name, version, kind } = app;
  if (typeof id !== "string" || !ID_PATTERN.test(id)) {
    errors.push(
      `$.id: must be a non-empty string matching ${ID_PATTERN.toString()}; received ${JSON.stringify(id ?? null)}`,
    );
  }
  if (typeof name !== "string" || name.trim() === "") {
    errors.push(`$.name: must be a non-empty string; received ${describeShape(name)}`);
  }
  if (typeof version !== "string" || version.trim() === "") {
    errors.push(`$.version: must be a non-empty string; received ${describeShape(version)}`);
  }
  if (kind !== "static" && kind !== "stateful") {
    errors.push(`$.kind: must be "static" or "stateful"; received ${JSON.stringify(kind ?? null)}`);
  }

  // --- Files ------------------------------------------------------------
  const files: BenchmarkFile[] = [];
  if (!Array.isArray(app.files) || app.files.length === 0) {
    errors.push(`$.files: must be a non-empty array of { path, content } entries`);
  } else {
    let previousPath: string | null = null;
    for (const [index, entry] of (app.files as unknown[]).entries()) {
      const errorPath = `$.files[${index}]`;
      if (!isPlainObject(entry)) {
        errors.push(
          `${errorPath}: must be an object with "path" and "content"; received ${describeShape(entry)}`,
        );
        continue;
      }
      const segments = fileSegments(entry.path, `${errorPath}.path`, errors);
      if (segments !== null) {
        const path = segments.join("/");
        if (typeof entry.content === "string") {
          files.push({ path, content: entry.content });
        } else {
          errors.push(
            `${errorPath}.content: must be a UTF-8 text string; received ${describeShape(entry.content)}`,
          );
        }
        if (previousPath !== null && !(previousPath < path)) {
          errors.push(
            `${errorPath}.path: file paths must be sorted and unique; "${path}" must come after "${previousPath}"`,
          );
        }
        previousPath = path;
      } else {
        previousPath = null;
      }
    }
  }

  // --- Routes ------------------------------------------------------------
  const routes: BenchmarkRoute[] = [];
  if (!Array.isArray(app.routes) || app.routes.length === 0) {
    errors.push(`$.routes: must be a non-empty array of { path, anchors } entries`);
  } else {
    let previousPath: string | null = null;
    for (const [index, entry] of (app.routes as unknown[]).entries()) {
      const errorPath = `$.routes[${index}]`;
      if (!isPlainObject(entry)) {
        errors.push(
          `${errorPath}: must be an object with "path" and "anchors"; received ${describeShape(entry)}`,
        );
        continue;
      }
      const { path } = entry;
      if (typeof path !== "string" || !ROUTE_PATH_PATTERN.test(path)) {
        errors.push(
          `${errorPath}.path: must be "/" or "/segment" (lowercase, no trailing slash); received ${JSON.stringify(path ?? null)}`,
        );
      } else if (path === "/api" || path.startsWith(BENCHMARK_API_PREFIX)) {
        errors.push(
          `${errorPath}.path: the "${BENCHMARK_API_PREFIX}" prefix is reserved for the state API; received "${path}"`,
        );
      } else {
        if (previousPath !== null && !(previousPath < path)) {
          errors.push(
            `${errorPath}.path: route paths must be sorted and unique; "${path}" must come after "${previousPath}"`,
          );
        }
        previousPath = path;
        const anchors = entry.anchors;
        if (!Array.isArray(anchors) || anchors.length === 0) {
          errors.push(`${errorPath}.anchors: must be a non-empty array of non-empty strings`);
        } else {
          const seen = new Set<string>();
          for (const [anchorIndex, anchor] of (anchors as unknown[]).entries()) {
            if (typeof anchor !== "string" || anchor.trim() === "") {
              errors.push(
                `${errorPath}.anchors[${anchorIndex}]: must be a non-empty string; received ${describeShape(anchor)}`,
              );
            } else if (seen.has(anchor)) {
              errors.push(
                `${errorPath}.anchors[${anchorIndex}]: duplicate anchor "${anchor}"; anchors within one route must be unique`,
              );
            } else {
              seen.add(anchor);
            }
          }
          if (anchors.every((anchor) => typeof anchor === "string" && anchor.trim() !== "")) {
            routes.push({ path, anchors: anchors as string[] });
          }
        }
      }
    }
  }

  // --- Route/file coherence ----------------------------------------------
  if (files.length > 0 && routes.length > 0) {
    const filePaths = new Set(files.map((file) => file.path));
    for (const route of routes) {
      const expected = routeFilePath(route.path);
      if (!filePaths.has(expected)) {
        errors.push(
          `$.routes: no file maps to route "${route.path}" (expected file "${expected}")`,
        );
      }
    }
  }

  // --- State seed and state.json coherence --------------------------------
  const stateSeed = app.stateSeed;
  const stateFile = files.find((file) => file.path === BENCHMARK_STATE_FILE);
  if (kind === "stateful") {
    if (stateSeed === undefined) {
      errors.push(`$.stateSeed: stateful benchmarks require a stateSeed`);
    } else if (!isPlainObject(stateSeed)) {
      errors.push(`$.stateSeed: must be a JSON object; received ${describeShape(stateSeed)}`);
    } else {
      const unsafe = isJsonSafeValue(stateSeed, "$.stateSeed");
      if (unsafe !== null) errors.push(unsafe);
    }
    if (stateFile === undefined) {
      errors.push(
        `$.files: stateful benchmarks must include "${BENCHMARK_STATE_FILE}" (the sandbox host's seed source)`,
      );
    } else if (isPlainObject(stateSeed) && isJsonSafeValue(stateSeed, "$.stateSeed") === null) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(stateFile.content);
      } catch {
        errors.push(
          `$.files: "${BENCHMARK_STATE_FILE}" must contain valid JSON of the stateSeed; it does not parse`,
        );
      }
      if (parsed !== undefined && canonicalJson(parsed) !== canonicalJson(stateSeed)) {
        errors.push(
          `$.files: "${BENCHMARK_STATE_FILE}" must deep-equal $.stateSeed (the sandbox host seeds from the file)`,
        );
      }
    }
  } else if (kind === "static") {
    if (stateSeed !== undefined) {
      errors.push(
        `$.stateSeed: only stateful benchmarks may declare a stateSeed; received one on a static app`,
      );
    }
    if (stateFile !== undefined) {
      errors.push(`$.files: static benchmarks must not include "${BENCHMARK_STATE_FILE}"`);
    }
  }

  // --- Start command -------------------------------------------------------
  const { startCommand } = app;
  if (typeof startCommand !== "string" || startCommand.trim() === "") {
    errors.push(
      `$.startCommand: must be a non-empty string; received ${describeShape(startCommand)}`,
    );
  } else if (startCommand.length > BENCHMARK_COMMAND_LIMIT_CHARS) {
    errors.push(
      `$.startCommand: must be at most ${BENCHMARK_COMMAND_LIMIT_CHARS} characters; received ${startCommand.length}`,
    );
  } else if (/https?:\/\//i.test(startCommand)) {
    errors.push(
      `$.startCommand: must not reference an external http(s) URL (deny-only execution honesty); received "${startCommand}"`,
    );
  }

  // --- Assumptions ------------------------------------------------------------
  const { assumptions } = app;
  if (!Array.isArray(assumptions)) {
    errors.push(
      `$.assumptions: must be an array of strings; received ${describeShape(assumptions)}`,
    );
  } else {
    for (const [index, entry] of (assumptions as unknown[]).entries()) {
      if (typeof entry !== "string" || entry.trim() === "") {
        errors.push(
          `$.assumptions[${index}]: must be a non-empty string; received ${describeShape(entry)}`,
        );
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

/** Validates an already-typed app and throws a typed error when it is invalid. */
export function assertValidBenchmarkApp(app: BenchmarkApp): void {
  const check = validateBenchmarkApp(app);
  if (!check.ok) {
    throw new ClappBenchmarkError(
      "validate",
      `benchmark app failed validation with ${check.errors.length} error(s): ${check.errors.join("; ")}`,
    );
  }
}
