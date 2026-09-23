import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { WORDMARK } from './lib/identity'
import { applyDisplay } from './lib/prefs'

// index.html carries the default; the configured name replaces it on load.
document.title = WORDMARK
// Before the first paint, so the page never flashes the other look.
applyDisplay()

// Deliberately no StrictMode: its double-invoked effects would open the
// microphone and arm the wake-word engine twice, and the second subscription
// steals the audio stream from the first.
createRoot(document.getElementById('root')!).render(<App />)
