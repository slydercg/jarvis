/**
 * Preferences set in the settings panel that belong to this browser: which
 * engine speaks, and how long he listens after answering. Anything the bridge
 * needs (the ElevenLabs key and voice) lives on the bridge instead.
 *
 * Browser storage can be unavailable or cleared; every read falls back to the
 * defaults, so the page behaves exactly as before when nothing is saved.
 */

/** 'auto' is ElevenLabs when a key is set, else the Mac's own voice. */
export type VoiceEngine = 'auto' | 'elevenlabs' | 'system'

/**
 * How the conversation reads. 'clear' puts the transcript on a solid backing
 * in a plain reading face and quiets the reactor behind it; 'cinematic' is the
 * original look, text floating straight on the scene.
 */
export type ReadMode = 'clear' | 'cinematic'
export type TextSize = 'normal' | 'large'

export type Prefs = {
  voiceEngine: VoiceEngine
  /** null = the VITE_FOLLOW_UP_SECONDS default. */
  followUpSeconds: number | null
  readMode: ReadMode
  textSize: TextSize
}

const KEY = 'jarvis.prefs'
const DEFAULTS: Prefs = { voiceEngine: 'auto', followUpSeconds: null, readMode: 'clear', textSize: 'normal' }

export function prefs(): Prefs {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Prefs>
    return { ...DEFAULTS, ...saved }
  } catch {
    return DEFAULTS
  }
}

export function setPrefs(patch: Partial<Prefs>): Prefs {
  const next = { ...prefs(), ...patch }
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    // Not saved; it still applies until the page reloads.
  }
  return next
}

/** Put the display prefs on <html>, where the stylesheet reads them. */
export function applyDisplay(p: Pick<Prefs, 'readMode' | 'textSize'> = prefs()): void {
  const root = document.documentElement
  root.dataset.read = p.readMode
  root.dataset.size = p.textSize
}
