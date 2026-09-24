import { createHash } from 'node:crypto'
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { readJsonFile, writeJsonFile } from './days.mjs'
import { parseUntil } from './focus.mjs'

/**
 * The review column: everything that asked for attention, kept until it is
 * dealt with.
 *
 * An alert card is gone the moment it is dismissed, and a spoken alert the
 * moment it is said — which is how things get forgotten. Every alert also
 * lands here, in ~/.jarvis/stratum.json, and stays:
 *
 *   open     needs him (new ones are marked unseen until he looks)
 *   snoozed  out of the way until a time, then back as open, and said again
 *   done     kept, quietly, for a week
 *
 * He can add his own ("remind me to call Chris at three"). Things that
 * resolve themselves do: a meeting once it is well under way, a promise once
 * the ledger has it kept, the brief once it has been asked for.
 */

const FILE = 'stratum.json'
const KEEP_DONE_MS = 7 * 86_400_000
const KEEP_OPEN_MS = 21 * 86_400_000
const MAX_ITEMS = 200

let listeners = []
/** Called with the full list whenever it changes. */
export function onStratumChange(fn) {
  listeners.push(fn)
  return () => (listeners = listeners.filter((l) => l !== fn))
}

/** prefix -> (id) => true while the thing a ref points at is still open. */
const resolvers = new Map()
export function registerResolver(prefix, fn) {
  resolvers.set(prefix, fn)
}

function load() {
  const s = readJsonFile(FILE, { items: [] })
  return Array.isArray(s.items) ? s.items : []
}

function save(items, { notify = true } = {}) {
  const now = Date.now()
  const kept = items
    .filter((i) =>
      i.state === 'done' ? now - (i.doneAt ?? i.at) < KEEP_DONE_MS : now - i.at < KEEP_OPEN_MS,
    )
    .slice(0, MAX_ITEMS)
  writeJsonFile(FILE, { items: kept })
  if (notify) for (const l of listeners) l(view(kept))
  return kept
}

const hash = (s) => createHash('sha1').update(s).digest('hex').slice(0, 10)

/** The same alert raised twice (a re-check, a restart) is one item. */
export function itemId(alert) {
  if (alert.ref) return hash(`ref|${alert.ref}`)
  const keys = (alert.items ?? []).map((i) => i.key ?? i.title).join(',')
  return hash(`${alert.kind}|${alert.title}|${keys}|${alert.kind === 'meeting' ? alert.at : ''}`)
}

/** Order for the page: open (unseen first, newest first), snoozed, done. */
function view(items) {
  const rank = (i) => (i.state === 'open' ? 0 : i.state === 'snoozed' ? 1 : 2)
  return [...items].sort((a, b) => rank(a) - rank(b) || (b.at ?? 0) - (a.at ?? 0))
}

export function listStratum() {
  return view(settle(load()))
}

/**
 * Bring the list up to date: wake snoozed items that are due, close what has
 * resolved itself. Returns the items; saves if anything changed.
 */
function settle(items, now = Date.now()) {
  let changed = false
  for (const i of items) {
    if (i.state === 'snoozed' && i.until && now >= i.until) {
      i.state = 'open'
      i.seen = false
      i.woke = now
      delete i.until
      changed = true
    }
    if (i.state !== 'done' && i.kind === 'meeting' && i.at && now > i.at + 30 * 60_000) {
      i.state = 'done'
      i.doneAt = now
      changed = true
    }
    if (i.state !== 'done' && i.ref) {
      const [prefix, id] = i.ref.split(':')
      const stillOpen = resolvers.get(prefix)
      if (stillOpen && id && !stillOpen(id)) {
        i.state = 'done'
        i.doneAt = now
        changed = true
      }
    }
  }
  return changed ? save(items) : items
}

/** Keep an alert. Digests are not kept: what they carry was kept already. */
export function keepAlert(alert) {
  if (!alert || alert.kind === 'digest') return null
  const items = load()
  const id = itemId(alert)
  const at = Date.parse(alert.at) || Date.now()
  const existing = items.find((i) => i.id === id)
  const fields = {
    kind: alert.kind,
    label: alert.label ?? '',
    title: String(alert.title ?? '').slice(0, 200),
    detail: String(alert.detail ?? '').slice(0, 500),
    ...(alert.items ? { items: alert.items.slice(0, 30) } : {}),
    ...(alert.prep ? { prep: alert.prep } : {}),
    ...(alert.ref ? { ref: alert.ref } : {}),
  }
  if (existing) {
    // Raised again while still open: refresh it. Raised again after it was
    // done: leave it done — it is the same thing, already handled.
    if (existing.state !== 'done') Object.assign(existing, fields, { at })
    save(items)
    return existing
  }
  const item = { id, ...fields, at, state: 'open', seen: false }
  items.unshift(item)
  save(items)
  return item
}

/** Change one item: done, open again, seen, or snoozed until a time. */
export function updateItem(id, change) {
  const items = load()
  const item = items.find((i) => i.id === id)
  if (!item) return null
  if (change.state === 'done') {
    item.state = 'done'
    item.doneAt = Date.now()
    delete item.until
  } else if (change.state === 'open') {
    item.state = 'open'
    delete item.until
    delete item.doneAt
  }
  if (change.until) {
    item.state = 'snoozed'
    item.until = change.until
    item.seen = true
  }
  if (change.seen) item.seen = true
  save(items)
  return item
}

/** Mark everything open as seen: he has looked at the column. */
export function markAllSeen() {
  const items = load()
  let changed = false
  for (const i of items) {
    if (i.state === 'open' && !i.seen) {
      i.seen = true
      changed = true
    }
  }
  if (changed) save(items)
}

/** Close everything of one kind — "clear the portfolio ones". */
export function closeKind(kind) {
  const items = load()
  let n = 0
  for (const i of items) {
    if (i.state !== 'done' && i.kind === kind) {
      i.state = 'done'
      i.doneAt = Date.now()
      n++
    }
  }
  if (n) save(items)
  return n
}

/** A reminder of his own. With `until`, it waits and then comes back. */
export function addReminder({ title, detail = '', until = null }) {
  const items = load()
  const now = Date.now()
  const item = {
    id: hash(`reminder|${title}|${now}`),
    kind: 'reminder',
    label: 'Reminder',
    title: String(title).slice(0, 200),
    detail: String(detail).slice(0, 500),
    at: now,
    state: until ? 'snoozed' : 'open',
    seen: !!until,
    ...(until ? { until } : {}),
  }
  items.unshift(item)
  save(items)
  return item
}

/**
 * Items whose snooze has just run out, for the minute clock to say aloud.
 * Each is returned once (it is marked with the time it woke).
 */
export function wokenSince(since) {
  return settle(load()).filter((i) => i.state === 'open' && i.woke && i.woke > since)
}

/** "In an hour", "3pm", "tomorrow" → a time; null when it cannot be read. */
export function parseWhen(when, now = new Date()) {
  const s = String(when ?? '').trim().toLowerCase()
  if (!s) return null
  const mins = /^(?:in\s+)?(\d{1,3})\s*(m|min|mins|minutes?)$/.exec(s)
  if (mins) return now.getTime() + Number(mins[1]) * 60_000
  const hours = /^(?:in\s+)?(an?|one|\d{1,2})\s*(h|hr|hrs|hours?)$/.exec(s)
  if (hours) return now.getTime() + (/^\d/.test(hours[1]) ? Number(hours[1]) : 1) * 3_600_000
  if (s === 'tomorrow' || s === 'tomorrow morning') {
    const d = new Date(now)
    d.setDate(d.getDate() + 1)
    d.setHours(9, 0, 0, 0)
    return d.getTime()
  }
  if (s === 'this afternoon') {
    const d = new Date(now)
    d.setHours(14, 0, 0, 0)
    return d.getTime() > now.getTime() ? d.getTime() : null
  }
  return parseUntil(s.replace(/^at\s+/, ''), now)
}

/** The conversation's handle on the column. */
export function stratumServer() {
  const out = (v) => ({ content: [{ type: 'text', text: JSON.stringify(v) }] })
  const brief = (i) => ({
    id: i.id,
    kind: i.kind,
    state: i.state,
    title: i.title,
    ...(i.detail ? { detail: i.detail } : {}),
    ...(i.items ? { items: i.items.map((x) => [x.key, x.title].filter(Boolean).join(' ')) } : {}),
    ...(i.until ? { until: new Date(i.until).toISOString() } : {}),
  })
  return createSdkMcpServer({
    name: 'jarvis_stratum',
    version: '1.0.0',
    tools: [
      tool(
        'review_list',
        'The review column: everything that asked for his attention and is not dealt with yet — ' +
          'portfolio blocks, overdue promises, mail that needs him, the brief, reminders. Open first. ' +
          'Use for "what\'s on my list", "what do I still need to look at", "what did I miss".',
        { includeDone: z.boolean().optional() },
        async ({ includeDone }) =>
          out(listStratum().filter((i) => includeDone || i.state !== 'done').map(brief)),
      ),
      tool(
        'review_update',
        'Mark a review item done, open it again, or snooze it until a time ("in an hour", "3pm", ' +
          '"tomorrow"). By id from review_list, or `kind` to close every open item of one kind ' +
          '("clear the portfolio ones" → kind portfolio).',
        {
          id: z.string().optional(),
          kind: z.string().optional(),
          state: z.enum(['done', 'open']).optional(),
          snooze: z.string().optional().describe('"in an hour", "3pm", "tomorrow"…'),
        },
        async ({ id, kind, state, snooze }) => {
          if (!id && kind) return out({ closed: closeKind(kind) })
          if (!id) return { ...out({ error: 'Give an id or a kind.' }), isError: true }
          const until = snooze ? parseWhen(snooze) : null
          if (snooze && !until) return { ...out({ error: `"${snooze}" is not a time I can read.` }), isError: true }
          const item = updateItem(id, { ...(state ? { state } : {}), ...(until ? { until } : {}) })
          return item ? out(brief(item)) : { ...out({ error: 'No item with that id.' }), isError: true }
        },
      ),
      tool(
        'review_remind',
        'Add a reminder of his own to the review column: "remind me to call Chris at three", "put ' +
          'the budget on my list". With `when`, it waits out of sight and comes back, spoken, then.',
        {
          title: z.string().min(2).max(200),
          when: z.string().optional().describe('"in 20 minutes", "3pm", "tomorrow"'),
          detail: z.string().max(500).optional(),
        },
        async ({ title, when, detail }) => {
          const until = when ? parseWhen(when) : null
          if (when && !until) return { ...out({ error: `"${when}" is not a time I can read.` }), isError: true }
          return out(brief(addReminder({ title, detail, until })))
        },
      ),
    ],
  })
}
