import { NAME, TAGLINE, WORDMARK } from '../lib/identity'
import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { useStore, accentFor, type Phase } from '../store'
import { Suggestions } from './Suggestions'
import { BladeSweep, Blades } from './Blades'
import { Effects } from './Effects'
import { Pointer } from './Pointer'
import { GestureGuide } from './GestureGuide'
import { CommandBar } from './CommandBar'
import { ConfirmCard } from './ConfirmCard'
import { AlertStack } from './AlertStack'
import { NowStrip } from './NowStrip'
import { DayTimeline } from './DayTimeline'

/**
 * The three things he can be doing, shown as words as well as light.
 *
 * The reactor's colour and glow already change with the phase, but colour
 * alone does not read across a room and does not read at all for anyone who
 * cannot tell the hues apart. So the phase is also a word, marked by weight
 * and a filled dot, in the same place every time.
 */
const STATES: Array<{ label: string; phases: Phase[] }> = [
  { label: 'LISTENING', phases: ['waking', 'listening'] },
  { label: 'THINKING', phases: ['thinking', 'tooling'] },
  { label: 'SPEAKING', phases: ['speaking'] },
]

/** Where "sign in again" sends you for a claude.ai connector. */
const CONNECTORS_URL = 'https://claude.ai/settings/connectors'

const HEALTH_LABEL = {
  live: 'live',
  pending: 'connecting',
  auth: 'needs sign-in',
  failed: 'failed to start',
} as const

const statusText: Record<Phase, string> = {
  offline: 'OFFLINE',
  boot: 'INITIALISING',
  dormant: `STANDBY — SAY “HEY ${NAME.toUpperCase()}”`,
  waking: 'ONLINE',
  listening: 'LISTENING',
  thinking: 'PROCESSING',
  tooling: 'ACCESSING SYSTEMS',
  speaking: 'RESPONDING',
}

function Corner({ at }: { at: 'tl' | 'tr' | 'bl' | 'br' }) {
  return <div className={`corner corner-${at}`} />
}

/* ------------------------------------------------------------------ decode */

/**
 * The glyphs the ghost is drawn from. Uppercase, digits and rules only: the
 * point is that the unresolved text reads as *machine*, so lowercase letters
 * and anything with a descender are left out — they look like badly rendered
 * words rather than an unfinished decode.
 */
const GLYPHS = '/\\|<>[]{}=+*#%&$0123456789ABCDEFGHJKLMNPQRSTUVWXYZ'

/** Characters of noise shown ahead of the resolved text. */
const GHOST = 22
/** Repaint interval for the scramble. ~24fps is plenty for glyph noise. */
const FRAME_MS = 42
/** Floor on the resolve rate, characters per second. */
const MIN_RATE = 110
/** The frontier is never allowed to trail the streamed text by longer. */
const MAX_LAG_MS = 420

function scramble(s: string, seed: number) {
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    // Whitespace is left alone so word shapes and line breaks hold still while
    // the glyphs underneath churn.
    if (c === ' ' || c === '\n' || c === '\t') {
      out += c
      continue
    }
    out += GLYPHS[(seed * 7919 + i * 104729 + c.charCodeAt(0)) % GLYPHS.length]
  }
  return out
}

/**
 * JARVIS's lines, arriving the way a computer would produce them.
 *
 * The hard part is not the effect, it is that the text underneath is *live*.
 * The store appends a token at a time, so this component re-renders dozens of
 * times a second with a slightly longer string, and the naive implementation —
 * scramble the whole thing, resolve it over N milliseconds — restarts the
 * animation on every token and never finishes decoding anything.
 *
 * So the frontier is a ref and only ever moves forward. Everything behind it
 * has settled and is plain text that will never animate again; a short window
 * ahead of it is noise; the rest is present in the DOM but invisible, which
 * keeps the line wrapping identical to the finished paragraph and means the
 * accessibility tree always holds the real sentence. The rate scales with how
 * far behind the frontier has fallen, so a single token drips and a 300
 * character burst clears inside MAX_LAG_MS — the decode must never be the
 * reason the transcript trails the voice.
 *
 * The rAF loop repaints on a 42ms gate rather than every frame, and stops dead
 * the moment the frontier catches up.
 */
function DecodeText({ text }: { text: string }) {
  const reduced = useReducedMotion()
  const settled = useRef(0)
  const raf = useRef(0)
  const latest = useRef(text)
  const [tick, bump] = useState(0)

  useEffect(() => {
    // The running loop reads the length through this ref rather than through
    // its own closure, so a token landing mid-sweep simply extends the target
    // instead of leaving the loop chasing a length that is already stale.
    latest.current = text

    if (reduced) {
      settled.current = text.length
      return
    }
    if (raf.current || settled.current >= text.length) return

    let prev = performance.now()
    let painted = 0

    const step = (now: number) => {
      // Clamped so a backgrounded tab does not resolve the whole answer in one
      // enormous frame the moment it comes back.
      const dt = Math.min(now - prev, 120) / 1000
      prev = now

      const target = latest.current.length
      const rate = Math.max(MIN_RATE, (target - settled.current) / (MAX_LAG_MS / 1000))
      settled.current = Math.min(target, settled.current + rate * dt)

      if (now - painted >= FRAME_MS) {
        painted = now
        bump((n) => n + 1)
      }

      if (settled.current < latest.current.length) {
        raf.current = requestAnimationFrame(step)
      } else {
        raf.current = 0
        bump((n) => n + 1)
      }
    }
    raf.current = requestAnimationFrame(step)
  }, [text, reduced])

  useEffect(
    () => () => {
      if (raf.current) cancelAnimationFrame(raf.current)
      raf.current = 0
    },
    [],
  )

  const n = Math.floor(settled.current)
  if (reduced || n >= text.length) return <>{text}</>

  return (
    <>
      {text.slice(0, n)}
      <span className="decode-ghost">{scramble(text.slice(n, n + GHOST), tick)}</span>
      <span className="decode-veil">{text.slice(n + GHOST)}</span>
    </>
  )
}

/* --------------------------------------------------------------------- hud */

export function Hud() {
  const lower = useLowerEdge()
  const systemsOpen = useStore((s) => s.systemsOpen)
  const setHistoryOpen = useStore((s) => s.setHistoryOpen)
  const setKeysOpen = useStore((s) => s.setKeysOpen)
  const setSystemsOpen = useStore((s) => s.setSystemsOpen)
  const phase = useStore((s) => s.phase)
  const caption = useStore((s) => s.caption)
  const turns = useStore((s) => s.turns)
  const activeTool = useStore((s) => s.activeTool)
  const jobStep = useStore((s) => s.jobStep)
  const connected = useStore((s) => s.connected)
  const health = useStore((s) => s.health)
  const sessionCost = useStore((s) => s.sessionCost)
  const tier = useStore((s) => s.tier)
  const confirm = useStore((s) => s.confirm)
  const error = useStore((s) => s.error)
  const level = useStore((s) => s.level)
  const voice = useStore((s) => s.voice)
  const bootNote = useStore((s) => s.bootNote)
  const gestures = useStore((s) => s.gestures)
  const looking = useStore((s) => s.looking)
  const ui = useStore((s) => s.ui)

  // accentFor folds JARVIS's overrides in over the phase colour, so one
  // variable on the root carries a theme change into every .hud-* rule without
  // a single component knowing a theme exists.
  const colour = accentFor(phase, ui)

  useEffect(() => {
    // The ground has to be set on the document, not painted here: the HUD sits
    // above the 3D scene, so a background drawn inside it would cover the
    // reactor rather than sit behind it. --bg is what html, body, #root and the
    // boot screen all pin themselves to.
    const root = document.documentElement
    // Checked again here: --bg feeds the background shorthand, which would
    // fetch a url(…). The bridge already only passes colours through.
    if (ui.background && CSS.supports('color', ui.background)) root.style.setProperty('--bg', ui.background)
    else root.style.removeProperty('--bg')
  }, [ui.background])

  return (
    <div className="hud" style={{ ['--accent' as string]: colour }}>
      {/* First in the tree on purpose. Everything after it is positioned with
          `z-index: auto`, so paint order is document order and the sweep stays
          behind the transcript and the panels without a z-index war. */}
      <BladeSweep />

      <Corner at="tl" />
      <Corner at="tr" />
      <Corner at="bl" />
      <Corner at="br" />

      <header className="hud-top">
        {ui.chrome.brand && (
          <div className="brand">
            <span className="brand-mark">{WORDMARK}</span>
            {TAGLINE && <span className="brand-sub">{TAGLINE}</span>}
          </div>
        )}

        <div className="status">
          <ol className="states" aria-hidden="true">
            {STATES.map((st) => {
              const on = st.phases.includes(phase)
              return (
                <li key={st.label} className={on ? 'state state-on' : 'state'}>
                  <span className="state-dot" />
                  {st.label}
                </li>
              )
            })}
          </ol>
          {/* The three core phases are already on the strip above; the line
              underneath only speaks up when it adds something (standby, boot,
              a tool running). Screen readers always get it. */}
          <span
            className={
              ['listening', 'thinking', 'speaking'].includes(phase)
                ? 'status-text sr-only'
                : 'status-text'
            }
            role="status"
            aria-live="polite"
          >
            {/* bootNote is the voice-model download readout. It is only ever
                the right thing to show during boot — as a general fallback a
                note that never got cleared (a stuck 'voice 97%') sits over
                LISTENING and PROCESSING for the rest of the session. */}
            {phase === 'boot' && bootNote ? bootNote : statusText[phase]}
          </span>
        </div>
      </header>

      <NowStrip />

      {/* Left rail: which integrations are live. Folded to one line by
          default so today's timeline can have the space; a connector that
          needs signing in or has failed still shows, folded or not, since
          that is the one thing on this list that needs him. */}
      {ui.chrome.systems && (
        <aside className={`rail rail-left${systemsOpen ? '' : ' rail-folded'}`} aria-label="Connected systems">
          <button
            type="button"
            className="rail-title rail-toggle"
            aria-expanded={systemsOpen}
            onClick={() => setSystemsOpen(!systemsOpen)}
          >
            SYSTEMS
            {connected.length > 0 && <span className="rail-count">{connected.length}</span>}
            <span className="rail-caret" aria-hidden="true">{systemsOpen ? '▾' : '▸'}</span>
          </button>
          {connected.length === 0 && <div className="rail-item dim">none linked</div>}
          {connected.filter((c) => systemsOpen || ['auth', 'failed'].includes(health[c] ?? 'live')).map((c) => {
            const h = health[c] ?? 'live'
            return (
              <div key={c} className={`rail-item rail-${h}`} title={`${c} — ${HEALTH_LABEL[h]}`}>
                <span className={`tick tick-${h}`} aria-hidden="true" />
                <span className="rail-label">{c}</span>
                {h === 'auth' && (
                  <a className="rail-fix" href={CONNECTORS_URL} target="_blank" rel="noreferrer">
                    sign in
                  </a>
                )}
                {h === 'failed' && <span className="rail-fix">failed</span>}
                <span className="sr-only">{HEALTH_LABEL[h]}</span>
              </div>
            )
          })}
          {systemsOpen && (
            <div className="rail-item">
              <span className="tick" aria-hidden="true" />
              Web
            </div>
          )}
        </aside>
      )}
      {ui.chrome.systems && <DayTimeline />}

      {/* Right rail: live telemetry, mostly for flavour */}
      <aside className="rail rail-right">
        <div className="rail-title">SIGNAL</div>
        <div className="meter">
          <div className="meter-fill" style={{ height: `${level * 100}%` }} />
        </div>
        <div className="rail-item mono">{(level * 100).toFixed(0).padStart(3, '0')}%</div>
        {sessionCost != null && (
          <>
            <div className="rail-title rail-gap">SESSION</div>
            <div className="rail-item mono" title="What this session has cost so far">
              ${sessionCost.toFixed(2)}
            </div>
            {tier && (
              <div className="rail-item mono dim-ish" title="Which model answered last">
                {tier === 'fast' ? 'quick model' : 'main model'}
              </div>
            )}
          </>
        )}
      </aside>

      <AnimatePresence>
        {activeTool && ui.chrome.toolBadge && !confirm && (
          <motion.div
            className="tool-badge"
            // Anchored to the TOP of the frame, not the middle. The old home was
            // viewport-centre plus a fixed drop, which on a tall or square
            // window landed the headline straight on top of the bottom
            // transcript — two elements pinned to different edges of the screen
            // were always going to meet somewhere. Up here it sits in its own
            // band with the rest of the status chrome and can never collide with
            // the log. Framer owns `transform` on an animated element, so the
            // centring (x: -50%) lives in these props, not the stylesheet.
            initial={{ opacity: 0, x: '-50%', y: -8, filter: 'blur(6px)' }}
            animate={{ opacity: 1, x: '-50%', y: 0, filter: 'blur(0px)' }}
            exit={{ opacity: 0, x: '-50%', y: -8, filter: 'blur(6px)' }}
            transition={{ type: 'spring', stiffness: 300, damping: 26 }}
          >
            <span className="tool-kicker">
              <span className="spinner" />
              working
            </span>
            <span className="tool-name">{activeTool.replace(/[_-]/g, ' ')}</span>
            {/* A job that takes a minute (the brief, the weekly review) says
                which step it is on, so it reads as moving, not stuck. */}
            {jobStep && jobStep.job === activeTool && (
              <span className="tool-step" aria-live="polite">
                {jobStep.step}
              </span>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* The one surface. Panels used to sit alongside this as a second place
          for things to appear, which meant two places to look and a decision
          the model had to make on grounds it could not know. Everything renders
          here now; Panels.tsx is unmounted rather than deleted so the design
          system it documents stays findable. */}
      <Blades />

      {/* Everything that reads as a line of text above the command bar, in one
          column anchored to the bottom, so each pushes the others up rather
          than printing over them: a two-line caption used to run into the
          error, and a wrapped error into the caption. */}
      <div className="lower" ref={lower}>
        {/* Conversation log — last few turns, fading upward */}
        {ui.chrome.transcript && (
          <div className="log" role="log" aria-live="polite" aria-label="Conversation">
            <AnimatePresence initial={false}>
              {turns.slice(-4).map((t) => (
                <motion.div
                  key={t.id}
                  className={`log-line log-${t.role}`}
                  initial={{ opacity: 0, y: 14 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ type: 'spring', stiffness: 320, damping: 32 }}
                >
                  <span className="log-who">{t.role === 'user' ? 'YOU' : NAME.toUpperCase()}</span>
                  {/* Only his half decodes. What the user said was never
                      transmitted from anywhere — dressing it up as machine
                      output would be a lie about where the words came from. */}
                  <span className="log-text">
                    {t.role === 'jarvis' ? (
                      <>
                        {/* The scramble is for the eye; a screen reader gets the
                            words themselves, not a stream of glyph noise. */}
                        <span aria-hidden="true">
                          <DecodeText text={t.text} />
                        </span>
                        <span className="sr-only">{t.text}</span>
                      </>
                    ) : (
                      t.text
                    )}
                  </span>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        )}
        {/* One reserved line, so the transcript above does not jump each time
            a caption comes and goes; only a longer one pushes it up. */}
        <div className="lower-line">
          {error && (
            <div className="error" role="alert" title={error}>
              {error}
            </div>
          )}
          <AnimatePresence>
            {caption && (
              <motion.div
                className="caption"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
              >
                {caption}
              </motion.div>
            )}
          </AnimatePresence>
          {/* The error takes the suggestion's place rather than sitting under it. */}
          {ui.chrome.suggestions && !error && <Suggestions />}
        </div>
      </div>

      <CommandBar />

      {/* Above the transcript and the blades: an action waiting on a yes is
          the most important thing on the screen while it is there. */}
      <ConfirmCard />

      <AlertStack />

      <footer className="hud-bottom">
        <span className="hint">
          say <b>“hey {NAME.toLowerCase()}”</b> · <kbd>Space</kbd> to talk · <kbd>G</kbd> hands
          {voice && (
            <>
              {' · '}
              <kbd>V</kbd> voice: {voice.replace(/\(.*?\)/g, '').trim()}
            </>
          )}
          {' · '}
          <button type="button" className="hint-link" onClick={() => setHistoryOpen(true)}>
            <kbd>H</kbd> history
          </button>
          {' · '}
          <button type="button" className="hint-link" onClick={() => setKeysOpen(true)}>
            <kbd>?</kbd> keys
          </button>
        </span>
      </footer>

      {/* Last, so a flash or a tear reads as being on the glass rather than
          underneath the chrome. It is pointer-events: none and unmounts the
          instant it finishes. */}
      <Effects />

      {/* Above even the effects: the reticle shows where a press will land, and
          a press that lands under a flourish is a press you cannot aim. */}
      <Pointer />
      {(gestures || looking) && (
        <div className="hands-live">
          {looking ? `LOOKING — ${looking.toUpperCase()}` : 'CAMERA ON · G TO STOP'}
        </div>
      )}
      <GestureGuide live={gestures} />
    </div>
  )
}

/**
 * Where the conversation column starts, as --lower-top on <html>. In the
 * Clear reading mode the blades lay themselves out above that line rather
 * than over the conversation (see index.css).
 */
function useLowerEdge() {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const root = document.documentElement
    const update = () => {
      // The column is bottom-anchored and grows upward; its first child with
      // any height is where the text begins.
      const first = [...el.children].find((c) => c.getBoundingClientRect().height > 0)
      const top = (first ?? el).getBoundingClientRect().top
      root.style.setProperty('--lower-top', `${Math.round(top)}px`)
      // When the conversation panel scrolls (Clear mode caps its height),
      // the newest line is the one to see.
      const log = el.querySelector('.log')
      if (log) log.scrollTop = log.scrollHeight
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    for (const c of el.children) ro.observe(c)
    const mo = new MutationObserver(() => {
      for (const c of el.children) ro.observe(c)
      update()
    })
    mo.observe(el, { childList: true, subtree: true })
    window.addEventListener('resize', update)
    return () => {
      ro.disconnect()
      mo.disconnect()
      window.removeEventListener('resize', update)
    }
  }, [])
  return ref
}
