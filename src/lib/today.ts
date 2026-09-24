/**
 * The arithmetic behind the now strip and the day timeline: which meeting is
 * on now and which is next, and where each block sits on the day's track.
 *
 * Kept import-free (types only) so tests can run it with type stripping.
 */
import type { TodayEvent } from './bridge'

/** The meeting under way, if any, and the next one to start. Focus blocks aside. */
export function pick(events: TodayEvent[], now: number) {
  const real = events.filter((e) => !e.focus)
  const current = real.find((e) => e.start <= now && now < e.end) ?? null
  const next = real.find((e) => e.start > now) ?? null
  return { current, next }
}

/** "Starting now", "In 12 min", or "At 3:00 PM". */
export function until(start: number, now: number, clock: (t: number) => string): string {
  const mins = Math.round((start - now) / 60_000)
  if (mins <= 1) return 'Starting now'
  if (mins < 60) return `In ${mins} min`
  return `At ${clock(start)}`
}

export type Placed = { event: TodayEvent; top: number; height: number; lane: number; lanes: number }

/**
 * The hours the track covers — the working day, stretched to take in any
 * early or late meeting — and each event's place on it, in fractions of the
 * track. Overlapping events share the width side by side, as a calendar does.
 */
export function layoutDay(events: TodayEvent[], dayStart: Date, fromHour = 8, toHour = 18) {
  const hourOf = (t: number) => (t - dayStart.getTime()) / 3_600_000
  let from = fromHour
  let to = toHour
  for (const e of events) {
    from = Math.min(from, Math.floor(hourOf(e.start)))
    to = Math.max(to, Math.ceil(hourOf(e.end)))
  }
  from = Math.max(0, from)
  to = Math.min(24, Math.max(to, from + 1))
  const span = to - from
  const frac = (t: number) => Math.min(1, Math.max(0, (hourOf(t) - from) / span))

  // Group events that overlap, directly or through a chain, then give each a
  // lane within its group.
  const sorted = [...events].sort((a, b) => a.start - b.start || b.end - a.end)
  const placed: Placed[] = []
  let group: Placed[] = []
  let groupEnd = -Infinity
  const laneEnds: number[] = []
  const close = () => {
    for (const p of group) p.lanes = laneEnds.length
    group = []
    laneEnds.length = 0
  }
  for (const e of sorted) {
    if (e.start >= groupEnd) close()
    let lane = laneEnds.findIndex((end) => end <= e.start)
    if (lane < 0) lane = laneEnds.push(e.end) - 1
    else laneEnds[lane] = e.end
    const p: Placed = { event: e, top: frac(e.start), height: Math.max(frac(e.end) - frac(e.start), 0.018), lane, lanes: 1 }
    group.push(p)
    placed.push(p)
    groupEnd = Math.max(groupEnd, e.end)
  }
  close()
  return { from, to, frac, placed }
}
