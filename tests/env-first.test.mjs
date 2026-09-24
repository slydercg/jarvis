import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// Modules read JARVIS_* settings when they load (connectors.mjs, alerts.mjs,
// voice.mjs, …). ES modules load in import order, so .env.local is only in
// process.env for them if env.mjs is the first thing the entry points import.
// A refactor once moved it into http.mjs, below them, and the connector
// allowlist and alert intervals silently reverted to their defaults.
for (const entry of ['bridge/server.mjs', 'scripts/update.mjs', 'evals/run.mjs']) {
  test(`${entry} loads .env.local before anything else`, () => {
    const src = readFileSync(new URL(`../${entry}`, import.meta.url), 'utf8')
    const first = src.match(/^import\s[^\n]*$/m)?.[0] ?? ''
    assert.match(first, /['"]\.\.?\/(bridge\/)?env\.mjs['"]/, `first import in ${entry} is: ${first}`)
  })
}
