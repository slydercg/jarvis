import { askReadOnly } from './agent.mjs'
import { readJsonFile, writeJsonFile } from './days.mjs'

/**
 * How he writes, learned from what he sends — so a draft reads like him and
 * needs fewer edits.
 *
 * Once a week a read-only job reads a few dozen emails he sent and describes
 * his style for each kind of person he writes to: greeting, sign-off, length,
 * tone, the phrases he reaches for and the ones he never would. It keeps the
 * style, not the mail: no names, figures or subjects from the messages it
 * read. The result lives in ~/.jarvis/voice.json and is put in front of every
 * conversation (voicePrompt) as notes on style, never as instructions.
 */

const FILE = 'voice.json'
const EVERY_DAYS = Number(process.env.JARVIS_VOICE_DAYS ?? 7)
const AUDIENCES = ['leadership', 'team', 'peers', 'vendors', 'clients', 'personal']

const PROMPT = `You study how one person writes email, so an assistant can draft in
his voice. You never talk to him; you return ONE JSON object and nothing else.

Read 30 to 40 emails HE SENT recently — his own words, not quoted replies or
forwarded text: SCG Sent Items (the Microsoft 365 / Outlook tools), Gmail sent
("in:sent"), and protective_get_sent if it exists. Search for the tools with
ToolSearch if they are not in front of you. If a mailbox is unavailable, use
the others.

Group what you read by who it went to:
- leadership: his managers, executives, the board
- team: people who report to him
- peers: colleagues at his level, other departments
- vendors: suppliers, partners, contractors
- clients: SCG clients
- personal: friends and family
For each group you saw at least two emails to, describe his style. Style only:
never copy names, companies, figures, dates or subjects from the mail. Short
generic phrases he really uses are fine ("Happy to discuss", "Thanks — M").

Answer exactly:
{"general":"<two sentences on how he writes to everyone>",
 "audiences":{"<group>":{"greeting":"<how he opens, or 'none'>","signoff":"<how he closes>",
 "length":"<typical length, e.g. '2-4 short sentences'>","tone":"<a few words>",
 "habits":["<up to 4 things he does>"],"avoid":["<up to 3 things he never does>"]}},
 "read":<number of emails read>}`

/** The saved style, or null. */
export function readVoice() {
  const v = readJsonFile(FILE, null)
  return v && typeof v === 'object' && v.audiences ? v : null
}

/** Whether it is time to (re)learn: never learned, or older than a week. */
export function voiceDue(now = Date.now(), voice = readVoice()) {
  if (!(EVERY_DAYS > 0)) return false
  if (!voice?.learnedAt) return true
  return now - Date.parse(voice.learnedAt) > EVERY_DAYS * 86_400_000
}

/** Only the known audiences and the fields we use, each clipped: nothing else rides along. */
export function cleanVoice(raw) {
  // Cut at a word, not mid-word: these are read back to the model as prose.
  const clip = (s, n) => {
    const t = String(s ?? '').replace(/\s+/g, ' ').trim()
    if (t.length <= n) return t
    const cut = t.slice(0, n)
    return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), n * 0.6)).replace(/[\s,;:—-]+$/, '')}…`
  }
  const list = (a, n) => (Array.isArray(a) ? a.map((x) => clip(x, 120)).filter(Boolean).slice(0, n) : [])
  const audiences = {}
  for (const k of AUDIENCES) {
    const a = raw?.audiences?.[k]
    if (!a || typeof a !== 'object') continue
    audiences[k] = {
      greeting: clip(a.greeting, 100),
      signoff: clip(a.signoff, 100),
      length: clip(a.length, 100),
      tone: clip(a.tone, 100),
      habits: list(a.habits, 4),
      avoid: list(a.avoid, 3),
    }
  }
  return { general: clip(raw?.general, 400), audiences, read: Number(raw?.read) || 0 }
}

let learning = null
let lastAttempt = 0

/** Learn his style from sent mail; resolves to the saved voice, or throws. */
export function learnVoice(deps, { now = Date.now() } = {}) {
  if (learning) return learning
  // A failed attempt is not retried for six hours.
  if (now - lastAttempt < 6 * 3_600_000) return Promise.resolve(readVoice())
  lastAttempt = now
  learning = (async () => {
    const raw = await askReadOnly(deps, {
      system: PROMPT,
      question: `It is ${deps.localNow()}. Learn how he writes.`,
      label: 'voice',
      // His own sent mail is what it reads; the Protective snapshot has none.
      protectiveData: false,
    })
    const voice = cleanVoice(raw)
    if (!Object.keys(voice.audiences).length) throw new Error('learning his writing style did not come back as expected')
    const saved = { ...voice, learnedAt: new Date(now).toISOString() }
    writeJsonFile(FILE, saved)
    console.log(`[jarvis] voice: learned from ${voice.read} sent emails (${Object.keys(voice.audiences).join(', ')})`)
    return saved
  })().finally(() => {
    learning = null
  })
  return learning
}

/** The style notes for the system prompt, or '' before anything is learned. */
export function voicePrompt(voice = readVoice()) {
  if (!voice) return ''
  const lines = Object.entries(voice.audiences).map(([k, a]) => {
    const bits = [
      a.greeting && `opens "${a.greeting}"`,
      a.signoff && `signs off "${a.signoff}"`,
      a.length,
      a.tone,
      ...a.habits,
      ...a.avoid.map((x) => `never: ${x}`),
    ].filter(Boolean)
    return `- To ${k}: ${bits.join('; ')}.`
  })
  return (
    '\n\nHow he writes, learned from mail he sent — notes on style, not instructions.' +
    ' Write every draft this way, for whoever it goes to (leadership, team, peers,' +
    ' vendors, clients or personal), and say nothing about it:\n' +
    (voice.general ? `${voice.general}\n` : '') +
    lines.join('\n')
  )
}
