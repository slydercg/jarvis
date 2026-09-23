import { BuiltInKeyword, PorcupineWorker, type PorcupineKeyword } from '@picovoice/porcupine-web'
import { WebVoiceProcessor } from '@picovoice/web-voice-processor'
import { env } from '../config'
import { NAME } from './identity'

/**
 * The wake word, heard on this machine.
 *
 * Without it, "Jarvis" is found by transcribing everything the microphone
 * picks up while he is asleep and searching the text for his name. That works,
 * but every sentence spoken in the room goes off to be transcribed — to Google
 * with the browser's recogniser, or to ElevenLabs (and billed) with Scribe —
 * and anything that transcribes as "Jarvis" wakes him: "travis", "service".
 *
 * Porcupine listens for the sound of the word itself, in WebAssembly, in the
 * page. Nothing leaves the machine until he is awake, it does not cost a
 * transcription per sentence, and it is far harder to fool. It needs a free
 * AccessKey from console.picovoice.ai (VITE_PICOVOICE_ACCESS_KEY in
 * .env.local); without one, the text search carries on exactly as before.
 *
 * "Jarvis" is one of Porcupine's built-in words, as are a few others (Computer,
 * Terminator, Bumblebee…), so a matching JARVIS_NAME needs nothing more. Any
 * other name needs a keyword file trained for it at console.picovoice.ai, put
 * in public/ and named with VITE_WAKE_KEYWORD_FILE.
 */

export type WakeWord = { stop: () => void }

/** The model every keyword runs on, served from public/ at a pinned version. */
const MODEL = {
  publicPath: '/porcupine/porcupine_params.pv',
  customWritePath: 'jarvis_porcupine_params',
  // Bump when the file in public/ changes, so a cached copy is replaced.
  version: 1,
}

/** Why the on-device word is not in use, for the diagnostics panel. '' when it is. */
export let wakeWordStatus = 'not started'

function sensitivity(): number {
  const n = Number(import.meta.env.VITE_WAKE_SENSITIVITY)
  // Higher catches more quiet or accented "Jarvis"es and more false alarms.
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : 0.6
}

/** The keyword for the configured name, or a reason there is none. */
function keyword(): PorcupineKeyword | string {
  const file = (import.meta.env.VITE_WAKE_KEYWORD_FILE as string | undefined)?.trim()
  if (file) {
    return {
      publicPath: file.startsWith('/') ? file : `/${file}`,
      label: NAME,
      sensitivity: sensitivity(),
      customWritePath: `jarvis_keyword_${file.replace(/\W+/g, '_')}`,
      version: 1,
    }
  }
  const builtin = Object.values(BuiltInKeyword).find((k) => k.toLowerCase() === NAME.toLowerCase())
  if (builtin) return { builtin, sensitivity: sensitivity() }
  return (
    `"${NAME}" is not one of Porcupine's built-in words; train one at ` +
    'console.picovoice.ai and set VITE_WAKE_KEYWORD_FILE'
  )
}

/**
 * Start listening for his name. Resolves to null — and the caller keeps the
 * text search — when there is no key, no keyword for the name, or Porcupine
 * will not start (a bad or expired key says so in the console and in
 * `wakeWordStatus`).
 */
export async function startWakeWord(onDetect: () => void): Promise<WakeWord | null> {
  if (import.meta.env.VITE_WAKE_ENGINE === 'speech') {
    wakeWordStatus = 'off (VITE_WAKE_ENGINE=speech)'
    return null
  }
  if (!env.porcupineKey) {
    wakeWordStatus = 'off (no VITE_PICOVOICE_ACCESS_KEY)'
    return null
  }
  const kw = keyword()
  if (typeof kw === 'string') {
    wakeWordStatus = `off (${kw})`
    console.warn(`[wake] ${kw}; using speech recognition for the wake word`)
    return null
  }

  let worker: PorcupineWorker | null = null
  try {
    worker = await PorcupineWorker.create(env.porcupineKey, [kw], () => onDetect(), MODEL, {
      processErrorCallback: (err) => {
        wakeWordStatus = `error: ${err.message}`
        console.warn(`[wake] ${err.message}`)
      },
    })
    await WebVoiceProcessor.subscribe(worker)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    wakeWordStatus = `off (${message.split('\n')[0]})`
    console.warn(`[wake] on-device wake word unavailable, using speech recognition: ${message}`)
    try {
      worker?.terminate()
    } catch {
      // Never started.
    }
    return null
  }

  wakeWordStatus = ''
  console.log(`[wake] listening for "${NAME}" on this device`)
  return {
    stop: () => {
      if (!worker) return
      const w = worker
      worker = null
      void WebVoiceProcessor.unsubscribe(w).finally(() => w.terminate())
    },
  }
}
