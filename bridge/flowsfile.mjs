import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, join } from 'node:path'
import { JARVIS_HOME } from './memory.mjs'

/**
 * The flows file is shared. The daily briefing's pa_endpoints.json in
 * OneDrive feeds Jarvis, the briefing and the SCG Agent Office, and each of
 * them reads keys the others don't. Editing it by rewriting the whole file
 * (PowerShell's ConvertTo-Json, a hand edit) can drop a key one of them
 * needs, and nothing says so: the reader that lost it just stops working.
 *
 * This keeps the key names (never the values: they are credentials) from the
 * last time the file was checked, so a key that has gone can be named; and
 * it changes one key at a time, leaving the rest of the file as it was.
 */

const SNAPSHOT = join(JARVIS_HOME, 'flows-keys.json')
const KEY = /^[A-Za-z0-9_.-]{1,64}$/

/** A file's text as JSON, a byte-order mark allowed. Throws a plain message. */
export function parseFlowsText(text) {
  const bom = text.charCodeAt(0) === 0xfeff
  try {
    const data = JSON.parse(bom ? text.slice(1) : text)
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('not an object')
    return { data, bom }
  } catch {
    throw new Error('is not valid JSON')
  }
}

/** The indent the file already uses, so a change doesn't reformat it. */
export function indentOf(text) {
  const m = text.match(/\n([ \t]+)"/)
  return m ? m[1] : '  '
}

/**
 * The file with one key set (or replaced in place), everything else as it
 * was: same key order, same indent, same trailing newline, same BOM.
 */
export function withKey(text, key, value) {
  if (!KEY.test(key)) throw new Error('that is not a key name')
  const { data, bom } = parseFlowsText(text)
  data[key] = value
  const out = JSON.stringify(data, null, indentOf(text)) + (text.endsWith('\n') ? '\n' : '')
  return (bom ? '﻿' : '') + out
}

/** Write next to the file and rename over it: a reader never sees half a file. */
export function writeKeepingMode(path, text) {
  let mode = 0o600
  try {
    mode = statSync(path).mode & 0o777
  } catch {
    // New file: private.
  }
  const tmp = join(dirname(path), `.${Date.now()}.flows.tmp`)
  writeFileSync(tmp, text, { mode })
  try {
    chmodSync(tmp, mode)
  } catch {
    // Mode set on create already.
  }
  renameSync(tmp, path)
}

/** The key names seen last time, for this file; null if never checked. */
export function lastKeys(path, snapshot = SNAPSHOT) {
  try {
    const s = JSON.parse(readFileSync(snapshot, 'utf8'))
    return s.path === path && Array.isArray(s.keys) ? s.keys : null
  } catch {
    return null
  }
}

export function rememberKeys(path, keys, snapshot = SNAPSHOT) {
  mkdirSync(dirname(snapshot), { recursive: true })
  writeFileSync(snapshot, JSON.stringify({ path, keys: [...keys].sort(), at: new Date().toISOString() }, null, 2), { mode: 0o600 })
}

/**
 * The file, judged: valid JSON or not, and which keys have gone since it was
 * last checked. Pure apart from reading `path`; `previous` is lastKeys().
 * Returns { status, detail, fix?, keys?, missing? } for the doctor and the
 * bridge's daily check.
 */
export function judgeFlowsFile(path, previous) {
  const where = path.replace(homedir(), '~')
  if (!existsSync(path)) return { status: 'fail', detail: `${where} is not there` }
  let parsed
  try {
    parsed = parseFlowsText(readFileSync(path, 'utf8'))
  } catch (err) {
    return {
      status: 'fail',
      detail: `${where} ${err.message}`,
      fix: 'Something rewrote it badly. Restore the last good copy from OneDrive\'s version history (right-click → Version history).',
    }
  }
  const keys = Object.keys(parsed.data).sort()
  const missing = previous ? previous.filter((k) => !keys.includes(k)) : []
  if (missing.length) {
    return {
      status: 'warn',
      keys,
      missing,
      detail: `${keys.length} keys; gone since last check: ${missing.join(', ')}`,
      fix:
        'Another app reading this file may have stopped working. Put a key back from a backup with ' +
        '`npm run flows:add -- <key> --from <backup file>`.',
    }
  }
  return {
    status: 'ok',
    keys,
    missing,
    detail: `${keys.length} keys, valid JSON${parsed.bom ? ' (starts with a byte-order mark, which some readers reject)' : ''}`,
  }
}

/**
 * Keys that copies next to the file have and it doesn't: "pa_endpoints.json"
 * is checked against "pa_endpoints.before-notes.json" and the like. A key
 * dropped before anything was keeping track still shows up this way.
 * Returns [{ key, in: [file names] }], key names only.
 */
export function keysOnlyInBackups(path) {
  const dir = dirname(path)
  const stem = basename(path, extname(path))
  let live
  try {
    live = new Set(Object.keys(parseFlowsText(readFileSync(path, 'utf8')).data))
  } catch {
    return []
  }
  const found = new Map()
  let names = []
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  for (const name of names.sort()) {
    if (name === basename(path) || !name.startsWith(`${stem}.`) || !name.endsWith('.json')) continue
    let keys
    try {
      keys = Object.keys(parseFlowsText(readFileSync(join(dir, name), 'utf8')).data)
    } catch {
      continue
    }
    for (const k of keys) if (!live.has(k)) found.set(k, [...(found.get(k) ?? []), name])
  }
  return [...found].map(([key, files]) => ({ key, in: files }))
}
