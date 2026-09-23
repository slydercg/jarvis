import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveLocation, focusFromFragment, extractHtml, readLocalPage } from '../bridge/localfiles.mjs'

test('a file:// link with spaces and a filter resolves to the file and the filter', () => {
  const r = resolveLocation('file:///Users/me/Claude%20Code%20Applications/APD%20Dashboard/d.html#sprint=everything&area=APD')
  assert.equal(r.path, '/Users/me/Claude Code Applications/APD Dashboard/d.html')
  assert.equal(focusFromFragment(r.fragment), 'APD')
  assert.equal(focusFromFragment('sprint=everything&area=all'), '')
})

test('HTML gives up its title, visible text and embedded data, not its scripts', () => {
  const { title, text, data } = extractHtml(
    '<title>Dash &amp; Co</title><style>.a{}</style><p>Hello</p><script>const DATA = {"a":1}; render()</script>',
  )
  assert.equal(title, 'Dash & Co')
  assert.match(text, /Hello/)
  assert.doesNotMatch(text, /render|\.a\{/)
  assert.ok(data[0].startsWith('DATA = {"a":1}'))
})

test('reads a dashboard in the home folder, narrowed to the filter', async () => {
  const dir = mkdtempSync(join(homedir(), '.jarvis-test-'))
  try {
    mkdirSync(join(dir, 'APD Dashboard'))
    const file = join(dir, 'APD Dashboard', 'dash.html')
    writeFileSync(file, '<title>Portfolio</title><script>const DATA = {"items":[{"area":"APD","t":"Migration blocked"},{"area":"NI","t":"Other team"}]}</script>')
    const out = await readLocalPage({ location: `${pathToFileURL(file).href}#area=APD` })
    assert.equal(out.focus, 'APD')
    assert.match(out.data.join(''), /Migration blocked/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('refuses files outside the home folder and non-document types', async () => {
  const outside = join(mkdtempSync(join(tmpdir(), 'jarvis-out-')), 'x.html')
  writeFileSync(outside, '<p>x</p>')
  if (!outside.startsWith(homedir())) {
    await assert.rejects(readLocalPage({ location: outside }), /home folder/)
  }
  const dir = mkdtempSync(join(homedir(), '.jarvis-test-'))
  try {
    writeFileSync(join(dir, 'key.pem'), 'secret')
    await assert.rejects(readLocalPage({ location: join(dir, 'key.pem') }), /not read this way/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
