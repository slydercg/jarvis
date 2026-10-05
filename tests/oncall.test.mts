import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hushReason } from '../src/lib/oncall.ts'

const ev = (title: string, start: number, end: number, people = 3, focus = false) =>
  ({ id: title, title, start, end, where: '', account: 'Protective' as const, people, clash: false, focus })

test('a call app, or a meeting with people under way, keeps him quiet', () => {
  assert.equal(hushReason({ enabled: true, deviceCall: 'Zoom', events: [], now: 0 }), 'On a call (Zoom)')
  assert.equal(hushReason({ enabled: true, deviceCall: null, events: [ev('Standup', 0, 100)], now: 50 }), 'In Standup')
})

test('focus blocks, meetings alone, meetings not yet started, or the setting off do not', () => {
  const events = [ev('Focus time', 0, 100, 0, true), ev('Hold', 0, 100, 0), ev('Later', 200, 300)]
  assert.equal(hushReason({ enabled: true, deviceCall: null, events, now: 50 }), null)
  assert.equal(hushReason({ enabled: false, deviceCall: 'Zoom', events: [ev('Standup', 0, 100)], now: 50 }), null)
})
