openWakeWord models, unmodified, from
https://github.com/dscripka/openWakeWord/releases/tag/v0.5.1

| File | Licence | sha256 |
|---|---|---|
| `melspectrogram.onnx` | Apache-2.0 (feature models, from Google's speech_embedding) | `ba2b0e0f8b7b875369a2c89cb13360ff53bac436f2895cced9f479fa65eb176f` |
| `embedding_model.onnx` | Apache-2.0 (feature models, from Google's speech_embedding) | `70d164290c1d095d1d4ee149bc5e00543250a7316b59f31d056cff7bd3075c1f` |
| `hey_jarvis_v0.1.onnx` | **CC BY-NC-SA 4.0: personal, non-commercial use only** | `94a13cfe60075b132f6a472e7e462e8123ee70861bc3fb58434a73712ee0d2cb` |

`capture.js` is this project's AudioWorklet that feeds them 80 ms chunks.
Checked against the Python `openwakeword` package on the same recordings: the
page's pipeline (src/lib/owwCore.ts) gives the same scores.
