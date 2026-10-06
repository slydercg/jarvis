import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { docxText, findTranscript, nameMatch, unzipEntry, vttText } from '../bridge/transcripts.mjs'

/** A minimal .zip holding one deflated file, as a .docx is built. */
function zip(name, content) {
  const data = deflateRawSync(Buffer.from(content))
  const n = Buffer.from(name)
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(8, 8)
  local.writeUInt32LE(data.length, 18)
  local.writeUInt16LE(n.length, 26)
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(8, 10)
  central.writeUInt32LE(data.length, 20)
  central.writeUInt16LE(n.length, 28)
  central.writeUInt32LE(0, 42)
  const cdStart = local.length + n.length + data.length
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(1, 8)
  eocd.writeUInt16LE(1, 10)
  eocd.writeUInt32LE(central.length + n.length, 12)
  eocd.writeUInt32LE(cdStart, 16)
  return Buffer.concat([local, n, data, central, n, eocd])
}

const para = (t) => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`
const TEAMS_DOCX = `<w:document><w:body>${[
  'Daily IT Leader Sync-20261006_163000-Meeting Recording',
  'Ginsberg, Corey   0:03',
  'Morning. Let&apos;s start with the repo migration.',
  'Ginsberg, Corey   0:09',
  'Dan has the APD repos.',
  'Slyder, Mark   0:15',
  'I&apos;ll send the triage list by Friday.',
].map(para).join('')}</w:body></w:document>`

const VTT =
  'WEBVTT\n\n0f1e-22/14-0\n00:00:01.000 --> 00:00:02.000\n<v Ginsberg, Corey>Morning.</v>\n\n' +
  '0f1e-22/15-0\n00:00:02.000 --> 00:00:03.000\n<v Ginsberg, Corey>Repo migration first.</v>\n\n' +
  '00:00:03.000 --> 00:00:04.000\n<v Slyder, Mark>Triage list by Friday.</v>'

test('a Teams .docx transcript reads as "Speaker: words", one line per turn', () => {
  const xml = unzipEntry(zip('word/document.xml', TEAMS_DOCX), 'word/document.xml').toString('utf8')
  assert.equal(
    docxText(xml),
    "Daily IT Leader Sync-20261006_163000-Meeting Recording\n" +
      "Ginsberg, Corey: Morning. Let's start with the repo migration. Dan has the APD repos.\n" +
      "Slyder, Mark: I'll send the triage list by Friday.",
  )
})

test('a .vtt transcript reads the same way', () => {
  assert.equal(vttText(VTT), 'Ginsberg, Corey: Morning. Repo migration first.\nSlyder, Mark: Triage list by Friday.')
})

test("a file is the meeting's only when its name carries most of the meeting's name", () => {
  assert.equal(nameMatch('Daily IT Leader Sync', 'Daily IT Leader Sync.vtt'), 1)
  assert.equal(nameMatch('Daily IT Leader Sync', 'Daily IT Leader Sync-20261006_163000-Meeting Recording.docx'), 1)
  assert.ok(nameMatch('Daily IT Leader Sync', 'Weaver Slyder Bi-Weekly Touchpoint.vtt') < 0.6)
  assert.ok(nameMatch('APD - Intake - Weekly Initiative/Epic Portfolio review', 'APD - Intake - Weekly Strategic Opportunity Intake Triage.vtt') < 0.6)
})

test('finds the newest matching transcript in Downloads, and nothing else', async () => {
  const home = mkdtempSync(join(tmpdir(), 'jarvis-home-'))
  const downloads = join(home, 'Downloads')
  mkdirSync(downloads)
  mkdirSync(join(home, 'Documents'))
  const now = Date.now()
  const at = (file, ms) => utimesSync(file, new Date(ms), new Date(ms))
  // The right meeting, as a .docx, and an older .vtt of the same meeting.
  writeFileSync(join(downloads, 'Daily IT Leader Sync.docx'), zip('word/document.xml', TEAMS_DOCX))
  writeFileSync(join(downloads, 'Daily IT Leader Sync.vtt'), VTT)
  at(join(downloads, 'Daily IT Leader Sync.vtt'), now - 3 * 86_400_000)
  // Other meetings, other types, too old, and a link out of the folder: never read.
  writeFileSync(join(downloads, 'Weaver Slyder Touchpoint.vtt'), VTT)
  writeFileSync(join(downloads, 'Daily IT Leader Sync notes.txt'), 'not a transcript')
  writeFileSync(join(home, 'Documents', 'Daily IT Leader Sync old.vtt'), VTT)
  at(join(home, 'Documents', 'Daily IT Leader Sync old.vtt'), now - 30 * 86_400_000)
  const outside = join(mkdtempSync(join(tmpdir(), 'jarvis-outside-')), 'secret.vtt')
  writeFileSync(outside, VTT)
  symlinkSync(outside, join(downloads, 'Daily IT Leader Sync link.vtt'))

  const r = await findTranscript('Daily IT Leader Sync', { home, now })
  assert.equal(r.found, true)
  assert.match(r.file, /Downloads.Daily IT Leader Sync\.docx$/)
  assert.match(r.transcript, /^Daily IT Leader Sync/)
  assert.match(r.transcript, /Slyder, Mark: I'll send the triage list by Friday\./)

  const none = await findTranscript('Quarterly Budget Review', { home, now })
  assert.deepEqual(none, { found: false, looked: ['~/Downloads', '~/Desktop', '~/Documents'] })
})

test('a folder macOS will not let Jarvis read is named, not taken for "no transcript"', { skip: process.getuid?.() === 0 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'jarvis-home-'))
  mkdirSync(join(home, 'Downloads'), { mode: 0o000 })
  try {
    const r = await findTranscript('Daily IT Leader Sync', { home })
    assert.deepEqual(r.blocked, ['~/Downloads'])
    assert.match(r.fix, /Privacy & Security/)
  } finally {
    chmodSync(join(home, 'Downloads'), 0o755)
  }
})

test('no transcript for a meeting tells the bridge, so its card can say how to get one', async () => {
  const home = mkdtempSync(join(tmpdir(), 'jarvis-home-'))
  mkdirSync(join(home, 'Downloads'))
  writeFileSync(join(home, 'Downloads', 'Daily IT Leader Sync.vtt'), VTT)
  const realHome = process.env.HOME
  process.env.HOME = home
  try {
    const { localFilesServer } = await import('../bridge/localfiles.mjs')
    const told = []
    const { handler } = localFilesServer({ onNoTranscript: (m) => told.push(m) }).instance._registeredTools.find_meeting_transcript
    const hit = JSON.parse((await handler({ meeting: 'Daily IT Leader Sync' })).content[0].text)
    assert.equal(hit.found, true)
    assert.deepEqual(told, [])
    await handler({ meeting: 'Weaver / Slyder Bi-Weekly Touchpoint' })
    assert.deepEqual(told, ['Weaver / Slyder Bi-Weekly Touchpoint'])
  } finally {
    process.env.HOME = realHome
  }
})
