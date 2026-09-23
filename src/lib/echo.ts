/**
 * Is this the microphone hearing the speakers?
 *
 * The mic stays open while he talks, and the macOS voice plays outside the
 * browser, where its echo canceller cannot hear it — so he hears himself, and
 * without this he answers his own sentences ("Yes, one thirteen, sir." comes
 * back as "Yes, 113, Sir." and gets "Quite right, sir."). No imports, so it can
 * be checked directly against real transcripts.
 */

const UNITS = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
  'seventeen', 'eighteen', 'nineteen',
]
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']

/**
 * Numbers as digits, whichever way they arrived.
 *
 * He says "one thirteen"; the recogniser writes "113" or "1:13". Spelt-out
 * numbers become digits ("twenty five" -> 25), and a run of numbers is read
 * the way times and figures are spoken, as one ("one thirteen" -> 113,
 * "1 13" -> 113), so both sides of the comparison end up with the same token.
 */
function digits(words: string[]): string[] {
  const out: string[] = []
  let run = ''
  const flush = () => {
    if (run) out.push(run)
    run = ''
  }
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    let n: string | null = null
    if (/^\d+$/.test(w)) n = w
    else if (UNITS.includes(w)) n = String(UNITS.indexOf(w))
    else if (TENS.includes(w) && w) {
      const next = words[i + 1]
      const unit = next ? UNITS.indexOf(next) : -1
      if (unit > 0 && unit < 10) {
        n = String(TENS.indexOf(w) * 10 + unit)
        i++
      } else n = String(TENS.indexOf(w) * 10)
    } else if (w === 'oh' && run) n = '0' // "one oh five"
    if (n === null) {
      flush()
      out.push(w)
    } else run += n
  }
  flush()
  return out
}

export function norm(s: string): string {
  const words = s
    .toLowerCase()
    // "1:13" and "1,300" are one number, not two.
    .replace(/(\d)[:,](\d)/g, '$1$2')
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
  return digits(words).join(' ')
}

/**
 * Words too common to be evidence of anything.
 *
 * This set is the difference between a usable filter and an infuriating one.
 * "What about the second one?" is a perfectly ordinary follow-up, and every
 * word in it is likely to appear somewhere in the answer it follows — so a
 * naive bag-of-words match suppresses the user's real question as an echo.
 * Only distinctive words count as proof he is hearing himself.
 */
const STOP = new Set(
  ('a an the and or but so of to in on at by for with from is are was were be ' +
    'it its this that these those i you he she we they me him her them my your ' +
    'our their what which who how why when where do does did can could would ' +
    'should will shall not no yes if then than as about into over under out up ' +
    'down first second third now here there just very really got ' +
    'get have has had say said tell okay ok well right').split(' '),
)

/**
 * Compared as bags of words rather than by string distance: the recogniser
 * mangles its own playback badly enough that a substring match rarely holds,
 * but the *words* survive. `override` is what must always cut through — "stop",
 * his name — however much it collides with what he is saying.
 */
export function isEcho(heard: string, spoken: string, override?: RegExp): boolean {
  if (!spoken) return false
  if (override?.test(heard)) return false

  const all = norm(heard).split(' ').filter(Boolean)
  if (!all.length) return true

  const mine = new Set(norm(spoken).split(' '))
  const content = all.filter((w) => !STOP.has(w))

  // Nothing distinctive was said at all, so there is no strong evidence either
  // way. Demand a total match before discarding it — the cost of dropping a
  // real question is much higher than the cost of one stray echo getting in.
  if (content.length < 2) {
    if (all.length < 2) return false
    return all.every((w) => mine.has(w))
  }

  let hits = 0
  for (const w of content) if (mine.has(w)) hits++
  return hits / content.length >= 0.6
}
