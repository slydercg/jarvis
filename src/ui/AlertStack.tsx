import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useStore, type Alert } from '../store'
import { LABELS } from './alertLabels'
import type { AlertItem } from '../lib/bridge'
import { isTicketLink } from '../lib/tickets'


/**
 * Proactive alerts, top right under the status line.
 *
 * A spoken alert is gone the moment it is said, and it may have been said to
 * an empty room; the card is what is still there when you look up. Newest
 * first, three at most, each dismissable. A meeting card counts down to its
 * start so it stays true for as long as it is on screen.
 */
export function AlertStack() {
  const alerts = useStore((s) => s.alerts)
  const muted = useStore((s) => s.alertsMuted)
  const dismiss = useStore((s) => s.dismissAlert)
  const focus = useStore((s) => s.focus)
  const listOpen = useStore((s) => s.stratumOpen)
  const [, tick] = useState(0)

  // Keep "in 8 min" honest, and clear meetings once they are well under way.
  useEffect(() => {
    if (!alerts.length) return
    const id = setInterval(() => {
      tick((n) => n + 1)
      for (const a of useStore.getState().alerts) {
        if (a.kind === 'meeting' && a.at < Date.now() - 10 * 60_000) dismiss(a.id)
        // Everything else is kept in the review list, so the card only has
        // to be seen, not kept: it steps aside after a minute and a half.
        if (a.kind !== 'meeting' && a.received < Date.now() - 90_000) dismiss(a.id)
      }
    }, 20_000)
    return () => clearInterval(id)
  }, [alerts.length, dismiss])

  const focused = focus.active && focus.until
  // With the review list open the cards would only repeat what is in it.
  if (listOpen && !muted && !focused) return null
  if (!alerts.length && !muted && !focused) return null

  return (
    <section className="alerts" aria-label="Alerts" aria-live="polite">
      {muted && <div className="alerts-muted">Alerts muted · say “resume alerts”</div>}
      {focused && (
        <div className="alerts-muted alerts-focus">
          Heads-down until {new Date(focus.until!).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
          {focus.held ? ` · ${focus.held} held` : ''}
        </div>
      )}
      <AnimatePresence initial={false}>
        {(listOpen ? [] : alerts).map((a) => (
          <motion.div
            key={a.id}
            className={`alert alert-${a.kind}${a.label === 'Overdue' ? ' alert-overdue' : ''}`}
            role="status"
            initial={{ opacity: 0, x: 16 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 16 }}
            transition={{ duration: 0.22, ease: 'easeOut' }}
          >
            <div className="alert-head">
              <span className="alert-kind">{a.label ?? LABELS[a.kind] ?? 'Alert'}</span>
              <span className="alert-when">{when(a)}</span>
              <button
                type="button"
                className="alert-dismiss"
                aria-label={`Dismiss alert: ${a.title}`}
                onClick={() => dismiss(a.id)}
              >
                ×
              </button>
            </div>
            <div className="alert-title">{a.title}</div>
            {a.detail && <div className="alert-detail">{a.detail}</div>}
            {a.prep && (
              <ul className="alert-prep" aria-label="Where things stand">
                {a.prep.points.length ? (
                  a.prep.points.map((p) => <li key={p}>{p}</li>)
                ) : (
                  <li>{a.prep.summary}</li>
                )}
              </ul>
            )}
            {a.items && a.items.length > 0 && (
              <AlertItems items={a.items} label={a.kind === 'digest' ? 'Held back' : 'Items'} />
            )}
          </motion.div>
        ))}
      </AnimatePresence>
    </section>
  )
}

function when(a: Pick<Alert, 'kind' | 'at'>): string {
  const mins = Math.round((a.at - Date.now()) / 60_000)
  if (a.kind === 'meeting') {
    if (mins > 1) return `in ${mins} min`
    if (mins >= -1) return 'now'
    return `started ${-mins} min ago`
  }
  const ago = -mins
  return ago < 1 ? 'just now' : `${ago} min ago`
}

/**
 * An alert's line items, one row each: the key (a link when it is a ticket),
 * the title, then who has it. Shared by the alert cards and the review column.
 * `limit` shows the first few with a "show all" to open the rest.
 */
export function AlertItems({ items, label, limit }: { items: AlertItem[]; label: string; limit?: number }) {
  const [all, setAll] = useState(false)
  const shown = limit && !all ? items.slice(0, limit) : items
  return (
    <>
      <ul className="alert-items" aria-label={label}>
        {shown.map((it, i) => (
          <li key={`${i}:${it.key ?? ''}:${it.title}`} className={`alert-item${it.key ? ' has-key' : ''}`}>
            {it.key &&
              (isTicketLink(it.url) ? (
                <a
                  className="alert-key ticket-link"
                  href={it.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={`Open ${it.key}`}
                >
                  {it.key}
                </a>
              ) : (
                <span className="alert-key">{it.key}</span>
              ))}
            <div className="alert-item-body">
              <div className="alert-item-title">{it.title}</div>
              {it.detail && <div className="alert-item-meta">{it.detail}</div>}
            </div>
          </li>
        ))}
      </ul>
      {limit && items.length > limit && (
        <button type="button" className="alert-more" onClick={() => setAll(!all)}>
          {all ? 'Show fewer' : `Show all ${items.length}`}
        </button>
      )}
    </>
  )
}
