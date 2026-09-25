import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.JARVIS_HOME = mkdtempSync(join(tmpdir(), 'jarvis-holdings-'))
const h = await import('../bridge/holdings.mjs')
const { allowWith, connectorDenylist } = await import('../bridge/connectors.mjs')

test('the job may read balances and positions on Robinhood, and nothing else', () => {
  for (const ok of ['get_accounts', 'get_portfolio', 'get_equity_positions', 'get_crypto_positions']) {
    assert.equal(h.HOLDINGS_TOOLS.test(`mcp__claude_ai_Robinhood__${ok}`), true, ok)
  }
  for (const no of [
    'mcp__claude_ai_Robinhood__place_equity_order',
    'mcp__claude_ai_Robinhood__cancel_crypto_order',
    'mcp__claude_ai_Robinhood__exercise_option',
    'mcp__claude_ai_Robinhood__add_to_watchlist',
    'mcp__claude_ai_Robinhood__get_accounts_and_place_order',
    'mcp__claude_ai_Gmail__get_accounts',
    'mcp__protective__protective_get_inbox',
  ]) {
    assert.equal(h.HOLDINGS_TOOLS.test(no), false, no)
  }
})

test('Robinhood is let through for this job alone, on top of his connector list', () => {
  const allow = new Set(['gmail', 'microsoft_365'])
  const names = ['claude.ai Gmail', 'claude.ai Robinhood', 'claude.ai PayPal']
  assert.deepEqual(connectorDenylist(allow, names), ['mcp__claude_ai_Robinhood', 'mcp__claude_ai_PayPal'])
  assert.deepEqual(connectorDenylist(allowWith(['robinhood'], allow), names), ['mcp__claude_ai_PayPal'])
  assert.equal(allowWith(['robinhood'], null), null)
})

test('a figure the model returns is kept only if Robinhood actually sent it', () => {
  const raw = [
    JSON.stringify({ results: [{ account_number: '5QX12349876', type: 'individual', portfolio: { equity: '52,310.44', extended_hours_equity: '52310.44' } }] }),
    '{"account":"IRA","total_equity":"18200.00","cash":"412.5","day_change":"-150.25"}',
  ]
  const answer = {
    accounts: [
      { name: 'Individual', type: 'individual', last4: '5QX12349876', value: 52310.44, cash: 999.99, dayChange: 310.1 },
      { name: 'Roth IRA', type: 'ira_roth', last4: '9876', value: '18,200.00', cash: '412.50', dayChange: -150.25 },
      { name: 'Made up', type: 'x', last4: '0000', value: 1000000, cash: null, dayChange: null },
    ],
  }
  const view = h.verify(answer, raw, 1)
  assert.deepEqual(view.accounts[0], {
    name: 'Individual', type: 'individual', last4: '9876', value: 52310.44, cash: null, dayChange: null, dayChangePct: null,
  })
  assert.equal(view.accounts[1].value, 18200)
  assert.equal(view.accounts[1].cash, 412.5)
  assert.equal(view.accounts[1].dayChange, -150.25)
  // (−150.25 on a close of 18,350.25)
  assert.equal(view.accounts[1].dayChangePct, -0.82)
  assert.equal(view.accounts[2].value, null)
  assert.equal(view.dropped, 3)
  // Totals are summed here, and say when a part is missing.
  assert.equal(view.totals.value, 70510.44)
  assert.equal(view.totals.valueComplete, false)
  assert.equal(view.totals.dayChangeComplete, false)
  assert.equal(view.totals.dayChangePct, null)
})

test('totals over complete accounts, with the day as a percent of yesterday', () => {
  const t = h.totals([
    { value: 1100, dayChange: 100 },
    { value: 900, dayChange: -50 },
  ])
  assert.deepEqual(t, { value: 2000, valueComplete: true, dayChange: 50, dayChangeComplete: true, dayChangePct: 2.56 })
})

test('off unless asked for; fresh figures are shown without reading Robinhood again', () => {
  const sent = []
  delete process.env.JARVIS_HOLDINGS
  h.holdingsOnOpen({}, (f) => sent.push(f))
  assert.equal(sent.length, 0)

  process.env.JARVIS_HOLDINGS = 'robinhood'
  const view = { at: Date.now() - 60_000, accounts: [{ name: 'Individual', last4: '9876', value: 10, cash: null, dayChange: null, dayChangePct: null }], totals: h.totals([{ value: 10, dayChange: null }]) }
  writeFileSync(join(process.env.JARVIS_HOME, 'holdings.json'), JSON.stringify(view))
  // No deps a read could use: this passes only if nothing is read.
  h.holdingsOnOpen({}, (f) => sent.push(f))
  assert.equal(sent.length, 1)
  assert.equal(sent[0].type, 'holdings')
  assert.equal(sent[0].holdings.accounts[0].value, 10)
  assert.equal(sent[0].holdings.refreshing, undefined)
  delete process.env.JARVIS_HOLDINGS
})
