/// <reference lib="webworker" />
import * as ort from 'onnxruntime-web/wasm'
import { createDetector, type Detector } from './owwCore'

/**
 * openWakeWord in a worker, so the reactor's animation never waits on it.
 * The pipeline itself is in owwCore.ts; this only loads the models and feeds
 * it audio in order.
 */

type Init = { type: 'init'; base: string; wakeModel: string; threshold: number }
type Audio = { type: 'audio'; samples: Float32Array }

let detector: Detector | null = null
let threshold = 0.5
let busy = false
const queue: Float32Array[] = []

const post = (msg: unknown) => (self as unknown as Worker).postMessage(msg)
const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

async function init({ base, wakeModel, threshold: t }: Init) {
  threshold = t
  // No cross-origin isolation on this page, so no SharedArrayBuffer: one thread.
  ort.env.wasm.numThreads = 1
  const opts: ort.InferenceSession.SessionOptions = { executionProviders: ['wasm'] }
  const [mel, embed, wake] = await Promise.all([
    ort.InferenceSession.create(`${base}oww/melspectrogram.onnx`, opts),
    ort.InferenceSession.create(`${base}oww/embedding_model.onnx`, opts),
    ort.InferenceSession.create(wakeModel, opts),
  ])
  detector = await createDetector(mel, embed, wake)
  post({ type: 'ready' })
}

/** One chunk at a time, in order; the models are not re-entrant. */
async function drain() {
  if (busy || !detector) return
  busy = true
  try {
    while (queue.length) {
      const score = await detector.step(queue.shift()!)
      if (score !== null && score >= threshold) post({ type: 'wake', score })
    }
  } catch (err) {
    post({ type: 'error', message: message(err) })
  } finally {
    busy = false
  }
}

self.onmessage = (e: MessageEvent<Init | Audio>) => {
  const msg = e.data
  if (msg.type === 'init') {
    init(msg).catch((err) => post({ type: 'error', message: message(err) }))
  } else if (msg.type === 'audio' && detector) {
    // If the machine falls behind, drop the oldest audio rather than lag
    // further and further behind what is being said.
    if (queue.length > 12) queue.splice(0, queue.length - 12)
    queue.push(msg.samples)
    void drain()
  }
}
