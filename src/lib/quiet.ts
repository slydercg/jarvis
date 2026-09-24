/**
 * Quiet hours: when nothing is spoken and no card pops up. Everything still
 * lands on the review list, to be seen in the morning.
 *
 * Three things get through: a reminder he set himself (he chose that time), a
 * meeting about to start (a meeting in the evening is working hours by
 * definition, and missing it is worse than hearing about it), and mail the
 * watcher marked VIP or incident. The default is eight in the evening to seven
 * in the morning, and all weekend.
 *
 * Kept import-free so tests can run it with type stripping.
 */
export type Quiet = { on: boolean; from: number; to: number; weekends: boolean }

export const DEFAULT_QUIET: Quiet = { on: true, from: 20, to: 7, weekends: true }

export function isQuiet(q: Quiet, d: Date = new Date()): boolean {
  if (!q.on) return false
  const day = d.getDay()
  if (q.weekends && (day === 0 || day === 6)) return true
  if (q.from === q.to) return false
  const h = d.getHours() + d.getMinutes() / 60
  return q.from < q.to ? h >= q.from && h < q.to : h >= q.from || h < q.to
}

/** When quiet ends, in whole quarter hours; null when it is not quiet now. */
export function quietUntil(q: Quiet, d: Date = new Date()): number | null {
  if (!isQuiet(q, d)) return null
  const t = new Date(d)
  t.setSeconds(0, 0)
  t.setMinutes(Math.ceil(t.getMinutes() / 15) * 15)
  for (let i = 0; i < 4 * 24 * 4; i++) {
    if (!isQuiet(q, t)) return t.getTime()
    t.setMinutes(t.getMinutes() + 15)
  }
  return null
}

/** Whether an alert is allowed to speak even in quiet hours. */
export const breaksQuiet = (a: { kind: string; vip?: boolean }) =>
  a.kind === 'reminder' || a.kind === 'meeting' || a.vip === true
