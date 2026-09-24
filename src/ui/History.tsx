import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useStore } from '../store'
import { requestTranscript } from '../lib/brain'
import type { TranscriptTurn } from '../lib/bridge'
import { dayLabel, segments } from '../lib/history'
import { LABELS } from './alertLabels'
import { NAME } from '../lib/identity'

/**
 * The history drawer: the whole of today's conversation, and any earlier day
 * still kept, searchable.
 *
 * The screen shows the last few exchanges and a spoken answer is gone once
 * said, so "what was that figure he gave me this morning?" had no answer. The
 * bridge keeps every question, answer and alert (bridge/transcript.mjs); this
 * reads them back a day at a time, and searches every kept day at once when
 * something is typed.
 *
 * Opened with H, "show my history", or the hint above the command bar.
 * Without a bridge (the direct mode) there is nothing kept on disk, so it
 * shows this page's own conversation.
 */
export function History() {
  const open = useStore((s) => s.historyOpen)
  const setOpen = useStore((s) => s.setHistoryOpen)
  const frame = useStore((s) => s.transcript)
  const turnsNow = useStore((s) => s.turns)
  const [day, setDay] = useState(() => todayKey())
  const [q, setQ] = useState('')
  const [bridged, setBridged] = useState(true)
  const list = useRef<HTMLOListElement>(null)
  const search = useRef<HTMLInputElement>(null)

  // Ask for the day (or the search) whenever it changes, and again after each
  // answer while today is on show, so the drawer keeps up with the talk.
  useEffect(() => {
    if (!open) return
    const query = q.trim()
    const t = setTimeout(
      () => setBridged(requestTranscript(query.length >= 2 ? undefined : day, query.length >= 2 ? query : undefined)),
      query ? 250 : 0,
    )
    return () => clearTimeout(t)
  }, [open, day, q, turnsNow.length])

  useEffect(() => {
    if (open) setTimeout(() => search.current?.focus(), 50)
  }, [open])

  // The conversation and the blades make room on the left while it is open
  // (index.css), as they do for the review list on the right.
  useEffect(() => {
    document.documentElement.dataset.history = open ? 'open' : 'closed'
  }, [open])

  const searching = q.trim().length >= 2
  const turns: TranscriptTurn[] = useMemo(() => {
    if (!bridged) {
      // No bridge: this page's own conversation is all there is.
      const local = turnsNow.map((t, i) => ({ at: i, role: t.role, text: t.text }) as TranscriptTurn)
      return searching ? local.filter((t) => t.text.toLowerCase().includes(q.trim().toLowerCase())) : local
    }
    if (!frame) return []
    if (searching) return frame.q === q.trim() ? frame.turns : []
    return frame.day === day && !frame.q ? frame.turns : []
  }, [bridged, frame, turnsNow, searching, q, day])

  // The newest line in view when a day opens; a search reads top-down.
  useEffect(() => {
    if (open && !searching && list.current) list.current.scrollTop = list.current.scrollHeight
  }, [open, searching, turns.length])

  const days = frame?.days?.length ? frame.days.slice(0, 7) : [todayKey()]
  const today = todayKey()

  return (
    <AnimatePresence>
      {open && (
        <motion.aside
          className="history"
          aria-label="Conversation history"
          initial={{ opacity: 0, x: -24 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -24 }}
          transition={{ duration: 0.22, ease: 'easeOut' }}
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return
            e.stopPropagation()
            // A search clears first, and the next Esc closes.
            if (q) setQ('')
            else setOpen(false)
          }}
        >
          <header className="history-head">
            <h2>History</h2>
            <input
              ref={search}
              type="search"
              className="history-search"
              placeholder="Search everything he said…"
              aria-label="Search the conversation history"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <button type="button" className="stratum-close" aria-label="Close history" onClick={() => setOpen(false)}>
              ×
            </button>
          </header>

          {!searching && bridged && (
            <nav className="history-days" aria-label="Day">
              {days.map((d) => (
                <button key={d} type="button" className={d === day ? 'on' : ''} onClick={() => setDay(d)}>
                  {dayLabel(d, today)}
                </button>
              ))}
            </nav>
          )}

          {turns.length === 0 ? (
            <p className="history-empty">
              {searching ? `Nothing said about “${q.trim()}” in the last month.` : 'Nothing said yet on this day.'}
            </p>
          ) : (
            <ol className="history-list" ref={list}>
              {turns.map((t, i) => (
                <li key={`${t.day ?? ''}${t.at}:${i}`} className={`history-turn role-${t.role}`}>
                  <div className="history-meta">
                    <span className="history-who">{who(t)}</span>
                    <span className="history-time">
                      {searching && t.day ? `${dayLabel(t.day, today)} · ` : ''}
                      {bridged ? clock(t.at) : ''}
                    </span>
                  </div>
                  <p className="history-text">
                    {segments(t.text, searching ? q : '').map((s, j) =>
                      s.hit ? <mark key={j}>{s.text}</mark> : <span key={j}>{s.text}</span>,
                    )}
                  </p>
                </li>
              ))}
            </ol>
          )}
        </motion.aside>
      )}
    </AnimatePresence>
  )
}

function who(t: TranscriptTurn): string {
  if (t.role === 'user') return 'You'
  if (t.role === 'jarvis') return NAME.charAt(0) + NAME.slice(1).toLowerCase()
  // An alert is what came in, which is not always what was said: quiet hours
  // and focus hold some back. So it is named for its kind, not for him.
  return t.kind && t.kind in LABELS ? LABELS[t.kind as keyof typeof LABELS] : 'Alert'
}

function todayKey(): string {
  return new Date().toLocaleDateString('en-CA')
}

function clock(t: number): string {
  return new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}
