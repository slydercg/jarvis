import { test } from 'node:test'
import assert from 'node:assert/strict'

const { yesOrNo } = await import('../src/lib/confirm.ts')

test('short answers are read as yes or no, spoken or typed', () => {
  for (const s of ['yes', 'Yes please', 'go ahead', 'okay, do it', 'send it']) {
    assert.equal(yesOrNo(s, true), true, s)
    assert.equal(yesOrNo(s, false), true, s)
  }
  for (const s of ['no', 'cancel that', "don't", 'wait', 'never mind']) assert.equal(yesOrNo(s, true), false, s)
})

test('a long sentence that merely starts with a yes-word is not a spoken yes', () => {
  // What a TV, a speakerphone or someone across the room sounds like.
  assert.equal(yesOrNo('okay so the thing about the quarterly numbers is', true), null)
  assert.equal(yesOrNo('sure, I mean we could look at it next week maybe', true), null)
  // Typed, the same words are a deliberate answer.
  assert.equal(yesOrNo('okay so the thing about the quarterly numbers is', false), true)
})

test('"right" is no longer a yes', () => {
  assert.equal(yesOrNo('right', true), null)
  assert.equal(yesOrNo('right, where were we', false), null)
})

test('no wins a tie', () => {
  assert.equal(yesOrNo('no, yes, no', true), false)
})
