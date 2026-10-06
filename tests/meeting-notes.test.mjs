import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.JARVIS_HOME = mkdtempSync(join(tmpdir(), 'jarvis-notes-'))
process.env.JARVIS_PA_ENDPOINTS = join(process.env.JARVIS_HOME, 'none.json')
const { normaliseNotes } = await import('../bridge/protective.mjs')
const { decideTool, readOnlyTool } = await import('../bridge/policy.mjs')
const { checkFlows, judgeNotes } = await import('../bridge/flowcheck.mjs')

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
  assert.equal(row.detail, 'set up (not called: it needs a meeting; try --notes)')
  assert.equal(called, false)
})

test("Copilot's notes, a WebVTT transcript and a stringified sender come out as plain text", () => {
  const r = normaliseNotes({
    source: 'copilot',
    notes: JSON.stringify([{ title: 'Intake', text: 'Reviewed the epics', subpoints: [{ title: 'Ranking', text: 'Thomas confirms' }] }]),
    actionItems: [{ title: 'Send the list', text: 'Send the ranked list', ownerDisplayName: 'Scott' }],
    transcript:
      'WEBVTT\n\n0f1e-22/14-0\n00:00:01.000 --> 00:00:02.000\n<v Scott>Morning all</v>\n\n' +
      '0f1e-22/15-0\n00:00:02.000 --> 00:00:03.000\n<v Scott>let us start</v>\n\n00:00:03.000 --> 00:00:04.000\n<v Thomas>Ready</v>',
    email: { subject: 'Recap', from: JSON.stringify({ emailAddress: { name: 'Scott P', address: 'scott@example.com' } }), body: 'x' },
  })
  assert.equal(r.notes, 'Intake: Reviewed the epics\n  - Ranking: Thomas confirms')
  assert.deepEqual(r.actionItems, ['Send the ranked list (Scott)'])
  assert.equal(r.transcript, 'Scott: Morning all let us start\nThomas: Ready')
  assert.equal(r.email.from, 'Scott P <scott@example.com>')
  // Plain strings pass through as they are.
  assert.equal(normaliseNotes({ notes: 'just text' }).notes, 'just text')
})

test("Graph's expected refusals are not errors; an expired connection is named", () => {
  const blocked = normaliseNotes({ source: 'none', errors: ['Get_online_meeting: 403 Insufficient permissions', 'Get_transcript_content: 404 Not found'] })
  assert.match(blocked.copilot, /^not granted/)
  assert.deepEqual(blocked.errors, [])
  const expired = normaliseNotes({ source: 'none', errors: ['Find_meeting: 401 Invalid token lifetime.'] })
  assert.match(expired.copilot, /^reconnect/)
  assert.equal(normaliseNotes({ source: 'copilot', notes: 'n' }).copilot, 'available')
  assert.deepEqual(normaliseNotes({ errors: ['Find_meeting: 500 Server error'] }).errors, ['Find_meeting: 500 Server error'])
})

test('the doctor judges one meeting-notes answer by counts, and names the fix', () => {
  const blocked = judgeNotes(normaliseNotes({ source: 'email', email: { subject: 's', body: 'b' }, errors: ['Get_online_meeting: 403 Insufficient permissions'] }))
  assert.equal(blocked.status, 'ok')
  assert.equal(blocked.detail, 'source: email; a recap email')
  assert.match(blocked.fix, /OnlineMeetings\.Read/)
  const expired = judgeNotes(normaliseNotes({ source: 'none', errors: ['Find_meeting: 401 Invalid token lifetime.'] }))
  assert.equal(expired.status, 'fail')
  assert.match(expired.fix, /Reconnect/)
  const odd = judgeNotes(normaliseNotes({ source: 'none', errors: ['Find_meeting: 500 see https://graph.microsoft.com/x?sig=SECRET'] }))
  assert.equal(odd.status, 'warn')
  assert.doesNotMatch(odd.fix, /SECRET/)
})
