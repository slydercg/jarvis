# Onboarding

A map of the codebase for anyone about to change it. The [README](README.md)
covers what Jarvis does and how to set it up; this covers how it is built and
where to look. [CLAUDE.md](CLAUDE.md) holds the same map for coding agents,
with the code style, test setup and gotchas they need. When a module is added,
renamed or removed, update both.

## The shape of it

Two halves, talking over a WebSocket on `localhost:8787`:

- **The page** (`src/`) is React, TypeScript and Three.js. It owns the
  microphone, the wake word, speech in and out, the 3D reactor, and the blades
  — the panels everything visual appears on.
- **The bridge** (`bridge/`) is Node. It runs Claude through the Agent SDK with
  your connected accounts as tools, decides which tool calls are allowed,
  confirmed or refused, and runs the background jobs: alerts, the brief, the
  wrap-up, the promise ledger, the portfolio pulse and the weekly review.

On a Mac it runs as two LaunchAgents: `local.jarvis.assistant` (the app) and
`local.jarvis.updater` (pulls `main` after each merge and restarts when idle).
Everything it remembers lives in `~/.jarvis`.

## One spoken question, end to end

1. **Wake:** `src/lib/wakeword.ts` and `oww.worker.ts` hear "hey Jarvis" on the
   device (openWakeWord); `vad.ts` finds the end of speech.
2. **Transcribe:** `voice.ts`. `echo.ts` drops anything that is his own voice
   coming back through the microphone.
3. **Send:** `lib/brain.ts` → `lib/bridge.ts` sends `{ type: 'ask', text }`.
4. **Think:** `bridge/server.mjs` prefixes the local time (and any alert he
   just spoke), picks the fast or deep model (`routeFor`), and runs the turn.
   Every tool call passes through **`decideTool`**: allow, confirm or deny.
5. **Confirm:** anything that sends, creates or moves sends a `confirm` frame
   first; `ui/ConfirmCard.tsx` asks yes or no, with a few seconds to undo.
6. **Answer:** the reply is spoken by `lib/tts.ts` (ElevenLabs, the Mac's
   voice, or Kokoro) and shown in the transcript (`ui/Hud.tsx`). Anything to
   look at goes on a blade (`ui/Blades.tsx`).

## The bridge (`bridge/`)

| File | What it does |
|---|---|
| `server.mjs` | Entry point: HTTP and WebSocket, the system prompt, the tool gate, the MCP servers per connection, the one-minute clock for proactive work |
| `agent.mjs` | `askReadOnly()` — one question to a separate read-only session, answered in JSON. Every background job uses it, and reports each step it takes |
| `steps.mjs` | Tool names in plain words ("Checking Jira") for the tool badge and a job's progress |
| `transcript.mjs` | The conversation history: every question, answer and alert, a file a day in `~/.jarvis/transcripts`, searchable. The page reads it in `ui/History.tsx` |
| `protective.mjs` | Protective mail, calendar and To Do through Power Automate flows |
| `briefing.mjs` | "Brief me": the ranked daily brief, cached and offered each morning |
| `alerts.mjs` | The watcher: one long-lived, cheap session checking calendar, mail and portfolio; meeting prep; focus blocks |
| `loop.mjs` | End-of-day wrap-up, meeting dossiers, and the tools over the promise ledger |
| `commitments.mjs` | The promise ledger, its scan, and its nudges |
| `focus.mjs` | Focus guard: holds alerts except VIPs, then one digest |
| `portfolio.mjs` | Portfolio pulse from Jira and the dashboards on the Mac; daily snapshots |
| `review.mjs` | The Friday weekly review and leadership update |
| `days.mjs` | Once-a-day offers and the per-day log the review reads back |
| `memory.mjs` | Remembered facts (`~/.jarvis/memory.md`) and resuming the conversation |
| `chrome.mjs` | Drives your own browser through the Claude extension |
| `localfiles.mjs` | Reads `file://` reports and dashboards in the home folder |
| `stratum.mjs` | The review list: every alert is kept until it's dealt with, plus snoozes and reminders. The page draws it in `ui/Stratum.tsx` |
| `today.mjs` | Today's meetings from every calendar, merged and clash-marked, plus the portfolio's standing, for the now strip and day timeline |
| `tickets.mjs` | Turns Jira keys and Azure DevOps ids into links, only to your own sites. `src/lib/tickets.ts` is the page's own check, and those are the only links the interface shows |
| `panels.mjs`, `ui.mjs`, `page.mjs`, `vision.mjs` | Blades and markup, interface controls, reader mode, the camera |
| `settings.mjs`, `env.mjs`, `net.mjs` | The ElevenLabs key and voice, `.env.local`, URL probing |

## The page (`src/`)

- `App.tsx` — the listening and answering loop, alerts, yes and no.
- `store.ts` — all interface state (Zustand).
- `lib/` — audio, voice, speech and the wake word; `prefs.ts` for per-browser
  settings such as the display mode; `quiet.ts` for quiet hours; `actions.ts`
  for each item's one-click next step; `history.ts` for search highlighting;
  `alertFit.ts` for how many alert cards fit above the conversation.
- `ui/` — `Hud`, `Blades`, `AlertStack`, `Stratum` (the review list),
  `History`, `KeysHelp` (the ? sheet), `NowStrip`, `DayTimeline`,
  `ConfirmCard`, `Settings`, `CommandBar`. All styling is in `index.css`,
  whose header says what each colour means.
- `scene/` — the reactor and particles.

## Rules the code keeps

- **Reading is free, changing things is asked.** Reads are allowed; drafts are
  allowed and never sent; sends, creates and moves are confirmed; anything
  that moves money is off unless `JARVIS_ALLOW_MONEY` is set.
- **Background jobs only read.** They run through `askReadOnly`, which refuses
  any tool that drafts, sends, creates, adds, updates, deletes, removes, moves,
  replies, forwards, posts, transitions or edits. Their only writes are their
  own files in `~/.jarvis`.
- **A new internal server** goes in both `INTERNAL_SERVERS` (so it stays off
  the systems rail) and `decideTool` (so its calls are decided on purpose).
- **Credentials never enter the repository.** Power Automate links, API keys
  and tokens live in `~/.jarvis` or `.env.local`, and no error message repeats
  them.
- **Written to be heard.** The persona keeps answers to two sentences with no
  markdown; detail goes on a blade.
- **Comments say why.** Match the density and tone of the code around you.

## Working on it

```bash
npm install
npm start                        # page and bridge together, for development
npm test                         # node:test — tests/*.test.*
npm run lint && npm run build    # oxlint; tsc and vite
```

On the Mac:

```bash
npm run autostart:logs           # the running bridge's log
npm run autostart:restart        # after changing .env.local or ~/.jarvis files
npm run browser:doctor           # the Claude extension's helper, per browser
```

- CI (`.github/workflows/ci.yml`) runs lint, build and tests on every pull
  request and every push to `main`.
- Changes go branch → pull request → squash merge. The updater applies them on
  the Mac within minutes.
- Every setting is documented in `.env.example`; each feature has its own
  section in the README.

## Where to start reading

1. `SYSTEM_PROMPT` in `bridge/server.mjs` and `decideTool` in `bridge/policy.mjs` — what Jarvis will
   and will not do.
2. `bridge/alerts.mjs` — how the proactive side stays cheap.
3. `src/App.tsx`, from the `watchAlerts` handler down — the page's main loop.
