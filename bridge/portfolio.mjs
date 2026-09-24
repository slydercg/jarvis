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

const MAX_AGE_MS = 30 * 60_000
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
let building = null

function snapshots() {
  return readJsonFile(SNAPSHOTS, {})
}

export function getPulse(deps, { question, refresh = false } = {}) {
  const fresh = cache && Date.now() - cache.builtAt < MAX_AGE_MS && !question
  if (fresh && !refresh) return Promise.resolve(cache)
  building ??= (async () => {
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
    if (!question) cache = entry
    // Every pulse carries the whole picture (blocked, behind, pipelines), a
    // specific question only changes its summary — so every one is the
    // day's snapshot, the baseline for tomorrow's "what changed".
    const { summary: _summary, ...state } = pulse
    const next = { ...snaps, [localDay()]: { at: new Date().toISOString(), ...state } }
    for (const d of Object.keys(next).sort().slice(0, -KEEP)) delete next[d]
    writeJsonFile(SNAPSHOTS, next)
    return entry
  })().finally(() => {
    building = null
  })
  return building
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
        'get_portfolio_pulse',
        'The delivery portfolio across Jira and Azure DevOps: what is blocked and with whom, which ' +
          'sprints or teams are behind, failing pipelines, what changed since yesterday, risks. Use for ' +
          '"what\'s blocked across the portfolio", "which team is behind", "what changed since yesterday", ' +
          '"how\'s delivery looking". Pass `question` for something specific. Takes a minute; the general ' +
          'pulse is cached for half an hour.',
        { question: z.string().max(300).optional(), refresh: z.boolean().optional() },
        async ({ question, refresh }) => {
          try {
            const { pulse, builtAt } = await getPulse(deps, { question, refresh: Boolean(refresh) })
            return {
              content: [
                { type: 'text', text: JSON.stringify({ builtMinutesAgo: Math.round((Date.now() - builtAt) / 60_000), ...pulse }) },
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
