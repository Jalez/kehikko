import { copyFileSync, existsSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { LIMITS, nodeAt, spaceIdFor, spaceTreeSchema, type SpaceNode } from 'kehikot-module-protocol'

import { createEpic, deleteEpic, editParts, listEpics, retitleEpic, type EpicSummary } from './holdings.ts'
import { epicsDir, hostPath } from './hostData.ts'
import { isReadOnlyRoot, makeUnderRoot, MISSING_SAID, projectRootExists, READ_ONLY_SAID } from './projectRoot.ts'

/**
 * A project's spaces: one tree, to any depth, in place of the two fixed levels epic → parts.
 *
 * ## Whose is what
 *
 * The top two levels ARE the epics and their parts, and their files stay the truth for them: a
 * top-level space is `.kehikot/host/epics/<slug>.json` (its id the slug, its name the title), and its
 * children are that file's `parts` (their ids and names, in that order). Everything the host and its
 * modules read off an epic or a part — refs, steps, documents, what modules filed under an id — is
 * read exactly as before, and a host from before spaces still finds every epic and part it knew.
 *
 * `.kehikot/host/spaces.json` keeps what the epic files cannot say: the order of the top-level
 * spaces, and every space deeper than a part. It also keeps a copy of the top two levels, so the file
 * on its own is the whole tree; but where the copy and the epic files differ, the files win
 * (`spaceTree`): an epic made or a part removed by an older host, or by hand, is simply what is there.
 * A node the files no longer have stays in `spaces.json`, unshown, so what was under it comes back
 * with it.
 *
 * ## The one writer
 *
 * `editSpaces` is the only function that writes the tree. At the top two levels it writes through the
 * epic writers (`createEpic`, `retitleEpic`, `deleteEpic`, `editParts`), so an epic or a part is made
 * one way whoever asks; below that it writes `spaces.json`. `create_epic` and `set_parts` keep working
 * and are spaces at those two levels.
 *
 * ## The migration
 *
 * `migrateSpaces`, on every start and whenever a project is added: once per project, when there is no
 * `spaces.json` and there are epics, it copies every epic file into `.kehikot/host/epics-before-spaces/`
 * (never moving or deleting one), writes `spaces.json` from the epics and their parts, and reads it back.
 * A second run finds the file and does nothing.
 */

/** The file, under the host's folder. */
export const SPACES_FILE = 'spaces.json'

/** Where the epic files are copied before the first `spaces.json` is written, under the host's folder. */
export const SPACES_BACKUP = 'epics-before-spaces'

interface SpacesFile {
  version: 1
  /** When this project's epics were first made spaces (ISO date). */
  migrated: string
  spaces: SpaceNode[]
}

/** The tree in `spaces.json` as written, or null when there is none or it cannot be read. */
export function readSpacesFile(root: string | null | undefined): SpacesFile | null {
  const path = root ? hostPath(root, SPACES_FILE) : null
  if (!path) return null
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const said = raw as { migrated?: unknown; spaces?: unknown }
  const tree = spaceTreeSchema.safeParse(said.spaces ?? [])
  return { version: 1, migrated: typeof said.migrated === 'string' ? said.migrated : '', spaces: tree.success ? tree.data : [] }
}

/** The epics with their parts, as the tree's top two levels read them. */
function epicLevels(root: string, epics?: readonly EpicSummary[]): SpaceNode[] {
  return (epics ?? listEpics(root)).map((epic) => ({
    id: epic.slug,
    name: epic.title ?? epic.slug,
    children: (epic.parts ?? []).map((part) => ({ id: part.id, name: part.heading || part.id, children: [] })),
  }))
}

const clone = (nodes: readonly SpaceNode[]): SpaceNode[] => nodes.map((node) => ({ id: node.id, name: node.name, children: clone(node.children) }))

/**
 * The tree as it stands, and the file it would be written as: the epic files' top two levels in the
 * file's order (an epic the file does not know goes last), each part with the spaces the file keeps
 * under it; and `kept`, the same plus every node the files no longer have, for the file.
 */
function merged(root: string, file: SpacesFile | null, epics?: readonly EpicSummary[]): { view: SpaceNode[]; kept: SpaceNode[] } {
  const levels = epicLevels(root, epics)
  const saved = file?.spaces ?? []
  const order = new Map(saved.map((node, index) => [node.id, index]))
  const tops = [...levels].sort((a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity))
  const view: SpaceNode[] = []
  const kept: SpaceNode[] = []
  for (const top of tops) {
    const before = saved.find((node) => node.id === top.id)
    const children = top.children.map((part) => {
      const was = before?.children.find((node) => node.id === part.id)
      return { id: part.id, name: part.name, children: clone(was?.children ?? []) }
    })
    view.push({ id: top.id, name: top.name, children })
    const gone = (before?.children ?? []).filter((node) => !top.children.some((part) => part.id === node.id))
    kept.push({ id: top.id, name: top.name, children: [...clone(children), ...clone(gone)] })
  }
  for (const node of saved) if (!levels.some((top) => top.id === node.id)) kept.push(clone([node])[0]!)
  return { view, kept }
}

/** A project's tree of spaces as it stands: `[]` for no project or none. Never throws. */
export function spaceTree(root: string | null | undefined, epics?: readonly EpicSummary[]): SpaceNode[] {
  if (!root) return []
  try {
    return merged(root, readSpacesFile(root), epics).view
  } catch {
    return []
  }
}

/** Write the file beside and rename it, so a reader never finds half. Throws on failure. */
function writeFile(root: string, file: SpacesFile): void {
  const path = hostPath(root, SPACES_FILE)
  if (!path) throw new Error('There is no project.')
  const folder = join(path, '..')
  if (!existsSync(folder) && !makeUnderRoot(root, folder)) throw new Error('The host folder could not be made in this project.')
  const beside = `${path}.tmp-${process.pid}`
  try {
    writeFileSync(beside, `${JSON.stringify(file, null, 2)}\n`, 'utf8')
    renameSync(beside, path)
  } catch (error) {
    try {
      unlinkSync(beside)
    } catch {
      /* Never made. */
    }
    throw error
  }
}

export interface SpacesMigrated {
  /** Whether `spaces.json` was written by this run. */
  wrote: boolean
  /** How many epic files were copied into the backup. */
  backedUp: number
  /** Why nothing was written, when something stood in the way. */
  why?: string
}

/**
 * Make a project's epics spaces, once: see the essay at the top. Idempotent, never deletes or moves an
 * epic file, never throws. `today` is a parameter for tests.
 */
export function migrateSpaces(
  root: string,
  log: (line: string) => void = (line) => console.warn(line),
  today: string = new Date().toISOString().slice(0, 10),
): SpacesMigrated {
  try {
    if (!projectRootExists(root) || isReadOnlyRoot(root)) return { wrote: false, backedUp: 0 }
    const path = hostPath(root, SPACES_FILE)
    if (!path || existsSync(path)) return { wrote: false, backedUp: 0 }
    let files: string[]
    try {
      files = readdirSync(epicsDir(root)).filter((file) => file.endsWith('.json'))
    } catch {
      return { wrote: false, backedUp: 0 }
    }
    if (!files.length) return { wrote: false, backedUp: 0 }

    /* The backup first, and only once: a copy of every epic file as it was before spaces. */
    const backup = hostPath(root, SPACES_BACKUP)!
    let backedUp = 0
    if (!existsSync(backup)) {
      if (!makeUnderRoot(root, backup)) return { wrote: false, backedUp: 0, why: 'the backup folder could not be made' }
      for (const file of files) {
        copyFileSync(join(epicsDir(root), file), join(backup, file))
        backedUp += 1
      }
    }

    const tree = merged(root, null).kept
    writeFile(root, { version: 1, migrated: today, spaces: tree })
    /* Read it back: what was written must be the tree the epics make. */
    const back = readSpacesFile(root)
    if (!back || JSON.stringify(back.spaces) !== JSON.stringify(tree)) {
      log(`kehikko: ${path} did not read back as written; the epic files are unchanged and stay the truth`)
    } else {
      log(`kehikko: made ${tree.length} epic${tree.length === 1 ? '' : 's'} into spaces in ${path} (copies in ${backup})`)
    }
    return { wrote: true, backedUp }
  } catch (error) {
    log(`kehikko: could not make the epics of ${root} into spaces: ${(error as Error).message}`)
    return { wrote: false, backedUp: 0, why: (error as Error).message }
  }
}

/** One edit of the tree. A path is the ids from the top-level space down. */
export type SpaceEdit =
  | { create: { parent: string[]; name: string; id?: string; after?: string | null } }
  | { rename: { path: string[]; name: string } }
  | { move: { path: string[]; after?: string | null; parent?: string[] } }
  | { remove: { path: string[]; confirm?: boolean } }

export interface SpaceEdited {
  outcome: 'changed' | 'unchanged' | 'declined' | 'no-such-space' | 'confirm'
  why: string
  /** The space the edit was about, by its path, as it stands after (null when removed or refused). */
  path: string[] | null
  /** The tree as it reads after the call. */
  tree: SpaceNode[]
}

const NAME_OK = (raw: unknown): string | null => {
  const name = typeof raw === 'string' ? raw.trim() : ''
  return name && name.length <= LIMITS.TITLE && !/[\u0000-\u001f\u007f]/.test(name) ? name : null
}

const count = (nodes: readonly SpaceNode[]): number => nodes.reduce((sum, node) => sum + 1 + count(node.children), 0)

/** The edit in a request body or a tool's arguments that names exactly one, or null. */
export function spaceEditIn(raw: unknown): SpaceEdit | null {
  if (!raw || typeof raw !== 'object') return null
  const said = raw as Record<string, unknown>
  const named = ['create', 'rename', 'move', 'remove'].filter((key) => said[key] !== undefined && said[key] !== null)
  if (named.length !== 1) return null
  const body = said[named[0]!]
  if (!body || typeof body !== 'object') return null
  const ids = (value: unknown): string[] | null =>
    Array.isArray(value) && value.every((one) => typeof one === 'string') ? (value as string[]) : null
  const b = body as Record<string, unknown>
  const after = b.after === null ? null : typeof b.after === 'string' ? b.after : undefined
  switch (named[0]) {
    case 'create': {
      const parent = b.parent === undefined ? [] : ids(b.parent)
      return parent ? { create: { parent, name: String(b.name ?? ''), id: typeof b.id === 'string' ? b.id : undefined, after } } : null
    }
    case 'rename': {
      const path = ids(b.path)
      return path?.length ? { rename: { path, name: String(b.name ?? '') } } : null
    }
    case 'move': {
      const path = ids(b.path)
      const parent = b.parent === undefined ? undefined : ids(b.parent)
      return path?.length && parent !== null ? { move: { path, after, parent: parent ?? undefined } } : null
    }
    default: {
      const path = ids(b.path)
      return path?.length ? { remove: { path, confirm: b.confirm === true } } : null
    }
  }
}

/** `list` with `node` placed by `after`: right after that id, first for null, last when absent. Null for an unknown `after`. */
function placed(list: readonly SpaceNode[], node: SpaceNode, after: string | null | undefined): SpaceNode[] | null {
  if (after === undefined) return [...list, node]
  if (after === null) return [node, ...list]
  const at = list.findIndex((one) => one.id === after)
  return at < 0 ? null : [...list.slice(0, at + 1), node, ...list.slice(at + 1)]
}

/** The children list at a parent path inside a (mutable) tree, or null. `[]` is the top level. */
function childrenAt(tree: SpaceNode[], parent: readonly string[]): SpaceNode[] | null {
  if (!parent.length) return tree
  return nodeAt(tree, parent)?.children ?? null
}

function setChildren(tree: SpaceNode[], parent: readonly string[], next: SpaceNode[]): SpaceNode[] {
  if (!parent.length) return next
  const node = nodeAt(tree, parent)
  if (node) node.children = next
  return tree
}

/**
 * THE writer of a project's spaces: create, rename, move (reorder among siblings at every level, and
 * to another parent below the top two levels), and remove (only with `confirm`, which the answer asks
 * for by saying what would go). Never throws; every refusal is a sentence in `why`.
 */
export function editSpaces(root: string | null | undefined, edit: SpaceEdit): SpaceEdited {
  const now = (): SpaceNode[] => spaceTree(root)
  const refused = (outcome: SpaceEdited['outcome'], why: string): SpaceEdited => ({ outcome, why, path: null, tree: root ? now() : [] })
  if (!root) return refused('declined', 'There is no project open.')
  if (!projectRootExists(root)) return refused('declined', `${MISSING_SAID} The spaces were not changed.`)
  if (isReadOnlyRoot(root)) return refused('declined', `${READ_ONLY_SAID} The spaces were not changed.`)

  const file = readSpacesFile(root)
  const save = (tree: SpaceNode[], path: string[] | null): SpaceEdited => {
    const kept = merged(root, { version: 1, migrated: file?.migrated || new Date().toISOString().slice(0, 10), spaces: tree }).kept
    try {
      writeFile(root, { version: 1, migrated: file?.migrated || new Date().toISOString().slice(0, 10), spaces: kept })
    } catch (error) {
      return refused('declined', `The spaces could not be written: ${(error as Error).message}`)
    }
    return { outcome: 'changed', why: '', path, tree: now() }
  }
  /* The file's tree with what the epic files say now, nodes they lost kept: what an edit is applied to. */
  const tree = merged(root, file).kept

  if ('create' in edit) {
    const { parent, after } = edit.create
    const name = NAME_OK(edit.create.name)
    if (name === null) return refused('declined', `A space is called something: one line, at most ${LIMITS.TITLE} characters.`)
    if (parent.length >= LIMITS.SPACE_DEPTH) return refused('declined', `Spaces nest at most ${LIMITS.SPACE_DEPTH} deep.`)
    if (parent.length === 0) {
      const made = createEpic(root, { title: name, slug: edit.create.id })
      if (!made.ok) return refused('declined', made.why.replace(/\bepic\b/g, 'space'))
      const top = tree.filter((node) => node.id !== made.epic.slug)
      const next = placed(top, { id: made.epic.slug, name, children: [] }, after) ?? [...top, { id: made.epic.slug, name, children: [] }]
      return save(next, [made.epic.slug])
    }
    const view = now()
    if (!nodeAt(view, parent)) return refused('no-such-space', `There is no space ${parent.join('/')} in this project.`)
    if (parent.length === 1) {
      const done = editParts(root, parent[0], { add: { name, after } })
      if (done.result.outcome !== 'changed' || !done.result.id) {
        return refused(done.result.outcome === 'no-such-part' ? 'no-such-space' : 'declined', done.result.why || 'The space was not added.')
      }
      return save(merged(root, file).kept, [parent[0]!, done.result.id])
    }
    if (count(tree) >= LIMITS.SPACES) return refused('declined', `A project holds at most ${LIMITS.SPACES} spaces.`)
    const id = spaceIdFor(name, tree)
    const list = childrenAt(tree, parent)!
    const next = placed(list, { id, name, children: [] }, after)
    if (!next) return refused('no-such-space', `There is no space ${after} beside it to put it after.`)
    return save(setChildren(tree, parent, next), [...parent, id])
  }

  if ('rename' in edit) {
    const { path } = edit.rename
    const name = NAME_OK(edit.rename.name)
    if (name === null) return refused('declined', `A space is called something: one line, at most ${LIMITS.TITLE} characters.`)
    const node = nodeAt(now(), path)
    if (!node) return refused('no-such-space', `There is no space ${path.join('/')} in this project.`)
    if (node.name === name) return { outcome: 'unchanged', why: '', path, tree: now() }
    if (path.length === 1) {
      const done = retitleEpic(root, path[0]!, name)
      if (!done.ok) return refused('declined', done.why.replace(/\bepic\b/g, 'space'))
      return save(merged(root, file).kept, path)
    }
    if (path.length === 2) {
      const done = editParts(root, path[0], { rename: { id: path[1]!, name } })
      if (done.result.outcome !== 'changed') return refused('declined', done.result.why || 'The space was not renamed.')
      return save(merged(root, file).kept, path)
    }
    nodeAt(tree, path)!.name = name
    return save(tree, path)
  }

  if ('move' in edit) {
    const { path, after } = edit.move
    const from = path.slice(0, -1)
    const to = edit.move.parent ?? from
    const id = path[path.length - 1]!
    if (!nodeAt(now(), path)) return refused('no-such-space', `There is no space ${path.join('/')} in this project.`)
    const across = to.join('/') !== from.join('/')
    if (across) {
      if (from.length < 2 || to.length < 2) {
        return refused('declined', 'A top-level space and the spaces right under one move only among their siblings; a deeper space can move under any space at that depth or below.')
      }
      if (to.length >= path.length && path.every((one, at) => to[at] === one)) {
        return refused('declined', 'A space cannot move into itself or a space under it.')
      }
      const target = childrenAt(tree, to)
      if (!target) return refused('no-such-space', `There is no space ${to.join('/')} in this project.`)
      if (target.some((one) => one.id === id)) return refused('declined', `${to.join('/')} already holds a space ${id}.`)
      if (to.length + 1 + depthOf(nodeAt(tree, path)!) - 1 > LIMITS.SPACE_DEPTH) return refused('declined', `Spaces nest at most ${LIMITS.SPACE_DEPTH} deep.`)
      const source = childrenAt(tree, from)!
      const node = source.find((one) => one.id === id)!
      setChildren(tree, from, source.filter((one) => one !== node))
      const next = placed(childrenAt(tree, to)!, node, after)
      if (!next) return refused('no-such-space', `There is no space ${after} there to put it after.`)
      return save(setChildren(tree, to, next), [...to, id])
    }
    if (after === id) return { outcome: 'unchanged', why: '', path, tree: now() }
    if (path.length === 2) {
      const done = editParts(root, path[0], { move: { id, after } })
      if (done.result.outcome === 'unchanged') return { outcome: 'unchanged', why: '', path, tree: now() }
      if (done.result.outcome !== 'changed') return refused('declined', done.result.why || 'The space was not moved.')
      return save(merged(root, file).kept, path)
    }
    const list = childrenAt(tree, from)!
    const node = list.find((one) => one.id === id)!
    const next = placed(list.filter((one) => one !== node), node, after)
    if (!next) return refused('no-such-space', `There is no space ${after} beside it to put it after.`)
    if (next.every((one, index) => one === list[index])) return { outcome: 'unchanged', why: '', path, tree: now() }
    return save(setChildren(tree, from, next), path)
  }

  const { path, confirm } = edit.remove
  const node = nodeAt(now(), path)
  if (!node) return refused('no-such-space', `There is no space ${path.join('/')} in this project.`)
  if (!confirm) {
    const under = count(node.children)
    return refused(
      'confirm',
      `Removing ${node.name} removes ${under ? `it and the ${under} space${under === 1 ? '' : 's'} under it` : 'it'}. What modules keep for it is theirs and stays. Ask again with confirm to remove it.`,
    )
  }
  if (path.length === 1) {
    const done = deleteEpic(root, path[0]!)
    if (!done.ok) return refused('declined', done.why.replace(/\bepic\b/g, 'space'))
  } else if (path.length === 2) {
    const done = editParts(root, path[0], { remove: { id: path[1]! } })
    if (done.result.outcome !== 'changed') return refused('declined', done.result.why || 'The space was not removed.')
  }
  const from = path.slice(0, -1)
  const list = childrenAt(tree, from) ?? []
  return { ...save(setChildren(tree, from, list.filter((one) => one.id !== path[path.length - 1])), null), path: null }
}

const depthOf = (node: SpaceNode): number => 1 + Math.max(0, ...node.children.map(depthOf))
