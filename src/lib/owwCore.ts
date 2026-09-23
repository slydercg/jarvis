import * as ort from 'onnxruntime-web/wasm'

/**
 * openWakeWord's streaming pipeline, with no browser in it, so the worker and
 * a Node check against the Python reference run exactly the same code.
 *
 *   80 ms of 16 kHz audio (1280 samples, int16-scaled floats)
 *     -> melspectrogram.onnx over the last 1760 samples -> mel frames of 32,
 *        scaled x/10 + 2 as the reference does
 *     -> embedding_model.onnx over the last 76 mel frames -> one 96-d feature
 *     -> the wake model over the last 16 features -> a score from 0 to 1
 */

export const CHUNK = 1280
const MEL_CONTEXT = CHUNK + 160 * 3
const MEL_WINDOW = 76
const FEATURES = 16
/** The reference reports nothing while its buffers still hold padding; this
 *  waits until every input the wake model sees is real audio (2 s). */
const WARMUP_CHUNKS = 25

export type Detector = { step: (samples: Float32Array) => Promise<number | null> }

export async function createDetector(
  mel: ort.InferenceSession,
  embed: ort.InferenceSession,
  wake: ort.InferenceSession,
): Promise<Detector> {
  let raw = new Float32Array(0)
  // The reference starts its mel buffer as ones; so does this.
  const melFrames: Float32Array[] = Array.from({ length: MEL_WINDOW }, () => new Float32Array(32).fill(1))
  const features: Float32Array[] = []
  let chunks = 0

  const step = async (samples: Float32Array): Promise<number | null> => {
    // Keep just enough history for the mel model's context.
    const joined = new Float32Array(raw.length + samples.length)
    joined.set(raw)
    joined.set(samples, raw.length)
    raw = joined.slice(-MEL_CONTEXT)

    // 1. Mel frames for the newest audio.
    const melOut = await mel.run({ [mel.inputNames[0]]: new ort.Tensor('float32', raw, [1, raw.length]) })
    const data = melOut[mel.outputNames[0]].data as Float32Array
    for (let f = 0; f < data.length / 32; f++) {
      const frame = new Float32Array(32)
      for (let j = 0; j < 32; j++) frame[j] = data[f * 32 + j] / 10 + 2
      melFrames.push(frame)
    }
    if (melFrames.length > MEL_WINDOW * 2) melFrames.splice(0, melFrames.length - MEL_WINDOW * 2)

    // 2. One embedding from the last 76 frames.
    const window = new Float32Array(MEL_WINDOW * 32)
    melFrames.slice(-MEL_WINDOW).forEach((fr, i) => window.set(fr, i * 32))
    const embOut = await embed.run({
      [embed.inputNames[0]]: new ort.Tensor('float32', window, [1, MEL_WINDOW, 32, 1]),
    })
    features.push(Float32Array.from(embOut[embed.outputNames[0]].data as Float32Array))
    if (features.length > FEATURES) features.shift()

    // 3. The wake score over the last 16 embeddings.
    chunks++
    if (features.length < FEATURES || chunks < WARMUP_CHUNKS) return null
    const feats = new Float32Array(FEATURES * 96)
    features.forEach((f, i) => feats.set(f, i * 96))
    const out = await wake.run({ [wake.inputNames[0]]: new ort.Tensor('float32', feats, [1, FEATURES, 96]) })
    return (out[wake.outputNames[0]].data as Float32Array)[0]
  }

  return { step }
}
