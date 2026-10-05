/**
 * Why he should keep quiet right now, or null.
 *
 * On a call — his own word ("I'm on a call"), a call app the bridge saw
 * (bridge/calls.mjs), or a meeting under way on the calendar — nothing is
 * spoken and no sound is played: answers, alerts and greetings are shown, not
 * said; only words starting with his name reach him, and he does not keep
 * listening after an answer, so the other side of the call is never taken for
 * a question. Settings → Listening turns the guessing off.
 *
 * Kept import-free (types only) so tests can run it with type stripping.
 */
import type { TodayEvent } from './bridge'

/** What he said himself: "I'm on a call" / "call's over", and until when. */
export type CallOverride = { on: boolean; until: number } | null

/** "I'm on a call" holds for three hours at most; "call's over" for thirty minutes. */
export const OVERRIDE_ON_MS = 3 * 3_600_000
export const OVERRIDE_OFF_MS = 30 * 60_000

export function hushReason(opts: {
  enabled: boolean
  deviceCall: string | null
  events: TodayEvent[]
  now: number
  override?: CallOverride
}): string | null {
  // His word beats every guess, and works with the setting off.
  const o = opts.override
  if (o && opts.now < o.until) return o.on ? 'On a call (you said so)' : null
  if (!opts.enabled) return null
  if (opts.deviceCall) return `On a call (${opts.deviceCall})`
  // Any meeting under way but a focus block. This used to need attendees too,
  // and a calendar flow that does not pass them on made every meeting look
  // like a meeting alone, so he listened to the whole call.
  const meeting = opts.events.find((e) => !e.focus && e.start <= opts.now && opts.now < e.end)
  return meeting ? `In ${meeting.title}` : null
}

/** "I'm on a call", "on a call", "I'm in a meeting". */
export const CALL_ON = /^(?:i'?m |i am )?(?:on|in) a (?:call|meeting)[.!]?$/i
/** "Call's over", "off the call", "I'm off the call", "meeting's over". */
export const CALL_OFF = /^(?:i'?m |i am )?(?:off the (?:call|meeting)|(?:the )?(?:call|meeting)(?:'s| is)? (?:over|done|finished|ended))[.!]?$/i

/** An alert as the digest needs it (store.ts Alert). */
type Heard = { kind: string; title: string; at: number; received: number; label?: string }

/**
 * One line for what came in during a call, said when it ends: "While you were
 * on the call: 2 emails, from Chris and Anne; RPT-3806 is blocked." Nothing
 * was read out during the call, so this is the only time he hears of them.
 * Null when nothing came in. Meeting heads-ups already past are left out.
 */
export function callDigest(alerts: Heard[], since: number, now: number): string | null {
  const fresh = alerts.filter((a) => a.received >= since && !(a.kind === 'meeting' && a.at < now))
  if (!fresh.length) return null
  const parts: string[] = []
  const mail = fresh.filter((a) => a.kind === 'mail')
  if (mail.length) {
    const who = [...new Set(mail.map((m) => m.title))].slice(0, 3)
    parts.push(`${mail.length === 1 ? 'an email' : `${mail.length} emails`}, from ${list(who)}${mail.length > who.length ? ' and others' : ''}`)
  }
  const meetings = fresh.filter((a) => a.kind === 'meeting')
  for (const m of meetings.slice(0, 2)) parts.push(`${m.title} starts in ${Math.max(1, Math.round((m.at - now) / 60_000))} minutes`)
  const portfolio = fresh.filter((a) => a.kind === 'portfolio')
  if (portfolio.length === 1) parts.push(portfolio[0].title)
  else if (portfolio.length > 1) parts.push(`${portfolio.length} portfolio alerts`)
  for (const r of fresh.filter((a) => a.kind === 'reminder').slice(0, 2)) parts.push(`a reminder: ${r.title}`)
  const recaps = fresh.filter((a) => a.kind === 'recap').length
  if (recaps) parts.push(recaps === 1 ? 'a meeting recap is ready' : `${recaps} meeting recaps are ready`)
  const rest = fresh.length - mail.length - meetings.length - portfolio.length - fresh.filter((a) => a.kind === 'reminder' || a.kind === 'recap').length
  if (rest > 0) parts.push(rest === 1 ? 'one more on your list' : `${rest} more on your list`)
  return `While you were on the call: ${parts.join('; ')}.`
}

function list(xs: string[]): string {
  return xs.length < 2 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`
}
