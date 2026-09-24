/**
 * What your Protective flows send back, and what that means for Jarvis.
 *
 *   npm run doctor:flows                 check every reading flow
 *   npm run doctor:flows -- --open-mail  also open the newest inbox email in Outlook
 *   npm run doctor:flows -- --open-todo  also open the first open task in To Do
 *
 * The two --open checks are how to find out, on this Mac, whether a brief
 * line's link lands on the email or task itself: the links are built the same
 * way the brief builds them. Nothing here calls a flow that drafts, sends or
 * adds, and no flow URL is printed. See bridge/flowcheck.mjs.
 */
import { execFile } from 'node:child_process'
import { platform } from 'node:os'
import '../bridge/env.mjs'
import { checkFlows } from '../bridge/flowcheck.mjs'
import { hasFlow, loadFlows, protective } from '../bridge/protective.mjs'
import { mailLink, todoLink } from '../bridge/maillinks.mjs'

const { flows, source } = loadFlows()
if (!source) {
  console.log('\n  No Protective flows found. Jarvis looks in JARVIS_PA_ENDPOINTS, ~/.jarvis/power-automate.json')
  console.log('  and the daily briefing\'s pa_endpoints.json in OneDrive. Add them in Settings, or run `npm run setup`.\n')
  process.exit(1)
}
console.log(`\n  Protective flows from ${source}\n`)

const rows = await checkFlows({
  flows,
  inbox: () => protective.inbox(25),
  flagged: () => protective.flagged(),
  todo: () => protective.todo(),
  sent: () => protective.sent(50),
  calendar: (day) => protective.calendar(day),
})

const mark = { ok: '✓', warn: '!', fail: '✗', info: '·' }
for (const r of rows) {
  const time = r.ms !== undefined ? `  (${(r.ms / 1000).toFixed(1)}s)` : ''
  console.log(`  ${mark[r.status]} ${r.name.padEnd(30)} ${r.detail}${time}`)
  if (r.fix) console.log(`      ${r.fix}`)
}
const failed = rows.filter((r) => r.status === 'fail').length
const warned = rows.filter((r) => r.status === 'warn').length
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
process.exit(failed ? 1 : 0)
