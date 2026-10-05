import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.JARVIS_HOME = mkdtempSync(join(tmpdir(), 'jarvis-reports-'))
const { redact, writeReport, listReports, readReport, REPORTS_DIR } = await import('../bridge/reports.mjs')

const FLOW = 'https://prod-01.westus.logic.azure.com/workflows/abc/triggers/manual/paths/invoke?api-version=1&sig=SECRET'

test('a flow URL loses its signature wherever it appears', () => {
  assert.equal(redact(`called ${FLOW} ok`), 'called https://prod-01.westus.logic.azure.com/workflows/abc/triggers/manual/paths/invoke?… ok')
  const name = writeReport({ trail: [{ at: 1, kind: 'heard', text: FLOW }] }, { log: [`x ${FLOW}`] }, new Date('2026-10-05T16:00:00Z'))
  const raw = readFileSync(join(REPORTS_DIR, name), 'utf8')
  assert.ok(!raw.includes('SECRET'))
  assert.equal(readReport(name).page.trail[0].kind, 'heard')
})

test('only the last thirty reports are kept', () => {
  for (let i = 0; i < 35; i++) writeReport({}, {}, new Date(Date.UTC(2026, 9, 6, 0, 0, i)))
  const all = listReports()
  assert.equal(all.length, 30)
  assert.equal(all.at(-1), '2026-10-06T00-00-34.json')
})
