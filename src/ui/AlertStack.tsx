import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useStore, type Alert } from '../store'
import { isTicketLink } from '../lib/tickets'

const LABELS: Record<Alert['kind'], string> = {
  meeting: 'Meeting',
  mail: 'Mail',
  brief: 'Brief',
  wrap: 'Wrap-up',
  review: 'Weekly review',
  promise: 'Promise',
  portfolio: 'Portfolio',
  digest: 'While you were focused',
}

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
  const [, tick] = useState(0)

  // Keep "in 8 min" honest, and clear meetings once they are well under way.
  useEffect(() => {
    if (!alerts.length) return
    const id = setInterval(() => {
      tick((n) => n + 1)
      for (const a of useStore.getState().alerts) {
        if (a.kind === 'meeting' && a.at < Date.now() - 10 * 60_000) dismiss(a.id)
      }
    }, 20_000)
    return () => clearInterval(id)
  }, [alerts.length, dismiss])

  const focused = focus.active && focus.until
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
        {alerts.map((a) => (
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
              <ul className="alert-items" aria-label={a.kind === 'digest' ? 'Held back' : 'Items'}>
                {a.items.map((it, i) => (
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
