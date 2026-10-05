import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.JARVIS_HOME = mkdtempSync(join(tmpdir(), 'jarvis-notes-'))
process.env.JARVIS_PA_ENDPOINTS = join(process.env.JARVIS_HOME, 'none.json')
const { normaliseNotes } = await import('../bridge/protective.mjs')
const { decideTool, readOnlyTool } = await import('../bridge/policy.mjs')
const { checkFlows } = await import('../bridge/flowcheck.mjs')

test("the meeting-notes flow's answer is bounded and says where it came from", () => {
  const r = normaliseNotes({
    source: 'copilot',
    meeting: 'APD - Intake - Weekly Initiative/Epic Portfolio review',
    notes: 'Scott explained the review…',
    actionItems: ['Add a value-stream check to the Friday checklist', { text: 'Thomas to confirm rankings' }],
    transcript: 'x'.repeat(100_000),
  })
  assert.equal(r.source, 'copilot')
  assert.deepEqual(r.actionItems, ['Add a value-stream check to the Friday checklist', 'Thomas to confirm rankings'])
  assert.equal(r.transcript.length, 60_000)
  assert.equal(normaliseNotes({ source: 'whatever' }).source, 'none')
  assert.equal(normaliseNotes(null).source, 'none')
  assert.equal(normaliseNotes({ source: 'none', email: {} }).email, null)
})

test('reading meeting notes is allowed, in the conversation and in background jobs', () => {
  const name = 'mcp__protective__protective_get_meeting_notes'
  assert.equal(decideTool(name, { allowWrites: false, confirm: true }), 'allow')
  assert.equal(readOnlyTool(name), true)
})

test('the doctor reports the meeting-notes flow without calling it', async () => {
  let called = false
  const URL = 'https://prod-01.westus.logic.azure.com/workflows/abc/triggers/manual/paths/invoke?sig=SECRET'
  const rows = await checkFlows({
    flows: { inbox: URL, todo: URL, calendar: URL, meeting_notes: URL },
    inbox: async () => [],
    todo: async () => [],
    calendar: async () => [],
    meetingNotes: async () => ((called = true), {}),
  })
  const row = rows.find((r) => r.key === 'meeting_notes')
  assert.equal(row.detail, 'set up (not called: it needs a meeting)')
  assert.equal(called, false)
})
