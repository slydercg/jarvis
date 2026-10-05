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
