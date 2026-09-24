import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Reading a report that lives on this Mac, like a generated dashboard.
 *
 * A file:// link cannot be opened by a web page, and the browser tools are
 * the wrong way round anyway: the file is right here. But a generated HTML
 * dashboard is mostly markup and scripts with the numbers buried in embedded
 * data, and a plain file read of it is a wall of code. This pulls out what a
 * person would read — the title, the visible text, and the data the page
 * renders from — and, given a focus ("APD", from a link's #area=APD), keeps
 * the parts about that.
 *
 * Read-only, and only inside the home folder, only for document types.
 */

const TYPES = new Set(['.html', '.htm', '.md', '.txt', '.json', '.csv'])
const MAX_BYTES = 25 * 1024 * 1024

/** "file:///Users/me/A%20B/x.html#area=APD" or "~/x.html" -> { path, fragment }. */
export function resolveLocation(location) {
  let loc = String(location).trim()
  let fragment = ''
  if (/^file:\/\//i.test(loc)) {
    const url = new URL(loc)
    fragment = decodeURIComponent(url.hash.replace(/^#/, ''))
    url.hash = ''
    return { path: fileURLToPath(url), fragment }
  }
  const hash = loc.indexOf('#')
  if (hash >= 0) {
    fragment = loc.slice(hash + 1)
    loc = loc.slice(0, hash)
  }
  if (loc.startsWith('~')) loc = homedir() + loc.slice(1)
  return { path: loc, fragment }
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
const decode = (s) =>
  s.replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (m, e) =>
    e[0] === '#'
      ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)))
      : (ENTITIES[e.toLowerCase()] ?? m),
  )

/** Title, visible text, and embedded data blobs from an HTML document. */
export function extractHtml(html) {
  const title = decode((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').trim())
  const data = []
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attrs = m[1]
    const body = m[2].trim()
    if (!body) continue
    if (/application\/(ld\+)?json/i.test(attrs)) data.push(body)
    else {
      // Data a page renders from, assigned in a script: const DATA = {...} / window.X = [...]
      for (const a of body.matchAll(/(?:const|let|var|window\.)\s*([A-Za-z_$][\w$]*)\s*=\s*([[{])/g)) {
        const start = a.index + a[0].length - 1
        data.push(`${a[1]} = ${body.slice(start, start + 400_000)}`)
      }
    }
  }
  const text = decode(
    html
      .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>|<\/(p|div|li|tr|h[1-6]|section|article|td|th)>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim()
  return { title, text, data }
}

/** The parts of `s` around each mention of `focus`, merged, up to `max` chars. */
export function around(s, focus, radius, max) {
  if (!focus) return s.slice(0, max)
  const lower = s.toLowerCase()
  const needle = focus.toLowerCase()
  const spans = []
  let i = lower.indexOf(needle)
  while (i >= 0 && spans.length < 200) {
    const a = Math.max(0, i - radius)
    const b = Math.min(s.length, i + needle.length + radius)
    const last = spans[spans.length - 1]
    if (last && a <= last[1]) last[1] = b
    else spans.push([a, b])
    i = lower.indexOf(needle, i + needle.length)
  }
  let out = ''
  for (const [a, b] of spans) {
    if (out.length >= max) break
    out += `${out ? '\n…\n' : ''}${s.slice(a, b)}`
  }
  return out.slice(0, max)
}

/** A focus word from a link fragment like "sprint=everything&area=APD". */
export function focusFromFragment(fragment) {
  const params = new URLSearchParams(fragment)
  for (const key of ['area', 'project', 'team', 'focus', 'q', 'filter']) {
    const v = params.get(key)
    if (v && v !== 'all' && v !== 'everything') return v
  }
  return ''
}

export async function readLocalPage({ location, focus, maxChars = 30_000 }) {
  const { path, fragment } = resolveLocation(location)
  const home = await realpath(homedir())
  let real
  try {
    real = await realpath(path)
  } catch {
    throw new Error(`there is no file at ${path.replace(homedir(), '~')}`)
  }
  if (real !== home && !real.startsWith(home + sep)) throw new Error('only files in your home folder can be read')
  // Hidden folders and ~/Library are where credentials and app state live —
  // ~/.jarvis's flow URLs, ~/.claude.json, ~/.aws, browser profiles — and a
  // .json or .txt among them reads as a document. Nothing he needs to read
  // for the user is kept there.
  const parts = real.slice(home.length + 1).split(sep)
  if (parts[0] === 'Library' || parts.some((p) => p.startsWith('.'))) {
    throw new Error('files in hidden folders and Library are not read this way')
  }
  const type = extname(real).toLowerCase()
  if (!TYPES.has(type)) throw new Error(`${type || 'that'} files are not read this way`)
  const info = await stat(real)
  if (info.size > MAX_BYTES) throw new Error('that file is too large to read')
  const raw = await readFile(real, 'utf8')
  const want = (focus ?? '').trim() || focusFromFragment(fragment)
  const modified = info.mtime.toISOString()
  if (type !== '.html' && type !== '.htm') {
    return { file: real.replace(home, '~'), modified, focus: want, content: around(raw, want, 1500, maxChars) }
  }
  const { title, text, data } = extractHtml(raw)
  const textPart = around(text, want, 600, Math.floor(maxChars * 0.4))
  let budget = maxChars - textPart.length
  const dataParts = []
  for (const d of data) {
    if (budget <= 500) break
    const part = around(d, want, 500, budget)
    if (!part) continue
    dataParts.push(part)
    budget -= part.length
  }
  return {
    file: real.replace(home, '~'),
    modified,
    title,
    fragment,
    focus: want,
    text: textPart,
    data: dataParts,
  }
}

export function localFilesServer() {
  return createSdkMcpServer({
    name: 'jarvis_files',
    version: '1.0.0',
    tools: [
      tool(
        'read_local_page',
        'Read a report or page saved on this Mac — a file:// link or a path — such as a generated ' +
          'HTML dashboard. Returns the title, when it was last updated, the visible text and the data ' +
          'the page is built from, narrowed to `focus` when given (a link ending #area=APD focuses on ' +
          'APD by itself). Use this, never the browser, for anything on this machine.',
        {
          location: z.string().min(1).describe('A file:// URL or a path, as given.'),
          focus: z.string().optional().describe('A project, area or word to narrow to.'),
        },
        async ({ location, focus }) => {
          try {
            return { content: [{ type: 'text', text: JSON.stringify(await readLocalPage({ location, focus })) }] }
          } catch (err) {
            return { content: [{ type: 'text', text: `Could not read it: ${err.message}.` }], isError: true }
          }
        },
      ),
    ],
  })
}
