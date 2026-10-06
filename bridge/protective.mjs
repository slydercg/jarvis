import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { JARVIS_HOME } from './memory.mjs'
import { joinUrl } from './tickets.mjs'

/**
 * The Protective mailbox, calendar and To Do, through Power Automate.
 *
 * Protective's Microsoft 365 is not reachable with a connector, so the daily
 * briefing already reads it through Power Automate flows with HTTP triggers:
 * POST {} to a flow's URL and it answers with `{ value: [...] }`. This uses the
 * same flows, so Jarvis sees exactly what the briefing sees.
 *
 * The URLs carry a signature and are credentials. They are read from a local
 * file — never the repository — in this order:
 *   1. JARVIS_PA_ENDPOINTS, a path;
 *   2. ~/.jarvis/power-automate.json, a private copy;
 *   3. the daily briefing's own pa_endpoints.json, if OneDrive syncs it here.
 * Only the flows below are kept from the file; anything else in it (the
 * briefing also stores Jira credentials there) is ignored.
 */

/** Flow key -> what it is, in the briefing's own names. */
export const FLOWS = {
  inbox: 'Inbox (latest 25)',
  calendar: 'Calendar',
  todo: 'To Do',
  flagged_email: 'Flagged mail',
  sent_email: 'Sent mail',
  draft_email: 'Save a draft',
  send_email: 'Send mail',
  todo_add: 'Add to Daily Meeting Actions',
  todo_waiting: 'Add to Waiting On Others',
  meeting_notes: 'Meeting notes (Copilot, transcript or recap email)',
}

const SAVED = join(JARVIS_HOME, 'power-automate.json')

/** Power Automate and Logic Apps hosts only: a flow URL is never anywhere else. */
export function validFlowUrl(u) {
  try {
    const url = new URL(u)
    return (
      url.protocol === 'https:' &&
      /(\.powerplatform\.com|\.logic\.azure\.com|\.azure-apim\.net)$/i.test(url.hostname)
    )
  } catch {
    return false
  }
}

/** Keep the known flows with valid URLs; drop everything else. */
export function pickFlows(raw) {
  const out = {}
  for (const key of Object.keys(FLOWS)) {
    const v = raw?.[key]
    if (typeof v === 'string' && validFlowUrl(v.trim())) out[key] = v.trim()
  }
  return out
}

function oneDriveCandidates() {
  const home = homedir()
  const tail = join('Desktop', 'daily-briefing-export', 'pa_endpoints.json')
  const found = []
  for (const base of [join(home, 'Library', 'CloudStorage'), home]) {
    let names = []
    try {
      names = readdirSync(base)
    } catch {
      continue
    }
    for (const n of names) if (/^OneDrive/i.test(n)) found.push(join(base, n, tail))
  }
  return found
}

let cache = null

/** { flows, source } — the flows available now. Re-read when the file changes. */
export function loadFlows() {
  const candidates = [
    process.env.JARVIS_PA_ENDPOINTS,
    SAVED,
    ...oneDriveCandidates(),
  ].filter(Boolean)
  for (const path of candidates) {
    if (!existsSync(path)) continue
    try {
      const flows = pickFlows(JSON.parse(readFileSync(path, 'utf8')))
      if (Object.keys(flows).length) {
        const source = path.replace(homedir(), '~')
        cache = { flows, source }
        return cache
      }
    } catch {
      // Unreadable or not JSON: try the next place.
    }
  }
  cache = { flows: {}, source: null }
  return cache
}

export const protectiveConfigured = () => Object.keys((cache ?? loadFlows()).flows).length > 0

/** Save flows to the private copy, merged over what was there. Mode 600. */
export function saveFlows(flows) {
  mkdirSync(JARVIS_HOME, { recursive: true })
  let prior = {}
  try {
    prior = pickFlows(JSON.parse(readFileSync(SAVED, 'utf8')))
  } catch {
    // Nothing saved yet.
  }
  writeFileSync(SAVED, JSON.stringify({ ...prior, ...flows }, null, 2))
  try {
    chmodSync(SAVED, 0o600)
  } catch {
    // The folder is private to the user anyway.
  }
  return loadFlows()
}

export function forgetFlows() {
  rmSync(SAVED, { force: true })
  return loadFlows()
}

// ---------------------------------------------------------------------------
// Calling a flow
// ---------------------------------------------------------------------------

async function callFlow(key, body = {}, timeoutMs = 60_000) {
  const url = (cache ?? loadFlows()).flows[key]
  if (!url) {
    throw new Error(
      `the ${FLOWS[key] ?? key} flow is not set up — add "${key}" to ~/.jarvis/power-automate.json`,
    )
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await res.text()
  if (!res.ok) {
    // Never echo the URL: it is the credential.
    throw new Error(`the ${FLOWS[key] ?? key} flow answered ${res.status}`)
  }
  try {
    return text ? JSON.parse(text) : {}
  } catch {
    return {}
  }
}

const list = (data) => (Array.isArray(data?.value) ? data.value : Array.isArray(data) ? data : [])

/**
 * Power Automate's calendar view returns start and end as UTC wall-clock with
 * no offset ("2026-09-24T14:30:00.0000000"). Read without a zone they land
 * hours off, so they are pinned to UTC here and reported in local time.
 */
export function utcWallClock(s) {
  if (!s || typeof s !== 'string') return null
  const trimmed = s.replace(/(\.\d{3})\d+/, '$1')
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(trimmed) ? trimmed : `${trimmed}Z`)
  return Number.isNaN(d.getTime()) ? null : d
}

const localIso = (d) => {
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const pad = (n) => String(Math.floor(Math.abs(n))).padStart(2, '0')
  const local = new Date(d.getTime() + off * 60_000).toISOString().slice(0, 19)
  return `${local}${sign}${pad(off / 60)}:${pad(off % 60)}`
}

const addr = (v) =>
  typeof v === 'string' ? v : v?.emailAddress?.address ?? v?.address ?? v?.emailAddress?.name ?? ''

export function normaliseMail(m) {
  return {
    id: m.id ?? '',
    from: addr(m.from),
    subject: m.subject ?? '',
    preview: (m.bodyPreview ?? m.preview ?? '').slice(0, 300),
    received: m.receivedDateTime ?? m.received ?? '',
    importance: m.importance ?? 'normal',
    unread: m.isRead === false,
  }
}

export function normaliseEvent(e) {
  const start = utcWallClock(e.start?.dateTime ?? e.start)
  const end = utcWallClock(e.end?.dateTime ?? e.end)
  const attendees = (e.requiredAttendees ?? e.attendees ?? '')
  return {
    id: e.id ?? e.iCalUId ?? '',
    title: e.subject ?? e.title ?? '(no title)',
    start: start ? localIso(start) : '',
    end: end ? localIso(end) : '',
    allDay: Boolean(e.isAllDay),
    where: e.location?.displayName ?? (typeof e.location === 'string' ? e.location : '') ?? '',
    organizer: addr(e.organizer),
    attendees: Array.isArray(attendees)
      ? attendees.map((a) => addr(a.emailAddress ?? a)).filter(Boolean).slice(0, 20)
      : String(attendees).split(';').map((s) => s.trim()).filter(Boolean).slice(0, 20),
    showAs: e.showAs ?? '',
    cancelled: Boolean(e.isCancelled),
    // Outlook's labels and its "!" flag: an 'Important' label (or high
    // importance) is what makes a meeting worth a spoken heads-up.
    importance: e.importance ?? 'normal',
    categories: Array.isArray(e.categories) ? e.categories.map(String).slice(0, 10) : [],
    // The Teams (or Zoom, Meet, Webex) link, for the heads-up's Join button.
    join: joinUrl(
      e.onlineMeeting?.joinUrl,
      e.onlineMeetingUrl,
      e.joinUrl,
      typeof e.location === 'string' ? e.location : e.location?.displayName,
      typeof e.body === 'string' ? e.body : e.body?.content,
      e.bodyPreview,
    ),
  }
}

export function flattenTodo(groups) {
  const rows = []
  for (const g of groups) {
    for (const t of g?.tasks ?? []) {
      if (t?.status === 'completed') continue
      rows.push({
        // Kept when the flow returns it: the brief links a task line to it.
        ...(t.id ? { id: String(t.id) } : {}),
        list: g.list ?? '',
        title: t.title ?? '',
        importance: t.importance ?? 'normal',
        created: t.createdDateTime ?? '',
        due: t.dueDateTime?.dateTime ?? t.dueDateTime ?? null,
      })
    }
  }
  return rows
}

/** The local calendar day ("YYYY-MM-DD") a spoken day refers to. */
export function dayOf(day) {
  const d = new Date()
  if (!day || day === 'today') return localIso(d).slice(0, 10)
  if (day === 'tomorrow') return localIso(new Date(d.getTime() + 86_400_000)).slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : localIso(d).slice(0, 10)
}

// Plain functions, used by the tools below and by the briefing.
export const protective = {
  async inbox(limit = 25) {
    return list(await callFlow('inbox')).map(normaliseMail).slice(0, limit)
  },
  async calendar(day) {
    const want = dayOf(day)
    return list(await callFlow('calendar'))
      .map(normaliseEvent)
      .filter((e) => !e.cancelled && e.start.slice(0, 10) === want)
      .sort((a, b) => a.start.localeCompare(b.start))
  },
  async todo() {
    return flattenTodo(list(await callFlow('todo')))
  },
  async flagged() {
    return list(await callFlow('flagged_email')).map(normaliseMail)
  },
  /** Optional: only when a "sent_email" flow has been added. */
  async sent(limit = 25) {
    return list(await callFlow('sent_email')).map(normaliseSent).slice(0, limit)
  },
  /**
   * Optional ("meeting_notes" flow): what Microsoft has on one meeting, for
   * when Granola has nothing — he was not on the call, or Granola was not
   * running. The flow tries Copilot's meeting notes, then the Teams transcript,
   * then a recap email in the inbox, and says which it found.
   */
  async meetingNotes({ subject, start, end }) {
    return normaliseNotes(await callFlow('meeting_notes', { subject, start, end: end ?? '' }, 90_000))
  },
}

/**
 * The meeting-notes flow's answer, bounded and made readable: a transcript
 * can run to a hundred thousand characters, and all of it would go into the
 * turn. Copilot's notes arrive as Graph's meetingNotes serialised to a JSON
 * string, the transcript as WebVTT, and the sender as a stringified Graph
 * recipient; each is turned into plain text here so the model reads prose,
 * not markup.
 */
export function normaliseNotes(r) {
  const s = (v, n) => (typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v)).slice(0, n)
  const items = Array.isArray(r?.actionItems) ? r.actionItems : []
  // The flow starts with an empty email object and fills it only when one is found.
  const email = r?.email && typeof r.email === 'object' && (r.email.subject || r.email.body) ? r.email : null
  const source = ['copilot', 'transcript', 'email', 'none'].includes(r?.source) ? r.source : 'none'
  const status = graphStatus(r?.errors)
  const errors = status.errors
  // No Graph errors and no Copilot or transcript: the flow didn't ask Graph
  // (Protective doesn't grant it), which is not the same as "available".
  const copilot = status.copilot === 'available' && source !== 'copilot' && source !== 'transcript' ? 'not asked' : status.copilot
  return {
    source,
    meeting: s(r?.meeting, 200),
    notes: s(copilotNotes(r?.notes), 20_000),
    actionItems: items.map((i) => s(actionItem(i), 400)).filter(Boolean).slice(0, 30),
    transcript: s(vttText(r?.transcript), 60_000),
    email: email ? { subject: s(email.subject, 300), from: s(sender(email.from), 200), received: s(email.received, 40), body: s(email.body, 20_000) } : null,
    copilot,
    errors: errors.map((e) => s(e, 300)).slice(0, 5),
  }
}

const parsed = (v) => {
  if (typeof v !== 'string' || !/^\s*[[{]/.test(v)) return v
  try {
    return JSON.parse(v)
  } catch {
    return v
  }
}

/** Graph's meetingNotes ([{ title, text, subpoints: [{ title, text }] }]) as plain lines. */
function copilotNotes(v) {
  const notes = parsed(v)
  if (typeof notes === 'string' || notes == null) return notes ?? ''
  const list = Array.isArray(notes) ? notes : Array.isArray(notes?.value) ? notes.value : [notes]
  const line = (n) => [n?.title, n?.text].filter(Boolean).join(': ')
  return list
    .map((n) => [line(n), ...(Array.isArray(n?.subpoints) ? n.subpoints.map((p) => `  - ${line(p)}`) : [])].filter((l) => l.trim() && l.trim() !== '-').join('\n'))
    .filter(Boolean)
    .join('\n')
}

/** A Copilot action item ({ title, text, ownerDisplayName }) or a plain string. */
function actionItem(i) {
  if (typeof i === 'string') return i
  const what = i?.text ?? i?.title ?? ''
  const who = i?.ownerDisplayName
  return what ? (who ? `${what} (${who})` : what) : i
}

/** WebVTT down to "Speaker: words" lines: cue numbers, timings and tags go. */
function vttText(v) {
  if (typeof v !== 'string' || !/^\uFEFF?WEBVTT/.test(v)) return v
  const out = []
  for (const raw of v.split(/\r?\n/)) {
    const l = raw.trim()
    if (!l || /^\uFEFF?WEBVTT/.test(l) || /-->/.test(l) || /^(NOTE|\d+$|[\w-]+\/\d+-\d+$)/i.test(l)) continue
    const m = l.match(/^<v\s+([^>]+)>(.*?)(?:<\/v>)?$/)
    const line = m ? `${m[1].trim()}: ${m[2]}` : l.replace(/<[^>]+>/g, '')
    // Teams splits one speaker's sentence across cues; join them back up.
    const who = m ? `${m[1].trim()}: ` : null
    if (who && out.length && out[out.length - 1].startsWith(who)) out[out.length - 1] += ` ${m[2]}`
    else out.push(line)
  }
  return out.join('\n')
}

/** "Name <address>" from a stringified Graph recipient, or the string as sent. */
function sender(v) {
  const f = parsed(v)
  const a = f?.emailAddress ?? f
  if (a && typeof a === 'object') return [a.name, a.address && `<${a.address}>`].filter(Boolean).join(' ')
  return f
}

/**
 * What the flow's Graph errors mean. Until Protective grants the connector's
 * app OnlineMeetings.Read and the transcript and AI-insight permissions,
 * every call fails at Get_online_meeting with a 403: expected, not news, and
 * the recap email still works. A 401 "Invalid token lifetime" means the
 * connection has expired and he can fix it (Power Automate → Connections →
 * Reconnect). A 404 for a missing transcript, or a v1.0 refusal when beta
 * answered, is noise. Only what is left is passed on as `errors`.
 */
export function graphStatus(list) {
  const all = (Array.isArray(list) ? list : []).map((e) => String(e ?? ''))
  const reconnect = all.some((e) => /\b401\b/.test(e) && /token/i.test(e))
  const blocked = all.some((e) => /\b403\b/.test(e) && /online_?meeting|insufficient|permission/i.test(e))
  const noise = (e) =>
    (/\b403\b/.test(e) && /online_?meeting|insufficient|permission/i.test(e)) ||
    (/\b401\b/.test(e) && /token/i.test(e)) ||
    (/transcript/i.test(e) && /\b404\b/.test(e)) ||
    /insights?/i.test(e)
  const copilot = reconnect
    ? 'reconnect: the Microsoft Graph connection in Power Automate has expired; Power Automate → Connections → Reconnect'
    : blocked
      ? 'not granted: Protective has not given the flow access to Copilot notes or transcripts yet'
      : 'available'
  return { copilot, errors: all.filter((e) => e && !noise(e)) }
}

export const hasFlow = (key) => Boolean((cache ?? loadFlows()).flows[key])

export function normaliseSent(m) {
  const to = m.toRecipients ?? m.to ?? []
  return {
    id: m.id ?? '',
    to: Array.isArray(to) ? to.map(addr).filter(Boolean).slice(0, 8) : String(to),
    subject: m.subject ?? '',
    preview: (m.bodyPreview ?? m.preview ?? '').slice(0, 400),
    sent: m.sentDateTime ?? m.sent ?? m.receivedDateTime ?? '',
  }
}

// ---------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------

const text = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] })
const failed = (err) => ({ content: [{ type: 'text', text: `Protective is unavailable: ${err.message}` }], isError: true })

/**
 * `readOnly` builds the reading tools only — what the background watcher and
 * the briefing get, so neither could draft, send or add anything even if
 * asked to. `onNoNotes(subject)` is told when the meeting-notes flow found
 * nothing at all for a meeting.
 */
export function protectiveServer({ readOnly = false, onNoNotes } = {}) {
  const tools = [
    tool(
      'protective_get_inbox',
      'The Protective (work) inbox, Mark.Slyder@protective.com: the latest messages, newest first, ' +
        'with sender, subject, a preview, importance and whether unread. This is the main work mailbox.',
      { limit: z.number().int().min(1).max(25).optional() },
      async ({ limit }) => {
        try {
          return text(await protective.inbox(limit ?? 25))
        } catch (err) {
          return failed(err)
        }
      },
    ),
    tool(
      'protective_get_calendar',
      'The Protective (work) calendar for one day: title, local start and end, place, organizer and ' +
        'attendees. Includes recurring meetings. This is the main work calendar.',
      { day: z.string().optional().describe('"today" (default), "tomorrow", or YYYY-MM-DD') },
      async ({ day }) => {
        try {
          return text(await protective.calendar(day))
        } catch (err) {
          return failed(err)
        }
      },
    ),
    tool(
      'protective_get_todo',
      'Open Microsoft To Do tasks on the Protective account, grouped by list (Flagged Emails, Daily ' +
        'Meeting Actions, Tasks, Waiting On Others). Completed tasks are left out.',
      {},
      async () => {
        try {
          return text(await protective.todo())
        } catch (err) {
          return failed(err)
        }
      },
    ),
    tool(
      'protective_get_flagged',
      'Mail flagged in Outlook on the Protective account. A different set from the To Do "Flagged ' +
        'Emails" list; never merge the two.',
      {},
      async () => {
        try {
          return text(await protective.flagged())
        } catch (err) {
          return failed(err)
        }
      },
    ),
  ]
  if (hasFlow('meeting_notes')) {
    tools.push(
      tool(
        'protective_get_meeting_notes',
        'What Microsoft has on one Protective meeting when Granola has nothing (he was not on the call, ' +
          'or Granola was not running): Copilot\'s meeting notes and action items, else the Teams ' +
          'transcript, else a recap email in the inbox. `source` says which (none when there is nothing); ' +
          '`copilot` says whether Copilot and transcripts can be read at all. ' +
          'Give the meeting\'s subject as on the calendar and its start (ISO 8601).',
        {
          subject: z.string().min(2).max(300),
          start: z.string().min(10).describe('The meeting start, ISO 8601, from the calendar.'),
          end: z.string().optional(),
        },
        async ({ subject, start, end }) => {
          try {
            const notes = await protective.meetingNotes({ subject, start, end })
            // Nothing anywhere: the meeting's card says how to get a recap
            // into the inbox (server.mjs), so the next try finds it.
            if (notes.source === 'none') onNoNotes?.(subject)
            return text(notes)
          } catch (err) {
            return failed(err)
          }
        },
      ),
    )
  }
  if (hasFlow('sent_email')) {
    tools.push(
      tool(
        'protective_get_sent',
        'Mail Mark sent from the Protective account, newest first: recipients, subject and a preview. ' +
          'Use it for what he promised people and replies he already made.',
        { limit: z.number().int().min(1).max(25).optional() },
        async ({ limit }) => {
          try {
            return text(await protective.sent(limit ?? 25))
          } catch (err) {
            return failed(err)
          }
        },
      ),
    )
  }
  if (!readOnly) {
    tools.push(
      tool(
        'protective_create_draft',
        'Save a draft email in the Protective Drafts folder, from Mark.Slyder@protective.com. It is NOT ' +
          'sent. Use for replies he should review.',
        {
          to: z.string().min(3),
          subject: z.string().min(1),
          body: z.string().min(1).describe('Simple HTML: <p> and <br>.'),
          cc: z.string().optional(),
        },
        async ({ to, subject, body, cc }) => {
          try {
            await callFlow('draft_email', { to, subject, body, cc: cc ?? '' }, 30_000)
            return text('Draft saved in the Protective Drafts folder.')
          } catch (err) {
            return failed(err)
          }
        },
      ),
      tool(
        'protective_send_email',
        'Send an email from Mark.Slyder@protective.com. It goes immediately.',
        {
          to: z.string().min(3),
          subject: z.string().min(1),
          body: z.string().min(1).describe('Simple HTML: <p> and <br>.'),
          cc: z.string().optional(),
        },
        async ({ to, subject, body, cc }) => {
          try {
            await callFlow('send_email', { to, subject, body, cc: cc ?? '' }, 30_000)
            return text('Sent.')
          } catch (err) {
            return failed(err)
          }
        },
      ),
      tool(
        'protective_create_tasks',
        'Add tasks to Microsoft To Do on the Protective account in one go: "me" goes to Daily Meeting ' +
          'Actions, "waiting" (someone else owes it) to Waiting On Others. Each title is prefixed with the ' +
          'meeting it came from, as the nightly meeting recap does.',
        {
          tasks: z
            .array(
              z.object({
                text: z.string().min(3).max(300),
                kind: z.enum(['me', 'waiting']),
                due: z.string().regex(/^(\d{4}-\d{2}-\d{2}|none)$/).optional(),
                meeting: z.string().max(120).optional(),
              }),
            )
            .min(1)
            .max(15),
        },
        async ({ tasks }) => {
          let done = 0
          const problems = []
          for (const t of tasks) {
            const key = t.kind === 'waiting' ? 'todo_waiting' : 'todo_add'
            const title = t.meeting ? `${t.meeting} — ${t.text}` : t.text
            try {
              await callFlow(key, { text: title, due: t.due ?? 'none', meeting: t.meeting ?? '' }, 30_000)
              done++
            } catch (err) {
              problems.push(err.message)
            }
          }
          return problems.length
            ? { ...text(`Added ${done} of ${tasks.length}. ${[...new Set(problems)].join('; ')}`), isError: done === 0 }
            : text(`Added ${done} task${done === 1 ? '' : 's'} to To Do.`)
        },
      ),
    )
  }
  return createSdkMcpServer({ name: 'protective', version: '1.0.0', tools })
}
