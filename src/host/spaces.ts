import { epicPartsOf, spaceFromEpicParts, spaceOf, type Space, type SpaceNode } from 'kehikot-module-protocol'

/**
 * Spaces on the page and the server alike: the rules both halves must agree on (protocol 2.89.0).
 *
 * A project stands in one space (or none, or "All spaces"). What it stands in is kept as epic and
 * parts — the top-level space and its picked children — whenever those can say it, which is every
 * place a person could reach before spaces, and beside them as `space` (a path of ids and the children
 * picked in it) only when they cannot: deeper than a part. `epic` and `parts` are always filled, by
 * `epicPartsOf`, so everything that reads them goes on working.
 *
 * Pure: no `window`, no `node:fs`. The picker's own rules (which rows show, which are open, where the
 * keyboard goes) are here too, so they are lines in a test.
 */

/** A space as the subject keeps it: a path of ids and the children picked in it. */
export interface HeldSpace {
  ids: string[]
  picked: string[]
}

/** Whether a space needs keeping beside epic and parts: deeper than a part, or children picked below the top. */
export function deepSpace(ids: readonly string[], picked: readonly string[] = []): boolean {
  return ids.length >= 3 || (ids.length === 2 && picked.length > 1)
}

/** The space a subject stands in: its kept space, else the one its epic and parts make. Null for none and for "All spaces". */
export function heldSpaceOf(subject: { epic: string | null; scope?: string; parts: readonly string[]; space?: HeldSpace }): HeldSpace | null {
  if (subject.scope === 'project') return null
  if (subject.space) return { ids: [...subject.space.ids], picked: [...subject.space.picked] }
  return spaceFromEpicParts(subject.epic, subject.parts)
}

/**
 * What standing in a space writes: the epic and parts it maps to, and the space itself when they
 * cannot say it. One picked child is standing in that child.
 */
export function standIn(ids: readonly string[], picked: readonly string[] = []): { epic: string | null; parts: string[]; space?: HeldSpace } {
  let path = [...ids]
  let chosen = [...picked]
  if (chosen.length === 1) {
    path = [...path, chosen[0]!]
    chosen = []
  }
  const said = epicPartsOf({ path: path.map((id) => ({ id })), picked: chosen })
  return deepSpace(path, chosen) ? { ...said, space: { ids: path, picked: chosen } } : said
}

/** The space a subject stands in, with names, from the project's tree; null when the tree does not have it. */
export function spaceHere(tree: readonly SpaceNode[], subject: Parameters<typeof heldSpaceOf>[0]): Space | null {
  const held = heldSpaceOf(subject)
  return held ? spaceOf(tree, held.ids, held.picked) : null
}

/** A path's key, for sets of open branches and for React keys: ids joined by `/`. */
export const keyOf = (ids: readonly string[]): string => ids.join('/')

/** One row of the picker's tree as it is drawn: a space, its depth, and whether it has children and is open. */
export interface TreeRow {
  ids: string[]
  name: string
  depth: number
  children: number
  open: boolean
  /** Whether it matches the filter (always, with no filter). */
  match: boolean
}

/** The keys of every branch on the way to a space: the ones that get the "contains the current space" mark when closed. */
export function branchesTo(ids: readonly string[]): string[] {
  const out: string[] = []
  for (let at = 1; at < ids.length; at += 1) out.push(keyOf(ids.slice(0, at)))
  return out
}

/** Whether a space's name matches a filter: every word, anywhere in the name or the id, case folded. */
function matches(node: SpaceNode, words: readonly string[]): boolean {
  const said = `${node.name} ${node.id}`.toLocaleLowerCase()
  return words.every((word) => said.includes(word))
}

const NONE: ReadonlySet<string> = new Set()

/**
 * The rows the picker draws. Expansion is only what the person did: with no filter, the top-level
 * spaces and the children of every branch in `open` (keys of paths), whatever space the project is on.
 * With a filter: every space at any depth that matches, with the branches above it revealed so it shows,
 * and nothing else; a revealed branch the person closed meanwhile is in `shut` and stays closed.
 */
export function treeRows(tree: readonly SpaceNode[], open: ReadonlySet<string>, filter = '', shut: ReadonlySet<string> = NONE): TreeRow[] {
  const words = filter.toLocaleLowerCase().split(/\s+/).filter(Boolean)
  const rows: TreeRow[] = []
  if (!words.length) {
    const walk = (nodes: readonly SpaceNode[], above: string[], depth: number): void => {
      for (const node of nodes) {
        const ids = [...above, node.id]
        const isOpen = node.children.length > 0 && open.has(keyOf(ids))
        rows.push({ ids, name: node.name, depth, children: node.children.length, open: isOpen, match: true })
        if (isOpen) walk(node.children, ids, depth + 1)
      }
    }
    walk(tree, [], 0)
    return rows
  }
  /* Which subtrees hold a match, so only the branches leading to one are walked (and shown open). */
  const holds = (node: SpaceNode): boolean => matches(node, words) || node.children.some(holds)
  const walk = (nodes: readonly SpaceNode[], above: string[], depth: number): void => {
    for (const node of nodes) {
      if (!holds(node)) continue
      const ids = [...above, node.id]
      const holding = node.children.filter(holds).length
      const isOpen = holding > 0 && !shut.has(keyOf(ids))
      rows.push({ ids, name: node.name, depth, children: holding, open: isOpen, match: matches(node, words) })
      if (isOpen) walk(node.children, ids, depth + 1)
    }
  }
  walk(tree, [], 0)
  return rows
}

/** What a key does in the tree: where the focus goes, and which branch opens or closes, or a pick. */
export type TreeMove =
  | { focus: number }
  | { focus: number; open: string }
  | { focus: number; close: string }
  | { pick: string[] }
  | null

/**
 * The tree's keyboard, as the WAI-ARIA tree pattern has it: Down and Up move, Home and End jump, Right
 * opens a closed branch (or moves into an open one), Left closes an open branch (or moves to its
 * parent), Enter picks. Null for any other key, or no rows.
 */
export function treeKey(rows: readonly TreeRow[], at: number, key: string): TreeMove {
  if (!rows.length) return null
  const here = rows[Math.min(Math.max(at, 0), rows.length - 1)]!
  const index = rows.indexOf(here)
  switch (key) {
    case 'ArrowDown':
      return { focus: Math.min(index + 1, rows.length - 1) }
    case 'ArrowUp':
      return { focus: Math.max(index - 1, 0) }
    case 'Home':
      return { focus: 0 }
    case 'End':
      return { focus: rows.length - 1 }
    case 'ArrowRight':
      if (here.children && !here.open) return { focus: index, open: keyOf(here.ids) }
      if (here.open) return { focus: Math.min(index + 1, rows.length - 1) }
      return { focus: index }
    case 'ArrowLeft': {
      if (here.open) return { focus: index, close: keyOf(here.ids) }
      const parent = keyOf(here.ids.slice(0, -1))
      const up = rows.findIndex((row) => keyOf(row.ids) === parent)
      return { focus: up >= 0 ? up : index }
    }
    case 'Enter':
      return { pick: here.ids }
    default:
      return null
  }
}

/** Type-ahead: the next row after `at` whose name starts with what was typed, wrapping; `at` when none does. */
export function typeAhead(rows: readonly TreeRow[], at: number, typed: string): number {
  const said = typed.toLocaleLowerCase()
  if (!said) return at
  for (let step = 1; step <= rows.length; step += 1) {
    const index = (at + step) % rows.length
    if (rows[index]!.name.toLocaleLowerCase().startsWith(said)) return index
  }
  return at
}

/** How many spaces a node holds below it, at every depth. */
export function spacesUnder(node: SpaceNode): number {
  return node.children.reduce((sum, child) => sum + 1 + spacesUnder(child), 0)
}

/** The breadcrumb's words: `Project › Space › Sub-space`, with the picked children joined by `+`. */
export function breadcrumb(project: string | null, space: Space | null, all = false): string[] {
  const out = project ? [project] : []
  if (all) return [...out, 'All spaces']
  if (!space) return out
  const names = space.path.map((step) => step.name || step.id)
  return [...out, ...names]
}
