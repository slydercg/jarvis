import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CALL_OFF, CALL_ON, hushReason } from '../src/lib/oncall.ts'

const ev = (title: string, start: number, end: number, people = 3, focus = false) =>
  ({ id: title, title, start, end, where: '', account: 'Protective' as const, people, clash: false, focus })

test('a call app, or a meeting with people under way, keeps him quiet', () => {
  assert.equal(hushReason({ enabled: true, deviceCall: 'Zoom', events: [], now: 0 }), 'On a call (Zoom)')
  assert.equal(hushReason({ enabled: true, deviceCall: null, events: [ev('Standup', 0, 100)], now: 50 }), 'In Standup')
})

test('focus blocks, meetings alone, meetings not yet started, or the setting off do not', () => {
  const events = [ev('Focus time', 0, 100, 0, true), ev('Later', 200, 300)]
  assert.equal(hushReason({ enabled: true, deviceCall: null, events, now: 50 }), null)
  assert.equal(hushReason({ enabled: false, deviceCall: 'Zoom', events: [ev('Standup', 0, 100)], now: 50 }), null)
})

test('a meeting counts even when the calendar sent no attendees', () => {
  assert.equal(hushReason({ enabled: true, deviceCall: null, events: [ev('Weekly SSA', 0, 100, 0)], now: 50 }), 'In Weekly SSA')
})

test('what he says beats the guess, either way, until it runs out', () => {
  const meeting = [ev('Weekly SSA', 0, 100)]
  assert.equal(hushReason({ enabled: true, deviceCall: null, events: [], now: 50, override: { on: true, until: 60 } }), 'On a call (you said so)')
  assert.equal(hushReason({ enabled: false, deviceCall: null, events: [], now: 50, override: { on: true, until: 60 } }), 'On a call (you said so)')
  assert.equal(hushReason({ enabled: true, deviceCall: 'Teams', events: meeting, now: 50, override: { on: false, until: 60 } }), null)
  assert.equal(hushReason({ enabled: true, deviceCall: null, events: meeting, now: 70, override: { on: false, until: 60 } }), 'In Weekly SSA')
})

test('the phrases that say so', () => {
  for (const s of ["I'm on a call", 'on a call', 'I am in a meeting.']) assert.ok(CALL_ON.test(s), s)
  for (const s of ["call's over", "I'm off the call", 'the meeting is over', 'call ended']) assert.ok(CALL_OFF.test(s), s)
  for (const s of ['what is on a call today', 'schedule a call']) assert.ok(!CALL_ON.test(s) && !CALL_OFF.test(s), s)
})

test('what came in during the call is said once, in one line', async () => {
  const { callDigest } = await import('../src/lib/oncall.ts')
  const a = (kind: string, title: string, received: number, at = received) => ({ kind, title, received, at })
  const alerts = [
    a('mail', 'Chris Martin', 10),
    a('mail', 'Anne Van', 20),
    a('portfolio', 'RPT-3806 is blocked', 30),
    a('meeting', 'Old standup', 15, 40),
    a('meeting', 'QBR', 25, 50 + 5 * 60_000),
    a('mail', 'Before the call', 1),
  ]
  assert.equal(
    callDigest(alerts, 5, 50),
    'While you were on the call: 2 emails, from Chris Martin and Anne Van; QBR starts in 5 minutes; RPT-3806 is blocked.',
  )
  assert.equal(callDigest([a('mail', 'Before', 1)], 5, 50), null)
})
