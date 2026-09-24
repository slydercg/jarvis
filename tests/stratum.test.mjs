import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// A private ~/.jarvis for the review list.
process.env.JARVIS_HOME = mkdtempSync(join(tmpdir(), 'jarvis-stratum-'))

const s = await import('../bridge/stratum.mjs')

const portfolio = {
  kind: 'portfolio',
  label: 'Portfolio',
  title: '2 high-priority items newly blocked',
  detail: '',
  items: [{ key: 'RPT-3880', title: 'Update SSRS report', detail: 'Maysoon · Blocked' }, { key: 'NI-812', title: 'API migration', detail: '' }],
  at: new Date().toISOString(),
}

test('an alert is kept once, however often it is raised, and a digest is not kept', () => {
  const first = s.keepAlert(portfolio)
  const again = s.keepAlert({ ...portfolio, at: new Date().toISOString() })
  assert.equal(first.id, again.id)
  assert.equal(s.keepAlert({ kind: 'digest', title: '3 things held back' }), null)
  const list = s.listStratum()
  assert.equal(list.length, 1)
  assert.equal(list[0].state, 'open')
  assert.equal(list[0].seen, false)
  assert.equal(list[0].items.length, 2)
})

test('done stays done when the same thing is raised again; it can be reopened', () => {
  const [item] = s.listStratum()
  s.updateItem(item.id, { state: 'done' })
  s.keepAlert(portfolio)
  assert.equal(s.listStratum()[0].state, 'done')
  s.updateItem(item.id, { state: 'open' })
  assert.equal(s.listStratum()[0].state, 'open')
})

test('seen, and closing a whole kind', () => {
  s.keepAlert({ kind: 'mail', title: 'Chris Patrick', detail: 'APD scope — needs a decision', at: new Date().toISOString() })
  s.markAllSeen()
  assert.ok(s.listStratum().every((i) => i.seen))
  assert.equal(s.closeKind('portfolio'), 1)
  assert.deepEqual(
    s.listStratum().filter((i) => i.state === 'open').map((i) => i.kind),
    ['mail'],
  )
})

test('snoozed items and reminders come back when their time comes, once', () => {
  const mail = s.listStratum().find((i) => i.kind === 'mail')
  const past = Date.now() - 1000
  s.updateItem(mail.id, { until: Date.now() + 3_600_000 })
  assert.equal(s.listStratum().find((i) => i.id === mail.id).state, 'snoozed')
  const reminder = s.addReminder({ title: 'Call Chris about the roadmap', until: Date.now() + 50 })
  assert.equal(reminder.state, 'snoozed')
  const since = Date.now()
  return new Promise((done) =>
    setTimeout(() => {
      const woken = s.wokenSince(since)
      assert.deepEqual(woken.map((i) => i.title), ['Call Chris about the roadmap'])
      assert.equal(woken[0].seen, false)
      assert.equal(s.wokenSince(Date.now()).length, 0, 'said once')
      assert.equal(s.listStratum().find((i) => i.id === mail.id).state, 'snoozed', 'not due yet')
      assert.ok(past < since)
      done()
    }, 80),
  )
})

test('things that resolve themselves close: a promise kept, a meeting long started', () => {
  let open = true
  s.registerResolver('commitment', () => open)
  s.keepAlert({ kind: 'promise', label: 'Overdue', title: 'Cathrene — send the doc', ref: 'commitment:abc123', at: new Date().toISOString() })
  s.keepAlert({ kind: 'meeting', title: 'Architecture review', at: new Date(Date.now() - 45 * 60_000).toISOString() })
  const find = (k) => s.listStratum().find((i) => i.kind === k)
  assert.equal(find('meeting').state, 'done', 'started 45 minutes ago')
  assert.equal(find('promise').state, 'open')
  open = false
  assert.equal(find('promise').state, 'done', 'the ledger has it kept')
})

test('spoken times: in N minutes, in an hour, 3pm, tomorrow', () => {
  const now = new Date('2026-09-24T10:00:00')
  assert.equal(s.parseWhen('in 20 minutes', now), now.getTime() + 20 * 60_000)
  assert.equal(s.parseWhen('in an hour', now), now.getTime() + 3_600_000)
  assert.equal(s.parseWhen('in 1 hour', now), now.getTime() + 3_600_000)
  assert.equal(new Date(s.parseWhen('3pm', now)).getHours(), 15)
  assert.equal(new Date(s.parseWhen('at 3', now)).getHours(), 15)
  const t = new Date(s.parseWhen('tomorrow', now))
  assert.equal(t.getDate(), 25)
  assert.equal(t.getHours(), 9)
  assert.equal(new Date(s.parseWhen('this afternoon', now)).getHours(), 14)
  assert.equal(s.parseWhen('whenever', now), null)
  assert.equal(s.parseWhen('9am', now), null, 'already past')
})
