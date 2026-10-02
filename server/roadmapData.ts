import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { KEHIKOT_DIR } from 'roadmap-module-protocol'

/**
 * Where a project's roadmap data lives, spelled once.
 *
 * ## The contract
 *
 * Every module keeps a project's data under `<project>/.kehikot/<module>/`, and
 * the roadmap is a module like the others: its epics are
 * `<project>/.kehikot/roadmap/epics/<slug>.json` — what a person wrote — and
 * its tracker state is `<project>/.kehikot/roadmap/state/<slug>.json` — what a
 * refresh last read. Papers are `<project>/.kehikot/paper/<epic>/`.
 *
 * It used to be `<project>/data/epics` and `<project>/data/state`. A folder
 * called `data` in somebody's repository says nothing about who put it there,
 * and it was the one place in a project that did not follow the protocol's
 * convention. `KEHIKOT_DIR` comes from the protocol so the dot-folder is never
 * spelled here; `roadmap` is the roadmap's own folder under it.
 *
 * Every path in this host that reads or writes epics or state goes through the
 * helpers below. A second spelling of the folder is how a host reads one place
 * while the roadmap writes another, with nothing on screen to say so.
 */

/** `.kehikot/roadmap`, relative to a project. */
export const ROADMAP_DIR = join(KEHIKOT_DIR, 'roadmap')

/** `.kehikot/roadmap/epics`, relative — for sentences a person reads. */
export const EPICS_REL = `${KEHIKOT_DIR}/roadmap/epics`

/** `.kehikot/roadmap/state`, relative — for sentences a person reads. */
export const STATE_REL = `${KEHIKOT_DIR}/roadmap/state`

/** A project's epics directory. */
export function epicsDir(root: string): string {
  return join(root, ROADMAP_DIR, 'epics')
}

/** A project's tracker-state directory. */
export function stateDir(root: string): string {
  return join(root, ROADMAP_DIR, 'state')
}

export interface Migrated {
  /** Legacy directories moved into `.kehikot/roadmap/`, as `[from, to]`. */
  moved: Array<[string, string]>
  /** Both the legacy and the new directory exist; the legacy one was left alone. */
  conflicts: Array<[string, string]>
  /** Whether `<project>/data` was removed because the move left it empty. */
  removedData: boolean
}

/**
 * Move a project's legacy `data/epics` and `data/state` into `.kehikot/roadmap/`.
 *
 * Run when the host adopts or adds a project. One `renameSync` per directory,
 * and only when the new one does not exist yet: nothing is ever overwritten,
 * because these are documents somebody wrote. When BOTH exist the legacy one is
 * left exactly where it is and both paths are reported (and logged), because
 * deciding which of two sets of epics is the real one is a person's call.
 *
 * `<project>/data` is removed afterwards only if it is then empty — the roadmap
 * repository keeps other things there, and a folder that held something else is
 * not this host's to delete.
 *
 * Never throws. A project on a read-only volume, or a rename across devices,
 * stays where it was and the host goes on reading the new place, which then
 * answers "no epics" honestly; the log says why.
 */
export function migrateLegacyRoadmapData(
  root: string,
  log: (line: string) => void = (line) => console.warn(line),
): Migrated {
  const said: Migrated = { moved: [], conflicts: [], removedData: false }
  const legacyRoot = join(root, 'data') // kehikot-storage: allow the legacy location, read only to move it into .kehikot/
  if (!isDir(legacyRoot)) return said

  for (const [legacy, now] of [
    [join(legacyRoot, 'epics'), epicsDir(root)],
    [join(legacyRoot, 'state'), stateDir(root)],
  ] as const) {
    if (!isDir(legacy)) continue
    if (existsSync(now)) {
      said.conflicts.push([legacy, now])
      log(`kehikko: both ${legacy} and ${now} exist — left the legacy one alone; reading ${now}`)
      continue
    }
    try {
      mkdirSync(join(root, ROADMAP_DIR), { recursive: true })
      renameSync(legacy, now)
      said.moved.push([legacy, now])
      log(`kehikko: moved ${legacy} -> ${now}`)
    } catch (error) {
      log(`kehikko: could not move ${legacy} -> ${now}: ${(error as Error).message}`)
    }
  }

  if (said.moved.length) {
    try {
      if (readdirSync(legacyRoot).length === 0) {
        rmdirSync(legacyRoot)
        said.removedData = true
      }
    } catch {
      /* Not empty, or not ours to remove. Left where it is. */
    }
  }
  return said
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
