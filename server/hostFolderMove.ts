import { existsSync, renameSync, statSync } from 'node:fs'

import { hostDir } from 'kehikot-module-protocol'

/**
 * The host's folder in a project moved from `.kehikot/kehikko/` to
 * `.kehikot/host/` (protocol 2.2.0). This is the one place that moves it. Delete
 * this file, its call in `hostData.ts` and its test in a later release: after
 * 2027-04-01, or once every project has been opened by a host with it.
 *
 * ## Why
 *
 * A kehikko is one canvas, and the folder holds what the host keeps for every
 * canvas in the project — its record of them, the epics, the tracker sources.
 * Named after one canvas, it read as a mistake to anyone opening `.kehikot/`.
 *
 * ## What it does
 *
 * For one project root: when `.kehikot/kehikko/` is a folder and
 * `.kehikot/host/` does not exist, `rename` the one to the other — atomic,
 * and on the same filesystem by construction (the two are siblings), so the
 * folder is wholly in one place or wholly in the other. Nothing is copied and
 * nothing deleted.
 *
 * When both exist, `host/` is kept and read, and `kehikko/` is left exactly as
 * it is and said once in the log: which of two sets of epics is the real one is
 * a person's call. A project the rename cannot touch (a read-only volume) stays
 * as it is and is said; `hostRoot` in `hostData.ts` reads the old folder in
 * place until it can be moved.
 *
 * Called from `migrateHostData`, which runs for every known project whose root
 * exists at start, and for a project when it is added or adopted. Idempotent:
 * a second run finds nothing to do and says nothing.
 *
 * A host from before this (0.1.25 and older) knows only `.kehikot/kehikko/`,
 * and after the move finds no epics or canvases there. That is accepted.
 */

export type Moved =
  /** Nothing to move: no `.kehikot/kehikko/`, or no project. */
  | { did: 'nothing' }
  /** Renamed `.kehikot/kehikko/` to `.kehikot/host/`. */
  | { did: 'moved'; from: string; to: string }
  /** Both exist; `host/` is kept and `kehikko/` left untouched. */
  | { did: 'both'; from: string; to: string }
  /** The rename failed; the old folder stays and is read in place. */
  | { did: 'failed'; from: string; to: string; why: string }

/** Folders already said to be both there, so a project opened again is not said again. */
const saidBoth = new Set<string>()

export function moveHostFolder(root: string, log: (line: string) => void = (line) => console.warn(line)): Moved {
  const to = hostDir(root)
  const from = hostDir(root, { legacy: true })
  if (to === null || from === null || !isDir(from)) return { did: 'nothing' }
  if (existsSync(to)) {
    if (!saidBoth.has(from)) {
      saidBoth.add(from)
      log(`kehikko: both ${from} and ${to} exist — reading ${to}; ${from} is left as it is`)
    }
    return { did: 'both', from, to }
  }
  try {
    renameSync(from, to)
  } catch (error) {
    const why = (error as Error).message
    log(`kehikko: could not move ${from} -> ${to}: ${why} — reading it where it is`)
    return { did: 'failed', from, to, why }
  }
  log(`kehikko: moved ${from} -> ${to}`)
  return { did: 'moved', from, to }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
