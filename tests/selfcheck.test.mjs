import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.JARVIS_HOME = mkdtempSync(join(tmpdir(), 'jarvis-selfcheck-'))
const { recordVoiceStats, selfCheck } = await import('../bridge/selfcheck.mjs')
const { writeReport } = await import('../bridge/reports.mjs')

test('the week of voice decisions, reports and spend, counted', () => {
  const now = new Date('2026-10-09T15:00:00')
  recordVoiceStats({ ignored: 3, dropped: 2 }, new Date('2026-10-06T10:00:00'))
  recordVoiceStats({ ignored: 4, 'barge-in': 1, 'bad key!': 9, nan: Number.NaN }, new Date('2026-10-08T10:00:00'))
  recordVoiceStats({ ignored: 100 }, new Date('2026-09-20T10:00:00'))
  writeReport({}, {}, new Date('2026-10-07T12:00:00Z'))
  writeReport({}, {}, new Date('2026-09-01T12:00:00Z'))
  const s = selfCheck(7, now)
  assert.deepEqual(s.voice, { ignored: 7, dropped: 2, 'barge-in': 1 })
  assert.equal(s.reports, 1)
  assert.equal(s.days, 7)
})
