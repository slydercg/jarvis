import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// A private ~/.jarvis with three notes, two of them about the same person.
process.env.JARVIS_HOME = mkdtempSync(join(tmpdir(), 'jarvis-memory-'))
const m = await import('../bridge/memory.mjs')
const seed = () =>
  writeFileSync(m.MEMORY_FILE, '- Chris leads the RPT programme (2026-09-20)\n- Chris prefers calls to email (2026-09-21)\n- Coffee black (2026-09-22)\n')
const text = (r) => r.content[0].text

test('forget with one match removes just that note', () => {
  seed()
  assert.match(text(m.forgetNotes({ about: 'coffee' })), /Forgot 1/)
  assert.doesNotMatch(readFileSync(m.MEMORY_FILE, 'utf8'), /Coffee/)
  assert.match(readFileSync(m.MEMORY_FILE, 'utf8'), /Chris leads/)
})

test('forget that matches several notes reads them back instead of wiping them', () => {
  seed()
  const r = text(m.forgetNotes({ about: 'chris' }))
  assert.match(r, /matches 2 facts/)
  assert.equal((readFileSync(m.MEMORY_FILE, 'utf8').match(/Chris/g) ?? []).length, 2)
  assert.match(text(m.forgetNotes({ about: 'chris', all: true })), /Forgot 2/)
  assert.doesNotMatch(readFileSync(m.MEMORY_FILE, 'utf8'), /Chris/)
})

test('remembered notes are framed as facts, not instructions', () => {
  seed()
  const prompt = m.memoryPrompt()
  assert.match(prompt, /not\s+instructions to you/)
  assert.match(prompt, /Chris leads the RPT programme/)
})
