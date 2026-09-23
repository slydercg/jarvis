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

/** ElevenLabs puts the reason in `detail`, in one of two shapes. */
const detailOf = (data) => {
  const d = data?.detail
  if (typeof d === 'string') return { text: d, message: d }
  const code = `${d?.code ?? ''} ${d?.status ?? ''} ${d?.type ?? ''}`
  return { text: `${code} ${d?.message ?? ''}`, message: d?.message ?? '' }
}
const isInvalid = (status, d) =>
  /invalid_api_key/i.test(d.text) || (status === 401 && !/missing_permission/i.test(d.text))
const isMissingPermission = (d) => /missing_permission/i.test(d.text)

/**
 * Ask ElevenLabs about a key.
 *
 * `ok` means it can do what he needs; `voices` is the account's voices when
 * the key may list them, else null. This used to treat every 401 as a wrong
 * key — but a key created without the Voices permission also gets a 401
 * (`missing_permissions`) from the voice list, so perfectly good keys were
 * refused. Now a key that cannot list voices is tested on what matters, one
 * tiny text-to-speech request, and ElevenLabs' own words are passed on when
 * it is refused.
 */
export async function checkElevenKey(key) {
  const call = (url, init = {}) =>
    fetch(url, {
      ...init,
      headers: { 'xi-api-key': key, ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(15_000),
    })

  let res
  try {
    res = await call('https://api.elevenlabs.io/v1/voices')
  } catch (err) {
    return { ok: false, reason: `Couldn't reach ElevenLabs (${err.message}).` }
  }
  const data = await res.json().catch(() => ({}))
  const d = detailOf(data)

  if (res.ok) {
    const voices = (data.voices ?? []).map((v) => ({
      id: v.voice_id,
      name: v.name,
      category: v.category ?? '',
      accent: v.labels?.accent ?? '',
      gender: v.labels?.gender ?? '',
    }))
    return { ok: true, voices }
  }
  if (isInvalid(res.status, d) && !isMissingPermission(d)) {
    return {
      ok: false,
      reason: `ElevenLabs says the key is invalid${d.message ? ` ("${d.message}")` : ''}. Check it was copied in full.`,
    }
  }
  if (!isMissingPermission(d)) {
    return { ok: false, reason: `ElevenLabs answered ${res.status}${d.message ? `: ${d.message}` : ''}.` }
  }

  // A real key that may not list voices. Can it speak? That is what he needs.
  let tts
  try {
    tts = await call(
      'https://api.elevenlabs.io/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb?output_format=mp3_22050_32',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'Hi.', model_id: 'eleven_flash_v2_5' }),
      },
    )
  } catch (err) {
    return { ok: false, reason: `Couldn't reach ElevenLabs (${err.message}).` }
  }
  if (tts.ok) {
    await tts.arrayBuffer().catch(() => {})
    return {
      ok: true,
      voices: null,
      note:
        'Saved. This key can speak but not list voices, so he uses the default voice. ' +
        'To choose one, edit the key at elevenlabs.io and allow Voices → Read.',
    }
  }
  const td = detailOf(await tts.json().catch(() => ({})))
  if (isMissingPermission(td)) {
    return {
      ok: false,
      reason:
        "That key is valid, but it isn't allowed to use Text to Speech. At elevenlabs.io → " +
        'Developers → API Keys, edit it and allow Text to Speech, Speech to Text and Voices → Read.',
    }
  }
  return {
    ok: false,
    reason: `ElevenLabs refused a test sentence (${tts.status}${td.message ? `: ${td.message}` : ''}).`,
  }
}

/** The running code's commit and date, for the settings panel. */
export const VERSION = (() => {
  const r = spawnSync('git', ['log', '-1', '--format=%h %cs'], { cwd: ROOT, encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : 'unknown'
})()
