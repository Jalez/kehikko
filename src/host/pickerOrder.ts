/**
 * How the three pickers in the bar (projects, epics, kehikot) are ordered, and
 * when a place counts as visited. Pure: the page and the server both read it.
 *
 * The host keeps the truth (`server/pickerOrder.ts`, in `frame.sqlite`); the
 * page's copy is `pickerStore.ts`. Nothing here is written to the browser.
 */

export const SORTS = ['az', 'recent'] as const
export type PickerSort = (typeof SORTS)[number]
export type Picker = 'projects' | 'epics' | 'kehikot'
export const PICKERS: readonly Picker[] = ['projects', 'epics', 'kehikot']
export type PickerSorts = Record<Picker, PickerSort>

/**
 * Epics are already listed A to Z by the host, so that stays what a person who
 * never touches the switch sees. Projects and kehikot were listed in the order
 * they were added, which says nothing about which one is wanted now: "Recent"
 * is the better start for them.
 */
export const DEFAULT_SORTS: PickerSorts = { projects: 'recent', epics: 'az', kehikot: 'recent' }

/** What a stored or posted value says, with the default wherever it is not one of the two. */
export function sortsFrom(value: unknown): PickerSorts {
  const out = { ...DEFAULT_SORTS }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    for (const picker of PICKERS) {
      const one = (value as Record<string, unknown>)[picker]
      if ((SORTS as readonly unknown[]).includes(one)) out[picker] = one as PickerSort
    }
  }
  return out
}

/** A change of the choices — any subset of the three, each one of the two — or null for anything else. */
export function sortsPatched(was: PickerSorts, change: unknown): PickerSorts | null {
  if (typeof change !== 'object' || change === null || Array.isArray(change)) return null
  const entries = Object.entries(change)
  if (entries.length === 0) return null
  const next = { ...was }
  for (const [key, one] of entries) {
    if (!(PICKERS as readonly string[]).includes(key) || !(SORTS as readonly unknown[]).includes(one)) return null
    next[key as Picker] = one as PickerSort
  }
  return next
}

/**
 * When each place was last visited, in ms, by the keys below. `spaces` holds the spaces deeper than
 * the top level (a part was one), by `spaceVisitKey`; a top-level space is its epic, so its visit is
 * the epic's — every epic visit kept before spaces is that space's visit (`spaceVisitedAt`).
 */
export interface Visits {
  projects: Readonly<Record<string, number>>
  epics: Readonly<Record<string, number>>
  kehikot: Readonly<Record<string, number>>
  /** Absent from an older host's answer. */
  spaces?: Readonly<Record<string, number>>
}
export const NO_VISITS: Visits = { projects: {}, epics: {}, kehikot: {}, spaces: {} }

export const projectVisitKey = (project: number): string => String(project)
export const epicVisitKey = (project: number, slug: string): string => `${project}/${slug}`
export const kehikkoVisitKey = (project: number, key: string): string => `${project}/${key}`
/** A space's visit key: the project, then its path of ids. A top-level space's is its epic's (`epicVisitKey`). */
export const spaceVisitKey = (project: number, ids: readonly string[]): string => `${project}/${ids.join('/')}`

/** When a space (by its path) was last visited itself: a top-level one through its epic, a deeper one through `spaces`. */
export function spaceVisitedAt(visits: Visits, project: number, ids: readonly string[]): number | undefined {
  if (!ids.length) return undefined
  const key = spaceVisitKey(project, ids)
  return ids.length === 1 ? visits.epics[key] : visits.spaces?.[key]
}

/** Which pickers' places are visited, as the person arrives at a place. */
export interface Here {
  project: number | null
  epic: string | null
  kehikko: string | null
  /** The space stood in, as a path, when it is deeper than its epic (one part picked was such a space). */
  space?: readonly string[] | null
}

/** What a visit records: the project, and the epic and kehikko in it when there are some. */
export interface Visit {
  project: number
  epic?: string
  kehikko?: string
  /** The space, as a path starting at `epic`, when it is deeper than the epic. */
  space?: string[]
  /** The place just left, which was visited until now: stamped a moment before the arrival, so it ranks next. */
  left?: Omit<Visit, 'left'>
}

/**
 * What arriving at `now` from `was` records. Every way of getting somewhere —
 * a picker, a pinned place, Inbox Open, an agent's jump, Go back, a jump into
 * another project — ends in the page showing a different place, so this is
 * asked of the place as the page shows it (`placeNow` in `App.tsx`), the one
 * place a place is applied. Null when nothing new was arrived at — and at
 * start-up, which is not a switch: the place the page opened on is stamped when
 * it is first left (`left`).
 */
export function visitFor(was: Here | null, now: Here | null): Visit | null {
  if (!was || !now || now.project === null) return null
  const deep = (here: Here): string[] | null => (here.epic !== null && here.space && here.space.length > 1 && here.space[0] === here.epic ? [...here.space] : null)
  const same = (a: string[] | null, b: string[] | null) => (a ?? []).join('/') === (b ?? []).join('/')
  if (was.project === now.project && was.epic === now.epic && was.kehikko === now.kehikko && same(deep(was), deep(now))) return null
  const place = (here: Here & { project: number }) => {
    const space = deep(here)
    return {
      project: here.project,
      ...(here.epic !== null ? { epic: here.epic } : {}),
      ...(space ? { space } : {}),
      ...(here.kehikko !== null ? { kehikko: here.kehikko } : {}),
    }
  }
  return { ...place({ ...now, project: now.project }), ...(was.project !== null ? { left: place({ ...was, project: was.project }) } : {}) }
}

/**
 * `items` in the order a picker shows them. A to Z compares names the way a
 * person reads them (numbers by value, case ignored). Recent puts the most
 * recently visited first; what was never visited follows, A to Z among itself.
 */
export function ordered<T>(items: readonly T[], sort: PickerSort, nameOf: (item: T) => string, visitedAt: (item: T) => number | undefined): T[] {
  const byName = (a: T, b: T) => nameOf(a).localeCompare(nameOf(b), undefined, { numeric: true, sensitivity: 'base' })
  const copy = [...items]
  if (sort === 'az') return copy.sort(byName)
  return copy.sort((a, b) => {
    const x = visitedAt(a)
    const y = visitedAt(b)
    if (x !== undefined && y !== undefined && x !== y) return y - x
    if (x !== undefined && y === undefined) return -1
    if (x === undefined && y !== undefined) return 1
    return byName(a, b)
  })
}

/** The words of the switch, and what is announced. */
export const SORT_WORDS: Record<PickerSort, { label: string; says: string }> = {
  az: { label: 'A–Z', says: 'alphabetical' },
  recent: { label: 'Recent', says: 'recently visited first' },
}
