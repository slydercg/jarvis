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

test('the brief gets links only on Protective lines that match an email', async () => {
  const brief = {
    items: [
      { account: 'Protective', source: 'email', subject: 'VAS invoice', from: 'ap@protective.com' },
      { account: 'Protective', source: 'task', subject: 'VAS invoice' },
      { account: 'SCG', source: 'email', subject: 'VAS invoice' },
      { account: 'Protective', source: 'email+task', subject: 'No such mail' },
    ],
  }
  const out = await withLinks(brief, async () => [{ id: ID, from: 'ap@protective.com', subject: 'VAS invoice', received: '2026-09-23' }])
  assert.deepEqual(out.items.map((i) => Boolean(i.link)), [true, true, false, false])
  // A mailbox that cannot be read leaves the brief as it was.
  assert.equal(await withLinks(brief, async () => { throw new Error('down') }), brief)
})

const SCG_ID = 'AAMkAGEwOGU0MTY1LTVlOGMtNDg2ZS1iYjEzLTUwOWQwNmEzMTA0NABGAAAAAABfFpOGaWo_S4HMnNqnfe2GBwCfYuMRKYJsS5ug61qFIu-cAACBrOelAAA='

test('an SCG email line links by the id the brief recorded, if it looks like one', async () => {
  const brief = {
    items: [
      { account: 'SCG', source: 'email', subject: 'Scope', messageId: SCG_ID },
      { account: 'SCG', source: 'email', subject: 'Scope', messageId: 'https://evil.example/x' },
      { account: 'SCG', source: 'email', subject: 'Scope', messageId: 'AAMk-too-short' },
      { account: 'SCG', source: 'task', subject: 'Scope', messageId: SCG_ID },
      { account: 'Gmail', source: 'email', subject: 'Scope', messageId: SCG_ID },
    ],
  }
  let looked = false
  const out = await withLinks(brief, async () => { looked = true; return [] })
  assert.deepEqual(out.items.map((i) => i.link ?? null), [mailLink(SCG_ID), null, null, null, null])
  // No Protective lines, so the Protective mailbox is not read at all.
  assert.equal(looked, false)
})

test('a Protective line falls back to its recorded id when no subject matches', async () => {
  const out = await withLinks({ items: [{ account: 'Protective', source: 'email', subject: 'Gone', messageId: SCG_ID }] }, async () => [])
  assert.equal(out.items[0].link, mailLink(SCG_ID))
})

test('a To Do line opens its email when it has one, else the task', async () => {
  const { todoLink } = await import('../bridge/maillinks.mjs')
  const TASK_ID = 'AQMkADAwATM0MDAAMS1hNTAwLTc5NDEtMDACLTAwCgBGAAAD'
  const brief = {
    items: [
      { account: 'Protective', source: 'task', subject: 'VAS invoice' },
      { account: 'Protective', source: 'task', subject: 'Renew the certificates' },
      { account: 'Protective', source: 'task', subject: 'Nothing matches' },
      { account: 'SCG', source: 'task', subject: 'Renew the certificates' },
    ],
  }
  const out = await withLinks(
    brief,
    async () => [{ id: ID, from: 'ap@protective.com', subject: 'VAS invoice' }],
    async () => [{ id: TASK_ID, title: 'Renew the certificates', list: 'Tasks' }, { title: 'Nothing matches', list: 'Tasks' }],
  )
  assert.deepEqual(out.items.map((i) => i.link ?? null), [mailLink(ID), todoLink(TASK_ID), null, null])
  assert.equal(todoLink(TASK_ID), `https://to-do.office.com/tasks/id/${TASK_ID}/details`)
  assert.equal(todoLink('javascript:x'), null)
})
