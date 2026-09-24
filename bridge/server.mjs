/**
 * JARVIS local bridge.
 *
 * Runs the Claude Agent SDK — Claude Code as a library — and exposes one turn
 * of conversation over a WebSocket. The browser stays the face and the voice;
 * this process is the brain and the hands.
 *
 * Two things this buys over calling the Claude API from the browser:
 *   1. No API key. It authenticates exactly the way `claude` does, off your
 *      existing login, and bills to that same account.
 *   2. Every MCP server in your Claude Code config is available, including the
 *      local stdio ones a browser could never reach — higgsfield, elevenlabs,
 *      android, playwright, palmier-pro and the rest.
 *
 *   node bridge/server.mjs
 */

// First, so .env.local is in process.env before anything below reads it.
import { WebSocketServer } from 'ws'
import { query, getSessionMessages } from '@anthropic-ai/claude-agent-sdk'
import { alertsSummary, startAlerts } from './alerts.mjs'
import {
  carriedPrompt,
  forgetSession,
  JARVIS_HOME,
  MISSING_CONVERSATION,
  MEMORY_FILE,
  memoryPrompt,
  memoryServer,
  recentTurns,
  saveSession,
  sessionOptions,
} from './memory.mjs'
import { displayServer } from './panels.mjs'
import { protectiveConfigured, protectiveServer } from './protective.mjs'
import { briefHealth, briefServer, maybeOfferBrief } from './briefing.mjs'
import { backgroundPaused, onCapReached, recordSpend, spendSummary } from './spend.mjs'
import { localFilesServer } from './localfiles.mjs'
import { loopServer, logMeetings, maybeOfferWrap } from './loop.mjs'
import {
  closeCommitment,
  commitmentOpen,
  commitmentsEnabled,
  dueNudges,
  scanCommitments,
  scanDue,
} from './commitments.mjs'
import {
  closeKind,
  findItem,
  keepAlert,
  listStratum,
  markAllSeen,
  onStratumChange,
  parseWhen,
  registerResolver,
  stratumServer,
  updateItem,
  wokenSince,
} from './stratum.mjs'
import { focusGate, focusServer, focusState, startFocus, vips } from './focus.mjs'
import { portfolioServer } from './portfolio.mjs'
import { maybeOfferReview, reviewServer } from './review.mjs'
import { firstToday, inWindow } from './days.mjs'
import { onToday, refreshToday, setPortfolio, setWatcherEvents, todayView } from './today.mjs'
import { describeStep, JOB_PHRASE } from './steps.mjs'
import { appendTurn, readTranscript, searchTranscripts, transcriptDays } from './transcript.mjs'
import { uiServer } from './ui.mjs'
import { browserDiagnosis, chromeAvailable, chromeServer } from './chrome.mjs'
import { visionServer } from './vision.mjs'
import {
  connectorBlocked,
  connectorDenylist,
  connectorsSummary,
  discoverConnectors,
  recordConnectors,
  statusSettled,
} from './connectors.mjs'
import {
  conversationDisallowed,
  decideTool as decide,
  intentGate,
  MONEY_VERB,
  mcpServerOf,
  mcpToolOf,
  readOnlyTool as readOnly,
} from './policy.mjs'
import { createStreaks, stuckAlert } from './health.mjs'
import { ALLOW_NO_ORIGIN, EXTRA_ORIGINS, PORT, createHttpServer, elevenSource, originAllowed } from './http.mjs'
import { NAME, SYSTEM_PROMPT } from './prompt.mjs'
import { homedir } from 'node:os'
import { chmodSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'


/**
 * A crash here takes the whole assistant down mid-sentence, and most of what
 * can reject is out of our hands — a socket dying under a write, an upstream
 * fetch aborting. Log it and keep serving; the turn that failed will surface
 * its own error to the browser.
 */
process.on('unhandledRejection', (err) => {
  console.error('[jarvis] unhandled rejection:', err)
})


/**
 * Voice is a bad interface for a confirmation dialog: there is no window to
 * click and the model can't pause for one. So the bridge decides.
 *
 * Read-only and generative tools run freely. Anything that writes to disk,
 * runs a shell, or changes the world waits for JARVIS_ALLOW_WRITES=1. Start
 * without it, and turn it on once you trust what you're demoing.
 */
const ALLOW_WRITES = process.env.JARVIS_ALLOW_WRITES === '1'

/**
 * The orchestrator model. Override with JARVIS_MODEL to trade quality for pace
 * — claude-sonnet-5 is noticeably snappier on camera if Opus feels slow.
 */
const MODEL = process.env.JARVIS_MODEL ?? 'claude-opus-5'

/**
 * How hard the model thinks before answering.
 *
 * This was 'low', on the reasoning that a voice assistant is judged on latency
 * — and that is true right up until the answer is thin. Low effort scopes the
 * work tightly to what was literally asked: fewer tool calls, less
 * cross-referencing, no second look. On a model of this tier that is leaving
 * most of it on the table.
 *
 * 'medium' is the compromise worth having here. It reasons and reaches for
 * tools noticeably more than 'low' while still answering inside the window a
 * spoken conversation tolerates. Raise it to 'high' or 'xhigh' when quality
 * matters more than pace; drop back to 'low' when filming and every second of
 * dead air shows.
 */
const EFFORT = process.env.JARVIS_EFFORT ?? 'high'

/**
 * Two tiers, chosen per question.
 *
 * Measured on this bridge, one Opus turn at high effort costs $0.30–0.40 —
 * the same for "what time is it" as for "compare these three offers". Most of
 * what is said to a voice assistant is the first kind. So short, simple turns
 * go to a faster, cheaper model at low effort, and anything that asks for
 * research, writing, analysis, planning or a briefing — or simply runs long —
 * goes to the main model. The conversation carries across: it is one session,
 * and only the model answering the next turn changes.
 *
 * JARVIS_ROUTING=off keeps every turn on JARVIS_MODEL.
 */
const FAST_MODEL = process.env.JARVIS_FAST_MODEL ?? 'claude-sonnet-5'
const FAST_EFFORT = process.env.JARVIS_FAST_EFFORT ?? 'low'
const ROUTING = process.env.JARVIS_ROUTING !== 'off' && FAST_MODEL !== MODEL
const ROUTES = {
  deep: { tier: 'deep', model: MODEL, effort: EFFORT },
  fast: { tier: 'fast', model: FAST_MODEL, effort: FAST_EFFORT },
}
const DEEP_ASK =
  /\b(brief(ing)?|research|analy[sz]\w*|compare|comparison|plan\w*|strateg\w*|write|draft\w*|summar\w*|review\w*|investigat\w*|explain why|generate|create|build|design|portfolio|report|prepare|decide|recommend\w*|pros and cons)\b/i
const DEEP_WORDS = 18

function routeFor(text) {
  if (!ROUTING) return ROUTES.deep
  const words = text.trim().split(/\s+/).filter(Boolean).length
  return DEEP_ASK.test(text) || words > DEEP_WORDS ? ROUTES.deep : ROUTES.fast
}


/**
 * Every MCP server Claude Code has configured, read out of its own config.
 *
 * This does two jobs. The HUD wants the names while the boot animation plays,
 * and the agent doesn't emit its init message — and therefore its server
 * list — until the first user message flows through, which is far too late.
 * More importantly, this bridge turns filesystem settings off (see
 * settingSources below) and the SDK stops discovering these servers on its
 * own, so handing them over explicitly is what keeps the local stdio ones —
 * the whole reason the bridge exists — in play.
 *
 * Only the global block and the home-directory project scope, because
 * homedir() is our cwd. That makes the list a close but not exact match for
 * the agent's own: the 'ready' sent on connect comes from here and the second
 * one, sent from the init message a turn later, carries live status. Expect
 * the two to differ, and treat the later one as authoritative.
 */
function configuredServers() {
  try {
    const cfg = JSON.parse(
      readFileSync(join(homedir(), '.claude.json'), 'utf8'),
    )
    return {
      ...(cfg.mcpServers ?? {}),
      // Servers scoped to the home directory apply too, since that's our cwd.
      ...(cfg.projects?.[homedir()]?.mcpServers ?? {}),
    }
  } catch {
    return {}
  }
}

const MCP_SERVERS = configuredServers()

/**
 * ~/.jarvis holds the session id, remembered notes, the promise ledger, the
 * conversation history, the logs and the Protective flow URLs. Owner-only,
 * whatever the umask made the folder: a closed folder covers every file in it,
 * including ones written with the default mode.
 */
try {
  mkdirSync(JARVIS_HOME, { recursive: true })
  chmodSync(JARVIS_HOME, 0o700)
} catch (err) {
  console.warn(`[jarvis] could not restrict ${JARVIS_HOME}: ${err.message}`)
}

/** `claude.ai Google Calendar` -> `Google Calendar`, for the HUD and the log. */
const displayName = (name) =>
  String(name)
    .replace(/^claude\.ai /, '')
    .replace(/_/g, ' ')
    .replace(/^[a-z]/, (c) => c.toUpperCase())

/**
 * The interface's own in-process servers. They are how JARVIS draws on the
 * screen, not systems he is linked to, so the SYSTEMS rail leaves them out.
 */
const INTERNAL_SERVERS = new Set([
  'jarvis', 'jarvis_ui', 'jarvis_chrome', 'jarvis_eyes', 'jarvis_memory', 'jarvis_brief', 'jarvis_files',
  'jarvis_loop', 'jarvis_focus', 'jarvis_portfolio', 'jarvis_review', 'jarvis_stratum',
])

/**
 * The SDK's status words, as the rail shows them. A server that needs signing
 * in again is kept on the list — marked, not dropped — because a connector
 * that silently vanishes is the one nobody thinks to go and fix.
 */
const RAIL_STATUS = {
  connected: 'live',
  pending: 'pending',
  'needs-auth': 'auth',
  failed: 'failed',
}

/** The rail: [{ name, status }], no internals, no disabled, sorted, deduped. */
function railList(all) {
  const seen = new Map()
  for (const s of all) {
    if (INTERNAL_SERVERS.has(s.name) || s.status === 'disabled' || connectorBlocked(s.name)) continue
    const name = displayName(s.name)
    if (!seen.has(name)) seen.set(name, RAIL_STATUS[s.status] ?? 'pending')
  }
  return [...seen]
    .map(([name, status]) => ({ name, status }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** How long a new session's status poll waits for claude.ai connectors to be listed. */
const CONNECTOR_GRACE_MS = 20_000

/**
 * The first init message is the only place the full list — your claude.ai
 * connectors included — is known, so say what came up and what did not.
 * A connector that needs signing in again is otherwise just absent, and
 * "why can't he read my mail" has no answer on screen.
 */
let initLogged = false
function logServers(everything) {
  recordConnectors(everything)
  const left = everything.filter((s) => connectorBlocked(s.name)).length
  if (left) console.log(`[jarvis] ${left} claude.ai connectors left out by JARVIS_CONNECTORS`)
  const all = everything.filter((s) => !INTERNAL_SERVERS.has(s.name) && !connectorBlocked(s.name))
  const byStatus = (pred) => all.filter(pred).map((s) => displayName(s.name))
  const usable = byStatus((s) => s.status !== 'needs-auth' && s.status !== 'failed')
  const connectors = all.filter((s) => /^claude\.ai /.test(s.name)).length
  console.log(
    `[jarvis] ${usable.length} MCP servers available` +
      (connectors ? ` (${connectors} from your claude.ai connectors)` : '') +
      (usable.length ? `: ${usable.join(', ')}` : ''),
  )
  const auth = byStatus((s) => s.status === 'needs-auth')
  if (auth.length) {
    console.warn(
      `[jarvis] needs signing in again (claude.ai → Settings → Connectors): ${auth.join(', ')}`,
    )
  }
  const failed = byStatus((s) => s.status === 'failed')
  if (failed.length) console.warn(`[jarvis] failed to start: ${failed.join(', ')}`)
  if (!connectors && !process.env.ANTHROPIC_API_KEY) {
    console.warn(
      '[jarvis] no claude.ai connectors loaded. To use Gmail, Calendar and the rest,' +
        ' connect them at claude.ai → Settings → Connectors and log Claude Code in with' +
        ' that same account (`claude`, then /login).',
    )
  }
}

const ALLOW_MONEY = process.env.JARVIS_ALLOW_MONEY === '1'
const CONFIRM = process.env.JARVIS_CONFIRM !== 'off'

/** The switches the policy in policy.mjs is decided against, read once. */
const POLICY = { allowWrites: ALLOW_WRITES, allowMoney: ALLOW_MONEY, confirm: CONFIRM }
const decideTool = (name) => decide(name, POLICY)



/**
 * What a confirmation card says: which service, which action, and the few
 * fields that tell you whether it is the right one — who it goes to, what it
 * is called, when it happens, how much. Never the whole payload: a card is
 * read at a glance, and a full email body belongs in the draft, not here.
 */
const CONFIRM_FIELDS = [
  ['tasks', 'Tasks'],
  ['to', 'To'], ['recipients', 'To'], ['recipient', 'To'], ['cc', 'Cc'],
  ['subject', 'Subject'], ['title', 'Title'], ['summary', 'Title'], ['name', 'Name'],
  ['start', 'Starts'], ['startTime', 'Starts'], ['start_time', 'Starts'], ['date', 'Date'],
  ['end', 'Ends'], ['attendees', 'Guests'], ['symbol', 'Symbol'], ['side', 'Side'],
  ['quantity', 'Quantity'], ['amount', 'Amount'], ['price', 'Price'],
  ['body', 'Message'], ['text', 'Message'], ['message', 'Message'], ['content', 'Message'],
  ['note', 'Note'],
]

const clip = (v, n) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  const flat = String(s ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat
}

/** Tasks read as a list; addresses as a comma-separated line. */
const x_sep = (key) => (key === 'tasks' ? ' · ' : ', ')

function describeAction(toolName, input = {}) {
  const server = mcpServerOf(toolName)
  const service = server ? displayName(server.replace(/^claude_ai_/i, '')) : 'System'
  // A tool named after its own server ("protective_create_tasks") reads as
  // the action alone under that service's name.
  const bare = server ? mcpToolOf(toolName).replace(new RegExp(`^${server}[_-]`, 'i'), '') : toolName
  const verb = bare.replace(/[_-]+/g, ' ').trim()
  const details = []
  const seen = new Set()
  for (const [key, label] of CONFIRM_FIELDS) {
    const v = input?.[key]
    if (v == null || v === '' || seen.has(label)) continue
    seen.add(label)
    const value =
      typeof v === 'object' && !Array.isArray(v)
        ? (v.dateTime ?? v.date ?? v.email ?? JSON.stringify(v))
        : Array.isArray(v)
          ? v
              .map((x) => (typeof x === 'object' ? (x.email ?? x.name ?? x.text ?? JSON.stringify(x)) : x))
              .join(x_sep(key))
          : v
    details.push({ label, value: clip(value, label === 'Message' || label === 'Tasks' ? 240 : 90) })
    if (details.length >= 5) break
  }
  return {
    service,
    action: verb,
    summary: `${service} · ${verb}${details[0] ? ` · ${details[0].value}` : ''}`,
    details,
    money: MONEY_VERB.test(verb),
  }
}



// One HTTP server for the speech proxy, media and settings (bridge/http.mjs)
// and the WebSocket upgrade.
const server = createHttpServer({
  mcpServers: MCP_SERVERS,
  status: () => ({ pages: pages.size, idleSeconds: Math.round((Date.now() - lastActivity) / 1000) }),
})

const wss = new WebSocketServer({
  server,
  // The handshake is the only place a page can be turned away, so it happens
  // here rather than after the socket is open. Rejections are logged loudly:
  // the likeliest cause is a dev server on an unexpected port, and a silent
  // 403 would look like the bridge simply isn't running.
  verifyClient: ({ origin, req }, done) => {
    const path = (req.url ?? '/').split('?')[0]
    if (path !== '/' && path !== '/ws') {
      console.warn(`[jarvis] rejected websocket on path ${path}`)
      return done(false, 403, 'Forbidden')
    }
    if (!originAllowed(origin)) {
      console.warn(
        `[jarvis] rejected websocket from origin ${origin ?? '(none)'}` +
          ' — set JARVIS_ALLOWED_ORIGINS to permit it',
      )
      return done(false, 403, 'Forbidden')
    }
    done(true)
  },
})
/**
 * Loopback only. Node's default is every interface, which put this socket on
 * the LAN — and the Origin check above only stops browsers, which tell the
 * truth about Origin; a script on another device on the same Wi-Fi can send
 * `Origin: http://localhost:5173` and drive the agent. The page and the bridge
 * always share a machine, so nothing legitimate is lost. JARVIS_BRIDGE_HOST
 * exists for anyone who deliberately wants the bridge reachable from elsewhere.
 */
const HOST = process.env.JARVIS_BRIDGE_HOST?.trim() || '127.0.0.1'
server.listen(PORT, HOST)

console.log(`[jarvis] bridge listening on ws://localhost:${PORT} (${HOST} only)`)
console.log(
  elevenSource()
    ? `[jarvis] speech via ElevenLabs (key from ${elevenSource()})`
    : '[jarvis] speech using the browser\'s own voice and recognition (no ElevenLabs key)',
)
console.log(
  ROUTING
    ? `[jarvis] model ${MODEL} · effort ${EFFORT} for deep turns; ${FAST_MODEL} · ${FAST_EFFORT} for quick ones`
    : `[jarvis] model ${MODEL} · effort ${EFFORT}`,
)
if (process.env.ANTHROPIC_API_KEY) {
  console.warn(
    '[jarvis] ANTHROPIC_API_KEY is set in this shell. Claude Code will bill that API key' +
      ' instead of your Claude subscription, and your claude.ai connectors (Gmail,' +
      ' Calendar, …) will not load. Unset it to use your subscription login.',
  )
}
{
  const notes = memoryPrompt().split('\n').filter((l) => l.startsWith('- ')).length
  console.log(
    `[jarvis] memory: ${notes} note${notes === 1 ? '' : 's'} in ${MEMORY_FILE}` +
      (process.env.JARVIS_RESUME === 'off' ? '; conversations start fresh' : '; recent conversations resume after a reload'),
  )
}
console.log(`[jarvis] ${alertsSummary()}`)
console.log(`[jarvis] ${connectorsSummary()}`)
// Learn the connector names before the first conversation starts, so it can
// leave out the ones JARVIS_CONNECTORS excludes. A no-op when it is unset.
void discoverConnectors().catch((err) => console.warn(`[jarvis] connector discovery failed: ${err.message}`))
if (ALLOW_MONEY) {
  console.warn('[jarvis] MONEY ENABLED — orders, payments and transfers are possible, each confirmed with you first')
}
console.log(
  ALLOW_WRITES
    ? '[jarvis] writes ENABLED — actions run without asking'
    : CONFIRM
      ? '[jarvis] actions that change things are confirmed with you first (yes / no, then a few seconds to undo)'
      : '[jarvis] writes disabled — set JARVIS_ALLOW_WRITES=1 to permit them, or JARVIS_CONFIRM=on to be asked',
)
// Asynchronous, so it lands a beat after the rest of the banner. Worth printing
// at all because an extension that is simply not running is indistinguishable
// at the tool boundary from one that is broken, and this is the one place the
// difference can be stated before anybody asks a question that depends on it.
void chromeAvailable().then((ok) => {
  console.log(
    ok
      ? `[jarvis] browser control ready${ALLOW_WRITES ? '' : ' (reading only — clicking and typing need JARVIS_ALLOW_WRITES=1)'}`
      : `[jarvis] browser control unavailable — ${browserDiagnosis()}`,
  )
})

console.log(
  '[jarvis] accepting local dev origins' +
    (EXTRA_ORIGINS.size ? ` plus ${[...EXTRA_ORIGINS].join(', ')}` : '') +
    (ALLOW_NO_ORIGIN ? ' and clients that send no origin' : ''),
)

/**
 * What to tell the browser when a turn ends badly. Plain sentences, because
 * whatever reaches the client is liable to be spoken.
 */
const RESULT_FAILURES = {
  error_during_execution: 'The turn failed part way through.',
  error_max_turns: 'The turn ran too long and was stopped.',
  error_max_budget_usd: 'The budget for this turn ran out.',
  error_max_structured_output_retries: 'The answer could not be assembled.',
  default: 'The turn ended without an answer.',
}

/**
 * API failures that no amount of retrying will fix.
 *
 * Measured on this SDK: with no valid login the CLI does not fail the turn, it
 * emits `api_retry` with error 'authentication_failed' and backs off, again
 * and again, for minutes. From the page that is indistinguishable from a slow
 * answer — the wake word works, the reactor listens, and JARVIS simply never
 * replies. So the first of these ends the turn, says what is wrong out loud,
 * and prints the fix where the person at the keyboard will see it.
 *
 * `spoken` is read aloud; `fix` goes to the terminal only.
 */
const FATAL_API_ERRORS = {
  authentication_failed: {
    spoken: "I'm afraid I'm not signed in to Claude on this machine. The fix is in the terminal.",
    fix: 'Claude Code is not logged in, or its login expired. Run `claude` in a terminal, type /login, choose your Claude subscription account, then restart Jarvis.',
  },
  oauth_org_not_allowed: {
    spoken: "I'm afraid this Claude organisation doesn't permit the login I'm using.",
    fix: 'Your Claude login belongs to an organisation that does not allow this. Run `claude`, then /login with a different account.',
  },
  billing_error: {
    spoken: "I'm afraid the Claude account has no usage or credit left.",
    fix: 'The Claude account is out of usage or credit. Check your plan at claude.ai/settings/usage. If you meant to use your subscription, make sure ANTHROPIC_API_KEY is not set in your shell.',
  },
  model_not_found: {
    spoken: "I'm afraid the configured model isn't available on this account.",
    fix: `The model "${MODEL}" is not available to this account. Restart with a different one, for example: JARVIS_MODEL=claude-sonnet-5 npm start`,
  },
}

/**
 * "Tuesday, 22 September 2026, 4:41 pm (America/Chicago)".
 *
 * The model has no clock. Without this, "what's on my calendar today" is a
 * guess at the date, and a guess in UTC at that — so every message carries
 * the machine's own idea of now, and the persona is told never to say it.
 */
function localNow() {
  const now = new Date()
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const when = now.toLocaleString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  })
  return `${when} (${zone})`
}

/**
 * Every open page, so an alert reaches whichever one is listening. The watcher
 * behind the alerts starts with the first page and then stays up: its session
 * is what keeps each check cheap.
 */
const pages = new Set()
let watcher = null

/**
 * When someone last spoke to him or he last answered. The auto-updater reads it
 * from /health and only restarts him once things have been quiet for a while,
 * because an update reloads the page and a reload needs a click to get the
 * microphone back — not something to spring on you mid-sentence.
 */
let lastActivity = Date.now()
const touch = () => {
  lastActivity = Date.now()
}
/**
 * What background readers may call: what the conversation may do without
 * asking, minus drafts — the conversation saves those without asking, but a
 * background job has no business writing anything at all.
 */
const readOnlyTool = (name) => readOnly(name, POLICY)

/** Servers for background readers: the configured ones plus Protective, read-only. */
const backgroundServers = () => ({
  ...MCP_SERVERS,
  ...(protectiveConfigured() ? { protective: protectiveServer({ readOnly: true }) } : {}),
})

/**
 * Alerts to every open page, through the focus guard: while he is heads-down
 * only VIPs, incidents and meeting heads-ups get through; the rest waits for
 * the digest.
 */
const toPages = (alert) => {
  console.log(`[jarvis] alert: ${alert.kind} — ${alert.title}`)
  // What came in, not what was said: the page may hold it (quiet hours), so
  // the history must not claim he said it aloud.
  appendTurn({
    role: 'alert',
    kind: alert.kind,
    text: `${alert.title}${alert.detail ? ` — ${alert.detail}` : ''}`,
  })
  recentAlerts.push({ at: Date.now(), line: alert.say ?? `${alert.title}${alert.detail ? ` — ${alert.detail}` : ''}` })
  while (recentAlerts.length > 10) recentAlerts.shift()
  for (const deliver of pages) deliver({ type: 'alert', alert })
}
/**
 * What was said unprompted lately, so "yes, draft it" straight after "Shall I
 * draft a nudge?" means something to the conversation, which did not hear it.
 */
const recentAlerts = []
const RECENT_ALERT_MS = 10 * 60_000
function alertContext(since) {
  const lines = recentAlerts.filter((a) => a.at > since && a.at > Date.now() - RECENT_ALERT_MS).map((a) => a.line)
  return lines.length ? `[Alerts you just spoke: ${lines.join(' | ')}]\n` : ''
}
const focusToPages = (focus) => {
  for (const deliver of pages) deliver({ type: 'focus', focus })
}
const focus = focusGate(toPages, focusToPages)
/**
 * Every alert is kept in the review column before focus decides whether it is
 * said now — so what focus holds back is on the list too, not only in the
 * digest. A reminder coming back from the column is not kept a second time.
 */
const broadcastAlert = (alert) => {
  if (!alert.fromStratum) keepAlert(alert)
  focus.deliver(alert)
}

/** The commitment scan, like the alert checks, speaks up once when it keeps failing. */
const jobHealth = createStreaks({
  onStuck: (job, n, reason) => {
    console.warn(`[jarvis] ${job} has failed ${n} times running; telling the user`)
    broadcastAlert(stuckAlert(job, n, reason))
  },
})
// A promise alert closes itself once the ledger has the promise kept.
registerResolver('commitment', commitmentOpen)
onStratumChange((items) => {
  for (const deliver of pages) deliver({ type: 'stratum', items })
})
// Today — the timeline and the now strip — to every page when it changes.
onToday((today) => {
  for (const deliver of pages) deliver({ type: 'today', today })
})
/** Asking for these is dealing with them: their "ready" item closes. */
const CLOSES_KIND = {
  jarvis_brief__get_brief: 'brief',
  jarvis_loop__get_day_wrap: 'wrap',
  jarvis_review__get_weekly_review: 'review',
}

/** Everything the brief builder needs; see briefing.mjs. */
const briefDeps = () => ({
  mcpServers: MCP_SERVERS,
  isReadOnly: readOnlyTool,
  localNow,
  model: FAST_MODEL,
  // Each step a background job takes, for the badge under whatever the
  // conversation is waiting on: "Building your brief · Checking Jira".
  onStep: (job, step) => {
    const phrase = JOB_PHRASE[job] ?? job
    for (const deliver of pages) deliver({ type: 'progress', job: phrase, step })
  },
})

// Said once, the day the spend cap is first reached.
onCapReached((spent, cap) =>
  broadcastAlert({
    kind: 'reminder',
    label: 'Spend cap',
    title: 'Daily spend cap reached',
    detail: `$${spent.toFixed(2)} of $${cap.toFixed(2)} today. Background checks and offers are paused until tomorrow; I still answer when you ask.`,
    say: "Sir, today's spend has reached your cap, so I've paused the background checks until tomorrow. I'll still answer when you ask.",
    at: new Date().toISOString(),
  }),
)

function ensureWatcher() {
  watcher ??= startAlerts({
    mcpServers: backgroundServers(),
    // Exactly what the conversation may do without asking, and nothing else:
    // no confirmations, no writes, ever.
    isReadOnly: readOnlyTool,
    broadcast: broadcastAlert,
    listening: () => pages.size > 0,
    localNow,
    vips,
    // A focus block on the calendar starts focus on its own, quietly.
    onFocusBlock: (title, start, end) => {
      try {
        focusToPages(startFocus({ until: end, reason: title, source: 'calendar' }))
        console.log(`[jarvis] focus: calendar block "${title}" until ${new Date(end).toLocaleTimeString()}`)
      } catch {
        // Already over.
      }
    },
    // The whole day, every calendar, for the timeline; and the portfolio's
    // standing, for the now strip.
    onCalendar: setWatcherEvents,
    onPortfolio: setPortfolio,
    model: FAST_MODEL,
    effort: FAST_EFFORT,
  })
}

/**
 * The minute clock for everything proactive that needs no model to decide:
 * focus ending on time, the evening wrap and Friday review offers, promise
 * nudges, the promise scan every few hours, and the day's meetings into the
 * log. Only while a page is open, and nudges only within alert hours.
 */
const ALERT_HOURS = process.env.JARVIS_ALERT_HOURS ?? '8-19'
let lastWake = Date.now()
const ALERT_DAYS = process.env.JARVIS_ALERT_WEEKENDS === 'on' ? 'every' : 'weekdays'
setInterval(() => {
  focus.tick()
  if (!pages.size) return
  void refreshToday()
  const deps = briefDeps()
  // Past the daily spend cap, offers and scans nobody asked for wait for
  // tomorrow (bridge/spend.mjs). Snoozes and nudges below cost nothing.
  const paused = backgroundPaused()
  if (!paused) {
    maybeOfferWrap(deps, broadcastAlert)
    maybeOfferReview(deps, broadcastAlert)
  }
  // Snoozed items and reminders whose time has come: back on the list, and said.
  for (const i of wokenSince(lastWake)) {
    broadcastAlert({
      kind: i.kind === 'reminder' ? 'reminder' : i.kind,
      label: i.kind === 'reminder' ? 'Reminder' : i.label || 'Back on your list',
      title: i.title,
      detail: i.detail,
      ...(i.items ? { items: i.items } : {}),
      say: `Sir, a reminder: ${i.title.replace(/[.!]$/, '')}.`,
      at: new Date().toISOString(),
      fromStratum: true,
    })
  }
  lastWake = Date.now()
  if (inWindow('16-24', 'every') && firstToday('meeting-log')) void logMeetings()
  if (!commitmentsEnabled() || !inWindow(ALERT_HOURS, ALERT_DAYS)) return
  for (const nudge of dueNudges()) broadcastAlert(nudge)
  if (!paused && scanDue()) {
    scanCommitments(deps)
      .then(() => jobHealth.ok('commitments'))
      .catch((err) => {
        console.warn(`[jarvis] commitments: ${err.message}`)
        jobHealth.fail('commitments', err.message)
      })
  }
}, 60_000).unref()

wss.on('connection', (socket) => {
  console.log('[jarvis] client connected')

  // Resume the recent conversation if there is one, or start a new one with an
  // id we choose, so it can be resumed after the next reload.
  const convo = sessionOptions()
  let answered = false

  // Answer the HUD straight away rather than making it wait for the agent's
  // first turn. Refined later by the real init message.
  socket.send(
    JSON.stringify({
      type: 'ready',
      servers: railList(Object.keys(MCP_SERVERS).map((name) => ({ name }))),
    }),
  )

  /** Alerts before this were already passed to this conversation. */
  let alertsSeen = 0

  /** Resolves the pending user message into the SDK's input generator. */
  let deliver = null
  let closed = false
  const inbox = []

  async function* userMessages() {
    while (!closed) {
      const text =
        inbox.shift() ??
        (await new Promise((resolve) => {
          deliver = resolve
        }))
      if (closed || text == null) return
      const context = alertContext(alertsSeen)
      alertsSeen = Date.now()
      yield {
        type: 'user',
        message: { role: 'user', content: `[${localNow()}]\n${context}${text}` },
        parent_tool_use_id: null,
      }
    }
  }

  const send = (msg) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg))
  }
  pages.add(send)
  ensureWatcher()
  // The first page of the morning builds the day's brief and offers it,
  // unless the daily spend cap has already been reached.
  if (!backgroundPaused()) maybeOfferBrief(briefDeps(), {
    weekends: process.env.JARVIS_ALERT_WEEKENDS === 'on',
    broadcast: broadcastAlert,
  })
  send({ type: 'focus', focus: focusState() })
  send({ type: 'stratum', items: listStratum() })
  send({ type: 'today', today: todayView() })
  void refreshToday()

  /**
   * Which question the agent is currently answering.
   *
   * The stream carries no notion of a turn, so without this the client cannot
   * tell the tail of an abandoned answer from the start of the new one — it
   * attaches a listener and receives whatever is on the socket. Echoing the
   * id the client sent lets it ignore anything that is not its own, which is
   * the only reliable fix: no amount of waiting on this side changes what a
   * listener over there has already heard.
   */
  let answering = null
  const sendTurn = (msg) => send({ ...msg, ask: answering })

  /**
   * What the user said to start the turn in flight, as they said it. The one
   * input no email, page or note can write, so it is what `remember` and
   * drafts are checked against — see intentGate in policy.mjs.
   */
  let turnText = ''
  const decideForTurn = (name) => intentGate(name, decideTool(name), turnText, POLICY)

  /** Whether any words have gone out yet in the turn in flight. */
  let spoke = false
  /**
   * Everything said in the turn in flight, for the history. Not `result`,
   * which is only the text after the last tool call: an answer spoken before
   * a `display` would have been kept as "On screen, sir."
   */
  let said = ''

  /** Which route the session is on now, and the queue that switches it. */
  let tier = 'deep'
  let delivering = Promise.resolve()

  /**
   * Set when a fatal API error has already been reported for this turn, so the
   * `result` that follows the interrupt does not say a second, vaguer thing.
   */
  let turnFailed = false

  /**
   * Why a turn ended without an answer, for the log and for what happens next.
   * `interrupted` is set when the page cuts a turn off because the user spoke
   * over it: the SDK then ends that turn as error_during_execution, which is
   * not a failure and must not be reported as one — in the logs it was most
   * of them. `lastTool` is the last tool the turn reached for, so a real
   * failure says where it happened. `failedInARow` counts real failures with
   * nothing said: a resumed conversation that has gone bad fails every turn,
   * and the only way out used to be saying "start fresh".
   */
  let interrupted = false
  let inFlight = false
  let sessionCost = 0
  let lastTool = ''
  let failedInARow = 0
  const FRESH_AFTER_FAILURES = 2

  const failTurn = (code) => {
    const known = FATAL_API_ERRORS[code]
    if (!known || turnFailed) return false
    turnFailed = true
    console.error(`[jarvis] ${known.fix}`)
    sendTurn({ type: 'error', message: known.spoken })
    // Stop the back-off loop now rather than letting it retry for minutes.
    void Promise.resolve(session.interrupt?.()).catch(() => {})
    return true
  }

  /**
   * Asking the browser for something and waiting for the answer.
   *
   * Every other tool here pushes — a panel, a blade, a retint — and never needs
   * a reply. The camera is the exception: the hardware is over there and the
   * model is here, so a frame has to come back. Correlated by id because a turn
   * can have more than one request in flight, and timed out because a browser
   * that has been closed mid-question would otherwise hang the turn until the
   * two-minute idle timer noticed.
   */
  const waiting = new Map()
  let asks = 0

  const ask = (kind, args, timeoutMs = 20_000) =>
    new Promise((resolve, reject) => {
      if (socket.readyState !== socket.OPEN) {
        return reject(new Error('the interface is not connected'))
      }
      const id = `q${++asks}`
      const timer = setTimeout(() => {
        waiting.delete(id)
        reject(new Error('the interface did not answer in time'))
      }, timeoutMs)
      waiting.set(id, { resolve, timer })
      send({ type: kind, id, ...args })
    })

  /**
   * Announcing a tool on the HUD, once, and only if it actually runs.
   *
   * A tool_use block surfaces twice — as a partial stream event and again on
   * the completed assistant message — so ids are remembered. The harder part
   * is timing, because a refused tool that lights the badge, plays the sound
   * and provokes a "working on it" line, for work that never happens, reads as
   * a bug on camera.
   *
   * The SDK's order is: the block starts streaming, then canUseTool is asked,
   * then the tool runs. So nothing is known at content_block_start. Announcing
   * from inside canUseTool would know the verdict but miss tools entirely —
   * measured on this SDK, the callback is consulted only for calls the CLI
   * hasn't already settled, so a `Bash: echo` its own classifier waves through
   * never reaches us at all.
   *
   * So: announce immediately for anything decideTool permits, since those run.
   * Hold the rest, and let the tool_result settle it — a refusal comes back as
   * is_error, anything else really did execute and has earned its badge, a
   * beat late. Nothing is ever announced for work that didn't happen.
   */
  const seenTools = new Set()
  const heldTools = new Map()

  /**
   * Resolves when the turn in flight has actually finished.
   *
   * Waiting on session.interrupt() alone is not enough. It resolves when the
   * agent has been *told* to stop, not when it has, so the last tokens of the
   * abandoned answer are still on their way — and since nothing on the wire
   * identifies which question a delta belongs to, they land on the next turn's
   * listener. Measured: ask for ALPHA, interrupt, ask for BRAVO, and BRAVO's
   * answer arrives as "ALPHA\nBRAVO".
   *
   * The SDK emits exactly one `result` per turn, so that is the boundary worth
   * waiting for. Raced against a timeout because a turn that never reports one
   * must not wedge the conversation for ever — a stray word is a blemish, a
   * deadlocked assistant is not.
   */
  let settling = Promise.resolve()
  let finishTurn = null

  const turnFinished = () =>
    new Promise((resolve) => {
      finishTurn = resolve
    })

  /**
   * A brief pause so the abandoned turn's frames are tagged with the OLD id
   * before the new one is adopted. Short, because correctness now comes from
   * the tag rather than from the wait — this only has to cover the gap, not
   * outlast the whole turn.
   */
  const SETTLE_CAP_MS = 400

  const announceTool = (id, name) => {
    if (name) lastTool = name
    if (!name || (id && seenTools.has(id))) return
    if (id) seenTools.add(id)
    // The display tool isn't work being done, it's the HUD drawing itself —
    // announcing it would put "jarvis · display" in the tool badge and trigger
    // a "working on it" filler for something already on screen.
    if (name === 'mcp__jarvis__display') return
    // The ui_* tools are the same case one step further: retinting the
    // interface is the interface talking about itself, not work being done for
    // the user, and the badge would be describing the very thing they can see.
    if (name.startsWith('mcp__jarvis_ui__')) return
    // Saving a note is instant and he acknowledges it himself; a badge and a
    // "working on it" line for it would be louder than the thing itself.
    if (name.startsWith('mcp__jarvis_memory__')) return
    // `label` is what the badge says: "Checking Jira", not the tool's name.
    if (decideForTurn(name) === 'allow') return sendTurn({ type: 'tool', name, label: describeStep(name) })
    if (id) heldTools.set(id, name)
  }

  const settleTool = (id, failed) => {
    const name = heldTools.get(id)
    if (name === undefined) return
    heldTools.delete(id)
    if (!failed) sendTurn({ type: 'tool', name, label: describeStep(name) })
  }

  const session = query({
    prompt: userMessages(),
    options: {
      ...convo.options,
      // Everything Claude Code has configured, plus the HUD as an in-process
      // server. The HUD's handler closes over this socket, so a `display` call
      // lands on screen directly — which is also why this object is built per
      // connection rather than once.
      mcpServers: {
        ...MCP_SERVERS,
        jarvis: displayServer(
          (panel) => send({ type: 'panel', panel }),
          (blade) => send({ type: 'blade', blade }),
        ),
        // The interface controls, on the same socket. A separate key because
        // MCP tool names are `mcp__<key>__<tool>` and one key can only carry
        // one server; the underscore in it is why decideTool and announceTool
        // both name `jarvis_ui` explicitly.
        jarvis_ui: uiServer((op, args) => send({ type: 'ui', op, args })),
        // The user's own Chrome, over the extension's native-host socket. It
        // holds no per-connection state, but it is built here with the rest so
        // the write gate is read once, at the same point as everything else.
        jarvis_chrome: chromeServer({ allowWrites: ALLOW_WRITES }),
        // The camera, which unlike everything else here has to ask and wait.
        jarvis_eyes: visionServer(ask),
        // Lasting notes about the user, in ~/.jarvis/memory.md.
        jarvis_memory: memoryServer(),
        // The day's ranked brief, built by a read-only session and cached.
        jarvis_brief: briefServer(briefDeps()),
        // Reports and dashboards saved on this Mac, file:// links included.
        jarvis_files: localFilesServer(),
        // Closing the loop: the evening wrap, dossiers, the promise ledger.
        jarvis_loop: loopServer(briefDeps()),
        // Heads-down: hold alerts except VIPs, then one digest.
        jarvis_focus: focusServer(focusToPages),
        // Jira and Azure DevOps, by voice.
        jarvis_portfolio: portfolioServer(briefDeps()),
        // Friday's review and the weekly update for leadership.
        jarvis_review: reviewServer(briefDeps()),
        // The review column: what is still waiting on him, and his reminders.
        jarvis_stratum: stratumServer(),
        // The Protective mailbox, calendar and To Do, via Power Automate —
        // present only once its flows are set up.
        ...(protectiveConfigured() ? { protective: protectiveServer() } : {}),
      },
      // A plain system prompt, not the claude_code preset. The preset is
      // tuned for a coding agent — verbose, file-oriented, and a large chunk
      // of input tokens on every turn. Replacing it makes the persona stick,
      // keeps answers short enough to speak, and cuts cost per turn.
      // Read per connection, so a note remembered (or edited by hand) in one
      // conversation is known in the next.
      systemPrompt: SYSTEM_PROMPT + memoryPrompt() + carriedPrompt(convo.carried),
      // Run from the home directory so project-scoped MCP servers don't shadow
      // the global ones, and so file tools have a sane root.
      cwd: homedir(),
      // No filesystem settings at all. Left to its default the SDK loads
      // ~/.claude/settings.json and settings.local.json exactly as the CLI
      // does — which on a working machine means a bypassPermissions default
      // and a pile of allow-rules for Bash. Allow-rules are matched before the
      // permission callback, so decideTool below would never even be asked
      // about the tools it most needs to refuse. Empty makes this bridge the
      // only authority. It also stops the global CLAUDE.md riding along on
      // every voice turn, carrying instructions written for a coding agent
      // into a conversation that is meant to be two sentences long.
      //
      // The cost is that MCP servers stop being discovered too, which is why
      // mcpServers above passes them in by hand.
      settingSources: [],
      // Connectors outside JARVIS_CONNECTORS, out of the model's view. decideTool
      // denies them too; this stops him reaching for them at all. And the
      // shell and file tools, which the CLI allows under the home folder
      // without ever asking decideTool — see LOCAL_ACCESS in policy.mjs.
      disallowedTools: [...connectorDenylist(), ...conversationDisallowed(POLICY)],
      // Your claude.ai connectors — Gmail, Google Calendar, Drive and the rest —
      // are a separate channel: the CLI fetches them with your claude.ai login
      // whatever settingSources says, and strictMcpConfig is the one switch
      // that would turn them off. Stated so nobody "tidies" it to true. Set
      // ENABLE_CLAUDEAI_MCP_SERVERS=0 in the shell to run without them.
      strictMcpConfig: false,
      // Stated explicitly, and it has to be.
      //
      // With no `model` here the SDK falls back to its own default, which on
      // this machine resolved to claude-opus-4-8[1m] — not what src/config.ts
      // declares for the browser-direct path, and not anything anyone chose.
      // Normally your own `/model` preference would decide, but that lives in
      // the settings files `settingSources: []` deliberately stops loading, so
      // without this line nothing in the project has a say at all.
      model: MODEL,
      effort: EFFORT,
      maxTurns: 24,
      permissionMode: 'default',
      // Without this the SDK only emits whole assistant messages, and JARVIS
      // would sit silent until the entire answer was written. Partial events
      // are what let speech start on the first finished sentence.
      includePartialMessages: true,
      // Signature is (toolName, input, options) and it must return a
      // PermissionResult object. Returning a bare boolean silently denies
      // everything, with the tool name arriving undefined.
      //
      // Worth knowing: this is a last gate, not the only one. Calls the CLI
      // has already settled never arrive here — its own classifier waves
      // through a `Bash: echo hello` without asking, and only reaches us for
      // something with a consequence, like a `touch`. So a deny here is
      // reliable; an absence of a call here is not proof nothing ran.
      canUseTool: async (toolName, input) => {
        let verdict = decideForTurn(toolName)
        if (verdict === 'confirm') {
          const action = describeAction(toolName, input)
          console.log(`[jarvis] tool ${toolName} -> asking: ${action.summary}`)
          let ok = false
          try {
            // Long enough for the prompt, a considered answer and the undo
            // window. The page always replies, so this is only the backstop
            // for a tab that closed with the card still up.
            const reply = await ask('confirm', action, 90_000)
            ok = reply?.ok === true
          } catch {
            ok = false
          }
          console.log(`[jarvis] tool ${toolName} -> ${ok ? 'confirmed' : 'declined'}`)
          if (ok) return { behavior: 'allow', updatedInput: input }
          return {
            behavior: 'deny',
            message:
              'The user declined this action, or did not confirm it in time. It was not' +
              ' done. Acknowledge that in a few words and do not try it again unless asked.',
          }
        }
        console.log(`[jarvis] tool ${toolName} -> ${verdict}`)
        const closes = CLOSES_KIND[toolName.replace(/^mcp__/, '')]
        if (verdict === 'allow' && closes) closeKind(closes)
        return verdict === 'allow'
          ? { behavior: 'allow' }
          : {
              behavior: 'deny',
              // Every word of this can end up spoken, so it carries no command
              // to read out — the persona is forbidden from saying one aloud.
              message:
                `Blocked: ${NAME} is running in read-only mode and cannot take` +
                ' actions that change anything. Tell the user this action is' +
                ' unavailable until they enable write access on the machine.',
            }
      },
    },
  })

  /**
   * Fill the SYSTEMS rail straight away, connectors included.
   *
   * The init message that carries the full server list only arrives with the
   * first question, so until then the rail could show nothing but what
   * ~/.claude.json names — none of the claude.ai connectors. mcpServerStatus()
   * answers as soon as the CLI has started, no question needed. Servers connect
   * lazily, so it is asked again every few seconds while any are still pending,
   * and the rail fills in as they come up. Also where the terminal learns what
   * loaded, at startup rather than on the first question.
   *
   * The claude.ai connectors join the list a few seconds after everything
   * else, so "nothing pending" is not the end on its own; statusSettled waits
   * up to CONNECTOR_GRACE_MS for them to appear before calling it final.
   */
  ;(async () => {
    const deadline = Date.now() + 60_000
    const graceUntil = Date.now() + CONNECTOR_GRACE_MS
    let last = ''
    while (!closed && Date.now() < deadline) {
      let all
      try {
        all = await session.mcpServerStatus()
      } catch {
        return // Session ended, or this SDK cannot answer; init will cover it.
      }
      if (closed) return
      recordConnectors(all)
      const list = railList(all)
      const key = JSON.stringify(list)
      if (key !== last) {
        last = key
        send({ type: 'ready', servers: list })
      }
      if (statusSettled(all, { graceUntil })) {
        if (!initLogged) {
          initLogged = true
          logServers(all)
        }
        return
      }
      await new Promise((r) => setTimeout(r, 3000))
    }
  })()

  // Put the last few exchanges back on screen, so a reload does not look like
  // amnesia when it is not.
  if (convo.resumed) {
    void getSessionMessages(convo.id, { dir: homedir() })
      .then((messages) => {
        const turns = recentTurns(messages)
        if (turns.length) send({ type: 'history', turns })
        console.log(`[jarvis] resumed the conversation (${messages.length} messages)`)
      })
      .catch(() => {})
  } else if (convo.carried?.length) {
    // A fresh conversation that picks up where a long one stopped: the same
    // last few exchanges stay on screen that the model was given.
    send({ type: 'history', turns: convo.carried })
  }

  // Pump the session's output stream to the browser for as long as it lives.
  ;(async () => {
    try {
      for await (const msg of session) {
        if (process.env.JARVIS_DEBUG === '1') {
          console.log('[msg]', msg.type, msg.event?.type ?? '')
        }

        switch (msg.type) {
          // Raw Anthropic stream events, surfaced by includePartialMessages.
          // This is the ONLY place spoken text arrives: there is no top-level
          // text_delta message in the SDK union and the 'assistant' message
          // carries no deltas either. Turn includePartialMessages off and
          // JARVIS goes completely mute.
          case 'stream_event': {
            const ev = msg.event
            // A new text block after one already spoken this turn — words on
            // either side of a tool call — would otherwise butt straight onto
            // the last one: "sending it now, sir.The email has been sent".
            if (ev?.type === 'content_block_start' && ev.content_block?.type === 'text' && spoke) {
              sendTurn({ type: 'text', delta: ' ' })
              said += ' '
            }
            if (
              ev?.type === 'content_block_delta' &&
              ev.delta?.type === 'text_delta' &&
              ev.delta.text
            ) {
              spoke = true
              said += ev.delta.text
              sendTurn({ type: 'text', delta: ev.delta.text })
            }
            if (
              ev?.type === 'content_block_start' &&
              ev.content_block?.type === 'tool_use'
            ) {
              announceTool(ev.content_block.id, ev.content_block.name)
            }
            break
          }

          case 'assistant': {
            // A failed request arrives as an assistant message carrying an
            // error code, its text a canned "Please run /login" that would be
            // read aloud as if it were an answer.
            if (msg.error && failTurn(msg.error)) break
            // Fallback for builds that emit whole assistant messages rather
            // than partial events. Deduped against the stream_event path.
            for (const block of msg.content ?? msg.message?.content ?? []) {
              if (block.type === 'tool_use') {
                announceTool(block.id, block.name)
              }
            }
            break
          }

          case 'user': {
            // Tool results come back as a user message. This is the only place
            // a held announcement can be resolved: a refused tool arrives with
            // is_error set and stays off the HUD, anything else ran.
            const blocks = msg.message?.content
            if (!Array.isArray(blocks)) break
            for (const block of blocks) {
              if (block?.type === 'tool_result') {
                settleTool(block.tool_use_id, block.is_error === true)
              }
            }
            break
          }

          case 'result': {
            touch()
            // What this turn cost, for the log: total_cost_usd is the
            // session's running total (the HUD shows it as such), so a turn
            // is the difference. Voice turns were the one cost never logged.
            const total = Number(msg.total_cost_usd ?? 0)
            const turnCost = total >= sessionCost ? total - sessionCost : total
            sessionCost = total
            recordSpend('conversation', turnCost)
            // Cache figures too: each model keeps its own prompt cache, so the
            // first turn on a model in a while re-sends the whole conversation
            // at the write price. These say how often that happens in real use.
            const k = (n) => `${((n ?? 0) / 1000).toFixed(1)}k`
            console.log(
              `[jarvis] turn ${msg.subtype === 'success' && !msg.is_error ? 'done' : 'ended'}` +
                ` in ${((msg.duration_ms ?? 0) / 1000).toFixed(1)}s ($${turnCost.toFixed(3)};` +
                ` ${ROUTES[tier].model}/${ROUTES[tier].effort}, cache read ${k(msg.usage?.cache_read_input_tokens)},` +
                ` written ${k(msg.usage?.cache_creation_input_tokens)})`,
            )
            // A result is not automatically a success. The error subtypes
            // carry no `result` field at all, so reporting them as 'done' with
            // empty text is indistinguishable from a turn that simply had
            // nothing to say — the HUD stops spinning and JARVIS stands there
            // silent. Say what happened instead.
            // Resuming a conversation Claude Code does not have fails every
            // turn with the same error. sessionOptions() checks first, so this
            // is the backstop: forget it, say so plainly, and drop the socket
            // so the page reconnects to a fresh one.
            if (
              convo.resumed &&
              !answered &&
              MISSING_CONVERSATION.test(`${msg.result ?? ''} ${[].concat(msg.errors ?? []).join(' ')}`)
            ) {
              console.warn('[jarvis] the conversation being resumed does not exist; starting a fresh one')
              forgetSession()
              sendTurn({
                type: 'error',
                message: "I couldn't pick up our earlier conversation, so I've started a fresh one. Please say that again.",
              })
              finishTurn?.()
              finishTurn = null
              closed = true
              deliver?.(null)
              session.close?.()
              socket.close()
              break
            }
            if (turnFailed) {
              // Already reported, in plain words, by failTurn.
            } else if (msg.subtype === 'success' && msg.is_error) {
              // "Success" with is_error: the CLI finished the turn but the
              // text is an error notice, not an answer. Log it verbatim — it is
              // usually the most specific description available.
              console.error(`[jarvis] turn failed: ${msg.result ?? 'unknown error'}`)
              sendTurn({
                type: 'error',
                message: 'The request to Claude failed. The details are in the terminal.',
              })
            } else if (msg.subtype === 'success') {
              appendTurn({ role: 'jarvis', text: said.trim() || (msg.result ?? '') })
              sendTurn({
                type: 'done',
                text: msg.result ?? '',
                costUsd: msg.total_cost_usd ?? null,
                tier,
              })
            } else if (interrupted && msg.subtype === 'error_during_execution') {
              // Cut off because the user spoke over it: the next question is
              // already on its way, and there is nothing to report.
              console.log('[jarvis] turn interrupted')
            } else {
              console.error(
                `[jarvis] turn failed: ${msg.subtype}${lastTool ? ` (last tool: ${lastTool})` : ''}`,
                msg.errors ?? '',
              )
              failedInARow = spoke ? 0 : failedInARow + 1
              if (failedInARow >= FRESH_AFTER_FAILURES) {
                console.warn(`[jarvis] ${failedInARow} turns in a row failed with nothing said; starting a fresh conversation`)
                sendTurn({
                  type: 'error',
                  message: "That conversation had stopped working, so I've started a fresh one. Please ask again.",
                })
                forgetSession()
                closed = true
                deliver?.(null)
                session.close?.()
                socket.close()
                break
              }
              sendTurn({
                type: 'error',
                message: RESULT_FAILURES[msg.subtype] ?? RESULT_FAILURES.default,
              })
            }
            if (msg.subtype === 'success' && !msg.is_error) failedInARow = 0
            // Whatever was waiting on this turn to finish can go now. This is
            // the only place a turn is genuinely over.
            finishTurn?.()
            finishTurn = null
            turnFailed = false
            interrupted = false
            inFlight = false
            lastTool = ''
            spoke = false
            said = ''
            // Keep an active conversation resumable after a reload — only
            // one that has actually answered. Saving on every result kept a
            // conversation Claude Code had never heard of "recent" for ever.
            if (msg.subtype === 'success' && !msg.is_error) {
              answered = true
              saveSession(convo.id)
            }
            // One turn's tool ids are never referred to again, and these
            // otherwise grow for as long as the socket is open.
            seenTools.clear()
            heldTools.clear()
            break
          }

          case 'system':
            if (msg.subtype === 'api_retry') {
              if (!failTurn(msg.error) && msg.attempt === 1) {
                console.warn(
                  `[jarvis] Claude request failed (${msg.error_status ?? 'no response'}, ${msg.error}); retrying`,
                )
              }
              break
            }
            if (msg.subtype === 'init') {
              // Servers report 'pending' until first use — they connect
              // lazily — so only drop the ones that are actually unusable.
              const all = msg.mcp_servers ?? []
              send({ type: 'ready', servers: railList(all) })
              // Left to the status poll while the connectors have yet to
              // appear, for the same reason it waits for them.
              if (!initLogged && statusSettled(all, { graceUntil: Infinity })) {
                // Once per bridge, not per page load: the list does not change
                // between reconnects and the terminal is not a ticker.
                initLogged = true
                logServers(all)
              }
            }
            break
        }
      }
    } catch (err) {
      console.error('[jarvis] session error:', err)
      // A resume that fails before anything was said — the transcript was
      // deleted, or is from an older version — must not fail every reconnect
      // after it. Forget it; the page reconnects to a fresh conversation.
      if (convo.resumed && !answered) {
        console.warn('[jarvis] could not resume the earlier conversation; starting a fresh one')
        forgetSession()
      }
      send({ type: 'error', message: String(err?.message ?? err) })
      // The stream is finished either way — nothing will ever be read from it
      // again. Leaving the socket open would leave the client believing it has
      // a working bridge, and every later question would hang for ever waiting
      // on a pump that has already stopped. Close it so it reconnects.
      closed = true
      deliver?.(null)
      session.close?.()
      socket.close()
    }
  })()

  socket.on('message', (raw) => {
    let msg
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return
    }

    if (msg.type === 'ask' && typeof msg.text === 'string') {
      touch()
      appendTurn({ role: 'user', text: msg.text })
      /**
       * Queued behind any interrupt that is still settling.
       *
       * A barge-in is two messages in quick succession — interrupt, then the
       * new question — and session.interrupt() is asynchronous. Delivering the
       * question the instant it arrives means the agent can still be winding
       * down the previous turn, so its last tokens are emitted after the new
       * one has begun and land on the new turn's listener. Measured: ask "one",
       * interrupt, ask "two", and the answer to "two" comes back as "One."
       *
       * Waiting costs nothing when nothing is interrupting — the chain is an
       * already-resolved promise — and removes the cross-talk when there is.
       */
      const text = msg.text
      const id = typeof msg.id === 'string' ? msg.id : null
      // Chained, so a second question cannot overtake the first while the
      // model switch for the first is still being applied.
      delivering = delivering.then(() => settling).then(async () => {
        const route = routeFor(text)
        if (route.tier !== tier) {
          try {
            await session.setModel(route.model)
            await session.applyFlagSettings({ effortLevel: route.effort })
            tier = route.tier
          } catch (err) {
            // Answer on whatever is current rather than not at all.
            console.warn(`[jarvis] could not switch to ${route.model}: ${err?.message ?? err}`)
          }
        }
        console.log(`[jarvis] ${tier} turn (${ROUTES[tier].model})`)
        answering = id
        turnText = text
        inFlight = true
        if (deliver) {
          const resolve = deliver
          deliver = null
          resolve(text)
        } else {
          inbox.push(text)
        }
      })
    }

    if (msg.type === 'reply' && typeof msg.id === 'string') {
      const slot = waiting.get(msg.id)
      if (slot) {
        waiting.delete(msg.id)
        clearTimeout(slot.timer)
        slot.resolve(msg)
      }
    }

    // The Diagnostics panel: what today has cost, and how the last brief
    // served went (links found, lines ticked off, anything that stopped them).
    if (msg.type === 'status') {
      send({ type: 'status', spend: spendSummary(), brief: briefHealth() })
      return
    }

    // The history drawer asks for a day of the conversation. With `q`, a
    // search across every kept day instead.
    if (msg.type === 'transcript') {
      if (typeof msg.q === 'string' && msg.q.trim()) {
        send({ type: 'transcript', day: '', q: msg.q, days: transcriptDays(), turns: searchTranscripts(msg.q) })
        return
      }
      const day = typeof msg.day === 'string' ? msg.day : new Date().toLocaleDateString('en-CA')
      send({ type: 'transcript', day, days: transcriptDays(), turns: readTranscript(day) })
      return
    }

    // The review column: done, open again, snoozed, or looked at.
    if (msg.type === 'stratum') {
      if (msg.op === 'seen') markAllSeen()
      else if (msg.op === 'kept' && typeof msg.id === 'string') {
        // "Kept it" on one of his promises: the ledger closes it, so it is
        // not nudged again tomorrow, and the item is done.
        const ref = findItem(msg.id)?.ref ?? ''
        if (ref.startsWith('commitment:')) closeCommitment(ref.slice('commitment:'.length), 'done')
        updateItem(msg.id, { state: 'done' })
      } else if (typeof msg.id === 'string') {
        if (msg.op === 'done' || msg.op === 'open') updateItem(msg.id, { state: msg.op })
        if (msg.op === 'snooze') {
          const until = parseWhen(String(msg.when ?? ''))
          if (until) updateItem(msg.id, { until })
        }
      }
      return
    }

    // "Start fresh": drop the conversation. Closing the socket makes the page
    // reconnect, and the next connection opens a new session.
    if (msg.type === 'reset') {
      console.log('[jarvis] starting a fresh conversation')
      forgetSession()
      closed = true
      deliver?.(null)
      session.close?.()
      socket.close()
      return
    }

    if (msg.type === 'interrupt') {
      // The page sends this for any "stop", idle or not; only a turn that is
      // actually running is being cut off.
      if (inFlight) interrupted = true
      // Held so the next question can wait for it rather than racing it.
      const stopped = turnFinished()
      settling = Promise.resolve(session.interrupt?.())
        .catch(() => {})
        .then(() =>
          Promise.race([
            stopped,
            new Promise((r) => setTimeout(r, SETTLE_CAP_MS)),
          ]),
        )
    }
  })

  socket.on('close', () => {
    pages.delete(send)
    console.log('[jarvis] client disconnected')
    closed = true
    deliver?.(null)
    session.close?.()
  })
})
