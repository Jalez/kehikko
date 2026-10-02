import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { KEHIKOT_DIR } from 'roadmap-module-protocol'

/**
 * Where a project's epics live, spelled once.
 *
 * ## The contract
 *
 * A project's epics are `<project>/.kehikot/epics/<slug>.json` — what a person
 * wrote — and their tracker state is `<project>/.kehikot/state/<slug>.json` —
 * what a refresh last read. Papers are `<project>/.kehikot/paper/<epic>/`.
 *
 * ## Where they used to be
 *
 * `<project>/data/{epics,state}` first: a folder called `data` in somebody's
 * repository says nothing about who put it there. Then, briefly,
 * `<project>/.kehikot/roadmap/{epics,state}`, named after the roadmap server
 * that wrote them at the time. The roadmap was a prototype of this host and is
 * retired; the host owns epics now, and a folder named after a program that no
 * longer exists sent at least one project's epics to a path nothing read. So
 * they sit directly under `.kehikot/`, where a person looking for them looks.
 *
 * Every path in this host that reads or writes epics or state goes through the
 * helpers below. A second spelling is how a host reads one place while
 * something else writes another, with nothing on screen to say so.
 */

/** `.kehikot/epics`, relative — for sentences a person reads. */
export const EPICS_REL = `${KEHIKOT_DIR}/epics`

/** `.kehikot/state`, relative — for sentences a person reads. */
export const STATE_REL = `${KEHIKOT_DIR}/state`

/** A project's epics directory. */
export function epicsDir(root: string): string {
  return join(root, KEHIKOT_DIR, 'epics')
}

/** A project's tracker-state directory. */
export function stateDir(root: string): string {
  return join(root, KEHIKOT_DIR, 'state')
}

export interface Migrated {
  /** Old directories moved into `.kehikot/`, as `[from, to]`. */
  moved: Array<[string, string]>
  /** An old and the new directory both exist; the old one was left alone. */
  conflicts: Array<[string, string]>
  /** Whether `<project>/data` was removed because the move left it empty. */
  removedData: boolean
}

/**
 * Move a project's old `{epics,state}` directories to `.kehikot/{epics,state}`.
 *
 * Two old places, newest first: `.kehikot/roadmap/` and then `data/`. Run when
 * the host adopts or adds a project. One `renameSync` per directory, and only
 * when the new one does not exist yet: nothing is ever overwritten, because
 * these are documents somebody wrote. When a target already exists the old
 * directory is left exactly where it is and both paths are reported (and
 * logged), because deciding which of two sets of epics is the real one is a
 * person's call.
 *
 * Afterwards `.kehikot/roadmap` and `<project>/data` are removed only if the
 * move left them empty — a folder that held something else is not this host's
 * to delete.
 *
 * Never throws. A rename that fails leaves the old directory where it was and
 * the host goes on reading the new place, which then answers "no epics"
 * honestly; the log says why.
 */
export function migrateLegacyEpicData(
  root: string,
  log: (line: string) => void = (line) => console.warn(line),
): Migrated {
  const said: Migrated = { moved: [], conflicts: [], removedData: false }
  const roadmapDir = join(root, KEHIKOT_DIR, 'roadmap')
  const dataDir = join(root, 'data') // kehikot-storage: allow the legacy location, read only to move it into .kehikot/

  for (const old of [roadmapDir, dataDir]) {
    if (!isDir(old)) continue
    for (const [from, to] of [
      [join(old, 'epics'), epicsDir(root)],
      [join(old, 'state'), stateDir(root)],
    ] as const) {
      if (!isDir(from)) continue
      if (existsSync(to)) {
        said.conflicts.push([from, to])
        log(`kehikko: both ${from} and ${to} exist — left the old one alone; reading ${to}`)
        continue
      }
      try {
        mkdirSync(join(root, KEHIKOT_DIR), { recursive: true })
        renameSync(from, to)
        said.moved.push([from, to])
        log(`kehikko: moved ${from} -> ${to}`)
      } catch (error) {
        log(`kehikko: could not move ${from} -> ${to}: ${(error as Error).message}`)
      }
    }
  }

  if (said.moved.length) {
    if (removeIfEmpty(dataDir)) said.removedData = true
    removeIfEmpty(roadmapDir)
  }
  return said
}

function removeIfEmpty(dir: string): boolean {
  try {
    if (isDir(dir) && readdirSync(dir).length === 0) {
      rmdirSync(dir)
      return true
    }
  } catch {
    /* Not empty, or not ours to remove. Left where it is. */
  }
  return false
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
