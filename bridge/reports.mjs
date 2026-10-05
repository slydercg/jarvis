import { mkdirSync, readdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { JARVIS_HOME } from './memory.mjs'

/**
 * "That was wrong": what happened, saved in one file.
 *
 * Every voice bug so far was found the same way: something odd happened, a
 * screenshot came in, and the cause had to be reconstructed from it. A
 * report holds what the screenshot can't show — what the microphone heard
 * and why each piece was kept or dropped (the page's trail), whether he
 * thought it was a call, the turns either side, and the bridge's own log
 * lines — so the cause can be read rather than guessed.
 *
 * Kept in ~/.jarvis/reports, the last KEEP of them. `npm run report` prints
 * the latest for pasting. Nothing leaves the Mac unless he pastes it.
 */

const DIR = join(JARVIS_HOME, 'reports')
const KEEP = 30
const LOG_LINES = 200

/**
 * Any URL loses its query string: a Power Automate flow URL carries its
 * signature there, and is a credential. The host and path are enough to read
 * a log by.
 */
export function redact(s) {
  return String(s ?? '').replace(/(https?:\/\/[^\s?"'<>]+)\?[^\s"'<>]*/g, '$1?…')
}

const lines = []
let tapped = false

/** Keep the bridge's last log lines, for the next report. Once per process. */
export function tapConsole() {
  if (tapped) return
  tapped = true
  for (const level of ['log', 'warn', 'error']) {
    const orig = console[level].bind(console)
    console[level] = (...args) => {
      try {
        const text = args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.message : JSON.stringify(a))).join(' ')
        lines.push(`${new Date().toISOString().slice(11, 19)} ${level === 'log' ? '' : `${level.toUpperCase()} `}${redact(text)}`.slice(0, 600))
        if (lines.length > LOG_LINES) lines.splice(0, lines.length - LOG_LINES)
      } catch {
        // Never let keeping a log line break logging.
      }
      orig(...args)
    }
  }
}

export function logTail() {
  return [...lines]
}

/**
 * Write one report and return its file name. `page` is what the page sent;
 * `bridge` is the bridge's half. Older reports beyond KEEP are removed.
 */
export function writeReport(page, bridge, now = new Date()) {
  mkdirSync(DIR, { recursive: true })
  const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const name = `${stamp}.json`
  const body = JSON.stringify({ at: now.toISOString(), page: page ?? {}, bridge: bridge ?? {} }, null, 2)
  writeFileSync(join(DIR, name), redact(body))
  const all = listReports()
  for (const old of all.slice(0, Math.max(0, all.length - KEEP))) rmSync(join(DIR, old), { force: true })
  return name
}

export function listReports() {
  try {
    return readdirSync(DIR).filter((f) => /^\d{4}-\d\d-\d\dT[\d-]+\.json$/.test(f)).sort()
  } catch {
    return []
  }
}

export function readReport(name) {
  return JSON.parse(readFileSync(join(DIR, name), 'utf8'))
}

export const REPORTS_DIR = DIR
