import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.JARVIS_HOME = mkdtempSync(join(tmpdir(), 'jarvis-join-'))
const { joinUrl } = await import('../bridge/tickets.mjs')
const { normaliseEvent } = await import('../bridge/protective.mjs')

const TEAMS = 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=%7b%22Tid%22%7d'

test('a meeting join link is taken from wherever the calendar put it', () => {
  assert.equal(joinUrl('', `Join the meeting now: ${TEAMS}.`), TEAMS)
  assert.equal(joinUrl('https://us02web.zoom.us/j/8123456789?pwd=abc'), 'https://us02web.zoom.us/j/8123456789?pwd=abc')
  assert.equal(joinUrl('Room 4', 'https://meet.google.com/abc-defg-hij'), 'https://meet.google.com/abc-defg-hij')
  const e = normaliseEvent({ subject: 'QBR', start: '2026-10-05T14:00:00', end: '2026-10-05T15:00:00', onlineMeeting: { joinUrl: TEAMS } })
  assert.equal(e.join, TEAMS)
})

test('nothing else becomes a join link', () => {
  for (const bad of [
    'https://evil.com/teams.microsoft.com/l/meetup-join/x',
    'http://teams.microsoft.com/l/meetup-join/x',
    'https://teams.microsoft.com.evil.com/l/meetup-join/x',
    'https://zoom.us/signin',
    'https://meet.google.com/landing',
  ]) assert.equal(joinUrl(bad), '', bad)
})
