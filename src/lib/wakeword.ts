import { BuiltInKeyword, PorcupineWorker, type PorcupineKeyword } from '@picovoice/porcupine-web'
import { WebVoiceProcessor } from '@picovoice/web-voice-processor'
import { env } from '../config'
import { getMic } from './audio'
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
 * On-device, the sound of the phrase itself is recognised in the page, in
 * WebAssembly. Nothing leaves the machine until he is awake, nothing is
 * billed while he sleeps, and it is far harder to fool. Two engines, tried in
 * this order:
 *
 *   Porcupine, when VITE_PICOVOICE_ACCESS_KEY is set. Answers to plain
 *     "Jarvis". Picovoice now reviews each sign-up, so a key is not a given.
 *   openWakeWord, with no key or account at all. Answers to "hey Jarvis" —
 *     the phrase its open model was trained on. The model is licensed for
 *     personal, non-commercial use (CC BY-NC-SA 4.0).
 *
 * If neither can start, the text search carries on exactly as before, so he
 * can always be woken. VITE_WAKE_ENGINE=speech skips both.
 */

export type WakeWord = { stop: () => void }

/** What is listening for his name, or why nothing on-device is. For diagnostics. */
export let wakeWordStatus = 'not started'

const BASE = import.meta.env.BASE_URL

function sensitivity(fallback: number): number {
  const n = Number(import.meta.env.VITE_WAKE_SENSITIVITY)
  // Higher catches quieter or accented wake words, and false-triggers more.
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : fallback
}

const isJarvis = () => NAME.toLowerCase() === 'jarvis'

export async function startWakeWord(onDetect: () => void): Promise<WakeWord | null> {
  if (import.meta.env.VITE_WAKE_ENGINE === 'speech') {
    wakeWordStatus = 'off (VITE_WAKE_ENGINE=speech)'
    return null
  }
  const reasons: string[] = []
  if (env.porcupineKey) {
    const p = await startPorcupine(onDetect, reasons)
    if (p) return p
  }
  const o = await startOpenWakeWord(onDetect, reasons)
  if (o) return o
  wakeWordStatus = `speech recognition (${reasons.join('; ')})`
  return null
}

// ---------------------------------------------------------------------------
// Porcupine
// ---------------------------------------------------------------------------

async function startPorcupine(onDetect: () => void, reasons: string[]): Promise<WakeWord | null> {
  const file = (import.meta.env.VITE_WAKE_KEYWORD_FILE as string | undefined)?.trim()
  let kw: PorcupineKeyword
  if (file) {
    kw = {
      publicPath: file.startsWith('/') ? file : `/${file}`,
      label: NAME,
      sensitivity: sensitivity(0.6),
      customWritePath: `jarvis_keyword_${file.replace(/\W+/g, '_')}`,
      version: 1,
    }
  } else {
    const builtin = Object.values(BuiltInKeyword).find((k) => k.toLowerCase() === NAME.toLowerCase())
    if (!builtin) {
      reasons.push(`Porcupine has no built-in "${NAME}"; set VITE_WAKE_KEYWORD_FILE`)
      return null
    }
    kw = { builtin, sensitivity: sensitivity(0.6) }
  }

  let worker: PorcupineWorker | null = null
  try {
    worker = await PorcupineWorker.create(
      env.porcupineKey,
      [kw],
      () => onDetect(),
      // The model every keyword runs on, served from public/ at a pinned
      // version; bump `version` when the file changes so a cached copy goes.
      { publicPath: `${BASE}porcupine/porcupine_params.pv`, customWritePath: 'jarvis_porcupine_params', version: 1 },
      {
        processErrorCallback: (err) => {
          wakeWordStatus = `Porcupine error: ${err.message}`
          console.warn(`[wake] ${err.message}`)
        },
      },
    )
    await WebVoiceProcessor.subscribe(worker)
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).split('\n')[0]
    reasons.push(`Porcupine: ${message}`)
    console.warn(`[wake] Porcupine unavailable: ${message}`)
    try {
      worker?.terminate()
    } catch {
      // Never started.
    }
    return null
  }

  wakeWordStatus = `on-device (Porcupine, "${NAME}")`
  console.log(`[wake] listening for "${NAME}" on this device (Porcupine)`)
  return {
    stop: () => {
      if (!worker) return
      const w = worker
      worker = null
      void WebVoiceProcessor.unsubscribe(w).finally(() => w.terminate())
    },
  }
}

// ---------------------------------------------------------------------------
// openWakeWord
// ---------------------------------------------------------------------------

/** How long the models may take to load before we give up and use speech. */
const OWW_LOAD_MS = 20_000

async function startOpenWakeWord(onDetect: () => void, reasons: string[]): Promise<WakeWord | null> {
  const custom = (import.meta.env.VITE_WAKE_MODEL as string | undefined)?.trim()
  if (!custom && !isJarvis()) {
    reasons.push(
      `openWakeWord has no "${NAME}" model; train one and set VITE_WAKE_MODEL`,
    )
    return null
  }
  const wakeModel = custom ? (custom.startsWith('/') ? custom : `/${custom}`) : `${BASE}oww/hey_jarvis_v0.1.onnx`
  const phrase = custom ? NAME : 'hey Jarvis'

  let worker: Worker | null = null
  let ctx: AudioContext | null = null
  const stop = () => {
    worker?.terminate()
    worker = null
    void ctx?.close()
    ctx = null
  }

  try {
    worker = new Worker(new URL('./oww.worker.ts', import.meta.url), { type: 'module' })
    const w = worker
    // A score of 0.5 is openWakeWord's own default; sensitivity is its mirror.
    const threshold = 1 - sensitivity(0.5)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('models took too long to load')), OWW_LOAD_MS)
      w.onmessage = (e) => {
        if (e.data?.type === 'ready') {
          clearTimeout(timer)
          resolve()
        } else if (e.data?.type === 'error') {
          clearTimeout(timer)
          reject(new Error(e.data.message))
        }
      }
      w.onerror = (e) => {
        clearTimeout(timer)
        reject(new Error(e.message || 'worker failed to start'))
      }
      w.postMessage({ type: 'init', base: BASE, wakeModel, threshold })
    })

    w.onmessage = (e) => {
      if (e.data?.type === 'wake') onDetect()
      else if (e.data?.type === 'error') {
        wakeWordStatus = `openWakeWord error: ${e.data.message}`
        console.warn(`[wake] ${e.data.message}`)
      }
    }

    // 16 kHz, the rate the models were trained at; the browser resamples the
    // microphone to it. The worklet hands over 80 ms at a time.
    ctx = new AudioContext({ sampleRate: 16000 })
    await ctx.audioWorklet.addModule(`${BASE}oww/capture.js`)
    const source = ctx.createMediaStreamSource(await getMic())
    const node = new AudioWorkletNode(ctx, 'oww-capture')
    node.port.onmessage = (e: MessageEvent<Float32Array>) =>
      worker?.postMessage({ type: 'audio', samples: e.data }, [e.data.buffer])
    // Through a silent gain to the output, so the graph is always pulled.
    const mute = ctx.createGain()
    mute.gain.value = 0
    source.connect(node)
    node.connect(mute)
    mute.connect(ctx.destination)
    await ctx.resume()
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).split('\n')[0]
    reasons.push(`openWakeWord: ${message}`)
    console.warn(`[wake] openWakeWord unavailable: ${message}`)
    stop()
    return null
  }

  wakeWordStatus = `on-device (openWakeWord, "${phrase}")`
  console.log(`[wake] listening for "${phrase}" on this device (openWakeWord)`)
  return { stop }
}
