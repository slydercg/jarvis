# J.A.R.V.I.S.

A browser voice assistant with an Iron Man holographic interface. Say
**"Hey Jarvis"**, he wakes, listens, and does real things through your tools —
searches the web, generates images, drives your phone, reads your mail. The face
is a web page (React + Vite + Three.js + custom GLSL). The brain is Claude Code,
run headless as a library.

**The only subscription you need is Claude Code.** No API keys, no OpenAI
account, no cloud bill — the brain runs on your existing Claude Code login, and
the heavy work (the model itself) runs on Anthropic's servers, so even a low-end
laptop only has to draw the interface. **ElevenLabs is an optional add-on** that
gives JARVIS a much better voice and sharper hearing; without it he speaks and
listens through the browser's own speech, and everything still works.

---

## Requirements

**In one line:** a Claude Code subscription, plus two free things every computer
can have — Node.js and Chrome. That's the whole list.

- **Claude Code, installed and logged in** — this is the only account you need.
  Install it with the official method — `npm install -g @anthropic-ai/claude-code`,
  or the platform installer at <https://docs.claude.com/en/docs/claude-code> —
  then run `claude` once and complete login. The bridge reuses that login. **No
  API key**, and usage is billed to your existing Claude account.
- **Node.js 20 or newer** — free, one installer from <https://nodejs.org>. This
  is a Node web app, so it is the one unavoidable tool.
- **Google Chrome or Microsoft Edge**, in a **real browser window** — not an
  embedded preview pane. Preview panes (including the one inside editors and
  Claude Code) block microphone access, so the page loads and looks right but
  never hears you. JARVIS also needs WebGL, which these browsers provide.
- **Optional: an ElevenLabs API key** — a good add-on, not a requirement. It
  gives a better voice and sharper transcription; the free tier is plenty for a
  demo. Without it, everything runs on the browser's own speech.

Run `npm run setup` after cloning and it checks all of this for you, in plain
language.

---

## Quick start

First, install, then start it:

```bash
npm install
npm start          # runs the brain and the face together
```

Then open the URL it prints (http://localhost:5173) in **Chrome**, click **INITIALISE**, and say **“Hey Jarvis”**.

Prefer two terminals? Run them separately instead:

```bash
npm install
```

Terminal 1 — the brain:

```bash
npm run bridge
```

Terminal 2 — the face:

```bash
npm run dev
```

Then open the app in a **real Chrome or Edge window**:

```bash
open http://localhost:5173
```

Click **INITIALISE**, allow the microphone when asked, and say **"Hey Jarvis"**.

> It has to be a real browser window. Embedded preview panes block the
> microphone, so JARVIS will look perfectly alive and simply never respond.

---

## How it works

JARVIS is two processes. The browser is the face and the voice; the bridge is
the brain and the hands.

```
  ┌─ browser (the face) ───────────────┐        ┌─ bridge (the brain) ─────────────┐
  │  "Hey Jarvis" wake word            │        │  Node · bridge/server.mjs        │
  │  local VAD  →  speech to text      │   ws   │  Claude Agent SDK                │
  │  reactor UI (Three.js + GLSL)      │◄─────► │   = Claude Code, headless        │
  │  text to speech                    │  8787  │  spawns your MCP servers         │
  │  heads-up display                  │        │  permission gate (decideTool)    │
  └────────────────────────────────────┘        └──────────────────────────────────┘
```

Everything you see and hear happens in the browser. The bridge is a single Node
process (`bridge/server.mjs`) that runs the **Claude Agent SDK**
(`@anthropic-ai/claude-agent-sdk`) — this spawns the real `claude` CLI as a child
process, so **the brain literally is Claude Code, headless.** They talk over a
WebSocket (plus a few HTTP endpoints) on `ws://localhost:8787`.

**Why a bridge at all?** A browser tab cannot spawn the local stdio MCP servers —
`higgsfield`, `elevenlabs`, `android`, `playwright`, `exa`, `serper`, and the
rest. The bridge can. And because it is the Agent SDK, it authenticates off your
existing Claude Code login: no API key, billed to that same Claude account.

**Two models, picked per question.** Short, simple turns ("what time is it",
"thanks", "turn it down") go to `claude-sonnet-5` at low effort. Anything that
asks for research, writing, analysis, planning or a briefing, or simply runs
long, goes to the main model. It's still one conversation; only the model
answering the next turn changes. Measured on this bridge, a quick follow-up
costs about $0.02 against $0.30–0.40 for a main-model turn. The HUD shows the
session's running cost and which model answered last.

**The main model.** `claude-opus-5` at effort `high` by default. Override with the
`JARVIS_MODEL` and `JARVIS_EFFORT` environment variables. On startup the bridge
prints its choice, e.g. `[jarvis] model claude-opus-5 · effort high`.

### The voice pipeline

The loop is designed so that nothing silently dies and barge-in feels natural.

- **Detection is local.** An energy-based voice-activity detector
  (`src/lib/vad.ts`) decides when you are speaking. It is instant, cannot quietly
  fail, and is what makes **barge-in** work — speak while JARVIS is talking and he
  stops.
- **Transcription has two tiers, chosen automatically at boot.** The browser asks
  the bridge `/health` and picks the best available:
  - **ElevenLabs key present** → ElevenLabs Scribe, via the bridge `/stt` endpoint.
  - **Nothing configured** → the browser's own `SpeechRecognition` (Chrome/Edge),
    guarded by a heartbeat so it recovers when Chrome throttles it.
- **Speaking** uses the **ElevenLabs voice when a key is present**, and the
  browser's `speechSynthesis` otherwise. If a cloud call fails it falls back to
  the browser voice, and if the OS voice itself is broken it latches over to the
  cloud voice.

So it works with no keys and auto-upgrades when a key appears — there is no flag
to set. Capability detection lives in `src/lib/capabilities.ts`, which probes the
bridge's `GET /health` (returning `{ ok, tts, stt }`, both tracking the
ElevenLabs key) once at boot and picks the engines.

---

## What JARVIS can do

Beyond answering, JARVIS reaches every MCP server in your Claude Code
configuration, and can drive his own interface.

### Your tools

Every server in your `~/.claude.json` is handed to the SDK explicitly. Depending
on what you have installed, that is roughly:

- **Web & search** — `exa`, `serper`, `serpapi`
- **Images & video** — `higgsfield`, `openrouter-image`, `palmier-pro`
- **Voice** — `elevenlabs`
- **Your phone** — `android`
- **The browser** — `playwright`

A few things you can say:

- *"What's happening in AI this week?"*
- *"Generate an image of the Mark VII suit."*
- *"Take a screenshot of my phone."*
- *"Open my GitHub notifications."*

### Your accounts: claude.ai connectors

The connectors you've added to your **claude.ai account** load too: Gmail,
Google Calendar, Drive, Notion, Jira and Confluence, HubSpot, market data, your
brokerage, your speakers and the rest. They aren't stored on disk. Claude Code
fetches them with your claude.ai login when the bridge starts a session, so
they come along as long as:

- Claude Code is logged in with the **same account** that holds the connectors
  (`claude`, then `/login`, then choose your Claude subscription), and
- `ANTHROPIC_API_KEY` is **not** set in the shell. An API key takes precedence
  over your login and switches the connectors off. The bridge warns you if it's
  set.

As soon as the page connects, before you say anything, the SYSTEMS rail on the
left fills with every server and connector that loaded (it wraps into columns
when the list is long), and the terminal lists them, for example:

```
[jarvis] 27 MCP servers available (27 from your claude.ai connectors): Gmail, Google Calendar, …
[jarvis] needs signing in again (claude.ai → Settings → Connectors): Notion
```

JARVIS reaches for a connector before opening the site in Chrome. Every message
also carries your local date, time and time zone, so "what's on my calendar
today" means your today. Try:

- *"Brief me."* Unread mail that needs you, today's meetings and clashes,
  yesterday's action items and the portfolio's move, as one card on screen
  and three spoken sentences. Sources you haven't connected are skipped.
- *"Anything important in my inbox?"*
- *"What's my next meeting?"*
- *"Draft a reply to Sarah saying Thursday works."* (Drafts are allowed in
  read-only mode. Nothing is sent.)
- *"How's the portfolio doing today?"*

Set `ENABLE_CLAUDEAI_MCP_SERVERS=0` in the shell to run without them.

### JARVIS controls the interface

He drives the UI through MCP tools the bridge exposes:

- `ui_theme` — accent, background, per-phase colours
- `ui_reactor` — colour, scale, intensity, spin, and style (`ring` | `sphere` | `wire`), visibility
- `ui_orbit` — put images in orbit around the reactor
- `ui_chrome` — show or hide rails, transcript, badges
- `ui_effect` — `glitch` | `pulse` | `scan` | `shake` | `flash`
- `ui_screen` — clear
- `ui_reset` — back to defaults

So *"make it red, hide the systems list, put that render in orbit"* is a spoken
command.

### The heads-up display

JARVIS authors panels with a `display` tool against a fixed `.hud-*` design
system. The browser sanitises the markup (DOMPurify, a class allowlist and a
strict CSP) before rendering. Rich media works — images, `<video>`, and
YouTube/Vimeo embeds. Remote images and video are fetched **server-side** through
the bridge (`/img` and `/media`, both SSRF-guarded), so hotlink-blocked news
thumbnails still appear and the page never beacons your IP to a host the model
chose.

---

## Controls

| Key / phrase | Does |
|---|---|
| **"Hey Jarvis"** | Wake him |
| **Space** | Talk without the wake word |
| Just speak | Interrupt him mid-sentence (barge-in) |
| **V** | Cycle the browser voice |
| **Escape** | Stand down (during start-up: skip the boot sequence) |
| Command bar | Type instead of talking; Enter sends it |
| **D** | Live diagnostics panel |
| **T** | One-line audio self-test |

---

## The boot sequence

Power-up plays a four-beat Iron Man start-up (`src/ui/Boot.tsx`): an
"INITIATING SYSTEM" status bar with a segmented progress bar and boot log; then
concentric reticle rings resolving into "J.A.R.V.I.S"; then a suit schematic;
then the triangular arc reactor lighting up — with a start-up sound under it
(`public/audio/boot-music.mp3`).

---

## Configuration

Everything is optional in bridge mode. Put settings in `.env.local` (copy
`.env.example`). The page reads the `VITE_*` values and the bridge reads the
rest. Anything already set in your shell wins over the file. The bridge refuses
`ANTHROPIC_API_KEY` from the file, because it would quietly switch you from your
subscription to API billing.

### Renaming him

One line in `.env.local` renames him everywhere: the wake word, the wordmark,
the tab title, the transcript and the way he refers to himself.

```
JARVIS_NAME=Friday
JARVIS_WAKE_ALIASES=fridey,frida   # optional: how speech recognition mishears it
JARVIS_TAGLINE=                    # optional: the line under the wordmark
```

A single word is dotted out like the original (`F.R.I.D.A.Y.`), and a name of
several words is shown as written (`MY DUDE`). Pick a name with two or more
syllables that you don't say in ordinary conversation: it is also the wake word.
Restart `npm start` after changing it.

### Bridge

| Variable | Default | Effect |
|---|---|---|
| `JARVIS_BRIDGE_PORT` | `8787` | Port for the WebSocket + HTTP endpoints |
| `JARVIS_MODEL` | `claude-opus-5` | Model to run |
| `JARVIS_EFFORT` | `high` | Reasoning effort |
| `JARVIS_FAST_MODEL` | `claude-sonnet-5` | Model for short, simple turns |
| `JARVIS_FAST_EFFORT` | `low` | Effort for those turns |
| `JARVIS_ROUTING` | on | `off` sends every turn to `JARVIS_MODEL` |
| `JARVIS_RESUME` | on | `off` starts every page load as a new conversation |
| `JARVIS_RESUME_HOURS` | `12` | How long after the last turn a conversation still resumes |
| `JARVIS_HOME` | `~/.jarvis` | Where the saved conversation id and `memory.md` live |
| `JARVIS_ALLOW_WRITES` | off | `1` runs effectful tools without asking (see below) |
| `JARVIS_CONFIRM` | on | `off` refuses effectful tools instead of asking you |
| `JARVIS_ALLOW_MONEY` | off | `1` allows orders, trades, payments, invoices, each confirmed |
| `JARVIS_ALLOWED_ORIGINS` | local dev | Extra WebSocket origins to accept |
| `JARVIS_ALLOW_NO_ORIGIN` | off | Accept connections with no `Origin` header |
| `JARVIS_FILE_ROOTS` | — | Roots the `/file` endpoint may serve from |
| `JARVIS_VOICE_ID` | — | ElevenLabs voice id |
| `ELEVENLABS_API_KEY` | — | Optional; enables the ElevenLabs voice + Scribe |

### Frontend (`.env.local`)

| Variable | Effect |
|---|---|
| `VITE_BACKEND` | `bridge` (default) or `direct` |
| `VITE_BRIDGE_URL` | Where to reach the bridge |
| `VITE_TTS_ENGINE` | `system` or `kokoro` |
| `VITE_KOKORO_VOICE` | Voice for the Kokoro engine |
| `VITE_USE_ELEVENLABS` | Force the ElevenLabs voice on |
| `VITE_ANTHROPIC_API_KEY` | Direct mode only |

### Adding an ElevenLabs key

You do not have to touch a flag. Any one of these works, checked in this order:

- `ELEVENLABS_API_KEY` in the shell that runs `npm start`
- `ELEVENLABS_API_KEY=...` in `.env.local`
- the key in your `elevenlabs` MCP server's env in `~/.claude.json`

The startup line says which one it used: `speech via ElevenLabs (key from .env.local)`.

Either way, `/health` starts reporting the capability, the browser picks it up on
the next boot, and both the voice and transcription upgrade automatically. If
the key turns out not to work (revoked, no Speech to Text permission, out of
credit), the page switches to the browser's own recognition on the first
rejection instead of going deaf. The terminal says why.

---

## Proactive alerts

He speaks up without being asked:

- **Before a meeting.** *"Sir, the design review starts in ten minutes."*
- **When mail needs you.** *"Sir, Sarah Chen has written about the contract
  signature. It looks like it needs you."* Only real people asking for
  something soon count. Newsletters, notifications, receipts and marketing never
  do.

Each alert also appears as a card at the top right, with a countdown for
meetings, and stays there until you dismiss it. He never talks over his own
answer or a confirmation; the alert waits until he's free. Say **"mute alerts"**
or **"do not disturb"** to silence them (the cards still appear) and **"resume
alerts"** to bring them back.

How it works: a separate watcher session, on the quick model and read-only,
checks your calendar every 20 minutes and your mail every 15. Each meeting gets
a local timer, so the alert fires on the minute without another model call. It
runs only while a Jarvis page is open, 8:00–19:00 on weekdays by default.
Measured cost: about $0.20 when the watcher starts, then roughly $0.01–0.05 per
check. The terminal logs each check and its cost.

| Variable | Default | Effect |
|---|---|---|
| `JARVIS_ALERTS` | on | `off` disables the watcher entirely |
| `JARVIS_ALERT_LEAD_MIN` | `10` | Minutes before a meeting to warn |
| `JARVIS_ALERT_CAL_MIN` | `20` | How often the calendar is checked |
| `JARVIS_ALERT_MAIL_MIN` | `15` | How often mail is checked (`0` turns mail alerts off) |
| `JARVIS_ALERT_HOURS` | `8-19` | Local hours the watcher runs |
| `JARVIS_ALERT_WEEKENDS` | off | `on` includes Saturday and Sunday |

---

## Memory

**The conversation survives a reload.** Refresh the page, lose the connection
or restart `npm start`, and he carries on where you left off. The last few
exchanges come back on screen, and "move it to four" still knows what "it"
is. A conversation stays resumable for 12 hours after you last spoke
(`JARVIS_RESUME_HOURS`). Say or type **"start fresh"** (or "new conversation",
"start over") to end one on purpose.

**Lasting notes.** Tell him *"remember that Sarah is my assistant"*, or state a
preference plainly, and it goes into `~/.jarvis/memory.md`. Every new
conversation starts knowing it. *"Forget…"* removes a note, and *"what do you
know about me?"* lists them. It's a plain Markdown file, one fact per line, so
edit or delete it freely. He refuses to store anything that looks like a
password, PIN, code, key, or card or account number, even when asked.

Delete `~/.jarvis` and he forgets everything. `JARVIS_RESUME=off` makes every
page load a new conversation; the notes still apply.

---

## Enabling actions

Lookups, search and generation run freely. Anything that **changes something**
(sending, replying, forwarding, creating or answering a calendar event, sharing
a file) is **put to you first**:

1. He says what he's about to do, and a card comes up with the service, the
   action and the details that matter: who it goes to, the subject, when.
2. He asks "Shall I proceed, sir?" Answer **yes** or **no** by voice, type it in
   the command bar, or press the button.
3. A yes starts a **4-second undo window**. Say "cancel" or "undo", or press
   Undo, and it doesn't happen. Silence for 45 seconds counts as no.

The decision is made in `decideTool()` in `bridge/server.mjs` (allow, confirm or
deny). The bridge sets `settingSources: []`, so filesystem settings and any
global `bypassPermissions` cannot override it.

What runs without asking, beyond lookups: **drafting** email (it lands in
Drafts, nothing is sent) and **music and speaker control** (Sonos, Spotify).

**Money** is a separate tier. Placing or cancelling orders, trades, payments,
invoices and transfers are refused unless you set `JARVIS_ALLOW_MONEY=1`, and
even then each one is confirmed. Reading balances, positions, orders and
invoices is always allowed.

**Shell and file changes** (Bash, Write, Edit) are never offered for
confirmation, because a spoken summary can't convey them safely. They need
`JARVIS_ALLOW_WRITES`.

`JARVIS_CONFIRM=off` goes back to refusing everything that changes something.

To let everything run without asking (phone, browser driving, shell, sending),
run the bridge this way instead:

```bash
npm run bridge:writes
```

> Read `decideTool()` before you do. *"Hey Jarvis, clean up my downloads folder"*
> means something rather different with writes enabled.

---

## Troubleshooting

**I can't hear him, or he can't hear me.** Press **D** for the diagnostics panel
— it states plainly whether he is hearing you and whether he is producing sound.
Press **T** for a one-line audio self-test.

**No voice at all.** You must be in **Chrome or Edge**, in a **real browser
window** (not an embedded preview), and you must have **allowed the microphone**.

**He hears you but never answers.** Look at the `npm start` terminal. If it says
Claude Code is not logged in, run `claude`, type `/login`, choose your Claude
subscription account, and restart. JARVIS also says this out loud now instead of
waiting silently. A `model ... is not available` line means your account can't
use the configured model: `JARVIS_MODEL=claude-sonnet-5 npm start`.

**Diagnostics show `stt 401` / `stt 403`.** Your ElevenLabs key was rejected.
JARVIS has already switched to browser speech. The terminal line says which key
it used and where it came from.

**Bridge not reachable.** Check that `npm run bridge` is still running in its
terminal, and that nothing else is holding port `8787`. `EADDRINUSE` means an
old copy is still running: `kill $(lsof -ti :8787)`.

---

## Security

All of this lives in `bridge/server.mjs`:

- The WebSocket accepts only local dev origins (add more with
  `JARVIS_ALLOWED_ORIGINS`).
- `/file`, `/img` and `/media` validate the scheme, confine to allowed roots,
  resolve the real path, and refuse private and loopback addresses (SSRF guard).
- The tool gate (`decideTool`) is default-deny for effectful MCP tools.
- A strict CSP in `index.html`; model-authored panel HTML is sanitised.

---

## Credits & licence

MIT.

The boot sound and any tracks in `public/audio/` ship with the project for the
demo. If you go on to monetise something built on this, clearing the rights to
that audio is your responsibility.
