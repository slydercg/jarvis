import { useRef, useState } from 'react'
import { useStore } from '../store'
import { NAME } from '../lib/identity'

/**
 * The typed way in.
 *
 * Voice is the point, but not always possible: in a meeting, on a call, in a
 * quiet office, or for anyone who cannot or would rather not speak. This is the
 * same turn as a spoken one — App listens for COMMAND_EVENT and runs it through
 * the exact path a transcript takes — so nothing typed behaves differently from
 * something said. It is also the accessible entry point: a labelled text field
 * a keyboard or screen reader can reach.
 *
 * Every global shortcut (Space, V, G, T, D, Escape…) already ignores keys typed
 * into an input, so typing here never fires them.
 */
export const COMMAND_EVENT = 'jarvis:command'

export function CommandBar() {
  const phase = useStore((s) => s.phase)
  const [value, setValue] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const ready = phase !== 'offline' && phase !== 'boot'

  const submit = () => {
    const text = value.trim()
    if (!text || !ready) return
    window.dispatchEvent(new CustomEvent(COMMAND_EVENT, { detail: text }))
    setValue('')
  }

  return (
    <form
      className="command"
      role="search"
      aria-label={`Type a command for ${NAME}`}
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <input
        ref={input}
        className="command-input"
        type="text"
        value={value}
        disabled={!ready}
        placeholder={`Type a command, or say “Hey ${NAME}”`}
        aria-label="Command"
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          // Escape leaves the field rather than being swallowed by it, so the
          // global Escape (stand down) is one more press away, not unreachable.
          if (e.key === 'Escape') input.current?.blur()
        }}
      />
      <button className="command-send" type="submit" disabled={!ready || !value.trim()}>
        Enter
      </button>
    </form>
  )
}
