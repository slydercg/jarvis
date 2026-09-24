import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { requestStatus, watchStatus, type StatusFrame } from '../lib/bridge'

/**
 * The "why can't he hear me / why can't I hear him" panel.
 *
 * Both halves of the voice loop fail silently by nature. Speech recognition
 * that ignores you and speech synthesis that produces no sound look identical
 * from the outside — nothing throws, nothing logs, the interface carries on as
 * though it were working. Every bug in this loop has therefore cost a round
 * trip of guesswork, and that is the actual problem this fixes: it is not a
 * developer toy, it is the instrument that turns "it doesn't work" into a
 * specific, answerable fact.
 *
 * Press D to show it. It polls rather than subscribing, because the two
 * diagnostic records are plain mutable objects written from outside React —
 * that is deliberate, since the whole point is to observe the loop without
 * changing its timing.
 *
 * Below the voice loop, two things the bridge knows and the page cannot see:
 * what today has cost, and how the last brief went (how many lines got a link
 * or were ticked off, and what stopped the rest). Features that fall back
 * quietly (a flow that sends no task ids, a mailbox that failed) otherwise
 * look exactly like features that work.
 */

type VoiceDiag = {
  running: boolean
  sessions: number
  heard: string
  heardAt: number
  lastError: string
  wakes: number
  wakeWord: string
  mode: string
  dropped: string
  accepted: number
  restarts: number
  idleMs: number
}

type TtsDiag = {
  engine: string
  spoken: number
  started: number
  failures: number
  lastError: string
  nativeBroken: boolean
  rescued: number
  voice: string
  lastText: string
}

const ago = (t: number) => (t ? `${((Date.now() - t) / 1000).toFixed(1)}s ago` : '—')

function Row({ k, v, bad, attn }: { k: string; v: string; bad?: boolean; attn?: boolean }) {
  return (
    <div className="diag-row">
      <span className="diag-k">{k}</span>
      <span className={bad ? 'diag-v diag-bad' : attn ? 'diag-v diag-attn' : 'diag-v'}>{v}</span>
    </div>
  )
}

export function Diagnostics() {
  const [open, setOpen] = useState(false)
  const [, tick] = useState(0)
  const phase = useStore((s) => s.phase)
  const [status, setStatus] = useState<StatusFrame | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.key === 'd' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        setOpen((o) => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (!open) return
    const id = setInterval(() => tick((n) => n + 1), 250)
    return () => clearInterval(id)
  }, [open])

  // The bridge's half, asked for while the panel is open. Every few seconds is
  // plenty: spend moves once a turn, brief health once a brief.
  useEffect(() => {
    if (!open) return
    watchStatus(setStatus)
    requestStatus()
    const id = setInterval(requestStatus, 5000)
    return () => {
      clearInterval(id)
      watchStatus(null)
    }
  }, [open])

  if (!open) return null

  const w = window as unknown as Record<string, unknown>
  const v = (w.__voice ?? {}) as Partial<VoiceDiag>
  const t = (w.__tts ?? {}) as Partial<TtsDiag>

  // The two verdicts worth stating outright, rather than making you infer them
  // from the numbers underneath.
  const earsOk = Boolean(v.running) && (v.accepted ?? 0) > 0
  const mouthOk = (t.started ?? 0) > 0 || (t.rescued ?? 0) > 0

  return (
    <div className="diag" aria-live="polite">
      <div className="diag-head">DIAGNOSTICS · D to close</div>

      <div className="diag-verdict">
        <span className={earsOk ? 'diag-ok' : 'diag-bad'}>
          {earsOk ? '● hearing you' : '● not hearing you'}
        </span>
        <span className={mouthOk ? 'diag-ok' : 'diag-bad'}>
          {mouthOk ? '● speaking' : '● no sound produced'}
        </span>
      </div>

      <div className="diag-sec">LISTENING</div>
      <Row k="recogniser" v={v.running ? 'running' : 'STOPPED'} bad={!v.running} />
      <Row k="sessions" v={String(v.sessions ?? 0)} />
      <Row
        k="silent for"
        v={`${((v.idleMs ?? 0) / 1000).toFixed(1)}s`}
        bad={(v.idleMs ?? 0) > 15000}
      />
      <Row k="forced restarts" v={String(v.restarts ?? 0)} bad={(v.restarts ?? 0) > 0} />
      <Row k="mode" v={`${v.mode ?? '—'} (phase ${phase})`} />
      <Row k="accepted" v={String(v.accepted ?? 0)} bad={(v.accepted ?? 0) === 0} />
      <Row k="wakes" v={String(v.wakes ?? 0)} />
      <Row k="wake word" v={v.wakeWord ?? '—'} />
      <Row k="last heard" v={v.heard ? `"${v.heard}" ${ago(v.heardAt ?? 0)}` : '— nothing yet'} bad={!v.heard} />
      <Row k="last drop" v={v.dropped || '—'} bad={Boolean(v.dropped)} />
      <Row k="error" v={v.lastError || '—'} bad={Boolean(v.lastError)} />

      <div className="diag-sec">SPEAKING · press T to test</div>
      <Row k="engine" v={String(t.engine ?? 'system')} />
      <Row k="voice" v={String(t.voice || '—')} />
      <Row k="handed to OS" v={String(t.spoken ?? 0)} />
      <Row k="actually spoke" v={String(t.started ?? 0)} bad={(t.started ?? 0) === 0} />
      <Row k="failures" v={String(t.failures ?? 0)} bad={(t.failures ?? 0) > 0} />
      <Row k="cloud rescues" v={String(t.rescued ?? 0)} />
      <Row k="error" v={t.lastError || '—'} bad={Boolean(t.lastError)} />

      <SpendRows status={status} />
      <BriefRows status={status} />
    </div>
  )
}

const usd = (n: number) => `$${n.toFixed(2)}`
/** "40s ago", "12 min ago", "3h 5m ago": a brief is hours old, not seconds. */
function since(t: number) {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m} min ago` : `${Math.floor(m / 60)}h ${m % 60}m ago`
}

function SpendRows({ status }: { status: StatusFrame | null }) {
  const s = status?.spend
  return (
    <>
      <div className="diag-sec">SPEND · estimated at API prices</div>
      {!s ? (
        <Row k="today" v={status ? '—' : 'asking the bridge…'} />
      ) : (
        <>
          <Row
            k="today"
            v={`${usd(s.today.total)}${s.cap ? ` of ${usd(s.cap)} cap` : ''}${s.paused ? ' · background paused' : ''}`}
            attn={s.paused}
          />
          <Row
            k="  by kind"
            v={`asked ${usd(s.today.byKind.conversation)} · jobs ${usd(s.today.byKind.background)} · watcher ${usd(s.today.byKind.watcher)}`}
          />
          <Row k="last 7 days" v={usd(s.week.total)} />
          <Row k="last 30 days" v={usd(s.month.total)} />
        </>
      )}
    </>
  )
}

function BriefRows({ status }: { status: StatusFrame | null }) {
  const b = status?.brief
  return (
    <>
      <div className="diag-sec">BRIEF</div>
      {!b ? (
        <Row k="last served" v={status ? '— not asked for since he started' : 'asking the bridge…'} />
      ) : (
        <>
          <Row k="last served" v={`${since(b.at)} · built ${since(b.builtAt)}`} />
          <Row k="lines" v={`${b.lines} · ${b.linked} linked · ${b.done} done`} />
          {b.unlinked.map((u, n) => (
            <Row key={`u${n}`} k={n === 0 ? 'no link' : ''} v={u} />
          ))}
          {b.notes.map((note, n) => (
            <Row key={`n${n}`} k={n === 0 ? 'attention' : ''} v={note} bad={/couldn't be read/.test(note)} attn={!/couldn't be read/.test(note)} />
          ))}
        </>
      )}
    </>
  )
}
