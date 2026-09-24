import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// A private ~/.jarvis; the brief never builds here.
process.env.JARVIS_HOME = mkdtempSync(join(tmpdir(), 'jarvis-brief-'))
const { sourceLine, withSources } = await import('../bridge/briefing.mjs')

// Thursday 24 September 2026, mid-morning, local time.
const now = new Date(2026, 8, 24, 10, 0)
const at = (day, h = 9) => new Date(2026, 8, day, h).toISOString()

test('a brief line says which account, which kind, who and when', () => {
  assert.equal(
    sourceLine({ account: 'Protective', source: 'email', from: 'Jane Doe', received: at(22) }, now),
    'Protective mail · Jane Doe · Tue',
  )
  assert.equal(sourceLine({ account: 'SCG', source: 'email', from: 'Chris', received: at(24, 7) }, now), 'SCG mail · Chris · today')
  assert.equal(sourceLine({ account: 'Protective', source: 'task', from: 'Flagged Emails', received: at(23) }, now), 'Protective To Do · Flagged Emails · yesterday')
  assert.equal(sourceLine({ account: 'Protective', source: 'email+task', from: 'Jane Doe', received: at(10) }, now), 'Protective mail + To Do · Jane Doe · Sep 10')
})

test('a brief built before this change still gets a source line', () => {
  assert.equal(sourceLine({ account: 'Protective', who: 'Justin Allen', source: 'email' }, now), 'Protective mail · Justin Allen')
  assert.equal(sourceLine({}, now), 'Mail mail')
})

test('every item in the brief the conversation sees carries its line', () => {
  const b = withSources({ focus: 'x', items: [{ account: 'SCG', source: 'email', from: 'Chris' }] }, now)
  assert.equal(b.items[0].sourceLine, 'SCG mail · Chris')
  assert.equal(b.focus, 'x')
  assert.deepEqual(withSources({ focus: 'y' }, now).items, [])
})

test('a bare address reads as a name', () => {
  assert.equal(sourceLine({ account: 'Protective', source: 'email', from: 'chris.patrick@protective.com' }, now), 'Protective mail · Chris Patrick')
  assert.equal(sourceLine({ account: 'Protective', source: 'email', from: 'cfo@protective.com' }, now), 'Protective mail · CFO')
  assert.equal(sourceLine({ account: 'SCG', source: 'email', from: 'Jane Doe <jane@x.com>' }, now), 'SCG mail · Jane Doe')
})
