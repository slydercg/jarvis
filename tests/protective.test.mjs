import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// A private home and a flows file with made-up URLs. fetch is replaced below,
// so nothing here ever reaches Power Automate.
const dir = mkdtempSync(join(tmpdir(), 'jarvis-pa-'))
process.env.JARVIS_HOME = dir
const FAKE = (id) => `https://example.environment.api.powerplatform.com/workflows/${id}/triggers/manual/paths/invoke?sig=test`
const flowsFile = join(dir, 'pa_endpoints.json')
writeFileSync(
  flowsFile,
  JSON.stringify({
    inbox: FAKE('inbox'),
    calendar: FAKE('calendar'),
    todo: FAKE('todo'),
    send_email: 'https://evil.example.com/steal',
    jira: { email: 'x', apiToken: 'must-be-ignored' },
  }),
)
process.env.JARVIS_PA_ENDPOINTS = flowsFile

const pa = await import('../bridge/protective.mjs')

test('only Power Automate URLs are accepted, and only known flows are kept', () => {
  const { flows } = pa.loadFlows()
  assert.deepEqual(Object.keys(flows).sort(), ['calendar', 'inbox', 'todo'])
  assert.equal(pa.validFlowUrl('https://evil.example.com/x'), false)
  assert.equal(pa.validFlowUrl('http://x.powerplatform.com/x'), false)
  assert.equal(pa.validFlowUrl(FAKE('a')), true)
})

test('calendar times are read as UTC wall clock, not local', () => {
  const d = pa.utcWallClock('2026-09-24T14:30:00.0000000')
  assert.equal(d.toISOString(), '2026-09-24T14:30:00.000Z')
  // An explicit offset is respected.
  assert.equal(pa.utcWallClock('2026-09-24T09:30:00-05:00').toISOString(), '2026-09-24T14:30:00.000Z')
})

test('To Do groups flatten and completed tasks drop out', () => {
  const rows = pa.flattenTodo([
    { list: 'Flagged Emails', tasks: [{ title: 'A', status: 'notStarted' }, { title: 'B', status: 'completed' }] },
    { list: 'Tasks', tasks: [{ title: 'C', status: 'inProgress', importance: 'high' }] },
  ])
  assert.deepEqual(rows.map((r) => `${r.list}:${r.title}`), ['Flagged Emails:A', 'Tasks:C'])
})

test('reading the inbox and calendar through the flows', async () => {
  const today = pa.dayOf('today')
  const noonUtc = new Date(`${today}T12:00:00`).toISOString().replace('Z', '0000') // local noon, as UTC wall clock
  const responses = {
    inbox: { value: [{ id: '1', from: 'ceo@protective.com', subject: 'Budget', bodyPreview: 'Need your sign-off', importance: 'high', isRead: false, receivedDateTime: '2026-09-24T12:00:00Z' }] },
    calendar: { value: [
      { subject: 'Design review', start: noonUtc, end: noonUtc, requiredAttendees: 'a@x.com;b@x.com', body: 'x'.repeat(1000) },
      { subject: 'Cancelled thing', start: noonUtc, end: noonUtc, isCancelled: true },
      { subject: 'Next year', start: '2027-01-01T12:00:00', end: '2027-01-01T13:00:00' },
    ] },
  }
  const real = globalThis.fetch
  globalThis.fetch = async (url) => {
    const key = String(url).match(/workflows\/(\w+)\//)[1]
    return new Response(JSON.stringify(responses[key]), { status: 200 })
  }
  try {
    const mail = await pa.protective.inbox()
    assert.equal(mail[0].from, 'ceo@protective.com')
    assert.equal(mail[0].unread, true)
    const events = await pa.protective.calendar('today')
    assert.deepEqual(events.map((e) => e.title), ['Design review'])
    assert.deepEqual(events[0].attendees, ['a@x.com', 'b@x.com'])
    assert.equal('body' in events[0], false)
  } finally {
    globalThis.fetch = real
  }
})

test('a failing flow never reveals its URL', async () => {
  const real = globalThis.fetch
  globalThis.fetch = async () => new Response('nope', { status: 401 })
  try {
    await assert.rejects(pa.protective.inbox(), (err) => !/sig=|powerplatform/.test(err.message) && /401/.test(err.message))
  } finally {
    globalThis.fetch = real
  }
})

test('a flow that is not set up says where to add it', async () => {
  await assert.rejects(pa.protective.sent(), /add "sent_email" to ~\/\.jarvis\/power-automate\.json/)
  assert.equal(pa.hasFlow('sent_email'), false)
  assert.deepEqual(
    pa.normaliseSent({ toRecipients: [{ emailAddress: { address: 'chris@example.com' } }], subject: 'Roadmap', bodyPreview: 'By Friday' }),
    { id: '', to: ['chris@example.com'], subject: 'Roadmap', preview: 'By Friday', sent: '' },
  )
})
