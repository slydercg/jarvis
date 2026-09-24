import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { pick, until } from '../lib/today'
import { COMMAND_EVENT } from './CommandBar'

/**
 * The now strip: one line across the top that answers "what's next?" without
 * asking — the next meeting and how long until it, whether he is heads-down,
 * how much is waiting on the review list, and how the portfolio stands.
 *
 * Every part is also a way in: the meeting asks who he is meeting, the count
 * opens the review list, the portfolio asks what is blocked. Nothing here is
 * new information; it is the answers he would otherwise have to ask for.
 */
export function NowStrip() {
  const today = useStore((s) => s.today)
  const focus = useStore((s) => s.focus)
  const stratum = useStore((s) => s.stratum)
  const setListOpen = useStore((s) => s.setStratumOpen)
  const listOpen = useStore((s) => s.stratumOpen)
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 20_000)
    return () => clearInterval(id)
  }, [])

  const waiting = stratum.filter((i) => i.state === 'open')
  const unseen = waiting.some((i) => !i.seen)
  const { current, next } = pick(today?.events ?? [], now)
  const meeting = current ?? next
  const portfolio = today?.portfolio
  const focusUntil = focus.active && focus.until ? Date.parse(focus.until) : null

  const ask = (text: string) => window.dispatchEvent(new CustomEvent(COMMAND_EVENT, { detail: text }))

  return (
    <nav className="now-strip" aria-label="Right now">
      {focusUntil ? (
        <span className="now-chip now-focus" title="Alerts are held except VIPs and meetings">
          <span className="now-dot" aria-hidden="true" />
          Heads-down until {clock(focusUntil)}
        </span>
      ) : null}

      {meeting ? (
        <button
          type="button"
          className={`now-chip now-meeting${meeting.clash ? ' clash' : ''}`}
          onClick={() => ask(`Who am I meeting in ${meeting.title}, and what's open with them?`)}
          title={`${meeting.title}${meeting.where ? ` · ${meeting.where}` : ''} — who's in it?`}
        >
          <span className="now-when">{current ? `Now · ends ${clock(current.end)}` : until(meeting.start, now, clock)}</span>
          <span className="now-title">{meeting.title}</span>
          {meeting.clash && <span className="now-flag">clash</span>}
        </button>
      ) : (
        today && <span className="now-chip now-quiet">No more meetings today</span>
      )}

      <button
        type="button"
        className={`now-chip now-review${waiting.length ? ' has' : ''}${unseen ? ' unseen' : ''}`}
        onClick={() => setListOpen(!listOpen)}
        title="Your review list (L)"
      >
        {waiting.length ? `${waiting.length} waiting` : 'List clear'}
      </button>

      {portfolio && (
        <button
          type="button"
          className={`now-chip now-portfolio${portfolio.blocked || portfolio.behind.length ? ' has' : ''}`}
          onClick={() => ask("What's blocked across the portfolio?")}
          title={`Portfolio, checked ${clock(portfolio.at)}`}
        >
          {portfolio.blocked ? `${portfolio.blocked} blocked` : 'Nothing blocked'}
          {portfolio.behind.length > 0 &&
            ` · ${portfolio.behind.length} sprint${portfolio.behind.length === 1 ? '' : 's'} behind`}
        </button>
      )}
    </nav>
  )
}

function clock(t: number): string {
  return new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}
