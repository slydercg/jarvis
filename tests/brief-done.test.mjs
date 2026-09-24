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

test('a brief button acts on its line only while that brief is current', async () => {
  const { writeFileSync } = await import('node:fs')
  const { briefAction, briefRef } = await import('../bridge/briefing.mjs')
  const { listStratum } = await import('../bridge/stratum.mjs')
  const builtAt = Date.now() - 3600e3
  const items = [
    { account: 'Protective', source: 'email', action: 'Approve the Q4 renewal', subject: 'RE: Q4 renewal', from: 'Chris Patrick', why: 'Pricing lapses Friday' },
    { account: 'SCG', source: 'task', action: 'Send the SOW', subject: 'Send the SOW', from: 'Tasks' },
  ]
  const day = new Date().toLocaleDateString('en-CA')
  writeFileSync(join(process.env.JARVIS_HOME, 'brief.json'), JSON.stringify({ last: { day, builtAt, brief: { focus: 'x', items } } }))
  const mail = briefRef(builtAt, 0, items[0])
  const task = briefRef(builtAt, 1, items[1])
  assert.match(mail, /^[a-z0-9]{4}-1m$/)
  assert.match(task, /^[a-z0-9]{4}-2t$/)

  // Reply: a question to ask, nothing changed.
  const reply = briefAction(mail, 'reply')
  assert.equal(reply.ok, true)
  assert.equal(reply.ask, 'Draft a reply to Chris Patrick about "RE: Q4 renewal" from my Protective account.')
  assert.equal(briefAction(task, 'reply').ok, false)

  // Tomorrow: off the brief, and a reminder that wakes at 9 tomorrow.
  const snoozed = briefAction(task, 'snooze')
  assert.equal(snoozed.ok, true)
  const reminder = listStratum().find((i) => i.title === 'Send the SOW')
  assert.equal(reminder.state, 'snoozed')
  assert.equal(new Date(reminder.until).getHours(), 9)

  // Done: kept on the saved brief, so the next serve leaves it out of the three.
  assert.equal(briefAction(mail, 'done').ok, true)
  const { todaysBrief } = await import('../bridge/briefing.mjs')
  assert.deepEqual(todaysBrief().brief.items.map((i) => i.done), ['marked done', 'moved to tomorrow'])

  // A ref from another build, a line that is not there, or a made-up op: nothing happens.
  assert.match(briefAction(briefRef(builtAt + 99_999_999, 0, items[0]), 'done').message, /rebuilt/)
  assert.equal(briefAction(mail.replace('-1m', '-7m'), 'done').ok, false)
  assert.equal(briefAction(mail, 'delete').ok, false)
  assert.equal(briefAction('"><script>', 'done').ok, false)
})

test('every page is told when a line changes, by button or by voice', async () => {
  const { briefAction, briefRef, onBriefAction, todaysBrief, updateBriefLine } = await import('../bridge/briefing.mjs')
  // Today's brief from the test above: an email line, then a task line.
  const { builtAt, brief } = todaysBrief()
  const told = []
  const stop = onBriefAction((r) => told.push(r))
  briefAction(briefRef(builtAt, 0, brief.items[0]), 'reply')
  const ref = briefRef(builtAt, 1, brief.items[1])
  assert.equal(told.length, 0)
  // By voice: the conversation's tool.
  const out = await updateBriefLine({ ref, action: 'done' })
  assert.equal(out.content[0].text, 'Done')
  assert.deepEqual(told.map((r) => [r.ref, r.op, r.ok]), [[ref, 'done', true]])
  const bad = await updateBriefLine({ ref: 'zzzz-1t', action: 'tomorrow' })
  assert.equal(bad.isError, true)
  stop()
})
