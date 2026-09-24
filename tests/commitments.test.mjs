import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.JARVIS_HOME = mkdtempSync(join(tmpdir(), 'jarvis-commit-'))
const c = await import('../bridge/commitments.mjs')

const ledger = (items) =>
  writeFileSync(join(process.env.JARVIS_HOME, 'commitments.json'), JSON.stringify({ scannedAt: null, items }))
const item = (id, who, extra = {}) => ({ id, direction: 'theirs', who, what: `thing ${id}`, due: null, since: '2026-09-20', status: 'open', ...extra })

test('people are matched by whole words, so Chris is not Christine', () => {
  assert.equal(c.samePerson('Chris', 'Chris Smith'), true)
  assert.equal(c.samePerson('chris.smith@example.com', 'Chris Smith'), true)
  assert.equal(c.samePerson('Chris', 'Christine'), false)
  assert.equal(c.samePerson('Chris Smith', 'Chris Jones'), false)
  assert.equal(c.samePerson('', 'Chris'), false)
})

test('meeting prep gets only the promises that involve the people in it', () => {
  ledger([item('a1', 'Chris Smith'), item('b2', 'Christine Park'), item('c3', 'Sarah')])
  const ids = (list) => list.map((i) => i.id).sort()
  assert.deepEqual(ids(c.commitmentsWith(['Chris Smith <chris.smith@example.com>'])), ['a1'])
  assert.deepEqual(ids(c.commitmentsWith(['Christine'])), ['b2'])
  assert.deepEqual(ids(c.openCommitments({ who: 'chris' })), ['a1'])
})

test('stale promises from others are let go; his own never are', () => {
  const now = new Date('2026-10-20T12:00:00')
  const l = {
    items: [
      item('old', 'Sarah', { since: '2026-09-20' }), // no date, a month old
      item('new', 'Sarah', { since: '2026-10-15' }), // no date, five days old
      item('late', 'Sarah', { due: '2026-10-01' }), // 19 days past due
      item('due', 'Sarah', { due: '2026-10-12' }), // 8 days past due: still chased
      item('mine', 'Sarah', { direction: 'mine', since: '2026-08-01' }),
      item('kept', 'Sarah', { status: 'done', since: '2026-08-01' }),
    ],
  }
  assert.equal(c.expireStale(l, now), 2)
  const status = Object.fromEntries(l.items.map((i) => [i.id, i.status]))
  assert.deepEqual(status, { old: 'expired', new: 'open', late: 'expired', due: 'open', mine: 'open', kept: 'done' })
  assert.equal(l.items.find((i) => i.id === 'old').closed, '2026-10-20')
})

test('expired promises drop out of what is open', () => {
  ledger([item('x9', 'Sarah', { status: 'expired', closed: '2026-09-24' }), item('y8', 'Sarah')])
  assert.deepEqual(c.openCommitments().map((i) => i.id), ['y8'])
})
