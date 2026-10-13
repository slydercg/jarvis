import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { docxText, findTranscript, nameMatch, unzipEntry, vttText, watchForTranscripts } from '../bridge/transcripts.mjs'

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
  'Morning Ops Sync-20261006_163000-Meeting Recording',
  'Rivera, Alex   0:03',
  'Morning. Let&apos;s start with the repo migration.',
  'Rivera, Alex   0:09',
  'Kim has the billing repos.',
  'Lee, Sam   0:15',
  'I&apos;ll send the triage list by Friday.',
].map(para).join('')}</w:body></w:document>`

const VTT =
  'WEBVTT\n\n0f1e-22/14-0\n00:00:01.000 --> 00:00:02.000\n<v Rivera, Alex>Morning.</v>\n\n' +
  '0f1e-22/15-0\n00:00:02.000 --> 00:00:03.000\n<v Rivera, Alex>Repo migration first.</v>\n\n' +
  '00:00:03.000 --> 00:00:04.000\n<v Lee, Sam>Triage list by Friday.</v>'

test('a Teams .docx transcript reads as "Speaker: words", one line per turn', () => {
  const xml = unzipEntry(zip('word/document.xml', TEAMS_DOCX), 'word/document.xml').toString('utf8')
  assert.equal(
    docxText(xml),
    "Morning Ops Sync-20261006_163000-Meeting Recording\n" +
      "Rivera, Alex: Morning. Let's start with the repo migration. Kim has the billing repos.\n" +
      "Lee, Sam: I'll send the triage list by Friday.",
  )
})

test('a .vtt transcript reads the same way', () => {
  assert.equal(vttText(VTT), 'Rivera, Alex: Morning. Repo migration first.\nLee, Sam: Triage list by Friday.')
})

test("a file is the meeting's only when its name carries most of the meeting's name", () => {
  assert.equal(nameMatch('Morning Ops Sync', 'Morning Ops Sync.vtt'), 1)
  assert.equal(nameMatch('Morning Ops Sync', 'Morning Ops Sync-20261006_163000-Meeting Recording.docx'), 1)
  assert.ok(nameMatch('Morning Ops Sync', 'Vendor Bi-Weekly Touchpoint.vtt') < 0.6)
  assert.ok(nameMatch('Product - Intake - Weekly Initiative/Epic Portfolio review', 'Product - Intake - Weekly Strategic Opportunity Intake Triage.vtt') < 0.6)
})

test('finds the newest matching transcript in Downloads, and nothing else', async () => {
  const home = mkdtempSync(join(tmpdir(), 'jarvis-home-'))
  const downloads = join(home, 'Downloads')
  mkdirSync(downloads)
  mkdirSync(join(home, 'Documents'))
  const now = Date.now()
  const at = (file, ms) => utimesSync(file, new Date(ms), new Date(ms))
  // The right meeting, as a .docx, and an older .vtt of the same meeting.
  writeFileSync(join(downloads, 'Morning Ops Sync.docx'), zip('word/document.xml', TEAMS_DOCX))
  writeFileSync(join(downloads, 'Morning Ops Sync.vtt'), VTT)
  at(join(downloads, 'Morning Ops Sync.vtt'), now - 3 * 86_400_000)
  // Other meetings, other types, too old, and a link out of the folder: never read.
  writeFileSync(join(downloads, 'Vendor Touchpoint.vtt'), VTT)
  writeFileSync(join(downloads, 'Morning Ops Sync notes.txt'), 'not a transcript')
  writeFileSync(join(home, 'Documents', 'Morning Ops Sync old.vtt'), VTT)
  at(join(home, 'Documents', 'Morning Ops Sync old.vtt'), now - 30 * 86_400_000)
  const outside = join(mkdtempSync(join(tmpdir(), 'jarvis-outside-')), 'secret.vtt')
  writeFileSync(outside, VTT)
  symlinkSync(outside, join(downloads, 'Morning Ops Sync link.vtt'))

  const r = await findTranscript('Morning Ops Sync', { home, now })
  assert.equal(r.found, true)
  assert.match(r.file, /Downloads.Morning Ops Sync\.docx$/)
  assert.match(r.transcript, /^Morning Ops Sync/)
  assert.match(r.transcript, /Lee, Sam: I'll send the triage list by Friday\./)

  const none = await findTranscript('Quarterly Budget Review', { home, now })
  assert.deepEqual(none, { found: false, looked: ['~/Downloads', '~/Desktop', '~/Documents'] })
})

test('a folder macOS will not let Jarvis read is named, not taken for "no transcript"', { skip: process.getuid?.() === 0 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'jarvis-home-'))
  mkdirSync(join(home, 'Downloads'), { mode: 0o000 })
  try {
    const r = await findTranscript('Morning Ops Sync', { home })
    assert.deepEqual(r.blocked, ['~/Downloads'])
    assert.match(r.fix, /Privacy & Security/)
  } finally {
    chmodSync(join(home, 'Downloads'), 0o755)
  }
})

test('no transcript for a meeting tells the bridge, so its card can say how to get one', async () => {
  const home = mkdtempSync(join(tmpdir(), 'jarvis-home-'))
  mkdirSync(join(home, 'Downloads'))
  writeFileSync(join(home, 'Downloads', 'Morning Ops Sync.vtt'), VTT)
  const realHome = process.env.HOME
  process.env.HOME = home
  try {
    const { localFilesServer } = await import('../bridge/localfiles.mjs')
    const told = []
    const { handler } = localFilesServer({ onNoTranscript: (m) => told.push(m) }).instance._registeredTools.find_meeting_transcript
    const hit = JSON.parse((await handler({ meeting: 'Morning Ops Sync' })).content[0].text)
    assert.equal(hit.found, true)
    assert.deepEqual(told, [])
    await handler({ meeting: 'Vendor Bi-Weekly Touchpoint' })
    assert.deepEqual(told, ['Vendor Bi-Weekly Touchpoint'])
  } finally {
    process.env.HOME = realHome
  }
})

test('a meeting waiting for its transcript is told once when it turns up, and forgotten after a day', async () => {
  let t = 0
  let there = false
  const found = []
  const watch = watchForTranscripts({
    now: () => t,
    find: async (title) => (there && title === 'Morning Ops Sync' ? { found: true, file: '~/Downloads/Morning Ops Sync.vtt' } : { found: false }),
    onFound: (title, r) => found.push([title, r.file]),
  })
  watch.add('Morning Ops Sync')
  watch.add('Vendor Bi-Weekly Touchpoint')
  await watch.tick()
  assert.deepEqual(found, [])
  there = true
  await watch.tick()
  await watch.tick()
  assert.deepEqual(found, [['Morning Ops Sync', '~/Downloads/Morning Ops Sync.vtt']])
  assert.equal(watch.size(), 1)
  t = 25 * 3_600_000
  await watch.tick()
  assert.equal(watch.size(), 0)
})
