import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const { score, sentences, summarise } = await import('../evals/score.mjs')
const cases = JSON.parse(readFileSync(new URL('../evals/cases.json', import.meta.url), 'utf8'))

const failing = (checks) => checks.filter((c) => !c.ok).map((c) => c.check)

test('every case has an id, something said, and valid expectations', () => {
  const ids = new Set()
  const keys = new Set(['calls', 'notCalls', 'notAllowed', 'allowed', 'confirms', 'says', 'notSays', 'maxSentences', 'inputs', 'notInputs'])
  for (const c of cases) {
    assert.ok(c.id && !ids.has(c.id), `unique id: ${c.id}`)
    ids.add(c.id)
    assert.ok(typeof c.say === 'string' && c.say.length > 3, c.id)
    for (const [k, v] of Object.entries(c.expect ?? {})) {
      assert.ok(keys.has(k), `${c.id}: unknown expectation ${k}`)
      if (k === 'maxSentences') continue
      const patterns = k === 'inputs' || k === 'notInputs' ? v.flatMap((x) => [x.call, x.has]) : v
      for (const p of patterns) assert.doesNotThrow(() => new RegExp(p, 'i'), `${c.id}: ${p}`)
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

test('what a call was given: the text on screen, the line it named', () => {
  const run = {
    calls: [
      { name: 'mcp__jarvis__display', verdict: 'allow', input: { title: 'TODAY', html: '<div class="hud-row" data-brief="d1wy-1m">Sign off</div>' } },
      { name: 'mcp__jarvis_brief__update_brief_line', verdict: 'allow', input: { ref: 'd1wy-3t', action: 'done' } },
    ],
    text: '',
  }
  const ok = {
    inputs: [{ call: 'display', has: 'data-brief="[a-z0-9]{4}-[1-8][mt]"' }, { call: 'update_brief_line', has: '^[a-z0-9]{4}-3t$' }],
    notInputs: [{ call: 'display', has: 'datadog' }],
  }
  assert.deepEqual(failing(score(run, ok)), [])
  assert.deepEqual(failing(score(run, { notInputs: [{ call: 'display', has: 'sign off' }] })), ['never calls display with /sign off/'])
  assert.deepEqual(failing(score(run, { inputs: [{ call: 'display', has: 'x-ref' }] })), ['calls display with /x-ref/'])
})

test('the eval brief is one the bridge serves without building it', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  process.env.JARVIS_HOME = mkdtempSync(join(tmpdir(), 'jarvis-eval-brief-'))
  const { briefFixture } = await import('../evals/fake-brief.mjs')
  writeFileSync(join(process.env.JARVIS_HOME, 'brief.json'), JSON.stringify({ last: briefFixture() }))
  const { getBrief } = await import('../bridge/briefing.mjs')
  // No deps: building would throw, so this passes only if the saved brief is used.
  const entry = await getBrief({})
  assert.equal(entry.brief.items.length, 4)
  assert.equal(entry.brief.items[1].done, 'replied')
})
