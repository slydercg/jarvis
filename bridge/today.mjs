import { localDay, readJsonFile, writeJsonFile } from './days.mjs'
import { protectiveConfigured } from './protective.mjs'
import { read } from './snapshot.mjs'

/**
 * Today, for the screen: every meeting on every calendar, with clashes marked,
 * plus the portfolio's standing — what the now strip and the day timeline draw.
 *
 * Two sources, merged:
 *   - Protective, straight from its Power Automate calendar flow. A plain
 *     HTTP call, no model, so it is cheap to refresh every few minutes.
 *   - Everything else (SCG, Google), from the alert watcher's own calendar
 *     check, which already reads every calendar every twenty minutes.
 * The same meeting on two calendars is shown once, Protective preferred.
 * Kept in ~/.jarvis/today.json so a restart does not blank the timeline
 * until the next watcher check.
 */

const FILE = 'today.json'
const REFRESH_MS = 5 * 60_000

let state = load()
let listeners = []
let lastFetch = 0

function load() {
  const s = readJsonFile(FILE, {})
  return s.day === localDay()
    ? { day: s.day, protective: s.protective ?? [], others: s.others ?? [], portfolio: s.portfolio ?? null }
    : { day: localDay(), protective: [], others: [], portfolio: s.portfolio ?? null }
}

/** Called with the page's view of today whenever it changes. */
export function onToday(fn) {
  listeners.push(fn)
  return () => (listeners = listeners.filter((l) => l !== fn))
}

function changed() {
  writeJsonFile(FILE, state)
  const view = todayView()
  for (const l of listeners) l(view)
}

function rollDay() {
  if (state.day !== localDay()) state = { day: localDay(), protective: [], others: [], portfolio: state.portfolio }
}

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

/** One event shape for the page, whatever calendar it came from. */
function event(e, account) {
  const start = Date.parse(e.start)
  const end = Date.parse(e.end)
  if (!e.title || Number.isNaN(start)) return null
  return {
    id: String(e.id || `${account}|${e.title}|${start}`),
    title: String(e.title).slice(0, 140),
    start,
    end: Number.isNaN(end) || end <= start ? start + 30 * 60_000 : end,
    where: String(e.where ?? '').slice(0, 120),
    account,
    people: Array.isArray(e.attendees) ? e.attendees.length : Array.isArray(e.who) ? e.who.length : 0,
    ...(e.focus ? { focus: true } : {}),
  }
}

/**
 * The day's events: merged, de-duplicated, sorted, with clashes marked. A
 * clash is two real meetings overlapping; focus blocks never clash.
 */
export function mergeEvents(protectiveEvents, otherEvents) {
  const out = [...protectiveEvents]
  for (const o of otherEvents) {
    const dupe = out.some((p) => Math.abs(p.start - o.start) < 5 * 60_000 && norm(p.title) === norm(o.title))
    if (!dupe) out.push(o)
  }
  out.sort((a, b) => a.start - b.start || a.end - b.end)
  for (const e of out) e.clash = false
  for (let i = 0; i < out.length; i++) {
    for (let j = i + 1; j < out.length && out[j].start < out[i].end; j++) {
      if (!out[i].focus && !out[j].focus) {
        out[i].clash = true
        out[j].clash = true
      }
    }
  }
  return out
}

export function todayView() {
  rollDay()
  return {
    day: state.day,
    events: mergeEvents(state.protective, state.others),
    portfolio: state.portfolio,
  }
}

/** Refresh Protective from its flow, at most every few minutes. */
export async function refreshToday({ force = false } = {}) {
  rollDay()
  if (!protectiveConfigured() || (!force && Date.now() - lastFetch < REFRESH_MS)) return
  lastFetch = Date.now()
  try {
    // Shared with the watcher and the read-only jobs (snapshot.mjs).
    const events = await read('calendar')
    if (!events) return
    const next = events
      .filter((e) => !e.allDay && e.showAs !== 'free')
      .map((e) => event(e, 'Protective'))
      .filter(Boolean)
    if (JSON.stringify(next) !== JSON.stringify(state.protective)) {
      state.protective = next
      changed()
    }
  } catch (err) {
    console.warn(`[jarvis] today: ${err.message}`)
  }
}

/**
 * What the watcher saw on the other calendars. Its answer covers every
 * calendar, Protective included; those are left to the flow, which is exact.
 */
export function setWatcherEvents(events) {
  rollDay()
  const today = localDay()
  const next = events
    .filter((e) => (e.account ?? '') !== 'Protective')
    .map((e) => event(e, e.account === 'Google' ? 'Google' : 'SCG'))
    .filter((e) => e && localDay(new Date(e.start)) === today)
  if (JSON.stringify(next) !== JSON.stringify(state.others)) {
    state.others = next
    changed()
  }
}

/** The portfolio's standing from the watcher's last check. */
export function setPortfolio({ blocked, behind }) {
  const next = { blocked, behind: behind.slice(0, 4), at: Date.now() }
  if (state.portfolio && state.portfolio.blocked === blocked && JSON.stringify(state.portfolio.behind) === JSON.stringify(next.behind)) return
  state.portfolio = next
  changed()
}
