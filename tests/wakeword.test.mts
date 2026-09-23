import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as ort from 'onnxruntime-web/wasm'
import { createDetector, CHUNK } from '../src/lib/owwCore.ts'

// The page's openWakeWord pipeline, on recorded speech. Same models as the page.
ort.env.wasm.numThreads = 1
const model = (f: string) => ort.InferenceSession.create(readFileSync(new URL(`../public/oww/${f}`, import.meta.url)))

async function maxScore(wav: string) {
  const d = await createDetector(
    await model('melspectrogram.onnx'),
    await model('embedding_model.onnx'),
    await model('hey_jarvis_v0.1.onnx'),
  )
  const buf = readFileSync(new URL(`./fixtures/${wav}`, import.meta.url))
  const pcm = new Int16Array(buf.buffer, buf.byteOffset + 44, (buf.length - 44) / 2)
  let best = 0
  for (let i = 0; i + CHUNK <= pcm.length; i += CHUNK) {
    const s = await d.step(Float32Array.from(pcm.subarray(i, i + CHUNK)))
    if (s !== null && s > best) best = s
  }
  return best
}

test('"hey Jarvis" wakes him', async () => {
  assert.ok((await maxScore('hey-jarvis.wav')) > 0.9)
})

test('a sentence with sound-alikes does not', async () => {
  assert.ok((await maxScore('not-jarvis.wav')) < 0.1)
})
