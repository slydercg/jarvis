import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.JARVIS_HOME = mkdtempSync(join(tmpdir(), 'jarvis-brief-done-'))
const { anchorTasks, serveBrief, tickDone } = await import('../bridge/briefing.mjs')

const MAIL_ID = 'AAMkAGI2m1renewalXYZ='
const TASK_ID = 'AQMkADAwATM0MDAAvasTASK='
const built = Date.parse('2026-09-24T07:00:00Z')

test('a To Do line is remembered by its task, and ticked off once that task is gone', () => {
  const items = [
    { account: 'Protective', source: 'task', subject: 'Chase the VAS invoice' },
    { account: 'Protective', source: 'task', subject: 'A title the model reworded' },
    { account: 'SCG', source: 'task', subject: 'Chase the VAS invoice' },
  ]
  const open = [{ id: TASK_ID, title: 'Chase the VAS invoice', list: 'Tasks' }]
  const anchored = anchorTasks(items, open)
  assert.equal(anchored[0].taskKey, `id:${TASK_ID}`)
  assert.equal(anchored[1].taskKey, undefined)
  assert.equal(anchored[2].taskKey, undefined)
  // Nothing new to remember: the same array back, so nothing is saved.
  assert.equal(anchorTasks(anchored, open), anchored)
  // Still open: nothing done. Gone: done. Unreadable To Do: nothing done.
  assert.equal(tickDone(anchored, { tasks: open, sent: null, builtAt: built })[0].done, undefined)
  const later = tickDone(anchored, { tasks: [], sent: null, builtAt: built })
  assert.deepEqual(later.map((i) => i.done ?? null), ['ticked off in To Do', null, null])
  assert.equal(tickDone(anchored, { tasks: null, sent: null, builtAt: built })[0].done, undefined)
})

test('a task with no id is known by its title instead', () => {
  const [a] = anchorTasks([{ account: 'Protective', source: 'email+task', subject: 'RE: Sign the SOW' }], [{ title: 'Sign the SOW' }])
  assert.equal(a.taskKey, 'title:sign the sow')
  assert.equal(tickDone([a], { tasks: [{ title: 'Sign the SOW' }], sent: null, builtAt: built })[0].done, undefined)
  assert.equal(tickDone([a], { tasks: [], sent: null, builtAt: built })[0].done, 'ticked off in To Do')
})

test('an email line is ticked off by a reply sent after it arrived, and not by an older one', () => {
  const item = { account: 'Protective', source: 'email', subject: 'Q4 renewal', received: '2026-09-23T15:00:00Z' }
  const sent = (at) => [{ subject: 'RE: Q4 renewal', sent: at }]
  assert.equal(tickDone([item], { tasks: null, sent: sent('2026-09-24T09:00:00Z'), builtAt: built })[0].done, 'replied')
  assert.equal(tickDone([item], { tasks: null, sent: sent('2026-09-22T09:00:00Z'), builtAt: built })[0].done, undefined)
  assert.equal(tickDone([item], { tasks: null, sent: [{ subject: 'RE: Other', sent: '2026-09-24T09:00:00Z' }], builtAt: built })[0].done, undefined)
  // Arrival unknown: only a reply after the brief was built counts.
  const unknown = { ...item, received: '' }
  assert.equal(tickDone([unknown], { tasks: null, sent: sent('2026-09-24T06:00:00Z'), builtAt: built })[0].done, undefined)
  assert.equal(tickDone([unknown], { tasks: null, sent: sent('2026-09-24T08:00:00Z'), builtAt: built })[0].done, 'replied')
  // SCG mail is never ticked off: the bridge cannot read that mailbox.
  assert.equal(tickDone([{ ...item, account: 'SCG' }], { tasks: null, sent: sent('2026-09-24T09:00:00Z'), builtAt: built })[0].done, undefined)
})

test('serving the brief links, ticks off, and reports how it went', async () => {
  const brief = {
    focus: 'Renewal first.',
    items: [
      { account: 'Protective', source: 'email', subject: 'Q4 renewal', from: 'chris@protective.com', received: '2026-09-23T15:00:00Z' },
      { account: 'Protective', source: 'task', subject: 'Chase the VAS invoice' },
      { account: 'SCG', source: 'email', subject: 'Scope', messageId: 'not-an-id' },
    ],
  }
  const sources = {
    mail: async () => [{ id: MAIL_ID, from: 'chris@protective.com', subject: 'Q4 renewal' }],
    tasks: async () => [{ title: 'Chase the VAS invoice', list: 'Tasks' }],
    sent: async () => { throw new Error('flow timed out') },
  }
  const out = await serveBrief({ brief, builtAt: built }, sources, new Date('2026-09-24T10:00:00Z'))
  assert.equal(out.brief.focus, 'Renewal first.')
  assert.match(out.brief.items[0].link, /outlook\.office\.com/)
  assert.match(out.brief.items[0].sourceLine, /Protective mail · Chris/)
  assert.equal(out.anchored[1].taskKey, 'title:chase the vas invoice')
  assert.equal(out.health.lines, 3)
  assert.equal(out.health.linked, 1)
  assert.equal(out.health.done, 0)
  assert.deepEqual(out.health.unlinked, ['Protective: Chase the VAS invoice', 'SCG: Scope'])
  assert.ok(out.health.notes.some((n) => /sent mail couldn't be read: flow timed out/.test(n)))
  assert.ok(out.health.notes.some((n) => /no task ids/.test(n)))
})
