import { query } from '@anthropic-ai/claude-agent-sdk'
import { commitmentsWith } from './commitments.mjs'
import { localDay, readJsonFile, writeJsonFile } from './days.mjs'
import { learnSites, ticketUrl } from './tickets.mjs'
import { connectorDenylist } from './connectors.mjs'
import { BACKGROUND_DISALLOWED } from './policy.mjs'
import { createStreaks, stuckAlert } from './health.mjs'

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

/** When each check last succeeded today, and the calendar's last answer. */
const STATE_FILE = 'alerts-state.json'

/**
 * When each check is next due, given what ran before a restart. A check that
 * succeeded within its interval today waits out the rest of it; anything else
 * — never run, run yesterday, interval turned off — is due at once (0).
 */
export function resumeDue(saved, { now = Date.now(), day = localDay(), minutes }) {
  const due = { calendar: 0, mail: 0, portfolio: 0 }
  if (!saved || saved.day !== day) return due
  for (const job of Object.keys(due)) {
    const last = Number(saved.last?.[job] ?? 0)
    const every = Number(minutes?.[job] ?? 0) * 60_000
    if (last > 0 && every > 0 && now - last < every) due[job] = last + every
  }
  return due
}
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
/**
 * Portfolio pulse: every JARVIS_PORTFOLIO_ALERT_MIN (60), ask Jira (and Azure
 * DevOps if connected) for blocked high-priority work and how each open
 * sprint is tracking. A newly blocked P1, or a sprint whose time has run well
 * ahead of its work, is said once. 0 turns it off.
 */
const PORTFOLIO_MIN = Number(process.env.JARVIS_PORTFOLIO_ALERT_MIN ?? 60)
const JIRA_PROJECTS = (process.env.JARVIS_JIRA_PROJECTS ?? 'NI,RPT').split(',').map((s) => s.trim()).filter(Boolean)
/** Time elapsed minus work done, in points of percent, before a sprint counts as slipping. */
const SLIP_PCT = Number(process.env.JARVIS_SPRINT_SLIP_PCT ?? 25)
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
    (PORTFOLIO_MIN > 0 ? `, portfolio every ${PORTFOLIO_MIN} min (${JIRA_PROJECTS.join(', ')})` : '') +
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
 *   vips        () => string[] — people whose mail gets through focus
 *   onFocusBlock (title, startMs, endMs) => void — a focus block on the calendar
 *   onCalendar  (events) => void — the whole day, every calendar, for the timeline
 *   onPortfolio ({ blocked, behind }) => void — the portfolio's standing
 *   model, effort
 */
export function startAlerts({
  mcpServers,
  isReadOnly,
  broadcast,
  listening,
  localNow,
  vips = () => [],
  onFocusBlock = () => {},
  onCalendar = () => {},
  onPortfolio = () => {},
  model,
  effort,
}) {
  if (!ENABLED) return { stop() {} }

  // Checks that keep failing are said out loud once, not only logged.
  const health = createStreaks({
    onStuck: (job, n, reason) => {
      console.warn(`[jarvis] alerts: ${job} has failed ${n} times running; telling the user`)
      broadcast(stuckAlert(job, n, reason))
    },
  })

  /** Note that a check succeeded, for resumeDue after a restart. */
  function recordRun(job, extra = {}) {
    const s = readJsonFile(STATE_FILE, {})
    const today = s.day === localDay() ? s : { day: localDay(), last: {} }
    writeJsonFile(STATE_FILE, { ...today, ...extra, last: { ...today.last, [job]: Date.now() } })
  }

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
      // No files, shell, web or subagents for a watcher reading unvetted mail.
      disallowedTools: [...connectorDenylist(), ...BACKGROUND_DISALLOWED],
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
      `It is ${localNow()}. List events on every calendar that start at any time today, ` +
        `or between now and ${HORIZON_MIN} minutes from now — earlier ones today included, ` +
        `for the day's timeline. Skip all-day events and events the user ` +
        `declined, and list a meeting that appears on two calendars once. Mark "focus": true ` +
        `on blocks he set aside for himself — Focus time, Heads down, Deep work, Do not book, ` +
        `no other attendees and a title that says so. Answer exactly: ` +
        `{"events":[{"id":"...","title":"...","start":"<ISO 8601 with offset>","end":"<ISO 8601 with offset>",` +
        `"where":"<room, link or empty>","who":["<up to 8 attendee names or addresses>"],"focus":false,` +
        `"account":"Protective|SCG|Google"}]}`,
    )
    const events = parseJson(text)?.events
    if (!Array.isArray(events)) {
      console.warn('[jarvis] alerts: the calendar check did not come back as expected')
      health.fail('calendar', 'no usable answer')
      return
    }
    health.ok('calendar')
    health.ok('watcher')
    onCalendar(events)
    const added = schedule(events)
    recordRun('calendar', { events })
    console.log(
      `[jarvis] alerts: calendar checked, ${events.length} upcoming` +
        (added ? `, ${added} newly scheduled` : '') +
        ` ($${spent.toFixed(3)})`,
    )
  }

  /**
   * Set a timer for each meeting's heads-up (and its prep), and for each focus
   * block. Keyed, so an event already scheduled is left alone. Used by every
   * calendar check, and at startup with the last check's answer, so a restart
   * does not lose the heads-ups it had set.
   */
  function schedule(events) {
    let added = 0
    for (const e of events) {
      const start = Date.parse(e?.start)
      if (!e?.title || Number.isNaN(start)) continue
      const key = `${e.id ?? e.title}|${start}`
      if (scheduled.has(key)) continue
      // A focus block is not a meeting: it starts focus, and says nothing.
      if (e.focus === true) {
        const end = Date.parse(e?.end)
        if (Number.isNaN(end) || end <= Date.now()) continue
        const timer = setTimeout(
          () => {
            scheduled.delete(key)
            onFocusBlock(String(e.title), start, end)
          },
          Math.max(0, start - Date.now()),
        )
        scheduled.set(key, { timer, prepTimer: null, prep: null })
        added++
        continue
      }
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
    return added
  }

  // --- meeting prep ---------------------------------------------------------------
  /**
   * Where things stand before a meeting — on the subject and with the people:
   * the last notes with them or on this, the latest mail thread, open Jira
   * items, and what is owed either way (from the promise ledger and what the
   * notes say). Two spoken sentences and up to four points; null when there
   * is nothing.
   */
  async function prepMeeting(title, start, who) {
    const when = new Date(start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    const owed = who.length ? commitmentsWith(who) : []
    const { text, spent } = await ask(
      `It is ${localNow()}. Prepare Mark for "${title}" at ${when}` +
        (who.length ? ` with ${who.join(', ')}` : '') +
        '. Look at: the most recent Granola meeting notes with these people or on this ' +
        'subject; the latest email thread with them in any mailbox; open Jira issues those ' +
        'notes or emails mention. For the people: what he promised them and what they owe him.' +
        (owed.length ? ` Already on record: ${JSON.stringify(owed.map(({ direction, who, what, due }) => ({ direction, who, what, due })))}.` : '') +
        ' Answer exactly {"summary":"<one or two spoken sentences: where things stand, anything ' +
        'owed either way, and what he needs to do or decide in this meeting>","points":' +
        '["<up to 4 short points; owed items as \'You owe Chris: …\' or \'Chris owes you: …\'>"]}. ' +
        'If nothing relevant turns up, {"summary":"","points":[]}.',
    )
    const prep = parseJson(text)
    console.log(`[jarvis] alerts: prepared "${title}" ($${spent.toFixed(3)})`)
    if (!prep?.summary) return null
    return {
      summary: String(prep.summary).slice(0, 400),
      points: (Array.isArray(prep.points) ? prep.points : []).map(String).slice(0, 4),
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
        `Mark "vip": true when the sender is one of these people — ${JSON.stringify(vips())} — or ` +
        'it is about a production incident, outage or security event. ' +
        'Answer exactly: {"emails":[{"id":"...","from":"<name>","subject":"...",' +
        '"why":"<under ten words>","vip":false}]}',
    )
    const emails = parseJson(text)?.emails
    if (!Array.isArray(emails)) {
      console.warn('[jarvis] alerts: the mail check did not come back as expected')
      health.fail('mail', 'no usable answer')
      return
    }
    health.ok('mail')
    health.ok('watcher')
    recordRun('mail')
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
          ...(m.vip === true ? { vip: true } : {}),
        })
      }
    }
    console.log(`[jarvis] alerts: mail checked, ${fresh} needing attention ($${spent.toFixed(3)})`)
  }

  // --- portfolio ---------------------------------------------------------------
  const PORTFOLIO_SEEN = 'portfolio-alerts.json'

  async function checkPortfolio() {
    const { text, spent } = await ask(
      `It is ${localNow()}. Using Jira (projects ${JIRA_PROJECTS.join(', ')}; search for the Jira ` +
        'tools if they are not in front of you) and Azure DevOps if it is connected: (1) issues in ' +
        'open sprints with priority Highest, High, P1 or Critical that are Blocked, On Hold or ' +
        'flagged; (2) for each open sprint, its dates and how many issues are done out of the total. ' +
        'Also give the Jira site address (https://<name>.atlassian.net, from the Jira tools) and the ' +
        'Azure DevOps organisation address if you used it. ' +
        'Answer exactly {"sites":{"jira":"<https://…atlassian.net or empty>","ado":"<https://… or empty>"},' +
        '"blocked":[{"key":"<RPT-123, or the ADO id>","source":"jira|ado","project":"<ADO project or empty>",' +
        '"title":"...","status":"...","owner":"<name or empty>"}],' +
        '"sprints":[{"name":"...","project":"...","start":"YYYY-MM-DD","end":"YYYY-MM-DD","done":0,"total":0}]}. ' +
        'If Jira is not connected, {"blocked":[],"sprints":[],"unavailable":true}.',
    )
    const r = parseJson(text)
    if (!r || r.unavailable) {
      console.log(`[jarvis] alerts: portfolio ${r?.unavailable ? 'unavailable (no Jira)' : 'check did not come back as expected'}`)
      // No Jira connected is a setting, not a failure.
      if (!r) health.fail('portfolio', 'no usable answer')
      return
    }
    health.ok('portfolio')
    recordRun('portfolio')
    if (r.sites) learnSites(r.sites)
    onPortfolio({
      blocked: Array.isArray(r.blocked) ? r.blocked.length : 0,
      behind: (Array.isArray(r.sprints) ? r.sprints : [])
        .filter((sp) => (sprintSlip(sp) ?? 0) >= SLIP_PCT)
        .map((sp) => String(sp.name)),
    })
    const seen = readJsonFile(PORTFOLIO_SEEN, { blocked: {}, slipping: {} })
    const today = new Date().toLocaleDateString('en-CA')
    const fresh = (Array.isArray(r.blocked) ? r.blocked : []).filter((b) => b?.key && !seen.blocked[b.key])
    for (const b of fresh) seen.blocked[b.key] = today
    if (fresh.length && listening()) {
      const first = fresh[0]
      broadcast({
        kind: 'portfolio',
        label: 'Portfolio',
        title: fresh.length === 1 ? `${first.key} is blocked` : `${fresh.length} high-priority items newly blocked`,
        detail: '',
        // One line per ticket — key, title, who has it — each key a link.
        items: fresh.slice(0, 30).map((b) => ({
          key: String(b.key),
          title: String(b.title ?? ''),
          detail: [b.owner, b.status].filter(Boolean).map(String).join(' · '),
          url: ticketUrl(b) ?? undefined,
        })),
        say:
          fresh.length === 1
            ? `Sir, ${first.title} is blocked${first.owner ? `, with ${first.owner}` : ''}.`
            : `Sir, ${fresh.length} high-priority items are newly blocked, ${first.title} among them.`,
        at: new Date().toISOString(),
      })
    }
    for (const sp of Array.isArray(r.sprints) ? r.sprints : []) {
      const slip = sprintSlip(sp)
      if (slip === null || slip < SLIP_PCT) continue
      const k = `${sp.project ?? ''}|${sp.name}`
      if (seen.slipping[k] === today) continue
      seen.slipping[k] = today
      if (!listening()) continue
      broadcast({
        kind: 'portfolio',
        label: 'Sprint',
        title: `${sp.name} is behind`,
        detail: `${sp.done} of ${sp.total} done with ${Math.round(elapsedPct(sp))}% of the sprint gone`,
        say: `Sir, ${sp.name} is behind — ${sp.done} of ${sp.total} done with ${Math.round(elapsedPct(sp))} percent of the sprint gone.`,
        at: new Date().toISOString(),
      })
    }
    // Forget blocked items after two weeks so a re-block is said again.
    const cutoff = new Date(Date.now() - 14 * 86_400_000).toLocaleDateString('en-CA')
    for (const [k, d] of Object.entries(seen.blocked)) if (d < cutoff) delete seen.blocked[k]
    writeJsonFile(PORTFOLIO_SEEN, seen)
    console.log(`[jarvis] alerts: portfolio checked, ${fresh.length} newly blocked ($${spent.toFixed(3)})`)
  }

  // --- the clock -----------------------------------------------------------------
  // Carried over a restart: checks that ran recently wait out their interval
  // instead of running again at once, and the last calendar answer puts the
  // meeting heads-ups back. Restarts were most of the background spend — the
  // first check after each costs two to four times a routine one.
  const saved = readJsonFile(STATE_FILE, {})
  const due = resumeDue(saved, { minutes: { calendar: CAL_MIN, mail: MAIL_MIN, portfolio: PORTFOLIO_MIN } })
  if (due.calendar > Date.now() && Array.isArray(saved.events)) {
    const n = schedule(saved.events)
    console.log(`[jarvis] alerts: carried over from ${Math.round((Date.now() - saved.last.calendar) / 60_000)} min ago` +
      `${n ? `, ${n} heads-up${n === 1 ? '' : 's'} rescheduled` : ''}; next calendar check in ${Math.round((due.calendar - Date.now()) / 60_000)} min`)
  }
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
      if (PORTFOLIO_MIN > 0 && now >= due.portfolio) {
        due.portfolio = now + PORTFOLIO_MIN * 60_000
        await checkPortfolio()
      }
    } catch (err) {
      console.warn(`[jarvis] alerts: check failed: ${err?.message ?? err}`)
      health.fail('watcher', err?.message ?? String(err))
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

/** Percent of a sprint's days gone, or null without dates. */
export function elapsedPct(sp, now = Date.now()) {
  const a = Date.parse(`${sp?.start}T00:00:00`)
  const b = Date.parse(`${sp?.end}T23:59:59`)
  if (Number.isNaN(a) || Number.isNaN(b) || b <= a) return null
  return Math.min(100, Math.max(0, ((now - a) / (b - a)) * 100))
}

/**
 * How far a sprint's time has run ahead of its work, in points of percent;
 * null when there is too little to judge (no dates, no issues, or under a
 * third of the way in, when "behind" is mostly noise).
 */
export function sprintSlip(sp, now = Date.now()) {
  const elapsed = elapsedPct(sp, now)
  const total = Number(sp?.total)
  const done = Number(sp?.done)
  if (elapsed === null || !(total > 0) || Number.isNaN(done) || elapsed < 33) return null
  return elapsed - (done / total) * 100
}
