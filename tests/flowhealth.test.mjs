import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// A private home and made-up flow URLs; fetch is replaced below.
const dir = mkdtempSync(join(tmpdir(), 'jarvis-flowhealth-'))
process.env.JARVIS_HOME = dir
const flowsFile = join(dir, 'pa_endpoints.json')
writeFileSync(
  flowsFile,
  '﻿' + JSON.stringify({ inbox: 'https://example.environment.api.powerplatform.com/workflows/inbox/triggers/manual/paths/invoke?sig=test' }),
)
process.env.JARVIS_PA_ENDPOINTS = flowsFile
const { connectionProblem, loadFlows, onFlowResult, protective } = await import('../bridge/protective.mjs')
const { createStreaks } = await import('../bridge/health.mjs')

test('a flows file that starts with a byte-order mark still loads', () => {
  assert.deepEqual(Object.keys(loadFlows().flows), ['inbox'])
})

test('an expired connection is told apart from any other failure, and named', () => {
  const body = (m) => JSON.stringify({ error: { code: 'ActionFailed', message: m } })
  assert.equal(connectionProblem('inbox', 502, body('Office 365 Outlook: Unauthorized')), 'Office 365 Outlook')
  assert.equal(connectionProblem('meeting_notes', 502, body('Find_meeting: 401 Invalid token lifetime. (HttpWithAzureAD)')), 'HTTP with Microsoft Entra ID')
  assert.equal(connectionProblem('todo', 401, ''), 'Microsoft To Do')
  assert.equal(connectionProblem('inbox', 502, body('List chats: Unauthorized (teams)')), 'Microsoft Teams')
  assert.equal(connectionProblem('inbox', 500, body('The request timed out')), null)
  assert.equal(connectionProblem('inbox', 404, 'Not found'), null)
})

test('every flow call reports how it went, without its URL; three failures make one card', async () => {
  const seen = []
  const stuck = []
  const health = createStreaks({ threshold: 3, onStuck: (key, n, why) => stuck.push([key, n, why]) })
  const off = onFlowResult((r) => {
    seen.push(r)
    if (r.ok) health.ok(r.key)
    else health.fail(r.key, r.connection ?? '')
  })
  const real = globalThis.fetch
  let answer = () => new Response(JSON.stringify({ error: { message: 'Office 365 Outlook connection: Unauthorized' } }), { status: 502 })
  globalThis.fetch = async () => answer()
  try {
    for (let i = 0; i < 4; i++) await assert.rejects(protective.inbox(), (err) => !/sig=|powerplatform/.test(err.message))
    assert.deepEqual(stuck, [['inbox', 3, 'Office 365 Outlook']])
    assert.equal(seen[0].status, 502)
    assert.doesNotMatch(JSON.stringify(seen), /sig=|powerplatform/)
    answer = () => new Response(JSON.stringify({ value: [] }), { status: 200 })
    await protective.inbox()
    assert.equal(health.count('inbox'), 0)
    assert.deepEqual(seen.at(-1), { key: 'inbox', ok: true })
  } finally {
    globalThis.fetch = real
    off()
  }
})
