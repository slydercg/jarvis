/**
 * How many alert cards fit above the conversation.
 *
 * The cards sit top right and the conversation grows upward from the bottom,
 * so a long answer on a laptop screen ran up underneath them and the cards
 * covered its first lines. The stack now shows only as many cards as fit
 * above the conversation, newest first, and the rest collapse into one
 * "+N more on your review list" line (everything on a card is on the list).
 *
 * Kept import-free so tests can run it with type stripping.
 */

/**
 * `heights` are the cards' heights, newest first. The cards start at `top`
 * and must end above `limit`, with `gap` between items. When some are left
 * out, the "+N more" line (`more` tall) has to fit too.
 */
export function cardsThatFit(heights: number[], top: number, limit: number, gap: number, more: number): number {
  const bottom = (n: number) => top + heights.slice(0, n).reduce((a, h) => a + h, 0) + gap * Math.max(0, n - 1)
  if (bottom(heights.length) <= limit) return heights.length
  for (let n = heights.length - 1; n > 0; n--) {
    if (bottom(n) + gap + more <= limit) return n
  }
  return 0
}

/** Whether two [left, right] spans share any width. */
export const overlaps = (a: [number, number], b: [number, number]) => a[0] < b[1] && b[0] < a[1]
