import { test } from 'node:test'
import assert from 'node:assert/strict'
import { briefOps, isBriefRef } from '../src/lib/brief.ts'

test('only a ref of the exact shape gets buttons', () => {
  assert.equal(isBriefRef('k3f9-2m'), true)
  assert.equal(isBriefRef('k3f9-8t'), true)
  for (const bad of ['k3f9-9m', 'k3f9-0t', 'K3F9-2m', 'k3f9-2x', 'k3f-2m', 'k3f9-2m ', '"><img>', '', null, 42]) {
    assert.equal(isBriefRef(bad), false, String(bad))
    assert.deepEqual(briefOps(String(bad)), [])
  }
})

test('mail lines can be replied to; task lines cannot', () => {
  assert.deepEqual(briefOps('k3f9-2m').map((o) => o.op), ['reply', 'done', 'snooze'])
  assert.deepEqual(briefOps('k3f9-3t').map((o) => o.op), ['done', 'snooze'])
})
