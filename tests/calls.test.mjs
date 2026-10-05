import { test } from 'node:test'
import assert from 'node:assert/strict'
import { callFrom, watchCalls } from '../bridge/calls.mjs'

const line = (proc, kind, name) => `   pid 412(${proc}): [0x0000abcd00018fff] 00:12:03 ${kind} named: "${name}" `

test('a call app holding the display awake is a call', () => {
  assert.equal(callFrom(line('zoom.us', 'PreventUserIdleDisplaySleep', 'Zoom meeting')), 'Zoom')
  assert.equal(callFrom(line('MSTeams', 'PreventUserIdleDisplaySleep', 'Call in progress')), 'Teams')
  assert.equal(callFrom(line('Google Chrome Helper', 'PreventUserIdleDisplaySleep', 'WebRTC has active PeerConnections')), 'a browser call')
})

test('audio in use, or a call app merely open, is not a call', () => {
  const quiet = [
    'Assertion status system-wide:',
    '   PreventUserIdleDisplaySleep    0',
    line('coreaudiod', 'PreventUserIdleSystemSleep', 'com.apple.audio.BuiltInMicrophoneDevice.context.preventuseridlesleep'),
    line('MSTeams', 'BackgroundTask', 'Teams sync'),
    line('Google Chrome', 'PreventUserIdleDisplaySleep', 'Video Wake Lock'),
  ].join('\n')
  assert.equal(callFrom(quiet), null)
  assert.equal(callFrom(''), null)
})

test('the watcher reports changes only, and does nothing off a Mac', async () => {
  const seen = []
  let out = line('zoom.us', 'PreventUserIdleDisplaySleep', 'Zoom meeting')
  const stop = watchCalls((c) => seen.push(c), { platform: 'darwin', enabled: true, intervalMs: 5, run: async () => out })
  await new Promise((r) => setTimeout(r, 20))
  out = ''
  await new Promise((r) => setTimeout(r, 20))
  stop()
  assert.deepEqual(seen, ['Zoom', null])
  let ran = false
  watchCalls(() => {}, { platform: 'linux', enabled: true, run: async () => ((ran = true), '') })()
  assert.equal(ran, false)
})
