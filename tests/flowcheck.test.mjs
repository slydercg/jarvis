import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.JARVIS_HOME = mkdtempSync(join(tmpdir(), 'jarvis-flowcheck-'))
const { checkFlows, judge } = await import('../bridge/flowcheck.mjs')

const GRAPH_ID = 'AAMkAGI2m1renewalXYZ0123456789='
const TASK_ID = 'AQMkADAwATM0MDAAvasTASK='
const URL = 'https://prod-01.westus.logic.azure.com/workflows/abc/triggers/manual/paths/invoke?sig=SECRET'
const flows = (...keys) => Object.fromEntries(keys.map((k) => [k, URL]))

test('the flows he relies on are checked, and a missing one says what it costs', async () => {
  const rows = await checkFlows({
    flows: flows('inbox', 'todo', 'calendar'),
    inbox: async () => [{ id: GRAPH_ID, received: '2026-09-24T08:00:00Z' }],
    todo: async () => [{ id: TASK_ID, list: 'Tasks', title: 'Chase the VAS invoice' }],
    calendar: async () => [{}, {}],
  })
  const by = Object.fromEntries(rows.map((r) => [r.key, r]))
  assert.equal(by.inbox.status, 'ok')
  assert.equal(by.todo.status, 'ok')
  assert.equal(by.calendar.detail, '2 events today')
  assert.equal(by.sent_email.status, 'warn')
  assert.match(by.sent_email.fix, /replied to are not ticked off/)
  assert.equal(by.flagged_email.status, 'warn')
})

test('the flows that change things are reported, never called', async () => {
  let called = false
  const spy = async () => {
    called = true
    return []
  }
  const rows = await checkFlows({
    flows: flows('inbox', 'todo', 'calendar', 'send_email', 'draft_email', 'todo_add'),
    inbox: async () => [],
    todo: async () => [],
    calendar: async () => [],
    send: spy,
    draft: spy,
    add: spy,
  })
  assert.equal(called, false)
  assert.match(rows.find((r) => r.key === 'send_email').detail, /not called/)
})

test('a failing flow never shows its URL', async () => {
  const rows = await checkFlows({
    flows: flows('inbox', 'todo', 'calendar'),
    inbox: async () => { throw new Error(`fetch failed for ${URL}`) },
    todo: async () => [],
    calendar: async () => [],
  })
  const inbox = rows.find((r) => r.key === 'inbox')
  assert.equal(inbox.status, 'fail')
  assert.doesNotMatch(JSON.stringify(rows), /sig=|logic\.azure/)
})

test('what came back is judged against what the brief needs', () => {
  assert.equal(judge('todo', [{ title: 'a', list: 'Tasks' }, { title: 'b', list: 'Tasks' }]).status, 'warn')
  assert.match(judge('todo', [{ title: 'a', list: 'Tasks' }]).fix, /task 'id'/)
  assert.match(judge('inbox', [{ received: '2026-09-24' }]).fix, /came with no id/)
  assert.match(judge('inbox', [{ id: 'm2', received: '2026-09-24' }]).fix, /shape Outlook opens/)
  assert.match(judge('sent_email', [{ subject: 'RE: x' }]).fix, /sentDateTime/)
  assert.equal(judge('inbox', []).status, 'ok')
})
