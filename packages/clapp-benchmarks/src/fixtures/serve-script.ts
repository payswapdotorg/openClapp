/**
 * The sandbox host every canonical benchmark ships as "serve.js".
 *
 * This file is FIXTURE CONTENT, not package code: it is seeded verbatim into
 * every workspace so the benchmark can start inside deny-only isolated
 * execution with `node serve.js` (bounded, network-free). It is the sandbox
 * twin of the in-process harness in harness.ts — the two implement the same
 * serving semantics:
 *
 *   - every sibling "*.html" file is served at its derived route ("/" for
 *     index.html, "/x" for x.html, "/a/b" for a/b.html);
 *   - when a "state.json" sibling exists the host is stateful: GET /api/
 *     returns the canonical JSON of the in-memory store seeded from it,
 *     PUT /api/ (and the HTML-form-compatible POST alias) merge a JSON
 *     object into the store, and "{{key}}" tokens in pages render from the
 *     store (missing keys keep their literal token);
 *   - unknown paths answer 404 and wrong methods 405 with honest JSON
 *     errors; request bodies are bounded;
 *   - no external resources, no timestamps, no randomness: identical inputs
 *     host byte-identical content every time.
 *
 * The source deliberately avoids backticks and template literals so it can
 * be embedded as a plain string in this package's fixture modules without
 * escaping drift.
 */
export const BENCHMARK_SERVE_JS = `#!/usr/bin/env node
// clapp benchmark host -- the sandbox twin of the in-process harness.
// Serves sibling .html files at their derived routes; when a state.json
// sibling exists, also serves the /api/ JSON store with {{token}} rendering.
// No external resources, no timestamps, no randomness.
"use strict";

var http = require("node:http");
var fs = require("node:fs");
var path = require("node:path");

var HOST = process.env.HOST || "127.0.0.1";
var PORT = Number(process.env.PORT || 8080);
var BODY_LIMIT_BYTES = 1024 * 1024;
var API_PATH = "/api/";

var root = __dirname;

// Route inventory derived by inverting the deterministic route rule.
var pages = new Map();
var names = fs.readdirSync(root).sort();
for (var nameIndex = 0; nameIndex < names.length; nameIndex += 1) {
  var name = names[nameIndex];
  if (!name.endsWith(".html")) continue;
  var route = name === "index.html" ? "/" : "/" + name.slice(0, -5);
  pages.set(
    route,
    { file: name, content: fs.readFileSync(path.join(root, name), "utf8") }
  );
}

// Stateful mode is the presence of the state.json seed file.
var stateFile = path.join(root, "state.json");
var stateful = fs.existsSync(stateFile);
var store = stateful ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : null;

// Canonical JSON: keys sorted recursively, no whitespace.
function canonical(value) {
  if (value === undefined) return "null";
  if (Array.isArray(value)) {
    var items = [];
    for (var i = 0; i < value.length; i += 1) items.push(canonical(value[i]));
    return "[" + items.join(",") + "]";
  }
  if (value !== null && typeof value === "object") {
    var keys = Object.keys(value).sort();
    var parts = [];
    for (var k = 0; k < keys.length; k += 1) {
      parts.push(JSON.stringify(keys[k]) + ":" + canonical(value[keys[k]]));
    }
    return "{" + parts.join(",") + "}";
  }
  return JSON.stringify(value);
}

// {{key}} tokens render from the store; missing keys keep their token.
function render(content) {
  if (!stateful) return content;
  return content.replace(/\\{\\{([A-Za-z0-9_]+)\\}\\}/g, function (whole, key) {
    if (!Object.prototype.hasOwnProperty.call(store, key)) return whole;
    var value = store[key];
    return typeof value === "string" ? value : canonical(value);
  });
}

function send(res, status, contentType, body) {
  var bytes = Buffer.from(body, "utf8");
  res.writeHead(status, {
    "content-type": contentType,
    "content-length": bytes.length
  });
  res.end(bytes);
}

function sendJson(res, status, error, message, extraHeaders) {
  var headers = extraHeaders || {};
  var body = canonical({ error: error, message: message });
  var bytes = Buffer.from(body, "utf8");
  res.writeHead(status, Object.assign({
    "content-type": "application/json; charset=utf-8",
    "content-length": bytes.length
  }, headers));
  res.end(bytes);
}

function readBoundedBody(req, callback) {
  var chunks = [];
  var size = 0;
  var settled = false;
  req.on("data", function (chunk) {
    if (settled) return;
    size += chunk.length;
    if (size > BODY_LIMIT_BYTES) {
      settled = true;
      chunks = [];
      callback({ ok: false, status: 413, message: "request body exceeds the " + BODY_LIMIT_BYTES + "-byte limit" });
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", function () {
    if (settled) return;
    settled = true;
    callback({ ok: true, text: Buffer.concat(chunks).toString("utf8") });
  });
  req.on("error", function (error) {
    if (settled) return;
    settled = true;
    callback({ ok: false, status: 400, message: "request body could not be read: " + (error && error.message) });
  });
}

var server = http.createServer(function (req, res) {
  var pathname = String(req.url || "/").split("?")[0];
  if (pathname === API_PATH) {
    if (!stateful) {
      sendJson(res, 404, "not_found", "no state API at /api/ for a static benchmark");
      return;
    }
    if (req.method === "GET") {
      send(res, 200, "application/json; charset=utf-8", canonical(store));
      return;
    }
    if (req.method === "PUT" || req.method === "POST") {
      readBoundedBody(req, function (outcome) {
        if (!outcome.ok) {
          sendJson(res, outcome.status, "bad_request", outcome.message);
          return;
        }
        var parsed = null;
        try {
          parsed = JSON.parse(outcome.text);
        } catch (error) {
          sendJson(res, 400, "bad_request", "the " + req.method + " body must be valid JSON: " + (error && error.message));
          return;
        }
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          sendJson(res, 400, "bad_request", "the " + req.method + " body must be a JSON object merged into the store");
          return;
        }
        Object.assign(store, parsed);
        send(res, 200, "application/json; charset=utf-8", canonical(store));
      });
      return;
    }
    sendJson(res, 405, "method_not_allowed", "the state API accepts GET, PUT and POST only", { allow: "GET, PUT, POST" });
    return;
  }
  var page = pages.get(pathname);
  if (page !== undefined) {
    if (req.method === "GET") {
      send(res, 200, "text/html; charset=utf-8", render(page.content));
      return;
    }
    sendJson(res, 405, "method_not_allowed", "page routes accept GET only", { allow: "GET" });
    return;
  }
  sendJson(res, 404, "not_found", "no route matches " + JSON.stringify(pathname));
});

server.listen(PORT, HOST, function () {
  process.stdout.write(
    "clapp benchmark host listening on " + HOST + ":" + String(PORT) +
    " (" + pages.size + " page(s), stateful: " + stateful + ")\\n"
  );
});
`;
