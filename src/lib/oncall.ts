/**
 * Why he should keep quiet right now, or null.
 *
 * On a call — a call app the bridge saw (bridge/calls.mjs), or a meeting with
 * other people under way on the calendar — nothing is spoken and no sound is
 * played: answers, alerts and greetings are shown, not said, and he does not
 * keep listening after an answer, so the other side of the call is never
 * taken for a question. Settings → Listening turns it off.
 *
 * Kept import-free (types only) so tests can run it with type stripping.
 */
import type { TodayEvent } from './bridge'

export function hushReason(opts: {
  enabled: boolean
  deviceCall: string | null
  events: TodayEvent[]
  now: number
}): string | null {
  if (!opts.enabled) return null
  if (opts.deviceCall) return `On a call (${opts.deviceCall})`
  const meeting = opts.events.find(
    (e) => !e.focus && e.people > 0 && e.start <= opts.now && opts.now < e.end,
  )
  return meeting ? `In ${meeting.title}` : null
}
