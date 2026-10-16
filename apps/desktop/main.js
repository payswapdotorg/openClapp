// OpenClapp desktop — Electron main process.
//
// Runs the CLAPP/OpenMuse server locally (sample mode by default; live mode
// via ~/.config/openclapp/desktop.env) and serves the bundled web shell.
// The app IS the product: the CLAPP application-intelligence layer on the
// OpenMuse runtime (chat, browser, terminal, files, delegated tasks).
//
// Layout (extraResources in the packaged app, apps/desktop/resources in dev):
//   resources/server/dist/...       compiled server (ESM)
//   resources/server/node_modules/  production deps + @clapp workspace shims
//   resources/web/                  the exported Expo web shell
//
// Ports: API 127.0.0.1:8787, UI 127.0.0.1:8788 (both env-overridable).
// Data: ~/.local/share/openclapp   Config: ~/.config/openclapp/desktop.env
const { app, BrowserWindow, Menu, shell, dialog, ipcMain } = require("electron");
const { spawn } = require("node:child_process");
const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

const IS_DEV = !app.isPackaged;
const RES = IS_DEV ? path.join(__dirname, "resources") : process.resourcesPath;
const SERVER_ENTRY = path.join(RES, "server", "dist", "apps", "server", "src", "index.js");
const WEB_DIR = path.join(RES, "web");

const API_PORT = intEnv("OPENCLAPP_API_PORT", 8787);
const UI_PORT = intEnv("OPENCLAPP_UI_PORT", 8788);
const API_ORIGIN = `http://127.0.0.1:${API_PORT}`;
const UI_ORIGIN = `http://127.0.0.1:${UI_PORT}`;
const UI_ORIGIN_LOCALHOST = `http://localhost:${UI_PORT}`;

const DATA_DIR =
  process.env.OPENCLAPP_DATA_DIR || path.join(os.homedir(), ".local", "share", "openclapp");
const CONFIG_DIR =
  process.env.OPENCLAPP_CONFIG_DIR || path.join(os.homedir(), ".config", "openclapp");
const ENV_FILE = path.join(CONFIG_DIR, "desktop.env");
const LOG_DIR = path.join(DATA_DIR, "logs");
const SERVER_LOG = path.join(LOG_DIR, "server.log");

function intEnv(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isInteger(v) && v > 0 && v < 65536 ? v : fallback;
}

function log(line) {
  const stamp = new Date().toISOString();
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(SERVER_LOG, `[${stamp}] ${line}\n`);
  } catch {
    /* best-effort */
  }
  console.log(`[openclapp] ${line}`);
}

// ---------------------------------------------------------------- env file --

function readUserEnv() {
  const out = {};
  try {
    const text = fs.readFileSync(ENV_FILE, "utf8");
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 1) continue;
      const key = line.slice(0, eq).trim();
      const val = line
        .slice(eq + 1)
        .trim()
        .replace(/^["']|["']$/g, "");
      if (key) out[key] = val;
    }
  } catch {
    /* no config file yet — defaults apply */
  }
  return out;
}

async function ensureFirstRunEnv() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });
  if (!fs.existsSync(ENV_FILE)) {
    const sample = [
      "# OpenClapp desktop configuration",
      "#",
      "# WORKSPACE_MODE=sample runs the built-in sample agent (no keys needed).",
      "# For a live agent set WORKSPACE_MODE=live and provide the keys below.",
      "",
      "# WORKSPACE_MODE=sample",
      "# CPK_INTELLIGENCE_API_KEY=",
      "# MODEL=",
      "# GOOGLE_CLIENT_ID=",
      "# GOOGLE_CLIENT_SECRET=",
      "",
    ].join("\n");
    await fsp.writeFile(ENV_FILE, sample, "utf8");
  }
}

function serverEnv() {
  const user = readUserEnv();
  // Clean, deliberate environment — never inherit DATABASE_URL and friends
  // from the user's shell (a stray system value breaks the embedded store).
  const env = {
    PATH: process.env.PATH || "/usr/bin:/bin",
    HOME: process.env.HOME || os.homedir(),
    LANG: process.env.LANG || "C.UTF-8",
    DO_NOT_TRACK: "1",
    COPILOTKIT_TELEMETRY_DISABLED: "true",
    PORT: String(API_PORT),
    HOST: "127.0.0.1",
    WORKSPACE_MODE: user.WORKSPACE_MODE || "sample",
    DATA_DIR: DATA_DIR,
    PUBLIC_API_URL: API_ORIGIN,
    ALLOWED_ORIGINS: `${UI_ORIGIN},${UI_ORIGIN_LOCALHOST}`,
    // Sample mode boots with a placeholder; the server requires a non-empty
    // value even when the sample backend never uses it. A live workspace
    // needs the real key from the config file.
    CPK_INTELLIGENCE_API_KEY: user.CPK_INTELLIGENCE_API_KEY || "sample-placeholder-not-a-real-key",
  };
  for (const [key, val] of Object.entries(user)) {
    if (key === "PATH" || key === "HOME") continue;
    env[key] = val;
  }
  return env;
}

// ------------------------------------------------------------- api server --

let serverProc = null;
let serverExited = false;
let serverExitCode = null;
let quitting = false;

function startServer() {
  serverExited = false;
  serverExitCode = null;
  log(`starting API server (${SERVER_ENTRY}) on ${API_ORIGIN}`);
  const env = serverEnv();
  // The packaged app runs the server with Electron's own embedded Node
  // (ELECTRON_RUN_AS_NODE) — no system Node.js dependency at all.
  const childEnv = { ...env, ELECTRON_RUN_AS_NODE: "1" };
  serverProc = spawn(process.execPath, [SERVER_ENTRY], {
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
    cwd: path.dirname(SERVER_ENTRY),
  });
  serverProc.stdout.setEncoding("utf8");
  serverProc.stderr.setEncoding("utf8");
  serverProc.stdout.on("data", (d) => {
    for (const line of d.split(/\r?\n/)) if (line.trim()) log(`[server] ${line}`);
  });
  serverProc.stderr.on("data", (d) => {
    for (const line of d.split(/\r?\n/)) if (line.trim()) log(`[server:err] ${line}`);
  });
  serverProc.on("exit", (code, signal) => {
    serverExited = true;
    serverExitCode = code ?? signal;
    log(`API server exited (code=${serverExitCode})`);
    if (!quitting && win && !win.isDestroyed()) showErrorScreen("server-exit");
  });
  return serverProc;
}

function stopServer() {
  if (serverProc && !serverExited) {
    serverProc.kill("SIGTERM");
    setTimeout(() => {
      try {
        if (serverProc && !serverExited) serverProc.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, 4000);
  }
}

async function waitHealthy(timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (serverExited) throw new Error("server exited before becoming healthy");
    const ok = await probeHealth(1000);
    if (ok) return;
    await sleep(500);
  }
  throw new Error(`server not healthy after ${timeoutMs}ms`);
}

function probeHealth(timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get(`${API_ORIGIN}/api/health`, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve(false);
    });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ------------------------------------------------------------- ui server ---

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
};

function startUiServer() {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
    let file = path.normalize(path.join(WEB_DIR, urlPath));
    if (!file.startsWith(WEB_DIR)) {
      res.writeHead(403);
      res.end("forbidden");
      return;
    }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) file = path.join(WEB_DIR, "index.html"); // SPA fallback
      fs.readFile(file, (err2, data) => {
        if (err2) {
          res.writeHead(500);
          res.end("ui missing");
          return;
        }
        res.writeHead(200, {
          "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
          "Cache-Control": "no-store",
        });
        res.end(data);
      });
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(UI_PORT, "127.0.0.1", () => resolve(server));
  });
}

// --------------------------------------------------------------- window ----

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 420,
    minHeight: 620,
    backgroundColor: "#ffffff",
    title: "OpenClapp",
    icon: path.join(__dirname, "icons", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadURL(`${UI_ORIGIN}/`);
  // The app shell is local; anything that tries to open a NEW window or
  // navigate off-origin goes to the user's browser instead.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(UI_ORIGIN) || url.startsWith(API_ORIGIN)) return { action: "allow" };
    shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(UI_ORIGIN) && !url.startsWith(API_ORIGIN)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });
  win.on("closed", () => {
    win = null;
  });
}

async function showErrorScreen(kind) {
  if (!win || win.isDestroyed()) return;
  let tail = "";
  try {
    tail = (await fsp.readFile(SERVER_LOG, "utf8")).split(/\r?\n/).slice(-30).join("\n");
  } catch {
    /* no log yet */
  }
  try {
    await win.loadFile(path.join(__dirname, "error.html"), { query: { kind, tail } });
  } catch {
    /* window gone */
  }
}

async function restartEverything() {
  stopServer();
  await sleep(1500);
  startServer();
  try {
    await waitHealthy();
    if (win && !win.isDestroyed()) win.loadURL(`${UI_ORIGIN}/`);
  } catch {
    await showErrorScreen("server-restart-failed");
  }
}

// ----------------------------------------------------------------- menu ----

function buildMenu() {
  const template = [
    {
      label: "OpenClapp",
      submenu: [
        {
          label: "About OpenClapp",
          click: () =>
            dialog.showMessageBox({
              type: "info",
              title: "About OpenClapp",
              message: "OpenClapp desktop",
              detail:
                "The CLAPP application-intelligence layer on the OpenMuse runtime.\n" +
                `Server: ${API_ORIGIN}\nConfig: ${ENV_FILE}\nData: ${DATA_DIR}`,
              buttons: ["OK"],
            }),
        },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "File",
      submenu: [
        { label: "Open Data Folder", click: () => shell.openPath(DATA_DIR) },
        { label: "Open Server Log", click: () => shell.openPath(SERVER_LOG) },
        { label: "Open Configuration", click: () => shell.openPath(ENV_FILE) },
        { type: "separator" },
        { role: "close" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        ...(IS_DEV ? [{ role: "toggleDevTools" }] : []),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ----------------------------------------------------------------- app -----

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    buildMenu();
    ipcMain.handle("openclapp:restart-server", () => restartEverything());
    ipcMain.handle("openclapp:paths", () => ({
      dataDir: DATA_DIR,
      configDir: CONFIG_DIR,
      envFile: ENV_FILE,
      serverLog: SERVER_LOG,
      apiOrigin: API_ORIGIN,
      uiOrigin: UI_ORIGIN,
    }));
    await ensureFirstRunEnv();
    try {
      await startUiServer();
    } catch (e) {
      log(`UI server failed: ${e.message} (is port ${UI_PORT} in use?)`);
      dialog.showErrorBox(
        "OpenClapp",
        `Could not bind the local UI server on port ${UI_PORT}.\n${e.message}`,
      );
      app.quit();
      return;
    }
    startServer();
    try {
      await waitHealthy();
      createWindow();
    } catch (e) {
      log(`startup failed: ${e.message}`);
      createWindow();
      await showErrorScreen("startup-failed");
    }
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("before-quit", () => {
    quitting = true;
    stopServer();
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
