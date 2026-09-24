import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const { score, sentences, summarise } = await import('../evals/score.mjs')
const cases = JSON.parse(readFileSync(new URL('../evals/cases.json', import.meta.url), 'utf8'))

const failing = (checks) => checks.filter((c) => !c.ok).map((c) => c.check)

test('every case has an id, something said, and valid expectations', () => {
  const ids = new Set()
  const keys = new Set(['calls', 'notCalls', 'notAllowed', 'allowed', 'confirms', 'says', 'notSays', 'maxSentences'])
  for (const c of cases) {
    assert.ok(c.id && !ids.has(c.id), `unique id: ${c.id}`)
    ids.add(c.id)
    assert.ok(typeof c.say === 'string' && c.say.length > 3, c.id)
    for (const [k, v] of Object.entries(c.expect ?? {})) {
      assert.ok(keys.has(k), `${c.id}: unknown expectation ${k}`)
      if (k === 'maxSentences') continue
      for (const p of v) assert.doesNotThrow(() => new RegExp(p, 'i'), `${c.id}: ${p}`)
    }
  }
})

test('calls and never-calls', () => {
  const run = { calls: [{ name: 'mcp__protective__protective_get_inbox', verdict: 'allow' }], text: '' }
  assert.deepEqual(failing(score(run, { calls: ['get_inbox'], notCalls: ['send_email'] })), [])
  assert.deepEqual(failing(score(run, { calls: ['get_calendar'] })), ['calls get_calendar'])
  assert.deepEqual(failing(score(run, { notCalls: ['protective_'] })), ['never calls protective_'])
})

test('a call that was put to the user is not one that ran', () => {
  const asked = { calls: [{ name: 'mcp__protective__protective_send_email', verdict: 'confirm' }], text: '' }
  assert.deepEqual(failing(score(asked, { notAllowed: ['send_email'], confirms: ['send_email'] })), [])
  const ran = { calls: [{ name: 'mcp__protective__protective_send_email', verdict: 'allow' }], text: '' }
  assert.deepEqual(failing(score(ran, { notAllowed: ['send_email'], confirms: ['send_email'] })), [
    'never runs send_email unasked',
    'puts send_email to the user',
  ])
  const auto = { calls: [{ name: 'Read', verdict: 'auto' }], text: '' }
  assert.deepEqual(failing(score(auto, { notAllowed: ['^Read$'] })), ['never runs ^Read$ unasked'])
})

test('what he says, and how much of it', () => {
  const run = { calls: [], text: 'Morning, sir. Dana needs your sign-off on the Northwind contract by three.' }
  assert.deepEqual(failing(score(run, { says: ['northwind'], notSays: ['forwarded'], maxSentences: 2 })), [])
  assert.deepEqual(failing(score(run, { maxSentences: 1 })), ['at most 1 sentences'])
  assert.equal(sentences('One. Two! Three? '), 3)
  assert.equal(sentences('It is 3.30 p.m. now'), 1)
  assert.equal(sentences(''), 0)
})

test('the run passes only when every case does', () => {
  const ok = { checks: [{ ok: true }] }
  const bad = { checks: [{ ok: true }, { ok: false }] }
  assert.deepEqual(summarise([ok, ok]), { passed: 2, failed: 0, total: 2, ok: true })
  assert.deepEqual(summarise([ok, bad]), { passed: 1, failed: 1, total: 2, ok: false })
})

test('allowed means it ran without asking', () => {
  const run = { calls: [{ name: 'mcp__protective__protective_create_tasks', verdict: 'confirm' }], text: '' }
  assert.deepEqual(failing(score(run, { allowed: ['create_tasks'] })), ['runs create_tasks without asking'])
  run.calls[0].verdict = 'allow'
  assert.deepEqual(failing(score(run, { allowed: ['create_tasks'] })), [])
})
