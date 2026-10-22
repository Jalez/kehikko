import { mkdirSync, readdirSync, statSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'

/**
 * A project's folder, and the one rule about it: this host never creates it.
 *
 * ## Why this exists
 *
 * A project is a folder the person picked, and folders get renamed, moved and
 * deleted. Every write this host makes under a project went through a
 * `mkdirSync(dirname(file), { recursive: true })`, which is the right call for
 * `.kehikot/host/` inside a folder that is there — and, when the folder is
 * gone, quietly rebuilds the path the person just moved away from: an empty
 * `<old name>/.kehikot/host/kehikot.json` beside the folder they renamed,
 * remade at every start.
 *
 * So every write under a project root asks here first. Inside a root that
 * exists, `.kehikot/…` folders are made as before. A root that is gone is not
 * made, the write is skipped, and the log says so once per root per start —
 * not once per write, which on a host syncing every load would be a flood.
 *
 * ## A ghost is not the project
 *
 * The guard asks whether the folder is THERE, and a host from before it (0.1.24
 * and older) had already rebuilt one: the person moved their files out and
 * deleted the folder, and a tracker read and a start-up sync made
 * `<old path>/.kehikot/kehikko/` again, with nothing beside it. Every host after
 * that found a folder at the path and took it for the project — moved its host
 * folder, minted an id into it, bookmarked it, kept writing into it — so it
 * "kept coming back", and the bookmark now led to it instead of to the files.
 *
 * So a project folder that holds nothing but `.kehikot/` (Finder's leavings
 * aside) is a GHOST when this host cannot vouch for it: either it recorded
 * the folder's identity (device and inode, `projects.folder`) and this is
 * another folder, or it recorded none and the folder was born in the same
 * moment as its `.kehikot/` — which is what `mkdir -p` does and a person
 * making a folder and adding it does not. A ghost is missing, for every
 * write and on the page, so "Locate…" can point the project at its files.
 * A folder of the person's own, or one this host was given and recorded,
 * holding only `.kehikot/`, is a project as before.
 *
 * Only a folder a project row names can be a ghost: the rows are this
 * server's, given here by `setRecordedFolders` (`projects.ts`). Without them
 * — a test, a tool — the guard is the existence check alone.
 *
 * No imports from the rest of the server, so anything may use it without a cycle.
 */

/** The sentence a person is told, here and on the page. */
export const MISSING_SAID = "Kehikot can't find this folder any more. It was moved, renamed or deleted."

/**
 * Whether a project's folder is there now, as a directory, and is not a
 * ghost (see above). Read every time, never cached.
 */
export function projectRootExists(root: string | null | undefined): boolean {
  if (typeof root !== 'string' || !root) return false
  try {
    if (!statSync(resolve(root)).isDirectory()) return false
  } catch {
    return false
  }
  return !isGhost(root)
}

/**
 * What a project row recorded about the folder at a path: `undefined` when no
 * project is there, `null` when one is but nothing was recorded (a row from
 * before), else the folder's identity as `folderIdentity` spells it.
 */
export type RecordedFolder = (root: string) => string | null | undefined

let recorded: RecordedFolder = () => undefined

/** Where the projects' recorded folders are read from. The server passes its database's; `undefined` puts back none. */
export function setRecordedFolders(next: RecordedFolder | undefined): void {
  recorded = next ?? (() => undefined)
}

/** Finder's and the system's own leavings, which a person did not put in a folder. */
const LEAVINGS = new Set(['.DS_Store', '.localized', 'Icon\r'])

/** Whether a folder holds `.kehikot/` and nothing else of anybody's. */
export function onlyKehikot(root: string): boolean {
  let names: string[]
  try {
    names = readdirSync(resolve(root))
  } catch {
    return false
  }
  const own = names.filter((name) => !LEAVINGS.has(name))
  return own.length === 1 && own[0] === '.kehikot'
}

/** A folder's identity on its disk — device and inode — or null when it cannot be read. Survives a rename and a move on one volume. */
export function folderIdentity(root: string): string | null {
  try {
    const at = statSync(resolve(root), { bigint: true })
    return at.isDirectory() ? `${at.dev}:${at.ino}` : null
  } catch {
    return null
  }
}

/** How close together a folder and its `.kehikot/` are born when one `mkdir -p` made both. */
export const BORN_TOGETHER_MS = 2_000

/**
 * Whether a folder was born with its `.kehikot/`: the mark of `mkdir -p`
 * making the folder to put `.kehikot/…` in. False where the filesystem keeps
 * no birth time, so nothing is called a ghost on a guess.
 */
export function bornWithKehikot(root: string): boolean {
  try {
    const folder = statSync(resolve(root)).birthtimeMs
    const kehikot = statSync(resolve(root, '.kehikot')).birthtimeMs
    if (!(folder > 0) || !(kehikot > 0)) return false
    return Math.abs(kehikot - folder) < BORN_TOGETHER_MS
  } catch {
    return false
  }
}

/**
 * A folder that only looks like a project because a host made it: nothing but
 * `.kehikot/`, born with it. Said of any folder, project or not — used where
 * a bookmark, a former path or a sibling offers a folder to follow.
 */
export function looksMadeByAHost(root: string): boolean {
  return onlyKehikot(root) && bornWithKehikot(root)
}

/** Whether the folder a project row names is a ghost: see the essay at the top. */
export function isGhost(root: string): boolean {
  const at = resolve(root)
  const known = recorded(at)
  if (known === undefined) return false
  if (!onlyKehikot(at)) return false
  if (known !== null) return folderIdentity(at) !== known
  return bornWithKehikot(at)
}

/**
 * ## A folder nobody picked is read, never written
 *
 * A fresh host with no project opens the person's home folder so that there is
 * a canvas at all (`adopt`, `projects.ts`). Nobody chose that folder, so
 * nothing is written under it: no `.kehikot/host/` files, no `.gitignore`
 * edit, no tracker cache. The projects table answers (`setReadOnlyRoots`), a
 * folder is read-only while its row is the unpicked home fallback, and the
 * moment the person picks a project (or picks home from the picker, which
 * records it as chosen) the answer changes.
 */
export type ReadOnlyRoot = (root: string) => boolean

let readOnly: ReadOnlyRoot = () => false

/** Where "is this folder only a fallback?" is read from. The server passes the projects table's; `undefined` puts back none. */
export function setReadOnlyRoots(next: ReadOnlyRoot | undefined): void {
  readOnly = next ?? (() => false)
}

/** Whether the host may not write under this folder because nobody picked it. */
export function isReadOnlyRoot(root: string | null | undefined): boolean {
  if (typeof root !== 'string' || !root) return false
  try {
    return readOnly(resolve(root))
  } catch {
    return false
  }
}

/**
 * Whether a write under a project's folder may go ahead: the folder is there,
 * is not a ghost, and is not the home fallback nobody picked. Says why once
 * when it is not. Use this where `projectRootExists` guarded a write.
 */
export function projectWritable(root: string | null | undefined): boolean {
  if (typeof root !== 'string' || !root) return false
  if (!projectRootExists(root)) {
    sayMissing(root)
    return false
  }
  if (isReadOnlyRoot(root)) {
    sayReadOnly(root)
    return false
  }
  return true
}

/** The sentence a person or an agent is told when a write was refused for that reason. */
export const READ_ONLY_SAID = 'No project has been picked yet, so nothing is written to this folder. Pick a project first.'

/** Why a write under `root` was refused: the sentence for a folder nobody picked, else the one for a folder that is gone. */
export function refusedSaid(root: string | null | undefined): string {
  return isReadOnlyRoot(root) ? READ_ONLY_SAID : MISSING_SAID
}

const said = new Set<string>()
const saidReadOnly = new Set<string>()
let log: (line: string) => void = (line) => console.warn(line)

/** Where the one line per missing root goes. Tests pass a collector; the server leaves the default. */
export function setMissingLog(next: (line: string) => void): void {
  log = next
}

/** Forget which roots were already reported, so the next start (or test) says them again. */
export function resetMissingSaid(): void {
  said.clear()
  saidReadOnly.clear()
}

/** Say once per root per start that a write under it was skipped. */
export function sayMissing(root: string): void {
  if (said.has(root)) return
  said.add(root)
  let there = false
  try {
    there = statSync(resolve(root)).isDirectory()
  } catch {
    /* Gone. */
  }
  log(
    there
      ? `kehikko: ${root} holds nothing but .kehikot/ — left there by an older Kehikot after the folder was moved, renamed or deleted, and not the project; nothing is written under it. Use Locate… to point the project at its files; the leftover folder can be deleted.`
      : `kehikko: ${root} is not there any more (moved, renamed or deleted); nothing is written under it.`,
  )
}

/** Say once per root per start that a write under it was refused because nobody picked it. */
export function sayReadOnly(root: string): void {
  if (saidReadOnly.has(root)) return
  saidReadOnly.add(root)
  log(`kehikko: ${root} is the folder this host opened because no project was picked; nothing is written under it. Pick a project to start.`)
}

/**
 * Make `dir` — a folder under `root` — when `root` is the project's folder;
 * never make `root`.
 *
 * Returns whether the write may go ahead. A missing root (or a ghost), and
 * the home fallback nobody picked, is reported once and answers false, and
 * the caller skips its write.
 *
 * Made one level at a time from the root down, never `recursive` from the
 * top: a folder deleted between the check and the write makes the first
 * `mkdir` fail, where `mkdir -p` would have made the root again. Throws what
 * `mkdirSync` throws for anything else (a read-only folder), as before.
 */
export function makeUnderRoot(root: string, dir: string): boolean {
  if (!projectWritable(root)) return false
  const base = resolve(root)
  const target = resolve(dir)
  const below = relative(base, target)
  if (below === '') return true
  if (below.startsWith('..') || resolve(base, below) !== target) {
    throw new Error(`${dir} is not inside ${root}.`)
  }
  let at = base
  for (const part of below.split(sep)) {
    at = `${at}${sep}${part}`
    try {
      mkdirSync(at)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EEXIST') continue
      if (code === 'ENOENT' && !projectRootExists(root)) {
        sayMissing(root)
        return false
      }
      throw error
    }
  }
  return true
}
