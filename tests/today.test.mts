import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// A private ~/.jarvis; no Protective flows, so nothing is fetched.
process.env.JARVIS_HOME = mkdtempSync(join(tmpdir(), 'jarvis-today-'))
process.env.JARVIS_PA_ENDPOINTS = join(process.env.JARVIS_HOME, 'none.json')

const t = await import('../bridge/today.mjs')
const { pick, until, layoutDay } = await import('../src/lib/today.ts')

const at = (h: number, m = 0) => {
  const d = new Date()
  d.setHours(h, m, 0, 0)
  return d.getTime()
}
const ev = (id: string, title: string, a: number, b: number, account = 'Protective', extra = {}) => ({
  id, title, start: a, end: b, where: '', account, people: 2, clash: false, ...extra,
})

test('the same meeting on two calendars is one; overlaps clash, focus blocks never do', () => {
  const merged = t.mergeEvents(
    [ev('p1', 'Architecture review', at(14), at(15)), ev('p2', 'Vendor sync', at(14, 30), at(15))],
    [
      ev('s1', 'architecture  review', at(14, 2), at(15), 'SCG'),
      ev('s2', 'Standup', at(9), at(9, 15), 'SCG'),
      ev('f1', 'Focus time', at(14, 45), at(16), 'SCG', { focus: true }),
    ],
  )
  assert.deepEqual(merged.map((e: { id: string }) => e.id), ['s2', 'p1', 'p2', 'f1'])
  assert.deepEqual(merged.map((e: { clash: boolean }) => e.clash), [false, true, true, false])
})

test('the watcher’s events: Protective left to the flow, other days dropped, the view pushed', () => {
  const seen: unknown[] = []
  const stop = t.onToday((v: unknown) => seen.push(v))
  const iso = (ms: number) => new Date(ms).toISOString()
  t.setWatcherEvents([
    { id: 'a', title: 'SCG steering', start: iso(at(10)), end: iso(at(11)), account: 'SCG', who: ['x'] },
    { id: 'b', title: 'Dentist', start: iso(at(16)), end: iso(at(17)), account: 'Google' },
    { id: 'c', title: 'Protective thing', start: iso(at(12)), end: iso(at(13)), account: 'Protective' },
    { id: 'd', title: 'Tomorrow', start: iso(at(10) + 86_400_000), end: iso(at(11) + 86_400_000), account: 'SCG' },
    { id: 'e', title: '', start: 'not a date' },
  ])
  t.setPortfolio({ blocked: 10, behind: ['NI Sprint 42'] })
  stop()
  const view = t.todayView()
  assert.deepEqual(view.events.map((e: { title: string; account: string }) => `${e.title}/${e.account}`), ['SCG steering/SCG', 'Dentist/Google'])
  assert.equal(view.events[0].people, 1)
  assert.equal(view.portfolio.blocked, 10)
  assert.equal(seen.length, 2)
})

test('what is on now and what is next; focus blocks are neither', () => {
  const events = [
    ev('a', 'Standup', at(9), at(9, 15)),
    ev('f', 'Focus', at(9, 30), at(11), 'SCG', { focus: true }),
    ev('b', 'Review', at(10), at(11)),
    ev('c', 'Lunch talk', at(12), at(13)),
  ]
  assert.deepEqual(pick(events, at(10, 30)), { current: events[2], next: events[3] })
  assert.deepEqual(pick(events, at(9, 40)), { current: null, next: events[2] })
  assert.deepEqual(pick(events, at(18)), { current: null, next: null })
  const clock = (ms: number) => new Date(ms).toTimeString().slice(0, 5)
  assert.equal(until(at(10), at(9, 59), clock), 'Starting now')
  assert.equal(until(at(10), at(9, 48), clock), 'In 12 min')
  assert.equal(until(at(13), at(10), clock), 'At 13:00')
})

test('the track covers the working day, stretched for early and late meetings; overlaps share lanes', () => {
  const dayStart = new Date(at(0))
  const events = [
    ev('a', 'Early', at(7, 30), at(8)),
    ev('b', 'One', at(14), at(15)),
    ev('c', 'Two', at(14, 30), at(15)),
    ev('d', 'Three', at(14, 45), at(15, 30)),
    ev('e', 'After', at(16), at(17)),
  ]
  const { from, to, placed } = layoutDay(events, dayStart)
  assert.equal(from, 7)
  assert.equal(to, 18)
  const lanes = Object.fromEntries(placed.map((p: { event: { id: string }; lane: number; lanes: number }) => [p.event.id, `${p.lane}/${p.lanes}`]))
  assert.deepEqual(lanes, { a: '0/1', b: '0/3', c: '1/3', d: '2/3', e: '0/1' })
  const b = placed.find((p: { event: { id: string } }) => p.event.id === 'b')!
  assert.ok(Math.abs(b.top - 7 / 11) < 1e-9 && Math.abs(b.height - 1 / 11) < 1e-9)
})
