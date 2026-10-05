/**
 * The voice incidents, replayed. Each case is something that went wrong in
 * real use, written as the events the voice loop saw, and what it must do
 * with them now. A change that brings one back fails here first.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { onsetAction, utteranceIsHis, wakeAction } from '../src/lib/decide.ts'
import { withoutSounds } from '../src/lib/echo.ts'
import { CALL_OFF, CALL_ON } from '../src/lib/oncall.ts'
import { WRONG } from '../src/lib/trail.ts'

const NAME = /^(?:hey|hi|ok|okay|yo)?\s*jarvis\b[\s,.:!?-]*/i

type Event = { onset: true } | { heard: string } | { wake: string }
type Outcome = string

/** What the loop does with each event, in order: the decisions App.tsx acts on. */
function replay(phase: string, hushed: boolean, events: Event[]): Outcome[] {
  return events.map((e) => {
    if ('onset' in e) return `onset:${onsetAction(phase, hushed)}`
    if ('wake' in e) return `wake:${wakeAction(e.wake, hushed)}`
    const words = withoutSounds(e.heard)
    if (!words) return 'dropped:only-a-sound'
    if (!utteranceIsHis(words, hushed, NAME)) return 'dropped:not-his'
    const said = words.replace(NAME, '')
    if (CALL_ON.test(said)) return 'call:on'
    if (CALL_OFF.test(said)) return 'call:off'
    if (WRONG.test(said)) return 'report'
    return `ask:${said}`
  })
}

test('typing while "Prep me" is being worked out no longer cuts it off', () => {
  // He clicked Prep me, then typed: the VAD fired, Scribe wrote "[typing]".
  assert.deepEqual(replay('thinking', false, [{ onset: true }, { heard: '[typing]' }]), [
    'onset:wait-for-words',
    'dropped:only-a-sound',
  ])
  // A tool running is the same.
  assert.deepEqual(replay('tooling', false, [{ onset: true }, { heard: '(keyboard clicking)' }]), [
    'onset:wait-for-words',
    'dropped:only-a-sound',
  ])
})

test('on a call, the call is never taken for questions', () => {
  // Something like his name, then the people on the call, sentence by sentence.
  assert.deepEqual(
    replay('listening', true, [
      { wake: '' },
      { heard: "Jumping in. So what we've got today is basically the overall overarching view of things" },
      { heard: "You know, whether it's Jim and I taking a call or Paul and I taking a call" },
      { onset: true },
    ]),
    ['wake:stand-down', 'dropped:not-his', 'dropped:not-his', 'onset:ignore-call'],
  )
})

test('on a call, a "yes" from the call cannot confirm an action for him', () => {
  assert.deepEqual(replay('listening', true, [{ heard: 'Yes.' }, { heard: 'Jarvis, yes' }]), ['dropped:not-his', 'ask:yes'])
})

test('on a call, he is still heard when he says his name in the same breath', () => {
  assert.deepEqual(
    replay('dormant', true, [{ wake: "what's next" }, { heard: "Jarvis, call's over" }, { heard: 'Jarvis, that was wrong' }]),
    ['wake:ask', 'call:off', 'report'],
  )
})

test('off a call, talking over him still stops him, and plain questions are asked', () => {
  assert.deepEqual(replay('speaking', false, [{ onset: true }, { heard: "what's blocked across the portfolio?" }]), [
    'onset:barge-in',
    "ask:what's blocked across the portfolio?",
  ])
  assert.deepEqual(replay('dormant', false, [{ wake: '' }, { onset: true }]), ['wake:greet', 'onset:none'])
  assert.deepEqual(replay('listening', false, [{ heard: "I'm on a call" }]), ['call:on'])
})
