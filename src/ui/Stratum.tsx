import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useStore } from '../store'
import { sendStratum } from '../lib/brain'
import type { StratumItem } from '../lib/bridge'
import { AlertItems } from './AlertStack'
import { LABELS } from './alertLabels'

/**
 * The review column, on the right: everything that asked for attention and is
 * not dealt with yet.
 *
 * Alert cards come and go; this is where they settle. Needs-you first (amber
 * marks the ones he has not looked at), then what is snoozed, then what was
 * done this week, folded away. Each row can be marked done or put off, and a
 * ticket key opens the ticket. The tab stays at the bottom right with a count
 * even when the column is closed, so nothing waiting is ever out of sight.
 *
 * The state lives on the bridge (bridge/stratum.mjs), so it survives reloads
 * and restarts; this only draws it and sends his decisions back.
 */
export function Stratum() {
  const items = useStore((s) => s.stratum)
  const open = useStore((s) => s.stratumOpen)
  const setOpen = useStore((s) => s.setStratumOpen)
  const [showDone, setShowDone] = useState(false)
  const [, tick] = useState(0)

  const waiting = items.filter((i) => i.state === 'open')
  const snoozed = items.filter((i) => i.state === 'snoozed')
  const done = items.filter((i) => i.state === 'done')
  const unseen = waiting.filter((i) => !i.seen).length

  // The layout makes room for the column (index.css) and the alert cards
  // step aside while it is open — everything on them is in here.
  useEffect(() => {
    document.documentElement.dataset.stratum = open ? 'open' : 'closed'
  }, [open])

  // Looking at the column is seeing what is on it.
  useEffect(() => {
    if (open && unseen) sendStratum('seen')
  }, [open, unseen])

  // Keep "12 min ago" and snooze times honest.
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 30_000)
    return () => clearInterval(id)
  }, [])

  return (
    <>
      <button
        type="button"
        className={`stratum-tab${waiting.length ? ' has-waiting' : ''}${unseen ? ' has-unseen' : ''}`}
        aria-expanded={open}
        aria-controls="stratum"
        onClick={() => setOpen(!open)}
        title="Your review list (L)"
      >
        <span className="stratum-tab-label">Review</span>
        <span className="stratum-count" aria-label={`${waiting.length} waiting`}>
          {waiting.length}
        </span>
      </button>

      <AnimatePresence>
        {open && (
          <motion.aside
            id="stratum"
            className="stratum"
            aria-label="Review list"
            initial={{ opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 24 }}
            transition={{ duration: 0.22, ease: 'easeOut' }}
          >
            <header className="stratum-head">
              <h2>Review</h2>
              <span className="stratum-sub">
                {waiting.length ? `${waiting.length} waiting on you` : 'Nothing waiting'}
              </span>
              <button type="button" className="stratum-close" aria-label="Close review list" onClick={() => setOpen(false)}>
                ×
              </button>
            </header>

            <div className="stratum-body">
              {!waiting.length && !snoozed.length && (
                <p className="stratum-empty">
                  All clear. Anything Jarvis raises lands here until you deal with it. Say “remind me to…” to add
                  your own.
                </p>
              )}
              {waiting.length > 0 && (
                <ul className="stratum-list" aria-label="Waiting on you">
                  {waiting.map((i) => (
                    <Row key={i.id} item={i} />
                  ))}
                </ul>
              )}
              {snoozed.length > 0 && (
                <>
                  <h3 className="stratum-section">Later</h3>
                  <ul className="stratum-list" aria-label="Snoozed">
                    {snoozed.map((i) => (
                      <Row key={i.id} item={i} />
                    ))}
                  </ul>
                </>
              )}
              {done.length > 0 && (
                <>
                  <button type="button" className="stratum-section stratum-fold" onClick={() => setShowDone(!showDone)}>
                    Done this week · {done.length} {showDone ? '▾' : '▸'}
                  </button>
                  {showDone && (
                    <ul className="stratum-list stratum-done" aria-label="Done">
                      {done.map((i) => (
                        <Row key={i.id} item={i} />
                      ))}
                    </ul>
                  )}
                </>
              )}
            </div>
          </motion.aside>
        )}
      </AnimatePresence>
    </>
  )
}

function Row({ item: i }: { item: StratumItem }) {
  const [later, setLater] = useState(false)
  const kind = i.label || LABELS[i.kind] || 'Alert'
  const asks = i.state === 'open' && (i.kind === 'portfolio' || i.kind === 'promise' || i.kind === 'mail' || i.kind === 'reminder')
  return (
    <li className={`stratum-row stratum-${i.state}${asks ? ' asks' : ''}${i.state === 'open' && !i.seen ? ' unseen' : ''}`}>
      <div className="stratum-row-head">
        <span className="stratum-kind">{kind}</span>
        <span className="stratum-when">{i.state === 'snoozed' && i.until ? `back ${clock(i.until)}` : ago(i.at)}</span>
      </div>
      <div className="stratum-title">{i.title}</div>
      {i.detail && <div className="stratum-detail">{i.detail}</div>}
      {i.items && i.items.length > 0 && <AlertItems items={i.items} label="Items" limit={3} />}
      <div className="stratum-acts">
        {i.state === 'done' ? (
          <button type="button" onClick={() => sendStratum('open', i.id)}>
            Reopen
          </button>
        ) : (
          <>
            <button type="button" className="primary" onClick={() => sendStratum('done', i.id)}>
              Done
            </button>
            {later ? (
              <>
                <button type="button" onClick={() => sendStratum('snooze', i.id, 'in 1 hour')}>
                  1 hour
                </button>
                <button type="button" onClick={() => sendStratum('snooze', i.id, 'this afternoon')}>
                  This afternoon
                </button>
                <button type="button" onClick={() => sendStratum('snooze', i.id, 'tomorrow')}>
                  Tomorrow
                </button>
              </>
            ) : (
              <button type="button" onClick={() => setLater(true)}>
                Later…
              </button>
            )}
          </>
        )}
      </div>
    </li>
  )
}

function ago(at: number): string {
  const mins = Math.round((Date.now() - at) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.round(hours / 24)
  return days === 1 ? 'yesterday' : `${days} days ago`
}

function clock(t: number): string {
  const d = new Date(t)
  const sameDay = d.toDateString() === new Date().toDateString()
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return sameDay ? `at ${time}` : `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`
}
