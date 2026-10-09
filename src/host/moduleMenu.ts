import type { OfficialModule } from './official.ts'
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

interface Line {
  id: string
  name: string
  /** What it is, in a sentence; empty when nobody has said. */
  summary: string
  tags: readonly string[]
  placed: boolean
}

/** A module registered on this machine. */
export interface Registered extends Line {
  kind: 'registered'
  presence: Presence
  /**
   * Whether it is on the official list. Null when the list could not be read —
   * a host older than the list — and then nothing is offered either way.
   */
  official: boolean | null
}

/** An official module that is not on this machine yet. */
export interface Available extends Line {
  kind: 'available'
  placed: false
  entry: OfficialModule
}

/** One line of the list. */
export type Row = Registered | Available

/**
 * Every line: what is registered, then what the official list has that this
 * machine does not.
 *
 * A registered module describes itself, and what it says — now, or the last
 * time it was awake — is what is shown. The list's own summary and tags fill
 * in only for one that has never answered here, which is exactly the module
 * somebody has just installed.
 */
export function rowsOf(
  presences: readonly Presence[],
  placed: ReadonlySet<string>,
  official: readonly OfficialModule[] | null = null,
): Row[] {
  const listed = new Map((official ?? []).map((entry) => [entry.id, entry]))
  const here = new Set(presences.map((presence) => presence.id))
  const registered: Row[] = presences.map((presence) => {
    const entry = listed.get(presence.id)
    const tags = presence.tags ?? presence.module?.tags ?? []
    return {
      kind: 'registered',
      id: presence.id,
      name: presence.name ?? entry?.name ?? presence.id,
      summary: presence.summary || presence.module?.summary || entry?.summary || '',
      tags: tags.length ? tags : (entry?.tags ?? []),
      placed: placed.has(presence.id),
      presence,
      official: official ? entry !== undefined : null,
    }
  })
  const available: Row[] = (official ?? [])
    .filter((entry) => !entry.installed && !here.has(entry.id))
    .map((entry) => ({ kind: 'available', id: entry.id, name: entry.name, summary: entry.summary, tags: entry.tags, placed: false, entry }))
  return [...registered, ...available]
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
 * per shelf. Each row appears once, and on a shelf what is installed comes
 * before what could be.
 */
export function arrange<R extends Pick<Row, 'id' | 'name' | 'summary' | 'tags' | 'placed'> & { kind?: Row['kind'] }>(
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
    .map(([heading, held]) => ({
      heading,
      rows: held.sort((a, b) => Number(a.kind === 'available') - Number(b.kind === 'available') || a.name.localeCompare(b.name)),
    }))
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
 * Three things are trouble: a module this host cannot speak to, a module whose
 * manifest this host refuses (`refused` — since protocol 1.0.0 that is also one
 * that does not say how it relates to the parts of an epic; before, that was a
 * quiet warning under a working row), and an address where something answers
 * that is not the module registered there. Each sentence ends with the next
 * step.
 */
/**
 * The module's version as its row's details give it: what it calls itself,
 * the commit its server started on, and the protocol package it is built
 * with. Null when the module is not answering, so nothing is known.
 */
export function builtFrom(presence: Presence): { version: string; protocol: string | null } | null {
  const module = presence.module
  if (!module) return null
  const commit = module.build?.commit ? ` (${module.build.commit.slice(0, 7)})` : ''
  return { version: `${module.version}${commit}`, protocol: module.build?.protocol ?? null }
}

export function attention(presence: Presence): string | null {
  if (presence.condition === 'ready') return null
  if (presence.condition === 'incompatible') {
    const newer = presence.protocols && presence.protocols.module !== null && presence.protocols.module > presence.protocols.host
    return `${presence.line} ${newer ? 'Update Kehikot to use it.' : 'Update the module to use it.'}`
  }
  /* The module answered and its manifest was refused (`discover.ts`): starting
     it again serves the same manifest, so say what does change it. Before the
     lifecycle check on purpose — a module the host just started and then
     refused must not sit there saying only "starting". */
  if (presence.refused) return `${presence.line} Update the module to use it.`
  if (presence.lifecycle || !presence.reached) return null
  return `${presence.line} Check what is running at ${presence.at}, then start the module again.`
}
