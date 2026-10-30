import { z } from 'zod'

import type { Place } from './jump.ts'

/**
 * Pinned places: the person's own quick way back to a place.
 *
 * The person's words: "Next to the Project > Epic > Parts > Kehikko would be
 * pinned instances for quick access. Make it so users can also unpin from that
 * dropdown, and put next to it the pin-this-kehikko button."
 *
 * A PLACE is what the bar's breadcrumb shows: a project, a kehikko of it, an
 * epic (or "All epics") and the parts picked in it. A pin remembers one, and
 * picking it goes there the way the person's own pickers go (`goPlace` in
 * `App.tsx`, the path an agent's `jump` and Go back take too), including into
 * another project with the calm switch.
 *
 * Pins are this person's on this machine and span projects, so they live in
 * `frame.sqlite` (`server/pinnedPlaces.ts`), never in a project. Only the page
 * pins, unpins and orders them (`POST /host/pinned-places`, `PAGE_ONLY`); an
 * agent reads them in `my_place` and can `jump` to one when asked, and no
 * door tool changes them.
 *
 * Everything that decides is here, pure, and shared by the server (what a
 * stored pin resolves to now) and the page (the label, whether the place on
 * screen is pinned, the order after a move). `test/pinned-places.test.ts` is
 * its table.
 */

/** The most pins kept. More than anyone scans in a menu; a cap so a loop cannot fill the database. */
export const PINNED_MAX = 50

/** Where a pin goes. `scope: 'project'` is "All epics": then `epic` is null and `parts` empty. */
export interface PinTarget {
  project: number
  /** The kehikko's key; null when the place had none open. */
  kehikko: string | null
  epic: string | null
  scope: 'epic' | 'project'
  parts: string[]
}

/** The names a pin was made with, kept so a pin whose things are gone can still say what it was. */
export interface PinNames {
  project: string
  kehikko: string | null
  epic: string | null
  /** Each part's heading, by id. */
  parts: Record<string, string>
}

/** One pin as the page and the door read it. */
export interface PinnedPlace {
  id: number
  /** Where picking it goes now: a part that is gone is left out. */
  target: PinTarget
  /** "CS-DEGREE › thesis › methods · Wide". Text, never markup. */
  label: string
  /** Why it cannot be gone to (project, kehikko, epic or every part gone), or null. Greyed, and still unpinnable. */
  stale: string | null
  /** A sentence when some parts are gone and the rest are kept, or null. */
  note: string | null
}

/** The words. Text only; no module and no vendor. */
export const PINNED_SAYS = {
  menu: 'Pinned places',
  empty: 'Pin a place to come back to it in one click.',
  pin: 'Pin this place',
  unpin: 'Unpin this place',
  unpinRow: (label: string) => `Unpin ${label}`,
  upRow: (label: string) => `Move ${label} up`,
  downRow: (label: string) => `Move ${label} down`,
  allEpics: 'All epics',
  noEpic: 'no epic',
  projectGone: (name: string) => `${name} is no longer a project here.`,
  folderGone: (name: string) => `The folder of ${name} is gone.`,
  kehikkoGone: (name: string) => `The kehikko ${name} is gone.`,
  epicGone: (name: string) => `The epic ${name} is gone.`,
  allPartsGone: (names: readonly string[]) => `${listed(names)} ${names.length === 1 ? 'is' : 'are'} gone from the epic.`,
  somePartsGone: (names: readonly string[]) =>
    `${listed(names)} ${names.length === 1 ? 'is' : 'are'} gone from the epic; the rest are kept.`,
  noPlace: 'Open a project to pin a place.',
} as const

function listed(names: readonly string[]): string {
  if (names.length <= 1) return names.join('')
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/** The shortcut that pins or unpins the place on screen: Alt+Shift+P (by `code`). Alt+Shift+N is the Inbox's. */
export const PIN_CHORD = { code: 'KeyP', said: 'Alt+Shift+P', aria: 'Alt+Shift+P' } as const

/** Whether a key press is the pin chord. */
export function isPinChord(event: { altKey: boolean; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; code: string }): boolean {
  return event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey && event.code === PIN_CHORD.code
}

const SEP = ' › '

/** The label of a place, from its names: "CS-DEGREE › thesis › methods, results · Wide". */
export function labelOf(target: Pick<PinTarget, 'scope' | 'epic' | 'parts' | 'kehikko'>, names: PinNames): string {
  const crumbs = [names.project]
  if (target.scope === 'project') crumbs.push(PINNED_SAYS.allEpics)
  else if (target.epic !== null) {
    crumbs.push(names.epic ?? target.epic)
    if (target.parts.length) crumbs.push(target.parts.map((id) => names.parts[id] ?? id).join(', '))
  }
  const kehikko = target.kehikko === null ? '' : ` · ${names.kehikko ?? target.kehikko}`
  return `${crumbs.join(SEP)}${kehikko}`
}

const sorted = (parts: readonly string[]) => [...new Set(parts)].sort()

/** A target in its one spelling: parts unique and sorted, none on "All epics" or with no epic. */
export function normalTarget(target: PinTarget): PinTarget {
  const all = target.scope === 'project'
  return {
    project: target.project,
    kehikko: target.kehikko,
    epic: all ? null : target.epic,
    scope: all ? 'project' : 'epic',
    parts: all || target.epic === null ? [] : sorted(target.parts),
  }
}

/** Whether two targets are the same place. */
export function sameTarget(a: PinTarget, b: PinTarget): boolean {
  const x = normalTarget(a)
  const y = normalTarget(b)
  return x.project === y.project && x.kehikko === y.kehikko && x.scope === y.scope && x.epic === y.epic && x.parts.join('+') === y.parts.join('+')
}

/** The place on screen as a pin's target, or null with no project open. */
export function targetOf(place: Place | null): PinTarget | null {
  if (!place) return null
  return normalTarget({ project: place.project, kehikko: place.kehikko, epic: place.epic, scope: place.scope === 'project' ? 'project' : 'epic', parts: place.parts })
}

/** Where a pin takes the person, as `goPlace` takes it: no step. */
export function placeOf(target: PinTarget): Place {
  return {
    project: target.project,
    kehikko: target.kehikko,
    epic: target.epic,
    ...(target.scope === 'project' ? { scope: 'project' as const } : {}),
    parts: [...target.parts],
    step: null,
  }
}

/** The pin of the place on screen, or null when it is not pinned. */
export function pinnedHere(pins: readonly PinnedPlace[], here: PinTarget | null): PinnedPlace | null {
  if (!here) return null
  return pins.find((pin) => sameTarget(pin.target, here)) ?? null
}

/** The order after moving one pin by one row (`by` -1 up, 1 down); the same order at an end. */
export function movedBy(ids: readonly number[], id: number, by: -1 | 1): number[] {
  const from = ids.indexOf(id)
  const to = from + by
  if (from < 0 || to < 0 || to >= ids.length) return [...ids]
  const out = [...ids]
  ;[out[from], out[to]] = [out[to]!, out[from]!]
  return out
}

/** The order after dragging one pin onto the row of another: it takes that row, the rest shift. */
export function movedOnto(ids: readonly number[], id: number, onto: number): number[] {
  const from = ids.indexOf(id)
  const to = ids.indexOf(onto)
  if (from < 0 || to < 0 || from === to) return [...ids]
  const out = ids.filter((one) => one !== id)
  out.splice(to, 0, id)
  return out
}

/** What is known about the place a stored pin names, now. Null for what is not there. */
export interface PinFacts {
  /** The project, or null when no project of this host has that id (or permanent id). */
  project: { id: number; name: string; missing: boolean } | null
  /** The project's kehikot, by key. */
  kehikot: ReadonlyMap<string, string>
  /** The project's epics (slug → title, or the slug), or null when they cannot be read. */
  epics: ReadonlyMap<string, string> | null
  /** The pinned epic's parts (id → heading), or null when it has none or it is gone. */
  parts: ReadonlyMap<string, string> | null
}

/** A pin as stored. */
export interface StoredPin {
  id: number
  target: PinTarget
  names: PinNames
}

/**
 * What a stored pin is now. A project, kehikko or epic that is gone makes it
 * stale, said with the reason; a part that is gone is left out, and when every
 * part is, it is stale too. Names come from what is there now, and from what
 * was kept for what is gone.
 */
export function resolvePin(stored: StoredPin, facts: PinFacts): PinnedPlace {
  const t = normalTarget(stored.target)
  const names: PinNames = { ...stored.names, parts: { ...stored.names.parts } }
  const out = (target: PinTarget, stale: string | null, note: string | null): PinnedPlace => ({
    id: stored.id,
    target,
    label: labelOf(t, names),
    stale,
    note,
  })
  if (!facts.project) return out(t, PINNED_SAYS.projectGone(names.project), null)
  names.project = facts.project.name
  const target = { ...t, project: facts.project.id }
  if (t.kehikko !== null) {
    const kehikko = facts.kehikot.get(t.kehikko)
    if (kehikko !== undefined) names.kehikko = kehikko
  }
  if (t.epic !== null && facts.epics) {
    const epic = facts.epics.get(t.epic)
    if (epic !== undefined) names.epic = epic
  }
  for (const id of t.parts) {
    const heading = facts.parts?.get(id)
    if (heading !== undefined) names.parts[id] = heading
  }
  if (facts.project.missing) return out(target, PINNED_SAYS.folderGone(names.project), null)
  if (t.kehikko !== null && !facts.kehikot.has(t.kehikko)) return out(target, PINNED_SAYS.kehikkoGone(names.kehikko ?? t.kehikko), null)
  if (t.epic !== null && facts.epics && !facts.epics.has(t.epic)) return out(target, PINNED_SAYS.epicGone(names.epic ?? t.epic), null)
  const gone = t.parts.filter((id) => !facts.parts?.has(id))
  if (!gone.length) return out(target, null, null)
  const goneNames = gone.map((id) => names.parts[id] ?? id)
  if (gone.length === t.parts.length) return out(target, PINNED_SAYS.allPartsGone(goneNames), null)
  return out({ ...target, parts: t.parts.filter((id) => !gone.includes(id)) }, null, PINNED_SAYS.somePartsGone(goneNames))
}

/* ---- The wire ---- */

const targetSchema = z
  .object({
    project: z.number().int().positive(),
    kehikko: z.string().min(1).max(200).nullable(),
    epic: z.string().min(1).max(200).nullable(),
    scope: z.enum(['epic', 'project']),
    parts: z.array(z.string().min(1).max(200)).max(64),
  })
  .strict()

/** A change the page asks for: pin a place, unpin one, or put them in an order (every id, first first). */
export const pinEditSchema = z.union([
  z.object({ pin: targetSchema }).strict(),
  z.object({ unpin: z.number().int().positive() }).strict(),
  z.object({ order: z.array(z.number().int().positive()).max(PINNED_MAX) }).strict(),
])
export type PinEdit = z.infer<typeof pinEditSchema>

export const pinnedPlaceSchema = z.object({
  id: z.number(),
  target: targetSchema,
  label: z.string(),
  stale: z.string().nullable(),
  note: z.string().nullable(),
})

const answerSchema = z.object({ pinned: z.array(pinnedPlaceSchema) })

/** The pins, first first. */
export async function fetchPinned(signal?: AbortSignal): Promise<PinnedPlace[]> {
  const response = await fetch('/host/pinned-places', { signal, cache: 'no-store' })
  if (!response.ok) throw new Error(`pinned places: ${response.status}`)
  return answerSchema.parse(await response.json()).pinned
}

/** Make one change; answers the pins as they now are. */
export async function editPinned(edit: PinEdit): Promise<PinnedPlace[]> {
  const response = await fetch('/host/pinned-places', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(edit),
  })
  const body = (await response.json().catch(() => null)) as { pinned?: unknown; error?: unknown } | null
  if (!response.ok) throw new Error(typeof body?.error === 'string' ? body.error : `pinned places: ${response.status}`)
  return answerSchema.parse(body).pinned
}

/** The pins as lines for an agent: read-only, with what `jump` takes to go to each. */
export function pinnedWords(pins: readonly PinnedPlace[], projectOf: (id: number) => string | null): string {
  if (!pins.length) return 'The person has pinned no places.'
  const lines = pins.map((pin, i) => {
    const t = pin.target
    const go = [
      `project: ${JSON.stringify(projectOf(t.project) ?? String(t.project))}`,
      t.kehikko !== null ? `kehikko: ${JSON.stringify(t.kehikko)}` : null,
      t.epic !== null ? `epic: ${JSON.stringify(t.epic)}` : null,
      t.epic !== null ? `parts: ${JSON.stringify(t.parts)}` : null,
    ].filter(Boolean)
    const state = pin.stale ? ` — cannot be gone to: ${pin.stale}` : pin.note ? ` — ${pin.note}` : ''
    const how = pin.stale || t.scope === 'project' ? '' : ` (jump { ${go.join(', ')} })`
    return `${i + 1}. ${pin.label}${state}${how}`
  })
  return [
    'The person’s pinned places (theirs; read-only — jump to one only when they ask, and never pin or unpin):',
    ...lines,
  ].join('\n')
}
