/**
 * Move Jarvis to another Mac.
 *
 *   npm run move:export [-- --out <file>]          on the old Mac
 *   npm run move:import -- <file> [--dry-run]       on the new one
 *                       [--replace-env] [--flows-here]
 *   npm run move:check                              what is still to do
 *
 * The code comes from GitHub; everything else that makes him his lives only
 * on the old Mac: .env.local (settings and keys), ~/.jarvis (memory, people,
 * promises, the review list, history, spend), the Power Automate flows file,
 * the local MCP servers Jarvis reads out of ~/.claude.json, untracked files in
 * public/ (a custom wake word) and how autostart was installed. Export puts
 * all of it in one file locked with a passphrase; import puts it back.
 *
 * What can't be copied is listed instead, with a live check where one is
 * possible: the Claude login (claude.ai connectors follow the account),
 * OneDrive, the Chrome extension's helper, macOS's microphone and Files and
 * Folders permissions, and the LaunchAgents, which must be installed for this
 * folder on this Mac.
 *
 * The file holds credentials: flow URLs carry their own signature, and
 * .env.local holds the ElevenLabs key. So: AES-256-GCM under a key scrypt
 * derives from the passphrase, written mode 600, never inside this folder
 * (the repository is public), and no value is ever printed — only names.
 */

import '../bridge/env.mjs'
import { spawnSync } from 'node:child_process'
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createConnection } from 'node:net'
import { homedir, hostname, userInfo } from 'node:os'
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { gunzipSync, gzipSync } from 'node:zlib'
import { BROWSER_HOSTS, HOST_MANIFEST } from '../bridge/chrome.mjs'
import { parseFlowsText, writeKeepingMode } from '../bridge/flowsfile.mjs'
import { JARVIS_HOME } from '../bridge/memory.mjs'
import { flowFileCandidates, loadFlows } from '../bridge/protective.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MAGIC = Buffer.from('JARVISMOVE1')
/** scrypt cost, 2^17: about a third of a second and 128 MB, once per run. */
const LOG_N = 17
const MIN_PASSPHRASE = 12
const EXT = '.jarvismove'

/**
 * Left out of ~/.jarvis. Logs are this Mac's; session.json points at a Claude
 * transcript that stays on the old Mac (resuming it there would fail, so he
 * starts a fresh conversation, notes intact); the updater's state, lock and
 * marker are about this install; connectors.json is a cache rebuilt at start.
 */
const SKIP = new Set(['logs', 'session.json', 'update.json', 'update.lock', '.skip-open', 'connectors.json'])

// ---------------------------------------------------------------------------
// The locked file
// ---------------------------------------------------------------------------

const deriveKey = (passphrase, salt, logN) =>
  scryptSync(passphrase.normalize('NFC'), salt, 32, { N: 2 ** logN, r: 8, p: 1, maxmem: 2 ** (logN + 11) })

/** The payload, gzipped and sealed: MAGIC, cost, salt, iv, tag, ciphertext. */
export function seal(payload, passphrase, logN = LOG_N) {
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', deriveKey(passphrase, salt, logN), iv)
  cipher.setAAD(MAGIC)
  const body = Buffer.concat([cipher.update(gzipSync(Buffer.from(JSON.stringify(payload)))), cipher.final()])
  return Buffer.concat([MAGIC, Buffer.from([logN]), salt, iv, cipher.getAuthTag(), body])
}

export function unseal(buf, passphrase) {
  if (buf.length < MAGIC.length + 45 || !buf.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('that is not a Jarvis move file')
  }
  let at = MAGIC.length
  const logN = buf[at++]
  // A crafted cost could ask scrypt for gigabytes; this file never uses more than 2^18.
  if (logN < 10 || logN > 18) throw new Error('that move file is damaged')
  const salt = buf.subarray(at, (at += 16))
  const iv = buf.subarray(at, (at += 12))
  const tag = buf.subarray(at, (at += 16))
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(passphrase, salt, logN), iv)
  decipher.setAAD(MAGIC)
  decipher.setAuthTag(tag)
  let plain
  try {
    plain = Buffer.concat([decipher.update(buf.subarray(at)), decipher.final()])
  } catch {
    throw new Error('wrong passphrase, or the file is damaged')
  }
  const payload = JSON.parse(gunzipSync(plain, { maxOutputLength: 2 ** 30 }).toString('utf8'))
  if (payload?.version !== 1 || !Array.isArray(payload.files)) throw new Error('that move file is from a newer Jarvis: pull, then try again')
  return payload
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function walk(dir, top = true, base = dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (top && SKIP.has(e.name)) continue
    if (e.name.endsWith('.tmp')) continue
    const abs = join(dir, e.name)
    // A link could point anywhere; only what is really in the folder goes.
    if (e.isDirectory()) walk(abs, false, base, out)
    else if (e.isFile()) out.push(relative(base, abs))
  }
  return out
}

/** How autostart was installed here, read back from its plist, or null. */
export function autostartOptions(home) {
  const agents = join(home, 'Library', 'LaunchAgents')
  const file = join(agents, 'local.jarvis.assistant.plist')
  if (!existsSync(file)) return null
  const body = readFileSync(file, 'utf8')
  const env = (k) => new RegExp(`<key>${k}</key>\\s*<string>([^<]*)</string>`).exec(body)?.[1]
  const unxml = (s) => s?.replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&')
  return {
    open: env('JARVIS_OPEN') === '1',
    browser: unxml(env('JARVIS_BROWSER')) ?? null,
    writes: body.includes('<string>--writes</string>'),
    update: existsSync(join(agents, 'local.jarvis.updater.plist')),
  }
}

/** The install command that gives the new Mac the old one's autostart. */
export function installCommand(a) {
  const flags = []
  if (a?.writes) flags.push('--writes')
  if (a && !a.open) flags.push('--no-open')
  if (a?.browser) flags.push(`--browser "${a.browser}"`)
  if (a && !a.update) flags.push('--no-update')
  return `npm run autostart:install${flags.length ? ` -- ${flags.join(' ')}` : ''}`
}

/** The MCP servers Jarvis reads by hand from ~/.claude.json (server.mjs). */
function claudeServers(home) {
  try {
    const cfg = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'))
    const servers = { mcpServers: cfg.mcpServers ?? {}, homeServers: cfg.projects?.[home]?.mcpServers ?? {} }
    return Object.keys(servers.mcpServers).length + Object.keys(servers.homeServers).length ? servers : null
  } catch {
    return null
  }
}

/** Files in public/ that git doesn't track and doesn't ignore: a custom wake word. */
function untrackedPublic(repo) {
  const r = spawnSync('git', ['ls-files', '--others', '--exclude-standard', '-z', 'public'], { cwd: repo, encoding: 'utf8' })
  return r.status === 0 ? r.stdout.split('\0').filter(Boolean) : []
}

const inside = (path, dir) => {
  const rel = relative(dir, path)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * Everything that moves, as one payload. Paths and options are passed in so
 * the tests can point it at a made-up Mac.
 */
export function collect({ repo, home, jarvisHome, flowsPath, publicFiles = [], autostart = null, now = new Date() }) {
  const files = []
  const add = (kind, path, abs, data = readFileSync(abs)) =>
    files.push({ kind, path, mode: statSync(abs).mode & 0o777, data: data.toString('base64') })
  const env = join(repo, '.env.local')
  if (existsSync(env)) add('env', '.env.local', env)
  if (existsSync(jarvisHome)) for (const rel of walk(jarvisHome)) add('jarvis', rel.split(sep).join('/'), join(jarvisHome, rel))
  if (flowsPath && existsSync(flowsPath) && !inside(flowsPath, jarvisHome)) add('flows', flowsPath, flowsPath)
  const servers = claudeServers(home)
  if (servers) files.push({ kind: 'claude-mcp', path: '.claude.json', mode: 0o600, data: Buffer.from(JSON.stringify(servers)).toString('base64') })
  for (const rel of publicFiles) {
    const abs = join(repo, rel)
    if (inside(abs, join(repo, 'public')) && statSync(abs).isFile()) add('public', rel.split(sep).join('/'), abs)
  }
  return {
    version: 1,
    made: now.toISOString(),
    from: { home, user: userInfo().username, host: hostname(), repo },
    autostart,
    files,
  }
}

/** What a payload holds, in words and names only. */
export function describe(payload) {
  const of = (k) => payload.files.filter((f) => f.kind === k)
  const out = []
  if (of('env').length) out.push('.env.local (settings and keys)')
  const n = of('jarvis').length
  if (n) out.push(`${n} file${n === 1 ? '' : 's'} from ~/.jarvis (memory, people, promises, review list, history)`)
  for (const f of of('flows')) {
    let n = '?'
    try {
      n = Object.keys(parseFlowsText(Buffer.from(f.data, 'base64').toString('utf8')).data).length
    } catch {
      // Counted as unknown; import says so too.
    }
    out.push(`the flows file (${n} keys)`)
  }
  for (const f of of('claude-mcp')) {
    const s = JSON.parse(Buffer.from(f.data, 'base64').toString('utf8'))
    const names = [...Object.keys(s.mcpServers), ...Object.keys(s.homeServers)]
    out.push(`${names.length} MCP server${names.length === 1 ? '' : 's'} from ~/.claude.json (${names.join(', ')})`)
  }
  if (of('public').length) out.push(`${of('public').length} local file(s) in public/ (${of('public').map((f) => f.path.replace(/^public\//, '')).join(', ')})`)
  if (payload.autostart) out.push(`how autostart was installed (${installCommand(payload.autostart).replace(/^npm run autostart:install(?: -- )?/, '') || 'defaults'})`)
  return out
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/** A path from the file, kept inside the folder it is written to. */
function safeRel(p) {
  const parts = String(p).split('/')
  if (!p || isAbsolute(p) || parts.some((s) => s === '..' || s === '' || s === '.')) throw new Error(`refusing an unsafe path in the move file: ${p}`)
  return join(...parts)
}

/**
 * The old Mac's home folder swapped for this one's in .env.local values, for
 * when the user name differs. Returns the text and the names that changed.
 */
export function moveEnvText(text, oldHome, home) {
  const changed = []
  if (!oldHome || oldHome === home) return { text, changed }
  const lines = text.split('\n').map((line) => {
    const m = /^(\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=)(.*)$/.exec(line)
    if (!m || !m[3].includes(oldHome)) return line
    const value = m[3].split(`${oldHome}/`).join(`${home}/`).replace(new RegExp(`(^|["'\\s;])${oldHome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|["'\\s;])`, 'g'), `$1${home}`)
    if (value === m[3]) return line
    changed.push(m[2])
    return m[1] + value
  })
  return { text: lines.join('\n'), changed }
}

/** Where a command would be found, or null. The LaunchAgent's PATH includes Homebrew's. */
export function findCommand(cmd, path = process.env.PATH ?? '') {
  if (isAbsolute(cmd)) return existsSync(cmd) ? cmd : null
  const dirs = [...path.split(delimiter), '/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local', 'bin')]
  for (const d of dirs) if (d && existsSync(join(d, cmd))) return join(d, cmd)
  return null
}

const stamp = (d) => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)

/**
 * Put a payload back on this Mac. Returns lines: { ok: true } done, { ok:
 * false } still to do, { ok: null } a note. Nothing in them is a value.
 */
export function restore(payload, { repo, home, jarvisHome, dryRun = false, replaceEnv = false, flowsHere = false, now = new Date() }) {
  const lines = []
  const done = (text) => lines.push({ ok: true, text })
  const todo = (text) => lines.push({ ok: false, text })
  const note = (text) => lines.push({ ok: null, text })
  const short = (p) => p.replace(home, '~')
  const oldHome = payload.from?.home
  const moveHome = (s) => (oldHome && oldHome !== home ? s.split(`${oldHome}/`).join(`${home}/`).split(`"${oldHome}"`).join(`"${home}"`) : s)
  const bytes = (f) => Buffer.from(f.data, 'base64')
  const of = (k) => payload.files.filter((f) => f.kind === k)
  const write = (path, data, mode) => {
    if (dryRun) return
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, data, { mode })
    chmodSync(tmp, mode)
    renameSync(tmp, path)
  }

  // ~/.jarvis — what a first run here already made is kept beside it.
  const state = of('jarvis')
  if (state.length) {
    const targets = state.map((f) => [f, join(jarvisHome, safeRel(f.path))])
    const here = existsSync(jarvisHome) ? walk(jarvisHome) : []
    if (here.length) {
      const backup = `${jarvisHome}.before-import-${stamp(now)}`
      if (!dryRun) cpSync(jarvisHome, backup, { recursive: true })
      note(`What was already in ${short(jarvisHome)} is kept at ${short(backup)}`)
    }
    for (const [f, target] of targets) {
      // The flows-keys snapshot is keyed by the flows file's path, which has the home folder in it.
      const data = f.path === 'flows-keys.json' ? Buffer.from(moveHome(bytes(f).toString('utf8'))) : bytes(f)
      write(target, data, f.mode || 0o600)
    }
    done(`${state.length} file${state.length === 1 ? '' : 's'} of memory, people, promises, review list and history → ${short(jarvisHome)}`)
  }

  // .env.local — never written over without being asked.
  const [env] = of('env')
  if (env) {
    const moved = moveEnvText(bytes(env).toString('utf8'), oldHome, home)
    const target = join(repo, '.env.local')
    if (!existsSync(target)) {
      write(target, moved.text, 0o600)
      done('Settings and keys → .env.local')
    } else if (readFileSync(target, 'utf8') === moved.text) {
      done('.env.local already matches the old Mac\'s')
    } else if (replaceEnv) {
      write(join(repo, '.env.before-import.local'), readFileSync(target), 0o600)
      write(target, moved.text, 0o600)
      done('.env.local replaced with the old Mac\'s; the one that was here is kept at .env.before-import.local')
    } else {
      // *.local is gitignored: a copy here can't be committed to the public repository.
      write(join(repo, '.env.from-old-mac.local'), moved.text, 0o600)
      todo('.env.local here differs from the old Mac\'s, so it was left alone. The old one is at .env.from-old-mac.local: run the import again with --replace-env to use it')
    }
    if (moved.changed.length) note(`Paths moved to this Mac's home folder in .env.local: ${moved.changed.join(', ')}`)
  }

  // The flows file — shared with the briefing and other tools, so OneDrive's copy is the one to use.
  for (const f of of('flows')) {
    let keys = []
    try {
      keys = Object.keys(parseFlowsText(bytes(f).toString('utf8')).data)
    } catch {
      todo('The flows file in the move file is not valid JSON; it was not used')
      continue
    }
    const saved = join(jarvisHome, 'power-automate.json')
    const there = [moveHome(f.path), ...flowFileCandidates()].find((p) => p !== saved && existsSync(p))
    if (flowsHere) {
      write(saved, bytes(f), 0o600)
      done(`Flows file (${keys.length} keys) → ${short(saved)}. Jarvis reads this copy now; the briefing and other tools still read OneDrive's`)
    } else if (there) {
      let have = []
      try {
        have = Object.keys(parseFlowsText(readFileSync(there, 'utf8')).data)
      } catch {
        todo(`${short(there)} is not valid JSON. Restore it from OneDrive's version history`)
        continue
      }
      const missing = keys.filter((k) => !have.includes(k))
      if (missing.length) todo(`The flows file here (${short(there)}) lacks keys the old Mac's had: ${missing.join(', ')}. Let OneDrive finish syncing, or add each with npm run flows:add`)
      else done(`Flows file found at ${short(there)}, every key the old Mac had`)
    } else {
      todo(
        `The flows file isn't on this Mac yet (it was at ${short(moveHome(f.path))}). Sign in to OneDrive and let it sync, ` +
          'or run the import again with --flows-here to keep the old Mac\'s copy in ~/.jarvis',
      )
    }
  }

  // ~/.claude.json's MCP servers — added beside what this Mac has, never over it.
  for (const f of of('claude-mcp')) {
    const want = JSON.parse(moveHome(bytes(f).toString('utf8')))
    const all = { ...want.mcpServers, ...want.homeServers }
    const names = Object.keys(all)
    const cfgPath = join(home, '.claude.json')
    if (!existsSync(cfgPath)) {
      todo(`${names.length} MCP server(s) (${names.join(', ')}) wait for Claude Code: run \`claude\` once and log in, then run the import again`)
      continue
    }
    const text = readFileSync(cfgPath, 'utf8')
    let cfg
    try {
      cfg = JSON.parse(text)
    } catch {
      todo('~/.claude.json is not valid JSON, so no MCP servers were added. Run `claude` once to repair it, then import again')
      continue
    }
    const added = []
    const merge = (into, from) => {
      for (const [n, s] of Object.entries(from)) {
        if (n in into) continue
        into[n] = s
        added.push(n)
      }
    }
    cfg.mcpServers ??= {}
    merge(cfg.mcpServers, want.mcpServers)
    if (Object.keys(want.homeServers).length) {
      cfg.projects ??= {}
      cfg.projects[home] ??= {}
      cfg.projects[home].mcpServers ??= {}
      merge(cfg.projects[home].mcpServers, want.homeServers)
    }
    if (added.length && !dryRun) {
      const backup = `${cfgPath}.before-jarvis-import`
      if (!existsSync(backup)) writeFileSync(backup, text, { mode: statSync(cfgPath).mode & 0o777 })
      writeKeepingMode(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`)
    }
    if (added.length) done(`MCP servers added to ~/.claude.json: ${added.join(', ')}`)
    if (added.length < names.length) done(`MCP servers already here, left as they are: ${names.filter((n) => !added.includes(n)).join(', ')}`)
    for (const [n, s] of Object.entries(all)) {
      if (typeof s?.command === 'string' && !findCommand(s.command)) todo(`Install \`${s.command}\`: the ${n} MCP server runs it`)
    }
  }

  // Untracked files in public/ — a custom wake word, say. Never over a tracked one.
  const local = of('public')
  if (local.length) {
    const put = []
    for (const f of local) {
      const target = join(repo, safeRel(f.path))
      if (!inside(target, join(repo, 'public')) || existsSync(target)) continue
      write(target, bytes(f), f.mode || 0o644)
      put.push(f.path.replace(/^public\//, ''))
    }
    if (put.length) done(`Local files → public/: ${put.join(', ')}`)
  }
  return lines
}

// ---------------------------------------------------------------------------
// What is left to do
// ---------------------------------------------------------------------------

/** The live checks, and the steps no file can carry. */
export function checks({ repo, home, jarvisHome, autostart }) {
  const lines = []
  const line = (ok, text) => lines.push({ ok, text })
  const major = Number(process.versions.node.split('.')[0])
  line(major >= 20, major >= 20 ? `Node.js ${process.versions.node}` : `Node.js ${process.versions.node} is too old: install Node 20 or newer`)
  const deps = existsSync(join(repo, 'node_modules', '@anthropic-ai', 'claude-agent-sdk'))
  line(deps, deps ? 'Dependencies installed' : 'Install dependencies: npm ci')
  const claude = findCommand('claude')
  line(Boolean(claude), claude ? 'Claude Code is installed' : 'Install Claude Code: npm install -g @anthropic-ai/claude-code')
  const loggedIn = existsSync(join(home, '.claude.json'))
  line(
    loggedIn,
    loggedIn
      ? 'Claude Code has been run here. Use the same account as the old Mac: the claude.ai connectors (Gmail, Calendar, Microsoft 365, Granola, Atlassian, Robinhood) come with it'
      : 'Run `claude` and log in with the same account as the old Mac: the claude.ai connectors come with the account',
  )
  const env = existsSync(join(repo, '.env.local'))
  line(env, env ? '.env.local is here' : '.env.local is missing: import the move file, or copy .env.example and fill it in')
  const memory = existsSync(join(jarvisHome, 'memory.md'))
  line(memory, memory ? `His memory is in ${jarvisHome.replace(home, '~')}` : `No memory in ${jarvisHome.replace(home, '~')} yet: import the move file`)
  const flows = loadFlows()
  const n = Object.keys(flows.flows).length
  line(n > 0, n ? `${n} Protective flows from ${flows.source}. Test them: npm run doctor:flows` : 'No flows file found: sign in to OneDrive and let it sync (or import with --flows-here)')
  const helper = BROWSER_HOSTS.filter((b) => existsSync(join(b.dir, HOST_MANIFEST))).map((b) => b.name)
  line(
    helper.length > 0,
    helper.length
      ? `Browser helper registered for ${helper.join(', ')}. Check it: npm run browser:doctor`
      : 'Browser control: install the Claude extension in Chrome and sign in, run `claude --chrome` once, then npm run browser:doctor',
  )
  const agent = existsSync(join(home, 'Library', 'LaunchAgents', 'local.jarvis.assistant.plist'))
  line(agent, agent ? 'Starts at login (autostart is installed)' : `Start at login, as the old Mac did: ${installCommand(autostart)}`)
  line(null, 'OneDrive: sign in on this Mac. The flows file is shared with the daily briefing and your other tools')
  line(null, 'Microphone: open Jarvis in Chrome, click INITIALISE and allow the microphone')
  line(null, 'Transcripts in Downloads: macOS asks once whether node may read Downloads. If you missed it: System Settings → Privacy & Security → Files and Folders → node')
  line(null, 'On the old Mac, run npm run autostart:uninstall. Two Jarvises would both alert, both build the brief and spend, and their promise lists would drift apart')
  line(null, 'Then delete the move file from both Macs and whatever carried it')
  return lines
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

const say = (s = '') => console.log(s)
const fail = (s) => {
  console.error(`\n  ${s}\n`)
  process.exit(1)
}
const show = (lines) => {
  for (const l of lines) say(`  ${l.ok === true ? '✓' : l.ok === false ? '→' : '·'} ${l.text}`)
}

/** Typed without echo. JARVIS_MOVE_PASSPHRASE is for scripts and tests. */
function askHidden(question) {
  if (!process.stdin.isTTY) fail('Run this in Terminal: it asks for a passphrase. (Or set JARVIS_MOVE_PASSPHRASE.)')
  process.stdout.write(question)
  return new Promise((resolveAnswer) => {
    const stdin = process.stdin
    let typed = ''
    const onData = (chunk) => {
      for (const c of chunk) {
        if (c === '\r' || c === '\n') return finish()
        if (c === '\u0003') {
          stdin.setRawMode(false)
          process.stdout.write('\n')
          process.exit(130)
        }
        if (c === '\u007f' || c === '\b') typed = typed.slice(0, -1)
        else typed += c
      }
    }
    const finish = () => {
      stdin.setRawMode(false)
      stdin.pause()
      stdin.off('data', onData)
      process.stdout.write('\n')
      resolveAnswer(typed)
    }
    stdin.setRawMode(true)
    stdin.setEncoding('utf8')
    stdin.resume()
    stdin.on('data', onData)
  })
}

async function passphrase(confirm) {
  const given = process.env.JARVIS_MOVE_PASSPHRASE
  if (given) {
    if (given.length < MIN_PASSPHRASE) fail(`The passphrase needs at least ${MIN_PASSPHRASE} characters.`)
    return given
  }
  const first = await askHidden(confirm ? `  Choose a passphrase (${MIN_PASSPHRASE}+ characters; you'll type it on the new Mac): ` : '  Passphrase: ')
  if (confirm) {
    if (first.length < MIN_PASSPHRASE) fail(`The passphrase needs at least ${MIN_PASSPHRASE} characters. A few unrelated words works well.`)
    if ((await askHidden('  Again: ')) !== first) fail('Those two did not match. Nothing was written.')
  }
  return first
}

/** Whether something answers on the bridge's port: Jarvis is running. */
function bridgeRunning(port) {
  return new Promise((done) => {
    const s = createConnection({ host: '127.0.0.1', port }, () => {
      s.destroy()
      done(true)
    })
    s.on('error', () => done(false))
    s.setTimeout(800, () => {
      s.destroy()
      done(false)
    })
  })
}

const expand = (p) => resolve(p.replace(/^~(?=$|\/)/, homedir()))
const short = (p) => p.replace(homedir(), '~')

async function exportCommand(args) {
  const home = homedir()
  const opt = args.indexOf('--out')
  const date = new Date().toISOString().slice(0, 10)
  const desktop = join(home, 'Desktop')
  const out = opt >= 0 && args[opt + 1] ? expand(args[opt + 1]) : join(existsSync(desktop) ? desktop : home, `jarvis-move-${date}${EXT}`)
  // Checked before anything is read: this folder is a public repository.
  if (out === ROOT || inside(out, ROOT)) fail('Save it outside the Jarvis folder: that folder is a public repository. Leave out --out to save it on the Desktop.')
  if (!existsSync(dirname(out))) fail(`There is no folder ${short(dirname(out))}.`)

  say('\n  Packing Jarvis for another Mac. Everything goes in one file locked with a passphrase.\n')
  const pass = await passphrase(true)
  const payload = collect({
    repo: ROOT,
    home,
    jarvisHome: JARVIS_HOME,
    flowsPath: loadFlows().path,
    publicFiles: untrackedPublic(ROOT),
    autostart: autostartOptions(home),
  })
  const buf = seal(payload, pass)
  writeFileSync(out, buf, { mode: 0o600 })
  chmodSync(out, 0o600)

  // A remote URL can carry a token (https://user:token@github.com/...); never print one.
  const remote =
    spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: ROOT, encoding: 'utf8' }).stdout?.trim().replace(/\/\/[^/@\s]*@/, '//') || '<this repository>'
  const folder = ROOT.startsWith(home) ? `~${ROOT.slice(home.length)}` : ROOT
  say(`\n  Saved ${short(out)} (${(buf.length / 1024 / 1024).toFixed(1)} MB).`)
  say('  In it:')
  for (const d of describe(payload)) say(`    · ${d}`)
  say('  Not in it (the import lists each, with a check): the Claude login and its connectors, OneDrive, the')
  say('  Chrome extension, macOS permissions, and autostart itself, which is installed fresh on the new Mac.\n')
  say('  Carry it by AirDrop or a USB stick, not email or chat. Then, on the new Mac:')
  say('    1. Install Node 20+ and Claude Code, run `claude` and log in with the same account')
  say(`    2. git clone ${remote} "${folder}"`)
  say(`       cd "${folder}" && npm ci`)
  say(`    3. npm run move:import -- ~/Downloads/${out.split(sep).pop()}`)
  say('    4. Once it runs there: npm run autostart:uninstall here, so only one Jarvis runs.\n')
}

async function importCommand(args) {
  const home = homedir()
  const file = args.find((a) => !a.startsWith('--'))
  if (!file) fail('Say which file: npm run move:import -- ~/Downloads/jarvis-move-<date>.jarvismove')
  const path = expand(file)
  if (!existsSync(path)) fail(`There is no file at ${short(path)}.`)
  const dryRun = args.includes('--dry-run')

  say('\n  Unpacking Jarvis from another Mac. Quit Claude Code first: this may add MCP servers to ~/.claude.json.\n')
  const pass = await passphrase(false)
  let payload
  try {
    payload = unseal(readFileSync(path), pass)
  } catch (err) {
    fail(`${err.message[0].toUpperCase()}${err.message.slice(1)}. Nothing was changed.`)
  }
  say(`\n  From ${payload.from?.host ?? 'the old Mac'}, packed ${new Date(payload.made).toLocaleString()}:`)
  for (const d of describe(payload)) say(`    · ${d}`)
  say()

  const port = Number(process.env.JARVIS_BRIDGE_PORT ?? 8787)
  if (!dryRun && (await bridgeRunning(port))) {
    fail('Jarvis is running on this Mac. Stop it first (npm run autostart:stop, or Ctrl-C the npm start window), then run this again.')
  }

  // If the old .env.local moved JARVIS_HOME and this Mac has no say of its own, follow it.
  let jarvisHome = JARVIS_HOME
  const env = payload.files.find((f) => f.kind === 'env')
  if (env && !process.env.JARVIS_HOME) {
    const m = /^\s*(?:export\s+)?JARVIS_HOME\s*=\s*["']?([^"'\n#]+?)["']?\s*$/m.exec(Buffer.from(env.data, 'base64').toString('utf8'))
    if (m) jarvisHome = expand(moveEnvText(m[1], payload.from?.home, home).text)
  }

  let lines
  try {
    lines = restore(payload, {
      repo: ROOT,
      home,
      jarvisHome,
      dryRun,
      replaceEnv: args.includes('--replace-env'),
      flowsHere: args.includes('--flows-here'),
    })
  } catch (err) {
    fail(err.message)
  }
  say(dryRun ? '  Dry run: nothing was written. This is what would happen:' : '  Done:')
  show(lines)
  say('\n  Still to do on this Mac (npm run move:check shows this again):')
  show(checks({ repo: ROOT, home, jarvisHome, autostart: payload.autostart }).filter((l) => l.ok !== true))
  say()
}

function checkCommand() {
  say('\n  Jarvis on this Mac:\n')
  show(checks({ repo: ROOT, home: homedir(), jarvisHome: JARVIS_HOME, autostart: autostartOptions(homedir()) }))
  say()
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, ...args] = process.argv.slice(2)
  const run = { export: exportCommand, import: importCommand, check: checkCommand }[command]
  if (!run) fail('Use npm run move:export, npm run move:import -- <file>, or npm run move:check.')
  await run(args)
}
