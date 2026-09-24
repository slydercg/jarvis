import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cardsThatFit, overlaps } from '../src/lib/alertFit.ts'

test('every card shows when there is room for all of them', () => {
  assert.equal(cardsThatFit([100, 80, 120], 112, 800, 10, 26), 3)
  assert.equal(cardsThatFit([], 112, 300, 10, 26), 0)
})

test('the newest cards stay and the rest leave room for the "+N more" line', () => {
  // 112 + 100 = 212; + 10 + 80 = 302; the third would end at 432.
  assert.equal(cardsThatFit([100, 80, 120], 112, 340, 10, 26), 2)
  // Two fit on their own (302) but not with the "+1 more" line under them (338 > 330).
  assert.equal(cardsThatFit([100, 80, 120], 112, 330, 10, 26), 1)
})

test('with no room at all, no card covers the conversation', () => {
  assert.equal(cardsThatFit([100, 80], 112, 150, 10, 26), 0)
})

test('spans overlap only when they share width', () => {
  assert.equal(overlaps([100, 200], [150, 300]), true)
  assert.equal(overlaps([100, 200], [200, 300]), false)
})
