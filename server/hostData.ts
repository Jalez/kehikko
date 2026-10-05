import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, rmdirSync, statSync } from 'node:fs'
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
 * ## Where it was, twice
 *
 * It was `<project>/data/{epics,state}` first, and then
 * `<project>/.kehikot/roadmap/{epics,state}` — a folder named after the app
 * this host was before it was called Kehikot. Both are brought over by
 * `migrateHostData`, and the second is still READ when the new folder is not
 * there (see `epicsDir`), so a project the migration could not write to keeps
 * its epics on screen.
 */

/** The host's own folder name under `.kehikot/`. `moduleFolder(HOST_ID)`; a test holds the two together. */
export const HOST_FOLDER = 'kehikko'

/** `.kehikot/kehikko`, relative to a project. */
export const HOST_DATA_DIR = join(KEHIKOT_DIR, HOST_FOLDER)

/** `.kehikot/roadmap`, relative to a project: where epics and state lived before the rename. Read, never written. */
export const LEGACY_DATA_DIR = join(KEHIKOT_DIR, 'roadmap')

/** `.kehikot/kehikko/epics`, relative — for sentences a person reads. */
export const EPICS_REL = `${KEHIKOT_DIR}/${HOST_FOLDER}/epics`

/** `.kehikot/kehikko/state`, relative — for sentences a person reads. */
export const STATE_REL = `${KEHIKOT_DIR}/${HOST_FOLDER}/state`

/**
 * One of the host's directories in a project: the current one, or — only when
 * it does not exist and the pre-rename one does — the pre-rename one.
 *
 * Reads AND writes go through this, so the two always agree: a project whose
 * `.kehikot/kehikko/` could not be made (a read-only volume, a copy that
 * failed) goes on being read and written where its epics actually are, rather
 * than showing them and then filing the next new epic somewhere else.
 */
function hostDir(root: string, name: 'epics' | 'state'): string {
  const now = join(root, HOST_DATA_DIR, name)
  if (existsSync(now)) return now
  const before = join(root, LEGACY_DATA_DIR, name)
  return isDir(before) ? before : now
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
  /** Pre-rename `.kehikot/roadmap/` directories copied into `.kehikot/kehikko/`, as `[from, to]`. */
  copied: Array<[string, string]>
  /** Both the legacy and a newer directory exist; the legacy one was left alone. */
  conflicts: Array<[string, string]>
  /** Whether `<project>/data` was removed because the move left it empty. */
  removedData: boolean
}

/**
 * Bring a project's epics and state into `.kehikot/kehikko/`, from wherever an
 * older host left them. Idempotent: run on every start and whenever a project
 * is adopted or added, and a second run finds nothing to do.
 *
 * ### `.kehikot/roadmap/{epics,state}` — COPIED, never moved
 *
 * Copied only when the new directory does not exist yet, into a temporary
 * sibling that is then renamed into place, so a crash leaves either nothing or
 * a whole copy. The original is left exactly where it is: an older host — the
 * installed app, or a checkout on another branch — may still be reading it.
 *
 * ### `data/{epics,state}` — moved, as before
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
 * goes on reading the old place (see `epicsDir`); the log says why.
 */
export function migrateHostData(root: string, log: (line: string) => void = (line) => console.warn(line)): Migrated {
  const said: Migrated = { moved: [], copied: [], conflicts: [], removedData: false }

  for (const name of ['epics', 'state'] as const) {
    const before = join(root, LEGACY_DATA_DIR, name)
    const now = join(root, HOST_DATA_DIR, name)
    if (!isDir(before) || existsSync(now)) continue
    const tmp = `${now}.copying-${process.pid}`
    try {
      mkdirSync(join(root, HOST_DATA_DIR), { recursive: true })
      rmSync(tmp, { recursive: true, force: true })
      cpSync(before, tmp, { recursive: true, preserveTimestamps: true, errorOnExist: true })
      renameSync(tmp, now)
      said.copied.push([before, now])
      log(`kehikko: copied ${before} -> ${now} (the original is left where it is)`)
    } catch (error) {
      rmSync(tmp, { recursive: true, force: true })
      log(`kehikko: could not copy ${before} -> ${now}: ${(error as Error).message}; reading ${before}`)
    }
  }

  const legacyRoot = join(root, 'data') // kehikot-storage: allow the legacy location, read only to move it into .kehikot/
  if (!isDir(legacyRoot)) return said

  for (const name of ['epics', 'state'] as const) {
    const legacy = join(legacyRoot, name)
    if (!isDir(legacy)) continue
    const now = join(root, HOST_DATA_DIR, name)
    const taken = [now, join(root, LEGACY_DATA_DIR, name)].find((dir) => existsSync(dir))
    if (taken) {
      said.conflicts.push([legacy, taken])
      log(`kehikko: both ${legacy} and ${taken} exist — left the legacy one alone; reading ${hostDir(root, name)}`)
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
