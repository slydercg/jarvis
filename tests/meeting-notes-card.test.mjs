import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// A private home and a made-up meeting-notes flow; fetch is replaced below,
// so nothing reaches Power Automate.
const dir = mkdtempSync(join(tmpdir(), 'jarvis-notes-card-'))
process.env.JARVIS_HOME = dir
const flowsFile = join(dir, 'pa_endpoints.json')
writeFileSync(
  flowsFile,
  JSON.stringify({ meeting_notes: 'https://example.environment.api.powerplatform.com/workflows/notes/triggers/manual/paths/invoke?sig=test' }),
)
process.env.JARVIS_PA_ENDPOINTS = flowsFile
const { protectiveServer } = await import('../bridge/protective.mjs')

async function ask(answer) {
  const told = []
  const server = protectiveServer({ onNoNotes: (subject) => told.push(subject) })
  const { handler } = server.instance._registeredTools.protective_get_meeting_notes
  const real = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify(answer), { status: 200 })
  try {
    await handler({ subject: 'APD intake', start: '2026-10-05T15:00:00-04:00' })
  } finally {
    globalThis.fetch = real
  }
  return told
}

test('nothing found for a meeting tells the bridge, so its card can say how to get a recap', async () => {
  assert.deepEqual(await ask({ source: 'none', email: {}, errors: ['Get_online_meeting: 403 Insufficient permissions'] }), ['APD intake'])
})

test('a recap email found is not "no notes"', async () => {
  assert.deepEqual(await ask({ source: 'email', email: { subject: 'APD intake', body: 'Decisions…' } }), [])
})
