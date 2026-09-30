import { canonicalJson } from "./canonical.ts";
import type { PlanComponent, PlanKeyedEntry } from "./plan.ts";

/**
 * Deterministic file emitters for the generated web candidate application.
 *
 * Every emitter is a pure function of its inputs: no timestamps, no random
 * ids, no environment reads. Plan-derived data is embedded through canonical
 * JSON so deep-equal inputs always produce byte-identical files, which is
 * what the determinism gate (ARCHITECTURE.md section 7) and later package
 * extraction (LEARNING.md) rely on.
 *
 * Two emitter conventions keep this module biome-clean while emitting code:
 * - generated code never uses template literals (it concatenates strings),
 *   so no emitter string literal ever carries a `${` sequence;
 * - emitter-side interpolation always goes through template literals, so
 *   arbitrary plan data (names, ids, JSON) can never break the emitted source.
 */

/**
 * One route entry of the generated routes.json inventory: the URL path, the
 * page file that serves it, and the journey anchors parity tooling relies on.
 */
export type WebRouteEntry = {
  journeyId: string;
  name: string;
  steps: number;
  path: string;
  page: string;
};

/** One acceptance journey the generated suite replays end-to-end. */
export type WebAcceptanceJourney = {
  journeyId: string;
  name: string;
  steps: number;
  path: string;
};

/** Embeds a value as a JSON.parse-able string literal in generated code. */
function jsonLiteral(value: unknown): string {
  return JSON.stringify(canonicalJson(value));
}

/** HTML text and attribute escaping for the generated pages. */
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** A double-quoted generated-code literal for an HTML attribute pair. */
function htmlAttributeLiteral(attribute: string, value: string): string {
  return JSON.stringify(`${attribute}="${escapeHtml(value)}"`);
}

/**
 * The candidate package manifest: no dependencies, ESM, and the two commands
 * the W1-003 seam composes as bounded runs (`node --check server.ts` parses
 * the server; `npx tsx --test journeys.test.ts` runs the generated suite —
 * tsx resolves transitively through the repository root, never the network).
 */
export function emitPackageJson(buildCommand: string, testCommand: string): string {
  return `${canonicalJson({
    name: "clapp-candidate",
    private: true,
    type: "module",
    scripts: { build: buildCommand, test: testCommand },
  })}\n`;
}

/**
 * The generated server: a fixed, plan-independent node:http module. All
 * plan-specific data lives in the sibling JSON/HTML files it reads once per
 * start(), so this source is byte-identical for every generated application
 * (the reusable "web server" package shape package extraction will mine).
 *
 * The module is deliberately pure-JavaScript syntax so `node --check` can
 * parse it without type stripping, imports only node builtins, binds
 * loopback only, and exports `start(port)` for in-process tests.
 */
export function emitServerSource(): string {
  const lines = [
    "// CLAPP generated candidate web server (appKind: web).",
    "//",
    "// A zero-dependency node:http server for the generated candidate application:",
    "// it serves the generated HTML pages (routed through routes.json) and the JSON",
    "// API store (GET/PUT /api/<key>) seeded from persistence.json and api.json. All",
    "// data is read once per start() from this module's sibling files, so the server",
    "// itself is plan-independent boilerplate.",
    "//",
    "// Networking is loopback-only by construction: the listener binds 127.0.0.1 and",
    "// nothing else is ever contacted. The port comes from CLAPP_CANDIDATE_PORT or",
    "// the fixed default; SIGTERM (and SIGINT) trigger a graceful shutdown when this",
    "// module runs as the main entry.",
    'import { readFile, readdir } from "node:fs/promises";',
    'import { createServer } from "node:http";',
    'import { dirname, join, resolve } from "node:path";',
    'import { fileURLToPath, pathToFileURL } from "node:url";',
    "",
    "const DEFAULT_PORT = 8787;",
    "const ROOT = dirname(fileURLToPath(import.meta.url));",
    "",
    "function canonicalStringify(value) {",
    "  if (Array.isArray(value)) {",
    '    return "[" + value.map(canonicalStringify).join(",") + "]";',
    "  }",
    '  if (value !== null && typeof value === "object") {',
    "    const body = Object.keys(value)",
    "      .sort()",
    "      .filter((key) => value[key] !== undefined)",
    '      .map((key) => JSON.stringify(key) + ":" + canonicalStringify(value[key]))',
    '      .join(",");',
    '    return "{" + body + "}";',
    "  }",
    '  return JSON.stringify(value) ?? "null";',
    "}",
    "",
    "async function readJsonFile(name) {",
    '  return JSON.parse(await readFile(join(ROOT, name), "utf8"));',
    "}",
    "",
    "async function loadPages() {",
    '  const directory = join(ROOT, "pages");',
    '  const names = (await readdir(directory)).filter((name) => name.endsWith(".html")).sort();',
    "  const pages = new Map();",
    "  for (const name of names) {",
    '    pages.set("pages/" + name, await readFile(join(directory, name), "utf8"));',
    "  }",
    "  return pages;",
    "}",
    "",
    "async function loadApp() {",
    '  const routes = await readJsonFile("routes.json");',
    '  const persistence = await readJsonFile("persistence.json");',
    '  const apiEntries = await readJsonFile("api.json");',
    "  const pages = await loadPages();",
    "  const store = { ...persistence };",
    "  for (const entry of apiEntries) {",
    "    if (!(entry.key in store)) {",
    "      store[entry.key] = entry.value;",
    "    }",
    "  }",
    "  return {",
    "    pageRoutes: new Map(routes.map((route) => [route.path, route])),",
    "    apiKeys: new Set(Object.keys(store)),",
    "    pages,",
    "    store,",
    "  };",
    "}",
    "",
    "function sendJson(response, status, value) {",
    '  const body = canonicalStringify(value) + "\\n";',
    "  response.writeHead(status, {",
    '    "content-type": "application/json; charset=utf-8",',
    '    "content-length": Buffer.byteLength(body),',
    "  });",
    "  response.end(body);",
    "}",
    "",
    "function sendHtml(response, status, html) {",
    "  response.writeHead(status, {",
    '    "content-type": "text/html; charset=utf-8",',
    '    "content-length": Buffer.byteLength(html),',
    "  });",
    "  response.end(html);",
    "}",
    "",
    "function readBody(request) {",
    "  return new Promise((resolveBody, rejectBody) => {",
    '    let text = "";',
    '    request.setEncoding("utf8");',
    '    request.on("data", (chunk) => {',
    "      text += chunk;",
    "    });",
    '    request.on("end", () => resolveBody(text));',
    '    request.on("error", rejectBody);',
    "  });",
    "}",
    "",
    "function decodeKey(value) {",
    "  try {",
    "    const decoded = decodeURIComponent(value);",
    "    return decoded.length === 0 ? null : decoded;",
    "  } catch {",
    "    return null;",
    "  }",
    "}",
    "",
    "async function handle(request, response, app) {",
    '  const method = request.method ?? "GET";',
    '  const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;',
    '  if (path.startsWith("/api/")) {',
    '    const key = decodeKey(path.slice("/api/".length));',
    "    if (key === null || !app.apiKeys.has(key)) {",
    '      return sendJson(response, 404, { error: "not_found" });',
    "    }",
    '    if (method === "GET" || method === "HEAD") {',
    "      return sendJson(response, 200, app.store[key]);",
    "    }",
    '    if (method === "PUT") {',
    "      let parsed;",
    "      try {",
    "        parsed = JSON.parse(await readBody(request));",
    "      } catch {",
    '        return sendJson(response, 400, { error: "invalid_json_body" });',
    "      }",
    "      app.store[key] = parsed;",
    "      return sendJson(response, 200, { key, updated: true });",
    "    }",
    '    return sendJson(response, 405, { error: "method_not_allowed" });',
    "  }",
    "  const route = app.pageRoutes.get(path);",
    '  if (route !== undefined && (method === "GET" || method === "HEAD")) {',
    "    const html = app.pages.get(route.page);",
    "    if (html !== undefined) {",
    "      return sendHtml(response, 200, html);",
    "    }",
    "  }",
    '  return sendJson(response, 404, { error: "not_found" });',
    "}",
    "",
    "/**",
    " * Starts the candidate server on loopback and resolves once it listens.",
    " * `port` 0 binds an ephemeral port for tests. The returned handle exposes",
    " * the bound port and a close() that stops accepting connections.",
    " */",
    "export async function start(port = DEFAULT_PORT) {",
    "  const app = await loadApp();",
    "  const server = createServer((request, response) => {",
    "    handle(request, response, app).catch(() => {",
    "      if (!response.headersSent) {",
    '        response.writeHead(500, { "content-type": "application/json; charset=utf-8" });',
    "      }",
    '      response.end(JSON.stringify({ error: "internal_error" }) + "\\n");',
    "    });",
    "  });",
    "  await new Promise((resolveListen, rejectListen) => {",
    '    server.once("error", rejectListen);',
    '    server.listen(port, "127.0.0.1", () => resolveListen());',
    "  });",
    "  const address = server.address();",
    "  return {",
    '    port: typeof address === "object" && address !== null ? address.port : port,',
    "    close: () =>",
    "      new Promise((resolveClose, rejectClose) => {",
    "        server.closeIdleConnections();",
    "        server.close((error) => {",
    "          if (error) {",
    "            rejectClose(error);",
    "          } else {",
    "            resolveClose();",
    "          }",
    "        });",
    "      }),",
    "  };",
    "}",
    "",
    "const isMain =",
    "  process.argv[1] !== undefined &&",
    "  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;",
    "",
    "if (isMain) {",
    "  void (async () => {",
    '    const requested = Number.parseInt(process.env.CLAPP_CANDIDATE_PORT ?? "", 10);',
    "    const server = await start(Number.isNaN(requested) ? DEFAULT_PORT : requested);",
    '    process.stdout.write("clapp-candidate listening on http://127.0.0.1:" + server.port + "\\n");',
    "    const shutdown = () => {",
    "      server",
    "        .close()",
    "        .catch(() => {})",
    "        .finally(() => process.exit(0));",
    "    };",
    '    process.once("SIGTERM", shutdown);',
    '    process.once("SIGINT", shutdown);',
    "  })();",
    "}",
    "",
  ];
  return lines.join("\n");
}

/** The route inventory the server resolves URL paths through. */
export function emitRoutesJson(routes: WebRouteEntry[]): string {
  return `${canonicalJson(routes)}\n`;
}

/** The initial state object, carried verbatim from plan.state. */
export function emitStateJson(state: Record<string, unknown>): string {
  return `${canonicalJson(state)}\n`;
}

/** The persistence map that seeds the server's in-memory API store. */
export function emitPersistenceJson(entries: PlanKeyedEntry[]): string {
  const store: Record<string, unknown> = {};
  for (const entry of entries) {
    store[entry.key] = entry.value;
  }
  return `${canonicalJson(store)}\n`;
}

/** The API endpoint inventory, carried verbatim from plan.api. */
export function emitApiJson(entries: PlanKeyedEntry[]): string {
  return `${canonicalJson(entries)}\n`;
}

/** One component descriptor: componentId + definition, canonically. */
export function emitComponentJson(component: PlanComponent): string {
  return `${canonicalJson({
    componentId: component.componentId,
    definition: component.definition,
  })}\n`;
}

/** The always-generated index page (route "/") with the journey navigation. */
export function emitIndexPage(journeys: { path: string; name: string }[]): string {
  const lines = [
    "<!doctype html>",
    '<html lang="en">',
    "  <head>",
    '    <meta charset="utf-8" />',
    "    <title>Index</title>",
    "  </head>",
    '  <body data-journey="index">',
    "    <main>",
    "      <h1>Index</h1>",
  ];
  if (journeys.length === 0) {
    lines.push("      <p>No journeys declared.</p>");
  } else {
    lines.push('      <nav aria-label="Journeys">', "        <ul>");
    for (const journey of journeys) {
      lines.push(`          <li><a href="${journey.path}">${escapeHtml(journey.name)}</a></li>`);
    }
    lines.push("        </ul>", "      </nav>");
  }
  lines.push("    </main>", "  </body>", "</html>", "");
  return lines.join("\n");
}

/** One minimal semantic HTML page per route, carrying the journey anchors. */
export function emitJourneyPage(route: WebRouteEntry): string {
  const escapedName = escapeHtml(route.name);
  const lines = [
    "<!doctype html>",
    '<html lang="en">',
    "  <head>",
    '    <meta charset="utf-8" />',
    `    <title>${escapedName}</title>`,
    "  </head>",
    `  <body data-journey="${escapeHtml(route.journeyId)}">`,
    "    <main>",
    `      <h1>${escapedName}</h1>`,
    `      <p data-step-count="${route.steps}">Steps: ${route.steps}</p>`,
    "    </main>",
    "  </body>",
    "</html>",
    "",
  ];
  return lines.join("\n");
}

/**
 * The generated acceptance suite: one node:test test per acceptance journey
 * plus the index-route test, all executed against the generated server in
 * process over loopback. Expected page anchors and API seeds are embedded at
 * generation time, so the suite both replays and pins the plan.
 *
 * CLAPP-W3-003 deepening: every plan route the acceptance selection does not
 * pin also gains an additive `route coverage: <journeyId>` test asserting the
 * same derivable anchors (200, text/html, data-journey, the route name and
 * data-step-count), so full-route coverage is pinned while the acceptance
 * test names and bodies stay byte-identical to the W3-002 contract. Route
 * coverage anchors are keyed by route path (unique per route), so duplicate
 * journeyIds can never collapse two routes' anchors. Step counts are the
 * plan routes' observed counts; the suite never invents step actions.
 */
export function emitJourneysTest(input: {
  acceptance: WebAcceptanceJourney[];
  routes: WebRouteEntry[];
  apiKeys: string[];
  expectedApi: Record<string, unknown>;
}): string {
  const routePaths: Record<string, string> = {};
  const htmlAnchors: Record<string, { name: string; steps: number }> = {};
  for (const journey of input.acceptance) {
    routePaths[journey.journeyId] = journey.path;
    htmlAnchors[journey.journeyId] = { name: escapeHtml(journey.name), steps: journey.steps };
  }
  const acceptanceIds = new Set(input.acceptance.map((journey) => journey.journeyId));
  const coverageRoutes = input.routes.filter((route) => !acceptanceIds.has(route.journeyId));
  const routeAnchors: Record<string, { journeyId: string; name: string; steps: number }> = {};
  for (const route of coverageRoutes) {
    routeAnchors[route.path] = {
      journeyId: route.journeyId,
      name: escapeHtml(route.name),
      steps: route.steps,
    };
  }
  const lines = [
    "// CLAPP generated acceptance journeys (appKind: web).",
    "//",
    "// node:test suite executed with tsx (see the candidate testCommand). Every test",
    "// starts the generated server in-process on an ephemeral loopback port, asserts",
    "// the journey page anchors and replays the JSON API round-trip. Networking",
    "// never leaves 127.0.0.1.",
    "//",
    "// CLAPP-W3-003: full-route coverage. Every plan route the acceptance selection",
    '// does not pin gains an additive "route coverage: <journeyId>" test asserting the',
    "// same derivable anchors. Step counts are the plan routes' observed counts; the",
    "// suite pins counts and anchors only — it never emits interaction scripts.",
    'import assert from "node:assert/strict";',
    'import { test } from "node:test";',
    'import { start } from "./server.ts";',
    "",
    `const ROUTE_PATHS: Record<string, string> = JSON.parse(${jsonLiteral(routePaths)});`,
    "const HTML_ANCHORS: Record<string, { name: string; steps: number }> = JSON.parse(" +
      `${jsonLiteral(htmlAnchors)});`,
    `const API_KEYS: string[] = JSON.parse(${jsonLiteral(input.apiKeys)});`,
    "const EXPECTED_API: Record<string, unknown> = JSON.parse(" +
      `${jsonLiteral(input.expectedApi)});`,
    "const PUT_PROBE: Record<string, unknown> = JSON.parse('{\"clappPutProbe\":true}');",
    "const ROUTE_ANCHORS: Record<string, { journeyId: string; name: string; steps: number }> = JSON.parse(" +
      `${jsonLiteral(routeAnchors)});`,
    "",
    "async function assertApiRoundTrip(baseUrl: string): Promise<void> {",
    "  for (const key of API_KEYS) {",
    '    const response = await fetch(baseUrl + "/api/" + encodeURIComponent(key));',
    '    assert.equal(response.status, 200, "GET /api/" + key);',
    "    assert.deepStrictEqual(await response.json(), EXPECTED_API[key]);",
    "  }",
    "  if (API_KEYS.length > 0) {",
    "    const key = API_KEYS[0];",
    '    const put = await fetch(baseUrl + "/api/" + encodeURIComponent(key), {',
    '      method: "PUT",',
    '      headers: { "content-type": "application/json" },',
    "      body: JSON.stringify(PUT_PROBE),",
    "    });",
    '    assert.equal(put.status, 200, "PUT /api/" + key);',
    '    const after = await fetch(baseUrl + "/api/" + encodeURIComponent(key));',
    "    assert.deepStrictEqual(await after.json(), PUT_PROBE);",
    "  }",
    "}",
    "",
    'test("index route serves the generated app", async () => {',
    "  const server = await start(0);",
    "  try {",
    '    const baseUrl = "http://127.0.0.1:" + server.port;',
    '    const response = await fetch(baseUrl + "/");',
    "    assert.equal(response.status, 200);",
    '    assert.ok((response.headers.get("content-type") ?? "").startsWith("text/html"));',
    "    const html = await response.text();",
    '    assert.ok(html.includes(\'data-journey="index"\'), "index data-journey anchor");',
    "    await assertApiRoundTrip(baseUrl);",
    "  } finally {",
    "    await server.close();",
    "  }",
    "});",
  ];
  for (const journey of input.acceptance) {
    const journeyIdLiteral = JSON.stringify(journey.journeyId);
    lines.push(
      "",
      `test(${JSON.stringify(`acceptance journey: ${journey.journeyId}`)}, async () => {`,
      "  const server = await start(0);",
      "  try {",
      '    const baseUrl = "http://127.0.0.1:" + server.port;',
      `    const anchor = HTML_ANCHORS[${journeyIdLiteral}];`,
      `    const response = await fetch(baseUrl + ROUTE_PATHS[${journeyIdLiteral}]);`,
      "    assert.equal(response.status, 200);",
      '    assert.ok((response.headers.get("content-type") ?? "").startsWith("text/html"));',
      "    const html = await response.text();",
      '    assert.ok(html.includes(anchor.name), "journey name anchor");',
      `    assert.ok(html.includes(${htmlAttributeLiteral("data-journey", journey.journeyId)}), "journey data-journey anchor");`,
      '    assert.ok(html.includes("data-step-count=\\"" + anchor.steps + "\\""), "journey step count anchor");',
      '    const index = await fetch(baseUrl + "/");',
      "    assert.equal(index.status, 200);",
      "    await assertApiRoundTrip(baseUrl);",
      "  } finally {",
      "    await server.close();",
      "  }",
      "});",
    );
  }
  for (const route of coverageRoutes) {
    const pathLiteral = JSON.stringify(route.path);
    lines.push(
      "",
      `test(${JSON.stringify(`route coverage: ${route.journeyId}`)}, async () => {`,
      "  const server = await start(0);",
      "  try {",
      '    const baseUrl = "http://127.0.0.1:" + server.port;',
      `    const path = ${pathLiteral};`,
      `    const anchor = ROUTE_ANCHORS[${pathLiteral}];`,
      "    const response = await fetch(baseUrl + path);",
      "    assert.equal(response.status, 200);",
      '    assert.ok((response.headers.get("content-type") ?? "").startsWith("text/html"));',
      "    const html = await response.text();",
      '    assert.ok(html.includes(anchor.name), "route name anchor");',
      `    assert.ok(html.includes(${htmlAttributeLiteral("data-journey", route.journeyId)}), "route data-journey anchor");`,
      '    assert.ok(html.includes("data-step-count=\\"" + anchor.steps + "\\""), "route step count anchor");',
      '    const index = await fetch(baseUrl + "/");',
      "    assert.equal(index.status, 200);",
      "    await assertApiRoundTrip(baseUrl);",
      "  } finally {",
      "    await server.close();",
      "  }",
      "});",
    );
  }
  lines.push("");
  return lines.join("\n");
}
