import { localDay, readJsonFile, writeJsonFile } from './days.mjs'
import { listReports } from './reports.mjs'
import { spendSummary } from './spend.mjs'

/**
 * How Jarvis himself did this week, for the Friday review: "that was wrong"
 * reports, what the voice loop ignored and why, and what he spent.
 *
 * The voice fixes of the past weeks are only proven by use, and nobody
 * should have to watch for regressions. The page keeps a count of each
 * decision it notes (src/lib/trail.ts) and sends the counts every few
 * minutes; they are kept a day at a time here, two weeks of them.
 */

const FILE = 'voice-stats.json'
const KEEP_DAYS = 14

/** Add the page's counts ({ ignored: 3, dropped: 5, … }) to today's. */
export function recordVoiceStats(counts, now = new Date()) {
  if (!counts || typeof counts !== 'object') return
  const all = readJsonFile(FILE, {})
  const day = localDay(now)
  const today = all[day] ?? {}
  for (const [kind, n] of Object.entries(counts)) {
    if (!/^[a-z-]{2,20}$/.test(kind) || !Number.isFinite(n) || n <= 0) continue
    today[kind] = (today[kind] ?? 0) + Math.min(Math.round(n), 10_000)
  }
  all[day] = today
  for (const d of Object.keys(all).sort().slice(0, -KEEP_DAYS)) delete all[d]
  writeJsonFile(FILE, all)
}

/** The last `days` days: reports saved, voice decisions by kind, and spend. */
export function selfCheck(days = 7, now = new Date()) {
  const from = localDay(new Date(now.getTime() - (days - 1) * 86_400_000))
  const voice = {}
  for (const [day, counts] of Object.entries(readJsonFile(FILE, {}))) {
    if (day < from) continue
    for (const [kind, n] of Object.entries(counts)) voice[kind] = (voice[kind] ?? 0) + n
  }
  // Report file names start with the UTC date they were saved.
  const reports = listReports().filter((f) => f.slice(0, 10) >= from).length
  let spend = null
  try {
    spend = spendSummary(now).week
  } catch {
    // No spend recorded is not a reason to drop the rest.
  }
  return { days, reports, voice, spend }
}
