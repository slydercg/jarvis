import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

// A private ~/.jarvis and Claude config, with a saved conversation of a chosen length.
process.env.JARVIS_HOME = mkdtempSync(join(tmpdir(), 'jarvis-resume-'))
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'jarvis-claude-'))
process.env.JARVIS_RESUME_MAX = '10'
const project = join(process.env.CLAUDE_CONFIG_DIR, 'projects', homedir().replace(/[^a-zA-Z0-9]/g, '-'))
mkdirSync(project, { recursive: true })

const m = await import('../bridge/memory.mjs')

function conversation(id, exchanges) {
  const lines = []
  for (let i = 0; i < exchanges; i++) {
    lines.push({ type: 'user', message: { role: 'user', content: `[Thu 10:0${i % 10}] question ${i}` } })
    lines.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `answer ${i}` }] } })
  }
  lines.push({ type: 'queue-operation' })
  writeFileSync(join(project, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  m.saveSession(id)
}

test('a short conversation is resumed as before', () => {
  conversation('11111111-1111-1111-1111-111111111111', 4)
  const s = m.sessionOptions()
  assert.equal(s.resumed, true)
  assert.equal(s.id, '11111111-1111-1111-1111-111111111111')
})

test('a long one starts fresh, carrying its last exchanges', () => {
  conversation('22222222-2222-2222-2222-222222222222', 8)
  const s = m.sessionOptions()
  assert.equal(s.resumed, false)
  assert.notEqual(s.id, '22222222-2222-2222-2222-222222222222')
  assert.ok(s.options.sessionId)
  assert.ok(s.carried.length > 0 && s.carried.length <= 6)
  assert.deepEqual(s.carried.at(-1), { role: 'jarvis', text: 'answer 7' })
  // The time prefix the model sees is not part of what he said.
  assert.ok(s.carried.some((t) => t.role === 'user' && t.text === 'question 7'))
})

test('the carried exchanges are framed as context, not instructions', () => {
  const block = m.carriedPrompt([{ role: 'user', text: 'draft the reply' }, { role: 'jarvis', text: 'Done, sir.' }])
  assert.match(block, /not instructions/)
  assert.match(block, /Him: draft the reply\nYou: Done, sir\./)
  assert.equal(m.carriedPrompt([]), '')
  assert.equal(m.carriedPrompt(undefined), '')
})

test('a reload before the fresh conversation answers keeps the carried exchanges', () => {
  conversation('33333333-3333-3333-3333-333333333333', 8)
  const first = m.sessionOptions()
  assert.ok(first.carried.length > 0)
  // The page reconnects before anything has been asked.
  const again = m.sessionOptions()
  assert.equal(again.resumed, false)
  assert.deepEqual(again.carried, first.carried)
  // The first answer saves the new conversation, and the carry-over is done.
  m.saveSession('44444444-4444-4444-4444-444444444444')
  writeFileSync(join(project, '44444444-4444-4444-4444-444444444444.jsonl'), '')
  const after = m.sessionOptions()
  assert.equal(after.resumed, true)
  assert.equal(after.carried, undefined)
})
