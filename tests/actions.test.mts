import { test } from 'node:test'
import assert from 'node:assert/strict'
import { primaryAction, splitPromise } from '../src/lib/actions.ts'

test('mail offers a reply about its subject', () => {
  assert.deepEqual(primaryAction({ kind: 'mail', title: 'Chris Pratt', detail: 'APD scope — wants a yes today' }), {
    label: 'Draft reply',
    ask: 'Draft a reply to Chris Pratt about "APD scope".',
  })
  assert.equal(primaryAction({ kind: 'mail', title: 'Chris Pratt' })?.ask, 'Draft a reply to Chris Pratt.')
})

test('a late promise of theirs offers a nudge; one of his own can be marked kept', () => {
  assert.deepEqual(
    primaryAction({ kind: 'promise', label: 'Overdue', title: 'Cathrene — send the provisioning doc', detail: '2 days late' }),
    { label: 'Draft nudge', ask: 'Draft a short, friendly nudge to Cathrene about: send the provisioning doc.' },
  )
  assert.deepEqual(primaryAction({ kind: 'promise', label: 'Promise', title: 'Maysoon — send the questionnaire' }), {
    label: 'Kept it',
    op: 'kept',
  })
})

test('portfolio, meetings and the ready-made jobs each have their one next step', () => {
  assert.equal(primaryAction({ kind: 'portfolio', label: 'Sprint', title: 'NI Sprint 42 is behind' })?.ask, 'Why is NI Sprint 42 behind?')
  assert.equal(primaryAction({ kind: 'portfolio', label: 'Portfolio', title: '2 high-priority items newly blocked' })?.label, "What's blocked?")
  assert.equal(primaryAction({ kind: 'meeting', title: 'APD weekly' })?.ask, 'Prep me for APD weekly.')
  assert.equal(primaryAction({ kind: 'brief', title: 'Your brief is ready' })?.ask, 'Brief me.')
  assert.equal(primaryAction({ kind: 'wrap', title: 'Ready to wrap up?' })?.ask, 'Wrap up my day.')
  assert.equal(primaryAction({ kind: 'review', title: 'Your week' })?.ask, 'Give me my weekly review.')
})

test('a reminder or a digest has no action of its own', () => {
  assert.equal(primaryAction({ kind: 'reminder', title: 'Call Chris' }), null)
  assert.equal(primaryAction({ kind: 'digest', title: '3 things held back' }), null)
})

test('a promise title splits on its dash, and survives not having one', () => {
  assert.deepEqual(splitPromise('Cathrene — send the doc'), ['Cathrene', 'send the doc'])
  assert.deepEqual(splitPromise('Just a note'), ['Just a note', ''])
})
