/**
 * The obvious next step for something on the review list or an alert card,
 * one click away: "Draft reply" on mail, "Draft nudge" on a late promise,
 * "Prep me" on a meeting.
 *
 * An action either asks Jarvis something (`ask`, exactly as if typed, so it
 * passes every gate a typed request does) or is an operation the bridge does
 * itself (`op`, e.g. closing one of his promises in the ledger).
 *
 * Kept import-free (types only) so tests can run it with type stripping.
 */
import type { AlertKind } from './bridge'

export type ItemLike = { kind: AlertKind; label?: string; title: string; detail?: string }
export type Action = { label: string; ask?: string; op?: 'kept' }

/** "Cathrene — send the provisioning doc" -> ["Cathrene", "send the provisioning doc"]. */
export function splitPromise(title: string): [string, string] {
  const at = title.indexOf(' — ')
  return at < 0 ? [title, ''] : [title.slice(0, at), title.slice(at + 3)]
}

export function primaryAction(i: ItemLike): Action | null {
  switch (i.kind) {
    case 'mail': {
      const subject = (i.detail ?? '').split(' — ')[0].trim()
      return { label: 'Draft reply', ask: `Draft a reply to ${i.title}${subject ? ` about "${subject}"` : ''}.` }
    }
    case 'promise': {
      const [who, what] = splitPromise(i.title)
      // Theirs, and late: nudge them. His own: he can say it is done.
      if (i.label === 'Overdue') {
        return { label: 'Draft nudge', ask: `Draft a short, friendly nudge to ${who}${what ? ` about: ${what}` : ''}.` }
      }
      return { label: 'Kept it', op: 'kept' }
    }
    case 'portfolio':
      if (i.label === 'Sprint') {
        return { label: 'Why behind?', ask: `Why is ${i.title.replace(/ is behind$/, '')} behind?` }
      }
      return { label: "What's blocked?", ask: "What's blocked across the portfolio?" }
    case 'meeting':
      return { label: 'Prep me', ask: `Prep me for ${i.title}.` }
    case 'brief':
      return { label: 'Brief me', ask: 'Brief me.' }
    case 'wrap':
      return { label: 'Wrap up', ask: 'Wrap up my day.' }
    case 'review':
      return { label: 'Open review', ask: 'Give me my weekly review.' }
    default:
      return null
  }
}
