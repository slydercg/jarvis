/**
 * Add or replace one key in the flows file, and change nothing else.
 *
 *   npm run flows:add -- <key>                     the flow URL on the clipboard
 *   npm run flows:add -- <key> --from <file>       that key's value from another
 *                                                   file (a backup), as it is there
 *   ... --file <path>                               a different flows file than the
 *                                                   one Jarvis reads
 *
 * The flows file (the daily briefing's pa_endpoints.json in OneDrive) is
 * shared with the briefing and the SCG Agent Office, which read keys Jarvis
 * doesn't. Rewriting it whole can drop one of theirs; this sets one key and
 * keeps the rest of the file as it was (bridge/flowsfile.mjs). Values are
 * never printed: they are credentials. The clipboard is cleared after.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { resolve } from 'node:path'
import '../bridge/env.mjs'
import { parseFlowsText, rememberKeys, withKey, writeKeepingMode } from '../bridge/flowsfile.mjs'
import { flowFileCandidates, loadFlows, validFlowUrl } from '../bridge/protective.mjs'

const args = process.argv.slice(2)
const opt = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const key = args.find((a, i) => !a.startsWith('--') && !['--from', '--file'].includes(args[i - 1]))
const fail = (msg) => {
  console.log(`\n  ${msg}\n`)
  process.exit(1)
}
const short = (p) => p.replace(homedir(), '~')
const expand = (p) => resolve(p.replace(/^~(?=$|\/)/, homedir()))

if (!key) fail('Say which key: npm run flows:add -- <key>   (e.g. sent_email)')

const target = opt('--file')
  ? expand(opt('--file'))
  : (loadFlows().path ?? flowFileCandidates().find((p) => existsSync(p)))
if (!target || !existsSync(target)) fail('No flows file found. Pass one with --file <path>.')

let value
const from = opt('--from')
if (from) {
  let source
  try {
    source = parseFlowsText(readFileSync(expand(from), 'utf8')).data
  } catch (err) {
    fail(`${short(expand(from))} ${err.code === 'ENOENT' ? 'is not there' : err.message}.`)
  }
  if (!(key in source)) fail(`${short(expand(from))} has no "${key}". Its keys: ${Object.keys(source).sort().join(', ')}`)
  value = source[key]
} else {
  if (platform() !== 'darwin') fail('Reading the clipboard needs macOS. Use --from <file> instead.')
  value = execFileSync('pbpaste', { encoding: 'utf8' }).trim()
  if (!(validFlowUrl(value) && value.includes('sig='))) {
    fail('The clipboard does not hold a Power Automate flow URL. Copy the HTTP URL from the flow\'s trigger and run this again.')
  }
}

let text
try {
  text = readFileSync(target, 'utf8')
  parseFlowsText(text)
} catch {
  // Never write over a file that can't be read: what is in it is unknown.
  fail(`${short(target)} is not valid JSON, so it was left alone. Restore it from OneDrive's version history first.`)
}
const replaced = key in parseFlowsText(text).data
const next = withKey(text, key, value)
writeKeepingMode(target, next)
const keys = Object.keys(parseFlowsText(next).data)
rememberKeys(target, keys)
if (!from) execFileSync('pbcopy', { input: ' ' })

console.log(`\n  ${replaced ? 'Replaced' : 'Added'} "${key}" in ${short(target)}; nothing else changed.`)
console.log(`  Keys now: ${[...keys].sort().join(', ')}\n`)
