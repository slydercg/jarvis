/**
 * The same question asked again while the first is still being answered.
 *
 * A click on "What's blocked?" can start a lookup that takes minutes. Clicked
 * again, or typed again, it used to cut the first one off and start over, so
 * every repeat made the answer later and enough of them meant it never came.
 * A repeat now leaves the one in flight alone. Case, spacing, punctuation and
 * a leading "please" don't make it a different question.
 *
 * Kept import-free so the tests can load it with type stripping.
 */
export function sameQuestion(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/^(?:please |can you |could you )+/, '')
      .replace(/ please$/, '')
      .trim()
  const x = norm(a)
  return x !== '' && x === norm(b)
}
