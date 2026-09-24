/**
 * Reading a yes or a no out of a reply to "shall I proceed?". Kept apart
 * from App.tsx so it can be tested without the browser.
 */

export const YES =
  /^(yes|yeah|yep|yup|sure|ok|okay|do it|go ahead|go for it|confirm(ed)?|proceed|send it|please do|affirmative|correct|absolutely)\b/i
export const NO =
  /^(no|nope|nah|cancel|stop|undo|don'?t|do not|abort|wait|hold on|never ?mind|negative|scratch that)\b/i

/**
 * Longest a spoken yes may run. A TV, a call on speaker or someone across the
 * room saying "okay, so the thing is…" starts with a yes-word; an answer to
 * "shall I proceed?" is short. Typed answers are deliberate and not limited.
 */
export const SPOKEN_YES_MAX_WORDS = 5

/** true, false, or null when the reply is neither. "No" wins a tie. */
export function yesOrNo(said: string, spoken = false): boolean | null {
  const s = said.replace(/^[\s,.!?-]+/, '')
  if (NO.test(s)) return false
  if (YES.test(s) && (!spoken || s.split(/\s+/).filter(Boolean).length <= SPOKEN_YES_MAX_WORDS)) return true
  return null
}
