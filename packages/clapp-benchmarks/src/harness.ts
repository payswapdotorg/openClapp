import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { canonicalJson, cloneJson, isJsonSafeValue } from "./canonical.ts";
import { ClappBenchmarkError, describeError } from "./errors.ts";
import type { BenchmarkApp, BenchmarkHarness, StartedBenchmark } from "./types.ts";
import { assertValidBenchmarkApp, routeFilePath } from "./validate.ts";

/**
 * Disposable in-process benchmark hosting (CLAPP-W1-005).
 *
 * createBenchmarkHarness(app) hosts one benchmark definition on a node:http
 * loopback server on an ephemeral port — the established in-process test
 * pattern (tests/clapp-w1-002-observation.test.ts): no Chromium, no Docker,
 * no external network. The serving semantics mirror the sandbox host file
 * the definition ships (serve.js): routes map to files by the deterministic
 * route rule, stateful apps serve the /api/ JSON store from an in-memory
 * store seeded from stateSeed, {{token}} placeholders render from the store,
 * and every response body — pages, API payloads, errors — is canonical and
 * byte-deterministic: the same definition (and, for stateful apps, the same
 * store) always hosts byte-identical content.
 *
 * reset() makes hosting disposable: it stops a running server, discards the
 * store, re-seeds from stateSeed and restarts on a NEW ephemeral port, so
 * the next start() serves bytes identical to a fresh start while never
 * reusing a port or leaking mutated state.
 */

/** The API route every stateful benchmark serves its JSON store on. */
const API_PATH = "/api/";
/** Methods the state API accepts (POST is the HTML-form-compatible PUT alias). */
const API_METHODS = "GET, PUT, POST";
/** Upper bound on one request body (the store is tiny; refuse the unbounded). */
const BODY_LIMIT_BYTES = 1024 * 1024;

/** The {{token}} grammar: a top-level store key inside double braces. */
const TOKEN_PATTERN = /\{\{([A-Za-z0-9_]+)\}\}/g;

/**
 * Renders a page's {{token}} placeholders from a store. Strings render as
 * themselves; every other JSON value renders in canonical form. A key the
 * store does not own keeps its literal token — an honest, visible absence
 * rather than a silently blank region (parity diffing can detect it).
 */
export function renderTokens(content: string, store: Record<string, unknown> | null): string {
  if (store === null) return content;
  return content.replace(TOKEN_PATTERN, (whole, key: string) => {
    if (!Object.hasOwn(store, key)) return whole;
    const value = store[key];
    return typeof value === "string" ? value : canonicalJson(value);
  });
}

/** Sends a deterministic text response (content-length from the UTF-8 bytes). */
function sendText(
  response: ServerResponse,
  status: number,
  contentType: string,
  body: string,
): void {
  const bytes = Buffer.from(body, "utf8");
  response.writeHead(status, {
    "content-type": contentType,
    "content-length": bytes.length,
  });
  response.end(bytes);
}

/** Sends a deterministic JSON error body (canonical keys: error, message). */
function sendJsonError(
  response: ServerResponse,
  status: number,
  code: string,
  message: string,
  extraHeaders: Record<string, string> = {},
): void {
  const body = canonicalJson({ error: code, message });
  const bytes = Buffer.from(body, "utf8");
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": bytes.length,
    ...extraHeaders,
  });
  response.end(bytes);
}

/** Reads one request body, bounded; a result, never an exception. */
function readBoundedBody(
  request: IncomingMessage,
): Promise<{ ok: true; text: string } | { ok: false; status: 400 | 413; message: string }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    request.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > BODY_LIMIT_BYTES) {
        settled = true;
        chunks.length = 0;
        resolve({
          ok: false,
          status: 413,
          message: `request body exceeds the ${BODY_LIMIT_BYTES}-byte limit`,
        });
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (settled) return;
      settled = true;
      resolve({ ok: true, text: Buffer.concat(chunks).toString("utf8") });
    });
    request.on("error", (error) => {
      if (settled) return;
      settled = true;
      resolve({
        ok: false,
        status: 400,
        message: `request body could not be read: ${describeError(error)}`,
      });
    });
  });
}

/**
 * Creates the in-process hosting harness for one benchmark app. The app is
 * validated up front (fail closed with the validator's full error list);
 * after that every served byte is a pure function of the definition and,
 * for stateful apps, the current store.
 */
export function createBenchmarkHarness(app: BenchmarkApp): BenchmarkHarness {
  assertValidBenchmarkApp(app);

  const stateful = app.kind === "stateful";
  if (stateful && (typeof app.stateSeed !== "object" || app.stateSeed === null))
    throw new ClappBenchmarkError(
      "harness",
      `stateful benchmark "${app.id}" has no stateSeed despite passing validation; refusing to guess`,
    );
  const seed = app.stateSeed as Record<string, unknown> | undefined;
  let store: Record<string, unknown> | null =
    stateful && seed !== undefined ? cloneJson(seed) : null;

  // The route table: route path -> mapped file content (validation
  // guarantees every route maps to exactly one existing file).
  const routeFiles = new Map<string, string>();
  for (const route of app.routes) {
    const expected = routeFilePath(route.path);
    const file = app.files.find((candidate) => candidate.path === expected);
    if (file === undefined)
      throw new ClappBenchmarkError(
        "harness",
        `route "${route.path}" has no mapped file "${expected}" despite passing validation; refusing to guess`,
      );
    routeFiles.set(route.path, file.content);
  }

  let incarnation: { server: ReturnType<typeof createServer>; port: number } | null = null;
  let handleIssued = false;

  const handlePageOrApi = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const pathname = new URL(request.url ?? "/", "http://benchmark.invalid").pathname;
    if (request.method === undefined) {
      sendJsonError(response, 405, "method_not_allowed", "requests must carry a method");
      return;
    }
    // The state API. GET never mutates anything (honest reads); PUT and the
    // HTML-form-compatible POST alias merge a JSON object into the store.
    if (pathname === API_PATH) {
      if (!stateful) {
        sendJsonError(response, 404, "not_found", "no state API at /api/ for a static benchmark");
        return;
      }
      if (request.method === "GET") {
        sendText(response, 200, "application/json; charset=utf-8", canonicalJson(store));
        return;
      }
      if (request.method === "PUT" || request.method === "POST") {
        const outcome = await readBoundedBody(request);
        if (!outcome.ok) {
          sendJsonError(response, outcome.status, "bad_request", outcome.message);
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(outcome.text);
        } catch (error) {
          sendJsonError(
            response,
            400,
            "bad_request",
            `the ${request.method} body must be valid JSON: ${describeError(error)}`,
          );
          return;
        }
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          sendJsonError(
            response,
            400,
            "bad_request",
            `the ${request.method} body must be a JSON object merged into the store`,
          );
          return;
        }
        Object.assign(store as Record<string, unknown>, parsed);
        sendText(response, 200, "application/json; charset=utf-8", canonicalJson(store));
        return;
      }
      sendJsonError(
        response,
        405,
        "method_not_allowed",
        "the state API accepts GET, PUT and POST only",
        { allow: API_METHODS },
      );
      return;
    }
    // Page routes serve their mapped file, tokens rendered for stateful apps.
    const content = routeFiles.get(pathname);
    if (content !== undefined) {
      if (request.method === "GET") {
        sendText(response, 200, "text/html; charset=utf-8", renderTokens(content, store));
        return;
      }
      sendJsonError(response, 405, "method_not_allowed", "page routes accept GET only", {
        allow: "GET",
      });
      return;
    }
    sendJsonError(response, 404, "not_found", `no route matches ${JSON.stringify(pathname)}`);
  };

  const requestHandler = (request: IncomingMessage, response: ServerResponse): void => {
    void handlePageOrApi(request, response).catch((error: unknown) => {
      // The handler itself is total; this belt-and-braces catch keeps the
      // disposable server alive and answers honestly instead of hanging.
      if (!response.headersSent)
        sendJsonError(
          response,
          500,
          "internal",
          `the harness failed to serve the request: ${describeError(error)}`,
        );
      else response.destroy();
    });
  };

  const listen = async (): Promise<{ server: ReturnType<typeof createServer>; port: number }> => {
    const server = createServer(requestHandler);
    await new Promise<void>((resolve, reject) => {
      const onError = (error: unknown) => {
        server.off("listening", onListening);
        reject(
          new ClappBenchmarkError(
            "harness",
            `the benchmark server could not listen on an ephemeral loopback port: ${describeError(error)}`,
            { cause: error },
          ),
        );
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.listen(0, "127.0.0.1", onListening);
    });
    return { server, port: (server.address() as AddressInfo).port };
  };

  const closeIncarnation = async (target: {
    server: ReturnType<typeof createServer>;
    port: number;
  }): Promise<void> => {
    if (incarnation !== target) return; // a stale handle stops nothing
    incarnation = null;
    handleIssued = false;
    await new Promise<void>((resolve) => {
      target.server.closeAllConnections?.();
      target.server.close(() => resolve());
    });
  };

  const start = async (): Promise<StartedBenchmark> => {
    if (handleIssued)
      throw new ClappBenchmarkError(
        "harness",
        `the benchmark server for "${app.id}" is already started; stop the current handle or reset() before starting again`,
      );
    if (incarnation === null) incarnation = await listen();
    const current = incarnation;
    handleIssued = true;
    return {
      port: current.port,
      baseUrl: `http://127.0.0.1:${current.port}`,
      stop: () => closeIncarnation(current),
    };
  };

  const reset = async (): Promise<void> => {
    if (incarnation !== null) {
      const old = incarnation;
      incarnation = null;
      handleIssued = false;
      await new Promise<void>((resolve) => {
        old.server.closeAllConnections?.();
        old.server.close(() => resolve());
      });
      // Restart on a NEW ephemeral port: the caller's next start() hands
      // out the fresh incarnation. The old handle goes stale (stop is a
      // no-op on it), the old port is released, mutated state is gone.
      incarnation = await listen();
    }
    // Discard the store and re-seed from the definition — always, running
    // or not, so the next start serves byte-identical content either way.
    store = stateful && seed !== undefined ? cloneJson(seed) : null;
  };

  return {
    start,
    snapshotState: () => (store === null ? {} : cloneJson(store)),
    mutateState: (patch: Record<string, unknown>) => {
      if (!stateful || store === null)
        throw new ClappBenchmarkError(
          "harness",
          `mutateState is only available for stateful benchmarks; "${app.id}" is static and serves no store`,
        );
      if (typeof patch !== "object" || patch === null || Array.isArray(patch))
        throw new ClappBenchmarkError(
          "harness",
          `the state patch must be a JSON object; received ${Array.isArray(patch) ? "array" : typeof patch}`,
        );
      const unsafe = isJsonSafeValue(patch, "patch");
      if (unsafe !== null)
        throw new ClappBenchmarkError("harness", `the state patch is not JSON-safe: ${unsafe}`);
      Object.assign(store, patch);
    },
    reset,
  };
}
