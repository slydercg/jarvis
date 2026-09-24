/**
 * The buttons on a brief line. The bridge gives each line of the served brief
 * a ref (bridge/briefing.mjs, briefRef): the build of the brief, the line, and
 * "m" for mail or "t" for a task. The model copies it onto the row as
 * data-brief; the sanitiser keeps it only on a .hud-row and only in exactly
 * this shape, and then adds the buttons itself. The model never writes a
 * button, and a ref only ever names a line the bridge checks again.
 *
 * Kept import-free so tests can run it with type stripping.
 */
export const BRIEF_REF = /^[a-z0-9]{4}-[1-8][mt]$/

export type BriefOp = 'done' | 'snooze' | 'reply'

export function isBriefRef(ref: unknown): ref is string {
  return typeof ref === 'string' && BRIEF_REF.test(ref)
}

/** The buttons a line gets, in order: Reply only on mail. */
export function briefOps(ref: string): Array<{ op: BriefOp; label: string; title: string }> {
  if (!isBriefRef(ref)) return []
  const ops: Array<{ op: BriefOp; label: string; title: string }> = []
  if (ref.endsWith('m')) ops.push({ op: 'reply', label: 'Reply', title: 'Ask him to draft a reply' })
  ops.push({ op: 'done', label: 'Done', title: 'Mark it done on the brief' })
  ops.push({ op: 'snooze', label: 'Tomorrow', title: 'Off today’s brief; back tomorrow at 9 as a reminder' })
  return ops
}

/** What the line says once a button has worked. */
export const settledLabel: Record<Exclude<BriefOp, 'reply'>, string> = {
  done: 'Done',
  snooze: 'Tomorrow, 9am',
}
