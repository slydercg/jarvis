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
    case 'recap':
      // Adding to To Do goes through the usual confirmation: nothing is
      // added until he says yes.
      return {
        label: 'Recap & actions',
        ask:
          `Recap "${i.title}", the meeting that just ended, from its meeting notes: what was decided, ` +
          `the action items that are mine, and what others said they would do for me. Record each of ` +
          `those in my promise ledger, with its due date if one was said, so they are tracked. Then offer ` +
          `to add mine to my To Do list, and add them only if I say yes.`,
      }
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

/** A blocked ticket as an alert card lists it (bridge/alerts.mjs): key, title, "owner · status". */
export type TicketLine = { key?: string; title: string; detail?: string }

/**
 * "Nudge" on a blocked ticket: a short message to whoever has it, drafted
 * from the ticket itself rather than left for the model to work out from a
 * bare name. Drafted and shown, never sent without his yes (the send tools
 * are confirmed like any other). Null when there is no one to nudge.
 */
export function nudgeAsk(t: TicketLine): string | null {
  const owner = (t.detail ?? '').split(' · ')[0].trim()
  if (!t.key || !owner || /^unassigned$/i.test(owner)) return null
  return (
    `Draft a short, friendly Teams message to ${owner} about ${t.key} ("${t.title}"), which is blocked: ` +
    `ask what they need to unblock it and whether I can help. Show me the draft; send it only if I say yes.`
  )
}
