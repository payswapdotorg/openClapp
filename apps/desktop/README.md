# OpenClapp desktop

The CLAPP product as a local Ubuntu desktop app: an Electron shell that runs
the OpenMuse server and the web app on your machine — chat, files, mail,
calendars, plans, and the sample agent, with no cloud dependency for the
local data plane.

> This directory packages the product. The application source is the repo
> itself (`apps/server`, `apps/mobile`, `packages/*`); nothing here forks
> product behavior.

## Install (Ubuntu x64)

Download from the repository's GitHub releases (Assets):

- **`OpenClapp_0.1.0_amd64.deb`** — `sudo apt install ./OpenClapp_0.1.0_amd64.deb`
  (or `sudo dpkg -i`), then launch **OpenClapp** from your desktop menu.
- **`OpenClapp-0.1.0-x86_64.AppImage`** — `chmod +x` and run it directly:
  `./OpenClapp-0.1.0-x86_64.AppImage`

Both are self-contained: they bundle the compiled server, its production
dependencies, the exported web shell, and the Electron runtime (which also
serves as the Node runtime for the server — **no system Node.js required**).

## What runs where

| Piece | Address | Notes |
| --- | --- | --- |
| API server | `http://127.0.0.1:8787` | Hono server, embedded PGlite store at `~/.local/share/openclapp` |
| Web shell | `http://127.0.0.1:8788` | the Expo web export, served locally by the app |
| Electron window | — | loads the local shell; external links go to your browser |

Both ports are overrideable (`OPENCLAPP_API_PORT`, `OPENCLAPP_UI_PORT`).

## Configuration

First run creates `~/.config/openclapp/desktop.env`:

- `WORKSPACE_MODE=sample` (default) — the built-in sample agent and sample
  workspace. No keys required for the data plane (mail, calendars, files,
  finance, plans).
- Chat (Rich Threads) requires a CopilotKit Intelligence key — the product's
  own substrate: run `npx copilotkit@latest login` and set
  `CPK_INTELLIGENCE_API_KEY=` in the env file, then restart the app.
- `WORKSPACE_MODE=live` — a real agent: additionally set `MODEL=` plus a
  provider key (`OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GOOGLE_API_KEY`),
  or point `AGENT_URL=` at an AG-UI endpoint.

The app menu (File) opens the data folder, the server log, and the config
file. If the server stops, the window shows the log tail with a restart
button.

## Build from source

Requires Node 22+ and pnpm (via corepack):

```sh
pnpm install            # repo deps
pnpm build:server       # tsc -> dist/
pnpm build:web          # expo export -> apps/mobile/dist/web
cd apps/desktop
npm install             # electron + electron-builder (own lockfile)
npm run dist            # prepare-resources.js + electron-builder --linux deb appimage
```

`prepare-resources.js` assembles `resources/`: the compiled server tree, a
production `node_modules` (exact versions resolved from the repo's own
install), `@clapp/*` workspace shims (the compiled dist imports workspace
packages by name; the shims mirror the pnpm workspace links so plain Node
resolution works), and the exported web shell. Non-runtime files (source
maps, declarations) are pruned.

Artifacts land in `apps/desktop/dist/`.

## Development

```sh
cd apps/desktop && node prepare-resources.js && npm start
```

Electron flags for headless/CI runs: `--no-sandbox --disable-gpu
--remote-debugging-port=<port> --remote-allow-origins=*` (with `xvfb-run`
or a `Xvfb :93` display).
