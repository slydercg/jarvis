import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.JARVIS_HOME = mkdtempSync(join(tmpdir(), 'jarvis-today-'))
process.env.JARVIS_PA_ENDPOINTS = join(process.env.JARVIS_HOME, 'none.json')
const { keepPast } = await import('../bridge/today.mjs')

const ev = (id, title, start, end) => ({ id, title, start, end })

test('meetings already over stay on the timeline when the calendar stops returning them', () => {
  const now = 1000
  const prev = [ev('a', 'Morning sync', 100, 200), ev('b', 'Triage', 900, 1100), ev('c', 'Later', 2000, 2100)]
  const next = [ev('b', 'Triage', 900, 1100)] // from now on; 'Later' was cancelled
  assert.deepEqual(keepPast(prev, next, now).map((e) => e.id), ['a', 'b'])
})

test('a past meeting the calendar still returns is not doubled', () => {
  const prev = [ev('a', 'Morning sync', 100, 200)]
  const next = [ev('a2', 'Morning  Sync', 100, 200)]
  assert.equal(keepPast(prev, next, 1000).length, 1)
})
