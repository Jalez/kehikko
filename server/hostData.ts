import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { KEHIKOT_DIR } from 'kehikot-module-protocol'

/**
 * Where a project's epics and tracker state live, spelled once.
 *
 * ## The contract
 *
 * Every module keeps a project's data under `<project>/.kehikot/<module>/`, and
 * this host is a module like the others: its folder is the one named after
 * `HOST_ID` in `kehikot.ts` — `kehikko` — beside `kehikot.json`. Its epics are
 * `<project>/.kehikot/kehikko/epics/<slug>.json` — what a person wrote — and
 * its tracker state is `<project>/.kehikot/kehikko/state/<slug>.json` — what a
 * refresh last read. Papers are `<project>/.kehikot/paper/<epic>/`.
 *
 * `KEHIKOT_DIR` comes from the protocol so the dot-folder is never spelled
 * here. Every path in this host that reads or writes epics or state goes
 * through the helpers below. A second spelling of the folder is how a host
 * reads one place while something else writes another, with nothing on screen
 * to say so.
 *
 * ## Where it was
 *
 * It was `<project>/data/{epics,state}` first, and `migrateHostData` moves a
 * project still laid out that way.
 */

/** The host's own folder name under `.kehikot/`. `moduleFolder(HOST_ID)`; a test holds the two together. */
export const HOST_FOLDER = 'kehikko'

/** `.kehikot/kehikko`, relative to a project. */
export const HOST_DATA_DIR = join(KEHIKOT_DIR, HOST_FOLDER)

/** `.kehikot/kehikko/epics`, relative — for sentences a person reads. */
export const EPICS_REL = `${KEHIKOT_DIR}/${HOST_FOLDER}/epics`

/** `.kehikot/kehikko/state`, relative — for sentences a person reads. */
export const STATE_REL = `${KEHIKOT_DIR}/${HOST_FOLDER}/state`

/** One of the host's directories in a project. Reads and writes both go through this. */
function hostDir(root: string, name: 'epics' | 'state'): string {
  return join(root, HOST_DATA_DIR, name)
}

/** A project's epics directory. */
export function epicsDir(root: string): string {
  return hostDir(root, 'epics')
}

/** A project's tracker-state directory. */
export function stateDir(root: string): string {
  return hostDir(root, 'state')
}

export interface Migrated {
  /** Legacy `data/` directories moved into `.kehikot/kehikko/`, as `[from, to]`. */
  moved: Array<[string, string]>
  /** Both the legacy and a newer directory exist; the legacy one was left alone. */
  conflicts: Array<[string, string]>
  /** Whether `<project>/data` was removed because the move left it empty. */
  removedData: boolean
}

/**
 * Bring a project's epics and state into `.kehikot/kehikko/` from
 * `data/{epics,state}`, where an older host left them. Idempotent: run on every
 * start and whenever a project is adopted or added, and a second run finds
 * nothing to do.
 *
 * The first layout, from before `.kehikot/` existed. One `renameSync` per
 * directory, and only when neither newer place has it: nothing is ever
 * overwritten, because these are documents somebody wrote. When a newer one
 * exists the legacy one is left exactly where it is and both paths are
 * reported (and logged), because deciding which of two sets of epics is the
 * real one is a person's call. `<project>/data` is removed afterwards only if it
 * is then empty — a folder that held something else is not this host's.
 *
 * Never throws. A project on a read-only volume stays where it was and the host
 * logs why.
 */
export function migrateHostData(root: string, log: (line: string) => void = (line) => console.warn(line)): Migrated {
  const said: Migrated = { moved: [], conflicts: [], removedData: false }

  const legacyRoot = join(root, 'data') // kehikot-storage: allow the legacy location, read only to move it into .kehikot/
  if (!isDir(legacyRoot)) return said

  for (const name of ['epics', 'state'] as const) {
    const legacy = join(legacyRoot, name)
    if (!isDir(legacy)) continue
    const now = join(root, HOST_DATA_DIR, name)
    if (existsSync(now)) {
      said.conflicts.push([legacy, now])
      log(`kehikko: both ${legacy} and ${now} exist — left the legacy one alone; reading ${now}`)
      continue
    }
    try {
      mkdirSync(join(root, HOST_DATA_DIR), { recursive: true })
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
