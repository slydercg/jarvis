import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mailLink, matchMail, plainSubject } from '../bridge/maillinks.mjs'

process.env.JARVIS_HOME = mkdtempSync(join(tmpdir(), 'jarvis-links-'))
const { withLinks } = await import('../bridge/briefing.mjs')

const ID = 'AAMkAGI2TG93AAA=/x+y_z-1'

test('a message id becomes an Outlook link; anything else does not', () => {
  assert.equal(mailLink(ID), `https://outlook.office.com/mail/deeplink/read/${encodeURIComponent(ID)}`)
  assert.equal(mailLink('javascript:alert(1)'), null)
  assert.equal(mailLink('short'), null)
  assert.equal(mailLink('a b c d e f g h'), null)
  assert.equal(mailLink(undefined), null)
})

test('an item finds its email by subject, ignoring RE: and FW:', () => {
  assert.equal(plainSubject('RE: Fwd:  VAS  Invoice'), 'vas invoice')
  const mail = [
    { id: 'AAMk-old-11111', from: 'ap@protective.com', subject: 'VAS invoice', received: '2026-09-20T09:00:00Z' },
    { id: 'AAMk-new-22222', from: 'ap@protective.com', subject: 'RE: VAS invoice', received: '2026-09-23T09:00:00Z' },
    { id: 'AAMk-other-333', from: 'cfo@protective.com', subject: 'VAS invoice', received: '2026-09-24T09:00:00Z' },
  ]
  // The same sender is preferred, then the newest.
  assert.equal(matchMail({ subject: 'VAS invoice', from: 'ap@protective.com' }, mail).id, 'AAMk-new-22222')
  assert.equal(matchMail({ subject: 'VAS invoice' }, mail).id, 'AAMk-other-333')
  assert.equal(matchMail({ subject: 'Something else' }, mail), null)
  assert.equal(matchMail({}, mail), null)
})

test('the brief gets links only on Protective email lines that match', async () => {
  const brief = {
    items: [
      { account: 'Protective', source: 'email', subject: 'VAS invoice', from: 'ap@protective.com' },
      { account: 'Protective', source: 'task', subject: 'VAS invoice' },
      { account: 'SCG', source: 'email', subject: 'VAS invoice' },
      { account: 'Protective', source: 'email+task', subject: 'No such mail' },
    ],
  }
  const out = await withLinks(brief, async () => [{ id: ID, from: 'ap@protective.com', subject: 'VAS invoice', received: '2026-09-23' }])
  assert.deepEqual(out.items.map((i) => Boolean(i.link)), [true, false, false, false])
  // A mailbox that cannot be read leaves the brief as it was.
  assert.equal(await withLinks(brief, async () => { throw new Error('down') }), brief)
})
