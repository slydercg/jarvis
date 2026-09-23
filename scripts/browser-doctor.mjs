/**
 * Why Jarvis can't reach the browser, and (with --fix) the usual repair.
 *
 *   npm run browser:doctor            what is set up, what is running
 *   npm run browser:doctor -- --fix   register the helper for browsers missing it
 *
 * Jarvis drives your browser through the Claude extension's native messaging
 * helper — the same one Claude Code uses. The browser only starts that helper
 * if its NativeMessagingHosts folder holds the helper's manifest. `claude
 * --chrome` is supposed to register it for every browser with the extension;
 * when Edge (or Brave, Arc) was missed, --fix copies the working registration
 * from a browser that has it. That works when the extension came from the
 * Chrome Web Store, whose extension id is the same in every browser.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { userInfo } from 'node:os'
import { BROWSER_HOSTS, HOST_MANIFEST } from '../bridge/chrome.mjs'

const fix = process.argv.includes('--fix')
const sockDir = `/tmp/claude-mcp-browser-bridge-${userInfo().username}`

const hosts = BROWSER_HOSTS.map((b) => ({
  ...b,
  installed: existsSync(join(b.dir, '..')),
  manifest: join(b.dir, HOST_MANIFEST),
}))
  .filter((b) => b.installed)
  .map((b) => ({ ...b, registered: existsSync(b.manifest) }))

console.log('\n  Browsers on this Mac, and whether the Claude extension helper is registered:')
for (const b of hosts) console.log(`    ${b.registered ? '✓' : '✗'} ${b.name}`)
if (!hosts.length) console.log('    (no Chromium browsers found)')

let sockets = []
try {
  sockets = readdirSync(sockDir).filter((n) => n.endsWith('.sock'))
} catch {
  // Not running.
}
const newest = sockets
  .map((n) => ({ n, at: statSync(join(sockDir, n)).mtimeMs }))
  .sort((a, b) => b.at - a.at)[0]
console.log(
  `\n  Helper running: ${newest ? `yes (since ${new Date(newest.at).toLocaleTimeString()})` : 'no'}`,
)

const source = hosts.find((b) => b.registered)
const missing = hosts.filter((b) => !b.registered)
if (fix) {
  if (!source) {
    console.log('\n  Nothing to copy from. Run `claude --chrome` once with the browser open first.\n')
    process.exit(1)
  }
  for (const b of missing) {
    mkdirSync(b.dir, { recursive: true })
    copyFileSync(source.manifest, b.manifest)
    console.log(`  Registered the helper for ${b.name} (copied from ${source.name}).`)
  }
  if (!missing.length) console.log('\n  Every browser already has it; nothing to do.')
  console.log('\n  Now quit and reopen the browser, and open the Claude extension once.\n')
} else if (!newest) {
  console.log(
    '\n  To fix: open the browser you use with the Claude extension enabled, and open the\n' +
      '  extension once.' +
      (missing.length ? ` If that browser is ${missing.map((b) => b.name).join(' or ')}, run\n  \`npm run browser:doctor -- --fix\` first.` : '') +
      (source ? '' : ' Nothing is registered yet: run `claude --chrome` once.') +
      '\n',
  )
} else {
  console.log('\n  All good: Jarvis can reach the browser.\n')
}
