import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { JARVIS_HOME } from './memory.mjs'

/**
 * Settings the page can change, so nobody has to open a terminal to do it.
 *
 * Two kinds, kept where they belong:
 *   - The ElevenLabs key goes in .env.local, the file the README already
 *     tells you to put it in, so the terminal and the settings panel always
 *     agree about which key is in use. The file is made readable only by you.
 *   - Everything else (the ElevenLabs voice) is in ~/.jarvis/settings.json.
 * The page never gets the key back; it only learns whether one is set.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ENV_LOCAL = join(ROOT, '.env.local')
const SETTINGS = join(JARVIS_HOME, 'settings.json')

export function readSettings() {
  try {
    return JSON.parse(readFileSync(SETTINGS, 'utf8'))
  } catch {
    return {}
  }
}

export function writeSettings(patch) {
  mkdirSync(JARVIS_HOME, { recursive: true })
  const next = { ...readSettings(), ...patch }
  writeFileSync(SETTINGS, JSON.stringify(next, null, 2))
  return next
}

/**
 * Set or remove one variable in .env.local, leaving every other line —
 * comments, blank lines, other settings — exactly as it was.
 */
export function setEnvLocal(name, value) {
  const lines = existsSync(ENV_LOCAL) ? readFileSync(ENV_LOCAL, 'utf8').split('\n') : []
  const match = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`)
  const kept = lines.filter((l) => !match.test(l))
  if (value !== null) {
    // Keep the file ending in exactly one newline after our line.
    while (kept.length && kept[kept.length - 1] === '') kept.pop()
    kept.push(`${name}=${value}`, '')
  }
  writeFileSync(ENV_LOCAL, kept.join('\n'))
  try {
    chmodSync(ENV_LOCAL, 0o600)
  } catch {
    // Not fatal; the file is still in the project folder only.
  }
}

/** Shape check before a key ever goes near the network or a file. */
export const plausibleKey = (k) => typeof k === 'string' && /^[A-Za-z0-9_-]{20,200}$/.test(k.trim())
export const plausibleVoiceId = (v) => typeof v === 'string' && /^[A-Za-z0-9]{10,40}$/.test(v)

/**
 * Ask ElevenLabs about a key. `ok` means it authenticates; `voices` is the
 * account's voices when the key may list them (a restricted key may speak and
 * transcribe without being allowed to), else null.
 */
export async function checkElevenKey(key) {
  let res
  try {
    res = await fetch('https://api.elevenlabs.io/v1/voices', {
      headers: { 'xi-api-key': key },
      signal: AbortSignal.timeout(10_000),
    })
  } catch (err) {
    return { ok: false, reason: `could not reach ElevenLabs (${err.message})` }
  }
  const data = await res.json().catch(() => ({}))
  // A wrong key comes back as 400 with code invalid_api_key, not 401.
  const code = data?.detail?.code ?? data?.detail?.status ?? ''
  if (res.status === 401 || /invalid_api_key|authentication/.test(`${code} ${data?.detail?.type ?? ''}`)) {
    return { ok: false, reason: 'ElevenLabs rejected that key — check it was copied in full.' }
  }
  // A restricted key without voices_read: it can still speak and transcribe.
  if (res.status === 403) return { ok: true, voices: null }
  if (!res.ok) return { ok: false, reason: `ElevenLabs answered ${res.status}` }
  const voices = (data.voices ?? []).map((v) => ({
    id: v.voice_id,
    name: v.name,
    category: v.category ?? '',
    accent: v.labels?.accent ?? '',
    gender: v.labels?.gender ?? '',
  }))
  return { ok: true, voices }
}

/** The running code's commit and date, for the settings panel. */
export const VERSION = (() => {
  const r = spawnSync('git', ['log', '-1', '--format=%h %cs'], { cwd: ROOT, encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : 'unknown'
})()
