import { test } from 'node:test'
import assert from 'node:assert/strict'
import { actionsSchema, cleanActions } from '../bridge/panels.mjs'

test('panel actions are trimmed, de-duplicated and capped at four', () => {
  const out = cleanActions([
    { label: '  Draft   reply ', ask: ' Draft a reply to Chris about the APD scope. ' },
    { label: 'draft reply', ask: 'Draft another reply.' },
    { label: 'Add to To Do', ask: 'Add these to my To Do.' },
    { label: '', ask: 'No label' },
    { label: 'No ask', ask: ' ' },
    { label: 'Prep me', ask: 'Prep me for APD weekly.' },
    { label: 'Open ticket', ask: 'Open NI-812.' },
    { label: 'One too many', ask: 'Ignored.' },
  ])
  assert.deepEqual(out, [
    { label: 'Draft reply', ask: 'Draft a reply to Chris about the APD scope.' },
    { label: 'Add to To Do', ask: 'Add these to my To Do.' },
    { label: 'Prep me', ask: 'Prep me for APD weekly.' },
    { label: 'Open ticket', ask: 'Open NI-812.' },
  ])
})

test('no usable actions is none at all, not an empty row of buttons', () => {
  assert.equal(cleanActions(undefined), undefined)
  assert.equal(cleanActions([]), undefined)
  assert.equal(cleanActions([{ label: 'x', ask: '' }]), undefined)
  assert.equal(cleanActions('Draft reply'), undefined)
})

test('malformed actions from the model never fail the panel they came with', () => {
  assert.equal(actionsSchema.parse([{ label: 'x'.repeat(80), ask: 'Too long a label' }]), undefined)
  assert.equal(actionsSchema.parse('not a list'), undefined)
  assert.deepEqual(actionsSchema.parse([{ label: 'Prep me', ask: 'Prep me for APD weekly.' }]), [
    { label: 'Prep me', ask: 'Prep me for APD weekly.' },
  ])
})
