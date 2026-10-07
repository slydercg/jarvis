import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.JARVIS_HOME = mkdtempSync(join(tmpdir(), 'jarvis-flowsfile-'))
const { judgeFlowsFile, keysOnlyInBackups, lastKeys, parseFlowsText, rememberKeys, withKey } = await import('../bridge/flowsfile.mjs')

const URL = (id) => `https://prod-01.westus.logic.azure.com/workflows/${id}/triggers/manual/paths/invoke?api-version=1&sig=SECRET${id}`

test('setting one key leaves the rest of the file as it was', () => {
  const text = '{\n    "inbox": "a",\n    "jira": { "email": "x" },\n    "todo": "b"\n}\n'
  const out = withKey(text, 'sent_email', 'c')
  assert.equal(out, '{\n    "inbox": "a",\n    "jira": {\n        "email": "x"\n    },\n    "todo": "b",\n    "sent_email": "c"\n}\n')
  // Replaced in place, not moved to the end.
  assert.match(withKey(text, 'inbox', 'z'), /^\{\n {4}"inbox": "z"/)
  // A byte-order mark stays, and is no reason to fail.
  assert.ok(withKey('﻿{"a":1}', 'b', 2).startsWith('﻿'))
  assert.throws(() => withKey('{"a":', 'b', 1), /not valid JSON/)
  assert.throws(() => withKey('{}', 'bad key!', 1), /not a key name/)
})

test('a key gone since the last check is named, by name only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-flows-'))
  const path = join(dir, 'pa_endpoints.json')
  writeFileSync(path, JSON.stringify({ inbox: URL('i'), todo: URL('t') }))
  rememberKeys(path, ['inbox', 'jira', 'todo'])
  const r = judgeFlowsFile(path, lastKeys(path))
  assert.equal(r.status, 'warn')
  assert.deepEqual(r.missing, ['jira'])
  assert.doesNotMatch(JSON.stringify(r), /SECRET/)
  // Nothing remembered for another file.
  assert.equal(lastKeys(join(dir, 'other.json')), null)
  writeFileSync(path, '{ "inbox": ')
  assert.equal(judgeFlowsFile(path, null).status, 'fail')
})

test('keys only the backups still have are found, without reading their values out', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-flows-'))
  const path = join(dir, 'pa_endpoints.json')
  writeFileSync(path, JSON.stringify({ inbox: URL('i') }))
  writeFileSync(join(dir, 'pa_endpoints.before-notes.json'), JSON.stringify({ inbox: URL('i'), agent_mail: URL('a') }))
  writeFileSync(join(dir, 'pa_endpoints.before-sent.json'), JSON.stringify({ agent_mail: URL('a'), jira: {} }))
  writeFileSync(join(dir, 'unrelated.json'), JSON.stringify({ other: 1 }))
  assert.deepEqual(keysOnlyInBackups(path), [
    { key: 'agent_mail', in: ['pa_endpoints.before-notes.json', 'pa_endpoints.before-sent.json'] },
    { key: 'jira', in: ['pa_endpoints.before-sent.json'] },
  ])
})

test('flows:add copies one key back from a backup and prints no value', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-flows-'))
  const live = join(dir, 'pa_endpoints.json')
  const backup = join(dir, 'pa_endpoints.before-notes.json')
  writeFileSync(live, '{\n  "inbox": "' + URL('i') + '"\n}\n', { mode: 0o600 })
  writeFileSync(backup, JSON.stringify({ inbox: URL('old'), agent_mail: URL('a') }))
  const out = execFileSync(process.execPath, ['scripts/flows-add.mjs', 'agent_mail', '--from', backup, '--file', live], {
    encoding: 'utf8',
    env: { ...process.env },
  })
  assert.match(out, /Added "agent_mail"/)
  assert.doesNotMatch(out, /SECRET|logic\.azure/)
  const data = parseFlowsText(readFileSync(live, 'utf8')).data
  assert.deepEqual(Object.keys(data), ['inbox', 'agent_mail'])
  assert.equal(data.inbox, URL('i'), 'the other keys are untouched')
  assert.equal(data.agent_mail, URL('a'))
  assert.equal(statSync(live).mode & 0o777, 0o600)
})

test('flows:add never writes over a file it cannot read', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-flows-'))
  const live = join(dir, 'pa_endpoints.json')
  const backup = join(dir, 'b.json')
  writeFileSync(live, '{ "inbox": ')
  writeFileSync(backup, JSON.stringify({ agent_mail: URL('a') }))
  assert.throws(() =>
    execFileSync(process.execPath, ['scripts/flows-add.mjs', 'agent_mail', '--from', backup, '--file', live], { encoding: 'utf8', stdio: 'pipe' }),
  )
  assert.equal(readFileSync(live, 'utf8'), '{ "inbox": ')
})
