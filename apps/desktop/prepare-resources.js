#!/usr/bin/env node
// prepare-resources.js — assemble apps/desktop/resources/ for packaging.
//
//   resources/server/dist/...        compiled server (tsc build:server)
//   resources/server/node_modules/   production deps (exact versions, npm)
//                                    + @clapp workspace shims (compiled)
//   resources/web/                   apps/mobile/dist/web (Expo export)
//
// The @clapp shims exist because the compiled dist imports workspace
// packages by name (@clapp/contracts et al.), which resolves in dev via
// pnpm workspace links (packages/*/node_modules) — node walking up from
// dist/ finds nothing. We mirror the dev layout: each compiled workspace
// package becomes node_modules/@clapp/<name> with its exports rewritten
// from .ts to .js.
//
// Usage: node apps/desktop/prepare-resources.js   (from the repo root)
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const OUT = path.join(__dirname, "resources");
const SERVER = path.join(OUT, "server");
const DIST = path.join(ROOT, "dist");
const WEB_SRC = path.join(ROOT, "apps", "mobile", "dist", "web");

// Workspace packages the server's runtime graph needs (the ones whose names
// appear as imports inside dist/): name -> packages dir. Node resolves every
// @clapp import by walking up to server-bundle/node_modules, so one shim per
// package covers all importers.
const CLAPP_PACKAGES = [
  ["@clapp/contracts", "clapp-contracts"],
  ["@clapp/observation", "clapp-observation"],
  ["@clapp/runtime-openmuse", "clapp-runtime-openmuse"],
  ["@clapp/intelligence", "clapp-intelligence"],
  ["@clapp/synthesis", "clapp-synthesis"],
];

function die(msg) {
  console.error(`[prepare-resources] ${msg}`);
  process.exit(1);
}

function cpDir(src, dst) {
  fs.cpSync(src, dst, { recursive: true, dereference: true, force: true });
}

function mustExist(p, what) {
  if (!fs.existsSync(p)) die(`missing ${what}: ${p}`);
}

// -------------------------------------------------------------------- main

mustExist(
  path.join(DIST, "apps", "server", "src", "index.js"),
  "compiled server (run `pnpm build:server` first)",
);
mustExist(path.join(WEB_SRC, "index.html"), "exported web shell (run `pnpm build:web` first)");

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(SERVER, { recursive: true });

// 1. compiled server tree
cpDir(DIST, path.join(SERVER, "dist"));
console.log("[prepare-resources] server dist copied");

// 2. production node_modules via a synthesized package.json (EXACT versions
//    resolved from the repo's own node_modules — no drift)
const RUNTIME_DEPS = [
  "@ag-ui/client",
  "@ag-ui/core",
  "@copilotkit/runtime",
  "@copilotkit/aimock",
  "@electric-sql/pglite",
  "@hono/node-server",
  "@tanstack/ai",
  "@tanstack/ai-anthropic",
  "@tanstack/ai-gemini",
  "@tanstack/ai-openai",
  "hono",
  "parse5",
  "pdf-lib",
  "pg",
  "rxjs",
  "zod",
];
const versions = {};
for (const dep of RUNTIME_DEPS) {
  const pj = path.join(ROOT, "node_modules", dep, "package.json");
  mustExist(pj, `installed dependency ${dep}`);
  versions[dep] = JSON.parse(fs.readFileSync(pj, "utf8")).version;
}
const bundleManifest = {
  name: "openclapp-server-bundle",
  version: "0.1.0",
  private: true,
  type: "module",
  description: "Bundled runtime for the OpenClapp desktop app",
  dependencies: Object.fromEntries(RUNTIME_DEPS.map((d) => [d, versions[d]])),
};
fs.writeFileSync(path.join(SERVER, "package.json"), `${JSON.stringify(bundleManifest, null, 2)}\n`);
console.log("[prepare-resources] installing production deps (npm, exact pins)…");
execFileSync(
  process.platform === "win32" ? "npm.cmd" : "npm",
  ["install", "--omit=dev", "--omit=scripts", "--no-audit", "--no-fund", "--loglevel=error"],
  { cwd: SERVER, stdio: "inherit" },
);
console.log("[prepare-resources] production deps installed");

// 2b. safe prune — source maps, type declarations and flow configs are
//     never loaded at runtime (node reads none of them); they are ~40% of
//     the tree. Module code is untouched.
let pruned = 0;
const PRUNE_PATTERNS = [/\.map$/, /\.d\.ts$/, /\.d\.mts$/, /\.flow$/];
function pruneDir(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === ".bin" || ent.name === ".cache") continue;
      pruneDir(p);
    } else if (PRUNE_PATTERNS.some((re) => re.test(ent.name))) {
      fs.unlinkSync(p);
      pruned++;
    }
  }
}
pruneDir(path.join(SERVER, "node_modules"));
console.log(`[prepare-resources] pruned ${pruned} non-runtime files`);

// 3. @clapp workspace shims (compiled trees + exports .ts -> .js)
for (const [name, dir] of CLAPP_PACKAGES) {
  const src = path.join(DIST, "packages", dir);
  mustExist(src, `compiled workspace package ${dir}`);
  const dst = path.join(SERVER, "node_modules", name);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.rmSync(dst, { recursive: true, force: true });
  fs.cpSync(src, dst, { recursive: true });
  const origPj = JSON.parse(
    fs.readFileSync(path.join(ROOT, "packages", dir, "package.json"), "utf8"),
  );
  const pj = {
    name,
    version: origPj.version || "0.1.0",
    private: true,
    type: "module",
    main: "./src/index.js",
    exports: { ".": "./src/index.js" },
  };
  fs.writeFileSync(path.join(dst, "package.json"), `${JSON.stringify(pj, null, 2)}\n`);
  console.log(`[prepare-resources] shim ${name} -> dist/packages/${dir}`);
}

// 4. web shell
fs.cpSync(WEB_SRC, path.join(OUT, "web"), { recursive: true });
console.log("[prepare-resources] web shell copied");
console.log(`[prepare-resources] done — resources/ ready at ${OUT}`);
