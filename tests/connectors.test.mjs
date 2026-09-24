import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// A private home with a cached connector list, and an allowlist that uses the
// spoken names, spacing and case a person would type into .env.local.
const dir = mkdtempSync(join(tmpdir(), 'jarvis-conn-'))
process.env.JARVIS_HOME = dir
process.env.JARVIS_CONNECTORS = 'Gmail, google calendar ,Atlassian Rovo (2)'
const KNOWN = ['claude.ai Atlassian Rovo', 'claude.ai Atlassian Rovo (2)', 'claude.ai Gmail', 'claude.ai Google Calendar', 'claude.ai Robinhood']
writeFileSync(join(dir, 'connectors.json'), JSON.stringify({ connectors: KNOWN }))

const c = await import('../bridge/connectors.mjs')

test('names normalise the same from settings, server names and tool names', () => {
  assert.equal(c.connectorKey('Google Calendar'), 'google_calendar')
  assert.equal(c.connectorKey('claude.ai Google Calendar'), 'google_calendar')
  assert.equal(c.connectorKey('claude_ai_Google_Calendar'), 'google_calendar')
  assert.equal(c.connectorKey('claude.ai Atlassian Rovo (2)'), 'atlassian_rovo_2')
})

test('an unset or empty allowlist changes nothing', () => {
  const none = c.parseAllowlist('')
  assert.equal(none, null)
  assert.equal(c.parseAllowlist(' , '), null)
  assert.equal(c.toolBlocked('mcp__claude_ai_Robinhood__place_equity_order', none), false)
  assert.deepEqual(c.connectorDenylist(none), [])
  assert.equal(c.connectorBlocked('claude.ai Robinhood', none), false)
})

test('tools on connectors outside the list are blocked; listed ones are not', () => {
  assert.equal(c.toolBlocked('mcp__claude_ai_Robinhood__place_equity_order'), true)
  assert.equal(c.toolBlocked('mcp__claude_ai_Gmail__search_threads'), false)
  assert.equal(c.toolBlocked('mcp__claude_ai_Google_Calendar__list_events'), false)
})

test('a name that cannot be split on __ is matched by its exact prefix', () => {
  // `Atlassian Rovo (2)` is allowed and `Atlassian Rovo` is not: splitting on
  // `__` would read both as `claude_ai_Atlassian_Rovo`.
  assert.equal(c.toolBlocked('mcp__claude_ai_Atlassian_Rovo__2___search'), false)
  assert.equal(c.toolBlocked('mcp__claude_ai_Atlassian_Rovo__search'), true)
})

test('a connector added since the list was cached is still denied', () => {
  assert.equal(c.toolBlocked('mcp__claude_ai_PayPal__create_invoice'), true)
})

test('local servers and the bridge\'s own are never affected', () => {
  assert.equal(c.toolBlocked('mcp__jarvis_memory__remember'), false)
  assert.equal(c.toolBlocked('mcp__protective__protective_get_inbox'), false)
  assert.equal(c.toolBlocked('mcp__sonos__play'), false)
  assert.equal(c.connectorBlocked('protective'), false)
})

test('the denylist names each excluded connector as a whole server', () => {
  assert.deepEqual(c.connectorDenylist().sort(), ['mcp__claude_ai_Atlassian_Rovo', 'mcp__claude_ai_Robinhood'])
})

test('the rail and log drop excluded connectors by server name', () => {
  assert.equal(c.connectorBlocked('claude.ai Robinhood'), true)
  assert.equal(c.connectorBlocked('claude.ai Gmail'), false)
})

test('a new status list refreshes the cache for the next session', () => {
  c.recordConnectors([
    { name: 'claude.ai Gmail', status: 'connected' },
    { name: 'claude.ai Twilio', status: 'connected' },
    { name: 'jarvis', status: 'connected' },
  ])
  const saved = JSON.parse(readFileSync(join(dir, 'connectors.json'), 'utf8'))
  assert.deepEqual(saved.connectors, ['claude.ai Gmail', 'claude.ai Twilio'])
  assert.deepEqual(c.connectorDenylist(), ['mcp__claude_ai_Twilio'])
})

test('an empty status list never wipes the cache', () => {
  c.recordConnectors([])
  const saved = JSON.parse(readFileSync(join(dir, 'connectors.json'), 'utf8'))
  assert.equal(saved.connectors.length, 2)
})
