import type { Presence } from './registry.ts'

/**
 * The module list, as something to look through: which shelf each module is
 * on, what a search finds, and which rows need a person.
 *
 * Pure, and apart from the component that draws it, so that the three
 * decisions here — where a module is filed, whether it matches, whether it is
 * in trouble — can be read and tested without a popover.
 */

/**
 * The shelf a tag is drawn under.
 *
 * The protocol's suggested tags are finer than a list of twenty modules needs:
 * `reading` and `writing` are one place a person looks, and so are `code`,
 * `review` and `tests`. A tag nobody here has heard of is its own shelf, under
 * its own word — the module said where it belongs, and the host draws that
 * rather than filing a stranger's category under "other".
 */
const SHELVES: Record<string, string> = {
  planning: 'Planning',
  reading: 'Reading and writing',
  writing: 'Reading and writing',
  code: 'Code',
  review: 'Code',
  tests: 'Code',
  agents: 'Agents',
}

/** The order the known shelves are drawn in. Unknown ones follow, by name; `OTHER` is last. */
const ORDER = ['Planning', 'Reading and writing', 'Code', 'Agents']

/** Where a module that gave no tags goes. */
export const OTHER = 'Other'

/** What is placed on the open kehikko, drawn first whatever it is tagged. */
export const HERE = 'On this kehikko'

/** The shelf for a module's tags. The FIRST tag decides; the rest only widen a search. */
export function shelfOf(tags: readonly string[]): string {
  const first = tags[0]
  if (!first) return OTHER
  /* `Object.hasOwn`, because a tag is a stranger's string and `constructor` is
     a key every object has. */
  if (Object.hasOwn(SHELVES, first)) return SHELVES[first]!
  const words = first.replace(/-/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** One line of the list. */
export interface Row {
  id: string
  name: string
  /** What it is, in a sentence; empty when nobody has said. */
  summary: string
  tags: readonly string[]
  placed: boolean
  presence: Presence
}

export function rowsOf(presences: readonly Presence[], placed: ReadonlySet<string>): Row[] {
  return presences.map((presence) => ({
    id: presence.id,
    name: presence.name ?? presence.id,
    summary: presence.summary ?? presence.module?.summary ?? '',
    tags: presence.tags ?? presence.module?.tags ?? [],
    placed: placed.has(presence.id),
    presence,
  }))
}

/**
 * Whether a row is what somebody typed.
 *
 * Every word has to be found, in the name, the summary, a tag, the shelf or the
 * id — so "code review" narrows rather than widens, and the shelf's own heading
 * finds what is under it.
 */
export function matches(row: Pick<Row, 'id' | 'name' | 'summary' | 'tags'>, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return true
  const text = [row.name, row.summary, row.id, shelfOf(row.tags), ...row.tags].join('\n').toLowerCase()
  return words.every((word) => text.includes(word))
}

export interface Section<R> {
  heading: string
  rows: R[]
}

/**
 * The list in the order it is drawn: what is on this kehikko, then one section
 * per shelf. Each row appears once.
 */
export function arrange<R extends Pick<Row, 'id' | 'name' | 'summary' | 'tags' | 'placed'>>(
  rows: readonly R[],
  query = '',
): Section<R>[] {
  const byHeading = new Map<string, R[]>()
  for (const row of rows) {
    if (!matches(row, query)) continue
    const heading = row.placed ? HERE : shelfOf(row.tags)
    const held = byHeading.get(heading)
    if (held) held.push(row)
    else byHeading.set(heading, [row])
  }
  const rank = (heading: string): number => {
    if (heading === HERE) return -1
    if (heading === OTHER) return ORDER.length + 1
    const known = ORDER.indexOf(heading)
    return known >= 0 ? known : ORDER.length
  }
  return [...byHeading.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([heading, held]) => ({ heading, rows: held.sort((a, b) => a.name.localeCompare(b.name)) }))
}

/**
 * What a person has to do about a module, or null when there is nothing.
 *
 * Not running is NOT something to do. Modules sleep when nothing needs them and
 * are started when a kehikko that has them is opened, so a registered program
 * that is not answering is the ordinary state of most of the list. The dot
 * says so; a sentence on every row said it so often that the one row with a
 * real fault did not stand out.
 *
 * Two things are trouble: a module this host cannot speak to, and an address
 * where something answers that is not the module registered there. Each
 * sentence ends with the next step.
 */
export function attention(presence: Presence): string | null {
  if (presence.condition === 'ready') return null
  if (presence.condition === 'incompatible') {
    const newer = presence.protocols && presence.protocols.module !== null && presence.protocols.module > presence.protocols.host
    return `${presence.line} ${newer ? 'Update Kehikot to use it.' : 'Update the module to use it.'}`
  }
  if (presence.lifecycle || !presence.reached) return null
  return `${presence.line} Check what is running at ${presence.at}, then start the module again.`
}
