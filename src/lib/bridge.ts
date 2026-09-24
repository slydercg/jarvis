import type { AskHandlers } from './anthropic'
import type { Blade, Panel } from '../store'
import { BRIDGE_WS_URL } from '../config'

/**
 * Client for the local bridge (see bridge/server.mjs).
 *
 * Same `ask()` shape as the browser-direct path, so App.tsx doesn't care which
 * brain is behind it. The difference is what's reachable: this one runs on your
 * machine, so every MCP server in your Claude Code config is in play.
 *
 * The socket is the session. The bridge holds one Claude Agent SDK query per
 * connection and the whole conversation lives inside it, so a dropped socket
 * silently wipes JARVIS's memory of the exchange while the transcript on screen
 * still shows it. That is why the reconnect below is loud rather than
 * invisible: `watchConnection` exists so the HUD can say so.
 */

/** Anything the bridge sends. Deliberately loose — a frame from a future
 *  bridge build should be ignored, not crash the turn. */
type Frame = {
  type?: string
  delta?: string
  name?: string
  text?: string
  message?: string
  panel?: Panel
  blade?: Blade
  op?: string
  args?: unknown
  id?: string
  ask?: string
  reason?: string
  mode?: string
  seconds?: number
  when?: string
  servers?: Array<string | { name?: string; status?: string }>
  costUsd?: number | null
  tier?: string
  service?: string
  action?: string
  summary?: string
  details?: Array<{ label: string; value: string }>
  money?: boolean
  turns?: Array<{ role: 'user' | 'jarvis'; text: string }>
  alert?: AlertFrame
  focus?: FocusFrame
  items?: StratumItem[]
  today?: TodayFrame
  spend?: SpendSummary
  brief?: BriefHealth
  ref?: string
  ok?: boolean
  label?: string
  job?: string
  step?: string | null
  days?: string[]
  day?: string
  q?: string
}

/** A background job's current step ("Checking Jira"), or null once it is done. */
let onProgress: ((job: string, step: string | null) => void) | null = null
export function watchProgress(fn: (job: string, step: string | null) => void) {
  onProgress = fn
}

/** One line of the kept conversation (bridge/transcript.mjs). */
export type TranscriptTurn = {
  at: number
  role: 'user' | 'jarvis' | 'alert'
  text: string
  kind?: string
  /** Search results only: which day it was said. */
  day?: string
}
/** A day of the conversation, or (with `q`) matches from every kept day. */
export type TranscriptFrame = { day: string; days: string[]; turns: TranscriptTurn[]; q?: string }

let onTranscript: ((t: TranscriptFrame) => void) | null = null
export function watchTranscript(fn: (t: TranscriptFrame) => void) {
  onTranscript = fn
}
/**
 * Ask for a day of the conversation, or search every kept day with `q`; the
 * answer arrives through watchTranscript.
 */
export function requestTranscript(day?: string, q?: string): boolean {
  if (socket?.readyState !== WebSocket.OPEN) return false
  socket.send(JSON.stringify({ type: 'transcript', day, q }))
  return true
}

/** What today has cost, from bridge/spend.mjs. Estimates at API prices. */
export type SpendSpan = { total: number; byKind: Record<'conversation' | 'background' | 'watcher', number> }
export type SpendSummary = { today: SpendSpan; week: SpendSpan; month: SpendSpan; cap: number | null; paused: boolean }
/** How the last brief served went, from serveBrief in bridge/briefing.mjs. */
export type BriefHealth = {
  at: number
  builtAt: number
  lines: number
  linked: number
  done: number
  unlinked: string[]
  notes: string[]
}
export type StatusFrame = { spend: SpendSummary | null; brief: BriefHealth | null }

let onStatus: ((s: StatusFrame) => void) | null = null
export function watchStatus(fn: ((s: StatusFrame) => void) | null) {
  onStatus = fn
}
/** What a brief button did (bridge/briefing.mjs, briefAction). */
export type BriefResult = { ref: string; op: string; ok: boolean; message: string; ask?: string }
let onBrief: ((r: BriefResult) => void) | null = null
export function watchBrief(fn: (r: BriefResult) => void) {
  onBrief = fn
}
/** Done, tomorrow or reply on one brief line; the answer arrives through watchBrief. */
export function sendBriefOp(ref: string, op: string): boolean {
  if (socket?.readyState !== WebSocket.OPEN) return false
  socket.send(JSON.stringify({ type: 'brief', ref, op }))
  return true
}

/** Ask the bridge for spend and brief health; the answer arrives through watchStatus. */
export function requestStatus(): boolean {
  if (socket?.readyState !== WebSocket.OPEN) return false
  socket.send(JSON.stringify({ type: 'status' }))
  return true
}

/** One meeting on today's timeline (bridge/today.mjs). Times are Date.now() values. */
export type TodayEvent = {
  id: string
  title: string
  start: number
  end: number
  where: string
  account: 'Protective' | 'SCG' | 'Google'
  people: number
  clash: boolean
  focus?: boolean
}

/** Today: every meeting on every calendar, and the portfolio's standing. */
export type TodayFrame = {
  day: string
  events: TodayEvent[]
  portfolio: { blocked: number; behind: string[]; at: number } | null
}

let onToday: ((t: TodayFrame) => void) | null = null
export function watchToday(fn: (t: TodayFrame) => void) {
  onToday = fn
}

/** One entry in the review column (bridge/stratum.mjs). */
export type StratumItem = {
  id: string
  kind: AlertKind
  label?: string
  title: string
  detail?: string
  items?: AlertItem[]
  at: number
  state: 'open' | 'snoozed' | 'done'
  seen?: boolean
  until?: number
}

let onStratum: ((items: StratumItem[]) => void) | null = null
export function watchStratum(fn: (items: StratumItem[]) => void) {
  onStratum = fn
}

/** Done, open again, snoozed ("in an hour", "tomorrow"), or all looked at. */
export function sendStratum(op: 'done' | 'open' | 'snooze' | 'seen' | 'kept', id?: string, when?: string) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'stratum', op, id, when }))
  }
}

/** Heads-down: alerts held until `until`, except VIPs and meetings. */
export type FocusFrame = { active: boolean; until?: string; reason?: string; held?: number }

let onFocus: ((f: FocusFrame) => void) | null = null
export function watchFocus(fn: (f: FocusFrame) => void) {
  onFocus = fn
}

/** A proactive heads-up from the bridge's watcher. */
export type AlertFrame = {
  kind: AlertKind
  title: string
  detail: string
  /** Meeting start, or when the mail was flagged. ISO 8601. */
  at: string
  /** Meetings only: where things stand, when it could be gathered in time. */
  prep?: { summary: string; points: string[] }
  /** The card's label, when the kind alone does not say it ("Overdue"). */
  label?: string
  /** The line to speak, composed by the bridge. */
  say?: string
  /** One line per thing: a focus digest's held alerts, a portfolio alert's tickets. */
  items?: AlertItem[]
  /** Mail from a VIP, or about an incident: it gets through focus and quiet hours. */
  vip?: boolean
}

/** One line on an alert card. `url` is a ticket link, checked again before use. */
export type AlertItem = { title: string; detail: string; key?: string; url?: string }

export type AlertKind =
  | 'meeting' | 'mail' | 'brief' | 'wrap' | 'review' | 'promise' | 'portfolio' | 'digest' | 'reminder'

let onAlert: ((a: AlertFrame) => void) | null = null
export function watchAlerts(fn: (a: AlertFrame) => void) {
  onAlert = fn
}

/** An action the bridge wants the user to approve before it runs. */
export type ConfirmRequest = {
  service: string
  action: string
  summary: string
  details: Array<{ label: string; value: string }>
  money: boolean
}

/** How a server is doing, as the rail shows it. */
export type ServerHealth = 'live' | 'pending' | 'auth' | 'failed'

/** What one turn produced. Cost is the session's running total, in dollars. */
export type AskResult = {
  text: string
  tools: string[]
  costUsd?: number | null
  tier?: string
}

/** Every question gets an id so its answer can be told from anyone else's. */
let askSeq = 0

let socket: WebSocket | null = null
let connecting: Promise<WebSocket> | null = null

/** Server names reported by the bridge, for the HUD readout. */
let servers: string[] = []
export const bridgeServers = () => servers

/** The list arrives twice — once from config, once with live status — so the
 *  HUD subscribes rather than reading it a single time at boot. */
let onServers: ((s: string[], health: Record<string, ServerHealth>) => void) | null = null
export function watchServers(fn: (s: string[], health: Record<string, ServerHealth>) => void) {
  onServers = fn
}

/** Panels arrive out of band — they're pushed while a turn is in flight,
 *  not returned by it. */
let onPanel: ((panel: Panel) => void) | null = null
export function watchPanels(fn: (panel: Panel) => void) {
  onPanel = fn
}

/**
 * The one request the bridge makes of us rather than the other way round.
 *
 * Everything else on this socket is pushed at the browser and needs no answer.
 * A camera frame has to travel back, so this handler is registered by the app
 * and its result is returned against the request's id.
 */
export type CaptureRequest = {
  /** 'look' for a single frame, 'watch' for a grid over time. */
  mode: 'look' | 'watch'
  reason: string
  seconds: number
  /** 'now' records forward; 'past' reads the rolling buffer. */
  when: 'now' | 'past'
}
export type CaptureResult = { data?: string; mimeType?: string; error?: string }

/** The last few exchanges of a resumed conversation, sent once on connect. */
let onHistory: ((turns: Array<{ role: 'user' | 'jarvis'; text: string }>) => void) | null = null
export function watchHistory(fn: (turns: Array<{ role: 'user' | 'jarvis'; text: string }>) => void) {
  onHistory = fn
}

/**
 * Start a fresh conversation. The bridge forgets the saved session and closes
 * the socket; the reconnect that follows opens a new one.
 */
export function resetConversation() {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'reset' }))
}

/** The bridge asking for a yes or no. The answer goes back as a `reply`. */
let onConfirm: ((req: ConfirmRequest) => Promise<{ ok: boolean }>) | null = null
export function watchConfirm(fn: (req: ConfirmRequest) => Promise<{ ok: boolean }>) {
  onConfirm = fn
}

let onCapture: ((req: CaptureRequest) => Promise<CaptureResult>) | null = null
export function watchCapture(fn: (req: CaptureRequest) => Promise<CaptureResult>) {
  onCapture = fn
}

/** Blades arrive the same way panels do — pushed mid-turn, so the article is
 *  already open as he starts the sentence about it. */
let onBlade: ((blade: Blade) => void) | null = null
export function watchBlades(fn: (blade: Blade) => void) {
  onBlade = fn
}

/** Commands that redress the interface — theme, reactor, orbits, effects. Same
 *  out-of-band route as panels: JARVIS issues them while he is still mid-answer
 *  so the change is on screen as he says it, which means they cannot ride back
 *  on the turn's result. The op/args pair stays untyped here on purpose — this
 *  module is a transport, and the store is where the shape is decided. */
let onUi: ((op: string, args: any) => void) | null = null
export function watchUi(fn: (op: string, args: any) => void) {
  onUi = fn
}

/**
 * Connection state, for the UI.
 *
 *   'open'        — first connection of the page.
 *   'lost'        — the socket died. The agent session died with it, so
 *                   everything said so far is gone as far as JARVIS knows.
 *   'reconnected' — we're back, on a fresh session with no memory of the above.
 */
export type ConnectionState = 'open' | 'lost' | 'reconnected'
let onConnection: ((state: ConnectionState) => void) | null = null
export function watchConnection(fn: (state: ConnectionState) => void) {
  onConnection = fn
}

export function isConnected(): boolean {
  return socket?.readyState === WebSocket.OPEN
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/** Resolved by the socket-level dispatcher on the first `ready` of the current
 *  connection. Re-armed per connection so a reconnect re-announces. */
let firstReady = deferred()

let everConnected = false

/** Backoff for the automatic re-dial, then every 8s for as long as it takes.
 *  It used to give up after half a minute, on the theory that a bridge down
 *  that long was stopped on purpose. With auto-start and auto-update it is
 *  just as often being restarted or taking over from another copy, and a page
 *  that had given up sat there saying "reconnecting" long after the bridge
 *  was back. A refused local connection costs nothing to retry. */
const RECONNECT_DELAYS = [500, 1000, 2000, 4000, 8000]
let attempt = 0
let reconnectTimer = 0

function scheduleReconnect() {
  const delay = RECONNECT_DELAYS[Math.min(attempt, RECONNECT_DELAYS.length - 1)]
  attempt += 1
  clearTimeout(reconnectTimer)
  reconnectTimer = window.setTimeout(() => {
    // A failed dial never reaches onclose's reschedule (that only fires for a
    // socket that had opened), so it has to re-arm here. Without this the page
    // tried exactly once, half a second after the drop, and then sat on
    // "reconnecting" for good if the bridge took any longer than that to come
    // back — which a restart always does.
    void connect().catch(() => {
      if (!socket) scheduleReconnect()
    })
  }, delay)
}

/**
 * One message listener per socket, owning everything that isn't part of a
 * turn. It used to live inside warmBridge, bound to that one socket: after any
 * reconnect the SYSTEM rail froze for the life of the page, and every extra
 * warmBridge() call leaked another listener onto the same socket.
 */
function dispatch(ws: WebSocket) {
  ws.addEventListener('message', (e: MessageEvent) => {
    let msg: Frame
    try {
      msg = JSON.parse(e.data as string)
    } catch {
      return
    }

    if (msg.type === 'ready') {
      // The bridge announces immediately on connect from Claude Code's config,
      // then again with live status once the agent initialises. Keep listening
      // so the later, more accurate list wins.
      const health: Record<string, ServerHealth> = {}
      servers = (msg.servers ?? [])
        .map((s) => {
          if (typeof s === 'string') return s
          const name = s.name ?? ''
          if (name && s.status) health[name] = s.status as ServerHealth
          return name
        })
        .filter(Boolean)
      onServers?.(servers, health)
      firstReady.resolve()
    } else if (msg.type === 'panel' && msg.panel) {
      onPanel?.(msg.panel)
    } else if (msg.type === 'blade' && msg.blade) {
      onBlade?.(msg.blade)
    } else if (msg.type === 'capture' && msg.id) {
      const id = msg.id
      const reply = (payload: Record<string, unknown>) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'reply', id, ...payload }))
        }
      }
      if (!onCapture) {
        reply({ error: 'The interface has no camera handler.' })
      } else {
        // Always answers, even on failure: the bridge is holding a turn open
        // waiting for this, and a rejection that never arrives is a turn that
        // hangs until the idle timer notices.
        onCapture({
          mode: msg.mode === 'watch' ? 'watch' : 'look',
          reason: msg.reason ?? '',
          seconds: Math.max(2, Math.min(15, Number(msg.seconds) || 6)),
          when: msg.when === 'past' ? 'past' : 'now',
        })
          .then(reply)
          .catch((err) => reply({ error: String(err?.message ?? err) }))
      }
    } else if (msg.type === 'alert' && msg.alert) {
      onAlert?.(msg.alert)
    } else if (msg.type === 'focus' && msg.focus) {
      onFocus?.(msg.focus)
    } else if (msg.type === 'stratum' && Array.isArray(msg.items)) {
      onStratum?.(msg.items)
    } else if (msg.type === 'today' && msg.today) {
      onToday?.(msg.today)
    } else if (msg.type === 'progress' && typeof msg.job === 'string') {
      onProgress?.(msg.job, msg.step ?? null)
    } else if (msg.type === 'brief' && typeof msg.ref === 'string') {
      onBrief?.({ ref: msg.ref, op: String(msg.op ?? ''), ok: msg.ok === true, message: String(msg.message ?? ''), ...(typeof msg.ask === 'string' ? { ask: msg.ask } : {}) })
    } else if (msg.type === 'status') {
      onStatus?.({ spend: msg.spend ?? null, brief: msg.brief ?? null })
    } else if (msg.type === 'transcript' && Array.isArray(msg.turns)) {
      onTranscript?.({
        day: msg.day ?? '',
        days: msg.days ?? [],
        turns: msg.turns as TranscriptTurn[],
        ...(typeof msg.q === 'string' ? { q: msg.q } : {}),
      })
    } else if (msg.type === 'history' && Array.isArray(msg.turns)) {
      onHistory?.(msg.turns)
    } else if (msg.type === 'confirm' && msg.id) {
      const id = msg.id
      const reply = (payload: Record<string, unknown>) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'reply', id, ...payload }))
        }
      }
      // No handler means no way to ask, and not asking must mean no.
      if (!onConfirm) {
        reply({ ok: false })
      } else {
        onConfirm({
          service: msg.service ?? 'System',
          action: msg.action ?? 'action',
          summary: msg.summary ?? '',
          details: Array.isArray(msg.details) ? msg.details : [],
          money: msg.money === true,
        })
          .then(reply)
          .catch(() => reply({ ok: false }))
      }
    } else if (msg.type === 'ui' && msg.op) {
      // A `ui` frame with no args is normal — reset and clear take none — so an
      // absent args object is an empty one, not a reason to drop the command.
      onUi?.(msg.op, (msg.args ?? {}) as Record<string, unknown>)
    }
  })
}

function connect(): Promise<WebSocket> {
  if (socket?.readyState === WebSocket.OPEN) return Promise.resolve(socket)
  if (connecting) return connecting

  firstReady = deferred()

  connecting = new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(BRIDGE_WS_URL)
    let settled = false

    /**
     * Every terminal path runs through here, and clearing `connecting` is the
     * whole point. The timeout used to reject without clearing it, which
     * bricked the client: the fast path above hands that same dead promise to
     * every later caller, so one slow start cost you a page reload.
     */
    const settle = (err: Error | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      connecting = null
      if (err) reject(err)
      else resolve(ws)
    }

    const timer = setTimeout(() => {
      ws.close()
      settle(new Error('Bridge not responding — is `npm run bridge` running?'))
    }, 6000)

    ws.onopen = () => {
      socket = ws
      attempt = 0
      dispatch(ws)
      settle(null)
      onConnection?.(everConnected ? 'reconnected' : 'open')
      everConnected = true
    }
    ws.onerror = () => {
      /**
       * The browser will not tell us why.
       *
       * A refused handshake and a rejected Origin arrive here identically — no
       * status, no reason, just `error` — and the two have completely different
       * fixes. The old message named only one of them, and confidently: it said
       * to start the bridge. When the real cause was the page being served on a
       * port outside the range the bridge trusts, that advice sent everyone to
       * inspect a process that was running perfectly the whole time.
       *
       * So say both, and put the actual port in front of them, since that is
       * the fact that distinguishes the two cases at a glance.
       */
      // The full explanation goes to the console; the screen gets one line.
      console.warn(
        `[bridge] cannot reach ${BRIDGE_WS_URL}: either it is not running, or this ` +
          `page's port (${location.port || '80'}) is outside the 5173-5199 / ` +
          '4173-4199 range it accepts.',
      )
      settle(
        new Error(
          "Can't reach the bridge — run npm run autostart:restart" +
            (/^(51(7[3-9]|[89]\d)|41(7[3-9]|[89]\d))$/.test(location.port) ? '' : ` (this page's port ${location.port} is refused)`),
        ),
      )
    }
    ws.onclose = () => {
      // A close before open is just a failed dial; after open it's a lost
      // session, and the two want different handling.
      settle(new Error('The bridge closed the connection.'))
      if (socket === ws) {
        socket = null
        onConnection?.('lost')
        scheduleReconnect()
      }
    }
  })

  return connecting
}

/** Open the socket early so the first "Hey Jarvis" isn't waiting on a handshake. */
export async function warmBridge(): Promise<void> {
  await connect()
  // Don't block startup if the bridge never announces — the dispatcher fills
  // the rail in whenever the list does turn up.
  await Promise.race([
    firstReady.promise,
    new Promise<void>((resolve) => setTimeout(resolve, 2500)),
  ])
}

// ---------------------------------------------------------------------------
// Turns
// ---------------------------------------------------------------------------

/**
 * No frame of any kind for two minutes means the turn is never coming back.
 * Generous on purpose: a long agent run can sit silent through a slow tool,
 * and cutting a real answer off is worse than waiting. What this catches is
 * the case that used to hang forever — the bridge alive but the turn lost.
 */
const IDLE_TIMEOUT_MS = 120_000

/** The turn in flight, so a barge-in can settle it locally. */
let pending: { finish: (fallback?: string) => void } | null = null

export async function ask(
  prompt: string,
  handlers: AskHandlers,
): Promise<AskResult> {
  /**
   * A new question supersedes the one in flight.
   *
   * Two concurrent turns genuinely would corrupt each other — both listeners
   * see every delta, and the first 'done' resolves both with the other's text —
   * but refusing the new one was the wrong way to prevent that. It surfaced as
   * "JARVIS is already answering", which is a sentence about this module's
   * bookkeeping rather than about anything the user did, and it contradicts the
   * premise the whole app is built on: say something and it becomes the turn.
   *
   * It fired far more than it looked like it should, because the only thing
   * that cleared the slot was a barge-in — and a barge-in only fires in guard
   * mode. A transcript can arrive well after the speech that produced it: the
   * segment queue means several can be waiting, and their onsets happened while
   * the machine was still listening, when nothing interrupts. So the second
   * utterance of a normal sentence could land on a turn that was already
   * running and simply be refused.
   *
   * Cancelling settles the old promise synchronously, so by the time the code
   * below claims the slot there is nothing left to collide with. The abandoned
   * turn's caller sees its own `stale()` check and stands down quietly.
   */
  if (pending) cancel()

  // Claim the slot in this same tick. connect() below awaits, and two calls
  // made before it settles would otherwise both sail past the check above.
  let cancelledWhileDialling = false
  pending = {
    finish: () => {
      cancelledWhileDialling = true
    },
  }

  let ws: WebSocket
  try {
    ws = await connect()
  } catch (err) {
    pending = null
    throw err
  }

  // Barged in on before the socket was even up. Nothing was ever asked.
  if (cancelledWhileDialling) {
    pending = null
    return { text: '', tools: [] }
  }

  const id = `a${++askSeq}`
  const tools: string[] = []
  let text = ''

  return new Promise((resolve, reject) => {
    let done = false
    let timer = 0

    const cleanup = () => {
      done = true
      pending = null
      clearTimeout(timer)
      ws.removeEventListener('message', onMessage)
      ws.removeEventListener('close', onClose)
      ws.removeEventListener('error', onError)
    }

    let costUsd: number | null = null
    let tier: string | undefined
    const finish = (fallback = '') => {
      if (done) return
      cleanup()
      // Prefer the streamed text; fall back to the final result if this build
      // didn't emit deltas.
      resolve({ text: (text || fallback).trim(), tools, costUsd, tier })
    }

    const fail = (err: Error) => {
      if (done) return
      cleanup()
      reject(err)
    }

    const arm = () => {
      clearTimeout(timer)
      timer = window.setTimeout(() => {
        fail(new Error('The bridge went quiet — that turn was lost, sir.'))
      }, IDLE_TIMEOUT_MS)
    }

    const onMessage = (e: MessageEvent) => {
      // Any frame at all is proof of life, including ones this turn ignores.
      arm()

      let msg: Frame
      try {
        msg = JSON.parse(e.data as string)
      } catch {
        // A frame we can't read is not a reason to abandon the turn. It used
        // to be: the parse threw inside the listener, nothing settled the
        // promise, and App's `busy` flag stayed true for the life of the page.
        return
      }

      /**
       * Somebody else's answer.
       *
       * A superseded turn keeps streaming for a moment after it is abandoned,
       * and this listener is attached to the socket rather than to a turn — so
       * without this check the tail of the old answer is read as the beginning
       * of the new one. Measured before it existed: ask for ALPHA, barge in,
       * ask for BRAVO, and BRAVO's answer came back as "ALPHA".
       */
      if (msg.ask && msg.ask !== id) return

      try {
        switch (msg.type) {
          case 'text':
            text += msg.delta ?? ''
            handlers.onText(msg.delta ?? '')
            break

          case 'tool':
            if (!msg.name) break
            tools.push(msg.name)
            // The bridge says what the tool is doing in words ("Checking
            // Jira"); the tool's own name is the fallback for an older bridge.
            handlers.onTool(msg.label || prettyToolName(msg.name))
            break

          case 'done':
            costUsd = typeof msg.costUsd === 'number' ? msg.costUsd : null
            tier = msg.tier
            finish(msg.text ?? '')
            break

          case 'error':
            // Marked as meant to be heard: the bridge writes these as plain
            // sentences for exactly that, and an error that only appears as
            // text on a screen nobody is looking at is a silent failure.
            fail(
              Object.assign(new Error(msg.message ?? 'The bridge reported an error.'), {
                spoken: true,
              }),
            )
            break
        }
      } catch (err) {
        fail(err instanceof Error ? err : new Error(String(err)))
      }
    }

    const onClose = () => {
      fail(new Error('The bridge disconnected mid-answer — that session is gone.'))
    }
    const onError = () => {
      fail(new Error('The connection to the bridge failed.'))
    }

    pending = { finish }
    ws.addEventListener('message', onMessage)
    ws.addEventListener('close', onClose)
    ws.addEventListener('error', onError)
    arm()

    try {
      ws.send(JSON.stringify({ type: 'ask', text: prompt, id }))
    } catch (err) {
      // The socket can go into CLOSING between connect() resolving and here.
      fail(err instanceof Error ? err : new Error(String(err)))
    }
  })
}

/**
 * Cut JARVIS off mid-answer.
 *
 * Tells the bridge to stop, then settles the in-flight turn here rather than
 * waiting for a 'done' that a barge-in may never produce. Whatever he had
 * already said is returned, so the caller's await always comes back and the
 * transcript keeps the half-sentence the user actually heard.
 */
export function cancel(): void {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'interrupt' }))
  }
  pending?.finish()
}

/** The older name for `cancel()`. */
export function interrupt(): void {
  cancel()
}

/** `mcp__higgsfield__generate_image` -> `higgsfield · generate image` */
function prettyToolName(raw: string): string {
  if (!raw.startsWith('mcp__')) return raw
  const [, server, ...rest] = raw.split('__')
  // claude.ai connectors arrive as `claude_ai_Google_Calendar`; the badge only
  // needs the part a person would recognise.
  const label = server.replace(/^claude_ai_/, '').replace(/_/g, ' ')
  return `${label} · ${rest.join(' ').replace(/_/g, ' ')}`
}
