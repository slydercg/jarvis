import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { BRIDGE_HTTP_URL } from '../config'
import { useStore } from '../store'
import { probeCapabilities } from '../lib/capabilities'
import { applyDisplay, prefs, setPrefs, type ReadMode, type TextSize, type VoiceEngine } from '../lib/prefs'
import {
  currentVoiceName,
  previewVoice,
  setSystemVoice,
  systemVoiceName,
  systemVoices,
} from '../lib/tts'
import { NAME } from '../lib/identity'

/**
 * Settings, in the interface rather than in a file.
 *
 * Opened with the gear at the bottom right or the comma key. Voice: which
 * engine speaks, the ElevenLabs key (checked with ElevenLabs before it is
 * saved, and never shown back), and which voice. Listening: how long he keeps
 * listening after an answer. Display: the Clear or Cinematic look and the
 * text size. About: which version is actually running, which
 * is the first question whenever a fix "didn't work".
 *
 * He stands down while this is open, so a preview is never heard as a question.
 */

type Voice = { id: string; name: string; category: string; accent: string; gender: string }
type BridgeSettings = {
  version: string
  eleven: { configured: boolean; source: string | null; voiceId: string }
}

const api = (path: string, init?: RequestInit) => fetch(`${BRIDGE_HTTP_URL}${path}`, init)

export function SettingsButton() {
  const open = useStore((s) => s.settingsOpen)
  const setOpen = useStore((s) => s.setSettingsOpen)
  return (
    <button
      type="button"
      className="settings-btn"
      aria-label="Settings"
      aria-expanded={open}
      title="Settings ( , )"
      onClick={() => setOpen(true)}
    >
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
        <path
          fill="currentColor"
          d="M19.4 13a7.5 7.5 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7.6 7.6 0 0 0-1.7-1L15 3.3h-4l-.4 2.6a7.6 7.6 0 0 0-1.7 1l-2.5-1-2 3.5L6.6 11a7.5 7.5 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1a7.6 7.6 0 0 0 1.7 1l.4 2.6h4l.4-2.6a7.6 7.6 0 0 0 1.7-1l2.5 1 2-3.5ZM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7Z"
          transform="translate(-1 0)"
        />
      </svg>
      <span>Settings</span>
    </button>
  )
}

export function Settings() {
  const open = useStore((s) => s.settingsOpen)
  const setOpen = useStore((s) => s.setSettingsOpen)
  const setVoiceLabel = useStore((s) => s.setVoice)
  const dialog = useRef<HTMLDivElement>(null)

  const [bridge, setBridge] = useState<BridgeSettings | null>(null)
  const [bridgeDown, setBridgeDown] = useState(false)
  const [engine, setEngine] = useState<VoiceEngine>(prefs().voiceEngine)
  const [keyInput, setKeyInput] = useState('')
  const [keyBusy, setKeyBusy] = useState(false)
  const [keyMsg, setKeyMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [voices, setVoices] = useState<Voice[]>([])
  const [voiceId, setVoiceId] = useState('')
  const [macVoice, setMacVoice] = useState(systemVoiceName())
  const [followUp, setFollowUp] = useState<number>(prefs().followUpSeconds ?? 6)
  const [readMode, setReadMode] = useState<ReadMode>(prefs().readMode)
  const [textSize, setTextSize] = useState<TextSize>(prefs().textSize)
  const chooseDisplay = (patch: { readMode?: ReadMode; textSize?: TextSize }) => {
    const next = setPrefs(patch)
    setReadMode(next.readMode)
    setTextSize(next.textSize)
    applyDisplay(next)
  }
  const [needsReload, setNeedsReload] = useState(false)

  const configured = Boolean(bridge?.eleven.configured)
  const effective: 'elevenlabs' | 'system' =
    engine === 'system' ? 'system' : engine === 'elevenlabs' || configured ? 'elevenlabs' : 'system'

  const loadVoices = async () => {
    try {
      const r = await api('/voices')
      const data = (await r.json()) as { voices: Voice[]; current?: string }
      setVoices(data.voices ?? [])
      if (data.current) setVoiceId(data.current)
    } catch {
      setVoices([])
    }
  }

  const load = async () => {
    try {
      const r = await api('/settings')
      const data = (await r.json()) as BridgeSettings
      setBridge(data)
      setBridgeDown(false)
      setVoiceId(data.eleven.voiceId)
      if (data.eleven.configured) void loadVoices()
    } catch {
      setBridgeDown(true)
    }
  }

  useEffect(() => {
    if (!open) return
    setKeyMsg(null)
    setKeyInput('')
    setMacVoice(systemVoiceName())
    void load()
    // Focus the panel so Escape and Tab work straight away.
    requestAnimationFrame(() => dialog.current?.querySelector<HTMLElement>('button, select, input')?.focus())
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // `load` is recreated each render; it only needs to run when the panel opens.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [open, setOpen])

  const chooseEngine = (next: VoiceEngine) => {
    setEngine(next)
    setPrefs({ voiceEngine: next })
    setVoiceLabel(currentVoiceName())
  }

  const saveKey = async () => {
    const key = keyInput.trim()
    if (!key) return
    setKeyBusy(true)
    setKeyMsg(null)
    try {
      const r = await api('/settings/eleven-key', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key }),
      })
      const data = (await r.json()) as { ok: boolean; reason?: string; note?: string | null; voices?: Voice[] | null }
      if (!data.ok) {
        setKeyMsg({ ok: false, text: data.reason ?? 'That key was not accepted.' })
        return
      }
      setKeyInput('')
      setKeyMsg({ ok: true, text: data.note ?? 'Saved. He speaks with ElevenLabs from now on.' })
      if (data.voices) setVoices(data.voices)
      await probeCapabilities()
      if (engine === 'system') chooseEngine('auto')
      setVoiceLabel(currentVoiceName())
      // Speaking switches now; listening picks its engine when the page loads.
      setNeedsReload(true)
      await load()
    } catch {
      setKeyMsg({ ok: false, text: "Couldn't reach the bridge." })
    } finally {
      setKeyBusy(false)
    }
  }

  const removeKey = async () => {
    try {
      await api('/settings/eleven-key', { method: 'DELETE' })
      await probeCapabilities()
      setVoiceLabel(currentVoiceName())
      setVoices([])
      setKeyMsg({ ok: true, text: 'Key removed from .env.local.' })
      setNeedsReload(true)
      await load()
    } catch {
      setKeyMsg({ ok: false, text: "Couldn't reach the bridge." })
    }
  }

  const chooseVoice = async (id: string) => {
    setVoiceId(id)
    await api('/settings/voice', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ voiceId: id }),
    }).catch(() => {})
  }

  const chooseMacVoice = (name: string) => {
    setMacVoice(name)
    setSystemVoice(name)
    setVoiceLabel(currentVoiceName())
  }

  const chooseFollowUp = (n: number) => {
    setFollowUp(n)
    setPrefs({ followUpSeconds: n })
  }

  const wakeWord =
    ((window as unknown as { __voice?: { wakeWord?: string } }).__voice?.wakeWord as string | undefined) ?? '—'
  const macList = open ? systemVoices() : []

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="settings"
          className="settings-scrim"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setOpen(false)
          }}
        >
          <div
            ref={dialog}
            className="settings"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-title"
          >
            <div className="settings-head">
              <h2 id="settings-title">Settings</h2>
              <button type="button" className="settings-close" aria-label="Close settings" onClick={() => setOpen(false)}>
                ×
              </button>
            </div>

            {bridgeDown && (
              <p className="settings-warn" role="status">
                The bridge isn't running, so voice settings can't be changed. Run npm run autostart:restart.
              </p>
            )}

            <section aria-labelledby="set-voice">
              <h3 id="set-voice">Voice</h3>

              <div className="settings-seg" role="radiogroup" aria-label="Speaking voice">
                {(
                  [
                    ['elevenlabs', 'ElevenLabs'],
                    ['system', 'Mac voice'],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={effective === value}
                    className={effective === value ? 'on' : ''}
                    onClick={() => chooseEngine(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {effective === 'elevenlabs' && (
                <div className="settings-block">
                  <div className="settings-row">
                    <span className="settings-label">ElevenLabs key</span>
                    <span className={configured ? 'settings-ok' : 'settings-warn-inline'}>
                      {configured ? `connected · from ${bridge?.eleven.source}` : 'not set up'}
                    </span>
                  </div>
                  <form
                    className="settings-key"
                    onSubmit={(e) => {
                      e.preventDefault()
                      void saveKey()
                    }}
                  >
                    <label className="sr-only" htmlFor="eleven-key">
                      ElevenLabs API key
                    </label>
                    <input
                      id="eleven-key"
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      placeholder={configured ? 'Paste a new key to replace it' : 'Paste your ElevenLabs API key'}
                      value={keyInput}
                      onChange={(e) => setKeyInput(e.target.value)}
                    />
                    <button type="submit" disabled={keyBusy || !keyInput.trim()}>
                      {keyBusy ? 'Checking…' : 'Save'}
                    </button>
                  </form>
                  <p className="settings-hint">
                    elevenlabs.io → Developers → API Keys. Give it Text to Speech, Speech to Text and
                    Voices (read). It's checked with ElevenLabs, then saved to .env.local on this Mac.
                  </p>
                  {keyMsg && (
                    <p className={keyMsg.ok ? 'settings-ok' : 'settings-warn-inline'} role="status">
                      {keyMsg.text}
                    </p>
                  )}
                  {configured && bridge?.eleven.source === '.env.local' && (
                    <button type="button" className="settings-link" onClick={() => void removeKey()}>
                      Remove key
                    </button>
                  )}

                  {configured && (
                    <div className="settings-row settings-pick">
                      <label className="settings-label" htmlFor="eleven-voice">
                        Voice
                      </label>
                      <select
                        id="eleven-voice"
                        value={voiceId}
                        onChange={(e) => void chooseVoice(e.target.value)}
                      >
                        {!voices.some((v) => v.id === voiceId) && <option value={voiceId}>Current voice</option>}
                        {voices.map((v) => (
                          <option key={v.id} value={v.id}>
                            {v.name}
                            {[v.gender, v.accent].filter(Boolean).length
                              ? ` — ${[v.gender, v.accent].filter(Boolean).join(', ')}`
                              : ''}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={() => void previewVoice({ engine: 'elevenlabs', voiceId })}
                      >
                        Preview
                      </button>
                    </div>
                  )}
                </div>
              )}

              {effective === 'system' && (
                <div className="settings-block">
                  <div className="settings-row settings-pick">
                    <label className="settings-label" htmlFor="mac-voice">
                      Voice
                    </label>
                    <select id="mac-voice" value={macVoice} onChange={(e) => chooseMacVoice(e.target.value)}>
                      {macList.map((v) => (
                        <option key={v.name} value={v.name}>
                          {v.name.replace(/\(.*?\)/g, '').trim()} — {v.lang}
                        </option>
                      ))}
                    </select>
                    <button type="button" onClick={() => void previewVoice({ engine: 'system', name: macVoice })}>
                      Preview
                    </button>
                  </div>
                  <p className="settings-hint">
                    The Mac's own voices are free and instant. ElevenLabs sounds far more natural, and
                    because it plays through the page, the browser can also cancel its echo.
                  </p>
                </div>
              )}
            </section>

            <section aria-labelledby="set-listen">
              <h3 id="set-listen">Listening</h3>
              <div className="settings-row settings-pick">
                <label className="settings-label" htmlFor="follow-up">
                  Keep listening after an answer
                </label>
                <input
                  id="follow-up"
                  type="range"
                  min={0}
                  max={15}
                  step={1}
                  value={followUp}
                  onChange={(e) => chooseFollowUp(Number(e.target.value))}
                  aria-valuetext={followUp === 0 ? 'off' : `${followUp} seconds`}
                />
                <span className="settings-value">{followUp === 0 ? 'off' : `${followUp}s`}</span>
              </div>
              <p className="settings-hint">
                {followUp === 0
                  ? `Every question starts with "hey ${NAME}". Best in a busy room.`
                  : `For ${followUp} seconds after he answers, carry on without saying his name.`}
              </p>
              <div className="settings-row">
                <span className="settings-label">Wake word</span>
                <span className="settings-value">{wakeWord}</span>
              </div>
            </section>

            <section aria-labelledby="set-display">
              <h3 id="set-display">Display</h3>
              <div className="settings-seg" role="radiogroup" aria-label="Conversation look">
                {(
                  [
                    ['clear', 'Clear'],
                    ['cinematic', 'Cinematic'],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={readMode === value}
                    className={readMode === value ? 'on' : ''}
                    onClick={() => chooseDisplay({ readMode: value })}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <p className="settings-hint">
                Clear puts the conversation on a solid panel in an easy-reading font and dims the reactor
                behind it. Cinematic is the original look.
              </p>
              <div className="settings-seg" role="radiogroup" aria-label="Text size">
                {(
                  [
                    ['normal', 'Normal text'],
                    ['large', 'Large text'],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={textSize === value}
                    className={textSize === value ? 'on' : ''}
                    onClick={() => chooseDisplay({ textSize: value })}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </section>

            <section aria-labelledby="set-about">
              <h3 id="set-about">About</h3>
              <div className="settings-row">
                <span className="settings-label">Running version</span>
                <span className="settings-value">{bridge?.version ?? '—'}</span>
              </div>
              <div className="settings-row">
                <span className="settings-label">Page version</span>
                <span className="settings-value">{__APP_VERSION__}</span>
              </div>
            </section>

            {needsReload && (
              <div className="settings-reload" role="status">
                <span>Reload to use the new key for listening too.</span>
                <button type="button" onClick={() => location.reload()}>
                  Reload
                </button>
              </div>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
