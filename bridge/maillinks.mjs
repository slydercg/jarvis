/**
 * Links that open an email in Outlook on the web, for the brief's lines.
 *
 * The link is built here from the message's own id, found by matching the
 * brief item to the mailbox; the model never writes one. Only this exact
 * shape gets past the page's sanitiser (src/lib/tickets.ts, isMailLink), so a
 * planted "open this" link in an email cannot become clickable.
 */

/** An Outlook web link for one message id, or null for anything id-shaped wrong. */
export function mailLink(id) {
  const s = String(id ?? '')
  if (!/^[A-Za-z0-9+/=_-]{8,512}$/.test(s)) return null
  return `https://outlook.office.com/mail/deeplink/read/${encodeURIComponent(s)}`
}

/**
 * An id the brief builder copied from the Outlook tool, only if it looks like
 * an Exchange message id ("AAMk…", long, base64 characters). Anything else —
 * a subject, a URL, a truncated copy — gives no link rather than a wrong one.
 */
export function readerId(id) {
  const s = String(id ?? '').trim()
  return /^AA[A-Za-z0-9+/=_-]{60,500}$/.test(s) ? s : null
}

/** A To Do web link for one task id, or null for anything id-shaped wrong. */
export function todoLink(id) {
  const s = String(id ?? '')
  if (!/^[A-Za-z0-9+/=_-]{8,512}$/.test(s)) return null
  return `https://to-do.office.com/tasks/id/${encodeURIComponent(s)}/details`
}

/** The To Do task a brief line came from: same title, ignoring RE:/FW:. */
export function matchTask(item, tasks) {
  const want = plainSubject(item?.subject)
  if (!want) return null
  return (tasks ?? []).find((t) => plainSubject(t?.title) === want) ?? null
}

/** "RE: Fwd: Q4 renewal" -> "q4 renewal". */
export const plainSubject = (s) =>
  String(s ?? '')
    .replace(/^\s*((re|fw|fwd|aw|sv)\s*:\s*)+/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()

/**
 * The message a brief item came from: same subject (ignoring RE:/FW:), and
 * when several share it, one from the same sender if there is one, newest
 * first. Null when nothing matches — a line without a link, not a wrong one.
 */
export function matchMail(item, messages) {
  const want = plainSubject(item?.subject)
  if (!want) return null
  const same = (messages ?? []).filter((m) => m?.id && plainSubject(m.subject) === want)
  if (!same.length) return null
  const from = String(item?.from ?? '').toLowerCase()
  const bySender = from ? same.filter((m) => String(m.from ?? '').toLowerCase().includes(from) || from.includes(String(m.from ?? '').toLowerCase())) : []
  const pool = bySender.length ? bySender : same
  return [...pool].sort((a, b) => String(b.received ?? '').localeCompare(String(a.received ?? '')))[0]
}
