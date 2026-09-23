import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useStore, UNDO_MS } from '../store'

/**
 * The yes-or-no for an action that changes something.
 *
 * Shown while the bridge holds a tool call open waiting on the user. It says
 * which service, what action and the few fields that tell you it is the right
 * one, and it can be answered three ways that all land in the same place: say
 * yes or no, type it in the command bar, or press a button here. A yes then
 * counts down a short undo window before the action actually runs — the
 * difference between a misheard "yes" and an email that cannot be unsent.
 */
export function ConfirmCard() {
  const confirm = useStore((s) => s.confirm)
  const [, tick] = useState(0)

  // Repaint the countdown while the undo window is open.
  useEffect(() => {
    if (confirm?.stage !== 'undo') return
    const id = setInterval(() => tick((n) => n + 1), 100)
    return () => clearInterval(id)
  }, [confirm?.stage])

  const left = confirm?.stage === 'undo' ? Math.max(0, confirm.until - Date.now()) : 0

  return (
    <AnimatePresence>
      {confirm && (
        <motion.div
          key="confirm"
          className={`confirm ${confirm.money ? 'confirm-money' : ''}`}
          role="alertdialog"
          aria-labelledby="confirm-title"
          aria-describedby="confirm-details"
          initial={{ opacity: 0, x: '-50%', y: -10 }}
          animate={{ opacity: 1, x: '-50%', y: 0 }}
          exit={{ opacity: 0, x: '-50%', y: -6 }}
          transition={{ duration: 0.2, ease: 'easeOut' }}
        >
          <div className="confirm-head">
            <span className="confirm-kicker">
              {confirm.stage === 'ask' ? 'Confirm action' : 'Going ahead'}
            </span>
            <span className="confirm-service">{confirm.service}</span>
          </div>
          <div id="confirm-title" className="confirm-action">
            {confirm.action}
          </div>
          {confirm.details.length > 0 && (
            <dl id="confirm-details" className="confirm-details">
              {confirm.details.map((d) => (
                <div key={d.label} className="confirm-row">
                  <dt>{d.label}</dt>
                  <dd>{d.value}</dd>
                </div>
              ))}
            </dl>
          )}

          {confirm.stage === 'ask' ? (
            <div className="confirm-actions">
              <button type="button" className="confirm-yes" onClick={() => confirm.answer(true)}>
                Yes, do it
              </button>
              <button type="button" className="confirm-no" onClick={() => confirm.answer(false)}>
                No
              </button>
              <span className="confirm-hint">or say “yes” / “no”</span>
            </div>
          ) : (
            <div className="confirm-actions">
              <div
                className="confirm-timer"
                role="progressbar"
                aria-label="Time left to undo"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round((left / UNDO_MS) * 100)}
              >
                <div className="confirm-timer-fill" style={{ transform: `scaleX(${left / UNDO_MS})` }} />
              </div>
              <button type="button" className="confirm-no" onClick={() => confirm.answer(false)}>
                Undo
              </button>
              <span className="confirm-hint">{Math.ceil(left / 1000)}s · or say “cancel”</span>
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  )
}
