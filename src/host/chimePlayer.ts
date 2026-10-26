import { presetOf, tuneFor, type ChimeSettings, type Kind, type Sound, type Tune } from './chime.ts'

/**
 * Making the sound. Web Audio only: the chimes are synthesised here, no audio
 * files ship, and the person's own clips are fetched from the host and played
 * through the same context (an Audio element is the fallback).
 *
 * ## The gesture
 *
 * WebKit (the desktop app's engine) keeps an `AudioContext` suspended until the
 * page has had a user gesture. `unlockOnGesture` makes or resumes it on the
 * first pointer or key event, and a Preview press resumes it too. Anything that
 * goes wrong — blocked, no Web Audio, a clip that will not decode — is
 * swallowed: a chime that cannot play is silence, never an error.
 */

type Ctx = AudioContext
let context: Ctx | null = null

function make(): Ctx | null {
  const scope = globalThis as { AudioContext?: new () => Ctx; webkitAudioContext?: new () => Ctx }
  const Made = scope.AudioContext ?? scope.webkitAudioContext
  if (!Made) return null
  try {
    return new Made()
  } catch {
    return null
  }
}

/** The context, made when first needed and resumed if the page let it fall asleep. */
export function audio(): Ctx | null {
  context ??= make()
  if (context && context.state === 'suspended') void Promise.resolve(context.resume()).catch(() => undefined)
  return context
}

/** Forget the context (tests). */
export function resetAudio(): void {
  context = null
}

/** Create or resume the context on the first pointer or key event of the page. Returns the undo. */
export function unlockOnGesture(target: Pick<Document, 'addEventListener' | 'removeEventListener'> = document): () => void {
  const events = ['pointerdown', 'keydown'] as const
  const wake = () => {
    audio()
    stop()
  }
  const stop = () => {
    for (const name of events) target.removeEventListener(name, wake, true)
  }
  for (const name of events) target.addEventListener(name, wake, true)
  return stop
}

const midi = (note: number) => 440 * 2 ** ((note - 69) / 12)

/** Schedule a tune on a context: a soft attack, then an exponential decay that rings past the slot. */
export function schedule(ctx: Ctx, tune: Tune, at = ctx.currentTime): void {
  const slot = 15 / tune.tempo
  /* A square wave is far louder than a sine at the same level. */
  const level = 0.2 * tune.volume * (tune.wave === 'square' ? 0.45 : 1)
  tune.notes.forEach((note, i) => {
    if (note === null) return
    const start = at + i * slot
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = tune.wave
    osc.frequency.value = midi(note)
    gain.gain.setValueAtTime(0.0001, start)
    gain.gain.linearRampToValueAtTime(level, start + 0.012)
    gain.gain.exponentialRampToValueAtTime(0.0001, start + slot + 0.17)
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start(start)
    osc.stop(start + slot + 0.2)
  })
}

const decoded = new Map<string, Promise<AudioBuffer | null>>()

async function bufferOf(ctx: Ctx, id: string): Promise<AudioBuffer | null> {
  const known = decoded.get(id)
  if (known) return known
  const loading = (async () => {
    try {
      const response = await globalThis.fetch(`/host/sounds/${id}`)
      if (!response.ok) return null
      return await ctx.decodeAudioData(await response.arrayBuffer())
    } catch {
      return null
    }
  })()
  decoded.set(id, loading)
  void loading.then((got) => {
    if (!got) decoded.delete(id)
  })
  return loading
}

/** Forget a clip's decoded copy (it was removed or replaced). */
export const forgetClip = (id: string): void => void decoded.delete(id)

async function playFile(id: string): Promise<void> {
  const ctx = audio()
  const buffer = ctx ? await bufferOf(ctx, id) : null
  if (ctx && buffer) {
    const source = ctx.createBufferSource()
    const gain = ctx.createGain()
    gain.gain.value = 0.9
    source.buffer = buffer
    source.connect(gain)
    gain.connect(ctx.destination)
    source.start()
    return
  }
  const Element = (globalThis as { Audio?: new (src?: string) => HTMLAudioElement }).Audio
  if (Element) await new Element(`/host/sounds/${id}`).play()
}

/**
 * Play one sound for a kind. Never throws; resolves when it has been started.
 * A file that is not among the settings' files plays nothing.
 */
export async function playSound(sound: Sound, kind: Kind, settings: ChimeSettings): Promise<void> {
  try {
    if (sound.type === 'none') return
    if (sound.type === 'file') {
      if (settings.files.some((one) => one.id === sound.id)) await playFile(sound.id)
      return
    }
    const tune = sound.type === 'custom' ? settings.custom : presetOf(sound.id)?.tune
    if (!tune) return
    const ctx = audio()
    if (ctx) schedule(ctx, tuneFor(tune, kind))
  } catch {
    /* blocked or unsupported: silence */
  }
}
