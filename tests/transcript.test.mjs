import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// A private ~/.jarvis for the history.
const home = mkdtempSync(join(tmpdir(), 'jarvis-history-'))
process.env.JARVIS_HOME = home
delete process.env.JARVIS_HISTORY
delete process.env.JARVIS_HISTORY_DAYS

const t = await import('../bridge/transcript.mjs')
const { localDay } = await import('../bridge/days.mjs')

const dir = join(home, 'transcripts')
const dayAgo = (n) => localDay(new Date(Date.now() - n * 86_400_000))

test('a day older than the keep window is dropped; a recent one stays', () => {
  // Written before the first append of the run, which is when pruning happens.
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${dayAgo(45)}.jsonl`), `${JSON.stringify({ at: 1, role: 'user', text: 'old' })}\n`)
  writeFileSync(join(dir, `${dayAgo(3)}.jsonl`), `${JSON.stringify({ at: 2, role: 'user', text: 'Datadog renewal?' })}\n`)
  t.appendTurn({ role: 'user', text: 'What is on today?' })
  assert.equal(existsSync(join(dir, `${dayAgo(45)}.jsonl`)), false)
  assert.equal(existsSync(join(dir, `${dayAgo(3)}.jsonl`)), true)
})

test('turns come back in order, trimmed, with the alert kind kept', () => {
  t.appendTurn({ role: 'jarvis', text: '  Three meetings, sir.  ' })
  t.appendTurn({ role: 'alert', kind: 'mail', text: 'Chris — the APD scope' })
  t.appendTurn({ role: 'user', text: '   ' })
  const turns = t.readTranscript()
  assert.deepEqual(
    turns.map((x) => [x.role, x.text, x.kind]),
    [
      ['user', 'What is on today?', undefined],
      ['jarvis', 'Three meetings, sir.', undefined],
      ['alert', 'Chris — the APD scope', 'mail'],
    ],
  )
})

test('a very long answer is kept, cut to a sane length', () => {
  t.appendTurn({ role: 'jarvis', text: 'x'.repeat(20_000) })
  const last = t.readTranscript().at(-1)
  assert.equal(last.text.length, 8000)
})

test('a line cut short by a crash is skipped, not fatal', () => {
  appendFileSync(join(dir, `${localDay()}.jsonl`), '{"at": 5, "role": "user", "te\n')
  t.appendTurn({ role: 'user', text: 'Still here?' })
  const turns = t.readTranscript()
  assert.equal(turns.at(-1).text, 'Still here?')
  assert.ok(turns.every((x) => typeof x.text === 'string'))
})

test('days are listed newest first, and a bad day name reads as nothing', () => {
  assert.deepEqual(t.transcriptDays(), [localDay(), dayAgo(3)])
  assert.deepEqual(t.readTranscript('../../etc/passwd'), [])
  assert.deepEqual(t.readTranscript('2020-01-01'), [])
})

test('search finds a word across every kept day, newest first, tagged with its day', () => {
  t.appendTurn({ role: 'jarvis', text: 'The Datadog renewal is due Friday.' })
  const hits = t.searchTranscripts('datadog')
  assert.deepEqual(
    hits.map((h) => [h.day, h.text]),
    [
      [localDay(), 'The Datadog renewal is due Friday.'],
      [dayAgo(3), 'Datadog renewal?'],
    ],
  )
  assert.deepEqual(t.searchTranscripts('d'), [])
  assert.equal(t.searchTranscripts('datadog', 1).length, 1)
})

test('JARVIS_HISTORY=off keeps nothing', async () => {
  process.env.JARVIS_HISTORY = 'off'
  // A fresh copy of the module, which reads the setting when it loads.
  const off = await import('../bridge/transcript.mjs?off')
  delete process.env.JARVIS_HISTORY
  const before = readFileSync(join(dir, `${localDay()}.jsonl`), 'utf8')
  off.appendTurn({ role: 'user', text: 'Not to be kept' })
  assert.equal(readFileSync(join(dir, `${localDay()}.jsonl`), 'utf8'), before)
  assert.equal(off.historyEnabled(), false)
})
