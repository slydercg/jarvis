/**
 * What he is called — one setting, read everywhere the name appears.
 *
 *   JARVIS_NAME=Friday                in .env.local (or the shell)
 *   JARVIS_WAKE_ALIASES=fridey,frida  ways the recogniser mishears it
 *   JARVIS_TAGLINE=...                the line under the wordmark
 *
 * The bridge reads the same JARVIS_NAME for the persona (bridge/env.mjs loads
 * .env.local for it), and vite.config.ts exposes exactly these three to the
 * page, so one line renames the wake word, the wordmark, the tab title, the
 * transcript and the way he refers to himself. Nothing here is a secret.
 */

const env = import.meta.env as Record<string, string | undefined>
const clean = (v: string | undefined) => (v ?? '').trim()

/** As the user wrote it: "Jarvis", "Friday", "My Dude". */
export const NAME = clean(env.JARVIS_NAME) || 'Jarvis'

const isDefault = NAME.toLowerCase() === 'jarvis'

/**
 * The HUD wordmark. A single word is dotted out like the original
 * (J.A.R.V.I.S., F.R.I.D.A.Y.); a name of several words is set in capitals
 * as it is, because "M.Y. D.U.D.E." reads as an accident.
 */
export const WORDMARK = /\s/.test(NAME)
  ? NAME.toUpperCase()
  : `${NAME.toUpperCase().split('').join('.')}.`

/** The backronym only makes sense for Jarvis; any other name gets none unless set. */
export const TAGLINE =
  env.JARVIS_TAGLINE !== undefined
    ? clean(env.JARVIS_TAGLINE)
    : isDefault
      ? 'Just A Rather Very Intelligent System'
      : ''

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** "my dude" -> `my[\s-]*dude`, so "my-dude", "mydude" and "my  dude" all match. */
const flexible = (phrase: string) =>
  phrase
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map(escape)
    .join('[\\s-]*')

/**
 * The name as a regex fragment, mishearings included.
 *
 * Jarvis keeps its hand-tuned list: Chrome routinely hears Travis, Jervis,
 * Jarvys or Java's for a perfectly clear "Jarvis". Any other name gets its own
 * spelling plus whatever JARVIS_WAKE_ALIASES lists — watch the diagnostics
 * panel (D) for what the recogniser actually hears, and add those.
 */
export const NAME_PATTERN = isDefault
  ? "(?:jarvis|jarvys|jervis|jarvis's|travis|jarviss|java's|jarv)"
  : `(?:${[NAME, ...clean(env.JARVIS_WAKE_ALIASES).split(',')]
      .map((s) => s.trim())
      .filter(Boolean)
      .map(flexible)
      .join('|')})`
