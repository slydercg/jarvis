/**
 * What the voice loop does with a sound, a sentence or his name, decided in
 * one place so the decisions can be tested against the cases that went wrong
 * (tests/voice-scenarios.test.mts).
 *
 * Every voice bug so far was one of these going the wrong way: a keyboard
 * taken for speech that cut "Prep me" off, the other side of a call taken
 * for questions, a word like his name on a call opening the mic, a "yes" on a
 * call confirming an action. App.tsx asks these and does what they say.
 *
 * Kept import-free so tests can run it with type stripping.
 */

export type Phase = 'offline' | 'boot' | 'dormant' | 'waking' | 'listening' | 'thinking' | 'tooling' | 'speaking' | string

/** Someone (or something) started making sound. */
export type Onset = 'none' | 'ignore-call' | 'wait-for-words' | 'barge-in' | 'listen'

export function onsetAction(phase: Phase, hushed: boolean): Onset {
  if (phase === 'offline' || phase === 'boot' || phase === 'dormant') return 'none'
  // On a call, sound is the call: nothing it does may cut a turn off.
  if (hushed) return 'ignore-call'
  // Still working and saying nothing: there is nothing to talk over, so a
  // sound waits for words before anything is abandoned.
  if (phase === 'thinking' || phase === 'tooling') return 'wait-for-words'
  // Talking over him stops him: that is what barge-in is for.
  if (phase === 'speaking') return 'barge-in'
  return 'listen'
}

/**
 * Whether a transcribed sentence is his at all. On a call only a sentence
 * that starts with his name is, in every mode — including a "yes" while an
 * action waits on one, which the call could otherwise give for him.
 */
export function utteranceIsHis(text: string, hushed: boolean, leadingName: RegExp): boolean {
  if (!text.trim()) return false
  return !hushed || leadingName.test(text)
}

/** His name was heard, with what followed it in the same breath. */
export type Wake = 'ask' | 'stand-down' | 'greet'

export function wakeAction(trailing: string, hushed: boolean): Wake {
  if (trailing.trim()) return 'ask'
  // His name alone on a call is most likely the call: no greeting, no open mic.
  return hushed ? 'stand-down' : 'greet'
}
