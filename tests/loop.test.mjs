import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// A private ~/.jarvis for the ledger, the focus state and the day log.
process.env.JARVIS_HOME = mkdtempSync(join(tmpdir(), 'jarvis-loop-'))
process.env.JARVIS_FOCUS_VIPS = 'Chris Smith'

const c = await import('../bridge/commitments.mjs')
const f = await import('../bridge/focus.mjs')
const days = await import('../bridge/days.mjs')
const { sprintSlip } = await import('../bridge/alerts.mjs')
const { meetingHours } = await import('../bridge/review.mjs')

const day = (offset) => days.localDay(new Date(Date.now() + offset * 86_400_000))

test('the same promise found twice is one ledger item', () => {
  const first = c.addCommitments([
    { direction: 'mine', who: 'Chris', what: 'Send the revised roadmap', due: day(1) },
    { direction: 'theirs', who: 'Cathrene', what: 'send the provisioning doc', due: day(-2) },
    { direction: 'mine', who: '', what: 'no person attached' },
  ])
  assert.equal(first.length, 2)
  const again = c.addCommitments([
    { direction: 'mine', who: 'chris', what: 'send the revised roadmap to Chris' },
    { direction: 'mine', who: 'Chris', what: 'Approve the Datadog renewal' },
  ])
  assert.deepEqual(again.map((i) => i.what), ['Approve the Datadog renewal'])
})

test('open items come soonest first, filtered by person and direction', () => {
  const open = c.openCommitments()
  assert.equal(open[0].who, 'Cathrene')
  assert.equal(open[0].daysLeft, -2)
  assert.equal(c.openCommitments({ who: 'chris' }).length, 2)
  assert.equal(c.openCommitments({ direction: 'theirs' }).length, 1)
  assert.equal(c.commitmentsWith(['Chris Smith <chris@example.com>']).length, 2)
})

test('nudges: his own the day before, theirs once late, each said once', () => {
  const nudges = c.dueNudges()
  const lines = nudges.map((n) => n.say)
  assert.equal(nudges.length, 2)
  assert.match(lines.find((l) => l.includes('Chris')), /you told Chris you would send the revised roadmap — that is due tomorrow/)
  assert.match(lines.find((l) => l.includes('Cathrene')), /Cathrene was to send the provisioning doc — it is two days late\. Shall I draft a nudge\?/)
  assert.equal(c.dueNudges().length, 0, 'not said twice in a day')
})

test('closing a promise takes it off the open list', () => {
  const [item] = c.openCommitments({ who: 'Cathrene' })
  assert.equal(c.closeCommitment(item.id, 'done').status, 'done')
  assert.equal(c.openCommitments({ who: 'Cathrene' }).length, 0)
  assert.equal(c.closeCommitment('nope'), null)
})

test('focus: clock times, VIPs through, the rest held and returned as a digest', () => {
  const at = new Date('2026-09-24T10:00:00')
  assert.equal(new Date(f.parseUntil('2pm', at)).getHours(), 14)
  assert.equal(new Date(f.parseUntil('2', at)).getHours(), 14, 'a bare two during the day is the afternoon')
  assert.equal(new Date(f.parseUntil('14:30', at)).getMinutes(), 30)
  assert.equal(f.parseUntil('9am', at), null, 'a time already past is refused')
  assert.equal(f.parseUntil('soonish', at), null)

  const said = []
  const gate = f.focusGate((a) => said.push(a))
  f.startFocus({ minutes: 30, reason: 'roadmap' })
  assert.equal(f.focusState().active, true)
  gate.deliver({ kind: 'mail', title: 'Newsletter person', detail: 'x', at: '' })
  gate.deliver({ kind: 'mail', title: 'Chris Smith', detail: 'prod down', vip: true, at: '' })
  gate.deliver({ kind: 'meeting', title: 'Design review', detail: '', at: '' })
  gate.deliver({ kind: 'promise', title: 'Sam — estimate', detail: '', at: '' })
  assert.deepEqual(said.map((a) => a.title), ['Chris Smith', 'Design review'])
  assert.equal(f.focusState().held, 2)

  const digest = f.endFocus()
  assert.equal(digest.kind, 'digest')
  assert.match(digest.say, /Two things came in while you were heads-down: Newsletter person; Sam — estimate\./)
  assert.equal(f.focusState().active, false)
  assert.equal(f.endFocus(), null, 'nothing held, no digest')
  assert.deepEqual(f.vips(), ['Chris Smith'])
})

test('once-a-day offers and hour windows', () => {
  assert.equal(days.firstToday('test-offer'), true)
  assert.equal(days.firstToday('test-offer'), false)
  const fri = new Date('2026-09-25T15:30:00')
  assert.equal(days.inWindow('14-18', [5], fri), true)
  assert.equal(days.inWindow('14-18', [4], fri), false)
  assert.equal(days.inWindow('17-20', 'weekdays', new Date('2026-09-26T18:00:00')), false, 'Saturday')
})

test('a sprint is behind when its time runs well ahead of its work', () => {
  const now = Date.parse('2026-09-23T12:00:00')
  const sp = { start: '2026-09-14', end: '2026-09-25', total: 20 }
  assert.ok(sprintSlip({ ...sp, done: 3 }, now) > 25)
  assert.ok(sprintSlip({ ...sp, done: 15 }, now) < 25)
  assert.equal(sprintSlip({ ...sp, done: 0 }, Date.parse('2026-09-15T12:00:00')), null, 'too early to judge')
  assert.equal(sprintSlip({ name: 'no dates', done: 1, total: 4 }, now), null)
})

test('meeting hours per day come from the day log', () => {
  const hours = meetingHours([
    {
      day: '2026-09-21',
      meetings: [
        { start: '2026-09-21T09:00:00-05:00', end: '2026-09-21T10:30:00-05:00' },
        { start: '2026-09-21T14:00:00-05:00', end: '2026-09-21T14:30:00-05:00' },
      ],
    },
    { day: '2026-09-22' },
  ])
  assert.deepEqual(hours, [
    { day: '2026-09-21', meetings: 2, hours: 2 },
    { day: '2026-09-22', meetings: 0, hours: 0 },
  ])
})
