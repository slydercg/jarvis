import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { JARVIS_HOME } from './memory.mjs'
import { localDay } from './days.mjs'

/**
 * The conversation, kept: what he asked, what Jarvis answered, and every
 * alert that came in, one file per day in ~/.jarvis/transcripts.
 *
 * The screen only ever shows the last few exchanges, and a spoken answer is
 * gone once it has been said — "what was that figure he gave me this
 * morning?" had no answer. The history drawer reads these back, searchable.
 *
 * They stay on this Mac, like memory. JARVIS_HISTORY=off keeps nothing;
 * JARVIS_HISTORY_DAYS (30) is how long a day is kept.
 */

const DIR = join(JARVIS_HOME, 'transcripts')
const ENABLED = process.env.JARVIS_HISTORY !== 'off'
const KEEP_DAYS = Number(process.env.JARVIS_HISTORY_DAYS ?? 30)
const MAX_TEXT = 8000

export const historyEnabled = () => ENABLED

const fileFor = (day) => join(DIR, `${day}.jsonl`)
const DAY = /^\d{4}-\d{2}-\d{2}$/

let pruned = ''

/**
 * Keep one line of the conversation. `role` is 'user', 'jarvis' or 'alert';
 * `kind` names the alert ("portfolio", "reminder").
 */
export function appendTurn({ role, text, kind, at = Date.now() }) {
  if (!ENABLED) return
  const t = String(text ?? '').trim()
  if (!t) return
  try {
    // Owner-only like ~/.jarvis around it (server.mjs): this is everything said.
    mkdirSync(DIR, { recursive: true, mode: 0o700 })
    const entry = { at, role, text: t.slice(0, MAX_TEXT), ...(kind ? { kind } : {}) }
    appendFileSync(fileFor(localDay(new Date(at))), `${JSON.stringify(entry)}\n`)
  } catch (err) {
    console.warn(`[jarvis] history: ${err.message}`)
  }
  prune()
}

/** One day's turns, oldest first. A malformed line is skipped, not fatal. */
export function readTranscript(day = localDay()) {
  if (!DAY.test(day)) return []
  let raw = ''
  try {
    raw = readFileSync(fileFor(day), 'utf8')
  } catch {
    return []
  }
  const out = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const e = JSON.parse(line)
      if (e && typeof e.text === 'string' && typeof e.at === 'number') out.push(e)
    } catch {
      // A line cut short by a crash mid-write: skip it.
    }
  }
  return out
}

/** Days with a transcript, newest first. */
export function transcriptDays() {
  try {
    return readdirSync(DIR)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .map((f) => f.slice(0, 10))
      .sort()
      .reverse()
  } catch {
    return []
  }
}

function prune() {
  const today = localDay()
  if (pruned === today) return
  pruned = today
  const cutoff = localDay(new Date(Date.now() - KEEP_DAYS * 86_400_000))
  for (const day of transcriptDays()) {
    if (day < cutoff) rmSync(fileFor(day), { force: true })
  }
}

/**
 * Every kept turn that mentions `q`, newest first, across all kept days —
 * "what did he say about Datadog?" — each tagged with its day.
 */
export function searchTranscripts(q, limit = 200) {
  const needle = String(q ?? '').trim().toLowerCase()
  if (needle.length < 2) return []
  const out = []
  for (const day of transcriptDays()) {
    const turns = readTranscript(day)
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i].text.toLowerCase().includes(needle)) out.push({ ...turns[i], day })
      if (out.length >= limit) return out
    }
  }
  return out
}
