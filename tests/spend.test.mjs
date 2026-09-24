import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// A private ~/.jarvis for the spend file.
const home = mkdtempSync(join(tmpdir(), 'jarvis-spend-'))
process.env.JARVIS_HOME = home
delete process.env.JARVIS_DAILY_CAP_USD
const s = await import('../bridge/spend.mjs')

const day = (d) => new Date(`2026-09-${d}T12:00:00`)

test('turns add up by day and kind; nonsense amounts are ignored', () => {
  s.recordSpend('conversation', 0.12, day(24))
  s.recordSpend('conversation', 0.03, day(24))
  s.recordSpend('background', 0.5, day(24))
  s.recordSpend('watcher', 0.01, day(23))
  s.recordSpend('watcher', -1, day(24))
  s.recordSpend('watcher', 'x', day(24))
  s.recordSpend('made-up', 9, day(24))
  const sum = s.spendSummary(day(24))
  assert.equal(sum.today.total, 0.65)
  assert.deepEqual(sum.today.byKind, { conversation: 0.15, background: 0.5, watcher: 0 })
  assert.equal(sum.week.total, 0.66)
  assert.equal(sum.cap, null)
  assert.equal(sum.paused, false)
})

test('days older than the keep window are dropped', () => {
  s.recordSpend('watcher', 0.2, new Date('2026-07-01T12:00:00'))
  s.recordSpend('watcher', 0.01, day(24))
  const saved = JSON.parse(readFileSync(join(home, 'spend.json'), 'utf8'))
  assert.equal(saved.days['2026-07-01'], undefined)
})

test('the cap pauses background work and says so once, the day it is reached', () => {
  process.env.JARVIS_DAILY_CAP_USD = '1'
  const told = []
  s.onCapReached((spent, cap) => told.push([spent, cap]))
  assert.equal(s.backgroundPaused(day(24)), false)
  s.recordSpend('conversation', 0.4, day(24))
  s.recordSpend('conversation', 0.4, day(24))
  assert.equal(s.backgroundPaused(day(24)), true)
  assert.equal(s.spendSummary(day(24)).paused, true)
  assert.equal(told.length, 1)
  assert.equal(told[0][1], 1)
  // The next day starts afresh.
  assert.equal(s.backgroundPaused(day(25)), false)
  delete process.env.JARVIS_DAILY_CAP_USD
  assert.equal(s.backgroundPaused(day(24)), false)
})
