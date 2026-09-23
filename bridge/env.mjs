/**
 * Load .env.local and .env into the bridge's environment.
 *
 * The README and .env.example both tell people to put ELEVENLABS_API_KEY in
 * .env.local, and Vite does read that file — but only for the page, and only
 * the VITE_* half of it. The bridge is a plain Node process and never looked at
 * it, so a key saved exactly where the instructions said did nothing at all.
 *
 * Imported first by server.mjs, before any module reads process.env.
 *
 * Precedence, highest first: the shell that ran `npm start`, then .env.local,
 * then .env. A variable already set is never overwritten, so an explicit
 * `JARVIS_MODEL=... npm start` still wins over the file.
 *
 * ANTHROPIC_API_KEY is deliberately refused from these files. Its presence
 * silently switches Claude Code from your subscription login to per-token API
 * billing and switches off your claude.ai connectors with it — far too large a
 * consequence to hide in a file the page also reads. Set it in the shell if you
 * truly mean it.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const REFUSED = new Set(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'])

/** Which file each variable came from, so startup logs can say so plainly. */
export const envSource = new Map()

function parse(text) {
  const out = {}
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
    if (!m) continue
    let value = m[2]
    const quoted = /^(['"])(.*)\1$/.exec(value)
    if (quoted) value = quoted[2]
    else value = value.replace(/\s+#.*$/, '')
    out[m[1]] = value
  }
  return out
}

for (const name of ['.env.local', '.env']) {
  const path = join(ROOT, name)
  if (!existsSync(path)) continue
  let vars
  try {
    vars = parse(readFileSync(path, 'utf8'))
  } catch (err) {
    console.warn(`[jarvis] could not read ${name}: ${err.message}`)
    continue
  }
  for (const [key, value] of Object.entries(vars)) {
    if (REFUSED.has(key)) {
      console.warn(
        `[jarvis] ignoring ${key} in ${name} — set it in your shell if you` +
          ' really want API billing instead of your Claude login',
      )
      continue
    }
    if (value === '' || process.env[key] !== undefined) continue
    process.env[key] = value
    envSource.set(key, name)
  }
}
