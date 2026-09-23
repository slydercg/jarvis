import { NAME_PATTERN } from './lib/identity'
import { COMMAND_EVENT } from './ui/CommandBar'
import { useEffect, useRef } from 'react'
import { Scene } from './scene/Scene'
import { Hud } from './ui/Hud'
import { Boot } from './ui/Boot'
import { Ignition } from './ui/Ignition'
import { Diagnostics } from './ui/Diagnostics'
import { Settings, SettingsButton } from './ui/Settings'
import { useStore, UNDO_MS, type Alert } from './store'
import { prefs } from './lib/prefs'
import { startVoice, type Voice, type VoiceMode } from './lib/voice'
import { createSpeaker, cycleVoice, currentVoiceName, speakingSince } from './lib/tts'
import * as sfx from './lib/sfx'
import * as music from './lib/music'
import * as hands from './lib/hands'
import { listenForClap } from './lib/clap'
import * as camera from './lib/camera'
import * as kokoro from './lib/kokoro'
import { TTS_ENGINE } from './config'
import { forTool, attention } from './lib/fillers'
import {
  ask,
  warm,
  interrupt,
  watchServers,
  watchPanels,
  watchBlades,
  watchConfirm,
  watchHistory,
  watchAlerts,
  resetConversation,
  watchCapture,
  watchUi,
  watchConnection,
  connectedLabels,
  usingBridge,
  type Msg,
} from './lib/brain'
import { startAnalyser, micLevel } from './lib/audio'
import { probeCapabilities } from './lib/capabilities'
import { env } from './config'

/**
 * The conversation.
 *
 * This used to be a sequential loop — greet, await a capture, await an answer,
 * repeat — with the microphone opened and closed around each step. That shape
 * cannot be interrupted: while it is awaiting the answer, nothing is listening,
 * so there is no way for the user to get a word in.
 *
 * It is an event machine now. The voice loop runs continuously and pushes
 * events at us; every one of them is legal in every phase. Saying anything at
 * all stops him talking, and whatever you say next becomes the new turn.
 */

/** How long to wait for someone to start speaking after he wakes. Generous:
 *  people say his name and *then* think about what they wanted. */
const AWAIT_SPEECH_MS = 14000

/**
 * After an answer, how long he keeps listening for a follow-up without his
 * name before dropping back to standby.
 *
 * It was 11 s, which in a room with other people in it meant he took whatever
 * anyone said next as a question. Six is enough to carry on a thought.
 * VITE_FOLLOW_UP_SECONDS changes it; 0 means every question starts with
 * "hey Jarvis".
 */
const FOLLOW_UP_DEFAULT_MS = (() => {
  const raw = String(import.meta.env.VITE_FOLLOW_UP_SECONDS ?? '').trim()
  const n = Number(raw)
  return raw && Number.isFinite(n) && n >= 0 ? n * 1000 : 6000
})()
/** The settings panel's choice, else the .env.local default. Read per answer. */
const followUpMs = () => {
  const s = prefs().followUpSeconds
  return s === null ? FOLLOW_UP_DEFAULT_MS : s * 1000
}

/** crypto.randomUUID needs a secure context, which a LAN address over plain
 *  http is not. Not worth failing a whole turn over an id. */
const newId = () =>
  globalThis.crypto?.randomUUID?.() ??
  `id${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`

/** The same mishearings voice.ts accepts for the wake word — otherwise a turn
 *  that woke him as "travis" gets that word sent on to the model as a question. */
const NAME = NAME_PATTERN
/** A bare vocative — "Jarvis", "hey jarvis" — with nothing asked. */
const BARE_NAME = new RegExp(`^(?:hey|hi|ok|okay|yo)?\\s*${NAME}[\\s,.!?]*$`, 'i')
/** A leading vocative on a real command: "Jarvis, what's the weather". */
const LEADING_NAME = new RegExp(`^(?:hey|hi|ok|okay|yo)?\\s*${NAME}\\b[\\s,.:!?-]*`, 'i')

/** Silence this long on a confirmation is a no. */
const CONFIRM_TIMEOUT_MS = 45_000

const YES =
  /^(yes|yeah|yep|yup|sure|ok|okay|do it|go ahead|go for it|confirm(ed)?|proceed|send it|please do|affirmative|correct|absolutely|right)\b/i
const NO =
  /^(no|nope|nah|cancel|stop|undo|don'?t|do not|abort|wait|hold on|never ?mind|negative|scratch that)\b/i

/** "Start fresh", "new conversation", "clear the chat", "start over". */
const FRESH =
  /^(let'?s )?(start (a )?(new|fresh)( conversation| chat)?|new (conversation|chat)|clear (the |this )?(conversation|chat)|start over|fresh start)[.!]?$/i

/** "Mute alerts", "do not disturb" — and the way back. */
const MUTE =
  /^((mute|pause|silence|stop|hold) (the |my )?(alerts|notifications)|do not disturb|don'?t disturb( me)?)[.!]?$/i
const UNMUTE =
  /^((unmute|resume|restart|turn on) (the |my )?(alerts|notifications)|alerts on)[.!]?$/i

/** What he says for an alert. Fronted "Sir": it is an interruption, not an answer. */
function alertLine(a: Alert): string {
  if (a.kind === 'brief') {
    // Offered, not read out: it may land while he is on a call.
    return "Good morning, sir. Your brief is ready when you are — say 'brief me'."
  }
  if (a.kind === 'meeting') {
    const mins = Math.round((a.at - Date.now()) / 60_000)
    const when = mins <= 1 ? 'is starting now' : `starts in ${mins} minutes`
    return `Sir, ${a.title} ${when}.${a.prep?.summary ? ` ${a.prep.summary}` : ''}`
  }
  const subject = a.detail.split(' — ')[0]
  return `Sir, ${a.title} has written${subject ? ` about ${subject}` : ''}. It looks like it needs you.`
}

/** true, false, or null when the reply is neither. "No" wins a tie. */
function yesOrNo(said: string): boolean | null {
  const s = said.replace(/^[\s,.!?-]+/, '')
  if (NO.test(s)) return false
  if (YES.test(s)) return true
  return null
}

/** Resolves once he has stopped talking, or after a few seconds regardless. */
function afterSpeech(maxMs = 8000): Promise<void> {
  const until = Date.now() + maxMs
  return new Promise((resolve) => {
    const check = () => {
      if (speakingSince() === 0 || Date.now() > until) resolve()
      else setTimeout(check, 150)
    }
    check()
  })
}

export default function App() {
  const store = useStore
  const phase = useStore((s) => s.phase)
  const history = useRef<Msg[]>([])
  const speaker = useRef<ReturnType<typeof createSpeaker> | null>(null)
  const voice = useRef<Voice | null>(null)

  /**
   * Monotonic turn counter. Every await in a turn checks it on the way out:
   * if it has moved, that turn was superseded by a barge-in and must not touch
   * the phase, the speaker, or the busy state on its way to the floor.
   */
  const turn = useRef(0)
  const booting = useRef(false)
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const voicePoll = useRef<ReturnType<typeof setInterval> | null>(null)
  /** Set while a "start fresh" reconnect is in flight, so it is not reported as a fault. */
  const resetting = useRef(false)
  /** Turns "reconnecting" into "not running" once the bridge has been gone a while. */
  const offlineTimer = useRef(0)
  /** Ends the boot sequence early. Set only while it is playing. */
  const skipBoot = useRef<(() => void) | null>(null)

  // -- helpers --------------------------------------------------------------

  const clearIdle = () => {
    if (idleTimer.current) clearTimeout(idleTimer.current)
    idleTimer.current = null
  }

  /** A short line of his own, outside any turn's speaker. */
  const say = (line: string) => {
    const p = createSpeaker()
    p.say(line)
    void p.end()
  }

  const silence = () => {
    speaker.current?.cancel()
    speaker.current = null
  }

  const goDormant = () => {
    // Standing down while an action waits on a yes is a no.
    store.getState().confirm?.answer(false)
    clearIdle()
    silence()
    turn.current++
    const s = store.getState()
    s.setCaption('')
    s.setActiveTool(null)
    music.working(false)
    music.duck(false)
    sfx.duck(false)
    s.setPhase('dormant')
  }

  /** Open the mic and wait. `window` is how long before he gives up. */
  const listen = (window: number) => {
    clearIdle()
    const s = store.getState()
    s.setCaption('')
    s.setPhase('listening')
    sfx.play('listen')
    idleTimer.current = setTimeout(goDormant, window)
  }

  // -- one turn -------------------------------------------------------------

  const respond = async (said: string): Promise<void> => {
    const mine = ++turn.current
    const stale = () => mine !== turn.current

    clearIdle()
    const s = store.getState()
    // Last turn's panels and blades go now, before the new answer starts
    // putting its own up. Anything the model marked sticky survives.
    s.clearPanels()
    s.clearBlades()
    s.setCaption('')
    s.pushTurn({ id: newId(), role: 'user', text: said })
    s.setPhase('thinking')

    const spk = createSpeaker()
    speaker.current = spk
    sfx.duck(true)
    music.duck(true)

    const turnId = newId()
    let started = false
    let filled = false

    try {
      const { text, costUsd, tier } = await ask(said, history.current, {
        onText: (delta) => {
          if (stale()) return
          if (!started) {
            started = true
            store.getState().setPhase('speaking')
            // The answer arriving is what ends the tool phase — a timer would
            // clear the readout while a slow tool was still running.
            store.getState().setActiveTool(null)
            music.working(false)
            store.getState().pushTurn({ id: turnId, role: 'jarvis', text: '' })
          }
          // A confirmation in the middle of an answer drops the phase to
          // listening; the words resuming afterwards are speech again.
          if (store.getState().phase !== 'speaking') store.getState().setPhase('speaking')
          store.getState().appendToLastTurn(delta)
          spk.push(delta)
        },
        onTool: (name) => {
          if (stale()) return
          // Only claim the tooling phase while he has nothing to say yet.
          // Setting it unconditionally pinned the machine in 'tooling' for the
          // rest of any answer that called a tool after it started talking,
          // which also broke the reactor's lip-sync for the remainder.
          if (!started) store.getState().setPhase('tooling')
          store.getState().setActiveTool(name)
          sfx.play('tool')
          music.working(true)
          // Say something the moment work starts — a tool can take ten seconds
          // and silence that long reads as a crash. Once per turn only; a
          // chain of five tools shouldn't produce five apologies.
          if (!filled && !started) {
            filled = true
            spk.say(forTool(name))
          }
        },
      })

      if (stale()) return
      if (costUsd != null) store.getState().setUsage(costUsd, tier ?? null)

      // The bridge keeps conversation state in its own session, so history is
      // only threaded through on the direct path.
      if (!usingBridge) {
        history.current.push({ role: 'user', content: said })
        history.current.push({ role: 'assistant', content: text || '…' })
        if (history.current.length > 16) {
          history.current = history.current.slice(-16)
        }
      }

      await spk.end()
      if (stale()) return
      sfx.play('done')
    } catch (err) {
      if (stale()) return
      console.error(err)
      sfx.play('error')
      store
        .getState()
        .setError(err instanceof Error ? err.message : 'Something went wrong.')
      // Say it too, when the bridge wrote it to be said — "not signed in" on a
      // screen nobody is facing reads exactly like being ignored.
      if (err instanceof Error && (err as Error & { spoken?: boolean }).spoken) {
        try {
          spk.say(err.message)
          await spk.end()
        } catch {
          // Speech failing here must not mask the original error.
        }
      }
    } finally {
      if (!stale()) {
        speaker.current = null
        sfx.duck(false)
        music.duck(false)
        store.getState().setActiveTool(null)
        music.working(false)
        // Stay open. Having to say his name again to add one more sentence is
        // the difference between a conversation and a vending machine —
        // unless it has been set to 0, and then that is what was asked for.
        const window = followUpMs()
        if (window > 0) listen(window)
        else goDormant()
      }
    }
  }

  // -- voice events ---------------------------------------------------------

  /** What the voice loop should do with what it hears, derived from phase. */
  const mode = (): VoiceMode => {
    switch (store.getState().phase) {
      case 'offline':
      case 'boot':
        return 'deaf'
      case 'dormant':
        return 'wake'
      case 'waking':
      case 'listening':
        return 'command'
      default:
        return 'guard' // thinking, tooling, speaking
    }
  }

  const onWake = (trailing: string, local = false) => {
    const phase = store.getState().phase
    if (phase === 'offline' || phase === 'boot') return

    store.getState().setError(null)
    sfx.play('wake')

    // "Jarvis, what's happening in AI this week" in one breath. Waiting for a
    // greeting he didn't need is the most common way an assistant wastes time.
    if (trailing) {
      void respond(trailing)
      return
    }

    store.getState().setPhase('waking')

    // The on-device word fires the instant his name is said, before anyone
    // knows whether a question follows. Greeting straight away would talk over
    // "Jarvis, what's the weather", so give it a beat: still talking means the
    // question is on its way and arrives as the next utterance; quiet means it
    // was just his name, and he answers to it.
    if (local) {
      window.setTimeout(() => {
        if (store.getState().phase !== 'waking') return
        if (voice.current?.talking()) {
          listen(AWAIT_SPEECH_MS)
          return
        }
        greet()
      }, 700)
      return
    }
    greet()
  }

  const greet = () => {
    // Answer to his name. Deliberately NOT awaited any more: the microphone is
    // already open and the echo filter knows his voice, so the user can talk
    // straight over the greeting instead of waiting it out.
    const greeting = createSpeaker()
    speaker.current = greeting
    greeting.say(attention())
    void greeting.end()

    listen(AWAIT_SPEECH_MS)
  }

  /**
   * Someone started talking. This is the whole point of the rewrite: he stops,
   * immediately, whatever he was doing.
   */
  const onSpeechStart = () => {
    clearIdle()
    const phase = store.getState().phase
    if (phase === 'offline' || phase === 'boot' || phase === 'dormant') return

    const wasBusy =
      phase === 'thinking' || phase === 'tooling' || phase === 'speaking'

    silence()
    if (wasBusy) {
      // Abandon the answer in flight. The turn counter moves in respond()'s
      // replacement; bumping it here covers the case where nothing replaces it.
      turn.current++
      interrupt()
      store.getState().setActiveTool(null)
      music.working(false)
      sfx.duck(false)
      music.duck(false)
    }
    store.getState().setPhase('listening')
  }

  /**
   * A reply while an action is waiting on the user. Checked before anything
   * else, so "yes" confirms rather than starting a new turn — which would
   * interrupt the very turn that is waiting for it.
   */
  const answerConfirm = (raw: string): boolean => {
    const pending = store.getState().confirm
    if (!pending) return false
    const said = raw.replace(LEADING_NAME, '').trim()
    const verdict = yesOrNo(said)
    if (verdict === null) {
      // Not an answer. Asked again once per stray phrase, only while asking;
      // during the undo window anything but a "no" simply lets it run.
      if (pending.stage === 'ask') say('Yes or no, sir?')
      return true
    }
    pending.answer(verdict)
    return true
  }

  /**
   * "Start fresh". Conversations now survive a reload, so there has to be a
   * way to end one on purpose: the bridge forgets it and reconnects to a new
   * session, and the screen is cleared to match. Lasting notes are kept.
   */
  const startFresh = (raw: string): boolean => {
    if (!usingBridge || !FRESH.test(raw.replace(LEADING_NAME, '').trim())) return false
    resetting.current = true
    turn.current++
    silence()
    const st = store.getState()
    st.setTurns([])
    st.clearPanels()
    st.clearBlades()
    st.setUsage(null, null)
    resetConversation()
    say('Fresh start, sir.')
    listen(AWAIT_SPEECH_MS)
    return true
  }

  /** "Mute alerts" / "resume alerts". Cards still appear while muted. */
  const toggleAlerts = (raw: string): boolean => {
    const said = raw.replace(LEADING_NAME, '').trim()
    const mute = MUTE.test(said)
    if (!mute && !UNMUTE.test(said)) return false
    store.getState().setAlertsMuted(mute)
    say(mute ? 'Alerts muted, sir.' : 'Alerts back on, sir.')
    listen(AWAIT_SPEECH_MS)
    return true
  }

  const onUtterance = (text: string) => {
    const phase = store.getState().phase
    if (phase === 'offline' || phase === 'boot' || phase === 'dormant') return
    if (answerConfirm(text)) return
    if (startFresh(text)) return
    if (toggleAlerts(text)) return

    // People keep using his name as a vocative once they're already talking to
    // him. Strip it rather than sending "jarvis" to the model as a question.
    if (BARE_NAME.test(text)) {
      listen(AWAIT_SPEECH_MS)
      return
    }
    const said = text.replace(LEADING_NAME, '').trim()
    if (!said) {
      listen(AWAIT_SPEECH_MS)
      return
    }

    void respond(said)
  }

  /**
   * A command typed into the command bar. The same turn as a spoken one, minus
   * the wake word: typing is its own intent, and a typed "hey jarvis" prefix is
   * stripped like a spoken one. If he is mid-answer, this interrupts him, the
   * same as talking over him would.
   */
  const onTyped = (raw: string) => {
    const phase = store.getState().phase
    if (phase === 'offline' || phase === 'boot') return
    if (answerConfirm(raw)) return
    if (startFresh(raw)) return
    if (toggleAlerts(raw)) return
    const said = raw.replace(LEADING_NAME, '').trim()
    if (!said) return
    if (phase === 'thinking' || phase === 'tooling' || phase === 'speaking') onSpeechStart()
    store.getState().setError(null)
    void respond(said)
  }

  const onPartial = (text: string) => {
    store.getState().setCaption(text)
  }

  const onVoiceError = (message: string) => {
    store.getState().setError(message)
  }

  // -- power on -------------------------------------------------------------

  const powerOn = async () => {
    // The ignition button and the space bar can both land here, and the phase
    // only moves after the first await — so without this a double press boots
    // twice, arming two voice loops and two download polls.
    if (booting.current) return
    booting.current = true

    try {
      await ignite()
    } catch (err) {
      // The guard must not outlive a failed boot. Audio unlock can be refused,
      // the microphone prompt dismissed, the bridge unreachable at the wrong
      // moment — and with the flag still latched the ignition button was dead
      // for the rest of the page, recoverable only by reloading. Reset it and
      // put the button back so the user can simply press it again.
      booting.current = false
      console.error('[jarvis] power-up failed:', err)
      store.getState().setPhase('offline')
      store
        .getState()
        .setError(
          err instanceof Error
            ? `Power-up failed: ${err.message}`
            : 'Power-up failed. Click to try again.',
        )
    }
  }

  const ignite = async () => {
    const s = store.getState()

    // Must happen inside the click handler — browsers won't start an
    // AudioContext or speech synthesis without a user gesture.
    await sfx.unlockAudio()
    sfx.play('boot')
    // The score. Must be started from inside this click handler for the same
    // reason as the rest of the audio.
    music.enable()
    music.playBoot()
    music.startAmbient()

    s.setPhase('boot')

    watchServers((servers, health) => {
      store.getState().setConnected(servers)
      store.getState().setHealth(health)
    })
    watchPanels((panel) => store.getState().pushPanel(panel))
    watchBlades((blade) => store.getState().pushBlade(blade))

    /**
     * The bridge asking whether an action may run.
     *
     * The card goes up, the phase drops to listening so the next thing said is
     * heard as an answer rather than a barge-in, and once his current sentence
     * has finished he asks. A yes starts a short undo window; a no, a stand
     * down, or silence past the timeout all mean no. Every path resolves, so
     * the bridge is never left holding a turn open.
     */
    watchConfirm(
      (req) =>
        new Promise<{ ok: boolean }>((resolve) => {
          let settled = false
          let askTimer = 0
          let undoTimer = 0
          const finish = (ok: boolean) => {
            if (settled) return
            settled = true
            clearTimeout(askTimer)
            clearTimeout(undoTimer)
            const st = store.getState()
            st.setConfirm(null)
            // Back to the turn in flight: the tool runs, or is refused, and he
            // will say which.
            if (st.phase === 'listening') st.setPhase('tooling')
            sfx.play(ok ? 'tool' : 'error')
            resolve({ ok })
          }
          const answer = (yes: boolean) => {
            const current = store.getState().confirm
            if (settled || !current) return
            if (current.stage === 'ask') {
              if (!yes) return finish(false)
              clearTimeout(askTimer)
              store.getState().setConfirm({ ...current, stage: 'undo', until: Date.now() + UNDO_MS })
              undoTimer = window.setTimeout(() => finish(true), UNDO_MS)
            } else if (!yes) {
              finish(false)
            }
          }
          clearIdle()
          store.getState().setConfirm({ ...req, stage: 'ask', until: 0, answer })
          store.getState().setPhase('listening')
          sfx.play('listen')
          askTimer = window.setTimeout(() => finish(false), CONFIRM_TIMEOUT_MS)
          void afterSpeech().then(() => {
            if (!settled) say(req.money ? 'This moves money, sir. Shall I proceed?' : 'Shall I proceed, sir?')
          })
        }),
    )

    /**
     * JARVIS asking to see something.
     *
     * Announced on screen for as long as it takes, with whatever he said he was
     * looking for. The camera's own light is on too, but a hardware light that
     * appears with no explanation is exactly the thing that makes people
     * distrust an assistant — so the interface says it before they have to ask.
     */
    watchCapture(async (req) => {
      const note =
        req.mode === 'watch'
          ? req.when === 'past'
            ? req.reason || 'reviewing the last few seconds'
            : `${req.reason || 'watching'} · ${req.seconds}s`
          : req.reason || 'taking a look'
      store.getState().setLooking(note)

      // The past is only available if something has been remembering it, and
      // that only happens while the camera is on screen. Answering plainly
      // beats opening the camera and recording the next few seconds instead,
      // which is a different question from the one that was asked.
      if (req.mode === 'watch' && req.when === 'past' && camera.bufferedSeconds() < 1) {
        store.getState().setLooking(null)
        return {
          error:
            'There is no recent footage — the camera has to be open on screen ' +
            'for me to remember what just happened. Ask me to open the camera, ' +
            'and I can watch from then on.',
        }
      }

      // Held for the whole capture. Without this the stream can be torn down by
      // whoever else was using it half way through a six-second watch.
      let held = false
      try {
        await camera.holdCamera()
        held = true
        if (req.mode === 'look') return camera.grabFrame()
        if (req.when === 'past') {
          const grid = camera.recentGrid(req.seconds, 9)
          return grid ?? { error: 'There is not enough recent footage to review.' }
        }
        return await camera.watchAhead(req.seconds, 9)
      } catch (err) {
        return {
          error:
            (err as DOMException)?.name === 'NotAllowedError'
              ? 'The camera is not permitted, so I cannot see anything.'
              : `The camera could not be read: ${(err as Error)?.message ?? err}`,
        }
      } finally {
        if (held) camera.releaseCamera()
        store.getState().setLooking(null)
      }
    })

    // The interface is JARVIS's to drive. These arrive out of band, pushed
    // mid-turn the way panels are, so a command can retint the reactor or put
    // something into orbit while he is still speaking the sentence about it.
    watchUi((op, args) => {
      const s = store.getState()
      const a = (args ?? {}) as Record<string, never>
      switch (op) {
        case 'patch':
          s.applyUi(args)
          break
        case 'orbit':
          if (a.action === 'add') s.addOrbit(args)
          else if (a.action === 'remove') s.removeOrbit(String(a.id))
          else s.clearOrbits()
          break
        case 'effect':
          s.fireEffect(a.kind)
          break
        case 'reset':
          s.resetUi()
          break
        case 'screen':
          s.clearScreen(a.what ?? 'all')
          break
        default:
          console.warn('[jarvis] unknown ui op:', op, args)
      }
    })
    // In bridge mode the conversation lives in the agent session, which is tied
    // to the socket — so a drop silently wipes his memory while the transcript
    // on screen still shows it. Better to say so than to let him quietly forget.
    watchConnection((state) => {
      // A fresh start closes the socket on purpose; that is not a fault.
      if (resetting.current) {
        if (state === 'reconnected') resetting.current = false
        return
      }
      clearTimeout(offlineTimer.current)
      if (state === 'lost') {
        store.getState().setError('Bridge connection lost — reconnecting.')
        // Still down after a while: it is not a blip, so say what fixes it.
        // The page keeps retrying and clears this the moment it is back.
        offlineTimer.current = window.setTimeout(() => {
          store
            .getState()
            .setError(
              "The bridge isn't running. Run npm run autostart:restart (or npm start); this page reconnects by itself.",
            )
        }, 30_000)
      } else if (state === 'reconnected') {
        // The bridge resumes the conversation, so nothing to apologise for.
        store.getState().setError(null)
      }
    })

    /**
     * A proactive alert. The card goes up at once; the spoken line waits until
     * he is free — never over his own answer or across a confirmation — and is
     * skipped entirely while alerts are muted. A meeting whose moment has
     * passed by the time he is free is not announced late.
     */
    watchAlerts((raw) => {
      const alert: Alert = {
        id: `${raw.kind}:${raw.title}:${raw.at}`,
        kind: raw.kind,
        title: raw.title,
        detail: raw.detail,
        at: Date.parse(raw.at) || Date.now(),
        ...(raw.prep ? { prep: raw.prep } : {}),
      }
      store.getState().pushAlert(alert)
      if (store.getState().alertsMuted) return
      const busy = () => {
        const st = store.getState()
        return (
          !!st.confirm ||
          st.phase === 'thinking' ||
          st.phase === 'tooling' ||
          st.phase === 'speaking' ||
          st.phase === 'boot' ||
          st.phase === 'offline'
        )
      }
      const deadline = Date.now() + 5 * 60_000
      const announce = () => {
        if (store.getState().alertsMuted) return
        if (!store.getState().alerts.some((a) => a.id === alert.id)) return // dismissed
        if (busy() && Date.now() < deadline) return void setTimeout(announce, 1500)
        if (alert.kind === 'meeting' && alert.at < Date.now() - 60_000) return
        sfx.play('wake')
        void afterSpeech().then(() => say(alertLine(alert)))
      }
      announce()
    })

    // A conversation resumed after a reload: put its last exchanges back on
    // screen, unless something has already been said in this page.
    watchHistory((turns) => {
      if (store.getState().turns.length) return
      store.getState().setTurns(turns.map((t) => ({ id: newId(), role: t.role, text: t.text })))
    })
    const warming = warm().catch((err: Error) => s.setError(err.message))

    if (!usingBridge && !env.anthropicKey) {
      s.setError(
        'No Anthropic API key — copy .env.example to .env.local and set VITE_ANTHROPIC_API_KEY.',
      )
    }

    // Pull the neural voice down during the boot sequence so the first
    // "Hey Jarvis" isn't waiting on an 86MB download. Deliberately not awaited
    // — if it's slow, JARVIS comes up on the system voice and swaps over the
    // moment the model is ready.
    if (TTS_ENGINE === 'kokoro') {
      void kokoro.load()
      voicePoll.current = setInterval(() => {
        const p = kokoro.loadProgress()
        if (kokoro.isReady() || kokoro.isUnavailable()) {
          store.getState().setBootNote('')
          if (voicePoll.current) clearInterval(voicePoll.current)
          voicePoll.current = null
        } else if (p > 0 && p < 1) {
          store.getState().setBootNote(`voice ${Math.round(p * 100)}%`)
        }
      }, 200)
    }

    // Long enough for the four-beat start-up sequence in Boot.tsx to play —
    // status bar, rings, suit schematic, reactor power-up — before the live
    // interface takes over. Kept a touch under the boot cue so the music is
    // still rising as the reactor lands.
    // Skippable (Escape or Space), and short for anyone who has asked their
    // system for less motion: nine seconds of animation is a performance the
    // first time and a wait every time after.
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    await new Promise<void>((r) => {
      skipBoot.current = r
      setTimeout(r, reduceMotion ? 1500 : 9200)
    })
    skipBoot.current = null
    await warming
    store.getState().setConnected(connectedLabels())
    store.getState().setVoice(currentVoiceName())

    // The analyser is what makes the reactor pulse with your voice. It needs a
    // getUserMedia stream; speech recognition does not, and gets its own. So a
    // failure here costs the animation and nothing else — saying "voice input
    // is unavailable" was both alarming and untrue.
    try {
      await startAnalyser()
    } catch {
      console.warn(
        '[jarvis] no microphone stream — the reactor will not pulse with your ' +
          'voice. Speech recognition is unaffected.',
      )
    }

    // Ask the bridge which speech engines exist before the loop starts, so the
    // first turn already uses ElevenLabs when a key is present and the browser
    // fallback when it is not — no flag, no reload.
    await probeCapabilities()

    // One voice loop, started once, running until the page closes.
    voice.current = await startVoice({
      mode,
      onWake,
      onSpeechStart,
      onPartial,
      onUtterance,
      onError: onVoiceError,
    })

    store.getState().setPhase('dormant')
  }

  // -- clap to start --------------------------------------------------------

  /**
   * A clap brings him up, as an alternative to the button.
   *
   * Only while the ignition screen is showing, and torn down the moment he
   * boots — the microphone is about to belong to the voice loop, and two
   * analysers arguing over the same stream is how you get an assistant that
   * hears half of what you say.
   *
   * Deliberately silent about failure. If the microphone is refused, or has not
   * been granted yet, the button is still right there; announcing an error
   * about a feature nobody asked for would be worse than quietly doing without.
   */
  useEffect(() => {
    if (phase !== 'offline') return
    let live: { stop: () => void } | null = null
    let gone = false
    void listenForClap(() => {
      if (!gone) void powerOn()
    }).then((l) => {
      if (gone) l.stop()
      else live = l
    })
    return () => {
      gone = true
      live?.stop()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase])

  // -- level pump + keys ----------------------------------------------------

  useEffect(() => {
    let raf = 0

    const pump = () => {
      const st = store.getState()
      // While speaking, follow JARVIS's own output rather than the mic, so the
      // orb lip-syncs instead of reacting to room noise.
      const lvl =
        st.phase === 'speaking' && speaker.current
          ? speaker.current.level()
          : micLevel()
      st.setLevel(lvl)
      raf = requestAnimationFrame(pump)
    }
    pump()

    // Opening settings stands him down: nothing said while you are in there,
    // and no voice preview, should be taken as a question.
    const unsubSettings = useStore.subscribe((s, prev) => {
      if (s.settingsOpen && !prev.settingsOpen && s.phase !== 'offline' && s.phase !== 'boot') {
        goDormant()
      }
    })

    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      // The settings panel has its own keys (Escape closes it); none of these
      // should fire behind it.
      if (store.getState().settingsOpen) return

      // Comma opens settings, as ⌘, does in most Mac apps.
      if (e.key === ',' && !e.repeat && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        store.getState().setSettingsOpen(true)
        return
      }

      // V auditions the next British voice installed on this machine. Which
      // ones exist varies per Mac, so hearing them beats trusting a ranking.
      // Bare V only — ⌘V and ⌃V are paste, and swallowing those was rude.
      if (
        e.key === 'v' &&
        !e.repeat &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey
      ) {
        e.preventDefault()
        const name = cycleVoice()
        store.getState().setVoice(name)
        silence()
        const demo = createSpeaker()
        speaker.current = demo
        demo.say(`Voice set to ${name.replace(/\(.*?\)/g, '').trim()}. At your service, sir.`)
        void demo.end()
        return
      }

      // G puts the camera on and starts tracking hands. Off by default and
      // never implicit: a webcam that turns itself on because an interface
      // thought it might be useful is not a trade anyone agreed to.
      if (e.key === 'g' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        const on = store.getState().gestures
        if (on) {
          hands.disableHands()
          store.getState().setGestures(false)
        } else {
          store.getState().setError(null)
          void hands
            .enableHands()
            .then(() => store.getState().setGestures(true))
            .catch((err: Error) => {
              store.getState().setGestures(false)
              store
                .getState()
                .setError(
                  err?.name === 'NotAllowedError'
                    ? 'Camera access denied — gesture control is unavailable.'
                    : `Gesture control failed to start: ${err?.message ?? err}`,
                )
            })
        }
        return
      }

      // T speaks a fixed line, bypassing the wake word, the recogniser and the
      // model entirely. When "I can't hear him" is the report, this is the one
      // keypress that separates a broken voice engine from a broken voice loop
      // — and it prints the verdict rather than making you infer it.
      if (e.key === 't' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        silence()
        const t = createSpeaker()
        speaker.current = t
        t.say('Audio test. If you can hear this, speech output is working, sir.')
        void t.end().then(() => {
          const d = (window as unknown as Record<string, Record<string, unknown>>).__tts
          console.info('[jarvis] audio test →', d)
          if (d && d.started === 0 && d.rescued === 0) {
            store.getState().setError(
              `No sound produced. engine=${d.engine} voice=${d.voice} error=${d.lastError || 'none'}`,
            )
          }
        })
        return
      }

      // Escape stands the whole thing down — the one thing the old build had
      // no key for at all.
      if (e.key === 'Escape') {
        e.preventDefault()
        if (store.getState().phase === 'boot') skipBoot.current?.()
        else if (store.getState().phase !== 'offline') goDormant()
        return
      }

      // Space starts a turn without the wake word. Worth using while filming so
      // a missed wake word doesn't cost a take.
      if (e.code !== 'Space' || e.repeat) return
      e.preventDefault()
      // Mid-confirmation, Space would start a fresh turn over the one waiting
      // for the answer. The card's buttons, a typed or a spoken reply answer it.
      if (store.getState().confirm) return

      const phase = store.getState().phase
      if (phase === 'offline') {
        void powerOn()
      } else if (phase === 'boot') {
        skipBoot.current?.()
      } else if (
        phase === 'thinking' ||
        phase === 'tooling' ||
        phase === 'speaking'
      ) {
        onSpeechStart()
        listen(AWAIT_SPEECH_MS)
      } else {
        onWake('')
      }
    }
    window.addEventListener('keydown', onKey)

    const onCommand = (e: Event) => onTyped(String((e as CustomEvent<string>).detail ?? ''))
    window.addEventListener(COMMAND_EVENT, onCommand)

    return () => {
      window.removeEventListener(COMMAND_EVENT, onCommand)
      cancelAnimationFrame(raf)
      window.removeEventListener('keydown', onKey)
      unsubSettings()
      clearIdle()
      if (voicePoll.current) clearInterval(voicePoll.current)
      voice.current?.stop()
      speaker.current?.cancel()
      // The camera must not outlive the page that turned it on.
      hands.disableHands()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <>
      <Scene />
      <Hud />
      <Boot />
      <Diagnostics />
      <SettingsButton />
      <Settings />
      <Ignition onStart={() => void powerOn()} />
    </>
  )
}
