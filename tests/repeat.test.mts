import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sameQuestion } from '../src/lib/repeat.ts'

test('the same question, however it is punctuated, is a repeat', () => {
  assert.equal(sameQuestion("What's blocked across the portfolio?", "what's blocked across the portfolio"), true)
  assert.equal(sameQuestion('  What’s blocked?  ', "What's blocked?"), true)
  assert.equal(sameQuestion('Please, what is on today?', 'What is on today'), true)
})

test('a different question is not a repeat', () => {
  assert.equal(sameQuestion("What's blocked across the portfolio?", 'Which team is behind?'), false)
  assert.equal(sameQuestion('', ''), false)
  assert.equal(sameQuestion(null, 'anything'), false)
  assert.equal(sameQuestion('?', '!'), false)
})
