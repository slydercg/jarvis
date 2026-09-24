import type { MouseEvent } from 'react'
import { sendBriefOp, watchBrief, type BriefResult } from '../lib/bridge'
import { isBriefRef, settledLabel } from '../lib/brief'
import { COMMAND_EVENT } from './CommandBar'

/**
 * Clicks on the buttons sanitise.ts adds to brief lines, for cards and blades
 * alike: one delegated handler on the markup, since the buttons live inside
 * HTML React does not own.
 *
 * Done and Tomorrow go to the bridge, which checks the line and answers; the
 * row then says what happened. Reply comes back as a question and is asked
 * exactly as if typed, so a draft passes every gate a spoken request does.
 */
export function onBriefClick(e: MouseEvent<HTMLElement>) {
  const button = (e.target as HTMLElement).closest('button[data-brief-op]')
  if (!button) return
  const row = button.closest('[data-brief]')
  const ref = row?.getAttribute('data-brief')
  const op = button.getAttribute('data-brief-op') ?? ''
  if (!row || !isBriefRef(ref)) return
  e.preventDefault()
  e.stopPropagation()
  if (!sendBriefOp(ref, op)) {
    say(ref, 'Not connected to the bridge')
    return
  }
  for (const r of rows(ref)) r.setAttribute('data-brief-state', 'pending')
}

const rows = (ref: string) => Array.from(document.querySelectorAll(`[data-brief="${CSS.escape(ref)}"]`))

/** Replace a line's buttons with a few words. */
function say(ref: string, text: string, state?: string) {
  for (const row of rows(ref)) {
    if (state) row.setAttribute('data-brief-state', state)
    else row.removeAttribute('data-brief-state')
    const bar = row.querySelector('.brief-acts')
    if (!bar) continue
    const note = document.createElement('span')
    note.className = 'brief-said'
    note.textContent = text
    if (state) bar.replaceChildren(note)
    else {
      bar.querySelector('.brief-said')?.remove()
      bar.append(note)
    }
  }
}

watchBrief((r: BriefResult) => {
  if (!isBriefRef(r.ref)) return
  if (!r.ok) {
    say(r.ref, r.message || 'That did not work')
    return
  }
  if (r.op === 'reply') {
    for (const row of rows(r.ref)) row.removeAttribute('data-brief-state')
    if (r.ask) window.dispatchEvent(new CustomEvent(COMMAND_EVENT, { detail: r.ask }))
    return
  }
  if (r.op === 'done' || r.op === 'snooze') say(r.ref, settledLabel[r.op], r.op)
})
