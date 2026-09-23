import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isEcho, norm } from '../src/lib/echo.ts'

const OVERRIDE = /\b(stop|wait|jarvis|cancel|enough|quiet|hold on|shut up|never ?mind|forget it|no)\b/i

test('numbers normalise the same whichever way they arrive', () => {
  assert.equal(norm('Yes, one thirteen, sir.'), norm('Yes, 113, Sir.'))
  assert.equal(norm("It's two thirty PM"), "it's 230 pm")
  assert.equal(norm('It is 2:30 PM'), 'it is 230 pm')
  assert.equal(norm('twenty five'), '25')
})

// [heard, what he said recently, echo?]
const cases: [string, string, boolean][] = [
  ['Yes, 113, Sir.', 'Yes, one thirteen, sir.', true],
  ['1:13 in the afternoon.', "It's one thirteen in the afternoon, sir.", true],
  ['1:23 in the afternoon.', 'One twenty-three in the afternoon, sir.', true],
  ['the temperature is 25 degrees', 'The temperature is twenty five degrees.', true],
  ['what about tomorrow', "It's one thirteen in the afternoon, sir.", false],
  ['what about the second one', 'The first one is the design review, the second one is the budget meeting.', false],
  ['move it to 3', 'Your design review is at two.', false],
  ['stop', 'Yes, one thirteen, sir.', false],
  ['Jarvis, what time is it', 'Yes, one thirteen, sir.', false],
]
for (const [heard, spoken, want] of cases) {
  test(`${want ? 'echo' : 'not echo'}: "${heard}"`, () => {
    assert.equal(isEcho(heard, spoken, OVERRIDE), want)
  })
}
