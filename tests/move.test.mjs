import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Two made-up Macs with different home folders. Nothing here reads the real
// ~/.jarvis, ~/.claude.json or .env.local.
const root = mkdtempSync(join(tmpdir(), 'jarvis-move-'))
const oldHome = join(root, 'old', 'olduser')
const newHome = join(root, 'new', 'newuser')
process.env.HOME = newHome
process.env.JARVIS_HOME = join(newHome, '.jarvis')
delete process.env.JARVIS_PA_ENDPOINTS
mkdirSync(newHome, { recursive: true })
const { collect, describe, installCommand, moveEnvText, restore, seal, unseal } = await import('../scripts/move.mjs')

const URL = (id) => `https://prod-01.westus.logic.azure.com/workflows/${id}/triggers/manual/paths/invoke?api-version=1&sig=SECRET${id}`
const KEY = 'sk_elevenlabs_SECRETKEY'

function oldMac() {
  const repo = join(oldHome, 'Apps', 'jarvis')
  const jh = join(oldHome, '.jarvis')
  mkdirSync(join(jh, 'transcripts'), { recursive: true })
  mkdirSync(join(jh, 'logs'), { recursive: true })
  mkdirSync(join(repo, 'public'), { recursive: true })
  writeFileSync(join(repo, '.env.local'), `ELEVENLABS_API_KEY=${KEY}\nJARVIS_PORTFOLIO_FILES=${oldHome}/Desktop/dash.html\nJARVIS_NAME=Friday\n`, { mode: 0o600 })
  writeFileSync(join(jh, 'memory.md'), '- likes tea\n', { mode: 0o600 })
  writeFileSync(join(jh, 'transcripts', '2026-10-01.jsonl'), '{"q":"hi"}\n')
  writeFileSync(join(jh, 'session.json'), '{"id":"abc"}')
  writeFileSync(join(jh, 'logs', 'jarvis.log'), 'noise')
  writeFileSync(join(jh, 'flows-keys.json'), JSON.stringify({ [`${oldHome}/OneDrive/pa_endpoints.json`]: ['inbox', 'todo'] }))
  const flows = join(oldHome, 'OneDrive', 'pa_endpoints.json')
  mkdirSync(join(oldHome, 'OneDrive'), { recursive: true })
  writeFileSync(flows, JSON.stringify({ inbox: URL('i'), todo: URL('t') }))
  writeFileSync(join(repo, 'public', 'my-name.onnx'), 'model')
  writeFileSync(
    join(oldHome, '.claude.json'),
    JSON.stringify({
      mcpServers: { elevenlabs: { command: 'uvx', env: { ELEVENLABS_API_KEY: KEY } }, sonos: { command: `${oldHome}/bin/sonos-mcp` } },
      projects: { [oldHome]: { mcpServers: { local: { command: 'node', args: [`${oldHome}/tools/local.mjs`] } } } },
    }),
  )
  return collect({
    repo,
    home: oldHome,
    jarvisHome: jh,
    flowsPath: flows,
    publicFiles: ['public/my-name.onnx'],
    autostart: { open: true, browser: null, writes: true, update: true },
  })
}

test('the move file opens only with its passphrase, and says which way it failed', () => {
  const payload = { version: 1, made: 'x', from: {}, files: [{ kind: 'jarvis', path: 'memory.md', data: 'aGk=' }] }
  const buf = seal(payload, 'correct horse battery', 10)
  assert.deepEqual(unseal(buf, 'correct horse battery'), payload)
  assert.throws(() => unseal(buf, 'wrong horse battery!'), /wrong passphrase/)
  const tampered = Buffer.from(buf)
  tampered[tampered.length - 1] ^= 1
  assert.throws(() => unseal(tampered, 'correct horse battery'), /wrong passphrase, or the file is damaged/)
  assert.throws(() => unseal(Buffer.from('{"version":1}'), 'x'), /not a Jarvis move file/)
  assert.doesNotMatch(buf.toString('latin1'), /memory\.md/, 'nothing readable outside the cipher')
})

test('what moves: his state, keys, flows, MCP servers and wake word; not logs or the old session', () => {
  const p = oldMac()
  const paths = p.files.map((f) => `${f.kind}:${f.kind === 'flows' ? 'flows' : f.path}`).sort()
  assert.deepEqual(paths, [
    'claude-mcp:.claude.json',
    'env:.env.local',
    'flows:flows',
    'jarvis:flows-keys.json',
    'jarvis:memory.md',
    'jarvis:transcripts/2026-10-01.jsonl',
    'public:public/my-name.onnx',
  ])
  const words = describe(p).join('\n')
  assert.match(words, /the flows file \(2 keys\)/)
  assert.match(words, /3 MCP servers from ~\/\.claude\.json \(elevenlabs, sonos, local\)/)
  assert.match(words, /--writes/)
  assert.doesNotMatch(words, /SECRET/)
})

test('import on a Mac with another user name puts it all back, moving paths and asking about the rest', () => {
  const p = oldMac()
  const repo = join(newHome, 'Apps', 'jarvis')
  const jh = join(newHome, '.jarvis')
  mkdirSync(join(repo, 'public'), { recursive: true })
  // A first run here already made a settings file.
  mkdirSync(jh, { recursive: true })
  writeFileSync(join(jh, 'settings.json'), '{}')

  const first = restore(p, { repo, home: newHome, jarvisHome: jh, now: new Date('2026-11-02T10:00:00Z') })
  const text = JSON.stringify(first)
  assert.doesNotMatch(text, /SECRET/, 'no value is ever reported')
  assert.equal(readFileSync(join(jh, 'memory.md'), 'utf8'), '- likes tea\n')
  assert.equal(statSync(join(jh, 'memory.md')).mode & 0o777, 0o600)
  assert.ok(existsSync(join(jh, 'transcripts', '2026-10-01.jsonl')))
  assert.ok(!existsSync(join(jh, 'session.json')) && !existsSync(join(jh, 'logs')))
  assert.ok(existsSync(join(`${jh}.before-import-20261102-100000`, 'settings.json')), 'what was here is kept')
  assert.match(readFileSync(join(jh, 'flows-keys.json'), 'utf8'), new RegExp(`${newHome}/OneDrive`))

  const env = readFileSync(join(repo, '.env.local'), 'utf8')
  assert.match(env, new RegExp(`JARVIS_PORTFOLIO_FILES=${newHome}/Desktop/dash.html`))
  assert.match(env, /ELEVENLABS_API_KEY=sk_elevenlabs_SECRETKEY/)
  assert.equal(statSync(join(repo, '.env.local')).mode & 0o777, 0o600)
  assert.match(text, /Paths moved .*JARVIS_PORTFOLIO_FILES/)
  assert.ok(existsSync(join(repo, 'public', 'my-name.onnx')))

  // OneDrive hasn't synced and Claude Code hasn't been run: both are named, nothing guessed.
  assert.match(text, /flows file isn't on this Mac yet.*--flows-here/)
  assert.match(text, /3 MCP server\(s\) \(elevenlabs, sonos, local\) wait for Claude Code/)

  // After OneDrive syncs one key short, and `claude` has been run once.
  mkdirSync(join(newHome, 'OneDrive'), { recursive: true })
  writeFileSync(join(newHome, 'OneDrive', 'pa_endpoints.json'), JSON.stringify({ inbox: URL('i') }))
  writeFileSync(join(newHome, '.claude.json'), JSON.stringify({ mcpServers: { sonos: { command: 'mine' } }, other: 1 }), { mode: 0o600 })
  writeFileSync(join(repo, '.env.local'), 'JARVIS_NAME=Edited\n', { mode: 0o600 })
  const again = JSON.stringify(restore(p, { repo, home: newHome, jarvisHome: jh }))
  assert.match(again, /lacks keys the old Mac's had: todo/)
  assert.match(again, /left alone.*--replace-env/)
  assert.equal(readFileSync(join(repo, '.env.local'), 'utf8'), 'JARVIS_NAME=Edited\n', 'never written over unasked')
  assert.match(readFileSync(join(repo, '.env.from-old-mac.local'), 'utf8'), /ELEVENLABS/)
  const cfg = JSON.parse(readFileSync(join(newHome, '.claude.json'), 'utf8'))
  assert.equal(cfg.other, 1)
  assert.deepEqual(cfg.mcpServers.sonos, { command: 'mine' }, "this Mac's own server wins")
  assert.equal(cfg.mcpServers.elevenlabs.command, 'uvx')
  assert.deepEqual(cfg.projects[newHome].mcpServers.local.args, [`${newHome}/tools/local.mjs`])
  assert.ok(existsSync(join(newHome, '.claude.json.before-jarvis-import')))
  assert.match(again, /added to ~\/\.claude\.json: elevenlabs, local/)
  assert.match(again, /already here.*sonos/)
  assert.doesNotMatch(again, /SECRET/)

  // Asked to, it keeps the old Mac's flows copy in ~/.jarvis, private.
  restore(p, { repo, home: newHome, jarvisHome: jh, flowsHere: true, replaceEnv: true })
  assert.equal(statSync(join(jh, 'power-automate.json')).mode & 0o777, 0o600)
  assert.match(readFileSync(join(repo, '.env.local'), 'utf8'), /ELEVENLABS/)
  assert.equal(readFileSync(join(repo, '.env.before-import.local'), 'utf8'), 'JARVIS_NAME=Edited\n')
})

test('a dry run writes nothing, and a path out of the folder is refused', () => {
  const p = oldMac()
  const home = join(root, 'dry')
  mkdirSync(home)
  restore(p, { repo: join(home, 'repo'), home, jarvisHome: join(home, '.jarvis'), dryRun: true })
  assert.ok(!existsSync(join(home, '.jarvis')) && !existsSync(join(home, 'repo')))
  const evil = { ...p, files: [{ kind: 'jarvis', path: '../../escape.txt', mode: 0o600, data: 'eA==' }] }
  assert.throws(() => restore(evil, { repo: home, home, jarvisHome: join(home, '.jarvis') }), /unsafe path/)
})

test("the old Mac's home folder is swapped only where it is a path", () => {
  const r = moveEnvText('A=/Users/old/x\nB="/Users/old"\nC=/Users/older/y\nD=plain\n', '/Users/old', '/Users/new')
  assert.equal(r.text, 'A=/Users/new/x\nB="/Users/new"\nC=/Users/older/y\nD=plain\n')
  assert.deepEqual(r.changed, ['A', 'B'])
  assert.equal(installCommand({ writes: true, open: false, browser: 'Microsoft Edge', update: true }), 'npm run autostart:install -- --writes --no-open --browser "Microsoft Edge"')
  assert.equal(installCommand(null), 'npm run autostart:install')
})

test('export refuses to save inside the repository, before reading anything', () => {
  assert.throws(
    () =>
      execFileSync(process.execPath, ['scripts/move.mjs', 'export', '--out', 'here.jarvismove'], {
        encoding: 'utf8',
        stdio: 'pipe',
        env: { ...process.env, JARVIS_MOVE_PASSPHRASE: 'long enough passphrase' },
      }),
    (err) => /public repository/.test(err.stderr),
  )
  assert.ok(!existsSync('here.jarvismove'))
})
