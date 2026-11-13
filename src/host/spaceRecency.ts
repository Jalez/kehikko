import { spaceFromEpicParts, worstActivity, type ActivityItem, type ActivityState, type SpaceNode } from 'kehikot-module-protocol'

import { DAY, HOUR, JUST_NOW, MINUTE } from './relativeTime.ts'
import { spaceVisitedAt, type PickerSort, type Visits } from './pickerOrder.ts'
import { keyOf } from './spaces.ts'

/**
 * What the space picker shows of each space's life: the activity dot (the worst live state of the
 * Inbox record's items in it, as the epic and part rows had it), when the space was last interacted
 * with (the person's own visit, or the last activity in it by anyone, whichever is later), the order
 * "Recent" puts siblings in, and the time headings it groups them under.
 *
 * Everything is per space and ALSO per subtree: a parent holds what its children hold, so a collapsed
 * branch says what goes on inside it and sorts by it. Pure: the clock and the time zone are passed in.
 */

type Place = NonNullable<ActivityItem['place']>

/** An item of the Inbox record as this reads it. */
export interface SpaceActivity {
  state: ActivityState
  place?: Place
  /** When it entered its state, ms. */
  entered: number
  /** Live: open and not put away (`isLive`). Only a live item marks a dot. */
  live: boolean
}

const RANK: Record<ActivityState, number> = { attention: 3, working: 2, done: 1 }

/**
 * The spaces (paths) an item's place names: its `space` when it says one, else what its epic and parts
 * make — one part is that child, several parts are each of those children, an epic alone is its
 * top-level space. None for a place naming no epic.
 */
export function spacesOfPlace(place: Place | undefined): string[][] {
  if (!place) return []
  if (place.space?.length && place.space[0] === place.epic) return [[...place.space]]
  const held = spaceFromEpicParts(place.epic, place.parts ?? [])
  if (!held) return []
  return held.picked.length ? held.picked.map((id) => [...held.ids, id]) : [held.ids]
}

/** Each space (by `keyOf` its path) a live item names, with the worst state named there itself. */
export function directMarks(items: readonly SpaceActivity[]): Map<string, ActivityState> {
  const out = new Map<string, ActivityState>()
  for (const item of items) {
    if (!item.live) continue
    for (const ids of spacesOfPlace(item.place)) {
      const key = keyOf(ids)
      const was = out.get(key)
      if (!was || RANK[item.state] > RANK[was]) out.set(key, item.state)
    }
  }
  return out
}

/**
 * When each space last saw activity itself, by anyone: an item's `entered`, and `now` for one that is
 * working at this moment. Every item the record holds open counts, live or put away.
 */
export function directActivity(items: readonly SpaceActivity[], now: number): Map<string, number> {
  const out = new Map<string, number>()
  for (const item of items) {
    const at = item.live && item.state === 'working' ? Math.max(now, item.entered) : item.entered
    for (const ids of spacesOfPlace(item.place)) {
      const key = keyOf(ids)
      out.set(key, Math.max(out.get(key) ?? 0, at))
    }
  }
  return out
}

/** What one space, and everything under it, holds. */
export interface SpaceLife {
  /** The worst live state in the space itself. */
  mark: ActivityState | null
  /** The worst live state in the space or anywhere under it. */
  markBelow: ActivityState | null
  /** The person's latest visit to the space or anything under it. */
  visited?: number
  /** The latest activity in the space or anything under it. */
  active?: number
  /** The later of the two: what "Recent" sorts by. */
  last?: number
}

const later = (a: number | undefined, b: number | undefined): number | undefined => (a === undefined ? b : b === undefined ? a : Math.max(a, b))

/** Every space of the tree, by `keyOf` its path, with what it and its subtree hold. */
export function spaceLives(
  tree: readonly SpaceNode[],
  project: number | null,
  visits: Visits,
  items: readonly SpaceActivity[],
  now: number,
): Map<string, SpaceLife> {
  const marks = directMarks(items)
  const activity = directActivity(items, now)
  const out = new Map<string, SpaceLife>()
  const walk = (node: SpaceNode, above: readonly string[]): SpaceLife => {
    const ids = [...above, node.id]
    const key = keyOf(ids)
    const mark = marks.get(key) ?? null
    let markBelow = mark
    let visited = project === null ? undefined : spaceVisitedAt(visits, project, ids)
    let active = activity.get(key)
    for (const child of node.children) {
      const life = walk(child, ids)
      markBelow = worstActivity([markBelow, life.markBelow].filter((one): one is ActivityState => one !== null))
      visited = later(visited, life.visited)
      active = later(active, life.active)
    }
    const life: SpaceLife = { mark, markBelow, visited, active, last: later(visited, active) }
    out.set(key, life)
    return life
  }
  for (const node of tree) walk(node, [])
  return out
}

/** The worst live state outside a space (its path): what the closed picker says goes on elsewhere. */
export function worstElsewhere(lives: ReadonlyMap<string, SpaceLife>, tree: readonly SpaceNode[], here: readonly string[]): ActivityState | null {
  const found: ActivityState[] = []
  const walk = (nodes: readonly SpaceNode[], above: readonly string[]) => {
    for (const node of nodes) {
      const ids = [...above, node.id]
      const key = keyOf(ids)
      const life = lives.get(key)
      const onTheWay = here.length >= ids.length && keyOf(here.slice(0, ids.length)) === key
      if (!onTheWay) {
        if (life?.markBelow) found.push(life.markBelow)
        continue
      }
      /* The current space and what is under it are where the person is; above it, only its own items are elsewhere. */
      if (ids.length === here.length) continue
      if (life?.mark) found.push(life.mark)
      walk(node.children, ids)
    }
  }
  walk(tree, [])
  return worstActivity(found)
}

/**
 * The tree with each level's siblings in the picker's order. A to Z compares names the way a person
 * reads them; Recent puts the latest interaction (in the space or its subtree) first, and the spaces
 * never interacted with after, A to Z. The structure is kept: only siblings move.
 */
export function sortedTree(tree: readonly SpaceNode[], sort: PickerSort, lives: ReadonlyMap<string, SpaceLife>): SpaceNode[] {
  const byName = (a: SpaceNode, b: SpaceNode) => (a.name || a.id).localeCompare(b.name || b.id, undefined, { numeric: true, sensitivity: 'base' })
  const walk = (nodes: readonly SpaceNode[], above: readonly string[]): SpaceNode[] => {
    const lastOf = (node: SpaceNode) => lives.get(keyOf([...above, node.id]))?.last
    const copy = nodes.map((node) => ({ ...node, children: walk(node.children, [...above, node.id]) }))
    if (sort === 'az') return copy.sort(byName)
    return copy.sort((a, b) => {
      const x = lastOf(a)
      const y = lastOf(b)
      if (x !== undefined && y !== undefined && x !== y) return y - x
      if (x !== undefined && y === undefined) return -1
      if (x === undefined && y !== undefined) return 1
      return byName(a, b)
    })
  }
  return walk(tree, [])
}

/**
 * While filtering: each level's siblings by how well they match — a name starting with the first word,
 * then one holding it, then a branch that only leads to a match — and A to Z within each.
 */
export function matchedTree(tree: readonly SpaceNode[], filter: string): SpaceNode[] {
  const first = filter.toLocaleLowerCase().split(/\s+/).filter(Boolean)[0] ?? ''
  const score = (node: SpaceNode) => {
    const name = (node.name || node.id).toLocaleLowerCase()
    return name.startsWith(first) ? 0 : name.includes(first) || node.id.toLocaleLowerCase().includes(first) ? 1 : 2
  }
  const byName = (a: SpaceNode, b: SpaceNode) => (a.name || a.id).localeCompare(b.name || b.id, undefined, { numeric: true, sensitivity: 'base' })
  const walk = (nodes: readonly SpaceNode[]): SpaceNode[] =>
    nodes.map((node) => ({ ...node, children: walk(node.children) })).sort((a, b) => score(a) - score(b) || byName(a, b))
  return walk(tree)
}

/** The time headings "Recent" groups siblings under, in order. `never` is for a space nobody has been to. */
export const BUCKETS = ['now', 'hour', 'today', 'yesterday', 'week', 'lastWeek', 'month', 'older', 'never'] as const
export type Bucket = (typeof BUCKETS)[number]
export const BUCKET_WORDS: Record<Bucket, string> = {
  now: 'Just now',
  hour: 'Last hour',
  today: 'Today',
  yesterday: 'Yesterday',
  week: 'This week',
  lastWeek: 'Last week',
  month: 'This month',
  older: 'Older',
  never: 'Not visited yet',
}


/** Local midnight of the day `at` falls on. */
const dayStart = (at: number): number => {
  const date = new Date(at)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/**
 * Which heading a time falls under, in the person's local time: in the last five minutes, within the hour, earlier today,
 * yesterday, earlier this week (weeks start on Monday), last week, earlier this month, older.
 */
export function bucketOf(at: number | undefined, now: number): Bucket {
  if (at === undefined) return 'never'
  if (now - at < JUST_NOW) return 'now'
  if (now - at < HOUR) return 'hour'
  const today = dayStart(now)
  if (at >= today) return 'today'
  const yesterday = dayStart(today - DAY / 2)
  if (at >= yesterday) return 'yesterday'
  const weekday = (new Date(now).getDay() + 6) % 7 /* Monday is 0 */
  let week = today
  for (let step = 0; step < weekday; step += 1) week = dayStart(week - DAY / 2)
  if (at >= week) return 'week'
  let lastWeek = week
  for (let step = 0; step < 7; step += 1) lastWeek = dayStart(lastWeek - DAY / 2)
  if (at >= lastWeek) return 'lastWeek'
  const month = new Date(now)
  month.setDate(1)
  month.setHours(0, 0, 0, 0)
  if (at >= month.getTime()) return 'month'
  return 'older'
}

/** How long ago, in a few characters: "just now", "5 min ago", "3 h ago", "2 d ago", "4 wk ago". */
export function agoWords(at: number, now: number): string {
  const gone = Math.max(0, now - at)
  if (gone < MINUTE) return 'just now'
  if (gone < HOUR) return `${Math.floor(gone / MINUTE)} min ago`
  if (gone < DAY) return `${Math.floor(gone / HOUR)} h ago`
  if (gone < 14 * DAY) return `${Math.floor(gone / DAY)} d ago`
  return `${Math.floor(gone / (7 * DAY))} wk ago`
}

/** A row's tooltip of when it was last interacted with: "Activity 1 h ago · you visited 3 d ago". Empty for never. */
export function lifeWords(life: SpaceLife | undefined, now: number): string {
  if (!life) return ''
  const out: string[] = []
  if (life.active !== undefined) out.push(`Activity ${agoWords(life.active, now)}`)
  if (life.visited !== undefined) out.push(`${out.length ? 'you' : 'You'} visited ${agoWords(life.visited, now)}`)
  return out.join(' · ')
}

/** One drawn row's place among its siblings, for the headings. */
export interface HeadedRow {
  ids: readonly string[]
  depth: number
}

/**
 * Which rows open a heading under "Recent", and which: the first of each run of siblings in one bucket.
 * At the top level every run is headed; inside an opened space only when its children fall in more
 * than one bucket, so a quiet branch is not cut into one-row groups. Under a filter, or A to Z, none.
 */
export function headings(rows: readonly HeadedRow[], bucketAt: (ids: readonly string[]) => Bucket): Map<number, Bucket> {
  const out = new Map<number, Bucket>()
  const parentOf = (row: HeadedRow) => keyOf(row.ids.slice(0, -1))
  const levels = new Map<string, number[]>()
  rows.forEach((row, index) => {
    const parent = parentOf(row)
    levels.set(parent, [...(levels.get(parent) ?? []), index])
  })
  for (const [parent, indexes] of levels) {
    const buckets = indexes.map((index) => bucketAt(rows[index]!.ids))
    if (parent !== '' && new Set(buckets).size < 2) continue
    indexes.forEach((index, at) => {
      if (at === 0 || buckets[at] !== buckets[at - 1]) out.set(index, buckets[at]!)
    })
  }
  return new Map([...out].sort(([a], [b]) => a - b))
}
