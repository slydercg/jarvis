# CLAUDE.md

J.A.R.V.I.S.: a voice assistant in the browser. There are two processes: the page (the face) and a Node bridge (the brain) that runs Claude Code headless and talks to the page over a WebSocket on :8787. README.md covers setup and features. This file covers how the code is put together. ONBOARDING.md is the same map written for people: one spoken question traced end to end, and where to start reading. When a module is added, renamed or removed, update both.

## Tech Stack

- **Page (`src/`)**: React 19, Vite 8, TypeScript 6 (`noEmit`, `erasableSyntaxOnly`, `verbatimModuleSyntax`), Three.js via @react-three/fiber with custom GLSL in `src/scene/`, zustand store, DOMPurify.
- **Bridge (`bridge/`)**: plain Node ESM `.mjs` (package is `"type": "module"`, Node >=20), `@anthropic-ai/claude-agent-sdk` `query()`, `ws`, zod for in-process MCP tool schemas.
- On-device audio/vision: onnxruntime-web (openWakeWord), kokoro-js TTS, @mediapipe/tasks-vision (hand tracking).

## Code Style

- Both halves: 2-space indent, single quotes, no semicolons.
- `src/` is TypeScript; `bridge/` and `scripts/` are untyped `.mjs` with JSDoc. Don't add TS to the bridge.
- Comments explain *why*, often at length: the failure mode a line prevents, or why a setting must not be "tidied". Keep them when editing and match the style. Many say "don't change X" and give the reason.
- Files are camelCase in `src/lib`, PascalCase components in `src/ui` and `src/scene`, and lowercase `.mjs` in `bridge/`.
- All model-authored markup (panels, blades) must go through `src/ui/sanitise.ts`, which is the single allowlist. Don't render model HTML anywhere else.
- All bridge outbound HTTP must go through `bridge/net.mjs` (the SSRF gate). Never call `fetch` directly on a model-chosen URL.

## Testing

- `npm test`: `node --test --experimental-strip-types` over `tests/*.test.*` (`.mjs` for bridge modules, `.mts` for `src/lib` modules).
- `.mts` tests import `src/*.ts` directly with type stripping, so any module tested this way must use only erasable TS syntax and must not import Vite-only things (`import.meta.env`, assets). `src/lib/echo.ts` is kept import-free for this reason.
- Tests replace `fetch` and point `JARVIS_HOME` at a temp dir. Never let a test reach the network or `~/.jarvis`. Audio fixtures are in `tests/fixtures/*.wav`.
- No coverage tooling is configured.

## Build & Run

- `npm start`: `scripts/start.mjs` runs the bridge and Vite together (adds `--writes` / `--open`, and copies the MediaPipe WASM into `public/mediapipe/`, which is gitignored).
- `npm run dev` (page only), `npm run bridge` (brain only), `npm run bridge:writes`.
- `npm run build` = `tsc -b && vite build`. `npm run lint` = oxlint (`react/rules-of-hooks` is an error).
- CI (`.github/workflows/ci.yml`, Node 22) runs `npm ci`, lint, build and test on every PR and every push to main. Run all three before pushing.
- `.claude/launch.json` runs `npm start` on port 5180 with `autoPort: false` on purpose (see Gotchas).

## Project Structure

| Path | Purpose |
|------|---------|
| `bridge/server.mjs` | Entry point (~2.4k lines): HTTP + WS server, origin check, `decideTool` permission gate, model routing, per-connection `query()` |
| `bridge/env.mjs` | Loads `.env.local`/`.env` into `process.env`. Must stay the first import |
| `bridge/memory.mjs` | Session resume + `remember` notes in `~/.jarvis/memory.md` |
| `bridge/panels.mjs` / `ui.mjs` | In-process MCP servers `jarvis` (`display` panels) and `jarvis_ui` (the model restyles the interface) |
| `bridge/chrome.mjs` | `jarvis_chrome`: drives the user's real Chrome through the extension's native host |
| `bridge/vision.mjs` | `jarvis_eyes`: asks the page for a camera frame (request/reply) |
| `bridge/alerts.mjs` / `briefing.mjs` | Separate long-lived and read-only agent sessions for proactive alerts and the daily brief |
| `bridge/protective.mjs` | Protective M365 mail/calendar/To Do through Power Automate flow URLs, which are credentials kept in `~/.jarvis`, never in the repo |
| `bridge/localfiles.mjs` | `jarvis_files`: read-only text extraction from documents under home |
| `bridge/net.mjs` / `page.mjs` | SSRF-gated outbound fetch; media/page proxy for showing articles |
| `bridge/settings.mjs` | Settings panel backend: writes the ElevenLabs key to `.env.local`, everything else to `~/.jarvis/settings.json` |
| `src/App.tsx`, `src/store.ts` | Main loop wiring and zustand state |
| `src/config.ts` | Every `import.meta.env` read. `VITE_BACKEND` = `bridge` (default) or `direct` (browser calls the API, `src/lib/anthropic.ts`) |
| `src/lib/` | Voice loop (`voice.ts`, `vad.ts`, `echo.ts`, `wakeword.ts` + `oww*`), TTS (`tts.ts`, `kokoro.ts`), bridge client (`bridge.ts`, `brain.ts`), hands/camera |
| `src/scene/` | Reactor (R3F + GLSL shaders) |
| `src/ui/` | HUD overlays: panels, blades, confirm card, settings, diagnostics |
| `scripts/` | `start`, `setup`, `browser-doctor`, `autostart` (LaunchAgents), `update` (self-updater) |

## Conventions

- Commits and PR titles are plain descriptive sentences, not Conventional Commits (e.g. "Stop him answering himself; ... (#13)"). Each PR is squash-merged to `main` with `(#N)` added.
- Work on a branch and open a PR. `main` is what every installed Mac auto-pulls (see Gotchas).
- Bridge errors: log with a `[jarvis]` prefix and keep the process alive. A crash drops the assistant mid-sentence, so unhandled rejections are caught at the top of `server.mjs`.
- Secrets go only in `.env.local` (gitignored, mode 600) or `~/.jarvis`. Only `VITE_*`, `JARVIS_NAME`, `JARVIS_TAGLINE` and `JARVIS_WAKE_ALIASES` reach the page (`envPrefix` in `vite.config.ts`). Variable names are listed in `.env.example`.

## Gotchas

- **Settings isolation**: every `query()` (server, alerts, briefing) passes `settingSources: []`, so user/project `settings.json`, CLAUDE.md, plugins, hooks and allow-rules never reach Jarvis at runtime, and `decideTool`/`canUseTool` is the only authority. Because of this, MCP servers are read from Claude's config by hand and passed as `mcpServers`, and `model` must be set explicitly.
- **`strictMcpConfig` is `false` on purpose**, not `true`: `true` would turn off claude.ai connectors (Gmail, Calendar, Drive). The code comment says not to "tidy" it. Use `ENABLE_CLAUDEAI_MCP_SERVERS=0` to run without them.
- **Write gating** (`decideTool` in `server.mjs`): read-only tools are always allowed. `Bash`/`Write`/`Edit` etc. need `JARVIS_ALLOW_WRITES=1`. Effectful MCP tools (matched by the verb regex) are allowed with writes on, otherwise get a spoken confirmation (`JARVIS_CONFIRM`, on by default), otherwise are denied. Money verbs also need `JARVIS_ALLOW_MONEY=1` and are always confirmed. `chromeServer` only *builds* click/type tools when writes are on. New in-process servers must be named explicitly in `decideTool`, or the verb regex will misjudge them.
- **The bridge runs with `cwd: homedir()`**, not the repo, and uses its own `SYSTEM_PROMPT`, not the claude_code preset.
- **Origin allowlist**: the bridge accepts WS only from `localhost:5173-5199` / `4173-4199` (or `JARVIS_ALLOWED_ORIGINS`). If the page is served on another port it loads fine but never gets an answer.
- **Mic**: embedded preview panes (including Claude Code's) block the microphone, and the page still looks alive. Test voice in a real Chrome/Edge window. A reload needs a click before the mic works again.
- **Hot reload**: Vite hot-reloads `src/`, but the bridge runs under plain `node` with no watch mode. Restart it after editing `bridge/` (`npm run autostart:restart` if autostart is installed).
- **Autostart/updater**: if installed, the LaunchAgent `local.jarvis.assistant` runs `npm start` from *this folder*, so `src/` edits go live in the running assistant. `local.jarvis.updater` runs every 5 min. On `main`, with no local commits and no edited tracked files (untracked files don't count), it fast-forwards to `origin/main` once the assistant has been idle for 15 min, restarts it, and does `git reset --hard` back if the health check fails. Work on a branch or set `JARVIS_AUTO_UPDATE=off` in `.env.local`. Logs are in `~/.jarvis/logs/`.
- Never read or print `.env.local`. Use `.env.example` for variable names.
