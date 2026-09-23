/**
 * Start JARVIS when you log in to your Mac, and keep him running.
 *
 *   npm run autostart:install     start at login from now on (and start now)
 *   npm run autostart:status      is it installed, is it running, last log lines
 *   npm run autostart:logs        follow the log
 *   npm run autostart:restart     after changing .env.local or pulling updates
 *   npm run autostart:stop        stop it until the next login
 *   npm run autostart:uninstall   stop it and never start at login again
 *
 * It is a macOS LaunchAgent: a small plist in ~/Library/LaunchAgents that tells
 * launchd to run `npm start` in this folder when you log in, restart it if it
 * crashes, and write its output to ~/.jarvis/logs/jarvis.log. When the face is
 * ready it opens in your browser (install with --no-open to skip that, or
 * --browser "Microsoft Edge" to pick one other than your default).
 *
 * Two things differ from running `npm start` in Terminal, and both are handled
 * here rather than left to be discovered:
 *
 *   - A login item does not read ~/.zshrc. PATH is written into the plist, so
 *     node and claude are found; settings you export in your shell are not, so
 *     install checks for any that are missing from .env.local and names them.
 *     It never copies a value into the plist — secrets belong in .env.local.
 *   - There is no terminal to watch. Everything goes to the log file, which is
 *     cut back when it grows past a few megabytes.
 *
 * Pass --writes to install to let the login copy take real actions, exactly as
 * `npm start -- --writes` does. --print writes nothing and shows the plist.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LABEL = 'local.jarvis.assistant'
const PLIST = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`)
const JARVIS_HOME = (process.env.JARVIS_HOME ?? join(homedir(), '.jarvis')).replace(
  /^~(?=$|\/)/,
  homedir(),
)
const LOG = join(JARVIS_HOME, 'logs', 'jarvis.log')
const DOMAIN = `gui/${userInfo().uid}`
const SERVICE = `${DOMAIN}/${LABEL}`

const [command = 'status', ...flags] = process.argv.slice(2)
const flag = (name) => flags.includes(name)
const option = (name) => {
  const i = flags.indexOf(name)
  return i >= 0 ? flags[i + 1] : undefined
}

const say = (line = '') => console.log(line)
const fail = (line) => {
  console.error(`\n  ${line}\n`)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Finding things the way a login item will need them
// ---------------------------------------------------------------------------

/** Where a command lives on the PATH of the shell running this, or null. */
function which(name) {
  const r = spawnSync('/bin/sh', ['-c', `command -v ${name}`], { encoding: 'utf8' })
  const found = r.status === 0 ? r.stdout.trim() : ''
  return found.startsWith('/') ? found : null
}

/**
 * The PATH the login copy runs with. launchd starts agents with almost nothing
 * on it (/usr/bin:/bin:/usr/sbin:/sbin), so node from Homebrew or nvm and the
 * claude CLI would not be found. Their folders go first, then the usual places.
 */
function loginPath(node) {
  const dirs = [
    dirname(node),
    which('claude') && dirname(which('claude')),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    join(homedir(), '.local', 'bin'),
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ].filter(Boolean)
  return [...new Set(dirs)].join(':')
}

/**
 * node as the shell finds it. Preferred over process.execPath, which is the
 * resolved binary: under Homebrew that is a versioned Cellar path that stops
 * existing on the next `brew upgrade`, while /opt/homebrew/bin/node keeps
 * pointing at whatever is current.
 */
function nodePath() {
  return which('node') ?? process.execPath
}

/** Variable names set in .env.local or .env. */
function envFileNames() {
  const names = new Set()
  for (const file of ['.env.local', '.env']) {
    const path = join(ROOT, file)
    if (!existsSync(path)) continue
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)
      if (m) names.add(m[1])
    }
  }
  return names
}

/**
 * Settings exported in this shell that the login copy will not see, because
 * they are not in .env.local either. Names only, never values.
 */
function shellOnlySettings() {
  const inFiles = envFileNames()
  return Object.keys(process.env)
    .filter((k) => /^(JARVIS_|ELEVENLABS_|VITE_)/.test(k))
    .filter((k) => !inFiles.has(k))
    .sort()
}

// ---------------------------------------------------------------------------
// The plist
// ---------------------------------------------------------------------------

const xml = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function plist({ node, path, open, browser, writes }) {
  const args = [node, join(ROOT, 'scripts', 'start.mjs'), ...(writes ? ['--writes'] : [])]
  const env = {
    PATH: path,
    JARVIS_LOG_FILE: LOG,
    ...(open ? { JARVIS_OPEN: '1' } : {}),
    ...(browser ? { JARVIS_BROWSER: browser } : {}),
  }
  const strings = (list) => list.map((a) => `\t\t<string>${xml(a)}</string>`).join('\n')
  const dict = (obj) =>
    Object.entries(obj)
      .map(([k, v]) => `\t\t<key>${xml(k)}</key>\n\t\t<string>${xml(v)}</string>`)
      .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${LABEL}</string>
\t<key>ProgramArguments</key>
\t<array>
${strings(args)}
\t</array>
\t<key>WorkingDirectory</key>
\t<string>${xml(ROOT)}</string>
\t<key>EnvironmentVariables</key>
\t<dict>
${dict(env)}
\t</dict>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<dict>
\t\t<key>SuccessfulExit</key>
\t\t<false/>
\t</dict>
\t<key>ThrottleInterval</key>
\t<integer>30</integer>
\t<key>ProcessType</key>
\t<string>Interactive</string>
\t<key>StandardOutPath</key>
\t<string>${xml(LOG)}</string>
\t<key>StandardErrorPath</key>
\t<string>${xml(LOG)}</string>
</dict>
</plist>
`
}

// ---------------------------------------------------------------------------
// launchctl
// ---------------------------------------------------------------------------

function launchctl(...args) {
  return spawnSync('launchctl', args, { encoding: 'utf8' })
}

function loaded() {
  return launchctl('print', SERVICE).status === 0
}

/** { state, pid, lastExit } from `launchctl print`, or null if not loaded. */
function serviceState() {
  const r = launchctl('print', SERVICE)
  if (r.status !== 0) return null
  const pick = (re) => re.exec(r.stdout)?.[1]
  return {
    state: pick(/^\s*state = (.+)$/m) ?? 'unknown',
    pid: pick(/^\s*pid = (\d+)$/m),
    lastExit: pick(/^\s*last exit code = (.+)$/m),
  }
}

function requireMac() {
  if (process.platform !== 'darwin') {
    fail(
      'Auto-start is set up with a macOS LaunchAgent, so it only works on a Mac.\n' +
        '  (`npm run autostart:install -- --print` shows the file it would write.)',
    )
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function install() {
  const node = nodePath()
  const config = {
    node,
    path: loginPath(node),
    open: !flag('--no-open'),
    browser: option('--browser'),
    writes: flag('--writes'),
  }
  const body = plist(config)

  if (flag('--print')) {
    process.stdout.write(body)
    return
  }
  requireMac()

  if (!existsSync(join(ROOT, 'node_modules'))) {
    fail('Run `npm install` in this folder first; the login copy runs from it.')
  }
  if (!which('claude')) {
    say('\n  Note: the claude CLI is not on your PATH. If he stops answering after a')
    say('  login, run `claude`, type /login, then `npm run autostart:restart`.')
  }

  mkdirSync(dirname(PLIST), { recursive: true })
  mkdirSync(dirname(LOG), { recursive: true })

  // Replace any earlier copy, so a re-install picks up a moved folder or a new
  // node. bootout on something that is not loaded just fails quietly.
  if (loaded()) launchctl('bootout', SERVICE)
  writeFileSync(PLIST, body)
  const r = launchctl('bootstrap', DOMAIN, PLIST)
  if (r.status !== 0) {
    fail(`launchctl could not load it: ${(r.stderr || r.stdout).trim()}\n  The plist is at ${PLIST}.`)
  }

  say(`\n  ${nameOf()} will now start when you log in, and is starting now.`)
  say(`  Folder:  ${ROOT}`)
  say(`  Node:    ${node}`)
  say(`  Log:     ${LOG}`)
  if (config.open) say(`  Opens in ${config.browser ?? 'your default browser'} once it is ready.`)
  if (config.writes) say('  Actions are enabled (--writes): effectful tools run without asking.')
  if (node.includes('/.nvm/')) {
    say('\n  Node comes from nvm. If you switch or remove this version, run install again.')
  }

  const missing = shellOnlySettings()
  if (missing.length) {
    say('\n  These are set in your shell but not in .env.local, so the login copy will')
    say('  not see them. Move them into .env.local, then `npm run autostart:restart`:')
    for (const k of missing) say(`    ${k}`)
  }
  if (process.env.ANTHROPIC_API_KEY) {
    say('\n  ANTHROPIC_API_KEY is set in this shell. The login copy does not get it, so it')
    say('  uses your Claude subscription login, with your claude.ai connectors.')
  }
  say('\n  Check on it with `npm run autostart:status`. The first microphone use still')
  say('  needs a click on INITIALISE in the page, as browsers require.\n')
}

function uninstall() {
  requireMac()
  const was = existsSync(PLIST)
  if (loaded()) launchctl('bootout', SERVICE)
  rmSync(PLIST, { force: true })
  say(
    was
      ? `\n  Removed. ${nameOf()} will no longer start at login, and has been stopped.\n  The log and memory in ${JARVIS_HOME} are kept.\n`
      : '\n  Auto-start was not installed; nothing to remove.\n',
  )
}

function stop() {
  requireMac()
  if (!loaded()) return say('\n  Not running under auto-start.\n')
  // A plain SIGTERM: start.mjs shuts both halves down and exits 0, and a clean
  // exit is the one thing KeepAlive does not restart. Back at the next login.
  launchctl('kill', 'SIGTERM', SERVICE)
  say('\n  Stopped until your next login. `npm run autostart:restart` brings it back now.\n')
}

function restart() {
  requireMac()
  if (!existsSync(PLIST)) fail('Auto-start is not installed. Run `npm run autostart:install`.')
  if (!loaded()) launchctl('bootstrap', DOMAIN, PLIST)
  const r = launchctl('kickstart', '-k', SERVICE)
  if (r.status !== 0) fail(`launchctl could not restart it: ${(r.stderr || r.stdout).trim()}`)
  say('\n  Restarted. `npm run autostart:logs` to watch it come up.\n')
}

function status() {
  requireMac()
  if (!existsSync(PLIST)) {
    say('\n  Auto-start is not installed. `npm run autostart:install` sets it up.\n')
    return
  }
  const s = serviceState()
  say(`\n  Installed: ${PLIST}`)
  if (!s) say('  Not loaded right now; it will start at your next login.')
  else if (s.pid) say(`  Running (pid ${s.pid}).`)
  else say(`  Not running (${s.state}${s.lastExit ? `, last exit ${s.lastExit}` : ''}).`)

  // The plist records paths from install time; say so if any have gone away.
  const body = readFileSync(PLIST, 'utf8')
  const node = /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]+)<\/string>/.exec(body)?.[1]
  if (node && !existsSync(node)) {
    say(`  Problem: ${node} no longer exists. Run \`npm run autostart:install\` again.`)
  }
  if (!body.includes(`<string>${xml(ROOT)}</string>`)) {
    say('  Problem: it was installed from a different folder. Run install again from here.')
  }

  if (existsSync(LOG)) {
    const tail = readFileSync(LOG, 'utf8').trimEnd().split('\n').slice(-8)
    say(`\n  Last lines of ${LOG}:`)
    for (const line of tail) say(`    ${line}`)
  }
  say()
}

function logs() {
  if (!existsSync(LOG)) fail(`No log yet at ${LOG}.`)
  spawnSync('tail', ['-n', '60', '-f', LOG], { stdio: 'inherit' })
}

/** The configured name, for messages. Read from .env.local without loading it. */
function nameOf() {
  if (process.env.JARVIS_NAME?.trim()) return process.env.JARVIS_NAME.trim()
  const path = join(ROOT, '.env.local')
  if (existsSync(path)) {
    const m = /^\s*JARVIS_NAME\s*=\s*['"]?([^'"#\n]+?)['"]?\s*(?:#.*)?$/m.exec(readFileSync(path, 'utf8'))
    if (m?.[1]) return m[1]
  }
  return 'Jarvis'
}

const COMMANDS = { install, uninstall, stop, restart, status, logs }
if (!COMMANDS[command]) {
  fail(`Unknown command "${command}". One of: ${Object.keys(COMMANDS).join(', ')}.`)
}
COMMANDS[command]()
