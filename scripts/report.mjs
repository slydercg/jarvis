#!/usr/bin/env node
// `npm run report`: the latest "that was wrong" report (bridge/reports.mjs),
// as plain text to paste into a conversation. `npm run report -- --list`
// lists them; `npm run report -- <file>` prints one. URLs are already
// stripped of their query strings when a report is written.
import { listReports, readReport, REPORTS_DIR } from '../bridge/reports.mjs'

const arg = process.argv[2]
const all = listReports()
if (arg === '--list') {
  for (const f of all) console.log(f)
  process.exit(0)
}
const name = arg ?? all.at(-1)
if (!name) {
  console.log(`No reports yet in ${REPORTS_DIR}. Say "Jarvis, that was wrong" or type "that was wrong" right after something goes wrong.`)
  process.exit(0)
}

const r = readReport(name)
const t = (ms) => (ms ? new Date(ms).toLocaleTimeString() : '—')
const out = []
out.push(`Jarvis report ${name}`)
if (r.page?.note) out.push(`Note: ${r.page.note}`)
out.push(`Phase: ${r.page?.phase ?? '—'} · silent: ${r.page?.hush ?? 'no'} · engine: ${r.page?.voice?.engine ?? '—'}`)
out.push('', 'What the page saw (oldest first):')
for (const e of r.page?.trail ?? []) out.push(`  ${t(e.at)}  ${e.kind.padEnd(9)} ${e.text}`)
out.push('', 'Conversation:')
for (const e of r.bridge?.turns ?? []) out.push(`  ${t(e.at)}  ${String(e.role).padEnd(6)} ${String(e.text).slice(0, 300)}`)
out.push('', `Call watcher: ${JSON.stringify(r.bridge?.call ?? null)}`)
out.push('', 'Bridge log (last lines):')
for (const l of (r.bridge?.log ?? []).slice(-60)) out.push(`  ${l}`)
console.log(out.join('\n'))
