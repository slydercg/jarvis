import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { WORDMARK } from './lib/identity'

// index.html carries the default; the configured name replaces it on load.
document.title = WORDMARK

// Deliberately no StrictMode: its double-invoked effects would open the
// microphone and arm the wake-word engine twice, and the second subscription
// steals the audio stream from the first.
createRoot(document.getElementById('root')!).render(<App />)
