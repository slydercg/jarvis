import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.JARVIS_HOME = mkdtempSync(join(tmpdir(), 'jarvis-alerts-'))
const { resumeDue } = await import('../bridge/alerts.mjs')

const MIN = 60_000
const now = Date.parse('2026-09-24T10:00:00')
const day = '2026-09-24'
const minutes = { calendar: 30, mail: 30, portfolio: 120 }

test('checks that ran recently today wait out their interval after a restart', () => {
  const saved = { day, last: { calendar: now - 10 * MIN, mail: now - 29 * MIN, portfolio: now - 60 * MIN } }
  const due = resumeDue(saved, { now, day, minutes })
  assert.equal(due.calendar, now + 20 * MIN)
  assert.equal(due.mail, now + 1 * MIN)
  assert.equal(due.portfolio, now + 60 * MIN)
})

test('a check that is overdue, never ran, or ran yesterday runs at once', () => {
  assert.deepEqual(resumeDue({ day, last: { calendar: now - 45 * MIN } }, { now, day, minutes }), { calendar: 0, mail: 0, portfolio: 0 })
  assert.deepEqual(resumeDue({ day: '2026-09-23', last: { calendar: now - MIN } }, { now, day, minutes }), { calendar: 0, mail: 0, portfolio: 0 })
  assert.deepEqual(resumeDue({}, { now, day, minutes }), { calendar: 0, mail: 0, portfolio: 0 })
  assert.deepEqual(resumeDue(null, { now, day, minutes }), { calendar: 0, mail: 0, portfolio: 0 })
})

test('a check turned off is never carried', () => {
  const due = resumeDue({ day, last: { mail: now - MIN } }, { now, day, minutes: { ...minutes, mail: 0 } })
  assert.equal(due.mail, 0)
})
