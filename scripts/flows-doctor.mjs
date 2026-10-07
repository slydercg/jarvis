/**
 * What your Protective flows send back, and what that means for Jarvis.
 *
 *   npm run doctor:flows                 check every reading flow
 *   npm run doctor:flows -- --open-mail  also open the newest inbox email in Outlook
 *   npm run doctor:flows -- --open-todo  also open the first open task in To Do
 *   npm run doctor:flows -- --accept-keys  a key left the flows file on purpose:
 *                                        stop warning about it
 *   npm run doctor:flows -- --notes "<subject>" <start>
 *                                        also ask the meeting-notes flow about one
 *                                        meeting (subject as on the calendar, start
 *                                        ISO 8601 with its offset); counts only
 *
 * The two --open checks are how to find out, on this Mac, whether a brief
 * line's link lands on the email or task itself: the links are built the same
 * way the brief builds them. Nothing here calls a flow that drafts, sends or
 * adds, and no flow URL is printed. See bridge/flowcheck.mjs.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { platform } from 'node:os'
import '../bridge/env.mjs'
import { checkFlows, judgeNotes } from '../bridge/flowcheck.mjs'
import { judgeFlowsFile, keysOnlyInBackups, lastKeys, rememberKeys } from '../bridge/flowsfile.mjs'
import { flowFileCandidates, hasFlow, loadFlows, protective } from '../bridge/protective.mjs'
import { mailLink, todoLink } from '../bridge/maillinks.mjs'

const mark = { ok: '✓', warn: '!', fail: '✗', info: '·' }
const { flows, source, path } = loadFlows()
// The file itself first: it is shared with the briefing and the SCG Agent
// Office, and a rewrite that drops their keys passes every check below.
const filePath = path ?? flowFileCandidates().find((p) => existsSync(p))
let file = null
if (filePath) {
  const previous = process.argv.includes('--accept-keys') ? null : lastKeys(filePath)
  file = judgeFlowsFile(filePath, previous)
  if (file.keys && !file.missing?.length) rememberKeys(filePath, file.keys)
}
if (!source) {
  if (file?.status === 'fail') {
    console.log(`\n  ✗ Flows file: ${file.detail}`)
    if (file.fix) console.log(`      ${file.fix}`)
  }
  console.log('\n  No Protective flows found. Jarvis looks in JARVIS_PA_ENDPOINTS, ~/.jarvis/power-automate.json')
  console.log('  and the daily briefing\'s pa_endpoints.json in OneDrive. Add them in Settings, or run `npm run setup`.\n')
  process.exit(1)
}
console.log(`\n  Protective flows from ${source}\n`)
if (file) {
  console.log(`  ${mark[file.status]} ${'Flows file'.padEnd(30)} ${file.detail}`)
  if (file.fix) console.log(`      ${file.fix}`)
  if (file.missing?.length) console.log('      If that was on purpose: npm run doctor:flows -- --accept-keys')
  for (const b of keysOnlyInBackups(filePath)) {
    console.log(`  ! ${'Only in a backup'.padEnd(30)} "${b.key}" is in ${b.in.join(', ')} but not the live file`)
    console.log(`      If something still needs it: npm run flows:add -- ${b.key} --from "${filePath.replace(/[^/]+$/, b.in.at(-1))}"`)
  }
}

const rows = await checkFlows({
  flows,
  inbox: () => protective.inbox(25),
  flagged: () => protective.flagged(),
  todo: () => protective.todo(),
  sent: () => protective.sent(50),
  calendar: (day) => protective.calendar(day),
})

for (const r of rows) {
  const time = r.ms !== undefined ? `  (${(r.ms / 1000).toFixed(1)}s)` : ''
  console.log(`  ${mark[r.status]} ${r.name.padEnd(30)} ${r.detail}${time}`)
  if (r.fix) console.log(`      ${r.fix}`)
}
const failed = rows.filter((r) => r.status === 'fail').length
const warned = rows.filter((r) => r.status === 'warn').length + (file?.status === 'warn' ? 1 : 0)
console.log(
  `\n  ${failed ? `${failed} not working` : 'Everything Jarvis reads is working'}` +
    `${warned ? `; ${warned} to look at` : ''}.\n`,
)

/** Open a link in the default browser, the way a click on the brief would. */
function open(url) {
  const cmd = platform() === 'darwin' ? 'open' : 'xdg-open'
  return new Promise((done) =>
    execFile(cmd, [url], (err) => {
      if (err) console.log(`  Couldn't open a browser (${err.code ?? err.message}). Paste the link into one.`)
      done()
    }),
  )
}

if (process.argv.includes('--open-mail') && hasFlow('inbox')) {
  const m = (await protective.inbox(25)).find((x) => mailLink(x.id))
  if (m) {
    console.log(`  Opening "${m.subject}" in Outlook. It should open that email, not the inbox.`)
    console.log(`  Link: ${mailLink(m.id)}`)
    await open(mailLink(m.id))
  } else console.log('  No inbox email with an id Outlook can open.')
}
if (process.argv.includes('--open-todo') && hasFlow('todo')) {
  const t = (await protective.todo()).find((x) => todoLink(x.id))
  if (t) {
    console.log(`  Opening "${t.title}" in To Do. It should open that task, not the To Do home page.`)
    console.log('  If it lands on the home page, tell Claude: the To Do link format needs changing.')
    console.log(`  Link: ${todoLink(t.id)}`)
    await open(todoLink(t.id))
  } else console.log('  No open task with an id, so there is no To Do link to try.')
}
const at = process.argv.indexOf('--notes')
if (at > 0 && hasFlow('meeting_notes')) {
  const [subject, start] = process.argv.slice(at + 1, at + 3)
  if (!subject || !Number.isFinite(Date.parse(start ?? ''))) {
    console.log('  --notes needs the subject and the start, e.g. --notes "Weekly review" 2026-10-05T15:00:00-04:00')
  } else {
    try {
      const r = judgeNotes(await protective.meetingNotes({ subject, start }))
      console.log(`  ${mark[r.status]} ${'Meeting notes'.padEnd(30)} ${r.detail}`)
      if (r.fix) console.log(`      ${r.fix}`)
    } catch (err) {
      console.log(`  ✗ ${'Meeting notes'.padEnd(30)} failed: ${String(err?.message ?? err).replace(/https?:\/\/\S+/g, '(url)')}`)
    }
  }
}
process.exit(failed ? 1 : 0)
