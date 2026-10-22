import {
  LIMITS,
  locationLabel,
  locationStands,
  sharedLocationSchema,
  type CodeLocation,
  type LocationIntent,
  type LocationSetResult,
  type SharedLocation,
} from 'kehikot-module-protocol'

/**
 * Where in a change's code somebody is pointing, per kehikko (protocol 2.13.0).
 *
 * A module calls `location.set`; the canvas keeps the latest one for the kehikko
 * that is open, stamps who pointed (`by`, out of the registration, never the
 * frame's word) and when (`at`), and every container on that kehikko is told it
 * in `context.location`. Review points at the line a comment is about, Source
 * and Diff follow; "Comment on this line" in Source or Diff points back with
 * `intent: 'comment'`.
 *
 * ## It lives while its change is picked out
 *
 * The selection is the project's; a location points INSIDE one of the picked
 * refs. A location whose change nobody has picked is a pointer into something
 * no pane is showing, so it is not taken (`not-selected`) and is cleared when
 * the selection stops including its change (`stillStanding`). Moving to another
 * project clears every one, as it clears every passage.
 *
 * ## Where it is kept
 *
 * In the page, in memory, and in `sessionStorage` (per tab, survives a reload),
 * keyed by kehikko id — the page's view state, never `kehikot.json` and never
 * the canvases database: it is a fact about a screen. A restored one comes back
 * as `show`: "comment here" was a request made once, and a reload is not the
 * person asking again. The page also tells the server (`POST /host/location`,
 * held in memory per page) so `read_canvas` can say it.
 *
 * Pure, so `test/location.test.ts` is a table.
 */

/** The location on each kehikko, by kehikko id. */
export type Locations = Readonly<Record<number, SharedLocation>>

export const NO_LOCATIONS: Locations = {}

export interface Pointing {
  kehikko: number
  location: CodeLocation | null
  intent?: LocationIntent
  /** The module that pointed, out of its registration. */
  by: string
  /** When, ISO 8601. */
  at: string
  /** The project's selection now. */
  selection: readonly string[]
}

/**
 * A module pointed, or stopped pointing. The outcome is what `location.set`
 * answers; `next` is the same object when nothing changed.
 */
export function located(was: Locations, pointing: Pointing): { next: Locations; answer: LocationSetResult } {
  const { kehikko, location, intent, by, at, selection } = pointing
  if (location === null) {
    if (!(kehikko in was)) return { next: was, answer: { outcome: 'taken', why: '' } }
    const { [kehikko]: _gone, ...rest } = was
    return { next: rest, answer: { outcome: 'taken', why: '' } }
  }
  if (!locationStands(location, selection)) {
    return {
      next: was,
      answer: {
        outcome: 'not-selected',
        why: `${location.change} is not picked out in this project, so a place in it is not shown to anybody. Pick it with selection.set, then point again.`.slice(0, LIMITS.REASON),
      },
    }
  }
  const shared = sharedLocationSchema.safeParse({ ...location, intent: intent ?? 'show', by, at })
  if (!shared.success) return { next: was, answer: { outcome: 'declined', why: 'That location will not go into a context.' } }
  return { next: { ...was, [kehikko]: shared.data }, answer: { outcome: 'taken', why: '' } }
}

/**
 * Every location whose change is still picked out. The same object back when
 * none went, so a selection that moved without touching a location does not
 * cost every frame a context.
 */
export function stillStanding(was: Locations, selection: readonly string[]): Locations {
  const gone = Object.entries(was).filter(([, location]) => !locationStands(location, selection))
  if (!gone.length) return was
  const next: Record<number, SharedLocation> = {}
  for (const [id, location] of Object.entries(was)) if (locationStands(location, selection)) next[Number(id)] = location
  return next
}

/** The location on one kehikko, or null — and null whenever its change is not picked out. */
export function locationOn(locations: Locations, kehikko: number | null, selection: readonly string[]): SharedLocation | null {
  if (kehikko === null) return null
  const one = locations[kehikko]
  return one && locationStands(one, selection) ? one : null
}

/** The key in `sessionStorage`. */
export const LOCATIONS_KEY = 'kehikot.frame.locations.v1'
/** How many kehikot a tab remembers a location for. */
const KEPT_MAX = 64

/**
 * What this tab remembered, each read through the protocol's schema and
 * brought back as `show`. Anything that does not parse is dropped; storage that
 * refuses is nothing remembered.
 */
export function readLocations(storage: Pick<Storage, 'getItem'>): Locations {
  try {
    const raw = storage.getItem(LOCATIONS_KEY)
    if (!raw) return NO_LOCATIONS
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return NO_LOCATIONS
    const out: Record<number, SharedLocation> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>).slice(0, KEPT_MAX)) {
      const id = Number(key)
      if (!Number.isInteger(id) || id <= 0) continue
      const one = sharedLocationSchema.safeParse(value)
      if (one.success) out[id] = { ...one.data, intent: 'show' }
    }
    return out
  } catch {
    return NO_LOCATIONS
  }
}

export function writeLocations(storage: Pick<Storage, 'setItem' | 'removeItem'>, locations: Locations): void {
  try {
    const entries = Object.entries(locations).slice(-KEPT_MAX)
    if (!entries.length) storage.removeItem(LOCATIONS_KEY)
    else storage.setItem(LOCATIONS_KEY, JSON.stringify(Object.fromEntries(entries)))
  } catch {
    /* Private browsing, or storage refused: it lasts until the reload. */
  }
}

/** One line for `read_canvas`: what is pointed at, by whom, and why. */
export function locationWords(location: SharedLocation | null): string {
  if (!location) return 'code location: none — nobody is pointing at a line of a change on this kehikko.'
  const side = location.side === 'old' ? 'the old side (the change’s base)' : 'the new side (the change’s head)'
  const commit = location.commit ? ` at ${location.commit.slice(0, 12)}` : ''
  const why = location.intent === 'comment' ? 'asking for a review comment there' : 'to look there'
  const by = location.by ? `, pointed by ${location.by}` : ''
  /* The change and the path are a module's words: one line, quoted, so they cannot forge a line of the answer. */
  const flat = (text: string) => text.replace(/\s+/g, ' ')
  return `code location: ${flat(location.change)} "${flat(locationLabel(location))}" on ${side}${commit}${by}, ${why}. Every module on this kehikko is told it (context.location).`
}
