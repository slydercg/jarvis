import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dayLabel, segments } from '../src/lib/history.ts'

test('a search splits a line into plain and matched pieces, whatever the case', () => {
  assert.deepEqual(segments('Approve the Datadog renewal; datadog is due', 'DataDog'), [
    { text: 'Approve the ', hit: false },
    { text: 'Datadog', hit: true },
    { text: ' renewal; ', hit: false },
    { text: 'datadog', hit: true },
    { text: ' is due', hit: false },
  ])
})

test('no search, a one-letter search or no match leaves the line whole', () => {
  const whole = [{ text: 'Three meetings today', hit: false }]
  assert.deepEqual(segments('Three meetings today', ''), whole)
  assert.deepEqual(segments('Three meetings today', 't'), whole)
  assert.deepEqual(segments('Three meetings today', 'jira'), whole)
  assert.deepEqual(segments('jira', 'jira'), [{ text: 'jira', hit: true }])
})

test('days are named the way you would say them', () => {
  assert.equal(dayLabel('2026-09-24', '2026-09-24'), 'Today')
  assert.equal(dayLabel('2026-09-23', '2026-09-24'), 'Yesterday')
  // Across the end of a month too.
  assert.equal(dayLabel('2026-09-30', '2026-10-01'), 'Yesterday')
  const older = dayLabel('2026-09-22', '2026-09-24')
  assert.match(older, /22/)
  assert.match(older, /Tue/)
})
