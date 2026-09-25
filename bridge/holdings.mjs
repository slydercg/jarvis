import { askReadOnly } from './agent.mjs'
import { readJsonFile, writeJsonFile } from './days.mjs'
import { backgroundPaused } from './spend.mjs'

/**
 * The holdings card: every Robinhood account and the total, on screen when
 * Jarvis opens.
 *
 * Robinhood is kept out of the conversation (JARVIS_CONNECTORS), and should
 * stay out: it is the one connector where a misheard sentence could place an
 * order. So this is its own read-only job, given that one connector and
 * allowed exactly the tools named in HOLDINGS_TOOLS. Every other Robinhood
 * tool, and every write of any kind, is refused, whatever the model asks for.
 *
 * The model only copies figures; it never adds them up. Each figure it
 * returns is checked against the raw text Robinhood sent back (`verify`), and
 * one that does not appear there is dropped rather than shown. The totals
 * are summed here. A wrong number on a money card is worse than a missing one.
 *
 * Off unless JARVIS_HOLDINGS=robinhood. Cached in ~/.jarvis/holdings.json and
 * refreshed when a page opens and the last read is older than
 * JARVIS_HOLDINGS_MAX_AGE_MIN (default 15), or on the card's Refresh button.
 * Paused, like the other unasked-for jobs, once the daily spend cap is hit.
 */

const FILE = 'holdings.json'
const MAX_AGE_MS = Number(process.env.JARVIS_HOLDINGS_MAX_AGE_MIN ?? 15) * 60_000

export const holdingsEnabled = () => /robinhood/i.test(process.env.JARVIS_HOLDINGS ?? '')

/** The reads this job may make on Robinhood. Nothing else there runs. */
export const HOLDINGS_TOOLS =
  /^mcp__claude_ai_Robinhood(?:[-_][0-9a-f]+)?__(get_accounts|get_portfolio|get_equity_positions|get_crypto_positions)$/

const PROMPT = `You read Robinhood balances for a dashboard. You never talk to anyone; you
return ONE JSON object and nothing else — no prose, no markdown fences.

Call get_accounts, then get_portfolio for each account (and get_crypto_positions
if the user has crypto). Do not call anything else.

Copy every figure EXACTLY as the tools returned it. Never add, subtract, round,
convert or estimate a number, and never total anything: the dashboard does
that. If a figure was not returned, use null.

Answer exactly:
{"accounts":[{"name":"<the account's nickname or type as returned, e.g. Individual, Roth IRA>",
 "type":"<brokerage type as returned, e.g. individual, ira_roth, crypto>",
 "last4":"<last 4 characters of the account number, never more>",
 "value":<total account value>,
 "cash":<cash or buying power as returned, else null>,
 "dayChange":<today's change in dollars as returned, else null>}]}`

/** Every number in the tool results, for checking the answer against. */
export function numbersIn(texts) {
  const out = new Set()
  for (const t of texts) {
    for (const m of String(t).matchAll(/-?\d[\d,]*\.?\d*/g)) {
      const n = Number(m[0].replace(/,/g, ''))
      if (Number.isFinite(n)) out.add(Math.round(n * 100))
    }
  }
  return out
}

/** A figure from the answer, kept only if Robinhood actually sent it (to the cent). */
function figure(v, seen) {
  if (v === null || v === undefined || v === '') return null
  const n = Number(String(v).replace(/[$,%\s]/g, ''))
  if (!Number.isFinite(n)) return null
  return seen.has(Math.round(n * 100)) ? n : null
}

/**
 * The model's answer, reduced to what can be trusted: known fields only, text
 * clipped, figures checked against the raw tool results, totals summed here.
 */
export function verify(answer, texts, at = Date.now()) {
  const seen = numbersIn(texts)
  const accounts = (Array.isArray(answer?.accounts) ? answer.accounts : []).slice(0, 12).map((a) => ({
    name: String(a?.name ?? 'Account').slice(0, 40),
    type: String(a?.type ?? '').slice(0, 30),
    last4: String(a?.last4 ?? '').replace(/[^A-Za-z0-9]/g, '').slice(-4),
    value: figure(a?.value, seen),
    cash: figure(a?.cash, seen),
    dayChange: figure(a?.dayChange, seen),
  })).map((a) => ({ ...a, dayChangePct: pct(a.dayChange, a.value) }))
  const dropped = (Array.isArray(answer?.accounts) ? answer.accounts : [])
    .slice(0, 12)
    .reduce((n, a, i) => n + ['value', 'cash', 'dayChange'].filter((k) => a?.[k] != null && accounts[i]?.[k] === null).length, 0)
  return { at, accounts, totals: totals(accounts), dropped }
}

/**
 * Today's move as a percent of yesterday's close, worked out here: Robinhood's
 * own percent can come as a fraction or a percent, and a card showing 0.01%
 * for a 1% day would be worse than none.
 */
const pct = (change, value) =>
  change !== null && value !== null && value - change > 0 ? Math.round((change / (value - change)) * 10000) / 100 : null

/** Summed here, never by the model. A total missing a part says so. */
export function totals(accounts) {
  const sum = (key) => {
    const parts = accounts.map((a) => a[key])
    return { value: Math.round(parts.reduce((s, v) => s + (v ?? 0), 0) * 100) / 100, complete: parts.every((v) => v !== null) }
  }
  const value = sum('value')
  const dayChange = sum('dayChange')
  const before = value.value - dayChange.value
  return {
    value: value.value,
    valueComplete: value.complete,
    dayChange: dayChange.value,
    dayChangeComplete: dayChange.complete,
    dayChangePct: dayChange.complete && before > 0 ? pct(dayChange.value, value.value) : null,
  }
}

let building = null
let lastError = ''

/** The last read, whatever its age; null before the first. */
export function cachedHoldings() {
  const saved = readJsonFile(FILE, null)
  return saved?.accounts ? { ...saved, error: lastError || undefined } : lastError ? { error: lastError } : null
}

/** Read Robinhood now (once, however many ask), save it, and return it. */
export function refreshHoldings(deps) {
  if (building) return building
  const texts = []
  building = askReadOnly(
    { ...deps, mcpServers: {} },
    {
      system: PROMPT,
      question: 'Read every Robinhood account now.',
      label: 'holdings',
      maxTurns: 12,
      timeoutMs: 2 * 60_000,
      effort: 'low',
      protectiveData: false,
      connectors: ['robinhood'],
      allowTool: (name) => HOLDINGS_TOOLS.test(name),
      onToolResult: (t) => texts.push(t),
    },
  )
    .then((answer) => {
      if (!answer?.accounts) throw new Error('Robinhood did not answer as expected')
      const view = verify(answer, texts)
      if (!view.accounts.length) throw new Error('no Robinhood accounts came back')
      if (view.dropped) console.warn(`[jarvis] holdings: ${view.dropped} figure(s) not found in what Robinhood sent, left off`)
      writeJsonFile(FILE, view)
      lastError = ''
      return view
    })
    .catch((err) => {
      lastError = err.message
      console.warn(`[jarvis] holdings: ${err.message}`)
      return cachedHoldings()
    })
    .finally(() => {
      building = null
    })
  return building
}

/**
 * A page opened: show what is known at once, and read again if it is stale.
 * `send` gets { type: 'holdings', holdings } now and again when fresh figures land.
 */
export function holdingsOnOpen(deps, send, { force = false } = {}) {
  if (!holdingsEnabled()) return
  const now = cachedHoldings()
  const stale = !now?.at || Date.now() - now.at > MAX_AGE_MS
  if (!force && (!stale || backgroundPaused())) {
    if (now) send({ type: 'holdings', holdings: now })
    return
  }
  // What is known now, marked as being read again, so the card appears at
  // once instead of after the half-minute a read takes.
  send({ type: 'holdings', holdings: { ...(now ?? {}), refreshing: true } })
  void refreshHoldings(deps).then((view) => view && send({ type: 'holdings', holdings: view }))
}
