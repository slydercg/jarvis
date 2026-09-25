import { test } from 'node:test'
import assert from 'node:assert/strict'
import { age, change, money } from '../src/lib/holdings.ts'

test('money, and a dash for what was not returned or not checked', () => {
  assert.equal(money(52310.44), '$52,310.44')
  assert.equal(money(null), '—')
  assert.equal(money(Number.NaN), '—')
})

test('the day as a direction and an amount, never a colour', () => {
  assert.equal(change(310.1, 0.6), '▲ $310.10 (+0.60%)')
  assert.equal(change(-150.25, -0.82), '▼ $150.25 (−0.82%)')
  assert.equal(change(-150.25), '▼ $150.25')
  assert.equal(change(0.001, 0), 'flat')
  assert.equal(change(null), '—')
})

test('how old the figures are', () => {
  const now = Date.parse('2026-09-25T15:00:00Z')
  assert.equal(age(now - 20_000, now), 'just now')
  assert.equal(age(now - 12 * 60_000, now), '12 min ago')
  assert.equal(age(now - 3 * 3_600_000, now), '3 h ago')
  assert.equal(age(undefined, now), '')
})
