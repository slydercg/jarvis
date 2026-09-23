import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'

/**
 * Memory, in two kinds.
 *
 * 1. The conversation itself survives a reload. Every page load used to open a
 *    brand-new agent session, so refreshing the tab, a dropped socket or a
 *    bridge restart wiped out whatever was just said. Now the session id is
 *    kept on disk and resumed while it is recent, so "and move it to four"
 *    still knows what "it" is.
 *
 * 2. Lasting notes. Things worth knowing next week — a preference, a person,
 *    a standing arrangement — are saved with a `remember` tool into a plain
 *    Markdown file you can read and edit yourself, and handed to every new
 *    session. Nothing is remembered that the model was not asked, or clearly
 *    told, to keep; and anything that looks like a secret is refused.
 *
 * Both live in ~/.jarvis (JARVIS_HOME to move it). Delete the folder and he
 * forgets everything.
 */

// A leading ~ is expanded by hand: .env.local is not a shell, and a folder
// literally called "~" in the project would be a confusing place for this.
export const JARVIS_HOME = (process.env.JARVIS_HOME ?? join(homedir(), '.jarvis')).replace(
  /^~(?=$|\/)/,
  homedir(),
)
const SESSION_FILE = join(JARVIS_HOME, 'session.json')
export const MEMORY_FILE = join(JARVIS_HOME, 'memory.md')

/** How long a conversation stays resumable. After this, a fresh one. */
const RESUME_HOURS = Number(process.env.JARVIS_RESUME_HOURS ?? 12)
const RESUME = process.env.JARVIS_RESUME !== 'off' && RESUME_HOURS > 0

/** Keep the notes short enough to ride along on every session cheaply. */
const MAX_NOTES = 80
const MAX_NOTE_CHARS = 280

function ensureHome() {
  mkdirSync(JARVIS_HOME, { recursive: true })
}

// ---------------------------------------------------------------------------
// The conversation
// ---------------------------------------------------------------------------

function readSession() {
  try {
    return JSON.parse(readFileSync(SESSION_FILE, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Whether Claude Code has a transcript for this session, or null when that
 * cannot be told. Sessions run with the home directory as their cwd, so the
 * transcript is ~/.claude/projects/<home with non-alphanumerics as ->/<id>.jsonl.
 * If that project folder is not there at all, the layout is not what this
 * expects, and it says so rather than guessing "no".
 */
function transcriptExists(id) {
  const base = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
  const project = join(base, 'projects', homedir().replace(/[^a-zA-Z0-9]/g, '-'))
  if (!existsSync(project)) return null
  return existsSync(join(project, `${id}.jsonl`))
}

/**
 * Which session to open: the recent one to resume, or a new id to start.
 * `{ resume: id }` or `{ sessionId: id }`, ready to spread into query options.
 *
 * A saved id only ever resumes if Claude Code actually has that conversation.
 * Resuming one it does not have fails every turn with "No conversation found
 * with session ID", which is exactly what an id saved before its first answer
 * — then a bridge restart — produced.
 */
export function sessionOptions() {
  const saved = readSession()
  const fresh = saved && Date.now() - (saved.lastUsed ?? 0) < RESUME_HOURS * 3_600_000
  if (RESUME && fresh && typeof saved.id === 'string') {
    if (transcriptExists(saved.id) === false) {
      console.warn('[jarvis] the saved conversation no longer exists; starting a fresh one')
      forgetSession()
    } else {
      return { resumed: true, id: saved.id, options: { resume: saved.id } }
    }
  }
  // Not saved yet: only a conversation with an answer in it is worth
  // resuming, and saveSession is called once there is one.
  const id = randomUUID()
  return { resumed: false, id, options: { sessionId: id } }
}

/** The CLI's words when asked to resume a conversation it does not have. */
export const MISSING_CONVERSATION = /No conversation found with session ID/i

/** Called after each answered turn, so an active conversation stays resumable. */
export function saveSession(id) {
  if (!RESUME) return
  try {
    ensureHome()
    writeFileSync(SESSION_FILE, JSON.stringify({ id, lastUsed: Date.now() }))
  } catch (err) {
    console.warn(`[jarvis] could not save the session id: ${err.message}`)
  }
}

/** "Start fresh": the next connection opens a new conversation. */
export function forgetSession() {
  try {
    rmSync(SESSION_FILE, { force: true })
  } catch {
    // Nothing to forget.
  }
}

/**
 * The last few exchanges of a resumed session, for the transcript on screen.
 * Text only: tool calls and their results are the working, not the talk.
 */
export function recentTurns(messages, limit = 6) {
  const turns = []
  for (const m of messages) {
    if (m.parent_tool_use_id) continue
    const content = m.message?.content
    let text = ''
    if (typeof content === 'string') text = content
    else if (Array.isArray(content)) {
      text = content
        .filter((b) => b?.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join(' ')
    }
    // Every question carries the local time in brackets for the model; the
    // person who asked it never saw that, so neither should the transcript.
    text = text.replace(/^\[[^\]]*\]\s*/, '').trim()
    // Switching model between turns records a slash command and its output
    // in the transcript. Bookkeeping, not conversation.
    if (!text || /^<(command-|local-command-)/.test(text)) continue
    const role = m.type === 'user' ? 'user' : 'jarvis'
    const last = turns[turns.length - 1]
    // One assistant reply is often several messages around its tool calls.
    if (last && last.role === role && role === 'jarvis') last.text = `${last.text} ${text}`
    else turns.push({ role, text })
  }
  return turns.slice(-limit)
}

// ---------------------------------------------------------------------------
// Lasting notes
// ---------------------------------------------------------------------------

function readNotes() {
  if (!existsSync(MEMORY_FILE)) return []
  return readFileSync(MEMORY_FILE, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2))
}

function writeNotes(notes) {
  ensureHome()
  const body = notes.map((n) => `- ${n}`).join('\n')
  writeFileSync(
    MEMORY_FILE,
    `# What ${process.env.JARVIS_NAME?.trim() || 'Jarvis'} remembers\n\n` +
      'One fact per line. Edit or delete freely; changes apply to the next conversation.\n\n' +
      `${body}\n`,
  )
}

/** The block added to the system prompt, or '' when there is nothing yet. */
export function memoryPrompt() {
  const notes = readNotes()
  if (!notes.length) return ''
  return (
    '\n\nWhat you know about the user from earlier conversations. Use it where it' +
    ' helps; never recite it back unprompted:\n' +
    notes.map((n) => `- ${n}`).join('\n')
  )
}

/**
 * Things that must never be written down: passwords, codes, keys, card and
 * account numbers. A voice assistant hears these said out loud more often
 * than you would think, and a Markdown file in your home folder is the wrong
 * place for any of them.
 */
const SECRET =
  /(password|passcode|passphrase|\bpin\b|api[ -]?key|secret|token|\bssn\b|social security|security code|cvv|routing number|account number|sk_[a-z0-9]|\b(?:\d[ -]?){12,19}\b)/i

const today = () => new Date().toISOString().slice(0, 10)

export function memoryServer() {
  return createSdkMcpServer({
    name: 'jarvis_memory',
    version: '1.0.0',
    tools: [
      tool(
        'remember',
        'Save one lasting fact about the user for future conversations: a preference, ' +
          'a person and who they are, a standing arrangement, how they like things done. ' +
          'Use it when they say "remember…", or state something plainly meant to last. ' +
          'Never for passing details of today, and never for passwords, codes, account ' +
          'or card numbers.',
        { note: z.string().min(3).max(MAX_NOTE_CHARS).describe('One fact, one short sentence, third person.') },
        async ({ note }) => {
          const clean = note.replace(/\s+/g, ' ').trim()
          if (SECRET.test(clean)) {
            return { content: [{ type: 'text', text: 'Not stored: it looks like a secret. Tell the user it was not saved.' }], isError: true }
          }
          const notes = readNotes()
          if (notes.some((n) => n.toLowerCase().startsWith(clean.toLowerCase()))) {
            return { content: [{ type: 'text', text: 'Already remembered.' }] }
          }
          notes.push(`${clean} (${today()})`)
          writeNotes(notes.slice(-MAX_NOTES))
          return { content: [{ type: 'text', text: 'Remembered.' }] }
        },
      ),
      tool(
        'forget',
        'Remove remembered facts that mention the given words, when the user asks you ' +
          'to forget something or a fact has changed.',
        { about: z.string().min(2).describe('Words the fact to forget contains.') },
        async ({ about }) => {
          const needle = about.toLowerCase()
          const notes = readNotes()
          const kept = notes.filter((n) => !n.toLowerCase().includes(needle))
          if (kept.length === notes.length) {
            return { content: [{ type: 'text', text: 'Nothing remembered matches that.' }] }
          }
          writeNotes(kept)
          return { content: [{ type: 'text', text: `Forgot ${notes.length - kept.length}.` }] }
        },
      ),
      tool(
        'recall',
        'List everything remembered about the user, when they ask what you know about them.',
        {},
        async () => {
          const notes = readNotes()
          return {
            content: [{ type: 'text', text: notes.length ? notes.map((n) => `- ${n}`).join('\n') : 'Nothing remembered yet.' }],
          }
        },
      ),
    ],
  })
}
