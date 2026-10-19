import { existsSync, readdirSync, renameSync, rmdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { moveHostFolder } from './hostFolderMove.ts'
import { makeUnderRoot, projectRootExists } from './projectRoot.ts'

import { HOST_FOLDER, KEHIKOT_DIR, LEGACY_HOST_FOLDER, hostDir as hostFolder, hostFile, legacyHostFile } from 'kehikot-module-protocol'

export { HOST_FOLDER, LEGACY_HOST_FOLDER }

/**
 * Where a project's epics and tracker state live, spelled once.
 *
 * ## The contract
 *
 * Every module keeps a project's data under `<project>/.kehikot/<module>/`.
 * This host keeps its own beside them, in `<project>/.kehikot/host/` (protocol
 * 2.2.0: `HOST_FOLDER`, `hostDir`, `hostFile`) — named for its role, not after
 * `HOST_ID`, which stays `kehikko` as the host's name on the wire and its MCP
 * door. Its epics are `<project>/.kehikot/host/epics/<slug>.json` — what a
 * person wrote — and its tracker state is `.kehikot/host/state/<slug>.json` —
 * what a refresh last read; beside them `kehikot.json`, `trackers.json`, the
 * tracker reading, the dispositions and `data-versions.json`. Papers are
 * `<project>/.kehikot/paper/<epic>/`.
 *
 * Every path in this host that reads or writes the host's folder goes through
 * `hostRoot` / `hostPath` below. A second spelling of the folder is how a host
 * reads one place while something else writes another, with nothing on screen
 * to say so.
 *
 * ## Where it was
 *
 * It was `<project>/data/{epics,state}` first, and `migrateHostData` moves a
 * project still laid out that way. Then it was `.kehikot/kehikko/` (until
 * protocol 2.2.0), and `moveHostFolder` (`hostFolderMove.ts`) renames that to
 * `.kehikot/host/` at start and whenever a project is added. Until it has
 * been moved — a read-only project, or one not yet met — `hostRoot` answers
 * the old folder, so nothing is read from an empty new one and nothing is
 * split between the two. Nothing ever creates `.kehikot/kehikko/`.
 */

/** `.kehikot/host`, relative to a project. */
export const HOST_DATA_DIR = join(KEHIKOT_DIR, HOST_FOLDER)

/** `.kehikot/host/epics`, relative — for sentences a person reads. */
export const EPICS_REL = `${KEHIKOT_DIR}/${HOST_FOLDER}/epics`

/** `.kehikot/host/state`, relative — for sentences a person reads. */
export const STATE_REL = `${KEHIKOT_DIR}/${HOST_FOLDER}/state`

/**
 * The host's folder in this project as it stands: `.kehikot/host`, or — only
 * while the project still has the pre-2.2 `.kehikot/kehikko` and no `host`
 * (not moved yet, or could not be: a read-only project) — that one. Both
 * reads and writes go through it, so the two are always the same folder.
 */
export function hostRoot(root: string): string {
  const now = hostFolder(root)
  if (now === null) throw new Error('There is no project, so there is no host folder in it.')
  if (existsSync(now)) return now
  const before = hostFolder(root, { legacy: true })!
  return isDir(before) ? before : now
}

/**
 * A path under the host's folder in a project (`hostRoot`), or `null` when
 * there is no project. The segments are checked by the protocol's `hostFile`,
 * which throws on one that could leave the folder.
 */
export function hostPath(projectPath: string | null | undefined, ...segments: string[]): string | null {
  const checked = hostFile(projectPath, ...segments)
  if (checked === null) return null
  const root = hostRoot(projectPath!)
  /* Moved or new: exactly the protocol's spelling. */
  if (root === hostFolder(projectPath)) return checked
  return legacyHostFile(projectPath, ...segments)
}

/** One of the host's directories in a project. Reads and writes both go through this. */
function hostDir(root: string, name: 'epics' | 'state'): string {
  return join(hostRoot(root), name)
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
  /** Legacy `data/` directories moved into `.kehikot/host/`, as `[from, to]`. */
  moved: Array<[string, string]>
  /** Both the legacy and a newer directory exist; the legacy one was left alone. */
  conflicts: Array<[string, string]>
  /** Whether `<project>/data` was removed because the move left it empty. */
  removedData: boolean
}

/**
 * Bring a project's epics and state into the host's folder from
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
 * First, `moveHostFolder` renames a pre-2.2 `.kehikot/kehikko/` to
 * `.kehikot/host/` (see there).
 *
 * Never throws. A project on a read-only volume stays where it was and the host
 * logs why.
 */
export function migrateHostData(root: string, log: (line: string) => void = (line) => console.warn(line)): Migrated {
  const said: Migrated = { moved: [], conflicts: [], removedData: false }
  /* A folder that is gone, or a ghost an older host left at a project's path (`projectRoot.ts`), is not migrated into. */
  if (!projectRootExists(root)) return said

  /* `.kehikot/kehikko/` → `.kehikot/host/` first, so what follows lands in the folder that stays. */
  moveHostFolder(root, log)

  const legacyRoot = join(root, 'data') // kehikot-storage: allow the legacy location, read only to move it into .kehikot/
  if (!isDir(legacyRoot)) return said

  for (const name of ['epics', 'state'] as const) {
    const legacy = join(legacyRoot, name)
    if (!isDir(legacy)) continue
    const now = hostDir(root, name)
    if (existsSync(now)) {
      said.conflicts.push([legacy, now])
      log(`kehikko: both ${legacy} and ${now} exist — left the legacy one alone; reading ${now}`)
      continue
    }
    try {
      /* Inside the project, never the project (`projectRoot.ts`). */
      if (!makeUnderRoot(root, hostRoot(root))) break
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
