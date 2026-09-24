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

Changing the code? Start with [ONBOARDING.md](ONBOARDING.md), a map of how it
is built and where to look.

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

### Start at login (Mac)

Have him running whenever your Mac is, with no terminal left open:

```bash
npm run autostart:install                              # opens in your default browser
npm run autostart:install -- --browser "Microsoft Edge"  # or a specific one
```

He starts now and at every login, restarts himself if he crashes, and opens the
page once it is ready. Click **INITIALISE** as usual: browsers need that click
before they allow the microphone.

| Command | What it does |
|---|---|
| `npm run autostart:status` | Installed? Running? The last few log lines |
| `npm run autostart:logs` | Follow the log (`~/.jarvis/logs/jarvis.log`) |
| `npm run autostart:restart` | Pick up a changed `.env.local` or a `git pull` |
| `npm run autostart:stop` | Stop until the next login |
| `npm run autostart:update` | Pull and apply the latest version now, without waiting |
| `npm run autostart:uninstall` | Stop, and never start at login again |

Install options: `--no-open` skips opening the browser, `--writes` lets the
login copy take actions (the same as `npm start -- --writes`), and `--no-update`
turns off the automatic updates described below.

#### It keeps itself up to date

Once installed, you never have to `git pull` again. A second small background
job checks GitHub every five minutes. When something new has been merged to
`main`, it:

1. **waits until he's quiet**, meaning no page is open or nothing has been
   said for 15 minutes (`JARVIS_UPDATE_IDLE_MIN`). An update reloads the page,
   and a reloaded page needs a click on INITIALISE before the microphone works
   again.
2. stops him, pulls the new version, and installs any new dependencies. Only
   what changed is installed, so this takes seconds.
3. starts him again and checks that he actually came up. The page you had
   open reloads by itself, and a macOS notification says what changed.
4. **if the new version doesn't start, puts the old one back** and skips that
   version until a newer one is merged.

It only ever fast-forwards `main`. It leaves the folder alone, and
`autostart:status` says why, when the folder is on another branch, has
commits that aren't on GitHub, or has edited files. If you have stopped him
with `autostart:stop`, it pulls the new version but doesn't start him.
`JARVIS_AUTO_UPDATE=off` in `.env.local` turns it off, and
`npm run autostart:update` applies an update immediately. Only one update
runs at a time. Its log is `~/.jarvis/logs/update.log`, and it names each step.

A login item does not read your `~/.zshrc`, so **put settings in `.env.local`,
not in shell exports**. The installer names any `JARVIS_*`, `ELEVENLABS_*` or
`VITE_*` variables it finds only in your shell. It never copies their values
anywhere. It writes one file, `~/Library/LaunchAgents/local.jarvis.assistant.plist`,
which records this folder and your `node`. If you move the folder or switch
Node versions with nvm, run install again. `autostart:status` tells you when
that is needed.

With auto-start on, typing `npm start` as well just says he is already running,
instead of fighting the other copy for the port.

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

## Protective mail and calendar (Power Automate)

Protective's Microsoft 365 isn't reachable with a connector, so Jarvis reads it
the same way the emailed daily briefing does: through its Power Automate flows.
Those cover the inbox, the calendar, To Do and flagged mail. Two more flows let
him save drafts and send, and the meeting recap's two To Do flows let him add
tasks.

The flow links carry a signature, so they are credentials. They live in a file
on this Mac, never in the repository. Jarvis looks in this order:

1. `JARVIS_PA_ENDPOINTS=/path/to/pa_endpoints.json` in `.env.local`
2. `~/.jarvis/power-automate.json`
3. the daily briefing's own `pa_endpoints.json`, if OneDrive syncs
   `Desktop/daily-briefing-export` to this Mac

The simplest setup is to copy the briefing's file into place and lock it down:

```bash
mkdir -p ~/.jarvis
cp "/path/to/daily-briefing-export/pa_endpoints.json" ~/.jarvis/power-automate.json
chmod 600 ~/.jarvis/power-automate.json
```

To let him add meeting action items to To Do, add `"todo_add"` (Daily Meeting
Actions) and `"todo_waiting"` (Waiting On Others) to that file. Their values
are the two To Do flow links from the Daily Meeting Recap task. Only the eight
known flows are read from the file (plus an optional `"sent_email"`, see
below); anything else in it, such as the
briefing's Jira credentials, is ignored. After changing the file, run
`npm run autostart:restart`.

Reading needs no confirmation. Saving a draft doesn't either; drafts are never
sent. Sending mail and adding tasks are confirmed on screen first, and a
batch of tasks is confirmed once.

## Your morning brief

"Brief me" answers from a brief built ahead of time with the same rules as
the emailed daily briefing. It reads Protective, SCG and To Do, ranks what is
being asked of you (not what arrived), and leads with a "focus first" line. The
first time you open Jarvis on a weekday morning (5–11 by default,
`JARVIS_BRIEF_HOURS`), he builds it in the background and says it's ready. It
is cached for 90 minutes; "refresh my brief" rebuilds it. `JARVIS_BRIEF=off`
turns off the morning offer.

## Meetings: prep and follow-through

- **Before:** about five minutes before each meeting heads-up, the watcher
  gathers where things stand with those people. It uses the last Granola notes,
  the latest mail thread and open Jira items. The heads-up says it in a
  sentence, and the alert card lists the points. `JARVIS_MEETING_PREP=off`
  turns this off.
- **On demand:** "prep me for my next meeting".
- **After:** "what did we agree?" reads the meeting from Granola. He then offers
  to add the action items to To Do: your own go to Daily Meeting Actions, and
  what others owe you goes to Waiting On Others.

- **Who you're meeting:** "who am I meeting at two?", "tell me about Chris".
  For each person he gives their role, your last three interactions (Granola,
  mail), what you owe them, what they owe you and what's open. Meeting prep
  now includes what's owed either way too.

## Closing the loop: end of day and promises

- **Wrap-up.** Say "wrap up my day" and he compares the day against this
  morning's brief: what got done, what slipped, the replies you still owe and
  the first thing for tomorrow. He then offers to put the loose ends on To Do,
  as one confirmed batch. On weekday evenings (17–20, `JARVIS_WRAP_HOURS`) he
  builds it in the background and says it's ready. `JARVIS_WRAP=off` turns off
  that offer.
- **Promises.** Jarvis keeps a ledger in `~/.jarvis/commitments.json` of what
  you said you'd do ("I'll send you the roadmap by Friday") and what others
  said they'd do for you. Every few hours (`JARVIS_COMMIT_SCAN_HOURS`, 4) he
  scans Granola notes, sent mail and Waiting On Others for new promises, and
  for ones that have been kept.
  - The day before one of yours is due, he reminds you once.
  - When one of theirs is a day late, he asks whether to draft a nudge.
    "Yes" saves the draft.
  - You can tell him directly: "I told Chris I'd send the roadmap by Friday",
    "what do I owe Chris?", "who owes me what?", "that's done".
  - `JARVIS_COMMITMENTS=off` turns the ledger's scans and nudges off.
- **Protective sent mail (optional).** Promises you made by email at SCG are
  read through the Microsoft 365 connector. For Protective, add a
  `"sent_email"` flow to `~/.jarvis/power-automate.json`: a copy of the Inbox
  flow pointed at Sent Items. Without it, Protective promises are still picked
  up from meeting notes.

## Focus

"I'm heads-down until two" or "focus for ninety minutes" holds alerts back. A
calendar block titled Focus time, Heads down, Deep work or Do not book does the
same on its own.

- **What still gets through:** mail from your VIPs, production incidents and
  meeting heads-ups.
- **The rest:** held, then read back as one digest when you say "I'm back" or
  the block ends.
- **VIPs:** "add Chris to my VIPs" adds someone. The list is stored in
  `~/.jarvis/settings.json` and can also be set with `JARVIS_FOCUS_VIPS`.
- **Meetings too:** set `JARVIS_FOCUS_HOLD_MEETINGS=on` to hold meeting
  heads-ups as well.
- **Teams status:** the Microsoft 365 connector can't set presence, so Jarvis
  doesn't change it.

## The portfolio pulse

Ask "what's blocked across the portfolio?", "which team is behind?" or "what
changed since yesterday?". Jarvis reads two sources:

- **Jira, live,** through the Atlassian connector, for projects NI and RPT
  (`JARVIS_JIRA_PROJECTS`).
- **The portfolio dashboards saved on this Mac,** which carry both Jira and
  Azure DevOps data, pipelines included. That is how Azure DevOps gets in
  without any new credentials. He finds `*dashboard*.html` files in the folders
  under `~/Claude Code Applications` and `portfolio_dashboard*.html` in
  Downloads, Desktop or Documents. Set `JARVIS_PORTFOLIO_FILES` (paths
  separated by `;`) to choose them instead.

Each pulse is saved as that day's snapshot, so he can say what changed since
yesterday.

While a page is open, the watcher checks Jira every hour
(`JARVIS_PORTFOLIO_ALERT_MIN`, 0 turns it off):

- A newly blocked high-priority item is said once.
- A sprint whose time has run well ahead of its work (25 points by default,
  `JARVIS_SPRINT_SLIP_PCT`) is flagged once a day.

The alert card lists every newly blocked ticket on its own line: key, title,
and who has it. The list scrolls if it's long. Each key opens the ticket in a
new tab, and so do the keys on the pulse's blade. Links are only ever built to
your Jira Cloud site and Azure DevOps organisation. Jarvis learns their
addresses from the Jira connector on his first check. To set them yourself,
add `JARVIS_JIRA_URL=https://yoursite.atlassian.net` and
`JARVIS_ADO_URL=https://yourorg.visualstudio.com` to `.env.local`.

## The weekly review

"Weekly review" (or "how did the week go?") covers:

- wins, slips and risks;
- promises kept and late;
- where the week's meeting hours went, compared with your stated priorities;
- a draft weekly update for leadership, in Progress / Plans / Problems form.
  Say yes and it goes to your Protective Drafts.

Tell him your priorities once: "remember my priorities this quarter are the
APD rollout, vendor spend and hiring". On Friday afternoons (14–18,
`JARVIS_REVIEW_HOURS`) he builds the review in the background and says it's
ready. `JARVIS_REVIEW=off` turns off that offer.

The review draws on what the week left behind: each day's brief, wrap-up and
Protective meetings, kept for five weeks in `~/.jarvis/days`.

## Reports saved on this Mac

Hand him a `file://` link or a path, for example a generated dashboard, and he
reads it directly. He never opens it in the browser, which couldn't open such a
link anyway. A filter in the link, such as `#…&area=APD`, narrows what he reads
out. Only documents inside your home folder are read.

## Settings

Click **Settings** at the bottom right, or press **,** (comma). He stands down
while it's open.

- **Voice:** ElevenLabs or the Mac's own voice. Paste an ElevenLabs API key
  and it's checked with ElevenLabs, then saved to `.env.local`. He speaks with
  it straight away; reload once so he listens with it too. Pick any voice on
  your ElevenLabs account and preview it before you choose.
- **Listening:** how long he keeps listening after an answer before needing
  "hey Jarvis" again, from 0 (always say it) to 15 seconds, plus the wake
  word's status.
- **Display:** how the conversation reads.
  - **Clear** (the default) puts it on a solid panel in the Mac's own reading
    font, dims the reactor and scanlines behind it, and makes the lighter lines
    in the brief and alert cards easier to read. Anything Jarvis puts on
    screen opens in the space above the conversation, never over it.
  - **Cinematic** is the original look.
  - **Large text** scales up the conversation, the cards and what he shows.
  - These are remembered in this browser.
- **About:** the version that's actually running. Check this first when a fix
  "didn't work": auto-update may not have applied it yet.

## Configuration

Everything is optional in bridge mode. Put settings in `.env.local` (copy
`.env.example`). The page reads the `VITE_*` values and the bridge reads the
rest. Anything already set in your shell wins over the file. The bridge refuses
`ANTHROPIC_API_KEY` from the file, because it would quietly switch you from your
subscription to API billing.

### Wake word on your own machine

He listens for his name **on your Mac**, with no setup. Without this, "Jarvis"
would be found by transcribing everything the microphone hears while he's
asleep and searching the text for it. Every sentence said in the room would
go off to be transcribed: to Google with the browser's recognition, or to
ElevenLabs with Scribe, which is billed. And anything that transcribes as
"Jarvis" would wake him.

Instead, the sound of the phrase is recognised in the page, in WebAssembly, by
[openWakeWord](https://github.com/dscripka/openWakeWord). Nothing leaves the
machine until he's awake, nothing is billed while he sleeps, and he
false-triggers far less.

- **Say "hey Jarvis".** A plain "Jarvis", "OK Jarvis" or "hi Jarvis" on its own
  works too. "Hey Jarvis, what's the weather" in one breath goes straight to
  the question, without a greeting over the top of it.
- **Check it:** press **D**. The `wake word` row says
  `on-device (openWakeWord, "hey Jarvis")`. If it can't start, the row says why
  and he falls back to the text search, so he can always be woken.
- **Tune it:** `VITE_WAKE_SENSITIVITY` (default `0.5`). Higher catches quieter
  wake words, and false-triggers more.
- **Licence:** the "hey Jarvis" model is **CC BY-NC-SA 4.0: personal,
  non-commercial use only**. See `public/oww/README.md`.

**Porcupine (optional).** With a Picovoice AccessKey
(`VITE_PICOVOICE_ACCESS_KEY` in `.env.local`), Porcupine is used instead. It
answers to plain "Jarvis" in any sentence and allows commercial use. Picovoice
now reviews each sign-up, so this is for once you're approved. If the key
doesn't work, openWakeWord takes over.

**Another name?** "Jarvis" is the only name that works out of the box.
- With openWakeWord: train a model (see openWakeWord's docs), put the `.onnx`
  in `public/`, and set `VITE_WAKE_MODEL=/my-name.onnx`.
- With Porcupine: the built-in words (Computer, Terminator, Bumblebee…) work
  as they are. Anything else needs a `.ppn` trained at console.picovoice.ai
  and `VITE_WAKE_KEYWORD_FILE=/my-name.ppn`.

`VITE_WAKE_ENGINE=speech` turns all of this off and uses the text search.

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
| `VITE_FOLLOW_UP_SECONDS` | How long he keeps listening after an answer without "hey Jarvis" (default `6`, `0` = always say it) |
| `VITE_WAKE_SENSITIVITY` | `0`–`1`. Higher catches more and false-triggers more (see below) |
| `VITE_WAKE_MODEL` | An openWakeWord `.onnx` in `public/` for a name other than Jarvis |
| `VITE_PICOVOICE_ACCESS_KEY` | Use Porcupine for the wake word instead (optional) |
| `VITE_WAKE_KEYWORD_FILE` | A Porcupine `.ppn` in `public/` for a name that isn't built in |
| `VITE_WAKE_ENGINE` | `speech` turns the on-device wake word off |
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

**"Browser control unavailable".** Jarvis drives your real browser through the
Claude extension's helper, the same one Claude Code uses. The browser only
starts that helper if it is registered for that browser. Run
`npm run browser:doctor` to see which browsers have it and whether it's
running. If you use Edge (or Brave or Arc) and it isn't registered there, run
`claude --chrome` once, or `npm run browser:doctor -- --fix`. Then quit and
reopen the browser and open the Claude extension once.

**Bridge not reachable.** Check that `npm run bridge` is still running in its
terminal, and that nothing else is holding port `8787`. `EADDRINUSE` means an
old copy is still running: `kill $(lsof -ti :8787)`.

**"Bridge connection lost — reconnecting."** The bridge restarted or stopped.
The page keeps retrying and clears the message by itself when the bridge is
back. If it changes to "The bridge isn't running", run
`npm run autostart:restart` (or `npm start`). With auto-start installed, an
`npm start` left open in a Terminal no longer strands you when you close it:
the login copy waits in the background and takes over.

**Started at login but not answering.** Run `npm run autostart:status` and read
the log lines it shows. The usual causes: Claude Code logged out (run `claude`,
`/login`, then `npm run autostart:restart`), or a setting that lives only in your
shell and not in `.env.local`.

**An update didn't arrive.** `npm run autostart:status` shows the last check and
anything pending, for example "waiting until he has been quiet" or "files edited
in this folder". `npm run autostart:update` applies it straight away.

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
