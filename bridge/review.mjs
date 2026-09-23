import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { askReadOnly, SOURCES } from './agent.mjs'
import { firstToday, inWindow, localDay, recentDays } from './days.mjs'
import { readLedger } from './commitments.mjs'
import { logMeetings } from './loop.mjs'
import { memoryPrompt } from './memory.mjs'
import { weekOfSnapshots } from './portfolio.mjs'

/**
 * The weekly CTO review, on Friday afternoon: wins, slips and risks across the
 * portfolio; promises kept and broken; where the week's hours actually went
 * against his stated priorities; and a draft of the weekly update for
 * leadership.
 *
 * Built from what the week left behind — each day's brief and wrap and
 * Protective meetings in ~/.jarvis/days, the portfolio snapshots, the promise
 * ledger — plus a fresh read of SCG's calendar and Jira. Stated priorities
 * come from memory: "remember my priorities this quarter are…".
 */

const HOURS = process.env.JARVIS_REVIEW_HOURS ?? '14-18'
const MAX_AGE_MS = 3 * 60 * 60_000

/** Hours in meetings per day, from the day log. No model. */
export function meetingHours(days) {
  const out = []
  for (const d of days) {
    let mins = 0
    for (const m of d.meetings ?? []) {
      const a = Date.parse(m.start)
      const b = Date.parse(m.end)
      if (!Number.isNaN(a) && !Number.isNaN(b) && b > a) mins += (b - a) / 60_000
    }
    out.push({ day: d.day, meetings: (d.meetings ?? []).length, hours: Math.round((mins / 60) * 10) / 10 })
  }
  return out
}

const PROMPT = `You prepare Mark's weekly review. He is a CTO. You never talk to him; you
return ONE JSON object and nothing else — no prose, no markdown fences.

${SOURCES}

You are given what the week left behind: each day's morning brief and evening
wrap, the Protective meetings of each day, portfolio snapshots, the promise
ledger, and his stated priorities (from memory — there may be none).

- wins: what actually shipped, closed or got decided this week. Specific.
  Evidence only. A promise made, a date agreed or a task created is not a
  win; a commitment still open in the ledger is never one. Few real wins
  beat padded ones — say so plainly if the week had none.
- slips: what was meant to happen and did not — brief items that kept coming
  back, broken promises, sprint work that did not land.
- risks: what is building up for next week.
- time: put every meeting of the week (Protective from the log, SCG from its
  calendar) into three to six buckets that make sense for him — vendor and
  commercial, delivery reviews, one-to-ones, architecture and roadmap,
  hiring, external — with hours and share of meeting time. Then one spoken
  sentence comparing that against his stated priorities, or saying none are
  on record.
- promises: counts of his commitments kept, still open, and late; theirs late.
- update: a weekly update for leadership in the Progress / Plans / Problems
  form — short, concrete, no filler — as simple HTML (<h3>, <ul>, <li>, <p>).

Answer exactly:
{"headline":"<one or two spoken sentences: the week in a line, then the one thing for next week>",
 "wins":["..."],"slips":["..."],"risks":["..."],
 "time":{"meetingHours":0,"buckets":[{"name":"...","hours":0,"pct":0}],"vsPriorities":"<one sentence>"},
 "promises":{"kept":0,"open":0,"late":0,"theirsLate":0},
 "update":{"subject":"Weekly update — <week of …>","html":"..."}}`

let cache = null
let building = null

export function getReview(deps, { refresh = false } = {}) {
  const fresh = cache && cache.day === localDay() && Date.now() - cache.builtAt < MAX_AGE_MS
  if (fresh && !refresh) return Promise.resolve(cache)
  building ??= (async () => {
    await logMeetings()
    const days = recentDays(7)
    const ledger = readLedger()
    const weekAgo = localDay(new Date(Date.now() - 7 * 86_400_000))
    const promises = ledger.items.filter((i) => i.status === 'open' || (i.closed ?? '') >= weekAgo)
    const review = await askReadOnly(deps, {
      system: PROMPT,
      question:
        `It is ${deps.localNow()}. Review the week.\n` +
        `Day log: ${JSON.stringify(days)}\n` +
        `Meeting hours by day (Protective): ${JSON.stringify(meetingHours(days))}\n` +
        `Portfolio snapshots: ${JSON.stringify(weekOfSnapshots(7))}\n` +
        `Promise ledger (this week): ${JSON.stringify(promises)}\n` +
        `What he has told you (priorities may be here): ${memoryPrompt() || 'nothing on record'}`,
      label: 'weekly review',
      maxTurns: 30,
      timeoutMs: 8 * 60_000,
    })
    if (!review?.headline) throw new Error('the weekly review did not come back as expected')
    cache = { day: localDay(), builtAt: Date.now(), review }
    return cache
  })().finally(() => {
    building = null
  })
  return building
}

/** Friday afternoon: build it in the background and offer it, once. */
export function maybeOfferReview(deps, broadcast) {
  if (process.env.JARVIS_REVIEW === 'off' || !inWindow(HOURS, [5])) return
  if (!firstToday('review')) return
  getReview(deps)
    .then(({ review }) =>
      broadcast({
        kind: 'review',
        label: 'Weekly review',
        title: 'Your weekly review is ready',
        detail: review.headline,
        say: "Sir, your weekly review is ready — say 'weekly review' when you have a moment.",
        at: new Date().toISOString(),
      }),
    )
    .catch((err) => console.warn(`[jarvis] review: ${err.message}`))
}

export function reviewServer(deps) {
  return createSdkMcpServer({
    name: 'jarvis_review',
    version: '1.0.0',
    tools: [
      tool(
        'get_weekly_review',
        'The weekly CTO review: wins, slips and risks across the portfolio; promises kept and late; where ' +
          'the week\'s meeting hours went against his stated priorities; and a draft weekly update for ' +
          'leadership (Progress / Plans / Problems, as HTML). Use for "weekly review", "how did the week ' +
          'go", "draft my weekly update". Takes a few minutes the first time; cached for the afternoon.',
        { refresh: z.boolean().optional() },
        async ({ refresh }) => {
          try {
            const { review } = await getReview(deps, { refresh: Boolean(refresh) })
            return { content: [{ type: 'text', text: JSON.stringify(review) }] }
          } catch (err) {
            return {
              content: [{ type: 'text', text: `The review could not be built: ${err.message}.` }],
              isError: true,
            }
          }
        },
      ),
    ],
  })
}
