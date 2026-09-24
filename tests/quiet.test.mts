import { test } from 'node:test'
import assert from 'node:assert/strict'
import { breaksQuiet, DEFAULT_QUIET, isQuiet, quietUntil } from '../src/lib/quiet.ts'

// 24 September 2026 is a Thursday; the 26th a Saturday. Local time throughout,
// as the page sees it.
const at = (day: number, h: number, m = 0) => new Date(2026, 8, day, h, m)

test('the default window wraps midnight: quiet at night, not in the day', () => {
  assert.equal(isQuiet(DEFAULT_QUIET, at(24, 21)), true)
  assert.equal(isQuiet(DEFAULT_QUIET, at(24, 2)), true)
  assert.equal(isQuiet(DEFAULT_QUIET, at(24, 6, 59)), true)
  assert.equal(isQuiet(DEFAULT_QUIET, at(24, 7)), false)
  assert.equal(isQuiet(DEFAULT_QUIET, at(24, 13)), false)
  assert.equal(isQuiet(DEFAULT_QUIET, at(24, 19, 59)), false)
  assert.equal(isQuiet(DEFAULT_QUIET, at(24, 20)), true)
})

test('a window inside one day, weekends, and off', () => {
  const lunch = { on: true, from: 12, to: 13, weekends: false }
  assert.equal(isQuiet(lunch, at(24, 12, 30)), true)
  assert.equal(isQuiet(lunch, at(24, 13)), false)
  assert.equal(isQuiet(lunch, at(26, 10)), false)
  assert.equal(isQuiet(DEFAULT_QUIET, at(26, 10)), true)
  assert.equal(isQuiet({ ...DEFAULT_QUIET, on: false }, at(24, 23)), false)
  // The same hour for both ends is no window at all, not the whole day.
  assert.equal(isQuiet({ on: true, from: 9, to: 9, weekends: false }, at(24, 9)), false)
})

test('quiet runs until the next working quarter hour', () => {
  assert.equal(quietUntil(DEFAULT_QUIET, at(24, 13)), null)
  assert.equal(quietUntil(DEFAULT_QUIET, at(24, 22, 10)), at(25, 7).getTime())
  // Friday evening runs through the weekend to Monday morning.
  assert.equal(quietUntil(DEFAULT_QUIET, at(25, 21)), at(28, 7).getTime())
  const half = { on: true, from: 12, to: 13, weekends: false }
  assert.equal(quietUntil(half, at(24, 12, 5)), at(24, 13).getTime())
})

test('reminders he set, meetings and VIP mail still get through', () => {
  assert.equal(breaksQuiet({ kind: 'reminder' }), true)
  assert.equal(breaksQuiet({ kind: 'meeting' }), true)
  assert.equal(breaksQuiet({ kind: 'mail', vip: true }), true)
  assert.equal(breaksQuiet({ kind: 'mail' }), false)
  assert.equal(breaksQuiet({ kind: 'portfolio' }), false)
})
