/**
 * What the page heard, said and decided over the last few minutes, for a
 * "that was wrong" report (bridge/reports.mjs).
 *
 * The voice bugs that mattered were all decisions nobody could see: a noise
 * taken for speech, a call taken for a question, a turn cut off on a sound.
 * Each such decision is noted here, with the words it was about, so a report
 * shows what happened in order instead of leaving it to be guessed from a
 * screenshot. In memory only, the last few minutes; nothing is kept on disk
 * until a report is asked for.
 *
 * Kept import-free so tests can run it with type stripping.
 */
export type TrailEntry = { at: number; kind: string; text: string }

const MAX = 120
const AGE_MS = 15 * 60_000
let entries: TrailEntry[] = []

export function note(kind: string, text: string, now = Date.now()): void {
  entries.push({ at: now, kind, text: String(text).slice(0, 300) })
  if (entries.length > MAX) entries = entries.slice(-MAX)
}

/** The trail, oldest first, without anything older than a quarter of an hour. */
export function trail(now = Date.now()): TrailEntry[] {
  return entries.filter((e) => now - e.at < AGE_MS)
}

export function clearTrail(): void {
  entries = []
}

/** "That was wrong", "that's wrong", "report that": a report, not a question. */
export const WRONG = /^(?:that(?: was|'s| is) (?:wrong|not right)|report (?:that|this)|bug report)[.!]?$/i
