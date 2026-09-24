import { test } from 'node:test'
import assert from 'node:assert/strict'

const { createStreaks, stuckAlert } = await import('../bridge/health.mjs')

test('a job is reported once, when it reaches the threshold, not on every failure', () => {
  const told = []
  const h = createStreaks({ threshold: 3, onStuck: (job, n) => told.push([job, n]) })
  h.fail('mail')
  h.fail('mail')
  assert.deepEqual(told, [])
  h.fail('mail')
  assert.deepEqual(told, [['mail', 3]])
  h.fail('mail')
  h.fail('mail')
  assert.equal(told.length, 1, 'still broken: not repeated')
})

test('a success resets the count, and a job that breaks again is reported again', () => {
  const told = []
  const h = createStreaks({ threshold: 2, onStuck: (job) => told.push(job) })
  h.fail('calendar')
  h.ok('calendar')
  h.fail('calendar')
  assert.deepEqual(told, [], 'the success in between broke the streak')
  h.fail('calendar')
  assert.deepEqual(told, ['calendar'])
  h.ok('calendar')
  h.fail('calendar')
  h.fail('calendar')
  assert.deepEqual(told, ['calendar', 'calendar'])
})

test('jobs are counted separately', () => {
  const told = []
  const h = createStreaks({ threshold: 2, onStuck: (job) => told.push(job) })
  h.fail('mail')
  h.fail('calendar')
  assert.deepEqual(told, [])
  assert.equal(h.count('mail'), 1)
})

test('the alert says what stopped, speakably, and where to look', () => {
  const a = stuckAlert('mail', 3, 'no usable answer')
  assert.equal(a.kind, 'reminder')
  assert.match(a.title, /mail/)
  assert.match(a.detail, /3 checks in a row/)
  assert.match(a.say, /^Sir, I haven't been able to check your mail/)
  assert.ok(!Number.isNaN(Date.parse(a.at)))
})
