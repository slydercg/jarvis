/**
 * Small pieces of the history drawer that are worth testing on their own:
 * splitting a line around what was searched for, and naming a day.
 *
 * Kept import-free so tests can run it with type stripping.
 */

/** "Approve the Datadog renewal", "datadog" -> plain / match / plain pieces. */
export function segments(text: string, q: string): Array<{ text: string; hit: boolean }> {
  const needle = q.trim().toLowerCase()
  if (needle.length < 2) return [{ text, hit: false }]
  const out: Array<{ text: string; hit: boolean }> = []
  const lower = text.toLowerCase()
  let from = 0
  for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, at + needle.length)) {
    if (at > from) out.push({ text: text.slice(from, at), hit: false })
    out.push({ text: text.slice(at, at + needle.length), hit: true })
    from = at + needle.length
  }
  if (from < text.length) out.push({ text: text.slice(from), hit: false })
  return out.length ? out : [{ text, hit: false }]
}

/** "2026-09-24" -> "Today", "Yesterday", or "Tue 22 Sep", against `today`. */
export function dayLabel(day: string, today: string): string {
  if (day === today) return 'Today'
  const d = new Date(`${day}T12:00:00`)
  const t = new Date(`${today}T12:00:00`)
  if (Math.round((t.getTime() - d.getTime()) / 86_400_000) === 1) return 'Yesterday'
  return d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })
}
