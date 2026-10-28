import { worstActivity, type ActivityItem, type ActivityState } from 'kehikot-module-protocol'

/**
 * What the modules say they are doing (protocol 1.5.0, `activity.set`): the
 * words, the marks and the places. The record itself — the lists, their life,
 * seen and dismissed — is the Inbox (`host/inbox.ts`, kept by `server/inbox.ts`);
 * what is here is what draws a mark from it.
 *
 * Pure, and importable from both halves like `parts.ts`; nothing here names a
 * module.
 *
 * ## Marks
 *
 * A container's mark is the worst state among the module's LIVE items
 * (`attention` over `working` over `done`; a `done` that was seen, and an item
 * that was put away, are not live). An item's place marks the epic it names,
 * the parts it names, and the kehikko it names.
 *
 * ## What came before the Inbox
 *
 * The seen set and the set of notices already told were kept in this
 * browser's storage. They are read once (`readSeen`, `readDerived`) and handed
 * to the server, which holds them from then on; the keys are then removed.
 */

export interface HeldItem extends ActivityItem {
  module: string
  entered: number
}

/** The words each state carries, for the tooltip and assistive technology. Never colour alone. */
export const ACTIVITY_WORDS: Record<ActivityState, string> = {
  attention: 'needs your attention',
  done: 'finished',
  working: 'working',
}

const RANK: Record<ActivityState, number> = { attention: 3, working: 2, done: 1 }

/** Where the person is: the open epic, the picked parts (none is the whole epic) and the open kehikko's key. */
export interface Where {
  epic: string | null
  parts: readonly string[]
  kehikko: string | null
}

type Place = NonNullable<ActivityItem['place']>

/** Whether a place is where the person is: every piece it names is open. A place naming nothing is never "here". */
export function placeOpened(place: Place | undefined, at: Where): boolean {
  if (!place) return false
  const named = place.epic !== undefined || (place.parts?.length ?? 0) > 0 || place.kehikko !== undefined
  if (!named) return false
  if (place.epic !== undefined && place.epic !== at.epic) return false
  if (place.parts?.length && at.parts.length && !place.parts.every((id) => at.parts.includes(id))) return false
  if (place.kehikko !== undefined && place.kehikko !== at.kehikko) return false
  return true
}

const worst = (items: Iterable<HeldItem>): ActivityState | null => worstActivity([...items].map((one) => one.state))

/** A container's mark: the worst of that module's items. */
export function moduleMark(items: readonly HeldItem[], module: string): ActivityState | null {
  return worst(items.filter((one) => one.module === module))
}

/** Each epic that holds something, with its worst state. An item naming a part of an epic marks that epic through its own `epic`. */
export function epicMarks(
  items: readonly HeldItem[],
  open: string | null,
  partsOf: (epic: string) => readonly string[] = () => [],
): Map<string, ActivityState> {
  const out = new Map<string, ActivityState>()
  const add = (epic: string, state: ActivityState) => {
    const was = out.get(epic)
    if (!was || RANK[state] > RANK[was]) out.set(epic, state)
  }
  for (const item of items) {
    const { place } = item
    if (!place) continue
    if (place.epic !== undefined) add(place.epic, item.state)
    else if (place.parts?.length && open !== null) {
      /* No epic named but parts: they are the open epic's, or the epic that
         has such a part. */
      const ids = partsOf(open)
      if (place.parts.some((id) => ids.includes(id))) add(open, item.state)
    }
  }
  return out
}

/** The open epic's parts that hold something. An item naming another epic marks none of these. */
export function partMarks(items: readonly HeldItem[], open: string | null): Map<string, ActivityState> {
  const out = new Map<string, ActivityState>()
  for (const item of items) {
    const { place } = item
    if (!place?.parts?.length) continue
    if (place.epic !== undefined && place.epic !== open) continue
    for (const id of place.parts) {
      const was = out.get(id)
      if (!was || RANK[item.state] > RANK[was]) out.set(id, item.state)
    }
  }
  return out
}

/** Each kehikko (by key) that holds something. */
export function kehikkoMarks(items: readonly HeldItem[]): Map<string, ActivityState> {
  const out = new Map<string, ActivityState>()
  for (const item of items) {
    const key = item.place?.kehikko
    if (key === undefined) continue
    const was = out.get(key)
    if (!was || RANK[item.state] > RANK[was]) out.set(key, item.state)
  }
  return out
}

/** The worst of the marks of every key except `except`. */
export function worstOther(marks: ReadonlyMap<string, ActivityState>, except: string | null): ActivityState | null {
  return worstActivity([...marks].filter(([key]) => key !== except).map(([, state]) => state))
}

/** The menu's order: worst first, then the most recently entered. */
export function ordered(items: readonly HeldItem[]): HeldItem[] {
  return [...items].sort((a, b) => RANK[b.state] - RANK[a.state] || b.entered - a.entered)
}

/** How many items need the person: the menu badge. */
export const attentionCount = (items: readonly HeldItem[]): number =>
  items.filter((one) => one.state === 'attention').length

/** What names the place, in words: epic · parts · kehikko. Names the page does not know fall back to the id. */
export interface Namer {
  epic(slug: string): string | null
  part(epic: string | null, id: string): string | null
  kehikko(key: string): string | null
}

export function placeWords(place: Place | undefined, names: Namer): string {
  if (!place) return ''
  const out: string[] = []
  if (place.epic !== undefined) out.push(names.epic(place.epic) ?? place.epic)
  if (place.parts?.length) {
    out.push(place.parts.map((id) => names.part(place.epic ?? null, id) ?? id).join(', '))
  }
  if (place.kehikko !== undefined) out.push(names.kehikko(place.kehikko) ?? place.kehikko)
  return out.join(' · ')
}

/**
 * The place in two lines for the menu: `here` is the specific part (picked
 * parts · kehikko), which tells two rows apart, and `epic` is the long title
 * that may be cut. `placeWords` is these two joined, the other way round.
 */
export function placeSplit(place: Place | undefined, names: Namer): { epic: string; here: string } {
  if (!place) return { epic: '', here: '' }
  const here: string[] = []
  if (place.parts?.length) here.push(place.parts.map((id) => names.part(place.epic ?? null, id) ?? id).join(', '))
  if (place.kehikko !== undefined) here.push(names.kehikko(place.kehikko) ?? place.kehikko)
  return {
    epic: place.epic !== undefined ? (names.epic(place.epic) ?? place.epic) : '',
    here: here.join(' · '),
  }
}

/** A title for a mark: the state's words, and the label when there is one. */
export const markWords = (state: ActivityState, what?: string): string =>
  what ? `${what} — ${ACTIVITY_WORDS[state]}` : ACTIVITY_WORDS[state]

/* ---- what this browser kept before the Inbox held it ---- */

/** `{ '<module>\u0000<id>': entered }` of the `done` items a person was told of. */
export type Seen = Readonly<Record<string, number>>
/** `{ '<module>\u0000<id>\u0000<state>': entered }` of the last notice told for it. */
export type Derived = Readonly<Record<string, number>>

const SEEN_PREFIX = 'kehikot.activity.seen.'
const DERIVED_PREFIX = 'kehikot.activity.derived.'

function numbers(text: string | null | undefined): Record<string, number> {
  try {
    if (!text) return {}
    const value: unknown = JSON.parse(text)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).filter(([, v]) => typeof v === 'number' && Number.isFinite(v)),
    ) as Record<string, number>
  } catch {
    return {}
  }
}

/** The two sets this browser kept for a project, or null when it kept neither. */
export function storedFor(
  storage: Pick<Storage, 'getItem'> | null,
  project: number,
): { seen: Seen; told: Derived } | null {
  try {
    const seen = storage?.getItem(`${SEEN_PREFIX}${project}`)
    const told = storage?.getItem(`${DERIVED_PREFIX}${project}`)
    if (seen == null && told == null) return null
    return { seen: numbers(seen), told: numbers(told) }
  } catch {
    return null
  }
}

/** Take the keys away, once the server holds what they said. */
export function clearStored(storage: Pick<Storage, 'removeItem'> | null, project: number): void {
  try {
    storage?.removeItem(`${SEEN_PREFIX}${project}`)
    storage?.removeItem(`${DERIVED_PREFIX}${project}`)
  } catch {
    /* A browser that will not remove it asks the server again next load; the server takes it once. */
  }
}

/** What the server is told for `read_canvas`: one row per item of the project, with whether it was seen. */
export interface ActivityRow {
  module: string
  /** The module's name, for a person; the page fills it in when it posts. */
  name?: string
  id: string
  state: ActivityState
  label: string
  place: string
  detail?: string
  seen: boolean
  /** The module's own sense of how pressing it is, when it said so. */
  priority?: 'urgent' | 'normal' | 'low'
  /** The module's named event (protocol 2.31.0), when it declared the one the item names. */
  event?: { id: string; says: string }
  /** When it entered its state, in ms since the epoch. */
  entered?: number
}

const DETAIL_MAX = 80
const MESSAGE_MAX = 400

/**
 * The line for a derived notice, in the format the Claude module sent for the
 * same two moments: the state in words, the label in quotes, the place in
 * words. Null when it cannot be filed — the format files every line under an
 * epic, and neither the item nor the open canvas names one.
 */
export function noticeFor(
  item: HeldItem,
  at: Where,
  names: Namer,
): {
  epic: string
  message: string
  level: 'attention' | 'done'
  refs: []
  place?: { epic: string; parts?: string[]; kehikko?: string }
} | null {
  if (item.state === 'working') return null
  const epic = item.place?.epic ?? at.epic
  if (!epic) return null
  const what = item.state === 'done' ? 'Finished' : 'Waiting for you'
  const where = placeWords(item.place, names)
  const detail = item.detail?.replace(/\s+/g, ' ').trim()
  let message = `${what}: \u201c${item.label}\u201d${where ? ` \u2014 ${where}` : ''}`
  if (detail && detail.length <= DETAIL_MAX) message += `. ${detail}`
  if (message.length > MESSAGE_MAX) message = `${message.slice(0, MESSAGE_MAX - 1)}\u2026`
  const place = item.place
  const parts = place?.parts
  return {
    epic,
    message,
    level: item.state === 'done' ? 'done' : 'attention',
    refs: [],
    ...(place?.epic !== undefined
      ? {
          place: {
            epic: place.epic,
            ...(parts?.length && parts.length <= 16 ? { parts: [...parts] } : {}),
            ...(place.kehikko !== undefined ? { kehikko: place.kehikko } : {}),
          },
        }
      : {}),
  }
}
