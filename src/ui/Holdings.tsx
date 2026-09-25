import { memo, useEffect, useState } from 'react'
import { refreshHoldings, type HoldingsView } from '../lib/bridge'
import { age, change, money } from '../lib/holdings'

/**
 * The Robinhood holdings card: every account and the total, shown when Jarvis
 * opens (bridge/holdings.mjs). Drawn from data, never from model markup, and
 * every figure on it was found in Robinhood's own answer; one that was not is
 * shown as a dash rather than guessed.
 */
export const HoldingsCard = memo(function HoldingsCard({ view }: { view: HoldingsView }) {
  // Re-render once a minute so "12 min ago" stays true while the card is up.
  const [, tick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 60_000)
    return () => clearInterval(id)
  }, [])

  const accounts = view.accounts ?? []
  const t = view.totals
  if (!accounts.length) {
    return (
      <div className="hold">
        <p className={view.error && !view.refreshing ? 'hold-note hold-bad' : 'hold-note'}>
          {view.refreshing ? 'Reading Robinhood…' : `Couldn't read Robinhood${view.error ? `: ${view.error}` : '.'}`}
        </p>
        {!view.refreshing && <Refresh />}
      </div>
    )
  }
  const missing = accounts.filter((a) => a.value === null).length
  return (
    <div className="hold">
      <div className="hold-total">
        <span className="hold-k">Total</span>
        <span className="hold-big">{money(t?.value)}</span>
        <span className="hold-move">
          {t?.dayChangeComplete ? `${change(t.dayChange, t.dayChangePct)} today` : 'today’s move: not all accounts reported it'}
        </span>
        {missing > 0 && (
          <span className="hold-note">
            {missing} account{missing === 1 ? '' : 's'} left out of the total: its value couldn’t be checked
          </span>
        )}
      </div>
      <div className="hold-rows">
        {accounts.map((a, i) => (
          <div className="hold-row" key={`${a.last4}-${i}`}>
            <span className="hold-name">
              {a.name}
              {a.last4 && <span className="hold-last4"> ··{a.last4}</span>}
            </span>
            <span className="hold-val">{money(a.value)}</span>
            <span className="hold-sub">
              {change(a.dayChange, a.dayChangePct)}
              {a.cash !== null && ` · cash ${money(a.cash)}`}
            </span>
          </div>
        ))}
      </div>
      <div className="hold-foot">
        <span>{view.refreshing ? 'Updating…' : `As of ${age(view.at)}`}</span>
        {view.error && !view.refreshing && <span className="hold-bad">Last update failed: {view.error}</span>}
        {!view.refreshing && <Refresh />}
      </div>
    </div>
  )
})

function Refresh() {
  return (
    <button type="button" className="hold-refresh" onClick={() => refreshHoldings()}>
      Refresh
    </button>
  )
}
