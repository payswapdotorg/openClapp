import { canonicalJson } from "../canonical.ts";
import type { BenchmarkApp } from "../types.ts";
import { BENCHMARK_SERVE_JS } from "./serve-script.ts";

/**
 * B02 — "clapp_benchmark_b02" — Field Notes, a stateful CRUD-ish operations
 * app. Three pages, each carrying a form (action + fields); a JSON API under
 * /api/ backed by the state seed (GET list, PUT update — with the
 * HTML-form-compatible POST alias — over an in-memory store); and visible
 * counter/status lines rendered from the store, so a repair loop can mutate
 * state through the API or the harness and observe the change on the pages.
 *
 * The seed is authored ONCE (B02_SEED) and the "state.json" file is derived
 * from it with the canonical serializer, so the definition cannot drift:
 * the validator enforces that state.json deep-equals stateSeed, and the
 * sandbox host boots its store from that file.
 */

const FOOTER = "Field Notes | Operations log | Local state only";

/** The single-authored state seed (also serialized into state.json). */
const B02_SEED: Record<string, unknown> = {
  boardName: "Field Operations Board",
  openTasks: 3,
  status: "operational",
  tasks: ["Inspect the intake pump", "Replace the filter cartridge", "Log the evening reading"],
};

const STYLE = `  <style>
    body { font-family: "Courier New", Courier, monospace; margin: 0 auto; max-width: 52rem; padding: 1.5rem 1rem 3rem; color: #1c2b33; background: #f2f4f3; line-height: 1.55; }
    nav a { margin-right: 1.5rem; text-decoration: none; color: #0f5c55; font-weight: bold; }
    nav a:hover, nav a:focus { text-decoration: underline; }
    footer { margin-top: 3rem; border-top: 2px dashed #9db1ab; padding-top: 0.9rem; font-size: 0.85rem; color: #5c6f69; }
    h1 { font-size: 1.6rem; margin-bottom: 0.4rem; text-transform: uppercase; letter-spacing: 0.06em; }
    h2 { font-size: 1.1rem; margin-top: 2rem; border-left: 4px solid #0f5c55; padding-left: 0.6rem; }
    p { margin: 0.6rem 0; }
    label { display: block; margin-top: 0.9rem; font-weight: bold; }
    input { display: block; margin-top: 0.25rem; padding: 0.4rem; border: 1px solid #5c6f69; width: 24rem; max-width: 100%; font-family: inherit; }
    button { margin-top: 1rem; padding: 0.45rem 1.1rem; background: #0f5c55; color: #ffffff; border: none; font-family: inherit; font-weight: bold; cursor: pointer; }
    pre { background: #1c2b33; color: #d8e6e2; padding: 1rem; overflow-x: auto; }
  </style>`;

const NAV = `  <nav aria-label="Primary">
    <a href="/">Dashboard</a>
    <a href="/tasks">Tasks</a>
    <a href="/settings">Settings</a>
  </nav>`;

const FOOTER_BLOCK = `  <footer>
    <p>${FOOTER}</p>
  </footer>`;

const INDEX_PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Field Notes — Overview</title>
${STYLE}
</head>
<body>
${NAV}
  <main>
    <h1>{{boardName}}</h1>
    <p>System status: {{status}}</p>
    <p>Open tasks: {{openTasks}}</p>
    <p>This board is the single source of truth for the field crew. Every reading, repair and replacement is logged against it.</p>
    <h2>Update status</h2>
    <form action="/api/" method="post">
      <label for="status">Status</label>
      <input id="status" name="status" value="operational">
      <button type="submit">Save status</button>
    </form>
  </main>
${FOOTER_BLOCK}
</body>
</html>
`;

const TASKS_PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Field Notes — Worklist</title>
${STYLE}
</head>
<body>
${NAV}
  <main>
    <h1>Task queue</h1>
    <p>Open tasks: {{openTasks}}</p>
    <h2>Task backlog</h2>
    <pre id="task-backlog">{{tasks}}</pre>
    <h2>Record a new task</h2>
    <form action="/api/" method="post">
      <label for="title">Task title</label>
      <input id="title" name="title" value="">
      <label for="assignee">Assignee</label>
      <input id="assignee" name="assignee" value="">
      <button type="submit">Add task</button>
    </form>
  </main>
${FOOTER_BLOCK}
</body>
</html>
`;

const SETTINGS_PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Field Notes — Preferences</title>
${STYLE}
</head>
<body>
${NAV}
  <main>
    <h1>Board settings</h1>
    <p>System status: {{status}}</p>
    <h2>Adjust the board</h2>
    <form action="/api/" method="post">
      <label for="boardName">Board name</label>
      <input id="boardName" name="boardName" value="Field Operations Board">
      <label for="status">Status</label>
      <input id="status" name="status" value="operational">
      <button type="submit">Save settings</button>
    </form>
  </main>
${FOOTER_BLOCK}
</body>
</html>
`;

/** B02 — the stateful CRUD-ish operations app (Field Notes). */
export const B02: BenchmarkApp = {
  id: "clapp_benchmark_b02",
  name: "Field Notes operations board",
  version: "1.0.0",
  kind: "stateful",
  files: [
    { path: "index.html", content: INDEX_PAGE },
    { path: "serve.js", content: BENCHMARK_SERVE_JS },
    { path: "settings.html", content: SETTINGS_PAGE },
    { path: "state.json", content: canonicalJson(B02_SEED) },
    { path: "tasks.html", content: TASKS_PAGE },
  ],
  routes: [
    {
      path: "/",
      anchors: [
        "Dashboard",
        "Tasks",
        "Settings",
        "System status:",
        "Open tasks:",
        "Update status",
        "Status",
        "Save status",
        FOOTER,
      ],
    },
    {
      path: "/settings",
      anchors: [
        "Dashboard",
        "Tasks",
        "Settings",
        "Board settings",
        "System status:",
        "Board name",
        "Status",
        "Save settings",
        FOOTER,
      ],
    },
    {
      path: "/tasks",
      anchors: [
        "Dashboard",
        "Tasks",
        "Settings",
        "Task queue",
        "Open tasks:",
        "Task backlog",
        "Task title",
        "Assignee",
        "Add task",
        FOOTER,
      ],
    },
  ],
  stateSeed: B02_SEED,
  startCommand: "node serve.js",
  assumptions: [
    "The JSON store under /api/ is the single source of truth; pages render {{token}} placeholders from it (missing keys keep their literal token).",
    "state.json is the persisted seed and deep-equals stateSeed (validator-enforced); the sandbox host boots its store from it.",
    "PUT (and the HTML-form-compatible POST alias) merge top-level keys into the store; GET /api/ returns the canonical JSON of the store.",
    "A reset discards the store and re-seeds from stateSeed; served content and state are then byte-identical to a fresh start.",
    "serve.js hosts every sibling .html file at its derived route; the file is byte-identical to the B01 host.",
  ],
};
