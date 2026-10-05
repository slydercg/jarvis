import { execFile } from 'node:child_process'

/**
 * Whether he is on a call, so Jarvis keeps quiet.
 *
 * He spoke over calls: an alert, an answer read out, a follow-up window that
 * took the other side of the call for a question. The page can't see other
 * apps, and the microphone is no guide — Jarvis holds it open itself for the
 * wake word. What does show a call is macOS's power assertions: a call app
 * keeps the display awake for as long as the call lasts, and says so in
 * `pmset -g assertions`. Zoom, Teams, Webex, FaceTime and Slack hold one by
 * process; a call in the browser (Teams or Meet on the web) shows as Chrome's
 * "WebRTC has active PeerConnections". Jarvis's own page uses no WebRTC.
 *
 * macOS only; elsewhere, and with JARVIS_CALL_DETECT=off, never on a call.
 * The page also treats a calendar meeting under way as a call (App.tsx).
 */

const CALL_APPS = [
  [/^(?:zoom\.us|CptHost|caphost)$/i, 'Zoom'],
  [/^(?:MSTeams|Microsoft Teams(?: \(work or school\))?|Teams)$/i, 'Teams'],
  [/^(?:Webex|Cisco Webex Meetings|Meeting Center)$/i, 'Webex'],
  [/^(?:FaceTime|avconferenced)$/i, 'FaceTime'],
  [/^Slack$/i, 'Slack'],
]
const WEBRTC = /WebRTC has active PeerConnections/i
const AWAKE = /PreventUserIdleDisplaySleep|NoDisplaySleepAssertion/

/**
 * The call app named in `pmset -g assertions` output, or null.
 * Lines look like:
 *   pid 412(zoom.us): [0x…] 00:12:03 PreventUserIdleDisplaySleep named: "…"
 */
export function callFrom(text) {
  return callMatch(text)?.app ?? null
}

/** The call app and the assertion that showed it, for Diagnostics. */
export function callMatch(text) {
  for (const line of String(text ?? '').split('\n')) {
    const m = /pid\s+\d+\(([^)]+)\):.*?(\w*Sleep\w*|NoDisplaySleepAssertion)\s+named:\s*"([^"]*)"/.exec(line)
    if (!m) continue
    const [, proc, kind, name] = m
    const seen = `${proc.trim()}: ${name}`.slice(0, 160)
    if (WEBRTC.test(name)) return { app: 'a browser call', seen }
    if (!AWAKE.test(kind)) continue
    const app = CALL_APPS.find(([re]) => re.test(proc.trim()))
    if (app) return { app: app[1], seen }
  }
  return null
}

/**
 * What the watcher has seen, for Diagnostics: whether it is watching at all,
 * the call it sees (and since when), the assertion that showed it, and when
 * it last looked. A missed or false call can be read off here, not guessed.
 */
const state = { watching: false, why: '', app: null, since: 0, seen: '', checkedAt: 0, failures: 0 }
export function callStatus() {
  return { ...state }
}

const defaultRun = () =>
  new Promise((resolve) => {
    execFile('pmset', ['-g', 'assertions'], { timeout: 3000 }, (err, stdout) => resolve(err ? '' : stdout))
  })

/**
 * Check every few seconds and call `onChange(app | null)` when it changes.
 * Returns a stop function.
 */
export function watchCalls(
  onChange,
  { intervalMs = 5000, platform = process.platform, run = defaultRun, enabled = process.env.JARVIS_CALL_DETECT !== 'off' } = {},
) {
  if (platform !== 'darwin' || !enabled) {
    state.watching = false
    state.why = platform !== 'darwin' ? 'not a Mac' : 'JARVIS_CALL_DETECT=off'
    return () => {}
  }
  state.watching = true
  state.why = ''
  let last = null
  let busy = false
  const tick = async () => {
    if (busy) return
    busy = true
    try {
      const out = await run()
      if (!out) state.failures++
      const hit = callMatch(out)
      const now = hit?.app ?? null
      state.checkedAt = Date.now()
      state.seen = hit?.seen ?? ''
      if (now !== last) {
        state.app = now
        state.since = now ? Date.now() : 0
        last = now
        onChange(now)
      }
    } catch {
      // A failed check changes nothing; the next one tries again.
    } finally {
      busy = false
    }
  }
  void tick()
  const timer = setInterval(tick, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}
