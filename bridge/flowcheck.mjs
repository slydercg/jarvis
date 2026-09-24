import { FLOWS } from './protective.mjs'
import { mailLink, todoLink } from './maillinks.mjs'

/**
 * What each Protective flow actually sends back, checked against what Jarvis
 * relies on. Features built on these flows fall back quietly when a field is
 * missing (a To Do flow with no task ids, a mailbox whose ids Outlook cannot
 * open, no sent-mail flow at all), and quiet fallbacks look exactly like
 * working features. This says which is which, without a model and without
 * spending anything. `npm run doctor:flows` prints it (scripts/flows-doctor.mjs).
 *
 * Only the reading flows are called. The ones that draft, send or add are
 * reported as set up or not, and never called. No flow URL is ever printed:
 * the URL is the credential.
 *
 * `api` is { flows, inbox, flagged, todo, sent, calendar }, the protective
 * module's own functions, passed in so the tests can stand in for Microsoft.
 */

const READS = ['inbox', 'flagged_email', 'todo', 'sent_email', 'calendar']

/** Anything shaped like a URL, taken out of an error before it is shown. */
const noUrls = (s) => String(s ?? '').replace(/https?:\/\/\S+/g, '(url)')

export async function checkFlows(api, now = () => Date.now()) {
  const rows = []
  const timed = async (fn) => {
    const t = now()
    try {
      return { value: await fn(), ms: now() - t }
    } catch (err) {
      return { error: noUrls(err?.message ?? err), ms: now() - t }
    }
  }
  const has = (key) => Boolean(api.flows?.[key])

  for (const key of READS) {
    const name = FLOWS[key]
    if (!has(key)) {
      rows.push({
        key,
        name,
        status: key === 'inbox' || key === 'todo' || key === 'calendar' ? 'fail' : 'warn',
        detail: 'not set up',
        fix: MISSING[key],
      })
      continue
    }
    const call = { inbox: api.inbox, flagged_email: api.flagged, todo: api.todo, sent_email: api.sent, calendar: () => api.calendar('today') }[key]
    const got = await timed(call)
    if (got.error) {
      rows.push({ key, name, status: 'fail', detail: `failed: ${got.error}`, ms: got.ms, fix: 'Open the flow in Power Automate and check its run history.' })
      continue
    }
    rows.push({ key, name, ms: got.ms, ...judge(key, Array.isArray(got.value) ? got.value : []) })
  }
  for (const key of Object.keys(FLOWS).filter((k) => !READS.includes(k))) {
    rows.push({ key, name: FLOWS[key], status: has(key) ? 'ok' : 'info', detail: has(key) ? 'set up (not called: it changes things)' : 'not set up' })
  }
  return rows
}

const MISSING = {
  inbox: 'Without it, Protective mail and brief links do not work.',
  todo: 'Without it, To Do lines on the brief are neither linked nor ticked off.',
  calendar: 'Without it, the timeline and meeting heads-ups miss Protective.',
  flagged_email: 'Optional: flagged mail helps match To Do lines to their email.',
  sent_email: 'Optional: without it, emails you have replied to are not ticked off the brief.',
}

/** One flow's answer, judged: status ok / warn, what came back, and the fix. */
export function judge(key, items) {
  const n = items.length
  if (key === 'inbox' || key === 'flagged_email') {
    const linkable = items.filter((m) => mailLink(m?.id)).length
    const dated = items.filter((m) => Number.isFinite(Date.parse(m?.received ?? ''))).length
    const detail = `${n} message${n === 1 ? '' : 's'}; ${linkable} with an id Outlook can open, ${dated} with a received time`
    if (n && linkable < n) {
      const missing = items.filter((m) => !m?.id).length
      return {
        status: 'warn',
        detail,
        fix: missing
          ? `${missing} came with no id: add the message 'id' to the flow's output, or those brief lines can't open their email.`
          : "Some ids aren't the shape Outlook opens (Graph message ids are long, starting AAMk…): check the flow returns 'id', not another field.",
      }
    }
    if (n && dated < n) return { status: 'warn', detail, fix: "Add 'receivedDateTime': replies can't be told apart from older mail without it." }
    return { status: 'ok', detail }
  }
  if (key === 'todo') {
    const withId = items.filter((t) => todoLink(t?.id)).length
    const lists = new Set(items.map((t) => t?.list).filter(Boolean)).size
    const detail = `${n} open task${n === 1 ? '' : 's'} in ${lists} list${lists === 1 ? '' : 's'}; ${withId} with an id`
    if (n && !withId) {
      return {
        status: 'warn',
        detail,
        fix: "Add the task 'id' to the flow's output: plain To Do lines can't open their task, and are matched by title instead.",
      }
    }
    return { status: 'ok', detail }
  }
  if (key === 'sent_email') {
    const timed = items.filter((m) => Number.isFinite(Date.parse(m?.sent ?? ''))).length
    const detail = `${n} sent message${n === 1 ? '' : 's'}; ${timed} with a sent time`
    if (n && timed < n) return { status: 'warn', detail, fix: "Add 'sentDateTime': a reply only counts if it was sent after the email arrived." }
    return { status: 'ok', detail }
  }
  return { status: 'ok', detail: `${n} event${n === 1 ? '' : 's'} today` }
}
