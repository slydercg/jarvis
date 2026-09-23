import { query } from '@anthropic-ai/claude-agent-sdk'

/**
 * Proactive alerts: a heads-up before a meeting, and a word when mail arrives
 * that genuinely needs you.
 *
 * A voice assistant that only ever answers is a search box with a voice. The
 * useful one says "Sir, the design review is in ten minutes" without being
 * asked. The hard part is doing that without spending money on every tick.
 *
 * So the watcher is one long-lived agent session of its own — separate from
 * the conversation, on the fast model at low effort — that stays open, so its
 * prompt and tool definitions stay cached and each check costs cents rather
 * than the ~$0.28 a cold session costs. It is asked two narrow questions on a
 * schedule and answers in JSON:
 *
 *   calendar, every JARVIS_ALERT_CAL_MIN (20): what starts in the next two
 *     hours? Each meeting then gets a local timer, so the alert itself fires
 *     at the right minute with no model call at all.
 *   mail, every JARVIS_ALERT_MAIL_MIN (15): anything unread since the last
 *     look, from a real person, that needs a reply soon?
 *
 * It runs only while a page is open to hear it, within working hours
 * (JARVIS_ALERT_HOURS, 8-19 by default, weekdays unless
 * JARVIS_ALERT_WEEKENDS=on), and its tools are read-only: it can never send,
 * accept or change anything. JARVIS_ALERTS=off turns the whole thing off.
 */

const ENABLED = process.env.JARVIS_ALERTS !== 'off'
const LEAD_MIN = Number(process.env.JARVIS_ALERT_LEAD_MIN ?? 10)
const CAL_MIN = Number(process.env.JARVIS_ALERT_CAL_MIN ?? 20)
const MAIL_MIN = Number(process.env.JARVIS_ALERT_MAIL_MIN ?? 15)
const WEEKENDS = process.env.JARVIS_ALERT_WEEKENDS === 'on'
const [FROM_H, TO_H] = (process.env.JARVIS_ALERT_HOURS ?? '8-19').split('-').map(Number)

/** How far ahead a calendar check looks. Longer than the poll, so nothing slips between checks. */
const HORIZON_MIN = Math.max(120, CAL_MIN * 3)
/**
 * Meeting prep: this many minutes before the heads-up, the watcher gathers
 * where things stand with these people (Granola notes, the latest mail,
 * open Jira items), so the heads-up can say it. JARVIS_MEETING_PREP=off
 * turns it off.
 */
const PREP = process.env.JARVIS_MEETING_PREP !== 'off'
const PREP_AHEAD_MIN = 5
/** A check that has not answered in this long is abandoned; the next tick tries again. */
const CHECK_TIMEOUT_MS = 180_000

const WATCHER_PROMPT = `You are a background watcher for a personal assistant. You never
talk to the user. You are asked narrow questions about their calendar and mail,
and you answer with ONE JSON object and nothing else: no prose, no markdown
fences. Check EVERY calendar and mailbox you have: the Protective work account
first (protective_get_calendar, protective_get_inbox) — it is the main one — then
Microsoft 365 / Outlook (the SCG account), then Gmail and Google Calendar. Search
for tools with ToolSearch if they are not in front of you ("calendar", "gmail",
"outlook", "granola", "jira"). If a source is not connected, answer as if it
were empty. Never take any action that changes anything — you only read.`

export function alertsEnabled() {
  return ENABLED
}

export function alertsSummary() {
  if (!ENABLED) return 'alerts off'
  const days = WEEKENDS ? 'every day' : 'weekdays'
  return (
    `alerts: meetings ${LEAD_MIN} min ahead (calendar checked every ${CAL_MIN} min)` +
    (MAIL_MIN > 0 ? `, urgent mail every ${MAIL_MIN} min` : ', mail off') +
    `; ${FROM_H}:00–${TO_H}:00 ${days}`
  )
}

function withinHours(now = new Date()) {
  const day = now.getDay()
  if (!WEEKENDS && (day === 0 || day === 6)) return false
  const h = now.getHours()
  return h >= FROM_H && h < TO_H
}

/** The first {...} in a reply, parsed; null if there is none that parses. */
function parseJson(text) {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
}

/**
 * Start the watcher.
 *
 *   mcpServers  the same servers the conversation has (claude.ai connectors
 *               arrive on their own with the login)
 *   isReadOnly  (toolName) => boolean — the bridge's own gate, 'allow' only
 *   broadcast   (alert) => void — delivers to every open page
 *   listening   () => boolean — whether any page is open
 *   localNow    () => string — "Tuesday, 23 September 2026, 4:41 pm (Zone)"
 *   model, effort
 */
export function startAlerts({ mcpServers, isReadOnly, broadcast, listening, localNow, model, effort }) {
  if (!ENABLED) return { stop() {} }

  // --- one session, fed a question at a time -------------------------------
  const inbox = []
  let wake = null
  let stopped = false
  async function* questions() {
    while (!stopped) {
      const q = inbox.shift() ?? (await new Promise((r) => (wake = r)))
      if (stopped || q == null) return
      yield { type: 'user', message: { role: 'user', content: q }, parent_tool_use_id: null }
    }
  }

  const session = query({
    prompt: questions(),
    options: {
      mcpServers,
      systemPrompt: WATCHER_PROMPT,
      settingSources: [],
      strictMcpConfig: false,
      model,
      effort,
      maxTurns: 12,
      permissionMode: 'default',
      // Read-only, always. Anything the conversation would allow outright is
      // fine; anything it would confirm or refuse, the watcher never does.
      canUseTool: async (name) =>
        isReadOnly(name)
          ? { behavior: 'allow' }
          : { behavior: 'deny', message: 'The watcher only reads. Do not try to change anything.' },
    },
  })

  /**
   * Resolvers for questions in flight, oldest first. The session answers in
   * order, so each result belongs to the head of this queue — including a
   * question that already timed out, whose late answer is then dropped here
   * rather than being handed to the next question as if it were its own.
   */
  const waiting = []
  let lastCost = 0
  ;(async () => {
    try {
      for await (const msg of session) {
        if (msg.type !== 'result') continue
        const cost = msg.total_cost_usd ?? lastCost
        const spent = cost - lastCost
        lastCost = cost
        waiting.shift()?.({ text: msg.subtype === 'success' ? (msg.result ?? '') : '', spent })
      }
    } catch (err) {
      if (!stopped) console.warn(`[jarvis] alerts: the watcher stopped: ${err?.message ?? err}`)
    }
  })()

  /** One question, one JSON answer. */
  const ask = (text) =>
    new Promise((resolve) => {
      let done = false
      const finish = (r) => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve(r)
      }
      const timer = setTimeout(() => finish({ text: '', spent: 0 }), CHECK_TIMEOUT_MS)
      waiting.push(finish)
      if (wake) {
        const w = wake
        wake = null
        w(text)
      } else inbox.push(text)
    })

  // --- meetings ----------------------------------------------------------------
  /** id|start -> timer, so a meeting seen on every check is scheduled once. */
  const scheduled = new Map()

  async function checkCalendar() {
    const { text, spent } = await ask(
      `It is ${localNow()}. List events on every calendar that start between now and ` +
        `${HORIZON_MIN} minutes from now. Skip all-day events and events the user ` +
        `declined, and list a meeting that appears on two calendars once. Answer exactly: ` +
        `{"events":[{"id":"...","title":"...","start":"<ISO 8601 with offset>",` +
        `"where":"<room, link or empty>","who":["<up to 8 attendee names or addresses>"]}]}`,
    )
    const events = parseJson(text)?.events
    if (!Array.isArray(events)) {
      console.warn('[jarvis] alerts: the calendar check did not come back as expected')
      return
    }
    let added = 0
    for (const e of events) {
      const start = Date.parse(e?.start)
      if (!e?.title || Number.isNaN(start)) continue
      const key = `${e.id ?? e.title}|${start}`
      if (scheduled.has(key)) continue
      // Already started: too late for a heads-up.
      if (start <= Date.now()) continue
      // Inside the lead window but not yet started: the delay is negative, so
      // it fires straight away.
      const delay = start - LEAD_MIN * 60_000 - Date.now()
      const entry = { timer: null, prepTimer: null, prep: null }
      const who = Array.isArray(e.who) ? e.who.map(String).slice(0, 8) : []
      entry.timer = setTimeout(
        () => {
          scheduled.delete(key)
          clearTimeout(entry.prepTimer)
          if (!listening()) return
          broadcast({
            kind: 'meeting',
            title: String(e.title),
            detail: e.where ? String(e.where) : '',
            at: new Date(start).toISOString(),
            ...(entry.prep ? { prep: entry.prep } : {}),
          })
        },
        Math.max(0, delay),
      )
      // Prep a few minutes before the heads-up, so it is ready when it fires.
      // Only when there is time for it; a heads-up is never held back waiting.
      const prepDelay = delay - PREP_AHEAD_MIN * 60_000
      if (PREP && prepDelay > -PREP_AHEAD_MIN * 60_000 + 60_000) {
        entry.prepTimer = setTimeout(
          () => {
            if (!listening() || stopped) return
            void prepMeeting(String(e.title), start, who).then((prep) => {
              entry.prep = prep
            })
          },
          Math.max(0, prepDelay),
        )
      }
      scheduled.set(key, entry)
      added++
    }
    console.log(
      `[jarvis] alerts: calendar checked, ${events.length} upcoming` +
        (added ? `, ${added} newly scheduled` : '') +
        ` ($${spent.toFixed(3)})`,
    )
  }

  // --- meeting prep ---------------------------------------------------------------
  /**
   * Where things stand before a meeting: the last notes with these people or
   * on this subject, the latest mail thread with them, open Jira items. Two
   * spoken sentences and up to three points; null when there is nothing.
   */
  async function prepMeeting(title, start, who) {
    const when = new Date(start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    const { text, spent } = await ask(
      `It is ${localNow()}. Prepare Mark for "${title}" at ${when}` +
        (who.length ? ` with ${who.join(', ')}` : '') +
        '. Look at: the most recent Granola meeting notes with these people or on this ' +
        'subject; the latest email thread with them in any mailbox; open Jira issues those ' +
        'notes or emails mention. Answer exactly {"summary":"<one or two spoken sentences: ' +
        'where things stand and what he needs to do or decide in this meeting>","points":' +
        '["<up to 3 short points>"]}. If nothing relevant turns up, {"summary":"","points":[]}.',
    )
    const prep = parseJson(text)
    console.log(`[jarvis] alerts: prepared "${title}" ($${spent.toFixed(3)})`)
    if (!prep?.summary) return null
    return {
      summary: String(prep.summary).slice(0, 400),
      points: (Array.isArray(prep.points) ? prep.points : []).map(String).slice(0, 3),
    }
  }

  // --- mail --------------------------------------------------------------------
  const seenMail = new Set()
  let mailSince = new Date(Date.now() - MAIL_MIN * 60_000)

  async function checkMail() {
    const since = mailSince
    mailSince = new Date()
    const { text, spent } = await ask(
      `It is ${localNow()}. Look at unread email received since ${since.toISOString()} ` +
        'in every mailbox — Protective first, then SCG and Gmail. ' +
        'Pick only messages from a real person that need the user\'s attention or a reply ' +
        'soon: a direct question, a deadline today, something blocked on them. Never ' +
        'newsletters, notifications, receipts, marketing or automated mail. At most three. ' +
        'Answer exactly: {"emails":[{"id":"...","from":"<name>","subject":"...",' +
        '"why":"<under ten words>"}]}',
    )
    const emails = parseJson(text)?.emails
    if (!Array.isArray(emails)) {
      console.warn('[jarvis] alerts: the mail check did not come back as expected')
      return
    }
    let fresh = 0
    for (const m of emails.slice(0, 3)) {
      const key = String(m?.id ?? `${m?.from}|${m?.subject}`)
      if (!m?.from || seenMail.has(key)) continue
      seenMail.add(key)
      fresh++
      if (listening()) {
        broadcast({
          kind: 'mail',
          title: String(m.from),
          detail: [m.subject, m.why].filter(Boolean).map(String).join(' — '),
          at: new Date().toISOString(),
        })
      }
    }
    console.log(`[jarvis] alerts: mail checked, ${fresh} needing attention ($${spent.toFixed(3)})`)
  }

  // --- the clock -----------------------------------------------------------------
  const due = { calendar: 0, mail: 0 }
  let busy = false
  const tick = async () => {
    if (busy || stopped || !listening() || !withinHours()) return
    busy = true
    try {
      const now = Date.now()
      if (now >= due.calendar) {
        due.calendar = now + CAL_MIN * 60_000
        await checkCalendar()
      }
      if (MAIL_MIN > 0 && now >= due.mail) {
        due.mail = now + MAIL_MIN * 60_000
        await checkMail()
      }
    } catch (err) {
      console.warn(`[jarvis] alerts: check failed: ${err?.message ?? err}`)
    } finally {
      busy = false
    }
  }
  const interval = setInterval(tick, 30_000)
  // First look soon after a page opens, not a full interval later.
  const first = setTimeout(tick, 20_000)

  return {
    stop() {
      stopped = true
      clearInterval(interval)
      clearTimeout(first)
      for (const t of scheduled.values()) {
        clearTimeout(t.timer)
        clearTimeout(t.prepTimer)
      }
      wake?.(null)
      session.close?.()
    },
  }
}
