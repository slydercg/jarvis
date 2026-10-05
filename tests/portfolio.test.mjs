import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// A private ~/.jarvis holding a pulse built five minutes ago.
process.env.JARVIS_HOME = mkdtempSync(join(tmpdir(), 'jarvis-pulse-'))
const builtAt = Date.now() - 5 * 60_000
const pulse = { summary: 'Two blocked.', blocked: [{ key: 'NI-1', title: 'x' }] }
writeFileSync(join(process.env.JARVIS_HOME, 'portfolio-pulse.json'), JSON.stringify({ builtAt, pulse }))
const { getPulse, pulseDue, pulseKey } = await import('../bridge/portfolio.mjs')

test('a pulse kept from before a restart answers at once, a specific question too', async () => {
  // No deps: anything that tried to build would throw.
  const a = await getPulse(null, {})
  const b = await getPulse(null, { question: "What's blocked across the portfolio?" })
  assert.equal(a.builtAt, builtAt)
  assert.deepEqual(b.pulse, pulse)
})

test('the pulse is warmed again only once it is older than the interval', () => {
  assert.equal(pulseDue(builtAt + 10 * 60_000), false)
  assert.equal(pulseDue(builtAt + 31 * 60_000), true)
})

test('the same question however it is worded shares one build', () => {
  assert.equal(pulseKey("What's blocked?"), pulseKey('what s BLOCKED'))
  assert.equal(pulseKey(undefined), '')
})

test('the blocked-work trend comes from the daily snapshots alone', async () => {
  const { blockedTrend } = await import('../bridge/portfolio.mjs')
  const b = (key, owner) => ({ key, title: `t ${key}`, owner })
  const snaps = {
    '2026-09-28': { blocked: [b('NI-1', 'Daniel'), b('NI-2', 'John'), b('NI-3', 'Chris')] },
    '2026-10-01': { blocked: [b('NI-1', 'Daniel'), b('NI-2', 'John'), b('NI-4', 'Daniel'), b('NI-3', 'Chris')] },
    '2026-10-05': { blocked: [b('NI-1', 'Daniel'), b('NI-4', 'Daniel')] },
  }
  const t = blockedTrend(snaps)
  assert.deepEqual(t.series.map((s) => s.blocked), [3, 4, 2])
  assert.equal(t.direction, 'falling')
  assert.equal(t.comparedWith, '2026-09-28')
  assert.deepEqual(t.longest.map((l) => `${l.key}:${l.days}`), ['NI-1:7', 'NI-4:4'])
  assert.deepEqual(t.byOwner, [{ owner: 'Daniel', count: 2 }])
  assert.deepEqual(t.cleared.map((c) => c.key).sort(), ['NI-2', 'NI-3'])
  assert.equal(blockedTrend({}).direction, 'unknown')
})
