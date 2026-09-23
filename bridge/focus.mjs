import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { JARVIS_HOME } from './memory.mjs'
import { readSettings, writeSettings } from './settings.mjs'

/**
 * Focus guard: "I'm heads-down until two", or a focus block on the calendar.
 *
 * While it holds, alerts are kept back rather than spoken — except from the
 * VIP list (his CEO, his directs, whoever he names) and production incidents,
 * which the mail watcher marks `vip`. Meeting heads-ups still come through
 * unless JARVIS_FOCUS_HOLD_MEETINGS=on: a meeting on the calendar is not a
 * distraction, it is the next thing. When focus ends, what was held comes
 * back as one digest.
 *
 * The state is a file, so a restart mid-focus stays focused.
 */

const FILE = join(JARVIS_HOME, 'focus.json')
const HOLD_MEETINGS = process.env.JARVIS_FOCUS_HOLD_MEETINGS === 'on'
const MAX_MINUTES = 8 * 60

function read() {
  try {
    const s = JSON.parse(readFileSync(FILE, 'utf8'))
    return { until: s.until ?? null, reason: s.reason ?? '', source: s.source ?? 'voice', held: s.held ?? [] }
  } catch {
    return { until: null, reason: '', source: 'voice', held: [] }
  }
}
function write(s) {
  try {
    mkdirSync(JARVIS_HOME, { recursive: true })
    writeFileSync(FILE, JSON.stringify(s, null, 2))
  } catch {
    // Focus still works for this run.
  }
}

let state = read()

export const focusActive = (now = Date.now()) => Boolean(state.until && now < state.until)

export function focusState() {
  return focusActive()
    ? { active: true, until: new Date(state.until).toISOString(), reason: state.reason, source: state.source, held: state.held.length }
    : { active: false, held: 0 }
}

/** VIPs: the settings list plus JARVIS_FOCUS_VIPS (comma separated). */
export function vips() {
  const fromEnv = (process.env.JARVIS_FOCUS_VIPS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const saved = Array.isArray(readSettings().focusVips) ? readSettings().focusVips : []
  return [...new Set([...fromEnv, ...saved])]
}

export function setVips({ add = [], remove = [] }) {
  const drop = new Set(remove.map((r) => r.toLowerCase()))
  const next = [...new Set([...vips(), ...add])].filter((v) => !drop.has(v.toLowerCase()))
  writeSettings({ focusVips: next })
  return next
}

/**
 * "until" as a spoken clock time ("14:00", "2pm", "2:30 pm") on today, or an
 * ISO time. Past times today mean tomorrow is not intended: they are refused.
 */
export function parseUntil(until, now = new Date()) {
  if (!until) return null
  const iso = Date.parse(until)
  if (/\d{4}-\d{2}-\d{2}T/.test(until) && !Number.isNaN(iso)) return iso
  const m = /^\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?\s*$/i.exec(until)
  if (!m) return null
  let h = Number(m[1])
  const min = Number(m[2] ?? 0)
  const ampm = m[3]?.[0]?.toLowerCase()
  if (ampm === 'p' && h < 12) h += 12
  if (ampm === 'a' && h === 12) h = 0
  // "until two" with no am/pm during the working day means the afternoon.
  if (!ampm && h < 8) h += 12
  const d = new Date(now)
  d.setHours(h, min, 0, 0)
  return d.getTime() > now.getTime() ? d.getTime() : null
}

export function startFocus({ minutes, until, reason = '', source = 'voice' }) {
  const end = until ?? (minutes ? Date.now() + Math.min(minutes, MAX_MINUTES) * 60_000 : null)
  if (!end || end <= Date.now()) throw new Error('a focus block needs an end time in the future')
  state = { until: Math.min(end, Date.now() + MAX_MINUTES * 60_000), reason, source, held: focusActive() ? state.held : [] }
  write(state)
  return focusState()
}

/** End focus; returns the digest alert for what was held, or null. */
export function endFocus(now = new Date()) {
  const held = state.held
  state = { until: null, reason: '', source: 'voice', held: [] }
  write(state)
  if (!held.length) return null
  const n = held.length
  return {
    kind: 'digest',
    label: 'While you were focused',
    title: `${n} thing${n === 1 ? '' : 's'} held back`,
    detail: held.map((a) => a.title).join(' · ').slice(0, 300),
    say:
      `Welcome back, sir. ${n === 1 ? 'One thing' : `${words(n)} things`} came in while you were heads-down: ` +
      held.slice(0, 3).map((a) => a.title).join('; ') + (n > 3 ? ', and more on screen.' : '.'),
    items: held.slice(0, 8).map((a) => ({ title: a.title, detail: a.detail ?? '' })),
    at: now.toISOString(),
  }
}

const words = (n) => ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'][n] ?? String(n)

/**
 * Wrap a broadcast so focus is respected. Returns [deliver, tick]: deliver()
 * for alerts, tick() to call every so often so focus ends on time.
 */
export function focusGate(broadcast, onChange = () => {}) {
  const deliver = (alert) => {
    const passes = !focusActive() || alert.vip || alert.kind === 'digest' || (alert.kind === 'meeting' && !HOLD_MEETINGS)
    if (passes) return broadcast(alert)
    state.held.push({ kind: alert.kind, title: alert.title, detail: alert.detail ?? '', at: alert.at })
    state.held = state.held.slice(-30)
    write(state)
    console.log(`[jarvis] focus: held ${alert.kind} — ${alert.title}`)
  }
  const tick = () => {
    if (state.until && Date.now() >= state.until) {
      const digest = endFocus()
      onChange(focusState())
      if (digest) broadcast(digest)
    }
  }
  return { deliver, tick }
}

export function focusServer(onChange) {
  const out = (v) => ({ content: [{ type: 'text', text: JSON.stringify(v) }] })
  return createSdkMcpServer({
    name: 'jarvis_focus',
    version: '1.0.0',
    tools: [
      tool(
        'focus_start',
        'Start a focus block: hold alerts except from VIPs and production incidents until it ends, then ' +
          'give one digest. For "I\'m heads-down until two", "focus for 90 minutes", "don\'t let anything ' +
          'through until the review". Give minutes or until (a clock time like "14:00" or "2pm").',
        {
          minutes: z.number().int().min(5).max(480).optional(),
          until: z.string().optional(),
          reason: z.string().max(80).optional(),
        },
        async ({ minutes, until, reason }) => {
          try {
            const end = until ? parseUntil(until) : null
            if (until && !end) return { ...out({ error: `"${until}" is not a time later today.` }), isError: true }
            const s = startFocus({ minutes, until: end, reason: reason ?? '' })
            onChange(s)
            return out({ ...s, vips: vips() })
          } catch (err) {
            return { ...out({ error: err.message }), isError: true }
          }
        },
      ),
      tool(
        'focus_end',
        'End focus now ("I\'m back", "focus off"); what was held back comes as one digest.',
        {},
        async () => {
          const digest = endFocus()
          onChange(focusState(), digest)
          return out({ ended: true, held: digest?.items ?? [] })
        },
      ),
      tool('focus_status', 'Whether focus is on, until when, and how much is being held.', {}, async () =>
        out({ ...focusState(), vips: vips() }),
      ),
      tool(
        'focus_vips',
        'The VIP list — people whose mail gets through focus. Add or remove names or addresses: "add ' +
          'Chris to my VIPs". Call with nothing to list it.',
        { add: z.array(z.string().min(2)).optional(), remove: z.array(z.string().min(2)).optional() },
        async ({ add, remove }) => out({ vips: add || remove ? setVips({ add, remove }) : vips() }),
      ),
    ],
  })
}
