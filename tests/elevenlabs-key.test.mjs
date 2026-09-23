import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.JARVIS_HOME = mkdtempSync(join(tmpdir(), 'jarvis-11-'))
const { checkElevenKey } = await import('../bridge/settings.mjs')

const J = (status, body) => new Response(JSON.stringify(body), { status })
const cases = [
  ['full permissions', [J(200, { voices: [{ voice_id: 'abc1234567890', name: 'George' }] })], true],
  ['wrong key, 400 invalid_api_key', [J(400, { detail: { type: 'authentication_error', code: 'invalid_api_key', message: 'API key is invalid.' } })], false],
  ['wrong key, 401 old shape', [J(401, { detail: { status: 'invalid_api_key', message: 'Invalid API key' } })], false],
  ['no Voices permission but can speak', [J(401, { detail: { status: 'missing_permissions', message: 'missing voices_read' } }), new Response(new Uint8Array([1]), { status: 200 })], true],
  ['no Text to Speech permission', [J(401, { detail: { status: 'missing_permissions' } }), J(401, { detail: { status: 'missing_permissions' } })], false],
]
for (const [name, responses, ok] of cases) {
  test(`ElevenLabs key: ${name}`, async () => {
    const real = globalThis.fetch
    let i = 0
    globalThis.fetch = async () => responses[i++]
    try {
      assert.equal((await checkElevenKey('sk_test')).ok, ok)
    } finally {
      globalThis.fetch = real
    }
  })
}
