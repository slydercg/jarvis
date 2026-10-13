import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

/**
 * The repository is public. Real addresses, colleagues and internal system
 * names once got in through test data copied from his screens; this keeps
 * them out. His own address belongs in .env.local (JARVIS_WORK_EMAIL), and
 * examples use made-up names on example domains.
 */
const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
  .split('\n')
  .filter((f) => f && !/(^|\/)package-lock\.json$|\.(wav|png|jpe?g|onnx|ico|woff2?)$/.test(f))

const MADE_UP = /(^|\.)(example\.com|example|x\.com|yourcompany\.com)$|^examp1e-[a-z]+\.com$/

test('no real email address is written into the code', () => {
  const found = []
  for (const f of files) {
    const text = readFileSync(f, 'utf8')
    for (const m of text.matchAll(/[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[a-z]{2,})/g)) {
      if (!MADE_UP.test(m[1].toLowerCase())) found.push(`${f}: ${m[0]}`)
    }
  }
  assert.deepEqual(found, [])
})

test('no internal system names or real colleagues in the code', () => {
  const NOT_HERE = /protective\.com|aulcorp|jira456|Ginsberg|Cathrene|Daily IT Leader|APD - Intake/i
  const found = files.filter((f) => f !== 'tests/no-personal-data.test.mjs' && NOT_HERE.test(readFileSync(f, 'utf8')))
  assert.deepEqual(found, [])
})
