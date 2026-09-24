import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useStore } from '../store'
import { sendStratum } from '../lib/brain'
import type { StratumItem } from '../lib/bridge'
import { AlertItems } from './AlertStack'
import { LABELS } from './alertLabels'
import { COMMAND_EVENT } from './CommandBar'
import { primaryAction } from '../lib/actions'

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
/** Sent by the L key: open the list and put the keyboard in it. */
export const FOCUS_LIST_EVENT = 'jarvis:focus-list'

/** The rows, in on-screen order. */
const rowsIn = (root: HTMLElement | null) => Array.from(root?.querySelectorAll<HTMLElement>('.stratum-row') ?? [])

/**
 * Page keys that still work from inside the list: Space to talk, and the keys
 * that open something else.
 */
const PASS_THROUGH = new Set([' ', 'h', '?', ','])

export function Stratum() {
  const items = useStore((s) => s.stratum)
  const aside = useRef<HTMLElement>(null)
  // Where the keyboard was when it dealt with a row (done, later, kept).
  const keyAt = useRef<number | null>(null)
  const open = useStore((s) => s.stratumOpen)
  const setOpen = useStore((s) => s.setStratumOpen)
  const [showDone, setShowDone] = useState(false)
  const [, tick] = useState(0)

  const waiting = items.filter((i) => i.state === 'open')
  const snoozed = items.filter((i) => i.state === 'snoozed')
  const done = items.filter((i) => i.state === 'done')
  const unseen = waiting.filter((i) => !i.seen).length

  // Opened by key: the first row takes the keyboard, once it has rendered.
  useEffect(() => {
    const onFocus = () => setTimeout(() => rowsIn(aside.current)[0]?.focus(), 80)
    window.addEventListener(FOCUS_LIST_EVENT, onFocus)
    return () => window.removeEventListener(FOCUS_LIST_EVENT, onFocus)
  }, [])

  /**
   * The list's own keys, while the keyboard is in it: ↑ ↓ (or J K) to move,
   * D done, S back in an hour, Enter the row's next step, L or Esc to close.
   * Handled here and stopped, so D does not also open Diagnostics.
   */
  const onKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const rows = rowsIn(aside.current)
    const row = (e.target as HTMLElement).closest<HTMLElement>('.stratum-row')
    const at = row ? rows.indexOf(row) : -1
    const item = items.find((i) => i.id === row?.dataset.id)
    const move = (to: number) => rows[Math.max(0, Math.min(rows.length - 1, to))]?.focus()
    // After a row is dealt with, the keyboard stays at the same place in the
    // list: on the next row, once the bridge's new list has been drawn (below).
    const refocus = () => {
      keyAt.current = at
    }
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
    let handled = true
    if (key === 'ArrowDown' || key === 'j') move(at + 1)
    else if (key === 'ArrowUp' || key === 'k') move(at - 1)
    else if (key === 'Escape' || key === 'l') {
      setOpen(false)
      ;(document.activeElement as HTMLElement | null)?.blur()
    } else if (key === 'd' && item && item.state !== 'done') {
      sendStratum('done', item.id)
      refocus()
    } else if (key === 's' && item && item.state !== 'done') {
      sendStratum('snooze', item.id, 'in 1 hour')
      refocus()
    } else if (key === 'Enter' && item && e.target === row) {
      const act = item.state === 'done' ? null : primaryAction(item)
      if (act?.op === 'kept') {
        sendStratum('kept', item.id)
        refocus()
      } else if (act?.ask) window.dispatchEvent(new CustomEvent(COMMAND_EVENT, { detail: act.ask }))
      else handled = false
    } else handled = false
    if (handled) {
      e.preventDefault()
      e.stopPropagation()
    } else if (key.length === 1 && !PASS_THROUGH.has(key)) {
      // Other single letters inside the list are the list's, never the page's
      // shortcuts behind it: a stray E would open a blade over the list.
      e.stopPropagation()
    }
  }

  // The row the keyboard was on moves (to Later or Done) or goes, and focus
  // would fall out of the list with it — the next D then opened Diagnostics.
  // So once the new list is drawn, the row now in that place takes it.
  useEffect(() => {
    if (keyAt.current === null) return
    const rows = rowsIn(aside.current)
    rows[Math.min(keyAt.current, rows.length - 1)]?.focus()
    keyAt.current = null
  }, [items])

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
            ref={aside}
            onKeyDown={onKeyDown}
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
  const act = i.state === 'done' ? null : primaryAction(i)
  const asks = i.state === 'open' && (i.kind === 'portfolio' || i.kind === 'promise' || i.kind === 'mail' || i.kind === 'reminder')
  return (
    <li
      className={`stratum-row stratum-${i.state}${asks ? ' asks' : ''}${i.state === 'open' && !i.seen ? ' unseen' : ''}`}
      data-id={i.id}
      tabIndex={0}
      aria-label={`${kind}: ${i.title}`}
    >
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
            {/* The obvious next step first: reply, nudge, prep, "kept it". */}
            {act && (
              <button
                type="button"
                className="primary"
                title={act.ask ? `Asks: ${act.ask}` : 'Marks the promise kept'}
                onClick={() => {
                  if (act.op === 'kept') sendStratum('kept', i.id)
                  else if (act.ask) window.dispatchEvent(new CustomEvent(COMMAND_EVENT, { detail: act.ask }))
                }}
              >
                {act.label}
              </button>
            )}
            <button type="button" className={act ? '' : 'primary'} onClick={() => sendStratum('done', i.id)}>
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
