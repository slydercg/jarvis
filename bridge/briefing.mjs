import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { JARVIS_HOME } from './memory.mjs'
import { askReadOnly } from './agent.mjs'
import { recordDay } from './days.mjs'
import { hasFlow, protective, protectiveConfigured } from './protective.mjs'
import { mailLink, matchMail, matchTask, plainSubject, readerId, todoLink } from './maillinks.mjs'

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

const isEmail = (i) => String(i?.source ?? '').includes('email')
const isTask = (i) => String(i?.source ?? '').includes('task')

/** What serving the brief reads from Protective, straight from its flows. */
const PROTECTIVE_SOURCES = {
  mail: protectiveMail,
  tasks: protectiveTasks,
  sent: protectiveSent,
}

/**
 * Read only what the brief's lines need: the mailbox for links, To Do for task
 * links and ticking off, sent mail for replies. A source that is not needed,
 * or not set up, is null; one that fails is null with its error noted, so the
 * health line can say why links or ticks are missing.
 */
export async function readForBrief(items, sources = PROTECTIVE_SOURCES) {
  const mine = items.filter((i) => i?.account === 'Protective')
  const errors = {}
  const read = async (key, needed) => {
    if (!needed || !sources[key]) return null
    try {
      return (await sources[key]()) ?? null
    } catch (err) {
      console.warn(`[jarvis] brief: ${key}: ${err.message}`)
      errors[key] = err.message
      return null
    }
  }
  const [messages, tasks, sent] = await Promise.all([
    read('mail', mine.some((i) => isEmail(i) || isTask(i))),
    read('tasks', mine.some(isTask)),
    read('sent', mine.some(isEmail)),
  ])
  return { messages, tasks, sent, errors }
}

/**
 * Give each line a link: an email opens in Outlook, a To Do task in To Do.
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
 * A line that cannot be matched simply has no link.
 */
export function linkItems(items, { messages, tasks }) {
  return items.map((i) => {
    let link = null
    if (isEmail(i) && (i.account === 'Protective' || i.account === 'SCG')) {
      const matched = i.account === 'Protective' ? matchMail(i, messages ?? [])?.id : null
      link = mailLink(matched ?? readerId(i.messageId))
    } else if (i.source === 'task' && i.account === 'Protective') {
      link = mailLink(matchMail(i, messages ?? [])?.id) ?? todoLink(matchTask(i, tasks ?? [])?.id)
    }
    return link ? { ...i, link } : i
  })
}

/** The links alone, as before: kept for callers that want nothing else. */
export async function withLinks(brief, lookup = protectiveMail, taskLookup = protectiveTasks) {
  const items = Array.isArray(brief?.items) ? brief.items : []
  const got = await readForBrief(items, { mail: lookup, tasks: taskLookup })
  const linked = linkItems(items, got)
  return linked.some((i, n) => i !== items[n]) ? { ...brief, items: linked } : brief
}

/** How a task is known again later: its id, or its title when the flow sends no ids. */
const taskKey = (t) => (t?.id ? `id:${t.id}` : `title:${plainSubject(t?.title)}`)

/**
 * Remember which open task each To Do line is, the first time it is seen. A
 * line is only ever ticked off against a task it was matched to, so a title
 * the model reworded is never mistaken for a finished task.
 * Returns the same array when nothing new was matched.
 */
export function anchorTasks(items, tasks) {
  if (!tasks) return items
  let changed = false
  const out = items.map((i) => {
    if (i.account !== 'Protective' || !isTask(i) || i.taskKey) return i
    const t = matchTask(i, tasks)
    if (!t) return i
    changed = true
    return { ...i, taskKey: taskKey(t) }
  })
  return changed ? out : items
}

/**
 * Mark what has been done since the brief was built, so it reads as a live
 * list rather than a snapshot of this morning:
 * - a To Do line whose task is no longer open: "ticked off in To Do";
 * - a Protective email line with a reply in sent mail after it arrived (or,
 *   if that is unknown, after the brief was built): "replied".
 * Nothing is removed. A source that could not be read ticks nothing off.
 * SCG and Gmail lines are left alone: the bridge cannot read those mailboxes.
 */
export function tickDone(items, { tasks, sent, builtAt }) {
  const open = tasks ? new Set(tasks.map(taskKey)) : null
  return items.map((i) => {
    if (i.account !== 'Protective' || i.done) return i
    if (open && i.taskKey && !open.has(i.taskKey)) return { ...i, done: 'ticked off in To Do' }
    if (sent && isEmail(i)) {
      const want = plainSubject(i.subject)
      const received = Date.parse(i.received ?? '')
      const since = Number.isFinite(received) ? received : builtAt
      const replied = want && sent.some((m) => plainSubject(m?.subject) === want && Date.parse(m?.sent ?? '') > since)
      if (replied) return { ...i, done: 'replied' }
    }
    return i
  })
}

/**
 * Everything serving the brief adds, in one pass over Protective: source
 * lines, links, and what is done. Also says how that went, for Diagnostics.
 * `anchored` is the items with newly remembered tasks, to be saved, or null.
 */
export async function serveBrief({ brief, builtAt }, sources = PROTECTIVE_SOURCES, now = new Date()) {
  const items = Array.isArray(brief?.items) ? brief.items : []
  const got = await readForBrief(items, sources)
  const anchored = anchorTasks(items, got.tasks)
  const served = tickDone(linkItems(withSources({ items: anchored }, now).items, got), { ...got, builtAt })
  const linkable = (i) => (isEmail(i) && (i.account === 'Protective' || i.account === 'SCG')) || (i.source === 'task' && i.account === 'Protective')
  const notes = []
  if (items.some((i) => i.account === 'Protective') && !protectiveConfigured()) {
    notes.push("Protective flows aren't set up on this Mac, so Protective lines have no links")
  }
  for (const [key, what] of [['mail', 'Protective mail'], ['tasks', 'Protective To Do'], ['sent', 'Protective sent mail']]) {
    if (got.errors[key]) notes.push(`${what} couldn't be read: ${got.errors[key]}`)
  }
  if (got.tasks?.length && !got.tasks.some((t) => t.id)) {
    notes.push("The To Do flow sends no task ids, so plain To Do lines can't open the task")
  }
  if (!got.sent && !got.errors.sent && items.some((i) => i.account === 'Protective' && isEmail(i)) && protectiveConfigured()) {
    notes.push("No sent-mail flow, so replied emails aren't ticked off")
  }
  const health = {
    at: now.getTime(),
    builtAt,
    lines: served.length,
    linked: served.filter((i) => i.link).length,
    done: served.filter((i) => i.done).length,
    unlinked: served.filter((i) => linkable(i) && !i.link).map((i) => `${i.account}: ${String(i.subject || i.action || '').slice(0, 60)}`).slice(0, 5),
    notes,
  }
  return { brief: { ...brief, items: served }, anchored: anchored === items ? null : anchored, health }
}

async function protectiveTasks() {
  return protectiveConfigured() ? protective.todo() : null
}

async function protectiveMail() {
  if (!protectiveConfigured()) return null
  const [inbox, flagged] = await Promise.all([protective.inbox(25), protective.flagged().catch(() => [])])
  return [...inbox, ...flagged]
}

/** Null when there is no sent-mail flow: nothing can be ticked off as replied. */
async function protectiveSent() {
  return protectiveConfigured() && hasFlow('sent_email') ? protective.sent(50) : null
}

/** How the last brief served went: links found, lines done, what got in the way. */
let lastHealth = null
export const briefHealth = () => lastHealth

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
            const entry = await getBrief(deps, { refresh: Boolean(refresh) })
            const age = Math.round((Date.now() - entry.builtAt) / 60_000)
            const { brief, anchored, health } = await serveBrief(entry)
            lastHealth = health
            // Which task each To Do line is, kept with the brief, so it can
            // be ticked off once that task is finished.
            if (anchored && cached === entry) {
              cached = { ...entry, brief: { ...entry.brief, items: anchored } }
              save({ last: cached })
            }
            return { content: [{ type: 'text', text: JSON.stringify({ builtMinutesAgo: age, ...brief }) }] }
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
