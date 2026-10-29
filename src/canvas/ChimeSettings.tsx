import { useEffect, useId, useRef, useState, type DragEvent } from 'react'
import { Bell, BellOff, Pencil, Play, Plus, Trash2, Upload } from 'lucide-react'

import { Button } from '@/components/ui/button.tsx'
import { Input } from '@/components/ui/input.tsx'
import { Label } from '@/components/ui/label.tsx'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select.tsx'
import { Switch } from '@/components/ui/switch.tsx'
import {
  choiceOf,
  durationMs,
  eventChoiceOf,
  eventDefault,
  eventSoundOfChoice,
  kindOf,
  FILE_LIMITS,
  KIND_WORDS,
  KINDS,
  LIMITS,
  noteName,
  PRESETS,
  SCALE,
  soundOfChoice,
  validTune,
  WAVES,
  WAVE_WORDS,
  type ChimeSettings,
  type Kind,
  type Sound,
  type Tune,
  type Wave,
} from '@/host/chime.ts'
import { audio, forgetClip, playSound } from '@/host/chimePlayer.ts'
import { Hint } from './Hint.tsx'
import { addSound, postChime, removeSound, renameSound, setMuted, setToast, useChimeSettings } from '@/host/chimeStore.ts'

/**
 * Settings › Inbox notifications: the mute switch, the toast switch, a sound for each kind of thing that
 * can arrive in the Inbox, the person's own clips, a sound for one module, and
 * the chime maker. The choices are the host's (`server/chime.ts`); this draws
 * them and sends each change through `postChime`. Every ▶ plays on the press,
 * which is also the gesture WebKit wants before it lets a page make sound.
 */

/** A module as the panel knows it: its id, its registered name, and the Inbox events it declares (protocol 2.31.0). */
export type ModuleRef = { id: string; name: string; events?: readonly { id: string; says: string; state: 'working' | 'attention' | 'done'; sound?: string }[] }

const said = (error: unknown): string => (error instanceof Error ? error.message : 'That did not work.')

/** The options every picker offers: the built-in chimes, My chime, the person's own sounds, and None. */
function Options({ settings }: { settings: ChimeSettings }) {
  return (
    <>
      <optgroup label="Built-in chimes">
        {PRESETS.map((one) => (
          <NativeSelectOption key={one.id} value={`preset:${one.id}`}>
            {one.name}
          </NativeSelectOption>
        ))}
      </optgroup>
      <optgroup label="Made by you">
        <NativeSelectOption value="custom">My chime</NativeSelectOption>
        {settings.files.map((one) => (
          <NativeSelectOption key={one.id} value={`file:${one.id}`}>
            {one.name}
          </NativeSelectOption>
        ))}
      </optgroup>
      <optgroup label="Silent">
        <NativeSelectOption value="none">None</NativeSelectOption>
      </optgroup>
    </>
  )
}

function Preview({ sound, kind, settings, label }: { sound: Sound; kind: Kind; settings: ChimeSettings; label: string }) {
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      className="shrink-0 gap-1.5"
      aria-label={`Preview ${label}`}
      onClick={() => void playSound(sound, kind, settings)}
    >
      <Play className="size-3.5" aria-hidden />
      Preview
    </Button>
  )
}

export function ChimePanel({ modules = [] }: { modules?: readonly ModuleRef[] }) {
  const settings = useChimeSettings()
  const [note, setNote] = useState<string | null>(null)
  const run = (work: Promise<unknown>) => {
    setNote(null)
    work.catch((error) => setNote(said(error)))
  }
  const labelId = useId()

  return (
    <div className="flex min-w-0 flex-col gap-6" data-chime-settings>
      <div className="divide-y rounded-lg border px-4">
        <div className="flex min-w-0 items-start justify-between gap-4 py-3.5">
          <div className="min-w-0 space-y-1">
            <Label htmlFor={`${labelId}-on`} className="text-sm leading-snug">
              Play a sound when something new arrives in the Inbox
            </Label>
            <p className="text-muted-foreground text-xs leading-relaxed">
              {settings.on ? 'On.' : 'Muted.'} Nothing plays for a place you are looking at, and a burst plays once, the most urgent kind first. Only the window you used last plays.
            </p>
          </div>
          <Switch id={`${labelId}-on`} checked={settings.on} onCheckedChange={(on) => run(setMuted(!on))} className="mt-0.5" />
        </div>
        <div className="flex min-w-0 items-start justify-between gap-4 py-3.5" data-toast-setting>
          <div className="min-w-0 space-y-1">
            <Label htmlFor={`${labelId}-toast`} className="text-sm leading-snug">
              Show a toast for new Inbox items
            </Label>
            <p className="text-muted-foreground text-xs leading-relaxed">
              {settings.toast ? 'On.' : 'Off.'} A brief note at the bottom right, never for a place you are looking at; a burst is one toast that says how many. Everything stays in the Inbox. Separate from the sound.
            </p>
          </div>
          <Switch id={`${labelId}-toast`} checked={settings.toast} onCheckedChange={(on) => run(setToast(on))} className="mt-0.5" />
        </div>
      </div>

      <section className="flex min-w-0 flex-col gap-2" aria-labelledby={`${labelId}-kinds`}>
        <h4 id={`${labelId}-kinds`} className="text-sm font-medium">
          A sound for each kind
        </h4>
        <ul className="divide-y rounded-lg border px-4" data-chime-kinds>
          {KINDS.map((kind) => (
            <li key={kind} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 py-3" data-chime-kind={kind}>
              <div className="min-w-32 flex-1 space-y-0.5">
                <Label htmlFor={`${labelId}-${kind}`} className="text-sm">
                  {KIND_WORDS[kind].label}
                </Label>
                <p className="text-muted-foreground text-xs">{KIND_WORDS[kind].hint}</p>
              </div>
              <div className="w-44 shrink-0">
                <NativeSelect
                  id={`${labelId}-${kind}`}
                  value={choiceOf(settings.sounds[kind])}
                  onChange={(event) => {
                    const sound = soundOfChoice(event.target.value)
                    if (sound) run(postChime({ sounds: { [kind]: sound } }))
                  }}
                >
                  <Options settings={settings} />
                </NativeSelect>
              </div>
              <Preview sound={settings.sounds[kind]} kind={kind} settings={settings} label={KIND_WORDS[kind].label} />
            </li>
          ))}
        </ul>
      </section>

      <Events settings={settings} modules={modules} run={run} />
      <Mine settings={settings} setNote={setNote} />
      <Overrides settings={settings} modules={modules} run={run} />
      <Maker settings={settings} run={run} />

      <p role="status" aria-live="polite" className="text-xs leading-relaxed" data-chime-note>
        {note}
      </p>
    </div>
  )
}

/**
 * What the file input offers. WKWebView's open panel is built from `accept`
 * by WebKit itself, and it matches a type, not just an extension, so the list
 * names the audio types as well; `audio/*` covers any wav spelling a system
 * knows. wry's macOS panel sets no filter at all, so there it is moot. The
 * server, and `add` below, still refuse anything that is not a sound.
 */
export const SOUND_ACCEPT = [
  'audio/*',
  'audio/wav',
  'audio/x-wav',
  'audio/wave',
  'audio/vnd.wave',
  'audio/mpeg',
  'audio/ogg',
  'audio/mp4',
  'audio/x-m4a',
  'audio/aac',
  ...FILE_LIMITS.exts.map((one) => `.${one}`),
].join(',')

/** The person's own clips: add (pick or drop), preview, rename, remove. */
function Mine({ settings, setNote }: { settings: ChimeSettings; setNote(note: string | null): void }) {
  const input = useRef<HTMLInputElement>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [over, setOver] = useState(false)
  const depth = useRef(0)
  const carriesFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files')

  const add = async (file: File) => {
    setNote(null)
    const ext = file.name.includes('.') ? file.name.slice(file.name.lastIndexOf('.') + 1).toLowerCase() : ''
    if (!(FILE_LIMITS.exts as readonly string[]).includes(ext)) {
      setNote(`Sounds are ${FILE_LIMITS.exts.join(', ')} files. “${file.name}” is not one.`)
      return
    }
    if (file.size > FILE_LIMITS.bytes) {
      setNote(`Sounds are at most ${FILE_LIMITS.bytes / 1024 / 1024} MB. “${file.name}” is ${(file.size / 1024 / 1024).toFixed(1)} MB.`)
      return
    }
    try {
      const bytes = await file.arrayBuffer()
      const ctx = audio()
      if (!ctx) throw new Error('This window cannot read sound files.')
      const decoded = await ctx.decodeAudioData(bytes.slice(0)).catch(() => null)
      if (!decoded) throw new Error(`“${file.name}” could not be read as a sound.`)
      if (decoded.duration > FILE_LIMITS.seconds) {
        throw new Error(`Sounds are at most ${FILE_LIMITS.seconds} seconds. “${file.name}” is ${decoded.duration.toFixed(1)}.`)
      }
      await addSound(file.name, bytes, decoded.duration)
      setNote(`Added “${file.name}”.`)
    } catch (error) {
      setNote(said(error))
    }
  }

  return (
    <section
      className={`flex min-w-0 flex-col gap-2 rounded-lg ${over ? 'ring-primary bg-accent/40 ring-2 ring-offset-4' : ''}`}
      data-chime-files
      data-dropping={over ? '' : undefined}
      onDragEnter={(event) => {
        if (!carriesFiles(event)) return
        event.preventDefault()
        depth.current += 1
        setOver(true)
      }}
      onDragOver={(event) => {
        if (!carriesFiles(event)) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
      }}
      onDragLeave={(event) => {
        if (!carriesFiles(event)) return
        depth.current = Math.max(0, depth.current - 1)
        if (depth.current === 0) setOver(false)
      }}
      onDrop={(event) => {
        if (!carriesFiles(event)) return
        event.preventDefault()
        depth.current = 0
        setOver(false)
        const file = event.dataTransfer.files?.[0]
        if (file) void add(file)
      }}
    >
      <div className="flex min-w-0 items-center justify-between gap-3">
        <h4 className="text-sm font-medium">Your sounds</h4>
        <Button type="button" size="sm" variant="outline" className="gap-1.5" onClick={() => input.current?.click()}>
          <Upload className="size-3.5" aria-hidden />
          Add a sound…
        </Button>
        <input
          ref={input}
          type="file"
          accept={SOUND_ACCEPT}
          hidden
          aria-label="Add a sound"
          onChange={(event) => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (file) void add(file)
          }}
        />
      </div>
      <p className="text-muted-foreground text-xs" data-chime-drop-hint>
        {over ? 'Drop it to add the sound' : 'or drop a sound file here'}
      </p>
      <p className="text-muted-foreground text-xs leading-relaxed">
        Your own clips ({FILE_LIMITS.exts.join(', ')}; up to {FILE_LIMITS.seconds} seconds and {FILE_LIMITS.bytes / 1024 / 1024} MB). They are copied to this computer and nowhere else, and Kehikot ships none.
      </p>
      {settings.files.length ? (
        <ul className="divide-y rounded-lg border px-4">
          {settings.files.map((file) => (
            <li key={file.id} className="flex min-w-0 flex-wrap items-center gap-2 py-2.5" data-chime-file={file.id}>
              {editing === file.id ? (
                <form
                  className="flex min-w-0 flex-1 items-center gap-2"
                  onSubmit={(event) => {
                    event.preventDefault()
                    const next = name.trim()
                    setEditing(null)
                    if (next && next !== file.name) void renameSound(file.id, next).catch((error) => setNote(said(error)))
                  }}
                >
                  <Input value={name} onChange={(event) => setName(event.target.value)} aria-label={`Name for ${file.name}`} maxLength={FILE_LIMITS.nameMax} autoFocus className="h-8" />
                  <Button type="submit" size="sm">
                    Save name
                  </Button>
                </form>
              ) : (
                <span className="min-w-0 flex-1 truncate text-sm" title={file.name}>
                  {file.name} <span className="text-muted-foreground text-xs">{file.seconds.toFixed(1)} s</span>
                </span>
              )}
              <Preview sound={{ type: 'file', id: file.id }} kind="attention" settings={settings} label={file.name} />
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label={`Rename ${file.name}`}
                onClick={() => {
                  setName(file.name)
                  setEditing(file.id)
                }}
              >
                <Pencil className="size-3.5" aria-hidden />
              </Button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label={`Remove ${file.name}`}
                onClick={() => {
                  setNote(null)
                  removeSound(file.id).then(
                    (answer) => {
                      forgetClip(file.id)
                      setNote(answer.said || `Removed “${file.name}”.`)
                    },
                    (error) => setNote(said(error)),
                  )
                }}
              >
                <Trash2 className="size-3.5" aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}

/**
 * A sound for each event a module declares (protocol 2.31.0), grouped by the
 * module's registered name and named by the event's own `says` — as text.
 * Nothing set plays the sound the module's manifest names for it, else the kind's;
 * "Same as …" chooses the kind's. Drawn only when some module declares one.
 */
function Events({ settings, modules, run }: { settings: ChimeSettings; modules: readonly ModuleRef[]; run(work: Promise<unknown>): void }) {
  const id = useId()
  const declaring = modules.filter((one) => one.events?.length)
  if (!declaring.length) return null
  return (
    <section className="flex min-w-0 flex-col gap-2" aria-labelledby={`${id}-events`} data-chime-events>
      <h4 id={`${id}-events`} className="text-sm font-medium">
        A sound for each event
      </h4>
      <p className="text-muted-foreground text-xs leading-relaxed">
        Some modules name what they tell you, like “Research complete”. Each can have its own sound, played as written; otherwise it plays its kind’s.
      </p>
      {declaring.map((module) => (
        <div key={module.id} className="flex min-w-0 flex-col gap-1" data-chime-event-module={module.id}>
          <p className="text-muted-foreground text-xs font-medium">{module.name}</p>
          <ul className="divide-y rounded-lg border px-4">
            {module.events!.map((event) => {
              const kind = kindOf({ state: event.state, priority: 'normal', origin: 'activity' }) ?? 'done'
              const chosen = settings.events[module.id]?.[event.id] ?? eventDefault(event.sound)
              const playing = chosen.type === 'kind' ? settings.sounds[kind] : chosen
              const field = `${id}-${module.id}-${event.id}`
              return (
                <li key={event.id} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 py-3" data-chime-event={event.id}>
                  <div className="min-w-32 flex-1 space-y-0.5">
                    <Label htmlFor={field} className="text-sm">
                      {event.says}
                    </Label>
                    <p className="text-muted-foreground text-xs">A kind of “{KIND_WORDS[kind].label}”.</p>
                  </div>
                  <div className="w-44 shrink-0">
                    <NativeSelect
                      id={field}
                      value={eventChoiceOf(chosen)}
                      onChange={(change) => {
                        const sound = eventSoundOfChoice(change.target.value)
                        if (sound) run(postChime({ events: { [module.id]: { [event.id]: sound } } }))
                      }}
                    >
                      <optgroup label="Its kind">
                        <NativeSelectOption value="kind">Same as {KIND_WORDS[kind].label}</NativeSelectOption>
                      </optgroup>
                      <Options settings={settings} />
                    </NativeSelect>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="shrink-0 gap-1.5"
                    aria-label={`Preview ${module.name} ${event.says}`}
                    onClick={() => void playSound(playing, kind, settings, chosen.type !== 'kind')}
                  >
                    <Play className="size-3.5" aria-hidden />
                    Preview
                  </Button>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </section>
  )
}

/** A different sound for one module's kind, by the module's registered name. */
function Overrides({ settings, modules, run }: { settings: ChimeSettings; modules: readonly ModuleRef[]; run(work: Promise<unknown>): void }) {
  const nameOf = (id: string) => modules.find((one) => one.id === id)?.name ?? id
  const rows = Object.entries(settings.modules).flatMap(([module, set]) => KINDS.flatMap((kind) => (set[kind] ? [{ module, kind, sound: set[kind] }] : [])))
  const [module, setModule] = useState('')
  const [kind, setKind] = useState<Kind>('attention')
  const free = modules.filter((one) => one.id)

  return (
    <section className="flex min-w-0 flex-col gap-2" data-chime-modules>
      <h4 className="text-sm font-medium">A sound for one module</h4>
      <p className="text-muted-foreground text-xs leading-relaxed">For example, one module’s “Needs you” can play a different chime from the rest.</p>
      {rows.length ? (
        <ul className="divide-y rounded-lg border px-4">
          {rows.map(({ module: id, kind: k, sound }) => (
            <li key={`${id}:${k}`} className="flex min-w-0 flex-wrap items-center gap-2 py-2.5" data-chime-module={id} data-chime-module-kind={k}>
              <span className="min-w-32 flex-1 text-sm">
                {nameOf(id)} <span className="text-muted-foreground text-xs">· {KIND_WORDS[k].label}</span>
              </span>
              <div className="w-40 shrink-0">
                <NativeSelect
                  aria-label={`Sound for ${nameOf(id)}, ${KIND_WORDS[k].label}`}
                  value={choiceOf(sound!)}
                  onChange={(event) => {
                    const next = soundOfChoice(event.target.value)
                    if (next) run(postChime({ modules: { [id]: { [k]: next } } }))
                  }}
                >
                  <Options settings={settings} />
                </NativeSelect>
              </div>
              <Preview sound={sound!} kind={k} settings={settings} label={`${nameOf(id)} ${KIND_WORDS[k].label}`} />
              <Button type="button" size="icon" variant="ghost" aria-label={`Remove the sound for ${nameOf(id)}, ${KIND_WORDS[k].label}`} onClick={() => run(postChime({ modules: { [id]: { [k]: null } } }))}>
                <Trash2 className="size-3.5" aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {free.length ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <div className="w-44">
            <NativeSelect aria-label="Module" value={module} onChange={(event) => setModule(event.target.value)}>
              <NativeSelectOption value="">Choose a module…</NativeSelectOption>
              {free.map((one) => (
                <NativeSelectOption key={one.id} value={one.id}>
                  {one.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          <div className="w-32">
            <NativeSelect aria-label="Kind" value={kind} onChange={(event) => setKind(event.target.value as Kind)}>
              {KINDS.map((one) => (
                <NativeSelectOption key={one} value={one}>
                  {KIND_WORDS[one].label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="gap-1.5"
            disabled={!module}
            onClick={() => {
              run(postChime({ modules: { [module]: { [kind]: settings.modules[module]?.[kind] ?? settings.sounds[kind] } } }))
              setModule('')
            }}
          >
            <Plus className="size-3.5" aria-hidden />
            Add a sound for a module
          </Button>
        </div>
      ) : null}
    </section>
  )
}

/** My chime: three to five notes of a friendly scale, a tempo, a wave and a volume. */
function Maker({ settings, run }: { settings: ChimeSettings; run(work: Promise<unknown>): void }) {
  const id = useId()
  const [draft, setDraft] = useState<Tune>(settings.custom)
  useEffect(() => setDraft(settings.custom), [settings.custom])
  const valid = validTune(draft)
  const set = (patch: Partial<Tune>) => setDraft((was) => ({ ...was, ...patch }))
  const setSlot = (at: number, value: number | null) => set({ notes: draft.notes.map((one, i) => (i === at ? value : one)) })
  const same = JSON.stringify(draft) === JSON.stringify(settings.custom)

  return (
    <section className="flex min-w-0 flex-col gap-3" data-chime-maker>
      <h4 className="text-sm font-medium">Make a chime</h4>
      <p className="text-muted-foreground text-xs leading-relaxed">
        Pick {LIMITS.notesMin} to {LIMITS.notesMax} notes; every note is from one friendly scale, so any choice sounds pleasant. “Finished” and “Notice” play a softer, lower, shorter form of it, and “Urgent” plays it twice.
      </p>
      <div className="flex min-w-0 flex-wrap items-end gap-2">
        {draft.notes.map((note, at) => (
          <div key={at} className="w-20 space-y-1">
            <Label htmlFor={`${id}-n${at}`} className="text-muted-foreground text-xs">
              Note {at + 1}
            </Label>
            <NativeSelect id={`${id}-n${at}`} value={note === null ? 'rest' : String(note)} onChange={(event) => setSlot(at, event.target.value === 'rest' ? null : Number(event.target.value))}>
              <NativeSelectOption value="rest">Rest</NativeSelectOption>
              {SCALE.map((one) => (
                <NativeSelectOption key={one} value={String(one)}>
                  {noteName(one)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
        ))}
        <Button type="button" size="sm" variant="outline" disabled={draft.notes.length >= LIMITS.notesMax} onClick={() => set({ notes: [...draft.notes, 72] })}>
          Add a note
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={draft.notes.length <= LIMITS.notesMin} onClick={() => set({ notes: draft.notes.slice(0, -1) })}>
          Remove a note
        </Button>
      </div>
      <div className="grid min-w-0 gap-3 sm:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor={`${id}-tempo`} className="text-xs">
            Tempo: {draft.tempo} beats a minute
          </Label>
          <input id={`${id}-tempo`} type="range" className="w-full" min={LIMITS.tempoMin} max={LIMITS.tempoMax} step={5} value={draft.tempo} onChange={(event) => set({ tempo: Number(event.target.value) })} />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${id}-wave`} className="text-xs">
            Sound
          </Label>
          <NativeSelect id={`${id}-wave`} value={draft.wave} onChange={(event) => set({ wave: event.target.value as Wave })}>
            {WAVES.map((one) => (
              <NativeSelectOption key={one} value={one}>
                {WAVE_WORDS[one]}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${id}-volume`} className="text-xs">
            Volume: {Math.round(draft.volume * 100)}%
          </Label>
          <input id={`${id}-volume`} type="range" className="w-full" min={LIMITS.volumeMin * 100} max={LIMITS.volumeMax * 100} step={5} value={Math.round(draft.volume * 100)} onChange={(event) => set({ volume: Number(event.target.value) / 100 })} />
        </div>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="outline" className="gap-1.5" disabled={!valid} onClick={() => valid && void playSound({ type: 'custom' }, 'attention', { ...settings, custom: valid })}>
          <Play className="size-3.5" aria-hidden />
          Preview
        </Button>
        <Button type="button" size="sm" disabled={!valid || same} onClick={() => valid && run(postChime({ custom: valid }))}>
          Save as “My chime”
        </Button>
        <span className="text-muted-foreground text-xs" data-chime-length>
          {valid ? `${durationMs(valid)} ms` : 'Pick at least one note.'}
          {same ? ' · saved' : ' · not saved yet'}
        </span>
      </div>
    </section>
  )
}

/** The Inbox panel's mute button: a bell, or a crossed-out bell while muted, pressed state in words and shape. */
export function MuteChime({ className }: { className?: string }) {
  const { on } = useChimeSettings()
  const [failed, setFailed] = useState(false)
  const label = on ? 'Mute chime' : 'Unmute chime'
  return (
    <Hint label={label} side="bottom" align="end">
    <Button
      type="button"
      size="icon"
      variant="ghost"
      className={className}
      aria-label={label}
      aria-pressed={!on}
      data-chime-mute={on ? 'off' : 'on'}
      data-failed={failed ? '' : undefined}
      onClick={() => {
        setFailed(false)
        setMuted(on).catch(() => setFailed(true))
      }}
    >
      {on ? <Bell className="size-4" aria-hidden /> : <BellOff className="size-4" aria-hidden />}
    </Button>
    </Hint>
  )
}
