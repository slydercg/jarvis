import { query } from '@anthropic-ai/claude-agent-sdk'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { JARVIS_HOME } from './memory.mjs'

/**
 * Which claude.ai connectors JARVIS may use.
 *
 * Every connector on the claude.ai account reaches every session this bridge
 * starts — trading, payments, hosting, SMS — whether or not a voice assistant
 * has any business with them. Each one is more surface for an instruction
 * planted in an email or a web page to reach for. JARVIS_CONNECTORS narrows
 * that to a named list; unset, nothing changes and every connector loads.
 *
 * Two layers, because they fail differently:
 *
 *   - decideTool denies any tool on a connector not on the list. This always
 *     holds, including for a connector added to the account since the last
 *     run, and it covers the background sessions through readOnlyTool.
 *   - disallowedTools takes the rest out of the model's view entirely, so it
 *     does not reach for them in the first place. That needs the connector
 *     names before a session starts, and the SDK only learns them a few
 *     seconds after one does — so the names are discovered once at startup,
 *     refreshed from every live session, and kept in ~/.jarvis/connectors.json.
 *
 * Local MCP servers from ~/.claude.json and the bridge's own in-process
 * servers are not connectors and are never affected.
 */

const CACHE = join(JARVIS_HOME, 'connectors.json')

/** `Google Calendar`, `claude.ai Google Calendar`, `claude_ai_Google_Calendar` -> `google_calendar`. */
export const connectorKey = (name) =>
  String(name)
    .replace(/^claude\.ai /i, '')
    .replace(/^claude_ai_/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')

/** The `mcp__<server>` half the CLI builds from a server name: `claude.ai Gmail` -> `claude_ai_Gmail`. */
const toolServer = (serverName) => String(serverName).replace(/[^a-zA-Z0-9_-]/g, '_')

const isConnectorName = (name) => /^claude\.ai /.test(name)

/** null when unset (everything allowed), otherwise a Set of connector keys. */
export function parseAllowlist(raw) {
  const names = String(raw ?? '')
    .split(',')
    .map((s) => connectorKey(s.trim()))
    .filter(Boolean)
  return names.length ? new Set(names) : null
}

const ALLOW = parseAllowlist(process.env.JARVIS_CONNECTORS)

/** Server names (`claude.ai Gmail`, …) last seen on the account. */
let known = loadKnown()

function loadKnown() {
  try {
    const names = JSON.parse(readFileSync(CACHE, 'utf8'))?.connectors
    return Array.isArray(names) ? names.filter(isConnectorName) : []
  } catch {
    return []
  }
}

/** Keep the connector names from a status list, for the next session's disallowedTools. */
export function recordConnectors(statuses) {
  const names = [...new Set((statuses ?? []).map((s) => s.name).filter(isConnectorName))].sort()
  if (!names.length || JSON.stringify(names) === JSON.stringify(known)) return
  known = names
  try {
    mkdirSync(JARVIS_HOME, { recursive: true })
    writeFileSync(CACHE, JSON.stringify({ connectors: names }, null, 2) + '\n')
  } catch (err) {
    console.warn(`[jarvis] could not save the connector list: ${err.message}`)
  }
}

/** Is this claude.ai server name (`claude.ai Robinhood`) outside the allowlist? */
export function connectorBlocked(serverName, allow = ALLOW) {
  return Boolean(allow) && isConnectorName(serverName) && !allow.has(connectorKey(serverName))
}

/**
 * Is this tool call on a connector outside the allowlist? Known names are
 * matched by exact prefix, because a name like `Atlassian Rovo (2)` becomes
 * `claude_ai_Atlassian_Rovo__2_` and cannot be split back apart on `__`.
 * Longest first, since `Atlassian Rovo`'s prefix is also the start of that one.
 */
export function toolBlocked(toolName, allow = ALLOW, names = known) {
  if (!allow || !toolName.startsWith('mcp__claude_ai_')) return false
  const longestFirst = [...names].sort((a, b) => toolServer(b).length - toolServer(a).length)
  for (const name of longestFirst) {
    if (toolName.startsWith(`mcp__${toolServer(name)}__`)) return !allow.has(connectorKey(name))
  }
  return !allow.has(connectorKey(toolName.split('__')[1]))
}

/**
 * The allowlist with some connectors added, for one job that needs a connector
 * the conversation is kept away from (the holdings card reads Robinhood).
 * Null stays null: with no allowlist, everything is already allowed.
 */
export const allowWith = (keys, allow = ALLOW) => (allow ? new Set([...allow, ...keys.map(connectorKey)]) : null)

/** For a session's options: every known connector not on the allowlist, as a whole-server rule. */
export function connectorDenylist(allow = ALLOW, names = known) {
  if (!allow) return []
  return names.filter((n) => !allow.has(connectorKey(n))).map((n) => `mcp__${toolServer(n)}`)
}

/**
 * Would claude.ai connectors load at all? Not when the CLI bills an API key,
 * and not when they are switched off; then there is nothing to wait for.
 */
export const connectorsExpected = (env = process.env) =>
  !env.ANTHROPIC_API_KEY && env.ENABLE_CLAUDEAI_MCP_SERVERS !== '0'

/**
 * Has a session's server list settled enough to report?
 *
 * Connectors are not merely 'pending' at first: for a few seconds after the
 * CLI starts they are absent from the list altogether, so a list with nothing
 * pending can still be missing all of them. Reporting then is what printed
 * "0 MCP servers available" on a working account, and stopped the rail from
 * ever filling in. So a list with no connectors in it is only final once the
 * grace period is over, or when none were ever going to load.
 */
export function statusSettled(all, { expected = connectorsExpected(), now = Date.now(), graceUntil = 0 } = {}) {
  if (all.some((s) => s.status === 'pending')) return false
  if (!expected || all.some((s) => isConnectorName(s.name))) return true
  return now >= graceUntil
}

/** A one-line summary for the startup banner. */
export function connectorsSummary() {
  if (!ALLOW) return 'connectors: all claude.ai connectors (set JARVIS_CONNECTORS to narrow them)'
  const off = known.filter((n) => !ALLOW.has(connectorKey(n))).length
  return `connectors: limited to ${[...ALLOW].join(', ')}` + (known.length ? ` (${off} others left out)` : '')
}

/**
 * Learn the account's connector names before the first conversation, so even
 * that one starts without the ones left out. No message is ever sent, so no
 * model turn runs: the session only exists long enough to report its servers.
 * Only when an allowlist is set; otherwise the names are never needed.
 */
export async function discoverConnectors({ timeoutMs = 45_000 } = {}) {
  if (!ALLOW) return
  let release
  const hold = new Promise((r) => (release = r))
  // A prompt stream that ends without ever producing a message.
  const silent = { [Symbol.asyncIterator]: () => ({ next: () => hold.then(() => ({ done: true, value: undefined })) }) }
  const session = query({
    prompt: silent,
    options: { cwd: homedir(), settingSources: [], strictMcpConfig: false, permissionMode: 'default' },
  })
  const deadline = Date.now() + timeoutMs
  try {
    while (Date.now() < deadline) {
      const all = await session.mcpServerStatus().catch(() => [])
      const connectors = all.filter((s) => isConnectorName(s.name))
      if (connectors.length && !connectors.some((s) => s.status === 'pending')) {
        recordConnectors(all)
        return
      }
      await new Promise((r) => setTimeout(r, 1500))
    }
  } finally {
    release()
    session.close?.()
  }
}
