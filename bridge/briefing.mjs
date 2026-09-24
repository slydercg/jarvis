import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { JARVIS_HOME } from './memory.mjs'
import { askReadOnly } from './agent.mjs'
import { recordDay } from './days.mjs'
import { protective, protectiveConfigured } from './protective.mjs'
import { mailLink, matchMail, matchTask, readerId, todoLink } from './maillinks.mjs'

/**
 * The brief: what needs doing today, ranked, from every mailbox and calendar.
 *
 * The same rules as the emailed daily briefing, condensed for the ear: read
 * the CONTENT of the mail, decide what is being asked of him and why it matters
 * today, reconcile with To Do, and lead with one "focus first" line. Built by a
 * separate, read-only agent session (it can never draft, send or add), cached
 * for the day so "brief me" answers in a moment, and offered unprompted the
 * first time he is opened each morning.
 */

const BRIEF_FILE = join(JARVIS_HOME, 'brief.json')
const MAX_AGE_MS = Number(process.env.JARVIS_BRIEF_MAX_AGE_MIN ?? 90) * 60_000
/** Morning window for the unprompted offer, local hours. */
const [OFFER_FROM, OFFER_TO] = (process.env.JARVIS_BRIEF_HOURS ?? '5-11').split('-').map(Number)

const PROMPT = `You prepare a morning brief for Mark, a CTO. You never talk to him; you
return ONE JSON object and nothing else — no prose, no markdown fences.

Sources — read every one you have, in parallel where you can:
- PROTECTIVE (his main work account): protective_get_inbox, protective_get_calendar
  (day "today"), protective_get_todo, protective_get_flagged.
- SCG (Slyder Consulting Group): the Microsoft 365 / Outlook tools — search the inbox
  and today's calendar. Search for them with ToolSearch ("outlook", "calendar") if
  they are not in front of you.
- Personal Gmail and Google Calendar if connected (lower priority).
If a source is missing or fails, carry on and record it under "sources".

Ranking — tell him what to DO, not what arrived. Judge each message by its content:
- Higher: a question, decision, approval or sign-off asked of him; a deadline
  ("action required", "by <date>", cutovers); a leader, direct report or key
  stakeholder; budget, headcount, acquisitions, outages, production issues, org
  changes; a thread he owes a reply on; risk or escalation.
- Lower, or leave out: automated reports, dashboards, notifications, newsletters,
  cc-only invites, anything with no ask.
- Reconcile with To Do: a task whose title matches an email subject is ONE item
  (source "email+task"). Flagged Emails and Daily Meeting Actions outrank general
  tasks. Waiting On Others is not his work — leave it out of the items.
- Every action is a specific verb phrase: "Approve the Q4 vendor renewal for Chris",
  "Reply to Cathrene with the provisioning steps". Never "review email from X",
  never a restated subject.
- At most 8 items. Tiers: "now" (today), "soon" (this week), "fyi".

Calendar: today's meetings across all calendars in local time, marking any overlap.

Answer exactly:
{"focus":"<one or two spoken sentences: the single most important thing first, then the next two>",
 "items":[{"priority":"now|soon|fyi","account":"Protective|SCG|Gmail","who":"<person or list>","action":"<verb phrase>","why":"<under 12 words>","source":"email|task|email+task","from":"<the sender's name as it appears on the email, or the To Do list for a task>","subject":"<the email subject or task title, exactly as written>","received":"<when the email arrived or the task was created, ISO 8601, if known>","messageId":"<for an email, its id exactly as the mail tool returned it, character for character; leave out for a task>"}],
 "meetings":[{"time":"<h:mm am/pm>","title":"...","account":"Protective|SCG|Google","clash":false}],
 "sources":{"protective":"ok|<why not>","scg":"ok|<why not>","todo":"ok|<why not>","google":"ok|none"}}`

/**
 * Where a brief line came from, in a few words: "Protective mail · Jane Doe ·
 * Tue". Built here rather than by the model, so it reads the same on every
 * line, and shown under each item on screen. "What's the VAS invoice?" had no
 * answer when the line said only what to do, not whose email asked it.
 */
export function sourceLine(item, now = new Date()) {
  const kind = { email: 'mail', task: 'To Do', 'email+task': 'mail + To Do' }[item?.source] ?? 'mail'
  const parts = [`${item?.account || 'Mail'} ${kind}`]
  const from = readableName(String(item?.from || item?.who || '').trim())
  if (from) parts.push(from)
  const t = Date.parse(item?.received ?? '')
  if (Number.isFinite(t)) parts.push(dayWord(new Date(t), now))
  return parts.join(' · ')
}

/**
 * A bare address reads as a name: "chris.patrick@protective.com" -> "Chris
 * Patrick". Mail flows often carry only the address, and a line full of
 * addresses is hard to scan. A role address ("cfo@…") stays as it is, upper-cased.
 */
function readableName(from) {
  const named = /^"?([^"<]+?)"?\s*<[^>]+>$/.exec(from)
  if (named) return named[1]
  const m = /^([^@\s]+)@[^@\s]+$/.exec(from)
  if (!m) return from
  const words = m[1].split(/[._-]+/).filter(Boolean)
  if (words.length === 1 && words[0].length <= 4) return words[0].toUpperCase()
  return words.map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(' ')
}

/** "today", "yesterday", "Tue" within the week, else "Sep 22". */
function dayWord(d, now) {
  const start = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const days = Math.round((start(now) - start(d)) / 86_400_000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 7) return d.toLocaleDateString('en-US', { weekday: 'short' })
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/** The brief as the conversation gets it: every item carries its source line. */
export function withSources(brief, now = new Date()) {
  const items = Array.isArray(brief?.items) ? brief.items : []
  return { ...brief, items: items.map((i) => ({ ...i, sourceLine: sourceLine(i, now) })) }
}

/**
 * Give each email item a link that opens it in Outlook.
 *
 * Protective: found in the inbox and flagged mail by subject (flow calls, no
 * model), falling back to the id the brief recorded. SCG: the bridge cannot
 * read that mailbox itself (it is a claude.ai connector), so the id the brief
 * builder copied from the Outlook tool is used, if it has the shape of one.
 *
 * A Protective To Do line opens the email behind it when there is one (a
 * "Flagged Emails" task is an email, and that link is the surest), else the
 * task itself in To Do on the web, when the flow returned the task's id.
 *
 * A line that cannot be matched simply has no link. Failures leave the brief
 * as it was.
 */
export async function withLinks(brief, lookup = protectiveMail, taskLookup = protectiveTasks) {
  const items = Array.isArray(brief?.items) ? brief.items : []
  const email = (i) => String(i.source ?? '').includes('email')
  const task = (i) => i.source === 'task'
  const protectiveLines = items.filter((i) => i.account === 'Protective')
  const read = async (fn) => {
    try {
      return await fn()
    } catch (err) {
      console.warn(`[jarvis] brief links: ${err.message}`)
      return []
    }
  }
  const messages = protectiveLines.some((i) => email(i) || task(i)) ? await read(lookup) : []
  const tasks = protectiveLines.some(task) ? await read(taskLookup) : []
  const linked = items.map((i) => {
    let link = null
    if (email(i) && (i.account === 'Protective' || i.account === 'SCG')) {
      const matched = i.account === 'Protective' ? matchMail(i, messages)?.id : null
      link = mailLink(matched ?? readerId(i.messageId))
    } else if (task(i) && i.account === 'Protective') {
      link = mailLink(matchMail(i, messages)?.id) ?? todoLink(matchTask(i, tasks)?.id)
    }
    return link ? { ...i, link } : i
  })
  return linked.some((i, n) => i !== items[n]) ? { ...brief, items: linked } : brief
}

async function protectiveTasks() {
  return protectiveConfigured() ? protective.todo() : []
}

async function protectiveMail() {
  if (!protectiveConfigured()) return []
  const [inbox, flagged] = await Promise.all([protective.inbox(25), protective.flagged().catch(() => [])])
  return [...inbox, ...flagged]
}

let cached = null
let building = null
let lastError = ''

const today = () => new Date().toLocaleDateString('en-CA')

function readSaved() {
  try {
    return JSON.parse(readFileSync(BRIEF_FILE, 'utf8'))
  } catch {
    return {}
  }
}
function save(patch) {
  try {
    mkdirSync(JARVIS_HOME, { recursive: true })
    writeFileSync(BRIEF_FILE, JSON.stringify({ ...readSaved(), ...patch }))
  } catch {
    // The cache is a convenience; losing it only costs a rebuild.
  }
}

/**
 * This morning's brief, even after a restart: what the end-of-day wrap
 * compares the day against. Null when none was built today.
 */
export function todaysBrief() {
  if (cached?.day === today()) return cached
  const saved = readSaved().last
  return saved?.day === today() ? saved : null
}

async function build(deps) {
  const brief = await askReadOnly(deps, {
    system: PROMPT,
    question: `It is ${deps.localNow()}. Prepare today's brief.`,
    label: 'brief',
  })
  if (!brief?.focus) throw new Error('the brief did not come back as expected')
  brief.items = (brief.items ?? []).slice(0, 8)
  return brief
}

/**
 * The day's brief: cached if fresh, else built (once, however many ask).
 * Returns { brief, builtAt } or throws.
 */
export function getBrief(deps, { refresh = false } = {}) {
  const fresh = cached && cached.day === today() && Date.now() - cached.builtAt < MAX_AGE_MS
  if (fresh && !refresh) return Promise.resolve(cached)
  if (building) return building
  building = build(deps)
    .then((brief) => {
      cached = { day: today(), builtAt: Date.now(), brief }
      save({ last: cached })
      recordDay({ brief })
      lastError = ''
      return cached
    })
    .catch((err) => {
      lastError = err.message
      throw err
    })
    .finally(() => {
      building = null
    })
  return building
}

export const briefStatus = () => ({
  ready: Boolean(cached && cached.day === today()),
  builtAt: cached?.builtAt ?? null,
  error: lastError,
})

/**
 * First page of the morning: build the brief in the background and, when it
 * is ready, offer it — once a day, weekdays unless weekends are on.
 */
export function maybeOfferBrief(deps, { weekends, broadcast }) {
  if (process.env.JARVIS_BRIEF === 'off') return
  const now = new Date()
  const day = now.getDay()
  if (!weekends && (day === 0 || day === 6)) return
  const h = now.getHours()
  if (h < OFFER_FROM || h >= OFFER_TO) return
  if (readSaved().offered === today() || offering) return
  // Marked offered only once a brief exists. It used to be marked first, so
  // one slow connector or bad answer at 7am meant no brief at all that day
  // and no sign one had been tried. A failure now waits and tries again.
  if (missed.day === today() && (missed.count >= BRIEF_TRIES || Date.now() - missed.at < BRIEF_RETRY_MS)) return
  offering = true
  getBrief(deps)
    .then(({ brief }) => {
      save({ offered: today() })
      broadcast({
        kind: 'brief',
        title: 'Morning brief ready',
        detail: brief.focus,
        at: new Date().toISOString(),
      })
    })
    .catch((err) => {
      missed = { day: today(), count: missed.day === today() ? missed.count + 1 : 1, at: Date.now() }
      const last = missed.count >= BRIEF_TRIES
      console.warn(`[jarvis] brief: ${err.message}${last ? '; giving up for today' : '; trying again in 20 min'}`)
      if (last) {
        broadcast({
          kind: 'reminder',
          title: "Couldn't build the morning brief",
          detail: `${BRIEF_TRIES} attempts failed. Details are in ~/.jarvis/logs/jarvis.log. Say "brief me" to try again.`,
          say: "Sir, I couldn't put this morning's brief together. Say 'brief me' if you'd like me to try again.",
          at: new Date().toISOString(),
        })
      }
    })
    .finally(() => {
      offering = false
    })
}

/** Tries at the morning brief per day, and the wait between them. */
const BRIEF_TRIES = 3
const BRIEF_RETRY_MS = 20 * 60_000
let offering = false
let missed = { day: '', count: 0, at: 0 }

/** The tool the conversation uses: `get_brief`, on the internal jarvis_brief server. */
export function briefServer(deps) {
  return createSdkMcpServer({
    name: 'jarvis_brief',
    version: '1.0.0',
    tools: [
      tool(
        'get_brief',
        "Today's ranked brief across the Protective and SCG mailboxes, calendars and To Do: a focus line, " +
          'up to eight actions with priority, and the meetings. Cached for the morning; pass refresh to ' +
          'rebuild (takes a minute). Use it for "brief me", "what do I need to do today", "how does my day look".',
        { refresh: z.boolean().optional() },
        async ({ refresh }) => {
          try {
            const { brief, builtAt } = await getBrief(deps, { refresh: Boolean(refresh) })
            const age = Math.round((Date.now() - builtAt) / 60_000)
            return { content: [{ type: 'text', text: JSON.stringify({ builtMinutesAgo: age, ...(await withLinks(withSources(brief))) }) }] }
          } catch (err) {
            return {
              content: [{ type: 'text', text: `The brief could not be built: ${err.message}. Gather what you can directly.` }],
              isError: true,
            }
          }
        },
      ),
    ],
  })
}
