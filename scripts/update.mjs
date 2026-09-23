/**
 * Keep this Mac on the latest merged version, without anyone typing git pull.
 *
 * Run every few minutes by a second LaunchAgent that `npm run autostart:install`
 * sets up (and `npm run autostart:update` runs it by hand, straight away). Each
 * run is cheap when there is nothing new: one `git fetch`, and it exits.
 *
 * When main has moved on it:
 *
 *   1. waits until he is quiet — no page open, or nothing said for
 *      JARVIS_UPDATE_IDLE_MIN minutes (15) — because the update reloads the
 *      page, and a reloaded page needs a click before it can use the mic;
 *   2. stops him, fast-forwards to origin/main, and installs whatever
 *      dependencies changed (incrementally; see installDeps);
 *   3. starts him again (rewriting the LaunchAgent first if that changed), and
 *      checks that the bridge actually comes up;
 *   4. if it does not, puts the previous version back, restarts that, and
 *      skips the broken commit until a newer one lands.
 *
 * It only ever fast-forwards main. On another branch, with local commits, or
 * with edited tracked files, it leaves everything alone and says why in
 * `npm run autostart:status`. The one exception is package-lock.json, which
 * `npm install` rewrites on its own; that is reset before the pull.
 *
 * A macOS notification says what changed. JARVIS_AUTO_UPDATE=off in .env.local
 * turns the whole thing off.
 */

import '../bridge/env.mjs'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const JARVIS_HOME = (process.env.JARVIS_HOME ?? join(homedir(), '.jarvis')).replace(
  /^~(?=$|\/)/,
  homedir(),
)
const STATE = join(JARVIS_HOME, 'update.json')
const SKIP_OPEN = join(JARVIS_HOME, '.skip-open')
const PORT = Number(process.env.JARVIS_BRIDGE_PORT ?? 8787)
const IDLE_MIN = Number(process.env.JARVIS_UPDATE_IDLE_MIN ?? 15)
const SERVICE = `gui/${userInfo().uid}/local.jarvis.assistant`
const LAUNCHCTL = process.env.JARVIS_LAUNCHCTL ?? 'launchctl'
const now = process.argv.includes('--now')

const log = (line) => console.log(`${new Date().toISOString()} ${line}`)

function trimLog() {
  const file = process.env.JARVIS_LOG_FILE
  if (!file) return
  try {
    if (statSync(file).size > 1024 * 1024) truncateSync(file, 0)
  } catch {
    // No log yet.
  }
}

function readState() {
  try {
    return JSON.parse(readFileSync(STATE, 'utf8'))
  } catch {
    return {}
  }
}
function writeState(patch) {
  mkdirSync(JARVIS_HOME, { recursive: true })
  writeFileSync(STATE, JSON.stringify({ ...readState(), ...patch, checked: new Date().toISOString() }, null, 2))
}

/** Say something once per remote commit, not every five minutes. */
function waiting(remote, reason) {
  const state = readState()
  if (state.waiting?.sha !== remote || state.waiting?.reason !== reason) log(reason)
  writeState({ waiting: { sha: remote, reason } })
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts })
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? r.error?.message ?? '').trim() }
}
const git = (...args) => run('git', args)

function notify(message) {
  if (process.platform !== 'darwin') return
  const q = (s) => `"${String(s).replace(/["\\]/g, '')}"`
  run('osascript', ['-e', `display notification ${q(message)} with title ${q(process.env.JARVIS_NAME?.trim() || 'Jarvis')}`])
}

/** The bridge's /health, or null if nothing answers. */
async function health() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(3000) })
    return res.ok ? await res.json() : null
  } catch {
    return null
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function stopJarvis() {
  run(LAUNCHCTL, ['kill', 'SIGTERM', SERVICE])
  for (let i = 0; i < 30 && (await health()); i++) await sleep(500)
}

/** Start him on whatever is checked out now, and wait for the bridge. */
async function startJarvis() {
  // The page that was open reloads by itself when the dev server comes back,
  // so the restart must not open a second one.
  mkdirSync(JARVIS_HOME, { recursive: true })
  writeFileSync(SKIP_OPEN, String(Date.now()))
  // Run the checked-out autostart, so a change to the LaunchAgent itself lands.
  const r = run(process.execPath, [join(ROOT, 'scripts', 'autostart.mjs'), 'refresh'])
  if (!r.ok) log(`restart: ${r.err || r.out}`)
  for (let i = 0; i < 60; i++) {
    await sleep(1500)
    if (await health()) return true
  }
  return false
}

/** Longest an install may take before the update is abandoned and rolled back. */
const INSTALL_TIMEOUT_MS = 15 * 60_000

/**
 * Bring node_modules in line with the lockfile, adding and removing only what
 * changed. This was `npm ci`, which deletes all 1.6 GB and downloads it again:
 * minutes at best, and under a throttled LaunchAgent it never finished, which
 * left him stopped on a half-installed node_modules crashing with
 * ERR_MODULE_NOT_FOUND. An incremental install is seconds for the usual one
 * added package, and never empties the folder.
 */
function installDeps() {
  const t0 = Date.now()
  log('installing dependencies')
  const r = run('npm', ['install', '--no-audit', '--no-fund'], { timeout: INSTALL_TIMEOUT_MS })
  const secs = Math.round((Date.now() - t0) / 1000)
  if (r.ok) {
    log(`dependencies installed (${secs}s)`)
    return true
  }
  log(`dependencies failed after ${secs}s: ${(r.err || 'timed out').split('\n').slice(-3).join(' ')}`)
  return false
}

/**
 * One update at a time. launchd never overlaps runs of its own job, but
 * `npm run autostart:update` by hand can land in the middle of one, and two
 * installs into the same node_modules is how you get a broken one.
 */
const LOCK = join(JARVIS_HOME, 'update.lock')
function takeLock() {
  try {
    const pid = Number(readFileSync(LOCK, 'utf8'))
    if (pid && pid !== process.pid) {
      try {
        process.kill(pid, 0)
        return false // alive: someone else is updating
      } catch {
        // Stale: its process is gone.
      }
    }
  } catch {
    // No lock.
  }
  mkdirSync(JARVIS_HOME, { recursive: true })
  writeFileSync(LOCK, String(process.pid))
  return true
}
function dropLock() {
  try {
    if (Number(readFileSync(LOCK, 'utf8')) === process.pid) rmSync(LOCK, { force: true })
  } catch {
    // Already gone.
  }
}

async function main() {
  trimLog()
  if (process.env.JARVIS_AUTO_UPDATE === 'off') return

  const branch = git('rev-parse', '--abbrev-ref', 'HEAD').out
  if (branch !== 'main') {
    return writeState({ waiting: { reason: `not updating: the folder is on branch "${branch}", not main` } })
  }

  if (!takeLock()) {
    if (now) console.log('An update is already running; `npm run autostart:status` shows its progress.')
    return
  }

  const fetched = git('fetch', '--quiet', 'origin', 'main')
  if (!fetched.ok) {
    // "cannot lock ref" is a `git pull` in a Terminal at the same moment, not
    // the network; the next check simply tries again.
    const first = fetched.err.split('\n')[0]
    return waiting('', /cannot lock ref|unable to update local ref/.test(fetched.err)
      ? 'fetch clashed with another git command; trying again next check'
      : `could not reach GitHub: ${first}`)
  }

  const local = git('rev-parse', 'HEAD').out
  const remote = git('rev-parse', 'origin/main').out
  if (local === remote) return writeState({ waiting: null, current: local })

  if (!git('merge-base', '--is-ancestor', 'HEAD', 'origin/main').ok) {
    return waiting(remote, 'not updating: this folder has commits that are not on GitHub')
  }
  if (readState().skip === remote && !now) {
    return waiting(remote, `not updating: ${remote.slice(0, 7)} failed to start last time; waiting for a newer one`)
  }

  // Tracked files changed here, staged or not. Untracked files never block a
  // fast-forward unless the update adds the same path, and then git says so.
  const dirty = git('diff', '--name-only', 'HEAD').out.split('\n').filter(Boolean)
  const edited = dirty.filter((f) => f !== 'package-lock.json')
  if (edited.length) {
    return waiting(remote, `not updating: files edited in this folder: ${edited.join(', ')}`)
  }

  const h = await health()
  if (!now && h && h.pages > 0 && (h.idleSeconds ?? 0) < IDLE_MIN * 60) {
    return waiting(remote, `update ready; waiting until he has been quiet for ${IDLE_MIN} min`)
  }

  // --- apply --------------------------------------------------------------
  const subject = git('log', '-1', '--format=%s', 'origin/main').out
  const changed = git('diff', '--name-only', 'HEAD', 'origin/main').out.split('\n')
  const deps = changed.includes('package-lock.json') || changed.includes('package.json')
  log(`updating ${local.slice(0, 7)} -> ${remote.slice(0, 7)}: ${subject}`)

  // Not running — stopped on purpose, or not started yet. Bring the code up to
  // date but leave starting him to whoever stopped him, or the next login.
  const running = Boolean(h)

  if (running) await stopJarvis()
  if (dirty.includes('package-lock.json')) git('checkout', '--', 'package-lock.json')
  const merged = git('merge', '--ff-only', '--quiet', 'origin/main')
  if (!merged.ok) {
    log(`fast-forward failed: ${merged.err}`)
    if (running) await startJarvis()
    return
  }
  // A failed install does not stop here: the start below fails its health
  // check, and the rollback puts the previous version and its modules back.
  if (deps) installDeps()
  log('starting')

  if (!running) {
    log(`updated to ${remote.slice(0, 7)} (he was not running; it applies when he next starts)`)
    writeState({ waiting: null, current: remote, last: { from: local, to: remote, subject, at: new Date().toISOString() } })
    return
  }

  if (await startJarvis()) {
    log(`updated to ${remote.slice(0, 7)}`)
    writeState({ waiting: null, current: remote, last: { from: local, to: remote, subject, at: new Date().toISOString() } })
    notify(`Updated: ${subject}`)
    return
  }

  // --- roll back -------------------------------------------------------------
  log(`${remote.slice(0, 7)} did not start; going back to ${local.slice(0, 7)}`)
  await stopJarvis()
  git('reset', '--hard', '--quiet', local)
  if (deps) installDeps()
  const back = await startJarvis()
  writeState({ skip: remote, waiting: { sha: remote, reason: `${remote.slice(0, 7)} failed to start; kept ${local.slice(0, 7)}` } })
  notify(
    back
      ? `The latest update would not start, so the previous version is back. Details: npm run autostart:status`
      : 'The update failed and the previous version did not start either. Run: npm run autostart:status',
  )
}

main()
  .catch((err) => log(`update check failed: ${err?.stack ?? err}`))
  .finally(() => {
    dropLock()
    // A stray marker would suppress opening the page at the next real login.
    if (existsSync(SKIP_OPEN) && Date.now() - statSync(SKIP_OPEN).mtimeMs > 10 * 60_000) rmSync(SKIP_OPEN, { force: true })
  })
