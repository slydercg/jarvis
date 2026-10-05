import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { askReadOnly } from './agent.mjs'
import { localDay, readJsonFile, writeJsonFile } from './days.mjs'
import { readLocalPage } from './localfiles.mjs'
import { learnSites, ticketUrl } from './tickets.mjs'

/**
 * The portfolio pulse: "what's blocked?", "which team is behind?", "what
 * changed since yesterday?" — across Jira and Azure DevOps, by voice.
 *
 * Two kinds of source, both read-only:
 *   - Jira live, through the Atlassian connector (JARVIS_JIRA_PROJECTS,
 *     NI and RPT by default), and Azure DevOps if a connector for it exists.
 *   - The dashboards already generated on this Mac — the portfolio dashboard
 *     carries Jira AND Azure DevOps data, pipelines included, which is how
 *     ADO gets in without any new credentials. JARVIS_PORTFOLIO_FILES names
 *     them (separated by ;), else they are found by name.
 *
 * Each pulse is kept as the day's snapshot, so "since yesterday" compares
 * against yesterday's, and the weekly review can see the week.
 */

/**
 * Built ahead of time during working hours (warmPulse, from the minute clock
 * in server.mjs), every JARVIS_PULSE_WARM_MIN minutes (30; 0 turns it off).
 * Built on demand, the pulse took minutes — long enough that he asked again,
 * and every repeat used to start it over. Kept ready, "what's blocked" is
 * answered in seconds. It counts as background spend, so the daily cap
 * (spend.mjs) stops it like any other unasked-for job.
 */
const WARM_MIN = Math.max(0, Number(process.env.JARVIS_PULSE_WARM_MIN ?? 30) || 0)
// Fresh for a little longer than the warming interval, so a pulse is never
// rebuilt on demand in the gap before the next one is warmed.
const MAX_AGE_MS = Math.max(30, WARM_MIN + 15) * 60_000
// The last pulse survives a restart, so the morning's first question after
// an update or a reboot is not the slow one.
const CACHE_FILE = 'portfolio-pulse.json'
const PROJECTS = (process.env.JARVIS_JIRA_PROJECTS ?? 'NI,RPT').split(',').map((s) => s.trim()).filter(Boolean)
const SNAPSHOTS = 'portfolio-snapshots.json'
const KEEP = 14

/** Dashboards on this Mac, newest first. */
export function dashboardFiles() {
  const listed = (process.env.JARVIS_PORTFOLIO_FILES ?? '').split(';').map((s) => s.trim()).filter(Boolean)
  if (listed.length) return listed.map((p) => p.replace(/^~/, homedir())).filter((p) => existsSync(p))
  const home = homedir()
  const found = []
  const look = (dir, test) => {
    try {
      for (const f of readdirSync(dir)) if (test(f)) found.push(join(dir, f))
    } catch {
      // Not there.
    }
  }
  const apps = join(home, 'Claude Code Applications')
  try {
    for (const d of readdirSync(apps)) look(join(apps, d), (f) => /dashboard.*\.html?$/i.test(f))
  } catch {
    // No projects folder.
  }
  for (const d of ['Downloads', 'Desktop', 'Documents']) look(join(home, d), (f) => /^portfolio_dashboard.*\.html?$/i.test(f))
  return found
    .map((p) => ({ p, t: statSync(p).mtimeMs }))
    .sort((a, b) => b.t - a.t)
    .slice(0, 3)
    .map((x) => x.p)
}

const PROMPT = `You report on Mark's delivery portfolio. He is a CTO. You never talk to
him; you return ONE JSON object and nothing else — no prose, no markdown fences.

Sources:
- Jira, live: search for the Jira tools with ToolSearch ("jira"). Projects: ${PROJECTS.join(', ')}.
  Open sprints: what is blocked or on hold, what is high priority and not moving,
  each sprint's dates and done-versus-total.
- Azure DevOps, if a tool for it is connected.
- The dashboards from this Mac, given to you below: they carry Jira AND Azure
  DevOps data (work items, pipelines). Say how old they are when you lean on them.
- Yesterday's snapshot, given below: use it for what changed.

Judge like a CTO: what is blocked and who can unblock it, which team or sprint
is behind (time gone versus work done), failing pipelines, risks building up.
Keep keys (NI-123, ADO #4567) so he can ask about them.

Answer exactly:
{"summary":"<one or two spoken sentences: the most important thing, then the next>",
 "sites":{"jira":"<https://…atlassian.net, from the Jira tools, or empty>","ado":"<Azure DevOps org address or empty>"},
 "blocked":[{"key":"...","title":"...","owner":"...","since":"<spoken or empty>","source":"jira|ado","project":"<ADO project or empty>"}],
 "behind":[{"name":"<sprint or team>","done":0,"total":0,"elapsedPct":0,"note":"<under 12 words>"}],
 "pipelines":[{"name":"...","status":"failing|flaky","note":"..."}],
 "changed":["<what moved since yesterday, one clause each>"],
 "risks":["<one clause each>"],
 "sources":{"jira":"live|unavailable","ado":"live|dashboard|unavailable","dashboards":["<file, age>"]}}`

let cache = null
let cacheLoaded = false
function cached() {
  if (!cacheLoaded) {
    cacheLoaded = true
    const saved = readJsonFile(CACHE_FILE, null)
    if (saved?.pulse?.summary && Number.isFinite(saved.builtAt)) cache = saved
  }
  return cache
}
// In-flight builds by question. Shared only by the same question: a repeat
// (a second click, the question asked again while the first is still being
// worked out) waits for the build already running instead of starting a
// second minutes-long one, but a different question never gets another's
// answer.
const building = new Map()

function snapshots() {
  return readJsonFile(SNAPSHOTS, {})
}

export function getPulse(deps, { question, refresh = false } = {}) {
  // A fresh pulse answers a specific question too: it carries the whole
  // picture (blocked, behind, pipelines, changes, risks), and the question
  // only changed the summary, which the conversation writes anyway. A
  // question it cannot answer is the conversation's to take further, with
  // the Jira tools or refresh: true.
  const c = cached()
  if (c && Date.now() - c.builtAt < MAX_AGE_MS && !refresh) return Promise.resolve(c)
  const key = pulseKey(question)
  const running = building.get(key)
  if (running) return running
  const build = (async () => {
    const snaps = snapshots()
    const yesterday = Object.keys(snaps).filter((d) => d < localDay()).sort().pop()
    const boards = []
    for (const f of dashboardFiles()) {
      try {
        const page = await readLocalPage({ location: f, maxChars: 40_000 })
        boards.push(page)
      } catch (err) {
        console.warn(`[jarvis] portfolio: ${err.message}`)
      }
    }
    const pulse = await askReadOnly(deps, {
      system: PROMPT,
      question:
        `It is ${deps.localNow()}.` +
        (question ? ` He asked: "${question}". Answer that first in the summary.` : ' Give the pulse.') +
        `\nYesterday's snapshot (${yesterday ?? 'none'}): ${yesterday ? JSON.stringify(snaps[yesterday]) : 'none'}` +
        `\nDashboards on this Mac: ${boards.length ? JSON.stringify(boards) : 'none found'}`,
      label: 'portfolio pulse',
      maxTurns: 25,
      // Jira and Azure DevOps only; the Protective snapshot is not needed.
      protectiveData: false,
    })
    if (!pulse?.summary) throw new Error('the portfolio pulse did not come back as expected')
    // Links are built here from known sites, never taken from the model.
    if (pulse.sites) learnSites(pulse.sites)
    delete pulse.sites
    pulse.blocked = (Array.isArray(pulse.blocked) ? pulse.blocked : []).map((b) => {
      const url = ticketUrl(b)
      return url ? { ...b, url } : b
    })
    const entry = { builtAt: Date.now(), pulse }
    if (!question) {
      cache = entry
      writeJsonFile(CACHE_FILE, entry)
    }
    // Every pulse carries the whole picture (blocked, behind, pipelines), a
    // specific question only changes its summary — so every one is the
    // day's snapshot, the baseline for tomorrow's "what changed".
    const { summary: _summary, ...state } = pulse
    const next = { ...snaps, [localDay()]: { at: new Date().toISOString(), ...state } }
    for (const d of Object.keys(next).sort().slice(0, -KEEP)) delete next[d]
    writeJsonFile(SNAPSHOTS, next)
    return entry
  })().finally(() => {
    building.delete(key)
  })
  building.set(key, build)
  return build
}

/**
 * Build the general pulse now if it is due: none yet, or older than the
 * warming interval. The caller decides when (working hours, under the spend
 * cap). Never throws; a failure waits for the next interval.
 */
export function warmPulse(deps, now = Date.now()) {
  if (!pulseDue(now)) return null
  return getPulse(deps, { refresh: true }).catch((err) => {
    console.warn(`[jarvis] portfolio: warming the pulse failed: ${err.message}`)
    return null
  })
}

/** For Diagnostics: when the pulse was last built, and whether one is building. */
export function pulseStatus() {
  return { builtAt: cached()?.builtAt ?? 0, building: building.size > 0, warmMin: WARM_MIN }
}

export function pulseDue(now = Date.now()) {
  if (!WARM_MIN || building.has('')) return false
  const c = cached()
  return !c || now - c.builtAt >= WARM_MIN * 60_000
}

/** The same question however it was worded: case, spacing and punctuation don't count. */
export function pulseKey(question) {
  return (question ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

/**
 * What is blocked over time, from the daily snapshots (the last KEEP days):
 * the count each day and which way it is going, what has been blocked
 * longest (counted from the first snapshot it appears in), who holds the most,
 * and what came unblocked in the window. No model: the snapshots already hold
 * it, so "how's the trend?" is answered from the files.
 */
export function blockedTrend(snaps = snapshots()) {
  const days = Object.keys(snaps).sort()
  if (!days.length) return { days: 0, series: [], direction: 'unknown', longest: [], byOwner: [], cleared: [] }
  const keysOf = (d) => (Array.isArray(snaps[d]?.blocked) ? snaps[d].blocked : []).filter((b) => b?.key)
  const series = days.map((d) => ({ day: d, blocked: keysOf(d).length }))
  const latestDay = days.at(-1)
  const latest = keysOf(latestDay)
  const firstSeen = new Map()
  for (const d of days) for (const b of keysOf(d)) if (!firstSeen.has(b.key)) firstSeen.set(b.key, d)
  const dayDiff = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000)
  const longest = latest
    .map((b) => ({ key: b.key, title: b.title ?? '', owner: b.owner ?? '', since: firstSeen.get(b.key), days: dayDiff(firstSeen.get(b.key), latestDay) }))
    .sort((a, b) => b.days - a.days || a.key.localeCompare(b.key))
    .slice(0, 5)
  const owners = new Map()
  for (const b of latest) {
    const o = String(b.owner || 'Unassigned').trim()
    owners.set(o, (owners.get(o) ?? 0) + 1)
  }
  const byOwner = [...owners].map(([owner, count]) => ({ owner, count })).sort((a, b) => b.count - a.count).slice(0, 5)
  // Against a week ago, or the oldest snapshot there is.
  const weekAgo = days.filter((d) => dayDiff(d, latestDay) >= 7).at(-1) ?? days[0]
  const then = keysOf(weekAgo).length
  const now = latest.length
  const direction = weekAgo === latestDay ? 'unknown' : now > then ? 'rising' : now < then ? 'falling' : 'flat'
  const latestKeys = new Set(latest.map((b) => b.key))
  const cleared = [...new Map(days.filter((d) => d >= weekAgo).flatMap((d) => keysOf(d)).map((b) => [b.key, b])).values()]
    .filter((b) => !latestKeys.has(b.key))
    .map((b) => ({ key: b.key, title: b.title ?? '' }))
    .slice(0, 10)
  return { days: days.length, from: days[0], to: latestDay, series, direction, comparedWith: weekAgo, then, now, longest, byOwner, cleared }
}

/** The week's snapshots, for the weekly review. */
export function weekOfSnapshots(days = 7) {
  const cutoff = localDay(new Date(Date.now() - days * 86_400_000))
  return Object.fromEntries(Object.entries(snapshots()).filter(([d]) => d > cutoff))
}

export function portfolioServer(deps) {
  return createSdkMcpServer({
    name: 'jarvis_portfolio',
    version: '1.0.0',
    tools: [
      tool(
        'get_portfolio_trend',
        'How blocked work is trending, from the daily portfolio snapshots (up to two weeks): the count ' +
          'each day and whether it is rising or falling against a week ago, what has been blocked longest, ' +
          'who holds the most, and what came unblocked. Instant. Use for "how\'s the trend", "is it getting ' +
          'better", "what\'s been stuck longest", "who has the most blocked".',
        {},
        async () => ({ content: [{ type: 'text', text: JSON.stringify(blockedTrend()) }] }),
      ),
      tool(
        'get_portfolio_pulse',
        'The delivery portfolio across Jira and Azure DevOps: what is blocked and with whom, which ' +
          'sprints or teams are behind, failing pipelines, what changed since yesterday, risks. Use for ' +
          '"what\'s blocked across the portfolio", "which team is behind", "what changed since yesterday", ' +
          '"how\'s delivery looking". Pass `question` for something specific. Usually ready at once (it is ' +
          'kept up to date in the background); answer the question from what comes back, and only pass ' +
          'refresh: true if he asks for it to be checked again now (that takes minutes).',
        { question: z.string().max(300).optional(), refresh: z.boolean().optional() },
        async ({ question, refresh }) => {
          try {
            const { pulse, builtAt } = await getPulse(deps, { question, refresh: Boolean(refresh) })
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    builtMinutesAgo: Math.round((Date.now() - builtAt) / 60_000),
                    ...(question ? { note: 'Answer his question from these fields; the summary may be the general one.' } : {}),
                    ...pulse,
                  }),
                },
              ],
            }
          } catch (err) {
            return {
              content: [{ type: 'text', text: `The pulse could not be built: ${err.message}. Use the Jira tools directly.` }],
              isError: true,
            }
          }
        },
      ),
    ],
  })
}
