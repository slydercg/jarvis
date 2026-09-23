import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { JARVIS_HOME } from './memory.mjs'

/**
 * Two small pieces of day-keeping shared by the proactive jobs.
 *
 * Offers: "your wrap-up is ready", "your weekly review is ready" — each said
 * once a day at most, inside a window of hours, remembered across restarts.
 *
 * The day log: one file per day in ~/.jarvis/days holding that day's brief,
 * wrap and meetings. The weekly review reads the week back from it, which is
 * the only way to know where Monday's hours went on Friday — the Protective
 * calendar flow only answers for the days around now. Kept for five weeks.
 */

const OFFERS = join(JARVIS_HOME, 'offers.json')
const DAYS = join(JARVIS_HOME, 'days')
const KEEP_DAYS = 35

/** Local calendar day, YYYY-MM-DD. */
export const localDay = (d = new Date()) => d.toLocaleDateString('en-CA')

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}
function writeJson(path, value) {
  try {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, JSON.stringify(value, null, 2))
  } catch {
    // Day-keeping is a convenience; nothing breaks without it.
  }
}

/**
 * "17-20" -> true between five and eight in the evening. `days` limits the
 * weekday: 'weekdays' (default), 'every', or a list of getDay() numbers.
 */
export function inWindow(hours, days = 'weekdays', now = new Date()) {
  const [from, to] = String(hours).split('-').map(Number)
  const d = now.getDay()
  if (days === 'weekdays' && (d === 0 || d === 6)) return false
  if (Array.isArray(days) && !days.includes(d)) return false
  const h = now.getHours() + now.getMinutes() / 60
  return h >= from && h < to
}

/** True the first time it is asked for `key` on a given day; false after. */
export function firstToday(key) {
  const offers = readJson(OFFERS, {})
  const today = localDay()
  if (offers[key] === today) return false
  offers[key] = today
  writeJson(OFFERS, offers)
  return true
}

const dayFile = (day) => join(DAYS, `${day}.json`)

/** Merge `patch` into a day's record (today by default). */
export function recordDay(patch, day = localDay()) {
  writeJson(dayFile(day), { ...readJson(dayFile(day), {}), ...patch, day })
  prune()
}

export const readDay = (day = localDay()) => readJson(dayFile(day), null)

/** The records for the last `n` days, oldest first, skipping days with none. */
export function recentDays(n = 7, now = new Date()) {
  const out = []
  for (let i = n - 1; i >= 0; i--) {
    const rec = readDay(localDay(new Date(now.getTime() - i * 86_400_000)))
    if (rec) out.push(rec)
  }
  return out
}

let pruned = ''
function prune() {
  const today = localDay()
  if (pruned === today) return
  pruned = today
  const cutoff = localDay(new Date(Date.now() - KEEP_DAYS * 86_400_000))
  try {
    for (const f of readdirSync(DAYS)) {
      if (/^\d{4}-\d{2}-\d{2}\.json$/.test(f) && f.slice(0, 10) < cutoff) rmSync(join(DAYS, f), { force: true })
    }
  } catch {
    // Nothing to prune.
  }
}

/** Spoken small numbers: "two days late", not "2 days late". */
export function spokenCount(n) {
  const words = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']
  return words[n] ?? String(n)
}

/** A small JSON state file in ~/.jarvis, by name. */
export const readJsonFile = (name, fallback) => readJson(join(JARVIS_HOME, name), fallback)
export const writeJsonFile = (name, value) => writeJson(join(JARVIS_HOME, name), value)
