import { lstat, readdir, readFile, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname, join, sep } from 'node:path'
import { inflateRawSync } from 'node:zlib'

/**
 * A Teams meeting transcript he has downloaded, for a recap when Granola has
 * nothing and no recap email came. Protective has no Copilot licence for him
 * and won't grant Graph access to transcripts, but the meeting's Transcript
 * tab is there without either: Transcript → Download saves a .vtt or .docx
 * to this Mac. This finds it by the meeting's name and turns it into
 * "Speaker: words" lines.
 *
 * Read-only. Only the top level of Downloads, Desktop and Documents is looked
 * at, only .vtt and .docx files changed in the last week, and only one whose
 * name matches the meeting: a transcript of some other meeting, or any other
 * document, is never read.
 */

const TYPES = new Set(['.vtt', '.docx'])
const MAX_BYTES = 25 * 1024 * 1024
const MAX_TEXT = 60_000
const PLACES = ['Downloads', 'Desktop', 'Documents']

/** WebVTT down to "Speaker: words" lines: cue numbers, timings and tags go. */
export function vttText(v) {
  if (typeof v !== 'string' || !/^﻿?WEBVTT/.test(v)) return v
  const out = []
  for (const raw of v.split(/\r?\n/)) {
    const l = raw.trim()
    if (!l || /^﻿?WEBVTT/.test(l) || /-->/.test(l) || /^(NOTE|\d+$|[\w-]+\/\d+-\d+$)/i.test(l)) continue
    const m = l.match(/^<v\s+([^>]+)>(.*?)(?:<\/v>)?$/)
    const line = m ? `${m[1].trim()}: ${m[2]}` : l.replace(/<[^>]+>/g, '')
    // Teams splits one speaker's sentence across cues; join them back up.
    const who = m ? `${m[1].trim()}: ` : null
    if (who && out.length && out[out.length - 1].startsWith(who)) out[out.length - 1] += ` ${m[2]}`
    else out.push(line)
  }
  return out.join('\n')
}

/**
 * One file out of a .zip (a .docx is one), with nothing but zlib. Bounded:
 * a crafted file that inflates to gigabytes stops at `max` bytes.
 */
export function unzipEntry(buf, name, max = 50 * 1024 * 1024) {
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('not a .docx file')
  const count = buf.readUInt16LE(eocd + 10)
  let at = buf.readUInt32LE(eocd + 16)
  for (let n = 0; n < count && at + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) break
    const method = buf.readUInt16LE(at + 10)
    const size = buf.readUInt32LE(at + 20)
    const nameLen = buf.readUInt16LE(at + 28)
    const skip = nameLen + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32)
    const local = buf.readUInt32LE(at + 42)
    if (buf.toString('utf8', at + 46, at + 46 + nameLen) === name) {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
      const data = buf.subarray(start, start + size)
      if (method === 0) return data
      if (method === 8) return inflateRawSync(data, { maxOutputLength: max })
      throw new Error('that .docx is compressed in a way this cannot read')
    }
    at += 46 + skip
  }
  throw new Error('no document inside that .docx')
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
const decode = (s) =>
  s.replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (m, e) =>
    e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENTITIES[e] ?? m),
  )

/**
 * A Teams transcript .docx as "Speaker: words" lines. Teams writes a line
 * with the speaker and a timestamp ("Jane Doe   0:03" or "0:00:03"), then
 * what they said; everything else in the document passes through as it is.
 */
export function docxText(xml) {
  const paras = xml
    .split(/<\/w:p>/)
    .map((p) => decode([...p.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join('')).trim())
    .filter(Boolean)
  const out = []
  let speaker = null
  for (const p of paras) {
    const head = p.match(/^(.+?)\s+(?:\d{1,2}:)?\d{1,2}:\d{2}$/) ?? p.match(/^(?:\d{1,2}:)?\d{1,2}:\d{2}\s+(.+)$/)
    if (head) {
      speaker = head[1].trim()
      continue
    }
    const who = speaker ? `${speaker}: ` : ''
    if (who && out.length && out[out.length - 1].startsWith(who)) out[out.length - 1] += ` ${p}`
    else out.push(`${who}${p}`)
  }
  return out.join('\n')
}

/** The words of a meeting or file name that say which meeting it is. */
const words = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/\.(vtt|docx)$/, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !['transcript', 'meeting', 'recording', 'the', 'and'].includes(w))

/** How much of the meeting's name a file's name carries, 0 to 1. */
export function nameMatch(meeting, file) {
  const want = [...new Set(words(meeting))]
  if (!want.length) return 0
  const have = new Set(words(file))
  return want.filter((w) => have.has(w)).length / want.length
}

/**
 * The newest downloaded transcript whose name matches the meeting, read.
 * `home` and `now` are for the tests.
 */
export async function findTranscript(meeting, { home = homedir(), now = Date.now(), days = 7 } = {}) {
  const root = await realpath(home)
  const found = []
  const blocked = []
  for (const place of PLACES) {
    let names
    try {
      names = await readdir(join(root, place))
    } catch (err) {
      // macOS asks before an app reads Downloads, Desktop or Documents; once
      // refused (or never answered, under the LaunchAgent) every read fails
      // with EPERM, which would otherwise look exactly like "no transcript".
      if (err?.code === 'EPERM' || err?.code === 'EACCES') blocked.push(`~/${place}`)
      continue
    }
    for (const name of names) {
      if (name.startsWith('.') || !TYPES.has(extname(name).toLowerCase())) continue
      const path = join(root, place, name)
      // A link could point anywhere; only a plain file here is read.
      const info = await lstat(path).catch(() => null)
      if (!info?.isFile() || info.size > MAX_BYTES || now - info.mtimeMs > days * 86_400_000) continue
      const score = nameMatch(meeting, name)
      if (score >= 0.6) found.push({ path, place, name, score, mtime: info.mtimeMs })
    }
  }
  found.sort((a, b) => b.score - a.score || b.mtime - a.mtime)
  const best = found[0]
  if (!best) {
    return {
      found: false,
      looked: PLACES.map((p) => `~/${p}`),
      ...(blocked.length
        ? {
            blocked,
            fix: 'macOS is not letting Jarvis read these folders: System Settings → Privacy & Security → Files and Folders (or Full Disk Access) → allow node.',
          }
        : {}),
    }
  }
  const buf = await readFile(best.path)
  const text = extname(best.name).toLowerCase() === '.vtt' ? vttText(buf.toString('utf8')) : docxText(unzipEntry(buf, 'word/document.xml').toString('utf8'))
  return {
    found: true,
    file: `~${sep}${best.place}${sep}${best.name}`,
    modified: new Date(best.mtime).toISOString(),
    transcript: String(text).slice(0, MAX_TEXT),
    truncated: String(text).length > MAX_TEXT,
  }
}
