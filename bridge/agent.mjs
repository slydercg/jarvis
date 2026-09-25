import { query } from '@anthropic-ai/claude-agent-sdk'
import { protectiveServer, protectiveConfigured } from './protective.mjs'
import { allowWith, connectorDenylist } from './connectors.mjs'
import { BACKGROUND_DISALLOWED } from './policy.mjs'
import { protectiveBlock } from './snapshot.mjs'
import { describeStep } from './steps.mjs'
import { recordSpend } from './spend.mjs'

/**
 * One read-only question to a separate agent session, answered in JSON.
 *
 * The brief, the end-of-day wrap, meeting dossiers, the commitment scan, the
 * portfolio pulse and the weekly review are all the same shape: gather from
 * several accounts, apply some judgement, hand back structured data for the
 * conversation to speak. None of them may change anything. They run in their
 * own session so the conversation stays responsive while they work, and so a
 * slow one can be cached and reused.
 *
 *   deps      { mcpServers, isReadOnly, localNow, model, onStep? } — see server.mjs
 *   system    the job's instructions; it must end by describing the JSON
 *   question  the one message sent
 *   label     for the log, and the job name its progress is reported under
 *   connectors  extra claude.ai connectors this job alone may reach
 *   allowTool   (name) => bool, replacing the read-only rule for this job:
 *               a job given a connector the conversation lacks names the
 *               exact tools it may call, and nothing else on it runs
 *   onToolResult  (text) => void, each tool result as it arrives, for a job
 *               that checks the answer's figures against what was read
 *
 * `onStep(label, phrase)` hears each step as the job takes it ("Checking
 * Jira"), and `onStep(label, null)` once it is over, so the screen can show a
 * job that takes a minute is moving rather than stuck.
 */
export async function askReadOnly(
  deps,
  {
    system,
    question,
    label,
    maxTurns = 30,
    timeoutMs = 5 * 60_000,
    effort = 'medium',
    protectiveData = true,
    connectors = [],
    allowTool = null,
    onToolResult = null,
  },
) {
  const servers = { ...deps.mcpServers }
  if (protectiveData && protectiveConfigured()) servers.protective = protectiveServer({ readOnly: true })
  // Protective handed over as data, fetched directly and shared between jobs,
  // instead of each job spending turns fetching it (see snapshot.mjs). The
  // tools stay, for anything the snapshot does not cover.
  const withData = protectiveData ? question + (await protectiveBlock()) : question
  const session = query({
    prompt: withData,
    options: {
      mcpServers: servers,
      systemPrompt: system,
      settingSources: [],
      strictMcpConfig: false,
      // No files, shell, web or subagents for a job reading unvetted mail.
      disallowedTools: [...connectorDenylist(connectors.length ? allowWith(connectors) : undefined), ...BACKGROUND_DISALLOWED],
      model: deps.model,
      effort,
      maxTurns,
      permissionMode: 'default',
      // What the conversation could do without asking, minus anything that
      // writes at all — drafts and task lists included.
      canUseTool: async (name) =>
        (allowTool ? allowTool(name) : deps.isReadOnly(name)) && !WRITES.test(name.split('__').pop() ?? '')
          ? { behavior: 'allow' }
          : { behavior: 'deny', message: 'This job only reads. Do not change anything.' },
    },
  })
  const timer = setTimeout(() => session.close?.(), timeoutMs)
  let result = ''
  let cost = 0
  let lastStep = ''
  const step = (phrase) => {
    if (phrase === lastStep) return
    lastStep = phrase
    try {
      deps.onStep?.(label, phrase)
    } catch {
      // Progress is a courtesy; it never stops the job.
    }
  }
  try {
    for await (const msg of session) {
      if (msg.type === 'assistant') {
        for (const block of msg.message?.content ?? msg.content ?? []) {
          if (block?.type === 'tool_use') step(describeStep(block.name))
        }
      }
      if (onToolResult && msg.type === 'user') {
        for (const block of msg.message?.content ?? []) {
          if (block?.type !== 'tool_result' || block.is_error) continue
          const parts = Array.isArray(block.content) ? block.content : [{ type: 'text', text: block.content }]
          for (const p of parts) if (p?.type === 'text' && p.text) onToolResult(String(p.text))
        }
      }
      if (msg.type === 'result') {
        result = msg.subtype === 'success' ? (msg.result ?? '') : ''
        cost = msg.total_cost_usd ?? 0
        break
      }
    }
  } finally {
    clearTimeout(timer)
    session.close?.()
    step(null)
  }
  recordSpend('background', cost)
  console.log(`[jarvis] ${label}: done ($${cost.toFixed(3)})`)
  return parseJson(result)
}

const WRITES = /draft|send|create|add|update|delete|remove|move|reply|forward|post|transition|edit/i

/** The first {...} in a reply, parsed; null if there is none that parses. */
export function parseJson(text) {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
}

/** The sources paragraph every gathering job shares. */
export const SOURCES = `Sources — read every one you have, in parallel where you can:
- PROTECTIVE (his main work account, Mark.Slyder@protective.com): protective_get_inbox,
  protective_get_calendar, protective_get_todo, protective_get_flagged, and
  protective_get_sent when it exists.
- SCG (Slyder Consulting Group): the Microsoft 365 / Outlook tools.
- Personal Gmail and Google Calendar, lower priority.
- Granola for meeting notes (get_meetings by id for recent ones), Jira and
  Confluence for delivery work.
Tools are loaded on demand: search with ToolSearch ("outlook", "calendar", "granola",
"jira") before deciding one is missing. If a source is missing or fails, carry on.`
