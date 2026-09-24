import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { JARVIS_HOME } from './memory.mjs'
import { askReadOnly, SOURCES } from './agent.mjs'
import { localDay, spokenCount } from './days.mjs'

/**
 * Promises, both ways.
 *
 * At a CTO's volume the thing that slips is not the work in To Do — it is the
 * "I'll get you that by Friday" said in a meeting or written in a reply, and
 * the "Cathrene will send the provisioning doc" nobody wrote down. This keeps
 * a ledger of both in ~/.jarvis/commitments.json:
 *
 *   mine    something Mark said he would do, for someone, maybe by a date
 *   theirs  something someone said they would do for him
 *
 * A read-only scan finds new ones — in Granola notes, sent mail, the Waiting
 * On Others list — and notices ones that have been kept. Nudges need no model
 * at all: a day before one of his is due, and once one of theirs is late.
 */

const FILE = join(JARVIS_HOME, 'commitments.json')
const SCAN_EVERY_H = Number(process.env.JARVIS_COMMIT_SCAN_HOURS ?? 4)
const FIRST_LOOKBACK_DAYS = 7

export const commitmentsEnabled = () => process.env.JARVIS_COMMITMENTS !== 'off'

export function readLedger() {
  try {
    const l = JSON.parse(readFileSync(FILE, 'utf8'))
    return { scannedAt: l.scannedAt ?? null, items: Array.isArray(l.items) ? l.items : [] }
  } catch {
    return { scannedAt: null, items: [] }
  }
}

function writeLedger(ledger) {
  mkdirSync(JARVIS_HOME, { recursive: true })
  // Kept items are kept for a month, then let go.
  const cutoff = localDay(new Date(Date.now() - 30 * 86_400_000))
  ledger.items = ledger.items.filter((i) => i.status === 'open' || (i.closed ?? i.since) >= cutoff)
  writeFileSync(FILE, JSON.stringify(ledger, null, 2))
}

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

/** Stable id from who and what, so the same promise found twice is one item. */
export const commitmentId = (direction, who, what) =>
  createHash('sha1').update(`${direction}|${norm(who)}|${norm(what)}`).digest('hex').slice(0, 8)

const validDue = (d) => (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null)

/**
 * Add items to the ledger, skipping ones already there (by id, or by the same
 * person and a clearly overlapping description). Returns the ones added.
 */
export function addCommitments(found, { source = 'said', ledger = readLedger(), save = true } = {}) {
  const added = []
  for (const f of found) {
    const direction = f?.direction === 'theirs' ? 'theirs' : f?.direction === 'mine' ? 'mine' : null
    const who = String(f?.who ?? '').trim()
    const what = String(f?.what ?? '').trim()
    if (!direction || !who || what.length < 4) continue
    const id = commitmentId(direction, who, what)
    const dupe = ledger.items.some(
      (i) =>
        i.id === id ||
        (i.direction === direction && norm(i.who) === norm(who) && overlap(i.what, what) >= 0.6),
    )
    if (dupe) continue
    const item = {
      id,
      direction,
      who: who.slice(0, 80),
      what: what.slice(0, 200),
      due: validDue(f.due),
      source: String(f.source ?? source).slice(0, 60),
      since: localDay(),
      status: 'open',
    }
    ledger.items.push(item)
    added.push(item)
  }
  if (save) writeLedger(ledger)
  return added
}

/** Share of the shorter description's words found in the longer one. */
export function overlap(a, b) {
  const wa = new Set(norm(a).split(' ').filter((w) => w.length > 2))
  const wb = new Set(norm(b).split(' ').filter((w) => w.length > 2))
  if (!wa.size || !wb.size) return 0
  const [small, big] = wa.size <= wb.size ? [wa, wb] : [wb, wa]
  let hit = 0
  for (const w of small) if (big.has(w)) hit++
  return hit / small.size
}

export function closeCommitment(id, status = 'done') {
  const ledger = readLedger()
  const item = ledger.items.find((i) => i.id === id)
  if (!item) return null
  item.status = status === 'dropped' ? 'dropped' : 'done'
  item.closed = localDay()
  writeLedger(ledger)
  return item
}

/** Whole days from today to `due` (negative when late). */
export function daysUntil(due, now = new Date()) {
  if (!due) return null
  const a = Date.parse(`${localDay(now)}T00:00:00Z`)
  const b = Date.parse(`${due}T00:00:00Z`)
  return Math.round((b - a) / 86_400_000)
}

/** Open items, soonest due first, each with daysLeft. Optionally one person. */
export function openCommitments({ who, direction } = {}) {
  const w = norm(who)
  return readLedger()
    .items.filter((i) => i.status === 'open')
    .filter((i) => !direction || i.direction === direction)
    .filter((i) => !w || norm(i.who).includes(w) || w.includes(norm(i.who)))
    .map((i) => ({ ...i, daysLeft: daysUntil(i.due) }))
    .sort((a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999'))
}

/** Items involving any of these people — for meeting prep and dossiers. */
export function commitmentsWith(people) {
  const names = people.map(norm).filter(Boolean)
  // "Chris Smith <chris.smith@x.com>" should match "Chris": compare first names too.
  const keys = new Set(names.flatMap((n) => [n, n.split(' ')[0]]).filter((n) => n.length > 2))
  return openCommitments().filter((i) => {
    const w = norm(i.who)
    return [...keys].some((k) => w.includes(k) || k.includes(w))
  })
}

// ---------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------

const SCAN_PROMPT = `You keep a ledger of promises for Mark, a CTO. You never talk to him;
you return ONE JSON object and nothing else — no prose, no markdown fences.

${SOURCES}

Find commitments made in the window you are given:
- "mine": Mark said or wrote that HE would do something for someone ("I'll send
  you the roadmap by Friday", "let me get back to you on headcount"). Look in
  Granola meeting notes (his own action items and things he agreed to) and in
  mail he SENT (SCG Sent Items; protective_get_sent if it exists).
- "theirs": someone said they would do something for him ("Cathrene will send
  the provisioning doc"). Look in Granola notes and in the To Do "Waiting On
  Others" list.
Only real, specific commitments with a person attached. Never newsletters,
automated mail, vague intentions ("we should…"), or things already done.
Convert relative dates to YYYY-MM-DD from today's date; no date → null.

You are also given the ledger's open items. For each one you find evidence has
been KEPT (the reply was sent, the document arrived, the task is completed),
list its id under "kept". Never guess.

Answer exactly:
{"new":[{"direction":"mine|theirs","who":"<person>","what":"<short verb phrase>","due":"YYYY-MM-DD|null","source":"meeting: <name>|email|to do"}],
 "kept":[{"id":"<ledger id>","evidence":"<under 12 words>"}]}`

let scanning = null
/** A failed scan is not retried for half an hour. */
let lastAttempt = 0

export function scanDue(now = Date.now()) {
  if (scanning || now - lastAttempt < 30 * 60_000) return false
  const { scannedAt } = readLedger()
  return !scannedAt || now - Date.parse(scannedAt) > SCAN_EVERY_H * 3_600_000
}

/** Look for new promises and kept ones; returns { added, kept } or throws. */
export function scanCommitments(deps) {
  scanning ??= (async () => {
    lastAttempt = Date.now()
    const before = readLedger()
    const since = before.scannedAt
      ? new Date(Date.parse(before.scannedAt) - 3_600_000)
      : new Date(Date.now() - FIRST_LOOKBACK_DAYS * 86_400_000)
    const open = before.items
      .filter((i) => i.status === 'open')
      .map(({ id, direction, who, what, due }) => ({ id, direction, who, what, due }))
    const result = await askReadOnly(deps, {
      system: SCAN_PROMPT,
      question:
        `It is ${deps.localNow()}. Window: since ${since.toISOString()}.\n` +
        `Open ledger items: ${JSON.stringify(open)}`,
      label: 'commitment scan',
    })
    if (!result) throw new Error('the commitment scan did not come back as expected')
    const ledger = readLedger()
    const added = addCommitments(Array.isArray(result.new) ? result.new : [], { ledger, save: false })
    const kept = []
    for (const k of Array.isArray(result.kept) ? result.kept : []) {
      const item = ledger.items.find((i) => i.id === k?.id && i.status === 'open')
      if (!item) continue
      item.status = 'done'
      item.closed = localDay()
      item.evidence = String(k.evidence ?? '').slice(0, 120)
      kept.push(item)
    }
    ledger.scannedAt = new Date().toISOString()
    writeLedger(ledger)
    console.log(`[jarvis] commitments: ${added.length} new, ${kept.length} kept`)
    return { added, kept }
  })().finally(() => {
    scanning = null
  })
  return scanning
}

// ---------------------------------------------------------------------------
// Nudges
// ---------------------------------------------------------------------------

/**
 * Alerts owed now, marking each as nudged so it is said once:
 *   his own, due tomorrow or today   — said once each of those days
 *   theirs, a day or more late       — said once, then again every two days
 */
export function dueNudges(now = new Date()) {
  const ledger = readLedger()
  const today = localDay(now)
  const out = []
  for (const i of ledger.items) {
    if (i.status !== 'open' || !i.due) continue
    const left = daysUntil(i.due, now)
    if (i.direction === 'mine' && (left === 0 || left === 1) && i.nudged !== today) {
      i.nudged = today
      const when = left === 0 ? 'today' : 'tomorrow'
      out.push({
        kind: 'promise',
        label: 'Promise',
        ref: `commitment:${i.id}`,
        title: `${i.who} — ${i.what}`,
        detail: `Due ${when}`,
        say: `Sir, you told ${i.who} you would ${lowerFirst(i.what)} — that is due ${when}.`,
        at: now.toISOString(),
      })
    }
    if (i.direction === 'theirs' && left !== null && left <= -1) {
      const last = i.nudged ? daysUntil(i.nudged, now) : null // negative: days since
      if (last !== null && last > -2) continue
      i.nudged = today
      const late = -left
      out.push({
        kind: 'promise',
        label: 'Overdue',
        ref: `commitment:${i.id}`,
        title: `${i.who} — ${i.what}`,
        detail: `${late} day${late === 1 ? '' : 's'} late`,
        say:
          `Sir, ${i.who} was to ${lowerFirst(i.what)} — it is ${spokenCount(late)} ` +
          `day${late === 1 ? '' : 's'} late. Shall I draft a nudge?`,
        at: now.toISOString(),
      })
    }
  }
  if (out.length) writeLedger(ledger)
  return out
}

const lowerFirst = (s) => (s ? s[0].toLowerCase() + s.slice(1) : s)

/** Whether a ledger item is still open — the review column asks. */
export const commitmentOpen = (id) => readLedger().items.some((i) => i.id === id && i.status === 'open')
