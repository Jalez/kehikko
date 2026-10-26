import type { Entry } from './inbox.ts'

/**
 * The Inbox chime: the rules, with no sound in them. Pure, and importable from
 * both halves like `inbox.ts` — the page plays and decides, the server keeps
 * and validates, and both run these functions over the same shapes.
 *
 * ## It is derived, never kept
 *
 * There is no second set of items here. The page chimes for what the record
 * already calls news: the entries `applyList` returns in `news` (an entry that
 * ENTERED attention or done, new since this page loaded, from a move in
 * `inbox_moves`), minus any whose place is on screen (`placeOpened`), and for a
 * legacy notice line as it arrives. This file only decides which SOUND that is,
 * and how a burst of them collapses to one.
 *
 * ## Four kinds
 *
 * The record has three states (`attention`, `working`, `done`), a priority
 * (`urgent`, `normal`, `low`) and an origin (`notice` for a one-off line).
 * `working` is never news. That leaves four things a person can tell apart by
 * ear: `urgent` (attention at urgent priority: something that cannot wait),
 * `attention` (it needs you), `done` and `notice`. A burst plays the most
 * urgent kind that arrived in it, in that order.
 *
 * ## Where it is kept
 *
 * Machine-wide, in the host's settings (`server/chime.ts`, key `inbox-chime`),
 * never in the browser and never in a project. Mute (`on`) is a separate
 * switch from the choice of sounds, so muting forgets nothing.
 */

export const KINDS = ['urgent', 'attention', 'done', 'notice'] as const
export type Kind = (typeof KINDS)[number]

/** How much a kind wins a burst: bigger is more urgent. */
export const URGENCY: Record<Kind, number> = { urgent: 4, attention: 3, done: 2, notice: 1 }

export const KIND_WORDS: Record<Kind, { label: string; hint: string }> = {
  urgent: { label: 'Urgent', hint: 'Something needs you and cannot wait.' },
  attention: { label: 'Needs you', hint: 'A module is waiting for you.' },
  done: { label: 'Finished', hint: 'Something finished.' },
  notice: { label: 'Notice', hint: 'A plain line a module told you.' },
}

/** The sound kind of an entry that entered the Inbox; `null` when it is nothing to hear (still working). */
export function kindOf(entry: Pick<Entry, 'state' | 'priority' | 'origin'>): Kind | null {
  if (entry.state === 'working') return null
  if (entry.origin === 'notice' && entry.state !== 'attention') return 'notice'
  if (entry.state === 'attention') return entry.priority === 'urgent' ? 'urgent' : 'attention'
  return 'done'
}

/** The most urgent of some kinds; `null` for none. */
export function loudest(kinds: Iterable<Kind>): Kind | null {
  let best: Kind | null = null
  for (const kind of kinds) if (best === null || URGENCY[kind] > URGENCY[best]) best = kind
  return best
}

/* ---- the tune ---- */

/** C major pentatonic over two octaves (MIDI numbers C4..A5): any choice of these sounds pleasant. */
export const SCALE: readonly number[] = [60, 62, 64, 67, 69, 72, 74, 76, 79, 81]
const NAMES: Record<number, string> = { 60: 'C4', 62: 'D4', 64: 'E4', 67: 'G4', 69: 'A4', 72: 'C5', 74: 'D5', 76: 'E5', 79: 'G5', 81: 'A5' }
export const noteName = (note: number | null): string => (note === null ? 'Rest' : (NAMES[note] ?? `${note}`))

export const WAVES = ['sine', 'triangle', 'square'] as const
export type Wave = (typeof WAVES)[number]
export const WAVE_WORDS: Record<Wave, string> = { sine: 'Sine (round)', triangle: 'Triangle (mellow)', square: 'Soft square (bright)' }

export const LIMITS = { notesMin: 3, notesMax: 5, tempoMin: 60, tempoMax: 240, volumeMin: 0.1, volumeMax: 1 } as const

/** A tune: notes (`null` is a rest), a tempo in steps of a sixteenth at this many beats a minute, a wave and a volume. */
export interface Tune {
  notes: (number | null)[]
  tempo: number
  wave: Wave
  volume: number
}

export const DEFAULT_TUNE: Tune = { notes: [72, 76, 79, null], tempo: 130, wave: 'triangle', volume: 0.6 }

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/**
 * A tune as the person may keep it: three to five slots, each a note of the
 * scale or a rest (not all rests), a tempo and volume within bounds, a known
 * wave. `null` for anything else — never a repaired guess.
 */
export function validTune(value: unknown): Tune | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const { notes, tempo, wave, volume } = value as Record<string, unknown>
  if (!Array.isArray(notes) || notes.length < LIMITS.notesMin || notes.length > LIMITS.notesMax) return null
  if (!notes.every((note) => note === null || (isNumber(note) && SCALE.includes(note)))) return null
  if (notes.every((note) => note === null)) return null
  if (!isNumber(tempo) || tempo < LIMITS.tempoMin || tempo > LIMITS.tempoMax) return null
  if (typeof wave !== 'string' || !(WAVES as readonly string[]).includes(wave)) return null
  if (!isNumber(volume) || volume < LIMITS.volumeMin || volume > LIMITS.volumeMax) return null
  return { notes: [...notes] as (number | null)[], tempo, wave: wave as Wave, volume }
}

/** How long one slot lasts. */
export const slotMs = (tune: Pick<Tune, 'tempo'>): number => 15000 / tune.tempo
/** The tail a note rings for after its slot. */
export const TAIL_MS = 170
/** How long a tune sounds, in ms. */
export const durationMs = (tune: Pick<Tune, 'notes' | 'tempo'>): number => Math.round(tune.notes.length * slotMs(tune) + TAIL_MS)

/**
 * A tune as a kind plays it. Needs you plays it as written; urgent plays it
 * twice, a little louder; finished and a notice play a softer, lower, shorter
 * form of it (the first two notes, an octave down, at about half the volume),
 * so the person designs ONE tune.
 */
export function tuneFor(tune: Tune, kind: Kind): Tune {
  if (kind === 'attention') return tune
  if (kind === 'urgent') {
    const once = [...tune.notes]
    while (once.length && once[once.length - 1] === null) once.pop()
    return { ...tune, notes: [...once, null, ...once], volume: Math.min(1, tune.volume * 1.15) }
  }
  const sounded = tune.notes.filter((note): note is number => note !== null).slice(0, 2)
  return { ...tune, notes: sounded.map((note) => note - 12), volume: Math.max(LIMITS.volumeMin, tune.volume * 0.55) }
}

/* ---- the built-in chimes ---- */

export interface Preset {
  id: string
  name: string
  tune: Tune
}

export const PRESETS: readonly Preset[] = [
  { id: 'bell', name: 'Bell', tune: { notes: [76, 79, 84], tempo: 120, wave: 'sine', volume: 0.7 } },
  { id: 'marimba', name: 'Marimba', tune: { notes: [67, 72, 76], tempo: 140, wave: 'triangle', volume: 0.8 } },
  { id: 'pluck', name: 'Soft pluck', tune: { notes: [79, 74, 67], tempo: 150, wave: 'triangle', volume: 0.6 } },
  { id: 'twotone', name: 'Two-tone', tune: { notes: [79, 72], tempo: 100, wave: 'sine', volume: 0.7 } },
  { id: 'rising', name: 'Rising', tune: { notes: [60, 64, 67, 72], tempo: 160, wave: 'square', volume: 0.45 } },
  { id: 'playful', name: 'Playful', tune: { notes: [72, 76, 72, 79, 84], tempo: 200, wave: 'triangle', volume: 0.7 } },
]
export const presetOf = (id: string): Preset | undefined => PRESETS.find((one) => one.id === id)

/* ---- what a person chooses ---- */

/** A sound a kind can play. `file` is one of the person's own clips (`files` in the settings). */
export type Sound =
  | { type: 'preset'; id: string }
  | { type: 'custom' }
  | { type: 'file'; id: string }
  | { type: 'none' }

export interface SoundFile {
  id: string
  /** What the person calls it: the file's name to begin with. */
  name: string
  ext: string
  bytes: number
  seconds: number
}

export const FILE_LIMITS = { bytes: 1024 * 1024, seconds: 5, count: 40, nameMax: 60, exts: ['wav', 'mp3', 'ogg', 'm4a', 'aac'] as const }
export const FILE_ID = /^[0-9a-f]{16}$/

export interface ChimeSettings {
  /** Not muted. */
  on: boolean
  sounds: Record<Kind, Sound>
  /** Per module (its id), a sound for some kinds in place of the kind's. */
  modules: Record<string, Partial<Record<Kind, Sound>>>
  custom: Tune
  files: SoundFile[]
}

export const DEFAULT_SOUNDS: Record<Kind, Sound> = {
  urgent: { type: 'preset', id: 'rising' },
  attention: { type: 'preset', id: 'bell' },
  done: { type: 'preset', id: 'marimba' },
  notice: { type: 'preset', id: 'pluck' },
}

export const DEFAULT_CHIME: ChimeSettings = {
  on: true,
  sounds: DEFAULT_SOUNDS,
  modules: {},
  custom: DEFAULT_TUNE,
  files: [],
}

const MODULES_MAX = 40

/** One sound as written, checked against the files that exist. `null` when it is not one. */
export function validSound(value: unknown, files: readonly SoundFile[]): Sound | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const { type, id } = value as Record<string, unknown>
  if (type === 'none') return { type: 'none' }
  if (type === 'custom') return { type: 'custom' }
  if (type === 'preset') return typeof id === 'string' && presetOf(id) ? { type: 'preset', id } : null
  if (type === 'file') return typeof id === 'string' && files.some((one) => one.id === id) ? { type: 'file', id } : null
  return null
}

const MODULE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i

export function validFile(value: unknown): SoundFile | null {
  if (typeof value !== 'object' || value === null) return null
  const { id, name, ext, bytes, seconds } = value as Record<string, unknown>
  if (typeof id !== 'string' || !FILE_ID.test(id)) return null
  if (typeof name !== 'string' || !name.trim() || name.length > FILE_LIMITS.nameMax) return null
  if (typeof ext !== 'string' || !(FILE_LIMITS.exts as readonly string[]).includes(ext)) return null
  if (!isNumber(bytes) || bytes <= 0 || bytes > FILE_LIMITS.bytes) return null
  if (!isNumber(seconds) || seconds <= 0 || seconds > FILE_LIMITS.seconds) return null
  return { id, name, ext, bytes, seconds }
}

/** What is stored, read leniently: anything wrong falls back to the default for that part, so a hand-edited row never silences the app. */
export function chimeFrom(stored: unknown): ChimeSettings {
  const row = typeof stored === 'object' && stored !== null && !Array.isArray(stored) ? (stored as Record<string, unknown>) : {}
  const files = Array.isArray(row.files) ? row.files.flatMap((one) => validFile(one) ?? []).slice(0, FILE_LIMITS.count) : []
  const sounds = { ...DEFAULT_SOUNDS }
  const given = typeof row.sounds === 'object' && row.sounds !== null ? (row.sounds as Record<string, unknown>) : {}
  for (const kind of KINDS) sounds[kind] = validSound(given[kind], files) ?? DEFAULT_SOUNDS[kind]
  const modules: ChimeSettings['modules'] = {}
  const over = typeof row.modules === 'object' && row.modules !== null ? (row.modules as Record<string, unknown>) : {}
  for (const [module, each] of Object.entries(over).slice(0, MODULES_MAX)) {
    if (!MODULE_ID.test(module) || typeof each !== 'object' || each === null) continue
    const set: Partial<Record<Kind, Sound>> = {}
    for (const kind of KINDS) {
      const sound = validSound((each as Record<string, unknown>)[kind], files)
      if (sound) set[kind] = sound
    }
    if (Object.keys(set).length) modules[module] = set
  }
  return {
    on: typeof row.on === 'boolean' ? row.on : true,
    sounds,
    modules,
    custom: validTune(row.custom) ?? DEFAULT_TUNE,
    files,
  }
}

/**
 * A change from the page: any subset of `{ on, sounds, custom, modules }`.
 * `sounds` and `modules[id]` take a few kinds at a time; a module's kind set to
 * `null` removes the override, and a module with `{}` is dropped. `null` for
 * anything that is not a change — a bad sound, a tune off the scale, an
 * unknown file — and nothing is applied.
 */
export function chimePatched(was: ChimeSettings, change: unknown): ChimeSettings | null {
  if (typeof change !== 'object' || change === null || Array.isArray(change)) return null
  const body = change as Record<string, unknown>
  const next: ChimeSettings = { ...was, sounds: { ...was.sounds }, modules: { ...was.modules } }
  let touched = false
  if (body.on !== undefined) {
    if (typeof body.on !== 'boolean') return null
    next.on = body.on
    touched = true
  }
  if (body.sounds !== undefined) {
    if (typeof body.sounds !== 'object' || body.sounds === null || Array.isArray(body.sounds)) return null
    for (const [kind, value] of Object.entries(body.sounds)) {
      if (!(KINDS as readonly string[]).includes(kind)) return null
      const sound = validSound(value, was.files)
      if (!sound) return null
      next.sounds[kind as Kind] = sound
    }
    touched = true
  }
  if (body.custom !== undefined) {
    const tune = validTune(body.custom)
    if (!tune) return null
    next.custom = tune
    touched = true
  }
  if (body.modules !== undefined) {
    if (typeof body.modules !== 'object' || body.modules === null || Array.isArray(body.modules)) return null
    for (const [module, each] of Object.entries(body.modules)) {
      if (!MODULE_ID.test(module) || typeof each !== 'object' || each === null || Array.isArray(each)) return null
      const set = { ...(next.modules[module] ?? {}) }
      for (const [kind, value] of Object.entries(each)) {
        if (!(KINDS as readonly string[]).includes(kind)) return null
        if (value === null) {
          delete set[kind as Kind]
          continue
        }
        const sound = validSound(value, was.files)
        if (!sound) return null
        set[kind as Kind] = sound
      }
      if (Object.keys(set).length) next.modules[module] = set
      else delete next.modules[module]
    }
    if (Object.keys(next.modules).length > MODULES_MAX) return null
    touched = true
  }
  return touched ? next : null
}

/**
 * The sound a kind plays for a module: the module's own for that kind, else the kind's.
 * A file that is gone, or My chime with nothing made, is never silence by accident: it is the kind's default.
 */
export function soundFor(settings: ChimeSettings, kind: Kind, module?: string): Sound {
  const asked = (module ? settings.modules[module]?.[kind] : undefined) ?? settings.sounds[kind]
  if (asked.type === 'file' && !settings.files.some((one) => one.id === asked.id)) return DEFAULT_SOUNDS[kind]
  return asked
}

/**
 * Take a file out of what uses it: every kind and module that played it goes back to the kind's default
 * (a module's override is simply removed). Says which kinds, so the page can tell the person.
 */
export function withoutFile(settings: ChimeSettings, id: string): { settings: ChimeSettings; fellBack: Kind[]; modules: string[] } {
  const uses = (sound: Sound | undefined) => sound?.type === 'file' && sound.id === id
  const fellBack: Kind[] = []
  const sounds = { ...settings.sounds }
  for (const kind of KINDS) {
    if (uses(sounds[kind])) {
      sounds[kind] = DEFAULT_SOUNDS[kind]
      fellBack.push(kind)
    }
  }
  const modules: ChimeSettings['modules'] = {}
  const touched: string[] = []
  for (const [module, set] of Object.entries(settings.modules)) {
    const kept: Partial<Record<Kind, Sound>> = {}
    for (const kind of KINDS) {
      const sound = set[kind]
      if (!sound) continue
      if (uses(sound)) touched.push(module)
      else kept[kind] = sound
    }
    if (Object.keys(kept).length) modules[module] = kept
  }
  return { settings: { ...settings, sounds, modules, files: settings.files.filter((one) => one.id !== id) }, fellBack, modules: [...new Set(touched)] }
}

/** The sentence that says what a removal changed; empty when nothing used the sound. */
export function fellBackWords(name: string, fellBack: readonly Kind[], modules: readonly string[]): string {
  const parts = [
    ...fellBack.map((kind) => KIND_WORDS[kind].label),
    ...modules.map((module) => `the sound for ${module}`),
  ]
  if (!parts.length) return ''
  return `“${name}” was removed. ${parts.join(', ')} went back to ${parts.length === 1 && fellBack.length === 1 ? 'its' : 'their'} default.`
}

/* ---- one sound for a burst ---- */

export interface BurstOptions {
  /** How long the first event waits for others to join it, so the most urgent wins. */
  collectMs?: number
  /** After a sound, how long every event is swallowed: a burst chimes once. */
  quietMs?: number
  now?: () => number
  after?: (run: () => void, ms: number) => unknown
}

export const BURST = { collectMs: 350, quietMs: 3000 }

/**
 * Events in, at most one sound out. The first event opens a short window; the
 * most urgent kind seen in it plays; then nothing plays until `quietMs` after.
 * `plays` decides at the moment of the sound (muted, or another window has the
 * focus), not when the event came.
 */
export class Burst {
  #kind: Kind | null = null
  #module: string | undefined
  #waiting = false
  #quietUntil = -Infinity
  readonly #options: Required<BurstOptions>
  constructor(
    private readonly play: (kind: Kind, module?: string) => void,
    options: BurstOptions = {},
  ) {
    this.#options = {
      collectMs: options.collectMs ?? BURST.collectMs,
      quietMs: options.quietMs ?? BURST.quietMs,
      now: options.now ?? (() => Date.now()),
      after: options.after ?? ((run, ms) => setTimeout(run, ms)),
    }
  }

  offer(kind: Kind, module?: string): void {
    const at = this.#options.now()
    if (!this.#waiting && at < this.#quietUntil) return
    if (this.#kind === null || URGENCY[kind] > URGENCY[this.#kind]) {
      this.#kind = kind
      this.#module = module
    }
    if (this.#waiting) return
    this.#waiting = true
    this.#options.after(() => this.#fire(), this.#options.collectMs)
  }

  #fire(): void {
    const kind = this.#kind
    const module = this.#module
    this.#kind = null
    this.#module = undefined
    this.#waiting = false
    if (kind === null) return
    this.#quietUntil = this.#options.now() + this.#options.quietMs
    this.play(kind, module)
  }
}

/* ---- which window plays ---- */

/** What one window says about itself to the others of this app. */
export interface Peer {
  id: string
  /** When it last had the focus; 0 for never. */
  focusedAt: number
  /** When it was last heard from. */
  heardAt: number
}

/** A window not heard from for this long is taken to be gone. */
export const PEER_GONE_MS = 60_000

/**
 * Only one window plays: the one that had the focus most recently (the one the
 * person is in, if any is focused), the lowest id on a tie. A window that was
 * never focused plays only when no other window was either. Windows not heard
 * from lately are not counted.
 */
export function playsHere(self: Peer, others: readonly Peer[], now: number): boolean {
  for (const other of others) {
    if (other.id === self.id || now - other.heardAt > PEER_GONE_MS) continue
    if (other.focusedAt > self.focusedAt) return false
    if (other.focusedAt === self.focusedAt && other.id < self.id) return false
  }
  return true
}

/* ---- a sound as a picker's value ---- */

/** A sound as the value of a picker option: `preset:bell`, `custom`, `file:<id>`, `none`. */
export const choiceOf = (sound: Sound): string =>
  sound.type === 'preset' ? `preset:${sound.id}` : sound.type === 'file' ? `file:${sound.id}` : sound.type

export function soundOfChoice(value: string): Sound | null {
  if (value === 'none' || value === 'custom') return { type: value }
  if (value.startsWith('preset:')) return { type: 'preset', id: value.slice(7) }
  if (value.startsWith('file:')) return { type: 'file', id: value.slice(5) }
  return null
}

/** What a sound is called, for a sentence. */
export function soundName(sound: Sound, files: readonly SoundFile[]): string {
  if (sound.type === 'none') return 'None'
  if (sound.type === 'custom') return 'My chime'
  if (sound.type === 'preset') return presetOf(sound.id)?.name ?? sound.id
  return files.find((one) => one.id === sound.id)?.name ?? 'A sound that is gone'
}
