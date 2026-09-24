import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { askReadOnly, SOURCES } from './agent.mjs'
import { todaysBrief } from './briefing.mjs'
import { firstToday, inWindow, localDay, recordDay } from './days.mjs'
import { protectiveConfigured } from './protective.mjs'
import { read } from './snapshot.mjs'
import {
  addCommitments,
  closeCommitment,
  commitmentsWith,
  openCommitments,
  scanCommitments,
} from './commitments.mjs'

/**
 * Closing the loop: the end-of-day wrap, who-am-I-meeting dossiers, and the
 * tools over the commitment ledger.
 *
 * The brief says what to do; these make sure what was promised — by him or to
 * him — does not quietly slip. All the gathering is read-only; the only
 * writes are to the ledger in ~/.jarvis, and adding tasks to To Do goes
 * through the conversation's own confirmed `protective_create_tasks`.
 */

const WRAP_HOURS = process.env.JARVIS_WRAP_HOURS ?? '17-20'
const WRAP_MAX_AGE_MS = 60 * 60_000
const DOSSIER_MAX_AGE_MS = 2 * 60 * 60_000

// ---------------------------------------------------------------------------
// The wrap
// ---------------------------------------------------------------------------

const WRAP_PROMPT = `You prepare Mark's end-of-day wrap-up. He is a CTO. You never talk to
him; you return ONE JSON object and nothing else — no prose, no markdown fences.

${SOURCES}

You are given this morning's brief (if there was one) and his open commitments.
Work out, by reading the mail, To Do and calendar as they are NOW:
- done: brief items that got done today — a reply sent, a task completed, a
  decision made in a meeting. Evidence only; never assume. Making a promise is
  not getting something done: an open commitment is never "done".
- slipped: brief items and commitments due today or earlier that did not happen.
- owed: replies he still owes — mail from a real person asking him something
  that he has not answered. Protective first. At most five.
- tomorrow: the first thing to do tomorrow morning, given tomorrow's calendar
  (protective_get_calendar with day "tomorrow", and SCG) and what slipped.
- tasks: what should go on To Do so nothing is lost overnight — slipped items
  and owed replies not already on To Do. "me" for his, "waiting" for things
  others owe him. Due as YYYY-MM-DD only when there is a real date.

Answer exactly:
{"summary":"<one or two spoken sentences: how the day went and the one thing that matters most now>",
 "done":["<short>"],
 "slipped":[{"what":"<verb phrase>","who":"<person or empty>","why":"<under 10 words>"}],
 "owed":[{"who":"<person>","about":"<what they asked, under 12 words>","account":"Protective|SCG|Gmail"}],
 "tomorrow":"<one spoken sentence>",
 "tasks":[{"text":"<verb phrase>","kind":"me|waiting","due":"YYYY-MM-DD|none"}]}`

let wrapCache = null
let wrapBuilding = null

export function getWrap(deps, { refresh = false } = {}) {
  const fresh = wrapCache && wrapCache.day === localDay() && Date.now() - wrapCache.builtAt < WRAP_MAX_AGE_MS
  if (fresh && !refresh) return Promise.resolve(wrapCache)
  wrapBuilding ??= (async () => {
    const brief = todaysBrief()?.brief ?? null
    const wrap = await askReadOnly(deps, {
      system: WRAP_PROMPT,
      question:
        `It is ${deps.localNow()}. Wrap up today.\n` +
        `This morning's brief: ${brief ? JSON.stringify(brief) : 'none was built today'}\n` +
        `Open commitments: ${JSON.stringify(openCommitments().slice(0, 30))}`,
      label: 'wrap',
    })
    if (!wrap?.summary) throw new Error('the wrap-up did not come back as expected')
    wrap.owed = (wrap.owed ?? []).slice(0, 5)
    wrap.tasks = (wrap.tasks ?? []).slice(0, 12)
    wrapCache = { day: localDay(), builtAt: Date.now(), wrap }
    recordDay({ wrap })
    await logMeetings()
    return wrapCache
  })().finally(() => {
    wrapBuilding = null
  })
  return wrapBuilding
}

/**
 * Today's Protective meetings, into the day log, for the weekly review's
 * where-did-the-time-go. A plain flow call, no model.
 */
export async function logMeetings() {
  if (!protectiveConfigured()) return
  try {
    const events = await read('calendar')
    if (!events) return
    recordDay({
      meetings: events
        .filter((e) => !e.allDay && e.showAs !== 'free')
        .map((e) => ({ title: e.title, start: e.start, end: e.end, people: e.attendees.length })),
    })
  } catch (err) {
    console.warn(`[jarvis] day log: ${err.message}`)
  }
}

/** Evening: build the wrap in the background and offer it, once a weekday. */
export function maybeOfferWrap(deps, broadcast) {
  if (process.env.JARVIS_WRAP === 'off' || !inWindow(WRAP_HOURS)) return
  if (!firstToday('wrap')) return
  getWrap(deps)
    .then(({ wrap }) =>
      broadcast({
        kind: 'wrap',
        label: 'Wrap-up',
        title: 'Ready to wrap up the day',
        detail: wrap.summary,
        say: "Sir, your wrap-up is ready when you are — say 'wrap up my day'.",
        at: new Date().toISOString(),
      }),
    )
    .catch((err) => console.warn(`[jarvis] wrap: ${err.message}`))
}

// ---------------------------------------------------------------------------
// Dossiers
// ---------------------------------------------------------------------------

const DOSSIER_PROMPT = `You prepare a short dossier on the people Mark, a CTO, is about to meet.
You never talk to him; you return ONE JSON object and nothing else.

${SOURCES}

For each person: who they are to him if it is clear (role, team, company); the
last three times they interacted — meetings in Granola, mail threads in any
mailbox — newest first, each in a clause; and anything open between them. You
are given the open commitments already on record with these people: use them,
and add any you find that are not there.

Answer exactly:
{"summary":"<one or two spoken sentences: the most useful thing to know walking in>",
 "people":[{"name":"...","role":"<or empty>",
   "last":[{"when":"<spoken, e.g. last Tuesday>","what":"<clause>","source":"meeting|email"}],
   "youOwe":["<verb phrase>"],"theyOwe":["<verb phrase>"],"open":["<unresolved topic>"]}]}`

const dossiers = new Map()

export async function getDossier(deps, { people, meeting, refresh = false }) {
  const names = people.map((p) => String(p).trim()).filter(Boolean).slice(0, 8)
  const key = `${names.map((n) => n.toLowerCase()).sort().join('|')}|${meeting ?? ''}`
  const hit = dossiers.get(key)
  if (hit && !refresh && Date.now() - hit.builtAt < DOSSIER_MAX_AGE_MS) return hit
  const dossier = await askReadOnly(deps, {
    system: DOSSIER_PROMPT,
    question:
      `It is ${deps.localNow()}. People: ${names.join(', ')}.` +
      (meeting ? ` Meeting: "${meeting}".` : '') +
      `\nCommitments on record with them: ${JSON.stringify(commitmentsWith(names))}`,
    label: 'dossier',
    maxTurns: 20,
  })
  if (!dossier?.people) throw new Error('the dossier did not come back as expected')
  const entry = { builtAt: Date.now(), dossier }
  dossiers.set(key, entry)
  return entry
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const out = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] })
const fail = (what, err) => ({
  content: [{ type: 'text', text: `${what} could not be built: ${err.message}. Gather what you can directly.` }],
  isError: true,
})

export function loopServer(deps) {
  return createSdkMcpServer({
    name: 'jarvis_loop',
    version: '1.0.0',
    tools: [
      tool(
        'get_day_wrap',
        'The end-of-day wrap-up: what got done against this morning\'s brief, what slipped, replies he ' +
          'still owes, the first thing for tomorrow, and the tasks to add to To Do so nothing is lost ' +
          'overnight. Use for "wrap up my day", "shut down", "how did today go". Takes about a minute ' +
          'the first time; cached for an hour.',
        { refresh: z.boolean().optional() },
        async ({ refresh }) => {
          try {
            const { wrap, builtAt } = await getWrap(deps, { refresh: Boolean(refresh) })
            return out({ builtMinutesAgo: Math.round((Date.now() - builtAt) / 60_000), ...wrap })
          } catch (err) {
            return fail('The wrap-up', err)
          }
        },
      ),
      tool(
        'get_dossier',
        'Who he is meeting: for each person, their role, the last three interactions (Granola meetings, ' +
          'mail in any account), what he owes them, what they owe him, and open topics. Use before a ' +
          'meeting, or for "tell me about Chris", "what\'s open with Cathrene".',
        {
          people: z.array(z.string().min(1)).min(1).max(8).describe('Names or addresses.'),
          meeting: z.string().optional().describe('The meeting title, when there is one.'),
          refresh: z.boolean().optional(),
        },
        async ({ people, meeting, refresh }) => {
          try {
            const { dossier } = await getDossier(deps, { people, meeting, refresh: Boolean(refresh) })
            return out(dossier)
          } catch (err) {
            return fail('The dossier', err)
          }
        },
      ),
      tool(
        'get_commitments',
        'The promise ledger: open commitments, his ("mine") and other people\'s to him ("theirs"), soonest ' +
          'due first, each with daysLeft (negative when late). Filter by person or direction. Use for ' +
          '"what did I promise", "what do I owe Chris", "who owes me what", "what\'s late".',
        {
          who: z.string().optional(),
          direction: z.enum(['mine', 'theirs']).optional(),
        },
        async ({ who, direction }) => out(openCommitments({ who, direction })),
      ),
      tool(
        'commitment_add',
        'Record a promise he states: "I promised Chris the roadmap by Friday" (mine) or "Sam owes me the ' +
          'estimate" (theirs). Due as YYYY-MM-DD when a day was said.',
        {
          direction: z.enum(['mine', 'theirs']),
          who: z.string().min(1),
          what: z.string().min(4).describe('A short verb phrase: "send the revised roadmap".'),
          due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        },
        async (c) => {
          const added = addCommitments([c], { source: 'said' })
          return out(added.length ? { added: added[0] } : { note: 'Already on record.' })
        },
      ),
      tool(
        'commitment_close',
        'Mark a commitment kept ("done") or no longer wanted ("dropped"), by its id from get_commitments.',
        { id: z.string().min(4), status: z.enum(['done', 'dropped']) },
        async ({ id, status }) => {
          const item = closeCommitment(id, status)
          return item ? out({ closed: item }) : { ...out({ error: 'No commitment with that id.' }), isError: true }
        },
      ),
      tool(
        'scan_commitments',
        'Look through recent meetings, sent mail and Waiting On Others for new promises and ones that ' +
          'have been kept. Runs on its own every few hours; call it only when asked to check now.',
        {},
        async () => {
          try {
            const { added, kept } = await scanCommitments(deps)
            return out({ added, kept })
          } catch (err) {
            return fail('The scan', err)
          }
        },
      ),
    ],
  })
}
