import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { layoutDay } from '../lib/today'
import { COMMAND_EVENT } from './CommandBar'

/**
 * Today's meetings on one vertical track, on the left: every calendar,
 * Protective, SCG and Google, coloured by account, with clashes outlined in
 * amber and a line for now. Past meetings dim; the one under way brightens.
 * Clicking a meeting asks who is in it — the dossier.
 *
 * It takes the space the Systems list used to fill; that list folds into a
 * one-line header above it and unfolds on a click (Hud.tsx), which hides the
 * timeline while it is open. On a narrow screen there is no room beside the
 * conversation, so the timeline stays away and the now strip carries the next
 * meeting alone.
 */
const MIN_WIDTH = 1280

export function DayTimeline() {
  const today = useStore((s) => s.today)
  const systemsOpen = useStore((s) => s.systemsOpen)
  const [now, setNow] = useState(Date.now())
  const [wide, setWide] = useState(() => window.innerWidth >= MIN_WIDTH)

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 30_000)
    const onResize = () => setWide(window.innerWidth >= MIN_WIDTH)
    window.addEventListener('resize', onResize)
    return () => {
      clearInterval(tick)
      window.removeEventListener('resize', onResize)
    }
  }, [])

  const show = wide && !systemsOpen && !!today
  // The conversation and blades make room for it (index.css).
  useEffect(() => {
    document.documentElement.dataset.timeline = show ? 'on' : 'off'
  }, [show])
  if (!show || !today) return null

  const dayStart = new Date(`${today.day}T00:00:00`)
  const { from, to, frac, placed } = layoutDay(today.events, dayStart)
  const hours = Array.from({ length: to - from + 1 }, (_, i) => from + i)
  const nowFrac = frac(now)
  const nowOnTrack = now >= dayStart.getTime() + from * 3_600_000 && now <= dayStart.getTime() + to * 3_600_000
  const ask = (title: string) =>
    window.dispatchEvent(new CustomEvent(COMMAND_EVENT, { detail: `Who am I meeting in ${title}, and what's open with them?` }))

  return (
    <section className="timeline" aria-label="Today's meetings">
      <header className="timeline-head">
        <span className="timeline-title">Today</span>
        <span className="timeline-date">
          {dayStart.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}
        </span>
      </header>
      <div className="timeline-legend" aria-hidden="true">
        {(['Protective', 'SCG', 'Google'] as const)
          .filter((a) => today.events.some((e) => e.account === a))
          .map((a) => (
            <span key={a} className={`timeline-key acct-${a.toLowerCase()}`}>
              {a}
            </span>
          ))}
      </div>
      <div className="timeline-track">
        {hours.map((h) => (
          <div key={h} className="timeline-hour" style={{ top: `${((h - from) / (to - from)) * 100}%` }}>
            <span>{hourLabel(h)}</span>
          </div>
        ))}
        {placed.map(({ event: e, top, height, lane, lanes }) => {
          const past = e.end <= now
          const current = e.start <= now && now < e.end
          return (
            <button
              key={e.id}
              type="button"
              className={`timeline-event acct-${e.account.toLowerCase()}${e.clash ? ' clash' : ''}${past ? ' past' : ''}${current ? ' current' : ''}${e.focus ? ' focus' : ''}`}
              style={{
                top: `${top * 100}%`,
                height: `${height * 100}%`,
                left: `calc(4px + (100% - 4px) * ${lane / lanes})`,
                width: `calc((100% - 4px) / ${lanes} - 4px)`,
              }}
              onClick={() => !e.focus && ask(e.title)}
              title={`${clock(e.start)}–${clock(e.end)} · ${e.title}${e.where ? ` · ${e.where}` : ''} (${e.account})${e.clash ? ' — clashes' : ''}`}
            >
              {/* The name always; the time only when there is room for a
                  second line — the block's place on the track already says it. */}
              <span className="timeline-name">{e.title}</span>
              {height > 0.05 && lanes === 1 && <span className="timeline-time">{clock(e.start)}</span>}
            </button>
          )
        })}
        {nowOnTrack && (
          <div className="timeline-now" style={{ top: `${nowFrac * 100}%` }} aria-label={`Now, ${clock(now)}`}>
            <span>{clock(now)}</span>
          </div>
        )}
      </div>
      {today.events.length === 0 && <p className="timeline-empty">No meetings today.</p>}
    </section>
  )
}

function clock(t: number): string {
  return new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function hourLabel(h: number): string {
  const d = new Date()
  d.setHours(h, 0, 0, 0)
  return d.toLocaleTimeString([], { hour: 'numeric' })
}
