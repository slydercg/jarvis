import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { execSync } from 'node:child_process'

// Which commit this page is, shown in Settings → About. The first question
// whenever a fix "didn't work" is whether the fix is even running yet.
const version = (() => {
  try {
    return execSync('git log -1 --format="%h %cs"').toString().trim()
  } catch {
    return 'unknown'
  }
})()

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  // VITE_* as usual, plus the three naming settings, which the bridge reads
  // under the same names — so one JARVIS_NAME line renames him everywhere.
  // None of them is a secret; nothing else JARVIS_* reaches the page.
  envPrefix: ['VITE_', 'JARVIS_NAME', 'JARVIS_TAGLINE', 'JARVIS_WAKE_ALIASES'],
  server: {
    // Honour PORT so a second instance can run alongside the first. The bridge
    // only accepts sockets from localhost:5173-5199, so stay inside that range
    // or set JARVIS_ALLOWED_ORIGINS to match.
    port: Number(process.env.PORT) || 5173,
  },
  optimizeDeps: {
    // kokoro-js pulls in `phonemizer`, which carries espeak-ng as inline WASM.
    // Vite's dependency pre-bundler rewrites that initialisation and the
    // language table ends up empty — the symptom is
    // `Invalid language identifier: "en". Should be one of: .` at generate()
    // time, long after the model has loaded successfully. Serving these
    // untouched fixes it.
    //
    // onnxruntime-web (the on-device wake word) finds its WebAssembly next to
    // its own module. Pre-bundled, "next to" is Vite's cache, which does not
    // have it; served as-is from node_modules, it is exactly where expected,
    // from our own origin, at the lockfile's version.
    exclude: ['kokoro-js', 'phonemizer', '@huggingface/transformers', 'onnxruntime-web'],
  },
})
