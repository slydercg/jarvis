import { AnimatePresence, motion } from 'framer-motion'
import { useStore } from '../store'

/**
 * The keyboard shortcuts, on one sheet. Opened with ? (and closed with it, or
 * Esc). Everything here also works by voice or by click; the keys are for the
 * moments he would rather not talk.
 */
const GROUPS: Array<{ title: string; keys: Array<[string, string]> }> = [
  {
    title: 'Talking',
    keys: [
      ['Space', 'Talk without the wake word'],
      ['V', 'Try the next voice'],
      ['T', 'Test the speakers'],
    ],
  },
  {
    title: 'Your day',
    keys: [
      ['L', 'Open or close the review list'],
      ['H', 'Conversation history'],
      [',', 'Settings'],
      ['?', 'This sheet'],
    ],
  },
  {
    title: 'In the review list',
    keys: [
      ['↑ ↓  or  J K', 'Move between items'],
      ['Enter', 'Do the next step (reply, nudge, prep…)'],
      ['D', 'Done'],
      ['S', 'Later — back in an hour'],
      ['L  or  Esc', 'Close the list'],
    ],
  },
  {
    title: 'On screen',
    keys: [
      ['E', 'Full screen the front panel'],
      ['X', 'Close the front panel'],
      ['[  ]', 'Cycle the panels'],
      ['G', 'Hand tracking on or off'],
      ['D', 'Diagnostics'],
    ],
  },
]

export function KeysHelp() {
  const open = useStore((s) => s.keysOpen)
  const setOpen = useStore((s) => s.setKeysOpen)
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="keys-scrim"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={() => setOpen(false)}
        >
          <motion.section
            className="keys"
            role="dialog"
            aria-label="Keyboard shortcuts"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            onClick={(e) => e.stopPropagation()}
          >
            <header className="keys-head">
              <h2>Keyboard</h2>
              <button type="button" className="stratum-close" aria-label="Close" onClick={() => setOpen(false)}>
                ×
              </button>
            </header>
            <div className="keys-grid">
              {GROUPS.map((g) => (
                <div key={g.title} className="keys-group">
                  <h3>{g.title}</h3>
                  <dl>
                    {g.keys.map(([k, what]) => (
                      <div key={k + what} className="keys-row">
                        <dt>
                          <kbd>{k}</kbd>
                        </dt>
                        <dd>{what}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              ))}
            </div>
          </motion.section>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
