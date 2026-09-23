/**
 * One command to run JARVIS: the bridge (brain) and the Vite dev server (face)
 * together, so a student types `npm start` and nothing else.
 *
 * Two long-running processes normally mean two terminals. This launcher spawns
 * both as children, tags their output so you can tell them apart, and shuts
 * them down together on Ctrl-C — no extra dependency, just Node.
 *
 * Pass --writes to allow JARVIS to take real actions (drive the phone, the
 * browser, send things): `npm start -- --writes`. Pass --open to open the page
 * in your browser once it is ready (auto-start at login does this for you).
 */

import { spawn } from 'node:child_process'
import process from 'node:process'
import { createServer } from 'node:net'
import { cpSync, existsSync, mkdirSync, rmSync, statSync, truncateSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Put MediaPipe's WebAssembly where the page can actually load it.
 *
 * Hand tracking needs a WASM runtime, and the usual recipe fetches it from a
 * CDN. That fails here twice over. The page's CSP names no CDN in `script-src`,
 * and the runtime arrives as a script — so it is blocked, and the failure
 * surfaces as gesture control simply never starting. And a CDN import is a live
 * supply-chain dependency: executable code, re-resolved on every load, that we
 * do not control and cannot pin against being changed under us.
 *
 * Copying it out of node_modules solves both. It is served from our own origin,
 * so `'self'` covers it; and it is the exact bytes of the version in the
 * lockfile. It stays out of git — 34 MB of build output does not belong in a
 * repository — and is re-copied whenever it is missing, which costs nothing
 * after the first run.
 */
function vendorWasm() {
  const from = 'node_modules/@mediapipe/tasks-vision/wasm'
  const to = 'public/mediapipe'
  if (!existsSync(from)) return // gesture control is optional; carry on without it
  if (existsSync(`${to}/vision_wasm_internal.wasm`)) return
  try {
    mkdirSync(to, { recursive: true })
    cpSync(from, to, { recursive: true })
    console.log('  vendored the hand-tracking runtime into public/mediapipe.')
  } catch (err) {
    console.warn(`  could not vendor the hand-tracking runtime: ${err.message}`)
  }
}

const writes = process.argv.includes('--writes')
const open = process.argv.includes('--open') || process.env.JARVIS_OPEN === '1'

// A dim label per process, so the interleaved logs stay readable. Colour only
// in a terminal: in the auto-start log file the escape codes are just noise.
const tty = process.stdout.isTTY
const ANSI = new RegExp(String.raw`\u001b\[[0-9;]*m`, 'g')
const paint = (tag, colour) => (line) =>
  line
    .toString()
    .split('\n')
    .filter((l) => l.length)
    .map((l) => (tty ? `\x1b[${colour}m${tag}\x1b[0m ${l}` : `${tag} ${l.replace(ANSI, '')}`))
    .join('\n')

const children = []

function run(name, command, args, colour, env) {
  const label = paint(name, colour)
  const child = spawn(command, args, {
    env: { ...process.env, ...env },
    shell: false,
  })
  child.stdout.on('data', (d) => process.stdout.write(label(d) + '\n'))
  child.stderr.on('data', (d) => process.stderr.write(label(d) + '\n'))
  child.on('exit', (code) => {
    // If either half dies the other is useless, so take the whole thing down
    // rather than leave a half-running app that looks alive but cannot answer.
    console.log(`${tty ? `\x1b[${colour}m${name}\x1b[0m` : name} exited (${code}); stopping the rest.`)
    shutdown(code ?? 0)
  })
  children.push(child)
  return child
}

let stopping = false
function shutdown(code) {
  if (stopping) return
  stopping = true
  for (const c of children) {
    try {
      c.kill('SIGTERM')
    } catch {
      /* already gone */
    }
  }
  setTimeout(() => process.exit(code), 300)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

/**
 * Tell the bridge which port the face will actually be on.
 *
 * The bridge only trusts WebSocket origins on localhost:5173-5199 and
 * 4173-4199, which is the right default — a socket that any local page can open
 * is a socket that drives every MCP server on the machine. But a launcher that
 * assigns a port outside that range produces the single most confusing failure
 * this project has: the interface loads, the reactor spins, the microphone
 * hears you, and the brain answers nothing, because the handshake is being 403'd
 * somewhere neither half reports. Passing the port through closes that gap
 * without widening what the bridge trusts by default.
 */
const port = process.env.PORT
const bridgeEnv = writes ? { JARVIS_ALLOW_WRITES: '1' } : {}
if (port) {
  bridgeEnv.JARVIS_ALLOWED_ORIGINS = `http://localhost:${port},http://127.0.0.1:${port}`
  console.log(`  serving the face on port ${port}; the bridge will accept it.\n`)
}

/**
 * Auto-start writes everything to one log file and nothing ever reads it back,
 * so it would grow for as long as the Mac is in use. launchd opens the file for
 * appending, which means cutting it to nothing here is safe even while it is
 * open: the next line simply lands at the start.
 */
function trimLog() {
  const file = process.env.JARVIS_LOG_FILE
  if (!file) return
  try {
    if (statSync(file).size > 5 * 1024 * 1024) truncateSync(file, 0)
  } catch {
    // No log yet.
  }
}

/**
 * Is the bridge's port already taken? Nearly always by another copy of this
 * app — the auto-start one, when you also type `npm start` — and the old
 * failure was an EADDRINUSE stack trace from the bridge while the face started
 * anyway and talked to the other copy. Say it plainly and stop instead.
 */
function portTaken(p) {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.once('error', (err) => resolve(err.code === 'EADDRINUSE'))
    probe.once('listening', () => probe.close(() => resolve(false)))
    probe.listen(p)
  })
}

/**
 * After an automatic update the page that was already open reloads by itself
 * when the dev server comes back; opening another would leave two copies
 * listening. The updater leaves this marker to say so.
 */
function justUpdated() {
  const marker = join(
    (process.env.JARVIS_HOME ?? join(homedir(), '.jarvis')).replace(/^~(?=$|\/)/, homedir()),
    '.skip-open',
  )
  try {
    const recent = Date.now() - statSync(marker).mtimeMs < 10 * 60_000
    rmSync(marker, { force: true })
    return recent
  } catch {
    return false
  }
}

/** Open the page once, in JARVIS_BROWSER if set, else the default browser. */
let opened = false
function openPage(url) {
  if (opened) return
  opened = true
  if (skipOpen) return console.log(`  updated; the open page at ${url} reloads by itself`)
  const browser = process.env.JARVIS_BROWSER
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', browser ? ['-a', browser, url] : [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]]
  const child = spawn(cmd, args, { stdio: 'ignore', detached: true })
  child.on('error', (err) => console.warn(`  could not open ${url}: ${err.message}`))
  child.unref()
  console.log(`  opening ${url}${browser ? ` in ${browser}` : ''}`)
}

trimLog()
// Read (and cleared) at startup, whether or not this run opens the page.
const skipOpen = justUpdated()

/**
 * Taken for a few seconds is normal: on a restart the previous bridge is still
 * letting go of the port. Only a port that stays taken is another copy.
 */
async function portHeld(p, seconds = 8) {
  for (let i = 0; i < seconds * 2; i++) {
    if (!(await portTaken(p))) return false
    await new Promise((r) => setTimeout(r, 500))
  }
  return true
}

const bridgePort = Number(process.env.JARVIS_BRIDGE_PORT ?? 8787)
if (await portHeld(bridgePort)) {
  console.log(
    `\nJARVIS is already running: something is using port ${bridgePort}.\n` +
      '  If it started at login, open http://localhost:5173 or run\n' +
      '  `npm run autostart:restart` to pick up changes. Otherwise stop the other\n' +
      `  copy (kill $(lsof -ti :${bridgePort})) and run npm start again.\n`,
  )
  // A clean exit, so auto-start does not keep retrying against the other copy.
  process.exit(0)
}

vendorWasm()

console.log(`\nJ.A.R.V.I.S. starting — the brain and the face. (${new Date().toString()})\n`)
run('bridge', 'node', ['bridge/server.mjs'], '36', bridgeEnv)
// npm is a shell script on most systems; call the vite binary directly so we do
// not need shell:true (which would break the argument handling above).
const face = run('face', process.execPath, ['node_modules/vite/bin/vite.js'], '35', {})

if (open) {
  // Vite prints "Local:   http://localhost:5173/" when it is serving, with the
  // port it actually got, which may not be 5173 if that was taken.
  let seen = ''
  face.stdout.on('data', (d) => {
    if (opened) return
    seen = (seen + d.toString().replace(ANSI, '')).slice(-2000)
    const m = /Local:\s+(https?:\/\/\S+)/.exec(seen)
    if (m) openPage(m[1])
  })
}

console.log(
  open
    ? '\nThe page opens by itself once it is ready. Click INITIALISE and say "Hey Jarvis".\n'
    : '\nWhen it says the dev server is ready, open the URL it prints in Chrome,\n' +
        'click INITIALISE, and say "Hey Jarvis". Ctrl-C stops everything.\n',
)
