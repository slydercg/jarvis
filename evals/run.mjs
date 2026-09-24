/**
 * The evals: real voice requests through Jarvis's own system prompt and tool
 * policy, against a fake Protective account, scored for what he did.
 *
 *   npm run eval                  every case in evals/cases.json
 *   npm run eval -- draft-asked   just the cases whose id contains that
 *
 * Needs a Claude Code login and costs a little each run (a few dollars on
 * Opus), so it is run on demand rather than in CI; the scoring rules
 * themselves are tested in CI (tests/evals.test.mjs). Nothing here touches a
 * real account: claude.ai connectors are switched off, Protective is the fake
 * in fake-protective.mjs, ~/.jarvis is a temporary folder, and every
 * confirmation is answered "no". Results go to eval-results/<time>.json.
 */
import '../bridge/env.mjs'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Before any bridge module reads them.
process.env.JARVIS_HOME = mkdtempSync(join(tmpdir(), 'jarvis-eval-'))
process.env.JARVIS_PA_ENDPOINTS = join(process.env.JARVIS_HOME, 'none.json')
process.env.ENABLE_CLAUDEAI_MCP_SERVERS = '0'
delete process.env.JARVIS_CONNECTORS

const { query } = await import('@anthropic-ai/claude-agent-sdk')
const { SYSTEM_PROMPT } = await import('../bridge/prompt.mjs')
const { conversationDisallowed, decideTool, intentGate, taskGate } = await import('../bridge/policy.mjs')
const { memoryServer } = await import('../bridge/memory.mjs')
const { displayServer } = await import('../bridge/panels.mjs')
const { fakeProtective } = await import('./fake-protective.mjs')
const { score, summarise } = await import('./score.mjs')

const here = dirname(fileURLToPath(import.meta.url))
const MODEL = process.env.EVAL_MODEL ?? process.env.JARVIS_MODEL ?? 'claude-opus-5'
const EFFORT = process.env.EVAL_EFFORT ?? process.env.JARVIS_EFFORT ?? 'medium'
// The defaults he runs with: writes off, money off, confirmations on.
const POLICY = { allowWrites: false, allowMoney: false, confirm: true }
const TIMEOUT_MS = 3 * 60_000

const filter = process.argv[2]
const cases = JSON.parse(readFileSync(join(here, 'cases.json'), 'utf8')).filter((c) => !filter || c.id.includes(filter))

function localNow() {
  const when = new Date().toLocaleString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
  })
  return `${when} (${Intl.DateTimeFormat().resolvedOptions().timeZone})`
}

async function runCase(c) {
  const { server: protective } = fakeProtective()
  const verdicts = new Map()
  const calls = []
  const session = query({
    // The same shape the bridge sends: the local time, then what was said.
    prompt: `[${localNow()}]\n${c.say}`,
    options: {
      cwd: homedir(),
      systemPrompt: SYSTEM_PROMPT,
      settingSources: [],
      strictMcpConfig: false,
      disallowedTools: conversationDisallowed(POLICY),
      mcpServers: {
        protective,
        jarvis: displayServer(() => {}, () => {}),
        jarvis_memory: memoryServer(),
      },
      model: MODEL,
      effort: EFFORT,
      maxTurns: 12,
      permissionMode: 'default',
      canUseTool: async (name) => {
        const verdict = taskGate(name, intentGate(name, decideTool(name, POLICY), c.say, POLICY), c.say)
        verdicts.set(name, [...(verdicts.get(name) ?? []), verdict])
        if (verdict === 'allow') return { behavior: 'allow' }
        return {
          behavior: 'deny',
          message: verdict === 'confirm' ? 'He said no on the confirmation card.' : 'Not permitted.',
        }
      },
    },
  })
  const timer = setTimeout(() => session.close?.(), TIMEOUT_MS)
  let text = ''
  let cost = 0
  try {
    for await (const m of session) {
      if (m.type === 'assistant') {
        for (const b of m.message?.content ?? []) if (b.type === 'tool_use') calls.push({ name: b.name, input: b.input })
      }
      if (m.type === 'result') {
        text = m.result ?? ''
        cost = m.total_cost_usd ?? 0
        break
      }
    }
  } finally {
    clearTimeout(timer)
    session.close?.()
  }
  // Each call's verdict, in order; one that never reached the policy was
  // settled by the CLI itself ("auto").
  const seen = new Map()
  for (const call of calls) {
    const i = seen.get(call.name) ?? 0
    seen.set(call.name, i + 1)
    call.verdict = verdicts.get(call.name)?.[i] ?? 'auto'
  }
  return { calls, text, cost }
}

const results = []
for (const c of cases) {
  process.stdout.write(`${c.id} … `)
  let run
  try {
    run = await runCase(c)
  } catch (err) {
    run = { calls: [], text: `ERROR: ${err?.message ?? err}`, cost: 0 }
  }
  const checks = score(run, c.expect)
  const ok = checks.every((x) => x.ok)
  results.push({ id: c.id, say: c.say, ...run, checks })
  console.log(`${ok ? 'pass' : 'FAIL'} ($${run.cost.toFixed(3)})`)
  for (const x of checks) if (!x.ok) console.log(`    ✗ ${x.check} — ${x.detail}`)
}

const sum = summarise(results)
const spent = results.reduce((a, r) => a + r.cost, 0)
console.log(`\n${sum.passed}/${sum.total} passed · ${MODEL}/${EFFORT} · $${spent.toFixed(2)}`)
const out = join(here, '..', 'eval-results')
mkdirSync(out, { recursive: true })
const file = join(out, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
writeFileSync(file, JSON.stringify({ model: MODEL, effort: EFFORT, at: new Date().toISOString(), ...sum, spent, results }, null, 2))
console.log(`results: ${file}`)
process.exit(sum.ok ? 0 : 1)
