import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WRONG, clearTrail, note, trail } from '../src/lib/trail.ts'

test('the trail keeps the last quarter of an hour, oldest first', () => {
  clearTrail()
  note('heard', 'old', 0)
  note('heard', 'prep me', 20 * 60_000)
  note('dropped', 'only a sound ([typing])', 20 * 60_000 + 1)
  assert.deepEqual(trail(21 * 60_000).map((e) => e.text), ['prep me', 'only a sound ([typing])'])
})

test('"that was wrong" is a report, not a question', () => {
  for (const s of ['That was wrong', "that's wrong.", 'report that', 'bug report']) assert.ok(WRONG.test(s), s)
  for (const s of ['what was wrong with the build', 'that was wrong of him to say']) assert.ok(!WRONG.test(s), s)
})
